import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AnalysisGap } from "../domain/index.js";
import type {
  LocalSnapshotOptions,
  LocalSnapshotResult,
  SnapshotFile,
  SnapshotInventory,
  SnapshotLimits,
  SnapshotScope,
} from "./types.js";

const MIB = 1024 * 1024;

export const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxFileBytes: 2 * MIB,
  maxTotalBytes: 50 * MIB,
  maxFiles: 5_000,
  maxEntries: 20_000,
  maxDepth: 128,
  timeoutMs: 120_000,
});

export const SNAPSHOT_EXTENSIONS = Object.freeze([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
] as const);

export const DEFAULT_EXCLUDED_DIRECTORIES = Object.freeze([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".cache", "vendor",
] as const);

export const DECLARATION_SUFFIXES = Object.freeze([".d.ts", ".d.mts", ".d.cts"] as const);

interface DirectoryWork { absolutePath: string; depth: number }

class ScanInterrupted extends Error {
  constructor(readonly reason: "cancelled" | "timeout" | "entries" | "files" | "bytes") {
    super(reason);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRelative(root: string, candidate: string): string | undefined {
  const value = relative(root, candidate);
  if (value === "") return "";
  if (isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) return undefined;
  return value.split(sep).join("/");
}

function validatePositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function createScope(options: LocalSnapshotOptions): SnapshotScope {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const optionKeys = new Set(["limits", "excludeDirectories", "signal"]);
  for (const key of Object.keys(options)) {
    if (!optionKeys.has(key)) throw new TypeError("options contains an unknown property");
  }
  const suppliedLimits = options.limits ?? {};
  if (suppliedLimits === null || typeof suppliedLimits !== "object" || Array.isArray(suppliedLimits)) {
    throw new TypeError("options.limits must be an object");
  }
  const limitKeys: readonly (keyof SnapshotLimits)[] = [
    "maxFileBytes", "maxTotalBytes", "maxFiles", "maxEntries", "maxDepth", "timeoutMs",
  ];
  for (const key of Object.keys(suppliedLimits)) {
    if (!limitKeys.includes(key as keyof SnapshotLimits)) throw new TypeError("unknown limit property");
  }
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...suppliedLimits };
  for (const key of limitKeys) validatePositiveInteger(`limits.${key}`, limits[key]);

  const additions = options.excludeDirectories ?? [];
  if (!Array.isArray(additions)) throw new TypeError("excludeDirectories must be an array");
  for (const name of additions) {
    if (typeof name !== "string" || name.length === 0 || name === "." || name === ".." ||
        name.includes("/") || name.includes("\\") || name.includes("\0")) {
      throw new TypeError("each excluded directory must be a non-empty basename");
    }
  }
  if (options.signal !== undefined &&
      (typeof options.signal !== "object" || typeof options.signal.aborted !== "boolean")) {
    throw new TypeError("signal must be an AbortSignal");
  }
  const directoryCaseSensitive = process.platform !== "win32";
  const excludedDirectories = [...new Set([...DEFAULT_EXCLUDED_DIRECTORIES, ...additions])]
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return {
    extensions: SNAPSHOT_EXTENSIONS,
    excludedDirectories: Object.freeze(excludedDirectories),
    excludedSuffixes: DECLARATION_SUFFIXES,
    directoryCaseSensitive,
    followSymlinks: false,
    respectGitignore: false,
    limits: Object.freeze(limits),
  };
}

function emptyInventory(): SnapshotInventory {
  return {
    discoveredFiles: 0,
    excludedByPolicy: 0,
    eligibleFiles: 0,
    readFiles: 0,
    failedOrSkippedEligibleFiles: 0,
    excludedDirectories: 0,
    observedEntries: 0,
  };
}

function gap(code: AnalysisGap["code"], message: string): AnalysisGap {
  return { code, message, affectsConclusion: true };
}

function displayPath(path: string): string {
  return JSON.stringify(path).replace(/[\u007f-\u009f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function hasUnsupportedPathCharacters(path: string): boolean {
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) return true;
  }
  return false;
}

function isEligible(path: string, scope: SnapshotScope): boolean {
  const lower = path.toLowerCase();
  return scope.extensions.some((extension) => lower.endsWith(extension)) &&
    !scope.excludedSuffixes.some((suffix) => lower.endsWith(suffix));
}

function sameIdentity(a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function verifyContained(root: string, candidate: string): Promise<boolean> {
  const resolved = await realpath(candidate);
  return normalizedRelative(root, resolved) !== undefined;
}

async function verifyPathChain(
  root: string,
  rootIdentity: Awaited<ReturnType<typeof lstat>>,
  candidate: string,
): Promise<boolean> {
  const relativePath = normalizedRelative(root, candidate);
  if (relativePath === undefined) return false;
  if (!sameIdentity(rootIdentity, await lstat(root))) return false;
  if (relativePath === "") return true;
  let cursor = root;
  for (const part of relativePath.split("/")) {
    cursor = resolve(cursor, part);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) return false;
  }
  return verifyContained(root, candidate);
}

async function readStableFile(
  root: string,
  rootIdentity: Awaited<ReturnType<typeof lstat>>,
  absolutePath: string,
  relativePath: string,
  maxBytes: number,
  remainingTotalBytes: () => number,
  consumeBytes: (count: number) => void,
  checkInterrupted: () => void,
): Promise<{ file?: SnapshotFile; changed?: boolean; rejectedHardlink?: boolean; resourceLimit?: boolean }> {
  const before = await lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) return {};
  if (before.nlink > 1) return { rejectedHardlink: true };
  if (!(await verifyPathChain(root, rootIdentity, absolutePath))) return { changed: true };

  const handle = await open(absolutePath, fsConstants.O_RDONLY);
  try {
    checkInterrupted();
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || !sameIdentity(before, opened)) return { changed: true };
    if (!(await verifyPathChain(root, rootIdentity, absolutePath))) return { changed: true };
    if (opened.size > maxBytes || opened.size > remainingTotalBytes()) return { resourceLimit: true };
    const buffer = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      checkInterrupted();
      const readLength = Math.min(64 * 1024, buffer.length - offset, remainingTotalBytes());
      if (readLength <= 0) return { resourceLimit: true };
      const { bytesRead } = await handle.read(buffer, offset, readLength, offset);
      consumeBytes(bytesRead);
      if (bytesRead === 0) break;
      offset += bytesRead;
      checkInterrupted();
    }
    const afterHandle = await handle.stat();
    const afterPath = await lstat(absolutePath);
    checkInterrupted();
    if (offset !== opened.size || !sameIdentity(opened, afterHandle) || !sameIdentity(afterHandle, afterPath) ||
        !(await verifyPathChain(root, rootIdentity, absolutePath))) return { changed: true };
    const bytes = buffer.subarray(0, offset);
    return { file: { path: relativePath, bytes, contentHash: sha256(bytes) } };
  } finally {
    await handle.close();
  }
}

