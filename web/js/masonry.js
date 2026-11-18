import { el } from "./api.js";

// Pack complete cards into the shortest column without reparenting them.
// Source order, keyboard focus, and each card's intrinsic height stay intact.
// Plain Grid remains the fallback when ResizeObserver is unavailable.
export function masonry(attrs = {}, ...children) {
  const grid = el("div", { ...attrs, class: `grid-cards masonry-grid ${attrs.class || ""}`.trim() }, ...children);
  if (typeof ResizeObserver === "undefined") return grid;

  const observed = new Set();
  let frame = 0;
  let connected = false;
  let lastWidth = -1;
  let stopped = false;
  const sizes = new WeakMap();
  const schedule = () => {
    if (!stopped && !frame) frame = requestAnimationFrame(layout);
  };
  const cardObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const previous = sizes.get(entry.target);
      const next = `${entry.contentRect.width}:${entry.contentRect.height}`;
      if (previous !== next) {
        sizes.set(entry.target, next);
        schedule();
      }
    }
  });
  const gridObserver = new ResizeObserver(() => {
    if (connected && !grid.isConnected) { dispose(); return; }
    const width = grid.clientWidth;
    if (width !== lastWidth) { lastWidth = width; schedule(); }
  });
  const mutations = new MutationObserver(schedule);

  function dispose() {
    stopped = true;
    cancelAnimationFrame(frame);
    gridObserver.disconnect();
    cardObserver.disconnect();
    mutations.disconnect();
    grid.removeEventListener("load", schedule, true);
    grid.removeEventListener("error", schedule, true);
  }

  function layout() {
    frame = 0;
    if (!grid.isConnected) {
      if (connected) dispose();
      return;
    }
    connected = true;
    const width = grid.clientWidth;
    if (!width) return;
    const cards = Array.from(grid.children);
    for (const card of observed) {
      if (card.parentElement !== grid) { cardObserver.unobserve(card); observed.delete(card); }
    }
    for (const card of cards) {
      if (!observed.has(card)) { observed.add(card); cardObserver.observe(card); }
    }
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 14;
    const emptyMessage = cards.length === 1 && cards[0].classList.contains("muted");
    const columns = emptyMessage ? 1 : Math.max(1, Math.min(5, Math.floor((width + gap) / (210 + gap))));
    const cardWidth = (width - gap * (columns - 1)) / columns;
    grid.classList.add("masonry-ready");
    // Batch width writes before measuring heights; images choose their natural
    // aspect ratio, and long captions are measured at their actual card width.
    for (const card of cards) card.style.width = `${cardWidth}px`;
    const heights = cards.map((card) => card.getBoundingClientRect().height);
    const bottoms = Array(columns).fill(0);
    cards.forEach((card, index) => {
      const column = bottoms.indexOf(Math.min(...bottoms));
      card.style.left = `${column * (cardWidth + gap)}px`;
      card.style.top = `${bottoms[column]}px`;
      bottoms[column] += heights[index] + gap;
    });
    grid.style.height = `${Math.max(0, ...bottoms) - (cards.length ? gap : 0)}px`;
    grid.dataset.columns = String(columns);
  }

  gridObserver.observe(grid);
  mutations.observe(grid, { childList: true });
  grid.addEventListener("load", schedule, true);
  grid.addEventListener("error", schedule, true);
  schedule();
  return grid;
}
