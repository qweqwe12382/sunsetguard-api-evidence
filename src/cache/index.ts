import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseApiTarget, validateScanReport } from "../domain/index.js";
import type { ApiTarget, ScanReport } from "../domain/index.js";
import { isWithinRoot } from "../snapshots/path-policy.js";
import { normalizeGitHubInput, REMOTE_POLICY_VERSION, remoteLimits, safeArchivePath } from "../remote/policy.js";
import type { GitHubInput, RemoteLimits } from "../remote/policy.js";
import type { GitHubSnapshot } from "../remote/snapshot.js";
import type { VerifiedAcquisition } from "../remote/acquire.js";
import type { VerifiedFile } from "../remote/archive.js";
import { verifyExtractedFiles } from "../remote/verify-files.js";
import { isRedactedSnippet } from "../reports/snippets.js";

export const CACHE_VERSION = "0.1.0-t10";
export const CACHE_LIMITS = Object.freeze({ maxDiskBytes: 512 * 1024 * 1024, maxEntries: 100_000, maxRecords: 512, maxRecordBytes: 16 * 1024 * 1024, timeoutMs: 120_000 });
export type CacheLimits = { -readonly [K in keyof typeof CACHE_LIMITS]: number };
export interface CacheIO { deadline?: number; signal?: AbortSignal }
export class CacheError extends Error {
  constructor(readonly code: "UNSAFE" | "CORRUPT" | "CAPACITY" | "BUSY" | "CANCELLED" | "TIMEOUT" | "IO" | "CLEANUP") {
    super(`Cache ${code.toLowerCase()}; cache data could not be used safely.`); this.name = "CacheError";
  }
}
export interface AnalysisCacheIdentity {
  repository: string; commit: string; snapshotHash: string; target: ApiTarget;
  analyzerVersion: string; ruleSetVersion: string; analysisProfile: "module-syntax-v1";
  /** Canonical policy data; excludes paths, credentials, timestamps and elapsed time. */
  scopePolicy: string; remotePolicy: string; snippetPolicy: string; includeSnippets: boolean;
}
export interface CachedSnapshot { snapshot: GitHubSnapshot; snapshotHash: string }
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => JSON.stringify(value);
const hash = (value: unknown) => digest(json(value));
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value: unknown, length: number): value is string => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const missing = (error: unknown) => isObject(error) && error.code === "ENOENT";
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const groups = ["snapshots", "analyses", "blobs"] as const;
type Group = typeof groups[number];
interface Budget { bytes: number; entries: number; records: number }
interface Envelope { version: string; kind: "snapshot" | "analysis"; checksum: string; value: unknown }
interface SnapshotRecord { policy: string; metadata: VerifiedAcquisition }

function context(limits: CacheLimits, io: CacheIO): { check(): void; deadline: number; signal?: AbortSignal } {
  if (io === null || typeof io !== "object" || Array.isArray(io) || Object.keys(io).some(key => !["deadline", "signal"].includes(key)) || (io.deadline !== undefined && (typeof io.deadline !== "number" || !Number.isFinite(io.deadline))) || (io.signal !== undefined && !(io.signal instanceof AbortSignal))) throw new CacheError("UNSAFE");
  const deadline = Math.min(performance.now() + limits.timeoutMs, io.deadline ?? Infinity);
  const check = () => { if (io.signal?.aborted) throw new CacheError("CANCELLED"); if (performance.now() >= deadline) throw new CacheError("TIMEOUT"); };
  check(); return { check, deadline, ...(io.signal === undefined ? {} : { signal: io.signal }) };
}
type Context = ReturnType<typeof context>;

async function canonicalPotential(path: string): Promise<string> {
  const suffix: string[] = []; let current = resolve(path);
  for (;;) {
    try { return join(await realpath(current), ...suffix); }
    catch (error) { if (!missing(error) || dirname(current) === current) throw error; suffix.unshift(basename(current)); current = dirname(current); }
  }
}

