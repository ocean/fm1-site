// The bootloader check's scanner: looks at every FM-1 firmware on Felucca's update code and writes
// bootloader-check/data.json's format (described in scripts/validate-bootloader-check.mjs).
//
// Each firmware is classified two ways:
// - source: what its default branch's update code does now (see source.mjs);
// - release.package: what its latest release's .fwsc does, which is what people install (see
//   fwsc.mjs).
// It also looks at modified forks of Felucca and of the popular firmwares.
//
// What it can't find out this run is carried forward from the previous data: a repository GitHub
// wouldn't answer for keeps its previous entry, and the listed repositories are never dropped
// because discovery didn't find them again. Only a repository that's gone (404) is dropped.
// Overrides aren't applied here: the page's build applies them.
//
// Repositories and packages are untrusted: they're parsed, never built or run. Only read-only
// requests are made to GitHub.
//
// Usage:
//   GITHUB_TOKEN=... node scripts/bootloader-check/scan.mjs --previous bootloader-check/data.json \
//     --output /path/to/data.json [--catalogue firmwares.json] [--details /path/to/details.json]
//     [--limit N] [--skip-packages] [--skip-search] [--skip-forks]
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { validateBootloaderCheck } from "../validate-bootloader-check.mjs";
import {
  catalogueRepos,
  isExcluded,
  listForks,
  popularStars,
  pushedSinceForked,
  searchRepos,
} from "./discover.mjs";
import { classifyPackage, combinePackageStatuses } from "./fwsc.mjs";
import { createGitHub, mapLimit } from "./github.mjs";
import { blobId, classifyText, createSourceClassifier } from "./source.mjs";
import { filesInZip } from "./zip.mjs";

const { values: options } = parseArgs({
  options: {
    previous: { type: "string" },
    output: { type: "string" },
    catalogue: { type: "string", default: "firmwares.json" },
    overrides: { type: "string", default: "bootloader-check/overrides.json" },
    details: { type: "string" },
    limit: { type: "string" },
    "skip-packages": { type: "boolean", default: false },
    "skip-search": { type: "boolean", default: false },
    "skip-forks": { type: "boolean", default: false },
  },
});
if (!options.previous || !options.output) {
  console.error("Usage: node scripts/bootloader-check/scan.mjs --previous <data.json> --output <path>");
  process.exit(2);
}

const log = (message) => console.log(message);
const github = createGitHub({ log });
const sources = createSourceClassifier(github);
const startedAt = new Date();
const errors = [];
const details = {};
const note = (repo, stage, error) => {
  const message = error instanceof Error ? error.message : String(error);
  errors.push({ repo, stage, message });
  log(`  ! ${repo} (${stage}): ${message.slice(0, 200)}`);
};
const key = (repo) => repo.toLowerCase();
const day = (iso) => (iso ? iso.slice(0, 10) : null);

// Felucca's own ota.c at its releases, by blob ID, for naming a fork's copy.
const feluccaRepo = "hugelton/Felucca";
const feluccaOtaPath = "firmware/src/ota.c";
const feluccaVersions = new Map([
  ["45ce4d45897bd91cb69f81a32bd2f0afea895ec6", "Felucca 0.8-beta"],
  ["b2a5a1a0fec44e83525548737ba28ee1d8b1d1a1", "Felucca 1.0-1.4"],
  ["6a0d049b3637933f9398f120d60f477e10f2f625", "Felucca 1.5-1.6"],
  ["cc929b33abe899a8f4f37b59d9d7c170a6ab4d2c", "Felucca 1.6.1"],
]);
// The largest release assets downloaded.
const maximumPackageBytes = 2 * 1024 * 1024;
const maximumZipBytes = 40 * 1024 * 1024;
const maximumPackagesPerRelease = 8;
// More failures than this share of the firmwares means something is broken: fail the run.
const failureShare = 0.2;

