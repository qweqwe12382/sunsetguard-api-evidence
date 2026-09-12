// Trusted offline worker fixture; never loads code from the acquired repository.
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { pack } from 'tar-stream';
import { acquireGitHub } from '../../dist/remote/acquire.js';
import { failure } from '../../dist/remote/policy.js';
const { Response, Headers, AbortController } = globalThis;

parentPort.postMessage({ testReady: true });
if (workerData.scenario === 'malformed') { parentPort.postMessage({ status: 'ready', value: { commit: 'FAKE_SECRET' } }); parentPort.close(); }
else {
if (workerData.scenario === 'busy') { while (true) { /* hard termination test */ } }
const commit = 'a'.repeat(40), treeSha = 'b'.repeat(40);
const source = 'import {oldApi} from "pkg"; oldApi(); throw Error("NEVER EXECUTE");';
const files = [{ path: 'source.ts', bytes: Buffer.from(source) }, { path: 'package.json', bytes: Buffer.from('{"dependencies":{"pkg":"^1.0.0"}}') }];
const stream = pack(), chunks = [];
const read = (async () => { for await (const chunk of stream) chunks.push(chunk); })();
for (const file of files) stream.entry({ name: `wrapper/${file.path}` }, file.bytes);
stream.finalize(); await read;
const archive = gzipSync(Buffer.concat(chunks));
let requests = 0;
const transport = async (_url, init) => {
  if (workerData.scenario === 'failure') return new Response('PRIVATE ERROR', { status: 404 });
  if (workerData.scenario === 'credential' && new Headers(init.headers).get('authorization') !== 'Bearer FAKE_TEST_TOKEN') throw Error('wrong token');
  const responses = [{ private: false, full_name: workerData.input.repository }, { sha: commit, commit: { tree: { sha: treeSha } } },
    { sha: treeSha, truncated: false, tree: files.map(file => ({ path: file.path, type: 'blob', mode: '100644', size: file.bytes.length, sha: createHash('sha1').update(`blob ${file.bytes.length}\0`).update(file.bytes).digest('hex') })) }];
  if (requests < 3) return new Response(JSON.stringify(responses[requests++]), { headers: { 'content-type': 'application/json' } });
  return new Response(new Uint8Array(archive));
};
try {
  const value = await acquireGitHub(workerData.input, workerData.root, workerData.limits, new AbortController().signal, workerData.token, transport);
  parentPort.postMessage({ status: 'ready', value });
} catch (error) { parentPort.postMessage(failure(error)); }
parentPort.close();
}
