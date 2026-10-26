// Read-only GitHub helpers for the bootloader check's scanner: the REST and GraphQL APIs, raw
// file contents and release downloads, with retries and GitHub's rate limits respected.
//
// Nothing here writes to GitHub: only GET requests, and GraphQL queries (never mutations).
// The token comes from GITHUB_TOKEN (or GH_TOKEN); without one, GitHub's limits are very low.

const api = "https://api.github.com";
const rawHost = "https://raw.githubusercontent.com";
const userAgent = "fm1-site-bootloader-check (https://fm-1.drewr.dev/bootloader-check/)";
const attempts = 4;
// How long to wait for a rate limit to reset before giving up on a request.
const longestWait = 15 * 60 * 1000;
const requestTimeout = 60 * 1000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// An error from GitHub, with the HTTP status (0 for a network failure).
export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createGitHub({ token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN, log = console.log } = {}) {
  const counts = { rest: 0, graphql: 0, search: 0, raw: 0, download: 0, retries: 0 };
  const authorisation = token ? { Authorization: `Bearer ${token}` } : {};

  // How long to wait before retrying a refused request, or null if it shouldn't be retried.
  function retryDelay(response, attempt) {
    const backoff = 2000 * 2 ** attempt;
    if (response.status >= 500) return backoff;
    if (response.status !== 403 && response.status !== 429) return null;
    const retryAfter = Number(response.headers.get("retry-after"));
    if (retryAfter > 0) return retryAfter * 1000;
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      return Math.max(reset - Date.now(), 0) + 1000;
    }
    // A 403 for anything else (a forbidden resource) isn't worth retrying.
    return response.status === 429 ? backoff : null;
  }

  async function request(url, options = {}, kind = "rest") {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      counts[kind]++;
      let response;
      try {
        response = await fetch(url, {
          ...options,
          headers: { "User-Agent": userAgent, ...authorisation, ...options.headers },
          signal: AbortSignal.timeout(requestTimeout),
        });
      } catch (error) {
        lastError = new GitHubError(`${url}: ${error.message}`, 0);
        counts.retries++;
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (response.ok || response.status === 404 || response.status === 409 || response.status === 422) {
        return response;
      }
      const delay = retryDelay(response, attempt);
      const body = (await response.text()).slice(0, 300);
      lastError = new GitHubError(`${url}: ${response.status} ${body}`, response.status);
      if (delay === null || delay > longestWait || attempt === attempts - 1) break;
      if (delay > 10_000) log(`  GitHub asked to wait ${Math.round(delay / 1000)} s (${response.status}).`);
      counts.retries++;
      await sleep(delay);
    }
    throw lastError;
  }

  // GET from the REST API: the parsed JSON, or null for 404 (and for 409, an empty repository).
  async function rest(path, { kind = "rest", accept = "application/vnd.github+json" } = {}) {
    const response = await request(`${api}/${path}`, { headers: { Accept: accept } }, kind);
    if (response.status === 404 || response.status === 409) return null;
    if (response.status === 422) throw new GitHubError(`${path}: 422 ${await response.text()}`, 422);
    return response.json();
  }

  // A GraphQL query (never a mutation). Returns { data, errors }: errors per alias, such as
  // NOT_FOUND for a repository that's gone, don't throw.
  async function graphql(query, variables = {}) {
    if (/^\s*mutation\b/.test(query)) throw new Error("Only queries are allowed.");
    const response = await request(
      `${api}/graphql`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) },
      "graphql",
    );
    if (!response.ok) throw new GitHubError(`GraphQL: ${response.status} ${await response.text()}`, response.status);
    const result = await response.json();
    if (!result.data && result.errors) {
      throw new GitHubError(`GraphQL: ${result.errors.map((error) => error.message).join("; ")}`, 200);
    }
    return { data: result.data ?? {}, errors: result.errors ?? [] };
  }

  // A file's bytes at a commit, from raw.githubusercontent.com, or null if it isn't there.
  async function raw(repo, ref, path, { maximumBytes = 2 * 1024 * 1024 } = {}) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const response = await request(`${rawHost}/${repo}/${ref}/${encoded}`, {}, "raw");
    if (response.status === 404) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maximumBytes) throw new GitHubError(`${repo}/${path} is over ${maximumBytes} bytes`, 200);
    return data;
  }

  // A release asset's bytes, refusing anything bigger than maximumBytes.
  async function download(url, { maximumBytes }) {
    const response = await request(url, { headers: { Accept: "application/octet-stream" } }, "download");
    if (response.status === 404) throw new GitHubError(`${url}: 404`, 404);
    const declared = Number(response.headers.get("content-length"));
    if (declared > maximumBytes) {
      await response.body?.cancel();
      throw new GitHubError(`${url} is ${declared} bytes, over ${maximumBytes}`, 200);
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximumBytes) throw new GitHubError(`${url} is over ${maximumBytes} bytes`, 200);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // Code search, every page of it (GitHub stops at 1,000 results). Code search allows only ten
  // requests a minute, so pages are spaced out. Returns the items.
  async function searchCode(query) {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const result = await rest(`search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`, {
        kind: "search",
      });
      if (!result) break;
      items.push(...result.items);
      if (result.items.length < 100 || items.length >= result.total_count) break;
      await sleep(7000);
    }
    return items;
  }

  return { rest, graphql, raw, download, searchCode, counts };
}

// Runs fn over items with at most limit running at once, in order of the items. Returns the
// results in the items' order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
