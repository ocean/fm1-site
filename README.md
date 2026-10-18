# fm-1.drewr.dev

The site for Drew's M-VAVE FM-1 projects: a plain static site with no build step.

```
index.html               the index: links to each project
llms.txt, llms-full.txt  what all this is, for language models (each project folder has its own llms-full.txt)
assets/site.css          shared styles (swap the typeface with the --font variable)
assets/flair.css         the index's hover themes: FM-SWITCH's 8-bit screen, ESTAMPIE's manuscript
assets/fonts.css         the projects' typefaces: Silkscreen, Departure Mono, VT323, IM Fell
assets/fonts/            the font files, all SIL OFL 1.1 (licences alongside)
assets/fm-switch-icon.svg  FM-SWITCH's 32 x 32 app icon, from the pixel map in FM-SWITCH's scripts/make-icon.py
fm-switch/               FM-SWITCH, the iOS and macOS app (../FM-SWITCH), in the app's 8-bit look
fm1kit/                  FM1Kit, the Swift package under it (../FM1Kit), in the manner of Apple's docs
estampie/                ESTAMPIE, the firmware (../estampie)
```

Hovering a project on the index switches the whole page into that project's look (pure CSS, with
`:has()`). Only fonts, colours and things that don't change the list's size are swapped, so the hovered
card never moves out from under the pointer.

`estampie/` holds a placeholder for now. The real pages are built in the estampie repo by
`web/make_site.py` (see its BUILDING.md, "The site") and copied here in place of the placeholder
(including `estampie/llms-full.txt`, which that build should then provide).

## Previewing

```bash
python3 -m http.server -d . 8000
```
