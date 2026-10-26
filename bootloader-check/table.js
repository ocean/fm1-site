/*
 * The bootloader check's list: search and status filters over the rows the build rendered, and the
 * agent prompt's copy button. Without JavaScript, the whole list and the prompt still show.
 */
(() => {
  const controls = document.querySelector(".controls");
  const search = document.getElementById("search");
  const count = document.getElementById("count");
  const rows = [...document.querySelectorAll("#firmwares tr")];
  const filters = [...document.querySelectorAll("[data-filter]")];
  let filter = "all";

  const update = () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const visible =
        (filter === "all" || row.dataset.status === filter) && (!query || row.dataset.search.includes(query));
      row.hidden = !visible;
      if (visible) shown += 1;
    }
    count.textContent = `Showing ${shown} of ${rows.length}`;
  };

  for (const button of filters) {
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      for (const other of filters) other.setAttribute("aria-pressed", String(other === button));
      update();
    });
  }
  search.addEventListener("input", update);
  controls.hidden = false;
  update();

  // The prompt's copy button; where the clipboard isn't allowed, it selects the prompt instead.
  const copy = document.querySelector("[data-copy]");
  const prompt = document.getElementById(copy.dataset.copy);
  copy.hidden = false;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(prompt.textContent);
      copy.textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(prompt);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      copy.textContent = "Selected: copy it";
    }
    setTimeout(() => {
      copy.textContent = "Copy prompt";
    }, 2500);
  });
})();
