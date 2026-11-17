import { clear, closeModal, el, packImg, showModal } from "../api.js";

const css = el("link", { rel: "stylesheet", href: new URL("../../css/studio.css", import.meta.url).href });
document.head.appendChild(css);

const sessions = new Map();
let fieldSequence = 0;
export const RATIOS = [
  ["3:4", "小红书"], ["1:1", "方图"], ["4:3", "横版"],
  ["16:9", "横屏视频"], ["9:16", "竖屏短视频"], ["2.35:1", "公众号封面"],
];

export function studioMount(host) {
  clear(host);
  const mount = el("div");
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
  const state = Object.assign(defaults, saved || {});
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

export function choices(label, options, value, onChange) {
  const name = `studio-choice-${++fieldSequence}`;
  const box = el("fieldset", { class: "studio-choices" }, el("legend", null, label));
  options.forEach(([id, text]) => {
    const input = el("input", { type: "radio", name, value: id, checked: id === value });
    const item = el("label", { class: "studio-choice" }, input, el("span", null, text));
    input.addEventListener("change", () => { if (input.checked) onChange(id); });
    box.appendChild(item);
  });
  box.sync = (next) => box.querySelectorAll("input").forEach((input) => { input.checked = input.value === next; });
  return box;
}

export function validRatio(value) {
  return /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value) && value.split(":").every((v) => Number(v) > 0);
}

export function ratioControl(label, value, onChange, { compact = false } = {}) {
  const input = el("input", {
    class: "input studio-ratio-input", value, placeholder: "宽:高", required: true,
    pattern: "[0-9]+(?:\\.[0-9]+)?:[0-9]+(?:\\.[0-9]+)?", spellcheck: "false",
  });
  const presets = choices("预置比例", RATIOS, value, (v) => {
    input.value = v;
    input.setCustomValidity("");
    onChange(v);
  });
  input.addEventListener("input", () => {
    input.setCustomValidity("");
    if (validRatio(input.value.trim())) { presets.sync(input.value.trim()); onChange(input.value.trim()); }
  });
  const validate = () => {
    input.setCustomValidity(validRatio(input.value.trim()) ? "" : "请填写有效的宽:高，例如 3:4 或 2.35:1");
    return input.reportValidity();
  };
  input.addEventListener("blur", validate);
  const node = el("div", { class: "studio-ratio" }, field(label, input), compact ? null : presets);
  node.sync = (v) => { input.value = v; input.setCustomValidity(""); presets.sync(v); };
  node.validate = validate;
  return node;
}

function resourceId(item) { return item.number || item.id; }
function resourceName(item) { return item.nameZh || item.name_zh || item.name || item.generation_name || item.name_en || resourceId(item); }

export function resourcePicker(label, items, value, onChange, empty = "不指定") {
  let selected = value;
  let caption = label;
  const button = el("button", { type: "button", class: "studio-resource" });
  const sync = (v = selected, nextLabel = caption) => {
    selected = v;
    caption = nextLabel;
    const item = items.find((x) => resourceId(x) === selected);
    clear(button);
    button.setAttribute("aria-label", `选择${caption}${item ? `，当前 ${resourceId(item)} ${resourceName(item)}` : ""}`);
    button.append(
      item?.image ? el("img", { src: packImg(item.image), alt: "" }) : el("span", { class: "studio-resource-placeholder", "aria-hidden": "true" }, "+"),
      el("span", { class: "studio-resource-meta" },
        el("small", null, caption + (item ? ` · ${resourceId(item)}` : "")),
        el("strong", null, item ? resourceName(item) : empty),
        el("small", null, item ? "点击更换" : "点击选择"))
    );
  };
  button.addEventListener("click", () => {
    const search = el("input", { class: "input", type: "search", placeholder: "搜索编号、名称或关键词" });
    const grid = el("div", { class: "studio-resource-grid" });
    const count = el("p", { class: "muted", role: "status" });
    const choose = (id) => { sync(id); onChange(id); closeModal(); };
    const render = () => {
      clear(grid);
      const q = search.value.trim().toLowerCase();
      const visible = items.filter((x) => `${resourceId(x)} ${resourceName(x)} ${x.traits || ""} ${x.category || ""}`.toLowerCase().includes(q));
      count.textContent = `${visible.length} 个可选${caption}`;
      visible.forEach((item) => grid.appendChild(el("button", {
        type: "button", class: "studio-resource-option", "aria-pressed": resourceId(item) === selected,
        onClick: () => choose(resourceId(item)),
      },
      item.image ? el("img", { src: packImg(item.image), alt: "", loading: "lazy" }) : null,
      el("small", null, resourceId(item)), el("strong", null, resourceName(item)))));
    };
    search.addEventListener("input", render);
    showModal(`选择${caption}`, el("div", { class: "col" }, field("搜索资源", search), count, grid), [
      el("button", { type: "button", class: "btn", onClick: () => choose("") }, empty),
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
    ]);
    render();
    search.focus();
  });
  sync();
  button.sync = sync;
  return button;
}

