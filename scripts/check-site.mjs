// Checks the built site (dist/) in a real browser before it's deployed:
//
// - accessibility, with axe (WCAG 2.2 A and AA, and best practice), on every page and in every
//   state: the index plain and in each project's theme, at desktop and phone sizes, and FM1Kit's
//   page in light and dark;
// - text contrast where axe can't measure it, over the themes' textured backdrops, against the
//   colours those backdrops are painted in;
// - that every file a page loads and every link inside the site (including llms.txt's) exists;
// - that pages log no errors.
//
// Screenshots of every state go to .artifacts/check/ (CI keeps them as a build artefact).
import { createServer } from "node:http";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { validateFirmwares } from "./validate-firmwares.mjs";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const shots = join(root, ".artifacts", "check");
const siteOrigin = "https://fm-1.drewr.dev";

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

// What to check. `activate` marks a project as pointed at, as flair.js does. `look` is the FM-SWITCH
// look the browser remembers (look.js), which the index's FM-SWITCH hover follows. `backdrops` are the
// colours painted behind the text in that state, for contrast checks axe can't make itself; without
// them, the page's own background colour is used.
const states = [
  { name: "index", path: "/", viewport: desktop, backdrops: ["#1a110b", "#2a1b11"] },
  { name: "index-phone", path: "/", viewport: phone, backdrops: ["#1a110b", "#2a1b11"] },
  {
    name: "index-fm-switch",
    path: "/",
    viewport: desktop,
    activate: ".project--switch",
    backdrops: ["#eee8dd", "#fff"],
  },
  {
    name: "index-fm-switch-dark",
    path: "/",
    viewport: desktop,
    colorScheme: "dark",
    activate: ".project--switch",
    backdrops: ["#141413", "#232321"],
  },
  {
    name: "index-fm-switch-phone",
    path: "/",
    viewport: phone,
    activate: ".project--switch",
    backdrops: ["#eee8dd", "#fff"],
  },
  {
    name: "index-fm-switch-retro",
    path: "/",
    viewport: desktop,
    look: "retro",
    activate: ".project--switch",
    backdrops: ["#0d100e", "#161b18"],
  },
  {
    name: "index-fm-switch-retro-phone",
    path: "/",
    viewport: phone,
    look: "retro",
    activate: ".project--switch",
    backdrops: ["#0d100e", "#161b18"],
  },
  {
    name: "index-estampie",
    path: "/",
    viewport: desktop,
    activate: ".project--estampie",
    backdrops: ["#eee2c4", "#dfcca0"],
  },
  {
    name: "index-estampie-phone",
    path: "/",
    viewport: phone,
    activate: ".project--estampie",
    backdrops: ["#eee2c4", "#dfcca0"],
  },
  {
    name: "index-fm1kit",
    path: "/",
    viewport: desktop,
    activate: ".project--fm1kit",
    backdrops: ["#fff", "#f5f5f7"],
  },
  {
    name: "index-fm1kit-dark",
    path: "/",
    viewport: desktop,
    colorScheme: "dark",
    activate: ".project--fm1kit",
    backdrops: ["#000", "#1c1c1e"],
  },
  {
    name: "index-fm1kit-phone",
    path: "/",
    viewport: phone,
    activate: ".project--fm1kit",
    backdrops: ["#fff", "#f5f5f7"],
  },
  { name: "fm-switch", path: "/fm-switch/", viewport: desktop, backdrops: ["#eee8dd", "#fff"] },
  { name: "fm-switch-dark", path: "/fm-switch/", viewport: desktop, colorScheme: "dark", backdrops: ["#141413", "#232321"] },
  { name: "fm-switch-phone", path: "/fm-switch/", viewport: phone, backdrops: ["#eee8dd", "#fff"] },
  { name: "fm-switch-retro", path: "/fm-switch/retro/", viewport: desktop, backdrops: ["#0d100e", "#161b18"] },
  { name: "fm-switch-retro-phone", path: "/fm-switch/retro/", viewport: phone, backdrops: ["#0d100e", "#161b18"] },
  { name: "fm1kit-light", path: "/fm1kit/", viewport: desktop, colorScheme: "light", backdrops: ["#fff"] },
  { name: "fm1kit-dark", path: "/fm1kit/", viewport: desktop, colorScheme: "dark", backdrops: ["#000"] },
  { name: "fm1kit-phone", path: "/fm1kit/", viewport: phone, colorScheme: "light", backdrops: ["#fff"] },
  { name: "estampie", path: "/estampie/", viewport: desktop },
  { name: "estampie-phone", path: "/estampie/", viewport: phone },
  { name: "bootloader-check", path: "/bootloader-check/", viewport: desktop, colorScheme: "light", backdrops: ["#fff", "#f6f7f8"] },
  {
    name: "bootloader-check-dark",
    path: "/bootloader-check/",
    viewport: desktop,
    colorScheme: "dark",
    backdrops: ["#17191c", "#1f2226"],
  },
  {
    name: "bootloader-check-phone",
    path: "/bootloader-check/",
    viewport: phone,
    colorScheme: "light",
    backdrops: ["#fff", "#f6f7f8"],
  },
  { name: "privacy", path: "/privacy/", viewport: phone, backdrops: ["#1a110b", "#2a1b11"] },
  { name: "not-found", path: "/404.html", viewport: phone, backdrops: ["#1a110b", "#2a1b11"] },
];

