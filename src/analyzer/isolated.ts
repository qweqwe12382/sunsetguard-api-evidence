import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";

import { locationSchema, parseApiTarget } from "../domain/index.js";
import type { AnalysisGap, ApiTarget } from "../domain/index.js";
import type { SnapshotFile } from "../snapshots/index.js";
import type { FileAnalysisResult } from "./types.js";
import type { AnalyzeWorkerRequest, AnalyzeWorkerResponse } from "./worker-protocol.js";

const DEFAULT_MAX_OLD_GENERATION_SIZE_MB = 128;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export interface IsolatedAnalyzerOptions {
  signal?: AbortSignal;
  /** V8 old-generation heap limit for the worker; this is not an operating-system RSS limit. */
  maxOldGenerationSizeMb?: number;
}

export interface IsolatedAnalyzer {
  analyze(file: SnapshotFile, target: ApiTarget, timeoutMs: number): Promise<FileAnalysisResult>;
  close(): Promise<void>;
}

function validateOptions(options: IsolatedAnalyzerOptions): number {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "signal" && key !== "maxOldGenerationSizeMb") throw new TypeError("options contains an unknown property");
  }
  if (options.signal !== undefined &&
      (typeof options.signal !== "object" || typeof options.signal.aborted !== "boolean" ||
       typeof options.signal.addEventListener !== "function")) {
    throw new TypeError("signal must be an AbortSignal");
  }
  const memory = options.maxOldGenerationSizeMb ?? DEFAULT_MAX_OLD_GENERATION_SIZE_MB;
  if (!Number.isSafeInteger(memory) || memory < 16 || memory > 4096) {
    throw new TypeError("maxOldGenerationSizeMb must be a safe integer from 16 through 4096");
  }
  return memory;
}

function validateRequest(file: SnapshotFile, inputTarget: ApiTarget, timeoutMs: number): ApiTarget {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive safe integer");
  const target = parseApiTarget(inputTarget);
  if (target.id !== inputTarget.id || target.moduleSpecifier !== inputTarget.moduleSpecifier) {
    throw new TypeError("target must use its canonical identity");
  }
  if (!(file.bytes instanceof Uint8Array)) throw new TypeError("file.bytes must be a Uint8Array");
  if (!/^[a-f0-9]{64}$/i.test(file.contentHash)) throw new TypeError("file.contentHash must be a SHA-256 hex digest");
  locationSchema.parse({ file: file.path, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } });
  return target;
}

function workerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../../dist/analyzer/worker-entry.js", import.meta.url)
    : new URL("./worker-entry.js", import.meta.url);
}

function resourceResult(file: SnapshotFile, target: ApiTarget, message: string): FileAnalysisResult {
  const gap: AnalysisGap = {
    code: "RESOURCE_LIMIT",
    message,
    targetId: target.id,
    affectsConclusion: true,
  };
  return { file: file.path, status: "partial", bindings: [], findings: [], gaps: [gap] };
}

