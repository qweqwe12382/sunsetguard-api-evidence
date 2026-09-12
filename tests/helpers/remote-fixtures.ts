import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import type { Header } from "tar-stream";
import type { VerifiedTree } from "../../src/remote/tree.js";

export const commit = "a".repeat(40), treeSha = "b".repeat(40);
export const gitBlob = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
export interface EntryFixture { name: string; text?: string; header?: Partial<Header> }
export async function tarBytes(entries: EntryFixture[], gzip = true): Promise<Buffer> {
  const stream = pack(), chunks: Buffer[] = [];
  const consume = (async () => { for await (const chunk of stream) { if (!Buffer.isBuffer(chunk)) throw Error("Expected tar bytes"); chunks.push(chunk); } })();
  for (const entry of entries) stream.entry({ name: entry.name, ...entry.header }, entry.text ?? "");
  stream.finalize(); await consume;
  const bytes = Buffer.concat(chunks); return gzip ? gzipSync(bytes) : bytes;
}
export function treeFor(entries: { name: string; text: string }[]): VerifiedTree {
  const dirs = new Set<string>();
  for (const entry of entries) { const parts = entry.name.split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); }
  return { sha: treeSha, directories: [...dirs], files: entries.map(entry => ({ path: entry.name, sha: gitBlob(Buffer.from(entry.text)), size: Buffer.byteLength(entry.text), mode: "100644" })) };
}
export const bodyOf = (data: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } });
