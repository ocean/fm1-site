// Shared by the build and the update scripts: fetching the files other projects publish here, by
// pinned version and SHA-256, and asking GitHub about their releases.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const root = new URL("..", import.meta.url).pathname;
const cache = join(root, ".artifacts", "cache");
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

export function sha256Of(data) {
  return createHash("sha256").update(data).digest("hex");
}

export async function download(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Couldn't download ${url}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// A pinned file: from the cache (.artifacts/cache/NAME) or downloaded, and always checked against
// its pinned SHA-256 before it's used. Returns its path in the cache.
export async function fetchPinned(url, sha256, name) {
  const path = join(cache, name);
  const data = (await readFile(path).catch(() => null)) ?? (await download(url));
  const actual = sha256Of(data);
  if (actual !== sha256) {
    await rm(path, { force: true });
    throw new Error(`${url} has SHA-256 ${actual}, but the pin says ${sha256}`);
  }
  await mkdir(cache, { recursive: true });
  await writeFile(path, data);
  return path;
}

export async function readPin(name) {
  return JSON.parse(await readFile(join(root, name), "utf8"));
}

export async function writePin(name, pin) {
  await writeFile(join(root, name), `${JSON.stringify(pin, null, 2)}\n`);
}

// GitHub's REST API, with the Actions token when there is one (fewer rate limits). Null for 404.
export async function github(path) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${path}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// Step outputs for GitHub Actions; does nothing elsewhere.
export async function setOutputs(outputs) {
  if (process.env.GITHUB_OUTPUT) {
    const lines = Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`);
    await appendFile(process.env.GITHUB_OUTPUT, lines.join(""));
  }
}
