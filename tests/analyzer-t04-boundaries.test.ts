import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyzer/index.js";
import { expectedBucket, parseApiTarget, validateRepositoryTargetResult } from "../src/domain/index.js";

const target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
function analyze(source: string, path = "source.ts") {
  const bytes = Buffer.from(source);
  return analyzeFile({ path, bytes, contentHash: createHash("sha256").update(bytes).digest("hex") }, target);
}

describe("T04 space and binding boundaries", () => {
  it.each([
    'import { oldApi } from "pkg"; type T = typeof oldApi;',
    'import * as ns from "pkg"; type T = ns.oldApi;',
    'export { oldApi } from "pkg";',
  ])("does not silently skip target imports or exports in ambient modules: %s", body => {
    const result = analyze('declare module "wrapper" { ' + body + ' }');
    expect(result.status).toBe("partial");
    expect(result.findings).toEqual([]);
    expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
  });

  it.each(['import { Other } from "pkg";', 'export { Other as oldApi } from "pkg";',
    'import { oldApi } from "other";'])("does not flag unrelated ambient module declarations: %s", body => {
    const result = analyze('declare module "wrapper" { ' + body + ' }');
    expect(result.status).toBe("complete-within-scope");
    expect(result.findings).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it("keeps value typeof and type typeof distinct for the same import", () => {
    const result = analyze('import { oldApi } from "pkg"; typeof oldApi; type F = typeof oldApi;');
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.findings.map(finding => finding.kind)).toEqual(["value-reference", "type-reference"]);
    expect(new Set(result.findings.map(finding => finding.bindingId)).size).toBe(1);
  });

  it("supports type-only namespace members without value evidence", () => {
    const result = analyze('import type * as ns from "pkg"; type T = ns.oldApi;');
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.findings.map(finding => finding.kind)).toEqual(["type-reference"]);
    expect(result.bindings[0]!.importSpace).toBe("type");
  });

  it.each([
    ['type T = typeof ns.oldApi;', 'type-reference'],
    ['class C extends ns.oldApi {}', 'value-reference'],
    ['interface I extends ns.oldApi {}', 'type-reference'],
    ['class C implements ns.oldApi {}', 'type-reference'],
    ['const v = { fn: ns.oldApi };', 'value-reference'],
  ])("classifies namespace member context: %s", (body, kind) => {
    const result = analyze('import * as ns from "pkg";\n' + body);
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.findings.map(finding => finding.kind)).toEqual([kind]);
    const finding = result.findings[0]!;
    expect(body.slice(finding.location.start.column - 1, finding.location.end.column - 1)).toBe("oldApi");
    expect(finding.bindingId).toBe(result.bindings[0]!.id);
  });

  it.each([
    'import type { oldApi } from "pkg"; oldApi();',
    'import type * as ns from "pkg"; ns.oldApi();',
    'import type { oldApi } from "pkg"; class C extends oldApi {}',
  ])("does not turn invalid value use of a type import into runtime evidence: %s", source => {
    const result = analyze(source);
    expect(result.status).toBe("partial");
    expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
    expect(result.findings.filter(finding => finding.kind === "value-reference")).toEqual([]);
  });

  it.each([
    'import type { oldApi } from "pkg"; export type { oldApi };',
    'import type * as ns from "pkg"; export type { ns };',
    'import * as ns from "pkg"; import alias = ns;',
    'import * as ns from "pkg"; type All = typeof ns;',
    'import * as ns from "pkg"; const obj = { ns };',
  ])("keeps local or namespace propagation visible: %s", source => {
    const result = analyze(source);
    expect(result.status).toBe("partial");
    expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
    expect(result.findings.filter(finding => finding.kind === "direct-reexport")).toEqual([]);
  });

  it("retains confirmed namespace evidence when a later access is dynamic", () => {
    const result = analyze('import * as ns from "pkg"; ns.oldApi(); ns[key]();');
    expect(result.status).toBe("partial");
    expect(result.findings.map(finding => finding.kind)).toEqual(["value-reference"]);
    expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
  });

  it("keeps named import evidence alongside a JSX propagation gap", () => {
    const result = analyze('import { oldApi } from "pkg"; const node = <View value={oldApi} />;', "source.tsx");
    expect(result.status).toBe("partial");
    expect(result.findings.map(finding => finding.kind)).toEqual(["import-only"]);
    expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
  });

  it("reports namespace member export expression propagation alongside its value reference", () => {
    const result = analyze('import * as ns from "pkg"; export default ns.oldApi;');
    expect(result.status).toBe("partial");
    expect(result.findings.map(finding => finding.kind)).toEqual(["value-reference"]);
    expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
  });

  it("does not misclassify internal namespace import-equals as a type annotation", () => {
    const result = analyze('import * as ns from "pkg"; import alias = ns.oldApi;');
    expect(result.status).toBe("partial");
    expect(result.findings).toEqual([]);
    expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN")).toBe(true);
  });

  it("keeps type-space namespace access bound to the import despite a value parameter", () => {
    const result = analyze('import * as ns from "pkg"; function f(ns: unknown) { type T = ns.oldApi; }');
    expect(result.status).toBe("complete-within-scope");
    expect(result.findings.map(finding => finding.kind)).toEqual(["type-reference"]);
  });

  it("does not match a re-export only because its exposed alias matches the target", () => {
    const result = analyze('export { other as oldApi } from "pkg"; export { oldApi } from "pkg-extra";');
    expect(result.status).toBe("complete-within-scope");
    expect(result.findings).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it("does not resolve another module's re-export to a same-spelled local import", () => {
    const result = analyze('import { oldApi } from "pkg"; export { oldApi } from "other";');
    expect(result.status).toBe("complete-within-scope");
    expect(result.findings.map(finding => finding.kind)).toEqual(["import-only"]);
    expect(result.gaps).toEqual([]);
  });

  it("keeps independent named, namespace and re-export bindings unique", () => {
    const result = analyze('import { oldApi } from "pkg"; import * as ns from "pkg";\noldApi(); ns.oldApi(); export { oldApi as forwarded } from "pkg";');
    expect(result.status).toBe("complete-within-scope");
    expect(new Set(result.bindings.map(binding => binding.id)).size).toBe(3);
    expect(result.findings.map(finding => finding.kind)).toEqual(["value-reference", "value-reference", "direct-reexport"]);
    expect(new Set(result.findings.map(finding => finding.bindingId)).size).toBe(3);
  });

  it("preserves Unicode export alias positions after a BOM and CRLF", () => {
    const source = '\ufeff// 😀\r\nexport { oldApi as 旧接口 } from "pkg";';
    const result = analyze(source);
    expect(result.status).toBe("complete-within-scope");
    expect(result.findings).toHaveLength(1);
    const at = result.findings[0]!.location;
    expect(at.start.line).toBe(2);
    expect(source.split('\r\n')[1]!.slice(at.start.column - 1, at.end.column - 1)).toBe("旧接口");
    const bindingAt = result.bindings[0]!.location;
    expect(source.split('\r\n')[1]!.slice(bindingAt.start.column - 1, bindingAt.end.column - 1)).toBe("oldApi");
  });

  it("fits all four evidence categories into the existing domain contract", () => {
    const source = 'import { oldApi as used, oldApi as unused, type oldApi as T } from "pkg";\n' +
      'import * as ns from "pkg"; used(); type Config = T; ns.oldApi(); export { oldApi as forwarded } from "pkg";';
    const { file: _file, ...analysis } = analyze(source);
    expect(_file).toBe("source.ts");
    expect(new Set(analysis.findings.map(finding => finding.kind))).toEqual(
      new Set(["import-only", "value-reference", "type-reference", "direct-reexport"]));
    const result = {
      ...analysis, repositoryId: "synthetic-t04", targetId: target.id,
      snapshot: { kind: "local", sourceId: "synthetic-t04", scopeHash: "synthetic-single-file",
        contentHash: createHash("sha256").update(source).digest("hex") },
      inventory: { discoveredFiles: 1, excludedByPolicy: 0, eligibleFiles: 1, analyzedFiles: 1, failedOrSkippedEligibleFiles: 0 },
      bucket: expectedBucket(analysis),
    };
    expect(validateRepositoryTargetResult(result)).toEqual(result);
  });
});
