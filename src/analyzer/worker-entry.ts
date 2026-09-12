import { parentPort } from "node:worker_threads";

import { analyzeFile } from "./analyze.js";
import { MAX_WORKER_EVIDENCE_ITEMS, MAX_WORKER_RESULT_BYTES } from "./worker-protocol.js";
import type { AnalyzeWorkerRequest, AnalyzeWorkerResponse } from "./worker-protocol.js";

if (parentPort === null) throw new Error("Analyzer worker requires a parent port.");
const port = parentPort;

port.on("message", (message: AnalyzeWorkerRequest) => {
  let response: AnalyzeWorkerResponse;
  try {
    let result = analyzeFile(message.file, message.target);
    const evidenceItems = result.bindings.length + result.findings.length + result.gaps.length;
    const exceedsResultLimit = evidenceItems > MAX_WORKER_EVIDENCE_ITEMS ||
      Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_WORKER_RESULT_BYTES;
    if (exceedsResultLimit) {
      result = {
        file: message.file.path,
        status: "partial",
        bindings: [],
        findings: [],
        gaps: [{
          code: "RESOURCE_LIMIT",
          message: "Isolated analysis exceeded its evidence-result resource limit.",
          targetId: message.target.id,
          affectsConclusion: true,
        }],
      };
    }
    response = { type: "result", id: message.id, result };
  } catch {
    // Do not serialize exception messages: they can contain untrusted source text or host paths.
    response = { type: "failure", id: message.id };
  }
  port.postMessage(response);
});
