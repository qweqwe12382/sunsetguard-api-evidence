import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubHttp } from "../src/remote/http.js";
import type { Transport } from "../src/remote/http.js";
import { acquireGitHub } from "../src/remote/acquire.js";
import { failure, normalizeGitHubInput, REMOTE_LIMITS, remoteLimits } from "../src/remote/policy.js";
import { tarBytes, treeFor, commit, treeSha } from "./helpers/remote-fixtures.js";

const input = { repository: "owner/repo", ref: "release/v1" }, signal = () => new AbortController().signal;
const json = (value: unknown, headers = {}) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
const roots: string[] = [], base = resolve(".test-tmp");
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) { if (dirname(root) !== base) throw Error("cleanup scope"); await rm(root, { recursive: true, force: true }); } });
async function root() { await mkdir(base, { recursive: true }); const path = await mkdtemp(join(base, "remote-http-")); roots.push(path); return path; }

describe("bounded GitHub HTTP acquisition", () => {
  it("normalizes case without allowing URLs, shell-like refs or path escape", () => {
    expect(normalizeGitHubInput({ repository: "Owner/Repo", ref: "feature/fix" })).toEqual({ repository: "owner/repo", ref: "feature/fix" });
    for (const repository of ["https://github.com/owner/repo", "//localhost/repo", "owner/repo.git", "../repo", "owner/repo?secret=TOKEN"]) expect(() => normalizeGitHubInput({ repository, ref: "main" })).toThrow();
    for (const ref of ["../main", "main;id", "main\n", "-main", "foo//bar", "foo.lock", "main@{1}", "main%2fother"]) expect(() => normalizeGitHubInput({ ...input, ref })).toThrow();
    expect(() => remoteLimits({ limits: { maxCompressedBytes: REMOTE_LIMITS.maxCompressedBytes + 1 } })).toThrow();
    expect(() => remoteLimits({ limits: { timeoutMs: NaN } })).toThrow();
  });

  it("resolves a ref once and binds downloaded bytes to the full selected commit tree", async () => {
    vi.stubGlobal("fetch", () => { throw Error("NETWORK MUST NOT RUN"); });
    const files = [{ name: "a.ts", text: 'import {oldApi} from "pkg"; oldApi();' }], tree = treeFor(files);
    const archive = await tarBytes([{ name: "wrapper/a.ts", text: files[0]!.text }]);
    const requested: string[] = [], headers: Headers[] = [];
    const transport: Transport = async (url, init) => {
      requested.push(url); headers.push(new Headers(init.headers));
      expect(init.redirect).toBe("manual"); expect(init.credentials).toBe("omit");
      if (requested.length === 1) return json({ private: false, full_name: "Owner/Repo" });
      if (requested.length === 2) return json({ sha: commit, commit: { tree: { sha: treeSha } } }, { link: '<https://api.github.com/ignored-files-page>; rel="next"' });
      if (requested.length === 3) return json({ sha: treeSha, truncated: false, tree: tree.files.map(file => ({ ...file, type: "blob" })) });
      if (requested.length === 4) return new Response(null, { status: 302, headers: { location: `https://codeload.github.com/owner/repo/legacy.tar.gz/${commit}` } });
      return new Response(new Uint8Array(archive));
    };
    const result = await acquireGitHub(input, await root(), REMOTE_LIMITS, signal(), "FAKE_TOKEN_DO_NOT_FORWARD", transport);
    expect(result.commit).toBe(commit); expect(result.files).toHaveLength(1);
    expect(requested).toEqual(["https://api.github.com/repos/owner/repo", "https://api.github.com/repos/owner/repo/commits/release%2Fv1?per_page=1", `https://api.github.com/repos/owner/repo/git/trees/${treeSha}?recursive=1`, `https://api.github.com/repos/owner/repo/tarball/${commit}`, `https://codeload.github.com/owner/repo/legacy.tar.gz/${commit}`]);
    expect(headers.slice(0, 4).every(value => value.get("authorization") === "Bearer FAKE_TOKEN_DO_NOT_FORWARD")).toBe(true);
    expect(headers[4]!.has("authorization")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("FAKE_TOKEN");
  });

  it.each(["http://codeload.github.com/owner/repo/tar.gz/", "https://127.0.0.1/", "https://codeload.github.com.evil.test/", "https://user:secret@codeload.github.com/owner/repo/tar.gz/", "https://codeload.github.com/other/repo/tar.gz/", "https://api.github.com/repos/owner/repo/tarball/"])("rejects untrusted redirect %s before another request", async prefix => {
    const transport = vi.fn<Transport>(async () => new Response(null, { status: 302, headers: { location: prefix + commit } }));
    await expect(new GitHubHttp(input, REMOTE_LIMITS, signal(), "secret", transport).request(`/tarball/${commit}`, commit)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("caps redirects and discards credentials for every codeload hop", async () => {
    const transport = vi.fn<Transport>(async (_url, init) => {
      if (transport.mock.calls.length > 1) expect(new Headers(init.headers).has("authorization")).toBe(false);
      return new Response(null, { status: 302, headers: { location: `https://codeload.github.com/owner/repo/tar.gz/${commit}` } });
    });
    await expect(new GitHubHttp(input, REMOTE_LIMITS, signal(), "secret", transport).request(`/tarball/${commit}`, commit)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("retries bounded rate limits, honors cancellation and does not leak error bodies", async () => {
    let calls = 0;
    const transport: Transport = async () => ++calls < 3 ? new Response("secret internal URL", { status: 429, headers: { "retry-after": "0" } }) : json({ ok: true });
    expect(await new GitHubHttp(input, REMOTE_LIMITS, signal(), undefined, transport).json("")).toEqual({ ok: true }); expect(calls).toBe(3);
    const limited: Transport = async () => new Response("FAKE_SECRET", { status: 429, headers: { "retry-after": "9000" } });
    const result = await new GitHubHttp(input, REMOTE_LIMITS, signal(), undefined, limited).json("").catch(failure);
    expect(result).toMatchObject({ code: "RATE_LIMITED", httpStatus: 429 }); expect(JSON.stringify(result)).not.toContain("FAKE_SECRET");
    const controller = new AbortController();
    const waiting = new GitHubHttp(input, REMOTE_LIMITS, controller.signal, undefined, async () => new Response(null, { status: 429 })).json("");
    controller.abort(); await expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it.each([404, 401, 422, 500])("preserves HTTP %s as a sanitized structured failure", async status => {
    const result = await new GitHubHttp(input, REMOTE_LIMITS, signal(), undefined, async () => new Response("C:/Users/private/TOKEN", { status })).json("").catch(failure);
    expect(result).toMatchObject({ code: "HTTP_ERROR", httpStatus: status }); expect(JSON.stringify(result)).not.toContain("private");
  });

  it("rejects missing fields, incomplete tree inventories, wrong commit and private repositories", async () => {
    for (const metadata of [{ private: true, full_name: "owner/repo" }, { full_name: "owner/repo" }, { private: false, full_name: "other/repo" }]) {
      await expect(acquireGitHub(input, await root(), REMOTE_LIMITS, signal(), undefined, async () => json(metadata))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
    let requests = 0;
    await expect(acquireGitHub({ ...input, ref: "c".repeat(40) }, await root(), REMOTE_LIMITS, signal(), undefined, async () => json(++requests === 1 ? { private: false, full_name: input.repository } : { sha: commit, commit: { tree: { sha: treeSha } } }))).rejects.toMatchObject({ code: "COMMIT_MISMATCH" });
    const link: Transport = async () => json({ tree: [] }, { link: '<https://evil.test>; rel="next"' });
    await expect(new GitHubHttp(input, REMOTE_LIMITS, signal(), undefined, link).json(`/git/trees/${treeSha}`)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("bounds JSON streams and refuses transport decoding and malformed responses", async () => {
    await expect(new GitHubHttp(input, { ...REMOTE_LIMITS, maxJsonBytes: 4 }, signal(), undefined, async () => json({ large: "123456" })).json("")).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    await expect(new GitHubHttp(input, REMOTE_LIMITS, signal(), undefined, async () => json({}, { "content-encoding": "gzip" })).json("")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(new GitHubHttp(input, REMOTE_LIMITS, signal(), undefined, async () => new Response("not json", { headers: { "content-type": "application/json" } })).json("")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const result = await new GitHubHttp(input, REMOTE_LIMITS, signal(), undefined, async () => { throw Error("secret body"); }).json("").catch(failure);
    expect(result).toMatchObject({ code: "NETWORK_ERROR" }); expect(JSON.stringify(result)).not.toContain("secret body");
  });
});