// ESTAMPIE's own site, when estampie.json pins a release: its other pages too.
const estampiePin = JSON.parse(await readFile(join(root, "estampie.json"), "utf8"));
if (estampiePin.version) {
  states.push(
    { name: "estampie-guide", path: "/estampie/guide/", viewport: desktop },
    { name: "estampie-installer", path: "/estampie/webapp/installer/", viewport: desktop },
    { name: "estampie-editor", path: "/estampie/webapp/editor/", viewport: desktop },
    { name: "estampie-emulator", path: "/estampie/webapp/emu/", viewport: desktop },
    { name: "estampie-sound-lab", path: "/estampie/webapp/emu/lab.html", viewport: desktop },
    { name: "estampie-sound-lab-phone", path: "/estampie/webapp/emu/lab.html", viewport: phone },
    { name: "estampie-emulator-tools", path: "/estampie/webapp/emu/tools.html", viewport: desktop },
  );
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

// A minimal static server for dist/, resolving folders to their index.html as GitHub Pages does.
function serve() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    let path = normalize(join(dist, decodeURIComponent(url.pathname)));
    if (!path.startsWith(dist)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(path)).isDirectory()) {
        path = join(path, "index.html");
      }
      const body = await readFile(path);
      response.writeHead(200, { "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Runs in the page: the contrast of each element's text against each backdrop colour.
function measureContrast({ selectors, backdrops }) {
  const parse = (colour) => {
    const probe = document.createElement("canvas").getContext("2d");
    probe.fillStyle = colour;
    probe.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = probe.getImageData(0, 0, 1, 1).data;
    return { red, green, blue, alpha: alpha / 255 };
  };
  const over = (top, bottom) => ({
    red: top.red * top.alpha + bottom.red * (1 - top.alpha),
    green: top.green * top.alpha + bottom.green * (1 - top.alpha),
    blue: top.blue * top.alpha + bottom.blue * (1 - top.alpha),
  });
  const luminance = ({ red, green, blue }) => {
    const channel = (value) => {
      const scaled = value / 255;
      return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
  };
  const ratio = (first, second) => {
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  };

  return selectors.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) {
      return { selector, missing: true };
    }
    // Text hidden from assistive technology is decoration, which WCAG exempts from contrast.
    if (element.closest('[aria-hidden="true"]')) {
      return { selector, decorative: true };
    }
    const style = getComputedStyle(element);
    const size = parseFloat(style.fontSize);
    const bold = parseInt(style.fontWeight, 10) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const text = parse(style.color);
    // The nearest element between the text and the page with a background of its own, such as a tag.
    let painted = null;
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const background = parse(getComputedStyle(node).backgroundColor);
      if (background.alpha > 0) {
        painted = background;
        break;
      }
    }
    const worst = Math.min(
      ...backdrops.map((backdrop) => {
        const behind = painted ? over(painted, parse(backdrop)) : parse(backdrop);
        return ratio(over(text, behind), behind);
      }),
    );
    return { selector, ratio: worst, required: large ? 3 : 4.5, colour: style.color };
  });
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Again until none are left: a transition can start another as it runs (a link's colour
    // transition restarts on each frame of the inherited colour's, and so ends after it).
    for (let round = 0; round < 20; round++) {
      const finite = document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
      if (finite.length === 0) {
        break;
      }
      await Promise.all(finite.map((animation) => animation.finished.catch(() => {})));
    }
  });
}

