/*
 * The bootloader check's list: search, status, stars and activity filters and sorting over the rows
 * the build rendered, and the agent prompt's copy button. Without JavaScript, the whole list (most
 * starred first) and the prompt still show.
 */
(() => {
  const controls = document.querySelector(".controls");
  const search = document.getElementById("search");
  const count = document.getElementById("count");
  const sort = document.getElementById("sort");
  const stars = document.getElementById("stars");
  const activity = document.getElementById("activity");
  const body = document.getElementById("firmwares");
  const rows = [...body.querySelectorAll("tr")];
  const filters = [...document.querySelectorAll("[data-filter]")];
  let filter = "all";

  // A row's commit count, or -1 when it isn't known.
  const commitsOf = (row) => Number(row.dataset.commits ?? -1);
  const daysSince = (row) => (row.dataset.last ? (Date.now() - Date.parse(row.dataset.last)) / 86_400_000 : Infinity);

  // The rows in the build's order (most starred first) break every tie.
  const orders = {
    stars: () => 0,
    last: (one, two) => two.dataset.last.localeCompare(one.dataset.last),
    commits: (one, two) => commitsOf(two) - commitsOf(one),
    name: (one, two) => one.dataset.name.localeCompare(two.dataset.name),
  };

  const isActive = (row) => {
    const [kind, amount] = activity.value.split("-");
    if (kind === "commits") return commitsOf(row) >= Number(amount);
    if (kind === "days") return daysSince(row) <= Number(amount);
    if (kind === "little") return row.dataset.commits !== undefined && commitsOf(row) < 5;
    return true;
  };

  const update = () => {
    const query = search.value.trim().toLowerCase();
    const minimumStars = Number(stars.value);
    let shown = 0;
    for (const row of rows) {
      const visible =
        (filter === "all" || row.dataset.status === filter) &&
        (!query || row.dataset.search.includes(query)) &&
        Number(row.dataset.stars) >= minimumStars &&
        isActive(row);
      row.hidden = !visible;
      if (visible) shown += 1;
    }
    count.textContent = `Showing ${shown} of ${rows.length}`;
  };

  const reorder = () => {
    const order = orders[sort.value] ?? orders.stars;
    const sorted = rows.map((row, index) => ({ row, index }));
    sorted.sort((one, two) => order(one.row, two.row) || one.index - two.index);
    body.append(...sorted.map(({ row }) => row));
  };

  for (const button of filters) {
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      for (const other of filters) other.setAttribute("aria-pressed", String(other === button));
      update();
    });
  }
  search.addEventListener("input", update);
  stars.addEventListener("change", update);
  activity.addEventListener("change", update);
  sort.addEventListener("change", reorder);
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
