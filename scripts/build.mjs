// Copies the site's public files into dist/, the folder Cloudflare serves. Anything not listed
// here (READMEs, configs, scripts, node_modules) stays out of the deploy.
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");

const publicPaths = [
  "index.html",
  "404.html",
  "_headers",
  "llms.txt",
  "llms-full.txt",
  "assets",
  "estampie",
  "fm-switch",
  "fm1kit",
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist);
for (const path of publicPaths) {
  await cp(join(root, path), join(dist, path), { recursive: true });
}
console.log(`Built ${publicPaths.length} paths into dist/.`);
