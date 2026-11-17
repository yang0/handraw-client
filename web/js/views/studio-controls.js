import { clear, closeModal, el, packImg, showModal } from "../api.js";

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
function resourceCategory(item) {
  const raw = item?.groupZh || item?.category_zh || item?.group || item?.category || "";
  return CATEGORY_LABELS[raw] || raw;
}

export function openResourceDialog(title, items, selected, onSelect, { empty = "不指定" } = {}) {
  const search = el("input", { class: "input", type: "search", placeholder: "搜索编号、名称或关键词…", autofocus: true });
  const catBar = el("div", { class: "studio-cat-tabs", role: "group", "aria-label": `${title}分类` });
  const grid = el("div", { class: "studio-resource-grid" });
  const count = el("p", { class: "muted", role: "status", style: { margin: "0" } });

  let activeCat = "";
  const catCounts = new Map();
  items.forEach((item) => {
    const c = resourceCategory(item);
    if (c) catCounts.set(c, (catCounts.get(c) || 0) + 1);
  });

  const choose = (id) => { onSelect(id); closeModal(); };

  const renderCats = () => {
    clear(catBar);
    if (catCounts.size <= 1) { catBar.classList.add("hidden"); return; }
    catBar.classList.remove("hidden");
    const entries = [["", `全部 (${items.length})`], ...Array.from(catCounts.entries()).map(([k, n]) => [k, `${k} (${n})`])];
    entries.forEach(([k, label]) => {
      catBar.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm" + (activeCat === k ? " btn-primary" : ""),
        "aria-pressed": String(activeCat === k),
        onClick: () => { activeCat = k; renderCats(); renderGrid(); },
      }, label));
    });
  };

  const renderGrid = () => {
    clear(grid);
    const q = search.value.trim().toLowerCase();
    const visible = items.filter((x) => {
      if (activeCat && resourceCategory(x) !== activeCat) return false;
      if (!q) return true;
      return `${resourceId(x)} ${resourceName(x)} ${x.traits || ""} ${x.prompt_zh || ""} ${resourceCategory(x)}`.toLowerCase().includes(q);
    });
    count.textContent = `共 ${visible.length} 项`;
    if (!visible.length) {
      grid.appendChild(el("p", { class: "muted", style: { gridColumn: "1 / -1", textAlign: "center", padding: "24px 0" } }, "没有匹配的条目"));
      return;
    }
    visible.forEach((item) => {
      const id = resourceId(item);
      grid.appendChild(el("button", {
        type: "button",
        class: "studio-resource-option",
        "aria-pressed": String(id === selected),
        onClick: () => choose(id),
      },
      item.image ? el("img", { src: packImg(item.image), alt: "", loading: "lazy" }) : el("div", { class: "studio-resource-option-empty" }, id || "+"),
      el("small", { class: "mono" }, id),
      el("strong", null, resourceName(item))));
    });
  };

  search.addEventListener("input", renderGrid);
  const body = el("div", { class: "col", style: { gap: "10px" } },
    el("search", null, field("筛选", search)),
    catBar,
    count,
    grid
  );
  showModal(`选择${title}`, body, [
    empty ? el("button", { type: "button", class: "btn", onClick: () => choose("") }, empty) : null,
    el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
  ].filter(Boolean));
  renderCats();
  renderGrid();
  search.focus();
}

export function resourcePicker(label, items, value, onChange, empty = "不指定", { allowClear = true } = {}) {
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
        item?.image ? el("img", { src: packImg(item.image), alt: "" }) : el("span", { class: "make-image-picker-placeholder", "aria-hidden": "true" }, "＋")),
      el("div", { class: "make-image-picker-info" },
        el("span", { class: "make-image-picker-badge" }, caption + (item ? ` · ${resourceId(item)}` : "")),
        el("strong", { class: "make-image-picker-name" }, item ? resourceName(item) : empty),
        el("span", { class: "make-image-picker-hint" }, item ? "点击更换" : "点击选择"))
    );
    clearBtn.classList.toggle("hidden", !(allowClear && hasItem));
  };

  button.addEventListener("click", () => {
    openResourceDialog(caption, items, selected, (id) => {
      sync(id);
      onChange(id);
    }, { empty: allowClear ? empty : "" });
  });

  sync();
  wrap.append(button, clearBtn);
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

  const primary = resourcePicker("画风", catalog.styles || [], state.style, (v) => { state.style = v; change(); }, "选择画风", { allowClear: !hasDefaultStyle });
  const secondary = resourcePicker("场景画风", catalog.styles || [], state.style2, (v) => { state.style2 = v; change(); }, "选择场景画风", { allowClear: true });
  const layoutPicker = resourcePicker("图型", catalog.layouts || [], state.layout, (v) => { state.layout = v; syncSpecialLayoutFields(); change(); }, "自由构图", { allowClear: true });
  const color = resourcePicker("主题色", catalog.colors || [], state.color, (v) => { state.color = v; change(); }, "随画风", { allowClear: true });

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
  }

  sync();
  return {
    node,
    sync,
    validate: () => (article || ratio.validate()) && (!state.fusion || Boolean(state.style && state.style2)),
    layoutPicker,
    pickersRow,
  };
}
