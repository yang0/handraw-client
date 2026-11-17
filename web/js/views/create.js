import { api, clear, closeModal, el, localImg, money, onEvent, packImg, showModal, toast } from "../api.js";
import { openRecipeEditor } from "./recipes.js";
import { mountSlotPanels } from "../plugins-host.js";
import { choices, extraInstructions, field, ratioToCss, recipeControls, studioMount, studioSession } from "./studio-controls.js";

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
    api("GET", "/api/works?limit=12").catch(() => ({ items: [] })),
  ]);
  if (!host.isConnected) return;

  const styles = stylesRes.items || [];
  const layouts = layoutsRes.items || [];
  const colors = colorsRes.items || [];
  const tones = tonesRes.items || [];
  const recipes = recRes.items || [];
  const settings = settRes.settings || {};

  const p = params.preset || params.recipe || {};
  const session = studioSession(host, "single", {
    recipeId: params.recipe?.id || "",
    style: params.style || p.style || p.styleIds?.[0] || styles[0]?.number || "FA-013",
    style2: params.style2 || p.style2 || p.styleIds?.[1] || "",
    layout: params.layout || p.layout || p.layoutId || "",
    color: params.color || p.color || p.colors?.[0] || "",
    tone: params.tone || p.tone || p.tones?.[0] || "",
    mood: params.mood || p.mood || "",
    mode: params.mode || p.mode || "graphic-text",
    ratio: params.ratio || p.ratio || settings.defaultRatio || "3:4",
    resolution: params.resolution || p.resolution || settings.defaultResolution || "2k",
    quality: params.quality || p.quality || "standard",
    theme: params.theme || "",
    text: params.text || "",
    redraw: Boolean(params.redraw),
    count: 1,
    modelRef: params.modelRef || modRes.defaultModel || "site:seedream-4.5",
    refs: Array.isArray(params.refs) ? [...params.refs] : (params.editImage ? [params.editImage] : []),
    promptCustomized: Boolean(params.promptText),
    customPrompt: params.promptText || "",
    compiled: null,
    preview: null,
    quote: null,
    activeRun: params.run || null,
    recentRuns: recentRes.items || [],
    parentId: params.parentId || "",
    groupId: params.groupId || "",
  });
  root = session.root;
  const state = session.state;
  if (Object.keys(params).length) {
    Object.assign(state, { theme: params.theme ?? state.theme, text: params.text ?? state.text });
    for (const key of ["style", "style2", "layout", "color", "tone", "mood", "mode", "ratio", "resolution", "modelRef", "parentId", "groupId"]) {
      const value = params[key] ?? p[key];
      if (value !== undefined) state[key] = value;
    }
    if (p.styleIds) { state.style = p.styleIds[0] || ""; state.style2 = p.styleIds[1] || ""; }
    if (p.layoutId !== undefined) state.layout = p.layoutId;
    if (p.colors) state.color = p.colors.join(" + ");
    if (p.tones) state.tone = p.tones[0] || "";
    if (params.refs || params.editImage) state.refs = params.refs || [params.editImage];
    if (params.promptText) { state.customPrompt = params.promptText; state.promptCustomized = true; }
    if (params.run) state.activeRun = params.run;
    if (params.recipe?.id) state.recipeId = params.recipe.id;
    if (!params.promptText) state.promptCustomized = false;
    state.fusion = Boolean(state.style2);
  }

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row" },
      el("h1", { class: "page-title" }, "单图创作"),
      el("span", { class: "muted" }, "调配画风、图型与主题色，在右侧直接输入画面描述出图")
    ),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn btn-sm", onClick: rollDice }, "🎲 摇灵感"),
      el("button", { type: "button", class: "btn btn-sm", onClick: saveCurrentRecipe }, "💾 存为配方"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("atlas") }, "📖 逛画册")
    )
  ));

  // Left: Website-parity Properties Panel
  const recSel = el("select", { class: "select select-sm", style: { flex: "1" }, "aria-label": "快速套用配方" },
    el("option", { value: "" }, "— 套用常用配方 —"),
    ...recipes.map((r) => el("option", { value: r.id }, `${r.name} (${(r.styleIds || []).join("+")})`))
  );
  if (state.recipeId) recSel.value = state.recipeId;
  recSel.addEventListener("change", () => {
    const r = recipes.find((x) => x.id === recSel.value);
    if (!r) return;
    state.recipeId = r.id;
    if (r.styleIds?.[0]) state.style = r.styleIds[0];
    state.style2 = r.styleIds?.[1] || "";
    state.fusion = Boolean(state.style2);
    state.layout = r.layoutId || "";
    state.color = r.colors?.[0] || "";
    state.tone = r.tones?.[0] || "";
    state.mood = r.mood || "";
    state.ratio = r.ratio || state.ratio;
    state.mode = r.mode || state.mode;
    state.promptCustomized = false;
    syncFormInputs();
    refreshPromptAndQuote();
  });

  const controls = recipeControls(state, { styles, layouts, colors, tones }, () => {
    state.promptCustomized = false;
    updateTextVisibility();
    scheduleRefresh();
    session.persist();
  });

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

  const textInput = el("input", {
    class: "input",
    type: "text",
    value: state.text,
    placeholder: "画面内要写出的主/副标题文字（可留空）",
  });
  textInput.addEventListener("input", () => {
    state.text = textInput.value;
    if (!state.promptCustomized) scheduleRefresh();
  });
  const textField = field("画面文字（可选）", textInput);
  function updateTextVisibility() {
    textField.classList.toggle("hidden", state.mode === "pure-image");
  }
  updateTextVisibility();

  const redrawChk = el("input", { type: "checkbox", checked: state.redraw });
  redrawChk.addEventListener("change", () => {
    state.redraw = redrawChk.checked;
    state.promptCustomized = false;
    scheduleRefresh();
  });

  // Prompt preview accordion (inside Properties pane, just like handraw-web)
  const promptEdit = el("textarea", { class: "textarea mono", rows: "4", style: { fontSize: "12px" } });
  if (state.customPrompt) promptEdit.value = state.customPrompt;
  promptEdit.addEventListener("input", () => {
    state.customPrompt = promptEdit.value;
    state.promptCustomized = true;
  });
  const promptNote = el("span", { class: "muted" }, "按所选模型自动切换中/英文提示词");
  const expandBtn = el("button", { type: "button", class: "btn btn-sm", onClick: handleExpandTheme }, "✨ AI 扩写");
  const resetPromptBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: () => { state.promptCustomized = false; refreshPromptAndQuote(); },
  }, "重置");

  const promptDetails = el("details", { class: "studio-more-card" },
    el("summary", { class: "studio-more-summary" },
      el("span", null, "提示词预览与微调"),
      el("span", { class: "studio-more-chevron", "aria-hidden": "true" })
    ),
    el("div", { class: "studio-more-body" },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap" } },
        promptNote,
        el("div", { class: "row" }, expandBtn, resetPromptBtn)
      ),
      promptEdit
    )
  );

  const recentBox = el("div", { class: "studio-recent-strip" });
  function renderRecentRuns() {
    clear(recentBox);
    const list = (state.recentRuns || []).slice(0, 8);
    if (!list.length) {
      recentBox.appendChild(el("span", { class: "muted", style: { gridColumn: "1 / -1" } }, "暂无历史草稿"));
      return;
    }
    list.forEach((run) => {
      const im = run.images?.[0];
      const src = im?.thumb ? localImg(im.thumb) : (im?.path ? localImg(im.path) : "/img/logo.svg");
      const active = state.activeRun?.id === run.id;
      recentBox.appendChild(el("button", {
        type: "button",
        class: "studio-recent-thumb" + (active ? " is-active" : ""),
        title: run.title || run.originalRequest || "作品",
        onClick: async () => {
          try {
            const detail = await api("GET", `/api/works/${encodeURIComponent(run.id)}`);
            state.activeRun = detail.run;
            renderViewer();
            renderRecentRuns();
          } catch (e) { toast(e.message); }
        },
      },
        el("img", { src, alt: run.title || "" }),
        el("span", null, run.title || "未命名")
      ));
    });
  }

  const leftPane = el("section", { class: "make-image-properties", "aria-label": "画面属性" },
    el("div", { class: "studio-more-row" },
      el("span", { class: "studio-row-label" }, "配方"),
      recSel
    ),
    controls.node,
    textField,
    resChoices,
    qualChoices,
    el("label", { class: "row", style: { cursor: "pointer" } }, redrawChk, el("span", null, "照片重绘（参考原图结构重绘）")),
    promptDetails,
    el("details", { class: "studio-more-card" },
      el("summary", { class: "studio-more-summary" },
        el("span", null, `最近创作 (${Math.min(8, (state.recentRuns || []).length)})`),
        el("span", { class: "studio-more-chevron", "aria-hidden": "true" })
      ),
      el("div", { class: "studio-more-body" }, recentBox)
    )
  );

  // Right: Output scroll + Chat-like Composer
  const previewStrip = el("div", { class: "make-image-recipe-strip" });
  const viewer = el("div", { class: "make-image-results-grid" });
  const outputScroll = el("div", { class: "make-image-output-scroll" }, previewStrip, viewer);

  const refsStrip = el("div", { class: "make-image-composer-attachments" });
  const fileInput = el("input", { type: "file", accept: "image/*", class: "hidden" });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const res = await api("POST", "/api/images/import", fd);
      state.refs.push(res.path);
      renderRefs();
      session.persist();
      toast("已添加参考图");
    } catch (e) { toast(e.message); }
    fileInput.value = "";
  });

  function renderRefs() {
    clear(refsStrip);
    refsStrip.classList.toggle("hidden", state.refs.length === 0);
    state.refs.forEach((rp, idx) => {
      refsStrip.appendChild(el("div", { class: "make-image-ref-thumb" },
        el("img", { src: localImg(rp), alt: `参考图 ${idx + 1}` }),
        el("button", {
          type: "button",
          "aria-label": `移除参考图 ${idx + 1}`,
          title: "移除参考图",
          onClick: () => { state.refs.splice(idx, 1); renderRefs(); session.persist(); },
        }, "×")
      ));
    });
  }
  renderRefs();

  const themeInput = el("textarea", {
    class: "make-image-composer-subject",
    rows: "3",
    "aria-label": "画面主题描述",
    placeholder: "描述想要创作的画面主题或故事，例如：周末早晨阳光洒进窗台的手冲咖啡桌…（Ctrl/⌘ + Enter 立即生成）",
  });
  themeInput.value = state.theme;
  themeInput.addEventListener("input", () => {
    state.theme = themeInput.value;
    if (!state.promptCustomized) scheduleRefresh();
  });
  themeInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      doGenerate(false);
    }
  });

  const addRefBtn = el("button", {
    type: "button",
    class: "make-image-add-reference",
    title: "添加参考图",
    "aria-label": "添加参考图",
    onClick: () => fileInput.click(),
  }, "+");

  const modelSel = buildGroupedModelSelect(modRes, state.modelRef);
  state.modelRef = modelSel.value;
  modelSel.addEventListener("change", () => {
    state.modelRef = modelSel.value;
    state.promptCustomized = false;
    refreshPromptAndQuote();
  });

  const countSel = el("select", { class: "select select-sm", "aria-label": "生成张数" },
    ...[1, 2, 3, 4].map((n) => el("option", { value: String(n) }, `${n} 张`))
  );
  countSel.value = String(state.count);
  countSel.addEventListener("change", () => { state.count = Number(countSel.value); refreshQuote(); });

  const quoteBadge = el("span", { class: "badge", title: "生成前预估费用" }, "报价计算中…");
  const resetBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: () => {
      state.theme = "";
      state.text = "";
      state.refs = [];
      state.promptCustomized = false;
      state.customPrompt = "";
      state.activeRun = null;
      themeInput.value = "";
      textInput.value = "";
      renderRefs();
      renderViewer();
      refreshPromptAndQuote();
      session.persist();
    },
  }, "清空");
  const genBtn = el("button", { type: "submit", class: "btn btn-primary" }, "开始生成");

  const composer = el("form", { class: "make-image-composer", action: "/api/generate", method: "post" },
    fileInput,
    refsStrip,
    themeInput,
    el("div", { class: "make-image-composer-bottom" },
      addRefBtn,
      modelSel,
      countSel,
      quoteBadge,
      el("div", { class: "make-image-composer-actions" }, resetBtn, genBtn)
    )
  );
  composer.addEventListener("submit", (e) => { e.preventDefault(); doGenerate(false); });

  const conversation = el("section", { class: "make-image-conversation", "aria-label": "画面输出与输入" },
    outputScroll,
    composer
  );

  const workspace = el("div", { class: "make-image-chat-workspace" }, leftPane, conversation);
  const slotContainer = el("div", { style: { marginTop: "4px" } });

  root.append(workspace, slotContainer);

  mountSlotPanels(slotContainer, "create-footer", {
    view: "create",
    recipe: () => ({ style: state.style, style2: state.fusion ? state.style2 : "", layout: state.layout, color: state.color, tone: state.tone, mode: state.mode, ratio: state.ratio }),
    applyTheme: (t) => { themeInput.value = t; state.theme = t; refreshPromptAndQuote(); },
  });

  function syncFormInputs() {
    controls.sync();
    resChoices.sync(state.resolution);
    qualChoices.sync(state.quality);
    textInput.value = state.text || "";
    redrawChk.checked = Boolean(state.redraw);
    updateTextVisibility();
  }

  function renderPreview() {
    clear(previewStrip);
    const prev = state.preview || {};
    const c = state.compiled || {};
    const chips = [
      prev.styleImage && { img: packImg(prev.styleImage), label: `${state.style} ${prev.styleName || ""}` },
      prev.style2Image && { img: packImg(prev.style2Image), label: `+ ${state.style2}` },
      prev.layoutImage && { img: packImg(prev.layoutImage), label: state.layout },
      prev.colorImage && { img: packImg(prev.colorImage), label: state.color },
      prev.toneImage && { img: packImg(prev.toneImage), label: state.tone },
    ].filter(Boolean);

    previewStrip.append(
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        ...chips.map((ch) => el("div", { class: "make-image-chip" },
          el("img", { src: ch.img, alt: "" }),
          el("span", null, ch.label)
        ))
      ),
      el("div", { class: "row" },
        el("span", { class: "badge" }, `${state.ratio} · ${state.resolution.toUpperCase()}`),
        c.useReference ? el("span", { class: "badge badge-accent" }, "参考图激活") : null,
        c.activation ? el("span", { class: "badge badge-warn", title: c.activation }, "带激活词") : null
      )
    );
  }

  function renderViewer() {
    clear(viewer);
    const run = state.activeRun;
    if (!run) {
      const styleObj = styles.find((x) => x.number === state.style);
      const thumb = styleObj?.image ? packImg(styleObj.image) : "/img/logo.svg";
      viewer.appendChild(el("div", { class: "make-image-ready-card", style: { gridColumn: "1 / -1" } },
        el("img", { src: thumb, alt: styleObj?.generation_name || "", style: { width: "132px", height: "132px", objectFit: "cover", borderRadius: "10px", border: "1px solid var(--line)" } }),
        el("div", { class: "col", style: { flex: "1", minWidth: "200px" } },
          el("span", { class: "style-code" }, state.style || "就绪"),
          el("h3", { style: { margin: 0 } }, `${styleObj?.nameZh || styleObj?.generation_name || "准备就绪"} · 零费用配方预览`),
          el("p", { class: "muted", style: { margin: 0, maxWidth: "520px" } }, styleObj?.traits || "在下方输入框描述画面主题后点击「开始生成」，生成图像默认保存在本地工作区。"),
          el("div", { class: "row", style: { marginTop: "4px" } },
            el("span", { class: "badge" }, `比例 ${state.ratio}`),
            el("span", { class: "badge" }, state.mode === "pure-image" ? "纯图" : (state.mode === "poster" ? "海报" : "图文")),
            el("span", { class: "badge" }, state.resolution.toUpperCase())
          )
        )
      ));
      return;
    }

    (run.images || []).forEach((im, idx) => {
      if (im.status === "queued" || im.status === "running") {
        viewer.appendChild(el("div", { class: "sketch-loader", style: { aspectRatio: ratioToCss(state.ratio) } },
          el("span", { class: "dot-pulse" }),
          el("strong", null, `第 ${idx + 1} 张 · ${im.status === "running" ? "正在绘制…" : "排队中…"}`),
          el("span", { class: "muted" }, run.modelLabel || run.model),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: async () => { await api("POST", `/api/images/${encodeURIComponent(im.id)}/cancel`); toast("已取消"); },
          }, "取消")
        ));
        return;
      }

      if (im.status === "failed" || im.status === "canceled") {
        viewer.appendChild(el("div", { class: "sketch-loader" },
          el("span", { class: "badge badge-err" }, im.status === "canceled" ? "已取消" : "生成失败"),
          el("span", { class: "muted", style: { textAlign: "center" } }, im.error || "未知错误"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            onClick: async () => { await api("POST", `/api/images/${encodeURIComponent(im.id)}/retry`); toast("已重新入队"); },
          }, "重试这张")
        ));
        return;
      }

      viewer.appendChild(el("div", { class: "style-card" },
        el("img", {
          class: "reveal-img",
          src: localImg(im.path),
          alt: `${run.title || "成图"} #${idx + 1}`,
          style: { width: "100%", maxHeight: "420px", objectFit: "contain", background: "var(--paper)", cursor: "zoom-in" },
          onClick: () => openLightbox(im, run),
        }),
        el("div", { class: "style-body", style: { marginTop: "auto" } },
          el("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "6px" } },
            el("span", { class: "muted mono" }, `${im.width || "?"}×${im.height || "?"}`),
            run.publishedWorkId ? el("span", { class: "badge badge-ok" }, "已发布") : el("span", { class: "badge" }, "仅本地")
          ),
          el("div", { class: "row" },
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: async () => { await api("POST", `/api/images/${encodeURIComponent(im.id)}/copy`); toast("图片已复制到剪贴板"); },
            }, "📋 复制"),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => ctx.go("annotate", { runId: run.id }),
            }, "📌 批注"),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => {
                state.refs = [im.path];
                renderRefs();
                toast("已将成图设为参考图");
              },
            }, "🔁 垫图"),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => ctx.go("works", { openRun: run.id }),
            }, "☁ 发布")
          )
        )
      ));
    });
  }

  function openLightbox(im, run) {
    const body = el("div", { class: "col", style: { alignItems: "center" } },
      el("img", { src: localImg(im.path), alt: run.title || "", style: { maxWidth: "100%", maxHeight: "70vh", borderRadius: "8px" } }),
      el("div", { class: "muted mono" }, `${im.path} (${im.width}×${im.height})`)
    );
    showModal(run.title || "大图预览", body, [
      el("button", { type: "button", class: "btn", onClick: async () => { await api("POST", `/api/works/${encodeURIComponent(run.id)}/reveal`); } }, "在目录中打开"),
      el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭"),
    ]);
  }

  let refreshTimer = null;
  let promptRevision = 0;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshPromptAndQuote, 180);
  }

  function rawModelFromRef(ref) {
    const idx = ref.indexOf(":");
    return idx >= 0 ? ref.slice(idx + 1) : ref;
  }

  async function refreshPromptAndQuote() {
    const revision = ++promptRevision;
    try {
      const res = await api("POST", "/api/prompt", {
        style: state.style,
        style2: state.fusion ? state.style2 : "",
        layout: state.layout,
        color: state.color,
        tone: state.tone,
        mood: state.mood,
        theme: state.theme || "手绘视觉主题展示",
        ratio: state.ratio,
        text: state.mode === "pure-image" ? "" : state.text,
        model: rawModelFromRef(state.modelRef),
        mode: state.mode,
        redraw: Boolean(state.redraw),
        extra: extraInstructions(state),
      });
      if (revision !== promptRevision || !root.isConnected) return;
      state.compiled = res.result;
      state.preview = res.preview;
      if (!state.promptCustomized) {
        promptEdit.value = res.result?.primary || "";
        promptNote.textContent = `当前语言：${(res.result?.language || "zh").toUpperCase()}（由所选模型决定）`;
      }
      renderPreview();
      if (!state.activeRun) renderViewer();
    } catch {}
    await refreshQuote();
  }

  async function refreshQuote() {
    try {
      const q = await api("POST", "/api/quote", {
        modelRef: state.modelRef,
        resolution: state.resolution,
        quality: state.quality,
        count: state.count,
      });
      state.quote = q;
      quoteBadge.className = "badge" + (q.overLimit ? " badge-warn" : (q.freeCount > 0 || q.source === "provider" ? " badge-ok" : ""));
      if (q.source === "provider") {
        quoteBadge.textContent = "自带接口直出";
      } else if (q.freeCount > 0 && q.totalCents === 0) {
        quoteBadge.textContent = `免费额度（${q.freeCount} 次）`;
      } else {
        quoteBadge.textContent = `预计 ${money(q.totalCents)}` + (q.freeCount > 0 ? `（含免费 ${q.freeCount} 次）` : "");
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
      state.promptCustomized = false;
      syncFormInputs();
      await refreshPromptAndQuote();
      toast(`已摇到：${state.style} + ${state.layout || "自由构图"}`);
    } catch (e) { toast(e.message); }
  }

  function saveCurrentRecipe() {
    openRecipeEditor({
      name: `${state.style}${state.layout ? " + " + state.layout : ""}`,
      styleIds: [state.style, state.fusion ? state.style2 : ""].filter(Boolean),
      layoutId: state.layout,
      colors: state.color ? [state.color] : [],
      tones: state.tone ? [state.tone] : [],
      mood: state.mood,
      ratio: state.ratio,
      mode: state.mode,
    }, async () => {
      const r = await api("GET", "/api/mine/recipes").catch(() => ({ items: [] }));
      clear(recSel);
      recSel.appendChild(el("option", { value: "" }, "— 套用常用配方 —"));
      (r.items || []).forEach((x) => recSel.appendChild(el("option", { value: x.id }, `${x.name} (${(x.styleIds || []).join("+")})`)));
    });
  }

  async function handleExpandTheme() {
    if (!state.theme.trim()) {
      toast("先输入简单主题关键词再扩写");
      return;
    }
    expandBtn.disabled = true;
    try {
      const res = await api("POST", "/api/prompt/expand", {
        theme: state.theme,
        style: state.style,
        mode: state.mode,
      });
      if (res.theme) {
        state.theme = res.theme;
        themeInput.value = res.theme;
        state.promptCustomized = false;
        await refreshPromptAndQuote();
        toast(res.source === "provider" ? "已通过文本模型扩写主题" : "已扩写画面结构描述");
      }
    } catch (e) { toast(e.message); } finally {
      expandBtn.disabled = false;
    }
  }

  async function doGenerate(confirmed) {
    if (!state.theme.trim() && !(state.promptCustomized && promptEdit.value.trim())) {
      toast("请输入想要创作的画面主题");
      themeInput.focus();
      return;
    }
    if (genBtn.disabled) return;
    if (!controls.validate()) { toast("请填写有效比例，并为双画风融合选择两种画风"); return; }
    genBtn.disabled = true;
    try {
      const res = await api("POST", "/api/generate", {
        mode: "single",
        title: (state.theme || "单图创作").slice(0, 28),
        modelRef: state.modelRef,
        resolution: state.resolution,
        quality: state.quality,
        count: state.count,
        confirmed,
        groupId: state.groupId,
        parentId: state.parentId,
        promptCustomized: state.promptCustomized,
        customPrompt: state.promptCustomized ? promptEdit.value : "",
        refs: state.refs,
        input: {
          style: state.style,
          style2: state.fusion ? state.style2 : "",
          layout: state.layout,
          color: state.color,
          tone: state.tone,
          mood: state.mood,
          theme: state.theme,
          ratio: state.ratio,
          text: state.mode === "pure-image" ? "" : state.text,
          mode: state.mode,
          redraw: Boolean(state.redraw),
          extra: extraInstructions(state),
        },
        recipe: {
          id: state.recipeId,
          styleIds: [state.style, state.fusion ? state.style2 : ""].filter(Boolean),
          layoutId: state.layout,
          color: state.color,
          tone: state.tone,
          ratio: state.ratio,
          mode: state.mode,
        },
      });
      if (res.needConfirm) {
        const body = el("div", { class: "col" },
          el("p", null, `本次预计使用网站计费额度 ${money(res.totalCents)}（含免费次数 ${res.freeCount} 次），超过了设置的单次确认阈值 ${money(res.limitCents)}。`),
          el("p", { class: "muted" }, "可在「设置」中调整确认阈值，或改用自己配置的 API 接口直出生图。")
        );
        showModal("费用二次确认", body, [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); doGenerate(true); } }, "确认继续生成"),
        ]);
        return;
      }
      state.activeRun = { ...res.run, images: res.images };
      state.recentRuns = [state.activeRun, ...state.recentRuns.filter((r) => r.id !== state.activeRun.id)];
      renderViewer();
      renderRecentRuns();
      toast("已提交生成队列，完成后自动显影");
    } catch (e) { toast(e.message); } finally {
      genBtn.disabled = false;
      session.persist();
    }
  }

  const unsub = onEvent(async (msg) => {
    if (!root.isConnected) {
      unsub();
      return;
    }
    const rid = msg.data?.runId || msg.data?.id;
    if ((msg.type === "job" || msg.type === "run") && state.activeRun && rid === state.activeRun.id) {
      try {
        const detail = await api("GET", `/api/works/${encodeURIComponent(state.activeRun.id)}`);
        state.activeRun = detail.run;
        renderViewer();
      } catch {}
    }
  });

  renderRecentRuns();
  await refreshPromptAndQuote();
  if (state.activeRun) renderViewer();
}
