// The FM-1 Moment's weekly refresh. It counts what each directory lists (directories.json) and
// adds firmwares new to aroum's FM1 Resource Hub to releases.csv, dated by the same evidence as the
// rest: the firmware's earliest GitHub release of its own, or else its author's first commit. It
// writes a report of every change for the pull request, and changes nothing a person wrote: the
// prose, altstrument's hand count, and rows already in releases.csv stay as they are.
//
//   GH_TOKEN=... node scripts/fm1-moment/refresh.mjs [--report report.md]
//
// It reads other sites' data as text and only counts and matches it. GH_TOKEN is used read-only,
// for GitHub's API rate limit.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dayLabel, melbourneDay, parseCsv, readTable, window, writeTable } from "./data.mjs";
import { countEditor, countFmdb, countHub, countWorks, lineageFamilies, readResourceHub, repoKey } from "./sources.mjs";
import { root } from "../pinned.mjs";

const folder = join(root, "fm1-moment");
const userAgent = "fm-1.drewr.dev FM-1 Moment refresh (https://github.com/ocean/fm1-site)";
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const today = new Date().toISOString().slice(0, 10);

class NotFound extends Error {}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers: { "User-Agent": userAgent, ...headers } });
  if (response.status === 404) throw new NotFound(`${url} answered 404`);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return { text: await response.text(), link: response.headers.get("link") };
}