export function createIsolatedAnalyzer(options: IsolatedAnalyzerOptions = {}): IsolatedAnalyzer {
  const maxOldGenerationSizeMb = validateOptions(options);
  let worker: Worker | undefined;
  let nextId = 1;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let retiring: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const isAborted = (): boolean => options.signal?.aborted === true;

  const terminateCurrent = async (): Promise<void> => {
    const current = worker;
    if (current === undefined) {
      await retiring;
      return;
    }
    worker = undefined;
    retiring = current.terminate().then(() => undefined);
    void retiring.catch(() => undefined);
    await retiring;
  };

  const ensureWorker = async (): Promise<Worker> => {
    await retiring;
    if (closed) throw new Error("Isolated analyzer is closed.");
    if (worker !== undefined) return worker;
    const created = new Worker(workerUrl(), {
      resourceLimits: { maxOldGenerationSizeMb },
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    worker = created;
    created.stdout?.resume();
    created.stderr?.resume();
    created.on("error", () => {
      if (worker !== created) return;
      worker = undefined;
      retiring = created.terminate().then(() => undefined);
      void retiring.catch(() => undefined);
    });
    created.on("exit", () => {
      if (worker === created) worker = undefined;
    });
    return created;
  };

  const run = async (file: SnapshotFile, target: ApiTarget, deadline: number): Promise<FileAnalysisResult> => {
    if (closed) {
      await terminateCurrent();
      return resourceResult(file, target, "Isolated analysis was closed before the file was processed.");
    }
    if (isAborted()) {
      await terminateCurrent();
      return resourceResult(file, target, "Isolated analysis was cancelled before the file was processed.");
    }
    let activeWorker: Worker;
    try {
      activeWorker = await ensureWorker();
    } catch {
      return resourceResult(file, target, "A previous analyzer worker could not be confirmed as terminated; this file was not processed.");
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0 || isAborted() || closed) {
      await terminateCurrent();
      const message = closed ? "Isolated analysis was closed before the file was processed."
        : isAborted() ? "Isolated analysis was cancelled before the file was processed."
          : "Isolated analysis exceeded its hard deadline before the file was processed.";
      return resourceResult(file, target, message);
    }
    const id = nextId++;
    const request: AnalyzeWorkerRequest = { type: "analyze", id, file, target };
    return new Promise<FileAnalysisResult>((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        activeWorker.off("message", onMessage);
        activeWorker.off("error", onError);
        activeWorker.off("exit", onExit);
      };
      const finishAfterTermination = (message: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void terminateCurrent().then(
          () => resolve(resourceResult(file, target, message)),
          () => resolve(resourceResult(file, target,
            "Analyzer worker termination could not be confirmed; reuse remains blocked.")),
        );
      };
      const onMessage = (response: AnalyzeWorkerResponse): void => {
        if (settled || response.id !== id) return;
        if (performance.now() >= deadline) {
          finishAfterTermination("Isolated analysis exceeded its hard deadline and the worker was terminated.");
          return;
        }
        if (response.type === "failure") {
          finishAfterTermination("The isolated analyzer worker failed and was terminated before reuse.");
          return;
        }
        settled = true;
        cleanup();
        resolve(response.result);
      };
      const onError = (): void => finishAfterTermination("The isolated analyzer worker failed and was terminated before reuse.");
      const onExit = (): void => finishAfterTermination("The isolated analyzer worker exited before returning a trustworthy result.");
      const onAbort = (): void => finishAfterTermination("Isolated analysis was cancelled and the worker was terminated.");
      const timer = setTimeout(
        () => finishAfterTermination("Isolated analysis exceeded its hard deadline and the worker was terminated."),
        Math.max(1, Math.ceil(remainingMs)),
      );
      activeWorker.on("message", onMessage);
      activeWorker.once("error", onError);
      activeWorker.once("exit", onExit);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (isAborted()) {
        onAbort();
        return;
      }
      try {
        activeWorker.postMessage(request);
      } catch {
        finishAfterTermination("The isolated analyzer request could not be transferred safely.");
      }
    });
  };

  return {
    analyze(file, inputTarget, timeoutMs) {
      if (closed) return Promise.reject(new Error("Isolated analyzer is closed."));
      const target = validateRequest(file, inputTarget, timeoutMs);
      if (file.bytes.byteLength > MAX_SOURCE_BYTES) {
        return Promise.resolve(resourceResult(file, target, "Source bytes exceed the isolated analyzer file-size limit."));
      }
      const deadline = performance.now() + timeoutMs;
      const task = queue.then(() => run(file, target, deadline));
      queue = task.then(() => undefined, () => undefined);
      return task;
    },
    close() {
      if (closing !== undefined) return closing;
      closed = true;
      closing = (async () => {
        const termination = terminateCurrent();
        await Promise.all([termination, queue]);
      })();
      return closing;
    },
  };
}
