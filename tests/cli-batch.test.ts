import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli/command.js";
import { validateScanReport } from "../src/domain/index.js";

const base = resolve(".test-tmp/cli-batch");
let root: string, manifest: string, source: string;
beforeEach(async () => {
  await mkdir(base, { recursive: true }); root = await mkdtemp(join(base, "run-"));
  manifest = join(root, "consumers.json"); source = join(root, "source");
  await mkdir(source); await writeFile(join(source, "use.ts"), 'import {oldApi} from "pkg"; oldApi("secret-canary");');
});
afterEach(async () => { if (dirname(root) !== base) throw Error("Unsafe test cleanup"); await rm(root, { recursive: true, force: true }); });
async function save(entries: unknown[] = [{ kind: "local", path: "source" }]) { await writeFile(manifest, JSON.stringify({ schemaVersion: "0.1", repositories: entries })); }
function capture() { let out = "", err = ""; const io: CliIo = { stdout: { write: chunk => { out += chunk; } }, stderr: { write: chunk => { err += chunk; } } }; return { io, out: () => out, err: () => err }; }
const args = (...extra: string[]) => ["scan", "--repos", manifest, "--package", "pkg", "--symbol", "oldApi", "--format", "json", ...extra];

describe("batch CLI", () => {
  it("advertises only implemented batch inputs, formats, and explicit credential policy", async () => {
    const output = capture();
    expect(await runCli(["scan", "--help"], output.io)).toBe(0);
    for (const name of ["--repos", "--cache", "--offline", "--github-token-env", "--include-snippets", "markdown"]) expect(output.out()).toContain(name);
    expect(output.err()).toBe("");
  });
  it("emits one validated JSON with normalized exclusions and failure exit 3", async () => {
    await save([{ kind: "local", path: "source" }, { kind: "local", path: "./source" }, { kind: "local", path: "missing" }]);
    const output = capture();
    expect(await runCli(args(), output.io)).toBe(3);
    const report = validateScanReport(JSON.parse(output.out()));
    expect(report.sample).toMatchObject({ selected: 3, excluded: 1, attempted: 2 });
    expect(report.summary).toMatchObject({ detected: 1, failed: 1 });
    expect(output.err()).toBe(""); expect(output.out()).not.toContain("secret-canary");
    expect(output.out()).not.toContain(root.replaceAll("\\", "\\\\"));
  });
  it("publishes Markdown next to the manifest even when a selected source is unavailable", async () => {
    await save([{ kind: "local", path: "source" }, { kind: "local", path: "missing" }]);
    const output = capture(), reportPath = join(root, "report.md");
    expect(await runCli(args("--format", "markdown", "--output", reportPath), output.io)).toBe(3);
    expect(output.out()).toBe("");
    const contents = await readFile(reportPath, "utf8");
    expect(contents).toContain("SunsetGuard"); expect(contents).toContain("SOURCE_UNAVAILABLE");
    expect(contents).not.toContain("secret-canary"); expect(contents).not.toContain(root);
  });
  it.each(["manifest", "source"])("refuses an output at the %s boundary", async kind => {
    await save();
    const before = await readFile(manifest, "utf8"), output = capture();
    const path = kind === "manifest" ? manifest : join(source, "report.json");
    expect(await runCli(args("--output", path), output.io)).toBe(1);
    expect(output.out()).toBe(""); expect(output.err()).not.toContain(root);
    expect(await readFile(manifest, "utf8")).toBe(before);
  });
  it("allows explicit snippets without copying neighboring literals", async () => {
    await save(); const output = capture();
    expect(await runCli(args("--include-snippets"), output.io)).toBe(0);
    const finding = validateScanReport(JSON.parse(output.out())).results[0]!.findings[0]!;
    expect(finding).toMatchObject({ snippetRedacted: true, snippet: expect.stringContaining("oldApi") });
    expect(output.out()).not.toContain("secret-canary");
  });
  it("returns an honest offline miss alongside successful local evidence", async () => {
    await save([{ kind: "github", repository: "owner/repo", ref: "a".repeat(40) }, { kind: "local", path: "source" }]);
    const output = capture();
    expect(await runCli(args("--offline"), output.io)).toBe(3);
    const report = validateScanReport(JSON.parse(output.out()));
    expect(report.summary).toMatchObject({ failed: 1, detected: 1 });
    expect(report.results[0]!.repositoryId).toBe("github:owner/repo");
    expect(report.results[1]!.repositoryId).toMatch(/^local:/);
    expect(output.err()).toBe("");
  });
  it("rejects invalid consumers and conflicting options before scanning", async () => {
    await writeFile(manifest, '{"secret":"fake-user-private"}');
    const malformed = capture(); expect(await runCli(args(), malformed.io)).toBe(2);
    expect(malformed.out()).toBe(""); expect(malformed.err()).not.toContain("fake-user-private");
    await save(); const conflict = capture();
    expect(await runCli(args("--offline", "--github-token-env"), conflict.io)).toBe(2);
    expect(conflict.out()).toBe("");
  });
  it("refuses cache creation inside scanned source without changing source bytes", async () => {
    await save(); const output = capture();
    const code = await runCli(args("--cache", join(source, "cache")), output.io);
    expect(code, output.err()).toBe(2);
    expect(output.out()).toBe("");
    expect(output.err()).toContain("--cache");
    expect(output.err()).not.toContain(root);
    expect(await readFile(join(source, "use.ts"), "utf8")).toContain("secret-canary");
  });
  it("runs the built executable with an argument array and JSON-only stdout", async () => {
    await save([{ kind: "local", path: "source" }, { kind: "local", path: "missing" }]);
    const child = spawnSync(process.execPath, [resolve("dist/cli/bin.js"), ...args()], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(3); expect(child.stderr).toBe("");
    expect(validateScanReport(JSON.parse(child.stdout)).summary).toMatchObject({ detected: 1, failed: 1 });
  });
});
