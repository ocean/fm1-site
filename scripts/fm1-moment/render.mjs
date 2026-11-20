// Renders the FM-1 Moment's charts and tables from its data at build time, so a refreshed
// releases.csv or directories.json redraws them, along with the figures in the prose around them.
import { chartEnd, dailySeries, dayLabel, daysBetween, fullDate, window } from "./data.mjs";

// Text needs only &, < and > escaped; attribute values need quotes escaped too.
const escapeText = (text) => String(text).replace(/[&<>]/g, (character) => `&#${character.codePointAt(0)};`);
const escapeAttribute = (text) => String(text).replace(/[&<>"']/g, (character) => `&#${character.codePointAt(0)};`);
const fixed = (number) => number.toFixed(1);

// The week the page calls the peak of the wave, shaded on the chart.
const peak = { first: "2026-10-13", last: "2026-10-20" };

// Events marked on the growth chart; each label sits 6 above the top of its line.
const events = [
  { day: "2026-09-27", label: "First custom firmware (Baud Girl) · 27 Sep", top: 24, anchor: "start" },
  { day: "2026-10-03", label: "Felucca, first open source · 3 Oct", top: 40, anchor: "start" },
  { day: "2026-10-16", label: "M-VAVE's FM1 Open · 16 Oct", top: 56, anchor: "end" },
  { day: "2026-10-21", label: "Stock V16 · 21 Oct", top: 40, anchor: "start" },
];

// The axis top: the next multiple of 50 above the largest value.
const axisTop = (largest) => (Math.floor(largest / 50) + 1) * 50;

// "17 and 19 October", or "30 September and 2 October" across months.
function joinDays(days) {
  const sameMonth = days.every((day) => day.slice(0, 7) === days[0].slice(0, 7));
  const labels = sameMonth
    ? [...days.slice(0, -1).map((day) => String(Number(day.slice(8)))), dayLabel(days.at(-1), true)]
    : days.map((day) => dayLabel(day, true));
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function growthChart(series) {
  const last = series.at(-1);
  const top = axisTop(last.total);
  const x = (index) => 48 + (index * 652) / (series.length - 1);
  const y = (value) => 250 - (value * 200) / top;
  const indexOf = (day) => series.findIndex((point) => point.day === day);
  const most = Math.max(...series.map((point) => point.added));
  const barHeight = (value) => (value * 70) / most;
  // Bars 10 wide, narrower once the days are too close for that.
  const barWidth = Math.min(10, (0.7 * 652) / (series.length - 1));
  const busiest = series.filter((point) => point.added === most).map((point) => point.day);
  const peakAdded = series
    .filter((point) => point.day >= peak.first && point.day <= peak.last)
    .reduce((sum, point) => sum + point.added, 0);
  const shift = (inner) => `<g transform="translate(0 24)">${inner}</g>`;
  const lines = [
    `<svg class="chart" viewBox="0 0 720 424" role="img" aria-labelledby="growth-title growth-desc">`,
    `<title id="growth-title">Custom FM-1 firmwares by first public release, ${dayLabel(series[0].day, true)} to ${dayLabel(last.day, true)} 2026</title>`,
    `<desc id="growth-desc">A cumulative line rising from ${series[0].total} on ${dayLabel(series[0].day, true)} to ${last.total} on ${dayLabel(last.day, true)}, steepest between ${Number(peak.first.slice(8))} and ${dayLabel(peak.last, true)}, with new firmwares per day as bars underneath. ${busiest.length === 1 ? `The busiest day was ${joinDays(busiest)}, with ${most}.` : `The busiest days were ${joinDays(busiest)}, with ${most} each.`}</desc>`,
  ];
  for (let value = 0; value <= top; value += 50) {
    lines.push(
      shift(`<line class="grid" x1="48" x2="700" y1="${fixed(y(value))}" y2="${fixed(y(value))}"/><text class="tick" x="40" y="${fixed(y(value) + 4)}" text-anchor="end">${value}</text>`),
    );
  }
  const bandLeft = x(indexOf(peak.first)) - 8;
  const bandRight = x(indexOf(peak.last)) + 8;
  lines.push(shift(`<rect class="band" x="${fixed(bandLeft)}" y="${fixed(y(top))}" width="${fixed(bandRight - bandLeft)}" height="${fixed(y(0) - y(top))}"/>`));
  const noteX = fixed(x(indexOf(peak.last)) + 4);
  lines.push(
    shift(`<text class="note" x="${noteX}" y="226" text-anchor="end"><tspan class="strong">${peakAdded} new</tspan></text><text class="note" x="${noteX}" y="241" text-anchor="end">${Number(peak.first.slice(8))}–${dayLabel(peak.last)}</text>`),
  );
  for (const event of events) {
    const eventX = x(indexOf(event.day));
    const labelX = event.anchor === "end" ? eventX - 4 : eventX + 4;
    lines.push(
      `<line class="event" x1="${fixed(eventX)}" x2="${fixed(eventX)}" y1="${event.top}" y2="384"/><text class="label" x="${fixed(labelX)}" y="${event.top - 6}" text-anchor="${event.anchor}">${escapeText(event.label)}</text>`,
    );
  }
  const path = series.map((point, index) => `${index === 0 ? "M" : "L"}${fixed(x(index))} ${fixed(y(point.total))}`).join("");
  lines.push(shift(`<path class="line" d="${path}"/>`));
  lines.push(shift(`<text class="end-label" x="698.0" y="${fixed(y(last.total) - 12)}" text-anchor="end">${last.total} by ${dayLabel(last.day)}</text>`));
  lines.push(shift(`<text class="label" x="48" y="282">New per day</text>`));
  series.forEach((point, index) => {
    if (point.added === 0) return;
    const height = barHeight(point.added);
    lines.push(
      shift(`<rect class="bar" x="${fixed(x(index) - barWidth / 2)}" y="${fixed(360 - height)}" width="${barWidth === 10 ? "10" : fixed(barWidth)}" height="${fixed(height)}"><title>${dayLabel(point.day)}: ${point.added} new</title></rect>`),
    );
    if (point.added === most) {
      lines.push(shift(`<text class="tick" x="${fixed(x(index))}" y="${fixed(360 - 70 - 5)}" text-anchor="middle">${most}</text>`));
    }
  });
  lines.push(shift(`<line class="axis" x1="48" x2="700" y1="360" y2="360"/>`));
  for (let index = 0; index < series.length; index += 7) {
    lines.push(shift(`<text class="tick" x="${fixed(x(index))}" y="378" text-anchor="middle">${dayLabel(series[index].day)}</text>`));
  }
  lines.push(`</svg>`);
  return { svg: lines.join("\n"), peakAdded };
}

function growthTable(series) {
  return series
    .map((point) => `<tr><td>${dayLabel(point.day)}</td><td class="n">${point.added}</td><td class="n">${point.total}</td></tr>`)
    .join("\n");
}

// fm1-editor.com's daily count against the releases, over the days it was counted.
function lagChart(series, listed) {
  const lag = { day: "2026-10-20" };
  const days = daysBetween(listed[0].day, window.boomEnd);
  const released = new Map(series.map((point) => [point.day, point.total]));
  const listedOn = new Map(listed.map((point) => [point.day, point.count]));
  const lastListed = listed.at(-1);
  const lastReleased = released.get(window.boomEnd);
  const top = axisTop(Math.max(lastReleased, lastListed.count));
  const x = (day) => 48 + (days.indexOf(day) * 512) / (days.length - 1);
  const y = (value) => 300 - (value * 240) / top;
  const lagReleased = released.get(lag.day);
  const lagListed = listedOn.get(lag.day);
  if (lagReleased === undefined || lagListed === undefined) {
    throw new Error(`The FM-1 Moment's lag chart has no count for ${lag.day}`);
  }
  const lines = [
    `<svg class="chart" viewBox="0 0 720 340" role="img" aria-labelledby="lag-title lag-desc">`,
    `<title id="lag-title">Firmwares released against firmwares listed on fm1-editor.com, ${Number(days[0].slice(8))} to ${dayLabel(window.boomEnd, true)} 2026</title>`,
    `<desc id="lag-desc">Two cumulative lines. fm1-editor.com's firmware page ran about five days behind first releases through mid-October; on ${dayLabel(lag.day, true)} ${lagReleased} had been released and ${lagListed} were listed. ${lastListed.count >= lastReleased ? `The page caught up by ${dayLabel(lastListed.day, true)}, with ${lastListed.count} entries against ${lastReleased} releases counted here.` : `By ${dayLabel(lastListed.day, true)} it listed ${lastListed.count}, against ${lastReleased} releases counted here.`}</desc>`,
  ];
  for (let value = 0; value <= top; value += 50) {
    lines.push(`<line class="grid" x1="48" x2="560" y1="${fixed(y(value))}" y2="${fixed(y(value))}"/><text class="tick" x="40" y="${fixed(y(value) + 4)}" text-anchor="end">${value}</text>`);
  }
  const releasedPath = days.map((day, index) => `${index === 0 ? "M" : "L"}${fixed(x(day))} ${fixed(y(released.get(day)))}`).join("");
  const listedPath = listed.map((point, index) => `${index === 0 ? "M" : "L"}${fixed(x(point.day))} ${fixed(y(point.count))}`).join("");
  lines.push(`<path class="line line--muted" d="${releasedPath}"/>`);
  lines.push(`<path class="line" d="${listedPath}"/>`);
  for (const point of listed) {
    lines.push(`<circle class="dot" cx="${fixed(x(point.day))}" cy="${fixed(y(point.count))}" r="2.5"><title>${dayLabel(point.day)}: ${point.count} listed</title></circle>`);
  }
  lines.push(`<text class="label" x="568" y="${fixed(y(lastReleased) - 6)}">Released (first release)</text>`);
  lines.push(`<text class="end-label" x="568" y="${fixed(y(lastListed.count) + 16)}">Listed on fm1-editor.com</text>`);
  const lagX = x(lag.day);
  const eventTop = y(lagReleased) + 4;
  lines.push(`<line class="event" x1="${fixed(lagX)}" x2="${fixed(lagX)}" y1="${fixed(eventTop)}" y2="${fixed(y(lagListed) - 4)}"/>`);
  lines.push(
    `<text class="note" x="${fixed(lagX - 6)}" y="${fixed(eventTop - 41.4)}" text-anchor="end"><tspan class="strong">${lagReleased - lagListed} not yet</tspan></text><text class="note" x="${fixed(lagX - 6)}" y="${fixed(eventTop - 26.4)}" text-anchor="end">listed, ${dayLabel(lag.day)}</text>`,
  );
  lines.push(`<line class="axis" x1="48" x2="560" y1="300" y2="300"/>`);
  for (let index = 0; index < days.length; index += 7) {
    lines.push(`<text class="tick" x="${fixed(x(days[index]))}" y="318" text-anchor="middle">${dayLabel(days[index])}</text>`);
  }
  lines.push(`</svg>`);
  return lines.join("\n");
}

function directoryRows(directories, total) {
  return directories.directories
    .map((directory) => {
      if (directory.name === "This page") {
        return `<tr><td>This page</td><td>${total}</td><td>${escapeText(directory.what)}</td></tr>`;
      }
      // A count from another day than the table's says when it was taken.
      const when =
        directory.checkedOn === directories.checkedOn
          ? ""
          : ` (${directory.dateApproximate ? "c. " : ""}${dayLabel(directory.checkedOn)})`;
      return `<tr><td><a href="${escapeAttribute(directory.url)}">${escapeText(directory.name)}</a></td><td>${escapeText(directory.label + when)}</td><td>${escapeText(directory.what)}</td></tr>`;
    })
    .join("\n");
}

// "About" a count: to the nearest 10.
const about = (count) => Math.round(count / 10) * 10;

// The page's generated sections, keyed by their markers' names, and the values for its
// data-fill spans. today is the Melbourne date the page is built on ("YYYY-MM-DD").
export function renderMoment({ releases, listed, directories }, today) {
  const series = dailySeries(releases, chartEnd(today));
  const total = releases.length;
  const growth = growthChart(series);
  const boom = series.find((point) => point.day === window.boomEnd).total;
  const last = series.at(-1);
  const since = last.total - boom;
  // Who's counting: this page at the low end, the directory that lists the most at the high end.
  const counts = directories.directories.map((directory) => directory.count).filter(Number.isInteger);
  if (counts.length === 0) throw new Error("directories.json gives no directory a count");

  return {
    sections: {
      "moment-growth-chart": growth.svg,
      "moment-growth-table": growthTable(series),
      "moment-lag-chart": lagChart(series, listed),
      "moment-directories": directoryRows(directories, total),
    },
    fills: {
      "releases-total": String(total),
      "directories-date": fullDate(directories.checkedOn),
      "count-range": `${about(total)} and ${about(Math.max(...counts))}`,
      "boom-about": String(about(boom)),
      "boom-total": String(boom),
      "peak-added": String(growth.peakAdded),
      "since-boom": since > 0 ? `, and ${since} more by ${dayLabel(last.day, true)}` : "",
    },
  };
}

// Replaces the contents of each <span data-fill="name"> with its value.
export function fillSpans(page, fills) {
  return page.replace(/<span data-fill="([a-z-]+)">[^<]*<\/span>/g, (span, name) => {
    if (!(name in fills)) throw new Error(`The FM-1 Moment has no value for data-fill="${name}"`);
    return `<span data-fill="${name}">${escapeText(fills[name])}</span>`;
  });
}
