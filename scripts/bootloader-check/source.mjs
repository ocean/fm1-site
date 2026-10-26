// Classifies a firmware repository's default branch: does its update code refuse V15 once the
// FM-1's bootloader has changed (the old check in Felucca's ota_stage()), or not?
//
// The update code is found from one recursive tree listing of the commit: the C files whose names
// say "ota" or "update", outside tests. Only those files are fetched (raw.githubusercontent.com),
// and only read as text. When the repository has none, its submodules are followed: a pinned
// fm1-base, felucca-bsp, Felucca or X0X is classified by the update code at the pinned commit, so
// fm1-base is followed on to its own felucca-bsp pin.
//
// Nothing fetched is built or run.
import { createHash } from "node:crypto";

// Files whose names say they hold update code, outside tests and fixtures.
const candidateName = /(^|\/)[^/]*(ota|update)[^/]*\.c$/i;
const testPath = /(^|\/)(tests?|testing|fixtures?|stubs?|mocks?|examples?|docs?)\//i;
const testName = /(^|\/)[^/]*(test|mock|stub|fixture)[^/]*$/i;
const vendoredPath = /(^|\/)(vendor|vendored|upstream|third_party|thirdparty|external|deps)\//i;
const maximumCandidates = 8;
const maximumSubmoduleDepth = 3;
// Submodules that are the platform's base (fm1-base and felucca-bsp), rather than a whole firmware.
const basePlatform = /(^|\/)(felucca-bsp|fm1-base)$/i;

