import type { WorkerOptions } from "node:worker_threads";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface BusyHandshake {
  exited: boolean;
  initialThreadId: number;
  worker: { threadId: number } | undefined;
  busy: Int32Array<SharedArrayBuffer>;
  ready: Promise<void>;
  markReady: () => void;
  busyMessageSeen: boolean;
}

const state = vi.hoisted(() => ({ handshake: undefined as BusyHandshake | undefined }));

vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class BusyWorker extends actual.Worker {
    constructor(_filename: string | URL, options?: WorkerOptions) {
      const handshake = state.handshake;
      if (handshake === undefined) throw new Error("The busy worker handshake was not prepared for this test.");
      const markReady = handshake.markReady;
      super(new URL("./busy-worker.mjs", import.meta.url), { ...options, workerData: { busy: handshake.busy.buffer } });
      handshake.worker = this;
      handshake.initialThreadId = this.threadId;
      this.once("message", (message: unknown) => {
        if (message !== "busy" || Atomics.load(handshake.busy, 0) !== 1) return;
        handshake.busyMessageSeen = true;
        markReady();
      });
      this.once("exit", () => { handshake.exited = true; });
    }
  }
  return { ...actual, Worker: BusyWorker };
});

import { createHash } from "node:crypto";
import { createIsolatedAnalyzer, type IsolatedAnalyzer } from "../../src/analyzer/isolated.js";
import { parseApiTarget } from "../../src/domain/index.js";
import type { FileAnalysisResult } from "../../src/analyzer/types.js";

const target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
const bytes = Buffer.from("export const value = 1;");
const file = { path: "src/input.ts", bytes, contentHash: createHash("sha256").update(bytes).digest("hex") };
const analyzers: IsolatedAnalyzer[] = [];

beforeEach(() => {
  let markReady = (): void => undefined;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  state.handshake = {
    exited: false, initialThreadId: -1, worker: undefined,
    busy: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    ready, markReady, busyMessageSeen: false,
  };
});

afterEach(async () => Promise.all(analyzers.splice(0).map(analyzer => analyzer.close())));

async function waitUntilBusy(handshake: BusyHandshake, pending: Promise<FileAnalysisResult>): Promise<void> {
  // analyze() creates its Worker asynchronously. Never read a handshake that
  // gets replaced by that constructor, and never wait forever after a deadline
  // has already terminated a worker that did not reach its busy loop.
  const outcome = await Promise.race([
    handshake.ready.then(() => ({ kind: "busy" as const })),
    pending.then(result => ({ kind: "finished" as const, result })),
  ]);
  if (outcome.kind === "finished") {
    throw new Error(`Analyzer returned before the busy worker handshake: ${outcome.result.gaps.map(gap => gap.message).join(" ")}`);
  }
  expect(handshake.busyMessageSeen).toBe(true);
  expect(Atomics.load(handshake.busy, 0)).toBe(1);
  expect(handshake.initialThreadId).toBeGreaterThan(0);
  expect(handshake.exited).toBe(false);
  expect(handshake.worker?.threadId).toBeGreaterThan(0);
}

describe("isolated analyzer driver with a real busy worker", () => {
  it("keeps the parent timer responsive and confirms worker exit before timeout returns", async () => {
    const handshake = state.handshake!;
    const analyzer = createIsolatedAnalyzer();
    analyzers.push(analyzer);
    const pending = analyzer.analyze(file, target, 400);
    await waitUntilBusy(handshake, pending);
    let parentTimerFired = false;
    let timerObservedLiveWorker = false;
    const timer = setTimeout(() => {
      parentTimerFired = true;
      timerObservedLiveWorker = !handshake.exited && (handshake.worker?.threadId ?? -1) > 0;
    }, 10);
    const result = await pending;
    clearTimeout(timer);
    expect(parentTimerFired).toBe(true);
    expect(timerObservedLiveWorker).toBe(true);
    expect(result.gaps[0]?.code).toBe("RESOURCE_LIMIT");
    expect(result.gaps[0]?.message).toContain("terminated");
    expect(handshake.exited).toBe(true);
    expect(handshake.worker?.threadId).toBe(-1);
  });

  it("terminates the already-busy worker on AbortSignal before returning", async () => {
    const handshake = state.handshake!;
    const controller = new AbortController();
    const analyzer = createIsolatedAnalyzer({ signal: controller.signal });
    analyzers.push(analyzer);
    const pending = analyzer.analyze(file, target, 5_000);
    await waitUntilBusy(handshake, pending);
    let parentTimerFired = false;
    let timerObservedLiveWorker = false;
    const timer = setTimeout(() => {
      parentTimerFired = true;
      timerObservedLiveWorker = !handshake.exited && (handshake.worker?.threadId ?? -1) > 0;
      controller.abort();
    }, 10);
    const result = await pending;
    clearTimeout(timer);
    expect(parentTimerFired).toBe(true);
    expect(timerObservedLiveWorker).toBe(true);
    expect(result.gaps[0]?.code).toBe("RESOURCE_LIMIT");
    expect(result.gaps[0]?.message).toContain("cancelled");
    expect(handshake.exited).toBe(true);
    expect(handshake.worker?.threadId).toBe(-1);
  });
});
