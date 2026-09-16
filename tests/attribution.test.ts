import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttributionContext, ATTRIBUTION_LIMITS } from "../src/attribution/index.js";
import { createConfigReader } from "../src/attribution/reader.js";
import { parseApiTarget, type Binding } from "../src/domain/index.js";
import type { SnapshotFile } from "../src/snapshots/index.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});
const base = resolve(".test-tmp", "attribution");
let container: string, root: string;
const target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
const source = (path = "src/a.ts"): SnapshotFile => {
  const bytes = new TextEncoder().encode('import { oldApi } from "pkg"; oldApi();');
  return { path, bytes, contentHash: createHash("sha256").update(bytes).digest("hex") };
};
function binding(path = "src/a.ts"): Binding {
  return { id: path, targetId: target.id, location: { file: path, start: { line: 1, column: 10 }, end: { line: 1, column: 16 } },
    form: "esm-named", importSpace: "value", attribution: { status: "declared-module", reasons: [] } };
}
async function put(path: string, text: string) {
  const destination = join(root, path);
  await fs.mkdir(dirname(destination), { recursive: true });
  await fs.writeFile(destination, text);
}
async function context(files = [source()]) {
  return createAttributionContext(root, target, files);
}
async function applied(path = "src/a.ts") {
  const ctx = await context([source(path)]);
  return ctx.apply(path, [binding(path)]);
}
beforeEach(async () => {
  await fs.mkdir(base, { recursive: true });
  container = await fs.mkdtemp(join(base, "case-"));
  root = join(container, "source");
  await fs.mkdir(join(root, "src"), { recursive: true });
  vi.mocked(fs.open).mockClear();
});
afterEach(async () => {
  if (dirname(resolve(container)) !== base) throw new Error("Invalid attribution cleanup scope");
  await fs.rm(container, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("bounded source attribution", () => {
  it.each([
    ["dependencies", "dependency"], ["devDependencies", "devDependency"],
    ["peerDependencies", "peerDependency"], ["optionalDependencies", "optionalDependency"],
  ])("corroborates %s without inventing a resolved version", async (section, kind) => {
    await put("package.json", JSON.stringify({ [section]: { pkg: "^1.2.3" }, scripts: { prepare: "throw new Error('never run')" } }));
    const result = await applied();
    expect(result.bindings[0]!.attribution).toMatchObject({ status: "manifest-corroborated", dependencyKind: kind, manifestFile: "package.json" });
    expect(result.bindings[0]!.attribution).not.toHaveProperty("declaredRange");
    expect(result.bindings[0]!.attribution).not.toHaveProperty("resolvedVersion");
    expect(result.gaps).toEqual([]);
  });
  it("does not export an unrecognized high-entropy alphanumeric dependency value", async () => {
    const privateValue = "ALPHANUMERICONLYVALUE1234567890";
    await put("package.json", JSON.stringify({ dependencies: { pkg: privateValue } }));
    const result = await applied();
    expect(result.bindings[0]!.attribution).toMatchObject({
      status: "manifest-corroborated", dependencyKind: "dependency", manifestFile: "package.json",
    });
    expect(result.bindings[0]!.attribution).not.toHaveProperty("declaredRange");
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });
  it("missing manifests remain declared and never read an ancestor outside root", async () => {
    await fs.writeFile(join(container, "package.json"), '{"dependencies":{"pkg":"1.0.0"}}');
    expect((await applied()).bindings[0]!.attribution.status).toBe("declared-module");
    expect(vi.mocked(fs.open).mock.calls.some(([path]) => String(path) === join(container, "package.json"))).toBe(false);
  });
  it("uses each source's nearest manifest, including a nearest package with no target dependency", async () => {
    await put("package.json", '{"dependencies":{"pkg":"1.0.0"}}');
    await put("packages/local/package.json", '{"dependencies":{"pkg":"workspace:*"}}');
    await put("packages/empty/package.json", '{}');
    const ctx = await context([source(), source("packages/local/a.ts"), source("packages/empty/a.ts")]);
    expect(ctx.apply("src/a.ts", [binding()]).bindings[0]!.attribution.status).toBe("manifest-corroborated");
    expect(ctx.apply("packages/local/a.ts", [binding("packages/local/a.ts")]).bindings[0]!.attribution.status).toBe("ambiguous");
    expect(ctx.apply("packages/empty/a.ts", [binding("packages/empty/a.ts")]).bindings[0]!.attribution.status).toBe("declared-module");
  });
  it.each(["npm:other@1", "file:../private", "link:../private", "workspace:*", "../local", "git+https://user:secret@example.invalid/repo", "C:\\private\\data", "npm_testExampleTokenDoNotUse"])("keeps non-registry target source ambiguous without exposing its value: %s", async range => {
    await put("package.json", JSON.stringify({ dependencies: { pkg: range } }));
    const result = await applied();
    expect(result.bindings[0]!.attribution.status).toBe("ambiguous");
    expect(result.gaps.some(g => g.code === "MODULE_ATTRIBUTION_AMBIGUOUS")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(range.replaceAll("\\", "\\\\"));
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("treats a local target package and conflicting dependency ranges as candidates", async () => {
    await put("package.json", '{"name":"pkg","dependencies":{"pkg":"1.0.0"}}');
    expect((await applied()).bindings[0]!.attribution.status).toBe("ambiguous");
    await put("package.json", '{"dependencies":{"pkg":"1.0.0"},"peerDependencies":{"pkg":"2.0.0"}}');
    expect((await applied()).bindings[0]!.attribution.status).toBe("ambiguous");
  });
  it("recognizes a captured workspace target even when the consumer uses a regular range", async () => {
    await put("package.json", '{"workspaces":["packages/*"],"dependencies":{"pkg":"^1.0.0"}}');
    await put("packages/target/package.json", '{"name":"pkg","version":"1.2.3"}');
    const ctx = await context([source(), source("packages/target/index.ts")]);
    expect(ctx.apply("src/a.ts", [binding()]).bindings[0]!.attribution.status).toBe("ambiguous");
    await put("packages/target/package.json", '{"name":"unrelated","version":"1.2.3"}');
    const other = await context([source(), source("packages/target/index.ts")]);
    expect(other.apply("src/a.ts", [binding()]).bindings[0]!.attribution.status).toBe("manifest-corroborated");
  });
  it("does not treat a local package outside selected workspace patterns as the target provider", async () => {
    await put("package.json", '{"workspaces":["apps/*"],"dependencies":{"pkg":"^1.0.0"}}');
    await put("packages/target/package.json", '{"name":"pkg"}');
    const ctx = await context([source(), source("packages/target/index.ts")]);
    expect(ctx.apply("src/a.ts", [binding()]).bindings[0]!.attribution.status).toBe("manifest-corroborated");
  });
  it("unsupported workspace selector syntax is visible instead of ignored", async () => {
    await put("package.json", '{"workspaces":["packages/**"],"dependencies":{"pkg":"1.0.0"}}');
    const result = await applied();
    expect(result.bindings[0]!.attribution.status).toBe("ambiguous");
    expect(result.gaps.some(g => g.code === "CONFIG_UNRESOLVED")).toBe(true);
  });
  it.each(["{", "[]", "null", '{"dependencies":[]}', '{"dependencies":{"pkg":4}}', '{"dependencies":{"pkg":"   "}}'])("malformed manifest %s produces an unresolved gap", async text => {
    await put("package.json", text);
    const result = await applied();
    expect(result.bindings[0]!.attribution.status).toBe("ambiguous");
    expect(result.gaps.some(g => g.code === "CONFIG_UNRESOLVED")).toBe(true);
  });
  it("does not interpret prototype-shaped manifest keys as dependency declarations", async () => {
    await put("package.json", '{"__proto__":{"dependencies":{"pkg":"1.0.0"}}}');
    expect((await applied()).bindings[0]!.attribution.status).toBe("declared-module");
  });
  it.each([
    '{"dependencies":{"pkg":"workspace:*"},"dependencies":{"pkg":"1.2.3"}}',
    '{"dependencies":{"pkg":"1.2.3"},"dependencies":{"pkg":"workspace:*"}}',
    '{"dependencies":{"pkg":"file:./local","p\\u006bg":"1.2.3"}}',
  ])("duplicate manifest keys preserve source uncertainty", async text => {
    await put("package.json", text);
    const result = await applied();
    expect(result.bindings[0]!.attribution.status).toBe("ambiguous");
    expect(result.gaps.some(g => g.code === "CONFIG_UNRESOLVED")).toBe(true);
  });
  it("marks target paths candidates but leaves unrelated paths corroborated", async () => {
    await put("package.json", '{"dependencies":{"pkg":"1.0.0"}}');
    await put("tsconfig.json", '{// comment\n"compilerOptions":{"paths":{"pkg":["./local.ts"]}}}');
    expect((await applied()).bindings[0]!.attribution.status).toBe("ambiguous");
    await put("tsconfig.json", '{"compilerOptions":{"paths":{"other/*":["./local/*"]}}}');
    expect((await applied()).bindings[0]!.attribution.status).toBe("manifest-corroborated");
  });
  it("uses the nearest tsconfig and follows bounded root-relative extends", async () => {
    await put("tsconfig.json", '{"compilerOptions":{"paths":{"pkg":["./local.ts"]}}}');
    await put("src/tsconfig.json", '{}');
    expect((await applied()).bindings[0]!.attribution.status).toBe("declared-module");
    await put("src/tsconfig.json", '{"extends":"../tsconfig.json"}');
    expect((await applied()).bindings[0]!.attribution.status).toBe("ambiguous");
  });
  it.each(['{"extends":"@org/config"}', '{"extends":"../outside.json"}', '{"extends":"./absent.json"}', '{'])('unresolved config %s prevents a clean or corroborated claim', async config => {
    await put("package.json", '{"dependencies":{"pkg":"1.0.0"}}');
    await put("tsconfig.json", config);
    const result = await applied();
    expect(result.bindings[0]!.attribution.status).toBe("ambiguous");
    expect(result.gaps.some(g => g.code === "CONFIG_UNRESOLVED")).toBe(true);
    expect(vi.mocked(fs.open).mock.calls.every(([path]) => String(path).startsWith(root))).toBe(true);
  });
  it("does not execute malicious readme, AGENTS, JS config or lifecycle data", async () => {
    const body = 'throw new Error("fixture executed");';
    await put("README.md", body);
    await put("AGENTS.md", body);
    await put("tsconfig.js", body);
    await put("package.json", '{"scripts":{"prepare":"exit 99"}}');
    expect((await applied()).gaps).toEqual([]);
    const opened = vi.mocked(fs.open).mock.calls.map(([path]) => String(path));
    expect(opened.some(path => /(?:AGENTS|README|tsconfig\.js)/.test(path))).toBe(false);
  });
  it("hashes configuration bytes, paths and missing files; source bytes are not duplicated", async () => {
    const before = await context();
    await put("package.json", '{}');
    const withManifest = await context();
    expect(withManifest.contentHash).not.toBe(before.contentHash);
    expect((await context()).contentHash).toBe(withManifest.contentHash);
    const otherSource = source(); otherSource.bytes = new Uint8Array([1, 2, 3]);
    expect((await context([otherSource])).contentHash).toBe(withManifest.contentHash);
    await put("package.json", '{ "description":"only config bytes changed" }');
    expect((await context()).contentHash).not.toBe(withManifest.contentHash);
  });
  it("rejects an oversized configuration before opening it", async () => {
    await put("package.json", " ".repeat(ATTRIBUTION_LIMITS.maxFileBytes + 1));
    const result = await applied();
    expect(result.gaps.some(g => g.code === "CONFIG_UNRESOLVED")).toBe(true);
    expect(vi.mocked(fs.open).mock.calls.some(([path]) => String(path) === join(root, "package.json"))).toBe(false);
  });
  it("rejects hard-linked metadata and directory junctions without opening the canary", async () => {
    const outside = join(container, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, "package.json"), '{"dependencies":{"pkg":"1.0.0"}}');
    await fs.link(join(outside, "package.json"), join(root, "package.json"));
    expect((await applied()).bindings[0]!.attribution.status).toBe("ambiguous");
    await fs.symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect((await applied("linked/a.ts")).bindings[0]!.attribution.status).toBe("ambiguous");
    expect(vi.mocked(fs.open).mock.calls).toHaveLength(0);
  });
  it("invalid UTF-8 is visible and no absolute path or source text escapes", async () => {
    await fs.writeFile(join(root, "package.json"), new Uint8Array([0xff, 0xfe, 0x00]));
    const result = await applied();
    expect(result.gaps.some(g => g.code === "CONFIG_UNRESOLVED")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(root.replaceAll("\\", "\\\\"));
  });
  it("cancellation and zero time budget produce visible limits", async () => {
    const controller = new AbortController(); controller.abort();
    const cancelled = await createAttributionContext(root, target, [source()], { signal: controller.signal });
    expect(cancelled.gaps.some(g => g.code === "RESOURCE_LIMIT")).toBe(true);
    expect(cancelled.apply("src/a.ts", [binding()]).bindings[0]!.attribution.status).toBe("ambiguous");
    expect((await createAttributionContext(root, target, [source()], { timeoutMs: 0 })).gaps.some(g => g.code === "RESOURCE_LIMIT")).toBe(true);
    expect(vi.mocked(fs.open).mock.calls).toHaveLength(0);
  });
  it("enforces the cumulative byte budget before another open", async () => {
    const body = JSON.stringify({ padding: "x".repeat(ATTRIBUTION_LIMITS.maxFileBytes - 32) });
    for (let i = 0; i < 9; i++) await put(`configs/${i}.json`, body);
    const reader = await createConfigReader(root);
    for (let i = 0; i < 8; i++) expect((await reader.read(`configs/${i}.json`)).kind).toBe("ok");
    expect((await reader.read("configs/8.json")).kind).toBe("failed");
    expect(reader.resourceIssue).toContain("byte budget");
    expect(vi.mocked(fs.open).mock.calls).toHaveLength(8);
  });
  it("enforces configuration file counts and never reads requested root-external paths", async () => {
    for (let i = 0; i <= ATTRIBUTION_LIMITS.maxFiles; i++) await put(`configs/${i}.json`, "{}");
    const reader = await createConfigReader(root);
    for (let i = 0; i < ATTRIBUTION_LIMITS.maxFiles; i++) expect((await reader.read(`configs/${i}.json`)).kind).toBe("ok");
    expect((await reader.read(`configs/${ATTRIBUTION_LIMITS.maxFiles}.json`)).kind).toBe("failed");
    expect((await reader.read("../outside.json")).kind).toBe("failed");
    expect((await reader.read("C:/secret.json")).kind).toBe("failed");
    expect(vi.mocked(fs.open).mock.calls).toHaveLength(ATTRIBUTION_LIMITS.maxFiles);
  });
  it("counts duplicate source inputs against bounded work and bounds direct binding input", async () => {
    const ctx = await context(Array<SnapshotFile>(ATTRIBUTION_LIMITS.maxLookups + 1).fill(source()));
    expect(ctx.gaps.some(g => g.code === "RESOURCE_LIMIT")).toBe(true);
    const result = ctx.apply("src/a.ts", Array<Binding>(50_001).fill(binding()));
    expect(result.bindings).toEqual([]);
    expect(result.gaps.some(g => g.code === "RESOURCE_LIMIT")).toBe(true);
  });
  it("validates reader options without accepting arbitrary configuration or fake signals", async () => {
    await expect(createConfigReader(root, { timeoutMs: -1 })).rejects.toThrow(TypeError);
    await expect(createConfigReader(root, { timeoutMs: Number.NaN })).rejects.toThrow(TypeError);
    await expect(createConfigReader(root, { project: true } as never)).rejects.toThrow(TypeError);
    await expect(createConfigReader(root, { signal: { aborted: false } } as never)).rejects.toThrow(TypeError);
    await expect(createConfigReader(root, null as never)).rejects.toThrow(TypeError);
  });
});
