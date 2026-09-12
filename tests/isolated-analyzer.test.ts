import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createIsolatedAnalyzer, type IsolatedAnalyzer } from "../src/analyzer/isolated.js";
import { parseApiTarget } from "../src/domain/index.js";
import type { SnapshotFile } from "../src/snapshots/index.js";

const target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
const analyzers: IsolatedAnalyzer[] = [];

function sourceFile(source: string): SnapshotFile {
  const bytes = Buffer.from(source);
  return { path: "src/input.ts", bytes, contentHash: createHash("sha256").update(bytes).digest("hex") };
}

function observeWorkerLifecycle() {
  const dispatched = vi.spyOn(Worker.prototype, "postMessage");
  const originalTerminate = Worker.prototype.terminate;
  const terminations: { worker: Worker; initialThreadId: number; exited: boolean }[] = [];
  const terminate = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
    const observation = { worker: this, initialThreadId: this.threadId, exited: false };
    terminations.push(observation);
    this.once("exit", () => { observation.exited = true; });
    return originalTerminate.call(this);
  });
  return { dispatched, terminations, restore: () => { dispatched.mockRestore(); terminate.mockRestore(); } };
}

/** Select the scheduling branch using only analyze's initial deadline read and
 * run's pre-dispatch read. The worker, timers and subsequent clock reads are real.
 */
function controlInitialDeadlineReads(beforeDispatchOffset: number) {
  const start = performance.now();
  let reads = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => {
    const value = reads++ === 0 ? start : start + beforeDispatchOffset;
    if (reads === 2) clock.mockRestore();
    return value;
  });
  return { reads: () => reads, restore: () => clock.mockRestore() };
}

afterEach(async () => Promise.all(analyzers.splice(0).map(analyzer => analyzer.close())));

