import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { locationSchema } from "../domain/index.js";

export const ATTRIBUTION_VERSION = "0.1.0-t06";
export const ATTRIBUTION_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxFiles: 128,
  maxLookups: 20_000,
  maxDepth: 128,
  maxExtendsDepth: 16,
});

export interface AttributionOptions { signal?: AbortSignal; timeoutMs?: number }
export type ConfigData = { kind: "ok"; text: string } | { kind: "missing" } |
  { kind: "failed"; reason: string };
type Identity = Awaited<ReturnType<typeof identity>>;
const identity = (path: string) => lstat(path, { bigint: true });
const same = (a: Identity, b: Identity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => (error as { code?: string } | undefined)?.code === "ENOENT";

export function safeConfigPath(path: string): boolean {
  return locationSchema.safeParse({ file: path, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }).success &&
    !path.includes(":") && /\.jsonc?$/i.test(path) && path.split("/").length <= ATTRIBUTION_LIMITS.maxDepth + 1;
}

/** Root-bounded JSON bytes only. Never loads a project, configuration module, or dependency. */
export async function createConfigReader(rootPath: string, options: AttributionOptions = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some(key => key !== "signal" && key !== "timeoutMs")) {
    throw new TypeError("Configuration options must contain only signal and timeoutMs.");
  }
  if (options.signal !== undefined && (options.signal === null || typeof options.signal !== "object" ||
      typeof options.signal.aborted !== "boolean" || typeof options.signal.addEventListener !== "function" ||
      typeof options.signal.removeEventListener !== "function")) {
    throw new TypeError("Configuration signal must be an AbortSignal.");
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
    throw new TypeError("Configuration timeout must be a finite non-negative number.");
  }
  const deadline = performance.now() + (options.timeoutMs ?? 120_000);
  let root: string | undefined;
  let rootIdentity: Identity | undefined;
  try {
    root = await realpath(resolve(rootPath));
    rootIdentity = await identity(root);
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) rootIdentity = undefined;
  } catch { /* Root failure is data, not a filesystem exception in the report. */ }
  const cache = new Map<string, ConfigData>();
  const records = new Map<string, { kind: string; digest?: string; bytes?: number }>();
  const directoryIdentities = new Map<string, Identity>();
  let files = 0, bytes = 0, lookups = 0;
  let limitReason: string | undefined;

  function interruption(): string | undefined {
    if (limitReason !== undefined) return limitReason;
    if (options.signal?.aborted === true) limitReason = "Configuration reading was cancelled.";
    else if (performance.now() >= deadline) limitReason = "Configuration reading exceeded its time budget.";
    return limitReason;
  }

  async function verifyDirectories(file: string): Promise<boolean> {
    if (root === undefined || rootIdentity === undefined || !same(rootIdentity, await identity(root))) return false;
    let path = root;
    for (const segment of file.split("/").slice(0, -1)) {
      if (interruption()) return false;
      path = resolve(path, segment);
      const info = await identity(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const previous = directoryIdentities.get(path);
      if (previous !== undefined && !same(previous, info)) return false;
      directoryIdentities.set(path, info);
      if (relative(path, await realpath(path)) !== "") return false;
    }
    return true;
  }

  async function readUncached(file: string): Promise<ConfigData> {
    if (root === undefined || rootIdentity === undefined) return { kind: "failed", reason: "The configuration root is unavailable." };
    if (!(await verifyDirectories(file))) return { kind: "failed", reason: "A configuration directory could not be verified safely." };
    const path = resolve(root, ...file.split("/"));
    const rel = relative(root, path);
    if (rel.startsWith(`..${sep}`) || rel === ".." || rel === "") {
      return { kind: "failed", reason: "A configuration path was rejected." };
    }
    let before: Identity;
    try { before = await identity(path); }
    catch (error) {
      if (missing(error) && await verifyDirectories(file)) return { kind: "missing" };
      return { kind: "failed", reason: "A configuration file could not be inspected." };
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || relative(path, await realpath(path)) !== "") {
      return { kind: "failed", reason: "A linked or non-regular configuration file was rejected." };
    }
    files += 1;
    if (files > ATTRIBUTION_LIMITS.maxFiles) {
      limitReason = "The configuration file-count budget was exhausted.";
      return { kind: "failed", reason: limitReason };
    }
    if (before.size > BigInt(ATTRIBUTION_LIMITS.maxFileBytes)) {
      return { kind: "failed", reason: "A configuration file exceeded its byte limit." };
    }
    if (before.size > BigInt(ATTRIBUTION_LIMITS.maxTotalBytes - bytes)) {
      limitReason = "The cumulative configuration byte budget was exhausted.";
      return { kind: "failed", reason: limitReason };
    }
    const interrupted = interruption();
    if (interrupted) return { kind: "failed", reason: interrupted };
    const handle = await open(path, constants.O_RDONLY);
    let buffer: Buffer | undefined;
    let offset = 0;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !same(before, opened) || !(await verifyDirectories(file))) {
        return { kind: "failed", reason: "A configuration file changed while opening." };
      }
      buffer = Buffer.alloc(Number(opened.size));
      while (offset < buffer.length) {
        const stopped = interruption();
        if (stopped) return { kind: "failed", reason: stopped };
        const length = Math.min(64 * 1024, buffer.length - offset, ATTRIBUTION_LIMITS.maxTotalBytes - bytes);
        if (length <= 0) {
          limitReason = "The cumulative configuration byte budget was exhausted.";
          return { kind: "failed", reason: limitReason };
        }
        const result = await handle.read(buffer, offset, length, offset);
        offset += result.bytesRead;
        bytes += result.bytesRead; // Discarded or changed bytes consume the same budget.
        if (result.bytesRead === 0) break;
      }
      records.set(file, { kind: "read", digest: hash(buffer.subarray(0, offset)), bytes: offset });
      const ended = await handle.stat({ bigint: true });
      const after = await identity(path);
      const stopped = interruption();
      if (stopped) return { kind: "failed", reason: stopped };
      if (offset !== buffer.length || !same(opened, ended) || !same(ended, after) || after.nlink !== 1n ||
          !(await verifyDirectories(file)) || relative(path, await realpath(path)) !== "") {
        return { kind: "failed", reason: "A configuration file changed while reading." };
      }
      try { return { kind: "ok", text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) }; }
      catch { return { kind: "failed", reason: "A configuration file was not valid UTF-8." }; }
    } finally {
      if (buffer !== undefined && !records.has(file)) records.set(file, { kind: "read", digest: hash(buffer.subarray(0, offset)), bytes: offset });
      await handle.close();
    }
  }

  return {
    async read(file: string): Promise<ConfigData> {
      if (!safeConfigPath(file)) return { kind: "failed", reason: "An unsafe configuration path was rejected." };
      const stopped = interruption();
      if (stopped) return { kind: "failed", reason: stopped };
      const prior = cache.get(file);
      if (prior !== undefined) return prior;
      lookups += 1;
      if (lookups > ATTRIBUTION_LIMITS.maxLookups) {
        limitReason = "The configuration lookup budget was exhausted.";
        return { kind: "failed", reason: limitReason };
      }
      let result: ConfigData;
      try { result = await readUncached(file); }
      catch { result = { kind: "failed", reason: "A configuration file could not be read safely." }; }
      const record = records.get(file);
      records.set(file, { ...record, kind: result.kind });
      cache.set(file, result);
      return result;
    },
    get contentHash(): string {
      return hash(JSON.stringify({ version: ATTRIBUTION_VERSION, records: [...records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), limitReason }));
    },
    get resourceIssue(): string | undefined { return interruption(); },
  };
}
