// Renders the bootloader check's data into its page (bootloader-check/index.html) at build time,
// so the list works without JavaScript; bootloader-check/table.js adds search and filters.
import { applyOverrides, bases } from "./validate-bootloader-check.mjs";

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (character) => `&#${character.codePointAt(0)};`);

// A firmware that pins V15's exact image can install V15, which puts the stock bootloader back, but
// nothing else: it has no updated check.
const takesV15Only = (entry) => entry.source.basis === "pinned-v15";
const sourceLabels = { affected: "Original check", ok: "Updated check", unclear: "Unclear" };
const packageLabels = {
  affected: ["affected", "Original check"],
  ok: ["ok", "Updated check"],
  other: ["other", "Own update code: see main branch"],
  none: ["other", "No .fwsc package"],
  unclear: ["unclear", "Unclear"],
};

// What each release's firmware code says about the flash chips (see fwsc.mjs's flashChipSupport).
const chipLabels = {
  both: ["ok", "Both chips"],
  first: ["affected", "Older chip"],
  none: ["other", "No check"],
};

// What each firmware's update code is built on (see source.mjs's baseOf).
const builtOnLabels = {
  "fm1-base": "fm1-base",
  "felucca-bsp": "felucca-bsp",
  "own-copy": "Own copy of Felucca's",
  submodule: "Another firmware's",
};

const pill = (kind, label) => `<span class="pill pill--${kind}">${escapeHtml(label)}</span>`;

const longDate = (iso) =>
  new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// What the firmware's developer needs to do about the bootloader check, or null for nothing.
function bootloaderFix(entry) {
  const sizeStep = entry.source.sizeCheck ? ", then check −15 only when there's a flash.bin" : "";
  const { status, basis } = entry.source;
  if (status === "unclear") return "Test on hardware";
  if (status === "ok") {
    return entry.release?.package === "affected" ? "Release a new version: the update isn't in one yet" : null;
  }
  switch (basis) {
    case "old-base":
      if (entry.source.base === "fm1-base") return "Update fm1-base (6c0b47e or later)";
      if (entry.source.base === "felucca-bsp") return "Update felucca-bsp (afd83ede or later)";
      return "Update fm1-base (6c0b47e or later) or felucca-bsp (afd83ede or later)";
    case "submodule":
      return "Port afd83ede into the submodule's ota.c";
    case "rewrite":
      return "Apply afd83ede's check in its own update code";
    default:
      return `Port afd83ede into ota.c${sizeStep}`;
  }
}

// What the firmware's developer needs to do, for the bootloader and the newer flash chip.
function toFix(entry) {
  const steps = [bootloaderFix(entry)];
  if (entry.release?.chips === "first") steps.push("Release support for the newer flash chip (0xB36014; see Felucca f4cbb6a2)");
  return steps.filter(Boolean).join(". ") || "Nothing";
}

function chipCell(release) {
  if (release?.chips) return pill(...chipLabels[release.chips]);
  if (!release) return `<span class="muted">None</span>`;
  if (release.package === "none") return `<span class="muted">No .fwsc package</span>`;
  return `<span class="muted">${release.package === null || release.chips === undefined ? "Not checked yet" : "Not read"}</span>`;
}

function builtOnCell(entry) {
  if (["rewrite", "own-loader"].includes(entry.source.basis)) return "Own update code";
  const label = builtOnLabels[entry.source.base];
  return label ? escapeHtml(label) : `<span class="muted">Not known</span>`;
}

function releaseCell(entry) {
  const { release } = entry;
  if (!release) return `<span class="muted">None</span>`;
  let [kind, label] = packageLabels[release.package] ?? ["unchecked", "Not checked yet"];
  if (release.package === "ok" && takesV15Only(entry)) label = "Takes V15 only";
  const date = release.date ? ` <span class="date">${escapeHtml(release.date)}</span>` : "";
  return `<span class="tag">${escapeHtml(release.tag)}</span>${date}<br>${pill(kind, label)}`;
}

function row(entry) {
  const repoUrl = `https://github.com/${entry.repo}`;
  const fork = entry.forkOf ? ` &middot; fork of ${escapeHtml(entry.forkOf)}` : "";
  const corrected = entry.corrected ? `<span class="corrected">Corrected: ${escapeHtml(entry.corrected)}</span>` : "";
  const search = [entry.name, entry.repo, entry.author, entry.source.sizeCheck ? "1.6.1" : ""].join(" ").toLowerCase();
  const sourceLabel = takesV15Only(entry) ? "Takes V15 only" : sourceLabels[entry.source.status];
  const sizeNote = entry.source.sizeCheck ? `<span class="why">Based on Felucca 1.6.1: has its board-size check</span>` : "";
  // For table.js's sorting and filters: an unknown commit count is left out.
  const commits = entry.commits ?? null;
  const sorting = [
    `data-name="${escapeHtml(entry.name.toLowerCase())}"`,
    `data-stars="${entry.stars}"`,
    `data-last="${escapeHtml(entry.lastCommit ?? "")}"`,
    `data-chips="${entry.release?.chips ?? "unknown"}"`,
    `data-base="${entry.source.base ?? "unknown"}"`,
    commits === null ? "" : `data-commits="${commits}"`,
  ].filter(Boolean);
  return [
    `<tr data-status="${entry.source.status}" data-search="${escapeHtml(search)}" ${sorting.join(" ")}>`,
    `<th scope="row"><a href="${escapeHtml(repoUrl)}">${escapeHtml(entry.name)}</a><span class="repo">${escapeHtml(entry.repo)}${fork}</span>${corrected}</th>`,
    `<td>${builtOnCell(entry)}</td>`,
    `<td>${pill(entry.source.status, sourceLabel)}<span class="why">${escapeHtml(bases[entry.source.basis])}</span>${sizeNote}</td>`,
    `<td>${releaseCell(entry)}</td>`,
    `<td>${chipCell(entry.release)}</td>`,
    `<td class="fix">${escapeHtml(toFix(entry))}</td>`,
    `<td class="date">${escapeHtml(entry.lastCommit ?? "")}</td>`,
    `<td class="num">${commits === null ? "" : commits.toLocaleString("en-AU")}</td>`,
    `<td class="num">${entry.stars.toLocaleString("en-AU")}</td>`,
    `</tr>`,
  ].join("");
}

