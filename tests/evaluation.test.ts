import { describe, expect, it } from "vitest";

import type { ScanReport } from "../src/domain/index.js";
import { evaluateScan } from "../src/evaluation/index.js";
import type { EvaluationDataset } from "../src/evaluation/index.js";

const digest = "a".repeat(64);
const loc = (file: string, column: number) => ({ file, start: { line: 1, column }, end: { line: 1, column: column + 1 } });
const dataset = (overrides: Partial<EvaluationDataset> = {}): EvaluationDataset => ({
  schemaVersion: "0.1", target: { id: "pkg::pkg::oldApi", packageName: "pkg", moduleSpecifier: "pkg", exportName: "oldApi" },
  snapshot: { snapshotId: "sample-1", contentHash: digest, scopeHash: digest, reportIdentity: { repositoryId: "repo", sourceId: "fixed-snapshot" } }, ruleSetVersion: "rules-1", analyzerVersion: "analyzer", analysisProfile: "module-syntax-v1", reviewStatus: "human-reviewed",
  files: [{ file: "a.ts", sha256: "b".repeat(64), exhaustive: true, labels: [{ id: "positive", file: "a.ts", expected: "finding", kind: "value-reference", attribution: "manifest-corroborated", location: loc("a.ts", 20), bindingLocation: loc("a.ts", 9) }] }],
  expectedRepository: { bucket: "detected", status: "complete-within-scope" }, ...overrides,
});
const report = (overrides: Partial<ScanReport["results"][number]> = {}): ScanReport => ({
  schemaVersion: "0.1", reportKind: "scan", analyzerVersion: "analyzer", ruleSetVersion: "rules-1", analysisProfile: "module-syntax-v1", generatedAt: "2026-09-11T00:00:00.000Z",
  target: { id: "pkg::pkg::oldApi", packageName: "pkg", moduleSpecifier: "pkg", exportName: "oldApi" }, limitations: ["fixed scope"],
  sample: { source: "local", selected: 1, excluded: 0, attempted: 1, knownTotal: 1, knownTotalUnit: "repositories", exclusionReasons: {} },
  summary: { detected: 1, notDetectedWithinScope: 0, unknown: 0, completeWithinScope: 1, partial: 0, failed: 0 },
  results: [{ repositoryId: "repo", targetId: "pkg::pkg::oldApi", snapshot: { kind: "local", sourceId: "fixed-snapshot", contentHash: digest, scopeHash: digest }, status: "complete-within-scope", bucket: "detected",
    inventory: { discoveredFiles: 1, excludedByPolicy: 0, eligibleFiles: 1, analyzedFiles: 1, failedOrSkippedEligibleFiles: 0 },
    bindings: [{ id: "binding", targetId: "pkg::pkg::oldApi", location: loc("a.ts", 9), localName: "oldApi", form: "esm-named", importSpace: "value", attribution: { status: "manifest-corroborated", reasons: ["manifest"] } }],
    findings: [{ id: "finding", targetId: "pkg::pkg::oldApi", bindingId: "binding", kind: "value-reference", location: loc("a.ts", 20), ruleId: "rule" }], gaps: [], ...overrides }],
});
const run = (data: EvaluationDataset, value?: ScanReport) => evaluateScan(data, value, { snapshotId: data.snapshot.snapshotId, files: data.files.map(file => ({ file: file.file, sha256: file.sha256 })) });

