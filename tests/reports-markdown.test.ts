import { beforeAll, describe, expect, it } from "vitest";
import { parseApiTarget, type ScanReport } from "../src/domain/index.js";
import { renderReport, type ReportFormat } from "../src/reports/render.js";
import { createRedactedSnippet } from "../src/reports/snippets.js";
import { scanLocal } from "../src/scans/index.js";

let captured: ScanReport;
beforeAll(async () => { captured = await scanLocal("fixtures/consumer", parseApiTarget({ packageName: "example-lib", exportName: "oldApi" })); });
const fixture = () => structuredClone(captured);
const sha = "a".repeat(40);
function githubReport(): ScanReport {
  const report = fixture();
  const result = report.results[0]!;
  result.repositoryId = "github:example/consumer";
  result.snapshot = { ...result.snapshot!, kind: "git", sourceId: `github:example/consumer@${sha}`, gitCommit: sha };
  report.sample.source = "explicit-list";
  return report;
}

/** Inspect the code-fence boundary: every attacker-controlled field must remain inside. */
function outsideCodeBlocks(markdown: string): string {
  const outside: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    if (fence !== undefined) {
      if (line === fence) fence = undefined;
      else expect(line).not.toMatch(new RegExp(`^ {0,3}${fence}{1,}[ \\t]*$`));
    } else {
      const opening = /^(`{3,})text$/.exec(line);
      if (opening !== null) fence = opening[1];
      else outside.push(line);
    }
  }
  expect(fence).toBeUndefined();
  return outside.join("\n");
}

describe("Markdown reference reports", () => {
  it("shows sample selection, exclusions, unknown totals and independent bucket/status tables", () => {
    const report = fixture();
    report.sample = { ...report.sample, selected: 3, excluded: 2, knownTotal: null, knownTotalUnit: "unknown", exclusionReasons: { "duplicate-repository": 2 } };
    const rendered = renderReport(report, "markdown");
    expect(rendered).toContain("| Selected | 3 |");
    expect(rendered).toContain("| Excluded | 2 |");
    expect(rendered).toContain("| Attempted | 1 |");
    expect(rendered).toContain("| Known total | unknown |");
    expect(rendered).toContain("duplicate-repository: 2");
    expect(rendered).toContain("| detected | 1 |");
    expect(rendered).toContain("| not-detected-within-scope | 0 |");
    expect(rendered).toContain("| unknown | 0 |");
    expect(rendered).toContain("| complete-within-scope | 1 |");
    expect(rendered).toContain("| partial | 0 |");
    expect(rendered).toContain("| failed | 0 |");
    expect(rendered).toContain("does not establish migration or safe removal");
  });

  it("retains four evidence kinds, accurate binding positions, rule versions and snapshot hashes", () => {
    const report = fixture();
    const result = report.results[0]!;
    const rendered = renderReport(report, "markdown");
    for (const kind of ["import-only", "value-reference", "type-reference", "direct-reexport"]) expect(rendered).toContain(kind);
    for (const finding of result.findings) {
      expect(rendered).toContain(finding.id);
      expect(rendered).toContain(`rule=${finding.ruleId}`);
      const binding = result.bindings.find(value => value.id === finding.bindingId)!;
      expect(rendered).toContain(binding.id);
      expect(rendered).toContain(`${binding.location.file}:${binding.location.start.line}:${binding.location.start.column}`);
    }
    expect(rendered).toContain(result.snapshot!.contentHash);
    expect(rendered).toContain(result.snapshot!.scopeHash);
    expect(rendered).toContain("declared-module");
    expect(rendered).toContain("## Limitations");
    expect(rendered).toContain("snapshotScope=");
    expect(outsideCodeBlocks(rendered)).not.toContain("](https://");
  });

  it("displays ambiguous candidates and the gaps that prevent a clean result", () => {
    const report = fixture();
    const result = report.results[0]!;
    for (const binding of result.bindings) binding.attribution = { status: "ambiguous", reasons: ["workspace package"] };
    result.gaps.push({ code: "MODULE_ATTRIBUTION_AMBIGUOUS", message: "Workspace source cannot be attributed to the published package.", affectsConclusion: true });
    result.status = "partial";
    result.bucket = "unknown";
    report.summary = { detected: 0, notDetectedWithinScope: 0, unknown: 1, completeWithinScope: 0, partial: 1, failed: 0 };
    const rendered = renderReport(report, "markdown");
    expect(rendered.match(/candidate \/ ambiguous/g)).toHaveLength(result.findings.length);
    expect(rendered).toContain("| detected | 0 |");
    expect(rendered).toContain("Result bucket: **unknown**. Execution status: **partial**.");
    expect(rendered).toContain("Code: MODULE_ATTRIBUTION_AMBIGUOUS; affectsConclusion=true");
  });

  it("keeps a binding visible even when no finding uses it", () => {
    const report = fixture();
    const binding = report.results[0]!.bindings[0]!;
    report.results[0]!.findings = report.results[0]!.findings.filter(finding => finding.bindingId !== binding.id);
    const rendered = renderReport(report, "markdown");
    expect(rendered).toContain("### Bindings without findings");
    expect(rendered).toContain(binding.id);
  });

  it("contains hostile HTML, links, fence runs and format controls within escaped evidence blocks", () => {
    const report = fixture();
    const result = report.results[0]!;
    const attack = "attacker-canary\n````````````\n# injected\n<script>alert(1)</script>![pixel](https://evil.invalid/collect)\u001b\u202e\u200b\u{e0001}";
    report.analyzerVersion = attack;
    report.ruleSetVersion = attack;
    report.limitations.push(attack);
    report.sample = { ...report.sample, selected: 2, excluded: 1, exclusionReasons: { [attack]: 1 } };
    result.repositoryId = attack;
    result.snapshot = { ...result.snapshot!, sourceId: attack, contentHash: attack, scopeHash: attack };
    result.bindings[0]!.localName = attack;
    result.bindings[0]!.attribution.reasons = [attack];
    result.bindings[0]!.attribution.declaredRange = attack;
    result.bindings[0]!.attribution.manifestFile = "src/<img src=evil>.json";
    result.findings[0]!.ruleId = attack;
    result.findings[0]!.id = attack;
    result.findings[0]!.location.file = "src/![attacker-canary](https:evil).ts";
    result.gaps.push({ code: "CONFIG_UNRESOLVED", message: attack, affectsConclusion: false });
    const rendered = renderReport(report, "markdown");
    const outside = outsideCodeBlocks(rendered);
    expect(rendered).toContain("`````````````text");
    expect(rendered).toContain("\\u001b");
    expect(rendered).toContain("\\u{e0001}");
    for (const raw of ["\u001b", "\u202e", "\u200b", "\u{e0001}"]) expect(rendered).not.toContain(raw);
    for (const value of ["attacker-canary", "evil.invalid", "<script>", "<img", "# injected", "[pixel]"]) expect(outside).not.toContain(value);
    expect(outside).not.toContain("](https://");
  });

  it("creates only fixed GitHub finding/binding links and encodes hostile filename characters", () => {
    const report = githubReport();
    const finding = report.results[0]!.findings[0]!;
    finding.location = { file: "src/汉字 []!(')#%?.ts", start: { line: 3, column: 1 }, end: { line: 5, column: 1 } };
    const rendered = renderReport(report, "markdown");
    const expected = `https://github.com/example/consumer/blob/${sha}/src/%E6%B1%89%E5%AD%97%20%5B%5D%21%28%27%29%23%25%3F.ts#L3-L4`;
    expect(rendered).toContain(`[Finding source](${expected})`);
    expect(rendered).toContain(`[Binding source](https://github.com/example/consumer/blob/${sha}/`);
    const links = [...outsideCodeBlocks(rendered).matchAll(/\]\(([^)]+)\)/g)].map(match => new URL(match[1]!));
    expect(links).toHaveLength(report.results[0]!.findings.length * 2);
    expect(links.every(url => url.hostname === "github.com" && url.pathname.startsWith(`/example/consumer/blob/${sha}/`))).toBe(true);
  });

  it.each(["local-kind", "local-id", "mismatch", "short-sha", "branch", "dirty", "url-id", "git-suffix"])("does not construct links for unverified identity: %s", variation => {
    const report = githubReport();
    const result = report.results[0]!;
    const snapshot = result.snapshot!;
    if (variation === "local-kind") snapshot.kind = "local";
    if (variation === "local-id") result.repositoryId = "local:example";
    if (variation === "mismatch") snapshot.sourceId = `github:other/consumer@${sha}`;
    if (variation === "short-sha") snapshot.gitCommit = "abcdef1";
    if (variation === "branch") snapshot.gitCommit = "main";
    if (variation === "dirty") snapshot.dirty = true;
    if (variation === "url-id") result.repositoryId = "github:https://evil.invalid/repo";
    if (variation === "git-suffix") result.repositoryId = "github:example/consumer.git";
    expect(outsideCodeBlocks(renderReport(report, "markdown"))).not.toContain("](https://");
  });
});