const previous = JSON.parse(await readFile(options.previous, "utf8"));
const previousFirmwares = new Map(previous.firmwares.map((entry) => [key(entry.repo), entry]));
const previousForks = new Map(previous.forks.map((fork) => [key(fork.repo), fork]));
const catalogue = await readFile(options.catalogue, "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => null);
const catalogued = new Map(catalogueRepos(catalogue).map((entry) => [key(entry.repo), entry]));

// 1. Discovery.
log("Discovery");
const candidates = new Map();
for (const entry of previous.firmwares) candidates.set(key(entry.repo), { repo: entry.repo, from: "previous" });
let catalogueAdded = 0;
for (const entry of catalogued.values()) {
  if (candidates.has(key(entry.repo)) || isExcluded(entry.repo) || previousForks.has(key(entry.repo))) continue;
  candidates.set(key(entry.repo), { repo: entry.repo, from: "catalogue" });
  catalogueAdded++;
}
log(`  ${previous.firmwares.length} listed; ${catalogueAdded} more from the catalogue (${catalogued.size} on GitHub)`);
let searchAdded = 0;
let searchUsed = false;
if (!options["skip-search"]) {
  const found = await searchRepos(github, log).catch((error) => {
    note("(code search)", "discovery", error);
    return null;
  });
  searchUsed = found !== null;
  for (const repo of found ?? []) {
    if (candidates.has(key(repo)) || isExcluded(repo) || previousForks.has(key(repo))) continue;
    candidates.set(key(repo), { repo, from: "search" });
    searchAdded++;
  }
  if (found) log(`  ${found.length} repositories from code search, ${searchAdded} not listed yet`);
}

// 2. Each repository's metadata, from GraphQL in batches.
const releaseFields = `tagName publishedAt createdAt isDraft isPrerelease
  releaseAssets(first: 50) { nodes { name size downloadUrl } }`;
const repoFields = `nameWithOwner isFork stargazerCount owner { login } parent { nameWithOwner }
  defaultBranchRef { name target { ... on Commit { oid committedDate } } }
  latestRelease { ${releaseFields} }
  releases(first: 5, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${releaseFields} } }`;

// Metadata for repositories: Map of key -> { data } | { gone: true } | { error }.
async function metadataFor(repos, fields, batchSize = 25) {
  const results = new Map();
  for (let start = 0; start < repos.length; start += batchSize) {
    const batch = repos.slice(start, start + batchSize);
    const query = `query {\n${batch
      .map((repo, index) => {
        const [owner, name] = repo.split("/");
        return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} }`;
      })
      .join("\n")}\n}`;
    try {
      const { data, errors: problems } = await github.graphql(query);
      batch.forEach((repo, index) => {
        const alias = `r${index}`;
        const problem = problems.find((error) => error.path?.[0] === alias);
        if (data[alias]) results.set(key(repo), { data: data[alias] });
        else if (problem?.type === "NOT_FOUND") results.set(key(repo), { gone: true });
        else results.set(key(repo), { error: new Error(problem?.message ?? "no data") });
      });
    } catch (error) {
      for (const repo of batch) results.set(key(repo), { error });
    }
  }
  return results;
}

let toScan = [...candidates.values()];
if (options.limit) {
  // For trying the scanner out: look at the first N; the rest are carried forward as they were.
  toScan = toScan.slice(0, Number(options.limit));
  log(`  --limit: looking at ${toScan.length} of ${candidates.size}; the rest are carried forward`);
}
log(`Metadata for ${toScan.length} repositories`);
const metadata = await metadataFor(toScan.map((candidate) => candidate.repo), repoFields);

// 3. Source: each default branch's update code.
log("Source");
const scanned = new Map();
await mapLimit(toScan, 4, async (candidate) => {
  const result = metadata.get(key(candidate.repo));
  if (result.gone) {
    log(`  - ${candidate.repo}: gone (404)${candidate.from === "previous" ? ", dropped" : ""}`);
    scanned.set(key(candidate.repo), { gone: true });
    return;
  }
  if (result.error) {
    if (candidate.from === "previous") note(candidate.repo, "metadata", result.error);
    scanned.set(key(candidate.repo), { error: true });
    return;
  }
  const meta = result.data;
  const commit = meta.defaultBranchRef?.target?.oid;
  let source = null;
  if (!commit) {
    source = { status: "unclear", basis: "unknown", kind: null, detail: "empty repository" };
  } else {
    try {
      source = await sources.classify(meta.nameWithOwner, commit);
    } catch (error) {
      if (candidate.from === "previous") note(candidate.repo, "source", error);
    }
  }
  scanned.set(key(candidate.repo), { meta, source, commit });
});

// 4. Packages: each latest release's .fwsc files.
const hasAsset = (release, pattern) => (release.releaseAssets?.nodes ?? []).some((asset) => pattern.test(asset.name));

// The release people install: GitHub's latest (or, when every release is a pre-release, the
// newest) if it has a package, zipped or not; otherwise the newest release that has a .fwsc, as
// when the latest only has notes; otherwise the latest.
function latestRelease(meta) {
  const recent = (meta.releases?.nodes ?? []).filter((node) => !node.isDraft);
  const latest = (meta.latestRelease && !meta.latestRelease.isDraft ? meta.latestRelease : null) ?? recent[0] ?? null;
  if (!latest || hasAsset(latest, /\.(fwsc|zip)$/i)) return latest;
  return recent.find((release) => hasAsset(release, /\.fwsc$/i)) ?? latest;
}

// M-VAVE's own packages, which some releases carry for going back to stock: not the firmware's.
const officialPackages = new Map([
  ["db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a", "M-VAVE V15"],
  ["2dd4f2d2f020851f8797752371704a9a541aa747f4e20419d629de9aa2c66f43", "M-VAVE Open V12"],
]);

async function packageStatus(repo, release) {
  const assets = release.releaseAssets?.nodes ?? [];
  const packages = assets.filter((asset) => /\.fwsc$/i.test(asset.name)).slice(0, maximumPackagesPerRelease);
  const files = [];
  for (const asset of packages) {
    if (asset.size > maximumPackageBytes) continue;
    files.push({ name: asset.name, data: await github.download(asset.downloadUrl, { maximumBytes: maximumPackageBytes }) });
  }
  if (packages.length === 0) {
    // Some releases ship their packages zipped.
    for (const asset of assets.filter((candidate) => /\.zip$/i.test(candidate.name)).slice(0, 3)) {
      if (asset.size > maximumZipBytes) continue;
      const archive = await github.download(asset.downloadUrl, { maximumBytes: maximumZipBytes });
      try {
        const inside = filesInZip(archive, { maximumBytes: maximumPackageBytes, maximumFiles: maximumPackagesPerRelease });
        files.push(...inside.map((file) => ({ name: `${asset.name}/${file.name}`, data: file.data })));
      } catch (error) {
        log(`  ${repo} ${asset.name}: ${error.message}`);
      }
    }
  }
  const results = [];
  for (const file of files) {
    const official = officialPackages.get(createHash("sha256").update(file.data).digest("hex"));
    if (official) {
      results.push({ name: file.name, status: "skipped", reason: `${official}, not the firmware` });
      continue;
    }
    try {
      const result = classifyPackage(file.data);
      results.push({ name: file.name, ...result });
    } catch (error) {
      results.push({ name: file.name, status: null, reason: error.message });
    }
  }
  const own = results.filter((result) => result.status !== "skipped");
  const readable = own.filter((result) => result.status);
  // Packages there but none readable: not checked, rather than none.
  const status = own.length > 0 && readable.length === 0 ? null : combinePackageStatuses(readable.map((result) => result.status));
  return { status, results };
}

if (!options["skip-packages"]) log("Packages");
await mapLimit([...scanned.entries()], 3, async ([repoKey, entry]) => {
  if (!entry.meta) return;
  const release = latestRelease(entry.meta);
  entry.release = release
    ? { tag: release.tagName, date: day(release.publishedAt ?? release.createdAt), package: null }
    : null;
  if (!release || options["skip-packages"]) return;
  // Only firmwares worth listing: ones already listed or with update code.
  if (candidates.get(repoKey).from !== "previous" && !entry.source?.kind) return;
  try {
    const { status, results } = await packageStatus(entry.meta.nameWithOwner, release);
    entry.release.package = status;
    entry.packages = results.map(({ name, status: result, reason, product }) => ({ name, status: result, reason, product }));
  } catch (error) {
    note(entry.meta.nameWithOwner, "package", error);
    entry.packageFailed = true;
  }
});

// 5. Firmwares, carrying forward what wasn't found out.
const firmwares = [];
const dropped = [];
const notAdded = [];
const emitted = new Set();
const add = (entry) => {
  // A renamed repository can be found under both names: list it once.
  if (emitted.has(key(entry.repo))) return;
  emitted.add(key(entry.repo));
  firmwares.push(entry);
};
for (const candidate of candidates.values()) {
  const before = previousFirmwares.get(key(candidate.repo)) ?? null;
  const entry = scanned.get(key(candidate.repo));
  if (!entry) {
    if (before) add(before);
    continue;
  }
  if (entry.gone) {
    if (before) dropped.push(before.repo);
    continue;
  }
  if (entry.error || !entry.meta) {
    if (before) add(before);
    continue;
  }
  const { meta, source } = entry;
  // A repository not listed yet is added only when it has the update code.
  if (!before && (!source?.kind || isExcluded(meta.nameWithOwner))) {
    notAdded.push(`${candidate.repo} (${candidate.from}: ${source ? (source.kind ?? "no update code") : "not classified"})`);
    continue;
  }

  let repo = before?.repo ?? meta.nameWithOwner;
  if (key(repo) !== key(meta.nameWithOwner)) {
    log(`  ${repo} is now ${meta.nameWithOwner} (overrides for the old name need moving)`);
    repo = meta.nameWithOwner;
  }
  const listing = catalogued.get(key(repo));
  let release = entry.release;
  if (release && release.package === null && before?.release?.tag === release.tag) {
    // Not checked this run (skipped or failed): keep what was found for the same release.
    release = { ...release, package: before.release.package ?? null };
  }
  let basis = source?.basis;
  // The scan can't tell an independent rewrite from a copy: keep what the survey found.
  if (before?.source.basis === "rewrite" && source?.status === "affected" && basis === "own-copy") basis = "rewrite";
  add({
    name: before?.name ?? listing?.name ?? repo.split("/")[1],
    repo,
    forkOf: meta.parent?.nameWithOwner ?? null,
    author: meta.owner.login,
    identity: before?.identity ?? listing?.product ?? null,
    stars: meta.stargazerCount,
    lastCommit: day(meta.defaultBranchRef?.target?.committedDate) ?? before?.lastCommit ?? null,
    source: source ? { status: source.status, basis } : before.source,
    release,
  });
  details[repo] ??= {
    from: candidate.from,
    commit: entry.commit ?? null,
    source: source ? { kind: source.kind, path: source.path, detail: source.detail, note: source.note } : null,
    packages: entry.packages ?? null,
  };
}
firmwares.sort((a, b) => b.stars - a.stars || key(a.repo).localeCompare(key(b.repo)));
const listed = new Set(firmwares.map((entry) => key(entry.repo)));

// 6. Modified forks.
async function scanForks() {
  log("Forks");
  const parents = new Set([feluccaRepo, ...previous.forks.map((fork) => fork.parent)]);
  for (const entry of firmwares) if (entry.stars >= popularStars) parents.add(entry.repo);
  const listings = await listForks(github, [...parents]);
  const seen = new Map();
  for (const [parent, forks] of listings) {
    for (const fork of forks) seen.set(key(fork.repo), { ...fork, parent });
  }
  log(`  ${seen.size} forks of ${parents.size} repositories`);

  // The forks to look at: the ones listed before, and any pushed to since they were made.
  const repos = new Map();
  for (const fork of previous.forks) repos.set(key(fork.repo), fork.repo);
  for (const fork of seen.values()) {
    if (pushedSinceForked(fork) && !listed.has(key(fork.repo)) && !isExcluded(fork.repo)) repos.set(key(fork.repo), fork.repo);
  }
  const forkFields = `nameWithOwner parent { nameWithOwner defaultBranchRef { target { oid } } }
    defaultBranchRef { target { oid } }`;
  const forkMetadata = await metadataFor([...repos.values()], forkFields, 50);

  // Felucca's latest release's ota.c, in case it's newer than the versions known here.
  const versions = new Map(feluccaVersions);
  try {
    const release = await github.rest(`repos/${feluccaRepo}/releases/latest`);
    const data = release && (await github.raw(feluccaRepo, release.tag_name, feluccaOtaPath));
    if (data && !versions.has(blobId(data))) versions.set(blobId(data), `Felucca ${release.tag_name.replace(/^v/, "")}`);
  } catch (error) {
    note(feluccaRepo, "versions", error);
  }

  // Where each parent keeps its update code.
  const paths = new Map(Object.entries(details).map(([repo, detail]) => [key(repo), detail.source?.path ?? null]));
  const result = [];
  const skipped = [];
  await mapLimit([...repos.values()], 4, async (repo) => {
    const before = previousForks.get(key(repo)) ?? null;
    const answer = forkMetadata.get(key(repo));
    if (answer.gone) {
      if (before) log(`  - ${repo}: gone (404), dropped`);
      return;
    }
    if (answer.error || !answer.data.parent) {
      if (before) {
        if (answer.error) note(repo, "fork metadata", answer.error);
        result.push(before);
      }
      return;
    }
    const meta = answer.data;
    const head = meta.defaultBranchRef?.target?.oid;
    const parentHead = meta.parent.defaultBranchRef?.target?.oid;
    try {
      if (!before) {
        // Modified: at least one commit its parent doesn't have.
        if (!head || !parentHead) return;
        const comparison = await github.rest(`repos/${meta.nameWithOwner}/compare/${parentHead}...${head}`);
        if (!comparison || comparison.ahead_by === 0) return;
      }
      const parentPath = paths.get(key(meta.parent.nameWithOwner)) ?? feluccaOtaPath;
      const data = head ? await github.raw(meta.nameWithOwner, head, parentPath, { maximumBytes: 1024 * 1024 }) : null;
      const kind = data ? classifyText(data.toString("utf8")) : null;
      const fork = { repo: before?.repo ?? meta.nameWithOwner, parent: meta.parent.nameWithOwner };
      if (!kind) {
        result.push({ ...fork, status: "no-update-code", basis: null });
      } else if (kind === "affected") {
        result.push({ ...fork, status: "affected", basis: versions.get(blobId(data)) ?? "modified" });
      } else {
        // The data has no status for a fork with the fix (or other update code): say so.
        skipped.push(`${meta.nameWithOwner} (${kind})`);
      }
    } catch (error) {
      note(repo, "fork", error);
      if (before) result.push(before);
    }
  });
  if (skipped.length > 0) log(`  Forks left out, as their update code isn't the old check: ${skipped.join(", ")}`);
  result.sort((a, b) => key(a.parent).localeCompare(key(b.parent)) || key(a.repo).localeCompare(key(b.repo)));
  return result;
}

