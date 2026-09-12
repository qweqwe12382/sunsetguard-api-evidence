import { describe, expect, it } from "vitest";
import type { Location } from "../src/domain/index.js";
import { createRedactedSnippet, createSnippetBuilder, SNIPPET_MAX_CHARS, SNIPPET_POLICY_VERSION } from "../src/reports/snippets.js";

const at = (line: number, column: number, length: number): Location => ({ file: "src/input.ts", start: { line, column }, end: { line, column: column + length } });

describe("frozen-byte token excerpts", () => {
  it("removes every surrounding literal, template, comment, number and other identifier", () => {
    const source = "const privateIdentifier = oldApi('literal-canary', `template-canary`, 918273, /regex-canary/); // comment-canary";
    const snippet = createRedactedSnippet(Buffer.from(source), at(1, source.indexOf("oldApi") + 1, 6), ["oldApi"]);
    expect(snippet).toEqual({ snippet: "[…] oldApi […]", snippetRedacted: true });
    for (const value of ["privateIdentifier", "literal-canary", "template-canary", "918273", "regex-canary", "comment-canary"]) expect(snippet!.snippet).not.toContain(value);
    expect(SNIPPET_POLICY_VERSION).toContain("t10");
  });

  it("retains only the chosen occurrence even when the same name appears in secret-looking text", () => {
    const source = "const secret = 'oldApi'; oldApi(); // oldApi";
    const snippet = createRedactedSnippet(Buffer.from(source), at(1, source.indexOf("oldApi()") + 1, 6), ["oldApi"]);
    expect(snippet!.snippet.match(/oldApi/g)).toHaveLength(1);
    expect(snippet!.snippet).toBe("[…] oldApi […]");
  });

  it("uses the alias and one-based UTF-16 positions without exposing adjacent Unicode content", () => {
    const source = "'😀绝密'; 遗留API()";
    const snippet = createRedactedSnippet(Buffer.from(source), at(1, source.indexOf("遗留API") + 1, 5), ["oldApi", "遗留API"]);
    expect(snippet).toEqual({ snippet: "[…] 遗留API […]", snippetRedacted: true });
  });

  it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])("indexes JavaScript line endings accurately: %j", ending => {
    const source = `comment-canary${ending}  oldApi();${ending}tail-canary`;
    const build = createSnippetBuilder(Buffer.from(source));
    expect(build(at(2, 3, 6), ["oldApi"])).toEqual({ snippet: "oldApi […]", snippetRedacted: true });
    expect(build(at(1, 3, 6), ["oldApi"])).toBeUndefined();
  });

  it("preserves BOM offsets and copies decoded bytes once for repeated token lookups", () => {
    const bytes = Buffer.from("\ufeffoldApi(); alias()");
    const build = createSnippetBuilder(bytes);
    bytes.fill(0);
    expect(build(at(1, 2, 6), ["oldApi"])).toEqual({ snippet: "oldApi […]", snippetRedacted: true });
    expect(build(at(1, 12, 5), ["alias"])).toEqual({ snippet: "[…] alias […]", snippetRedacted: true });
  });

  it("refuses mismatched tokens, multiline positions, invalid coordinates, huge tokens and malformed UTF-8", () => {
    const build = createSnippetBuilder(Buffer.from("oldApi();\nother"));
    expect(build(at(1, 1, 6), ["other"])).toBeUndefined();
    expect(build(at(1, 1, 9), ["oldApi();"])).toBeUndefined();
    expect(build({ ...at(1, 1, 6), end: { line: 2, column: 1 } }, ["oldApi"])).toBeUndefined();
    for (const coordinate of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(build(at(1, coordinate, 6), ["oldApi"])).toBeUndefined();
    expect(build(at(100, 1, 6), ["oldApi"])).toBeUndefined();
    expect(build(at(1, 1, 500), ["oldApi"])).toBeUndefined();
    expect(createSnippetBuilder(Uint8Array.from([0xff, 0xfe]))(at(1, 1, 6), ["oldApi"])).toBeUndefined();
  });

  it("bounds source size, line indexing and excerpt length", () => {
    expect(createSnippetBuilder(new Uint8Array(2 * 1024 * 1024 + 1))(at(1, 1, 6), ["oldApi"])).toBeUndefined();
    expect(createSnippetBuilder(Buffer.from(`${"\n".repeat(100_000)}oldApi`))(at(100_001, 1, 6), ["oldApi"])).toBeUndefined();
    const name = "a".repeat(148);
    const source = `secret; ${name}('secret')`;
    const snippet = createRedactedSnippet(Buffer.from(source), at(1, 9, name.length), [name]);
    expect(snippet).toBeDefined();
    expect(snippet!.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(snippet!.snippet).not.toContain("secret");
  });
});