describe("explicit snippet rendering", () => {
  it.each<ReportFormat>(["json", "text", "markdown"])("keeps snippets off by default in %s and requires redaction metadata when enabled", format => {
    const report = fixture();
    const finding = report.results[0]!.findings[0]!;
    finding.snippet = "private-canary-source";
    expect(renderReport(report, format)).not.toContain("private-canary-source");
    expect(renderReport(report, format, { includeSnippets: true })).not.toContain("private-canary-source");
    finding.snippetRedacted = false;
    expect(renderReport(report, format, { includeSnippets: true })).not.toContain("private-canary-source");
    expect(finding.snippet).toBe("private-canary-source");
  });

  it.each<ReportFormat>(["json", "text", "markdown"])("renders a bounded helper-produced excerpt only when explicitly enabled in %s", format => {
    const report = fixture();
    const source = "const secret = 'private-canary'; oldApi(secret); // private-comment";
    const start = source.indexOf("oldApi");
    const excerpt = createRedactedSnippet(Buffer.from(source), { file: "input.ts", start: { line: 1, column: start + 1 }, end: { line: 1, column: start + 7 } }, ["oldApi"]);
    Object.assign(report.results[0]!.findings[0]!, excerpt);
    const rendered = renderReport(report, format, { includeSnippets: true });
    expect(rendered).toContain("[…] oldApi […]");
    for (const secret of ["private-canary", "private-comment"]) expect(rendered).not.toContain(secret);
    if (format === "json") expect(JSON.parse(rendered).results[0].findings[0].snippetRedacted).toBe(true);
    else expect(rendered).toContain("secret"); // visible limitation about the redaction policy
    expect(renderReport(report, format)).not.toContain("[…] oldApi […]");
  });

  it("rejects arbitrary snippet content even if a caller falsely marks it redacted", () => {
    const report = fixture();
    Object.assign(report.results[0]!.findings[0]!, { snippet: "\u001b\n````````\n<script>attacker-canary</script>".repeat(10), snippetRedacted: true });
    const json = JSON.parse(renderReport(report, "json", { includeSnippets: true }));
    expect(json.results[0].findings[0].snippet).toBeUndefined();
    expect(json.results[0].findings[0].snippetRedacted).toBeUndefined();
    expect(outsideCodeBlocks(renderReport(report, "markdown", { includeSnippets: true }))).not.toContain("attacker-canary");
  });

  it("bounds escaped identifier excerpts without splitting surrogate pairs", () => {
    const report = fixture();
    const binding = report.results[0]!.bindings.find(value => value.id === report.results[0]!.findings[0]!.bindingId)!;
    binding.localName = `a${"\u200d𐐀".repeat(35)}`;
    Object.assign(report.results[0]!.findings[0]!, { snippet: `[…] ${binding.localName} […]`, snippetRedacted: true });
    const json = JSON.parse(renderReport(report, "json", { includeSnippets: true }));
    const rendered = json.results[0].findings[0].snippet as string;
    expect(rendered.length).toBeLessThanOrEqual(160);
    expect(rendered).toContain("\\u200d");
    expect(rendered).not.toMatch(/[\p{Cf}\p{Cs}]/u);
    expect(rendered.endsWith("…")).toBe(true);
  });
});
