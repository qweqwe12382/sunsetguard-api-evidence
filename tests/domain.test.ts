import { describe, expect, it } from "vitest";
import {
  DomainValidationError, expectedBucket, parseApiTarget, validateRepositoryTargetResult, validateScanReport,
  type RepositoryTargetResult, type ScanReport,
} from "../src/domain/index.js";

const result = (overrides: Partial<RepositoryTargetResult> = {}): RepositoryTargetResult => ({
  repositoryId: "local:fixture",
  targetId: "example-lib::example-lib/parser::oldParse",
  snapshot: { kind: "local", sourceId: "synthetic-fixture", contentHash: "test-content-hash", scopeHash: "test-scope-hash" },
  status: "complete-within-scope",
  bucket: "detected",
  inventory: { discoveredFiles: 1, excludedByPolicy: 0, eligibleFiles: 1, analyzedFiles: 1, failedOrSkippedEligibleFiles: 0 },
  bindings: [{
    id: "b1", targetId: "example-lib::example-lib/parser::oldParse",
    location: { file: "src/a.ts", start: { line: 1, column: 10 }, end: { line: 1, column: 18 } },
    localName: "oldParse", form: "esm-named", importSpace: "value",
    attribution: { status: "declared-module", reasons: ["literal module declaration"] },
  }],
  findings: [{
    id: "f1", targetId: "example-lib::example-lib/parser::oldParse", bindingId: "b1", kind: "value-reference",
    location: { file: "src/a.ts", start: { line: 2, column: 1 }, end: { line: 2, column: 9 } }, ruleId: "esm-named-v1",
  }],
  gaps: [],
  ...overrides,
});

describe("parseApiTarget", () => {
  it("defaults the exact module entry and derives a stable id", () => {
    expect(parseApiTarget({ packageName: "@scope/pkg", exportName: "oldApi" })).toMatchObject({
      id: "@scope/pkg::@scope/pkg::oldApi", moduleSpecifier: "@scope/pkg",
    });
    expect(parseApiTarget({ packageName: "example-lib", moduleSpecifier: "example-lib/parser", exportName: "oldParse" }).id)
      .toBe("example-lib::example-lib/parser::oldParse");
  });

  it.each([
    [{ exportName: "oldApi" }, "packageName"],
    [{ packageName: "pkg", moduleSpecifier: "pkg-extra", exportName: "oldApi" }, "moduleSpecifier"],
    [{ packageName: "pkg", moduleSpecifier: "pkg/../other", exportName: "oldApi" }, "subpath"],
    [{ packageName: "pkg", moduleSpecifier: "pkg//internal", exportName: "oldApi" }, "subpath"],
    [{ packageName: "pkg", moduleSpecifier: "pkg/./internal", exportName: "oldApi" }, "subpath"],
    [{ packageName: "pkg", moduleSpecifier: "pkg/internal api", exportName: "oldApi" }, "subpath"],
    [{ id: "invented", packageName: "pkg", exportName: "oldApi" }, "id"],
    [{ packageName: "pkg", exportName: "old-api" }, "exportName"],
  ])("rejects inconsistent or unreasonable targets", (input, message) => {
    expect(() => parseApiTarget(input)).toThrow(message);
  });

  it("requires evidence metadata before calling deprecation verified", () => {
    expect(() => parseApiTarget({ packageName: "pkg", exportName: "oldApi", deprecation: { status: "verified" } }))
      .toThrow("requires packageVersion");
  });
});

