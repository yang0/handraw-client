import { el } from "./api.js";

export const CARD_SIZES = ["1x", "2x", "3x", "4x"];
export const DEFAULT_CARD_SIZE = "2x";

export const CARD_SIZE_PRESETS = {
  "1x": { minWidth: 150, maxCols: 8, gap: 10 },
  "2x": { minWidth: 205, maxCols: 5, gap: 14 },
  "3x": { minWidth: 265, maxCols: 4, gap: 16 },
  "4x": { minWidth: 365, maxCols: 3, gap: 18 },
};

export function normalizeCardSize(size) {
  return CARD_SIZES.includes(size) ? size : DEFAULT_CARD_SIZE;
}

function readStoredSize(storageKey, defaultSize) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw && CARD_SIZES.includes(raw)) return raw;
  } catch {}
  return normalizeCardSize(defaultSize);
}

/**
 * Builds a Skill-gallery-style 1x/2x/3x/4x card-size toolbar and binds it to
 * a host container (`host.dataset.cardSize`) plus any nested `.masonry-grid`.
 */
export function createCardSizeSwitcher({
  storageKey = "handraw_card_size",
  defaultSize = DEFAULT_CARD_SIZE,
  host = null,
  onChange = null,
} = {}) {
  let current = readStoredSize(storageKey, defaultSize);
  const buttons = [];

  const applyToHost = (size) => {
    if (!host) return;
    host.dataset.cardSize = size;
    host.querySelectorAll(".masonry-grid").forEach((grid) => {
      grid.dataset.cardSize = size;
      grid.relayout?.();
    });
  };

  const setSize = (nextSize) => {
    const target = normalizeCardSize(nextSize);
    current = target;
    try { localStorage.setItem(storageKey, target); } catch {}
    buttons.forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.size === target));
    });
    applyToHost(target);
    onChange?.(target);
  };

  CARD_SIZES.forEach((size) => {
    const btn = el("button", {
      type: "button",
      class: "size-btn",
      dataset: { size },
      "aria-pressed": String(size === current),
      title: `切换卡片尺寸为 ${size}`,
      onClick: () => setSize(size),
    }, size);
    buttons.push(btn);
  });

  const group = el("div", { class: "size-btn-group", role: "group", "aria-label": "卡片尺寸规格" }, ...buttons);
  const bar = el("div", {
    class: "size-switcher",
    role: "toolbar",
    focusgroup: "toolbar wrap",
    "aria-label": "卡片尺寸切换",
  },
    el("span", { class: "size-label", "aria-hidden": "true" }, "尺寸"),
    group
  );

  // Roving tabindex fallback when native focusgroup is unavailable.
  if (!("focusGroup" in HTMLElement.prototype)) {
    buttons.forEach((b) => {
      b.tabIndex = b.dataset.size === current ? 0 : -1;
    });
    bar.addEventListener("focusin", ({ target }) => {
      if (!buttons.includes(target)) return;
      buttons.forEach((b) => { b.tabIndex = b === target ? 0 : -1; });
    });
    bar.addEventListener("keydown", (e) => {
      const idx = buttons.indexOf(document.activeElement);
      if (idx === -1) return;
      const rtl = getComputedStyle(bar).direction === "rtl";
      const nextStep = rtl ? -1 : 1;
      let nextIdx = -1;
      if (e.key === "ArrowRight") nextIdx = (idx + nextStep + buttons.length) % buttons.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - nextStep + buttons.length) % buttons.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = buttons.length - 1;
      if (nextIdx === -1) return;
      e.preventDefault();
      buttons[nextIdx].focus();
    });
  }

  applyToHost(current);

  return {
    el: bar,
    getSize: () => current,
    setSize,
    applyToHost: () => applyToHost(current),
  };
}

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
  let lastSizeKey = "";
  let stopped = false;
  const sizes = new WeakMap();
  const schedule = () => {
    if (!stopped && !frame) frame = requestAnimationFrame(layout);
  };
  grid.relayout = schedule;

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
    const sizeKey = normalizeCardSize(grid.dataset.cardSize || grid.closest("[data-card-size]")?.dataset.cardSize);
    if (width !== lastWidth || sizeKey !== lastSizeKey) {
      lastWidth = width;
      lastSizeKey = sizeKey;
      schedule();
    }
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
    const sizeKey = normalizeCardSize(grid.dataset.cardSize || grid.closest("[data-card-size]")?.dataset.cardSize);
    lastSizeKey = sizeKey;
    const preset = CARD_SIZE_PRESETS[sizeKey];
    const gap = preset.gap;
    grid.style.setProperty("--masonry-gap", `${gap}px`);

    const cards = Array.from(grid.children);
    for (const card of observed) {
      if (card.parentElement !== grid) { cardObserver.unobserve(card); observed.delete(card); }
    }
    for (const card of cards) {
      if (!observed.has(card)) { observed.add(card); cardObserver.observe(card); }
    }
    const emptyMessage = cards.length === 1 && cards[0].classList.contains("muted");
    const columns = emptyMessage ? 1 : Math.max(1, Math.min(preset.maxCols, Math.floor((width + gap) / (preset.minWidth + gap))));
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
  mutations.observe(grid, { childList: true, attributes: true, attributeFilter: ["data-card-size"] });
  grid.addEventListener("load", schedule, true);
  grid.addEventListener("error", schedule, true);
  schedule();
  return grid;
}
