import { setTimeout as delay } from "node:timers/promises";
import { RemoteError } from "./policy.js";
import type { GitHubInput, RemoteLimits } from "./policy.js";

export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export class GitHubHttp {
  private requests = 0;
  constructor(private input: GitHubInput, private limits: RemoteLimits, private signal: AbortSignal,
    private token?: string, private transport: Transport = fetch) {}

  async request(apiPath: string, archiveCommit?: string): Promise<Response> {
    const first = new URL(`https://api.github.com/repos/${this.input.repository}${apiPath}`);
    let url = first, redirects = 0, retries = 0, credentialsAllowed = true;
    while (true) {
      if (this.signal.aborted) throw new RemoteError("CANCELLED");
      if (++this.requests > this.limits.maxRequests) throw new RemoteError("RESOURCE_LIMIT");
      const headers: Record<string, string> = { Accept: "application/vnd.github+json", "Accept-Encoding": "identity", "User-Agent": "SunsetGuard/0.1", "X-GitHub-Api-Version": "2022-11-28" };
      if (credentialsAllowed && url.hostname === "api.github.com" && this.token !== undefined) headers.Authorization = `Bearer ${this.token}`;
      let response: Response;
      try { response = await this.transport(url.href, { method: "GET", headers, redirect: "manual", credentials: "omit", signal: this.signal }); }
      catch { throw new RemoteError(this.signal.aborted ? "CANCELLED" : "NETWORK_ERROR"); }
      if (response.redirected || (response.url !== "" && response.url !== url.href)) { await response.body?.cancel(); throw new RemoteError("INVALID_RESPONSE"); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (location === null || location.length > 2048 || ++redirects > this.limits.maxRedirects) throw new RemoteError("INVALID_RESPONSE");
        let next: URL; try { next = new URL(location, url); } catch { throw new RemoteError("INVALID_RESPONSE"); }
        const archivePaths = [`/${this.input.repository}/legacy.tar.gz/${archiveCommit}`, `/${this.input.repository}/tar.gz/${archiveCommit}`];
        if (next.protocol !== "https:" || next.username || next.password || next.port || next.hash || next.search ||
            archiveCommit === undefined || next.hostname !== "codeload.github.com" || !archivePaths.includes(next.pathname.toLowerCase())) throw new RemoteError("INVALID_RESPONSE");
        credentialsAllowed = false; url = next; continue;
      }
      const rateLimited = response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
      if (rateLimited || response.status === 502 || response.status === 503 || response.status === 504) {
        await response.body?.cancel();
        if (retries++ >= this.limits.maxRetries) throw new RemoteError(rateLimited ? "RATE_LIMITED" : "HTTP_ERROR", response.status);
        const retryAfter = response.headers.get("retry-after");
        const ms = retryAfter === null ? 250 * 2 ** (retries - 1) : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        if (!Number.isFinite(ms) || ms > this.limits.maxRetryDelayMs) throw new RemoteError(rateLimited ? "RATE_LIMITED" : "HTTP_ERROR", response.status);
        try { await delay(Math.max(1, ms), undefined, { signal: this.signal }); } catch { throw new RemoteError("CANCELLED"); }
        continue;
      }
      if (response.status !== 200) { await response.body?.cancel(); throw new RemoteError("HTTP_ERROR", response.status); }
      if (response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity") { await response.body?.cancel(); throw new RemoteError("INVALID_RESPONSE"); }
      return response;
    }
  }

  async json(apiPath: string, allowFilePagination = false): Promise<unknown> {
    const response = await this.request(apiPath);
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(response.headers.get("content-type") ?? "") ||
        (!allowFilePagination && response.headers.has("link"))) { await response.body?.cancel(); throw new RemoteError("INVALID_RESPONSE"); }
    const chunks: Uint8Array[] = []; let total = 0;
    if (response.body === null) throw new RemoteError("INVALID_RESPONSE");
    const reader = response.body.getReader();
    try {
      while (true) {
        const read = await reader.read(); if (read.done) break;
        total += read.value.byteLength;
        if (total > this.limits.maxJsonBytes) throw new RemoteError("RESOURCE_LIMIT");
        chunks.push(read.value);
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
    } catch (error) { throw error instanceof RemoteError ? error : new RemoteError(this.signal.aborted ? "CANCELLED" : "INVALID_RESPONSE"); }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
