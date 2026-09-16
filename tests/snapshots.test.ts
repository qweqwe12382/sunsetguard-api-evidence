import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureLocalSnapshot, DEFAULT_SNAPSHOT_LIMITS } from "../src/snapshots/index.js";

const temporaryBase = resolve(process.cwd(), ".test-tmp", "snapshots");
let testRoot = "";

function assertTemporaryChild(candidate: string): void {
  const pathFromBase = relative(temporaryBase, candidate);
  if (pathFromBase === "" || isAbsolute(pathFromBase) || pathFromBase === ".." || pathFromBase.startsWith("..\\") || pathFromBase.startsWith("../")) {
    throw new Error("refusing to remove a path outside the snapshot test directory");
  }
}

async function write(relativePath: string, contents: string | Uint8Array): Promise<void> {
  const destination = resolve(testRoot, relativePath);
  const pathFromRoot = relative(testRoot, destination);
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith("..\\") || pathFromRoot.startsWith("../")) {
    throw new Error("test path escaped its temporary root");
  }
  await fs.mkdir(resolve(destination, ".."), { recursive: true });
  await fs.writeFile(destination, contents);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gapCodes(result: Awaited<ReturnType<typeof captureLocalSnapshot>>): string[] {
  return result.gaps.map((gap) => gap.code);
}

beforeEach(async () => {
  testRoot = resolve(temporaryBase, `${process.pid}-${randomUUID()}`);
  assertTemporaryChild(testRoot);
  await fs.mkdir(testRoot, { recursive: true });
});