export function extraInstructions(state) {
  return [
    state.whitespace && `留白程度：${({ normal: "正常", moderate: "适中", high: "大量" })[state.whitespace]}`,
    state.audience?.trim() && `目标受众：${state.audience.trim()}`,
    state.businessScene?.trim() && `业务场景：${state.businessScene.trim()}`,
    state.mode === "poster" && "海报设计，文字参与构图，突出主标题与视觉层级。",
    state.extra?.trim(),
  ].filter(Boolean).join("\n");
}

// This is an independent implementation of the website's control vocabulary.
export function recipeControls(state, catalog, onChange = () => {}, { article = false, layout = true } = {}) {
  state.mode = state.mode === "pure" ? "pure-image" : (state.mode || "graphic-text");
  state.fusion = state.fusion ?? Boolean(state.style2);
  const change = () => onChange();
  const modes = choices("生成方式", [["graphic-text", "图文"], ["pure-image", "纯图"], ["poster", "海报"]], state.mode, (v) => {
    state.mode = v;
    if (!article) { state.ratio = v === "poster" ? "9:16" : "3:4"; ratio.sync(state.ratio); }
    change();
  });
  const fusion = choices("画风模式", [["single", "单画风"], ["fusion", "双画风融合"]], state.fusion ? "fusion" : "single", (v) => {
    state.fusion = v === "fusion";
    sync(); change();
  });
  const primary = resourcePicker("画风", catalog.styles || [], state.style, (v) => { state.style = v; change(); });
  const secondary = resourcePicker("场景画风", catalog.styles || [], state.style2, (v) => { state.style2 = v; change(); });
  const color = resourcePicker("主题色", catalog.colors || [], state.color, (v) => { state.color = v; change(); }, "随画风");
  const layoutPicker = resourcePicker("图型", catalog.layouts || [], state.layout, (v) => { state.layout = v; change(); }, "自由构图");
  const tone = resourcePicker("影调", catalog.tones || [], state.tone, (v) => { state.tone = v; change(); }, "自然影调");
  const ratio = ratioControl("画幅", state.ratio || "3:4", (v) => { state.ratio = v; change(); });
  const mood = el("input", { class: "input", value: state.mood || "", placeholder: "治愈，诗意，温暖…" });
  const audience = el("input", { class: "input", value: state.audience || "", placeholder: "例如：手账爱好者、都市白领" });
  const business = el("input", { class: "input", value: state.businessScene || "", placeholder: "例如：小红书图文封面" });
  const extra = el("textarea", { class: "textarea", rows: "2", value: state.extra || "", placeholder: "需要保留或避免的画面细节" });
  for (const [input, key] of [[mood, "mood"], [audience, "audience"], [business, "businessScene"], [extra, "extra"]]) {
    input.addEventListener("input", () => { state[key] = input.value; change(); });
  }
  const whitespace = choices("留白", [["", "不限"], ["normal", "正常"], ["moderate", "适中"], ["high", "大量"]], state.whitespace || "", (v) => { state.whitespace = v; change(); });
  const note = el("p", { class: "muted" }, "角色画风决定人物与主体的画法，场景画风决定背景与环境。");
  const more = el("details", { class: "studio-more", open: Boolean(state.moreOpen) },
    el("summary", null, "更多设置"), el("div", { class: "col" },
      tone, field("情绪", mood), whitespace, field("目标受众", audience),
      field("业务场景", business), field("补充要求", extra)));
  more.addEventListener("toggle", () => { state.moreOpen = more.open; change(); });
  const node = el("section", { class: "studio-recipe-controls", "aria-label": "配图设置" },
    modes, fusion, el("div", { class: "studio-resource-row" }, primary, secondary, color, layout ? layoutPicker : null),
    note, article ? null : ratio, more);
  function sync() {
    modes.sync(state.mode);
    fusion.sync(state.fusion ? "fusion" : "single");
    primary.sync(state.style, state.fusion ? "角色画风" : "画风");
    secondary.sync(state.style2);
    secondary.classList.toggle("hidden", !state.fusion);
    note.classList.toggle("hidden", !state.fusion);
    color.sync(state.color); layoutPicker.sync(state.layout); tone.sync(state.tone);
    ratio.sync(state.ratio || "3:4");
    mood.value = state.mood || ""; audience.value = state.audience || "";
    business.value = state.businessScene || ""; extra.value = state.extra || "";
    whitespace.sync(state.whitespace || "");
  }
  sync();
  return { node, sync, validate: () => (article || ratio.validate()) && (!state.fusion || Boolean(state.style && state.style2)), layoutPicker };
}
