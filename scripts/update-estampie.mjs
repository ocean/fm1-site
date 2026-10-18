// Points estampie.json at the latest ESTAMPIE release's site, if it's newer than the one pinned.
//
// Looks up the latest release of ocean/estampie (drafts and pre-releases aren't "latest"), finds
// its estampie-site-X.Y.zip asset, downloads it and hashes it, and checks that hash against the
// release's estampie-site-X.Y.zip.sha256 asset when there is one. Prints what it did; in GitHub
// Actions it also sets the outputs `changed` and `version`.
//
// Run locally with: npm run update:estampie (set GH_TOKEN to avoid GitHub's rate limits).
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pinPath = join(root, "estampie.json");
const repository = "ocean/estampie";
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

async function github(path) {
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

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Couldn't download ${url}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function setOutputs(outputs) {
  if (process.env.GITHUB_OUTPUT) {
    const lines = Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`);
    await appendFile(process.env.GITHUB_OUTPUT, lines.join(""));
  }
}

const pin = JSON.parse(await readFile(pinPath, "utf8"));
const release = await github(`repos/${repository}/releases/latest`);
if (!release) {
  console.log(`${repository} has no releases yet: nothing to do.`);
  await setOutputs({ changed: "false" });
  process.exit(0);
}

const siteAsset = release.assets.find((asset) => /^estampie-site-.+\.zip$/.test(asset.name));
if (!siteAsset) {
  console.log(`${repository} ${release.tag_name} has no estampie-site-*.zip asset: nothing to do.`);
  await setOutputs({ changed: "false" });
  process.exit(0);
}

const version = siteAsset.name.replace(/^estampie-site-/, "").replace(/\.zip$/, "");
if (version === pin.version) {
  console.log(`ESTAMPIE ${version} is already pinned.`);
  await setOutputs({ changed: "false", version });
  process.exit(0);
}

const zip = await download(siteAsset.browser_download_url);
const sha256 = createHash("sha256").update(zip).digest("hex");
const hashAsset = release.assets.find((asset) => asset.name === `${siteAsset.name}.sha256`);
if (hashAsset) {
  const published = (await download(hashAsset.browser_download_url)).toString("utf8").trim().split(/\s+/)[0];
  if (published !== sha256) {
    throw new Error(`${siteAsset.name} hashes to ${sha256}, but the release says ${published}`);
  }
}

await writeFile(
  pinPath,
  `${JSON.stringify({ version, url: siteAsset.browser_download_url, sha256 }, null, 2)}\n`,
);
console.log(`Pinned ESTAMPIE ${version} (was ${pin.version ?? "none"}): ${sha256}`);
await setOutputs({ changed: "true", version });
