import type { Location } from "../domain/index.js";

export const SNIPPET_POLICY_VERSION = "0.1.0-t10-token-excerpt";
export const SNIPPET_MAX_CHARS = 160;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_LINES = 100_000;
const identifier = /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u;

export interface RedactedSnippet { snippet: string; snippetRedacted: true }
export type SnippetBuilder = (location: Location, allowedNames: readonly string[]) => RedactedSnippet | undefined;
interface Line { start: number; end: number; first: number; last: number }

/** A redaction flag alone cannot authorize arbitrary cached or caller-supplied text. */
export function isRedactedSnippet(value: string, allowedNames: readonly string[]): boolean {
  if (value.length > SNIPPET_MAX_CHARS) return false;
  return allowedNames.some(name => name.length <= SNIPPET_MAX_CHARS - 12 && identifier.test(name) &&
    [name, `[…] ${name}`, `${name} […]`, `[…] ${name} […]`].includes(value));
}

/**
 * Only the already-identified evidence token survives. Every other nonblank part
 * of that source line is omitted, including literals, comments and identifiers.
 * The caller must supply frozen bytes and the analyzer's exact token location;
 * this helper neither reads files nor identifies references or arbitrary secrets.
 */
export function createRedactedSnippet(
  bytes: Uint8Array, location: Location, allowedNames: readonly string[],
): RedactedSnippet | undefined {
  return createSnippetBuilder(bytes)(location, allowedNames);
}

/** Decode and index each frozen file once; each token lookup is bounded to 148 characters. */
export function createSnippetBuilder(bytes: Uint8Array): SnippetBuilder {
  const unavailable: SnippetBuilder = () => undefined;
  if (bytes.byteLength > MAX_SOURCE_BYTES) return unavailable;
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return unavailable; }
  const lines: Line[] = [];
  let start = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = -1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character !== "\n" && character !== "\r" && character !== "\u2028" && character !== "\u2029") {
      if (!/\s/.test(character)) { first = Math.min(first, index); last = index + 1; }
      continue;
    }
    lines.push({ start, end: index, first, last });
    if (lines.length >= MAX_SOURCE_LINES) return unavailable;
    if (character === "\r" && source[index + 1] === "\n") index += 1;
    start = index + 1;
    first = Number.POSITIVE_INFINITY;
    last = -1;
  }
  lines.push({ start, end: source.length, first, last });
  return (location, allowedNames) => {
    if (location.start.line !== location.end.line ||
        ![location.start.line, location.start.column, location.end.column].every(value => Number.isSafeInteger(value) && value > 0) ||
        location.end.column <= location.start.column || location.end.column - location.start.column > SNIPPET_MAX_CHARS - 12) return undefined;
    const row = lines[location.start.line - 1];
    if (row === undefined) return undefined;
    const tokenStart = row.start + location.start.column - 1;
    const tokenEnd = row.start + location.end.column - 1;
    if (tokenEnd > row.end) return undefined;
    const token = source.slice(tokenStart, tokenEnd);
    if (!identifier.test(token) || !allowedNames.includes(token)) return undefined;
    // Keeping only this span avoids guessing whether surrounding source is a
    // multiline comment, JSX text, template, regex, literal, or another binding.
    const snippet = `${row.first < tokenStart ? "[…] " : ""}${token}${row.last > tokenEnd ? " […]" : ""}`;
    return { snippet, snippetRedacted: true };
  };
}