describe("createIsolatedAnalyzer", () => {
  it("analyzes sequential files in the fixed tool worker", async () => {
    const analyzer = createIsolatedAnalyzer();
    analyzers.push(analyzer);
    const first = await analyzer.analyze(sourceFile('import { oldApi } from "pkg"; oldApi();'), target, 5_000);
    const second = await analyzer.analyze(sourceFile("export const unrelated = 1;"), target, 5_000);
    expect(first).toMatchObject({ status: "complete-within-scope", findings: [{ kind: "value-reference" }] });
    expect(second).toMatchObject({ status: "complete-within-scope", findings: [] });
  });

  it("enforces a real timer deadline after dispatch, waits for termination, and rebuilds safely", async () => {
    const analyzer = createIsolatedAnalyzer();
    analyzers.push(analyzer);
    const lifecycle = observeWorkerLifecycle();
    const clock = controlInitialDeadlineReads(0);
    let parentTimerFired = false;
    let timerObservedDispatchedWorker = false;
    const parentTimer = setTimeout(() => {
      parentTimerFired = true;
      const dispatchedWorker = lifecycle.dispatched.mock.contexts[0] as Worker | undefined;
      timerObservedDispatchedWorker = (dispatchedWorker?.threadId ?? -1) > 0;
    }, 0);
    try {
      const timedOut = await analyzer.analyze(sourceFile("export const value = 1;"), target, 1);
      expect(clock.reads()).toBe(2);
      expect(lifecycle.dispatched).toHaveBeenCalledTimes(1);
      expect(lifecycle.dispatched.mock.calls[0]?.[0]).toMatchObject({ type: "analyze" });
      expect(parentTimerFired).toBe(true);
      expect(timerObservedDispatchedWorker).toBe(true);
      expect(timedOut).toMatchObject({ status: "partial", gaps: [{ code: "RESOURCE_LIMIT" }] });
      expect(timedOut.gaps[0]!.message).toContain("terminated");
      expect(lifecycle.terminations).toHaveLength(1);
      const retired = lifecycle.terminations[0]!;
      expect(retired.initialThreadId).toBeGreaterThan(0);
      expect(retired.exited).toBe(true);
      expect(retired.worker.threadId).toBe(-1);

      const recovered = await analyzer.analyze(sourceFile('import { oldApi } from "pkg"; oldApi();'), target, 5_000);
      expect(recovered.findings.map(finding => finding.kind)).toEqual(["value-reference"]);
      expect(lifecycle.dispatched).toHaveBeenCalledTimes(2);
      const replacement = lifecycle.dispatched.mock.contexts[1] as Worker;
      expect(replacement).not.toBe(retired.worker);
      expect(replacement.threadId).toBeGreaterThan(0);
    } finally {
      clearTimeout(parentTimer);
      clock.restore();
      lifecycle.restore();
    }
  });

  it("reports a deadline exhausted before dispatch and can rebuild afterward", async () => {
    const analyzer = createIsolatedAnalyzer();
    analyzers.push(analyzer);
    const lifecycle = observeWorkerLifecycle();
    const clock = controlInitialDeadlineReads(2);
    try {
      const timedOut = await analyzer.analyze(sourceFile("export const value = 1;"), target, 1);
      expect(clock.reads()).toBe(2);
      expect(lifecycle.dispatched).not.toHaveBeenCalled();
      expect(timedOut).toMatchObject({ status: "partial", findings: [], bindings: [], gaps: [{ code: "RESOURCE_LIMIT" }] });
      expect(timedOut.gaps[0]?.message).toBe("Isolated analysis exceeded its hard deadline before the file was processed.");
      expect(lifecycle.terminations).toHaveLength(1);
      const retired = lifecycle.terminations[0]!;
      expect(retired.initialThreadId).toBeGreaterThan(0);
      expect(retired.exited).toBe(true);
      expect(retired.worker.threadId).toBe(-1);

      const recovered = await analyzer.analyze(sourceFile('import { oldApi } from "pkg"; oldApi();'), target, 5_000);
      expect(recovered.findings.map(finding => finding.kind)).toEqual(["value-reference"]);
      expect(lifecycle.dispatched).toHaveBeenCalledTimes(1);
      const replacement = lifecycle.dispatched.mock.contexts[0] as Worker;
      expect(replacement).not.toBe(retired.worker);
      expect(replacement.threadId).toBeGreaterThan(0);
    } finally {
      clock.restore();
      lifecycle.restore();
    }
  });

  it("terminates on cancellation and does not accept work after close", async () => {
    const controller = new AbortController();
    const analyzer = createIsolatedAnalyzer({ signal: controller.signal });
    analyzers.push(analyzer);
    controller.abort();
    const cancelled = await analyzer.analyze(sourceFile("export const value = 1;"), target, 5_000);
    expect(cancelled).toMatchObject({ status: "partial", gaps: [{ code: "RESOURCE_LIMIT" }] });
    expect(cancelled.gaps[0]!.message).toContain("cancelled");
    await analyzer.close();
    await expect(analyzer.analyze(sourceFile("export {};"), target, 5_000)).rejects.toThrow("closed");
  });

  it("does not start queued work after close begins", async () => {
    const analyzer = createIsolatedAnalyzer();
    analyzers.push(analyzer);
    const first = analyzer.analyze(sourceFile("export const first = 1;"), target, 5_000);
    const queued = analyzer.analyze(sourceFile("export const second = 2;"), target, 5_000);
    const closing = analyzer.close();
    const [firstResult, queuedResult] = await Promise.all([first, queued]);
    await closing;
    expect(firstResult.gaps[0]?.code).toBe("RESOURCE_LIMIT");
    expect(queuedResult.gaps[0]?.code).toBe("RESOURCE_LIMIT");
    expect(queuedResult.gaps[0]?.message).toContain("closed");
  });

  it("rejects oversized input before transfer to the worker", async () => {
    const analyzer = createIsolatedAnalyzer();
    analyzers.push(analyzer);
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
    const file: SnapshotFile = { path: "src/large.ts", bytes, contentHash: createHash("sha256").update(bytes).digest("hex") };
    const result = await analyzer.analyze(file, target, 5_000);
    expect(result).toMatchObject({ status: "partial", gaps: [{ code: "RESOURCE_LIMIT" }] });
    expect(result.gaps[0]!.message).toContain("file-size");
  });

  it("replaces an excessive evidence result before structured-clone transfer", async () => {
    const analyzer = createIsolatedAnalyzer({ maxOldGenerationSizeMb: 256 });
    analyzers.push(analyzer);
    const source = 'import { oldApi } from "pkg";\n' + "oldApi;\n".repeat(50_001);
    const result = await analyzer.analyze(sourceFile(source), target, 8_000);
    expect(result).toMatchObject({ status: "partial", bindings: [], findings: [], gaps: [{ code: "RESOURCE_LIMIT" }] });
    expect(result.gaps[0]!.message).toContain("evidence-result");
  });

  it("turns a real constrained-V8 worker failure into a sanitized resource gap", async () => {
    const analyzer = createIsolatedAnalyzer({ maxOldGenerationSizeMb: 16 });
    analyzers.push(analyzer);
    let source = "";
    for (let index = 0; index < 80_000; index += 1) source += `const value${index}=${index};`;
    const result = await analyzer.analyze(sourceFile(source), target, 5_000);
    expect(result).toMatchObject({ status: "partial", gaps: [{ code: "RESOURCE_LIMIT" }] });
    expect(result.gaps[0]!.message).toContain("worker failed");
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:\\|\/Users\//);
  });

  it("validates limits without accepting a caller-controlled worker path", () => {
    expect(() => createIsolatedAnalyzer({ maxOldGenerationSizeMb: 15 })).toThrow("maxOldGenerationSizeMb");
    expect(() => createIsolatedAnalyzer({ workerPath: "downstream.js" } as never)).toThrow("unknown property");
  });
});
