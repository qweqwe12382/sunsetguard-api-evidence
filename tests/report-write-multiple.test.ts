import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const staging = vi.hoisted(() => ({
  onOpen: undefined as (() => Promise<void>) | undefined,
  uuid: undefined as `${string}-${string}-${string}-${string}-${string}` | undefined,
  inaccessible: "",
  inspectPath: "",
  beforeInspect: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => staging.uuid ?? actual.randomUUID() };
});

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (args[0] === staging.inaccessible) {
        const error = new Error(`Cannot inspect ${staging.inaccessible}`) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      if (args[0] === staging.inspectPath && staging.beforeInspect !== undefined) {
        const callback = staging.beforeInspect;
        staging.beforeInspect = undefined;
        await callback();
      }
      return actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (typeof args[0] === "string" && args[0].includes(".sunsetguard-") && staging.onOpen !== undefined) {
        const callback = staging.onOpen;
        staging.onOpen = undefined;
        await callback();
      }
      return handle;
    },
  };
});

import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { writeReportOutsideSource, writeReportOutsideSources } from "../src/reports/write.js";

const temporaryBase = resolve(".test-tmp", "report-write-multiple");
let sandbox = "";
let first = "";
let second = "";
let reports = "";

beforeEach(async () => {
  staging.onOpen = undefined;
  staging.uuid = undefined;
  staging.inaccessible = "";
  staging.inspectPath = "";
  staging.beforeInspect = undefined;
  await mkdir(temporaryBase, { recursive: true });
  sandbox = await mkdtemp(join(temporaryBase, `${process.pid}-`));
  first = join(sandbox, "first");
  second = join(sandbox, "second");
  reports = join(sandbox, "reports");
  await Promise.all([mkdir(first), mkdir(second), mkdir(reports)]);
});

