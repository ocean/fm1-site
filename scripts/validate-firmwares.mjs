// Checks firmwares.json, the FM-1 firmware list FM-SWITCH downloads, before it's published.
//
// The list is built by FM-SWITCH's fm1-catalogue tool (from the firmware hub, fm1-editor.com and
// aroum's FM1 Resource Hub). This repository publishes it, so it checks the file with its own code:
// the format the app understands, sane sizes, https for anything the app downloads, and real
// SHA-256 values. Run as a script with a path, or import validateFirmwares().
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const knownFormatVersions = [1];
const maximumBytes = 2 * 1024 * 1024;
const entryCount = { minimum: 50, maximum: 1000 };
const packageOrigins = ["hub", "githubRelease", "publisherManifest", "projectPage", "mvave"];
// Where an entry's description (what) came from, when it isn't the hub or fm1-editor.com.
const whatSources = ["gitHub"];
const sha256Pattern = /^[0-9a-f]{64}$/;

function urlWithScheme(value, schemes) {
  try {
    return schemes.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Returns a list of problems; empty means the list can be published.
export function validateFirmwares(text) {
  if (Buffer.byteLength(text) > maximumBytes) {
    return [`the file is ${Buffer.byteLength(text)} bytes, over the ${maximumBytes}-byte limit`];
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch (error) {
    return [`not valid JSON: ${error.message}`];
  }

  const problems = [];
  if (!knownFormatVersions.includes(list.formatVersion)) {
    problems.push(`formatVersion ${list.formatVersion} isn't one FM-SWITCH reads (${knownFormatVersions.join(", ")})`);
  }
  if (typeof list.builtAt !== "string" || Number.isNaN(Date.parse(list.builtAt))) {
    problems.push("builtAt isn't a date");
  }
  if (!Array.isArray(list.problems) || list.problems.length > 0) {
    problems.push("problems should be an empty list in a published file");
  }
  if (!Array.isArray(list.entries)) {
    return [...problems, "entries isn't a list"];
  }
  if (list.entries.length < entryCount.minimum || list.entries.length > entryCount.maximum) {
    problems.push(`${list.entries.length} entries, outside ${entryCount.minimum} to ${entryCount.maximum}`);
  }

  const ids = new Set();
  for (const [index, entry] of list.entries.entries()) {
    const where = `entry ${index} (${entry?.id ?? "no id"})`;
    const check = (condition, message) => {
      if (!condition) {
        problems.push(`${where}: ${message}`);
      }
    };
    check(typeof entry.id === "string" && entry.id.length > 0, "no id");
    check(!ids.has(entry.id), "its id is used twice");
    ids.add(entry.id);
    check(typeof entry.name === "string" && entry.name.length > 0, "no name");
    check(Array.isArray(entry.kinds) && entry.kinds.every((kind) => typeof kind === "string"), "kinds isn't a list of strings");
    check(typeof entry.beta === "boolean", "beta isn't true or false");
    check(typeof entry.isOfficial === "boolean", "isOfficial isn't true or false");
    check(Number.isInteger(entry.listing) && entry.listing >= 1 && entry.listing <= 7, "listing isn't 1 to 7");
    check(
      Array.isArray(entry.links) &&
        entry.links.every((link) => typeof link.label === "string" && urlWithScheme(link.url, ["https:", "http:"])),
      "a link has no label, or isn't http or https",
    );
    for (const key of ["packageURL", "releaseURL"]) {
      check(entry[key] === undefined || urlWithScheme(entry[key], ["https:"]), `${key} isn't https`);
    }
    check(entry.packageOrigin === undefined || packageOrigins.includes(entry.packageOrigin), "unknown packageOrigin");
    check(
      entry.whatSource === undefined || (whatSources.includes(entry.whatSource) && typeof entry.what === "string"),
      "whatSource is unknown, or there's no what for it to describe",
    );
    check(entry.sha256 === undefined || sha256Pattern.test(entry.sha256), "sha256 isn't 64 lowercase hex characters");
    for (const key of ["size", "stars"]) {
      check(entry[key] === undefined || (Number.isInteger(entry[key]) && entry[key] >= 0), `${key} isn't a whole number`);
    }
    check(
      entry.builds === undefined ||
        (Array.isArray(entry.builds) &&
          entry.builds.every(
            (build) =>
              typeof build.name === "string" &&
              urlWithScheme(build.url, ["https:"]) &&
              (build.sha256 === undefined || sha256Pattern.test(build.sha256)),
          )),
      "a build has no name, isn't https, or has a bad sha256",
    );
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node scripts/validate-firmwares.mjs FILE");
    process.exit(1);
  }
  const problems = validateFirmwares(await readFile(path, "utf8"));
  if (problems.length > 0) {
    console.error(`${path} can't be published:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`${path} is a valid firmware list.`);
}
