import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseApiTarget, validateScanReport } from "../src/domain/index.js";
import { renderReport } from "../src/reports/render.js";
import { scanLocal } from "../src/scans/index.js";

const temporaryBase = resolve(".test-tmp", "reexport-alias");
const target = parseApiTarget({ packageName: "pkg", exportName: "oldApi" });
let root = "";

function assertTemporaryChild(candidate: string): void {
  const child = relative(temporaryBase, resolve(candidate));
  if (child === "" || isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\")) {
    throw new Error("refusing cleanup outside the re-export test directory");
  }
}

beforeEach(async () => {
  await mkdir(temporaryBase, { recursive: true });
  root = await mkdtemp(join(temporaryBase, `${process.pid}-`));
});

afterEach(async () => {
  assertTemporaryChild(root);
  await rm(root, { recursive: true, force: true });
});

describe("quoted direct re-export aliases", () => {
  it.each(["", " ", "line\\nname"])("keeps legal alias %j reportable", async escapedAlias => {
    const source = `export { oldApi as "${escapedAlias}" } from "pkg";\nimport { oldApi } from "pkg";\noldApi();\n`;
    await writeFile(join(root, "source.ts"), source);

    const report = await scanLocal(root, target);
    const result = report.results[0]!;
    const direct = result.findings.find(finding => finding.kind === "direct-reexport")!;
    const binding = result.bindings.find(value => value.id === direct.bindingId)!;
    const decodedAlias = escapedAlias === "line\\nname" ? "line\nname" : escapedAlias;

    expect(result.status).toBe("complete-within-scope");
    expect(binding).toMatchObject({ form: "esm-reexport", localName: decodedAlias });
    expect(direct.location).toEqual({
      file: "source.ts", start: { line: 1, column: 20 },
      end: { line: 1, column: 22 + escapedAlias.length },
    });
    expect(result.findings.map(finding => finding.kind)).toContain("value-reference");

    const json = renderReport(report, "json");
    expect(validateScanReport(JSON.parse(json)).results[0]!.findings).toHaveLength(2);
    const renderedText = renderReport(report, "text");
    expect(renderedText).not.toContain("line\nname");
    if (escapedAlias === "line\\nname") expect(renderedText).toContain("line\\u000aname");
  });
});
