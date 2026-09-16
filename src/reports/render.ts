import { validateScanReport, type Binding, type Finding, type Location, type RepositoryTargetResult, type ScanReport } from "../domain/index.js";
import { isRedactedSnippet, SNIPPET_MAX_CHARS } from "./snippets.js";

export type ReportFormat = "json" | "text" | "markdown";
export interface RenderOptions { includeSnippets?: boolean }

function text(value: string): string {
  return [...value].map(character => {
    const code = character.codePointAt(0)!;
    return /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(character)
      ? code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`
      : character;
  }).join("");
}

function location(value: Location): string {
  return `${text(value.file)}:${value.start.line}:${value.start.column}-${value.end.line}:${value.end.column}`;
}

function snippet(finding: Finding, includeSnippets: boolean, allowedNames: readonly string[]): Pick<Finding, "snippet" | "snippetRedacted"> {
  if (!includeSnippets || finding.snippetRedacted !== true || finding.snippet === undefined || !isRedactedSnippet(finding.snippet, allowedNames)) return {};
  const safe = text(finding.snippet);
  // Do not split a surrogate pair if escaping format characters expands a token.
  let limited = "";
  for (const character of safe) {
    if (limited.length + character.length > SNIPPET_MAX_CHARS - 1 && safe.length > SNIPPET_MAX_CHARS) { limited += "…"; break; }
    limited += character;
  }
  return { snippet: limited, snippetRedacted: true };
}

function bindingLines(binding: Binding): string[] {
  const lines = [
    `binding: ${text(binding.id)}; ${binding.form}/${binding.importSpace}; ${text(binding.localName ?? "unnamed")} at ${location(binding.location)}`,
    `attribution: ${binding.attribution.status}; ${binding.attribution.reasons.map(text).join("; ")}`,
  ];
  if (binding.attribution.manifestFile !== undefined) {
    lines.push(`manifest: ${text(binding.attribution.manifestFile)}; dependency=${text(binding.attribution.dependencyKind ?? "unknown")}`);
  }
  if (binding.attribution.resolvedVersion !== undefined) lines.push(`resolved-version: ${text(binding.attribution.resolvedVersion)}`);
  return lines;
}

function snapshotLines(result: RepositoryTargetResult): string[] {
  return [
    `Snapshot: ${text(result.snapshot?.contentHash ?? "unavailable")}`,
    `Scope hash: ${text(result.snapshot?.scopeHash ?? "unavailable")}`,
    `Source: ${text(result.snapshot?.sourceId ?? "unavailable")}; kind=${result.snapshot?.kind ?? "unavailable"}`,
    `Commit: ${text(result.snapshot?.gitCommit ?? "unavailable")}; dirty=${result.snapshot?.dirty === undefined ? "unknown" : result.snapshot.dirty}`,
  ];
}

/** All untrusted fields stay inside a code fence longer than any source fence. */
function fenced(lines: readonly string[]): string {
  const body = lines.join("\n");
  let length = 3;
  for (const match of body.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}text\n${body}\n${fence}`;
}

function sourceLink(result: RepositoryTargetResult, at: Location): string | undefined {
  const snapshot = result.snapshot;
  const matched = /^github:([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100})$/.exec(result.repositoryId);
  const repository = matched?.[1];
  if (repository === undefined || /\/(?:\.|\.\.)$/.test(repository) || repository.endsWith(".git") ||
      snapshot?.kind !== "git" || snapshot.dirty === true || !/^[a-f0-9]{40}$/.test(snapshot.gitCommit ?? "") ||
      snapshot.sourceId !== `${result.repositoryId}@${snapshot.gitCommit}`) return undefined;
  let path: string;
  try { path = at.file.split("/").map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/"); }
  catch { return undefined; }
  const lastLine = at.end.line > at.start.line && at.end.column === 1 ? at.end.line - 1 : at.end.line;
  const lines = at.start.line === lastLine ? `L${at.start.line}` : `L${at.start.line}-L${lastLine}`;
  return `https://github.com/${repository}/blob/${snapshot.gitCommit}/${path}#${lines}`;
}

function markdown(report: ScanReport, includeSnippets: boolean): string {
  const lines = [
    "# SunsetGuard reference evidence", "",
    "References are observations within the stated scope. An absence of findings does not establish migration or safe removal.", "",
    "## Target and analysis", "", fenced([
      `Target: ${text(report.target.packageName)} :: ${text(report.target.moduleSpecifier)} :: ${text(report.target.exportName)}`,
      `Report: ${report.reportKind}; schema=${report.schemaVersion}; analyzer=${text(report.analyzerVersion)}; rules=${text(report.ruleSetVersion)}; profile=${report.analysisProfile}`,
      `Generated: ${text(report.generatedAt)}`,
    ]), "", "## Sample and results", "",
    "| Sample | Count |", "| --- | ---: |",
    `| Selected | ${report.sample.selected} |`, `| Excluded | ${report.sample.excluded} |`,
    `| Attempted | ${report.sample.attempted} |`,
    `| Known total | ${report.sample.knownTotal === null ? "unknown" : report.sample.knownTotal} |`, "",
    `Sample source: ${report.sample.source}. Total unit: ${report.sample.knownTotalUnit}.`, "",
    "| Result bucket | Repositories |", "| --- | ---: |",
    `| detected | ${report.summary.detected} |`,
    `| not-detected-within-scope | ${report.summary.notDetectedWithinScope} |`,
    `| unknown | ${report.summary.unknown} |`, "",
    "| Execution status | Repositories |", "| --- | ---: |",
    `| complete-within-scope | ${report.summary.completeWithinScope} |`,
    `| partial | ${report.summary.partial} |`, `| failed | ${report.summary.failed} |`, "",
    "### Exclusions", "",
  ];
  const exclusions = Object.entries(report.sample.exclusionReasons);
  lines.push(exclusions.length === 0 ? "None recorded." : fenced(exclusions.map(([reason, count]) => `${text(reason)}: ${count}`)));
  for (const [index, result] of report.results.entries()) {
    lines.push("", `## Repository ${index + 1}`, "", fenced([`Repository: ${text(result.repositoryId)}`, ...snapshotLines(result)]), "",
      `Result bucket: **${result.bucket}**. Execution status: **${result.status}**.`, "",
      "| File inventory | Count |", "| --- | ---: |",
      `| Discovered | ${result.inventory.discoveredFiles} |`, `| Excluded by policy | ${result.inventory.excludedByPolicy} |`,
      `| Eligible | ${result.inventory.eligibleFiles} |`, `| Analyzed | ${result.inventory.analyzedFiles} |`,
      `| Failed or skipped eligible | ${result.inventory.failedOrSkippedEligibleFiles} |`, "", "### Findings", "");
    const bindings = new Map(result.bindings.map(binding => [binding.id, binding]));
    if (result.findings.length === 0) lines.push("None within the reported scope; inspect execution status and gaps.");
    for (const [findingIndex, finding] of result.findings.entries()) {
      const binding = bindings.get(finding.bindingId)!;
      lines.push(`#### Finding ${findingIndex + 1}: ${finding.kind}${binding.attribution.status === "ambiguous" ? " — candidate / ambiguous" : ""}`, "",
        fenced([`Finding: ${text(finding.id)}; rule=${text(finding.ruleId)}`, `Location: ${location(finding.location)}`, ...bindingLines(binding)]), "");
      const findingLink = sourceLink(result, finding.location);
      const bindingLink = sourceLink(result, binding.location);
      if (findingLink !== undefined && bindingLink !== undefined) lines.push(`[Finding source](${findingLink}) · [Binding source](${bindingLink})`, "");
      if (finding.snippet !== undefined) lines.push("Redacted token excerpt (surrounding source omitted):", "", fenced([finding.snippet]), "");
    }
    const referenced = new Set(result.findings.map(finding => finding.bindingId));
    const remaining = result.bindings.filter(binding => !referenced.has(binding.id));
    if (remaining.length > 0) {
      lines.push("### Bindings without findings", "");
      for (const binding of remaining) lines.push(fenced(bindingLines(binding)), "");
    }
    lines.push("### Gaps", "");
    if (result.gaps.length === 0) lines.push("None recorded.");
    for (const gap of result.gaps) lines.push(fenced([
      `Code: ${gap.code}; affectsConclusion=${gap.affectsConclusion}`,
      ...(gap.location === undefined ? [] : [`Location: ${location(gap.location)}`]),
      `Message: ${text(gap.message)}`,
    ]), "");
  }
  lines.push("", "## Limitations", "");
  if (report.limitations.length === 0) lines.push("None recorded.");
  else for (const limitation of report.limitations) lines.push(fenced([text(limitation)]), "");
  if (includeSnippets) lines.push("Snippet excerpts retain only matched evidence tokens; surrounding source is omitted. This is a bounded redaction policy, not a guarantee of detecting every secret.", "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Snippet-bearing input must come from the bounded frozen-byte snippet helper. */
export function renderReport(input: ScanReport, format: ReportFormat, options: RenderOptions = {}): string {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      Object.keys(options).some(key => key !== "includeSnippets") ||
      (options.includeSnippets !== undefined && typeof options.includeSnippets !== "boolean")) throw new TypeError("Invalid render options.");
  const validated = validateScanReport(input);
  const report: ScanReport = {
    ...validated,
    results: validated.results.map(result => {
      const names = new Map(result.bindings.map(binding => [binding.id, binding.localName]));
      return {
        ...result,
        // declaredRange is accepted for legacy report compatibility but is downstream manifest data.
        // Rebuild attribution from report-safe fields so no renderer exports that raw value.
        bindings: result.bindings.map(binding => ({
          ...binding,
          attribution: {
            status: binding.attribution.status,
            reasons: binding.attribution.reasons,
            ...(binding.attribution.manifestFile === undefined ? {} : { manifestFile: binding.attribution.manifestFile }),
            ...(binding.attribution.dependencyKind === undefined ? {} : { dependencyKind: binding.attribution.dependencyKind }),
            ...(binding.attribution.resolvedVersion === undefined ? {} : { resolvedVersion: binding.attribution.resolvedVersion }),
          },
        })),
        findings: result.findings.map(finding => ({
          id: finding.id, targetId: finding.targetId, bindingId: finding.bindingId,
          kind: finding.kind, location: finding.location, ruleId: finding.ruleId,
          ...snippet(finding, options.includeSnippets === true, [validated.target.exportName, names.get(finding.bindingId) ?? ""]),
        })),
      };
    }),
  };
  if (format === "json") return `${JSON.stringify(report)}\n`;
  if (format === "markdown") return markdown(report, options.includeSnippets === true);
  if (format !== "text") throw new TypeError("Unsupported report format.");
  const lines = [
    `Target: ${text(report.target.packageName)} :: ${text(report.target.moduleSpecifier)} :: ${text(report.target.exportName)}`,
    `Report: ${report.reportKind}; schema=${report.schemaVersion}; analyzer=${text(report.analyzerVersion)}; rules=${text(report.ruleSetVersion)}; profile=${report.analysisProfile}`,
    `Generated: ${text(report.generatedAt)}`,
    `Sample: selected=${report.sample.selected}, excluded=${report.sample.excluded}, attempted=${report.sample.attempted}; source=${report.sample.source}; known-total=${report.sample.knownTotal ?? "unknown"}; unit=${report.sample.knownTotalUnit}`,
    ...Object.entries(report.sample.exclusionReasons).map(([reason, count]) => `Exclusion: ${text(reason)}=${count}`),
    `Summary: detected=${report.summary.detected}, not-detected-within-scope=${report.summary.notDetectedWithinScope}, unknown=${report.summary.unknown}`,
    `Execution: complete=${report.summary.completeWithinScope}, partial=${report.summary.partial}, failed=${report.summary.failed}`,
  ];
  for (const result of report.results) {
    lines.push("", `Repository: ${text(result.repositoryId)}`, `Status: ${result.status} (${result.bucket})`, ...snapshotLines(result),
      `Inventory: discovered=${result.inventory.discoveredFiles}, excluded=${result.inventory.excludedByPolicy}, eligible=${result.inventory.eligibleFiles}, analyzed=${result.inventory.analyzedFiles}, skipped=${result.inventory.failedOrSkippedEligibleFiles}`,
      "Findings:");
    const bindings = new Map(result.bindings.map(binding => [binding.id, binding]));
    if (result.findings.length === 0) lines.push("- none within the reported scope; inspect status and gaps");
    for (const finding of result.findings) {
      const binding = bindings.get(finding.bindingId)!;
      const candidate = binding.attribution.status === "ambiguous" ? "candidate / ambiguous: " : "";
      lines.push(`- ${candidate}${finding.kind} ${location(finding.location)} [${text(finding.id)}]; rule=${text(finding.ruleId)}`,
        ...bindingLines(binding).map(value => `  ${value}`));
      if (finding.snippet !== undefined) lines.push(`  redacted-token-excerpt: ${finding.snippet}`);
    }
    const referenced = new Set(result.findings.map(finding => finding.bindingId));
    for (const binding of result.bindings.filter(value => !referenced.has(value.id))) lines.push(...bindingLines(binding));
    lines.push("Gaps:");
    if (result.gaps.length === 0) lines.push("- none recorded");
    for (const gap of result.gaps) lines.push(`- ${gap.code}${gap.location ? ` at ${location(gap.location)}` : ""}: ${text(gap.message)}; affectsConclusion=${gap.affectsConclusion}`);
  }
  lines.push("", "Limitations:", ...report.limitations.map(value => `- ${text(value)}`));
  if (options.includeSnippets === true) lines.push("- Snippet excerpts omit surrounding source; this bounded redaction policy cannot guarantee detection of every secret.");
  return `${lines.join("\n")}\n`;
}
