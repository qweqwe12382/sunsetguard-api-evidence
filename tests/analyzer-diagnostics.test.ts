import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzeFile, createSourceContext } from "../src/analyzer/index.js";
import { parseApiTarget } from "../src/domain/index.js";
import type { SnapshotFile } from "../src/snapshots/index.js";

const target = parseApiTarget({ packageName: "example-lib", moduleSpecifier: "example-lib/parser", exportName: "oldApi" });
const header = 'import { oldApi } from "example-lib/parser";';
function file(source: string | Uint8Array, path = "src/input.ts"): SnapshotFile {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;
  return { path, bytes, contentHash: createHash("sha256").update(bytes).digest("hex") };
}

describe("bounded parse diagnostic evidence", () => {
  it("locates the actual invalid semicolon using CRLF and UTF-16 columns after Unicode", () => {
    // On line 2, const[6] + 名称[2] + ' = '[3] + '"😀"'[4] + '; '[2]
    // + oldApi[6] + '('[1] places the invalid ';' at column 25, end 26.
    const source = `${header}\r\nconst 名称 = "😀"; oldApi(;\r\n`;
    const result = analyzeFile(file(source, "src/名称.ts"), target);
    expect(source.split("\r\n")[1]!.slice(24, 25)).toBe(";");
    expect(result).toMatchObject({ file: "src/名称.ts", status: "partial", findings: [], bindings: [] });
    expect(result.gaps).toEqual([{
      code: "PARSE_FAILED", targetId: target.id, affectsConclusion: true,
      message: "Source syntax could not be analyzed reliably (1 diagnostic; first diagnostic TS1005). Only the first diagnostic location is shown.",
      location: { file: "src/名称.ts", start: { line: 2, column: 25 }, end: { line: 2, column: 26 } },
    }]);
  });

  it("keeps EOF diagnostics zero-length and end-exclusive without inventing an offending token", () => {
    const result = analyzeFile(file(`${header}\r\noldApi(`, "examples/eof.ts"), target);
    expect(result.status).toBe("partial");
    expect(result.findings).toEqual([]);
    expect(result.bindings).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    // oldApi( is seven UTF-16 code units; EOF is the insertion point at column 8.
    expect(result.gaps[0]!.location).toEqual({ file: "examples/eof.ts", start: { line: 2, column: 8 }, end: { line: 2, column: 8 } });
  });

  it("reports the total while retaining only the first diagnostic location", () => {
    const source = `${header}\r\nconst token = "private-canary";\r\nconst broken = ;\r\nconst second = ;\r\n`;
    const result = analyzeFile(file(source), target);
    expect(result.status).toBe("partial");
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.message).toContain("2 diagnostics; first diagnostic TS1109");
    // Both malformed initializers end with ';' at column 16; only line 3 is reported.
    expect(result.gaps[0]!.location).toEqual({ file: "src/input.ts", start: { line: 3, column: 16 }, end: { line: 3, column: 17 } });
    expect(JSON.stringify(result)).not.toContain("private-canary");
  });

  it("never exports compiler diagnostic text, identifiers, source text or its synthetic absolute filename", () => {
    const input = file(`${header}\nconst node = <secretCanary></differentCanary>;`, "src/component.tsx");
    const context = createSourceContext(input);
    const diagnostics = context.program.getSyntacticDiagnostics(context.sourceFile);
    // The real compiler message quotes the opening JSX tag name. The report must not.
    expect(ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, "\n")).toContain("secretCanary");
    const result = analyzeFile(input, target);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.message).toContain("TS17002");
    expect(result.gaps[0]!.location).toEqual({ file: "src/component.tsx", start: { line: 2, column: 30 }, end: { line: 2, column: 45 } });
    const serialized = JSON.stringify(result);
    for (const forbidden of ["secretCanary", "differentCanary", "const node", "/snapshot/", "corresponding JSX closing tag"]) expect(serialized).not.toContain(forbidden);
  });

  it("caps reported diagnostic counts without expanding a gap into thousands of locations", () => {
    const result = analyzeFile(file(`${header}\n${"const x = ;\n".repeat(10_001)}`), target);
    expect(result.status).toBe("partial");
    expect(result.findings).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.message).toContain("more than 10000 diagnostics");
    expect(result.gaps[0]!.message.length).toBeLessThan(180);
    expect(result.gaps[0]!.location).toEqual({ file: "src/input.ts", start: { line: 2, column: 11 }, end: { line: 2, column: 12 } });
  });

  it.each([
    [Uint8Array.from([0xff, 0xfe]), "PARSE_FAILED"],
    [new Uint8Array(2 * 1024 * 1024 + 1), "RESOURCE_LIMIT"],
  ])("does not fabricate a line/column when decoding or a resource boundary prevents parsing", (bytes, code) => {
    const result = analyzeFile(file(bytes, "src/unreadable.ts"), target);
    expect(result).toMatchObject({ status: "partial", findings: [], bindings: [] });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.code).toBe(code);
    expect(result.gaps[0]!.location).toBeUndefined();
    expect(result.gaps[0]!.message).not.toContain("TS");
  });

  it("does not introduce gaps or change binding/shadowing evidence in valid source", () => {
    const result = analyzeFile(file(`${header}\r\noldApi();\r\nfunction local(oldApi: () => void) { oldApi(); }`), target);
    expect(result.status).toBe("complete-within-scope");
    expect(result.gaps).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe("value-reference");
    expect(result.findings[0]!.location.start).toEqual({ line: 2, column: 1 });
  });
});
