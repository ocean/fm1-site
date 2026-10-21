// Checks the live site after a deploy: what GitHub Pages serves can't be seen by the local checks.
// Pages sets its own headers, so this checks the ones that matter to someone: the content types
// browsers need, CORS for the files other sites and the FM-SWITCH app fetch, and the 404 page. Run
// from CI after dist/ is built and deployed. Each check names a file that exists in dist/, so it
// only asks for real files.
//
// Retries for a little while, because a new deploy can take a few seconds to reach every edge.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./pinned.mjs";

// The deploy's address, with a trailing slash so paths resolve under it (Pages serves a site
// without a custom domain at ocean.github.io/fm1-site/).
const site = new URL((process.env.SITE_URL || "https://fm-1.drewr.dev/").replace(/\/?$/, "/"));
const dist = join(root, "dist");
const files = (await readdir(dist, { recursive: true })).map((path) => `/${path}`);
const first = (pattern) => files.find((path) => pattern.test(path));

// [path, request headers, expected status, { header: expected value or pattern }]
const checks = [
  ["/", {}, 200, { "content-type": /^text\/html/ }],
  ["/fm1kit/", {}, 200, { "content-type": /^text\/html/ }],
  ["/llms-full.txt", {}, 200, { "content-type": /^text\/plain/ }],
  ["/no-such-page", {}, 404, { "content-type": /^text\/html/ }],
];
if (files.includes("/firmwares.json")) {
  checks.push([
    "/firmwares.json",
    { Origin: "https://example.com" },
    200,
    { "content-type": /^application\/json/, "access-control-allow-origin": "*" },
  ]);
}
const words = first(/^\/estampie\/words\/[^/]+\.json$/);
if (words) {
  checks.push([words, { Origin: "https://charlesvestal.github.io" }, 200, { "access-control-allow-origin": "*" }]);
}
const wasm = first(/^\/estampie\/.+\.wasm$/);
if (wasm) {
  checks.push([wasm, {}, 200, { "content-type": "application/wasm" }]);
}

async function problemsFor([path, requestHeaders, status, expected]) {
  const response = await fetch(new URL(path.slice(1), site), { headers: requestHeaders, redirect: "manual" });
  const problems = [];
  // A proxied DNS record puts Cloudflare (and its bot protection) in front of the site again.
  const mitigated = response.headers.get("cf-mitigated");
  if (mitigated) {
    return [`${path}: Cloudflare answered (cf-mitigated: ${mitigated}): is fm-1's DNS record still proxied?`];
  }
  if (response.status !== status) {
    problems.push(`${path}: status ${response.status}, expected ${status}`);
  }
  if (status === 404 && !(await response.text()).includes("<h1>404</h1>")) {
    problems.push(`${path}: isn't the site's own 404 page`);
  }
  for (const [name, value] of Object.entries(expected)) {
    const actual = response.headers.get(name);
    const matches = value instanceof RegExp ? value.test(actual ?? "") : actual === value;
    if (!matches) {
      problems.push(`${path}: ${name} is ${actual ?? "missing"}, expected ${value}`);
    }
  }
  return problems;
}

console.log(`Checking ${site}`);
let problems = [];
for (let attempt = 1; attempt <= 6; attempt++) {
  problems = (await Promise.all(checks.map(problemsFor))).flat();
  if (problems.length === 0) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

for (const [path] of checks) {
  console.log(`${problems.some((problem) => problem.startsWith(`${path}:`)) ? "FAIL" : "ok  "} ${path}`);
}
if (problems.length > 0) {
  console.error(`\nThe live site isn't right:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exitCode = 1;
}
