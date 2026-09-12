import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parseApiTarget, validateScanReport, expectedBucket } from "../domain/index.js";
import type { ApiTarget, ScanReport } from "../domain/index.js";
import { RULE_SET_VERSION, ANALYSIS_PROFILE } from "../analyzer/index.js";
import { fetchGitHubSnapshot } from "../remote/snapshot.js";
import { normalizeGitHubInput, remoteLimits, failure, REMOTE_POLICY_VERSION } from "../remote/policy.js";
import type { GitHubInput, RemoteOptions, RemoteFailure } from "../remote/policy.js";
import { verifyExtractedFiles } from "../remote/verify-files.js";
import type { GitHubSnapshot } from "../remote/snapshot.js";
import { CacheStore, CacheError, canCacheAnalysis, snapshotCacheHash } from "../cache/index.js";
import type { AnalysisCacheIdentity } from "../cache/index.js";
import { ATTRIBUTION_LIMITS, ATTRIBUTION_VERSION } from "../attribution/index.js";
import { DEFAULT_SNAPSHOT_LIMITS, DEFAULT_EXCLUDED_DIRECTORIES, DECLARATION_SUFFIXES, SNAPSHOT_EXTENSIONS } from "../snapshots/index.js";
import { SNIPPET_POLICY_VERSION } from "../reports/snippets.js";
import { scanLocal, ANALYZER_VERSION, DEFAULT_ANALYSIS_LIMITS } from "./local.js";

export interface GitHubScanOptions extends RemoteOptions { cache?: CacheStore; offline?: boolean; includeSnippets?: boolean }
const CACHE_FALLBACK = "Cache reuse was unavailable or rejected after boundary, integrity or capacity validation; cache data do not establish a complete scan.";
function parseOptions(options: GitHubScanOptions): RemoteOptions {
  if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["cache", "offline", "includeSnippets", "signal", "limits", "tokenEnvironment"].includes(key))) throw new TypeError("Unknown GitHub scan option.");
  if ((options.cache !== undefined && !(options.cache instanceof CacheStore)) || (options.offline !== undefined && typeof options.offline !== "boolean") || (options.includeSnippets !== undefined && typeof options.includeSnippets !== "boolean")) throw new TypeError("Invalid GitHub scan option.");
  return { ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.limits === undefined ? {} : { limits: options.limits }), ...(options.tokenEnvironment === undefined ? {} : { tokenEnvironment: options.tokenEnvironment }) };
}

function failedReport(input: GitHubInput, target: ApiTarget, failed: RemoteFailure): ScanReport {
  return validateScanReport({ schemaVersion: "0.1", reportKind: "scan", analyzerVersion: ANALYZER_VERSION, ruleSetVersion: RULE_SET_VERSION,
    analysisProfile: ANALYSIS_PROFILE, generatedAt: new Date().toISOString(), target,
    limitations: ["Remote acquisition failed; this result is unknown and is not evidence of non-use.", "No downstream code, scripts, dependencies, or configurations were executed."],
    sample: { source: "explicit-list", selected: 1, excluded: 0, attempted: 1, knownTotal: 1, knownTotalUnit: "repositories", exclusionReasons: {} },
    summary: { detected: 0, notDetectedWithinScope: 0, unknown: 1, completeWithinScope: 0, partial: 0, failed: 1 },
    results: [{ repositoryId: `github:${input.repository}`, targetId: target.id, status: "failed", bucket: "unknown",
      inventory: { discoveredFiles: 0, excludedByPolicy: 0, eligibleFiles: 0, analyzedFiles: 0, failedOrSkippedEligibleFiles: 0 }, bindings: [], findings: [],
      gaps: [{ code: "SOURCE_UNAVAILABLE", message: `${failed.code}: ${failed.message}${failed.httpStatus === undefined ? "" : ` HTTP ${failed.httpStatus}.`}`, targetId: target.id, affectsConclusion: true }] }],
  });
}