describe("repository result invariants", () => {
  it("keeps positive evidence detected when analysis is partial", () => {
    const partial = result({ status: "partial", gaps: [{ code: "PARSE_FAILED", message: "one file failed", affectsConclusion: true }] });
    expect(expectedBucket(partial)).toBe("detected");
    expect(validateRepositoryTargetResult(partial)).toEqual(partial);
  });

  it("keeps ambiguous candidates out of detected", () => {
    const ambiguous = result({
      status: "partial", bucket: "unknown",
      bindings: [{ ...result().bindings[0]!, attribution: { status: "ambiguous", reasons: ["paths mapping"] } }],
      gaps: [{ code: "MODULE_ATTRIBUTION_AMBIGUOUS", message: "paths mapping", affectsConclusion: true }],
    });
    expect(expectedBucket(ambiguous)).toBe("unknown");
    expect(validateRepositoryTargetResult(ambiguous)).toEqual(ambiguous);
    expect(() => validateRepositoryTargetResult({ ...ambiguous, bucket: "detected" })).toThrow("bucket must be unknown");
    expect(() => validateRepositoryTargetResult({ ...ambiguous, status: "complete-within-scope", gaps: [] })).toThrow("ambiguous candidates");
  });

  it("does not permit an empty analysis to look complete and clean", () => {
    const empty = result({
      status: "complete-within-scope", bucket: "not-detected-within-scope",
      inventory: { discoveredFiles: 0, excludedByPolicy: 0, eligibleFiles: 0, analyzedFiles: 0, failedOrSkippedEligibleFiles: 0 },
      bindings: [], findings: [], gaps: [],
    });
    expect(() => validateRepositoryTargetResult(empty)).toThrow(DomainValidationError);
    expect(validateRepositoryTargetResult({
      ...empty, status: "partial", bucket: "unknown",
      gaps: [{ code: "NO_ANALYZABLE_FILES", message: "no source files", affectsConclusion: true }],
    }).bucket).toBe("unknown");
  });

  it("rejects broken inventory and orphan findings", () => {
    expect(() => validateRepositoryTargetResult(result({ inventory: { ...result().inventory, eligibleFiles: 2 } }))).toThrow("inventory");
    expect(() => validateRepositoryTargetResult(result({ findings: [{ ...result().findings[0]!, bindingId: "missing" }] }))).toThrow("unknown binding");
  });

  it("accepts acquisition failure as unknown + failed", () => {
    const failed = result({
      status: "failed", bucket: "unknown",
      inventory: { discoveredFiles: 0, excludedByPolicy: 0, eligibleFiles: 0, analyzedFiles: 0, failedOrSkippedEligibleFiles: 0 },
      bindings: [], findings: [], gaps: [{ code: "SOURCE_UNAVAILABLE", message: "source unavailable", affectsConclusion: true }],
    });
    expect(validateRepositoryTargetResult(failed)).toEqual(failed);
  });

  it("rejects backwards locations and import-only mixed with a real reference", () => {
    const backwards = result();
    backwards.findings[0]!.location.end = { line: 1, column: 1 };
    backwards.findings[0]!.location.start = { line: 2, column: 1 };
    expect(() => validateRepositoryTargetResult(backwards)).toThrow("invalid structure");
    expect(() => validateRepositoryTargetResult(result({ findings: [
      result().findings[0]!,
      { ...result().findings[0]!, id: "f2", kind: "import-only" },
    ] }))).toThrow("import-only cannot coexist");
  });

  it("requires a snapshot identity for analyzable evidence", () => {
    const withEvidence = result();
    delete withEvidence.snapshot;
    expect(() => validateRepositoryTargetResult(withEvidence)).toThrow("snapshot identity");
  });

  it("keeps confirmed evidence while making mixed attribution incomplete", () => {
    const mixed = result();
    mixed.bindings.push({ ...mixed.bindings[0]!, id: "ambiguous-binding", attribution: { status: "ambiguous", reasons: ["local replacement"] } });
    mixed.findings.push({ ...mixed.findings[0]!, id: "candidate", bindingId: "ambiguous-binding" });
    expect(() => validateRepositoryTargetResult(mixed)).toThrow("ambiguous candidates");
    mixed.status = "partial";
    mixed.gaps.push({ code: "MODULE_ATTRIBUTION_AMBIGUOUS", message: "local replacement", affectsConclusion: true });
    expect(validateRepositoryTargetResult(mixed).bucket).toBe("detected");
  });

  const malformed: Array<[string, (value: RepositoryTargetResult) => unknown]> = [
    ["snapshot shape", value => ({ ...value, snapshot: "not a snapshot" })],
    ["unknown attribution", value => ({ ...value, bindings: [{ ...value.bindings[0]!, attribution: { status: "trusted", reasons: [] } }] })],
    ["unknown finding kind", value => ({ ...value, findings: [{ ...value.findings[0]!, kind: "call" }] })],
    ["snippet type", value => ({ ...value, findings: [{ ...value.findings[0]!, snippet: 5 }] })],
    ["manifest absolute path", value => ({ ...value, bindings: [{ ...value.bindings[0]!, attribution: { status: "manifest-corroborated", reasons: [], manifestFile: "C:/private/package.json" } }] })],
    ["path traversal", value => ({ ...value, findings: [{ ...value.findings[0]!, location: { ...value.findings[0]!.location, file: "../outside.ts" } }] })],
    ["control character in path", value => ({ ...value, findings: [{ ...value.findings[0]!, location: { ...value.findings[0]!.location, file: "src/\u001bfile.ts" } }] })],
    ["unrelated gap target", value => ({ ...value, gaps: [{ code: "PARSE_FAILED", message: "error", affectsConclusion: true, targetId: "another-target" }] })],
    ["blank named binding", value => ({ ...value, bindings: [{ ...value.bindings[0]!, localName: " " }] })],
  ];
  for (const [name, mutate] of malformed) {
    it(`rejects malformed external evidence: ${name}`, () => {
      expect(() => validateRepositoryTargetResult(mutate(result()))).toThrow(DomainValidationError);
    });
  }

  it("preserves legitimate filename whitespace without changing evidence identity", () => {
    const evidence = result();
    evidence.findings[0]!.location.file = "src/ file.ts ";
    expect(validateRepositoryTargetResult(evidence).findings[0]!.location.file).toBe("src/ file.ts ");
  });

  it("allows arbitrary string aliases only for direct re-exports", () => {
    const direct = result({
      bindings: [{ ...result().bindings[0]!, form: "esm-reexport", localName: " " }],
      findings: [{ ...result().findings[0]!, kind: "direct-reexport" }],
    });
    expect(validateRepositoryTargetResult(direct).bindings[0]!.localName).toBe(" ");
  });
});

