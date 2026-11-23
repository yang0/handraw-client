import { el } from "../api.js";
import { renderCreate } from "./create.js";
import { renderSeries } from "./series.js";

const studioState = {
  mode: "single", // single | series
  shared: null,
};

export async function renderStudio(root, ctx, params = {}) {
  const explicit = params.studioMode;
  if (explicit === "single" || explicit === "series") {
    studioState.mode = explicit;
  } else if (params.style || params.galleryRef || params.galleryRefs || params.editImage || params.theme || params.run || params.recipe || params.preset) {
    studioState.mode = "single";
  }

  let currentGetter = null;
  const switchTo = (nextMode) => {
    if (nextMode === studioState.mode) return;
    if (typeof currentGetter === "function") {
      try { studioState.shared = currentGetter(); } catch {}
    }
    studioState.mode = nextMode;
    renderStudio(root, ctx, { studioMode: nextMode });
  };

  const makeModeSwitcher = (active) => el("div", {
    class: "studio-mode-switch row",
    role: "group",
    "aria-label": "生图方式",
    style: {
      gap: "4px",
      padding: "3px",
      borderRadius: "10px",
      background: "var(--surface-2, #efeae0)",
      border: "1px solid var(--line)",
    },
  },
    el("button", {
      type: "button",
      class: "btn btn-sm" + (active === "single" ? " btn-primary" : ""),
      dataset: { studioMode: "single" },
      "aria-pressed": String(active === "single"),
      onClick: () => switchTo("single"),
    }, "单图"),
    el("button", {
      type: "button",
      class: "btn btn-sm" + (active === "series" ? " btn-primary" : ""),
      dataset: { studioMode: "series" },
      "aria-pressed": String(active === "series"),
      onClick: () => switchTo("series"),
    }, "系列图")
  );

  const mergedParams = {
    ...(studioState.shared ? { sharedRecipe: studioState.shared } : {}),
    ...params,
    modeSwitcher: makeModeSwitcher(studioState.mode),
    registerSharedGetter: (fn) => { currentGetter = fn; },
  };
  studioState.shared = null;

  if (studioState.mode === "series") {
    await renderSeries(root, ctx, mergedParams);
  } else {
    await renderCreate(root, ctx, mergedParams);
  }
}
