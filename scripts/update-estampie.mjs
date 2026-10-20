// Points estampie.json at the latest ESTAMPIE release's site, if it's newer than the one pinned.
//
// Looks up the latest release of ocean/estampie (drafts and pre-releases aren't "latest"), finds
// its estampie-site-X.Y.Z.zip asset, downloads it and hashes it, and checks that hash against the
// release's estampie-site-X.Y.Z.zip.sha256 asset when there is one.
//
// Then it verifies the zip's build attestation: GitHub's signed record that it was built on
// GitHub's own runners, by the FM-1 Firmware Hub's shared build workflow, from ESTAMPIE's source at
// that release's tag. A zip without one, or built from anything else, isn't pinned. (Releases from
// 0.3.1 on are built and signed by GitHub; earlier ones were built by hand and can't be pinned
// again.) Needs the GitHub CLI, gh.
//
// Prints what it did; in GitHub Actions it also sets the outputs `changed` and `version`.
//
// Run locally with: npm run update:estampie (set GH_TOKEN to avoid GitHub's rate limits).
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { download, github, readPin, setOutputs, sha256Of, writePin } from "./pinned.mjs";

const run = promisify(execFile);
const repository = "ocean/estampie";
const signerWorkflow = "zvenson/fm1-build/.github/workflows/build.yml";

// The attestation's certificate, if the zip verifies as built from this repository at this tag.
async function verifyAttestation(zip, name, tag) {
  const folder = await mkdtemp(join(tmpdir(), "estampie-"));
  try {
    const path = join(folder, name);
    await writeFile(path, zip);
    const { stdout } = await run("gh", [
      "attestation",
      "verify",
      path,
      "--repo",
      repository,
      "--signer-workflow",
      signerWorkflow,
      "--source-ref",
      `refs/tags/${tag}`,
      "--format",
      "json",
    ]);
    return JSON.parse(stdout)[0].verificationResult.signature.certificate;
  } catch (error) {
    throw new Error(
      `${name} has no build attestation from ${signerWorkflow} for ${repository} at ${tag}, so it won't be pinned.\n${error.stderr ?? error.message}`,
      { cause: error },
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

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

const zip = await download(siteAsset.browser_download_url);
const sha256 = sha256Of(zip);
const hashAsset = release.assets.find((asset) => asset.name === `${siteAsset.name}.sha256`);
if (hashAsset) {
  const published = (await download(hashAsset.browser_download_url)).toString("utf8").trim().split(/\s+/)[0];
  if (published !== sha256) {
    throw new Error(`${siteAsset.name} hashes to ${sha256}, but the release says ${published}`);
  }
}

const certificate = await verifyAttestation(zip, siteAsset.name, release.tag_name);
console.log(
  `Verified ${siteAsset.name}: built from ${certificate.sourceRepositoryURI} at ${certificate.sourceRepositoryRef} ` +
    `(${certificate.sourceRepositoryDigest}) by ${certificate.buildSignerURI}, ${certificate.runnerEnvironment}.`,
);

await writePin("estampie.json", {
  version,
  url: siteAsset.browser_download_url,
  sha256,
  sourceCommit: certificate.sourceRepositoryDigest,
});
console.log(`Pinned ESTAMPIE ${version} (was ${pin.version ?? "none"}): ${sha256}`);
await setOutputs({ changed: "true", version });
