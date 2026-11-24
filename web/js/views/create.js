import { api, clear, closeModal, el, galleryImg, localImg, money, onEvent, packImg, showModal, toast } from "../api.js";
import { openRecipeEditor, openRecipeManagerModal } from "./recipes.js";
import { mountSlotPanels } from "../plugins-host.js";
import { bindPageImagePaste, importTempReferenceFile, MAX_REF_IMAGES, openReferencePickerModal } from "./ref-picker.js";
import {
  RATIOS,
  choices,
  extraInstructions,
  field,
  ratioToCss,
  recipeControls,
  resourceId,
  resourceName,
  resourcePicker,
  studioMount,
  studioSession,
} from "./studio-controls.js";

export function buildGroupedModelSelect(modelsData = {}, currentRef = "") {
  const sel = el("select", { class: "select select-sm", style: { maxWidth: "220px" }, "aria-label": "生图模型" });
  const rawSite = modelsData.site;
  const siteModels = Array.isArray(rawSite)
    ? rawSite
    : (rawSite?.specifications || rawSite?.models || rawSite?.items || []);
  const providers = Array.isArray(modelsData.providers) ? modelsData.providers : [];
  const textHint = modelsData.loggedIn ? "网站模型" : "网站模型（需先登录）";

  const gSite = el("optgroup", { label: textHint });
  const seenRefs = new Set();
  for (const m of siteModels) {
    if (m && m.enabled === false) continue;
    const id = m?.model || m?.id || "";
    if (!id) continue;
    const ref = "site:" + id;
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    const note = m.supportsFreeQuota || m.freeQuota ? "可免额" : "";
    const label = [m.label || m.name || id, note].filter(Boolean).join(" · ");
    gSite.appendChild(el("option", { value: ref }, label));
  }
  if (gSite.children.length > 0) sel.appendChild(gSite);

  for (const p of providers) {
    const models = p.models || [];
    if (!models.length) continue;
    const g = el("optgroup", { label: `自定义 · ${p.name}` });
    for (const m of models) {
      const ref = `${p.id}:${m.id}`;
      g.appendChild(el("option", { value: ref }, m.label || m.name || m.id));
    }
    sel.appendChild(g);
  }

  if (sel.options.length === 0) {
    sel.appendChild(el("option", { value: "site:seedream-4.5" }, "Seedream 4.5（默认）"));
  }
  if (currentRef && Array.from(sel.options).some((o) => o.value === currentRef)) {
    sel.value = currentRef;
  } else if (modelsData.defaultModel && Array.from(sel.options).some((o) => o.value === modelsData.defaultModel)) {
    sel.value = modelsData.defaultModel;
  }
  return sel;
}

export function buildGroupedAIModelSelect(modelsData = {}, currentRef = "", capability = "text") {
  const isVision = capability === "vision";
  const sel = el("select", {
    class: "select select-sm",
    style: { maxWidth: "280px" },
    "aria-label": isVision ? "视觉服务接口" : "文字服务接口",
  });
  const siteHint = modelsData.loggedIn ? "网站官方服务" : "网站官方服务（需先登录）";
  const gSite = el("optgroup", { label: siteHint });
  gSite.appendChild(el("option", { value: "site:auto" }, isVision ? "网站官方接口 · 智能视觉服务（平台自动调度）" : "网站官方接口 · 智能文字服务（平台自动调度）"));
  sel.appendChild(gSite);

  const textProvs = Array.isArray(modelsData.textProviders) ? modelsData.textProviders : [];
  for (const p of textProvs) {
    const models = p.models || [];
    if (!models.length) continue;
    const g = el("optgroup", { label: `第三方 OpenAI 接口 · ${p.name}` });
    for (const m of models) {
      const ref = `${p.id}:${m.id}`;
      const note = isVision && m.canVision ? " · 识图" : "";
      g.appendChild(el("option", { value: ref }, `${m.label || m.name || m.id}${note}`));
    }
    sel.appendChild(g);
  }

  const fallbackRef = isVision ? modelsData.defaultVisionModel : modelsData.defaultTextModel;
  const rawTarget = currentRef || fallbackRef || "site:auto";
  const target = rawTarget.startsWith("site:") ? "site:auto" : rawTarget;
  if (target && Array.from(sel.options).some((o) => o.value === target)) {
    sel.value = target;
  } else {
    sel.value = "site:auto";
  }
  return sel;
}

const MODE_LABELS = {
  "graphic-text": "图文",
  "pure-image": "纯图",
  poster: "海报",
};

const SOURCE_LABELS = {
  site: "网站规划",
  provider: "文本模型规划",
  local: "本地规划",
  direct: "提示词直出",
  work: "历史作品",
};

const EXAMPLE_PROMPTS = [
  { tag: "单图", text: "清晨阳光洒进窗台的手冲咖啡桌，温暖治愈的手绘风插画" },
  { tag: "多图", text: "画 4 张周末去菜市场买菜做饭的治愈日常手账，温暖生活气息" },
  { tag: "海报", text: "做一张春日手作市集竖版海报，暖纸手绘插画质感" },
];

