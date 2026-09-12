import { createHash } from "node:crypto";
import { access, link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheError, createCache, snapshotCacheHash } from "../src/cache/index.js";
import { REMOTE_LIMITS } from "../src/remote/policy.js";
import type { GitHubSnapshot } from "../src/remote/snapshot.js";
import { gitBlob } from "./helpers/remote-fixtures.js";

const fault = vi.hoisted(() => ({ recordWrite: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    if (fault.recordWrite && args[1] === "wx" && /[\\/]snapshots[\\/]/.test(String(args[0]))) {
      const write = file.writeFile.bind(file);
      file.writeFile = async (...parameters: Parameters<typeof file.writeFile>) => {
        const data = parameters[0];
        if (Buffer.isBuffer(data)) { await write(data.subarray(0, 5)); throw Error("injected disk interruption with private path"); }
        return write(...parameters);
      };
    }
    return file;
  } };
});

let base: string, source: string, cachePath: string;
const input = { repository: "owner/repo", ref: "a".repeat(40) };
beforeEach(async () => {
  const parent = resolve(".test-tmp"); await mkdir(parent, { recursive: true });
  base = await mkdtemp(join(parent, "cache-")); source = join(base, "source"); cachePath = join(base, "cache"); await mkdir(source); fault.recordWrite = false;
});
afterEach(async () => { if (dirname(base) !== resolve(".test-tmp")) throw Error("cleanup scope"); await rm(base, { recursive: true, force: true }); });
async function snapshot(files = [{ path: "nested/source.ts", text: 'import { api } from "pkg"; api();' }, { path: "package.json", text: '{"dependencies":{"pkg":"1"}}' }]): Promise<GitHubSnapshot> {
  for (const file of files) { await mkdir(dirname(join(source, file.path)), { recursive: true }); await writeFile(join(source, file.path), file.text); }
  return { status: "ready", input, commit: input.ref, treeSha: "b".repeat(40), archiveSha256: "c".repeat(64), compressedBytes: 100, expandedBytes: 4096,
    files: files.map(file => ({ path: file.path, size: Buffer.byteLength(file.text), sha256: createHash("sha256").update(file.text).digest("hex"), gitBlobSha: gitBlob(Buffer.from(file.text)) })), directory: source, dispose: async () => undefined };
}
describe("persistent bounded snapshot cache", () => {
  it("saves original bytes, reopens, checks both hashes and materializes independent disposable snapshots", async () => {
    const original = await snapshot(), store = await createCache(cachePath, [source]);
    expect(await store.putSnapshot(original, REMOTE_LIMITS)).toBe(snapshotCacheHash(original));
    const reopened = await createCache(cachePath, [source]), cached = await reopened.getSnapshot(input, REMOTE_LIMITS);
    expect(cached?.snapshotHash).toBe(snapshotCacheHash(original)); expect(cached?.snapshot.directory).not.toContain(cachePath);
    expect(await readFile(join(cached!.snapshot.directory, "nested/source.ts"), "utf8")).toBe(await readFile(join(source, "nested/source.ts"), "utf8"));
    await writeFile(join(source, "nested/source.ts"), "changed original");
    expect(await readFile(join(cached!.snapshot.directory, "nested/source.ts"), "utf8")).not.toBe("changed original");
    await Promise.all([cached!.snapshot.dispose(), cached!.snapshot.dispose()]); await expect(access(cached!.snapshot.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(cachePath, "snapshots"))).toHaveLength(1); expect(await readdir(join(cachePath, "blobs"))).toHaveLength(2);
  });
  it("never reuses a moving ref and lower retrieval limits reject oversized metadata", async () => {
    const original = await snapshot(), store = await createCache(cachePath); await store.putSnapshot(original, REMOTE_LIMITS);
    expect(await store.getSnapshot({ ...input, ref: "main" }, REMOTE_LIMITS)).toBeUndefined();
    await expect(store.getSnapshot(input, { ...REMOTE_LIMITS, maxExpandedBytes: 1 })).rejects.toBeInstanceOf(CacheError);
  });
  it("rejects corrupt metadata and leaves original cache files untouched", async () => {
    const store = await createCache(cachePath); await store.putSnapshot(await snapshot(), REMOTE_LIMITS);
    const path = join(cachePath, "snapshots", (await readdir(join(cachePath, "snapshots")))[0]!);
    await writeFile(path, '{"version":"forged"}');
    await expect(store.getSnapshot(input, REMOTE_LIMITS)).rejects.toMatchObject({ code: "CORRUPT" });
    expect(await readFile(path, "utf8")).toBe('{"version":"forged"}');
  });
  it("rejects changed raw blobs even when the record is untouched", async () => {
    const original = await snapshot(), store = await createCache(cachePath); await store.putSnapshot(original, REMOTE_LIMITS);
    await writeFile(join(cachePath, "blobs", original.files[0]!.sha256), "X".repeat(original.files[0]!.size));
    await expect(store.getSnapshot(input, REMOTE_LIMITS)).rejects.toMatchObject({ code: "CORRUPT" });
    expect(await access(join(cachePath, ".lease")).then(() => true, () => false)).toBe(false);
  });
  it("checks Git blob hashes as well as SHA-256 in checksummed records", async () => {
    const store = await createCache(cachePath); await store.putSnapshot(await snapshot(), REMOTE_LIMITS);
    const path = join(cachePath, "snapshots", (await readdir(join(cachePath, "snapshots")))[0]!);
    const envelope = JSON.parse(await readFile(path, "utf8")) as { checksum: string; value: { metadata: { files: { gitBlobSha: string }[] } } };
    envelope.value.metadata.files[0]!.gitBlobSha = "f".repeat(40); envelope.checksum = createHash("sha256").update(JSON.stringify(envelope.value)).digest("hex"); await writeFile(path, JSON.stringify(envelope));
    await expect(store.getSnapshot(input, REMOTE_LIMITS)).rejects.toMatchObject({ code: "CORRUPT" });
  });
  it("rejects cache paths inside protected roots, files and unknown pre-existing directories", async () => {
    await expect(createCache(join(source, "cache"), [source])).rejects.toMatchObject({ code: "UNSAFE" });
    await expect(access(join(source, "cache"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(cachePath, "user-owned"); await expect(createCache(cachePath)).rejects.toBeInstanceOf(CacheError);
    expect(await readFile(cachePath, "utf8")).toBe("user-owned");
    const unknown = join(base, "unknown"); await mkdir(unknown); await writeFile(join(unknown, "keep.txt"), "keep");
    await expect(createCache(unknown)).rejects.toBeInstanceOf(CacheError); expect(await readFile(join(unknown, "keep.txt"), "utf8")).toBe("keep");
  });
  it("accepts protected manifest files and absent source roots without weakening lexical boundaries", async () => {
    const manifest = join(base, "consumers.json"); await writeFile(manifest, "{}");
    await expect(createCache(cachePath, [manifest, join(base, "missing-source")])).resolves.toBeDefined();
    await mkdir(join(base, "missing-source"));
    await expect(createCache(join(base, "missing-source", "cache"), [join(base, "missing-source")])).rejects.toMatchObject({ code: "UNSAFE" });
  });
  it("rejects source roots or manifest files located inside a cache", async () => {
    await expect(createCache(cachePath, [join(cachePath, "blobs")])).rejects.toMatchObject({ code: "UNSAFE" });
    const cache = await createCache(cachePath);
    await expect(cache.assertOutsideRoots([join(cachePath, "blobs")])).rejects.toMatchObject({ code: "UNSAFE" });
    await expect(cache.assertOutsideRoots([join(cachePath, "format.json")])).rejects.toMatchObject({ code: "UNSAFE" });
    await expect(createCache(cachePath, [join(cachePath, "future-source")])).rejects.toMatchObject({ code: "UNSAFE" });
  });
  it("removes only its incomplete blob after a hash failure and allows a correct retry", async () => {
    const original = await snapshot(), store = await createCache(cachePath);
    const wrong = { ...original, files: original.files.map(file => ({ ...file, gitBlobSha: "f".repeat(40) })) };
    await expect(store.putSnapshot(wrong, REMOTE_LIMITS)).rejects.toMatchObject({ code: "CORRUPT" });
    expect(await readdir(join(cachePath, "blobs"))).toHaveLength(0); expect(await readdir(join(cachePath, "snapshots"))).toHaveLength(0);
    await expect(store.putSnapshot(original, REMOTE_LIMITS)).resolves.toBe(snapshotCacheHash(original));
  });
  it("removes a partly written record after an I/O failure without poisoning future writes", async () => {
    const original = await snapshot(), store = await createCache(cachePath); fault.recordWrite = true;
    await expect(store.putSnapshot(original, REMOTE_LIMITS)).rejects.toMatchObject({ code: "IO" });
    expect(await readdir(join(cachePath, "snapshots"))).toHaveLength(0);
    fault.recordWrite = false; await expect(store.putSnapshot(original, REMOTE_LIMITS)).resolves.toBe(snapshotCacheHash(original));
  });
  it("rejects directory junctions and hard-linked blob records without changing outside data", async () => {
    const outside = join(base, "outside"); await mkdir(outside); const alias = join(base, "alias");
    await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(createCache(join(alias, "cache"))).rejects.toBeInstanceOf(CacheError);
    const original = await snapshot(), store = await createCache(cachePath); await store.putSnapshot(original, REMOTE_LIMITS);
    const blob = join(cachePath, "blobs", original.files[0]!.sha256), twin = join(outside, "twin"); await link(blob, twin);
    await expect(store.getSnapshot(input, REMOTE_LIMITS)).rejects.toMatchObject({ code: "UNSAFE" });
    expect(await readFile(twin, "utf8")).toContain("api");
  });
  it("enforces byte, entry, record and JSON limits without evicting data", async () => {
    const original = await snapshot();
    const bytes = await createCache(cachePath, [], { limits: { maxDiskBytes: 100 } });
    await expect(bytes.putSnapshot(original, REMOTE_LIMITS)).rejects.toMatchObject({ code: "CAPACITY" });
    expect(await readdir(join(cachePath, "snapshots"))).toHaveLength(0);
    const entryCache = await createCache(join(base, "entries"), [], { limits: { maxEntries: 5 } });
    await expect(entryCache.putSnapshot(original, REMOTE_LIMITS)).rejects.toMatchObject({ code: "CAPACITY" });
    const recordCache = await createCache(join(base, "records"), [], { limits: { maxRecords: 1 } });
    await recordCache.putSnapshot(original, REMOTE_LIMITS);
    await expect(recordCache.putSnapshot({ ...original, input: { ...input, repository: "other/repo" } }, REMOTE_LIMITS)).rejects.toMatchObject({ code: "CAPACITY" });
    const jsonCache = await createCache(join(base, "json"), [], { limits: { maxRecordBytes: 100 } });
    await expect(jsonCache.putSnapshot(original, REMOTE_LIMITS)).rejects.toMatchObject({ code: "CAPACITY" });
  });
  it("does not remove an existing lease and honors cancellation/deadline before reading records", async () => {
    const store = await createCache(cachePath); await writeFile(join(cachePath, ".lease"), "other writer");
    await expect(store.getSnapshot(input, REMOTE_LIMITS)).rejects.toMatchObject({ code: "BUSY" }); expect(await readFile(join(cachePath, ".lease"), "utf8")).toBe("other writer");
    const controller = new AbortController(); controller.abort();
    await expect(store.getSnapshot(input, REMOTE_LIMITS, { signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(store.getSnapshot(input, REMOTE_LIMITS, { deadline: performance.now() - 1 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("rejects traversal even with a recomputed envelope checksum", async () => {
    const store = await createCache(cachePath); await store.putSnapshot(await snapshot(), REMOTE_LIMITS);
    const path = join(cachePath, "snapshots", (await readdir(join(cachePath, "snapshots")))[0]!);
    const data = JSON.parse(await readFile(path, "utf8")) as { checksum: string; value: { metadata: { files: { path: string }[] } } };
    data.value.metadata.files[0]!.path = "../escape"; data.checksum = createHash("sha256").update(JSON.stringify(data.value)).digest("hex"); await writeFile(path, JSON.stringify(data));
    await expect(store.getSnapshot(input, REMOTE_LIMITS)).rejects.toBeInstanceOf(CacheError); await expect(access(join(base, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
