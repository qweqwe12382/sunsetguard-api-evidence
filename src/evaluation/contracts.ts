import type { AnalysisStatus, ApiTarget, AttributionStatus, FindingKind, GapCode, Location, RepositoryBucket } from "../domain/index.js";

export interface EvaluationSnapshot {
  snapshotId: string;
  contentHash: string;
  scopeHash: string;
  reportIdentity: { repositoryId: string; sourceId: string };
}
export interface ObservedFileHash { file: string; sha256: string }
export interface EvaluationObservation { snapshotId: string; files: ObservedFileHash[] }
export interface ReviewedFile {
  file: string;
  sha256: string;
  exhaustive: boolean;
  labels: EvaluationLabel[];
}
interface LabelBase { id: string; file: string; location?: Location }
export interface FindingLabel extends LabelBase {
  expected: "finding";
  location: Location;
  kind: FindingKind;
  bindingLocation: Location;
  attribution: AttributionStatus;
}
export interface NegativeLabel extends LabelBase { expected: "negative" }
export interface UnknownLabel extends LabelBase { expected: "unknown"; expectedGapCodes: GapCode[] }
export type EvaluationLabel = FindingLabel | NegativeLabel | UnknownLabel;

export interface EvaluationDataset {
  schemaVersion: "0.1";
  target: ApiTarget;
  snapshot: EvaluationSnapshot;
  ruleSetVersion: string;
  analyzerVersion: string;
  analysisProfile: "module-syntax-v1";
  reviewStatus: "provisional" | "human-reviewed";
  files: ReviewedFile[];
  expectedRepository?: { bucket: RepositoryBucket; status: AnalysisStatus };
}

export interface RatioCounts { tp: number; fp: number; fn: number; precision: number | null; recall: number | null }
export interface EvaluationResult {
  reviewStatus: EvaluationDataset["reviewStatus"];
  provisional: boolean;
  notice: string;
  token: RatioCounts;
  confirmed: RatioCounts;
  ambiguousCandidates: { matched: number; unexpected: number; missed: number };
  attribution: { correct: number; incorrect: number; unassessable: number };
  negatives: { trueNegative: number; falsePositive: number; unassessable: number; unknownMisclassifiedClean: number };
  unknown: { matched: number; missing: number };
  repository: { expected: EvaluationDataset["expectedRepository"] | null; actual: EvaluationDataset["expectedRepository"] | null; bucketMatch: boolean | null; statusMatch: boolean | null };
  scope: { reviewedFiles: number; exhaustiveFiles: number; excludedPredictions: number };
}
