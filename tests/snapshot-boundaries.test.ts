import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLocalSnapshot, isWithinRoot } from "../src/snapshots/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open), opendir: vi.fn(original.opendir) };
});
const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const temporaryBase = resolve(".test-tmp");
let root: string;

beforeEach(async () => {
  vi.mocked(fs.open).mockImplementation(realFs.open);
  vi.mocked(fs.opendir).mockImplementation(realFs.opendir);
  await fs.mkdir(temporaryBase, { recursive: true });
  root = await fs.mkdtemp(join(temporaryBase, "snapshot-boundary-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!root || root === temporaryBase || !isWithinRoot(temporaryBase, root)) throw new Error("Unsafe test cleanup");
  await fs.rm(root, { recursive: true, force: true });
});

describe("snapshot failure and cancellation boundaries", () => {
  it("charges discarded changed-file bytes to the total read budget", async () => {
    await fs.writeFile(join(root, "a.ts"), "aaaa");
    await fs.writeFile(join(root, "b.ts"), "bbbb");
    const originalOpen = realFs.open;
    let readBytes = 0;
    let openedFiles = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      openedFiles++;
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        readBytes += result.bytesRead;
        if (result.bytesRead > 0) await fs.appendFile(args[0], "changed");
        return result;
      });
      return handle;
    });
    const result = await captureLocalSnapshot(root, { limits: { maxTotalBytes: 4 } });
    expect(result.status).toBe("partial");
    expect(result.files).toEqual([]);
    expect(readBytes).toBe(4);
    expect(openedFiles).toBe(1);
    expect(result.gaps.map(gap => gap.code)).toEqual(expect.arrayContaining(["SNAPSHOT_CHANGED", "RESOURCE_LIMIT"]));
    expect(result.inventory.eligibleFiles).toBe(result.inventory.readFiles + result.inventory.failedOrSkippedEligibleFiles);
  });

  it("rejects short EOF even if metadata does not reveal a change", async () => {
    await fs.writeFile(join(root, "source.ts"), "unread bytes");
    const originalOpen = realFs.open;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      vi.spyOn(handle, "read").mockImplementation(async () => ({
        bytesRead: 0,
        buffer: Buffer.alloc(0),
      }));
      return handle;
    });
    const result = await captureLocalSnapshot(root);
    expect(result.files).toEqual([]);
    expect(result.gaps.map(gap => gap.code)).toContain("SNAPSHOT_CHANGED");
    expect(result.inventory.failedOrSkippedEligibleFiles).toBe(1);
  });

  it("closes the last file and marks capture partial when cancelled during its read", async () => {
    await fs.writeFile(join(root, "only.ts"), "data");
    const controller = new AbortController();
    const originalOpen = realFs.open;
    let closeCount = 0;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        controller.abort();
        return result;
      });
      vi.spyOn(handle, "close").mockImplementation(async () => { closeCount++; await close(); });
      return handle;
    });
    const result = await captureLocalSnapshot(root, { signal: controller.signal });
    expect(closeCount).toBe(1);
    expect(result.status).toBe("partial");
    expect(result.files).toEqual([]);
    expect(result.inventory.failedOrSkippedEligibleFiles).toBe(1);
    expect(result.gaps.some(gap => gap.code === "RESOURCE_LIMIT" && /cancelled/i.test(gap.message))).toBe(true);
  });

  it("distinguishes an unreadable root from an empty accessible directory", async () => {
    vi.mocked(fs.opendir).mockRejectedValue(Object.assign(new Error("private diagnostic"), { code: "EACCES" }));
    const result = await captureLocalSnapshot(root);
    expect(result.status).toBe("failed");
    expect(result.snapshot).toBeUndefined();
    expect(result.gaps.map(gap => gap.code)).toEqual(["SOURCE_UNAVAILABLE"]);
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("checks the monotonic deadline after a read instead of returning complete", async () => {
    await fs.writeFile(join(root, "only.ts"), "data");
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await realFs.open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        clock = 2;
        return result;
      });
      return handle;
    });
    const result = await captureLocalSnapshot(root, { limits: { timeoutMs: 1 } });
    expect(result.status).toBe("partial");
    expect(result.files).toEqual([]);
    expect(result.gaps.some(gap => gap.code === "RESOURCE_LIMIT" && /time budget/.test(gap.message))).toBe(true);
  });

  it("treats explicitly excluded linked directories as scope exclusions", async () => {
    const source = join(root, "source");
    const outside = join(root, "outside");
    await fs.mkdir(source);
    await fs.mkdir(outside);
    await fs.writeFile(join(source, "safe.ts"), "safe bytes");
    await fs.writeFile(join(outside, "canary.ts"), "outside bytes");
    await fs.symlink(outside, join(source, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const opened: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args) => { opened.push(String(args[0])); return realFs.open(...args); });
    const result = await captureLocalSnapshot(source);
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.inventory.excludedDirectories).toBe(1);
    expect(opened).toEqual([join(source, "safe.ts")]);
  });
});