/** Capture bounded, read-only source bytes. This is acquisition only, not reference analysis. */
export async function captureLocalSnapshot(
  rootPath: string,
  options: LocalSnapshotOptions = {},
): Promise<LocalSnapshotResult> {
  if (typeof rootPath !== "string" || rootPath.trim().length === 0 || rootPath.includes("\0")) {
    throw new TypeError("rootPath must be a non-empty path string");
  }
  const scope = createScope(options);
  const inventory = emptyInventory();
  const files: SnapshotFile[] = [];
  const gaps: AnalysisGap[] = [];
  const startedAt = performance.now();
  const checkInterrupted = (): void => {
    if (options.signal?.aborted === true) throw new ScanInterrupted("cancelled");
    if (performance.now() - startedAt >= scope.limits.timeoutMs) throw new ScanInterrupted("timeout");
  };

  let root: string;
  let rootIdentity: Awaited<ReturnType<typeof lstat>>;
  try {
    root = await realpath(resolve(rootPath));
    rootIdentity = await lstat(root);
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new Error("not a directory");
  } catch {
    return { phase: "snapshot", status: "failed", scope, inventory, files, gaps: [
      gap("SOURCE_UNAVAILABLE", "The local source root is unavailable or is not a readable directory."),
    ] };
  }

  const directoryKey = (name: string): string => scope.directoryCaseSensitive ? name : name.toLowerCase();
  const excluded = new Set(scope.excludedDirectories.map(directoryKey));
  const queue: DirectoryWork[] = [{ absolutePath: root, depth: 0 }];
  let consumedBytes = 0;
  let sourceUnavailable = false;
  try {
    while (queue.length > 0) {
      checkInterrupted();
      const current = queue.shift();
      if (current === undefined) break;
      const currentStats = await lstat(current.absolutePath);
      if (!currentStats.isDirectory() || currentStats.isSymbolicLink() ||
          !(await verifyPathChain(root, rootIdentity, current.absolutePath))) {
        gaps.push(gap("SNAPSHOT_CHANGED", "A directory changed identity during snapshot capture."));
        continue;
      }
      const directory = await opendir(current.absolutePath);
      try {
        if (!(await verifyPathChain(root, rootIdentity, current.absolutePath))) {
          gaps.push(gap("SNAPSHOT_CHANGED", "A directory changed identity before enumeration."));
          continue;
        }
        for await (const entry of directory) {
          checkInterrupted();
          inventory.observedEntries += 1;
          if (inventory.observedEntries > scope.limits.maxEntries) throw new ScanInterrupted("entries");
          const absolutePath = resolve(current.absolutePath, entry.name);
          const relativePath = normalizedRelative(root, absolutePath);
          if (relativePath === undefined || relativePath === "") {
            gaps.push(gap("SNAPSHOT_CHANGED", "An observed entry was outside the verified source root."));
            continue;
          }
          const entryStats = await lstat(absolutePath);
          if (hasUnsupportedPathCharacters(relativePath)) {
            if (entryStats.isFile() && isEligible(relativePath, scope)) {
              inventory.discoveredFiles += 1;
              inventory.eligibleFiles += 1;
              inventory.failedOrSkippedEligibleFiles += 1;
            }
            gaps.push(gap("FILE_READ_FAILED", `Skipped entry with unsupported path characters: ${displayPath(relativePath)}`));
            continue;
          }
          if (entryStats.isSymbolicLink()) {
            if (excluded.has(directoryKey(entry.name))) {
              inventory.excludedDirectories += 1;
              continue;
            }
            if (isEligible(relativePath, scope)) {
              inventory.discoveredFiles += 1;
              inventory.eligibleFiles += 1;
              inventory.failedOrSkippedEligibleFiles += 1;
            }
            gaps.push(gap("SYMLINK_SKIPPED", `Skipped symbolic-link entry: ${displayPath(relativePath)}`));
            continue;
          }
          if (entryStats.isDirectory()) {
            if (excluded.has(directoryKey(entry.name))) {
              inventory.excludedDirectories += 1;
            } else if (current.depth >= scope.limits.maxDepth) {
              gaps.push(gap("RESOURCE_LIMIT", `Directory depth limit reached at: ${displayPath(relativePath)}`));
            } else {
              queue.push({ absolutePath, depth: current.depth + 1 });
            }
            continue;
          }
          if (!entryStats.isFile()) continue;
          inventory.discoveredFiles += 1;
          if (!isEligible(relativePath, scope)) {
            inventory.excludedByPolicy += 1;
            continue;
          }
          inventory.eligibleFiles += 1;
          if (inventory.eligibleFiles > scope.limits.maxFiles) {
            inventory.failedOrSkippedEligibleFiles += 1;
            throw new ScanInterrupted("files");
          }
          if (entryStats.size > scope.limits.maxFileBytes) {
            inventory.failedOrSkippedEligibleFiles += 1;
            gaps.push(gap("RESOURCE_LIMIT", `Source file exceeds the per-file byte limit: ${displayPath(relativePath)}`));
            continue;
          }
          if (consumedBytes + entryStats.size > scope.limits.maxTotalBytes) {
            inventory.failedOrSkippedEligibleFiles += 1;
            throw new ScanInterrupted("bytes");
          }
          try {
            const result = await readStableFile(
              root,
              rootIdentity,
              absolutePath,
              relativePath,
              scope.limits.maxFileBytes,
              () => scope.limits.maxTotalBytes - consumedBytes,
              (count) => { consumedBytes += count; },
              checkInterrupted,
            );
            if (result.file !== undefined) {
              files.push(result.file);
              inventory.readFiles += 1;
            } else if (result.resourceLimit) {
              throw new ScanInterrupted("bytes");
            } else {
              inventory.failedOrSkippedEligibleFiles += 1;
              gaps.push(gap(result.changed ? "SNAPSHOT_CHANGED" : "FILE_READ_FAILED",
                result.changed ? `Source file changed during snapshot capture: ${displayPath(relativePath)}` :
                  result.rejectedHardlink ? `Skipped multiply-linked source file: ${displayPath(relativePath)}` :
                    `Source file could not be safely read: ${displayPath(relativePath)}`));
            }
          } catch (error) {
            if (error instanceof ScanInterrupted) {
              inventory.failedOrSkippedEligibleFiles += 1;
              throw error;
            }
            inventory.failedOrSkippedEligibleFiles += 1;
            gaps.push(gap("FILE_READ_FAILED", `Source file could not be safely read: ${displayPath(relativePath)}`));
          }
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
    }
    checkInterrupted();
  } catch (error) {
    if (error instanceof ScanInterrupted) {
      const messages: Record<ScanInterrupted["reason"], string> = {
        cancelled: "Snapshot capture was cancelled.",
        timeout: "Snapshot capture exceeded its time budget.",
        entries: "Snapshot capture exceeded its directory-entry limit.",
        files: "Snapshot capture exceeded its source-file limit.",
        bytes: "Snapshot capture exceeded its total-byte limit.",
      };
      gaps.push(gap("RESOURCE_LIMIT", messages[error.reason]));
    } else {
      if (inventory.observedEntries === 0 && files.length === 0) {
        sourceUnavailable = true;
        gaps.push(gap("SOURCE_UNAVAILABLE", "The local source root could not be enumerated safely."));
      } else {
        gaps.push(gap("FILE_READ_FAILED", "Directory enumeration could not be completed safely."));
      }
    }
  }

  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const contentHash = sha256(files.map((file) =>
    `${Buffer.byteLength(file.path, "utf8")}:${file.path}:${file.bytes.byteLength}:${file.contentHash}`,
  ).join("\n"));
  const scopeHash = sha256(JSON.stringify(scope));
  const snapshot = { kind: "local" as const, sourceId: contentHash, contentHash, scopeHash };
  if (files.length === 0 && gaps.every((item) => item.code !== "SOURCE_UNAVAILABLE" &&
      item.code !== "RESOURCE_LIMIT" && item.code !== "FILE_READ_FAILED" && item.code !== "SNAPSHOT_CHANGED")) {
    gaps.push(gap("NO_ANALYZABLE_FILES", "No analyzable source files were read within the configured scope."));
  }
  return {
    phase: "snapshot",
    status: sourceUnavailable ? "failed" : gaps.length === 0 ? "complete-within-scope" : "partial",
    ...(sourceUnavailable ? {} : { snapshot }),
    scope,
    inventory,
    files,
    gaps,
  };
}
