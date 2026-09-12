import { GitHubHttp } from "./http.js";
import type { Transport } from "./http.js";
import { extractVerifiedArchive } from "./archive.js";
import type { ArchiveVerification } from "./archive.js";
import { isSha, object, parseTree } from "./tree.js";
import { RemoteError } from "./policy.js";
import type { GitHubInput, RemoteLimits } from "./policy.js";

export interface VerifiedAcquisition extends ArchiveVerification { input: GitHubInput; commit: string; treeSha: string }
/** Internal worker implementation. The optional transport is for offline tests only. */
export async function acquireGitHub(input: GitHubInput, root: string, limits: RemoteLimits, signal: AbortSignal, token?: string, transport?: Transport): Promise<VerifiedAcquisition> {
  const client = new GitHubHttp(input, limits, signal, token, transport);
  const repository = await client.json("");
  if (!object(repository) || repository.private !== false || typeof repository.full_name !== "string" || repository.full_name.toLowerCase() !== input.repository) throw new RemoteError("INVALID_RESPONSE");
  // Only sha/tree metadata is consumed; optional commit-files pagination is not an inventory.
  const resolved = await client.json(`/commits/${encodeURIComponent(input.ref)}?per_page=1`, true);
  if (!object(resolved) || !isSha(resolved.sha) || !object(resolved.commit) || !object(resolved.commit.tree) || !isSha(resolved.commit.tree.sha)) throw new RemoteError("INVALID_RESPONSE");
  const commit = resolved.sha, treeSha = resolved.commit.tree.sha;
  if (isSha(input.ref) && commit !== input.ref) throw new RemoteError("COMMIT_MISMATCH");
  const tree = parseTree(await client.json(`/git/trees/${treeSha}?recursive=1`), treeSha, limits);
  const response = await client.request(`/tarball/${commit}`, commit);
  const size = response.headers.get("content-length");
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > limits.maxCompressedBytes)) { await response.body?.cancel(); throw new RemoteError("RESOURCE_LIMIT"); }
  if (response.body === null) throw new RemoteError("INVALID_RESPONSE");
  const archive = await extractVerifiedArchive(response.body, root, tree, limits, signal);
  return { input, commit, treeSha, ...archive };
}
