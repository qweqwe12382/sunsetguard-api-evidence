import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const linkControl = vi.hoisted(() => ({ mode: "pass" as "pass" | "fail" | "occupy", destination: "", contents: "" }));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (linkControl.mode === "fail") {
        const error = new Error("synthetic publish failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      if (linkControl.mode === "occupy") await actual.writeFile(linkControl.destination, linkControl.contents, { flag: "wx" });
      return actual.link(...args);
    },
  };
});

import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { writeReportOutsideSource } from "../src/reports/write.js";

const temporaryBase = resolve(".test-tmp", "report-write");
let sandbox = "";
let sourceRoot = "";
let outputRoot = "";

function assertTemporaryChild(candidate: string): void {
  const child = relative(temporaryBase, resolve(candidate));
  if (child === "" || isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\")) {
    throw new Error("refusing cleanup outside the report-write test directory");
  }
}

beforeEach(async () => {
  linkControl.mode = "pass";
  linkControl.destination = "";
  linkControl.contents = "";
  await mkdir(temporaryBase, { recursive: true });
  sandbox = await mkdtemp(join(temporaryBase, `${process.pid}-`));
  sourceRoot = join(sandbox, "source");
  outputRoot = join(sandbox, "reports");
  await mkdir(sourceRoot);
  await mkdir(outputRoot);
  await writeFile(join(sourceRoot, "input.ts"), "export const original = true;\r\n");
});

afterEach(async () => {
  linkControl.mode = "pass";
  assertTemporaryChild(sandbox);
  await rm(sandbox, { recursive: true, force: true });
});

describe("writeReportOutsideSource", () => {
  it("publishes the complete bytes outside source without leaving a temporary file", async () => {
    const destination = join(outputRoot, "report.json");
    const contents = "{\n  \"message\": \"名称`\\r\\n\"\n}\n";

    await writeReportOutsideSource(sourceRoot, destination, contents);

    expect(await readFile(destination, "utf8")).toBe(contents);
    expect(await readdir(outputRoot)).toEqual(["report.json"]);
    expect(await readFile(join(sourceRoot, "input.ts"), "utf8")).toBe("export const original = true;\r\n");
  });

  it("does not overwrite an existing external file", async () => {
    const destination = join(outputRoot, "report.json");
    await writeFile(destination, "preserve-existing");

    await expect(writeReportOutsideSource(sourceRoot, destination, "replacement")).rejects.toThrow();

    expect(await readFile(destination, "utf8")).toBe("preserve-existing");
    expect(await readdir(outputRoot)).toEqual(["report.json"]);
  });

  it.each(["report.json", "nested/report.json"])("rejects a destination inside source: %s", async relativePath => {
    const destination = join(sourceRoot, relativePath);
    await expect(writeReportOutsideSource(sourceRoot, destination, "forbidden")).rejects.toThrow();
    await expect(readFile(destination, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an external directory link that resolves into source", async () => {
    const alias = join(sandbox, "source-alias");
    await symlink(sourceRoot, alias, process.platform === "win32" ? "junction" : "dir");

    await expect(writeReportOutsideSource(sourceRoot, join(alias, "report.json"), "forbidden")).rejects.toThrow();
    expect(await readdir(sourceRoot)).toEqual(["input.ts"]);
  });

  it("does not replace a hard-link destination", async () => {
    const hardlinkDestination = join(outputRoot, "hardlink.json");
    await link(join(sourceRoot, "input.ts"), hardlinkDestination);

    await expect(writeReportOutsideSource(sourceRoot, hardlinkDestination, "replacement")).rejects.toThrow();

    expect(await readFile(join(sourceRoot, "input.ts"), "utf8")).toBe("export const original = true;\r\n");
    expect(await readdir(outputRoot)).toEqual(["hardlink.json"]);
  });

  it("does not replace a symlink destination", async context => {
    const symlinkDestination = join(outputRoot, "symlink.json");
    try {
      await symlink(join(sourceRoot, "input.ts"), symlinkDestination, "file");
    } catch (error) {
      if (process.platform === "win32" && typeof error === "object" && error !== null && "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")) {
        context.skip("Windows denied creation of the file symlink; junction and hard-link tests still run.");
      }
      throw error;
    }
    await expect(writeReportOutsideSource(sourceRoot, symlinkDestination, "replacement")).rejects.toThrow();
    expect(await readFile(join(sourceRoot, "input.ts"), "utf8")).toBe("export const original = true;\r\n");
  });

  it("requires the destination parent to exist and leaves no partial directory", async () => {
    const missingParent = join(outputRoot, "missing", "report.json");
    await expect(writeReportOutsideSource(sourceRoot, missingParent, "contents")).rejects.toThrow();
    expect(await readdir(outputRoot)).toEqual([]);
  });

  it("removes the temporary file when atomic no-clobber publication fails", async () => {
    const destination = join(outputRoot, "report.json");
    linkControl.mode = "fail";

    await expect(writeReportOutsideSource(sourceRoot, destination, "contents")).rejects.toThrow("safely published");

    await expect(readFile(destination, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(outputRoot)).toEqual([]);
  });

  it("preserves a destination created immediately before atomic publication", async () => {
    const destination = join(outputRoot, "report.json");
    linkControl.mode = "occupy";
    linkControl.destination = destination;
    linkControl.contents = "won-the-race";

    await expect(writeReportOutsideSource(sourceRoot, destination, "must-not-overwrite")).rejects.toThrow("safely published");

    expect(await readFile(destination, "utf8")).toBe("won-the-race");
    expect(await readdir(outputRoot)).toEqual(["report.json"]);
  });

  it.runIf(process.platform === "win32")("rejects Windows alternate data stream destinations", async () => {
    const destination = join(outputRoot, "report.json:stream");
    await expect(writeReportOutsideSource(sourceRoot, destination, "forbidden")).rejects.toThrow();
    expect(await readdir(outputRoot)).toEqual([]);
  });
});
