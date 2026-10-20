// Points fm1kit.json at the latest FM1Kit release's llms.txt and llms-full.txt, if that release is
// newer than the one pinned and has them (releases before they were added don't).
//
// Release tags, not main: main can describe features that aren't released yet. Prints what it
// did; in GitHub Actions it also sets the outputs `changed` and `version`.
//
// Run locally with: npm run update:fm1kit (set GH_TOKEN to avoid GitHub's rate limits).
import { github, readPin, setOutputs, sha256Of, writePin } from "./pinned.mjs";

const repository = "ocean/FM1Kit";
const files = ["llms.txt", "llms-full.txt"];

async function finish(message, outputs) {
  console.log(message);
  await setOutputs(outputs);
  process.exit(0);
}

const pin = await readPin("fm1kit.json");
const release = await github(`repos/${repository}/releases/latest`);
if (!release) {
  // GitHub answers 404 for a private repository too, so this can also mean it isn't public.
  await finish(`${repository} has no releases, or isn't public: nothing to do.`, { changed: "false" });
}

const tag = release.tag_name;
if (tag === pin.tag) {
  await finish(`FM1Kit ${tag} is already pinned.`, { changed: "false", version: tag });
}

const hashes = {};
for (const file of files) {
  const response = await fetch(`https://raw.githubusercontent.com/${repository}/${tag}/${file}`);
  if (response.status === 404) {
    await finish(`FM1Kit ${tag} has no ${file}: keeping ${pin.tag ?? "the placeholder"}.`, {
      changed: "false",
      version: tag,
    });
  }
  if (!response.ok) {
    throw new Error(`Couldn't download ${file} at ${tag}: ${response.status}`);
  }
  hashes[file] = sha256Of(Buffer.from(await response.arrayBuffer()));
}

await writePin("fm1kit.json", { tag, files: hashes });
console.log(`Pinned FM1Kit ${tag}'s ${files.join(" and ")} (was ${pin.tag ?? "none"}).`);
await setOutputs({ changed: "true", version: tag });
