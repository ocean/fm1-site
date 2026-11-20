// Reads what each directory publishes, for the FM-1 Moment's weekly refresh. Everything here
// parses text another site published, so it only counts and matches: nothing it reads is run.
import { readTable } from "./data.mjs";

// A GitHub repository's address in one form, for matching ("owner/repo", lower case).
export function repoKey(url) {
  const match = /github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(url ?? "");
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/i, "")}`.toLowerCase();
}

// aroum's FM1 Resource Hub sections that list firmwares, and the family a new row takes from each.
const resourceHubSections = [
  { heading: /^#### 1\.1\.1\. /, group: "sound", family: "Sound (Felucca family)" },
  { heading: /^#### 1\.1\.2\. /, group: "sound", family: "Sound (SLOOP family)" },
  { heading: /^#### 1\.1\.3\. /, group: "sound", family: "Sound (FoMni family)" },
  { heading: /^#### 1\.1\.4\. /, group: "sound", family: "Sound (independent)" },
  { heading: /^### 1\.2\. /, group: "platforms", family: "Platform" },
  { heading: /^### 1\.3\. /, group: "games", family: "Games and experiments" },
  { heading: /^### 1\.4\. /, group: "patchers", family: null },
];

// The firmware tables in aroum's README: a count for each group, and each row's name, author and
// GitHub repository, if it has one.
export function readResourceHub(markdown) {
  const counts = { sound: 0, platforms: 0, games: 0, patchers: 0 };
  const entries = [];
  let section = null;
  for (const line of markdown.split("\n")) {
    if (/^#{2,4} /.test(line)) {
      section = resourceHubSections.find((candidate) => candidate.heading.test(line)) ?? null;
      continue;
    }
    if (!section || !/^\| \d+ \|/.test(line)) continue;
    counts[section.group] += 1;
    const cell = line.split(/(?<!\\)\|/)[2] ?? "";
    const title = /\*\*(.+?)\*\*/.exec(cell)?.[1] ?? "";
    const by = title.lastIndexOf(" by ");
    const repoLink = /\]\((https:\/\/github\.com\/[^)\s]+)\)/.exec(cell)?.[1];
    entries.push({
      name: (by > 0 ? title.slice(0, by) : title).trim(),
      repo: repoKey(repoLink),
      group: section.group,
      family: section.family,
    });
  }
  if (entries.length === 0) throw new Error("aroum's README has no firmware tables any more");
  return { counts, entries };
}

// fm1-editor.com's firmware page: one element of class "firmware-entry" per firmware.
export function countEditor(html) {
  const count = (html.match(/class="firmware-entry(?=[\s"])/g) ?? []).length;
  if (count === 0) throw new Error("fm1-editor.com's firmware page has no entries any more");
  return count;
}

// Leo Kuroshita's FM-1 CFW Database: one row per work in db/works.csv.
export function countWorks(csv) {
  const count = readTable(csv.replace(/^\uFEFF/, "")).length;
  if (count === 0) throw new Error("The FM-1 CFW Database's works.csv has no rows");
  return count;
}

// FMDB's feed.json: its firmwares list.
export function countFmdb(json) {
  const feed = JSON.parse(json);
  if (!Array.isArray(feed.firmwares)) throw new Error("FMDB's feed.json has no firmwares list any more");
  return feed.firmwares.length;
}

// FM-SWITCH's firmwares.json: the entries The Firmware Hub lists (bit 0 of listing).
export function countHub(json) {
  const list = JSON.parse(json);
  const count = list.entries.filter((entry) => (entry.listing & 1) === 1).length;
  if (count === 0) throw new Error("firmwares.json has no firmwares from The Firmware Hub");
  return count;
}

// Each firmware's family by Leo Kuroshita's lineage, keyed by repository, where it places one:
// through SLOOP or FoMni, otherwise from Felucca, from AMB-1, or from M-VAVE's fm1_open.
export function lineageFamilies(json) {
  const taxonomy = JSON.parse(json);
  const nodes = new Map(taxonomy.nodes.map((node) => [node.id, node]));
  const idsOf = (repo) => new Set(taxonomy.nodes.filter((node) => repoKey(node.repo) === repo).map((node) => node.id));
  const sloop = idsOf("isod89/sloop-fm1");
  const fomni = idsOf("charlesvestal/fm1-fomni");
  if (sloop.size === 0 || fomni.size === 0) throw new Error("The FM-1 CFW Database has no SLOOP or FoMni any more");
  const families = new Map();
  for (const node of taxonomy.nodes) {
    const key = repoKey(node.repo);
    if (!key || node.kind !== "firmware") continue;
    const path = node.lineage_path ?? [];
    const through = (ids) => path.some((id) => ids.has(id));
    let family = null;
    if (node.classification === "felucca-descendant") {
      if (through(sloop)) family = "Sound (SLOOP family)";
      else if (through(fomni)) family = "Sound (FoMni family)";
      else family = "Sound (Felucca family)";
    } else if (node.classification === "other-root-lineage" && nodes.get(node.root_id)?.name === "AMB-1") {
      family = "Sound (AMB-1 family)";
    } else if (node.classification === "official-fm1-open" && node.primary_parent) {
      family = "Sound (M-VAVE fm1_open family)";
    }
    if (family) families.set(key, family);
  }
  return families;
}
