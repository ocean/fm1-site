/*
 * FM-SWITCH's page comes in two looks, like the app: Standard (fm-switch/) and Retro, the app's
 * hidden 8-bit look (fm-switch/retro/). Choosing one with the page's Standard/Retro switch is
 * remembered in the browser, and the index's FM-SWITCH hover and link follow it.
 *
 * Loaded in the head, before anything is drawn, so the index never shows the wrong look first.
 * Without JavaScript or storage, both pages still work and the index uses Standard.
 */
(() => {
  const key = "fm-switch-look";
  const root = document.documentElement;

  // The switch on FM-SWITCH's pages.
  document.addEventListener("click", (event) => {
    const choice = event.target.closest?.("[data-choose-look]");
    if (choice) {
      try {
        localStorage.setItem(key, choice.dataset.chooseLook);
      } catch {
        // Storage is blocked (some private windows): the index stays Standard.
      }
    }
  });

  const apply = () => {
    let look = "standard";
    try {
      look = localStorage.getItem(key) === "retro" ? "retro" : "standard";
    } catch {
      // As above.
    }
    root.dataset.look = look;
    for (const link of document.querySelectorAll("[data-retro-href]")) {
      link.href = look === "retro" ? link.dataset.retroHref : link.dataset.standardHref;
    }
  };

  apply();
  document.addEventListener("DOMContentLoaded", apply);

  // Coming back from FM-SWITCH's page (including from the back-forward cache) picks up a new choice.
  window.addEventListener("pageshow", apply);
})();
