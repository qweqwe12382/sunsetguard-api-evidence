import { describe, expect, it } from "vitest";
import { parseApiTarget, validateScanReport } from "../src/domain/index.js";
import { renderReport } from "../src/reports/render.js";
import { scanLocal } from "../src/scans/index.js";

const target = parseApiTarget({ packageName: "example-lib", exportName: "oldApi" });
const fixtureReport = () => scanLocal("fixtures/consumer", target);

describe("report rendering", () => {
  it("renders a single valid JSON document with all evidence kinds", async () => {
    const report = await fixtureReport();
    const json = renderReport(report, "json");
    expect(validateScanReport(JSON.parse(json))).toEqual(report);
    expect(report.results[0]!.findings).toHaveLength(5);
    expect(new Set(report.results[0]!.findings.map(finding => finding.kind)).size).toBe(4);
  });

  it("renders every result, binding location, summary and limitation", async () => {
    const report = await fixtureReport();
    report.reportKind = "synthetic-example";
    report.results.push({ ...report.results[0]!, repositoryId: "synthetic-second" });
    report.sample = { ...report.sample, selected: 2, attempted: 2, knownTotal: 2 };
    report.summary = { ...report.summary, detected: 2, completeWithinScope: 2 };
    const rendered = renderReport(report, "text");
    expect(rendered).toContain("Summary: detected=2");
    expect(rendered).toContain("Repository: local:single");
    expect(rendered).toContain("Repository: synthetic-second");
    for (const finding of report.results[0]!.findings) {
      expect(rendered).toContain(finding.id);
      expect(rendered).toContain(finding.bindingId);
    }
    expect(rendered).toContain("declared-module");
    expect(rendered).toContain("Scope hash:");
    expect(rendered).toContain("snapshotScope=");
    expect(rendered).toContain("Gaps:\n- none recorded");
  });

  it("does not publish source snippets and escapes text control characters", async () => {
    const report = await fixtureReport();
    report.results[0]!.findings[0]!.snippet = "private-canary-source";
    report.limitations.push("control:\u001b[2J\u202e\u061c\u200e\u200f");
    const json = renderReport(report, "json");
    const rendered = renderReport(report, "text");
    expect(json).not.toContain("private-canary-source");
    expect(rendered).not.toContain("private-canary-source");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u202e");
    for (const character of ["\u061c", "\u200e", "\u200f"]) expect(rendered).not.toContain(character);
    expect(rendered).toContain("\\u001b");
    expect(report.results[0]!.findings[0]!.snippet).toBe("private-canary-source");
  });

  it("refuses an inconsistent report before rendering output", async () => {
    const report = await fixtureReport();
    report.summary.detected = 20;
    expect(() => renderReport(report, "json")).toThrow();
  });
  it("visibly labels ambiguous findings as candidates and keeps them out of confirmed detection", async () => {
    const report = await fixtureReport();
    report.reportKind = "synthetic-example";
    const result = report.results[0]!;
    result.bindings = result.bindings.map(binding => ({ ...binding, attribution: { status: "ambiguous", reasons: ["workspace source"] } }));
    result.gaps.push({ code: "MODULE_ATTRIBUTION_AMBIGUOUS", message: "Source is ambiguous.", targetId: target.id, affectsConclusion: true });
    result.status = "partial";
    result.bucket = "unknown";
    report.summary = { detected: 0, notDetectedWithinScope: 0, unknown: 1, completeWithinScope: 0, partial: 1, failed: 0 };
    const rendered = renderReport(report, "text");
    expect(rendered).toContain("Summary: detected=0");
    expect(rendered.match(/candidate \/ ambiguous:/g)).toHaveLength(5);
    expect(validateScanReport(JSON.parse(renderReport(report, "json"))).results[0]!.findings).toHaveLength(5);
  });
});