function forkRow(fork) {
  const status =
    fork.status === "affected" ? pill("affected", "Original check") : `<span class="muted">No update code</span>`;
  return [
    `<tr>`,
    `<th scope="row"><a href="https://github.com/${escapeHtml(fork.repo)}">${escapeHtml(fork.repo)}</a></th>`,
    `<td>${escapeHtml(fork.parent)}</td>`,
    `<td>${status}</td>`,
    `<td>${escapeHtml(fork.basis ?? "")}</td>`,
    `</tr>`,
  ].join("");
}

function tally(number, text, kind) {
  return `<li class="tally--${kind}"><b>${number.toLocaleString("en-AU")}</b><span>${text}</span></li>`;
}

// The page's filled-in sections, keyed by their markers' names.
export function renderBootloaderCheck(data, overrides) {
  const shown = applyOverrides(data, overrides);
  const firmwares = shown.firmwares.toSorted((one, two) => two.stars - one.stars || one.name.localeCompare(two.name));
  const count = (status) => firmwares.filter((entry) => entry.source.status === status).length;
  const checkedReleases = firmwares.filter((entry) => ["affected", "ok"].includes(entry.release?.package));
  const originalReleases = checkedReleases.filter((entry) => entry.release.package === "affected").length;
  const sizeChecked = firmwares.filter((entry) => entry.source.status === "affected" && entry.source.sizeCheck).length;
  const forksAffected = shown.forks.filter((fork) => fork.status === "affected").length;
  const chipsRead = firmwares.filter((entry) => entry.release?.chips);
  const olderChipOnly = chipsRead.filter((entry) => entry.release.chips === "first").length;
  const onFm1Base = firmwares.filter((entry) => entry.source.base === "fm1-base");
  const fm1BaseUpdated = onFm1Base.filter((entry) => entry.source.status === "ok").length;

  const tallies = [
    tally(count("affected"), `of ${firmwares.length} firmwares' main branches can trap users with a changed bootloader`, "affected"),
    tally(count("ok"), "have the updated check, or take V15, so their owners can get back to stock", "ok"),
  ];
  if (onFm1Base.length > 0) {
    tallies.push(tally(onFm1Base.length, `are built on fm1-base, ${fm1BaseUpdated} of them on a version with the updated check`, "ok"));
  }
  if (checkedReleases.length > 0) {
    tallies.push(
      tally(originalReleases, `of ${checkedReleases.length} latest releases checked have the original check`, "affected"),
    );
  }
  if (sizeChecked > 0) {
    tallies.push(
      tally(sizeChecked, `of the ${count("affected")} are based on Felucca 1.6.1, with its board-size check too`, "affected"),
    );
  }
  if (chipsRead.length > 0) {
    tallies.push(tally(olderChipOnly, `of ${chipsRead.length} latest releases read only know the older flash chip, so lose saves on newer FM-1s`, "affected"));
  }
  tallies.push(tally(forksAffected, `of ${shown.forks.length} modified forks have it too`, "affected"));
  if (count("unclear") > 0) tallies.push(tally(count("unclear"), "use a different check, untested", "unclear"));

  const checked =
    shown.method === "survey"
      ? `Surveyed on ${longDate(shown.checkedAt)}.`
      : `Checked every week; the list last changed on ${longDate(shown.checkedAt)}.`;
  return {
    "bootloader-checked": `<p class="checked">${checked}</p>`,
    "bootloader-totals": `<ul class="tally" aria-label="Totals">${tallies.join("")}</ul>`,
    "bootloader-rows": firmwares.map(row).join("\n"),
    "bootloader-forks": shown.forks.map(forkRow).join("\n"),
  };
}

// Replaces each "<!-- name: ... -->" marker line in the page with its section.
export function fillMarkers(page, sections) {
  let filled = page;
  for (const [name, html] of Object.entries(sections)) {
    const marker = new RegExp(`^( *)<!-- ${name}: [^\\n]*-->$`, "m");
    const match = filled.match(marker);
    if (!match) throw new Error(`The bootloader check's page has no ${name} marker`);
    const indented = html
      .split("\n")
      .map((line) => match[1] + line)
      .join("\n");
    filled = filled.replace(marker, () => indented);
  }
  return filled;
}
