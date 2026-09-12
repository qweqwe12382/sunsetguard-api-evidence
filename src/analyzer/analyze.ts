import { createHash } from "node:crypto";
import ts from "typescript";

import { locationSchema, parseApiTarget } from "../domain/index.js";
import type { AnalysisGap, ApiTarget, Binding, Finding, Location } from "../domain/index.js";
import type { SnapshotFile } from "../snapshots/index.js";
import { createSourceContext } from "./context.js";
import type { FileAnalysisResult } from "./types.js";

export const RULE_SET_VERSION = "0.1.0-t07";
export const ANALYSIS_PROFILE = "module-syntax-v1" as const;

const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const;
const MAX_ANALYZER_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REPORTED_DIAGNOSTIC_COUNT = 10_000;

function hashId(...parts: readonly (string | number)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const text = String(part);
    hash.update(String(Buffer.byteLength(text, "utf8"))).update(":").update(text).update(";");
  }
  return hash.digest("hex");
}

function location(sourceFile: ts.SourceFile, node: ts.Node, file: string): Location {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file,
    start: { line: start.line + 1, column: start.character + 1 },
    end: { line: end.line + 1, column: end.character + 1 },
  };
}

/** Never use a compiler filename or diagnostic message as report content. */
function diagnosticLocation(sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic, file: string): Location | undefined {
  const { start, length } = diagnostic;
  if (diagnostic.file !== sourceFile || typeof start !== "number" || typeof length !== "number" ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 ||
      start > sourceFile.text.length || length > sourceFile.text.length - start) return undefined;
  const from = sourceFile.getLineAndCharacterOfPosition(start);
  const to = sourceFile.getLineAndCharacterOfPosition(start + length);
  return {
    file,
    start: { line: from.line + 1, column: from.character + 1 },
    end: { line: to.line + 1, column: to.character + 1 },
  };
}

function unsupported(target: ApiTarget, message: string, at?: Location): AnalysisGap {
  return {
    code: "UNSUPPORTED_TARGET_PATTERN",
    message,
    targetId: target.id,
    ...(at === undefined ? {} : { location: at }),
    affectsConclusion: true,
  };
}

function validateInputs(file: SnapshotFile, target: ApiTarget): ApiTarget {
  const normalized = parseApiTarget(target);
  if (normalized.id !== target.id || normalized.moduleSpecifier !== target.moduleSpecifier) {
    throw new TypeError("target must use its canonical identity");
  }
  if (!(file.bytes instanceof Uint8Array)) throw new TypeError("file.bytes must be a Uint8Array");
  if (!/^[a-f0-9]{64}$/i.test(file.contentHash)) throw new TypeError("file.contentHash must be a SHA-256 hex digest");
  locationSchema.parse({ file: file.path, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } });
  const lower = file.path.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.some(extension => lower.endsWith(extension))) {
    throw new TypeError("file.path must have a supported source extension");
  }
  return normalized;
}

function moduleText(node: ts.Expression): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function leftmostEntityName(name: ts.EntityName): ts.Identifier {
  let current = name;
  while (ts.isQualifiedName(current)) current = current.left;
  return current;
}

function isTargetImportSymbol(symbol: ts.Symbol | undefined, target: ApiTarget): boolean {
  return symbol?.declarations?.some(declaration => {
    if (ts.isImportSpecifier(declaration)) {
      if ((declaration.propertyName?.text ?? declaration.name.text) !== target.exportName) return false;
      const importDeclaration = declaration.parent.parent.parent;
      return ts.isImportDeclaration(importDeclaration) && moduleText(importDeclaration.moduleSpecifier) === target.moduleSpecifier;
    }
    if (ts.isNamespaceImport(declaration)) {
      const importDeclaration = declaration.parent.parent;
      return ts.isImportDeclaration(importDeclaration) && moduleText(importDeclaration.moduleSpecifier) === target.moduleSpecifier;
    }
    return false;
  }) === true;
}