async function directoryIdentity(path: string): Promise<BigIntStats> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(path, await realpath(path)) !== "") throw new CacheError("UNSAFE");
  return metadata;
}
async function ancestors(path: string): Promise<Map<string, BigIntStats>> {
  const result = new Map<string, BigIntStats>();
  for (let current = path; ; current = dirname(current)) {
    result.set(current, await directoryIdentity(current));
    if (dirname(current) === current) return result;
  }
}
async function checkedFile(path: string, maximum: number): Promise<{ handle: FileHandle; info: BigIntStats }> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(maximum)) throw new CacheError("UNSAFE");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { if (!same(info, await handle.stat({ bigint: true }))) throw new CacheError("UNSAFE"); }
  catch (error) { await handle.close(); throw error; }
  return { handle, info };
}
async function finishRead(path: string, handle: FileHandle, info: BigIntStats): Promise<void> {
  const after = await handle.stat({ bigint: true }), linked = await lstat(path, { bigint: true });
  if (!same(info, after) || !same(info, linked) || linked.isSymbolicLink() || linked.nlink !== 1n || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) throw new CacheError("CORRUPT");
}
async function readJSON(path: string, maximum: number, ctx: Context): Promise<unknown> {
  const { handle, info } = await checkedFile(path, maximum);
  try {
    const parts: Buffer[] = []; let size = 0;
    while (true) {
      ctx.check(); const buffer = Buffer.alloc(Math.min(65536, maximum + 1 - size));
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead; if (size > maximum) throw new CacheError("CAPACITY"); parts.push(buffer.subarray(0, read.bytesRead));
    }
    await finishRead(path, handle, info);
    const bytes = Buffer.concat(parts), text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (size !== Number(info.size)) throw new CacheError("CORRUPT");
    return JSON.parse(text) as unknown;
  } finally { await handle.close(); }
}
function envelope(value: unknown, kind: Envelope["kind"]): Buffer {
  return Buffer.from(json({ version: CACHE_VERSION, kind, checksum: hash(value), value } satisfies Envelope));
}
function unwrap(value: unknown, kind: Envelope["kind"]): unknown {
  if (!isObject(value) || Object.keys(value).sort().join() !== "checksum,kind,value,version" || value.version !== CACHE_VERSION || value.kind !== kind || value.checksum !== hash(value.value)) throw new CacheError("CORRUPT");
  return value.value;
}
function snapshotRecord(snapshot: VerifiedAcquisition): SnapshotRecord {
  return { policy: REMOTE_POLICY_VERSION, metadata: {
    input: { repository: snapshot.input.repository, ref: snapshot.commit }, commit: snapshot.commit, treeSha: snapshot.treeSha,
    archiveSha256: snapshot.archiveSha256, compressedBytes: snapshot.compressedBytes, expandedBytes: snapshot.expandedBytes,
    files: snapshot.files.map(file => ({ path: file.path, sha256: file.sha256, gitBlobSha: file.gitBlobSha, size: file.size })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  } };
}
export const snapshotCacheHash = (snapshot: VerifiedAcquisition): string => hash(snapshotRecord(snapshot));
function validateSnapshot(value: unknown, input: GitHubInput, limits: RemoteLimits): SnapshotRecord {
  if (!isObject(value) || value.policy !== REMOTE_POLICY_VERSION || !isObject(value.metadata)) throw new CacheError("CORRUPT");
  const data = value.metadata;
  if (!isObject(data.input) || data.input.repository !== input.repository || data.input.ref !== input.ref || data.commit !== input.ref || !sha(data.commit, 40) || !sha(data.treeSha, 40) || !sha(data.archiveSha256, 64) ||
      !Number.isSafeInteger(data.compressedBytes) || (data.compressedBytes as number) <= 0 || (data.compressedBytes as number) > limits.maxCompressedBytes ||
      !Number.isSafeInteger(data.expandedBytes) || (data.expandedBytes as number) < 0 || (data.expandedBytes as number) > limits.maxExpandedBytes || !Array.isArray(data.files) || data.files.length > limits.maxEntries) throw new CacheError("CORRUPT");
  let size = 0; const names = new Set<string>(), files: VerifiedFile[] = [];
  for (const file of data.files) {
    if (!isObject(file) || typeof file.path !== "string" || !sha(file.sha256, 64) || !sha(file.gitBlobSha, 40) || !Number.isSafeInteger(file.size) || (file.size as number) < 0) throw new CacheError("CORRUPT");
    const path = safeArchivePath(file.path, limits), canonical = path.normalize("NFC").toLowerCase();
    if (names.has(canonical)) throw new CacheError("CORRUPT"); names.add(canonical);
    size += file.size as number; if (size > (data.expandedBytes as number)) throw new CacheError("CORRUPT");
    files.push({ path, sha256: file.sha256, gitBlobSha: file.gitBlobSha, size: file.size as number });
  }
  for (const name of names) { const parts = name.split("/"); for (let depth = 1; depth < parts.length; depth++) if (names.has(parts.slice(0, depth).join("/"))) throw new CacheError("CORRUPT"); }
  const projected = snapshotRecord({ input, commit: data.commit, treeSha: data.treeSha, archiveSha256: data.archiveSha256, compressedBytes: data.compressedBytes as number, expandedBytes: data.expandedBytes as number, files });
  if (json(value) !== json(projected)) throw new CacheError("CORRUPT");
  return projected;
}
function snapshotKey(input: GitHubInput): string { return hash({ version: CACHE_VERSION, policy: REMOTE_POLICY_VERSION, repository: input.repository, commit: input.ref }); }
function analysisKey(identity: AnalysisCacheIdentity): string {
  if (normalizeGitHubInput({ repository: identity.repository, ref: identity.commit }).repository !== identity.repository || !sha(identity.commit, 40) || !sha(identity.snapshotHash, 64) || typeof identity.scopePolicy !== "string" || identity.scopePolicy.length > 32768 || typeof identity.includeSnippets !== "boolean") throw new CacheError("CORRUPT");
  parseApiTarget(identity.target);
  return hash({ version: CACHE_VERSION, identity });
}
export function canCacheAnalysis(report: ScanReport): boolean {
  const result = report.results[0];
  return report.reportKind === "scan" && report.sample.source === "explicit-list" && report.results.length === 1 && result?.snapshot?.kind === "git" && result.status !== "failed" &&
    result.inventory.failedOrSkippedEligibleFiles === 0 && result.gaps.every(gap => ["UNSUPPORTED_TARGET_PATTERN", "MODULE_ATTRIBUTION_AMBIGUOUS", "PARSE_FAILED", "NO_ANALYZABLE_FILES"].includes(gap.code));
}
function checkAnalysis(reportValue: unknown, identity: AnalysisCacheIdentity): ScanReport {
  const report = validateScanReport(reportValue), result = report.results[0];
  const policy = analysisPolicy(identity);
  const framed = createHash("sha256");
  for (const item of [hash(policy.snapshotScope), json(policy.analysisPolicy), json(policy.attributionPolicy)]) framed.update(String(Buffer.byteLength(item))).update(":").update(item).update(";");
  const expectedScope = hash({ localScope: framed.digest("hex"), remotePolicy: identity.remotePolicy, limits: policy.remoteLimits });
  if (!canCacheAnalysis(report) || report.analyzerVersion !== identity.analyzerVersion || report.ruleSetVersion !== identity.ruleSetVersion || report.analysisProfile !== identity.analysisProfile || json(report.target) !== json(identity.target) ||
      result?.repositoryId !== `github:${identity.repository}` || result.snapshot?.gitCommit !== identity.commit || result.snapshot.sourceId !== `github:${identity.repository}@${identity.commit}` ||
      result.snapshot.scopeHash !== expectedScope ||
      json(report.sample) !== json({ source: "explicit-list", selected: 1, excluded: 0, attempted: 1, knownTotal: 1, knownTotalUnit: "repositories", exclusionReasons: {} }) ||
      !report.limitations.includes(`snapshotScope=${json(policy.snapshotScope)}`) || !report.limitations.includes(`analysisPolicy=${json(policy.analysisPolicy)}`) || !report.limitations.includes(`attributionPolicy=${json(policy.attributionPolicy)}`) ||
      (!identity.includeSnippets && result.findings.some(finding => finding.snippet !== undefined))) throw new CacheError("CORRUPT");
  const names = new Map(result.bindings.map(binding => [binding.id, binding.localName]));
  if (result.findings.some(finding => finding.snippet !== undefined && (finding.snippetRedacted !== true || !isRedactedSnippet(finding.snippet, [identity.target.exportName, names.get(finding.bindingId) ?? identity.target.exportName])))) throw new CacheError("CORRUPT");
  return report;
}
function analysisPolicy(identity: AnalysisCacheIdentity): Record<string, unknown> & { remoteLimits: RemoteLimits } {
  const value: unknown = JSON.parse(identity.scopePolicy);
  if (!isObject(value) || !isObject(value.snapshotScope) || !isObject(value.analysisPolicy) || !isObject(value.attributionPolicy) || !isObject(value.remoteLimits)) throw new CacheError("CORRUPT");
  const limits = remoteLimits({ limits: value.remoteLimits });
  if (json(limits) !== json(value.remoteLimits)) throw new CacheError("CORRUPT");
  return { ...value, remoteLimits: limits };
}

/** Files are immutable raw blobs plus checksummed JSON records. This is integrity checking, not authentication against an owner who rewrites every hash. */
export class CacheStore {
  private constructor(private readonly directory: string, private readonly identities: Map<string, BigIntStats>, readonly limits: Readonly<CacheLimits>) {}
  static async create(directory: string, protectedRoots: readonly string[], limits: CacheLimits): Promise<CacheStore> {
    if (typeof directory !== "string" || directory.trim() === "" || directory.includes("\0") || (process.platform === "win32" && (directory.startsWith("\\\\") || resolve(directory).slice(parse(resolve(directory)).root.length).includes(":")))) throw new CacheError("UNSAFE");
    const path = resolve(directory); await ancestors(dirname(path));
    for (const root of protectedRoots) {
      const lexical = resolve(root), canonical = await canonicalPotential(root);
      if (isWithinRoot(lexical, path) || isWithinRoot(canonical, path) || isWithinRoot(path, lexical) || isWithinRoot(path, canonical)) throw new CacheError("UNSAFE");
    }
    let fresh = false;
    try { await lstat(path); } catch (error) { if (!missing(error)) throw error; await mkdir(path, { mode: 0o700 }); fresh = true; }
    const identities = await ancestors(path);
    if (fresh) {
      const marker = await open(join(path, "format.json"), "wx", 0o600);
      try { await marker.writeFile(json({ name: "SunsetGuard cache", version: CACHE_VERSION })); } finally { await marker.close(); }
      for (const group of groups) await mkdir(join(path, group), { mode: 0o700 });
    }
    for (const group of groups) identities.set(join(path, group), await directoryIdentity(join(path, group)));
    const store = new CacheStore(path, identities, Object.freeze({ ...limits }));
    await store.lease({}, async () => undefined); return store;
  }
  async assertOutsideRoots(roots: readonly string[]): Promise<void> {
    for (const root of roots) {
      const lexical = resolve(root), canonical = await canonicalPotential(root);
      if (isWithinRoot(lexical, this.directory) || isWithinRoot(canonical, this.directory) || isWithinRoot(this.directory, lexical) || isWithinRoot(this.directory, canonical)) throw new CacheError("UNSAFE");
    }
    await this.checkIdentities();
  }
  private async checkIdentities(): Promise<void> {
    for (const [path, identity] of this.identities) if (!same(identity, await directoryIdentity(path))) throw new CacheError("UNSAFE");
  }
  private async inventory(ctx: Context): Promise<Budget> {
    const budget: Budget = { bytes: 0, entries: 0, records: 0 };
    const visit = async (path: string, group?: Group) => {
      const entries = await opendir(path);
      for await (const entry of entries) {
        ctx.check(); if (++budget.entries > this.limits.maxEntries) throw new CacheError("CAPACITY");
        const info = await lstat(join(path, entry.name), { bigint: true });
        if (group === undefined && groups.includes(entry.name as Group)) { if (!info.isDirectory() || info.isSymbolicLink()) throw new CacheError("UNSAFE"); await visit(join(path, entry.name), entry.name as Group); continue; }
        if (group === undefined ? !["format.json", ".lease"].includes(entry.name) : !(group === "blobs" ? /^[a-f0-9]{64}$/.test(entry.name) : /^[a-f0-9]{64}\.json$/.test(entry.name))) throw new CacheError("CORRUPT");
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new CacheError("UNSAFE");
        budget.bytes += Number(info.size); if (budget.bytes > this.limits.maxDiskBytes) throw new CacheError("CAPACITY");
        if (group === "snapshots" || group === "analyses") { if (++budget.records > this.limits.maxRecords || info.size > BigInt(this.limits.maxRecordBytes)) throw new CacheError("CAPACITY"); }
      }
    };
    await visit(this.directory);
    const marker = await readJSON(join(this.directory, "format.json"), 256, ctx);
    if (json(marker) !== json({ name: "SunsetGuard cache", version: CACHE_VERSION })) throw new CacheError("CORRUPT");
    return budget;
  }
  private async lease<T>(io: CacheIO, action: (ctx: Context, budget: Budget) => Promise<T>): Promise<T> {
    const ctx = context(this.limits, io); let lock: FileHandle | undefined, identity: BigIntStats | undefined;
    try {
      await this.checkIdentities(); ctx.check();
      try { lock = await open(join(this.directory, ".lease"), "wx", 0o600); identity = await lock.stat({ bigint: true }); }
      catch { throw new CacheError("BUSY"); }
      const budget = await this.inventory(ctx); const result = await action(ctx, budget); ctx.check(); await this.checkIdentities(); return result;
    } catch (error) { throw error instanceof CacheError ? error : new CacheError("IO"); }
    finally {
      if (lock !== undefined) {
        await lock.close();
        await this.release(identity);
      }
    }
  }
  private async release(identity: BigIntStats | undefined): Promise<void> {
    await this.checkIdentities();
    const path = join(this.directory, ".lease"), current = await lstat(path, { bigint: true });
    if (identity === undefined || !same(current, identity) || current.isSymbolicLink()) throw new CacheError("CLEANUP");
    await unlink(path);
  }
  private reserve(budget: Budget, bytes: number, record: boolean): void {
    if (bytes > (record ? this.limits.maxRecordBytes : this.limits.maxDiskBytes) || budget.bytes + bytes > this.limits.maxDiskBytes || budget.entries + 1 > this.limits.maxEntries || (record && budget.records + 1 > this.limits.maxRecords)) throw new CacheError("CAPACITY");
    budget.bytes += bytes; budget.entries++; if (record) budget.records++;
  }
  private async writeRecord(group: "snapshots" | "analyses", key: string, bytes: Buffer, ctx: Context, budget: Budget): Promise<void> {
    const path = join(this.directory, group, `${key}.json`);
    try {
      const existing = await readJSON(path, this.limits.maxRecordBytes, ctx);
      if (json(existing) !== bytes.toString("utf8")) throw new CacheError("CORRUPT"); return;
    } catch (error) { if (!missing(error)) throw error; }
    this.reserve(budget, bytes.length, true); ctx.check(); await this.checkIdentities();
    const file = await open(path, "wx", 0o600), identity = await file.stat({ bigint: true }); let complete = false;
    try { for (let offset = 0; offset < bytes.length; offset += 65536) { ctx.check(); await file.writeFile(bytes.subarray(offset, offset + 65536)); } await file.sync(); complete = true; }
    finally { await file.close(); if (!complete) await this.rollbackCreated(path, identity); }
  }
  private async rollbackCreated(path: string, identity: BigIntStats): Promise<void> {
    await this.checkIdentities();
    if (!groups.some(group => dirname(path) === join(this.directory, group))) throw new CacheError("CLEANUP");
    const current = await lstat(path, { bigint: true });
    if (!same(identity, current) || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) throw new CacheError("CLEANUP");
    await unlink(path);
  }
  private async transfer(source: string, destination: string | undefined, file: VerifiedFile, ctx: Context, rollback = false): Promise<void> {
    const { handle, info } = await checkedFile(source, file.size); let output: FileHandle | undefined, outputIdentity: BigIntStats | undefined, complete = false;
    try {
      if (Number(info.size) !== file.size) throw new CacheError("CORRUPT");
      if (destination !== undefined) { output = await open(destination, "wx", 0o600); outputIdentity = await output.stat({ bigint: true }); }
      const sha256 = createHash("sha256"), git = createHash("sha1").update(`blob ${file.size}\0`), buffer = Buffer.alloc(65536); let size = 0;
      while (true) {
        ctx.check(); const read = await handle.read(buffer, 0, Math.min(buffer.length, file.size + 1 - size), null);
        if (read.bytesRead === 0) break;
        size += read.bytesRead; if (size > file.size) throw new CacheError("CORRUPT");
        const bytes = buffer.subarray(0, read.bytesRead); sha256.update(bytes); git.update(bytes); if (output !== undefined) await output.writeFile(bytes);
      }
      if (size !== file.size || sha256.digest("hex") !== file.sha256 || git.digest("hex") !== file.gitBlobSha) throw new CacheError("CORRUPT");
      await finishRead(source, handle, info); if (output !== undefined) await output.sync(); complete = true;
    } finally { await handle.close(); if (output !== undefined) await output.close(); if (rollback && !complete && destination !== undefined && outputIdentity !== undefined) await this.rollbackCreated(destination, outputIdentity); }
  }
  async putSnapshot(snapshot: GitHubSnapshot, limits: RemoteLimits, io: CacheIO = {}): Promise<string> {
    const input = normalizeGitHubInput({ repository: snapshot.input.repository, ref: snapshot.commit });
    const record = validateSnapshot(snapshotRecord(snapshot), input, limits);
    return this.lease(io, async (ctx, budget) => {
      if (isWithinRoot(snapshot.directory, this.directory) || isWithinRoot(this.directory, snapshot.directory)) throw new CacheError("UNSAFE");
      await verifyExtractedFiles(snapshot.directory, record.metadata.files, ctx.deadline, ctx.signal);
      for (const file of record.metadata.files) {
        const path = join(this.directory, "blobs", file.sha256);
        try { await this.transfer(path, undefined, file, ctx); }
        catch (error) { if (!missing(error)) throw error; this.reserve(budget, file.size, false); await this.checkIdentities(); await this.transfer(join(snapshot.directory, ...file.path.split("/")), path, file, ctx, true); }
      }
      await verifyExtractedFiles(snapshot.directory, record.metadata.files, ctx.deadline, ctx.signal);
      await this.writeRecord("snapshots", snapshotKey(input), envelope(record, "snapshot"), ctx, budget); return hash(record);
    });
  }
  async getSnapshot(inputValue: GitHubInput, limits: RemoteLimits, io: CacheIO = {}): Promise<CachedSnapshot | undefined> {
    const input = normalizeGitHubInput(inputValue); if (!sha(input.ref, 40)) return undefined;
    let temporary: { directory: string; dispose(): Promise<void> } | undefined;
    try {
      return await this.lease(io, async ctx => {
        let value: unknown;
        try { value = await readJSON(join(this.directory, "snapshots", `${snapshotKey(input)}.json`), this.limits.maxRecordBytes, ctx); }
        catch (error) { if (missing(error)) return undefined; throw error; }
        const record = validateSnapshot(unwrap(value, "snapshot"), input, limits);
        temporary = await privateSnapshot();
        for (const file of record.metadata.files) {
          const destination = join(temporary.directory, ...file.path.split("/"));
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await this.transfer(join(this.directory, "blobs", file.sha256), destination, file, ctx);
        }
        await verifyExtractedFiles(temporary.directory, record.metadata.files, ctx.deadline, ctx.signal);
        return { snapshot: { ...record.metadata, status: "ready", ...temporary }, snapshotHash: hash(record) };
      });
    } catch (error) { if (temporary !== undefined) await temporary.dispose(); throw error; }
  }
  async getAnalysis(identity: AnalysisCacheIdentity, io: CacheIO = {}): Promise<ScanReport | undefined> {
    const key = analysisKey(identity);
    return this.lease(io, async ctx => {
      let raw: unknown;
      try { raw = await readJSON(join(this.directory, "analyses", `${key}.json`), this.limits.maxRecordBytes, ctx); }
      catch (error) { if (missing(error)) return undefined; throw error; }
      const value = unwrap(raw, "analysis");
      if (!isObject(value) || json(value.identity) !== json(identity)) throw new CacheError("CORRUPT");
      const report = checkAnalysis(value.report, identity);
      await this.checkAnalysisSource(identity, report, ctx);
      report.generatedAt = new Date().toISOString();
      report.limitations.push("Analysis cache hit: evidence and original analysis policies were reused for the same verified snapshot; generatedAt is this report assembly time.");
      return validateScanReport(report);
    });
  }
  async putAnalysis(identity: AnalysisCacheIdentity, reportValue: ScanReport, io: CacheIO = {}): Promise<void> {
    const key = analysisKey(identity), report = checkAnalysis(reportValue, identity);
    await this.lease(io, async (ctx, budget) => {
      await this.checkAnalysisSource(identity, report, ctx);
      // Immutable records retain the original analysis timestamp; a hit assembles a new report timestamp.
      const path = join(this.directory, "analyses", `${key}.json`);
      try {
        const previous = unwrap(await readJSON(path, this.limits.maxRecordBytes, ctx), "analysis");
        if (!isObject(previous) || json(previous.identity) !== json(identity)) throw new CacheError("CORRUPT");
        checkAnalysis(previous.report, identity); return;
      } catch (error) { if (!missing(error)) throw error; }
      await this.writeRecord("analyses", key, envelope({ identity, report }, "analysis"), ctx, budget);
    });
  }
  private async checkAnalysisSource(identity: AnalysisCacheIdentity, report: ScanReport, ctx: Context): Promise<void> {
    const input = { repository: identity.repository, ref: identity.commit }, limits = analysisPolicy(identity).remoteLimits;
    const raw = await readJSON(join(this.directory, "snapshots", `${snapshotKey(input)}.json`), this.limits.maxRecordBytes, ctx);
    const record = validateSnapshot(unwrap(raw, "snapshot"), input, limits), metadata = record.metadata;
    if (hash(record) !== identity.snapshotHash || !report.limitations.includes(`remotePolicy=${json({ version: identity.remotePolicy, limits, treeSha: metadata.treeSha, archiveSha256: metadata.archiveSha256, verifiedFiles: metadata.files.length })}`)) throw new CacheError("CORRUPT");
    const files = new Set(metadata.files.map(file => file.path)), result = report.results[0]!;
    if ([...result.bindings, ...result.findings].some(evidence => !files.has(evidence.location.file)) || result.gaps.some(gap => gap.location !== undefined && !files.has(gap.location.file))) throw new CacheError("CORRUPT");
  }
}

async function privateSnapshot(): Promise<{ directory: string; dispose(): Promise<void> }> {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(join(parent, `sunsetguard-cache-${randomUUID()}-`));
  const identity = await directoryIdentity(directory); let disposal: Promise<void> | undefined;
  const remove = async () => {
    if (dirname(directory) !== parent || await realpath(parent) !== parent || !same(identity, await directoryIdentity(directory))) throw new CacheError("CLEANUP");
    await rm(directory, { recursive: true, force: false, maxRetries: 2 });
  };
  return { directory, dispose: () => disposal ??= remove() };
}
export async function createCache(directory: string, protectedRoots: readonly string[] = [], options: { limits?: Partial<CacheLimits> } = {}): Promise<CacheStore> {
  const limits: CacheLimits = { ...CACHE_LIMITS };
  if (options === null || typeof options !== "object" || Object.keys(options).some(key => key !== "limits") || (options.limits !== undefined && !isObject(options.limits))) throw new TypeError("Invalid cache options.");
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(CACHE_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > CACHE_LIMITS[key as keyof CacheLimits]) throw new TypeError("Cache limits may only lower the defaults.");
    limits[key as keyof CacheLimits] = value;
  }
  try { return await CacheStore.create(directory, protectedRoots, limits); }
  catch (error) { throw error instanceof CacheError ? error : new CacheError("IO"); }
}
