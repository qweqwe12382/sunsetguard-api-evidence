import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCache } from "../src/cache/index.js";
import type { AnalysisCacheIdentity } from "../src/cache/index.js";
import { ATTRIBUTION_VERSION } from "../src/attribution/index.js";
import { parseApiTarget } from "../src/domain/index.js";
import { RemoteError } from "../src/remote/policy.js";
import { gitBlob } from "./helpers/remote-fixtures.js";

const state = vi.hoisted(() => ({ base: "", downloads: 0, analyses: 0, mode: "normal", commit: "a".repeat(40), verifications: 0, directories: [] as string[] }));
vi.mock("../src/remote/snapshot.js", () => ({ fetchGitHubSnapshot: async (input: { repository: string; ref: string }) => {
  state.downloads++;
  if (state.mode === "failed") return { status: "failed", code: "HTTP_ERROR", httpStatus: 404, message: "GitHub returned an unsuccessful response." };
  const directory = await mkdtemp(join(state.base, "download-")); state.directories.push(directory);
  const files = [
    { path: "source.ts", text: 'import { oldApi } from "pkg"; oldApi(); const secret="DO NOT EXPORT";' },
    { path: "package.json", text: '{"dependencies":{"pkg":"1"}}' },
    ...(state.mode === "partial" ? [{ path: "dynamic.ts", text: 'import("pkg");' }] : []),
  ];
  for (const file of files) await writeFile(join(directory, file.path), file.text);
  return { status: "ready", directory, input, commit: state.commit, treeSha: "b".repeat(40), archiveSha256: "c".repeat(64), compressedBytes: 100, expandedBytes: 4096,
    files: files.map(file => ({ path: file.path, size: Buffer.byteLength(file.text), sha256: createHash("sha256").update(file.text).digest("hex"), gitBlobSha: gitBlob(Buffer.from(file.text)) })),
    dispose: async () => { if (state.mode === "cleanup") throw new RemoteError("CLEANUP_FAILED"); if (dirname(directory) !== state.base) throw Error("cleanup scope"); await rm(directory, { recursive: true }); } };
} }));
vi.mock("../src/scans/local.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/scans/local.js")>();
  return { ...actual, scanLocal: async (...args: Parameters<typeof actual.scanLocal>) => { state.analyses++; return actual.scanLocal(...args); } };
});
vi.mock("../src/remote/verify-files.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/remote/verify-files.js")>();
  return { ...actual, verifyExtractedFiles: async (...args: Parameters<typeof actual.verifyExtractedFiles>) => {
    state.verifications++;
    if (state.mode === "timeout-after" && state.analyses > 0) throw new RemoteError("TIMEOUT");
    return actual.verifyExtractedFiles(...args);
  } };
});
import { scanGitHub } from "../src/scans/github.js";
const input = { repository: "owner/repo", ref: "a".repeat(40) }, target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
let cachePath: string;
beforeEach(async () => {
  const parent = resolve(".test-tmp"); await mkdir(parent, { recursive: true }); state.base = await mkdtemp(join(parent, "cache-github-")); cachePath = join(state.base, "cache");
  state.downloads = 0; state.analyses = 0; state.verifications = 0; state.mode = "normal"; state.commit = input.ref; state.directories = [];
});
afterEach(async () => { if (dirname(state.base) !== resolve(".test-tmp")) throw Error("cleanup scope"); await rm(state.base, { recursive: true, force: true }); });
async function readAnalysisIdentity(): Promise<AnalysisCacheIdentity> {
  const file = (await readdir(join(cachePath, "analyses")))[0]!;
  const value = JSON.parse(await readFile(join(cachePath, "analyses", file), "utf8")) as { value: { identity: AnalysisCacheIdentity } }; return value.value.identity;
}
describe("GitHub snapshot and analysis cache integration", () => {
  it("reuses full commit bytes and analysis with stable findings, snapshot and counters", async () => {
    const cache = await createCache(cachePath), first = await scanGitHub(input, target, { cache }), next = await scanGitHub(input, target, { cache });
    expect(first.summary.detected).toBe(1); expect(state.downloads).toBe(1); expect(state.analyses).toBe(1);
    expect(next.results).toEqual(first.results); expect(next.summary).toEqual(first.summary);
    expect(next.limitations.join(" ")).toContain("Analysis cache hit"); expect(next.limitations.join(" ")).toContain("Snapshot cache hit");
    expect(JSON.stringify(next)).not.toContain(state.base); expect(JSON.stringify(next)).not.toContain("DO NOT EXPORT");
    const identity = await readAnalysisIdentity(); expect(identity.repository).toBe(input.repository); expect(identity.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("invalidates analysis for target, rules, analyzer, source, scope and snippet policy changes", async () => {
    const cache = await createCache(cachePath); await scanGitHub(input, target, { cache }); const identity = await readAnalysisIdentity();
    expect(JSON.parse(identity.scopePolicy).attributionPolicy.version).toBe(ATTRIBUTION_VERSION);
    const changes: Partial<AnalysisCacheIdentity>[] = [
      { ruleSetVersion: "future-rule" }, { analyzerVersion: "future-analyzer" }, { snapshotHash: "e".repeat(64) }, { scopePolicy: "changed scope" },
      { target: parseApiTarget({ packageName: "pkg", exportName: "otherApi" }) }, { snippetPolicy: "future-snippet" }, { remotePolicy: "future-remote" },
      { repository: "other/repo" }, { includeSnippets: true },
    ];
    for (const change of changes) expect(await cache.getAnalysis({ ...identity, ...change })).toBeUndefined();
    expect((await scanGitHub(input, parseApiTarget({ packageName: "pkg", exportName: "otherApi" }), { cache })).summary.detected).toBe(0);
    expect(state.downloads).toBe(1); expect(state.analyses).toBe(2);
    await scanGitHub(input, target, { cache, limits: { timeoutMs: 110_000 } }); expect(state.analyses).toBe(3);
  });
  it("offline hits work without download or reading even an explicitly requested missing credential", async () => {
    const cache = await createCache(cachePath); await scanGitHub(input, target, { cache }); state.mode = "failed";
    const previous = process.env.SUNSETGUARD_GITHUB_TOKEN; delete process.env.SUNSETGUARD_GITHUB_TOKEN;
    try {
      const report = await scanGitHub(input, target, { cache, offline: true, tokenEnvironment: "SUNSETGUARD_GITHUB_TOKEN" });
      expect(report.summary.detected).toBe(1); expect(state.downloads).toBe(1); expect(state.analyses).toBe(1);
    } finally { if (previous === undefined) delete process.env.SUNSETGUARD_GITHUB_TOKEN; else process.env.SUNSETGUARD_GITHUB_TOKEN = previous; }
  });
  it("offline missing snapshot, moving refs and no store remain unknown failed without network", async () => {
    const cache = await createCache(cachePath);
    for (const options of [{ cache, offline: true }, { offline: true }]) expect((await scanGitHub(input, target, options)).results[0]).toMatchObject({ bucket: "unknown", status: "failed" });
    await scanGitHub(input, target, { cache });
    expect((await scanGitHub({ ...input, ref: "main" }, target, { cache, offline: true })).results[0]).toMatchObject({ status: "failed", bucket: "unknown" });
    expect(state.downloads).toBe(1);
  });
  it("online moving refs always reacquire and do not serve the previous branch commit", async () => {
    const cache = await createCache(cachePath), moving = { ...input, ref: "main" };
    const first = await scanGitHub(moving, target, { cache }); state.commit = "d".repeat(40);
    const second = await scanGitHub(moving, target, { cache });
    expect(state.downloads).toBe(2); expect(state.analyses).toBe(2);
    expect(first.results[0]!.snapshot!.gitCommit).toBe(input.ref); expect(second.results[0]!.snapshot!.gitCommit).toBe(state.commit);
    expect(await readdir(join(cachePath, "snapshots"))).toHaveLength(2);
  });
  it("corrupt snapshot fails offline and falls back online with a visible static diagnostic", async () => {
    const cache = await createCache(cachePath); await scanGitHub(input, target, { cache });
    const path = join(cachePath, "snapshots", (await readdir(join(cachePath, "snapshots")))[0]!); await writeFile(path, "invalid record DO NOT EXPORT");
    const offline = await scanGitHub(input, target, { cache, offline: true }); expect(offline.summary.failed).toBe(1); expect(state.downloads).toBe(1);
    const online = await scanGitHub(input, target, { cache }); expect(online.summary.detected).toBe(1); expect(state.downloads).toBe(2);
    expect(online.limitations.join(" ")).toContain("Cache reuse was unavailable"); expect(JSON.stringify(online)).not.toContain("DO NOT EXPORT");
  });
  it("corrupt analysis is recomputed from verified offline source without promoting corrupt counters", async () => {
    const cache = await createCache(cachePath); await scanGitHub(input, target, { cache });
    const path = join(cachePath, "analyses", (await readdir(join(cachePath, "analyses")))[0]!); await writeFile(path, '{"summary":{"detected":999}}');
    const report = await scanGitHub(input, target, { cache, offline: true });
    expect(report.summary.detected).toBe(1); expect(state.analyses).toBe(2); expect(state.downloads).toBe(1); expect(report.limitations.join(" ")).toContain("Cache reuse was unavailable");
  });
  it("rejects a checksummed legacy analysis that contains a downstream dependency value", async () => {
    const cache = await createCache(cachePath); await scanGitHub(input, target, { cache });
    const path = join(cachePath, "analyses", (await readdir(join(cachePath, "analyses")))[0]!);
    const record = JSON.parse(await readFile(path, "utf8")) as {
      checksum: string;
      value: { report: { results: { bindings: { attribution: Record<string, unknown> }[] }[] } };
    };
    const privateValue = "ALPHANUMERICONLYVALUE1234567890";
    record.value.report.results[0]!.bindings[0]!.attribution.declaredRange = privateValue;
    record.checksum = createHash("sha256").update(JSON.stringify(record.value)).digest("hex");
    await writeFile(path, JSON.stringify(record));

    const report = await scanGitHub(input, target, { cache, offline: true });
    expect(report.summary.detected).toBe(1);
    expect(state.downloads).toBe(1);
    expect(state.analyses).toBe(2);
    expect(report.limitations.join(" ")).toContain("Cache reuse was unavailable");
    expect(JSON.stringify(report)).not.toContain(privateValue);
  });
  it("cross-checks the source record and independently recomputes scope even for checksummed stale records", async () => {
    const cache = await createCache(cachePath); await scanGitHub(input, target, { cache }); const identity = await readAnalysisIdentity();
    const snapshotPath = join(cachePath, "snapshots", (await readdir(join(cachePath, "snapshots")))[0]!);
    const original = await readFile(snapshotPath, "utf8");
    const sourceRecord = JSON.parse(original) as { checksum: string; value: { metadata: { files: { path: string; sha256: string }[] } } };
    sourceRecord.value.metadata.files.find(file => file.path === "package.json")!.sha256 = "e".repeat(64);
    sourceRecord.checksum = createHash("sha256").update(JSON.stringify(sourceRecord.value)).digest("hex"); await writeFile(snapshotPath, JSON.stringify(sourceRecord));
    await expect(cache.getAnalysis(identity)).rejects.toMatchObject({ code: "CORRUPT" });
    await writeFile(snapshotPath, original);
    const analysisPath = join(cachePath, "analyses", (await readdir(join(cachePath, "analyses")))[0]!);
    const analysis = JSON.parse(await readFile(analysisPath, "utf8")) as { checksum: string; value: { report: { results: { snapshot: { scopeHash: string } }[] } } };
    analysis.value.report.results[0]!.snapshot.scopeHash = "f".repeat(64); analysis.checksum = createHash("sha256").update(JSON.stringify(analysis.value)).digest("hex");
    await writeFile(analysisPath, JSON.stringify(analysis)); await expect(cache.getAnalysis(identity)).rejects.toMatchObject({ code: "CORRUPT" });
    const actual = await scanGitHub(input, target, { cache, offline: true }); expect(actual.summary.detected).toBe(1); expect(actual.results[0]!.snapshot!.scopeHash).not.toBe("f".repeat(64));
  });
  it("preserves stable partial evidence across cache hits", async () => {
    state.mode = "partial"; const cache = await createCache(cachePath);
    const first = await scanGitHub(input, target, { cache }), second = await scanGitHub(input, target, { cache, offline: true });
    expect(first.summary).toMatchObject({ detected: 1, partial: 1 }); expect(second.results).toEqual(first.results); expect(state.analyses).toBe(1);
  });
  it("does not cache cleanup or resource failures as successful analysis", async () => {
    state.mode = "cleanup"; const cache = await createCache(cachePath);
    const first = await scanGitHub(input, target, { cache }); expect(first.summary).toMatchObject({ detected: 1, partial: 1 });
    expect(first.results[0]!.gaps.some(gap => gap.message.includes("cleanup"))).toBe(true); expect(await readdir(join(cachePath, "analyses"))).toHaveLength(0);
    state.mode = "normal"; await scanGitHub(input, target, { cache, offline: true }); expect(state.analyses).toBe(2);
    const otherCachePath = join(state.base, "resource-cache"), otherCache = await createCache(otherCachePath); state.analyses = 0; state.mode = "timeout-after";
    const timeout = await scanGitHub(input, target, { cache: otherCache }); expect(timeout.results[0]).toMatchObject({ status: "partial", bucket: "detected", snapshot: { kind: "local" } });
    expect(await readdir(join(otherCachePath, "analyses"))).toHaveLength(0);
  });
  it("continues real analysis when cache capacity cannot store the snapshot", async () => {
    const cache = await createCache(cachePath, [], { limits: { maxDiskBytes: 100 } });
    const report = await scanGitHub(input, target, { cache }); expect(report.summary.detected).toBe(1); expect(report.limitations.join(" ")).toContain("Cache reuse was unavailable");
    expect(await readdir(join(cachePath, "snapshots"))).toHaveLength(0);
  });
  it("does not start acquisition with a fresh timeout after cache I/O exhausts the scan deadline", async () => {
    const cache = await createCache(cachePath);
    vi.spyOn(cache, "getSnapshot").mockImplementation(async () => { await new Promise(resolveDelay => setTimeout(resolveDelay, 20)); return undefined; });
    const report = await scanGitHub(input, target, { cache, limits: { timeoutMs: 10 } });
    expect(report.summary).toMatchObject({ unknown: 1, failed: 1 }); expect(state.downloads).toBe(0); expect(state.analyses).toBe(0);
  });
  it("keeps source snippet modes separated and redacted", async () => {
    const cache = await createCache(cachePath);
    const plain = await scanGitHub(input, target, { cache }), snippets = await scanGitHub(input, target, { cache, includeSnippets: true });
    expect(plain.results[0]!.findings[0]!.snippet).toBeUndefined(); expect(snippets.results[0]!.findings[0]!.snippetRedacted).toBe(true);
    expect(JSON.stringify(snippets)).not.toContain("DO NOT EXPORT"); expect(state.analyses).toBe(2); expect(state.downloads).toBe(1);
    const reused = await scanGitHub(input, target, { cache, includeSnippets: true, offline: true }); expect(reused.results).toEqual(snippets.results); expect(state.analyses).toBe(2);
  });
});
