export const REMOTE_POLICY_VERSION = "0.1.0-t09";
export const REMOTE_LIMITS = Object.freeze({
  timeoutMs: 120_000, maxCompressedBytes: 50 * 1024 * 1024, maxExpandedBytes: 150 * 1024 * 1024,
  maxJsonBytes: 8 * 1024 * 1024, maxEntries: 50_000, maxDepth: 64,
  maxRedirects: 3, maxRequests: 20, maxRetries: 2, maxRetryDelayMs: 2_000,
});
export type RemoteLimits = { -readonly [Key in keyof typeof REMOTE_LIMITS]: number };
export interface GitHubInput { repository: string; ref: string }
export interface RemoteOptions {
  signal?: AbortSignal;
  limits?: Partial<RemoteLimits>;
  /** Explicit opt-in to the one named credential source. Never read automatically. */
  tokenEnvironment?: "SUNSETGUARD_GITHUB_TOKEN";
}
export type RemoteFailureCode = "HTTP_ERROR" | "RATE_LIMITED" | "NETWORK_ERROR" | "TIMEOUT" | "CANCELLED" |
  "INVALID_RESPONSE" | "UNSAFE_ARCHIVE" | "RESOURCE_LIMIT" | "COMMIT_MISMATCH" | "SOURCE_CHANGED" | "IO_ERROR" | "CLEANUP_FAILED";
const messages: Record<RemoteFailureCode, string> = {
  HTTP_ERROR: "GitHub returned an unsuccessful response.", RATE_LIMITED: "GitHub rate limiting exceeded the retry policy.",
  NETWORK_ERROR: "The GitHub request failed.", TIMEOUT: "Remote acquisition exceeded its hard deadline.",
  CANCELLED: "Remote acquisition was cancelled.", INVALID_RESPONSE: "GitHub metadata or response structure could not be verified.",
  UNSAFE_ARCHIVE: "The repository archive contains an unsupported or unsafe entry.", RESOURCE_LIMIT: "Remote acquisition exceeded its resource policy.",
  COMMIT_MISMATCH: "Archive bytes do not match the complete tree of the selected commit.",
  SOURCE_CHANGED: "Verified source bytes changed before or during analysis.", IO_ERROR: "Private snapshot storage could not be accessed safely.",
  CLEANUP_FAILED: "Private snapshot cleanup could not be confirmed.",
};
export class RemoteError extends Error {
  constructor(readonly code: RemoteFailureCode, readonly httpStatus?: number) { super(messages[code]); this.name = "RemoteError"; }
}
export interface RemoteFailure { status: "failed"; code: RemoteFailureCode; message: string; httpStatus?: number }
export function failure(error: unknown): RemoteFailure {
  const known = error instanceof RemoteError ? error : new RemoteError("IO_ERROR");
  return { status: "failed", code: known.code, message: known.message, ...(known.httpStatus === undefined ? {} : { httpStatus: known.httpStatus }) };
}
export function normalizeGitHubInput(input: GitHubInput): GitHubInput {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "repository" && key !== "ref")) throw new TypeError("GitHub input requires only repository and ref.");
  if (typeof input.repository !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository) || /\/(?:\.|\.\.)$/.test(input.repository) || input.repository.toLowerCase().endsWith(".git")) throw new TypeError("Repository must be a GitHub owner/name, without a URL or .git suffix.");
  if (typeof input.ref !== "string" || input.ref.length === 0 || input.ref.length > 200 ||
      !/^[A-Za-z0-9_./-]+$/.test(input.ref) || input.ref.startsWith("-") || input.ref.endsWith(".") ||
      input.ref.includes("..") || input.ref.split("/").some(part => part === "" || part.startsWith(".") || part.endsWith(".lock"))) throw new TypeError("An explicit supported GitHub ref is required.");
  return { repository: input.repository.toLowerCase(), ref: /^[a-fA-F0-9]{40}$/.test(input.ref) ? input.ref.toLowerCase() : input.ref };
}
export function remoteLimits(options: RemoteOptions): RemoteLimits {
  if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["signal", "limits", "tokenEnvironment"].includes(key))) throw new TypeError("Unknown remote option.");
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal.");
  if (options.tokenEnvironment !== undefined && options.tokenEnvironment !== "SUNSETGUARD_GITHUB_TOKEN") throw new TypeError("Unsupported credential source.");
  if (options.limits !== undefined && (options.limits === null || typeof options.limits !== "object" || Array.isArray(options.limits))) throw new TypeError("limits must be an object.");
  const result: RemoteLimits = { ...REMOTE_LIMITS };
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(REMOTE_LIMITS, key) || !Number.isSafeInteger(value) || value < (["maxRetries", "maxRedirects"].includes(key) ? 0 : 1) || value > REMOTE_LIMITS[key as keyof RemoteLimits]) throw new TypeError("Remote limits can only lower default budgets.");
    result[key as keyof RemoteLimits] = value;
  }
  return result;
}
export function safeArchivePath(value: string, limits: RemoteLimits): string {
  const parts = value.split("/");
  if (Buffer.from(value).toString("utf8") !== value || value.includes("\ufffd") || Buffer.byteLength(value) > 2048 || parts.length > limits.maxDepth ||
      parts.some(part => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git" || Buffer.byteLength(part) > 255 || /[ .]$/.test(part) ||
        [...part].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /[\\:*?"<>|]/.test(part) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new RemoteError("UNSAFE_ARCHIVE");
  return value;
}
