import type { AnalysisGap, AnalysisStatus, Snapshot } from "../domain/index.js";

export interface SnapshotLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxEntries: number;
  maxDepth: number;
  timeoutMs: number;
}

export interface SnapshotScope {
  extensions: readonly string[];
  excludedDirectories: readonly string[];
  excludedSuffixes: readonly string[];
  directoryCaseSensitive: boolean;
  followSymlinks: false;
  respectGitignore: false;
  limits: SnapshotLimits;
}

export interface LocalSnapshotOptions {
  limits?: Partial<SnapshotLimits>;
  /** Additional directory basenames to exclude. Default exclusions remain active. */
  excludeDirectories?: readonly string[];
  signal?: AbortSignal;
}

export interface SnapshotFile {
  /** Exact relative path using forward slashes. */
  path: string;
  bytes: Uint8Array;
  contentHash: string;
}

export interface SnapshotInventory {
  discoveredFiles: number;
  excludedByPolicy: number;
  eligibleFiles: number;
  readFiles: number;
  failedOrSkippedEligibleFiles: number;
  excludedDirectories: number;
  observedEntries: number;
}

/** Acquisition status only; never a repository reference-analysis result. */
export interface LocalSnapshotResult {
  phase: "snapshot";
  status: AnalysisStatus;
  snapshot?: Snapshot;
  scope: SnapshotScope;
  inventory: SnapshotInventory;
  files: SnapshotFile[];
  gaps: AnalysisGap[];
}
