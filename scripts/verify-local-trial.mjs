/** Offline verification of a private, explicitly supplied SunsetGuard trial bundle. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { spawn } from "node:child_process";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { setTimeout, clearTimeout } from "node:timers";
import process from "node:process";

const MIB = 1024 * 1024, MAX_FILES = 256, MAX_BYTES = 20 * MIB;
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = value => createHash("sha256").update(value).digest("hex");
const within = (root, path) => { const item = relative(root, path); return item === "" || (!isAbsolute(item) && item !== ".." && !item.startsWith(`..${sep}`)); };
const checks = [], cases = {}; let artifact, trial, stage = "arguments";
function checked(name, value, details = {}) { assert.ok(value, name); checks.push({ name, status: "passed", ...details }); }
function safeRelative(path) {
  return typeof path === "string" && path.length < 240 && !path.includes("\\") && path.split("/").every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..") &&
    (["package.json", "pnpm-lock.yaml", ".npmrc", "README.md", "fixtures/consumer/source.ts", "docs/SPEC.md", "examples/consumers.local.json", "examples/consumers.github.json"].includes(path) || /^src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ts$/.test(path) || /^dist\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(path));
}
async function safeDirectory(path) {
  const absolute = resolve(path);
  for (let current = absolute; ; current = dirname(current)) {
    const info = await lstat(current); assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal(relative(current, await realpath(current)), "");
    if (dirname(current) === current) break;
  }
  return absolute;
}
async function readBounded(path, maximum) {
  const before = await lstat(path, { bigint: true }); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(maximum));
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true }); assert.equal(opened.ino, before.ino); assert.equal(opened.dev, before.dev);
    const chunks = []; let size = 0;
    while (true) { const buffer = Buffer.alloc(65536); const result = await handle.read(buffer, 0, buffer.length, null); if (result.bytesRead === 0) break; size += result.bytesRead; assert.ok(size <= maximum); chunks.push(buffer.subarray(0, result.bytesRead)); }
    const after = await handle.stat({ bigint: true }), linked = await lstat(path, { bigint: true });
    assert.equal(size, Number(before.size)); for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) { assert.equal(after[field], before[field]); assert.equal(linked[field], before[field]); }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}
function parseArguments() {
  const args = process.argv.slice(2); assert.ok(args.length >= 1); const supplied = { bundle: args.shift() };
  while (args.length > 0) { const flag = args.shift(); assert.ok(["--pnpm-cli", "--snapshot-cache"].includes(flag) && args.length > 0 && supplied[flag] === undefined); supplied[flag] = args.shift(); }
  return supplied;
}
function octal(bytes) { const value = bytes.toString("ascii").replace(/\0.*$/, "").trim(); assert.match(value, /^[0-7]+$/); return Number.parseInt(value, 8); }
function field(bytes) { const nul = bytes.indexOf(0); return new TextDecoder("utf-8", { fatal: true }).decode(nul < 0 ? bytes : bytes.subarray(0, nul)); }
async function unpack(bytes, manifest, destination) {
  const chunks = []; let expanded = 0;
  const source = Readable.from([bytes]), gunzip = source.pipe(createGunzip());
  try { for await (const chunk of gunzip) { expanded += chunk.length; assert.ok(expanded <= MAX_BYTES + MAX_FILES * 1024 + 1024); chunks.push(chunk); } }
  finally { source.destroy(); gunzip.destroy(); }
  const tar = Buffer.concat(chunks), expected = new Map(manifest.files.map(file => [file.path, file])), files = new Map();
  let cursor = 0, end = false, mtime;
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512); cursor += 512;
    if (header.every(value => value === 0)) { assert.ok(cursor + 512 <= tar.length && tar.subarray(cursor).every(value => value === 0)); end = true; break; }
    let checksum = 0; for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    assert.equal(octal(header.subarray(148, 156)), checksum); assert.equal(field(header.subarray(257, 263)), "ustar");
    assert.ok(header[156] === 0 || header[156] === 48); assert.equal(field(header.subarray(157, 257)), "");
    const name = [field(header.subarray(345, 500)), field(header.subarray(0, 100))].filter(Boolean).join("/");
    assert.ok(name.startsWith("sunsetguard/")); const path = name.slice("sunsetguard/".length); assert.ok(safeRelative(path) && expected.has(path) && !files.has(path));
    const size = octal(header.subarray(124, 136)), stamp = octal(header.subarray(136, 148));
    if (mtime === undefined) mtime = stamp; assert.equal(stamp, mtime);
    const declared = expected.get(path); assert.equal(size, declared.size); assert.ok(cursor + size <= tar.length && files.size < MAX_FILES);
    const contents = tar.subarray(cursor, cursor + size); assert.equal(sha(contents), declared.sha256); files.set(path, contents);
    const padded = Math.ceil(size / 512) * 512; assert.ok(cursor + padded <= tar.length && tar.subarray(cursor + size, cursor + padded).every(value => value === 0)); cursor += padded;
  }
  assert.ok(end); assert.equal(files.size, expected.size);
  // All archive bytes and names are checked before materializing any entry.
  for (const [path, contents] of files) { const output = join(destination, ...path.split("/")); assert.ok(within(destination, output)); await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await writeFile(output, contents, { flag: "wx", mode: 0o600 }); }
  return { entries: files.size, rawFileBytes: manifest.files.reduce((sum, file) => sum + file.size, 0), fixedMtime: mtime };
}
function environment(extra = {}) {
  const env = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATH", "Path", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}
async function run(executable, args, cwd, env, timeoutMs = 120_000) {
  const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", limit = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  for (const [stream, append] of [[child.stdout, text => { stdout += text; }], [child.stderr, text => { stderr += text; }]]) stream.on("data", text => { append(text); if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 2 * MIB) { limit = true; child.kill(); } });
  const timer = setTimeout(() => { limit = true; child.kill(); }, timeoutMs);
  let code;
  try { code = await new Promise((resolveCode, reject) => { child.once("error", reject); child.once("close", resolveCode); }); } finally { clearTimeout(timer); }
  assert.ok(!limit); return { code, stdout, stderr };
}
async function auditModules(root) {
  const modules = await realpath(join(root, "node_modules")); let entries = 0, directories = [modules]; const seen = new Set();
  while (directories.length > 0) {
    const directory = directories.pop(); if (seen.has(directory)) continue; seen.add(directory);
    for await (const entry of await opendir(directory)) {
      assert.ok(++entries <= 20_000); const path = join(directory, entry.name), info = await lstat(path), canonical = await realpath(path); assert.ok(within(modules, canonical));
      if (info.isDirectory() || info.isSymbolicLink()) { const actual = await lstat(canonical); if (actual.isDirectory()) directories.push(canonical); else assert.ok(actual.isFile()); }
      else assert.ok(info.isFile());
    }
  }
  return { entries, canonicalRoot: "sunsetguard/node_modules", escaped: 0 };
}
function parseReport(result, expectedCode, expectations = {}) {
  assert.equal(result.code, expectedCode); assert.equal(result.stderr, ""); const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, "0.1"); assert.equal(report.reportKind, "scan"); assert.equal(report.results.length, expectations.results ?? 1);
  if (expectations.bucket !== undefined) assert.equal(report.results[0].bucket, expectations.bucket);
  if (expectations.status !== undefined) assert.equal(report.results[0].status, expectations.status);
  const text = JSON.stringify(report); assert.ok(!text.includes(workspace) && !text.includes(trial) && !text.includes("28928") && !text.includes("NEVER_EXECUTE_FIXTURE") && !text.includes('"snippet":'));
  return report;
}

try {
  const options = parseArguments(), bundleDirectory = await safeDirectory(options.bundle);
  const pnpmCandidate = options["--pnpm-cli"] ?? process.env.npm_execpath;
  assert.ok(typeof pnpmCandidate === "string" && isAbsolute(pnpmCandidate) && ["pnpm.cjs", "pnpm.js", "pnpm.mjs"].includes(basename(pnpmCandidate)));
  const pnpmCli = await realpath(pnpmCandidate); assert.ok((await lstat(pnpmCli)).isFile());
  const artifactParent = join(workspace, "artifacts"); await mkdir(artifactParent, { recursive: true }); await safeDirectory(artifactParent);
  artifact = await mkdtemp(join(artifactParent, "local-install-"));
  stage = "archive";
  const bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(join(bundleDirectory, "bundle.json"), MIB)));
  assert.equal(bundle.format, "sunsetguard-local-trial-v1"); assert.equal(bundle.archive, "sunsetguard-local-trial.tgz");
  assert.match(bundle.archiveSha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(bundle.archiveBytes) && bundle.archiveBytes > 0 && bundle.archiveBytes <= MAX_BYTES);
  assert.ok(Array.isArray(bundle.files) && bundle.files.length > 0 && bundle.files.length <= MAX_FILES);
  const names = new Set(); let total = 0;
  for (const file of bundle.files) { assert.ok(safeRelative(file.path) && !names.has(file.path.toLowerCase())); names.add(file.path.toLowerCase()); assert.match(file.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(file.size) && file.size >= 0); total += file.size; }
  assert.ok(total <= MAX_BYTES); for (const mandatory of ["package.json", "pnpm-lock.yaml", ".npmrc", "dist/cli/bin.js", "dist/analyzer/worker-entry.js", "dist/remote/worker-entry.js"]) assert.ok(names.has(mandatory));
  const archive = await readBounded(join(bundleDirectory, bundle.archive), MAX_BYTES); assert.equal(archive.length, bundle.archiveBytes); assert.equal(sha(archive), bundle.archiveSha256);
  const trialParent = resolve(workspace, "..", "SunsetGuard-trials"); await mkdir(trialParent, { recursive: true }); await safeDirectory(trialParent);
  trial = await mkdtemp(join(trialParent, "local-install-")); const install = join(trial, "sunsetguard"); await mkdir(install, { mode: 0o700 });
  checked("archive-integrity-and-allowlist", true, await unpack(archive, bundle, install));
  const packageJson = JSON.parse(await readFile(join(install, "package.json"), "utf8")); assert.equal(packageJson.name, "sunsetguard"); assert.equal(packageJson.private, true); assert.deepEqual(Object.keys(packageJson.scripts), ["start"]);
  assert.equal(packageJson.scripts.start, "node dist/cli/bin.js"); assert.equal(packageJson.bin.sunsetguard, "dist/cli/bin.js"); assert.equal(packageJson.type, "module");
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ["commander", "tar-stream", "typescript", "zod"]);
  assert.ok(Object.values({ ...packageJson.dependencies, ...packageJson.devDependencies }).every(version => typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)));
  assert.equal(await readFile(join(install, ".npmrc"), "utf8"), "ignore-scripts=true\nsave-exact=true\nengine-strict=true\n");
  checked("private-runtime-package", true, { packageName: packageJson.name, version: packageJson.version, private: true });
  stage = "install";
  const emptyConfig = join(trial, "empty.npmrc"); await writeFile(emptyConfig, "", { flag: "wx" });
  const installed = await run(process.execPath, [pnpmCli, "install", "--prod", "--offline", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--ignore-workspace"], install,
    environment({ CI: "true", npm_config_userconfig: emptyConfig, npm_config_globalconfig: emptyConfig }));
  cases.install = { exitCode: installed.code, stdoutBytes: Buffer.byteLength(installed.stdout), stderrBytes: Buffer.byteLength(installed.stderr), diagnosticCodes: [...new Set(`${installed.stdout}\n${installed.stderr}`.match(/ERR_PNPM_[A-Z_]+/g) ?? [])] };
  checked("offline-production-install", installed.code === 0, { scripts: "disabled", devDependencies: "not-installed" });
  checked("runtime-node-modules-contained", true, await auditModules(install));
  for (const developmentOnly of ["vitest", "eslint", "@eslint/js", "@types/node"]) assert.ok(!await lstat(join(install, "node_modules", developmentOnly)).then(() => true, () => false));
  stage = "runtime";
  const emptyCwd = join(trial, "empty-cwd"), samples = join(trial, "samples"), outputs = join(trial, "outputs"); await mkdir(emptyCwd); await mkdir(samples); await mkdir(outputs);
  const guard = join(trial, "guard.mjs"), probe = join(trial, "probe.mjs"), trace = join(artifact, "module-loads.jsonl");
  await writeFile(guard, await readFile(new URL("./helpers/local-trial-guard.mjs", import.meta.url)), { flag: "wx" });
  await writeFile(probe, await readFile(new URL("./helpers/local-trial-probe.mjs", import.meta.url)), { flag: "wx" }); await writeFile(trace, "", { flag: "wx" });
  const env = environment({ SUNSETGUARD_TRIAL_ROOT: install, SUNSETGUARD_TRIAL_TRACE: trace });
  const bin = join(install, "dist/cli/bin.js"), nodeArgs = ["--import", pathToFileURL(guard).href];
  const cli = args => run(process.execPath, [...nodeArgs, bin, ...args], emptyCwd, env);
  const help = await cli(["--help"]); checked("help-from-empty-cwd", help.code === 0 && help.stderr === "" && help.stdout.includes("analyze") && help.stdout.includes("scan"));
  const probeResult = await run(process.execPath, [...nodeArgs, probe], emptyCwd, env); assert.equal(probeResult.code, 0); assert.equal(probeResult.stderr, ""); cases.runtime = JSON.parse(probeResult.stdout); checked("runtime-dependencies-and-remote-worker", true, cases.runtime);
  const demo = parseReport(await cli(["scan", "--repos", join(install, "examples/consumers.local.json"), "--package", "example-lib", "--symbol", "oldApi", "--format", "json"]), 0, { bucket: "detected", status: "complete-within-scope" });
  checked("packaged-demo-manifest-from-empty-cwd", demo.results[0].findings.length === 5, { findings: demo.results[0].findings.length }); cases.packagedDemo = demo.summary;
  const fixtures = {
    positive: { "source.ts": 'import { oldApi as retained } from "trial-package";\nretained();\nthrow new Error("NEVER_EXECUTE_FIXTURE");\n' },
    negative: { "source.ts": 'import { otherApi } from "trial-package";\nfunction fn(oldApi: () => void) { oldApi(); }\notherApi();\nthrow new Error("NEVER_EXECUTE_FIXTURE");\n' },
    partial: { "supported.ts": 'import { oldApi } from "trial-package"; oldApi();\n', "broken.ts": 'import { oldApi } from "trial-package";\nconst = ;\n' },
  };
  for (const [name, files] of Object.entries(fixtures)) { await mkdir(join(samples, name)); for (const [path, text] of Object.entries(files)) await writeFile(join(samples, name, path), text, { flag: "wx" }); }
  const command = name => ["analyze", join(samples, name), "--package", "trial-package", "--symbol", "oldApi", "--format", "json"];
  const positive = parseReport(await cli(command("positive")), 0, { bucket: "detected", status: "complete-within-scope" });
  assert.equal(positive.analyzerVersion, bundle.analyzerVersion); assert.equal(positive.ruleSetVersion, bundle.ruleSetVersion); assert.ok(positive.results[0].findings.some(finding => finding.location.file === "source.ts" && finding.location.start.line === 2));
  checked("positive-binding-reference", true, { findings: positive.results[0].findings.length });
  const ordinary = parseReport(await run(process.execPath, [bin, ...command("positive")], emptyCwd, environment()), 0); assert.deepEqual(ordinary.results, positive.results); checked("uninstrumented-cli-parity", true);
  const negative = parseReport(await cli(command("negative")), 0, { bucket: "not-detected-within-scope", status: "complete-within-scope" }); assert.equal(negative.results[0].findings.length, 0); checked("negative-shadowed-and-other-export", true);
  const partial = parseReport(await cli(command("partial")), 3, { bucket: "detected", status: "partial" }); assert.ok(partial.results[0].gaps.some(gap => gap.code === "PARSE_FAILED" && gap.location?.file === "broken.ts" && gap.location.start.line > 0 && gap.location.start.column > 0)); checked("partial-retains-evidence-and-parse-position", true);
  const invalid = await cli(["analyze", join(samples, "positive"), "--package", "trial-package"]); checked("invalid-arguments-exit-2", invalid.code === 2 && invalid.stdout === "" && invalid.stderr.length > 0);
  const output = join(outputs, "report.json"), external = await cli([...command("positive"), "--output", output]); checked("external-file-output-clean-streams", external.code === 0 && external.stdout === "" && external.stderr === "");
  const saved = await readBounded(output, MIB), noOverwrite = await cli([...command("positive"), "--output", output]); checked("no-overwrite-exit-1", noOverwrite.code === 1 && noOverwrite.stdout === "" && sha(await readBounded(output, MIB)) === sha(saved));
  const markdown = await cli(["analyze", join(samples, "positive"), "--package", "trial-package", "--symbol", "oldApi", "--format", "markdown"]); checked("markdown-from-installed-cli", markdown.code === 0 && markdown.stderr === "" && markdown.stdout.includes("detected") && !markdown.stdout.includes(trial));
  const manifest = join(trial, "offline-miss.json"); await writeFile(manifest, JSON.stringify({ schemaVersion: "0.1", repositories: [{ kind: "github", repository: "owner/repo", ref: "a".repeat(40) }] }), { flag: "wx" });
  const miss = parseReport(await cli(["scan", "--repos", manifest, "--offline", "--package", "trial-package", "--symbol", "oldApi", "--format", "json"]), 3, { bucket: "unknown", status: "failed" }); checked("offline-github-miss-exit-3", true);
  cases.positive = positive.summary; cases.negative = negative.summary; cases.partial = partial.summary; cases.offlineMiss = miss.summary;
  await writeFile(join(artifact, "report.json"), JSON.stringify(positive, null, 2) + "\n", { flag: "wx" });
  if (options["--snapshot-cache"] !== undefined) {
    stage = "snapshot-cache-replay";
    const cache = await safeDirectory(options["--snapshot-cache"]), fixtureManifest = JSON.parse(await readFile(join(install, "examples/consumers.github.json"), "utf8"));
    assert.ok(fixtureManifest.repositories.length === 2 && fixtureManifest.repositories.every(entry => entry.kind === "github" && /^[a-f0-9]{40}$/.test(entry.ref)));
    const replayManifest = join(trial, "replay.json"); await writeFile(replayManifest, JSON.stringify(fixtureManifest), { flag: "wx" });
    const args = ["scan", "--repos", replayManifest, "--cache", cache, "--offline", "--package", "react-dom", "--symbol", "findDOMNode", "--format", "json"];
    const firstRun = await cli(args), secondRun = await cli(args);
    const first = parseReport(firstRun, 3, { results: 2 }), second = parseReport(secondRun, 3, { results: 2 });
    assert.deepEqual(second.results, first.results); assert.deepEqual(second.summary, first.summary); assert.ok(first.results.every(result => result.snapshot?.kind === "git"));
    for (const report of [first, second]) {
      assert.equal(report.target.packageName, "react-dom"); assert.equal(report.target.moduleSpecifier, "react-dom"); assert.equal(report.target.exportName, "findDOMNode");
      const requested = new Map(fixtureManifest.repositories.map(entry => [`github:${entry.repository.toLowerCase()}`, entry.ref.toLowerCase()]));
      assert.equal(requested.size, report.results.length);
      for (const result of report.results) {
        assert.ok(requested.has(result.repositoryId)); assert.equal(result.snapshot.gitCommit, requested.get(result.repositoryId)); requested.delete(result.repositoryId);
      }
      assert.equal(requested.size, 0);
    }
    assert.ok(first.limitations.some(line => line.startsWith("Snapshot cache hit:"))); assert.ok(second.limitations.some(line => line.startsWith("Snapshot cache hit:"))); assert.ok(second.limitations.some(line => line.startsWith("Analysis cache hit:")));
    const rcUtil = fixtureManifest.repositories.find(entry => entry.repository === "react-component/util"); assert.ok(rcUtil);
    const rcManifest = join(trial, "rcutil-replay.json"); await writeFile(rcManifest, JSON.stringify({ schemaVersion: "0.1", repositories: [rcUtil] }), { flag: "wx" });
    const rcReport = parseReport(await cli(["scan", "--repos", rcManifest, "--cache", cache, "--offline", "--package", "react-dom", "--symbol", "findDOMNode", "--format", "json"]), 3);
    assert.equal(rcReport.results[0].repositoryId, "github:react-component/util"); assert.equal(rcReport.results[0].snapshot.gitCommit, rcUtil.ref);
    assert.deepEqual(rcReport.target, first.target); assert.ok(rcReport.limitations.some(line => line.startsWith("Analysis cache hit:")));
    checked("optional-real-snapshot-cache-replay", true, { repositories: first.results.map(result => ({ repositoryId: result.repositoryId, commit: result.snapshot.gitCommit, status: result.status, bucket: result.bucket })) });
    await writeFile(join(artifact, "cache-first.json"), JSON.stringify(first, null, 2) + "\n", { flag: "wx" }); await writeFile(join(artifact, "cache-second.json"), JSON.stringify(second, null, 2) + "\n", { flag: "wx" });
  } else checks.push({ name: "optional-real-snapshot-cache-replay", status: "not-run", reason: "No --snapshot-cache was provided." });
  stage = "trace";
  const events = (await readBounded(trace, 4 * MIB)).toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  checked("no-runtime-network-attempts", !events.some(event => event.event === "network-denied"));
  checked("both-worker-entries-contained-and-executed", ["dist/analyzer/worker-entry.js", "dist/remote/worker-entry.js"].every(path => events.some(event => event.event === "worker" && event.path === path) && events.some(event => event.event === "module" && event.path === path && event.thread > 0)));
  checked("loaded-runtime-dependencies-contained", events.some(event => event.event === "module" && event.path.startsWith("node_modules/")), { uniqueModules: new Set(events.filter(event => event.event === "module").map(event => event.path)).size });
  const summary = { format: "sunsetguard-local-install-checks-v1", status: "passed", artifact: `artifacts/${basename(artifact)}`, trial: `../SunsetGuard-trials/${basename(trial)}`, archiveSha256: bundle.archiveSha256,
    analyzerVersion: bundle.analyzerVersion, ruleSetVersion: bundle.ruleSetVersion, checks, cases, limitations: ["Private local trial only; no package publication, maintainer adoption or production validation is implied.", "Archive and cache checks verify integrity, not authenticity against someone rewriting all bytes and metadata.", "Instrumented execution checks module and Worker locations; the same positive case also ran without instrumentation.", "The installation and generated original fixtures are retained for inspection; fixture code was never executed."] };
  await writeFile(join(artifact, "checks.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" }); process.stdout.write(JSON.stringify({ status: "passed", artifact: summary.artifact, trial: summary.trial, checks: checks.length }) + "\n");
} catch {
  const result = { format: "sunsetguard-local-install-checks-v1", status: "failed", stage, checks, cases, ...(artifact === undefined ? {} : { artifact: `artifacts/${basename(artifact)}` }), ...(trial === undefined ? {} : { trial: `../SunsetGuard-trials/${basename(trial)}` }) };
  if (artifact !== undefined) await writeFile(join(artifact, "checks.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" }).catch(() => undefined);
  process.stderr.write(JSON.stringify(result) + "\n"); process.exitCode = 1;
}
