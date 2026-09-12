import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { analyzeFile } from "../src/analyzer/index.js";
import { parseApiTarget } from "../src/domain/index.js";
import { captureLocalSnapshot } from "../src/snapshots/index.js";

async function removeOwnedTemporaryDirectory(root: string, parent: string): Promise<void> {
  if (path.dirname(root) !== parent || !path.basename(root).startsWith("analyzer-")) {
    throw new Error("Refusing cleanup outside the owned temporary directory");
  }
  await rm(root, { recursive: true, force: true });
}

it("analyzes captured bytes with reproducible positions without executing or changing the source", async () => {
  const parent = path.resolve(".test-tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "analyzer-"));
  const filename = path.join(root, "consumer.ts");
  const source = '\ufeffimport { oldApi as legacy } from "pkg";\r\nthrow new Error("fixture must never execute");\r\nconst value = legacy;\r\n';
  try {
    await writeFile(filename, source, "utf8");
    const captured = await captureLocalSnapshot(root);
    expect(captured.status).toBe("complete-within-scope");
    expect(captured.files).toHaveLength(1);
    const file = captured.files[0]!;
    expect(file.contentHash).toBe(createHash("sha256").update(Buffer.from(source)).digest("hex"));
    const result = analyzeFile(file, parseApiTarget({ packageName: "pkg", exportName: "oldApi" }));
    expect(result.status).toBe("complete-within-scope");
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.kind).toBe("value-reference");
    expect(finding.location.file).toBe("consumer.ts");
    const { start, end } = finding.location;
    expect(start.line).toBe(3);
    expect(end.line).toBe(3);
    expect(source.split("\r\n")[start.line - 1]!.slice(start.column - 1, end.column - 1)).toBe("legacy");
    expect(result.bindings[0]!.attribution.status).toBe("declared-module");
    expect(await readFile(filename, "utf8")).toBe(source);
  } finally {
    await removeOwnedTemporaryDirectory(root, parent);
  }
});
