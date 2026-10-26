// Finds the repositories the bootloader check looks at, beyond the ones it already lists:
// - the site's own firmware catalogue (firmwares.json), for entries whose repository is on GitHub;
// - GitHub code search for the update code's telltale text (code search skips forks);
// - the forks of Felucca and of the most starred firmwares, which code search can't see.
//
// Code search needs a token GitHub accepts for it. If it's refused (as it may be for the Actions
// token), discovery goes on without it and says so.

// Text only Felucca's update code (old or fixed) has.
export const searchQueries = [
  '"FELUCCA-LOADER-1"',
  '"official loader writes the head"',
  "OTA_LDR_HCRC",
  "ota_boot_valid",
];

// Repositories with the update code that aren't FM-1 firmwares, so they're never added: the
// platform's libraries, firmwares only for the SMK-37, and tools, emulators and catalogues that
// carry copies of firmwares. (A correction to a listed repository belongs in overrides.json.)
export const excludedRepos = new Set(
  [
    "hugelton/felucca-bsp",
    "charlesvestal/fm1-base",
    "styvesgoupil/fm1-base",
    "ChanceTheMaker/sloop-smk",
    "genkigenki/Makkuro37",
    "acidsound/smk37pro-acidsound-mod",
    "jbschooley/Virtual-FM-1",
    "quixotic7/FM1VST",
    "thingsapart/fm1-studio",
    "joakimeriksson/fm1-emu",
    "markterm/harbor",
    "jvitkauskas/m-flasher",
    "kmplngj/m-flasher",
    "kmplngj/m-flasher-legacy",
    "Quixotic7/MvaveFM1Unbricker",
    "kurogedelic/FM-1-transporter",
    "AL-255/FM-1-RE",
    "hyruleanhero1988/FM-1-Swap",
    "ocean/FM-SWITCH",
    "ocean/FM1Kit",
    "ocean/fm1-site",
    "aroum/fm1-custom-fw",
    "2bbb/fm1-firmware-collection",
    "philmillman/altstrument",
  ].map((repo) => repo.toLowerCase()),
);

export const isExcluded = (repo) => excludedRepos.has(repo.toLowerCase());

// How many stars make a firmware popular enough to have its forks looked at.
export const popularStars = 30;

const githubRepo = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:[#?].*)?$/i;

// The catalogue's firmwares that are on GitHub: { repo, name, product }, one per repository.
export function catalogueRepos(catalogue) {
  const found = new Map();
  for (const entry of catalogue?.entries ?? []) {
    let repo = typeof entry.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(entry.repo) ? entry.repo : null;
    if (!repo) {
      const link = (entry.links ?? []).find((candidate) => /source/i.test(candidate.label ?? "") && githubRepo.test(candidate.url));
      const match = link && githubRepo.exec(link.url);
      repo = match ? `${match[1]}/${match[2]}` : null;
    }
    if (!repo || found.has(repo.toLowerCase())) continue;
    found.set(repo.toLowerCase(), { repo, name: entry.name ?? null, product: entry.product ?? null });
  }
  return [...found.values()];
}

// Repositories code search finds, or null when code search was refused.
export async function searchRepos(github, log) {
  const repos = new Map();
  for (const query of searchQueries) {
    try {
      const items = await github.searchCode(query);
      for (const item of items) {
        const repo = item.repository?.full_name;
        if (repo && !item.repository.fork) repos.set(repo.toLowerCase(), repo);
      }
      log(`  code search ${query}: ${items.length} file(s)`);
    } catch (error) {
      if ([401, 403, 422].includes(error.status)) {
        log(`  Code search was refused (${error.status}), so it's skipped: ${error.message.slice(0, 160)}`);
        return null;
      }
      throw error;
    }
  }
  return [...repos.values()];
}

// The forks of each parent: Map of parent -> [{ repo, createdAt, pushedAt }].
export async function listForks(github, parents) {
  const forks = new Map();
  const query = `query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      forks(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { nameWithOwner createdAt pushedAt }
      }
    }
  }`;
  for (const parent of parents) {
    const [owner, name] = parent.split("/");
    const list = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
      const { data } = await github.graphql(query, { owner, name, after });
      const connection = data.repository?.forks;
      if (!connection) break;
      list.push(
        ...connection.nodes.map((node) => ({ repo: node.nameWithOwner, createdAt: node.createdAt, pushedAt: node.pushedAt })),
      );
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }
    forks.set(parent, list);
  }
  return forks;
}

// True when a fork has been pushed to since it was made (a fork that hasn't is its parent's copy).
export const pushedSinceForked = (fork) => Date.parse(fork.pushedAt) > Date.parse(fork.createdAt) + 60_000;
