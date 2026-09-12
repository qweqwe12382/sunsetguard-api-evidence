import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { ATTRIBUTION_LIMITS, ATTRIBUTION_VERSION, createAttributionContext } from "../attribution/index.js";
import { ANALYSIS_PROFILE, RULE_SET_VERSION, createIsolatedAnalyzer } from "../analyzer/index.js";
import { expectedBucket, locationSchema, parseApiTarget, validateScanReport } from "../domain/index.js";
import type { AnalysisGap, ApiTarget, Binding, Finding, Inventory, RepositoryTargetResult, ScanReport } from "../domain/index.js";
import { captureLocalSnapshot } from "../snapshots/index.js";
import type { LocalSnapshotOptions, SnapshotFile } from "../snapshots/index.js";
import { createSnippetBuilder, SNIPPET_POLICY_VERSION } from "../reports/snippets.js";

export const ANALYZER_VERSION = "0.1.0-t10.1";
export const DEFAULT_ANALYSIS_LIMITS = Object.freeze({ maxEvidenceItems: 100_000, maxEvidenceBytes: 32 * 1024 * 1024, maxOldGenerationSizeMb: 128 });
export interface AnalysisLimits { maxEvidenceItems: number; maxEvidenceBytes: number; maxOldGenerationSizeMb: number }
export interface LocalScanOptions extends LocalSnapshotOptions { analysisLimits?: Partial<AnalysisLimits>; includeSnippets?: boolean }

function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value as number;
}
function parseOptions(options: LocalScanOptions): { snapshot: LocalSnapshotOptions; analysis: AnalysisLimits } {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("options must be an object");
  const allowed = new Set(["limits", "excludeDirectories", "signal", "analysisLimits", "includeSnippets"]);
  if (Object.keys(options).some(key => !allowed.has(key))) throw new TypeError("options contains an unknown property");
  if (options.includeSnippets !== undefined && typeof options.includeSnippets !== "boolean") throw new TypeError("includeSnippets must be a boolean");
  const supplied = options.analysisLimits ?? {};
  if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)) throw new TypeError("analysisLimits must be an object");
  const keys = ["maxEvidenceItems", "maxEvidenceBytes", "maxOldGenerationSizeMb"] as const;
  if (Object.keys(supplied).some(key => !keys.includes(key as keyof AnalysisLimits))) throw new TypeError("analysisLimits contains an unknown property");
  const analysis = { ...DEFAULT_ANALYSIS_LIMITS, ...supplied };
  for (const key of keys) positive(analysis[key], `analysisLimits.${key}`);
  if (analysis.maxEvidenceItems > DEFAULT_ANALYSIS_LIMITS.maxEvidenceItems || analysis.maxEvidenceBytes > DEFAULT_ANALYSIS_LIMITS.maxEvidenceBytes || analysis.maxOldGenerationSizeMb > DEFAULT_ANALYSIS_LIMITS.maxOldGenerationSizeMb) throw new TypeError("analysis limits may only lower the defaults");
  if (analysis.maxOldGenerationSizeMb < 16) throw new TypeError("analysisLimits.maxOldGenerationSizeMb must be at least 16");
  return { analysis, snapshot: {
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.excludeDirectories === undefined ? {} : { excludeDirectories: options.excludeDirectories }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  } };
}
function resourceGap(message: string, targetId: string): AnalysisGap { return { code: "RESOURCE_LIMIT", message, targetId, affectsConclusion: true }; }
function interruption(signal: AbortSignal | undefined, deadline: number): "cancelled" | "timeout" | undefined { return signal?.aborted === true ? "cancelled" : performance.now() >= deadline ? "timeout" : undefined; }
function interruptionGap(reason: "cancelled" | "timeout", targetId: string): AnalysisGap { return resourceGap(reason === "cancelled" ? "Local scan analysis was cancelled." : "Local scan exceeded its total time budget.", targetId); }
function serializedBytes(values: readonly unknown[]): number { return values.reduce<number>((sum, value) => sum + Buffer.byteLength(JSON.stringify(value), "utf8"), 0); }
function combinedHash(...values: readonly string[]): string { const hash = createHash("sha256"); for (const value of values) hash.update(String(Buffer.byteLength(value, "utf8"))).update(":").update(value).update(";"); return hash.digest("hex"); }
function sameRoot(left: BigIntStats, right: BigIntStats): boolean { return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino; }
function boundedInitialGaps(values: readonly AnalysisGap[], limits: AnalysisLimits, targetId: string): { gaps: AnalysisGap[]; overflow: boolean } {
  const terminal = resourceGap("Initial snapshot or configuration evidence exceeded the aggregate budget; remaining evidence and files were omitted.", targetId);
  const terminalBytes = serializedBytes([terminal]);
  const gaps: AnalysisGap[] = [];
  let bytes = 0;
  let overflow = false;
  for (const gap of values) {
    const mandatory = gap.code === "SOURCE_UNAVAILABLE" || gap.code === "NO_ANALYZABLE_FILES";
    const gapBytes = serializedBytes([gap]);
    if (mandatory || (gaps.length + 1 + 1 <= limits.maxEvidenceItems && bytes + gapBytes + terminalBytes <= limits.maxEvidenceBytes)) {
      gaps.push(gap);
      bytes += gapBytes;
    } else overflow = true;
  }
  if (overflow) gaps.push(terminal);
  return { gaps, overflow };
}
function summaryFor(result: RepositoryTargetResult): ScanReport["summary"] { return {
  detected: result.bucket === "detected" ? 1 : 0, notDetectedWithinScope: result.bucket === "not-detected-within-scope" ? 1 : 0, unknown: result.bucket === "unknown" ? 1 : 0,
  completeWithinScope: result.status === "complete-within-scope" ? 1 : 0, partial: result.status === "partial" ? 1 : 0, failed: result.status === "failed" ? 1 : 0,
}; }

