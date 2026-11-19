import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { root } from "../pinned.mjs";
import { chartEnd, dailySeries, melbourneDay, parseCsv, readMomentData, readTable, writeTable } from "./data.mjs";
import { fillSpans, renderMoment } from "./render.mjs";
import { countEditor, countHub, lineageFamilies, readResourceHub, repoKey } from "./sources.mjs";

const folder = join(root, "fm1-moment");

test("releases.csv reads and writes back unchanged", async () => {
  const text = await readFile(join(folder, "releases.csv"), "utf8");
  assert.equal(writeTable(parseCsv(text)[0], readTable(text), text.includes("\r\n") ? "\r\n" : "\n"), text);
});

test("days are counted in Melbourne, earlier ones on the first day", () => {
  assert.equal(melbourneDay("2026-10-16T13:30Z"), "2026-10-17");
  const series = dailySeries([{ first_seen_utc: "2026-09-03T04:24Z" }, { first_seen_utc: "2026-10-16T13:30Z" }]);
  assert.deepEqual(series[0], { day: "2026-09-27", added: 1, total: 1 });
  assert.equal(series.find((point) => point.day === "2026-10-17").added, 1);
  assert.equal(series.at(-1).total, 2);
});

test("the growth chart runs to the day it's built, until the cut-off", () => {
  assert.equal(chartEnd("2026-11-18"), "2026-11-18");
  assert.equal(chartEnd("2026-12-25"), "2026-11-30");
  assert.equal(chartEnd("2026-10-20"), "2026-10-31");
});

test("the page's data renders, and fills its spans", async () => {
  const data = await readMomentData(folder);
  const { sections, fills } = renderMoment(data, "2026-11-18");
  assert.match(sections["moment-growth-chart"], />\d+ by 18 Nov</);
  assert.match(sections["moment-growth-table"], /<td>18 Nov<\/td>/);
  assert.doesNotMatch(sections["moment-growth-table"], /19 Nov/);
  assert.equal(fills["releases-total"], String(data.releases.length));
  assert.equal(fillSpans('<span data-fill="releases-total">0</span>', fills), `<span data-fill="releases-total">${data.releases.length}</span>`);
  assert.throws(() => fillSpans('<span data-fill="unknown">0</span>', fills), /no value/);
});

test("the numbers sentence follows the data", async () => {
  const data = await readMomentData(folder);
  const october = data.releases.filter((release) => melbourneDay(release.first_seen_utc) <= "2026-10-31");
  const later = [{ first_seen_utc: "2026-11-05T00:00Z" }, { first_seen_utc: "2026-11-25T00:00Z" }];
  const { fills } = renderMoment({ ...data, releases: [...october, ...later] }, "2026-11-18");
  assert.equal(fills["since-boom"], ", and 1 more by 18 November");
  assert.equal(fills["boom-total"], String(october.length));
  assert.equal(renderMoment({ ...data, releases: october }, "2026-11-18").fills["since-boom"], "");
  const counts = data.directories.directories.map((directory) => directory.count).filter(Number.isInteger);
  const about = (count) => Math.round(count / 10) * 10;
  assert.equal(fills["count-range"], `${about(october.length + 2)} and ${about(Math.max(...counts))}`);
});

test("aroum's README is counted by section", () => {
  const markdown = [
    "#### 1.1.1. Felucca Ecosystem",
    "| # | Name | Description |",
    "|---|---|---|",
    "| 1 | **Felucca by hugelton**<br>[GitHub](https://github.com/hugelton/Felucca) \\| [Web](https://x) | Sound |",
    "### 1.2. Modular Firmware Platforms",
    "| 1 | **Hexagon Console**<br>[Project Link](https://www.reddit.com/r/x) | Teased |",
    "### 1.3. Gaming",
    "| 1 | **FM-1 Doom by Sven Trogus (zvenson)**<br>[GitHub](https://github.com/zvenson/fm1doom) | Game |",
    "### 1.4. Stock Firmware Patchers",
    "| 1 | **Patcher by czietz**<br>[GitHub](https://github.com/czietz/fm1-firmware-patcher) | Patch |",
    "## 2. Hardware",
    "| 1 | **Not a firmware**<br>[GitHub](https://github.com/a/b) | Other |",
  ].join("\n");
  const { counts, entries } = readResourceHub(markdown);
  assert.deepEqual(counts, { sound: 1, platforms: 1, games: 1, patchers: 1 });
  assert.deepEqual(entries[0], { name: "Felucca", repo: "hugelton/felucca", group: "sound", family: "Sound (Felucca family)" });
  assert.equal(entries[1].repo, null);
  assert.equal(entries[2].name, "FM-1 Doom");
  assert.equal(entries[3].family, null);
});

test("directories are counted from their data", async () => {
  assert.equal(countEditor('<div class="firmware-entry synthwave-panel"></div><article class="firmware-entry"></article><p class="firmware-entry-title">'), 2);
  assert.throws(() => countEditor("<p>gone</p>"), /no entries/);
  assert.equal(countHub(JSON.stringify({ entries: [{ listing: 1 }, { listing: 6 }, { listing: 15 }] })), 2);
  assert.equal(repoKey("https://github.com/Owner/Repo.git/tree/main"), "owner/repo");
});

test("Leo Kuroshita's lineage gives families", () => {
  const node = (id, repo, classification, lineage_path, extra = {}) => ({
    id,
    name: id,
    repo: `https://github.com/${repo}`,
    kind: "firmware",
    classification,
    lineage_path,
    root_id: lineage_path[0],
    primary_parent: lineage_path.at(-2) ?? null,
    ...extra,
  });
  const taxonomy = {
    nodes: [
      node("F:1", "hugelton/Felucca", "felucca-descendant", ["F:1"]),
      node("S:1", "isod89/sloop-fm1", "felucca-descendant", ["F:1", "S:1"]),
      node("S:2", "a/sloop-child", "felucca-descendant", ["F:1", "S:1", "S:2"]),
      node("O:1", "charlesvestal/fm1-fomni", "felucca-descendant", ["F:1", "O:1"]),
      node("Z:2", "charlesvestal/fm1-amb", "other-root-lineage", ["Z:2"], { name: "AMB-1" }),
      node("Z:3", "b/dub", "other-root-lineage", ["Z:2", "Z:3"]),
      node("M:1", "m-vave/fm1_open", "official-fm1-open", ["M:1"]),
      node("M:2", "c/plaits", "official-fm1-open", ["M:1", "M:2"]),
      node("U:1", "d/alone", "unplaced", ["U:1"]),
    ],
  };
  const families = lineageFamilies(JSON.stringify(taxonomy));
  assert.equal(families.get("a/sloop-child"), "Sound (SLOOP family)");
  assert.equal(families.get("hugelton/felucca"), "Sound (Felucca family)");
  assert.equal(families.get("b/dub"), "Sound (AMB-1 family)");
  assert.equal(families.get("c/plaits"), "Sound (M-VAVE fm1_open family)");
  assert.equal(families.has("m-vave/fm1_open"), false);
  assert.equal(families.has("d/alone"), false);
});
