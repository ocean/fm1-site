/*
 * Turns the page into a project's world while it's pointed at or pressed (flair.css does the
 * rest, keyed on .is-active; keyboard focus works without this script).
 *
 * A mouse previews by pointing. A finger can't hover, so pressing a project previews it for as
 * long as the finger stays down, and lifting it plays the theme briefly before opening the page,
 * like a transition into it. A press that turns into a scroll is cancelled by the browser, and so
 * is the preview.
 */
(() => {
  const transitionDelay = matchMedia("(prefers-reduced-motion: reduce)").matches ? 250 : 550;
  const projects = document.querySelectorAll(".project--switch, .project--estampie");

  const clearAll = () => projects.forEach((project) => project.classList.remove("is-active"));

  for (const project of projects) {
    let pressedByTouch = false;

    project.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") {
        project.classList.add("is-active");
      }
    });

    project.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "touch") {
        project.classList.remove("is-active");
      }
    });

    project.addEventListener("pointerdown", (event) => {
      pressedByTouch = event.pointerType === "touch";
      if (pressedByTouch) {
        clearAll();
        project.classList.add("is-active");
      }
    });

    // The press became a scroll, or a long press opened the link menu.
    project.addEventListener("pointercancel", () => project.classList.remove("is-active"));
    project.addEventListener("contextmenu", () => project.classList.remove("is-active"));

    project.addEventListener("click", (event) => {
      const opensElsewhere = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (!pressedByTouch || opensElsewhere) {
        return;
      }
      event.preventDefault();
      project.classList.add("is-active");
      setTimeout(() => {
        window.location.href = project.href;
      }, transitionDelay);
    });
  }

  // Coming back to the page (including from the back-forward cache) starts it plain again.
  window.addEventListener("pageshow", clearAll);
})();