export async function scanLocal(rootPath: string, inputTarget: ApiTarget, options: LocalScanOptions = {}): Promise<ScanReport> {
  const startedAt = performance.now();
  const target = parseApiTarget(inputTarget);
  const parsed = parseOptions(options);
  let scanRoot = rootPath;
  let rootIdentity: BigIntStats | undefined;
  try {
    scanRoot = await realpath(resolve(rootPath));
    rootIdentity = await lstat(scanRoot, { bigint: true });
  } catch { /* captureLocalSnapshot returns the structured SOURCE_UNAVAILABLE result. */ }
  const acquisition = await captureLocalSnapshot(scanRoot, parsed.snapshot);
  const deadline = startedAt + acquisition.scope.limits.timeoutMs;
  const validFiles: SnapshotFile[] = [];
  const initialGaps = [...acquisition.gaps];
  let failedFiles = 0;
  for (const file of acquisition.files) {
    if (locationSchema.safeParse({ file: file.path, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }).success) validFiles.push(file);
    else { failedFiles += 1; initialGaps.push({ code: "FILE_READ_FAILED", message: "A captured source path cannot be represented and was excluded before configuration inspection.", targetId: target.id, affectsConclusion: true }); }
  }

  let attribution: Awaited<ReturnType<typeof createAttributionContext>>;
  try {
    attribution = await createAttributionContext(scanRoot, target, validFiles, { ...(parsed.snapshot.signal === undefined ? {} : { signal: parsed.snapshot.signal }), timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) });
    initialGaps.push(...attribution.gaps);
  } catch {
    const unresolved: AnalysisGap = { code: "CONFIG_UNRESOLVED", message: "Module attribution context could not be created safely.", targetId: target.id, affectsConclusion: true };
    initialGaps.push(unresolved);
    attribution = { contentHash: combinedHash("unresolved", ATTRIBUTION_VERSION), gaps: [unresolved], apply: (_path, bindings) => ({
      bindings: bindings.map(binding => ({ ...binding, attribution: { status: "ambiguous" as const, reasons: ["attribution unavailable"] } })),
      gaps: bindings.length === 0 ? [] : [{ code: "MODULE_ATTRIBUTION_AMBIGUOUS", message: "Module source attribution is unavailable.", targetId: target.id, affectsConclusion: true }],
    }) };
  }
  if (rootIdentity !== undefined) {
    let changed = false;
    try { changed = !sameRoot(rootIdentity, await lstat(scanRoot, { bigint: true })); } catch { changed = true; }
    if (changed) {
      const changedGap: AnalysisGap = { code: "SNAPSHOT_CHANGED", message: "The canonical source root changed between snapshot and attribution capture.", targetId: target.id, affectsConclusion: true };
      initialGaps.push(changedGap);
      const prior = attribution;
      attribution = { contentHash: prior.contentHash, gaps: [...prior.gaps, changedGap], apply: (path, sourceBindings) => {
        const applied = prior.apply(path, sourceBindings);
        return { bindings: applied.bindings.map(binding => ({ ...binding, attribution: { status: "ambiguous" as const, reasons: ["source root changed between capture phases"] } })),
          gaps: [...applied.gaps, ...(sourceBindings.length === 0 ? [] : [{ code: "MODULE_ATTRIBUTION_AMBIGUOUS" as const, message: "Source root identity changed before attribution could be trusted.", targetId: target.id, affectsConclusion: true }])] };
      } };
    }
  }

  const bounded = boundedInitialGaps(initialGaps, parsed.analysis, target.id);
  const gaps = bounded.gaps;
  const bindings: Binding[] = [];
  const findings: Finding[] = [];
  let analyzedFiles = 0;
  let evidenceItems = gaps.length;
  let evidenceBytes = serializedBytes(gaps);
  let stopped = bounded.overflow;
  if (bounded.overflow) failedFiles += validFiles.length;
  if (!bounded.overflow && acquisition.status !== "failed" && validFiles.length > 0) {
    const terminalBudgetGap = resourceGap("Analysis evidence exceeded the aggregate budget; this file and remaining files were omitted atomically.", target.id);
    const terminalBudgetBytes = serializedBytes([terminalBudgetGap]);
    const worker = createIsolatedAnalyzer({ ...(parsed.snapshot.signal === undefined ? {} : { signal: parsed.snapshot.signal }), maxOldGenerationSizeMb: parsed.analysis.maxOldGenerationSizeMb });
    try {
      for (let index = 0; index < validFiles.length; index += 1) {
        await yieldImmediate();
        const reason = interruption(parsed.snapshot.signal, deadline);
        if (reason !== undefined) { failedFiles += validFiles.length - index; gaps.push(interruptionGap(reason, target.id)); stopped = true; break; }
        const file = validFiles[index]!;
        const analysis = await worker.analyze(file, target, Math.max(1, Math.ceil(deadline - performance.now())));
        let attributed: ReturnType<typeof attribution.apply>;
        try { attributed = attribution.apply(file.path, analysis.bindings); }
        catch { attributed = {
          bindings: analysis.bindings.map(binding => ({ ...binding, attribution: { status: "ambiguous" as const, reasons: ["file attribution failed"] } })),
          gaps: [{ code: analysis.bindings.length === 0 ? "CONFIG_UNRESOLVED" : "MODULE_ATTRIBUTION_AMBIGUOUS", message: "File attribution failed safely.", targetId: target.id, affectsConclusion: true }],
        }; }
        const fileGaps = [...analysis.gaps, ...attributed.gaps];
        const snippet = options.includeSnippets === true ? createSnippetBuilder(file.bytes) : undefined;
        const localNames = new Map(attributed.bindings.map(binding => [binding.id, binding.localName]));
        const fileFindings = snippet === undefined ? analysis.findings : analysis.findings.map(finding => ({ ...finding,
          ...snippet(finding.location, [target.exportName, localNames.get(finding.bindingId) ?? target.exportName]),
        }));
        const items = [...attributed.bindings, ...fileFindings, ...fileGaps];
        const nextItems = evidenceItems + items.length;
        const nextBytes = evidenceBytes + serializedBytes(items);
        if (nextItems + 1 > parsed.analysis.maxEvidenceItems || nextBytes + terminalBudgetBytes > parsed.analysis.maxEvidenceBytes) {
          failedFiles += validFiles.length - index; gaps.push(terminalBudgetGap); stopped = true; break;
        }
        bindings.push(...attributed.bindings); findings.push(...fileFindings); gaps.push(...fileGaps);
        evidenceItems = nextItems; evidenceBytes = nextBytes;
        if (analysis.gaps.some(value => value.code === "PARSE_FAILED" || value.code === "RESOURCE_LIMIT")) failedFiles += 1; else analyzedFiles += 1;
      }
      await yieldImmediate();
      const finalReason = interruption(parsed.snapshot.signal, deadline);
      if (!stopped && finalReason !== undefined) gaps.push(interruptionGap(finalReason, target.id));
    } finally { await worker.close(); }
  }

  const inventory: Inventory = { discoveredFiles: acquisition.inventory.discoveredFiles, excludedByPolicy: acquisition.inventory.excludedByPolicy, eligibleFiles: acquisition.inventory.eligibleFiles,
    analyzedFiles, failedOrSkippedEligibleFiles: acquisition.inventory.failedOrSkippedEligibleFiles + failedFiles };
  const sourceFailed = acquisition.status === "failed";
  if (!sourceFailed && inventory.eligibleFiles === 0 && !gaps.some(value => value.code === "NO_ANALYZABLE_FILES")) gaps.push({ code: "NO_ANALYZABLE_FILES", message: "No analyzable source files were available within the captured scope.", targetId: target.id, affectsConclusion: true });
  const analysisPolicy = { limits: parsed.analysis, mandatoryDiagnosticReserve: "At most three mandatory source/empty/resource diagnostics can exceed a lowered evidence budget.", analyzerVersion: ANALYZER_VERSION, ruleSetVersion: RULE_SET_VERSION,
    snippets: { enabled: options.includeSnippets === true, policyVersion: SNIPPET_POLICY_VERSION } };
  const attributionPolicy = { limits: ATTRIBUTION_LIMITS, version: ATTRIBUTION_VERSION };
  const snapshot = acquisition.snapshot === undefined ? undefined : { ...acquisition.snapshot,
    contentHash: combinedHash(acquisition.snapshot.contentHash, attribution.contentHash), sourceId: combinedHash(acquisition.snapshot.contentHash, attribution.contentHash),
    scopeHash: combinedHash(acquisition.snapshot.scopeHash, JSON.stringify(analysisPolicy), JSON.stringify(attributionPolicy)) };
  const status: RepositoryTargetResult["status"] = sourceFailed ? "failed" : gaps.some(value => value.affectsConclusion) || inventory.failedOrSkippedEligibleFiles > 0 ? "partial" : "complete-within-scope";
  const base = { repositoryId: "local:single", targetId: target.id, ...(snapshot === undefined ? {} : { snapshot }), status, inventory, bindings, findings, gaps };
  const result: RepositoryTargetResult = { ...base, bucket: expectedBucket(base) };
  const report: ScanReport = {
    schemaVersion: "0.1", reportKind: "scan", analyzerVersion: ANALYZER_VERSION, ruleSetVersion: RULE_SET_VERSION, analysisProfile: ANALYSIS_PROFILE, generatedAt: new Date().toISOString(), target,
    limitations: [`snapshotScope=${JSON.stringify(acquisition.scope)}`, `analysisPolicy=${JSON.stringify(analysisPolicy)}`, `attributionPolicy=${JSON.stringify(attributionPolicy)}`,
      "Module attribution uses bounded local configuration evidence and does not prove runtime package resolution.", "Only captured source bytes are analyzed; downstream code and configuration are not executed.",
      "Per-file AST work uses a terminating worker deadline; aggregate evidence limits are item and serialized-byte budgets, not an RSS guarantee.",
      "Workspace checks use root selectors and manifests encountered alongside captured source files; exact and single-star selectors are supported, not full workspace or dependency resolution.",
      "Snapshot filesystem I/O observes cancellation and time cooperatively between bounded operations; it is not an OS-level hard interruption.",
      "Path identity checks detect observed changes but do not provide an atomic filesystem transaction against concurrent directory replacement.",
      "Inventory counts are bounded observations, not totals for entries not enumerated after a limit or cancellation.",
      "The local sourceId identifies captured source and attribution bytes; it is not a stable repository identity across scans.",
      options.includeSnippets === true ? "Source snippets were explicitly enabled: only the matched token is retained, with surrounding source redacted and bounded. This is not general secret detection; identifiers and evidence paths remain visible." : "Source snippets are disabled and are not included in reports.",
      "Not detected within this scope does not mean migrated, globally unused, or safe to remove."],
    sample: { source: "local", selected: 1, excluded: 0, attempted: 1, knownTotal: 1, knownTotalUnit: "repositories", exclusionReasons: {} }, summary: summaryFor(result), results: [result],
  };
  return validateScanReport(report);
}