const githubHeaders = (accept = "application/vnd.github+json") => ({
  Accept: accept,
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

const githubJson = async (path) => {
  const { text, link } = await fetchText(`https://api.github.com/${path}`, githubHeaders());
  return { body: JSON.parse(text), link };
};

// A file from a repository's default branch.
const githubFile = async (repo, path) =>
  (await fetchText(`https://api.github.com/repos/${repo}/contents/${path}`, githubHeaders("application/vnd.github.raw"))).text;

// "2026-10-07T04:24:51Z" as releases.csv writes it, "2026-10-07T04:24Z".
const minutes = (iso) => `${iso.slice(0, 16)}Z`;

// When a repository's firmware was first public, and the evidence: its earliest release of its own
// (forks don't inherit releases), or else its author's first commit.
async function firstSeen(key) {
  const { body: repo } = await githubJson(`repos/${key}`);
  const releases = [];
  for (let page = 1; page <= 10; page += 1) {
    const { body } = await githubJson(`repos/${key}/releases?per_page=100&page=${page}`);
    releases.push(...body.filter((release) => !release.draft));
    if (body.length < 100) break;
  }
  const dated = releases
    .map((release) => ({ tag: release.tag_name, at: release.published_at ?? release.created_at }))
    .filter((release) => release.at)
    .sort((one, two) => one.at.localeCompare(two.at));
  const base = { repo, name: repo.name, owner: repo.owner.login, link: repo.html_url };
  if (dated.length > 0) return { ...base, at: minutes(dated[0].at), evidence: `tag ${dated[0].tag}` };

  // The oldest commit is on the last page, one commit to a page.
  const author = repo.fork ? `&author=${encodeURIComponent(repo.owner.login)}` : "";
  const first = await githubJson(`repos/${key}/commits?per_page=1${author}`);
  const last = /<([^>]+)>; rel="last"/.exec(first.link ?? "")?.[1];
  const commits = last ? (await githubJson(last.replace("https://api.github.com/", ""))).body : first.body;
  const commit = commits.at(-1);
  if (!commit) return { ...base, at: null, evidence: null };
  return {
    ...base,
    at: minutes(commit.commit.author.date),
    evidence: repo.fork ? "first own commit" : "first commit",
  };
}

const problems = [];
const report = [];

// Each directory's count, or null when its source couldn't be read (the old count then stays).
async function readCounts(hubMarkdown) {
  const attempt = async (name, read) => {
    try {
      return await read();
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
      return null;
    }
  };
  return {
    "resource-hub": await attempt("FM1 Resource Hub", async () => readResourceHub(hubMarkdown).counts),
    "fm1-editor": await attempt("fm1-editor.com", async () =>
      countEditor(await githubFile("benny-sparra/fm1-dx7-patch-importer", "firmware/index.html")),
    ),
    "cfw-database": await attempt("FM-1 CFW Database", async () =>
      countWorks(await githubFile("kurogedelic/FM-1_CFW_Database", "db/works.csv")),
    ),
    fmdb: await attempt("FMDB", async () =>
      countFmdb((await fetchText("https://stanleygurvich.github.io/FMDB_FM1_FirmwareDatabase/feed.json")).text),
    ),
    "firmware-hub": await attempt("The Firmware Hub (from firmwares.json)", async () =>
      countHub(await readFile(join(root, "firmwares.json"), "utf8")),
    ),
  };
}

// What each source's count says in the table.
function describe(source, count) {
  if (source === "resource-hub") {
    const total = count.sound + count.games + count.platforms + count.patchers;
    return {
      count: total,
      label: `${total} entries`,
      what: `Curated: ${count.sound + count.games} sound firmwares and games, ${count.platforms} platforms, ${count.patchers} patchers`,
    };
  }
  if (source === "cfw-database") return { count, label: `${count} works` };
  if (source === "firmware-hub") return { count, label: String(count) };
  return { count, label: `${count} entries` };
}

async function refreshDirectories(hubMarkdown) {
  const path = join(folder, "directories.json");
  const directories = JSON.parse(await readFile(path, "utf8"));
  const counts = await readCounts(hubMarkdown);
  let changed = false;
  for (const directory of directories.directories) {
    const count = counts[directory.source];
    if (count === undefined || count === null) continue;
    const next = describe(directory.source, count);
    const was = directory.label;
    if (next.label !== was || (next.what && next.what !== directory.what)) {
      report.push(`- ${directory.name}: ${was} -> ${next.label}${next.what && next.what !== directory.what ? ` (${next.what})` : ""}`);
      changed = true;
    }
    Object.assign(directory, next, { checkedOn: today });
    delete directory.dateApproximate;
  }
  if (!changed) return false;
  directories.checkedOn = today;
  await writeFile(path, `${JSON.stringify(directories, null, 2)}\n`);
  return true;
}

async function addNewFirmwares(hubMarkdown) {
  const path = join(folder, "releases.csv");
  const text = await readFile(path, "utf8");
  const [header] = parseCsv(text);
  const rows = readTable(text);
  const counted = new Set(rows.map((row) => repoKey(row.link)).filter(Boolean));
  const notCounted = JSON.parse(await readFile(join(folder, "not-counted.json"), "utf8"));
  const skipped = new Set(notCounted.repositories.map((entry) => entry.repo.toLowerCase()));
  const { entries } = readResourceHub(hubMarkdown);
  const candidates = entries.filter(
    (entry) => entry.repo && entry.family && !counted.has(entry.repo) && !skipped.has(entry.repo),
  );
  if (candidates.length === 0) return false;

  let families = new Map();
  try {
    families = lineageFamilies(await githubFile("kurogedelic/FM-1_CFW_Database", "db/taxonomy.json"));
  } catch (error) {
    problems.push(`FM-1 CFW Database lineage: ${error.message}; new firmwares keep aroum's families`);
  }

  const added = [];
  const leftOut = [];
  for (const candidate of candidates) {
    let seen;
    try {
      seen = await firstSeen(candidate.repo);
    } catch (error) {
      // A repository that's gone or private can't be dated; it stays out until it's back.
      if (error instanceof NotFound) {
        leftOut.push(`- ${candidate.name} (https://github.com/${candidate.repo}) is gone or private`);
      } else {
        problems.push(`${candidate.repo}: ${error.message}`);
      }
      continue;
    }
    if (!seen.at) {
      leftOut.push(`- ${candidate.name} (${seen.link}) has no release and no commit of its author's`);
      continue;
    }
    // Leo Kuroshita's lineage decides a sound firmware's family where it places one.
    const family = candidate.family.startsWith("Sound") ? (families.get(candidate.repo) ?? candidate.family) : candidate.family;
    added.push({
      first_seen_utc: seen.at,
      firmware: candidate.name || seen.name,
      author: seen.owner,
      family,
      link: seen.link,
      evidence: seen.evidence,
    });
  }
  if (leftOut.length > 0) report.push("", "In aroum's list but not added:", "", ...leftOut);
  if (added.length === 0) return false;

  const all = [...rows, ...added].sort((one, two) => one.first_seen_utc.localeCompare(two.first_seen_utc));
  await writeFile(path, writeTable(header, all, text.includes("\r\n") ? "\r\n" : "\n"));
  const line = (row) =>
    `- ${row.firmware} by ${row.author}, ${dayLabel(row.first_seen_utc.slice(0, 10))} ${row.first_seen_utc.slice(0, 4)} (${row.evidence}), ${row.family}: ${row.link}`;
  const sorted = added.sort((one, two) => one.first_seen_utc.localeCompare(two.first_seen_utc));
  const early = sorted.filter((row) => melbourneDay(row.first_seen_utc) <= window.boomEnd);
  const later = sorted.filter((row) => melbourneDay(row.first_seen_utc) > window.boomEnd);
  if (early.length > 0) {
    report.push("", `New in releases.csv, first seen by ${dayLabel(window.boomEnd, true)}, so the first five weeks' figures change (${early.length}):`, "", ...early.map(line));
  }
  if (later.length > 0) report.push("", `New in releases.csv, first seen since (${later.length}):`, "", ...later.map(line));
  return true;
}

const reportPath = process.argv.includes("--report") ? process.argv[process.argv.indexOf("--report") + 1] : null;

let hubMarkdown = null;
try {
  hubMarkdown = await githubFile("aroum/fm1-custom-fw", "README.md");
} catch (error) {
  problems.push(`FM1 Resource Hub: ${error.message}`);
}

report.push("Directory counts:", "");
const directoriesChanged = hubMarkdown ? await refreshDirectories(hubMarkdown) : false;
if (!directoriesChanged) report.push("- No change");
report.push("", "altstrument's count is checked by hand, and isn't refreshed.");
const releasesChanged = hubMarkdown ? await addNewFirmwares(hubMarkdown) : false;
if (problems.length > 0) report.push("", "Couldn't read:", "", ...problems.map((problem) => `- ${problem}`));

const changed = directoriesChanged || releasesChanged;
const text = `${report.join("\n")}\n`;
console.log(text);
if (reportPath) await writeFile(reportPath, text);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nproblems=${problems.length > 0}\n`);
}
