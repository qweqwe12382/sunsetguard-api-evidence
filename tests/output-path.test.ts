import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertOutputOutsideSource, isWithinRoot, UnsafeOutputPathError } from "../src/snapshots/path-policy.js";

const temporaryRoot = resolve(".test-tmp");
let sandbox: string;
let source: string;

beforeEach(async () => {
  await mkdir(temporaryRoot, { recursive: true });
  sandbox = await mkdtemp(join(temporaryRoot, "output-path-"));
  source = join(sandbox, "source");
  await mkdir(source);
  await writeFile(join(source, "input.ts"), "export const original = true;\r\n");
});

afterEach(async () => {
  if (!sandbox || sandbox === temporaryRoot || !isWithinRoot(temporaryRoot, resolve(sandbox))) {
    throw new Error("Refusing cleanup outside the test sandbox");
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe("read-only output path preflight", () => {
  it("rejects the source root and both existing and absent descendants", async () => {
    for (const output of [source, join(source, "input.ts"), join(source, "new", "report.json")]) {
      await expect(assertOutputOutsideSource(source, output)).rejects.toThrow(UnsafeOutputPathError);
    }
    expect(await readFile(join(source, "input.ts"), "utf8")).toBe("export const original = true;\r\n");
    expect(await readdir(source)).toEqual(["input.ts"]);
  });

  it.runIf(process.platform === "win32")("does not permit a Windows alternate stream on the source directory", async () => {
    await expect(assertOutputOutsideSource(source, `${source}:report.json`)).rejects.toThrow("alternate data streams");
  });

  it("allows a sibling with a common name prefix without creating it", async () => {
    const output = join(sandbox, "source-reports", "new", "report.json");
    expect(await assertOutputOutsideSource(source, output)).toBe(output);
    expect(await readdir(sandbox)).toEqual(["source"]);
  });

  it("rejects an external junction that leads back into source", async () => {
    const alias = join(sandbox, "external-alias");
    await symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(assertOutputOutsideSource(source, join(alias, "new", "report.json")))
      .rejects.toThrow("outside the source root");
  });

  it("rejects a hard-linked output which shares source bytes", async () => {
    const alias = join(sandbox, "report.json");
    await link(join(source, "input.ts"), alias);
    await expect(assertOutputOutsideSource(source, alias)).rejects.toThrow("independent regular file");
  });

  it("rejects a dangling junction ancestor instead of treating it as an absent directory", async () => {
    const alias = join(sandbox, "dangling-alias");
    await symlink(join(sandbox, "absent-target"), alias, process.platform === "win32" ? "junction" : "dir");
    await expect(assertOutputOutsideSource(source, join(alias, "report.json"))).rejects.toThrow("cannot be resolved");
  });

  it("resolves an explicitly selected source root alias", async () => {
    const alias = join(sandbox, "selected-root");
    await symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(assertOutputOutsideSource(alias, join(source, "report.json"))).rejects.toThrow("outside");
  });

  it("allows an existing external regular file without changing its contents", async () => {
    const output = join(sandbox, "external.json");
    await writeFile(output, "preserve");
    expect(await assertOutputOutsideSource(source, output)).toBe(output);
    expect(await readFile(output, "utf8")).toBe("preserve");
  });

  it("rejects nonexistent roots and a file used as a parent without leaking paths", async () => {
    await expect(assertOutputOutsideSource(join(sandbox, "missing"), join(sandbox, "out.json")))
      .rejects.toThrow("source root is not an accessible directory");
    const parent = join(sandbox, "regular-file");
    await writeFile(parent, "content");
    try {
      await assertOutputOutsideSource(source, join(parent, "out.json"));
      expect.fail("a file cannot be an output directory");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeOutputPathError);
      expect((error as Error).message).not.toContain(sandbox);
    }
  });
});
