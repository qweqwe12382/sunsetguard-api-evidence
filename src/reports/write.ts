import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";

import { isWithinRoot } from "../snapshots/index.js";

export class ReportWriteError extends Error {
  constructor() {
    super("The report could not be safely published. Use a new file outside the source root with an existing parent directory.");
    this.name = "ReportWriteError";
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function checkedPath(value: string): string {
  if (typeof value !== "string" || value.trim() === "" ||
      Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\")) throw new ReportWriteError();
  const absolute = resolve(value);
  const segments = absolute.slice(parse(absolute).root.length).split(/[\\/]/u);
  // Reject Windows aliases even on another platform so a report path has one
  // meaning. In particular, NUL.json and filename:stream are not ordinary files.
  if (segments.some(segment => /[<>:"|?*]/u.test(segment) || /[ .]$/u.test(segment) ||
      /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(segment))) {
    throw new ReportWriteError();
  }
  return absolute;
}

interface Boundary {
  lexical: string;
  canonical: string;
  ancestor: string;
  canonicalAncestor: string;
  ancestorIdentity: BigIntStats;
  canonicalIdentity: BigIntStats;
}

/** A missing root still reserves its potential path below the closest existing
 * ancestor. Broken links, inaccessible ancestors and non-directory traversal
 * cannot establish a safe boundary and deliberately fail closed.
 */
async function observeBoundary(lexical: string): Promise<Boundary> {
  let ancestor = lexical;
  const suffix: string[] = [];
  for (;;) {
    let identity: BigIntStats;
    try {
      identity = await lstat(ancestor, { bigint: true });
    } catch (error) {
      if (!missing(error)) throw new ReportWriteError();
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new ReportWriteError();
      suffix.unshift(basename(ancestor));
      ancestor = parent;
      continue;
    }
    const canonicalAncestor = checkedPath(await realpath(ancestor));
    const canonicalIdentity = await lstat(canonicalAncestor, { bigint: true });
    if (canonicalIdentity.isSymbolicLink() ||
        (!canonicalIdentity.isDirectory() && !canonicalIdentity.isFile()) ||
        (suffix.length > 0 && !canonicalIdentity.isDirectory())) throw new ReportWriteError();
    return {
      lexical, canonical: join(canonicalAncestor, ...suffix), ancestor, canonicalAncestor,
      ancestorIdentity: identity, canonicalIdentity,
    };
  }
}

function sameBoundary(left: Boundary, right: Boundary): boolean {
  return left.lexical === right.lexical && left.canonical === right.canonical &&
    left.ancestor === right.ancestor && left.canonicalAncestor === right.canonicalAncestor &&
    sameIdentity(left.ancestorIdentity, right.ancestorIdentity) &&
    sameIdentity(left.canonicalIdentity, right.canonicalIdentity);
}

function requireOutside(boundaries: readonly Boundary[], lexical: string, canonical: string): void {
  for (const root of boundaries) {
    if (isWithinRoot(root.lexical, lexical) || isWithinRoot(root.canonical, lexical) ||
        isWithinRoot(root.lexical, canonical) || isWithinRoot(root.canonical, canonical)) throw new ReportWriteError();
  }
}

async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  throw new ReportWriteError();
}

/** Publish complete bytes atomically without overwriting an existing destination.
 * Parent directories must exist. Path identity checks are not OS-level isolation
 * against hostile concurrent ancestor replacement; no source code is executed.
 */
export async function writeReportOutsideSource(sourceRoot: string, outputPath: string, contents: string): Promise<void> {
  // Preserve the original single-source API's accessible-directory requirement.
  try {
    const source = await realpath(checkedPath(sourceRoot));
    if (!(await lstat(source)).isDirectory()) throw new ReportWriteError();
  } catch {
    throw new ReportWriteError();
  }
  await writeReportOutsideSources([sourceRoot], outputPath, contents);
}

/** Protect every input boundary, including a manifest file, cache directory or
 * missing source root. An empty list supports reports for remote-only inputs.
 */
export async function writeReportOutsideSources(
  sourceRoots: readonly string[], outputPath: string, contents: string,
): Promise<void> {
  let handle: FileHandle | undefined;
  let temporary: string | undefined;
  let temporaryIdentity: BigIntStats | undefined;
  let parent: string | undefined;
  let parentIdentity: BigIntStats | undefined;
  let output: string | undefined;
  let outputLinked = false;
  let failed = false;
  try {
    const lexicalOutput = checkedPath(outputPath);
    const boundaries: Boundary[] = [];
    for (const root of new Set(sourceRoots.map(checkedPath))) boundaries.push(await observeBoundary(root));
    const outputParent = await observeBoundary(dirname(lexicalOutput));
    if (outputParent.ancestor !== outputParent.lexical || !outputParent.canonicalIdentity.isDirectory()) {
      throw new ReportWriteError();
    }
    parent = outputParent.canonical;
    parentIdentity = outputParent.canonicalIdentity;
    const publishedPath = join(parent, basename(lexicalOutput));
    output = publishedPath;
    requireOutside(boundaries, lexicalOutput, publishedPath);
    await absent(publishedPath);

    const checkParents = async (): Promise<void> => {
      for (const boundary of boundaries) {
        if (!sameBoundary(boundary, await observeBoundary(boundary.lexical))) throw new ReportWriteError();
      }
      if (!sameBoundary(outputParent, await observeBoundary(outputParent.lexical)) ||
          !sameIdentity(parentIdentity!, await lstat(parent!, { bigint: true })) ||
          await realpath(parent!) !== parent) throw new ReportWriteError();
      requireOutside(boundaries, lexicalOutput, publishedPath);
      if (temporary !== undefined) requireOutside(boundaries, join(dirname(lexicalOutput), basename(temporary)), temporary);
    };

    await checkParents();
    temporary = join(parent, `.sunsetguard-${randomUUID()}.tmp`);
    // Also validate the staging path, rather than assuming the parent is safe.
    requireOutside(boundaries, join(dirname(lexicalOutput), basename(temporary)), temporary);
    handle = await open(temporary, "wx", 0o600);
    temporaryIdentity = await handle.stat({ bigint: true });
    if (!temporaryIdentity.isFile() || temporaryIdentity.nlink !== 1n) throw new ReportWriteError();
    await checkParents();
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    if (!sameIdentity(temporaryIdentity, written) || written.nlink !== 1n ||
        written.size !== BigInt(Buffer.byteLength(contents, "utf8"))) throw new ReportWriteError();
    await handle.close();
    handle = undefined;

    await checkParents();
    const staged = await lstat(temporary, { bigint: true });
    if (!staged.isFile() || staged.nlink !== 1n || !sameIdentity(temporaryIdentity, staged) ||
        staged.size !== written.size) throw new ReportWriteError();
    await absent(publishedPath);
    // link is an atomic create-if-absent; rename would silently replace a file
    // that appeared after preflight. Both names are on the same filesystem.
    await link(temporary, publishedPath);
    outputLinked = true;
    await checkParents();
    const published = await lstat(publishedPath, { bigint: true });
    if (!published.isFile() || published.nlink !== 2n || !sameIdentity(temporaryIdentity, published)) throw new ReportWriteError();
  } catch {
    failed = true;
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch { failed = true; }
    }
    const parentIsStillTrusted = async (): Promise<boolean> => {
      if (parent === undefined || parentIdentity === undefined) return false;
      try {
        return await realpath(parent) === parent && sameIdentity(parentIdentity, await lstat(parent, { bigint: true }));
      } catch {
        return false;
      }
    };
    if (temporary !== undefined && temporaryIdentity !== undefined && parent !== undefined && parentIdentity !== undefined) {
      try {
        // Never unlink a replacement file or traverse a replaced parent during cleanup.
        if (!await parentIsStillTrusted()) {
          failed = true;
        } else {
          const staged = await lstat(temporary, { bigint: true });
          if (!staged.isFile() || !sameIdentity(temporaryIdentity, staged)) failed = true;
          else await unlink(temporary);
        }
      } catch { failed = true; }
    }
    if (failed && outputLinked && output !== undefined && temporaryIdentity !== undefined) {
      // A successful hard link must not make a failed publication look
      // successful. Run this after staging cleanup so a cleanup failure also
      // rolls back the published name. Remove it only while the original
      // parent is still trusted and the name still identifies our file.
      if (await parentIsStillTrusted()) {
        try {
          const published = await lstat(output, { bigint: true });
          if (published.isFile() && sameIdentity(temporaryIdentity, published)) await unlink(output);
        } catch (error) {
          if (!missing(error)) failed = true;
        }
      }
    }
  }
  if (failed) throw new ReportWriteError();
}
