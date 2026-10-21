# fm-1.drewr.dev

The site for Drew's M-VAVE FM-1 projects: a plain static site with no build step.

```
index.html               the index: links to each project
llms.txt, llms-full.txt  what all this is, for language models (each project folder has its own llms-full.txt)
assets/site.css          shared styles (swap the typeface with the --font variable)
assets/flair.css, .js    the index's hover themes: FM-SWITCH's 8-bit screen, ESTAMPIE's manuscript
assets/fonts.css         the projects' typefaces: Silkscreen, Departure Mono, VT323, IM Fell
assets/fonts/            the font files, all SIL OFL 1.1 (licences alongside)
assets/fm-switch-icon.svg  FM-SWITCH's 32 x 32 app icon, from the pixel map in FM-SWITCH's scripts/make-icon.py
fm-switch/               FM-SWITCH, the iOS and macOS app (../FM-SWITCH), in the app's 8-bit look
fm1kit/                  FM1Kit, the Swift package under it (../FM1Kit), in the manner of Apple's docs
estampie/                ESTAMPIE, the firmware (../estampie)
```

Pointing at a project on the index switches the whole page into that project's look (CSS with
`:has()`, keyed on an `.is-active` class that `assets/flair.js` sets; keyboard focus works without it).
Only fonts, colours and things that don't change the list's size are swapped, so the hovered card never
moves out from under the pointer.

On touch screens, pressing a project previews its look for as long as the finger stays down, and a tap
plays it for about half a second before opening the page, like a transition into it. A press that turns
into a scroll cancels the preview.

## Files the projects publish here

Two projects publish their own files into this site, each pinned to a release and checked by SHA-256.
While nothing is pinned, this repository's placeholder files are used.

- **ESTAMPIE's site** (its front page, browser emulator, installer, sound editor, guide, firmware and llms
  files) is built and released from the [estampie repository](https://github.com/ocean/estampie): each
  release attaches the whole site as `estampie-site-X.Y.zip`. `estampie.json` pins one:
  `{ "version", "url", "sha256" }`. The build downloads the zip, checks it and unpacks it into
  `dist/estampie/`, and the checks then cover ESTAMPIE's guide, installer, editor and emulator too.
  Before a new release is pinned, its zip's build attestation must verify (`gh attestation verify`): built
  on GitHub's runners from `ocean/estampie` at the release's tag, by a version of the FM-1 Firmware Hub's
  shared workflow (`zvenson/fm1-build`) listed in `trustedSignerDigests` in `scripts/update-estampie.mjs`.
  That workflow lives in a repository this site doesn't control, so when it releases a new version,
  review it and add its digest there; until then, releases built with it aren't pinned.
- **FM1Kit's `llms.txt` and `llms-full.txt`** are kept by the [FM1Kit repository](https://github.com/ocean/FM1Kit)
  alongside its README and DocC. `fm1kit.json` pins a release tag and each file's SHA-256:
  `{ "tag", "files": { "llms.txt": "...", "llms-full.txt": "..." } }`. The build fetches them from that
  tag (never `main`, which can describe unreleased features) into `dist/fm1kit/`.

Downloads are cached in `.artifacts/cache/`. The "Update projects" workflow
(`.github/workflows/update-projects.yml`) looks for newer releases every day, or when run by hand, and
opens a pull request updating the pin (`npm run update:estampie` and `npm run update:fm1kit` do the same
locally). CI checks the pull request, and merging it deploys. Opening the pull request needs Settings ›
Actions › General › "Allow GitHub Actions to create and approve pull requests"; without it the workflow
pushes the branch and leaves opening the pull request to you.

## The firmware list

`firmwares.json` (served at https://fm-1.drewr.dev/firmwares.json, open to any site)
is the FM-1 firmware list FM-SWITCH downloads. FM-SWITCH's `fm1-catalogue` tool builds it from the firmware
hub, fm1-editor.com and aroum's FM1 Resource Hub. The "Update the firmware list" workflow
(`.github/workflows/update-firmwares.yml`) runs it on macOS, then a separate job running only this
repository's code checks the result (`scripts/validate-firmwares.mjs`: the format the app reads, https for
anything it downloads, real SHA-256 values, sane sizes) and commits it to `main` only when the list itself
has changed. CI then checks and deploys it. FM-SWITCH's code never gets a token that can write here.

## Working on it

Needs Node 24 (`.nvmrc`).

```bash
npm install
npx playwright install chromium   # once, for the checks
npm run lint      # ESLint, Stylelint and html-validate
npm run build     # copies the public files into dist/
npm run check     # accessibility, contrast, links and console errors, in a real browser
npm run ci        # all three, as CI runs them
npm run preview   # build, then serve dist/ at http://localhost:8788
```

`npm run check` loads every page in headless Chromium: the index plain and in each project's theme, at
desktop and phone sizes, FM1Kit's page in light and dark, and the 404 page. In each it runs axe (WCAG 2.2
A and AA, and best practice), measures text contrast itself wherever axe can't (text over the themes'
gradients and textures), and fails on any file that doesn't load, any broken link inside the site
(including those in `llms.txt` and `llms-full.txt`) and any console error. Screenshots of each state go to
`.artifacts/check/`.

## Deploying

The site is served by GitHub Pages: just the files in `dist/`, with `404.html` for unknown paths, on
the custom domain `fm-1.drewr.dev` (set in the repository's Pages settings). Its DNS record at Cloudflare
is a DNS-only (grey-cloud) CNAME to `ocean.github.io`, so Cloudflare's bot protection, which is on for
the rest of drewr.dev and can't be turned off for one host, doesn't challenge agents and scripts
fetching the site from data centres. Pages sets the headers itself: every file is cached for ten
minutes and open to any site (`Access-Control-Allow-Origin: *`), which `firmwares.json` and ESTAMPIE's
words files need.

GitHub Actions (`.github/workflows/ci.yml`) lints, builds and checks every push and pull request, and
deploys `main` once the checks pass, then checks the live site (`scripts/check-live.mjs`: content types,
CORS and the 404 page). Screenshots from the checks are kept as a build artefact. No secrets are needed.
