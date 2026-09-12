import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { failure, normalizeGitHubInput, remoteLimits, safeArchivePath, RemoteError } from "./policy.js";
import type { GitHubInput, RemoteFailure, RemoteOptions, RemoteLimits, RemoteFailureCode } from "./policy.js";
import type { VerifiedAcquisition } from "./acquire.js";
import { isSha, object } from "./tree.js";

export interface GitHubSnapshot extends VerifiedAcquisition {
  status: "ready";
  /** Private tool-owned path, never serialize this handle into a report. */
  directory: string;
  dispose(): Promise<void>;
}
type WorkerResult = { status: "ready"; value: VerifiedAcquisition } | RemoteFailure;
const workerUrl = () => import.meta.url.endsWith(".ts") ? new URL("../../dist/remote/worker-entry.js", import.meta.url) : new URL("./worker-entry.js", import.meta.url);

function workerResult(value: unknown, input: GitHubInput, limits: RemoteLimits): WorkerResult {
  try {
    if (!object(value)) throw Error();
    if (value.status === "failed") {
      const codes: RemoteFailureCode[] = ["HTTP_ERROR", "RATE_LIMITED", "NETWORK_ERROR", "TIMEOUT", "CANCELLED", "INVALID_RESPONSE", "UNSAFE_ARCHIVE", "RESOURCE_LIMIT", "COMMIT_MISMATCH", "SOURCE_CHANGED", "IO_ERROR", "CLEANUP_FAILED"];
      if (typeof value.code !== "string" || !codes.includes(value.code as RemoteFailureCode) ||
          (value.httpStatus !== undefined && (!Number.isInteger(value.httpStatus) || (value.httpStatus as number) < 100 || (value.httpStatus as number) > 599))) throw Error();
      return failure(new RemoteError(value.code as RemoteFailureCode, value.httpStatus as number | undefined));
    }
    const data = value.value;
    if (value.status !== "ready" || !object(data) || !object(data.input) || data.input.repository !== input.repository || data.input.ref !== input.ref ||
        !isSha(data.commit) || !isSha(data.treeSha) || (isSha(input.ref) && input.ref !== data.commit) || typeof data.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.archiveSha256) ||
        !Number.isSafeInteger(data.compressedBytes) || (data.compressedBytes as number) <= 0 || (data.compressedBytes as number) > limits.maxCompressedBytes ||
        !Number.isSafeInteger(data.expandedBytes) || (data.expandedBytes as number) < 0 || (data.expandedBytes as number) > limits.maxExpandedBytes ||
        !Array.isArray(data.files) || data.files.length > limits.maxEntries) throw Error();
    const paths = new Set<string>(); let bytes = 0;
    for (const file of data.files) {
      if (!object(file) || typeof file.path !== "string" || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !isSha(file.gitBlobSha) || !Number.isSafeInteger(file.size) || (file.size as number) < 0) throw Error();
      const path = safeArchivePath(file.path, limits).normalize("NFC").toLowerCase();
      if (paths.has(path)) throw Error(); paths.add(path); bytes += file.size as number;
      if (bytes > (data.expandedBytes as number)) throw Error();
    }
    return { status: "ready", value: { input, commit: data.commit, treeSha: data.treeSha, archiveSha256: data.archiveSha256,
      compressedBytes: data.compressedBytes as number, expandedBytes: data.expandedBytes as number,
      files: data.files.map(file => ({ path: file.path as string, sha256: file.sha256 as string, gitBlobSha: file.gitBlobSha as string, size: file.size as number })) } };
  } catch { return failure(new RemoteError("IO_ERROR")); }
}

export async function fetchGitHubSnapshot(inputValue: GitHubInput, options: RemoteOptions = {}): Promise<GitHubSnapshot | RemoteFailure> {
  const input = normalizeGitHubInput(inputValue), limits = remoteLimits(options), started = performance.now();
  if (options.signal?.aborted) return failure(new RemoteError("CANCELLED"));
  let token: string | undefined;
  if (options.tokenEnvironment !== undefined) {
    token = process.env[options.tokenEnvironment];
    if (token === undefined || token.length === 0 || token.length > 1024 || /\s/.test(token)) throw new TypeError("The explicitly requested credential is missing or invalid.");
  }
  let directory: string, parent: string;
  try { parent = await realpath(tmpdir()); directory = await mkdtemp(join(parent, "sunsetguard-")); }
  catch { return failure(new RemoteError("IO_ERROR")); }
  const identity = await lstat(directory, { bigint: true });
  let disposed = false;
  let disposing: Promise<void> | undefined;
  const remove = async () => {
    if (disposed) return;
    try {
      const current = await lstat(directory, { bigint: true });
      // Delete only the fresh, identity-checked child of the canonical temporary parent.
      if (dirname(directory) !== parent || relative(parent, directory).includes("/") ||
          await realpath(dirname(directory)) !== parent || await realpath(directory) !== directory ||
          current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs) throw new RemoteError("CLEANUP_FAILED");
      await rm(directory, { recursive: true, force: false, maxRetries: 2 }); disposed = true;
    } catch { throw new RemoteError("CLEANUP_FAILED"); }
  };
  const dispose = () => disposing ??= remove();
  let result: WorkerResult;
  try {
    if (options.signal?.aborted) throw new RemoteError("CANCELLED");
    const remaining = Math.ceil(limits.timeoutMs - (performance.now() - started));
    if (remaining <= 0) throw new RemoteError("TIMEOUT");
    const worker = new Worker(workerUrl(), { workerData: { input, root: directory, limits: { ...limits, timeoutMs: remaining }, ...(token === undefined ? {} : { token }) },
      resourceLimits: { maxOldGenerationSizeMb: 128 }, execArgv: [], env: {}, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    result = await new Promise<WorkerResult>(resolve => {
      let finished = false;
      const finish = (value: WorkerResult) => {
        if (finished) return; finished = true;
        clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        // Return only after termination, including the success path; parser/network work cannot outlive the handle.
        void worker.terminate().then(() => resolve(value), () => resolve(failure(new RemoteError("IO_ERROR"))));
      };
      const abort = () => finish(failure(new RemoteError("CANCELLED")));
      const timer = setTimeout(() => finish(failure(new RemoteError("TIMEOUT"))), remaining);
      worker.on("message", (value: unknown) => finish(workerResult(value, input, limits)));
      worker.on("error", () => finish(failure(new RemoteError("RESOURCE_LIMIT"))));
      worker.on("exit", () => { if (!finished) finish(failure(new RemoteError("IO_ERROR"))); });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  } catch (error) { result = failure(error); }
  if (result.status === "failed") {
    try { await dispose(); } catch { return failure(new RemoteError("CLEANUP_FAILED")); }
    return result;
  }
  return { status: "ready", ...result.value, directory, dispose };
}
