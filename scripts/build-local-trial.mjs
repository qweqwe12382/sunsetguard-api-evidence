/** Build only SunsetGuard-owned allowlisted files. No downstream data or installed dependencies enter the archive. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { pack } from "tar-stream";
import { ANALYZER_VERSION } from "../dist/scans/local.js";
import { RULE_SET_VERSION } from "../dist/analyzer/index.js";

const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const maximum = 20 * 1024 * 1024;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
async function sourceFile(path) {
  assert.match(path, /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/);
  assert.ok(!path.split("/").some(part => part === "." || part === ".."));
  const full = join(workspace, ...path.split("/"));
  assert.ok(!relative(workspace, full).startsWith(`..${sep}`));
  assert.equal(await realpath(full), full);
  for (let parent = dirname(full); parent !== workspace; parent = dirname(parent)) assert.ok(!(await lstat(parent)).isSymbolicLink());
  const before = await lstat(full, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(maximum));
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert.ok(same(before, await handle.stat({ bigint: true })));
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, Math.min(65536, bytes.length - size), null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    assert.equal(size, Number(before.size));
    assert.ok(same(before, await handle.stat({ bigint: true })) && same(before, await lstat(full, { bigint: true })));
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
async function sources(directory) {
  const result = [];
  for (const entry of await readdir(join(workspace, directory), { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink());
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await sources(path));
    else { assert.ok(entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")); result.push(path); }
  }
  return result.sort();
}
const sourcePaths = await sources("src");
const sourcePackage = JSON.parse((await sourceFile("package.json")).toString("utf8"));
assert.equal(sourcePackage.private, true);
assert.equal(sourcePackage.name, "sunsetguard");
assert.deepEqual(Object.keys(sourcePackage.dependencies).sort(), ["commander", "tar-stream", "typescript", "zod"]);
assert.ok(Object.values({ ...sourcePackage.dependencies, ...sourcePackage.devDependencies }).every(value => /^\d+\.\d+\.\d+$/.test(value)));
const runtimePackage = {
  name: sourcePackage.name, version: sourcePackage.version, private: true, description: sourcePackage.description,
  type: sourcePackage.type, packageManager: sourcePackage.packageManager, engines: sourcePackage.engines, bin: sourcePackage.bin,
  scripts: { start: "node dist/cli/bin.js" }, dependencies: sourcePackage.dependencies, devDependencies: sourcePackage.devDependencies,
};
const contents = new Map([
  ["package.json", Buffer.from(JSON.stringify(runtimePackage, null, 2) + "\n")],
  [".npmrc", Buffer.from("ignore-scripts=true\nsave-exact=true\nengine-strict=true\n")],
  ["README.md", await sourceFile("docs/LOCAL_PACKAGE.md")],
]);
for (const path of ["pnpm-lock.yaml", "docs/SPEC.md", "examples/consumers.local.json", "examples/consumers.github.json", "fixtures/consumer/source.ts"]) contents.set(path, await sourceFile(path));
for (const path of sourcePaths) {
  contents.set(path, await sourceFile(path));
  const stem = path.replace(/^src\//, "dist/").replace(/\.ts$/, "");
  for (const suffix of [".js", ".d.ts", ".js.map"]) contents.set(stem + suffix, await sourceFile(stem + suffix));
  const map = JSON.parse(contents.get(stem + ".js.map").toString("utf8"));
  assert.equal(map.sourcesContent, undefined);
  assert.ok(map.sources.every(item => !/^(?:[a-z]+:|\/|\\)/i.test(item)));
}
assert.ok(contents.size <= 256);
assert.ok([...contents.values()].reduce((sum, bytes) => sum + bytes.length, 0) <= maximum);
const parent = join(workspace, "artifacts"); await mkdir(parent, { recursive: true });
assert.equal(await realpath(parent), parent);
const output = await mkdtemp(join(parent, "local-trial-"));
const archive = "sunsetguard-local-trial.tgz";
const packer = pack();
const completed = pipeline(packer, createGzip({ level: 9 }), createWriteStream(join(output, archive), { flags: "wx", mode: 0o600 }));
// Attach the rejection handler immediately so write failure cannot leave an unobserved stream rejection.
void completed.catch(() => undefined);
const files = [];
for (const [path, bytes] of [...contents.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
  files.push({ path, size: bytes.length, sha256: digest(bytes) });
  await new Promise((resolve, reject) => packer.entry({ name: `sunsetguard/${path}`, type: "file", mode: path === "dist/cli/bin.js" ? 0o755 : 0o644,
    uid: 0, gid: 0, uname: "", gname: "", mtime: new Date(0), size: bytes.length }, bytes, error => error ? reject(error) : resolve()));
}
packer.finalize(); await completed;
const archiveHandle = await open(join(output, archive), "r");
const archiveHash = createHash("sha256"); let archiveBytes = 0;
try { for await (const bytes of archiveHandle.createReadStream()) { archiveHash.update(bytes); archiveBytes += bytes.length; } }
finally { await archiveHandle.close(); }
const archiveSha256 = archiveHash.digest("hex");
const manifest = { format: "sunsetguard-local-trial-v1", archive, archiveSha256, archiveBytes, analyzerVersion: ANALYZER_VERSION, ruleSetVersion: RULE_SET_VERSION, files };
await writeFile(join(output, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
await writeFile(join(output, "SHA256SUMS.txt"), `${archiveSha256}  ${archive}\n`, { flag: "wx" });
process.stdout.write(JSON.stringify({ artifact: relative(workspace, output).split(sep).join("/"), archive, archiveBytes, archiveSha256, fileCount: files.length }) + "\n");
