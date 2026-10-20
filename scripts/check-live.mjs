// Checks the live site's response headers after a deploy, since _headers only takes effect on
// Cloudflare: the local checks can't see them. Run from the deploy job, after dist/ is built and
// deployed. Each check names a file that exists in dist/, so it only asks for real files.
//
// Retries for a little while, because a new deploy can take a few seconds to reach every edge.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./pinned.mjs";

const site = process.env.SITE_URL ?? "https://fm-1.drewr.dev";
const dist = join(root, "dist");
const files = (await readdir(dist, { recursive: true })).map((path) => `/${path}`);
const first = (pattern) => files.find((path) => pattern.test(path));

// [path, request headers, { header: expected value or pattern }]
const checks = [
  ["/", {}, { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" }],
  [
    "/assets/fonts/silkscreen-latin-400-normal.woff2",
    {},
    { "cache-control": "public, max-age=31536000, immutable" },
  ],
];
if (files.includes("/firmwares.json")) {
  checks.push([
    "/firmwares.json",
    { Origin: "https://example.com" },
    {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=3600",
    },
  ]);
}
const words = first(/^\/estampie\/words\/[^/]+\.json$/);
if (words) {
  checks.push([
    words,
    { Origin: "https://charlesvestal.github.io" },
    { "access-control-allow-origin": "*", "cache-control": "public, max-age=31536000, immutable" },
  ]);
}
const wasm = first(/^\/estampie\/.+\.wasm$/);
if (wasm) {
  checks.push([wasm, {}, { "content-type": "application/wasm" }]);
}

async function problemsFor([path, requestHeaders, expected]) {
  const response = await fetch(site + path, { headers: requestHeaders, redirect: "manual" });
  const problems = [];
  // Cloudflare's bot protection can challenge requests from data centres, such as CI runners. That
  // says nothing about the headers real visitors get, so it's reported but isn't a failure.
  const mitigated = response.headers.get("cf-mitigated");
  if (mitigated) {
    challenged.add(`${path} (cf-mitigated: ${mitigated}, status ${response.status})`);
    return problems;
  }
  if (response.status !== 200) {
    problems.push(`${path}: status ${response.status}`);
  }
  for (const [name, value] of Object.entries(expected)) {
    const actual = response.headers.get(name);
    if (actual !== value) {
      problems.push(`${path}: ${name} is ${actual ?? "missing"}, expected ${value}`);
    }
  }
  return problems;
}

const challenged = new Set();
let problems = [];
for (let attempt = 1; attempt <= 6; attempt++) {
  challenged.clear();
  problems = (await Promise.all(checks.map(problemsFor))).flat();
  if (problems.length === 0) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

for (const [path] of checks) {
  const status = [...challenged].some((entry) => entry.startsWith(`${path} `))
    ? "skip"
    : problems.some((problem) => problem.startsWith(`${path}:`))
      ? "FAIL"
      : "ok  ";
  console.log(`${status} ${path}`);
}
if (challenged.size > 0) {
  const list = [...challenged].join("; ");
  console.log(`::warning title=Cloudflare challenged the check::Couldn't see the real headers for: ${list}`);
}
if (problems.length > 0) {
  console.error(`\nThe live site's headers aren't right:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exitCode = 1;
}
