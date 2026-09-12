import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyzer/index.js";
import { parseApiTarget } from "../src/domain/index.js";

const target = parseApiTarget({ packageName: "react-dom", exportName: "findDOMNode" });
const run = (source: string) => {
  const bytes = Buffer.from(source);
  return analyzeFile({ path: "x.tsx", bytes, contentHash: createHash("sha256").update(bytes).digest("hex") }, target);
};

describe("unsupported default-import member attribution", () => {
  it("gaps target access at the exact member without inventing a named binding", () => {
    const result = run("import ReactDOM from 'react-dom';\nReactDOM.findDOMNode(x);");
    expect(result.status).toBe("partial");
    expect(result.bindings).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.gaps).toEqual([expect.objectContaining({ code: "UNSUPPORTED_TARGET_PATTERN", affectsConclusion: true,
      location: { file: "x.tsx", start: { line: 2, column: 10 }, end: { line: 2, column: 21 } } })]);
  });

  it.each([
    "ReactDOM.createPortal(x,y);", "ReactDOM['createPortal'](x,y);", "ReactDOM[`createPortal`](x,y);",
    "function f(ReactDOM){ReactDOM.findDOMNode(x)}", "{const ReactDOM = other; ReactDOM.findDOMNode(x);}",
    "try {} catch(ReactDOM) {ReactDOM.findDOMNode(x);}", "const object = { ReactDOM: 1 };",
    "type T=ReactDOM.Other;", "// ReactDOM.findDOMNode(x)\nconst text = 'ReactDOM.findDOMNode';",
    "ReactDOM(x);", "new ReactDOM(x);",
  ])("does not attribute an unrelated or shadowed use: %s", tail => {
    expect(run(`import ReactDOM from 'react-dom'; ${tail}`).gaps).toEqual([]);
  });

  it.each([
    "ReactDOM['findDOMNode'](x);", "ReactDOM[key](x);", "const alias=ReactDOM;", "consume(ReactDOM);",
    "export {ReactDOM as dom};", "export default ReactDOM;", "type T=ReactDOM.findDOMNode;",
    "const o={ReactDOM};", "function f(){return ReactDOM;}", "const alias = condition && ReactDOM;",
    "const o = {...ReactDOM};", "const a = [ReactDOM];", "(ReactDOM as any).findDOMNode(x);",
    "ReactDOM?.findDOMNode(x);", "const C = <Widget dom={ReactDOM}/>;",
  ])("preserves a gap for unsupported access or propagation: %s", tail => {
    const result = run(`import ReactDOM from 'react-dom'; ${tail}`);
    expect(result.status).toBe("partial");
    expect(result.gaps.some(gap => gap.code === "UNSUPPORTED_TARGET_PATTERN" && gap.affectsConclusion)).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("tracks default specifier aliases and nested declarations, while excluding other modules", () => {
    expect(run("import {default as DOM} from 'react-dom'; DOM.findDOMNode(x);").status).toBe("partial");
    expect(run("declare module 'wrapper' {import DOM from 'react-dom'; type T=DOM.findDOMNode;}").status).toBe("partial");
    expect(run("import DOM from 'react-dom-extra'; DOM.findDOMNode(x);").gaps).toEqual([]);
  });

  it("keeps supported named evidence alongside the default-import gap", () => {
    const result = run("import ReactDOM,{findDOMNode} from 'react-dom'; findDOMNode(x); ReactDOM.findDOMNode(x);");
    expect(result.status).toBe("partial");
    expect(result.findings.map(finding => finding.kind)).toEqual(["value-reference"]);
  });
});
