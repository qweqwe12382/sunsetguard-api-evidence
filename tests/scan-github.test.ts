import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseApiTarget } from "../src/domain/index.js";
import { RemoteError } from "../src/remote/policy.js";
import { gitBlob } from "./helpers/remote-fixtures.js";

const state = vi.hoisted(() => ({ mode: "normal", directory: "", verifications: 0, disposed: false }));
vi.mock("../src/remote/snapshot.js", () => ({ fetchGitHubSnapshot: async (input: { repository: string; ref: string }) => {
  if (state.mode === "failed") return { status: "failed", code: "HTTP_ERROR", httpStatus: 404, message: "GitHub returned an unsuccessful response." };
  const base = resolve(".test-tmp"); await mkdir(base, { recursive: true });
  state.directory = await mkdtemp(join(base, "github-scan-"));
  const content = state.mode === "empty" ? [] : [
    { path: "source.ts", text: 'import { oldApi } from "pkg"; oldApi(); throw Error("DO NOT EXECUTE");' },
    { path: "package.json", text: '{"dependencies":{"pkg":"^1.0.0"}}' },
    ...(state.mode === "partial" ? [{ path: "unsupported.ts", text: 'import("pkg");' }] : []),
  ];
  for (const file of content) await writeFile(join(state.directory, file.path), file.text);
  return { status: "ready", directory: state.directory, input, commit: "a".repeat(40), treeSha: "b".repeat(40), archiveSha256: "c".repeat(64), compressedBytes: 100, expandedBytes: 1024,
    files: content.map(file => ({ path: file.path, size: Buffer.byteLength(file.text), sha256: createHash("sha256").update(file.text).digest("hex"), gitBlobSha: gitBlob(Buffer.from(file.text)) })),
    dispose: async () => { if (state.mode === "cleanup") throw new RemoteError("CLEANUP_FAILED"); if (dirname(state.directory) !== base) throw Error("cleanup scope"); await rm(state.directory, { recursive: true }); state.disposed = true; } };
} }));
vi.mock("../src/remote/verify-files.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/remote/verify-files.js")>();
  return { ...actual, verifyExtractedFiles: async (...args: Parameters<typeof actual.verifyExtractedFiles>) => {
    state.verifications++;
    if (state.verifications === 2 && state.mode === "timeout-after") throw new RemoteError("TIMEOUT");
    if (state.verifications === 2 && state.mode === "changed") await writeFile(join(state.directory, "source.ts"), "mutated");
    return actual.verifyExtractedFiles(...args);
  } };
});
import { scanGitHub } from "../src/scans/github.js";
const input = { repository: "Owner/Repo", ref: "main" }, target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
beforeEach(() => { state.mode = "normal"; state.verifications = 0; state.disposed = false; state.directory = ""; });
afterEach(async () => { if (state.directory !== "") { if (dirname(state.directory) !== resolve(".test-tmp")) throw Error("cleanup scope"); await rm(state.directory, { recursive: true, force: true }); } });

describe("single GitHub scan integration", () => {
  it("reports verified commit provenance, real findings and no private path or snippets", async () => {
    const report = await scanGitHub(input, target);
    expect(report.results[0]).toMatchObject({ repositoryId: "github:owner/repo", status: "complete-within-scope", bucket: "detected", snapshot: { kind: "git", gitCommit: "a".repeat(40), sourceId: `github:owner/repo@${"a".repeat(40)}` } });
    expect(report.results[0]!.findings).toHaveLength(1); expect(report.sample.source).toBe("explicit-list");
    const value = JSON.stringify(report); expect(value).not.toContain("test-tmp"); expect(value).not.toContain("DO NOT EXECUTE");
    expect(state.disposed).toBe(true); await expect(access(state.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps detected plus partial for supported evidence alongside a syntax gap", async () => {
    state.mode = "partial"; const report = await scanGitHub(input, target);
    expect(report.results[0]).toMatchObject({ status: "partial", bucket: "detected", snapshot: { kind: "git" } });
    expect(report.summary).toMatchObject({ detected: 1, partial: 1, failed: 0 }); expect(state.disposed).toBe(true);
  });

  it("represents acquisition failure as unknown and permits a later repository to succeed", async () => {
    state.mode = "failed"; const failed = await scanGitHub(input, target);
    expect(failed.results[0]).toMatchObject({ status: "failed", bucket: "unknown", findings: [] }); expect(failed.results[0]!.snapshot).toBeUndefined();
    state.mode = "normal"; const successful = await scanGitHub(input, target);
    expect(successful.summary.detected).toBe(1); expect(failed.summary.unknown).toBe(1);
  });

  it("does not call an empty verified tree complete-clean", async () => {
    state.mode = "empty";
    expect((await scanGitHub(input, target)).results[0]).toMatchObject({ status: "partial", bucket: "unknown" });
  });

  it("retains evidence with local content identity if post-scan deadline verification cannot finish", async () => {
    state.mode = "timeout-after"; const report = await scanGitHub(input, target);
    expect(report.results[0]).toMatchObject({ status: "partial", bucket: "detected", snapshot: { kind: "local" } });
    expect(report.results[0]!.findings).toHaveLength(1); expect(report.results[0]!.snapshot!.gitCommit).toBeUndefined();
    expect(report.limitations.join(" ")).not.toContain("Fixed source permalink base:");
  });

  it("downgrades changed source to candidates without a verified Git permalink", async () => {
    state.mode = "changed"; const report = await scanGitHub(input, target);
    expect(report.results[0]).toMatchObject({ status: "partial", bucket: "unknown", snapshot: { kind: "local" } });
    expect(report.results[0]!.findings).toHaveLength(1); expect(report.results[0]!.bindings[0]!.attribution.status).toBe("ambiguous");
    expect(report.results[0]!.gaps.map(gap => gap.code)).toContain("SNAPSHOT_CHANGED");
  });

  it("makes cleanup failure visible without discarding completed findings", async () => {
    state.mode = "cleanup"; const report = await scanGitHub(input, target);
    expect(report.results[0]).toMatchObject({ status: "partial", bucket: "detected" });
    expect(report.results[0]!.gaps.some(gap => gap.message.includes("cleanup"))).toBe(true);
  });
});
