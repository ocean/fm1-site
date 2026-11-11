// Builds the site, serves dist/ at http://localhost:8788 (or $PORT), and rebuilds whenever a file
// in the repository changes. Pages open in a browser reload themselves after each rebuild.
// The reload script is added to HTML as it is served, so it never reaches dist/ or the deploy.
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { root } from "./pinned.mjs";

const dist = join(root, "dist");
const port = Number(process.env.PORT) || 8788;

// Changes under these folders don't affect the build, and dist/ is the build's own output.
const ignoredFolders = ["dist", "node_modules", ".git", ".artifacts"];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const reloadScript =
  '<script>new EventSource("/__reload").addEventListener("reload", () => location.reload());</script>';

// The browsers waiting to hear about the next rebuild.
const listeners = new Set();

function runBuild() {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Build failed:\n${stderr || stdout || error.message}`);
        resolve(false);
        return;
      }
      console.log(`Built in ${Date.now() - started} ms.`);
      resolve(true);
    });
  });
}

// One build at a time. A change during a build queues one more build after it.
let building = false;
let queued = false;

async function rebuild() {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  do {
    queued = false;
    if (await runBuild()) {
      for (const response of listeners) {
        response.write("event: reload\ndata: \n\n");
      }
    }
  } while (queued);
  building = false;
}

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const path = normalize(join(dist, decoded));
  if (path !== dist && !path.startsWith(dist + sep)) {
    return null;
  }
  const info = await stat(path).catch(() => null);
  if (info?.isDirectory()) {
    return join(path, "index.html");
  }
  return info ? path : null;
}

async function serve(request, response) {
  if (request.url === "/__reload") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    response.write(": connected\n\n");
    listeners.add(response);
    request.on("close", () => listeners.delete(response));
    return;
  }

  // A folder's URL without its trailing slash redirects, so relative links on its page resolve.
  const path = await resolveFile(request.url);
  if (path && path.endsWith(`${sep}index.html`) && !request.url.split("?")[0].endsWith("/")) {
    response.writeHead(301, { Location: `${request.url.split("?")[0]}/` });
    response.end();
    return;
  }

  let body = path ? await readFile(path).catch(() => null) : null;
  let status = 200;
  let type = path ? contentTypes[extname(path).toLowerCase()] : undefined;
  if (!body) {
    body = await readFile(join(dist, "404.html")).catch(() => Buffer.from("Not found"));
    status = 404;
    type = contentTypes[".html"];
  }
  if (type === contentTypes[".html"]) {
    body = body.toString("utf8").replace("</body>", `${reloadScript}\n</body>`);
  }
  response.writeHead(status, {
    "Content-Type": type ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

await runBuild();

let timer;
watch(root, { recursive: true }, (_event, filename) => {
  if (!filename || ignoredFolders.some((folder) => filename === folder || filename.startsWith(folder + sep))) {
    return;
  }
  // Editors often write a file in several steps, so wait for the changes to settle.
  clearTimeout(timer);
  timer = setTimeout(rebuild, 150);
});

createServer((request, response) => {
  serve(request, response).catch((error) => {
    console.error(error);
    response.writeHead(500);
    response.end();
  });
}).listen(port, () => {
  console.log(`Serving the site at http://localhost:${port}/ and rebuilding on changes. Ctrl+C stops it.`);
});
