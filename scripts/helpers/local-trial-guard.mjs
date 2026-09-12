// Trusted acceptance instrumentation, copied into the private trial directory.
// Node API: https://nodejs.org/api/module.html#moduleregisterhooksoptions
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { appendFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import workerThreads from "node:worker_threads";
import process from "node:process";

const root = realpathSync(process.env.SUNSETGUARD_TRIAL_ROOT);
const parent = dirname(root), trace = process.env.SUNSETGUARD_TRIAL_TRACE;
const helper = realpathSync(fileURLToPath(import.meta.url));
const allowedHelpers = new Set([helper, resolve(parent, "probe.mjs")]);
const within = (base, candidate) => { const value = relative(base, candidate); return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`)); };
const record = value => appendFileSync(trace, JSON.stringify({ ...value, thread: workerThreads.threadId }) + "\n", { encoding: "utf8" });
const seen = new Set();
function permit(url) {
  if (url.startsWith("node:")) return;
  if (!url.startsWith("file:")) throw Error("TRIAL_UNEXPECTED_MODULE_SCHEME");
  const path = realpathSync(fileURLToPath(url));
  if (!within(root, path) && !allowedHelpers.has(path)) throw Error("TRIAL_MODULE_OUTSIDE_INSTALL");
  if (!seen.has(path)) { seen.add(path); record({ event: "module", path: within(root, path) ? relative(root, path).split(sep).join("/") : `helper/${relative(parent, path)}` }); }
}
registerHooks({
  resolve(specifier, context, nextResolve) { const result = nextResolve(specifier, context); permit(result.url); return result; },
  load(url, context, nextLoad) { permit(url); return nextLoad(url, context); },
});
globalThis.fetch = async () => { record({ event: "network-denied" }); throw Error("TRIAL_NETWORK_DISABLED"); };
const Worker = workerThreads.Worker;
workerThreads.Worker = class extends Worker {
  constructor(filename, options = {}) {
    const url = filename instanceof URL ? filename : pathToFileURL(resolve(filename)); permit(url.href);
    const path = realpathSync(fileURLToPath(url));
    if (!within(root, path)) throw Error("TRIAL_WORKER_OUTSIDE_INSTALL");
    record({ event: "worker", path: relative(root, path).split(sep).join("/") });
    super(filename, { ...options, execArgv: ["--import", pathToFileURL(helper).href], env: {
      ...(options.env ?? process.env), SUNSETGUARD_TRIAL_ROOT: root, SUNSETGUARD_TRIAL_TRACE: trace,
    } });
  }
};
syncBuiltinESMExports();
