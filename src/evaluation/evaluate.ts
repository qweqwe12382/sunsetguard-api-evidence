import { locationSchema, parseApiTarget, validateScanReport } from "../domain/index.js";
import type { AnalysisGap, AttributionStatus, Finding, GapCode, Location, ScanReport } from "../domain/index.js";
import type { EvaluationDataset, EvaluationLabel, EvaluationObservation, EvaluationResult, FindingLabel, RatioCounts } from "./contracts.js";

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) throw new TypeError(`${name} must be a non-empty trimmed string`);
  return value;
};
const hash = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  return value;
};
const location = (value: unknown, name: string): Location => {
  const parsed = locationSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${name} must be a valid source location`);
  return parsed.data;
};
const locationKey = (value: Location): string => `${value.file}:${value.start.line}:${value.start.column}:${value.end.line}:${value.end.column}`;
const ratio = (tp: number, fp: number, fn: number): RatioCounts => ({ tp, fp, fn,
  precision: tp + fp === 0 ? null : tp / (tp + fp), recall: tp + fn === 0 ? null : tp / (tp + fn) });
const attribution = (finding: Finding, report: ScanReport): AttributionStatus | undefined =>
  report.results[0]?.bindings.find(binding => binding.id === finding.bindingId)?.attribution.status;
const beforeOrEqual = (left: Location["start"], right: Location["start"]): boolean => left.line < right.line || (left.line === right.line && left.column <= right.column);
const gapMatches = (gap: AnalysisGap, label: EvaluationLabel): boolean => {
  if (!gap.affectsConclusion || label.expected !== "unknown" || !label.expectedGapCodes.includes(gap.code)) return false;
  if (gap.location === undefined) return label.location === undefined;
  if (gap.location.file !== label.file) return false;
  if (label.location === undefined) return true;
  return beforeOrEqual(gap.location.start, label.location.start) && beforeOrEqual(label.location.end, gap.location.end);
};
const gapCodes = new Set<GapCode>(["SOURCE_UNAVAILABLE", "NO_ANALYZABLE_FILES", "FILE_READ_FAILED", "PARSE_FAILED", "RESOURCE_LIMIT", "SYMLINK_SKIPPED", "SNAPSHOT_CHANGED", "UNSUPPORTED_TARGET_PATTERN", "MODULE_ATTRIBUTION_AMBIGUOUS", "CONFIG_UNRESOLVED"]);

function validateDataset(input: EvaluationDataset): EvaluationDataset {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("evaluation dataset must be an object");
  if (input.schemaVersion !== "0.1" || input.analysisProfile !== "module-syntax-v1" || !["provisional", "human-reviewed"].includes(input.reviewStatus)) throw new TypeError("evaluation dataset metadata is invalid");
  const target = parseApiTarget(input.target);
  text(input.snapshot?.snapshotId, "snapshotId"); hash(input.snapshot?.contentHash, "contentHash");
  hash(input.snapshot?.scopeHash, "scopeHash"); text(input.analyzerVersion, "analyzerVersion");
  text(input.snapshot?.reportIdentity?.repositoryId, "report repositoryId"); text(input.snapshot?.reportIdentity?.sourceId, "report sourceId");
  text(input.ruleSetVersion, "ruleSetVersion");
  if (!Array.isArray(input.files) || input.files.length === 0) throw new TypeError("evaluation requires a non-empty reviewed file scope");
  const files = new Set<string>(), labels = new Set<string>(), labelUnits = new Set<string>();
  for (const file of input.files) {
    location({ file: file.file, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }, "reviewed file path");
    if (files.has(file.file)) throw new TypeError("reviewed file paths must be unique");
    files.add(file.file); hash(file.sha256, "reviewed file sha256");
    if (typeof file.exhaustive !== "boolean" || !Array.isArray(file.labels)) throw new TypeError("reviewed file contract is invalid");
    for (const label of file.labels) {
      text(label.id, "label id");
      if (labels.has(label.id)) throw new TypeError("label ids must be unique");
      labels.add(label.id);
      if (label.file !== file.file) throw new TypeError("label file must match its reviewed file");
      if (label.location !== undefined && location(label.location, "label location").file !== file.file) throw new TypeError("label location must match its reviewed file");
      if (label.expected === "finding") {
        location(label.bindingLocation, "binding location");
        if (label.bindingLocation.file !== file.file || label.location === undefined) throw new TypeError("finding labels require locations in their reviewed file");
        if (!["import-only", "value-reference", "type-reference", "direct-reexport"].includes(label.kind) || !["declared-module", "manifest-corroborated", "ambiguous"].includes(label.attribution)) throw new TypeError("finding label is invalid");
      } else if (label.expected === "unknown") {
        if (!Array.isArray(label.expectedGapCodes) || label.expectedGapCodes.length === 0 || new Set(label.expectedGapCodes).size !== label.expectedGapCodes.length || !label.expectedGapCodes.every(code => gapCodes.has(code))) throw new TypeError("unknown labels require unique valid expected gap codes");
      } else if (label.expected !== "negative") throw new TypeError("label expectation is invalid");
      const unit = label.expected === "finding" ? `${label.expected}|${label.file}|${locationKey(label.location)}|${label.kind}|${locationKey(label.bindingLocation)}` :
        `${label.expected}|${label.file}|${label.location === undefined ? "file" : locationKey(label.location)}`;
      if (labelUnits.has(unit)) throw new TypeError("evaluation label units must be unique");
      labelUnits.add(unit);
    }
  }
  if (input.expectedRepository !== undefined &&
      (!["detected", "not-detected-within-scope", "unknown"].includes(input.expectedRepository.bucket) ||
       !["complete-within-scope", "partial", "failed"].includes(input.expectedRepository.status) ||
       (input.expectedRepository.bucket === "not-detected-within-scope" && input.expectedRepository.status !== "complete-within-scope") ||
       (input.expectedRepository.bucket === "unknown" && input.expectedRepository.status === "complete-within-scope"))) throw new TypeError("expected repository classification is invalid");
  return { ...input, target };
}

export function evaluateScan(datasetInput: EvaluationDataset, reportInput: ScanReport | undefined, observation: EvaluationObservation): EvaluationResult {
  const dataset = validateDataset(datasetInput);
  if (observation === null || typeof observation !== "object" || observation.snapshotId !== dataset.snapshot.snapshotId || !Array.isArray(observation.files)) throw new TypeError("observed snapshot identity and file hashes must be provided");
  const observed = new Map<string, string>();
  for (const file of observation.files) {
    location({ file: file.file, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }, "observed file path");
    if (observed.has(file.file)) throw new TypeError("observed file paths must be unique");
    observed.set(file.file, hash(file.sha256, "observed file sha256"));
  }
  if (observed.size !== dataset.files.length || dataset.files.some(file => observed.get(file.file) !== file.sha256)) throw new TypeError("observed file hashes do not match the fixed evaluation scope");
  const report = reportInput === undefined ? undefined : validateScanReport(reportInput);
  if (report !== undefined) {
    if (report.target.id !== dataset.target.id || report.ruleSetVersion !== dataset.ruleSetVersion || report.analyzerVersion !== dataset.analyzerVersion || report.analysisProfile !== dataset.analysisProfile) throw new TypeError("report and evaluation identity do not match");
    if (report.results.length !== 1 || report.results[0]?.repositoryId !== dataset.snapshot.reportIdentity.repositoryId ||
        report.results[0].snapshot?.sourceId !== dataset.snapshot.reportIdentity.sourceId || report.results[0].snapshot.contentHash !== dataset.snapshot.contentHash || report.results[0].snapshot.scopeHash !== dataset.snapshot.scopeHash) {
      throw new TypeError("report snapshot does not match the evaluation dataset");
    }
  }
  const fileMap = new Map(dataset.files.map(file => [file.file, file]));
  const predictions = report?.results[0]?.findings ?? [];
  for (const prediction of predictions) if (!fileMap.has(prediction.location.file)) throw new TypeError("report contains predictions outside the reviewed file scope");
  const used = new Set<string>();
  let tp = 0, fn = 0, confirmedTp = 0, confirmedFp = 0, confirmedFn = 0, attributionCorrect = 0, attributionIncorrect = 0, attributionUnassessable = 0;
  let candidateMatched = 0, candidateMissed = 0, candidateUnexpected = 0, negativeTn = 0, negativeFp = 0, negativeUnassessable = 0, unknownMatched = 0, unknownMissing = 0, unknownMisclassifiedClean = 0;
  const findings = dataset.files.flatMap(file => file.labels).filter((label): label is FindingLabel => label.expected === "finding");
  for (const expected of findings) {
    const matchIndex = predictions.findIndex((prediction, index) => !used.has(String(index)) && prediction.kind === expected.kind && locationKey(prediction.location) === locationKey(expected.location!) && (() => {
      const binding = report?.results[0]?.bindings.find(value => value.id === prediction.bindingId);
      return binding !== undefined && locationKey(binding.location) === locationKey(expected.bindingLocation);
    })());
    if (matchIndex < 0) { fn += 1; if (expected.attribution === "ambiguous") candidateMissed += 1; else confirmedFn += 1; continue; }
    used.add(String(matchIndex)); tp += 1;
    const actual = report === undefined ? undefined : attribution(predictions[matchIndex]!, report);
    if (expected.attribution === "ambiguous") {
      if (actual === "ambiguous") candidateMatched += 1;
      else { candidateMissed += 1; confirmedFp += 1; }
    } else if (actual === "ambiguous") { confirmedFn += 1; candidateUnexpected += 1; }
    else confirmedTp += 1;
    if (actual === undefined) attributionUnassessable += 1;
    else if (actual === expected.attribution) attributionCorrect += 1;
    else attributionIncorrect += 1;
  }
  let fp = 0, excludedPredictions = 0;
  predictions.forEach((prediction, index) => {
    if (used.has(String(index))) return;
    const reviewed = fileMap.get(prediction.location.file);
    const explicitlyReviewed = reviewed?.labels.some(label => label.location === undefined
      ? label.expected === "negative"
      : locationKey(label.location) === locationKey(prediction.location)) === true;
    if (reviewed?.exhaustive !== true && !explicitlyReviewed) { excludedPredictions += 1; return; }
    fp += 1;
    if (report !== undefined && attribution(prediction, report) === "ambiguous") candidateUnexpected += 1;
    else confirmedFp += 1;
  });
  const result = report?.results[0];
  for (const label of dataset.files.flatMap(file => file.labels)) {
    if (label.expected === "negative") {
      const hit = predictions.some(prediction => prediction.location.file === label.file && (label.location === undefined || locationKey(prediction.location) === locationKey(label.location)));
      if (hit) negativeFp += 1; else negativeTn += 1;
      const unresolved = result === undefined || result.status !== "complete-within-scope" || result.gaps.some(gap => gap.affectsConclusion && (gap.location === undefined || gap.location.file === label.file));
      if (!hit && unresolved) { negativeTn -= 1; negativeUnassessable += 1; }
    } else if (label.expected === "unknown") {
      const hit = label.expectedGapCodes.every(code => result?.gaps.some(gap => gap.code === code && gapMatches(gap, label)) === true);
      if (hit) unknownMatched += 1;
      else { unknownMissing += 1; if (result?.bucket === "not-detected-within-scope" && result.status === "complete-within-scope") unknownMisclassifiedClean += 1; }
    }
  }
  const actualRepository = result === undefined ? null : { bucket: result.bucket, status: result.status };
  const expectedRepository = dataset.expectedRepository ?? null;
  return {
    reviewStatus: dataset.reviewStatus, provisional: dataset.reviewStatus !== "human-reviewed",
    notice: dataset.reviewStatus === "human-reviewed" ? "Metrics use a human-reviewed fixed evaluation set." : "Provisional metrics are not human-confirmed accuracy claims.",
    token: ratio(tp, fp, fn), confirmed: ratio(confirmedTp, confirmedFp, confirmedFn),
    ambiguousCandidates: { matched: candidateMatched, unexpected: candidateUnexpected, missed: candidateMissed },
    attribution: { correct: attributionCorrect, incorrect: attributionIncorrect, unassessable: attributionUnassessable },
    negatives: { trueNegative: negativeTn, falsePositive: negativeFp, unassessable: negativeUnassessable, unknownMisclassifiedClean }, unknown: { matched: unknownMatched, missing: unknownMissing },
    repository: { expected: expectedRepository, actual: actualRepository, bucketMatch: expectedRepository === null || actualRepository === null ? null : expectedRepository.bucket === actualRepository.bucket,
      statusMatch: expectedRepository === null || actualRepository === null ? null : expectedRepository.status === actualRepository.status },
    scope: { reviewedFiles: dataset.files.length, exhaustiveFiles: dataset.files.filter(file => file.exhaustive).length, excludedPredictions },
  };
}
