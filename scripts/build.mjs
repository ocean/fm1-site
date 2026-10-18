// Copies the site's public files into dist/, the folder Cloudflare serves. Anything not listed
// here (READMEs, configs, scripts, node_modules) stays out of the deploy.
//
// ESTAMPIE's folder is its own site, built and released from the estampie repository. When
// estampie.json pins a release, its site zip is downloaded (cached in .artifacts/cache/), checked
// against the pinned SHA-256 and unpacked into dist/estampie/ in place of the placeholder here.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const cache = join(root, ".artifacts", "cache");

const publicPaths = [
  "index.html",
  "404.html",
  "_headers",
  "llms.txt",
  "llms-full.txt",
  "assets",
  "estampie",
  "fm-switch",
  "fm1kit",
];

// The pinned ESTAMPIE release's site zip, from the cache or downloaded, checked against its hash.
async function estampieSiteZip(pin) {
  const zipPath = join(cache, `estampie-site-${pin.version}.zip`);
  let zip = await readFile(zipPath).catch(() => null);
  if (!zip) {
    console.log(`Downloading ESTAMPIE ${pin.version}'s site from ${pin.url}`);
    const response = await fetch(pin.url);
    if (!response.ok) {
      throw new Error(`Couldn't download ESTAMPIE's site: ${response.status} from ${pin.url}`);
    }
    zip = Buffer.from(await response.arrayBuffer());
  }
  const sha256 = createHash("sha256").update(zip).digest("hex");
  if (sha256 !== pin.sha256) {
    await rm(zipPath, { force: true });
    throw new Error(`ESTAMPIE's site zip has SHA-256 ${sha256}, but estampie.json pins ${pin.sha256}`);
  }
  await mkdir(cache, { recursive: true });
  await writeFile(zipPath, zip);
  return zipPath;
}

// Every path inside a folder, so nothing unpacked can sit outside it.
async function listFiles(folder) {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries.map((entry) => join(entry.parentPath, entry.name));
}

async function unpackEstampie(pin) {
  const zipPath = await estampieSiteZip(pin);
  const folder = join(dist, "estampie");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder);
  await run("unzip", ["-q", zipPath, "-d", folder]);
  for (const path of await listFiles(folder)) {
    if (relative(folder, path).startsWith("..")) {
      throw new Error(`ESTAMPIE's site zip holds a path outside its folder: ${path}`);
    }
  }
  await readFile(join(folder, "index.html")).catch(() => {
    throw new Error("ESTAMPIE's site zip has no index.html at its root");
  });
  console.log(`Unpacked ESTAMPIE ${pin.version}'s site into dist/estampie/.`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist);
for (const path of publicPaths) {
  await cp(join(root, path), join(dist, path), { recursive: true });
}

const pin = JSON.parse(await readFile(join(root, "estampie.json"), "utf8"));
if (pin.version) {
  await unpackEstampie(pin);
} else {
  console.log("No ESTAMPIE release pinned in estampie.json: keeping the placeholder.");
}
console.log(`Built ${publicPaths.length} paths into dist/.`);
