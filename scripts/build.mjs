// Copies the site's public files into dist/, the folder GitHub Pages serves. Anything not listed
// here (READMEs, configs, scripts, node_modules) stays out of the deploy.
//
// Two projects publish their own files here, each pinned to a release and checked by SHA-256
// (downloads are cached in .artifacts/cache/):
// - estampie.json: ESTAMPIE's whole site, a zip unpacked into dist/estampie/;
// - fm1kit.json: FM1Kit's llms.txt and llms-full.txt, from its release tag, into dist/fm1kit/.
// FM-SWITCH's firmwares.json is committed here by its own workflow and copied as it is, and its
// three most starred firmwares are written into FM-SWITCH's page.
// While nothing is pinned, the placeholder files in this repository are used instead.
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { firmwareBadge } from "./firmware-badges.mjs";
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
  "privacy",
];

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.codePointAt(0)};`);

// FM-SWITCH's page lists the firmwares with the most GitHub stars, as the firmware hub counts
// them, each with the badge the app gives it. Without a firmware list, the list is left out.
async function writeMostStarred(firmwares) {
  const path = join(dist, "fm-switch", "index.html");
  const page = await readFile(path, "utf8");
  const marker = /^( *)<!-- most-starred: [^\n]*-->\n/m;
  const indent = page.match(marker)?.[1];
  if (indent === undefined) {
    throw new Error("FM-SWITCH's page has no most-starred marker");
  }
  const entries = firmwares ? JSON.parse(firmwares).entries : [];
  const starred = entries
    .filter((entry) => Number.isInteger(entry.stars) && entry.stars > 0)
    .sort((one, two) => two.stars - one.stars)
    .slice(0, 3);
  let list = "";
  if (starred.length > 0) {
    const items = starred.map((entry) => {
      const badge = firmwareBadge(entry.name, { isOfficial: entry.isOfficial, version: entry.version });
      const colours = `--badge-first: ${badge.first}; --badge-second: ${badge.second}; --badge-ink: ${badge.ink}`;
      const split = badge.split === "diagonal" ? " badge--diagonal" : "";
      const site = entry.links.find((link) => link.label === "Project site") ?? entry.links[0];
      const name = site
        ? `<a href="${escapeHtml(site.url)}">${escapeHtml(entry.name)}</a>`
        : `<span>${escapeHtml(entry.name)}</span>`;
      return (
        `${indent}  <li><span class="badge${split}" style="${colours}" aria-hidden="true">${escapeHtml(badge.letters)}</span>` +
        `${name}<span class="stars">${entry.stars.toLocaleString("en-AU")} stars</span></li>\n`
      );
    });
    list =
      `${indent}<p class="starred">Most starred on GitHub</p>\n` +
      `${indent}<ul class="badges">\n${items.join("")}${indent}</ul>\n`;
  }
  await writeFile(path, page.replace(marker, list));
  console.log(`Listed ${starred.length} most starred firmwares on FM-SWITCH's page.`);
}

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
await writeMostStarred(firmwares && firmwares.toString("utf8"));

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
