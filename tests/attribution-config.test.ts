import { describe, expect, it, vi } from "vitest";
import { resolveConfigPaths } from "../src/attribution/config.js";
import type { ConfigRead } from "../src/attribution/config.js";
const missing: ConfigRead = async () => ({ kind: "missing" });
const paths = (key: string) => JSON.stringify({ compilerOptions: { paths: { [key]: ["./local"] } } });
const reader = (files: Record<string, string>): ConfigRead => async path =>
  files[path] === undefined ? { kind: "missing" } : { kind: "ok", text: files[path] };

describe("bounded JSONC configuration inheritance", () => {
  it.each([["pkg", "pkg", true], ["pkg/*", "pkg/x", true], ["*", "pkg", true], ["@scope/*", "@scope/pkg", true], ["other/*", "pkg/x", false], ["ab*bc", "abc", false]])("matches %s against %s", async (pattern, target, expected) => {
    expect((await resolveConfigPaths("tsconfig.json", paths(String(pattern)), String(target), missing)).pathsMayMatchTarget).toBe(expected);
  });
  it("accepts JSONC comments and trailing commas", async () => {
    const result = await resolveConfigPaths("tsconfig.json", '{//comment\n"compilerOptions":{"paths":{"pkg":["./local"],},},}', "pkg", missing);
    expect(result).toEqual({ pathsMayMatchTarget: true, unresolved: [] });
  });
  it.each(["{", "null", "[]", '{"extends":4}', '{"extends":[4]}', '{"compilerOptions":false}', '{"compilerOptions":{"paths":null}}', '{"compilerOptions":{"paths":"bad"}}', '{"compilerOptions":{"paths":{"p**g":["x"]}}}', '{"compilerOptions":{"paths":{"pkg":4}}}'])("reports invalid configuration: %s", async text => {
    expect((await resolveConfigPaths("tsconfig.json", text, "pkg", missing)).unresolved.length).toBeGreaterThan(0);
  });
  it("keeps malformed parent diagnostics even if child paths override them", async () => {
    const result = await resolveConfigPaths("tsconfig.json", '{"extends":"./base.json","compilerOptions":{"paths":{}}}', "pkg", reader({ "base.json": '{"compilerOptions":{"paths":null}}' }));
    expect(result.pathsMayMatchTarget).toBe(false);
    expect(result.unresolved.length).toBeGreaterThan(0);
  });
  it.each(["@org/config", "base.json", "../outside.json", "C:/private.json", "https://example.invalid/config.json"])("rejects %s before invoking the reader", async parent => {
    const read = vi.fn(missing);
    expect((await resolveConfigPaths("tsconfig.json", JSON.stringify({ extends: parent }), "pkg", read)).unresolved.length).toBeGreaterThan(0);
    expect(read).not.toHaveBeenCalled();
  });
  it("follows an internal parent and optional JSON suffix", async () => {
    const result = await resolveConfigPaths("src/tsconfig.json", '{"extends":"../base"}', "pkg", reader({ "base.json": paths("pkg") }));
    expect(result).toEqual({ pathsMayMatchTarget: true, unresolved: [] });
  });
  it("reports missing, failed and throwing readers", async () => {
    for (const read of [missing, async () => ({ kind: "failed" as const }), async () => { throw new Error("C:/secret"); }]) {
      const result = await resolveConfigPaths("tsconfig.json", '{"extends":"./base.json"}', "pkg", read);
      expect(result.unresolved.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain("C:/secret");
    }
  });
  it("child paths replace parent paths as one option", async () => {
    const result = await resolveConfigPaths("tsconfig.json", '{"extends":"./base.json","compilerOptions":{"paths":{}}}', "pkg", reader({ "base.json": paths("pkg") }));
    expect(result).toEqual({ pathsMayMatchTarget: false, unresolved: [] });
  });
  it("later parents override earlier paths", async () => {
    const result = await resolveConfigPaths("tsconfig.json", '{"extends":["./first.json","./last.json"]}', "pkg", reader({ "first.json": paths("pkg"), "last.json": paths("other") }));
    expect(result).toEqual({ pathsMayMatchTarget: false, unresolved: [] });
  });
  it("shared diamond parents do not create a cycle", async () => {
    const result = await resolveConfigPaths("tsconfig.json", '{"extends":["./a.json","./b.json"]}', "pkg", reader({ "a.json": '{"extends":"./base.json"}', "b.json": '{"extends":"./base.json"}', "base.json": paths("pkg") }));
    expect(result).toEqual({ pathsMayMatchTarget: true, unresolved: [] });
  });
  it("detects a real cycle", async () => {
    const result = await resolveConfigPaths("a.json", '{"extends":"./b.json"}', "pkg", reader({ "b.json": '{"extends":"./a.json"}', "a.json": '{"extends":"./b.json"}' }));
    expect(result.unresolved.some(message => message.includes("cycle"))).toBe(true);
  });
  it("bounds depth and repeated expansion work", async () => {
    const depthRead: ConfigRead = async path => ({ kind: "ok", text: JSON.stringify({ extends: `./${Number(path.slice(0, -5)) + 1}.json` }) });
    expect((await resolveConfigPaths("0.json", '{"extends":"./1.json"}', "pkg", depthRead)).unresolved.some(message => message.includes("budget"))).toBe(true);
    const repeated = vi.fn(reader({ "base.json": "{}" }));
    const result = await resolveConfigPaths("tsconfig.json", JSON.stringify({ extends: Array<string>(500).fill("./base.json") }), "pkg", repeated);
    expect(result.unresolved.some(message => message.includes("budget"))).toBe(true);
    expect(repeated.mock.calls.length).toBeLessThanOrEqual(128);
  });
  it("does not let an early matched key hide malformed later mappings", async () => {
    const result = await resolveConfigPaths("tsconfig.json", '{"compilerOptions":{"paths":{"pkg":["x"],"other":4}}}', "pkg", missing);
    expect(result.pathsMayMatchTarget).toBe(true);
    expect(result.unresolved.length).toBeGreaterThan(0);
  });
  it("reports duplicate JSONC keys before their context is overwritten", async () => {
    const result = await resolveConfigPaths("tsconfig.json", '{"compilerOptions":{"paths":{"pkg":["local"]}},"compilerOptions":{}}', "pkg", missing);
    expect(result.unresolved.some(message => message.includes("Duplicate"))).toBe(true);
  });
});
