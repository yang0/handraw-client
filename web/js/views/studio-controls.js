import { api, clear, closeModal, el, localImg, packImg, showModal, toast } from "../api.js";
import { masonry } from "../masonry.js";
import { openLayoutEditorModal, openStyleEditorModal } from "./resource-editor.js";

const css = el("link", { rel: "stylesheet", href: new URL("../../css/studio.css", import.meta.url).href });
document.head.appendChild(css);

const sessions = new Map();
let fieldSequence = 0;

export const RATIOS = [
  ["3:4", "小红书"], ["1:1", "方图"], ["4:3", "横版"],
  ["16:9", "横屏视频"], ["9:16", "竖屏短视频"], ["2.35:1", "公众号封面"],
];

export const DEFAULT_MOODS = ["治愈", "温暖", "清新", "幽默", "故事感", "极简", "戏剧张力", "怀旧"];

export const WHITESPACE_OPTIONS = [
  ["", "不限"], ["normal", "正常"], ["moderate", "适中"], ["high", "大量"],
];

export const SC021_PLAYSTYLES = ["标准四格漫画", "反转三格漫画", "对比双格漫画", "对话分格故事", "人物成长四步"];

const CATEGORY_LABELS = {
  community: "社区共享",
  infographic: "信息图",
  storyboard: "分镜剧场",
  sketchbook: "手账/笔记",
  comic: "漫画分格",
  card: "社交图文卡",
  social_card: "社交图文卡",
  editorial: "杂志社论",
  ecommerce: "电商海报",
};

export function studioMount(host) {
  clear(host);
  const mount = el("div", { class: "studio-mount" });
  host.appendChild(mount);
  return mount;
}

// Each entrance owns a separate draft and detached DOM. No shared form state.
export function studioSession(host, kind, defaults) {
  clear(host);
  const root = el("div", { class: `creation-page creation-${kind}` });
  host.appendChild(root);
  let saved = sessions.get(kind);
  if (!saved) {
    try { saved = JSON.parse(sessionStorage.getItem(`studio-draft:${kind}`) || "null"); } catch {}
  }
  const state = Object.assign({}, defaults, saved || {});
  sessions.set(kind, state);
  const persist = () => {
    try { sessionStorage.setItem(`studio-draft:${kind}`, JSON.stringify(state)); } catch {}
  };
  for (const name of ["input", "change", "click"]) root.addEventListener(name, () => queueMicrotask(persist));
  return { root, state, persist };
}

export function field(label, control, hint = "") {
  if (!control.id) control.id = `studio-field-${++fieldSequence}`;
  if (!control.name) control.name = control.id;
  const help = hint ? el("span", { class: "muted", id: `${control.id}-hint` }, hint) : null;
  if (help) control.setAttribute("aria-describedby", help.id);
  return el("div", { class: "field" }, el("label", { for: control.id }, label), control, help);
}

export function choices(label, options, value, onChange, { inline = false } = {}) {
  const name = `studio-choice-${++fieldSequence}`;
  const legend = el("legend", null, label);
  const itemsWrap = el("div", { class: "studio-choices-items" });
  const box = el("fieldset", { class: "studio-choices" + (inline ? " is-inline" : "") }, legend, itemsWrap);
  options.forEach(([id, text]) => {
    const input = el("input", { type: "radio", name, value: id, checked: id === value });
    const item = el("label", { class: "studio-choice" }, input, el("span", null, text));
    input.addEventListener("change", () => { if (input.checked) onChange(id); });
    itemsWrap.appendChild(item);
  });
  box.sync = (next) => itemsWrap.querySelectorAll("input").forEach((input) => { input.checked = input.value === next; });
  return box;
}

export function validRatio(value) {
  return /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value) && value.split(":").every((v) => Number(v) > 0);
}

export function ratioToCss(ratio) {
  const parts = String(ratio || "3:4").split(":").map(Number);
  if (parts.length === 2 && parts.every((n) => Number.isFinite(n) && n > 0)) {
    return `${parts[0]} / ${parts[1]}`;
  }
  return "3 / 4";
}

