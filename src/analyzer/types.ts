import type { AnalysisGap, Binding, Finding } from "../domain/index.js";

/** File-level syntax analysis; repository scope and provenance are integrated later. */
export interface FileAnalysisResult {
  file: string;
  status: "complete-within-scope" | "partial";
  bindings: Binding[];
  findings: Finding[];
  gaps: AnalysisGap[];
}
