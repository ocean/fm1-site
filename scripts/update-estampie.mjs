// Points estampie.json at the latest ESTAMPIE release's site, if it's newer than the one pinned.
//
// Looks up the latest release of ocean/estampie (drafts and pre-releases aren't "latest"), finds
// its estampie-site-X.Y.zip asset, downloads it and hashes it, and checks that hash against the
// release's estampie-site-X.Y.zip.sha256 asset when there is one. Prints what it did; in GitHub
// Actions it also sets the outputs `changed` and `version`.
//
// Run locally with: npm run update:estampie (set GH_TOKEN to avoid GitHub's rate limits).
import { download, github, readPin, setOutputs, sha256Of, writePin } from "./pinned.mjs";

const repository = "ocean/estampie";

async function finish(message, outputs) {
  console.log(message);
  await setOutputs(outputs);
  process.exit(0);
}

const pin = await readPin("estampie.json");
const release = await github(`repos/${repository}/releases/latest`);
if (!release) {
  // GitHub answers 404 for a private repository too, so this can also mean it isn't public.
  await finish(`${repository} has no releases, or isn't public: nothing to do.`, { changed: "false" });
}

const siteAsset = release.assets.find((asset) => /^estampie-site-.+\.zip$/.test(asset.name));
if (!siteAsset) {
  await finish(`${repository} ${release.tag_name} has no estampie-site-*.zip asset: nothing to do.`, {
    changed: "false",
  });
}

const version = siteAsset.name.replace(/^estampie-site-/, "").replace(/\.zip$/, "");
if (version === pin.version) {
  await finish(`ESTAMPIE ${version} is already pinned.`, { changed: "false", version });
}

const sha256 = sha256Of(await download(siteAsset.browser_download_url));
const hashAsset = release.assets.find((asset) => asset.name === `${siteAsset.name}.sha256`);
if (hashAsset) {
  const published = (await download(hashAsset.browser_download_url)).toString("utf8").trim().split(/\s+/)[0];
  if (published !== sha256) {
    throw new Error(`${siteAsset.name} hashes to ${sha256}, but the release says ${published}`);
  }
}

await writePin("estampie.json", { version, url: siteAsset.browser_download_url, sha256 });
console.log(`Pinned ESTAMPIE ${version} (was ${pin.version ?? "none"}): ${sha256}`);
await setOutputs({ changed: "true", version });