export function ratioControl(label, value, onChange, { compact = false } = {}) {
  const input = el("input", {
    class: "input studio-ratio-input", value: value || "3:4", placeholder: "宽:高", required: true,
    pattern: "[0-9]+(?:\\.[0-9]+)?:[0-9]+(?:\\.[0-9]+)?", spellcheck: "false",
    "aria-label": `${label}自定义比例`,
  });
  const presetList = compact ? RATIOS.slice(0, 4) : RATIOS;
  const presetsWrap = el("div", { class: "studio-ratio-presets", role: "group", "aria-label": `${label}常用比例` });
  const syncButtons = (val) => {
    presetsWrap.querySelectorAll("button").forEach((btn) => {
      const matched = btn.dataset.ratio === val;
      btn.className = "btn btn-sm" + (matched ? " btn-primary is-active" : "");
      btn.setAttribute("aria-pressed", String(matched));
    });
  };
  presetList.forEach(([val, name]) => {
    const btn = el("button", {
      type: "button",
      class: "btn btn-sm" + (val === value ? " btn-primary is-active" : ""),
      dataset: { ratio: val },
      "aria-pressed": String(val === value),
      onClick: () => {
        input.value = val;
        input.setCustomValidity("");
        syncButtons(val);
        onChange(val);
      },
    }, `${name} ${val}`);
    presetsWrap.appendChild(btn);
  });
  input.addEventListener("input", () => {
    input.setCustomValidity("");
    const v = input.value.trim();
    if (validRatio(v)) {
      syncButtons(v);
      onChange(v);
    }
  });
  const validate = () => {
    input.setCustomValidity(validRatio(input.value.trim()) ? "" : "请填写有效的宽:高，例如 3:4 或 2.35:1");
    return input.reportValidity();
  };
  input.addEventListener("blur", validate);
  const labelNode = label ? el("span", { class: "studio-row-label" }, label) : null;
  const row = el("div", { class: "studio-ratio-row" + (compact ? " is-compact" : "") },
    labelNode,
    el("div", { class: "studio-ratio-controls" }, presetsWrap, input)
  );
  row.sync = (v) => {
    input.value = v || "3:4";
    input.setCustomValidity("");
    syncButtons(input.value);
  };
  row.validate = validate;
  return row;
}

export function resourceId(item) { return item?.number || item?.id || ""; }
export function resourceName(item) { return item?.nameZh || item?.name_zh || item?.name || item?.generation_name || item?.name_en || resourceId(item); }
export function resourceThumbUrl(item) {
  const raw = String(item?.image || "").trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("/files/") || raw.startsWith("data:")) {
    return raw;
  }
  if (item?.source === "mine" || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.includes("\\")) {
    return localImg(raw);
  }
  return packImg(raw);
}
function resourceCategory(item) {
  const raw = item?.groupZh || item?.category_zh || item?.group || item?.category || "";
  return CATEGORY_LABELS[raw] || raw;
}

const _warmedStudioThumbs = new Set();

export function warmResourceThumbs(items, limit = 24) {
  if (!Array.isArray(items) || !items.length || typeof Image === "undefined") return;
  const urls = [];
  for (let i = 0; i < items.length && urls.length < limit; i++) {
    const url = resourceThumbUrl(items[i]);
    if (!url || _warmedStudioThumbs.has(url)) continue;
    _warmedStudioThumbs.add(url);
    urls.push(url);
  }
  if (!urls.length) return;
  const run = () => {
    urls.forEach((url) => {
      const img = new Image();
      img.decoding = "async";
      try { img.fetchPriority = "low"; } catch {}
      img.src = url;
    });
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 1200 });
  } else {
    setTimeout(run, 120);
  }
}

// ---- Shared 推荐 order (#168, handraw-web#548) ------------------------------
// The website ranks styles / layouts once (buyer reviews, generation success,
// recent engagement) for its channel and pickers; the client proxies the same
// order so the picker matches the website. Offline: original order.
const RANKING_TTL_MS = 5 * 60 * 1000;
const _rankingCache = new Map();

export function loadResourceRanking(kind) {
  const k = kind === "layout" ? "layout" : "style";
  const hit = _rankingCache.get(k);
  if (hit && (hit.pending || Date.now() - hit.at < RANKING_TTL_MS)) return hit.pending || Promise.resolve(hit.data);
  const pending = api("GET", `/api/resources/ranking?kind=${k}`)
    .then((data) => {
      const clean = { order: Array.isArray(data?.order) ? data.order : [], quality: data?.quality || {} };
      _rankingCache.set(k, { at: Date.now(), data: clean });
      return clean;
    })
    .catch(() => {
      _rankingCache.delete(k);
      return { order: [], quality: {} };
    });
  _rankingCache.set(k, { at: Date.now(), pending });
  return pending;
}

function cachedRanking(kind) {
  const hit = _rankingCache.get(kind === "layout" ? "layout" : "style");
  return hit && hit.data ? hit.data : null;
}

function isMineResource(item) {
  return Boolean(item && (item.source === "mine" || item.isMine));
}