// Git's blob ID for a file's contents, as in a tree listing.
export function blobId(data) {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

// What one file's text says about its update code: "fixed" (ota_boot_valid), "pinned" (accepts
// only the exact V15 image), "affected" (the old check), "update-code" (update code without any
// of those) or null (no update code at all).
export function classifyText(text) {
  const hasUpdateCode = /\bota_stage\b|FELUCCA-LOADER-1|\b\w*LDR_HCRC\b|0xEBAA/i.test(text);
  if (!hasUpdateCode) return null;
  if (/\bota_boot_valid\b/.test(text)) return "fixed";
  if (/\betch_ota_stock\b/.test(text)) return "pinned";
  // M-VAVE's loader recognised by its header CRC, and the boot area compared up to 0x4000.
  const recognisesLoader = /\b\w*LDR_HCRC\b|0xEBAA/i.test(text);
  const comparesHead =
    /the official loader writes the head/i.test(text) ||
    (/0x4000u?\b/i.test(text) && /\b(ota_memeq|memeq|memcmp)\s*\(/.test(text) && /return\s+-[57]\s*;/.test(text));
  if (recognisesLoader && comparesHead) return "affected";
  return "update-code";
}

// The candidate update-code files in a tree listing, best first: the repository's own code before
// vendored copies, files called ota.c first, then the shallowest.
export function candidateFiles(tree) {
  const rank = (path) => [vendoredPath.test(path) ? 1 : 0, /(^|\/)ota\.c$/.test(path) ? 0 : 1, path.split("/").length];
  const compare = (a, b) => {
    const [x, y] = [rank(a.path), rank(b.path)];
    for (let index = 0; index < x.length; index++) {
      if (x[index] !== y[index]) return x[index] - y[index];
    }
    return a.path.localeCompare(b.path);
  };
  return tree
    .filter((entry) => entry.type === "blob" && candidateName.test(entry.path))
    .filter((entry) => !testPath.test(entry.path) && !testName.test(entry.path))
    .sort(compare);
}

// The submodules in .gitmodules, as { path, url }.
export function parseGitmodules(text) {
  const modules = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[submodule\b/.test(line)) {
      current = {};
      modules.push(current);
      continue;
    }
    const match = /^\s*(path|url)\s*=\s*(.+?)\s*$/.exec(line);
    if (current && match) current[match[1]] = match[2];
  }
  return modules.filter((module) => module.path && module.url);
}

// The owner/name of a submodule's GitHub repository, or null for one elsewhere. A relative URL
// (../name.git) is relative to the repository that has the submodule.
export function githubRepoOf(url, parentRepo) {
  let match = /^(?:https?:\/\/|git:\/\/|ssh:\/\/git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  match ??= /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  if (match) return `${match[1]}/${match[2]}`;
  const relative = /^\.\.\/(?:\.\.\/([\w.-]+)\/)?([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (relative && parentRepo) return `${relative[1] ?? parentRepo.split("/")[0]}/${relative[2]}`;
  return null;
}

// Classifies repositories. One classifier is shared by a whole scan, so a submodule pinned by
// several firmwares (fm1-base, felucca-bsp) is looked at once per commit.
export function createSourceClassifier(github) {
  const treeCache = new Map();
  const submoduleCache = new Map();

  // A commit's whole tree, and whether GitHub cut it short.
  function treeOf(repo, commit) {
    const key = `${repo}@${commit}`;
    if (!treeCache.has(key)) {
      treeCache.set(
        key,
        github.rest(`repos/${repo}/git/trees/${commit}?recursive=1`).then((result) => {
          if (!result) return null;
          return { entries: result.tree, truncated: result.truncated };
        }),
      );
    }
    return treeCache.get(key);
  }

  // The first candidate file with update code: { path, blob, kind, text }, or null.
  async function findUpdateCode(repo, commit, entries) {
    for (const entry of candidateFiles(entries).slice(0, maximumCandidates)) {
      const data = await github.raw(repo, commit, entry.path, { maximumBytes: 1024 * 1024 });
      if (!data) continue;
      const text = data.toString("utf8");
      const kind = classifyText(text);
      if (kind) return { path: entry.path, blob: blobId(data), kind, text };
    }
    return null;
  }

  async function submodulesOf(repo, commit, entries) {
    const pinned = entries.filter((entry) => entry.type === "commit");
    if (pinned.length === 0) return [];
    const gitmodules = await github.raw(repo, commit, ".gitmodules");
    const urls = new Map(parseGitmodules(gitmodules?.toString("utf8") ?? "").map((module) => [module.path, module.url]));
    return pinned.map((entry) => {
      const url = urls.get(entry.path) ?? null;
      return { path: entry.path, commit: entry.sha, url, repo: url ? githubRepoOf(url, repo) : null };
    });
  }

  // Follows a submodule to its update code: { kind, via: [repos], base } or null.
  async function classifySubmodule(module, depth) {
    const key = `${module.repo}@${module.commit}`;
    if (!submoduleCache.has(key)) {
      submoduleCache.set(
        key,
        (async () => {
          const tree = await treeOf(module.repo, module.commit);
          if (!tree) return null;
          const found = await findUpdateCode(module.repo, module.commit, tree.entries);
          if (found) return { kind: found.kind, via: [module.repo], path: found.path };
          if (depth >= maximumSubmoduleDepth) return null;
          for (const inner of await submodulesOf(module.repo, module.commit, tree.entries)) {
            if (!inner.repo) continue;
            const result = await classifySubmodule(inner, depth + 1);
            if (result) return { ...result, via: [module.repo, ...result.via] };
          }
          return null;
        })(),
      );
    }
    return submoduleCache.get(key);
  }

  // Classifies a repository at a commit. Returns { status, basis, path, blob, kind, detail, note }
  // in the data's terms; throws when GitHub couldn't be asked (so the caller keeps what it had).
  async function classify(repo, commit) {
    const tree = await treeOf(repo, commit);
    if (!tree) throw new Error(`no tree for ${repo}@${commit}`);
    const note = tree.truncated ? "GitHub cut the tree listing short" : null;
    const own = await findUpdateCode(repo, commit, tree.entries);
    if (own) {
      const byKind = {
        fixed: ["ok", "fixed-code"],
        pinned: ["ok", "pinned-v15"],
        affected: ["affected", "own-copy"],
        "update-code": ["unclear", "unknown"],
      };
      const [status, basis] = byKind[own.kind];
      return { status, basis, path: own.path, blob: own.blob, kind: own.kind, text: own.text, detail: own.path, note };
    }

    const modules = await submodulesOf(repo, commit, tree.entries);
    // Look at the platform's own submodules first.
    const ordered = [...modules].sort(
      (a, b) => Number(!basePlatform.test(a.repo ?? "")) - Number(!basePlatform.test(b.repo ?? "")),
    );
    for (const module of ordered) {
      if (!module.repo) continue;
      const result = await classifySubmodule(module, 1);
      if (!result) continue;
      const isBase = result.via.some((via) => basePlatform.test(via));
      const detail = `${module.path} -> ${result.via.join(" -> ")} (${module.commit.slice(0, 7)})`;
      const byKind = {
        fixed: ["ok", isBase ? "fixed-base" : "fixed-code"],
        pinned: ["ok", "pinned-v15"],
        affected: ["affected", isBase ? "old-base" : "submodule"],
        "update-code": ["unclear", "unknown"],
      };
      const [status, basis] = byKind[result.kind];
      return { status, basis, path: null, blob: null, kind: result.kind, detail, note };
    }
    return { status: "unclear", basis: "unknown", path: null, blob: null, kind: null, detail: null, note };
  }

  return { classify, treeOf };
}