afterEach(async () => {
  assertTemporaryChild(testRoot);
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe("captureLocalSnapshot", () => {
  it("reads all supported source extensions, preserves tests/examples, and excludes declarations and build directories", async () => {
    const supported = ["a.ts", "b.tsx", "c.js", "d.jsx", "e.mts", "f.cts", "g.mjs", "h.cjs"];
    for (const path of supported) await write(`src/${path}`, "export const value = 1;\n");
    await write("src/types.d.ts", "declare const value: number;\n");
    await write("tests/retained.ts", "export {};\n");
    await write("examples/retained.js", "export {};\n");
    await write("node_modules/ignored.ts", "export {};\n");
    await write("dist/ignored.ts", "export {};\n");
    await write("coverage/ignored.ts", "export {};\n");

    const result = await captureLocalSnapshot(testRoot);

    expect(result.phase).toBe("snapshot");
    expect(result.status).toBe("complete-within-scope");
    expect(result.files.map((file) => file.path)).toEqual([
      ...supported.map((path) => `src/${path}`), "tests/retained.ts", "examples/retained.js",
    ].sort());
    expect(result.files).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/types.d.ts" }),
      expect.objectContaining({ path: "node_modules/ignored.ts" }),
    ]));
    expect(result.inventory.readFiles).toBe(10);
    expect(result.inventory.eligibleFiles).toBe(10);
    expect(result.inventory.excludedDirectories).toBe(3);
    expect(result.scope.followSymlinks).toBe(false);
    expect(result.scope.respectGitignore).toBe(false);
  });

  it("keeps Unicode and CRLF bytes exactly and derives repeatable content hashes", async () => {
    const source = Buffer.from("export const 名称 = 'x';\r\n", "utf8");
    await write("src/unicode.ts", source);

    const first = await captureLocalSnapshot(testRoot);
    const second = await captureLocalSnapshot(testRoot);
    const file = first.files[0];

    expect(file).toBeDefined();
    expect(file!.bytes).toEqual(source);
    expect(file!.contentHash).toBe(sha256(source));
    expect(first.snapshot).toEqual(second.snapshot);
    expect(await fs.readFile(resolve(testRoot, "src/unicode.ts"))).toEqual(source);
    await write("src/unicode.ts", "export const 名称 = 'changed';\r\n");
    const changed = await captureLocalSnapshot(testRoot);
    expect(changed.snapshot!.contentHash).not.toBe(first.snapshot!.contentHash);
    expect(changed.files[0]!.contentHash).not.toBe(file!.contentHash);
  });

  it("returns an honest partial result for empty input and failed acquisition for a missing root", async () => {
    const empty = await captureLocalSnapshot(testRoot);
    const missing = await captureLocalSnapshot(resolve(testRoot, "does-not-exist"));

    expect(empty.status).toBe("partial");
    expect(empty.files).toEqual([]);
    expect(gapCodes(empty)).toContain("NO_ANALYZABLE_FILES");
    expect(missing.status).toBe("failed");
    expect(missing.snapshot).toBeUndefined();
    expect(gapCodes(missing)).toContain("SOURCE_UNAVAILABLE");
  });

  it("retains already-read files and records resource limits", async () => {
    await write("c.ts", "ccc");
    await write("a.ts", "a");
    await write("b.ts", "bb");

    const fileLimit = await captureLocalSnapshot(testRoot, { limits: { maxFiles: 2 } });
    const byteLimit = await captureLocalSnapshot(testRoot, { limits: { maxTotalBytes: 3 } });
    const entryLimit = await captureLocalSnapshot(testRoot, { limits: { maxEntries: 2 } });

    expect(fileLimit.status).toBe("partial");
    expect(fileLimit.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(fileLimit.inventory.readFiles).toBe(2);
    expect(gapCodes(fileLimit)).toContain("RESOURCE_LIMIT");
    expect(byteLimit.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(gapCodes(byteLimit)).toContain("RESOURCE_LIMIT");
    expect(entryLimit.files).toEqual([]);
    expect(entryLimit.inventory.observedEntries).toBe(3);
    expect(gapCodes(entryLimit)).toContain("RESOURCE_LIMIT");
  });

  it("keeps evidence from completed directories when a later directory exceeds the entry limit", async () => {
    await write("a.ts", "kept");
    await write("z-dir/one.ts", "one");
    await write("z-dir/two.ts", "two");

    const result = await captureLocalSnapshot(testRoot, { limits: { maxEntries: 3 } });

    expect(result.status).toBe("partial");
    expect(result.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(result.inventory.observedEntries).toBe(4);
    expect(gapCodes(result)).toContain("RESOURCE_LIMIT");
  });

  it("enforces per-file bytes and directory depth without discarding earlier evidence", async () => {
    await write("a.ts", "ok");
    await write("large.ts", "four");
    await write("nested/deeper/too-deep.ts", "deep");

    const sizeLimited = await captureLocalSnapshot(testRoot, { limits: { maxFileBytes: 3 } });
    const depthLimited = await captureLocalSnapshot(testRoot, { limits: { maxDepth: 1 } });

    expect(sizeLimited.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(sizeLimited.inventory.failedOrSkippedEligibleFiles).toBeGreaterThan(0);
    expect(gapCodes(sizeLimited)).toContain("RESOURCE_LIMIT");
    expect(depthLimited.files.map((file) => file.path)).toEqual(["a.ts", "large.ts"]);
    expect(gapCodes(depthLimited)).toContain("RESOURCE_LIMIT");
  });

  it("honors pre-cancellation before reading a source file", async () => {
    await write("source.ts", "export const value = 1;\n");
    const controller = new AbortController();
    controller.abort();

    const result = await captureLocalSnapshot(testRoot, { signal: controller.signal });

    expect(result.status).toBe("partial");
    expect(result.files).toEqual([]);
    expect(result.inventory.readFiles).toBe(0);
    expect(gapCodes(result)).toContain("RESOURCE_LIMIT");
  });

  it("retains completed bytes and becomes partial when cancellation arrives on the final file", async () => {
    await write("a.ts", "export const a = 1;\n");
    await write("b.ts", "export const b = 2;\n");
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        if (String(args[0]) === resolve(testRoot, "b.ts")) controller.abort();
        return actual.open(...args);
      },
    }));
    try {
      const { captureLocalSnapshot: isolatedCapture } = await import("../src/snapshots/index.js");
      const result = await isolatedCapture(testRoot, { signal: controller.signal });

      expect(result.status).toBe("partial");
      expect(result.files.map((file) => file.path)).toEqual(["a.ts"]);
      expect(result.inventory.readFiles).toBe(1);
      expect(gapCodes(result)).toContain("RESOURCE_LIMIT");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("records a read-open failure without treating the file as a successful snapshot", async () => {
    await write("broken.ts", "export const broken = true;\n");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        if (String(args[0]) === resolve(testRoot, "broken.ts")) throw new Error("synthetic read failure");
        return actual.open(...args);
      },
    }));
    try {
      const { captureLocalSnapshot: isolatedCapture } = await import("../src/snapshots/index.js");
      const result = await isolatedCapture(testRoot);

      expect(result.status).toBe("partial");
      expect(result.files).toEqual([]);
      expect(result.inventory.failedOrSkippedEligibleFiles).toBe(1);
      expect(gapCodes(result)).toContain("FILE_READ_FAILED");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("marks a file partial when its identity changes after reading", async () => {
    await write("changed.ts", "export const changed = false;\n");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        if (String(args[0]) === resolve(testRoot, "changed.ts")) {
          const originalStat = handle.stat.bind(handle) as () => Promise<{ mtimeMs: number }>;
          let statCalls = 0;
          Object.defineProperty(handle, "stat", { value: async () => {
            const metadata = await originalStat();
            statCalls += 1;
            return statCalls === 2
              ? { ...metadata, mtimeMs: metadata.mtimeMs + 1 }
              : metadata;
          } });
        }
        return handle;
      },
    }));
    try {
      const { captureLocalSnapshot: isolatedCapture } = await import("../src/snapshots/index.js");
      const result = await isolatedCapture(testRoot);

      expect(result.status).toBe("partial");
      expect(result.files).toEqual([]);
      expect(gapCodes(result)).toContain("SNAPSHOT_CHANGED");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("does not follow a Windows directory junction outside the root", async () => {
    const outside = resolve(temporaryBase, `${process.pid}-${randomUUID()}-outside`);
    assertTemporaryChild(outside);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(resolve(outside, "canary.ts"), "export const canary = true;\n");
    await write("inside.ts", "export const inside = true;\n");
    await fs.symlink(outside, resolve(testRoot, "linked"), process.platform === "win32" ? "junction" : "dir");

    try {
      const openedPaths: string[] = [];
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.resetModules();
      vi.doMock("node:fs/promises", () => ({
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          openedPaths.push(String(args[0]));
          return actual.open(...args);
        },
      }));
      const { captureLocalSnapshot: isolatedCapture } = await import("../src/snapshots/index.js");
      const result = await isolatedCapture(testRoot);

      expect(result.files.map((file) => file.path)).toEqual(["inside.ts"]);
      expect(result.files.map((file) => Buffer.from(file.bytes).toString("utf8")).join()).not.toContain("canary");
      expect(openedPaths).toContain(resolve(testRoot, "inside.ts"));
      expect(openedPaths).not.toContain(resolve(outside, "canary.ts"));
      expect(gapCodes(result)).toContain("SYMLINK_SKIPPED");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("applies the declared platform directory case policy and does not echo untrusted limit keys", async () => {
    await write("NODE_MODULES/canary.ts", "export const escaped = true;\n");

    const result = await captureLocalSnapshot(testRoot);
    expect(result.scope.directoryCaseSensitive).toBe(process.platform !== "win32");
    if (process.platform === "win32") {
      expect(result.files).toEqual([]);
      expect(result.inventory.excludedDirectories).toBe(1);
    } else {
      expect(result.files.map(file => file.path)).toEqual(["NODE_MODULES/canary.ts"]);
      expect(result.inventory.excludedDirectories).toBe(0);
    }

    await expect(captureLocalSnapshot(testRoot, {
      limits: { "bad\u0000key": 1 } as unknown as Record<string, number>,
    })).rejects.toThrow("unknown limit");
    await expect(captureLocalSnapshot(testRoot, {
      limits: { "bad\u0000key": 1 } as unknown as Record<string, number>,
    })).rejects.not.toThrow("bad\u0000key");
  });

  it("allows callers to lower snapshot limits but rejects attempts to raise defaults", async () => {
    await write("source.ts", "export const value = true;\n");

    const lowered = await captureLocalSnapshot(testRoot, { limits: { maxFileBytes: 1 } });
    expect(lowered.scope.limits.maxFileBytes).toBe(1);
    expect(gapCodes(lowered)).toContain("RESOURCE_LIMIT");

    await expect(captureLocalSnapshot(testRoot, {
      limits: { maxFileBytes: DEFAULT_SNAPSHOT_LIMITS.maxFileBytes + 1 },
    })).rejects.toThrow("limits.maxFileBytes cannot exceed the default maximum");
    await expect(captureLocalSnapshot(testRoot, {
      limits: { timeoutMs: DEFAULT_SNAPSHOT_LIMITS.timeoutMs + 1 },
    })).rejects.toThrow("limits.timeoutMs cannot exceed the default maximum");
  });

  it("reads each supplied snapshot limit once before using the validated value", async () => {
    await write("source.ts", "export const value = true;\n");
    let reads = 0;
    const limits: Record<string, number> = {};
    Object.defineProperty(limits, "maxFileBytes", {
      enumerable: true,
      get: () => ++reads === 1 ? 1 : DEFAULT_SNAPSHOT_LIMITS.maxFileBytes + 1,
    });

    const result = await captureLocalSnapshot(testRoot, { limits });
    expect(reads).toBe(1);
    expect(result.scope.limits.maxFileBytes).toBe(1);
    expect(gapCodes(result)).toContain("RESOURCE_LIMIT");

    await expect(captureLocalSnapshot(testRoot, {
      limits: { maxFileBytes: undefined } as unknown as Record<string, number>,
    })).rejects.toThrow("limits.maxFileBytes must be a positive safe integer");
  });
});