/** My own resources first, then the website's 推荐 order, then the rest as-is. */
export function rankResourceItems(items, ranking) {
  const list = Array.isArray(items) ? items : [];
  const order = ranking && Array.isArray(ranking.order) ? ranking.order : [];
  const pos = new Map(order.map((code, i) => [String(code).toUpperCase(), i]));
  return list
    .map((it, i) => {
      const p = pos.get(String(resourceId(it)).toUpperCase());
      return { it, i, m: isMineResource(it) ? 0 : 1, r: p === undefined ? Number.MAX_SAFE_INTEGER : p };
    })
    .sort((a, b) => (a.m - b.m) || (a.r - b.r) || (a.i - b.i))
    .map((x) => x.it);
}

function qualityChip(ranking, id) {
  const q = ranking && ranking.quality ? ranking.quality[id] || ranking.quality[String(id).toUpperCase()] : null;
  if (!q) return null;
  const parts = [];
  const badges = Array.isArray(q.b) ? q.b : [];
  if (badges.includes("top_rated")) parts.push(el("span", { class: "hrq-badge" }, "🏅 口碑之选"));
  else if (badges.includes("rising")) parts.push(el("span", { class: "hrq-badge is-rising" }, "✨ 新星"));
  if (Number(q.n) > 0 && typeof q.p === "number") parts.push(el("span", { class: "hrq-chip", title: `${Number(q.n)} 位付费买家评价` }, `👍 ${q.p}% 好评`));
  if (typeof q.s === "number") parts.push(el("span", { class: "hrq-chip is-muted", title: "基于官网生图记录" }, `出图 ${q.s}%`));
  return parts.length ? el("span", { class: "hrq-row" }, ...parts) : null;
}