async function checkPreviewCard(page, base, path, linksFound) {
  const tags = await page.$$eval('meta[property^="og:"], meta[name^="twitter:"]', (metas) =>
    Object.fromEntries(metas.map((meta) => [meta.getAttribute("property") ?? meta.name, meta.content])),
  );
  if (Object.keys(tags).length === 0) {
    return [];
  }
  const problems = [];
  const live = (url) => (url?.startsWith(`${siteOrigin}/`) ? url.slice(siteOrigin.length) : null);

  const ownUrl = live(tags["og:url"]);
  if (!tags["og:url"]) {
    problems.push("preview card: no og:url");
  } else if (ownUrl !== path) {
    problems.push(`preview card: og:url is ${tags["og:url"]}, but this page is ${siteOrigin}${path}`);
  }
  for (const required of ["og:title", "og:description", "og:image"]) {
    if (!tags[required]) {
      problems.push(`preview card: no ${required}`);
    }
  }

  for (const key of ["og:image", "twitter:image"]) {
    const imagePath = live(tags[key]);
    if (tags[key] && !imagePath) {
      problems.push(`preview card: ${key} ${tags[key]} isn't on ${siteOrigin}`);
    }
    if (imagePath) {
      linksFound.set(imagePath, path);
    }
  }

  const imagePath = live(tags["og:image"]);
  if (imagePath && tags["og:image:width"] && tags["og:image:height"]) {
    const size = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode().catch(() => {});
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, base + imagePath);
    const stated = `${tags["og:image:width"]} x ${tags["og:image:height"]}`;
    if (`${size.width} x ${size.height}` !== stated) {
      problems.push(`preview card: ${imagePath} is ${size.width} x ${size.height}, but the tags say ${stated}`);
    }
  }
  return problems;
}

