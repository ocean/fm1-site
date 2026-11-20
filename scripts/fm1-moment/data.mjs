// Reads the FM-1 Moment's data: releases.csv (one row per firmware, by first public release),
// fm1-editor-daily.csv (fm1-editor.com's firmware count at its last update of each day in
// October 2026) and directories.json (what each directory counts).
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The boom the page's growth chart covers, on Melbourne dates: from the first custom firmware to
// the day it's built, until the cut-off. Firmwares first seen earlier count on the first day. The
// boom's first five weeks, to boomEnd, are what the page's history and fm1-editor.com chart cover.
export const window = {
  first: "2026-09-27",
  boomEnd: "2026-10-31",
  cutOff: "2026-11-30",
  timeZone: "Australia/Melbourne",
};

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longMonths = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "2026-10-07" as "7 Oct", or "7 October" when long.
export function dayLabel(day, long = false) {
  const [, month, date] = day.split("-").map(Number);
  return `${date} ${(long ? longMonths : months)[month - 1]}`;
}

// "2026-11-18" as "18 November 2026".
export const fullDate = (day) => `${dayLabel(day, true)} ${day.slice(0, 4)}`;

// Splits CSV text into rows of fields, allowing quoted fields with commas and doubled quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (quoted) throw new Error("A quoted CSV field never ends");
  return rows;
}

// Quotes a CSV field only when it needs it.
const csvField = (value) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
export const csvLine = (fields) => fields.map(csvField).join(",");

// Rows as CSV text under their header, with the line ending the file already uses.
export const writeTable = (header, rows, lineEnding) =>
  [header, ...rows.map((row) => header.map((name) => row[name]))].map(csvLine).join(lineEnding) + lineEnding;

// The CSV's rows as objects keyed by its header.
export function readTable(text) {
  const [header, ...rows] = parseCsv(text);
  return rows.map((fields) => {
    if (fields.length !== header.length) {
      throw new Error(`A row has ${fields.length} fields, not ${header.length}: ${fields.join(",")}`);
    }
    return Object.fromEntries(header.map((name, index) => [name, fields[index]]));
  });
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: window.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// releases.csv's "2026-10-07T04:24Z" as its Melbourne date, "2026-10-07".
export function melbourneDay(firstSeen) {
  const time = Date.parse(firstSeen.replace(/Z$/, ":00Z"));
  if (Number.isNaN(time)) throw new Error(`Not a time: ${firstSeen}`);
  return dayFormat.format(new Date(time));
}

// Every day from first to last, as "YYYY-MM-DD".
export function daysBetween(first, last) {
  const days = [];
  for (let time = Date.parse(`${first}T00:00:00Z`); time <= Date.parse(`${last}T00:00:00Z`); time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

// Today in Melbourne, as "YYYY-MM-DD".
export const melbourneToday = (now = new Date()) => dayFormat.format(now);

// The growth chart's last day: today, but no later than the cut-off or earlier than boomEnd.
export function chartEnd(today) {
  if (today > window.cutOff) return window.cutOff;
  return today < window.boomEnd ? window.boomEnd : today;
}

// New firmwares and the running total for each day from the window's first day to last.
// Firmwares first seen after last aren't counted.
export function dailySeries(releases, last = window.boomEnd) {
  const counts = new Map();
  for (const release of releases) {
    const day = melbourneDay(release.first_seen_utc);
    const counted = day < window.first ? window.first : day;
    counts.set(counted, (counts.get(counted) ?? 0) + 1);
  }
  let total = 0;
  return daysBetween(window.first, last).map((day) => {
    const added = counts.get(day) ?? 0;
    total += added;
    return { day, added, total };
  });
}

// The page's three data files, from its folder.
export async function readMomentData(folder) {
  const [releases, daily, directories] = await Promise.all(
    ["releases.csv", "fm1-editor-daily.csv", "directories.json"].map((file) => readFile(join(folder, file), "utf8")),
  );
  return {
    releases: readTable(releases),
    listed: readTable(daily).map((row) => ({ day: row.day, count: Number(row.listed) })),
    directories: JSON.parse(directories),
  };
}