export function openResourceDialog(title, items, selected, onSelect, { empty = "不指定", allowRandom = true, createKind = "", kind = "" } = {}) {
  const search = el("input", { class: "input", type: "search", placeholder: "搜索编号、名称或关键词…", autofocus: true });
  const catBar = el("div", { class: "studio-cat-tabs", role: "group", "aria-label": `${title}分类` });
  // Styles / layouts get the website's 推荐 order and a waterfall layout (#168).
  const rankKind = kind || (createKind === "style" || createKind === "layout" ? createKind : "");
  const waterfall = Boolean(rankKind);
  const scroller = el("div", { class: "studio-resource-grid" + (waterfall ? " is-waterfall" : "") });
  const grid = waterfall ? masonry({ class: "studio-resource-masonry", dataset: { cardSize: "1x" } }) : scroller;
  if (waterfall) scroller.appendChild(grid);
  let ranking = waterfall ? cachedRanking(rankKind) : null;
  // Work on a copy so caller catalog arrays keep their reference, while still
  // syncing newly created items back into sourceItems (#168).
  const sourceItems = items;
  items = waterfall ? rankResourceItems(items, ranking) : items;
  const count = el("p", { class: "muted", role: "status", style: { margin: "0" } });

  let activeCat = "";
  let currentVisible = items.slice();
  const catCounts = new Map();
  const searchIndex = items.map((item) => {
    const c = resourceCategory(item);
    if (c) catCounts.set(c, (catCounts.get(c) || 0) + 1);
    return `${resourceId(item)} ${resourceName(item)} ${item.traits || ""} ${item.prompt_zh || ""} ${c}`.toLowerCase();
  });

  let closeCurrent = closeModal;
  let batchObserver = null;
  let searchTimer = null;
  const cleanupGrid = () => {
    if (batchObserver) {
      batchObserver.disconnect();
      batchObserver = null;
    }
  };
  const choose = (id) => {
    cleanupGrid();
    onSelect(id);
    closeCurrent();
  };

  const renderCats = () => {
    clear(catBar);
    if (catCounts.size <= 1) { catBar.classList.add("hidden"); return; }
    catBar.classList.remove("hidden");
    const sortedCats = Array.from(catCounts.entries()).sort(([a], [b]) => {
      const aMine = a === "我的画风" || a === "我的图型" || a === "mine";
      const bMine = b === "我的画风" || b === "我的图型" || b === "mine";
      if (aMine !== bMine) return aMine ? -1 : 1;
      return 0;
    });
    const entries = [["", `全部 (${items.length})`], ...sortedCats.map(([k, n]) => [k, `${k} (${n})`])];
    entries.forEach(([k, label]) => {
      catBar.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm" + (activeCat === k ? " btn-primary" : ""),
        "aria-pressed": String(activeCat === k),
        onClick: () => { activeCat = k; renderCats(); renderGrid(); },
      }, label));
    });
  };

  const buildOptionCard = (item, idx) => {
    const id = resourceId(item);
    let mediaNode;
    if (item.image) {
      const wrap = el("div", { class: "studio-resource-thumb-wrap", dataset: { fallback: id || "+" } });
      if (waterfall) wrap.style.aspectRatio = "3 / 4";
      const img = el("img", {
        src: resourceThumbUrl(item),
        alt: "",
        decoding: "async",
        loading: idx < 18 ? "eager" : "lazy",
        ...(idx < 10 ? { fetchpriority: "high" } : {}),
      });
      const adoptRatio = () => {
        // Waterfall: the card takes the image's natural shape (#168).
        if (waterfall && img.naturalWidth > 0 && img.naturalHeight > 0) {
          wrap.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        }
      };
      img.addEventListener("load", () => {
        img.classList.remove("is-error");
        img.classList.add("is-loaded");
        wrap.classList.remove("is-error");
        adoptRatio();
      });
      img.addEventListener("error", () => {
        img.classList.remove("is-loaded", "is-instant");
        img.classList.add("is-error");
        wrap.classList.add("is-error");
      });
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add("is-loaded", "is-instant");
        adoptRatio();
      }
      wrap.appendChild(img);
      mediaNode = wrap;
    } else {
      mediaNode = el("div", { class: "studio-resource-option-empty" }, id || "+");
    }
    const isProtected = Boolean(item.promptHidden || item.siteModelOnly || item.source === "community" || item.source === "exclusive");
    const subTag = isProtected
      ? (item.unlocked || item.isMine ? `${id} · ☁ 网站模型` : `${id} · 🔒 ${Math.max(1, Number(item.unlockCost || 1))}分`)
      : id;
    return el("button", {
      type: "button",
      class: "studio-resource-option",
      "aria-pressed": String(id === selected),
      onClick: () => choose(id),
    },
    mediaNode,
    el("small", { class: "mono" }, subTag),
    el("strong", null, resourceName(item)),
    waterfall ? qualityChip(ranking, id) : null);
  };

  const renderGrid = () => {
    cleanupGrid();
    clear(grid);
    scroller.querySelectorAll(":scope > .studio-resource-sentinel").forEach((n) => n.remove());
    scroller.scrollTop = 0;
    const q = search.value.trim().toLowerCase();
    const visible = [];
    for (let i = 0; i < items.length; i++) {
      const x = items[i];
      if (activeCat && resourceCategory(x) !== activeCat) continue;
      if (q && !searchIndex[i].includes(q)) continue;
      visible.push(x);
    }
    currentVisible = visible;
    count.textContent = `共 ${visible.length} 项`;
    if (randomBtn) randomBtn.disabled = visible.length === 0;
    if (!visible.length) {
      grid.appendChild(el("p", { class: "muted", style: { gridColumn: "1 / -1", textAlign: "center", padding: "24px 0" } }, "没有匹配的条目"));
      return;
    }

    const INITIAL_BATCH = 36;
    const NEXT_BATCH = 40;
    let cursor = 0;
    let sentinel = null;

    const appendBatch = (size) => {
      if (cursor >= visible.length) {
        cleanupGrid();
        sentinel?.remove();
        sentinel = null;
        return;
      }
      const frag = document.createDocumentFragment();
      const end = Math.min(visible.length, cursor + size);
      for (let i = cursor; i < end; i++) {
        frag.appendChild(buildOptionCard(visible[i], i));
      }
      cursor = end;
      if (sentinel && sentinel.parentNode === grid) {
        grid.insertBefore(frag, sentinel);
      } else {
        grid.appendChild(frag);
      }
      grid.relayout?.();
      if (cursor >= visible.length) {
        cleanupGrid();
        sentinel?.remove();
        sentinel = null;
      }
    };

    appendBatch(INITIAL_BATCH);

    if (cursor < visible.length) {
      sentinel = el("div", { class: "studio-resource-sentinel", "aria-hidden": "true" });
      // Waterfall cards are absolutely positioned, so the sentinel sits after
      // the masonry grid inside the scroller instead of among the cards.
      (waterfall ? scroller : grid).appendChild(sentinel);
      if (typeof IntersectionObserver !== "undefined") {
        batchObserver = new IntersectionObserver((entries) => {
          if (entries.some((en) => en.isIntersecting)) {
            appendBatch(NEXT_BATCH);
          }
        }, { root: scroller, rootMargin: "480px 0px" });
        batchObserver.observe(sentinel);
      } else {
        appendBatch(visible.length - cursor);
      }
    }
  };

  const pickRandom = () => {
    const src = currentVisible.length ? currentVisible : items;
    if (!src.length) {
      toast("当前没有可随机选择的条目");
      return;
    }
    const candidates = src.length > 1 ? src.filter((x) => resourceId(x) !== selected) : src;
    const pool = candidates.length ? candidates : src;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    const id = resourceId(picked);
    choose(id);
    toast(`🎲 已随机选择${title}：${id} ${resourceName(picked)}`);
  };

  const randomBtn = allowRandom && items.length > 1
    ? el("button", {
        type: "button",
        class: "btn btn-sm studio-picker-random-btn",
        title: `从当前筛选结果中随机选择一个${title}`,
        onClick: pickRandom,
      }, "🎲 随机选择")
    : null;

  const createBtn = (createKind === "style" || createKind === "layout")
    ? el("button", {
        type: "button",
        class: "btn btn-sm btn-primary studio-picker-create-btn",
        title: createKind === "layout" ? "新建自己的图型并立即选用" : "新建自己的画风并立即选用",
        onClick: () => {
          const openEditor = createKind === "layout" ? openLayoutEditorModal : openStyleEditorModal;
          openEditor({}, (saved) => {
            if (!saved) return;
            const newId = resourceId(saved);
            if (newId) {
              const existIdx = items.findIndex((x) => resourceId(x) === newId);
              if (existIdx >= 0) items[existIdx] = saved;
              else items.unshift(saved);
              if (sourceItems !== items && Array.isArray(sourceItems)) {
                const srcIdx = sourceItems.findIndex((x) => resourceId(x) === newId);
                if (srcIdx >= 0) sourceItems[srcIdx] = saved;
                else sourceItems.unshift(saved);
              }
              choose(newId);
            }
          }, { stacked: true });
        },
      }, createKind === "layout" ? "＋ 新建图型" : "＋ 新建画风")
    : null;

  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderGrid, 60);
  });
  const body = el("div", { class: "studio-picker-dialog-body" },
    el("search", { class: "studio-picker-search-row" },
      el("div", { style: { flex: "1 1 auto", minWidth: 0 } }, field("筛选", search)),
      randomBtn,
      createBtn
    ),
    catBar,
    count,
    scroller
  );
  const footer = [
    empty ? el("button", { type: "button", class: "btn", onClick: () => choose("") }, empty) : null,
    el("button", { type: "button", class: "btn", onClick: () => closeCurrent() }, "取消"),
  ].filter(Boolean);

  // If #app-dialog is already open (e.g. inside slot prompt or settings dialog),
  // stack a dedicated native top-layer <dialog> instead of overwriting it.
  let activeDialog = null;
  if (document.getElementById("app-dialog")?.open) {
    const titleId = `nested-dlg-title-${++fieldSequence}`;
    const nested = el("dialog", { class: "modal modal-picker", closedby: "any", "aria-labelledby": titleId },
      el("div", { class: "modal-inner" },
        el("div", { class: "modal-head" },
          el("h2", { id: titleId, class: "modal-title" }, `选择${title}`),
          el("form", { method: "dialog" },
            el("button", { class: "icon-btn", value: "close", "aria-label": "关闭" }, "✕")
          )
        ),
        el("div", { class: "modal-body" }, body),
        el("div", { class: "modal-foot" }, ...footer)
      )
    );
    closeCurrent = () => { if (nested.open) nested.close(""); };
    nested.addEventListener("close", () => { cleanupGrid(); clearTimeout(searchTimer); nested.remove(); });
    document.body.appendChild(nested);
    nested.showModal();
    activeDialog = nested;
  } else {
    activeDialog = showModal(`选择${title}`, body, footer);
    activeDialog?.classList.add("modal-picker");
    activeDialog?.addEventListener("close", () => {
      cleanupGrid();
      clearTimeout(searchTimer);
      activeDialog.classList.remove("modal-picker");
    }, { once: true });
  }
  renderCats();
  renderGrid();
  requestAnimationFrame(() => search.focus({ preventScroll: true }));
  if (waterfall) {
    loadResourceRanking(rankKind).then((fresh) => {
      if (!fresh || !fresh.order.length || fresh === ranking || !scroller.isConnected) return;
      const userScrolled = scroller.scrollTop > 40;
      ranking = fresh;
      const reordered = rankResourceItems(items, ranking);
      items.splice(0, items.length, ...reordered);
      searchIndex.splice(0, searchIndex.length, ...items.map((item) => `${resourceId(item)} ${resourceName(item)} ${item.traits || ""} ${item.prompt_zh || ""} ${resourceCategory(item)}`.toLowerCase()));
      if (!userScrolled) renderGrid();
    });
  }
}

