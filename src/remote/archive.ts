import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import type { Header } from "tar-stream";
import { RemoteError, safeArchivePath } from "./policy.js";
import type { RemoteLimits } from "./policy.js";
import type { VerifiedTree } from "./tree.js";

export interface VerifiedFile { path: string; sha256: string; gitBlobSha: string; size: number }
export interface ArchiveVerification { archiveSha256: string; compressedBytes: number; expandedBytes: number; files: VerifiedFile[] }

/** Parse data only; never invoke a filesystem extractor or apply archived modes/links. Root is tool-created and empty. */
export async function extractVerifiedArchive(body: ReadableStream<Uint8Array>, root: string, tree: VerifiedTree, limits: RemoteLimits, signal: AbortSignal): Promise<ArchiveVerification> {
  let compressedBytes = 0, expandedBytes = 0, entries = 0, prefix: string | undefined;
  const archiveHash = createHash("sha256"), files: VerifiedFile[] = [], seen = new Set<string>();
  const expected = new Map(tree.files.map(file => [file.path, file]));
  const directories = new Set(tree.directories);
  const parser = extract();
  const compressed = new Transform({ transform(chunk: Buffer, _encoding, next) {
    compressedBytes += chunk.byteLength; archiveHash.update(chunk);
    next(compressedBytes > limits.maxCompressedBytes ? new RemoteError("RESOURCE_LIMIT") : null, chunk);
  } });
  const expanded = new Transform({ transform(chunk: Buffer, _encoding, next) {
    expandedBytes += chunk.byteLength;
    next(expandedBytes > limits.maxExpandedBytes ? new RemoteError("RESOURCE_LIMIT") : null, chunk);
  } });
  const reader = body.getReader();
  const source = Readable.from((async function* () {
    try { while (true) { const item = await reader.read(); if (item.done) break; yield item.value; } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  })(), { objectMode: false });
  const unzip = createGunzip({ chunkSize: 64 * 1024 });
  const consume = (async () => {
    for await (const entry of parser) {
      if (signal.aborted) throw new RemoteError("CANCELLED");
      if (++entries > limits.maxEntries + 1) throw new RemoteError("RESOURCE_LIMIT");
      const header: Header = entry.header;
      if ((header.type !== "file" && header.type !== "directory") || header.linkname || !Number.isSafeInteger(header.size) || (header.size ?? -1) < 0) throw new RemoteError("UNSAFE_ARCHIVE");
      if (header.pax !== undefined && header.pax !== null && (typeof header.pax !== "object" || Object.entries(header.pax).some(([key, value]) => key === "linkpath" || key.toLowerCase().includes("sparse") || (key === "size" && (typeof value !== "string" || !/^\d+$/.test(value)))))) throw new RemoteError("UNSAFE_ARCHIVE");
      const name = header.type === "directory" && header.name.endsWith("/") ? header.name.slice(0, -1) : header.name;
      safeArchivePath(name, { ...limits, maxDepth: limits.maxDepth + 1 });
      const slash = name.indexOf("/"), top = slash === -1 ? name : name.slice(0, slash);
      if (prefix === undefined) prefix = top;
      if (top !== prefix || (slash === -1 && header.type !== "directory")) throw new RemoteError("UNSAFE_ARCHIVE");
      const file = slash === -1 ? "" : name.slice(slash + 1);
      if (seen.has(file)) throw new RemoteError("UNSAFE_ARCHIVE"); seen.add(file);
      if (header.type === "directory") {
        if (header.size !== 0 || (file !== "" && !directories.has(file))) throw new RemoteError("COMMIT_MISMATCH");
        for await (const chunk of entry) if (!(chunk instanceof Uint8Array) || chunk.byteLength > 0) throw new RemoteError("UNSAFE_ARCHIVE");
        continue;
      }
      const wanted = expected.get(file);
      if (wanted === undefined || header.size !== wanted.size) throw new RemoteError("COMMIT_MISMATCH");
      const target = join(root, ...file.split("/"));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, "wx", 0o600);
      const gitHash = createHash("sha1").update(`blob ${wanted.size}\0`), hash = createHash("sha256"); let size = 0;
      try {
        for await (const chunk of entry) {
          if (!(chunk instanceof Uint8Array)) throw new RemoteError("UNSAFE_ARCHIVE");
          if (signal.aborted) throw new RemoteError("CANCELLED");
          size += chunk.byteLength;
          if (size > wanted.size) throw new RemoteError("COMMIT_MISMATCH");
          gitHash.update(chunk); hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = await handle.write(chunk, offset, chunk.byteLength - offset);
            if (written.bytesWritten === 0) throw new RemoteError("IO_ERROR");
            offset += written.bytesWritten;
          }
        }
      } finally { await handle.close(); }
      if (size !== wanted.size || gitHash.digest("hex") !== wanted.sha) throw new RemoteError("COMMIT_MISMATCH");
      files.push({ path: file, size, sha256: hash.digest("hex"), gitBlobSha: wanted.sha });
    }
  })();
  const transfer = pipeline(source, compressed, unzip, expanded, parser, { signal });
  try { await Promise.all([consume, transfer]); }
  catch (error) {
    source.destroy(); compressed.destroy(); unzip.destroy(); expanded.destroy(); parser.destroy();
    await reader.cancel().catch(() => undefined);
    await Promise.allSettled([consume, transfer]);
    throw error instanceof RemoteError ? error : new RemoteError(signal.aborted ? "CANCELLED" : "UNSAFE_ARCHIVE");
  }
  if (files.length !== expected.size) throw new RemoteError("COMMIT_MISMATCH");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { archiveSha256: archiveHash.digest("hex"), compressedBytes, expandedBytes, files };
}
