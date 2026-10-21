// Copies the site's public files into dist/, the folder GitHub Pages serves. Anything not listed
// here (READMEs, configs, scripts, node_modules) stays out of the deploy.
//
// Two projects publish their own files here, each pinned to a release and checked by SHA-256
// (downloads are cached in .artifacts/cache/):
// - estampie.json: ESTAMPIE's whole site, a zip unpacked into dist/estampie/;
// - fm1kit.json: FM1Kit's llms.txt and llms-full.txt, from its release tag, into dist/fm1kit/.
// FM-SWITCH's firmwares.json is committed here by its own workflow and copied as it is.
// While nothing is pinned, the placeholder files in this repository are used instead.
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { fetchPinned, readPin, root } from "./pinned.mjs";

const run = promisify(execFile);
const dist = join(root, "dist");

const publicPaths = [
  "index.html",
  "404.html",
  "llms.txt",
  "llms-full.txt",
  "assets",
  "estampie",
  "fm-switch",
  "fm1kit",
];

async function unpackEstampie(pin) {
  const zipPath = await fetchPinned(pin.url, pin.sha256, `estampie-site-${pin.version}.zip`);
  const folder = join(dist, "estampie");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder);
  await run("unzip", ["-q", zipPath, "-d", folder]);
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (relative(folder, path).startsWith("..")) {
      throw new Error(`ESTAMPIE's site zip holds a path outside its folder: ${path}`);
    }
  }
  await readFile(join(folder, "index.html")).catch(() => {
    throw new Error("ESTAMPIE's site zip has no index.html at its root");
  });
  console.log(`Unpacked ESTAMPIE ${pin.version}'s site into dist/estampie/.`);
}

async function copyFm1kitFiles(pin) {
  for (const [file, sha256] of Object.entries(pin.files)) {
    const url = `https://raw.githubusercontent.com/ocean/FM1Kit/${pin.tag}/${file}`;
    const path = await fetchPinned(url, sha256, `fm1kit-${pin.tag}-${file}`);
    await cp(path, join(dist, "fm1kit", file));
  }
  console.log(`Copied FM1Kit ${pin.tag}'s ${Object.keys(pin.files).join(" and ")} into dist/fm1kit/.`);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist);
for (const path of publicPaths) {
  await cp(join(root, path), join(dist, path), { recursive: true });
}

// FM-SWITCH's firmware list, committed daily by the "Update the firmware list" workflow (once it has run).
const firmwares = await readFile(join(root, "firmwares.json")).catch(() => null);
if (firmwares) {
  await cp(join(root, "firmwares.json"), join(dist, "firmwares.json"));
}

const estampie = await readPin("estampie.json");
if (estampie.version) {
  await unpackEstampie(estampie);
} else {
  console.log("No ESTAMPIE release pinned in estampie.json: keeping the placeholder.");
}

const fm1kit = await readPin("fm1kit.json");
if (fm1kit.tag) {
  await copyFm1kitFiles(fm1kit);
} else {
  console.log("No FM1Kit release pinned in fm1kit.json: keeping fm1kit/llms-full.txt.");
}
console.log(`Built ${publicPaths.length} paths into dist/.`);