export function resourcePicker(label, items, value, onChange, empty = "不指定", { allowClear = true, createKind = "", kind = "" } = {}) {
  let selected = value;
  let caption = label;
  const wrap = el("div", { class: "studio-picker-wrap" });
  const button = el("button", { type: "button", class: "make-image-picker-card" });
  const clearBtn = el("button", {
    type: "button",
    class: "make-image-picker-clear",
    title: `清除${label}`,
    "aria-label": `清除${label}`,
    onClick: (e) => {
      e.stopPropagation();
      sync("");
      onChange("");
    },
  }, "×");

  const sync = (v = selected, nextLabel = caption) => {
    selected = v;
    caption = nextLabel;
    const item = items.find((x) => resourceId(x) === selected);
    const hasItem = Boolean(item);
    button.className = "make-image-picker-card" + (hasItem ? " is-selected" : "");
    button.setAttribute("aria-label", `选择${caption}${item ? `，当前 ${resourceId(item)} ${resourceName(item)}` : ""}`);
    clear(button);
    button.append(
      el("div", { class: "make-image-picker-thumb" },
        item?.image ? el("img", { src: resourceThumbUrl(item), alt: "" }) : el("span", { class: "make-image-picker-placeholder", "aria-hidden": "true" }, "＋")),
      el("div", { class: "make-image-picker-info" },
        el("span", { class: "make-image-picker-badge" }, caption + (item ? ` · ${resourceId(item)}` : "")),
        el("strong", { class: "make-image-picker-name" }, item ? resourceName(item) : empty),
        el("span", { class: "make-image-picker-hint" }, item ? "点击更换" : "点击选择"))
    );
    clearBtn.classList.toggle("hidden", !(allowClear && hasItem));
  };

  const quickNewBtn = (createKind === "style" || createKind === "layout")
    ? el("button", {
        type: "button",
        class: "make-image-picker-create",
        title: createKind === "layout" ? "直接新建自己的图型并选中" : "直接新建自己的画风并选中",
        "aria-label": createKind === "layout" ? "新建我的图型" : "新建我的画风",
        onClick: (e) => {
          e.stopPropagation();
          const openEditor = createKind === "layout" ? openLayoutEditorModal : openStyleEditorModal;
          openEditor({}, (saved) => {
            if (!saved) return;
            const newId = resourceId(saved);
            if (newId) {
              const existIdx = items.findIndex((x) => resourceId(x) === newId);
              if (existIdx >= 0) items[existIdx] = saved;
              else items.unshift(saved);
              sync(newId);
              onChange(newId);
            }
          });
        },
      }, "＋ 自建")
    : null;

  button.addEventListener("click", () => {
    const rankKind = kind || (createKind === "style" || createKind === "layout" ? createKind : "");
    openResourceDialog(caption, items, selected, (id) => {
      sync(id);
      onChange(id);
    }, { empty: allowClear ? empty : "", createKind, kind: rankKind });
  });

  sync();
  wrap.append(...[button, quickNewBtn, clearBtn].filter(Boolean));
  wrap.sync = sync;
  return wrap;
}