async function checkState(browser, base, state, linksFound) {
  const problems = [];
  const context = await browser.newContext({
    viewport: state.viewport,
    colorScheme: state.colorScheme ?? "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  if (state.look) {
    await page.addInitScript((look) => localStorage.setItem("fm-switch-look", look), state.look);
  }

  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.push(`${response.status()} loading ${response.url().replace(base, "")}`);
    }
  });
  page.on("requestfailed", (request) => problems.push(`failed to load ${request.url().replace(base, "")}`));

  // Waiting for the network to go quiet also follows any redirect, such as a meta refresh.
  await page.goto(base + state.path, { waitUntil: "networkidle" });
  const landedOn = new URL(page.url()).pathname;
  if (landedOn !== state.path) {
    console.log(`     ${state.path} redirects to ${landedOn}`);
  }
  if (state.activate) {
    await page.locator(state.activate).evaluate((link) => link.classList.add("is-active"));
  }
  await settle(page);

  // Nothing may make the page scroll sideways (WCAG reflow, and it shows as a gap on phones).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) {
    problems.push(`the page scrolls sideways by ${overflow}px`);
  }

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    // The themes' decorative backdrops are hidden from assistive technology on purpose.
    .exclude(".backdrop")
    .analyze();

  for (const violation of results.violations) {
    for (const node of violation.nodes) {
      problems.push(`${violation.id}: ${violation.help} (${node.target.join(" ")})`);
    }
  }

  // Contrast axe couldn't decide, usually because the text sits over a gradient or texture.
  const undecided = results.incomplete
    .filter((result) => result.id === "color-contrast")
    .flatMap((result) => result.nodes.map((node) => node.target.join(" ")));
  if (undecided.length > 0) {
    const backdrops =
      state.backdrops ??
      (await page.evaluate(() =>
        [document.body, document.documentElement]
          .map((element) => getComputedStyle(element).backgroundColor)
          .filter((colour) => colour !== "rgba(0, 0, 0, 0)")
          .slice(0, 1),
      ));
    const measured = await page.evaluate(measureContrast, { selectors: undecided, backdrops });
    for (const result of measured) {
      if (result.decorative) {
        continue;
      } else if (result.missing) {
        problems.push(`contrast: couldn't find ${result.selector}`);
      } else if (result.ratio < result.required) {
        problems.push(
          `contrast: ${result.selector} is ${result.ratio.toFixed(2)}:1 (${result.colour}), needs ${result.required}:1`,
        );
      }
    }
  }

  // Remember links inside the site, to check they all exist.
  const links = await page.$$eval("a[href]", (anchors) => anchors.map((anchor) => anchor.href));
  for (const link of links) {
    if (link.startsWith(base)) {
      linksFound.set(link.replace(base, ""), state.path);
    }
  }

  // Link previews (Open Graph and Twitter cards) use the live site's addresses: og:url must be this
  // page's own address, and the card image must exist here at the size the tags give.
  problems.push(...(await checkPreviewCard(page, base, landedOn, linksFound)));

  await page.screenshot({ path: join(shots, `${state.name}.png`), fullPage: true });
  await context.close();

  const contrastChecked = undecided.length > 0 ? `, ${undecided.length} contrast checks by hand` : "";
  console.log(`${problems.length === 0 ? "ok  " : "FAIL"} ${state.name}${contrastChecked}`);
  return problems.map((problem) => `${state.name}: ${problem}`);
}

// Links in the llms.txt and llms-full.txt files (the site's own and the projects'): absolute ones to
// the live site, and Markdown links relative to the file, which resolve as a browser would. Check the
// files they name exist here.
async function llmsLinks() {
  const found = new Map();
  const entries = await readdir(dist, { recursive: true });
  for (const file of entries.filter((entry) => /(^|\/)llms(-full)?\.txt$/.test(entry))) {
    const text = await readFile(join(dist, file), "utf8");
    for (const [url] of text.matchAll(/https:\/\/fm-1\.drewr\.dev\/[^\s)>"`]*/g)) {
      found.set(url.slice(siteOrigin.length), `/${file}`);
    }
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (!/^([a-z]+:|#|\/\/)/i.test(target)) {
        found.set(new URL(target, `${siteOrigin}/${file}`).pathname, `/${file}`);
      }
    }
  }
  return found;
}

await mkdir(shots, { recursive: true });
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const problems = [];
const linksFound = await llmsLinks();

try {
  for (const state of states) {
    problems.push(...(await checkState(browser, base, state, linksFound)));
  }
  for (const [path, from] of linksFound) {
    const response = await fetch(base + path.split("#")[0]);
    if (!response.ok) {
      problems.push(`broken link on ${from}: ${path} (${response.status})`);
    }
  }
  console.log(`Checked ${linksFound.size} links inside the site.`);

  // FM-SWITCH's firmware list, when there is one: the format the app reads, served as JSON.
  const firmwaresResponse = await fetch(`${base}/firmwares.json`);
  if (firmwaresResponse.ok) {
    const firmwareProblems = validateFirmwares(await firmwaresResponse.text());
    problems.push(...firmwareProblems.map((problem) => `firmwares.json: ${problem}`));
    console.log(`${firmwareProblems.length === 0 ? "ok  " : "FAIL"} firmwares.json`);
  }
} finally {
  await browser.close();
  server.close();
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed. Screenshots are in .artifacts/check/.");
}
