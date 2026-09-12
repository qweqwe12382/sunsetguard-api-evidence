import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateScanReport } from "../src/domain/index.js";
import { runCli, type CliIo } from "../src/cli/command.js";

const base = resolve(".test-tmp", "cli");
let root: string;
let source: string;
let reports: string;
beforeEach(async () => {
  await mkdir(base, { recursive: true });
  root = await mkdtemp(join(base, "integration-"));
  source = join(root, "source");
  reports = join(root, "reports");
  await mkdir(source);
  await mkdir(reports);
});
afterEach(async () => {
  if (dirname(root) !== base) throw new Error("Invalid cleanup scope");
  await rm(root, { recursive: true, force: true });
});
function capture() {
  let out = "", err = "";
  const io: CliIo = { stdout: { write: chunk => { out += chunk; } }, stderr: { write: chunk => { err += chunk; } } };
  return { io, out: () => out, err: () => err };
}
function args(extra: string[] = []) {
  return ["analyze", source, "--package", "pkg", "--symbol", "oldApi", "--format", "json", ...extra];
}
const positive = 'import { oldApi } from "pkg"; oldApi();';

describe("CLI integration", () => {
  it("returns complete JSON and correct evidence without exposing the source root", async () => {
    await writeFile(join(source, "a.ts"), positive);
    const output = capture();
    expect(await runCli(args(), output.io)).toBe(0);
    const report = validateScanReport(JSON.parse(output.out()));
    expect(report.reportKind).toBe("scan");
    expect(report.summary).toMatchObject({ detected: 1, completeWithinScope: 1, unknown: 0 });
    expect(report.results[0]!.findings).toHaveLength(1);
    expect(output.err()).toBe("");
    expect(output.out()).not.toContain(source);
    expect(output.out()).not.toContain(source.replaceAll("\\", "\\\\"));
    expect(await readFile(join(source, "a.ts"), "utf8")).toBe(positive);
  });

  it("retains evidence and valid JSON when another file fails to parse", async () => {
    await writeFile(join(source, "a.ts"), positive);
    await writeFile(join(source, "b.ts"), "(");
    const output = capture();
    expect(await runCli(args(), output.io)).toBe(3);
    const report = validateScanReport(JSON.parse(output.out()));
    expect(report.summary).toMatchObject({ detected: 1, partial: 1 });
    expect(report.results[0]!.inventory).toMatchObject({ analyzedFiles: 1, failedOrSkippedEligibleFiles: 1 });
    expect(report.results[0]!.gaps.some(gap => gap.code === "PARSE_FAILED")).toBe(true);
  });

  it("treats an empty directory as unknown and partial", async () => {
    const output = capture();
    expect(await runCli(args(), output.io)).toBe(3);
    expect(validateScanReport(JSON.parse(output.out())).results[0]).toMatchObject({ bucket: "unknown", status: "partial" });
  });

  it("writes a complete external report and leaves stdout empty", async () => {
    await writeFile(join(source, "a.ts"), positive);
    const destination = join(reports, "report.json");
    const output = capture();
    expect(await runCli(args(["--output", destination]), output.io)).toBe(0);
    expect(output.out()).toBe("");
    expect(output.err()).toBe("");
    expect(validateScanReport(JSON.parse(await readFile(destination, "utf8"))).summary.detected).toBe(1);
    expect(await readdir(reports)).toEqual(["report.json"]);
  });

  it.each(["inside", "existing", "missing-parent"])("fails unsafe output without overwriting files: %s", async kind => {
    await writeFile(join(source, "a.ts"), positive);
    const destination = kind === "inside" ? join(source, "output.json")
      : kind === "existing" ? join(reports, "existing.json") : join(reports, "missing", "output.json");
    if (kind === "existing") await writeFile(destination, "keep me");
    const output = capture();
    expect(await runCli(args(["--output", destination]), output.io)).toBe(1);
    expect(output.out()).toBe("");
    expect(output.err()).not.toContain(root);
    expect(await readFile(join(source, "a.ts"), "utf8")).toBe(positive);
    if (kind === "existing") expect(await readFile(destination, "utf8")).toBe("keep me");
    else await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unknown options without echoing untrusted arguments", async () => {
    const output = capture();
    expect(await runCli(args(["--bad-\u001b[2J"]), output.io)).toBe(2);
    expect(output.out()).toBe("");
    expect(output.err()).not.toContain("\u001b");
  });

  it("returns a valid partial report when cancelled before capture", async () => {
    await writeFile(join(source, "a.ts"), positive);
    const controller = new AbortController();
    controller.abort();
    const output = capture();
    expect(await runCli(args(), output.io, { signal: controller.signal })).toBe(3);
    const report = validateScanReport(JSON.parse(output.out()));
    expect(report.summary).toMatchObject({ partial: 1, unknown: 1 });
    expect(report.results[0]!.gaps.some(gap => gap.code === "RESOURCE_LIMIT")).toBe(true);
  });

  it("returns output failure for asynchronous stream errors without throwing details", async () => {
    await writeFile(join(source, "a.ts"), positive);
    const io: CliIo = {
      stdout: { write: async () => { throw new Error("private stdout failure"); } },
      stderr: { write: async () => { throw new Error("private stderr failure"); } },
    };
    expect(await runCli(args(), io)).toBe(1);
    expect(await runCli([], io)).toBe(1);
  });
});
