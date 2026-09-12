import type { ApiTarget } from "../domain/index.js";
import type { SnapshotFile } from "../snapshots/index.js";
import type { FileAnalysisResult } from "./types.js";

export const MAX_WORKER_EVIDENCE_ITEMS = 50_000;
export const MAX_WORKER_RESULT_BYTES = 16 * 1024 * 1024;

export interface AnalyzeWorkerRequest {
  type: "analyze";
  id: number;
  file: SnapshotFile;
  target: ApiTarget;
}

export type AnalyzeWorkerResponse = {
  type: "result";
  id: number;
  result: FileAnalysisResult;
} | {
  type: "failure";
  id: number;
};
