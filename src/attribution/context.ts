import { posix } from "node:path";

import { locationSchema } from "../domain/index.js";
import type { AnalysisGap, ApiTarget, Binding } from "../domain/index.js";
import type { SnapshotFile } from "../snapshots/index.js";
import { resolveConfigPaths } from "./config.js";
import { hasDuplicateJsonKeys } from "./json-keys.js";
import { ATTRIBUTION_LIMITS, createConfigReader } from "./reader.js";
import type { AttributionOptions, ConfigData } from "./reader.js";

export interface AttributionContext {
  apply(filePath: string, bindings: readonly Binding[]): { bindings: Binding[]; gaps: AnalysisGap[] };
  contentHash: string;
  gaps: AnalysisGap[];
}
interface Nearest { path: string; data: ConfigData }
interface SourceAttribution {
  attribution: Binding["attribution"];
  unresolved: string[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const declared = (): Binding["attribution"] => ({ status: "declared-module", reasons: ["Source declares the exact target module; runtime resolution is not verified."] });
const ambiguous = (reasons: string[]): Binding["attribution"] => ({ status: "ambiguous", reasons });
const sections = [
  ["dependencies", "dependency"], ["devDependencies", "devDependency"],
  ["peerDependencies", "peerDependency"], ["optionalDependencies", "optionalDependency"],
] as const;

function workspacePatterns(data: ConfigData): { patterns: string[]; unresolved: boolean } {
  if (data.kind === "missing") return { patterns: [], unresolved: false };
  if (data.kind !== "ok") return { patterns: [], unresolved: true };
  try {
    const raw: unknown = JSON.parse(data.text);
    if (!object(raw) || !own(raw, "workspaces")) return { patterns: [], unresolved: false };
    if (hasDuplicateJsonKeys("package.json", data.text)) return { patterns: [], unresolved: true };
    const value = object(raw.workspaces) ? raw.workspaces.packages : raw.workspaces;
    if (!Array.isArray(value) || value.length > 128 || !value.every(pattern => typeof pattern === "string" &&
        pattern.length > 0 && pattern.length <= 512 && !pattern.startsWith("/") &&
        !pattern.includes("\\") && !pattern.includes(":") && !pattern.split("/").includes("..") &&
        !/[!{}[\]?]/.test(pattern) && pattern.split("*").length <= 2)) return { patterns: [], unresolved: true };
    return { patterns: value as string[], unresolved: false };
  } catch { return { patterns: [], unresolved: true }; }
}
function matchesWorkspace(pattern: string, path: string): boolean {
  if (pattern.startsWith("./")) pattern = pattern.slice(2);
  if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === path;
  const prefix = pattern.slice(0, star), suffix = pattern.slice(star + 1);
  return path.length >= prefix.length + suffix.length && path.startsWith(prefix) && path.endsWith(suffix) &&
    !path.slice(prefix.length, path.length - suffix.length).includes("/");
}

function manifestAttribution(nearest: Nearest | undefined, target: ApiTarget): SourceAttribution {
  if (nearest === undefined) return { attribution: declared(), unresolved: [] };
  if (nearest.data.kind !== "ok") {
    return { attribution: ambiguous(["The nearest manifest could not be verified."]),
      unresolved: [nearest.data.kind === "failed" ? nearest.data.reason : "The selected manifest became unavailable."] };
  }
  let raw: unknown;
  try {
    if (hasDuplicateJsonKeys(nearest.path, nearest.data.text)) {
      return { attribution: ambiguous(["The nearest manifest contains duplicate keys."]), unresolved: ["Duplicate manifest keys make the dependency context ambiguous."] };
    }
    raw = JSON.parse(nearest.data.text);
  }
  catch { return { attribution: ambiguous(["The nearest manifest is unresolved."]), unresolved: ["The nearest package manifest is not valid JSON."] }; }
  if (!object(raw)) return { attribution: ambiguous(["The nearest manifest is unresolved."]), unresolved: ["The nearest package manifest must be a JSON object."] };
  const unresolved: string[] = [];
  const declarations: { range: string; kind: typeof sections[number][1] }[] = [];
  for (const [section, kind] of sections) {
    const values = raw[section];
    if (!own(raw, section)) continue;
    if (!object(values)) { unresolved.push("A manifest dependency section has an unsupported shape."); continue; }
    if (!own(values, target.packageName)) continue;
    const range = values[target.packageName];
    if (typeof range !== "string" || range.trim() !== range || range.length === 0 || range.length > 512) {
      unresolved.push("The target dependency declaration could not be represented safely.");
    } else declarations.push({ range, kind });
  }
  if (unresolved.length > 0) return { attribution: ambiguous(["The target manifest context is unresolved."]), unresolved: [...new Set(unresolved)] };
  const reasons: string[] = [];
  if (raw.name === target.packageName) reasons.push("The nearest package declares the target package name locally.");
  for (const { range } of declarations) {
    if (/^(?:npm:|file:|link:|workspace:)/i.test(range)) reasons.push("The target dependency uses an alias, local path, or workspace protocol.");
    // Do not copy paths, URLs or recognizable access-token formats into report metadata.
    else if (!/^[a-zA-Z0-9*^~<>=| .+_-]+$/.test(range) || /^(?:npm_|gh[pousr]_|github_pat_|sk-)/i.test(range)) {
      reasons.push("The target dependency is not a safely reportable registry range or tag.");
    }
  }
  if (new Set(declarations.map(entry => entry.range)).size > 1) reasons.push("Dependency sections declare conflicting target ranges.");
  if (reasons.length > 0) return { attribution: ambiguous([...new Set(reasons)]), unresolved: [] };
  const first = declarations[0];
  if (first === undefined) return { attribution: declared(), unresolved: [] };
  const kinds = new Set(declarations.map(entry => entry.kind));
  return { attribution: {
    status: "manifest-corroborated",
    reasons: ["The nearest manifest declares the target registry dependency; runtime resolution is not verified."],
    manifestFile: nearest.path,
    declaredRange: first.range,
    dependencyKind: kinds.size === 1 ? first.kind : "unknown",
  }, unresolved: [] };
}

/** Freeze source-relative provenance context. apply() performs no filesystem access. */
export async function createAttributionContext(
  rootPath: string, target: ApiTarget, sourceFiles: readonly SnapshotFile[], options: AttributionOptions = {},
): Promise<AttributionContext> {
  const reader = await createConfigReader(rootPath, options);
  const gaps: AnalysisGap[] = [];
  const states = new Map<string, SourceAttribution>();
  const nearestCache = new Map<string, Nearest | undefined>();
  const configCache = new Map<string, Awaited<ReturnType<typeof resolveConfigPaths>>>();
  const workspaces = sourceFiles.length === 0 ? { patterns: [], unresolved: false } : workspacePatterns(await reader.read("package.json"));
  const observedLocalTargets = new Set<string>();
  let limitIssue: string | undefined;
  function gap(code: AnalysisGap["code"], message: string): AnalysisGap {
    return { code, message, targetId: target.id, affectsConclusion: true };
  }
  async function nearest(start: string, name: string): Promise<Nearest | undefined> {
    let dir = start;
    const visited: string[] = [];
    let selected: Nearest | undefined;
    while (true) {
      const key = `${dir}/${name}`;
      if (nearestCache.has(key)) { selected = nearestCache.get(key); break; }
      visited.push(key);
      const path = dir === "." ? name : `${dir}/${name}`;
      const data = await reader.read(path);
      if (data.kind !== "missing") { selected = { path, data }; break; }
      if (dir === ".") break;
      dir = posix.dirname(dir);
    }
    for (const key of visited) nearestCache.set(key, selected);
    return selected;
  }

  for (let index = 0; index < sourceFiles.length; index += 1) {
    if (index >= ATTRIBUTION_LIMITS.maxLookups) { limitIssue = "The source attribution context budget was exhausted."; break; }
    const source = sourceFiles[index]!;
    if (states.has(source.path)) continue;
    const stopped = reader.resourceIssue;
    if (stopped !== undefined) { limitIssue = stopped; break; }
    if (!locationSchema.safeParse({ file: source.path, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }).success ||
        source.path.includes(":") || source.path.split("/").length > ATTRIBUTION_LIMITS.maxDepth + 1) {
      states.set(source.path, { attribution: ambiguous(["The source path cannot be used for bounded configuration lookup."]),
        unresolved: ["Configuration lookup for a source path was rejected."] });
      continue;
    }
    const directory = posix.dirname(source.path);
    const manifest = await nearest(directory, "package.json");
    const state = manifestAttribution(manifest, target);
    if (manifest?.data.kind === "ok") {
      try {
        const raw: unknown = JSON.parse(manifest.data.text);
        if (object(raw) && raw.name === target.packageName) observedLocalTargets.add(posix.dirname(manifest.path));
      } catch { /* The manifest attribution above already preserves the parse gap. */ }
    }
    const config = await nearest(directory, "tsconfig.json");
    if (config !== undefined) {
      if (config.data.kind !== "ok") {
        state.unresolved.push(config.data.kind === "failed" ? config.data.reason : "The selected TypeScript configuration is missing.");
      } else {
        let resolution = configCache.get(config.path);
        if (resolution === undefined) {
          resolution = await resolveConfigPaths(config.path, config.data.text, target.moduleSpecifier, path => reader.read(path));
          configCache.set(config.path, resolution);
        }
        state.unresolved.push(...resolution.unresolved);
        if (resolution.pathsMayMatchTarget) {
          state.attribution = ambiguous(["TypeScript paths may remap the target module declaration.",
            ...(state.attribution.status === "ambiguous" ? state.attribution.reasons : [])]);
        }
      }
    }
    if (state.unresolved.length > 0) {
      state.unresolved = [...new Set(state.unresolved)];
      state.attribution = ambiguous(["The target source configuration could not be fully checked.",
        ...(state.attribution.status === "ambiguous" ? state.attribution.reasons : [])]);
    }
    states.set(source.path, state);
  }
  const localWorkspaceTarget = [...observedLocalTargets].some(path => workspaces.patterns.some(pattern => matchesWorkspace(pattern, path)));
  for (const state of states.values()) {
    if (workspaces.unresolved) state.unresolved.push("The root workspace configuration could not be checked safely.");
    if (localWorkspaceTarget || workspaces.unresolved) {
      state.attribution = ambiguous([localWorkspaceTarget ? "A captured workspace manifest provides the target package locally." : "The workspace source context is unresolved.",
        ...(state.attribution.status === "ambiguous" ? state.attribution.reasons : [])]);
    }
  }
  limitIssue ??= reader.resourceIssue;
  if (limitIssue !== undefined) gaps.push(gap("RESOURCE_LIMIT", limitIssue));
  const contentHash = reader.contentHash;
  return {
    contentHash,
    gaps,
    apply(filePath, bindings) {
      if (bindings.length > 50_000) return { bindings: [], gaps: [gap("RESOURCE_LIMIT", "The file attribution binding budget was exhausted.")] };
      const state = states.get(filePath) ?? { attribution: ambiguous(["The source configuration was not captured within the declared limits."]),
        unresolved: ["The source configuration context is unavailable."] };
      const localGaps: AnalysisGap[] = state.unresolved.map(message => gap("CONFIG_UNRESOLVED", message));
      const attributed = bindings.map(binding => {
        if (binding.targetId !== target.id) return binding;
        if (state.attribution.status === "ambiguous") {
          localGaps.push({ ...gap("MODULE_ATTRIBUTION_AMBIGUOUS", "This binding is a source-attribution candidate and is excluded from confirmed detection."), location: binding.location });
        }
        return { ...binding, attribution: state.attribution };
      });
      return { bindings: attributed, gaps: localGaps };
    },
  };
}