afterEach(async () => {
  staging.onOpen = undefined;
  staging.uuid = undefined;
  staging.inaccessible = "";
  staging.inspectPath = "";
  staging.beforeInspect = undefined;
  const child = relative(temporaryBase, resolve(sandbox));
  if (child === "" || isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\")) {
    throw new Error("refusing cleanup outside the multiple-report test directory");
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe("writeReportOutsideSources", () => {
  it("publishes outside every source, manifest file and cache without staging leftovers", async () => {
    const manifest = join(sandbox, "consumers.json");
    const cache = join(sandbox, "cache");
    await writeFile(manifest, "{\"version\":1}");
    await mkdir(cache);
    const output = join(reports, "report.md");
    await writeReportOutsideSources([first, second, first, manifest, cache], output, "# 名称\n");
    expect(await readFile(output, "utf8")).toBe("# 名称\n");
    expect(await readdir(reports)).toEqual(["report.md"]);
    expect(await readFile(manifest, "utf8")).toBe("{\"version\":1}");
    expect(await readdir(first)).toEqual([]);
    expect(await readdir(second)).toEqual([]);
    expect(await readdir(cache)).toEqual([]);
  });

  it("protects each input root even when the destination is outside the first", async () => {
    for (const root of [first, second]) {
      await expect(writeReportOutsideSources([first, second], join(root, "report.json"), "forbidden")).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    }
  });

  it("writes remote-only reports and still requires an existing output parent", async () => {
    const output = join(reports, "remote.json");
    await writeReportOutsideSources([], output, "{\"attempted\":1}\n");
    expect(await readFile(output, "utf8")).toBe("{\"attempted\":1}\n");
    await expect(writeReportOutsideSources([], join(reports, "missing", "report.json"), "forbidden")).rejects.toThrow();
    expect(await readdir(reports)).toEqual(["remote.json"]);
  });

  it("allows failed missing sources and file inputs while preserving single-root validation", async () => {
    const missing = join(first, "missing", "nested");
    const fileInput = join(second, "input.ts");
    await writeFile(fileInput, "throw new Error('never execute');");
    const output = join(reports, "failed-inputs.json");
    await writeReportOutsideSources([missing, fileInput], output, "{\"failed\":2}");
    expect(await readFile(output, "utf8")).toBe("{\"failed\":2}");
    expect(await readFile(fileInput, "utf8")).toBe("throw new Error('never execute');");
    await expect(writeReportOutsideSource(missing, join(reports, "single-missing.json"), "forbidden")).rejects.toThrow();
    await expect(writeReportOutsideSource(fileInput, join(reports, "single-file.json"), "forbidden")).rejects.toThrow();
    expect(await readdir(reports)).toEqual(["failed-inputs.json"]);
  });

  it("reserves missing roots through both lexical and canonical ancestor paths", async () => {
    const alias = join(sandbox, "source-alias");
    await symlink(second, alias, process.platform === "win32" ? "junction" : "dir");
    const missingRoot = join(alias, "missing-source");
    for (const output of [missingRoot, join(second, "missing-source")]) {
      await expect(writeReportOutsideSources([missingRoot], output, "forbidden")).rejects.toThrow();
    }
    await writeReportOutsideSources([missingRoot], join(reports, "report.json"), "allowed");
    expect(await readdir(second)).toEqual([]);
    expect(await readFile(join(reports, "report.json"), "utf8")).toBe("allowed");
  });

  it("protects the manifest file itself and never replaces it or its hard-link alias", async () => {
    const manifest = join(sandbox, "consumers.json");
    const alias = join(reports, "manifest-alias.json");
    await writeFile(manifest, "manifest-original");
    await link(manifest, alias);
    await expect(writeReportOutsideSources([first, manifest], manifest, "forbidden")).rejects.toThrow();
    await expect(writeReportOutsideSources([manifest], alias, "forbidden")).rejects.toThrow();
    expect(await readFile(manifest, "utf8")).toBe("manifest-original");
    expect(await readdir(reports)).toEqual(["manifest-alias.json"]);
  });

  it("rejects an output parent link into another input and preserves an external link's prior behavior", async () => {
    const sourceAlias = join(sandbox, "second-alias");
    const reportAlias = join(sandbox, "report-alias");
    await symlink(second, sourceAlias, process.platform === "win32" ? "junction" : "dir");
    await symlink(reports, reportAlias, process.platform === "win32" ? "junction" : "dir");
    await expect(writeReportOutsideSources([first, second], join(sourceAlias, "forbidden.json"), "forbidden")).rejects.toThrow();
    await writeReportOutsideSource(first, join(reportAlias, "allowed.json"), "allowed");
    expect(await readdir(second)).toEqual([]);
    expect(await readFile(join(reports, "allowed.json"), "utf8")).toBe("allowed");
  });

  it("never overwrites an existing destination even with no source boundaries", async () => {
    const output = join(reports, "existing.json");
    await writeFile(output, "preserve-existing");
    await expect(writeReportOutsideSources([], output, "forbidden")).rejects.toThrow("safely published");
    expect(await readFile(output, "utf8")).toBe("preserve-existing");
    expect(await readdir(reports)).toEqual(["existing.json"]);
  });

  it.each(["NUL.json", "CON.txt", "LPT¹.log", "report.json:stream", "trailing. "])(
    "rejects device, ADS and alias destinations without exposing paths: %s", async name => {
      const output = join(reports, name);
      const failure = await writeReportOutsideSources([], output, "forbidden").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("safely published");
      expect(String(failure)).not.toContain(sandbox);
      expect(await readdir(reports)).toEqual([]);
    },
  );

  it("checks the temporary file against all roots before opening it", async () => {
    staging.uuid = "00000000-0000-0000-0000-000000000001";
    const reservedStaging = join(reports, `.sunsetguard-${staging.uuid}.tmp`);
    await expect(writeReportOutsideSources([reservedStaging], join(reports, "report.json"), "forbidden")).rejects.toThrow();
    expect(await readdir(reports)).toEqual([]);
  });

  it("fails and removes only its temporary file when a missing boundary appears during writing", async () => {
    const missingRoot = join(first, "appeared-source");
    staging.onOpen = async () => { await mkdir(missingRoot); };
    await expect(writeReportOutsideSources([missingRoot], join(reports, "report.json"), "forbidden")).rejects.toThrow();
    expect(await readdir(reports)).toEqual([]);
    expect(await readdir(first)).toEqual(["appeared-source"]);
  });

  it("rejects an inaccessible boundary without leaking the filesystem error or staging output", async () => {
    staging.inaccessible = join(first, "inaccessible-source");
    const failure = await writeReportOutsideSources([staging.inaccessible], join(reports, "report.json"), "forbidden")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("safely published");
    expect(String(failure)).not.toContain(sandbox);
    expect(String(failure)).not.toContain("EACCES");
    expect(await readdir(reports)).toEqual([]);
  });

  it("does not unlink a replacement staging file through a changed output parent", async () => {
    staging.uuid = "00000000-0000-0000-0000-000000000002";
    const temporaryName = `.sunsetguard-${staging.uuid}.tmp`;
    const previousParent = join(sandbox, "previous-reports");
    staging.inspectPath = join(reports, temporaryName);
    staging.beforeInspect = async () => {
      await rename(reports, previousParent);
      await mkdir(reports);
      await writeFile(join(reports, temporaryName), "user-replacement");
    };
    await expect(writeReportOutsideSources([first, second], join(reports, "report.json"), "forbidden")).rejects.toThrow();
    expect(await readFile(join(reports, temporaryName), "utf8")).toBe("user-replacement");
    expect(await readdir(reports)).toEqual([temporaryName]);
    // The original directory was moved by another actor; safe cleanup must not
    // search for it or remove anything through the replacement parent.
    expect(await readdir(previousParent)).toEqual([temporaryName]);
  });

  it("fails when a source is replaced by an alias during staging without deleting user directories", async () => {
    const previousSource = join(sandbox, "previous-source");
    staging.onOpen = async () => {
      await rename(second, previousSource);
      await symlink(reports, second, process.platform === "win32" ? "junction" : "dir");
    };
    await expect(writeReportOutsideSources([first, second], join(reports, "report.json"), "forbidden")).rejects.toThrow();
    expect(await readdir(reports)).toEqual([]);
    expect(await readdir(previousSource)).toEqual([]);
    expect(await readdir(second)).toEqual([]);
  });
});
