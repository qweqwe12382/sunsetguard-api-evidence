import ts from "typescript";
import { ATTRIBUTION_LIMITS, safeConfigPath } from "./reader.js";
import { hasDuplicateJsonKeys } from "./json-keys.js";

export type ConfigRead = (path: string) => Promise<{ kind: "ok"; text: string } | { kind: "missing" | "failed" }>;
export interface ConfigResolution { pathsMayMatchTarget: boolean; unresolved: string[] }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function extendsPath(base: string, value: string): string | undefined {
  // Bare specifiers are package configuration references, even when they end in .json.
  if (!value.startsWith("./") && !value.startsWith("../")) return undefined;
  if (value.includes("\\") || value.includes(":") || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return undefined;
  const parts = base.split("/").slice(0, -1);
  for (const part of value.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") { if (parts.length === 0) return undefined; parts.pop(); }
    else parts.push(part);
  }
  let file = parts.join("/");
  if (!/\.jsonc?$/i.test(file)) file += ".json";
  return safeConfigPath(file) ? file : undefined;
}
function matches(pattern: string, target: string): boolean {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === target;
  const prefix = pattern.slice(0, star), suffix = pattern.slice(star + 1);
  return target.length >= prefix.length + suffix.length && target.startsWith(prefix) && target.endsWith(suffix);
}

/** Resolve only a bounded JSONC inheritance graph; never resolve a package or load a Project. */
export async function resolveConfigPaths(path: string, text: string, target: string, read: ConfigRead): Promise<ConfigResolution> {
  const unresolved = new Set<string>();
  const stack = new Set<string>();
  let visits = 0;
  async function visit(file: string, body: string, depth: number): Promise<Record<string, unknown>> {
    visits += 1;
    if (depth > ATTRIBUTION_LIMITS.maxExtendsDepth || visits > ATTRIBUTION_LIMITS.maxFiles || Buffer.byteLength(body, "utf8") > ATTRIBUTION_LIMITS.maxFileBytes) {
      unresolved.add("The configuration inheritance resource budget was exhausted."); return {};
    }
    if (!safeConfigPath(file)) { unresolved.add("An unsafe configuration path was rejected."); return {}; }
    if (stack.has(file)) { unresolved.add("The configuration inheritance graph contains a cycle."); return {}; }
    stack.add(file);
    try {
      let value: unknown;
      try {
        if (hasDuplicateJsonKeys(file, body)) unresolved.add("Duplicate configuration keys make the source context ambiguous.");
        const parsed = ts.parseConfigFileTextToJson(file, body);
        if (parsed.error) { unresolved.add("A TypeScript configuration could not be parsed."); return {}; }
        value = parsed.config;
      } catch { unresolved.add("A TypeScript configuration exceeded parser limits."); return {}; }
      if (!object(value)) { unresolved.add("A TypeScript configuration must be an object."); return {}; }
      let inherited: Record<string, unknown> = {};
      if (own(value, "extends")) {
        const raw = value.extends;
        const parents = typeof raw === "string" ? [raw] : Array.isArray(raw) && raw.every(item => typeof item === "string") ? raw as string[] : undefined;
        if (parents === undefined) unresolved.add("Configuration extends must be a string or string array.");
        else for (const parent of parents) {
          if (visits >= ATTRIBUTION_LIMITS.maxFiles) { unresolved.add("The configuration inheritance resource budget was exhausted."); break; }
          const next = extendsPath(file, parent);
          if (next === undefined) { unresolved.add("A package or root-external configuration extends was not resolved."); continue; }
          let data: Awaited<ReturnType<ConfigRead>>;
          try { data = await read(next); }
          catch { unresolved.add("An extended configuration could not be read safely."); continue; }
          if (data.kind !== "ok") { unresolved.add(data.kind === "missing" ? "An extended configuration is missing." : "An extended configuration could not be read safely."); continue; }
          // Later parents override earlier compiler options. The child then overrides all parents.
          inherited = { ...inherited, ...await visit(next, data.text, depth + 1) };
        }
      }
      if (!own(value, "compilerOptions")) return inherited;
      const options = value.compilerOptions;
      if (!object(options)) { unresolved.add("Configuration compilerOptions must be an object."); return inherited; }
      if (own(options, "paths")) {
        const paths = options.paths;
        if (!object(paths)) unresolved.add("Configuration paths must be an object.");
        else for (const [key, replacements] of Object.entries(paths)) {
          if (key.split("*").length > 2 || !Array.isArray(replacements) ||
              !replacements.every(item => typeof item === "string" && item.split("*").length <= 2)) {
            unresolved.add("A paths mapping has an unsupported shape.");
          }
        }
      }
      return { ...inherited, ...options };
    } finally { stack.delete(file); }
  }
  const options = await visit(path, text, 0);
  const paths = options.paths;
  const pathsMayMatchTarget = object(paths) && Object.keys(paths).some(key => key.split("*").length <= 2 && matches(key, target));
  return { pathsMayMatchTarget, unresolved: [...unresolved] };
}