describe("scan report invariants", () => {
  it("checks both independent summary dimensions", () => {
    const detectedPartial = result({ status: "partial", gaps: [{ code: "PARSE_FAILED", message: "one file", affectsConclusion: true }] });
    const report: ScanReport = {
      schemaVersion: "0.1", reportKind: "synthetic-example", analyzerVersion: "0.0.0", ruleSetVersion: "module-syntax-v1",
      analysisProfile: "module-syntax-v1", generatedAt: "2026-09-10T00:00:00.000Z",
      target: parseApiTarget({ packageName: "example-lib", moduleSpecifier: "example-lib/parser", exportName: "oldParse" }),
      limitations: ["module declarations are not runtime resolution proof"],
      sample: { source: "local", selected: 1, excluded: 0, attempted: 1, knownTotal: 1, knownTotalUnit: "repositories", exclusionReasons: {} },
      summary: { detected: 1, notDetectedWithinScope: 0, unknown: 0, completeWithinScope: 0, partial: 1, failed: 0 },
      results: [detectedPartial],
    };
    expect(validateScanReport(report)).toEqual(report);
    expect(() => validateScanReport({ ...report, summary: { ...report.summary, partial: 0 } })).toThrow("summary.partial");
    expect(() => validateScanReport({ ...report, sample: { ...report.sample, attempted: 2 } })).toThrow("sample counts");
  });

  it("requires canonical targets and honest exclusion metadata", () => {
    const base = result();
    const report: ScanReport = {
      schemaVersion: "0.1", reportKind: "synthetic-example", analyzerVersion: "0.0.0", ruleSetVersion: "v1",
      analysisProfile: "module-syntax-v1", generatedAt: "2026-09-10T00:00:00.000Z",
      target: parseApiTarget({ packageName: "example-lib", moduleSpecifier: "example-lib/parser", exportName: "oldParse" }),
      limitations: ["limited static analysis"],
      sample: { source: "local", selected: 2, excluded: 1, attempted: 1, knownTotal: 2, knownTotalUnit: "repositories", exclusionReasons: { duplicate: 1 } },
      summary: { detected: 1, notDetectedWithinScope: 0, unknown: 0, completeWithinScope: 1, partial: 0, failed: 0 }, results: [base],
    };
    expect(validateScanReport(report)).toEqual(report);
    expect(() => validateScanReport({ ...report, target: { packageName: "example-lib", exportName: "oldParse" } })).toThrow("invalid structure");
    expect(() => validateScanReport({ ...report, sample: { ...report.sample, knownTotalUnit: "unknown" } })).toThrow("knownTotal");
    expect(() => validateScanReport({ ...report, sample: { ...report.sample, exclusionReasons: {} } })).toThrow("exclusionReasons");
    expect(() => validateScanReport({ ...report, safeToRemove: true })).toThrow("invalid structure");
    expect(() => validateScanReport({
      ...report,
      results: [base, structuredClone(base)],
      sample: { ...report.sample, selected: 3, attempted: 2 },
      summary: { ...report.summary, detected: 2, completeWithinScope: 2 },
    })).toThrow("duplicate repositoryId");
  });
});