function isWithin(node: ts.Node, predicate: (candidate: ts.Node) => boolean): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (predicate(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isTypePosition(node: ts.Identifier): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isExpressionWithTypeArguments(current) && ts.isHeritageClause(current.parent)) {
      return current.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(current.parent.parent);
    }
    if (ts.isHeritageClause(current)) {
      return current.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(current.parent);
    }
    if (ts.isTypeNode(current) || ts.isTypeQueryNode(current) || ts.isInterfaceDeclaration(current) ||
        ts.isTypeLiteralNode(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function isJsxPosition(node: ts.Identifier): boolean {
  return isWithin(node.parent, candidate => ts.isJsxElement(candidate) || ts.isJsxSelfClosingElement(candidate) ||
    ts.isJsxOpeningElement(candidate) || ts.isJsxClosingElement(candidate) || ts.isJsxAttribute(candidate));
}

function isImportDeclarationPart(node: ts.Identifier): boolean {
  return isWithin(node.parent, candidate => ts.isImportDeclaration(candidate) || ts.isImportEqualsDeclaration(candidate));
}

function isLocalExport(node: ts.Identifier): boolean {
  return isWithin(node.parent, candidate => ts.isExportSpecifier(candidate));
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  return (parent as ts.NamedDeclaration).name === node;
}

function collectUnsupportedSyntax(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  target: ApiTarget,
  addGap: (gap: AnalysisGap) => void,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !ts.isSourceFile(node.parent) &&
        moduleText(node.moduleSpecifier) === target.moduleSpecifier) {
      const named = node.importClause?.namedBindings;
      const relevant = named !== undefined && (ts.isNamespaceImport(named) ||
        named.elements.some(specifier => (specifier.propertyName?.text ?? specifier.name.text) === target.exportName));
      if (relevant) {
        addGap(unsupported(target, "Target imports inside nested or ambient modules are not supported.",
          location(sourceFile, node, targetFile(sourceFile))));
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined &&
        moduleText(node.moduleSpecifier) === target.moduleSpecifier) {
      const relevant = node.exportClause === undefined || ts.isNamespaceExport(node.exportClause) ||
        (!ts.isSourceFile(node.parent) && ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.some(specifier => (specifier.propertyName?.text ?? specifier.name.text) === target.exportName));
      if (relevant) {
        addGap(unsupported(target, "Re-exports of the target API are not supported by this rule set.",
          location(sourceFile, node, targetFile(sourceFile))));
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression !== undefined &&
        moduleText(node.moduleReference.expression) === target.moduleSpecifier) {
      addGap(unsupported(target, "TypeScript import-equals from the target module is not supported by this rule set.",
        location(sourceFile, node.name, targetFile(sourceFile))));
    }
    if (ts.isImportEqualsDeclaration(node) && !ts.isExternalModuleReference(node.moduleReference)) {
      const referenced = leftmostEntityName(node.moduleReference);
      if (isTargetImportSymbol(checker.getSymbolAtLocation(referenced), target)) {
        addGap(unsupported(target, "Import-equals propagation of the local target binding is not supported by this rule set.",
          location(sourceFile, node.moduleReference, targetFile(sourceFile))));
      }
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) && node.argument.literal.text === target.moduleSpecifier) {
      const targetRelated = node.qualifier === undefined || leftmostEntityName(node.qualifier).text === target.exportName;
      if (targetRelated) {
        addGap(unsupported(target, "Import-type references to the target API are not supported by this rule set.",
          location(sourceFile, node.qualifier ?? node, targetFile(sourceFile))));
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && moduleText(node.arguments[0]!) === target.moduleSpecifier) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addGap(unsupported(target, "Dynamic imports of the target module are not supported by this rule set.",
          location(sourceFile, node.expression, targetFile(sourceFile))));
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" &&
          checker.getSymbolAtLocation(node.expression) === undefined) {
        addGap(unsupported(target, "CommonJS require of the target module is not supported by this rule set.",
          location(sourceFile, node.expression, targetFile(sourceFile))));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function targetFile(sourceFile: ts.SourceFile): string {
  return sourceFile.fileName.startsWith("/snapshot/") ? sourceFile.fileName.slice("/snapshot/".length) : "source";
}

// A default import is not proof of a named export. Keep related uses visible as gaps.
function collectDefaultImportGaps(sourceFile: ts.SourceFile, checker: ts.TypeChecker, target: ApiTarget, addGap: (gap: AnalysisGap) => void): void {
  const symbols = new Set<ts.Symbol>();
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && moduleText(node.moduleSpecifier) === target.moduleSpecifier) {
      const names: ts.Identifier[] = node.importClause?.name === undefined ? [] : [node.importClause.name];
      const named = node.importClause?.namedBindings;
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const specifier of named.elements) if (specifier.propertyName?.text === "default") names.push(specifier.name);
      }
      for (const name of names) { const symbol = checker.getSymbolAtLocation(name); if (symbol !== undefined) symbols.add(symbol); }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  if (symbols.size === 0) return;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isImportDeclarationPart(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (ts.isShorthandPropertyAssignment(node.parent)) symbol = checker.getShorthandAssignmentValueSymbol(node.parent) ?? symbol;
      if (ts.isExportSpecifier(node.parent)) symbol = checker.getExportSpecifierLocalTargetSymbol(node.parent) ?? symbol;
      if (symbol !== undefined && symbols.has(symbol) && (!isDeclarationIdentifier(node) || ts.isExportSpecifier(node.parent))) {
        const parent = node.parent;
        let at: ts.Node | undefined = node;
        if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) at = undefined;
        else if (ts.isPropertyAccessExpression(parent) && parent.expression === node) at = parent.name.text === target.exportName ? parent.name : undefined;
        else if (ts.isQualifiedName(parent) && parent.left === node) at = parent.right.text === target.exportName ? parent.right : undefined;
        else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
          at = ts.isStringLiteralLike(parent.argumentExpression) && parent.argumentExpression.text !== target.exportName ? undefined : parent;
        }
        if (at !== undefined) addGap(unsupported(target, "Default-import target access or propagation is not supported; it does not prove a named export binding.", location(sourceFile, at, targetFile(sourceFile))));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Analyze one immutable snapshot file without reading the filesystem or resolving dependencies. */
function analyzeValidatedFile(file: SnapshotFile, target: ApiTarget): FileAnalysisResult {
  if (file.bytes.byteLength > MAX_ANALYZER_FILE_BYTES) {
    return {
      file: file.path,
      status: "partial",
      bindings: [],
      findings: [],
      gaps: [{
        code: "RESOURCE_LIMIT",
        message: "Source bytes exceed the analyzer file-size limit.",
        targetId: target.id,
        affectsConclusion: true,
      }],
    };
  }
  let context: ReturnType<typeof createSourceContext>;
  try {
    context = createSourceContext(file);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return {
        file: file.path,
        status: "partial",
        bindings: [],
        findings: [],
        gaps: [{
          code: error instanceof RangeError ? "RESOURCE_LIMIT" : "PARSE_FAILED",
          message: error instanceof RangeError ? "Source parsing exceeded an analyzer resource boundary." :
            "Source bytes could not be decoded as UTF-8.",
          targetId: target.id,
          affectsConclusion: true,
        }],
      };
    }
    throw error;
  }
  const { sourceFile, checker, program } = context;
  const diagnostics = program.getSyntacticDiagnostics(sourceFile);
  if (diagnostics.length > 0) {
    const first = diagnostics[0]!;
    const at = diagnosticLocation(sourceFile, first, file.path);
    const count = diagnostics.length > MAX_REPORTED_DIAGNOSTIC_COUNT ? `more than ${MAX_REPORTED_DIAGNOSTIC_COUNT}` : String(diagnostics.length);
    const firstCode = Number.isSafeInteger(first.code) && first.code >= 0 && first.code <= 999_999 ? `; first diagnostic TS${first.code}` : "";
    return {
      file: file.path,
      status: "partial",
      bindings: [],
      findings: [],
      gaps: [{
        code: "PARSE_FAILED",
        message: `Source syntax could not be analyzed reliably (${count} diagnostic${diagnostics.length === 1 ? "" : "s"}${firstCode}).${at === undefined ? "" : " Only the first diagnostic location is shown."}`,
        targetId: target.id,
        ...(at === undefined ? {} : { location: at }),
        affectsConclusion: true,
      }],
    };
  }

  const bindings: Binding[] = [];
  const findings: Finding[] = [];
  const gaps: AnalysisGap[] = [];
  const gapKeys = new Set<string>();
  const addGap = (value: AnalysisGap): void => {
    const key = `${value.code}:${value.message}:${value.location?.start.line ?? 0}:${value.location?.start.column ?? 0}`;
    if (!gapKeys.has(key)) { gapKeys.add(key); gaps.push(value); }
  };
  collectUnsupportedSyntax(sourceFile, checker, target, addGap);
  collectDefaultImportGaps(sourceFile, checker, target, addGap);

  const candidates: { specifier: ts.ImportSpecifier; symbol: ts.Symbol; binding: Binding; typeOnly: boolean }[] = [];
  const namespaceCandidates: { declaration: ts.NamespaceImport; symbol: ts.Symbol; binding: Binding; typeOnly: boolean }[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || moduleText(statement.moduleSpecifier) !== target.moduleSpecifier) continue;
    const clause = statement.importClause;
    if (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
      const declaration = clause.namedBindings;
      const symbol = checker.getSymbolAtLocation(declaration.name);
      const bindingLocation = location(sourceFile, declaration.name, file.path);
      if (symbol === undefined) {
        addGap(unsupported(target, "The target namespace import binding could not be resolved locally.", bindingLocation));
      } else {
        const binding: Binding = {
          id: hashId("binding", RULE_SET_VERSION, target.id, file.path, declaration.name.getStart(sourceFile), declaration.name.getEnd()),
          targetId: target.id,
          location: bindingLocation,
          localName: declaration.name.text,
          form: "esm-namespace",
          importSpace: clause.isTypeOnly ? "type" : "value",
          attribution: {
            status: "declared-module",
            reasons: ["The exact module specifier is syntax-declared; manifest and runtime resolution were not verified."],
          },
        };
        bindings.push(binding);
        namespaceCandidates.push({ declaration, symbol, binding, typeOnly: binding.importSpace === "type" });
      }
    }
    if (clause?.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const specifier of clause.namedBindings.elements) {
      if ((specifier.propertyName?.text ?? specifier.name.text) !== target.exportName) continue;
      const symbol = checker.getSymbolAtLocation(specifier.name);
      const bindingLocation = location(sourceFile, specifier.name, file.path);
      if (symbol === undefined) {
        addGap(unsupported(target, "The target import binding could not be resolved locally.", bindingLocation));
        continue;
      }
      const binding: Binding = {
        id: hashId("binding", RULE_SET_VERSION, target.id, file.path, specifier.name.getStart(sourceFile), specifier.name.getEnd()),
        targetId: target.id,
        location: bindingLocation,
        localName: specifier.name.text,
        form: "esm-named",
        importSpace: clause.isTypeOnly || specifier.isTypeOnly ? "type" : "value",
        attribution: {
          status: "declared-module",
          reasons: ["The exact module specifier is syntax-declared; manifest and runtime resolution were not verified."],
        },
      };
      bindings.push(binding);
      candidates.push({ specifier, symbol, binding, typeOnly: binding.importSpace === "type" });
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined ||
        moduleText(statement.moduleSpecifier) !== target.moduleSpecifier || statement.exportClause === undefined ||
        !ts.isNamedExports(statement.exportClause)) continue;
    for (const specifier of statement.exportClause.elements) {
      const targetToken = specifier.propertyName ?? specifier.name;
      if (targetToken.text !== target.exportName) continue;
      const bindingLocation = location(sourceFile, targetToken, file.path);
      const binding: Binding = {
        id: hashId("binding", RULE_SET_VERSION, target.id, file.path, targetToken.getStart(sourceFile), targetToken.getEnd(), "reexport"),
        targetId: target.id,
        location: bindingLocation,
        localName: specifier.name.text,
        form: "esm-reexport",
        importSpace: statement.isTypeOnly || specifier.isTypeOnly ? "type" : "value",
        attribution: {
          status: "declared-module",
          reasons: ["The exact module specifier is syntax-declared; manifest and runtime resolution were not verified."],
        },
      };
      bindings.push(binding);
      findings.push({
        id: hashId("finding", RULE_SET_VERSION, target.id, binding.id, "direct-reexport"),
        targetId: target.id,
        bindingId: binding.id,
        kind: "direct-reexport",
        location: location(sourceFile, specifier.name, file.path),
        ruleId: RULE_SET_VERSION,
      });
    }
  }

  const conflicts = new Set<ts.Symbol>();
  for (const candidate of candidates) {
    const declarations = candidate.symbol.declarations ?? [];
    const importDeclarations = declarations.filter(ts.isImportSpecifier);
    if (declarations.length !== 1 || importDeclarations.length !== 1 ||
        candidates.some(other => other !== candidate && other.symbol === candidate.symbol)) {
      conflicts.add(candidate.symbol);
      addGap(unsupported(target, "A conflicting target import declaration prevents reliable local binding analysis.",
        candidate.binding.location));
    }
  }
  const namespaceConflicts = new Set<ts.Symbol>();
  for (const candidate of namespaceCandidates) {
    const declarations = candidate.symbol.declarations ?? [];
    if (declarations.length !== 1 || !ts.isNamespaceImport(declarations[0]!) ||
        namespaceCandidates.some(other => other !== candidate && other.symbol === candidate.symbol)) {
      namespaceConflicts.add(candidate.symbol);
      addGap(unsupported(target, "A conflicting target namespace declaration prevents reliable local binding analysis.",
        candidate.binding.location));
    }
  }

  const references = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ts.isIdentifier(node.name)) {
      const candidate = namespaceCandidates.find(item => item.symbol === checker.getSymbolAtLocation(node.expression));
      if (candidate !== undefined && !namespaceConflicts.has(candidate.symbol) && node.name.text === target.exportName) {
        const at = location(sourceFile, node.name, file.path);
        const typePosition = isTypePosition(node.name);
        if (isWithin(node, ts.isExportAssignment)) {
          addGap(unsupported(target, "Export expression propagation of the target namespace member is not supported by this rule set.", at));
        }
        if (candidate.typeOnly && !typePosition) {
          addGap(unsupported(target, "A type-only target namespace binding is used in a value position.", at));
        } else if (isJsxPosition(node.name)) {
          addGap(unsupported(target, "JSX references to the target namespace member are not supported by this rule set.", at));
        } else {
          findings.push({
            id: hashId("finding", RULE_SET_VERSION, target.id, candidate.binding.id, file.path, node.name.getStart(sourceFile), node.name.getEnd()),
            targetId: target.id,
            bindingId: candidate.binding.id,
            kind: typePosition ? "type-reference" : "value-reference",
            location: at,
            ruleId: RULE_SET_VERSION,
          });
          references.set(candidate.binding.id, (references.get(candidate.binding.id) ?? 0) + 1);
        }
      }
    }
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && !isWithin(node, ts.isImportEqualsDeclaration)) {
      const candidate = namespaceCandidates.find(item => item.symbol === checker.getSymbolAtLocation(node.left));
      if (candidate !== undefined && !namespaceConflicts.has(candidate.symbol) && node.right.text === target.exportName) {
        const at = location(sourceFile, node.right, file.path);
        findings.push({
          id: hashId("finding", RULE_SET_VERSION, target.id, candidate.binding.id, file.path, node.right.getStart(sourceFile), node.right.getEnd()),
          targetId: target.id,
          bindingId: candidate.binding.id,
          kind: "type-reference",
          location: at,
          ruleId: RULE_SET_VERSION,
        });
        references.set(candidate.binding.id, (references.get(candidate.binding.id) ?? 0) + 1);
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const candidate = namespaceCandidates.find(item => item.symbol === checker.getSymbolAtLocation(node.expression));
      const literalOther = ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text !== target.exportName;
      if (candidate !== undefined && !namespaceConflicts.has(candidate.symbol) && !literalOther) {
        addGap(unsupported(target, "Computed access on the target namespace may refer to the target API and is not supported.",
          location(sourceFile, node, file.path)));
      }
    }
    if (ts.isIdentifier(node) && !isImportDeclarationPart(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
        symbol = checker.getShorthandAssignmentValueSymbol(node.parent) ?? symbol;
      }
      if (ts.isExportSpecifier(node.parent)) {
        symbol = checker.getExportSpecifierLocalTargetSymbol(node.parent) ?? symbol;
      }
      const candidate = candidates.find(item => item.symbol === symbol);
      if (candidate !== undefined && !conflicts.has(candidate.symbol) &&
          (!isDeclarationIdentifier(node) || ts.isExportSpecifier(node.parent))) {
        const at = location(sourceFile, node, file.path);
        if (isWithin(node.parent, ts.isExportAssignment)) {
          addGap(unsupported(target, "Export expression propagation of the target binding is not supported by this rule set.", at));
        }
        const typePosition = isTypePosition(node);
        if (isLocalExport(node)) {
          addGap(unsupported(target, "Local export propagation of the target binding is not supported by this rule set.", at));
        } else if (candidate.typeOnly && !typePosition) {
          addGap(unsupported(target, "A type-only target binding is used in a value position.", at));
        } else if (isJsxPosition(node)) {
          addGap(unsupported(target, "JSX references to the target binding are not supported by this rule set.", at));
        } else {
          const finding: Finding = {
            id: hashId("finding", RULE_SET_VERSION, target.id, candidate.binding.id, file.path, node.getStart(sourceFile), node.getEnd()),
            targetId: target.id,
            bindingId: candidate.binding.id,
            kind: typePosition ? "type-reference" : "value-reference",
            location: at,
            ruleId: RULE_SET_VERSION,
          };
          findings.push(finding);
          references.set(candidate.binding.id, (references.get(candidate.binding.id) ?? 0) + 1);
        }
      }
      const namespaceCandidate = namespaceCandidates.find(item => item.symbol === symbol);
      if (namespaceCandidate !== undefined && !namespaceConflicts.has(namespaceCandidate.symbol) &&
          (!isDeclarationIdentifier(node) || ts.isExportSpecifier(node.parent)) &&
          !((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node) &&
          !(ts.isQualifiedName(node.parent) && node.parent.left === node)) {
        addGap(unsupported(target, "The target namespace binding escapes static member analysis.",
          location(sourceFile, node, file.path)));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const candidate of candidates) {
    if (!conflicts.has(candidate.symbol) && (references.get(candidate.binding.id) ?? 0) === 0) {
      findings.push({
        id: hashId("finding", RULE_SET_VERSION, target.id, candidate.binding.id, "import-only"),
        targetId: target.id,
        bindingId: candidate.binding.id,
        kind: "import-only",
        location: candidate.binding.location,
        ruleId: RULE_SET_VERSION,
      });
    }
  }

  bindings.sort((a, b) => a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column);
  findings.sort((a, b) => a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column ||
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  gaps.sort((a, b) => (a.location?.start.line ?? 0) - (b.location?.start.line ?? 0) ||
    (a.location?.start.column ?? 0) - (b.location?.start.column ?? 0) || (a.message < b.message ? -1 : 1));
  return { file: file.path, status: gaps.length === 0 ? "complete-within-scope" : "partial", bindings, findings, gaps };
}

export function analyzeFile(file: SnapshotFile, inputTarget: ApiTarget): FileAnalysisResult {
  const target = validateInputs(file, inputTarget);
  try {
    return analyzeValidatedFile(file, target);
  } catch (error) {
    if (error instanceof RangeError) {
      return {
        file: file.path,
        status: "partial",
        bindings: [],
        findings: [],
        gaps: [{
          code: "RESOURCE_LIMIT",
          message: "Source analysis exceeded an analyzer resource boundary.",
          targetId: target.id,
          affectsConclusion: true,
        }],
      };
    }
    throw error;
  }
}
