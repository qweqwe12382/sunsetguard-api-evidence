import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { analyzeFile } from "../src/analyzer/index.js";
import { parseApiTarget } from "../src/domain/index.js";
import type { SnapshotFile } from "../src/snapshots/index.js";

const target = parseApiTarget({ packageName: "example-lib", moduleSpecifier: "example-lib/parser", exportName: "oldApi" });

function analyze(source: string, path = "src/input.ts") {
  const bytes = Buffer.from(source, "utf8");
  const file: SnapshotFile = { path, bytes, contentHash: createHash("sha256").update(bytes).digest("hex") };
  return analyzeFile(file, target);
}

describe("analyzeFile: T04 type, namespace, and re-export evidence", () => {
  it("classifies import type usage and an unused type import without runtime-value claims", () => {
    const used = analyze('import type { oldApi as Options } from "example-lib/parser";\ntype Config = Options;\n');
    const unused = analyze('import type { oldApi } from "example-lib/parser";\n');
    expect(used.status).toBe("complete-within-scope");
    expect(used.gaps).toEqual([]);
    expect(used.bindings).toHaveLength(1);
    expect(used.bindings[0]).toMatchObject({ importSpace: "type", localName: "Options" });
    expect(used.findings).toMatchObject([{ kind: "type-reference" }]);
    expect(used.findings[0]!.bindingId).toBe(used.bindings[0]!.id);
    expect(unused.status).toBe("complete-within-scope");
    expect(unused.gaps).toEqual([]);
    expect(unused.bindings).toHaveLength(1);
    expect(unused.findings).toMatchObject([{ kind: "import-only" }]);
    expect(unused.findings).not.toMatchObject([{ kind: "value-reference" }]);
  });

  it("classifies type positions and typeof type queries as type-reference", () => {
    const valueImport = analyze('import { oldApi } from "example-lib/parser";\ntype T = typeof oldApi;\n');
    const typeImport = analyze('import { type oldApi } from "example-lib/parser";\ntype T = oldApi;\n');
    for (const result of [valueImport, typeImport]) {
      expect(result.status).toBe("complete-within-scope");
      expect(result.gaps).toEqual([]);
      expect(result.bindings).toHaveLength(1);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.bindingId).toBe(result.bindings[0]!.id);
      expect(result.findings[0]!.kind).toBe("type-reference");
    }
  });

  it("classifies namespace static target-member access with exact member location", () => {
    const result = analyze('import * as api from "example-lib/parser";\napi.oldApi();\n');
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.bindings).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({ form: "esm-namespace", localName: "api", importSpace: "value" });
    expect(result.findings).toMatchObject([{ kind: "value-reference", location: {
      file: "src/input.ts", start: { line: 2, column: 5 }, end: { line: 2, column: 11 },
    } }]);
    expect(result.findings[0]!.bindingId).toBe(result.bindings[0]!.id);
  });

  it("classifies namespace qualified type access but does not create import-only for an untouched namespace", () => {
    const typeUse = analyze('import * as api from "example-lib/parser";\ntype T = api.oldApi;\n');
    const unused = analyze('import * as api from "example-lib/parser";\n');
    expect(typeUse.status).toBe("complete-within-scope");
    expect(typeUse.gaps).toEqual([]);
    expect(typeUse.findings).toHaveLength(1);
    expect(typeUse.findings[0]).toMatchObject({ kind: "type-reference", bindingId: typeUse.bindings[0]!.id });
    expect(unused.status).toBe("complete-within-scope");
    expect(unused.gaps).toEqual([]);
    expect(unused.findings).toEqual([]);
  });

  it("does not confuse local, other-module, or non-target namespace members", () => {
    const result = analyze('import * as api from "example-lib/parser";\nimport * as other from "other-lib";\n{ const api = { oldApi() {} }; api.oldApi(); }\nother.oldApi();\n');
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it.each([
    ['import * as api from "example-lib/parser";\napi["oldApi"]();\n'],
    ['import * as api from "example-lib/parser";\nconst copy = api;\n'],
    ['import * as api from "example-lib/parser";\nconsume(api);\n'],
    ['import { oldApi } from "example-lib/parser";\nexport { oldApi };\n'],
  ])("keeps namespace escape and local export propagation partial", (source) => {
    const result = analyze(source);
    expect(result.status).toBe("partial");
    expect(result.gaps.map((gap) => gap.code)).toContain("UNSUPPORTED_TARGET_PATTERN");
  });

  it("reports direct named re-export aliases as direct-reexport with export-token evidence", () => {
    const result = analyze('export { oldApi as legacy } from "example-lib/parser";\n');
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.bindings).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({ form: "esm-reexport", localName: "legacy", importSpace: "value" });
    expect(result.findings).toMatchObject([{ kind: "direct-reexport", location: {
      file: "src/input.ts", start: { line: 1, column: 20 }, end: { line: 1, column: 26 },
    } }]);
    expect(result.findings[0]!.bindingId).toBe(result.bindings[0]!.id);
  });

  it.each([
    'export { type oldApi as Legacy } from "example-lib/parser";\n',
    'export type { oldApi as Legacy } from "example-lib/parser";\n',
  ])("keeps direct type re-exports in type space: %s", source => {
    const result = analyze(source);
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.bindings).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({ form: "esm-reexport", localName: "Legacy", importSpace: "type" });
    expect(result.findings).toMatchObject([{ kind: "direct-reexport" }]);
    expect(result.findings[0]!.bindingId).toBe(result.bindings[0]!.id);
  });

  it("marks target star re-export as unsupported rather than claiming a named export", () => {
    const result = analyze('export * from "example-lib/parser";\n');
    expect(result.status).toBe("partial");
    expect(result.findings).toEqual([]);
    expect(result.gaps.map((gap) => gap.code)).toContain("UNSUPPORTED_TARGET_PATTERN");
  });
});
