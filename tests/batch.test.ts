import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseApiTarget, validateScanReport } from "../src/domain/index.js";
import { readConsumers } from "../src/scans/consumers.js";
import { scanConsumers } from "../src/scans/batch.js";
import * as local from "../src/scans/local.js";
import { setTimeout as delay } from "node:timers/promises";

const base = resolve(".test-tmp/batch");
const target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
let root: string, manifest: string;
beforeEach(async () => { await mkdir(base, { recursive: true }); root = await mkdtemp(join(base, "scan-")); manifest = join(root, "consumers.json"); });
afterEach(async () => { vi.restoreAllMocks(); if (dirname(root) !== base) throw Error("Unsafe test cleanup"); await rm(root, { recursive: true, force: true }); });
async function source(name: string, contents: string) { await mkdir(join(root, name)); await writeFile(join(root, name, "source.ts"), contents); return { kind: "local", path: name }; }
async function plan(entries: unknown[]) { await writeFile(manifest, JSON.stringify({ schemaVersion: "0.1", repositories: entries })); return readConsumers(manifest); }

describe("sequential batch results", () => {
  it("retains positives, negatives, failures, and duplicate exclusions with independent counts", async () => {
    const yes = await source("yes", 'import {oldApi as old} from "pkg"; old();');
    const no = await source("no", 'import {oldApi} from "other"; oldApi();');
    const input = await plan([yes, { kind: "local", path: "missing" }, no, yes]);
    const report = validateScanReport(await scanConsumers(input, target));
    expect(report.sample).toMatchObject({ selected: 4, excluded: 1, attempted: 3, knownTotal: 3, exclusionReasons: { "duplicate-input": 1 } });
    expect(report.summary).toEqual({ detected: 1, notDetectedWithinScope: 1, unknown: 1, completeWithinScope: 2, partial: 0, failed: 1 });
    expect(report.results[0]!.findings).toHaveLength(1);
    expect(report.results[1]!.gaps[0]!.code).toBe("SOURCE_UNAVAILABLE");
    expect(JSON.stringify(report)).not.toContain(root);
    expect(JSON.stringify(report)).not.toContain(root.replaceAll("\\", "\\\\"));
    expect(report.results.every(result => result.repositoryId.startsWith("local:"))).toBe(true);
  });
  it("preserves detected+partial and ambiguous candidates instead of promoting them", async () => {
    const yes = await source("partial", 'import {oldApi} from "pkg"; oldApi(); import("pkg");');
    const candidate = await source("candidate", 'import {oldApi} from "pkg"; oldApi();');
    await writeFile(join(root, "candidate/package.json"), '{"dependencies":{"pkg":"file:../private"}}');
    const report = await scanConsumers(await plan([yes, candidate]), target);
    expect(report.summary).toMatchObject({ detected: 1, unknown: 1, partial: 2 });
    expect(report.results[1]!.findings).toHaveLength(1);
    expect(report.results[1]!.bindings[0]!.attribution.status).toBe("ambiguous");
  });
  it("retains three unknown units when cancelled and performs no clean inference", async () => {
    const yes = await source("yes", 'import {oldApi} from "pkg"; oldApi();');
    const signal = AbortSignal.abort();
    const report = await scanConsumers(await plan([yes, { kind: "local", path: "missing" }, { kind: "github", repository: "o/r", ref: "main" }]), target, { signal });
    expect(report.summary).toMatchObject({ unknown: 3, failed: 3, completeWithinScope: 0 });
    expect(report.results.every(result => result.snapshot === undefined)).toBe(true);
  });
  it("bounds aggregate evidence and marks omitted inputs unavailable", async () => {
    const first = await source("first", 'import {oldApi} from "pkg"; oldApi();');
    const second = await source("second", 'import {oldApi} from "pkg"; oldApi();');
    const report = await scanConsumers(await plan([first, second]), target, { limits: { maxReportBytes: 1 } });
    expect(report.summary).toMatchObject({ unknown: 2, failed: 2, detected: 0 });
    expect(report.limitations.some(line => line.includes("mandatory unavailable-input diagnostics"))).toBe(true);
  });
  it("retains completed evidence on mid-batch cancellation and never starts remaining input", async () => {
    const entries = await Promise.all(["first", "second", "third"].map(name => source(name, 'import {oldApi} from "pkg"; oldApi();')));
    const controller = new AbortController(), original = local.scanLocal;
    let calls = 0;
    const scanner = vi.spyOn(local, "scanLocal").mockImplementation(async (...args) => {
      if (++calls === 2) controller.abort();
      return original(...args);
    });
    const report = await scanConsumers(await plan(entries), target, { signal: controller.signal });
    expect(scanner).toHaveBeenCalledTimes(2);
    expect(report.results[0]).toMatchObject({ status: "complete-within-scope", bucket: "detected" });
    expect(report.results[1]!.bucket).toBe("unknown");
    expect(report.results[2]).toMatchObject({ status: "failed", bucket: "unknown" });
  });
  it("preserves the finished child when a batch deadline expires before the next starts", async () => {
    const entries = await Promise.all(["first", "second"].map(name => source(name, 'import {oldApi} from "pkg"; oldApi();')));
    const first = await local.scanLocal(join(root, "first"), target);
    const scanner = vi.spyOn(local, "scanLocal").mockImplementation(async () => { await delay(25); return first; });
    const report = await scanConsumers(await plan(entries), target, { limits: { timeoutMs: 10 } });
    expect(scanner).toHaveBeenCalledTimes(1);
    expect(report.summary).toMatchObject({ detected: 1, completeWithinScope: 1, failed: 1 });
  });
  it("retains earlier evidence when later report bytes exhaust the aggregate budget", async () => {
    const first = await source("first", 'import {oldApi} from "pkg"; oldApi();');
    const second = await source("second", 'import {oldApi} from "pkg"; ' + "oldApi();".repeat(100));
    const third = await source("third", 'import {oldApi} from "pkg"; oldApi();');
    const measured = await local.scanLocal(join(root, "first"), target);
    const maxReportBytes = Buffer.byteLength(JSON.stringify({ result: measured.results[0], limitations: measured.limitations })) + 1024;
    const scanner = vi.spyOn(local, "scanLocal");
    const report = await scanConsumers(await plan([first, second, third]), target, { limits: { maxReportBytes } });
    expect(scanner).toHaveBeenCalledTimes(2);
    expect(report.summary).toMatchObject({ detected: 1, failed: 2 });
    expect(report.results[0]!.findings).toHaveLength(1);
    expect(report.results[2]!.gaps[0]!.message).toContain("budget");
  });
  it("keeps identical-byte repositories distinct and stable across repeated scans", async () => {
    const first = await source("first", 'import {oldApi} from "pkg"; oldApi();');
    const second = await source("second", 'import {oldApi} from "pkg"; oldApi();');
    const input = await plan([first, second]);
    const left = await scanConsumers(input, target), right = await scanConsumers(input, target);
    expect(left.sample.attempted).toBe(2);
    expect(left.results).toEqual(right.results);
    expect(left.results[0]!.snapshot!.contentHash).toBe(left.results[1]!.snapshot!.contentHash);
    expect(left.results[0]!.repositoryId).not.toBe(left.results[1]!.repositoryId);
  });
  it("keeps snippets off by default and adds bounded redacted context only on request", async () => {
    const entry = await source("source", 'import {oldApi} from "pkg";\noldApi("secret-canary-C:/Users/private");');
    const input = await plan([entry]);
    const plain = await scanConsumers(input, target), snippets = await scanConsumers(input, target, { includeSnippets: true });
    expect(plain.results[0]!.findings[0]!.snippet).toBeUndefined();
    expect(snippets.results[0]!.findings[0]).toMatchObject({ snippet: expect.stringContaining("oldApi"), snippetRedacted: true });
    expect(JSON.stringify(snippets)).not.toContain("secret-canary");
    expect(snippets.results[0]!.snapshot!.scopeHash).not.toBe(plain.results[0]!.snapshot!.scopeHash);
  });
  it("requires an immutable prepared plan so forged IDs cannot leak paths or inflate the denominator", async () => {
    const input = await plan([await source("one", 'import {oldApi} from "pkg"; oldApi();')]);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.entries)).toBe(true);
    expect(Object.isFrozen(input.entries[0])).toBe(true);
    for (const forged of [
      { ...input, entries: [{ ...input.entries[0]!, repositoryId: "C:/Users/private-canary" }] },
      { ...input, selected: 2, entries: [{ ...input.entries[0]!, repositoryId: "local:one" }, { ...input.entries[0]!, repositoryId: "local:two" }] },
      JSON.parse(JSON.stringify(input)) as typeof input,
    ]) await expect(scanConsumers(forged, target, { signal: AbortSignal.abort() })).rejects.toThrow("readConsumers");
  });
});
