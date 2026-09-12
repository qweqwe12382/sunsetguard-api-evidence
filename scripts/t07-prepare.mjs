// Trusted, explicit audit preparation only. This is not a product remote fetcher.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath, URL } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../benchmarks/samples.json', import.meta.url), 'utf8'));
const allowed = new Map([
  ['mui/material-ui', 'a563a60219f7f6519fb0f34f6d8e3bf0974e6495'],
  ['react-component/util', '6253c1b69eaf6dbde64f32370a69df0f24865715'],
  ['reactstrap/reactstrap', '41eb0d427c3c8568948ec47880af7cb473228215'],
]);
const parent = path.join(path.dirname(project), 'SunsetGuard-samples');
await mkdir(parent, { recursive: true });
const destination = await mkdtemp(path.join(parent, 't07-'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const records = [];
let total = 0, requests = 0;
const deadline = Date.now() + 120_000;
for (const sample of manifest.samples) {
  if (allowed.get(sample.repository) !== sample.commit || !/^[a-z0-9.-]+$/.test(sample.id)) throw Error('Sample is not approved by this fixed preparation script');
  const files = new Set([...sample.sourceFiles, sample.licenseFile]);
  for (const source of sample.sourceFiles) {
    let directory = path.posix.dirname(source);
    while (true) {
      files.add(path.posix.join(directory, 'package.json'));
      files.add(path.posix.join(directory, 'tsconfig.json'));
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
  }
  const entries = [];
  for (const file of [...files].sort()) {
    if (!/^[A-Za-z0-9_./-]+$/.test(file) || file.split('/').some(p => p === '..' || p === '') || file.startsWith('/')) throw Error('Invalid fixed sample path');
    if (++requests > 64 || Date.now() >= deadline) throw Error('Preparation request/time budget reached');
    const url = `https://raw.githubusercontent.com/${sample.repository}/${sample.commit}/${file}`;
    const response = await globalThis.fetch(url, { redirect: 'error', credentials: 'omit', signal: globalThis.AbortSignal.timeout(Math.min(15_000, deadline - Date.now())) });
    if (response.status === 404 && !sample.sourceFiles.includes(file) && file !== sample.licenseFile) {
      await response.body?.cancel(); entries.push({ file, status: 'absent', url }); continue;
    }
    if (!response.ok || response.url !== url) throw Error(`Fixed source request failed: HTTP ${response.status}`);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length; total += chunk.length;
      if (bytes > 256 * 1024 || total > 2 * 1024 * 1024) throw Error('Preparation byte budget reached');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const target = path.join(destination, sample.id, ...file.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
    entries.push({ file, status: 'present', bytes, sha256: sha256(data), url });
  }
  records.push({ id: sample.id, commit: sample.commit, entries });
}
const lock = { schemaVersion: '0.1', preparedAt: new Date().toISOString(), policy: { redirects: 0, credentials: 'none', maxFileBytes: 262144, maxTotalBytes: 2097152, maxRequests: 64, maxTotalMs: 120000 }, totalBytes: total, requests, samples: records };
// An existing lock is a byte contract: re-fetches verify it instead of replacing it.
const lockPath = new URL('../benchmarks/sources.lock.json', import.meta.url);
let prior;
try { prior = JSON.parse(await readFile(lockPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (prior !== undefined) {
  if (JSON.stringify(prior.samples) !== JSON.stringify(records)) throw Error('Downloaded bytes differ from the frozen source lock');
} else await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ destination, samples: records.length, requests, totalBytes: total }) + '\n');
