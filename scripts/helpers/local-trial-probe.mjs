// Trusted acceptance probe; never imports source fixtures.
import { createRequire } from "node:module";
import { realpath, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import process from "node:process";
import assert from "node:assert/strict";
import { setTimeout, clearTimeout } from "node:timers";

const root = await realpath(process.env.SUNSETGUARD_TRIAL_ROOT), modules = join(root, "node_modules");
const require = createRequire(join(root, "package.json"));
const within = (base, path) => { const rel = relative(base, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dependencies = [];
for (const [name, version] of Object.entries(packageJson.dependencies)) {
  const entry = await realpath(require.resolve(name)); assert.ok(within(modules, entry));
  let packageRoot = dirname(entry), found;
  while (within(modules, packageRoot)) {
    try { const candidate = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")); if (candidate.name === name) { found = candidate; break; } } catch { /* Inspect package metadata only, never execute package scripts. */ }
    packageRoot = dirname(packageRoot);
  }
  assert.ok(found); assert.equal(found.version, version);
  dependencies.push({ name, version: found.version, entry: relative(root, entry).split(sep).join("/") });
}
const remoteEntry = join(root, "dist/remote/worker-entry.js");
const worker = new Worker(pathToFileURL(remoteEntry), { execArgv: [], env: {}, stdout: true, stderr: true,
  workerData: { input: { repository: "invalid-repository", ref: "main" }, root: process.cwd(), limits: {} } });
worker.stdout.resume(); worker.stderr.resume();
const message = await new Promise((resolveMessage, reject) => {
  const timer = setTimeout(() => { void worker.terminate().then(() => reject(Error("TRIAL_REMOTE_WORKER_TIMEOUT"))); }, 15_000);
  worker.once("error", error => { clearTimeout(timer); reject(error); });
  worker.once("message", value => { clearTimeout(timer); resolveMessage(value); });
});
await worker.terminate(); assert.equal(message.status, "failed");
process.stdout.write(JSON.stringify({ dependencies, remoteWorker: { entry: "dist/remote/worker-entry.js", status: message.status, code: message.code, network: "not-requested-invalid-input" } }) + "\n");
