import { performance } from "node:perf_hooks";
import { parseApiTarget, validateScanReport } from "../domain/index.js";
import type { ApiTarget, RepositoryTargetResult, ScanReport } from "../domain/index.js";
import { RULE_SET_VERSION, ANALYSIS_PROFILE } from "../analyzer/index.js";
import { scanLocal, ANALYZER_VERSION } from "./local.js";
import { scanGitHub } from "./github.js";
import type { GitHubScanOptions } from "./github.js";
import { CONSUMERS_LIMITS, isPreparedConsumersPlan, type ConsumersPlan } from "./consumers.js";
import { CacheStore } from "../cache/index.js";

export const BATCH_POLICY_VERSION = "0.1.0-t10";
export const BATCH_LIMITS = Object.freeze({ timeoutMs: 600_000, maxReportBytes: 48 * 1024 * 1024 });
export type BatchLimits = { -readonly [Key in keyof typeof BATCH_LIMITS]: number };
export interface BatchScanOptions extends Pick<GitHubScanOptions, "cache" | "offline" | "includeSnippets" | "tokenEnvironment" | "signal"> {
  limits?: Partial<BatchLimits>;
}

function unavailable(repositoryId: string, targetId: string, message: string): RepositoryTargetResult {
  return { repositoryId, targetId, status: "failed", bucket: "unknown",
    inventory: { discoveredFiles: 0, excludedByPolicy: 0, eligibleFiles: 0, analyzedFiles: 0, failedOrSkippedEligibleFiles: 0 },
    bindings: [], findings: [], gaps: [{ code: "SOURCE_UNAVAILABLE", message, targetId, affectsConclusion: true }] };
}

/** Execute a plan produced by readConsumers. Input paths stay in the plan, never in the report. */
export async function scanConsumers(plan: ConsumersPlan, targetValue: ApiTarget, options: BatchScanOptions = {}): Promise<ScanReport> {
  const target = parseApiTarget(targetValue);
  if (!isPreparedConsumersPlan(plan)) throw new TypeError("A plan returned by readConsumers is required.");
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
      (options.cache !== undefined && !(options.cache instanceof CacheStore)) ||
      (options.offline !== undefined && typeof options.offline !== "boolean") ||
      (options.includeSnippets !== undefined && typeof options.includeSnippets !== "boolean") ||
      (options.tokenEnvironment !== undefined && options.tokenEnvironment !== "SUNSETGUARD_GITHUB_TOKEN") ||
      (options.limits !== undefined && (options.limits === null || typeof options.limits !== "object" || Array.isArray(options.limits)))) throw new TypeError("Invalid batch options.");
  await options.cache?.assertOutsideRoots([plan.manifestPath, ...plan.entries.flatMap(entry => entry.kind === "local" ? [entry.path] : [])]);
  const limits = { ...BATCH_LIMITS, ...options.limits };
  if (Object.keys(options).some(key => !["cache", "offline", "includeSnippets", "tokenEnvironment", "signal", "limits"].includes(key)) ||
      Object.keys(options.limits ?? {}).some(key => !Object.hasOwn(BATCH_LIMITS, key)) ||
      Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value <= 0 || value > BATCH_LIMITS[key as keyof typeof BATCH_LIMITS])) throw new TypeError("Invalid batch limits or options.");
  const started = performance.now(), deadline = started + limits.timeoutMs;
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const results: RepositoryTargetResult[] = [];
  const limitations = new Set<string>([
    "The sample is the explicitly supplied consumers list, with normalized duplicates excluded. No star threshold or ecosystem discovery was applied.",
    "knownTotal counts unique repository identities in this input list only; it is not an ecosystem total.",
    "Local identities hash canonical input paths and are separate from GitHub identities; matching bytes do not merge independent sources.",
    "Not detected within this scope does not mean migrated, globally unused, or safe to remove.",
    `batchPolicy=${JSON.stringify({ version: BATCH_POLICY_VERSION, limits, consumers: CONSUMERS_LIMITS, concurrency: 1 })}`,
  ]);
  let reportBytes = 0, overflow = false;
  for (const entry of plan.entries) {
    if (signal.aborted || performance.now() >= deadline || overflow) {
      results.push(unavailable(entry.repositoryId, target.id, overflow ? "The batch report budget was exhausted before this input could be included." : "The batch was cancelled or its total deadline expired before this input was scanned."));
      continue;
    }
    let child: ScanReport;
    try {
      child = entry.kind === "local"
        ? await scanLocal(entry.path, target, { signal, ...(options.includeSnippets === undefined ? {} : { includeSnippets: options.includeSnippets }) })
        : await scanGitHub({ repository: entry.repository, ref: entry.ref }, target, { signal,
          ...(options.cache === undefined ? {} : { cache: options.cache }), ...(options.offline === undefined ? {} : { offline: options.offline }),
          ...(options.includeSnippets === undefined ? {} : { includeSnippets: options.includeSnippets }),
          ...(options.tokenEnvironment === undefined ? {} : { tokenEnvironment: options.tokenEnvironment }),
        });
      child = validateScanReport(child);
      if (child.results.length !== 1 || child.target.id !== target.id || child.analyzerVersion !== ANALYZER_VERSION || child.ruleSetVersion !== RULE_SET_VERSION || child.analysisProfile !== ANALYSIS_PROFILE) throw new Error("Incompatible child report");
    } catch {
      results.push(unavailable(entry.repositoryId, target.id, "This input could not produce a validated report; other repository results were retained."));
      continue;
    }
    const result = child.results[0]!;
    result.repositoryId = entry.repositoryId;
    // Reserve bounded terminal diagnostics for every not-yet-included input.
    const bytes = Buffer.byteLength(JSON.stringify({ result, limitations: child.limitations }));
    if (reportBytes + bytes > limits.maxReportBytes) {
      overflow = true;
      results.push(unavailable(entry.repositoryId, target.id, "This repository report exceeded the remaining aggregate report budget and was omitted as a unit."));
      continue;
    }
    reportBytes += bytes;
    results.push(result);
    for (const line of child.limitations) limitations.add(line);
    if (entry.kind === "github") limitations.add(`Requested source: ${entry.repositoryId}; ref=${entry.ref}.`);
  }
  if (overflow) limitations.add("The aggregate report budget was exceeded. At most 50 mandatory unavailable-input diagnostics and fixed metadata are reserved beyond that budget.");
  const summary: ScanReport["summary"] = { detected: 0, notDetectedWithinScope: 0, unknown: 0, completeWithinScope: 0, partial: 0, failed: 0 };
  for (const result of results) {
    summary[result.bucket === "not-detected-within-scope" ? "notDetectedWithinScope" : result.bucket]++;
    summary[result.status === "complete-within-scope" ? "completeWithinScope" : result.status]++;
  }
  return validateScanReport({ schemaVersion: "0.1", reportKind: "scan", analyzerVersion: ANALYZER_VERSION, ruleSetVersion: RULE_SET_VERSION,
    analysisProfile: ANALYSIS_PROFILE, generatedAt: new Date().toISOString(), target, limitations: [...limitations],
    sample: { source: "explicit-list", selected: plan.selected, excluded: plan.duplicates, attempted: results.length,
      knownTotal: plan.entries.length, knownTotalUnit: "repositories", exclusionReasons: plan.duplicates === 0 ? {} : { "duplicate-input": plan.duplicates } },
    summary, results });
}