describe("fixed-snapshot evaluation", () => {
  it("matches exact finding and binding spans while keeping repository comparison separate", () => {
    const result = run(dataset(), report());
    expect(result.token).toEqual({ tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 });
    expect(result.attribution).toEqual({ correct: 1, incorrect: 0, unassessable: 0 });
    expect(result.repository).toMatchObject({ bucketMatch: true, statusMatch: true });
    expect(run(dataset()).token).toMatchObject({ tp: 0, fp: 0, fn: 1, precision: null, recall: 0 });
    const extra = report({ findings: [...report().results[0]!.findings, { id: "extra", targetId: "pkg::pkg::oldApi", bindingId: "binding", kind: "value-reference", location: loc("a.ts", 30), ruleId: "rule" }] });
    expect(run(dataset(), extra).token).toMatchObject({ tp: 1, fp: 1, fn: 0, precision: 0.5 });
    const wrongSource = report({ bindings: [{ ...report().results[0]!.bindings[0]!, attribution: { status: "declared-module", reasons: ["declaration only"] } }] });
    expect(run(dataset(), wrongSource).attribution.incorrect).toBe(1);
  });

  it("reports zero denominators as null and does not count output in a non-exhaustive file as FP", () => {
    const data = dataset({ reviewStatus: "provisional", files: [{ file: "a.ts", sha256: "b".repeat(64), exhaustive: false, labels: [] }] });
    const result = run(data, report());
    expect(result.token).toEqual({ tp: 0, fp: 0, fn: 0, precision: null, recall: null });
    expect(result.scope.excludedPredictions).toBe(1);
    expect(result.provisional).toBe(true);
    expect(result.notice).toContain("not human-confirmed");
  });

  it("counts false predictions at explicitly reviewed spans even in a non-exhaustive file", () => {
    const negative = dataset({ files: [{ file: "a.ts", sha256: "b".repeat(64), exhaustive: false, labels: [
      { id: "negative", file: "a.ts", expected: "negative", location: loc("a.ts", 20) },
    ] }] });
    expect(run(negative, report()).token).toEqual({ tp: 0, fp: 1, fn: 0, precision: 0, recall: null });
    expect(run(negative, report()).negatives.falsePositive).toBe(1);
    const wrongKind = dataset();
    wrongKind.files[0]!.exhaustive = false;
    const mismatch = report({ findings: [{ ...report().results[0]!.findings[0]!, kind: "type-reference" }] });
    expect(run(wrongKind, mismatch).token).toMatchObject({ tp: 0, fp: 1, fn: 1 });
  });

  it("separates ambiguous candidates, attribution errors, and unknown gaps", () => {
    const data = dataset({ files: [{ file: "a.ts", sha256: "b".repeat(64), exhaustive: true, labels: [
      { id: "candidate", file: "a.ts", expected: "finding", kind: "value-reference", attribution: "ambiguous", location: loc("a.ts", 20), bindingLocation: loc("a.ts", 9) },
      { id: "unknown", file: "a.ts", expected: "unknown", expectedGapCodes: ["PARSE_FAILED"], location: loc("a.ts", 30) },
    ] }], expectedRepository: { bucket: "unknown", status: "partial" } });
    const actual = report({ status: "partial", bucket: "unknown",
      bindings: [{ ...report().results[0]!.bindings[0]!, attribution: { status: "ambiguous", reasons: ["paths"] } }],
      gaps: [
        { code: "MODULE_ATTRIBUTION_AMBIGUOUS", message: "paths", targetId: "pkg::pkg::oldApi", location: loc("a.ts", 9), affectsConclusion: true },
        { code: "PARSE_FAILED", message: "parse", targetId: "pkg::pkg::oldApi", location: loc("a.ts", 30), affectsConclusion: true },
      ] });
    actual.summary = { detected: 0, notDetectedWithinScope: 0, unknown: 1, completeWithinScope: 0, partial: 1, failed: 0 };
    const result = run(data, actual);
    expect(result.ambiguousCandidates.matched).toBe(1);
    expect(result.attribution.correct).toBe(1);
    expect(result.unknown).toEqual({ matched: 1, missing: 0 });
  });

  it("does not turn a missing or clean report into evidence for expected unknown", () => {
    const data = dataset({ files: [{ file: "a.ts", sha256: "b".repeat(64), exhaustive: true, labels: [{ id: "unknown", file: "a.ts", expected: "unknown", expectedGapCodes: ["PARSE_FAILED"] }] }] });
    expect(run(data).unknown).toEqual({ matched: 0, missing: 1 });
    const clean = report({ bucket: "not-detected-within-scope", findings: [], bindings: [] });
    clean.summary = { detected: 0, notDetectedWithinScope: 1, unknown: 0, completeWithinScope: 1, partial: 0, failed: 0 };
    expect(run(data, clean).negatives.unknownMisclassifiedClean).toBe(1);
    const negative = dataset({ files: [{ file: "a.ts", sha256: "b".repeat(64), exhaustive: true, labels: [{ id: "negative", file: "a.ts", expected: "negative" }] }] });
    const partial = report({ status: "partial", bucket: "unknown", findings: [], bindings: [], gaps: [{ code: "RESOURCE_LIMIT", message: "limit", targetId: "pkg::pkg::oldApi", affectsConclusion: true }] });
    partial.summary = { detected: 0, notDetectedWithinScope: 0, unknown: 1, completeWithinScope: 0, partial: 1, failed: 0 };
    expect(run(negative, partial).negatives).toMatchObject({ trueNegative: 0, falsePositive: 0, unassessable: 1 });
  });

  it("rejects duplicate labels, identity mismatches, empty review scopes, and predictions outside review", () => {
    const duplicate = dataset({ files: [{ file: "a.ts", sha256: "b".repeat(64), exhaustive: true, labels: [
      { id: "same", file: "a.ts", expected: "negative" }, { id: "same", file: "a.ts", expected: "negative" },
    ] }] });
    expect(() => run(duplicate)).toThrow("unique");
    expect(() => run(dataset({ files: [] }))).toThrow("non-empty");
    expect(() => run(dataset(), { ...report(), ruleSetVersion: "other" })).toThrow("identity");
    expect(() => run(dataset(), { ...report(), analyzerVersion: "other" })).toThrow("identity");
    expect(() => run(dataset(), report({ snapshot: { kind: "local", sourceId: "fixed-snapshot", contentHash: digest, scopeHash: "c".repeat(64) } }))).toThrow("snapshot");
    expect(() => run(dataset(), report({ snapshot: { kind: "local", sourceId: "other", contentHash: digest, scopeHash: digest } }))).toThrow("snapshot");
    const outside = report({ findings: [{ id: "other", targetId: "pkg::pkg::oldApi", bindingId: "binding", kind: "value-reference", location: loc("unreviewed.ts", 1), ruleId: "rule" }] });
    expect(() => run(dataset(), outside)).toThrow("outside");
    expect(() => evaluateScan(dataset(), report(), { snapshotId: "wrong", files: [{ file: "a.ts", sha256: "b".repeat(64) }] })).toThrow("observed snapshot");
    expect(() => evaluateScan(dataset(), report(), { snapshotId: "sample-1", files: [{ file: "a.ts", sha256: "c".repeat(64) }] })).toThrow("hashes");
  });

  it("requires every expected conclusion-affecting gap, and rejects cross-file label spans", () => {
    const data = dataset({ files: [{ file: "a.ts", sha256: "b".repeat(64), exhaustive: true, labels: [
      { id: "unknown", file: "a.ts", expected: "unknown", expectedGapCodes: ["PARSE_FAILED", "RESOURCE_LIMIT"] },
    ] }] });
    const partial = report({ status: "partial", gaps: [{ code: "PARSE_FAILED", message: "parse", affectsConclusion: true }] });
    partial.summary = { detected: 1, notDetectedWithinScope: 0, unknown: 0, completeWithinScope: 0, partial: 1, failed: 0 };
    expect(run(data, partial).unknown).toEqual({ matched: 0, missing: 1 });
    partial.results[0]!.gaps.push({ code: "RESOURCE_LIMIT", message: "limit", affectsConclusion: false });
    expect(run(data, partial).unknown.missing).toBe(1);
    partial.results[0]!.gaps[1]!.affectsConclusion = true;
    expect(run(data, partial).unknown.matched).toBe(1);
    data.files[0]!.labels[0]!.location = loc("other.ts", 1);
    expect(() => run(data, partial)).toThrow("reviewed file");
  });
});
