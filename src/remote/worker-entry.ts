import { parentPort, workerData } from "node:worker_threads";
import { acquireGitHub } from "./acquire.js";
import { failure, normalizeGitHubInput, remoteLimits } from "./policy.js";
import type { GitHubInput, RemoteLimits } from "./policy.js";

const data = workerData as { input: GitHubInput; root: string; limits: RemoteLimits; token?: string };
try {
  const input = normalizeGitHubInput(data.input), limits = remoteLimits({ limits: data.limits });
  const result = await acquireGitHub(input, data.root, limits, AbortSignal.timeout(limits.timeoutMs), data.token);
  parentPort?.postMessage({ status: "ready", value: result });
} catch (error) { parentPort?.postMessage(failure(error)); }
parentPort?.close();