/** One explicit public repository; offline mode only reads a verified full-SHA cache. */
export async function scanGitHub(inputValue: GitHubInput, targetValue: ApiTarget, options: GitHubScanOptions = {}): Promise<ScanReport> {
  const remoteOptions = parseOptions(options);
  const input = normalizeGitHubInput(inputValue), target = parseApiTarget(targetValue), limits = remoteLimits(remoteOptions);
  const deadline = performance.now() + limits.timeoutMs;
  const io = { deadline, ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const notes = new Set<string>(); let snapshot: GitHubSnapshot | undefined, snapshotHash: string | undefined;
  const offlineFailure = () => {
    const report = failedReport(input, target, { status: "failed", code: "IO_ERROR", message: "Offline mode requires a verified cached snapshot for an explicit full commit SHA; no network request or credential read was made." });
    report.limitations.push(...notes); return validateScanReport(report);
  };
  const fullCommit = /^[a-f0-9]{40}$/.test(input.ref);
  if (options.offline && (!fullCommit || options.cache === undefined)) return offlineFailure();
  if (fullCommit && options.cache !== undefined) {
    try { const cached = await options.cache.getSnapshot(input, limits, io); if (cached !== undefined) { snapshot = cached.snapshot; snapshotHash = cached.snapshotHash; notes.add("Snapshot cache hit: original files were checked with SHA-256 and Git blob hashes, then materialized into a new private temporary directory."); } }
    catch { notes.add(CACHE_FALLBACK); }
  }
  if (snapshot === undefined) {
    if (options.offline) return offlineFailure();
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return failedReport(input, target, { status: "failed", code: "TIMEOUT", message: "Snapshot cache lookup exhausted the remote scan deadline before acquisition." });
    const acquired = await fetchGitHubSnapshot(input, { ...remoteOptions, limits: { ...limits, timeoutMs: remaining } });
    if (acquired.status === "failed") { const report = failedReport(input, target, acquired); report.limitations.push(...notes); return report; }
    snapshot = acquired; snapshotHash = snapshotCacheHash(snapshot);
    if (options.cache !== undefined) {
      try { await options.cache.putSnapshot(snapshot, limits, io); }
      catch { notes.add(CACHE_FALLBACK); }
    }
  }
  const identity: AnalysisCacheIdentity = { repository: input.repository, commit: snapshot.commit, snapshotHash: snapshotHash!, target,
    analyzerVersion: ANALYZER_VERSION, ruleSetVersion: RULE_SET_VERSION, analysisProfile: ANALYSIS_PROFILE, remotePolicy: REMOTE_POLICY_VERSION, snippetPolicy: SNIPPET_POLICY_VERSION, includeSnippets: options.includeSnippets ?? false,
    scopePolicy: JSON.stringify({ remoteLimits: limits,
      snapshotScope: { extensions: SNAPSHOT_EXTENSIONS, excludedDirectories: [...DEFAULT_EXCLUDED_DIRECTORIES].sort(), excludedSuffixes: DECLARATION_SUFFIXES,
        directoryCaseSensitive: process.platform !== "win32", followSymlinks: false, respectGitignore: false, limits: { ...DEFAULT_SNAPSHOT_LIMITS, timeoutMs: limits.timeoutMs } },
      analysisPolicy: { limits: DEFAULT_ANALYSIS_LIMITS, mandatoryDiagnosticReserve: "At most three mandatory source/empty/resource diagnostics can exceed a lowered evidence budget.", analyzerVersion: ANALYZER_VERSION, ruleSetVersion: RULE_SET_VERSION,
        snippets: { enabled: options.includeSnippets === true, policyVersion: SNIPPET_POLICY_VERSION } },
      attributionPolicy: { limits: ATTRIBUTION_LIMITS, version: ATTRIBUTION_VERSION } }) };
  let report: ScanReport | undefined;
  let analysisHit = false, disposed = false;
  try {
    await verifyExtractedFiles(snapshot.directory, snapshot.files, deadline, options.signal);
    if (options.cache !== undefined) {
      try { report = await options.cache.getAnalysis(identity, io); analysisHit = report !== undefined; }
      catch { notes.add(CACHE_FALLBACK); }
    }
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    const deadlineSignal = AbortSignal.timeout(remaining);
    report ??= await scanLocal(snapshot.directory, target, { limits: { timeoutMs: limits.timeoutMs }, signal: options.signal === undefined ? deadlineSignal : AbortSignal.any([options.signal, deadlineSignal]), includeSnippets: options.includeSnippets ?? false });
    const result = report.results[0]!;
    result.repositoryId = `github:${input.repository}`;
    report.sample.source = "explicit-list";
    await verifyExtractedFiles(snapshot.directory, snapshot.files, deadline, options.signal);
    if (!analysisHit && result.snapshot !== undefined) {
      result.snapshot = { ...result.snapshot, kind: "git", gitCommit: snapshot.commit, sourceId: `github:${input.repository}@${snapshot.commit}`,
        scopeHash: createHash("sha256").update(JSON.stringify({ localScope: result.snapshot.scopeHash, remotePolicy: REMOTE_POLICY_VERSION, limits })).digest("hex") };
    }
    if (!analysisHit) {
      report.limitations = report.limitations.filter(line => !line.startsWith("The local sourceId"));
      report.limitations.push(`remotePolicy=${JSON.stringify({ version: REMOTE_POLICY_VERSION, limits, treeSha: snapshot.treeSha, archiveSha256: snapshot.archiveSha256, verifiedFiles: snapshot.files.length })}`,
      `Fixed source permalink base: https://github.com/${input.repository}/blob/${snapshot.commit}/`,
      "All archived files were checked against the selected commit tree's Git blob hashes. Local read boundaries still do not provide an atomic filesystem transaction.");
    }
    report = validateScanReport(report);
  } catch (error) {
    const failed = failure(error);
    if (report === undefined) report = failedReport(input, target, failed);
    else {
      const result = report.results[0]!;
      result.status = "partial";
      if (analysisHit) {
        if (result.snapshot !== undefined) result.snapshot = { kind: "local", sourceId: result.snapshot.contentHash, contentHash: result.snapshot.contentHash, scopeHash: result.snapshot.scopeHash };
        report.limitations = report.limitations.filter(line => !line.startsWith("Fixed source permalink base:"));
      }
      const changed = failed.code === "SOURCE_CHANGED";
      if (changed) result.bindings = result.bindings.map(binding => ({ ...binding, attribution: { status: "ambiguous", reasons: ["Extracted source changed after acquisition."] } }));
      result.gaps.push({ code: changed ? "SNAPSHOT_CHANGED" : "RESOURCE_LIMIT", message: failed.message, targetId: target.id, affectsConclusion: true });
      if (changed && result.bindings.length > 0) result.gaps.push({ code: "MODULE_ATTRIBUTION_AMBIGUOUS", message: "Changed extracted bytes cannot retain confirmed GitHub attribution.", targetId: target.id, affectsConclusion: true });
      result.bucket = expectedBucket(result);
      report.summary = { detected: Number(result.bucket === "detected"), notDetectedWithinScope: 0, unknown: Number(result.bucket === "unknown"), completeWithinScope: 0, partial: 1, failed: 0 };
      report.limitations.push("Post-scan commit verification was incomplete; retained evidence has a local content snapshot, without a verified Git permalink.");
      report = validateScanReport(report);
    }
  }
  try { await snapshot.dispose(); disposed = true; } catch (error) {
    const result = report.results[0]!;
    result.gaps.push({ code: "SOURCE_UNAVAILABLE", message: error instanceof CacheError ? "Private cached snapshot cleanup could not be confirmed." : failure(error).message, targetId: target.id, affectsConclusion: true });
    if (result.status !== "failed") { result.status = "partial"; result.bucket = expectedBucket(result); report.summary.completeWithinScope = 0; report.summary.partial = 1; report.summary.notDetectedWithinScope = 0; report.summary.unknown = Number(result.bucket === "unknown"); }
  }
  if (disposed && !analysisHit && canCacheAnalysis(report) && options.cache !== undefined) {
    try { await options.cache.putAnalysis(identity, report, io); }
    catch { notes.add(CACHE_FALLBACK); }
  }
  report.limitations.push(...notes);
  if (options.cache !== undefined) report.limitations.push("The private local cache checks content integrity and identity consistency; it does not authenticate data against an owner who rewrites both bytes and all metadata hashes.");
  return validateScanReport(report);
}
