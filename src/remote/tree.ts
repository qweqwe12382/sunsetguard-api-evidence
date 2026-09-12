import { RemoteError, safeArchivePath } from "./policy.js";
import type { RemoteLimits } from "./policy.js";

export interface TreeFile { path: string; sha: string; size: number; mode: "100644" | "100755" }
export interface VerifiedTree { sha: string; files: TreeFile[]; directories: string[] }
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const isSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

export function parseTree(value: unknown, expectedSha: string, limits: RemoteLimits): VerifiedTree {
  if (!object(value) || value.sha !== expectedSha || value.truncated !== false || !Array.isArray(value.tree)) throw new RemoteError("INVALID_RESPONSE");
  if (value.tree.length > limits.maxEntries) throw new RemoteError("RESOURCE_LIMIT");
  const files: TreeFile[] = [], directories: string[] = [], entries = new Map<string, string>(), collisions = new Set<string>();
  let bytes = 0;
  for (const entry of value.tree) {
    if (!object(entry) || typeof entry.path !== "string" || !isSha(entry.sha)) throw new RemoteError("INVALID_RESPONSE");
    const file = safeArchivePath(entry.path, limits), key = file.normalize("NFC").toLowerCase();
    if (collisions.has(key)) throw new RemoteError("UNSAFE_ARCHIVE");
    collisions.add(key);
    if (entry.type === "tree" && entry.mode === "040000") { directories.push(file); entries.set(file, "tree"); }
    else if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")) {
      if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) throw new RemoteError("INVALID_RESPONSE");
      bytes += entry.size as number;
      if (bytes > limits.maxExpandedBytes) throw new RemoteError("RESOURCE_LIMIT");
      files.push({ path: file, sha: entry.sha, size: entry.size as number, mode: entry.mode }); entries.set(file, "blob");
    } else throw new RemoteError("UNSAFE_ARCHIVE"); // includes symlinks and submodules, without fetching targets
  }
  for (const file of entries.keys()) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth++) if (entries.get(parts.slice(0, depth).join("/")) !== "tree") throw new RemoteError("INVALID_RESPONSE");
  }
  return { sha: expectedSha, files, directories };
}
