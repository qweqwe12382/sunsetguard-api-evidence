import ts from "typescript";
import { locationSchema } from "../domain/index.js";
import type { SnapshotFile } from "../snapshots/index.js";

export interface SourceContext {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  program: ts.Program;
  requestedFiles: readonly string[];
}

/** No filesystem-backed compiler host, default library, package resolution, or config loading. */
export function createSourceContext(file: SnapshotFile): SourceContext {
  locationSchema.parse({ file: file.path, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } });
  // Keeping the BOM preserves the UTF-16 offsets of the original source.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
  const extension = file.path.slice(file.path.lastIndexOf(".")).toLowerCase();
  const kind = extension === ".tsx" ? ts.ScriptKind.TSX
    : extension === ".jsx" ? ts.ScriptKind.JSX
      : [".js", ".mjs", ".cjs"].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  if (![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extension)) {
    throw new TypeError("Unsupported source extension.");
  }
  const filename = `/snapshot/${file.path}`;
  const sourceFile = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, kind);
  const requestedFiles: string[] = [];
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    noLib: true,
    noResolve: true,
    types: [],
    strict: true,
    skipLibCheck: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name) => { requestedFiles.push(name); return name === filename ? sourceFile : undefined; },
    getDefaultLibFileName: () => "/unavailable/lib.d.ts",
    writeFile: () => { throw new Error("The analysis host is read-only."); },
    getCurrentDirectory: () => "/snapshot",
    getDirectories: () => [],
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: name => name === filename,
    readFile: name => name === filename ? text : undefined,
    resolveModuleNames: names => names.map(() => undefined),
  };
  const program = ts.createProgram([filename], options, host);
  return { sourceFile, checker: program.getTypeChecker(), program, requestedFiles };
}
