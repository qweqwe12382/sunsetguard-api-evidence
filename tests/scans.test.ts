import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as analyzer from "../src/analyzer/index.js";
import * as snapshots from "../src/snapshots/index.js";

import { parseApiTarget, validateScanReport } from "../src/domain/index.js";
import { scanLocal } from "../src/scans/index.js";

const target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sunsetguard-scan-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(async root => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("sunsetguard-scan-")) {
      throw new Error("Invalid cleanup scope");
    }
    await rm(root, { recursive: true, force: true });
  }));
});

describe("scanLocal", () => {
  it("turns unrepresentable captured paths into gaps without dropping other evidence", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "a.ts"), 'import { oldApi } from "pkg"; oldApi();');
    await writeFile(join(root, "b.ts"), 'export {};');
    const capture = snapshots.captureLocalSnapshot;
    vi.spyOn(snapshots, "captureLocalSnapshot").mockImplementation(async (...args) => {
      const result = await capture(...args);
      result.files[1]!.path = "unsafe\u001b.ts"; // Simulate a legal POSIX name on Windows as well.
      return result;
    });
    const report = await scanLocal(root, target);
    expect(report.results[0]).toMatchObject({ status: "partial", bucket: "detected",
      inventory: { analyzedFiles: 1, failedOrSkippedEligibleFiles: 1 } });
    expect(report.results[0]!.gaps.some(gap => gap.code === "FILE_READ_FAILED")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("unsafe");
  });
  it("builds a validated detected report without exposing the absolute root", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "main.ts"), 'import { oldApi } from "pkg";\noldApi();\n');

    const report = await scanLocal(root, target);

    expect(validateScanReport(report)).toEqual(report);
    expect(report.reportKind).toBe("scan");
    expect(report.results[0]).toMatchObject({ status: "complete-within-scope", bucket: "detected" });
    expect(report.summary).toMatchObject({ detected: 1, completeWithinScope: 1 });
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it("reports a clean in-scope file only as not detected within that scope", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "main.ts"), "export const value = 1;\n");
    const result = (await scanLocal(root, target)).results[0]!;
    expect(result).toMatchObject({ status: "complete-within-scope", bucket: "not-detected-within-scope" });
    expect(result.inventory).toMatchObject({ eligibleFiles: 1, analyzedFiles: 1, failedOrSkippedEligibleFiles: 0 });
  });

  it("keeps an empty directory partial and unknown", async () => {
    const result = (await scanLocal(await temporaryRoot(), target)).results[0]!;
    expect(result).toMatchObject({ status: "partial", bucket: "unknown" });
    expect(result.gaps.some(gap => gap.code === "NO_ANALYZABLE_FILES")).toBe(true);
  });

  it("counts a parse failure as skipped analysis", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "broken.ts"), "const value = ;\n");
    const result = (await scanLocal(root, target)).results[0]!;
    expect(result).toMatchObject({ status: "partial", bucket: "unknown",
      inventory: { eligibleFiles: 1, analyzedFiles: 0, failedOrSkippedEligibleFiles: 1 } });
    expect(result.gaps.some(gap => gap.code === "PARSE_FAILED")).toBe(true);
  });

  it("retains detected evidence when another file cannot be parsed", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "a.ts"), 'import { oldApi } from "pkg"; oldApi();');
    await writeFile(join(root, "b.ts"), "const value = ;");
    const result = (await scanLocal(root, target)).results[0]!;
    expect(result).toMatchObject({ status: "partial", bucket: "detected",
      inventory: { eligibleFiles: 2, analyzedFiles: 1, failedOrSkippedEligibleFiles: 1 } });
  });

  it("counts target-related unsupported syntax as analyzed but partial", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "dynamic.ts"), 'void import("pkg");');
    const result = (await scanLocal(root, target)).results[0]!;
    expect(result).toMatchObject({ status: "partial", bucket: "unknown",
      inventory: { eligibleFiles: 1, analyzedFiles: 1, failedOrSkippedEligibleFiles: 0 } });
    expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
  });

  it("preserves resource-limit inventory without analyzing oversized files", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "large.ts"), "export const longValue = 123456789;\n");
    const result = (await scanLocal(root, target, { limits: { maxFileBytes: 8 } })).results[0]!;
    expect(result).toMatchObject({ status: "partial", bucket: "unknown",
      inventory: { eligibleFiles: 1, analyzedFiles: 0, failedOrSkippedEligibleFiles: 1 } });
    expect(result.gaps.some(gap => gap.code === "RESOURCE_LIMIT")).toBe(true);
  });

  it("turns cancellation and unavailable roots into honest repository statuses", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "main.ts"), "export const value = 1;");
    const controller = new AbortController();
    controller.abort();
    const cancelled = (await scanLocal(root, target, { signal: controller.signal })).results[0]!;
    expect(cancelled).toMatchObject({ status: "partial", bucket: "unknown" });
    expect(cancelled.gaps.some(gap => gap.code === "RESOURCE_LIMIT")).toBe(true);
    expect(cancelled.gaps.some(gap => gap.code === "NO_ANALYZABLE_FILES")).toBe(true);

    const unavailable = (await scanLocal(join(root, "missing"), target)).results[0]!;
    expect(unavailable).toMatchObject({ status: "failed", bucket: "unknown" });
    expect(unavailable.gaps.some(gap => gap.code === "SOURCE_UNAVAILABLE")).toBe(true);
  });

  it.each(["cancel", "timeout"])("checks %s after the last file and retains completed evidence", async mode => {
    const root = await temporaryRoot();
    await writeFile(join(root, "a.ts"), 'import { oldApi } from "pkg"; oldApi();');
    const controller = new AbortController();
    const originalFactory = analyzer.createIsolatedAnalyzer;
    const now = performance.now.bind(performance);
    let jump = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now() + jump);
    vi.spyOn(analyzer, "createIsolatedAnalyzer").mockImplementation(options => {
      const isolated = originalFactory(options);
      return {
        async analyze(file, api, timeoutMs) {
          const result = await isolated.analyze(file, api, timeoutMs);
          if (mode === "cancel") controller.abort();
          else jump = 20000;
          return result;
        },
        close: () => isolated.close(),
      };
    });
    const report = await scanLocal(root, target, { signal: controller.signal, limits: { timeoutMs: 10000 } });
    expect(report.results[0]).toMatchObject({ status: "partial", bucket: "detected",
      inventory: { analyzedFiles: 1, failedOrSkippedEligibleFiles: 0 } });
    expect(report.results[0]!.gaps.some(gap => gap.code === "RESOURCE_LIMIT")).toBe(true);
  });
});
