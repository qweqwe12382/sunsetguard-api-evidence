import { z } from "zod";

const nonEmptyText = z.string().refine(value => value.length > 0 && value === value.trim(), "must be a non-empty trimmed string");
const count = z.number().int().nonnegative().safe();

const safeRelativePath = z.string().min(1).superRefine((path, context) => {
  const segments = path.split("/");
  const hasControl = [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\") || hasControl || segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    context.addIssue({ code: "custom", message: "must be a safe normalized relative path" });
  }
});

const positionSchema = z.strictObject({ line: z.number().int().min(1).safe(), column: z.number().int().min(1).safe() });
export const locationSchema = z.strictObject({ file: safeRelativePath, start: positionSchema, end: positionSchema }).superRefine((location, context) => {
  if (location.end.line < location.start.line || (location.end.line === location.start.line && location.end.column < location.start.column)) {
    context.addIssue({ code: "custom", path: ["end"], message: "must not precede start" });
  }
});

export const apiTargetInputSchema = z.strictObject({
  id: nonEmptyText.optional(), packageName: nonEmptyText, moduleSpecifier: nonEmptyText.optional(), exportName: nonEmptyText,
  deprecation: z.strictObject({
    status: z.enum(["user-declared", "verified"]), packageVersion: nonEmptyText.optional(),
    sourceUrl: z.url().optional(), checkedAt: z.iso.datetime().optional(),
  }).optional(),
});
const apiTargetSchema = apiTargetInputSchema.extend({ id: nonEmptyText, moduleSpecifier: nonEmptyText });

export const bindingSchema = z.strictObject({
  id: nonEmptyText, targetId: nonEmptyText, location: locationSchema, localName: z.string().optional(),
  form: z.enum(["esm-named", "esm-namespace", "esm-reexport", "cjs-namespace", "cjs-destructure"]),
  importSpace: z.enum(["value", "type"]),
  attribution: z.strictObject({
    status: z.enum(["declared-module", "manifest-corroborated", "ambiguous"]), reasons: z.array(nonEmptyText),
    manifestFile: safeRelativePath.optional(), declaredRange: nonEmptyText.optional(),
    dependencyKind: z.enum(["dependency", "devDependency", "peerDependency", "optionalDependency", "unknown"]).optional(),
    resolvedVersion: nonEmptyText.optional(),
  }),
}).superRefine((binding, context) => {
  if (binding.form !== "esm-reexport" && binding.localName !== undefined &&
      (binding.localName.length === 0 || binding.localName !== binding.localName.trim())) {
    context.addIssue({ code: "custom", path: ["localName"], message: "must be a non-empty trimmed local binding name" });
  }
});

export const findingSchema = z.strictObject({
  id: nonEmptyText, targetId: nonEmptyText, bindingId: nonEmptyText,
  kind: z.enum(["import-only", "value-reference", "type-reference", "direct-reexport"]),
  location: locationSchema, ruleId: nonEmptyText, snippet: z.string().optional(), snippetRedacted: z.boolean().optional(),
});

export const gapSchema = z.strictObject({
  code: z.enum(["SOURCE_UNAVAILABLE", "NO_ANALYZABLE_FILES", "FILE_READ_FAILED", "PARSE_FAILED", "RESOURCE_LIMIT", "SYMLINK_SKIPPED", "SNAPSHOT_CHANGED", "UNSUPPORTED_TARGET_PATTERN", "MODULE_ATTRIBUTION_AMBIGUOUS", "CONFIG_UNRESOLVED"]),
  message: nonEmptyText, targetId: nonEmptyText.optional(), location: locationSchema.optional(), affectsConclusion: z.boolean(),
});

const snapshotSchema = z.strictObject({
  kind: z.enum(["local", "git"]), sourceId: nonEmptyText, contentHash: nonEmptyText, scopeHash: nonEmptyText,
  gitCommit: nonEmptyText.optional(), dirty: z.boolean().optional(),
});
const inventorySchema = z.strictObject({
  discoveredFiles: count, excludedByPolicy: count, eligibleFiles: count, analyzedFiles: count, failedOrSkippedEligibleFiles: count,
});

export const repositoryTargetResultSchema = z.strictObject({
  repositoryId: nonEmptyText, targetId: nonEmptyText, snapshot: snapshotSchema.optional(),
  status: z.enum(["complete-within-scope", "partial", "failed"]),
  bucket: z.enum(["detected", "not-detected-within-scope", "unknown"]),
  inventory: inventorySchema, bindings: z.array(bindingSchema), findings: z.array(findingSchema), gaps: z.array(gapSchema),
});

export const scanReportSchema = z.strictObject({
  schemaVersion: z.literal("0.1"), reportKind: z.enum(["scan", "synthetic-example"]),
  analyzerVersion: nonEmptyText, ruleSetVersion: nonEmptyText, analysisProfile: z.literal("module-syntax-v1"),
  generatedAt: z.iso.datetime(), target: apiTargetSchema, limitations: z.array(nonEmptyText),
  sample: z.strictObject({
    source: z.enum(["local", "explicit-list", "provider"]), selected: count, excluded: count, attempted: count,
    knownTotal: count.nullable(), knownTotalUnit: z.enum(["repositories", "unknown"]),
    exclusionReasons: z.record(z.string(), count),
  }),
  summary: z.strictObject({ detected: count, notDetectedWithinScope: count, unknown: count, completeWithinScope: count, partial: count, failed: count }),
  results: z.array(repositoryTargetResultSchema),
});