export function extraInstructions(state) {
  const parts = [];
  if (state.layout === "SC-021" && state.sc021Type) {
    parts.push(`SC-021 分格玩法：${state.sc021Type}`);
  }
  if (state.layout === "SC-022" && (state.sc022Name?.trim() || state.sc022Pinyin?.trim())) {
    const nm = [state.sc022Name?.trim(), state.sc022Pinyin?.trim()].filter(Boolean).join(" / ");
    parts.push(`人物卡姓名标识：${nm}`);
  }
  if (state.whitespace) {
    parts.push(`留白程度：${({ normal: "正常", moderate: "适中", high: "大量" })[state.whitespace] || state.whitespace}`);
  }
  if (state.audience?.trim()) parts.push(`目标受众：${state.audience.trim()}`);
  if (state.businessScene?.trim()) parts.push(`业务场景：${state.businessScene.trim()}`);
  if (state.mode === "poster") parts.push("海报设计，文字参与构图，突出主标题与视觉层级。");
  if (state.extra?.trim()) parts.push(state.extra.trim());
  return parts.filter(Boolean).join("\n");
}

function moodTokens(raw) {
  return String(raw || "")
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Shared website-parity form controls across Single, Series, and Article.
export function recipeControls(state, catalog, onChange = () => {}, { article = false, layout = true, hasDefaultStyle = true } = {}) {
  state.mode = state.mode === "pure" ? "pure-image" : (state.mode || "graphic-text");
  state.fusion = state.fusion ?? Boolean(state.style2);
  const change = () => onChange();

  const modes = choices("生成方式", [["graphic-text", "图文"], ["pure-image", "纯图"], ["poster", "海报"]], state.mode, (v) => {
    state.mode = v;
    if (!article) {
      state.ratio = v === "poster" ? "9:16" : "3:4";
      ratio.sync(state.ratio);
    }
    change();
  }, { inline: true });

  const fusion = choices("画风模式", [["single", "单画风"], ["fusion", "双画风融合"]], state.fusion ? "fusion" : "single", (v) => {
    state.fusion = v === "fusion";
    sync();
    change();
  }, { inline: true });

  const topRow = el("div", { class: "make-image-top-row" }, modes, fusion);

  const primary = resourcePicker("画风", catalog.styles || [], state.style, (v) => { state.style = v; change(); }, hasDefaultStyle ? "选择画风" : "AI 推荐", { allowClear: !hasDefaultStyle, createKind: "style" });
  const secondary = resourcePicker("场景画风", catalog.styles || [], state.style2, (v) => { state.style2 = v; change(); }, "选择场景画风", { allowClear: true, createKind: "style" });
  const layoutPicker = resourcePicker("图型", catalog.layouts || [], state.layout, (v) => { state.layout = v; syncSpecialLayoutFields(); change(); }, "自由构图", { allowClear: true, createKind: "layout" });
  const color = resourcePicker("主题色", catalog.colors || [], state.color, (v) => { state.color = v; change(); }, "随画风", { allowClear: true });
  // Preload the shared website 推荐 ranking so opening the picker is already ordered (#168).
  loadResourceRanking("style");
  loadResourceRanking("layout");
  warmResourceThumbs(catalog.styles || [], 24);
  warmResourceThumbs(catalog.layouts || [], 24);

  const pickersRow = el("div", { class: "make-image-pickers-row" },
    primary, secondary, layout ? layoutPicker : null, color
  );
  const note = el("div", { class: "make-image-style-note" }, "角色画风决定人物与主体的画法，场景画风决定背景与环境");

  // Conditional SC-021 / SC-022 fields
  const sc021Wrap = el("div", { class: "studio-special-row hidden" });
  const sc021Btns = el("div", { class: "studio-chip-row" });
  SC021_PLAYSTYLES.forEach((play) => {
    sc021Btns.appendChild(el("button", {
      type: "button",
      class: "btn btn-sm",
      dataset: { sc021: play },
      onClick: () => { state.sc021Type = play; syncSpecialLayoutFields(); change(); },
    }, play));
  });
  sc021Wrap.append(el("span", { class: "studio-row-label" }, "SC-021 玩法"), sc021Btns);

  const sc022NameIn = el("input", { class: "input", value: state.sc022Name || "", placeholder: "如：林小满" });
  const sc022PinyinIn = el("input", { class: "input", value: state.sc022Pinyin || "", placeholder: "如：Lin Xiaoman" });
  sc022NameIn.addEventListener("input", () => { state.sc022Name = sc022NameIn.value; change(); });
  sc022PinyinIn.addEventListener("input", () => { state.sc022Pinyin = sc022PinyinIn.value; change(); });
  const sc022Wrap = el("div", { class: "studio-special-row hidden" },
    field("SC-022 姓名", sc022NameIn),
    field("SC-022 拼音", sc022PinyinIn)
  );

  function syncSpecialLayoutFields() {
    sc021Wrap.classList.toggle("hidden", state.layout !== "SC-021");
    sc022Wrap.classList.toggle("hidden", state.layout !== "SC-022");
    if (state.layout === "SC-021") {
      if (!state.sc021Type) state.sc021Type = SC021_PLAYSTYLES[0];
      sc021Btns.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.sc021 === state.sc021Type;
        b.className = "btn btn-sm" + (on ? " btn-primary" : "");
        b.setAttribute("aria-pressed", String(on));
      });
    }
  }

  const ratio = ratioControl("画幅", state.ratio || "3:4", (v) => { state.ratio = v; change(); });

  // More settings: tone picker, mood chips + input, whitespace, audience, business scene, extra
  const tone = resourcePicker("影调", catalog.tones || [], state.tone, (v) => { state.tone = v; change(); }, "自然影调", { allowClear: true });
  const moodInput = el("input", { class: "input", value: state.mood || "", placeholder: "情绪词用中文逗号分隔，如：治愈，诗意" });
  const moodChipsWrap = el("div", { class: "studio-chip-row" });
  DEFAULT_MOODS.forEach((m) => {
    moodChipsWrap.appendChild(el("button", {
      type: "button",
      class: "btn btn-sm studio-chip-btn",
      dataset: { mood: m },
      onClick: () => {
        const cur = moodTokens(state.mood);
        const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m];
        state.mood = next.join("，");
        moodInput.value = state.mood;
        syncMoodChips();
        change();
      },
    }, m));
  });
  function syncMoodChips() {
    const cur = new Set(moodTokens(state.mood));
    moodChipsWrap.querySelectorAll("button").forEach((b) => {
      const on = cur.has(b.dataset.mood);
      b.className = "btn btn-sm studio-chip-btn" + (on ? " btn-primary" : "");
      b.setAttribute("aria-pressed", String(on));
    });
  }
  moodInput.addEventListener("input", () => {
    state.mood = moodInput.value;
    syncMoodChips();
    change();
  });

  const whitespace = choices("留白", WHITESPACE_OPTIONS, state.whitespace || "", (v) => { state.whitespace = v; change(); }, { inline: true });
  const audience = el("input", { class: "input", value: state.audience || "", placeholder: "例如：手账爱好者、都市白领" });
  const business = el("input", { class: "input", value: state.businessScene || "", placeholder: "例如：小红书图文封面" });
  const extra = el("textarea", { class: "textarea", rows: "2", value: state.extra || "", placeholder: "需要保留或避免的画面细节" });
  for (const [input, key] of [[audience, "audience"], [business, "businessScene"], [extra, "extra"]]) {
    input.addEventListener("input", () => { state[key] = input.value; change(); });
  }

  const more = el("details", { class: "studio-more-card", open: Boolean(state.moreOpen) },
    el("summary", { class: "studio-more-summary" },
      el("span", null, "更多设置 · 影调、情绪、留白与受众"),
      el("span", { class: "studio-more-chevron", "aria-hidden": "true" })
    ),
    el("div", { class: "studio-more-body" },
      el("div", { class: "studio-more-row" }, el("span", { class: "studio-row-label" }, "影调"), tone),
      el("div", { class: "col", style: { gap: "6px" } },
        el("div", { class: "studio-more-row" }, el("span", { class: "studio-row-label" }, "情绪"), moodInput),
        moodChipsWrap
      ),
      whitespace,
      el("div", { class: "studio-duo-row" },
        field("目标受众", audience),
        field("业务场景", business)
      ),
      field("补充要求", extra)
    )
  );
  more.addEventListener("toggle", () => { state.moreOpen = more.open; change(); });

  const node = el("section", { class: "studio-recipe-controls", "aria-label": "配图设置" },
    topRow, pickersRow, note, sc021Wrap, sc022Wrap, article ? null : ratio, more
  );

  let directMode = false;

  function applyDirectVisibility() {
    topRow.classList.toggle("hidden", directMode);
    pickersRow.classList.toggle("hidden", directMode);
    more.classList.toggle("hidden", directMode);
    if (directMode) {
      note.classList.add("hidden");
      sc021Wrap.classList.add("hidden");
      sc022Wrap.classList.add("hidden");
    } else {
      note.classList.toggle("hidden", !state.fusion);
      syncSpecialLayoutFields();
    }
  }

  function sync() {
    modes.sync(state.mode);
    fusion.sync(state.fusion ? "fusion" : "single");
    primary.sync(state.style, state.fusion ? "角色画风" : "画风");
    secondary.sync(state.style2);
    secondary.classList.toggle("hidden", !state.fusion);
    pickersRow.classList.toggle("has-style2", Boolean(state.fusion));
    note.classList.toggle("hidden", !state.fusion);
    color.sync(state.color);
    layoutPicker.sync(state.layout);
    tone.sync(state.tone);
    ratio.sync(state.ratio || "3:4");
    moodInput.value = state.mood || "";
    syncMoodChips();
    syncSpecialLayoutFields();
    sc022NameIn.value = state.sc022Name || "";
    sc022PinyinIn.value = state.sc022Pinyin || "";
    audience.value = state.audience || "";
    business.value = state.businessScene || "";
    extra.value = state.extra || "";
    whitespace.sync(state.whitespace || "");
    applyDirectVisibility();
  }

  function setDirectMode(on) {
    directMode = Boolean(on);
    applyDirectVisibility();
  }

  sync();
  return {
    node,
    sync,
    setDirectMode,
    validate: () => (article || ratio.validate()) && (directMode || !state.fusion || Boolean(state.style && state.style2)),
    layoutPicker,
    pickersRow,
  };
}
