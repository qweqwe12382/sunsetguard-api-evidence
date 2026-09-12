import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import type { VerifiedFile } from "./archive.js";
import { RemoteError } from "./policy.js";

/** Recheck the tool-created extraction tree without following links or trusting mtime alone. */
export async function verifyExtractedFiles(root: string, files: readonly VerifiedFile[], deadline: number, signal?: AbortSignal): Promise<void> {
  const expected = new Map(files.map(file => [file.path, file])), seen = new Set<string>();
  const expectedDirectories = new Set([""]);
  for (const file of files) {
    const parts = file.path.split("/");
    for (let depth = 1; depth < parts.length; depth++) expectedDirectories.add(parts.slice(0, depth).join("/"));
  }
  const rootBefore = await lstat(root, { bigint: true });
  let entries = 0;
  const checkTime = () => {
    if (signal?.aborted) throw new RemoteError("CANCELLED");
    if (performance.now() >= deadline) throw new RemoteError("TIMEOUT");
  };
  const visit = async (directory: string) => {
    checkTime();
    if (!expectedDirectories.has(relative(root, directory).split("\\").join("/"))) throw new RemoteError("SOURCE_CHANGED");
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || relative(directory, await realpath(directory)) !== "") throw new RemoteError("SOURCE_CHANGED");
    const children = await readdir(directory);
    for (const name of children) {
      checkTime();
      if (++entries > 50_001) throw new RemoteError("SOURCE_CHANGED");
      const path = join(directory, name), info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink()) throw new RemoteError("SOURCE_CHANGED");
      if (info.isDirectory()) { await visit(path); continue; }
      const file = expected.get(relative(root, path).split("\\").join("/"));
      if (file === undefined || !info.isFile() || info.nlink !== 1n || info.size !== BigInt(file.size)) throw new RemoteError("SOURCE_CHANGED");
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat({ bigint: true });
        if (opened.dev !== info.dev || opened.ino !== info.ino) throw new RemoteError("SOURCE_CHANGED");
        const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let size = 0;
        while (true) {
          checkTime();
          const read = await handle.read(buffer, 0, Math.min(buffer.length, file.size + 1 - size), null);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
          if (size > file.size) throw new RemoteError("SOURCE_CHANGED");
          hash.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await handle.stat({ bigint: true }), pathAfter = await lstat(path, { bigint: true });
        if (size !== file.size || hash.digest("hex") !== file.sha256 || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs || pathAfter.ino !== info.ino || pathAfter.dev !== info.dev || pathAfter.isSymbolicLink()) throw new RemoteError("SOURCE_CHANGED");
        seen.add(file.path);
      } finally { await handle.close(); }
    }
    const after = await lstat(directory, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new RemoteError("SOURCE_CHANGED");
  };
  try {
    await visit(root);
    const after = await lstat(root, { bigint: true });
    if (after.dev !== rootBefore.dev || after.ino !== rootBefore.ino || seen.size !== expected.size) throw new RemoteError("SOURCE_CHANGED");
  } catch (error) { throw error instanceof RemoteError ? error : new RemoteError("SOURCE_CHANGED"); }
}
