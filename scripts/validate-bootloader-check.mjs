// Checks the bootloader check's data (bootloader-check/data.json) and its hand-edited corrections
// (bootloader-check/overrides.json) before they're published, and describes their format.
//
// data.json, written by scripts/bootloader-check/scan.mjs:
// - formatVersion: 1; checkedAt: when the scan ran (ISO 8601); method: "survey" or "scan".
// - firmwares: one per FM-1 firmware on Felucca's update code, each with
//   - name, repo ("owner/name"), forkOf (a repo, or null), author, identity (its product string,
//     or null), stars, lastCommit (YYYY-MM-DD, or null), commits (its default branch's commits, or
//     for a fork, the ones its parent doesn't have; null when not known);
//   - source: what its default branch does now: status ("affected", "ok" or "unclear"), and basis,
//     one of the bases below;
//   - release: its latest release, or null: tag, date (YYYY-MM-DD, or null), and package, what its
//     .fwsc does ("affected", "ok", "other" for not Felucca's update code, "none" for no .fwsc,
//     "unclear", which only an override sets, or null when it hasn't been checked).
// - forks: modified forks, each with repo, parent, status ("affected" or "no-update-code") and
//   basis (which Felucca its update code comes from, or null).
//
// overrides.json: { formatVersion: 1, overrides: { "owner/name": { reason, and any of hide (true
// to leave a repo off the page), name, source, and release: { package }, which corrects the latest
// release's package status, whatever its tag } } }, applied on top of every scan.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const statuses = ["affected", "ok", "unclear"];
export const bases = {
  "own-copy": "Own copy of the old check",
  "old-base": "Pins fm1-base or felucca-bsp from before the fix",
  submodule: "Old check from a Felucca or X0X submodule",
  rewrite: "Independent rewrite with the same check",
  "fixed-code": "Has the fix (ota_boot_valid)",
  "fixed-base": "On a fixed fm1-base or felucca-bsp",
  "pinned-v15": "Accepts the exact V15 package (puts the stock bootloader back)",
  "own-loader": "Installs every package with its own loader",
  "chip-key": "Compares the chip key instead: untested",
  unknown: "Update code not found",
};
const packages = ["affected", "ok", "other", "none", "unclear", null];
const forkStatuses = ["affected", "no-update-code"];
const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const isDate = (value) => value === null || (typeof value === "string" && datePattern.test(value));

function checkSource(source, check) {
  check(source && statuses.includes(source.status), "source.status isn't affected, ok or unclear");
  check(source && Object.hasOwn(bases, source.basis), "source.basis is unknown");
}

function checkRelease(release, check) {
  if (release === null) return;
  check(typeof release.tag === "string" && release.tag.length > 0, "release has no tag");
  check(isDate(release.date), "release.date isn't YYYY-MM-DD or null");
  check(packages.includes(release.package), "release.package is unknown");
}

export function validateBootloaderCheck(dataText, overridesText) {
  const problems = [];
  let data;
  let overrides;
  try {
    data = JSON.parse(dataText);
    overrides = JSON.parse(overridesText);
  } catch (error) {
    return [`Not JSON: ${error.message}`];
  }
  if (data.formatVersion !== 1) problems.push("data: formatVersion isn't 1");
  if (Number.isNaN(Date.parse(data.checkedAt))) problems.push("data: checkedAt isn't a date");
  if (!["survey", "scan"].includes(data.method)) problems.push("data: method isn't survey or scan");
  if (!Array.isArray(data.firmwares) || data.firmwares.length === 0) problems.push("data: no firmwares");
  if (!Array.isArray(data.forks)) problems.push("data: forks isn't a list");
  if (problems.length > 0) return problems;

  const repos = new Set();
  for (const [index, entry] of data.firmwares.entries()) {
    const check = (ok, message) => {
      if (!ok) problems.push(`firmwares[${index}] (${entry?.repo ?? "?"}): ${message}`);
    };
    check(typeof entry.name === "string" && entry.name.length > 0, "no name");
    check(repoPattern.test(entry.repo ?? ""), "repo isn't owner/name");
    check(!repos.has(entry.repo), "its repo is listed twice");
    repos.add(entry.repo);
    check(entry.forkOf === null || repoPattern.test(entry.forkOf), "forkOf isn't owner/name or null");
    check(typeof entry.author === "string", "no author");
    check(entry.identity === null || typeof entry.identity === "string", "identity isn't text or null");
    check(Number.isInteger(entry.stars) && entry.stars >= 0, "stars isn't a whole number");
    check(isDate(entry.lastCommit), "lastCommit isn't YYYY-MM-DD or null");
    check(entry.commits == null || (Number.isInteger(entry.commits) && entry.commits >= 0), "commits isn't a whole number or null");
    checkSource(entry.source, check);
    checkRelease(entry.release, check);
  }
  for (const [index, fork] of data.forks.entries()) {
    const check = (ok, message) => {
      if (!ok) problems.push(`forks[${index}] (${fork?.repo ?? "?"}): ${message}`);
    };
    check(repoPattern.test(fork.repo ?? ""), "repo isn't owner/name");
    check(repoPattern.test(fork.parent ?? ""), "parent isn't owner/name");
    check(forkStatuses.includes(fork.status), "status is unknown");
    check(fork.basis === null || typeof fork.basis === "string", "basis isn't text or null");
  }

  if (overrides.formatVersion !== 1 || typeof overrides.overrides !== "object") {
    problems.push("overrides: formatVersion isn't 1, or there's no overrides object");
    return problems;
  }
  for (const [repo, override] of Object.entries(overrides.overrides)) {
    const check = (ok, message) => {
      if (!ok) problems.push(`overrides["${repo}"]: ${message}`);
    };
    check(repoPattern.test(repo), "isn't owner/name");
    check(typeof override.reason === "string" && override.reason.length > 0, "has no reason");
    const known = ["reason", "hide", "name", "source", "release"];
    check(Object.keys(override).every((key) => known.includes(key)), `has a key other than ${known.join(", ")}`);
    if (override.hide !== undefined) check(override.hide === true, "hide isn't true");
    if (override.name !== undefined) check(typeof override.name === "string", "name isn't text");
    if (override.source !== undefined) checkSource(override.source, check);
    if (override.release !== undefined) {
      check(
        override.release !== null &&
          Object.keys(override.release).join() === "package" &&
          packages.includes(override.release.package),
        "release has to be { package } alone, with a known package status",
      );
    }
  }
  return problems;
}

// The data as the page shows it: overrides applied, hidden repos left out.
export function applyOverrides(data, overrides) {
  const firmwares = [];
  for (const entry of data.firmwares) {
    const override = overrides.overrides[entry.repo];
    if (override?.hide) continue;
    const changes = { ...override };
    delete changes.reason;
    delete changes.hide;
    // A release correction keeps the scanned tag and date, so it carries over to new releases.
    if (changes.release) changes.release = entry.release && { ...entry.release, ...changes.release };
    firmwares.push({ ...entry, ...changes, corrected: override ? override.reason : null });
  }
  return { ...data, firmwares };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dataPath = "bootloader-check/data.json", overridesPath = "bootloader-check/overrides.json"] =
    process.argv.slice(2);
  const problems = validateBootloaderCheck(await readFile(dataPath, "utf8"), await readFile(overridesPath, "utf8"));
  if (problems.length > 0) {
    console.error(`The bootloader check's data has ${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("ok   bootloader-check/data.json and overrides.json");
}
