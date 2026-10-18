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
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const shots = join(root, ".artifacts", "check");
const siteOrigin = "https://fm-1.drewr.dev";

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

// What to check. `activate` marks a project as pointed at, as flair.js does. `backdrops` are the
// colours painted behind the text in that state, for contrast checks axe can't make itself.
const states = [
  { name: "index", path: "/", viewport: desktop, backdrops: ["#1a110b", "#2a1b11"] },
  { name: "index-phone", path: "/", viewport: phone, backdrops: ["#1a110b", "#2a1b11"] },
  {
    name: "index-fm-switch",
    path: "/",
    viewport: desktop,
    activate: ".project--switch",
    backdrops: ["#0d100e", "#161b18"],
  },
  {
    name: "index-fm-switch-phone",
    path: "/",
    viewport: phone,
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
  { name: "fm-switch", path: "/fm-switch/", viewport: desktop, backdrops: ["#0d100e", "#161b18"] },
  { name: "fm-switch-phone", path: "/fm-switch/", viewport: phone, backdrops: ["#0d100e", "#161b18"] },
  { name: "fm1kit-light", path: "/fm1kit/", viewport: desktop, colorScheme: "light", backdrops: ["#fff"] },
  { name: "fm1kit-dark", path: "/fm1kit/", viewport: desktop, colorScheme: "dark", backdrops: ["#000"] },
  { name: "fm1kit-phone", path: "/fm1kit/", viewport: phone, colorScheme: "light", backdrops: ["#fff"] },
  { name: "estampie", path: "/estampie/", viewport: desktop, backdrops: ["#1a110b", "#2a1b11"] },
  { name: "not-found", path: "/404.html", viewport: phone, backdrops: ["#1a110b", "#2a1b11"] },
];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
};

// A minimal static server for dist/, resolving folders to their index.html as Cloudflare does.
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
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => {})));
  });
}

async function checkState(browser, base, state, linksFound) {
  const problems = [];
  const context = await browser.newContext({
    viewport: state.viewport,
    colorScheme: state.colorScheme ?? "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();

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

  await page.goto(base + state.path, { waitUntil: "load" });
  if (state.activate) {
    await page.locator(state.activate).evaluate((link) => link.classList.add("is-active"));
  }
  await settle(page);

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
    const measured = await page.evaluate(measureContrast, { selectors: undecided, backdrops: state.backdrops });
    for (const result of measured) {
      if (result.missing) {
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

  await page.screenshot({ path: join(shots, `${state.name}.png`), fullPage: true });
  await context.close();

  const contrastChecked = undecided.length > 0 ? `, ${undecided.length} contrast checks by hand` : "";
  console.log(`${problems.length === 0 ? "ok  " : "FAIL"} ${state.name}${contrastChecked}`);
  return problems.map((problem) => `${state.name}: ${problem}`);
}

// Links in llms.txt and llms-full.txt point at the live site; check the files they name exist here.
async function llmsLinks() {
  const found = new Map();
  for (const file of ["llms.txt", "llms-full.txt"]) {
    const text = await readFile(join(dist, file), "utf8");
    for (const [url] of text.matchAll(/https:\/\/fm-1\.drewr\.dev\/[^\s)>"]*/g)) {
      found.set(url.slice(siteOrigin.length), `/${file}`);
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
