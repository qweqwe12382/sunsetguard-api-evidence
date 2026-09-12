import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { hasDuplicateJsonKeys } from "../attribution/json-keys.js";
import { normalizeGitHubInput } from "../remote/policy.js";

export const CONSUMERS_VERSION = "0.1";
export const CONSUMERS_LIMITS = Object.freeze({ maxBytes: 256 * 1024, maxEntries: 50, maxDepth: 8 });
export class ConsumersInputError extends Error {
  constructor(message = "The consumers file must be bounded, valid JSON with supported repository entries.") { super(message); this.name = "ConsumersInputError"; }
}
const localPath = z.string().min(1).max(4096).refine(value => value.trim() === value && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const schema = z.strictObject({ schemaVersion: z.literal(CONSUMERS_VERSION), repositories: z.array(z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("github"), repository: z.string(), ref: z.string() }),
  z.strictObject({ kind: z.literal("local"), path: localPath }),
])).min(1).max(CONSUMERS_LIMITS.maxEntries) });

export type Consumer = Readonly<{ kind: "github"; repository: string; ref: string; repositoryId: string }> |
  Readonly<{ kind: "local"; path: string; repositoryId: string }>;
/** Paths in this execution plan are private inputs and must never be serialized into reports. */
export interface ConsumersPlan {
  readonly manifestPath: string;
  readonly selected: number;
  readonly duplicates: number;
  readonly entries: readonly Consumer[];
}
const preparedPlans = new WeakSet<ConsumersPlan>();
export const isPreparedConsumersPlan = (value: unknown): value is ConsumersPlan => typeof value === "object" && value !== null && preparedPlans.has(value as ConsumersPlan);

function boundedNesting(text: string): void {
  let depth = 0, quoted = false, escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > CONSUMERS_LIMITS.maxDepth) throw new ConsumersInputError();
    } else if (character === "}" || character === "]") depth--;
  }
}

async function canonicalPotential(path: string): Promise<string> {
  let current = path;
  const suffix: string[] = [];
  for (;;) {
    try { return join(await realpath(current), ...suffix); }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT" || dirname(current) === current) return path;
      suffix.unshift(basename(current)); current = dirname(current);
    }
  }
}

export async function readConsumers(path: string): Promise<ConsumersPlan> {
  try {
    if (typeof path !== "string" || !localPath.safeParse(path).success) throw new ConsumersInputError();
    const requested = resolve(path);
    const before = await lstat(requested, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(CONSUMERS_LIMITS.maxBytes)) throw new ConsumersInputError();
    const canonical = await realpath(requested);
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const same = (value: typeof before) => value.isFile() && value.nlink === 1n && value.dev === before.dev && value.ino === before.ino &&
        value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs;
      if (!same(await handle.stat({ bigint: true }))) throw new ConsumersInputError();
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== Number(before.size) || !same(await handle.stat({ bigint: true })) || !same(await lstat(requested, { bigint: true })) || await realpath(requested) !== canonical) throw new ConsumersInputError();
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    } finally { await handle.close(); }
    boundedNesting(text);
    const raw: unknown = JSON.parse(text);
    if (hasDuplicateJsonKeys("consumers.json", text)) throw new ConsumersInputError("Duplicate JSON keys are not allowed in consumers files.");
    const parsed = schema.parse(raw);
    const entries: Consumer[] = [];
    const identities = new Map<string, Consumer>();
    let duplicates = 0;
    for (const entry of parsed.repositories) {
      let consumer: Consumer;
      if (entry.kind === "github") {
        const input = normalizeGitHubInput({ repository: entry.repository, ref: entry.ref });
        consumer = { kind: "github", ...input, repositoryId: `github:${input.repository}` };
      } else {
        const root = await canonicalPotential(resolve(dirname(canonical), entry.path));
        const identity = process.platform === "win32" ? root.toLowerCase() : root;
        consumer = { kind: "local", path: root, repositoryId: `local:${createHash("sha256").update(identity).digest("hex")}` };
      }
      const prior = identities.get(consumer.repositoryId);
      if (prior !== undefined) {
        if (prior.kind === "github" && consumer.kind === "github" && prior.ref !== consumer.ref) throw new ConsumersInputError("Multiple refs for one repository require separate scans.");
        duplicates++;
      } else { entries.push(consumer); identities.set(consumer.repositoryId, consumer); }
    }
    const plan: ConsumersPlan = Object.freeze({ manifestPath: canonical, selected: parsed.repositories.length, duplicates,
      entries: Object.freeze(entries.map(entry => Object.freeze(entry))) });
    preparedPlans.add(plan);
    return plan;
  } catch (error) {
    if (error instanceof ConsumersInputError) throw error;
    throw new ConsumersInputError();
  }
}
