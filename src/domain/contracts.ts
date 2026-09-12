export type AnalysisStatus = "complete-within-scope" | "partial" | "failed";
export type RepositoryBucket = "detected" | "not-detected-within-scope" | "unknown";
export type FindingKind = "import-only" | "value-reference" | "type-reference" | "direct-reexport";
export type AttributionStatus = "declared-module" | "manifest-corroborated" | "ambiguous";

export interface ApiTarget {
  id: string;
  packageName: string;
  moduleSpecifier: string;
  exportName: string;
  deprecation?: {
    status: "user-declared" | "verified";
    packageVersion?: string;
    sourceUrl?: string;
    checkedAt?: string;
  };
}
export interface Position { line: number; column: number }
export interface Location { file: string; start: Position; end: Position }
export interface Snapshot {
  kind: "local" | "git";
  sourceId: string;
  contentHash: string;
  scopeHash: string;
  gitCommit?: string;
  dirty?: boolean;
}

export interface Binding {
  id: string;
  targetId: string;
  location: Location;
  localName?: string;
  form: "esm-named" | "esm-namespace" | "esm-reexport" | "cjs-namespace" | "cjs-destructure";
  importSpace: "value" | "type";
  attribution: {
    status: AttributionStatus;
    reasons: string[];
    manifestFile?: string;
    declaredRange?: string;
    dependencyKind?: "dependency" | "devDependency" | "peerDependency" | "optionalDependency" | "unknown";
    resolvedVersion?: string;
  };
}

export interface Finding {
  id: string;
  targetId: string;
  bindingId: string;
  kind: FindingKind;
  location: Location;
  ruleId: string;
  snippet?: string;
  snippetRedacted?: boolean;
}

export type GapCode =
  | "SOURCE_UNAVAILABLE" | "NO_ANALYZABLE_FILES" | "FILE_READ_FAILED" | "PARSE_FAILED"
  | "RESOURCE_LIMIT" | "SYMLINK_SKIPPED" | "SNAPSHOT_CHANGED" | "UNSUPPORTED_TARGET_PATTERN"
  | "MODULE_ATTRIBUTION_AMBIGUOUS" | "CONFIG_UNRESOLVED";

export interface AnalysisGap {
  code: GapCode;
  message: string;
  targetId?: string;
  location?: Location;
  affectsConclusion: boolean;
}

export interface Inventory {
  discoveredFiles: number;
  excludedByPolicy: number;
  eligibleFiles: number;
  analyzedFiles: number;
  failedOrSkippedEligibleFiles: number;
}

export interface RepositoryTargetResult {
  repositoryId: string;
  targetId: string;
  snapshot?: Snapshot;
  status: AnalysisStatus;
  bucket: RepositoryBucket;
  inventory: Inventory;
  bindings: Binding[];
  findings: Finding[];
  gaps: AnalysisGap[];
}

export interface ScanReport {
  schemaVersion: "0.1";
  reportKind: "scan" | "synthetic-example";
  analyzerVersion: string;
  ruleSetVersion: string;
  analysisProfile: "module-syntax-v1";
  generatedAt: string;
  target: ApiTarget;
  limitations: string[];
  sample: {
    source: "local" | "explicit-list" | "provider";
    selected: number;
    excluded: number;
    attempted: number;
    knownTotal: number | null;
    knownTotalUnit: "repositories" | "unknown";
    exclusionReasons: Record<string, number>;
  };
  summary: {
    detected: number;
    notDetectedWithinScope: number;
    unknown: number;
    completeWithinScope: number;
    partial: number;
    failed: number;
  };
  results: RepositoryTargetResult[];
}
