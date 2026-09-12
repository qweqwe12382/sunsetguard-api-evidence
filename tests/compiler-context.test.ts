import ts from "typescript";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSourceContext } from "../src/analyzer/context.js";

function context(code: string) {
  const bytes = Buffer.from(code, "utf8");
  return createSourceContext({ path: "consumer.ts", bytes, contentHash: createHash("sha256").update(bytes).digest("hex") });
}

describe("restricted compiler API spike", () => {
  it("keeps unresolved import aliases distinct and excludes shadowed parameters", () => {
    const { sourceFile, checker } = context([
      'import { oldApi as left } from "pkg";',
      'import { oldApi as right } from "other";',
      'left(); right();',
      'function run(left: unknown) { left; }',
    ].join("\n"));
    const declarations = sourceFile.statements.filter(ts.isImportDeclaration);
    const imports = declarations.map(statement => {
      const named = statement.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named)) throw new Error("Missing named imports");
      return checker.getSymbolAtLocation(named.elements[0]!.name);
    });
    expect(imports[0]).toBeDefined();
    expect(imports[1]).toBeDefined();
    expect(imports[0]).not.toBe(imports[1]);
    const calls: ts.Symbol[] = [];
    let shadowed: ts.Symbol | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(checker.getSymbolAtLocation(node.expression)!);
      if (ts.isExpressionStatement(node) && ts.isIdentifier(node.expression)) shadowed = checker.getSymbolAtLocation(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(calls).toEqual(imports);
    expect(shadowed).toBeDefined();
    expect(shadowed).not.toBe(imports[0]);
  });

  it("distinguishes shorthand value symbols from property names", () => {
    const { sourceFile, checker } = context('import { oldApi } from "pkg"; const value = { oldApi };');
    const declaration = sourceFile.statements[0] as ts.ImportDeclaration;
    const binding = checker.getSymbolAtLocation((declaration.importClause!.namedBindings as ts.NamedImports).elements[0]!.name);
    let shorthand: ts.ShorthandPropertyAssignment | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isShorthandPropertyAssignment(node)) shorthand = node;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(shorthand).toBeDefined();
    expect(checker.getSymbolAtLocation(shorthand!.name)).not.toBe(binding);
    expect(checker.getShorthandAssignmentValueSymbol(shorthand!)).toBe(binding);
  });

  it("never loads external libraries, dependencies or triple-slash files", () => {
    const read = vi.spyOn(ts.sys, "readFile").mockImplementation(() => { throw new Error("external read forbidden"); });
    const exists = vi.spyOn(ts.sys, "fileExists").mockImplementation(() => { throw new Error("external probe forbidden"); });
    const directory = vi.spyOn(ts.sys, "readDirectory").mockImplementation(() => { throw new Error("external enumeration forbidden"); });
    try {
      const result = context([
        '/// <reference path="../../private.ts" />',
        '/// <reference types="external-package" />',
        'import { oldApi } from "pkg";',
        'oldApi();',
      ].join("\n"));
      result.program.getSyntacticDiagnostics();
      result.program.getSemanticDiagnostics();
      expect(result.program.getSourceFiles().map(file => file.fileName)).toEqual(["/snapshot/consumer.ts"]);
      expect(result.requestedFiles).toEqual(["/snapshot/consumer.ts"]);
      expect(read).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
      expect(directory).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("preserves a UTF-8 BOM and rejects invalid UTF-8 instead of replacing bytes", () => {
    const result = context('\ufeffimport { oldApi } from "pkg";');
    expect(result.sourceFile.text.charCodeAt(0)).toBe(0xfeff);
    expect(() => createSourceContext({ path: "bad.ts", bytes: Uint8Array.from([0xff]), contentHash: "test" })).toThrow();
  });
});
