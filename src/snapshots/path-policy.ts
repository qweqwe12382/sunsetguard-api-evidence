import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export class UnsafeOutputPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutputPathError";
  }
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function requirePath(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new UnsafeOutputPathError("A non-empty filesystem path is required.");
  }
  if (process.platform === "win32") {
    const absolute = resolve(value);
    if (absolute.slice(parse(absolute).root.length).includes(":") || absolute.startsWith("\\\\.\\")) {
      throw new UnsafeOutputPathError("Device paths and alternate data streams are not supported.");
    }
  }
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Read-only preflight. This does not authorize overwriting an existing file and
 * is not a race-free write primitive: the eventual writer must revalidate paths.
 */
export async function assertOutputOutsideSource(sourceRoot: string, outputPath: string): Promise<string> {
  requirePath(sourceRoot);
  requirePath(outputPath);
  const lexicalRoot = resolve(sourceRoot);
  const lexicalOutput = resolve(outputPath);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(lexicalRoot);
    if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new UnsafeOutputPathError("The source root is not an accessible directory.");
  }
  if (isWithinRoot(lexicalRoot, lexicalOutput) || isWithinRoot(canonicalRoot, lexicalOutput)) {
    throw new UnsafeOutputPathError("Reports must be written outside the source root.");
  }

  let ancestor = lexicalOutput;
  const suffix: string[] = [];
  for (;;) {
    let observedAncestor = false;
    try {
      const metadata = await lstat(ancestor);
      observedAncestor = true;
      // A missing suffix must descend from a real directory. Resolve parent
      // links below so an apparently external alias into the source is caught.
      if (suffix.length > 0 && !metadata.isDirectory() && !metadata.isSymbolicLink()) {
        throw new UnsafeOutputPathError("The output ancestor is not a directory.");
      }
      if (suffix.length === 0 && (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink > 1)) {
        throw new UnsafeOutputPathError("The output is not an independent regular file.");
      }
      const canonicalAncestor = await realpath(ancestor);
      if (suffix.length > 0 && !(await stat(canonicalAncestor)).isDirectory()) {
        throw new UnsafeOutputPathError("The output ancestor is not a directory.");
      }
      const canonicalOutput = join(canonicalAncestor, ...suffix);
      if (isWithinRoot(canonicalRoot, canonicalOutput)) {
        throw new UnsafeOutputPathError("Reports must be written outside the source root.");
      }
      return canonicalOutput;
    } catch (error: unknown) {
      if (error instanceof UnsafeOutputPathError) throw error;
      if (observedAncestor) throw new UnsafeOutputPathError("The output ancestor changed or cannot be resolved.");
      if (!missing(error)) throw new UnsafeOutputPathError("The output path cannot be safely resolved.");
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new UnsafeOutputPathError("The output path has no accessible parent.");
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}
