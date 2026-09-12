/** Explicit live acceptance command. Never part of the offline default test suite. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { validateScanReport } from "../dist/domain/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = join(workspace, "artifacts");
const external = resolve(workspace, "..", "SunsetGuard-samples");
await mkdir(artifacts, { recursive: true });
await mkdir(external, { recursive: true });
const output = await mkdtemp(join(artifacts, "t10-"));
const samples = await mkdtemp(join(external, "t10-"));
const cache = join(samples, "cache");
const manifest = join(output, "consumers.json");
const declared = JSON.parse(await readFile(join(workspace, "examples/consumers.github.json"), "utf8"));
// A deliberate duplicate checks the same denominator through the real executable.
declared.repositories.push({ ...declared.repositories[0], repository: "React-Component/Util" });
await writeFile(manifest, JSON.stringify(declared, null, 2) + "\n");
const command = [join(workspace, "dist/cli/bin.js"), "scan", "--repos", manifest, "--package", "react-dom", "--symbol", "findDOMNode", "--cache", cache];
async function run(name, extra) {
  const reportPath = join(output, name);
  const args = [...command, "--output", reportPath, ...extra];
  const child = spawn(process.execPath, args, { cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", text => { stdout += text; }); child.stderr.on("data", text => { stderr += text; });
  const timer = setTimeout(() => child.kill(), 360_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  assert.equal(stdout, ""); assert.equal(stderr, ""); assert.ok(code === 0 || code === 3);
  return { code, text: await readFile(reportPath, "utf8") };
}
const online = await run("online.json", ["--format", "json"]);
const offline = await run("offline.json", ["--offline", "--format", "json"]);
const markdown = await run("report.md", ["--offline", "--format", "markdown"]);
const first = validateScanReport(JSON.parse(online.text)), repeated = validateScanReport(JSON.parse(offline.text));
assert.equal(first.sample.selected, 3); assert.equal(first.sample.excluded, 1); assert.equal(first.sample.attempted, 2);
assert.ok(first.results.every(result => result.snapshot?.kind === "git"));
assert.deepEqual(first.results, repeated.results);
assert.deepEqual(first.summary, repeated.summary);
assert.ok(repeated.limitations.some(line => line.startsWith("Snapshot cache hit:")));
assert.ok(repeated.limitations.some(line => line.startsWith("Analysis cache hit:")));
assert.equal(markdown.code, offline.code);
for (const contents of [online.text, offline.text, markdown.text]) {
  assert.ok(!contents.includes(workspace) && !contents.includes(samples) && !contents.includes("28928"));
  assert.ok(!contents.includes('"snippet":'));
}
const result = { artifact: `artifacts/${output.split(/[\\/]/).at(-1)}`, onlineExit: online.code, offlineExit: offline.code, markdownExit: markdown.code,
  sample: first.sample, summary: first.summary, repositories: first.results.map(result => ({ repositoryId: result.repositoryId,
    commit: result.snapshot?.gitCommit, analyzedFiles: result.inventory.analyzedFiles, bucket: result.bucket, status: result.status })) };
await writeFile(join(output, "acceptance.json"), JSON.stringify(result, null, 2) + "\n");
process.stdout.write(JSON.stringify(result) + "\n");