const DIRECT_EXAMPLE_PROMPTS = [
  { tag: "英文直出", text: "Cinematic editorial photograph of a sunlit Japanese kissaten coffee counter in Tokyo, pour-over glass carafe, warm morning rays, 35mm Kodak Portra 400 grain, shallow depth of field" },
  { tag: "写实光影", text: "雨后黄昏的京都小巷，湿润石板路倒映着暖黄色灯笼微光，胶片摄影质感，高细节，电影级构图" },
  { tag: "创意设计", text: "Minimalist isometric 3D diorama of a cozy rooftop greenhouse studio, soft clay materials, pastel warm daylight, clean studio background, octane render" },
];

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function splitTokens(raw) {
  return String(raw || "")
    .split(/[,，、+\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function runToTurn(run, fallbackRatio = "3:4", fallbackMode = "graphic-text") {
  const imgs = Array.isArray(run?.images) ? run.images : [];
  let rec = {};
  let meta = {};
  try {
    rec = typeof run.recipe === "string" ? JSON.parse(run.recipe) : (run.recipe || {});
  } catch {}
  try {
    meta = typeof run.meta === "string" ? JSON.parse(run.meta) : (run.meta || {});
  } catch {}
  const isDirect = Boolean(meta.directPrompt);
  const style1 = isDirect ? "" : (rec.styleIds?.[0] || rec.style || "");
  const style2 = isDirect ? "" : (rec.styleIds?.[1] || rec.style2 || "");
  const ratio = meta.ratio || rec.ratio || fallbackRatio || "3:4";
  const mode = isDirect ? "pure-image" : (rec.mode || fallbackMode || "graphic-text");
  const items = imgs.map((im, idx) => ({
    id: uid("it"),
    index: idx + 1,
    title: imgs.length > 1 ? `第 ${idx + 1} 张` : (run.title || "当前画面"),
    subject: (isDirect ? (im.prompt || run.promptZh || run.originalRequest) : (im.theme || run.originalRequest)) || run.title || "",
    displayCopy: "",
    layout: isDirect ? "" : (rec.layoutId || ""),
    layoutName: "",
    ratio,
    mood: isDirect ? "" : (rec.mood || ""),
    status: im.status || "done",
    runId: run.id,
    imageId: im.id,
    path: im.path || "",
    thumb: im.thumb || "",
    width: im.width || 0,
    height: im.height || 0,
    error: im.error || "",
  }));
  return {
    id: uid("turn"),
    userMessage: run.originalRequest || run.title || "历史创作",
    reply: isDirect
      ? `已载入历史直出作品「${run.title || "未命名"}」（未调用手绘 Skill，共 ${items.length} 张）。`
      : `已载入历史作品「${run.title || "未命名"}」（共 ${items.length} 张），可继续对话迭代或单独重绘任意一张。`,
    source: isDirect ? "direct" : "work",
    directPrompt: isDirect,
    kind: items.length > 1 ? "multi" : "single",
    common: {
      style1,
      style1Name: style1,
      style2,
      style2Name: style2,
      mode,
      ratio,
      colors: rec.color ? [rec.color] : (Array.isArray(rec.colors) ? rec.colors : []),
      colorNames: [],
      tones: rec.tone ? [rec.tone] : (Array.isArray(rec.tones) ? rec.tones : []),
      moods: rec.mood ? splitTokens(rec.mood) : [],
      whitespace: "",
      audience: "",
      businessScene: "",
    },
    runIds: run.id ? [run.id] : [],
    items,
  };
}

export async function renderCreate(root, ctx, params = {}) {
  const host = studioMount(root);

  const [stylesRes, layoutsRes, colorsRes, tonesRes, recRes, modRes, settRes, recentRes] = await Promise.all([
    api("GET", "/api/resources/styles").catch(() => ({ items: [] })),
    api("GET", "/api/resources/layouts").catch(() => ({ items: [] })),
    api("GET", "/api/resources/colors").catch(() => ({ items: [] })),
    api("GET", "/api/resources/tones").catch(() => ({ items: [] })),
    api("GET", "/api/mine/recipes").catch(() => ({ items: [] })),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [] })),
    api("GET", "/api/settings").catch(() => ({ settings: {} })),
    api("GET", "/api/works?limit=12&hasImages=1").catch(() => ({ items: [] })),
  ]);
  if (!host.isConnected) return;

  const styles = stylesRes.items || [];
  const layouts = layoutsRes.items || [];
  const colors = colorsRes.items || [];
  const tones = tonesRes.items || [];
  let recipes = recRes.items || [];
  const settings = settRes.settings || {};

  const p = params.preset || params.recipe || {};
  const session = studioSession(host, "studio", {
    directPrompt: false,
    directCount: 1,
    recipeId: params.recipe?.id || "",
    style: "",
    style2: "",
    fusion: false,
    layout: "",
    color: "",
    tone: "",
    mood: "",
    mode: "graphic-text",
    ratio: settings.defaultRatio || "3:4",
    whitespace: "",
    audience: "",
    businessScene: "",
    extra: "",
    resolution: settings.defaultResolution || "2k",
    quality: "standard",
    redraw: false,
    modelRef: modRes.defaultModel || "site:seedream-4.5",
    refs: [],
    galleryRefs: [],
    parentId: "",
    groupId: "",
    forkOf: "",
    forkTitle: "",
    draftInput: "",
    turns: [],
    activeTurnIndex: -1,
    selectedItemIndex: 0,
    viewMode: "focused",
    composerMode: "chat",
    composerExpanded: false,
    recentRuns: recentRes.items || [],
  });
  root = session.root;
  const state = session.state;
  state.recentRuns = recentRes.items || state.recentRuns || [];

  // Apply incoming route handoff params (from Home, Atlas, Works, Plugins, etc.)
  if (Object.keys(params).length) {
    if (params.directPrompt !== undefined) {
      state.directPrompt = Boolean(params.directPrompt);
    } else if (params.recipe || params.style || params.preset) {
      state.directPrompt = false;
    }
    for (const key of ["style", "style2", "layout", "color", "tone", "mood", "mode", "ratio", "resolution", "modelRef", "parentId", "groupId", "forkOf", "forkTitle"]) {
      const value = params[key] ?? p[key];
      if (value !== undefined) state[key] = value;
    }
    if (p.styleIds) {
      state.style = p.styleIds[0] || "";
      state.style2 = p.styleIds[1] || "";
    }
    if (p.layoutId !== undefined) state.layout = p.layoutId;
    if (p.colors) state.color = Array.isArray(p.colors) ? (p.colors[0] || "") : String(p.colors || "");
    if (p.tones) state.tone = Array.isArray(p.tones) ? (p.tones[0] || "") : String(p.tones || "");
    if (params.recipe?.id) state.recipeId = params.recipe.id;
    if (params.refs || params.editImage) state.refs = Array.isArray(params.refs) ? [...params.refs] : [params.editImage];
    if (Array.isArray(params.galleryRefs)) {
      state.galleryRefs = [...params.galleryRefs];
    } else if (params.galleryRef && params.galleryRef.kind && params.galleryRef.id) {
      const list = Array.isArray(state.galleryRefs) ? state.galleryRefs : [];
      const exists = list.some((g) => g.kind === params.galleryRef.kind && g.id === params.galleryRef.id && (g.variant || "") === (params.galleryRef.variant || ""));
      state.galleryRefs = exists ? list : [...list, params.galleryRef];
    }
    if (params.theme) {
      state.draftInput = params.theme;
      state.composerMode = "chat";
    }
    if (params.run) {
      const turn = runToTurn(params.run, state.ratio, state.mode);
      state.turns = [...(state.turns || []), turn];
      state.activeTurnIndex = state.turns.length - 1;
      state.selectedItemIndex = 0;
      state.viewMode = "focused";
      state.composerMode = "chat";
    }
    state.fusion = Boolean(state.style2);
  }

  // Runtime transient state
  let isPlanning = false;
  let planningPrompt = "";
  let isSubmitting = false;
  let lastStageRenderKey = "";

  const currentTurn = () => {
    if (!Array.isArray(state.turns) || state.activeTurnIndex < 0 || state.activeTurnIndex >= state.turns.length) {
      return null;
    }
    return state.turns[state.activeTurnIndex];
  };

  const currentItem = () => {
    const turn = currentTurn();
    if (!turn || !turn.items?.length) return null;
    const idx = Math.max(0, Math.min(state.selectedItemIndex || 0, turn.items.length - 1));
    state.selectedItemIndex = idx;
    return turn.items[idx];
  };

  const turnHasRunning = (turn) => Boolean(turn?.items?.some((it) => it.status === "queued" || it.status === "running"));

  // ---------- Header ----------
  const headerSubtitle = el("span", { class: "muted" }, "一个工作台同时支持单图与多图规划，左侧随时调配画风、图型与单张属性");
  const rollDiceBtn = el("button", { type: "button", class: "btn btn-sm", onClick: rollDice }, "🎲 摇灵感");
  const saveRecipeBtn = el("button", { type: "button", class: "btn btn-sm", onClick: saveCurrentRecipe }, "💾 存为配方");
  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row", style: { gap: "10px", flexWrap: "wrap" } },
      el("h1", { class: "page-title" }, "生图"),
      headerSubtitle
    ),
    el("div", { class: "row" },
      rollDiceBtn,
      saveRecipeBtn,
      el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("atlas") }, "📖 逛画廊")
    )
  ));

  // ---------- Left Pane: Shared Properties + Selected Item Inspector ----------
  const recSel = el("select", { class: "select select-sm", style: { flex: "1", minWidth: "0" }, "aria-label": "快速套用配方" });
  function renderRecipeOptions() {
    clear(recSel);
    recSel.appendChild(el("option", { value: "" }, "— 套用常用配方 —"));
    recipes.forEach((r) => {
      recSel.appendChild(el("option", { value: r.id }, `${r.name} (${(r.styleIds || []).join("+")})`));
    });
    if (state.recipeId && recipes.some((x) => x.id === state.recipeId)) {
      recSel.value = state.recipeId;
    } else {
      recSel.value = "";
    }
  }
  function applyRecipeObj(r) {
    if (!r) return;
    state.recipeId = r.id || "";
    state.style = r.styleIds?.[0] || "";
    state.style2 = r.styleIds?.[1] || "";
    state.fusion = Boolean(state.style2);
    state.layout = r.layoutId || "";
    state.color = r.colors?.[0] || "";
    state.tone = r.tones?.[0] || "";
    state.mood = r.mood || "";
    state.ratio = r.ratio || state.ratio;
    state.mode = r.mode || state.mode;
    recSel.value = state.recipeId;
    syncLeftControls();
    renderSelectedSlot();
    renderOutput();
    refreshQuote();
    session.persist();
  }
  async function reloadRecipes() {
    const r = await api("GET", "/api/mine/recipes").catch(() => ({ items: [] }));
    recipes = r.items || [];
    renderRecipeOptions();
  }
  function openRecipesManager() {
    openRecipeManagerModal({
      activeRecipeId: state.recipeId,
      onApply: (rec) => {
        applyRecipeObj(rec);
        toast(`已套用配方：${rec.name}`);
      },
      onChanged: reloadRecipes,
    });
  }
  renderRecipeOptions();
  recSel.addEventListener("change", () => {
    const r = recipes.find((x) => x.id === recSel.value);
    if (!r) return;
    applyRecipeObj(r);
  });

  const controls = recipeControls(state, { styles, layouts, colors, tones }, () => {
    renderSelectedSlot();
    if (!currentTurn()) renderOutput();
    refreshQuote();
    session.persist();
  }, { hasDefaultStyle: false });

  const resChoices = choices("清晰度", [["1k", "1K"], ["2k", "2K"], ["4k", "4K"]], state.resolution, (v) => {
    state.resolution = v;
    refreshQuote();
    session.persist();
  }, { inline: true });

  const qualChoices = choices("质量", [["standard", "标准"], ["high", "高质量"]], state.quality, (v) => {
    state.quality = v;
    refreshQuote();
    session.persist();
  }, { inline: true });

  const redrawChk = el("input", { type: "checkbox", checked: Boolean(state.redraw) });
  redrawChk.addEventListener("change", () => {
    state.redraw = redrawChk.checked;
    session.persist();
  });

  // Dynamic per-card selected slot inspector (aligned with handraw-web #sc-selected-slot)
  const selectedSlotBox = el("section", {
    id: "sc-selected-slot",
    class: "sc-selected-slot hidden",
    "aria-label": "当前选中图单张属性",
  });

  function renderSelectedSlot() {
    clear(selectedSlotBox);
    const turn = currentTurn();
    const item = currentItem();
    if (!turn || !item) {
      selectedSlotBox.classList.add("hidden");
      return;
    }
    selectedSlotBox.classList.remove("hidden");
    const isMulti = turn.items.length > 1;
    const idx = state.selectedItemIndex;
    const badgeText = isMulti ? `图 ${idx + 1}` : "当前画面";

    const head = el("div", { class: "sc-selected-slot-head" },
      el("div", { class: "row", style: { gap: "6px" } },
        el("span", { class: "badge badge-accent" }, badgeText),
        el("strong", { style: { fontSize: "12.5px" } }, "单张属性")
      ),
      isMulti
        ? el("button", {
            type: "button",
            class: "btn btn-sm",
            style: { color: "var(--err, #b83227)" },
            onClick: () => deleteItemAt(idx),
          }, "删除")
        : null
    );
    selectedSlotBox.appendChild(head);

    const isDirectSlot = Boolean(turn.directPrompt || state.directPrompt);
    if (!isDirectSlot && state.mode !== "pure-image") {
      const itemLayoutPicker = resourcePicker(
        "本图图型",
        layouts,
        item.layout || "",
        (lid) => {
          item.layout = lid || "";
          const found = layouts.find((l) => resourceId(l) === lid);
          item.layoutName = found ? resourceName(found) : "";
          renderPlanStrip();
          renderStage(true);
          session.persist();
        },
        "跟随全局",
        { allowClear: true }
      );
      selectedSlotBox.appendChild(itemLayoutPicker);
    }

    const ratioSel = el("select", { class: "select select-sm", style: { flex: "1" }, "aria-label": "单张比例" });
    const curRatio = item.ratio || state.ratio || "3:4";
    const ratioValues = new Set(RATIOS.map(([v]) => v));
    RATIOS.forEach(([v, lbl]) => {
      ratioSel.appendChild(el("option", { value: v }, `${lbl} (${v})`));
    });
    if (!ratioValues.has(curRatio)) {
      ratioSel.appendChild(el("option", { value: curRatio }, `自定义 (${curRatio})`));
    }
    ratioSel.value = curRatio;
    ratioSel.addEventListener("change", () => {
      item.ratio = ratioSel.value;
      renderStage(true);
      session.persist();
    });
    selectedSlotBox.appendChild(el("div", { class: "studio-more-row" },
      el("span", { class: "studio-row-label" }, "单张比例"),
      ratioSel
    ));

    if (!isDirectSlot && state.mode !== "pure-image") {
      const copyIn = el("input", {
        class: "input",
        type: "text",
        value: item.displayCopy || "",
        placeholder: "本图画面内文字（可留空）",
      });
      copyIn.addEventListener("input", () => {
        item.displayCopy = copyIn.value;
        session.persist();
      });
      selectedSlotBox.appendChild(field("本图文字（可选）", copyIn));
    }

    selectedSlotBox.appendChild(el("div", { class: "sc-selected-slot-hint muted" },
      "本图提示词与参考图 · 在右侧底部输入框修改"
    ));
  }

  // Recent works strip
  const recentBox = el("div", { class: "studio-recent-strip" });
  const recentSummaryText = el("span", null, `最近创作 (${Math.min(8, (state.recentRuns || []).length)})`);
  function renderRecentRuns() {
    clear(recentBox);
    const list = (state.recentRuns || []).slice(0, 8);
    recentSummaryText.textContent = `最近创作 (${list.length})`;
    if (!list.length) {
      recentBox.appendChild(el("span", { class: "muted", style: { gridColumn: "1 / -1" } }, "暂无历史创作"));
      return;
    }
    const activeTurn = currentTurn();
    list.forEach((run) => {
      const im = run.images?.[0];
      const src = im?.thumb ? localImg(im.thumb) : (im?.path ? localImg(im.path) : "/img/logo.svg");
      const isActive = Boolean(activeTurn?.runIds?.includes(run.id));
      recentBox.appendChild(el("button", {
        type: "button",
        class: "studio-recent-thumb" + (isActive ? " is-active" : ""),
        title: run.title || run.originalRequest || "作品",
        onClick: async () => {
          try {
            const detail = await api("GET", `/api/works/${encodeURIComponent(run.id)}`);
            const turn = runToTurn(detail.run, state.ratio, state.mode);
            state.turns = [...(state.turns || []), turn];
            state.activeTurnIndex = state.turns.length - 1;
            state.selectedItemIndex = 0;
            state.viewMode = "focused";
            state.composerMode = "chat";
            lastStageRenderKey = "";
            renderAll();
            session.persist();
          } catch (e) { toast(e.message); }
        },
      },
        el("img", { src, alt: run.title || "" }),
        el("span", null, run.title || "未命名")
      ));
    });
  }

  const modeSkillBtn = el("button", {
    type: "button",
    class: "mode-seg-btn",
    "data-studio-mode": "skill",
    onClick: () => setStudioDirectMode(false),
  }, "🎨 手绘 Skill");

  const modeDirectBtn = el("button", {
    type: "button",
    class: "mode-seg-btn",
    "data-studio-mode": "direct",
    onClick: () => setStudioDirectMode(true),
  }, "⚡ 直出（不用 Skill）");

  const studioModeSwitch = el("div", {
    class: "mode-seg-switch",
    role: "group",
    "aria-label": "生图引擎模式",
  }, modeSkillBtn, modeDirectBtn);

  const directHintCard = el("div", { class: "direct-mode-callout hidden" },
    el("strong", null, "⚡ 提示词直出模式"),
    el("span", null, "跳过手绘 Skill 与 AI 规划，将你的完整提示词原样发给生图模型，适合外部采集、Midjourney / GPT 等通用提示词直接出图。")
  );

  const directCountChoices = choices("生成张数", [["1", "1 张"], ["2", "2 张"], ["4", "4 张"]], String(state.directCount || 1), (v) => {
    state.directCount = Math.max(1, Math.min(4, Number(v) || 1));
    refreshQuote();
    session.persist();
  }, { inline: true });

  const recipeRow = el("div", { class: "studio-more-row" },
    el("span", { class: "studio-row-label" }, "配方"),
    recSel,
    el("button", {
      type: "button",
      class: "btn btn-sm",
      id: "btn-manage-recipes",
      title: "查看、新建、编辑或导入导出配方",
      onClick: openRecipesManager,
    }, "管理")
  );

  const redrawRow = el("label", { class: "row", style: { cursor: "pointer", fontSize: "12.5px" } }, redrawChk, el("span", null, "照片重绘（参考原图结构重绘）"));

  function setStudioDirectMode(on) {
    const next = Boolean(on);
    if (Boolean(state.directPrompt) === next) return;
    state.directPrompt = next;
    syncLeftControls();
    syncComposerState();
    renderSelectedSlot();
    if (!currentTurn()) renderOutput();
    refreshQuote();
    session.persist();
  }

  const leftPane = el("section", { class: "make-image-properties", "aria-label": "画面属性" },
    studioModeSwitch,
    directHintCard,
    recipeRow,
    controls.node,
    directCountChoices,
    resChoices,
    qualChoices,
    redrawRow,
    selectedSlotBox,
    el("details", { class: "studio-more-card" },
      el("summary", { class: "studio-more-summary" },
        recentSummaryText,
        el("span", { class: "studio-more-chevron", "aria-hidden": "true" })
      ),
      el("div", { class: "studio-more-body" }, recentBox)
    )
  );

  // ---------- Right Pane: Output Scroll + Unified Composer ----------
  const forkBanner = el("div", { class: "insp-fork-banner hidden" });
  function renderForkBanner() {
    clear(forkBanner);
    if (!state.forkOf && !state.forkTitle) {
      forkBanner.classList.add("hidden");
      return;
    }
    forkBanner.classList.remove("hidden");
    forkBanner.append(
      el("span", null, `✨ 正在做《${state.forkTitle || state.forkOf}》的同款${state.forkOf ? "（生成后原作者将获 +2 积分激励）" : ""}`),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => {
          state.forkOf = "";
          state.forkTitle = "";
          renderForkBanner();
          session.persist();
        },
      }, "✕ 清除")
    );
  }
  renderForkBanner();

  const turnBar = el("div", { class: "sc-turn-bar hidden", role: "tablist", "aria-label": "对话轮次" });
  const planStrip = el("div", { class: "sc-plan-strip hidden" });
  const stageBox = el("div", { class: "sc-stage-wrap" });
  const gridBox = el("div", { class: "sc-grid-view hidden" });
  const thumbRail = el("div", { class: "sc-thumb-rail hidden", role: "group", "aria-label": "画面缩略图列表" });

  const outputScroll = el("div", { class: "make-image-output-scroll" },
    forkBanner,
    turnBar,
    planStrip,
    stageBox,
    gridBox,
    thumbRail
  );

  // Composer elements
  const refsStrip = el("div", { class: "make-image-composer-attachments hidden" });
  const fileInput = el("input", { type: "file", accept: "image/*", multiple: true, class: "hidden" });

  async function importReferenceFile(file) {
    if (!file) return;
    const current = Array.isArray(state.refs) ? state.refs : [];
    if (current.length >= MAX_REF_IMAGES) {
      toast(`参考图最多 ${MAX_REF_IMAGES} 张，请先移除一张`);
      return;
    }
    try {
      const path = await importTempReferenceFile(file);
      if (path) {
        if (!current.includes(path)) {
          state.refs = [...current, path];
          renderRefs();
          session.persist();
          toast("已添加参考图");
        } else {
          toast("该参考图已在当前列表里");
        }
      }
    } catch (e) { toast(e.message); }
  }

  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    for (const f of files) {
      await importReferenceFile(f);
    }
    fileInput.value = "";
  });

  function renderRefs() {
    clear(refsStrip);
    const gRefs = Array.isArray(state.galleryRefs) ? state.galleryRefs : [];
    const localRefs = Array.isArray(state.refs) ? state.refs : [];
    refsStrip.classList.toggle("hidden", localRefs.length === 0 && gRefs.length === 0);
    gRefs.forEach((gr, idx) => {
      const label = `${gr.galleryName || gr.kind} · ${gr.name || gr.id}`;
      refsStrip.appendChild(el("div", { class: "make-image-ref-thumb", title: label },
        gr.imageUrl
          ? el("img", { src: galleryImg(gr.imageUrl), alt: label })
          : el("span", { class: "badge badge-accent", style: { padding: "6px 8px", display: "inline-flex", alignItems: "center" } }, label),
        el("button", {
          type: "button",
          "aria-label": `移除画廊参考 ${label}`,
          title: `移除 ${label}`,
          onClick: () => {
            state.galleryRefs.splice(idx, 1);
            renderRefs();
            session.persist();
          },
        }, "×")
      ));
    });
    localRefs.forEach((rp, idx) => {
      refsStrip.appendChild(el("div", { class: "make-image-ref-thumb" },
        el("img", { src: localImg(rp), alt: `参考图 ${idx + 1}` }),
        el("button", {
          type: "button",
          "aria-label": `移除参考图 ${idx + 1}`,
          title: "移除参考图",
          onClick: () => {
            state.refs.splice(idx, 1);
            renderRefs();
            session.persist();
          },
        }, "×")
      ));
    });
  }

  const expandComposerBtn = el("button", {
    type: "button",
    class: "sc-composer-expand-btn",
    title: "展开输入框",
    "aria-label": "展开输入框",
    "aria-expanded": "false",
    onClick: () => {
      state.composerExpanded = !state.composerExpanded;
      syncComposerExpand();
      subjectInput.focus();
    },
  }, "⤢");

  const modeChatBtn = el("button", {
    type: "button",
    class: "sc-composer-mode-btn",
    onClick: () => {
      state.composerMode = "chat";
      syncComposerState();
      subjectInput.focus();
    },
  }, "继续对话");

  const modeImageBtn = el("button", {
    type: "button",
    class: "sc-composer-mode-btn",
    onClick: () => {
      if (!currentItem()) return;
      state.composerMode = "image";
      syncComposerState();
      subjectInput.focus();
    },
  }, "当前画面提示词");

  const composerModesBar = el("div", {
    class: "sc-composer-modes hidden",
    role: "group",
    "aria-label": "输入范围",
  }, modeChatBtn, modeImageBtn);

  const subjectInput = el("textarea", {
    class: "make-image-composer-subject",
    rows: "3",
    "aria-label": "创作描述",
    placeholder: "描述想画的内容，支持单图或一次规划多张（如：画 4 张咖啡店治愈日常手账，或每行写一条场景）…（Ctrl/⌘ + Enter 发送）",
  });

  function autoResizeTextarea() {
    if (state.composerExpanded) {
      subjectInput.style.height = "";
      return;
    }
    subjectInput.style.height = "auto";
    const next = Math.min(180, Math.max(66, subjectInput.scrollHeight));
    subjectInput.style.height = `${next}px`;
  }

  subjectInput.addEventListener("input", () => {
    const item = currentItem();
    if (state.composerMode === "image" && item) {
      item.subject = subjectInput.value;
    } else {
      state.draftInput = subjectInput.value;
    }
    autoResizeTextarea();
  });

  subjectInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.composerExpanded) {
      e.preventDefault();
      state.composerExpanded = false;
      syncComposerExpand();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handleComposerSubmit();
    }
  });

  const addRefBtn = el("button", {
    type: "button",
    class: "make-image-add-reference",
    title: "从自建图库选择、上传或粘贴参考图（也支持直接 Ctrl/⌘ + V 粘贴）",
    "aria-label": "添加参考图",
    onClick: () => openReferencePickerModal({
      currentRefs: state.refs || [],
      maxCount: MAX_REF_IMAGES,
      title: "选择参考图（自建图库 / 本地上传 / 粘贴）",
      onConfirm: (nextRefs) => {
        state.refs = nextRefs;
        renderRefs();
        session.persist();
      },
    }),
  }, "+");

  const modelSel = buildGroupedModelSelect(modRes, state.modelRef);
  state.modelRef = modelSel.value;
  modelSel.addEventListener("change", () => {
    state.modelRef = modelSel.value;
    refreshQuote();
    session.persist();
  });

  const quoteBadge = el("span", { class: "badge", title: "生成前预估费用" }, "报价计算中…");

  const clearBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: () => {
      if (state.composerMode === "image") {
        const item = currentItem();
        if (item) item.subject = "";
      } else {
        state.draftInput = "";
      }
      state.refs = [];
      state.galleryRefs = [];
      subjectInput.value = "";
      autoResizeTextarea();
      renderRefs();
      session.persist();
    },
  }, "清空表单");

  const stopBtn = el("button", {
    type: "button",
    class: "btn btn-sm hidden",
    style: { color: "var(--err, #b83227)", borderColor: "var(--err, #b83227)" },
    onClick: () => cancelTurnRunning(currentTurn()),
  }, "停止生成");

  const submitBtn = el("button", { type: "submit", class: "btn btn-primary" }, "开始生成");

  const composer = el("form", { class: "make-image-composer", action: "/api/studio/chat-plan", method: "post" },
    expandComposerBtn,
    fileInput,
    composerModesBar,
    refsStrip,
    subjectInput,
    el("div", { class: "make-image-composer-bottom" },
      addRefBtn,
      modelSel,
      quoteBadge,
      el("div", { class: "make-image-composer-actions" }, clearBtn, stopBtn, submitBtn)
    )
  );
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    handleComposerSubmit();
  });
  bindPageImagePaste(composer, async (files) => {
    for (const f of files) await importReferenceFile(f);
  });
  composer.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      composer.classList.add("is-dragover");
    }
  });
  composer.addEventListener("dragleave", () => composer.classList.remove("is-dragover"));
  composer.addEventListener("drop", async (e) => {
    composer.classList.remove("is-dragover");
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      for (const f of files) await importReferenceFile(f);
    }
  });

  const conversation = el("section", { class: "make-image-conversation", "aria-label": "画面输出与对话输入" },
    outputScroll,
    composer
  );

  const workspace = el("div", { class: "make-image-chat-workspace" }, leftPane, conversation);
  const slotContainer = el("div", { class: "studio-slot-container" });
  root.append(workspace, slotContainer);

  mountSlotPanels(slotContainer, "create-footer", {
    view: "create",
    recipe: () => ({
      style: state.style,
      style2: state.fusion ? state.style2 : "",
      layout: state.layout,
      color: state.color,
      tone: state.tone,
      mode: state.mode,
      ratio: state.ratio,
    }),
    applyTheme: (t) => {
      state.composerMode = "chat";
      state.draftInput = t;
      syncComposerState();
      subjectInput.focus();
    },
  });

  // ---------- Rendering & Sync helpers ----------
  function syncLeftControls() {
    const isDirect = Boolean(state.directPrompt);
    modeSkillBtn.classList.toggle("is-active", !isDirect);
    modeDirectBtn.classList.toggle("is-active", isDirect);
    modeSkillBtn.setAttribute("aria-pressed", String(!isDirect));
    modeDirectBtn.setAttribute("aria-pressed", String(isDirect));
    directHintCard.classList.toggle("hidden", !isDirect);
    directCountChoices.classList.toggle("hidden", !isDirect);
    recipeRow.classList.toggle("hidden", isDirect);
    redrawRow.classList.toggle("hidden", isDirect);
    rollDiceBtn.classList.toggle("hidden", isDirect);
    saveRecipeBtn.classList.toggle("hidden", isDirect);
    headerSubtitle.textContent = isDirect
      ? "提示词直出模式：跳过手绘 Skill，将你的完整提示词原样发给生图模型"
      : "一个工作台同时支持单图与多图规划，左侧随时调配画风、图型与单张属性";
    controls.setDirectMode(isDirect);
    controls.sync();
    directCountChoices.sync(String(state.directCount || 1));
    resChoices.sync(state.resolution);
    qualChoices.sync(state.quality);
    redrawChk.checked = Boolean(state.redraw);
    if (state.recipeId) recSel.value = state.recipeId;
  }

  function syncComposerExpand() {
    const exp = Boolean(state.composerExpanded);
    composer.classList.toggle("is-expanded", exp);
    expandComposerBtn.textContent = exp ? "⤡" : "⤢";
    expandComposerBtn.title = exp ? "收起输入框 (Esc)" : "展开输入框";
    expandComposerBtn.setAttribute("aria-label", exp ? "收起输入框" : "展开输入框");
    expandComposerBtn.setAttribute("aria-expanded", String(exp));
    autoResizeTextarea();
  }

  function syncComposerState() {
    const turn = currentTurn();
    const item = currentItem();
    if (!turn || !item) {
      state.composerMode = "chat";
      composerModesBar.classList.add("hidden");
    } else {
      composerModesBar.classList.remove("hidden");
      const isMulti = turn.items.length > 1;
      modeImageBtn.textContent = isMulti ? `图 ${state.selectedItemIndex + 1} 提示词` : "当前画面提示词";
      modeChatBtn.classList.toggle("is-active", state.composerMode === "chat");
      modeImageBtn.classList.toggle("is-active", state.composerMode === "image");
    }

    const isDirect = Boolean(state.directPrompt);
    if (state.composerMode === "image" && item) {
      subjectInput.value = item.subject || "";
      subjectInput.placeholder = isDirect
        ? "直接修改当前画面的直出提示词，点击右侧按钮只重绘这一张…（Ctrl/⌘ + Enter）"
        : "直接修改当前画面的描述词，点击右侧按钮只重绘这一张…（Ctrl/⌘ + Enter）";
      submitBtn.textContent = item.status === "done" ? "重绘此图" : "生成这张";
    } else if (isDirect) {
      subjectInput.value = state.draftInput || "";
      subjectInput.placeholder = "直接粘贴或输入完整生图提示词（中英文均可），将跳过手绘 Skill 原样发给生图模型…（Ctrl/⌘ + Enter 直出）";
      submitBtn.textContent = "⚡ 直接生图";
    } else {
      subjectInput.value = state.draftInput || "";
      subjectInput.placeholder = turn
        ? "继续补充或调整需求，例如：整体色调更暖一点、改成 4 张分镜…（Ctrl/⌘ + Enter 发送）"
        : "描述想画的内容，支持单图或一次规划多张（如：画 4 张咖啡店治愈日常手账，或每行写一条场景）…（Ctrl/⌘ + Enter 发送）";
      submitBtn.textContent = isPlanning ? "规划中…" : (turn ? "发送并生成" : "开始生成");
    }

    submitBtn.disabled = isPlanning || isSubmitting;
    stopBtn.classList.toggle("hidden", !turnHasRunning(turn));
    autoResizeTextarea();
    refreshQuote();
  }

  function renderTurnBar() {
    clear(turnBar);
    if (!state.turns?.length) {
      turnBar.classList.add("hidden");
      return;
    }
    turnBar.classList.remove("hidden");
    const pillsWrap = el("div", { class: "sc-turn-pills" });
    state.turns.forEach((t, idx) => {
      const cnt = t.items?.length || 0;
      const label = cnt > 1 ? `第 ${idx + 1} 轮（${cnt}张）` : `第 ${idx + 1} 轮`;
      pillsWrap.appendChild(el("button", {
        type: "button",
        role: "tab",
        class: "sc-turn-pill" + (idx === state.activeTurnIndex ? " is-active" : ""),
        "aria-selected": String(idx === state.activeTurnIndex),
        title: t.userMessage || label,
        onClick: () => {
          state.activeTurnIndex = idx;
          state.selectedItemIndex = 0;
          lastStageRenderKey = "";
          renderAll();
          session.persist();
        },
      }, label));
    });
    const newChatBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: () => {
        state.turns = [];
        state.activeTurnIndex = -1;
        state.selectedItemIndex = 0;
        state.viewMode = "focused";
        state.composerMode = "chat";
        lastStageRenderKey = "";
        renderAll();
        session.persist();
        subjectInput.focus();
      },
    }, "＋ 新对话");
    turnBar.append(pillsWrap, newChatBtn);
  }

  function renderPlanStrip() {
    clear(planStrip);
    const turn = currentTurn();
    if (!turn || isPlanning) {
      planStrip.classList.add("hidden");
      return;
    }
    planStrip.classList.remove("hidden");

    const items = turn.items || [];
    const total = items.length;
    const isMulti = total > 1;
    const doneItems = items.filter((it) => it.status === "done" && it.path);
    const running = turnHasRunning(turn);
    const pendingItems = items.filter((it) => it.status === "idle" || it.status === "failed" || it.status === "canceled");

    const actions = el("div", { class: "sc-plan-actions" });

    if (isMulti) {
      actions.appendChild(el("div", { class: "sc-view-toggle", role: "group", "aria-label": "浏览视图" },
        el("button", {
          type: "button",
          class: "sc-view-toggle-btn" + (state.viewMode !== "grid" ? " is-active" : ""),
          onClick: () => {
            state.viewMode = "focused";
            lastStageRenderKey = "";
            renderOutput();
            session.persist();
          },
        }, "单张大图"),
        el("button", {
          type: "button",
          class: "sc-view-toggle-btn" + (state.viewMode === "grid" ? " is-active" : ""),
          onClick: () => {
            state.viewMode = "grid";
            renderOutput();
            session.persist();
          },
        }, "网格总览")
      ));
    }

    if (doneItems.length >= 2) {
      const exportRunId = doneItems.find((it) => it.runId)?.runId || turn.runIds?.[turn.runIds.length - 1];
      if (exportRunId) {
        actions.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => exportTurnRun(exportRunId, "zip"),
        }, "📦 导出 ZIP"));
        actions.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => exportTurnRun(exportRunId, "xiaohongshu"),
        }, "📕 小红书 3:4"));
      }
    }

    if (running) {
      actions.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => cancelTurnRunning(turn),
      }, "停止生成"));
    } else if (pendingItems.length > 0) {
      actions.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => generateTurnItems(turn, pendingItems, false),
      }, pendingItems.length === total ? `开始生成全部 ${total} 张` : `继续生成剩余 ${pendingItems.length} 张`));
    } else if (total > 0) {
      actions.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => generateTurnItems(turn, items, false),
      }, isMulti ? `重新生成全部 ${total} 张` : "重新生成"));
    }

    const common = turn.common || {};
    const isDirectTurn = Boolean(turn.directPrompt);
    const styleObj = !isDirectTurn ? styles.find((s) => s.number === (common.style1 || state.style)) : null;
    const styleLabel = !isDirectTurn && common.style1
      ? `${common.style1} ${common.style1Name || (styleObj ? resourceName(styleObj) : "")}`.trim()
      : "";
    const meta = isDirectTurn
      ? el("div", { class: "sc-meta-chips" },
          el("span", { class: "badge badge-accent" }, isMulti ? `⚡ 提示词直出 · ${doneItems.length}/${total} 张` : "⚡ 提示词直出"),
          el("span", { class: "badge" }, common.ratio || state.ratio || "3:4"),
          el("span", { class: "badge" }, "未调用手绘 Skill")
        )
      : el("div", { class: "sc-meta-chips" },
          el("span", { class: "badge badge-accent" }, isMulti ? `多图 · ${doneItems.length}/${total} 张` : "单图方案"),
          styleLabel ? el("span", { class: "badge" }, styleLabel + (common.style2 ? ` + ${common.style2}` : "")) : null,
          el("span", { class: "badge" }, MODE_LABELS[common.mode || state.mode] || "图文"),
          el("span", { class: "badge" }, common.ratio || state.ratio || "3:4"),
          common.colors?.length ? el("span", { class: "badge" }, (common.colorNames?.length ? common.colorNames : common.colors).join(" + ")) : null,
          turn.source ? el("span", { class: "badge" }, SOURCE_LABELS[turn.source] || turn.source) : null
        );

    planStrip.append(
      el("div", { class: "sc-plan-top" },
        el("p", { class: "sc-plan-reply" }, turn.reply || turn.userMessage || ""),
        actions
      ),
      meta
    );
  }

  function renderEmptyOrThinking() {
    clear(stageBox);
    gridBox.classList.add("hidden");
    thumbRail.classList.add("hidden");
    lastStageRenderKey = "";

    if (isPlanning) {
      stageBox.appendChild(el("div", { class: "sc-thinking-card" },
        el("span", { class: "dot-pulse" }),
        el("strong", null, "正在结合手绘风画风库规划画面方案…"),
        planningPrompt ? el("p", { class: "muted", style: { margin: 0, maxWidth: "520px", textAlign: "center" } }, `「${planningPrompt.slice(0, 80)}」`) : null
      ));
      return;
    }

    // Build zero-cost active recipe preview chips if user selected anything on the left
    const styleObj = state.style ? styles.find((x) => x.number === state.style) : null;
    const style2Obj = state.fusion && state.style2 ? styles.find((x) => x.number === state.style2) : null;
    const layoutObj = state.layout ? layouts.find((x) => x.id === state.layout) : null;
    const colorObj = state.color ? colors.find((x) => x.id === state.color) : null;

    const previewChips = [
      styleObj && { img: styleObj.image ? packImg(styleObj.image) : "", label: `${styleObj.number} ${resourceName(styleObj)}` },
      style2Obj && { img: style2Obj.image ? packImg(style2Obj.image) : "", label: `+ ${style2Obj.number}` },
      layoutObj && { img: layoutObj.image ? packImg(layoutObj.image) : "", label: `${layoutObj.id} ${resourceName(layoutObj)}` },
      colorObj && { img: colorObj.image ? packImg(colorObj.image) : "", label: `${colorObj.id} ${resourceName(colorObj)}` },
    ].filter(Boolean);

    const isDirect = Boolean(state.directPrompt);
    const activeExamples = isDirect ? DIRECT_EXAMPLE_PROMPTS : EXAMPLE_PROMPTS;
    const exampleRow = el("div", { class: "sc-example-prompts" },
      ...activeExamples.map((ex) => el("button", {
        type: "button",
        class: "sc-example-btn",
        onClick: () => {
          state.draftInput = ex.text;
          state.composerMode = "chat";
          syncComposerState();
          subjectInput.focus();
        },
      },
        el("span", { class: "badge badge-accent" }, ex.tag),
        el("span", null, ex.text)
      ))
    );

    if (isDirect) {
      stageBox.appendChild(el("div", { class: "sc-empty-state" },
        el("div", { class: "sc-empty-icon", "aria-hidden": "true" }, "⚡"),
        el("h2", { class: "sc-empty-title" }, "提示词直出 · 原样生图"),
        el("p", { class: "muted sc-empty-desc" },
          "已关闭手绘 Skill 与 AI 改写，直接粘贴外部采集或自写的完整提示词（中英文均可），将按原样直达生图模型。"
        ),
        el("div", { class: "row", style: { justifyContent: "center", gap: "6px", flexWrap: "wrap" } },
          el("span", { class: "badge badge-accent" }, "⚡ 跳过手绘 Skill"),
          el("span", { class: "badge" }, `${state.ratio} · ${state.resolution.toUpperCase()} · ${state.directCount || 1} 张`)
        ),
        exampleRow
      ));
      return;
    }

    stageBox.appendChild(el("div", { class: "sc-empty-state" },
      el("div", { class: "sc-empty-icon", "aria-hidden": "true" }, "✦"),
      el("h2", { class: "sc-empty-title" }, "让灵感从这里开始"),
      el("p", { class: "muted sc-empty-desc" },
        "直接描述想画的画面，支持单张精绘或一次规划多张系列图（如「画 4 张…」或分行输入多条场景）。左侧留空画风时将自动为你推荐。"
      ),
      previewChips.length
        ? el("div", { class: "sc-empty-recipe-chips" },
            ...previewChips.map((ch) => el("div", { class: "make-image-chip" },
              ch.img ? el("img", { src: ch.img, alt: "" }) : null,
              el("span", null, ch.label)
            )),
            el("span", { class: "badge" }, `${MODE_LABELS[state.mode] || "图文"} · ${state.ratio} · ${state.resolution.toUpperCase()}`)
          )
        : el("div", { class: "row", style: { justifyContent: "center", gap: "6px" } },
            el("span", { class: "badge" }, "画风：AI 自动推荐（也可左侧自选）"),
            el("span", { class: "badge" }, `${MODE_LABELS[state.mode] || "图文"} · ${state.ratio} · ${state.resolution.toUpperCase()}`)
          ),
      exampleRow
    ));
  }

  function renderStage(force = false) {
    const turn = currentTurn();
    const item = currentItem();
    if (!turn || !item) {
      renderEmptyOrThinking();
      return;
    }
    const isMulti = turn.items.length > 1;
    if (isMulti && state.viewMode === "grid") {
      stageBox.classList.add("hidden");
      return;
    }
    stageBox.classList.remove("hidden");

    const idx = state.selectedItemIndex;
    const renderKey = [
      turn.id,
      item.id,
      idx,
      turn.items.length,
      item.status,
      item.path,
      item.error,
      item.title,
      item.layout,
      item.ratio,
    ].join("|");
    if (!force && renderKey === lastStageRenderKey) {
      return;
    }
    lastStageRenderKey = renderKey;
    clear(stageBox);

    const captionText = isMulti
      ? `图 ${idx + 1} / ${turn.items.length} · ${item.title || `第 ${idx + 1} 张`}`
      : (item.title || "当前画面");

    const stage = el("div", { class: "sc-preview-stage" });
    stage.appendChild(el("div", { class: "sc-stage-caption" },
      el("span", null, captionText),
      item.layout ? el("span", { class: "sc-stage-layout-tag" }, item.layout) : null,
      el("span", { class: "sc-stage-ratio-tag" }, item.ratio || state.ratio || "3:4")
    ));

    if (isMulti) {
      stage.appendChild(el("button", {
        type: "button",
        class: "sc-nav-btn sc-nav-prev",
        "aria-label": "上一张",
        disabled: idx <= 0,
        onClick: () => selectItem(idx - 1),
      }, "‹"));
      stage.appendChild(el("button", {
        type: "button",
        class: "sc-nav-btn sc-nav-next",
        "aria-label": "下一张",
        disabled: idx >= turn.items.length - 1,
        onClick: () => selectItem(idx + 1),
      }, "›"));
    }

    const body = el("div", { class: "sc-stage-body" });
    if (item.status === "done" && item.path) {
      body.appendChild(el("img", {
        class: "sc-stage-img",
        src: localImg(item.path),
        alt: item.title || item.subject || "生成图像",
        onClick: () => openLightbox(item),
      }));
    } else if (item.status === "queued" || item.status === "running") {
      body.appendChild(el("div", { class: "sc-stage-status" },
        el("span", { class: "dot-pulse" }),
        el("strong", null, `${isMulti ? `图 ${idx + 1}` : "当前画面"} · ${item.status === "running" ? "正在绘制中…" : "排队等待中…"}`),
        el("p", { class: "muted sc-stage-subject-preview" }, item.subject || ""),
        item.imageId
          ? el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: async () => {
                await api("POST", `/api/images/${encodeURIComponent(item.imageId)}/cancel`).catch(() => {});
                item.status = "canceled";
                renderAll();
                toast("已取消该图生成");
              },
            }, "取消这张")
          : null
      ));
    } else if (item.status === "failed" || item.status === "canceled") {
      body.appendChild(el("div", { class: "sc-stage-status" },
        el("span", { class: "badge badge-err" }, item.status === "canceled" ? "已取消" : "生成失败"),
        el("p", { class: "muted sc-stage-subject-preview" }, item.error || item.subject || "未能完成绘制"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => retryOrGenerateItem(turn, item),
        }, "重试这张")
      ));
    } else {
      body.appendChild(el("div", { class: "sc-stage-status sc-stage-idle" },
        el("strong", null, item.title || `图 ${idx + 1}`),
        el("p", { class: "muted sc-stage-subject-preview" }, item.subject || "在底部切换到本图提示词输入画面描述，然后点击生成。"),
        item.displayCopy ? el("span", { class: "badge" }, `画面文字：${item.displayCopy}`) : null,
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => generateTurnItems(turn, [item], false),
        }, "生成这张")
      ));
    }

    stage.appendChild(body);
    stageBox.appendChild(stage);

    // Stage action bar for completed image
    if (item.status === "done" && item.path) {
      const dim = item.width && item.height ? `${item.width}×${item.height}` : "";
      stageBox.appendChild(el("div", { class: "sc-stage-actions" },
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openLightbox(item) }, "🔍 查看原图"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: async () => {
              if (!item.imageId) return;
              try {
                await api("POST", `/api/images/${encodeURIComponent(item.imageId)}/copy`);
                toast("图片已复制到剪贴板");
              } catch (e) { toast(e.message); }
            },
          }, "📋 复制"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => {
              if (!state.refs.includes(item.path)) {
                state.refs = [...state.refs, item.path];
              }
              renderRefs();
              session.persist();
              toast("已将该图加入底部参考图");
            },
          }, "🔁 设为参考图"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => generateTurnItems(turn, [item], false),
          }, "🔄 重新生成"),
          item.runId
            ? el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: () => ctx.go("works", { openRun: item.runId }),
              }, "☁ 发布")
            : null
        ),
        dim ? el("span", { class: "muted mono", style: { fontSize: "11.5px" } }, dim) : null
      ));
    }
  }

  function renderGridView() {
    clear(gridBox);
    const turn = currentTurn();
    if (!turn || turn.items.length <= 1 || state.viewMode !== "grid") {
      gridBox.classList.add("hidden");
      return;
    }
    gridBox.classList.remove("hidden");

    turn.items.forEach((item, idx) => {
      const isSelected = idx === state.selectedItemIndex;
      const thumbNode = item.status === "done" && item.path
        ? el("img", {
            src: localImg(item.thumb || item.path),
            alt: item.title || `图 ${idx + 1}`,
            class: "sc-grid-img",
            onClick: () => {
              state.selectedItemIndex = idx;
              state.viewMode = "focused";
              lastStageRenderKey = "";
              renderAll();
            },
          })
        : el("div", { class: "sc-grid-placeholder", style: { aspectRatio: ratioToCss(item.ratio || state.ratio) } },
            (item.status === "queued" || item.status === "running") ? el("span", { class: "dot-pulse" }) : null,
            el("span", { class: "muted", style: { fontSize: "12px" } },
              item.status === "running" ? "正在绘制…"
              : item.status === "queued" ? "排队中…"
              : item.status === "failed" ? "生成失败"
              : item.status === "canceled" ? "已取消"
              : "待生成"
            )
          );

      gridBox.appendChild(el("article", { class: "sc-grid-card" + (isSelected ? " is-selected" : "") },
        el("div", { class: "sc-grid-media" },
          el("span", { class: "sc-grid-badge" }, `#${idx + 1}`),
          thumbNode
        ),
        el("div", { class: "sc-grid-body" },
          el("strong", { class: "sc-grid-title", title: item.title || "" }, item.title || `第 ${idx + 1} 张`),
          el("p", { class: "muted sc-grid-sub" }, item.subject || ""),
          el("div", { class: "row", style: { gap: "6px", marginTop: "auto" } },
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => {
                state.selectedItemIndex = idx;
                state.viewMode = "focused";
                lastStageRenderKey = "";
                renderAll();
              },
            }, "查看"),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => generateTurnItems(turn, [item], false),
            }, item.status === "done" ? "重绘" : "生成")
          )
        )
      ));
    });
  }

  function renderThumbRail() {
    clear(thumbRail);
    const turn = currentTurn();
    if (!turn || isPlanning) {
      thumbRail.classList.add("hidden");
      return;
    }
    thumbRail.classList.remove("hidden");

    turn.items.forEach((item, idx) => {
      const isSelected = idx === state.selectedItemIndex;
      let pic;
      if (item.status === "done" && item.path) {
        pic = el("img", { src: localImg(item.thumb || item.path), alt: item.title || `图 ${idx + 1}` });
      } else if (item.status === "queued" || item.status === "running") {
        pic = el("span", { class: "dot-pulse" });
      } else if (item.status === "failed" || item.status === "canceled") {
        pic = el("span", { class: "sc-thumb-err" }, "!");
      } else {
        pic = el("span", { class: "muted" }, `#${idx + 1}`);
      }
      const statusMark = item.status === "done" ? " ✓" : (item.status === "failed" ? " !" : "");
      thumbRail.appendChild(el("button", {
        type: "button",
        class: "sc-thumb-item" + (isSelected ? " is-selected" : ""),
        "aria-pressed": String(isSelected),
        title: `${item.title || `图 ${idx + 1}`}：${(item.subject || "").slice(0, 60)}`,
        onClick: () => selectItem(idx),
      },
        el("div", { class: "sc-thumb-pic" }, pic),
        el("span", { class: "sc-thumb-label" }, `#${idx + 1}${statusMark}`)
      ));
    });

    if (turn.items.length < 12) {
      thumbRail.appendChild(el("button", {
        type: "button",
        class: "sc-thumb-add",
        title: "添加画面（最多 12 张）",
        "aria-label": "添加画面",
        onClick: () => addItemToTurn(turn),
      }, "+"));
    }
  }

  function renderOutput() {
    renderTurnBar();
    renderPlanStrip();
    if (isPlanning || !currentTurn()) {
      renderEmptyOrThinking();
    } else {
      renderStage(false);
      renderGridView();
      renderThumbRail();
    }
  }

  function renderAll() {
    renderRefs();
    renderSelectedSlot();
    renderOutput();
    syncComposerState();
    renderRecentRuns();
  }

  function selectItem(nextIdx) {
    const turn = currentTurn();
    if (!turn || !turn.items.length) return;
    const clamped = Math.max(0, Math.min(nextIdx, turn.items.length - 1));
    state.selectedItemIndex = clamped;
    renderSelectedSlot();
    renderStage(true);
    renderThumbRail();
    renderGridView();
    syncComposerState();
    session.persist();
  }

  function addItemToTurn(turn) {
    if (!turn || turn.items.length >= 12) return;
    const nextNum = turn.items.length + 1;
    turn.items.push({
      id: uid("it"),
      index: nextNum,
      title: `第 ${nextNum} 张`,
      subject: "",
      displayCopy: "",
      layout: state.mode === "pure-image" ? "" : (state.layout || ""),
      layoutName: "",
      ratio: state.ratio || turn.common?.ratio || "3:4",
      mood: "",
      status: "idle",
      runId: "",
      imageId: "",
      path: "",
      thumb: "",
      width: 0,
      height: 0,
      error: "",
    });
    turn.kind = turn.items.length > 1 ? "multi" : "single";
    state.selectedItemIndex = turn.items.length - 1;
    state.viewMode = "focused";
    state.composerMode = "image";
    lastStageRenderKey = "";
    renderAll();
    subjectInput.focus();
    session.persist();
  }

  function deleteItemAt(idx) {
    const turn = currentTurn();
    if (!turn || turn.items.length <= 1) return;
    turn.items.splice(idx, 1);
    turn.items.forEach((it, i) => { it.index = i + 1; });
    turn.kind = turn.items.length > 1 ? "multi" : "single";
    state.selectedItemIndex = Math.min(idx, turn.items.length - 1);
    if (turn.items.length <= 1) state.viewMode = "focused";
    lastStageRenderKey = "";
    renderAll();
    session.persist();
  }

  function openLightbox(item) {
    const body = el("div", { class: "col", style: { alignItems: "center", gap: "8px" } },
      el("img", { src: localImg(item.path), alt: item.title || "", style: { maxWidth: "100%", maxHeight: "72vh", borderRadius: "8px" } }),
      el("div", { class: "muted mono", style: { fontSize: "12px" } }, `${item.path}${item.width ? ` (${item.width}×${item.height})` : ""}`)
    );
    showModal(item.title || "大图预览", body, [
      item.runId
        ? el("button", {
            type: "button",
            class: "btn",
            onClick: async () => { await api("POST", `/api/works/${encodeURIComponent(item.runId)}/reveal`).catch(() => {}); },
          }, "在目录中打开")
        : null,
      el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭"),
    ].filter(Boolean));
  }

  // ---------- Actions: Quote, Dice, Recipe, Export, Cancel, Plan & Generate ----------
  async function refreshQuote() {
    const turn = currentTurn();
    const count = state.composerMode === "image"
      ? 1
      : (turn && turn.items.length > 1 && state.composerMode !== "chat" ? turn.items.length : 1);
    try {
      const q = await api("POST", "/api/quote", {
        modelRef: state.modelRef,
        resolution: state.resolution,
        quality: state.quality,
        count,
      });
      quoteBadge.className = "badge" + (q.overLimit ? " badge-warn" : (q.freeCount > 0 || q.source === "provider" ? " badge-ok" : ""));
      if (q.source === "provider") {
        quoteBadge.textContent = "自带接口直出";
      } else if (q.freeCount > 0 && q.totalCents === 0) {
        quoteBadge.textContent = `免费额度（${q.freeCount} 次）`;
      } else {
        quoteBadge.textContent = `单张约 ${money(q.totalCents)}` + (q.freeCount > 0 ? `（含免费 ${q.freeCount} 次）` : "");
      }
    } catch {
      quoteBadge.textContent = state.modelRef.startsWith("site:") && !modRes.loggedIn ? "使用网站模型需登录" : "报价待定";
      quoteBadge.className = "badge";
    }
  }

  async function rollDice() {
    try {
      const rnd = await api("GET", "/api/resources/random");
      state.style = rnd.style?.number || state.style;
      state.layout = rnd.layout?.id || "";
      state.color = rnd.color?.id || "";
      state.tone = rnd.tone?.id || "";
      syncLeftControls();
      renderSelectedSlot();
      if (!currentTurn()) renderOutput();
      session.persist();
      toast(`已摇到：${state.style}${state.layout ? " + " + state.layout : ""}`);
    } catch (e) { toast(e.message); }
  }

  function saveCurrentRecipe() {
    const stCode = state.style || currentTurn()?.common?.style1 || "";
    openRecipeEditor({
      name: `${stCode || "手绘配方"}${state.layout ? " + " + state.layout : ""}`,
      styleIds: [stCode, state.fusion ? state.style2 : ""].filter(Boolean),
      layoutId: state.layout,
      colors: state.color ? [state.color] : [],
      tones: state.tone ? [state.tone] : [],
      mood: state.mood,
      ratio: state.ratio,
      mode: state.mode,
    }, async () => {
      const r = await api("GET", "/api/mine/recipes").catch(() => ({ items: [] }));
      recipes = r.items || [];
      renderRecipeOptions();
    });
  }

  async function exportTurnRun(runId, format) {
    try {
      const res = await api("POST", `/api/works/${encodeURIComponent(runId)}/export`, { format });
      toast(format === "xiaohongshu" ? `已导出小红书 3:4 压缩包：${res.path}` : `已导出 ZIP：${res.path}`);
    } catch (e) { toast(e.message); }
  }

  async function cancelTurnRunning(turn) {
    if (!turn) return;
    const runningItems = (turn.items || []).filter((it) => (it.status === "queued" || it.status === "running") && it.imageId);
    for (const it of runningItems) {
      await api("POST", `/api/images/${encodeURIComponent(it.imageId)}/cancel`).catch(() => {});
      it.status = "canceled";
    }
    lastStageRenderKey = "";
    renderAll();
    session.persist();
    toast("已停止当前生成任务");
  }

  async function retryOrGenerateItem(turn, item) {
    if (item.imageId && (item.status === "failed" || item.status === "canceled")) {
      try {
        await api("POST", `/api/images/${encodeURIComponent(item.imageId)}/retry`);
        item.status = "queued";
        item.error = "";
        lastStageRenderKey = "";
        renderAll();
        toast("已重新入队");
        return;
      } catch {
        // Fall back to creating a fresh generation for this item
      }
    }
    await generateTurnItems(turn, [item], false);
  }

  function applyCommonBackToLeft(common, styleLocked) {
    if (!common) return;
    if (!styleLocked && common.style1) {
      state.style = common.style1;
      state.style2 = common.style2 || "";
      state.fusion = Boolean(state.style2);
    }
    if (common.mode) state.mode = common.mode;
    if (common.ratio) state.ratio = common.ratio;
    if (!state.color && common.colors?.length) state.color = common.colors[0];
    if (!state.tone && common.tones?.length) state.tone = common.tones[0];
    if (!state.mood && common.moods?.length) state.mood = common.moods.join("，");
    if (!state.whitespace && common.whitespace) state.whitespace = common.whitespace;
    if (!state.audience && common.audience) state.audience = common.audience;
    if (!state.businessScene && common.businessScene) state.businessScene = common.businessScene;
    syncLeftControls();
  }

  async function handleComposerSubmit() {
    if (isPlanning || isSubmitting) return;
    if (!controls.validate()) {
      toast("请填写有效比例，并为双画风融合选择两种画风");
      return;
    }

    // Mode 1: Editing a specific card's prompt -> directly generate/redraw just that card
    if (state.composerMode === "image") {
      const turn = currentTurn();
      const item = currentItem();
      if (!turn || !item) return;
      const subj = subjectInput.value.trim();
      if (!subj) {
        toast("请先输入当前画面的描述词");
        subjectInput.focus();
        return;
      }
      item.subject = subj;
      await generateTurnItems(turn, [item], false);
      return;
    }

    // Mode 2A: Direct-prompt mode (skip handraw-skill & chat-plan, send verbatim prompt!) (#87)
    if (state.directPrompt) {
      const message = subjectInput.value.trim();
      if (!message) {
        toast("请先输入或粘贴完整提示词");
        subjectInput.focus();
        return;
      }
      const cnt = Math.max(1, Math.min(4, Number(state.directCount) || 1));
      const directItems = Array.from({ length: cnt }, (_, idx) => ({
        id: uid("it"),
        index: idx + 1,
        title: cnt > 1 ? `直出第 ${idx + 1} 张` : message.slice(0, 20),
        subject: message,
        displayCopy: "",
        layout: "",
        layoutName: "",
        ratio: state.ratio || "3:4",
        mood: "",
        status: "idle",
        runId: "",
        imageId: "",
        path: "",
        thumb: "",
        width: 0,
        height: 0,
        error: "",
      }));
      const turn = {
        id: uid("turn"),
        userMessage: message,
        reply: cnt > 1
          ? `提示词直出（共 ${cnt} 张，未调用手绘 Skill）：${message.slice(0, 72)}${message.length > 72 ? "…" : ""}`
          : `提示词直出（未调用手绘 Skill）：${message.slice(0, 80)}${message.length > 80 ? "…" : ""}`,
        source: "direct",
        directPrompt: true,
        kind: cnt > 1 ? "multi" : "single",
        common: { ratio: state.ratio || "3:4", mode: "pure-image" },
        runIds: [],
        items: directItems,
      };
      state.draftInput = "";
      subjectInput.value = "";
      state.turns = [...(state.turns || []), turn];
      state.activeTurnIndex = state.turns.length - 1;
      state.selectedItemIndex = 0;
      state.viewMode = "focused";
      state.composerMode = "chat";
      lastStageRenderKey = "";
      renderAll();
      session.persist();
      await generateTurnItems(turn, turn.items, false);
      return;
    }

    // Mode 2B: Chat / unified single+multi planning -> POST /api/studio/chat-plan -> auto generate
    const message = subjectInput.value.trim();
    if (!message) {
      toast("请先描述想画的内容");
      subjectInput.focus();
      return;
    }

    const history = [];
    (state.turns || []).slice(-4).forEach((t) => {
      if (t.userMessage) history.push({ role: "user", content: t.userMessage });
      if (t.reply) history.push({ role: "assistant", content: t.reply });
    });

    isPlanning = true;
    planningPrompt = message;
    state.draftInput = "";
    subjectInput.value = "";
    syncComposerState();
    renderOutput();

    try {
      const plan = await api("POST", "/api/studio/chat-plan", {
        message,
        history,
        selected: {
          style1: state.style || "",
          style2: state.fusion ? (state.style2 || "") : "",
          layout: state.mode === "pure-image" ? "" : (state.layout || ""),
          colors: state.color ? splitTokens(state.color) : [],
          tones: state.tone ? [state.tone] : [],
          moods: state.mood ? splitTokens(state.mood) : [],
          mode: state.mode || "graphic-text",
          ratio: state.ratio || "3:4",
          whitespace: state.whitespace || "",
          audience: state.audience || "",
          businessScene: state.businessScene || "",
        },
      });
      if (!root.isConnected) return;

      applyCommonBackToLeft(plan.common, Boolean(plan.styleLocked));

      const plannedItems = (plan.items || []).map((it, idx) => ({
        id: uid("it"),
        index: idx + 1,
        title: it.title || (plan.items.length > 1 ? `第 ${idx + 1} 张` : message.slice(0, 14)),
        subject: it.subject || message,
        displayCopy: it.displayCopy || "",
        layout: it.layout || "",
        layoutName: it.layoutName || "",
        ratio: it.ratio || plan.common?.ratio || state.ratio || "3:4",
        mood: it.mood || "",
        status: "idle",
        runId: "",
        imageId: "",
        path: "",
        thumb: "",
        width: 0,
        height: 0,
        error: "",
      }));

      const turn = {
        id: uid("turn"),
        userMessage: message,
        reply: plan.reply || "",
        source: plan.source || "local",
        kind: plannedItems.length > 1 ? "multi" : "single",
        common: plan.common || {},
        runIds: [],
        items: plannedItems,
      };

      state.turns = [...(state.turns || []), turn];
      state.activeTurnIndex = state.turns.length - 1;
      state.selectedItemIndex = 0;
      state.viewMode = "focused";
      state.composerMode = "chat";
      lastStageRenderKey = "";

      isPlanning = false;
      planningPrompt = "";
      renderAll();
      session.persist();

      // Immediately start generating the planned items (single or multi)
      await generateTurnItems(turn, turn.items, false);
    } catch (e) {
      isPlanning = false;
      planningPrompt = "";
      state.draftInput = message;
      syncComposerState();
      renderOutput();
      toast(e.message || "规划失败，请重试");
    }
  }

  async function generateTurnItems(turn, targetItems, confirmed) {
    if (!turn || !targetItems?.length || isSubmitting) return;
    isSubmitting = true;
    syncComposerState();

    const isDirect = Boolean(turn.directPrompt || state.directPrompt);
    const common = turn.common || {};
    const isSeriesBatch = targetItems.length > 1;

    let payloadItems;
    let payloadRecipe;
    const payloadGalleryRefs = (state.galleryRefs || []).map((g) => ({
      kind: g.kind,
      id: g.id,
      ...(g.variant ? { variant: g.variant } : {}),
    }));
    if (isDirect) {
      payloadItems = targetItems.map((it) => {
        const rawP = String(it.subject || turn.userMessage || "").trim();
        return {
          theme: rawP,
          prompt: rawP,
          ratio: it.ratio || state.ratio || "3:4",
          mode: "pure-image",
        };
      });
      payloadRecipe = {};
    } else {
      const effectiveStyle = state.style || common.style1 || "FA-013";
      const effectiveStyle2 = state.fusion ? (state.style2 || "") : "";
      const effectiveMode = state.mode || common.mode || "graphic-text";
      const effectiveColor = state.color || (common.colors?.[0] || "");
      const effectiveTone = state.tone || (common.tones?.[0] || "");
      const baseExtra = extraInstructions(state);
      payloadItems = targetItems.map((it) => {
        const mergedMood = [state.mood, it.mood].filter(Boolean).join("，");
        return {
          theme: it.subject || turn.userMessage || "手绘插画",
          style: effectiveStyle,
          style2: effectiveStyle2,
          layout: effectiveMode === "pure-image" ? "" : (it.layout || state.layout || ""),
          color: effectiveColor,
          tone: effectiveTone,
          mood: mergedMood,
          ratio: it.ratio || state.ratio || "3:4",
          text: effectiveMode === "pure-image" ? "" : (it.displayCopy || ""),
          mode: effectiveMode,
          redraw: Boolean(state.redraw),
          extra: baseExtra,
        };
      });
      payloadRecipe = {
        id: state.recipeId,
        styleIds: [effectiveStyle, effectiveStyle2].filter(Boolean),
        layoutId: state.layout || payloadItems[0]?.layout || "",
        color: effectiveColor || payloadItems[0]?.color || "",
        tone: effectiveTone || payloadItems[0]?.tone || "",
        mood: state.mood || payloadItems[0]?.mood || "",
        ratio: state.ratio || payloadItems[0]?.ratio || "",
        mode: effectiveMode || payloadItems[0]?.mode || "",
        resolution: state.resolution || "",
        quality: state.quality || "",
      };
    }

    try {
      const res = await api("POST", "/api/generate", {
        mode: isSeriesBatch ? "series" : "single",
        title: (targetItems.length === 1 ? (targetItems[0].title || targetItems[0].subject) : (turn.userMessage || (isDirect ? "直出创作" : "系列创作"))).slice(0, 28),
        modelRef: state.modelRef,
        resolution: state.resolution,
        quality: state.quality,
        confirmed,
        directPrompt: isDirect,
        groupId: state.groupId,
        parentId: state.parentId,
        forkOf: isDirect ? "" : (state.forkOf || ""),
        refs: state.refs,
        galleryRefs: payloadGalleryRefs,
        items: payloadItems,
        recipe: payloadRecipe,
      });

      if (res.needConfirm) {
        isSubmitting = false;
        syncComposerState();
        const body = el("div", { class: "col" },
          el("p", null, `本次预计生成 ${res.count} 张，使用网站计费额度 ${money(res.totalCents)}（含免费次数 ${res.freeCount} 次），超过了设置的单次确认阈值 ${money(res.limitCents)}。`),
          el("p", { class: "muted" }, "可在「设置」中调整确认阈值，或改用自己配置的 API 接口直出生图。")
        );
        showModal("费用二次确认", body, [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => {
              closeModal();
              generateTurnItems(turn, targetItems, true);
            },
          }, "确认继续生成"),
        ]);
        return;
      }

      const run = res.run;
      const imgs = res.images || run?.images || [];
      if (run?.id && !turn.runIds.includes(run.id)) {
        turn.runIds.push(run.id);
      }
      targetItems.forEach((it, i) => {
        const im = imgs[i];
        if (!im) return;
        it.runId = run.id;
        it.imageId = im.id;
        it.status = im.status || "queued";
        it.error = im.error || "";
        if (im.path) it.path = im.path;
        if (im.thumb) it.thumb = im.thumb;
      });

      state.recentRuns = [{ ...run, images: imgs }, ...(state.recentRuns || []).filter((r) => r.id !== run.id)].slice(0, 12);
      lastStageRenderKey = "";
      renderAll();
      toast(targetItems.length > 1 ? `已提交 ${targetItems.length} 张生成任务` : "已提交生成队列，完成后自动显影");
    } catch (e) {
      toast(e.message || "提交生成失败");
    } finally {
      isSubmitting = false;
      syncComposerState();
      session.persist();
    }
  }

  // ---------- Surgical SSE Sync ----------
  const pendingRunSync = new Map();
  async function syncRunFromServer(runId) {
    if (!runId || !root.isConnected) return;
    try {
      const detail = await api("GET", `/api/works/${encodeURIComponent(runId)}`);
      const run = detail.run;
      if (!run || !root.isConnected) return;

      const byId = new Map((run.images || []).map((im) => [im.id, im]));
      let touchedActiveTurn = false;
      const activeTurn = currentTurn();

      (state.turns || []).forEach((turn) => {
        if (!turn.runIds?.includes(runId)) return;
        let changed = false;
        (turn.items || []).forEach((it) => {
          const im = byId.get(it.imageId);
          if (!im) return;
          if (
            it.status !== im.status ||
            it.path !== (im.path || "") ||
            it.thumb !== (im.thumb || "") ||
            it.error !== (im.error || "")
          ) {
            it.status = im.status;
            it.path = im.path || "";
            it.thumb = im.thumb || "";
            it.width = im.width || 0;
            it.height = im.height || 0;
            it.error = im.error || "";
            changed = true;
          }
        });
        if (changed && activeTurn && turn.id === activeTurn.id) {
          touchedActiveTurn = true;
        }
      });

      // Keep recentRuns fresh
      const rIdx = (state.recentRuns || []).findIndex((r) => r.id === run.id);
      if (rIdx >= 0) {
        state.recentRuns[rIdx] = run;
      }

      if (touchedActiveTurn) {
        renderPlanStrip();
        renderStage(false);
        renderGridView();
        renderThumbRail();
        syncComposerState();
        renderRecentRuns();
        session.persist();
      }
    } catch {}
  }

  const unsub = onEvent((msg) => {
    if (!root.isConnected) {
      unsub();
      return;
    }
    if (msg.type !== "job" && msg.type !== "run") return;
    const rid = msg.data?.runId || msg.data?.id;
    if (!rid) return;
    const tracked = (state.turns || []).some((t) => t.runIds?.includes(rid));
    if (!tracked) return;
    if (pendingRunSync.has(rid)) return;
    pendingRunSync.set(rid, setTimeout(() => {
      pendingRunSync.delete(rid);
      syncRunFromServer(rid);
    }, 120));
  });

  // Keyboard ← / → navigation for multi-image focused stage
  const onKeyDown = (e) => {
    if (!root.isConnected) {
      window.removeEventListener("keydown", onKeyDown);
      return;
    }
    const tag = (document.activeElement?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || document.querySelector("dialog[open]")) {
      return;
    }
    const turn = currentTurn();
    if (!turn || turn.items.length <= 1 || state.viewMode === "grid") return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      selectItem(state.selectedItemIndex - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      selectItem(state.selectedItemIndex + 1);
    }
  };
  window.addEventListener("keydown", onKeyDown);

  // Initial render
  syncLeftControls();
  syncComposerExpand();
  renderAll();
  await refreshQuote();

  // Re-sync any still-running runs if user switched views and came back
  const cur = currentTurn();
  if (cur && turnHasRunning(cur)) {
    for (const rid of cur.runIds || []) {
      syncRunFromServer(rid);
    }
  }
  if (params.openRecipes) {
    openRecipesManager();
  }
}
