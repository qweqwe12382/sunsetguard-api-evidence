import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONSUMERS_LIMITS, readConsumers } from "../src/scans/consumers.js";

const base = resolve(".test-tmp/consumers");
let root: string, manifest: string;
beforeEach(async () => { await mkdir(base, { recursive: true }); root = await mkdtemp(join(base, "input-")); manifest = join(root, "consumers.json"); });
afterEach(async () => { if (dirname(root) !== base) throw Error("Unsafe test cleanup"); await rm(root, { recursive: true, force: true }); });
const github = (repository = "Owner/Repo", ref = "main") => ({ kind: "github", repository, ref });
const save = (repositories: unknown[]) => writeFile(manifest, JSON.stringify({ schemaVersion: "0.1", repositories }));

describe("bounded explicit consumers plans", () => {
  it("normalizes identity and deduplicates without star or activity filters", async () => {
    await save([github(), github("owner/repo"), github("small/new", "v1")]);
    expect(await readConsumers(manifest)).toMatchObject({ selected: 3, duplicates: 1, entries: [
      { kind: "github", repository: "owner/repo", ref: "main", repositoryId: "github:owner/repo" },
      { repositoryId: "github:small/new" },
    ] });
  });
  it("canonicalizes full SHA case and rejects distinct refs in one sample", async () => {
    await save([github("owner/repo", "A".repeat(40)), github("owner/repo", "a".repeat(40))]);
    expect((await readConsumers(manifest)).duplicates).toBe(1);
    await save([github("owner/repo", "main"), github("OWNER/REPO", "v1")]);
    await expect(readConsumers(manifest)).rejects.toThrow("Multiple refs");
  });
  it("resolves relative local paths against the manifest and hashes paths rather than exporting them", async () => {
    await mkdir(join(root, "source"));
    await save([{ kind: "local", path: "./source" }, { kind: "local", path: join(root, "source") }, github()]);
    const plan = await readConsumers(manifest);
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries[0]).toMatchObject({ path: join(root, "source"), repositoryId: expect.stringMatching(/^local:[a-f0-9]{64}$/) });
    expect(plan.entries[1]!.repositoryId).not.toBe(plan.entries[0]!.repositoryId);
  });
  it("deduplicates explicit local aliases via canonical identity", async () => {
    await mkdir(join(root, "source"));
    await symlink(join(root, "source"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await save([{ kind: "local", path: "source" }, { kind: "local", path: "alias" }]);
    expect((await readConsumers(manifest)).duplicates).toBe(1);
    await save([{ kind: "local", path: "source/missing" }, { kind: "local", path: "alias/missing" }]);
    expect((await readConsumers(manifest)).duplicates).toBe(1);
  });
  it("retains unavailable local entries for unknown results and never executes source data", async () => {
    const command = 'throw new Error("must not execute");';
    await writeFile(join(root, "README.md"), command);
    await save([{ kind: "local", path: "missing" }]);
    expect((await readConsumers(manifest)).entries).toHaveLength(1);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(command);
  });
  it.each([
    [], [github("https://github.com/owner/repo")], [github("owner/repo.git")], [github("owner/repo.GIT")], [github("owner/repo", "")],
    [{ ...github(), stars: 1000 }], [{ kind: "local", path: "" }], [{ kind: "local", path: "x\0y" }],
    [{ kind: "url", url: "http://127.0.0.1/" }], Array.from({ length: CONSUMERS_LIMITS.maxEntries + 1 }, () => github()),
  ].map(entries => ({ entries })))("rejects unsupported or over-limit input without echoing it %#", async ({ entries }) => {
    await save(entries);
    await expect(readConsumers(manifest)).rejects.toThrow("supported repository entries");
  });
  it.each([
    '{"schemaVersion":"0.1","repositories":[],"repositories":[{"kind":"github","repository":"o/r","ref":"main"}]}',
    '{"schemaVersion":"0.1","repositories":[{"kind":"github","repository":"o/r","repository":"p/r","ref":"main"}]}',
    "[".repeat(10000) + "]".repeat(10000),
    " ".repeat(CONSUMERS_LIMITS.maxBytes + 1), "not json", '{"schemaVersion":"0.1","repositories":[],"secret":"canary"}',
  ])("rejects malformed, duplicate-key, deep, or oversized JSON %#", async contents => {
    await writeFile(manifest, contents);
    await expect(readConsumers(manifest)).rejects.toThrow();
  });
  it("rejects invalid UTF-8 bytes", async () => {
    await writeFile(manifest, Buffer.from([0xff, 0xfe]));
    await expect(readConsumers(manifest)).rejects.toThrow();
  });
});
