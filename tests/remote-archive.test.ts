import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractVerifiedArchive } from "../src/remote/archive.js";
import { REMOTE_LIMITS } from "../src/remote/policy.js";
import { parseTree } from "../src/remote/tree.js";
import { bodyOf, tarBytes, treeFor, treeSha } from "./helpers/remote-fixtures.js";

const roots: string[] = [], base = resolve(".test-tmp");
async function root() { await mkdir(base, { recursive: true }); const value = await mkdtemp(join(base, "remote-")); roots.push(value); return value; }
afterEach(async () => { for (const item of roots.splice(0)) { if (dirname(item) !== base || !basename(item).startsWith("remote-")) throw Error("cleanup scope"); await rm(item, { recursive: true, force: true }); } });
const fixtures = [{ name: "src/中文.ts", text: 'import {oldApi} from "pkg"; oldApi();\r\nthrow Error("MUST NOT EXECUTE");' }];
const tree = treeFor(fixtures);
const decode = async (data: Buffer, directory: string, limits = REMOTE_LIMITS) => extractVerifiedArchive(bodyOf(data), directory, tree, limits, new AbortController().signal);

describe("streaming verified GitHub archives", () => {
  it("writes only exact verified bytes under the fresh root and ignores executable modes", async () => {
    const directory = await root();
    const bytes = await tarBytes([{ name: "wrapper/", header: { type: "directory" } }, { name: "wrapper/src/", header: { type: "directory" } }, { name: "wrapper/src/中文.ts", text: fixtures[0]!.text, header: { mode: 0o777 } }]);
    const result = await decode(bytes, directory);
    expect(result.files).toHaveLength(1); expect(result.files[0]!.gitBlobSha).toBe(tree.files[0]!.sha);
    expect(await readFile(join(directory, "src/中文.ts"), "utf8")).toBe(fixtures[0]!.text);
    expect((await lstat(join(directory, "src/中文.ts"))).isFile()).toBe(true);
    expect(result.compressedBytes).toBe(bytes.length);
  });

  it.each(["../escape.ts", "/absolute.ts", "wrapper/../escape.ts", "wrapper/C:/escape.ts", "wrapper/src\\escape.ts", "wrapper/src/file.ts:ads", "wrapper/NUL.ts", "wrapper/src/trail. ", "wrapper/.git/config", "wrapper//empty.ts"])("rejects unsafe archive path %s without writing files", async name => {
    const directory = await root();
    await expect(decode(await tarBytes([{ name, text: "canary" }]), directory)).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["symlink", "link", "fifo", "character-device", "block-device"] as const)("rejects %s entries without following a link", async type => {
    const directory = await root();
    await expect(decode(await tarBytes([{ name: "wrapper/src/中文.ts", header: { type, linkname: "../../canary" } }]), directory)).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects duplicate names, mixed archive roots, wrong hashes and missing tracked entries", async () => {
    const valid = { name: "wrapper/src/中文.ts", text: fixtures[0]!.text };
    await expect(decode(await tarBytes([valid, valid]), await root())).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    await expect(decode(await tarBytes([valid, { name: "different/", header: { type: "directory" } }]), await root())).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    await expect(decode(await tarBytes([{ ...valid, text: "x".repeat(Buffer.byteLength(valid.text)) }]), await root())).rejects.toMatchObject({ code: "COMMIT_MISMATCH" });
    await expect(decode(await tarBytes([]), await root())).rejects.toMatchObject({ code: "COMMIT_MISMATCH" });
  });

  it("checks PAX paths after override, including long Unicode filenames", async () => {
    await expect(decode(await tarBytes([{ name: "wrapper/src/中文.ts", text: fixtures[0]!.text, header: { pax: { path: "../../escape.ts" } } }]), await root())).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    const file = { name: `src/${"名".repeat(70)}.ts`, text: "export const x = 1;" };
    const result = await extractVerifiedArchive(bodyOf(await tarBytes([{ name: `wrapper/${file.name}`, text: file.text }])), await root(), treeFor([file]), REMOTE_LIMITS, new AbortController().signal);
    expect(result.files[0]!.path).toBe(file.name);
  });

  it("bounds compressed bytes and decompressed metadata, rejects truncation and corruption", async () => {
    const bytes = await tarBytes([{ name: "wrapper/src/中文.ts", text: fixtures[0]!.text }]);
    await expect(extractVerifiedArchive(bodyOf(bytes), await root(), tree, { ...REMOTE_LIMITS, maxCompressedBytes: 10 }, new AbortController().signal)).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    await expect(extractVerifiedArchive(bodyOf(gzipSync(Buffer.alloc(100_000))), await root(), tree, { ...REMOTE_LIMITS, maxExpandedBytes: 1024 }, new AbortController().signal)).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    await expect(decode(bytes.subarray(0, bytes.length - 8), await root())).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    await expect(decode(Buffer.from("not a gzip archive"), await root())).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    const raw = await tarBytes([{ name: "wrapper/src/中文.ts", text: fixtures[0]!.text }], false);
    raw[0] = raw[0]! ^ 1;
    await expect(decode(gzipSync(raw), await root())).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
  });

  it("cancels a stalled HTTP body when invalid gzip bytes fail early", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("not gzip")); }, cancel() { cancelled = true; } });
    await expect(extractVerifiedArchive(stalled, await root(), tree, REMOTE_LIMITS, new AbortController().signal)).rejects.toMatchObject({ code: "UNSAFE_ARCHIVE" });
    expect(cancelled).toBe(true);
  });

  it("rejects truncated trees, links/submodules, parent conflicts and portable path collisions", () => {
    const row = { path: "source.ts", type: "blob", mode: "100644", size: 2, sha: "c".repeat(40) };
    const value = { sha: treeSha, truncated: false, tree: [row] };
    expect(parseTree(value, treeSha, REMOTE_LIMITS).files).toHaveLength(1);
    for (const bad of [{ ...value, truncated: true }, { ...value, sha: "d".repeat(40) }, { ...value, tree: [{ ...row, path: "missing/source.ts" }] }]) expect(() => parseTree(bad, treeSha, REMOTE_LIMITS)).toThrow();
    for (const mode of ["120000", "160000"]) expect(() => parseTree({ ...value, tree: [{ ...row, mode }] }, treeSha, REMOTE_LIMITS)).toThrow();
    expect(() => parseTree({ ...value, tree: [row, { ...row, path: "SOURCE.ts" }] }, treeSha, REMOTE_LIMITS)).toThrow();
    expect(() => parseTree({ ...value, tree: [row, { ...row, path: "source.ts/child" }] }, treeSha, REMOTE_LIMITS)).toThrow();
    expect(() => parseTree(value, treeSha, { ...REMOTE_LIMITS, maxExpandedBytes: 1 })).toThrow();
  });
});
