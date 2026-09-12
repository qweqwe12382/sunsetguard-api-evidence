import type {
  AnalysisStatus, ApiTarget, AttributionStatus, Binding, Inventory,
  RepositoryBucket, RepositoryTargetResult, ScanReport,
} from "./contracts.js";
import { apiTargetInputSchema, repositoryTargetResultSchema, scanReportSchema } from "./schema.js";

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DomainValidationError(`${name} must be an object`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) throw new DomainValidationError(`${name} must be a non-empty trimmed string`);
  return value;
};
const count = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DomainValidationError(`${name} must be a non-negative safe integer`);
  return value as number;
};
const oneOf = <T extends string>(value: unknown, values: readonly T[], name: string): T => {
  if (typeof value !== "string" || !values.includes(value as T)) throw new DomainValidationError(`${name} is invalid`);
  return value as T;
};
const list = (value: unknown, name: string): unknown[] => {
  if (!Array.isArray(value)) throw new DomainValidationError(`${name} must be an array`);
  return value;
};
const validateLocation = (value: unknown, name: string): void => {
  const location = record(value, name);
  if (typeof location.file !== "string" || location.file.length === 0) throw new DomainValidationError(`${name}.file must be a non-empty string`);
  const path = location.file;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\") || path.split("/").includes("..")) throw new DomainValidationError(`${name}.file must be a safe relative path`);
  for (const positionName of ["start", "end"] as const) {
    const position = record(location[positionName], `${name}.${positionName}`);
    if (!Number.isSafeInteger(position.line) || (position.line as number) < 1 || !Number.isSafeInteger(position.column) || (position.column as number) < 1) {
      throw new DomainValidationError(`${name}.${positionName} must use one-based integer coordinates`);
    }
  }
};

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/;
const EXPORT_NAME = /^(?:[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*)$/u;

export function parseApiTarget(input: unknown): ApiTarget {
  const parsed = apiTargetInputSchema.safeParse(input);
  if (!parsed.success) throw new DomainValidationError(`target.${parsed.error.issues[0]?.path.join(".") || "value"} is invalid`);
  const value = parsed.data as Record<string, unknown>;
  const packageName = text(value.packageName, "packageName");
  if (!PACKAGE_NAME.test(packageName) || packageName.length > 214) throw new DomainValidationError("packageName is not a valid npm package name");
  const moduleSpecifier = own(value, "moduleSpecifier")
    ? text(value.moduleSpecifier, "moduleSpecifier")
    : packageName;
  if (moduleSpecifier !== packageName && !moduleSpecifier.startsWith(`${packageName}/`)) {
    throw new DomainValidationError("moduleSpecifier must be the package root or an explicit subpath of packageName");
  }
  const subpath = moduleSpecifier === packageName ? [] : moduleSpecifier.slice(packageName.length + 1).split("/");
  const unsafeSegment = (segment: string): boolean => segment === "" || segment === "." || segment === ".." ||
    [...segment].some(character => /\s/.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (moduleSpecifier.includes("\\") || subpath.some(unsafeSegment)) {
    throw new DomainValidationError("moduleSpecifier contains an invalid subpath");
  }
  const exportName = text(value.exportName, "exportName");
  if (!EXPORT_NAME.test(exportName)) throw new DomainValidationError("exportName must be a named JavaScript export");
  const id = `${packageName}::${moduleSpecifier}::${exportName}`;
  if (own(value, "id") && text(value.id, "id") !== id) throw new DomainValidationError("id must match packageName, moduleSpecifier, and exportName");

  let deprecation: ApiTarget["deprecation"];
  if (own(value, "deprecation")) {
    const raw = record(value.deprecation, "deprecation");
    if (raw.status !== "user-declared" && raw.status !== "verified") throw new DomainValidationError("deprecation.status is invalid");
    const optionalText = (key: "packageVersion" | "sourceUrl" | "checkedAt") => own(raw, key) ? text(raw[key], `deprecation.${key}`) : undefined;
    const packageVersion = optionalText("packageVersion");
    const sourceUrl = optionalText("sourceUrl");
    const checkedAt = optionalText("checkedAt");
    deprecation = {
      status: raw.status,
      ...(packageVersion ? { packageVersion } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(checkedAt ? { checkedAt } : {}),
    };
    if (raw.status === "verified") {
      if (!packageVersion || !sourceUrl || !checkedAt) throw new DomainValidationError("verified deprecation requires packageVersion, sourceUrl, and checkedAt");
      try { new URL(sourceUrl); } catch { throw new DomainValidationError("deprecation.sourceUrl must be an absolute URL"); }
      if (Number.isNaN(Date.parse(checkedAt))) throw new DomainValidationError("deprecation.checkedAt must be a valid date-time");
    }
  }
  return { id, packageName, moduleSpecifier, exportName, ...(deprecation ? { deprecation } : {}) };
}

function validateInventory(input: unknown): asserts input is Inventory {
  const value = record(input, "inventory") as unknown as Inventory;
  for (const key of ["discoveredFiles", "excludedByPolicy", "eligibleFiles", "analyzedFiles", "failedOrSkippedEligibleFiles"] as const) count(value[key], `inventory.${key}`);
  if (value.eligibleFiles !== value.analyzedFiles + value.failedOrSkippedEligibleFiles) throw new DomainValidationError("inventory eligible file count is inconsistent");
  if (value.discoveredFiles < value.excludedByPolicy + value.eligibleFiles) throw new DomainValidationError("inventory discovered file count is inconsistent");
}

function validateIds(result: RepositoryTargetResult): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const binding of result.bindings) {
    record(binding, "binding");
    text(binding.id, "binding.id");
    validateLocation(binding.location, "binding.location");
    oneOf(binding.form, ["esm-named", "esm-namespace", "esm-reexport", "cjs-namespace", "cjs-destructure"], "binding.form");
    oneOf(binding.importSpace, ["value", "type"], "binding.importSpace");
    const attribution = record(binding.attribution, "binding.attribution");
    oneOf(attribution.status, ["declared-module", "manifest-corroborated", "ambiguous"], "binding.attribution.status");
    list(attribution.reasons, "binding.attribution.reasons").forEach(reason => text(reason, "binding.attribution.reason"));
    if (binding.targetId !== result.targetId) throw new DomainValidationError("binding targetId does not match result targetId");
    if (bindings.has(binding.id)) throw new DomainValidationError(`duplicate binding id: ${binding.id}`);
    bindings.set(binding.id, binding);
  }
  const findings = new Set<string>();
  for (const finding of result.findings) {
    record(finding, "finding");
    text(finding.id, "finding.id");
    validateLocation(finding.location, "finding.location");
    oneOf(finding.kind, ["import-only", "value-reference", "type-reference", "direct-reexport"], "finding.kind");
    text(finding.ruleId, "finding.ruleId");
    if (finding.targetId !== result.targetId) throw new DomainValidationError("finding targetId does not match result targetId");
    if (!bindings.has(finding.bindingId)) throw new DomainValidationError(`finding references unknown binding: ${finding.bindingId}`);
    if (findings.has(finding.id)) throw new DomainValidationError(`duplicate finding id: ${finding.id}`);
    findings.add(finding.id);
  }
  return bindings;
}

export function hasCountableEvidence(result: Pick<RepositoryTargetResult, "bindings" | "findings">): boolean {
  const attribution = new Map<string, AttributionStatus>(result.bindings.map(binding => [binding.id, binding.attribution.status]));
  return result.findings.some(finding => {
    const status = attribution.get(finding.bindingId);
    return status === "declared-module" || status === "manifest-corroborated";
  });
}

export function expectedBucket(result: Pick<RepositoryTargetResult, "status" | "bindings" | "findings" | "gaps">): RepositoryBucket {
  if (hasCountableEvidence(result)) return "detected";
  if (result.status === "complete-within-scope" && !result.gaps.some(gap => gap.affectsConclusion)) return "not-detected-within-scope";
  return "unknown";
}

export function validateRepositoryTargetResult(input: unknown): RepositoryTargetResult {
  const parsed = repositoryTargetResultSchema.safeParse(input);
  if (!parsed.success) throw new DomainValidationError("result has an invalid structure");
  const result = parsed.data as RepositoryTargetResult;
  text(result.repositoryId, "repositoryId");
  text(result.targetId, "targetId");
  oneOf(result.status, ["complete-within-scope", "partial", "failed"], "status");
  oneOf(result.bucket, ["detected", "not-detected-within-scope", "unknown"], "bucket");
  validateInventory(result.inventory);
  list(result.bindings, "bindings");
  list(result.findings, "findings");
  list(result.gaps, "gaps");
  for (const gap of result.gaps) {
    const rawGap = record(gap, "gap");
    oneOf(rawGap.code, ["SOURCE_UNAVAILABLE", "NO_ANALYZABLE_FILES", "FILE_READ_FAILED", "PARSE_FAILED", "RESOURCE_LIMIT", "SYMLINK_SKIPPED", "SNAPSHOT_CHANGED", "UNSUPPORTED_TARGET_PATTERN", "MODULE_ATTRIBUTION_AMBIGUOUS", "CONFIG_UNRESOLVED"], "gap.code");
    text(rawGap.message, "gap.message");
    if (typeof rawGap.affectsConclusion !== "boolean") throw new DomainValidationError("gap.affectsConclusion must be a boolean");
    if (gap.targetId !== undefined && gap.targetId !== result.targetId) throw new DomainValidationError("gap targetId does not match result targetId");
    if (rawGap.location !== undefined) validateLocation(rawGap.location, "gap.location");
  }
  validateIds(result);
  if ((result.inventory.analyzedFiles > 0 || result.findings.length > 0) && result.snapshot === undefined) {
    throw new DomainValidationError("analyzed files and findings require a snapshot identity");
  }
  const kindsByBinding = new Map<string, Set<string>>();
  for (const finding of result.findings) {
    const kinds = kindsByBinding.get(finding.bindingId) ?? new Set<string>();
    kinds.add(finding.kind);
    kindsByBinding.set(finding.bindingId, kinds);
  }
  for (const kinds of kindsByBinding.values()) {
    if (kinds.has("import-only") && kinds.size > 1) throw new DomainValidationError("import-only cannot coexist with another finding kind for the same binding");
  }
  const affectingGap = result.gaps.some(gap => gap.affectsConclusion);
  const noFilesGap = result.gaps.some(gap => gap.code === "NO_ANALYZABLE_FILES" && gap.affectsConclusion);
  if (result.status === "complete-within-scope" && (affectingGap || result.inventory.failedOrSkippedEligibleFiles > 0)) {
    throw new DomainValidationError("complete-within-scope cannot contain a conclusion-affecting gap or skipped eligible file");
  }
  if (result.inventory.analyzedFiles === 0 && result.findings.length === 0 && result.status === "complete-within-scope") {
    throw new DomainValidationError("an empty analysis cannot be complete-within-scope");
  }
  const sourceUnavailable = result.gaps.some(gap => gap.code === "SOURCE_UNAVAILABLE" && gap.affectsConclusion);
  if (result.inventory.eligibleFiles === 0 && !noFilesGap && !(result.status === "failed" && sourceUnavailable)) throw new DomainValidationError("zero eligible files requires NO_ANALYZABLE_FILES, or SOURCE_UNAVAILABLE when acquisition failed");
  if (result.inventory.eligibleFiles === 0 && noFilesGap && (result.status !== "partial" || result.bucket !== "unknown")) throw new DomainValidationError("no analyzable files must be unknown + partial");
  const ambiguousCandidate = result.findings.some(finding => result.bindings.find(binding => binding.id === finding.bindingId)?.attribution.status === "ambiguous");
  if (ambiguousCandidate && (result.status !== "partial" || !affectingGap)) throw new DomainValidationError("ambiguous candidates require partial status and a conclusion-affecting gap");
  if (result.status === "failed" && result.bucket !== "unknown") throw new DomainValidationError("failed results must use the unknown bucket");
  const expected = expectedBucket(result);
  if (result.bucket !== expected) throw new DomainValidationError(`bucket must be ${expected}`);
  return result;
}

const statusKey: Record<AnalysisStatus, keyof ScanReport["summary"]> = {
  "complete-within-scope": "completeWithinScope", partial: "partial", failed: "failed",
};
const bucketKey: Record<RepositoryBucket, keyof ScanReport["summary"]> = {
  detected: "detected", "not-detected-within-scope": "notDetectedWithinScope", unknown: "unknown",
};

export function validateScanReport(input: unknown): ScanReport {
  const parsed = scanReportSchema.safeParse(input);
  if (!parsed.success) throw new DomainValidationError("report has an invalid structure");
  const report = parsed.data as ScanReport;
  if (report.schemaVersion !== "0.1" || report.analysisProfile !== "module-syntax-v1") throw new DomainValidationError("unsupported report contract version or analysis profile");
  oneOf(report.reportKind, ["scan", "synthetic-example"], "reportKind");
  text(report.analyzerVersion, "analyzerVersion");
  text(report.ruleSetVersion, "ruleSetVersion");
  if (typeof report.generatedAt !== "string" || Number.isNaN(Date.parse(report.generatedAt))) throw new DomainValidationError("generatedAt must be a valid date-time");
  const normalizedTarget = parseApiTarget(report.target);
  if (report.target.id !== normalizedTarget.id || report.target.moduleSpecifier !== normalizedTarget.moduleSpecifier) throw new DomainValidationError("report target must contain its canonical id and moduleSpecifier");
  list(report.results, "results");
  list(report.limitations, "limitations").forEach(value => text(value, "limitation"));
  report.results.forEach(validateRepositoryTargetResult);
  if (new Set(report.results.map(result => result.repositoryId)).size !== report.results.length) {
    throw new DomainValidationError("duplicate repositoryId would inflate the sample");
  }
  if (report.results.some(result => result.targetId !== report.target.id)) throw new DomainValidationError("result targetId does not match report target");
  const sample = record(report.sample, "sample") as unknown as ScanReport["sample"];
  const summary = record(report.summary, "summary") as unknown as ScanReport["summary"];
  oneOf(sample.source, ["local", "explicit-list", "provider"], "sample.source");
  oneOf(sample.knownTotalUnit, ["repositories", "unknown"], "sample.knownTotalUnit");
  for (const key of ["selected", "excluded", "attempted"] as const) count(sample[key], `sample.${key}`);
  if (sample.knownTotal !== null) count(sample.knownTotal, "sample.knownTotal");
  if (sample.knownTotal !== null && sample.knownTotalUnit !== "repositories") throw new DomainValidationError("knownTotal requires repositories as its unit");
  const exclusionTotal = Object.values(sample.exclusionReasons).reduce((sum, value) => sum + count(value, "sample.exclusionReasons value"), 0);
  if (exclusionTotal !== sample.excluded) throw new DomainValidationError("exclusionReasons must sum to sample.excluded");
  if (sample.selected !== sample.excluded + sample.attempted || sample.attempted !== report.results.length) throw new DomainValidationError("sample counts are inconsistent");
  const actual = { detected: 0, notDetectedWithinScope: 0, unknown: 0, completeWithinScope: 0, partial: 0, failed: 0 };
  for (const result of report.results) { actual[bucketKey[result.bucket]]++; actual[statusKey[result.status]]++; }
  for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
    count(summary[key], `summary.${key}`);
    if (summary[key] !== actual[key]) throw new DomainValidationError(`summary.${key} does not match results`);
  }
  return report;
}
