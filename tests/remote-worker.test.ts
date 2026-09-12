import type { WorkerOptions } from "node:worker_threads";
import { access, readdir, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ scenario: "ready", directory: "", exited: false, worker: undefined as { threadId: number } | undefined,
  ready: Promise.resolve(), markReady: (() => undefined) as () => void, options: undefined as WorkerOptions | undefined }));
vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class OfflineWorker extends actual.Worker {
    constructor(_file: string | URL, options?: WorkerOptions) {
      state.options = options;
      const data = options?.workerData as { root: string };
      state.directory = data.root;
      super(new URL("./helpers/remote-worker.mjs", import.meta.url), { ...options, workerData: { ...data, scenario: state.scenario } });
      state.worker = this;
      this.once("exit", () => { state.exited = true; });
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event === "message" && (args[0] as { testReady?: boolean })?.testReady === true) { state.markReady(); return true; }
      return super.emit(event, ...args);
    }
  }
  return { ...actual, Worker: OfflineWorker };
});
import { fetchGitHubSnapshot } from "../src/remote/snapshot.js";
import type { GitHubSnapshot } from "../src/remote/snapshot.js";
const handles: GitHubSnapshot[] = [];
beforeEach(() => {
  state.scenario = "ready"; state.exited = false; state.directory = "";
  state.ready = new Promise(resolve => { state.markReady = resolve; });
});
afterEach(async () => { for (const handle of handles.splice(0)) await handle.dispose(); vi.unstubAllEnvs(); });

describe("remote acquisition worker lifecycle", () => {
  it("waits for worker termination before returning verified files, and disposes idempotently", async () => {
    const result = await fetchGitHubSnapshot({ repository: "Owner/Repo", ref: "main" });
    expect(result.status).toBe("ready"); if (result.status !== "ready") throw Error("Expected verified snapshot"); handles.push(result);
    expect(state.exited).toBe(true); expect(state.worker?.threadId).toBe(-1);
    expect(state.options?.env).toEqual({}); expect(state.options?.execArgv).toEqual([]);
    expect(await readdir(result.directory)).toEqual(["package.json", "source.ts"]);
    expect(await readFile(`${result.directory}/source.ts`, "utf8")).toContain("NEVER EXECUTE");
    await Promise.all([result.dispose(), result.dispose()]); await result.dispose(); await expect(access(result.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hard-terminates a busy worker, leaves the parent responsive, and removes private storage", async () => {
    state.scenario = "busy";
    const pending = fetchGitHubSnapshot({ repository: "owner/repo", ref: "main" }, { limits: { timeoutMs: 1000 } });
    await state.ready;
    let ticked = false; setTimeout(() => { ticked = true; }, 10);
    expect(await pending).toMatchObject({ status: "failed", code: "TIMEOUT" });
    expect(ticked).toBe(true); expect(state.exited).toBe(true); expect(state.worker?.threadId).toBe(-1);
    await expect(access(state.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts a running worker and waits for actual exit before cleanup returns", async () => {
    state.scenario = "busy"; const controller = new AbortController();
    const pending = fetchGitHubSnapshot({ repository: "owner/repo", ref: "main" }, { signal: controller.signal });
    await state.ready; controller.abort();
    expect(await pending).toMatchObject({ status: "failed", code: "CANCELLED" });
    expect(state.exited).toBe(true); expect(state.worker?.threadId).toBe(-1);
    await expect(access(state.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a sanitized HTTP failure and creates no reusable partial snapshot", async () => {
    state.scenario = "failure";
    const result = await fetchGitHubSnapshot({ repository: "owner/repo", ref: "main" });
    expect(result).toMatchObject({ status: "failed", code: "HTTP_ERROR", httpStatus: 404 });
    expect(JSON.stringify(result)).not.toContain("PRIVATE ERROR");
    expect(state.exited).toBe(true); await expect(access(state.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads only the explicitly selected credential and excludes it from acquisition metadata", async () => {
    vi.stubEnv("SUNSETGUARD_GITHUB_TOKEN", "FAKE_TEST_TOKEN");
    const anonymous = await fetchGitHubSnapshot({ repository: "owner/repo", ref: "main" });
    if (anonymous.status !== "ready") throw Error("Expected anonymous fixture"); handles.push(anonymous);
    expect((state.options?.workerData as { token?: string }).token).toBeUndefined();
    state.scenario = "credential";
    const credential = await fetchGitHubSnapshot({ repository: "owner/repo", ref: "main" }, { tokenEnvironment: "SUNSETGUARD_GITHUB_TOKEN" });
    if (credential.status !== "ready") throw Error("Expected credential fixture"); handles.push(credential);
    expect(JSON.stringify(credential)).not.toContain("FAKE_TEST_TOKEN");
  });

  it("rejects malformed worker output and cleans up instead of publishing a ready handle", async () => {
    state.scenario = "malformed";
    const result = await fetchGitHubSnapshot({ repository: "owner/repo", ref: "main" });
    expect(result).toMatchObject({ status: "failed", code: "IO_ERROR" });
    expect(JSON.stringify(result)).not.toContain("FAKE_SECRET");
    await expect(access(state.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
