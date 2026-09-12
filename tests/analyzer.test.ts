import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { analyzeFile } from "../src/analyzer/index.js";
import { parseApiTarget, type ApiTarget } from "../src/domain/index.js";
import type { SnapshotFile } from "../src/snapshots/index.js";

const target: ApiTarget = parseApiTarget({ packageName: "example-lib", moduleSpecifier: "example-lib/parser", exportName: "oldApi" });

function file(source: string, path = "src/input.ts"): SnapshotFile {
  const bytes = Buffer.from(source, "utf8");
  return { path, bytes, contentHash: createHash("sha256").update(bytes).digest("hex") };
}

function analyze(source: string, path?: string) {
  return analyzeFile(file(source, path), target);
}

function kinds(result: ReturnType<typeof analyzeFile>): string[] {
  return result.findings.map((finding) => finding.kind);
}

describe("analyzeFile: T03 ESM named imports", () => {
  it("reports a named import call as binding-backed value evidence", () => {
    const result = analyze('import { oldApi } from "example-lib/parser";\noldApi();\n');

    expect(result.status).toBe("complete-within-scope");
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({ targetId: target.id, localName: "oldApi", form: "esm-named", importSpace: "value" });
    expect(kinds(result)).toEqual(["value-reference"]);
    expect(result.findings[0]).toMatchObject({ targetId: target.id, bindingId: result.bindings[0]!.id, location: {
      file: "src/input.ts", start: { line: 2, column: 1 }, end: { line: 2, column: 7 },
    } });
  });

  it("matches an alias and direct function-value assignment, without following the new alias", () => {
    const result = analyze('import { oldApi as legacy } from "example-lib/parser";\nlegacy();\nconst next = legacy;\nnext();\n');

    expect(result.bindings[0]).toMatchObject({ localName: "legacy" });
    expect(kinds(result)).toEqual(["value-reference", "value-reference"]);
    expect(result.findings.map((finding) => finding.location.start.line)).toEqual([2, 3]);
  });

  it("keeps an unreferenced target import as import-only while another binding has value evidence", () => {
    const result = analyze('import { oldApi, oldApi as used } from "example-lib/parser";\nused();\n');

    expect(result.bindings).toHaveLength(2);
    expect(kinds(result).sort()).toEqual(["import-only", "value-reference"]);
    const importOnly = result.findings.find((finding) => finding.kind === "import-only");
    expect(importOnly?.bindingId).not.toBe(result.findings.find((finding) => finding.kind === "value-reference")?.bindingId);
  });

  it("does not add import-only once that same binding has value evidence", () => {
    const result = analyze('import { oldApi } from "example-lib/parser";\nconst use = oldApi;\n');

    expect(kinds(result)).toEqual(["value-reference"]);
  });

  it("uses binding identity through parameter, block, catch, and function-name shadowing", () => {
    const result = analyze(`import { oldApi } from "example-lib/parser";
function parameter(oldApi: () => void) { oldApi(); }
{ const oldApi = () => undefined; oldApi(); }
try { throw new Error(); } catch (oldApi) { void oldApi; }
const fn = function oldApi() { return oldApi(); };
`);

    expect(kinds(result)).toEqual(["import-only"]);
    expect(result.findings[0]!.location.start.line).toBe(1);
  });

  it("does not match other packages, similar package names, comments, strings, keys, or labels", () => {
    const result = analyze(`import { oldApi } from "example-lib/parser";
import { oldApi as other } from "other-lib";
import { oldApi as similar } from "example-lib/parser-extra";
// oldApi();
const text = "oldApi";
const value = { oldApi: 1 };
oldApi: for (const item of [1]) break oldApi;
other(); similar();
`);

    expect(kinds(result)).toEqual(["import-only"]);
    expect(result.bindings).toHaveLength(1);
  });

  it("counts object shorthand as a value reference but not an object-property key", () => {
    const result = analyze('import { oldApi } from "example-lib/parser";\nconst one = { oldApi };\nconst two = { oldApi: 1 };\n');

    expect(kinds(result)).toEqual(["value-reference"]);
    expect(result.findings[0]!.location.start).toEqual({ line: 2, column: 15 });
  });

  it("preserves BOM, Unicode, and CRLF offsets for the referenced token", () => {
    const result = analyze('\uFEFFimport { oldApi as 名称 } from "example-lib/parser";\r\n名称();\r\n', "src/名称.ts");

    expect(result.status).toBe("complete-within-scope");
    expect(kinds(result)).toEqual(["value-reference"]);
    expect(result.findings[0]!.location).toEqual({
      file: "src/名称.ts", start: { line: 2, column: 1 }, end: { line: 2, column: 3 },
    });
  });

  it("marks parse diagnostics as partial rather than accepting a tolerant AST as complete", () => {
    const result = analyze('import { oldApi } from "example-lib/parser";\noldApi(\n');

    expect(result.status).toBe("partial");
    expect(result.gaps.map((gap) => gap.code)).toContain("PARSE_FAILED");
  });

  it.each([
    ['import * as api from "example-lib/parser";\napi["oldApi"]();\n', "namespace computed member"],
    ['export * from "example-lib/parser";\n', "star re-export"],
    ['async function load() { return import("example-lib/parser"); }\n', "dynamic import"],
    ['const api = require("example-lib/parser");\napi.oldApi();\n', "require"],
    ['import { oldApi } from "example-lib/parser";\nconst node = <View value={oldApi} />;\n', "JSX"],
  ])("reports target-related unsupported syntax: %s", (source) => {
    const result = analyze(source, source.includes("<View") ? "src/input.tsx" : undefined);

    expect(result.status).toBe("partial");
    expect(result.gaps.map((gap) => gap.code)).toContain("UNSUPPORTED_TARGET_PATTERN");
  });

  it("does not let an unrelated dynamic import make target analysis partial", () => {
    const result = analyze('import { oldApi } from "example-lib/parser";\noldApi();\nimport("other-lib");\n');

    expect(result.status).toBe("complete-within-scope");
    expect(kinds(result)).toEqual(["value-reference"]);
    expect(result.gaps).toEqual([]);
  });
});