let forks = previous.forks;
if (!options["skip-forks"]) {
  try {
    forks = await scanForks();
  } catch (error) {
    note("(forks)", "forks", error);
    forks = previous.forks;
  }
}

// 7. Write, check and summarise.
const data = { formatVersion: 1, checkedAt: startedAt.toISOString(), method: "scan", firmwares, forks };
const text = `${JSON.stringify(data, null, 2)}\n`;
const overridesText = await readFile(options.overrides, "utf8").catch(() => '{ "formatVersion": 1, "overrides": {} }');
const problems = validateBootloaderCheck(text, overridesText);

const count = (list, pick) => list.reduce((counts, item) => ({ ...counts, [pick(item)]: (counts[pick(item)] ?? 0) + 1 }), {});
const sourceChanges = [];
for (const entry of firmwares) {
  const before = previousFirmwares.get(key(entry.repo));
  if (!before) continue;
  if (before.source.status !== entry.source.status || before.source.basis !== entry.source.basis) {
    sourceChanges.push(`${entry.repo}: ${before.source.status}/${before.source.basis} -> ${entry.source.status}/${entry.source.basis}`);
  }
}
const added = firmwares.filter((entry) => !previousFirmwares.has(key(entry.repo)));
const forksAdded = forks.filter((fork) => !previousForks.has(key(fork.repo)));
const forksDropped = previous.forks.filter((fork) => !forks.some((other) => key(other.repo) === key(fork.repo)));
const summary = {
  firmwares: firmwares.length,
  sources: count(firmwares, (entry) => `${entry.source.status}/${entry.source.basis}`),
  packages: count(firmwares, (entry) => (entry.release ? String(entry.release.package) : "no release")),
  sourceChanges,
  added: added.map((entry) => `${entry.repo} (${details[entry.repo]?.from}: ${entry.source.status}/${entry.source.basis})`),
  notAdded,
  dropped,
  forks: forks.length,
  forksAdded: forksAdded.map((fork) => `${fork.repo} (${fork.status}, ${fork.basis})`),
  forksDropped: forksDropped.map((fork) => fork.repo),
  codeSearch: searchUsed ? "used" : "skipped",
  requests: github.counts,
  errors,
};
log(`\nSummary\n${JSON.stringify(summary, null, 2)}`);

await writeFile(options.output, text);
log(`Wrote ${options.output}`);
if (options.details) {
  await writeFile(options.details, `${JSON.stringify({ summary, repos: details }, null, 2)}\n`);
  log(`Wrote ${options.details}`);
}
if (problems.length > 0) {
  console.error(`The scan's data has ${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
const failed = new Set(errors.map((error) => error.repo)).size;
if (failed > firmwares.length * failureShare) {
  console.error(`${failed} repositories failed, too many to trust this run.`);
  process.exit(1);
}
