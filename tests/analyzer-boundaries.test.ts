import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseApiTarget } from "../src/domain/index.js";
import { analyzeFile } from "../src/analyzer/index.js";

const target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
function analyze(body: string, prefix = 'import { oldApi } from "pkg";\n') {
  const bytes = Buffer.from(prefix + body);
  return analyzeFile({ path: "consumer.ts", bytes, contentHash: createHash("sha256").update(bytes).digest("hex") }, target);
}

describe("binding and syntax boundary regressions", () => {
  it.each([
    ['const obj = { oldApi: 1, other: 2 }; obj.oldApi; oldApi: while(false) { break oldApi; }', 0],
    ['const obj = { oldApi }; const computed = { [oldApi]: 1 };', 2],
    ['const f = function oldApi() { return oldApi; }; oldApi();', 1],
    ['function f(other = oldApi) {}', 1],
    ['for (let oldApi of []) { oldApi(); } oldApi();', 1],
    ['try {} catch (oldApi) { oldApi(); } oldApi();', 1],
    ['typeof oldApi;', 1],
    ['class Consumer extends oldApi {}', 1],
  ])("counts direct value bindings in %s", (body, expected) => {
    const result = analyze(body);
    expect(result.status).toBe("complete-within-scope");
    expect(result.findings.filter(finding => finding.kind === "value-reference")).toHaveLength(expected);
    expect(result.findings.filter(finding => finding.kind === "import-only")).toHaveLength(expected === 0 ? 1 : 0);
  });

  it.each([
    'type Fn = typeof oldApi;',
    'interface Shape { [oldApi]: string; }',
    'class Consumer implements oldApi {}',
  ])("keeps erased type context out of value findings: %s", body => {
    const result = analyze(body);
    expect(result.findings.filter(finding => finding.kind === "value-reference")).toEqual([]);
    expect(result.findings.map(finding => finding.kind)).toEqual(["type-reference"]);
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
  });

  it("does not treat unrelated exports or a default import as the requested named export", () => {
    const result = analyze('', 'import oldApi from "pkg"; oldApi(); export { otherApi } from "pkg";');
    expect(result.findings).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it("does not attribute a shadowed require function to the package", () => {
    const result = analyze('function run(require: (s: string) => unknown) { require("pkg"); }');
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.findings.map(finding => finding.kind)).toEqual(["import-only"]);
  });

  it("does not silently accept conflicting declarations as reliable value references", () => {
    const result = analyze('const oldApi = () => {}; oldApi();');
    expect(result.status).toBe("partial");
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.findings.filter(finding => finding.kind === "value-reference")).toEqual([]);
  });

  it.each(['export { oldApi };', 'export { oldApi as forwarded };',
    'import alias = oldApi;', 'export import alias = oldApi;'])(
    "retains import evidence alongside an unsupported propagation gap: %s", body => {
      const result = analyze(body);
      expect(result.status).toBe("partial");
      expect(result.findings.map(finding => finding.kind)).toEqual(["import-only"]);
      expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
    });

  it("migrates the former type-query gap to type evidence", () => {
    const result = analyze('type F = typeof oldApi;');
    expect(result.status).toBe("complete-within-scope");
    expect(result.findings.map(finding => finding.kind)).toEqual(["type-reference"]);
    expect(result.gaps).toEqual([]);
  });

  it.each([
    'export * as namespace from "pkg";',
    'export * from "pkg";',
    'import api = require("pkg");',
    'type T = import("pkg").oldApi;',
    'type T = import("pkg").oldApi.Nested;',
    'type T = typeof import("pkg");',
  ])("does not silently omit unsupported target module patterns: %s", source => {
    const result = analyze(source, "");
    expect(result.status).toBe("partial");
    expect(result.findings).toEqual([]);
    expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
  });

  it.each(['type T = import("pkg").Other;', 'type T = import("other").oldApi;',
    'type T = import("pkg").Other.oldApi;'])(
    "does not let unrelated import types contaminate the target: %s", source => {
      const result = analyze(source, "");
      expect(result.status).toBe("complete-within-scope");
      expect(result.gaps).toEqual([]);
    });

  it.each(['export default oldApi;', 'export = oldApi;'])(
    "retains export expression evidence with a propagation gap: %s", source => {
      const result = analyze(source);
      expect(result.status).toBe("partial");
      expect(result.findings.map(finding => finding.kind)).toEqual(["value-reference"]);
      expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
    });

  it("does not attribute unrelated internal aliases or export assignments to the target", () => {
    const result = analyze('namespace other {} import alias = other; export default other;');
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.findings.map(finding => finding.kind)).toEqual(["import-only"]);
  });

  it("makes repeated evidence stable and independent bindings distinct", () => {
    const body = 'import { oldApi as second } from "pkg"; oldApi(); second();';
    const result = analyze(body);
    expect(result).toEqual(analyze(body));
    expect(new Set(result.bindings.map(binding => binding.id)).size).toBe(2);
    expect(new Set(result.findings.map(finding => finding.id)).size).toBe(2);
  });

  it.each([
    [Buffer.from([0xff]), "PARSE_FAILED"],
    [Buffer.alloc(2 * 1024 * 1024 + 1, 32), "RESOURCE_LIMIT"],
  ])("reports invalid or oversized source bytes as a gap", (bytes, code) => {
    const result = analyzeFile({ path: "consumer.ts", bytes,
      contentHash: createHash("sha256").update(bytes).digest("hex") }, target);
    expect(result.status).toBe("partial");
    expect(result.findings).toEqual([]);
    expect(result.gaps.map(gap => gap.code)).toEqual([code]);
  });
});
