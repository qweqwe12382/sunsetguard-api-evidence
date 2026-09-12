import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as attributionModule from "../src/attribution/index.js";
import { parseApiTarget } from "../src/domain/index.js";
import { scanLocal } from "../src/scans/local.js";

const roots: string[] = [];
const target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sunsetguard-t06-scan-"));
  roots.push(root);
  return root;
}
async function source(root: string, path: string, body: string): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async root => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("sunsetguard-t06-scan-")) throw new Error("invalid cleanup scope");
    await rm(root, { recursive: true, force: true });
  }));
});

describe("scanLocal T06 integration", () => {
  it("keeps confirmed and ambiguous evidence separate in one snapshot", async () => {
    const root = await temporaryRoot();
    await source(root, "package.json", JSON.stringify({ dependencies: { pkg: "^1.0.0" } }));
    await source(root, "confirmed.ts", 'import { oldApi } from "pkg"; oldApi();');
    await source(root, "workspace/package.json", JSON.stringify({ dependencies: { pkg: "workspace:*" } }));
    await source(root, "workspace/candidate.ts", 'import { oldApi } from "pkg"; oldApi();');

    const result = (await scanLocal(root, target)).results[0]!;
    const statuses = new Set(result.bindings.map(binding => binding.attribution.status));
    expect(statuses).toEqual(new Set(["manifest-corroborated", "ambiguous"]));
    expect(result).toMatchObject({ bucket: "detected", status: "partial" });
    expect(result.gaps.some(gap => gap.code === "MODULE_ATTRIBUTION_AMBIGUOUS")).toBe(true);
  });

  it("includes configuration bytes and policy changes in snapshot identity", async () => {
    const root = await temporaryRoot();
    await source(root, "main.ts", 'import { oldApi } from "pkg"; oldApi();');
    await source(root, "package.json", JSON.stringify({ dependencies: { pkg: "^1" } }));
    await source(root, "tsconfig.json", JSON.stringify({ compilerOptions: {} }));
    const first = await scanLocal(root, target);
    await source(root, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
    const changedConfig = await scanLocal(root, target);
    const changedPolicy = await scanLocal(root, target, { analysisLimits: { maxEvidenceItems: 99_999 } });

    expect(changedConfig.results[0]!.snapshot!.contentHash).not.toBe(first.results[0]!.snapshot!.contentHash);
    expect(changedPolicy.results[0]!.snapshot!.scopeHash).not.toBe(changedConfig.results[0]!.snapshot!.scopeHash);
    expect(changedPolicy.limitations.join("\n")).toContain("maxEvidenceItems");
  });

  it("drops a file atomically and marks all remaining files skipped at a low evidence limit", async () => {
    const root = await temporaryRoot();
    await source(root, "a.ts", 'import { oldApi } from "pkg"; oldApi(); oldApi();');
    await source(root, "b.ts", 'import { oldApi } from "pkg"; oldApi();');

    const result = (await scanLocal(root, target, { analysisLimits: { maxEvidenceItems: 1 } })).results[0]!;
    expect(result).toMatchObject({ status: "partial", bucket: "unknown",
      inventory: { eligibleFiles: 2, analyzedFiles: 0, failedOrSkippedEligibleFiles: 2 } });
    expect(result.bindings).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.gaps.some(gap => gap.code === "RESOURCE_LIMIT" && gap.message.includes("aggregate"))).toBe(true);
  });

  it("enforces the aggregate serialized-byte evidence limit", async () => {
    const root = await temporaryRoot();
    await source(root, "main.ts", "import { oldApi } from 'pkg'; oldApi();");
    const result = (await scanLocal(root, target, { analysisLimits: { maxEvidenceBytes: 256 } })).results[0]!;
    expect(result.bindings).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.inventory).toMatchObject({ analyzedFiles: 0, failedOrSkippedEligibleFiles: 1 });
    expect(result.status).toBe("partial");
    expect(result.gaps.some(gap => gap.code === "RESOURCE_LIMIT" && gap.message.includes("omitted atomically"))).toBe(true);
  });

  it("retains the first complete file when the next file reaches the item limit", async () => {
    const root = await temporaryRoot();
    await source(root, "a.ts", "import { oldApi } from 'pkg'; oldApi();");
    await source(root, "b.ts", "import { oldApi } from 'pkg'; oldApi();");
    const result = (await scanLocal(root, target, { analysisLimits: { maxEvidenceItems: 4 } })).results[0]!;
    expect(result.bindings).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.location.file).toBe("a.ts");
    expect(result.inventory).toMatchObject({ analyzedFiles: 1, failedOrSkippedEligibleFiles: 1 });
    expect(result.bucket).toBe("detected");
    expect(result.status).toBe("partial");
  });

  it("bounds snapshot gaps even when there are no readable source files", async () => {
    const root = await temporaryRoot();
    await Promise.all(["a.ts", "b.ts", "c.ts", "d.ts"].map(path => source(root, path, "oldApi();")));
    const result = (await scanLocal(root, target, { limits: { maxFileBytes: 1 }, analysisLimits: { maxEvidenceItems: 2 } })).results[0]!;
    expect(result.gaps).toHaveLength(2);
    expect(result.gaps.some(gap => gap.code === "RESOURCE_LIMIT" && gap.message.includes("Initial snapshot"))).toBe(true);
    expect(result.inventory).toMatchObject({ eligibleFiles: 4, analyzedFiles: 0, failedOrSkippedEligibleFiles: 4 });
    expect(result.bucket).toBe("unknown");
    expect(result.status).toBe("partial");
  });

  it("invalidates attribution when the canonical root identity changes between phases", async () => {
    const root = await temporaryRoot();
    const capturedRoot = `${root}-captured`;
    roots.push(capturedRoot);
    await source(root, "package.json", JSON.stringify({ dependencies: { pkg: "^1" } }));
    await source(root, "main.ts", "import { oldApi } from 'pkg'; oldApi();");
    const original = attributionModule.createAttributionContext;
    vi.spyOn(attributionModule, "createAttributionContext").mockImplementationOnce(async (...args) => {
      await rename(root, capturedRoot);
      await mkdir(root);
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { other: "^1" } }));
      return original(...args);
    });
    const result = (await scanLocal(root, target)).results[0]!;
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.attribution.status).toBe("ambiguous");
    expect(result.gaps.some(gap => gap.code === "SNAPSHOT_CHANGED")).toBe(true);
    expect(result.status).toBe("partial");
  });

  it("rejects attempts to raise or smuggle analysis limits", async () => {
    const root = await temporaryRoot();
    await expect(scanLocal(root, target, { analysisLimits: { maxOldGenerationSizeMb: 129 } })).rejects.toThrow("only lower");
    await expect(scanLocal(root, target, { analysisLimits: { extra: 1 } as never })).rejects.toThrow("unknown property");
    await expect(scanLocal(root, target, { analysisLimits: { maxOldGenerationSizeMb: 15 } })).rejects.toThrow("at least 16");
  });
});
