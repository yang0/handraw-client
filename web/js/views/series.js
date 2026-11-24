import { api, clear, closeModal, el, localImg, money, onEvent, showModal, toast } from "../api.js";
import { buildGroupedModelSelect } from "./create.js";
import { choices, extraInstructions, field, ratioToCss, recipeControls, resourceId, resourcePicker, studioMount, studioSession } from "./studio-controls.js";

export async function renderSeries(host, ctx, params = {}) {
  host = studioMount(host);
  const [stylesRes, layoutsRes, colorsRes, tonesRes, recRes, modRes, draftsRes] = await Promise.all([
    ...["styles", "layouts", "colors", "tones"].map((k) => api("GET", `/api/resources/${k}`).catch(() => ({ items: [] }))),
    api("GET", "/api/mine/recipes").catch(() => ({ items: [] })),
    api("GET", "/api/models").catch(() => ({})),
    api("GET", "/api/docs/series").catch(() => ({ items: [] })),
  ]);
  if (!host.isConnected) return;
  const styles = stylesRes.items || [], layouts = layoutsRes.items || [];
  const colors = colorsRes.items || [], tones = tonesRes.items || [];
  const recipes = recRes.items || [];
  let drafts = draftsRes.items || [];

  const session = studioSession(host, "series", {
    docId: "", title: "", topic: "", count: 3, style: styles[0]?.number || "FA-013", style2: "",
    layout: "", layoutMode: "ai", layoutRequirement: "", color: "", tone: "", mood: "",
    ratio: "3:4", mode: "graphic-text", resolution: "2k", modelRef: modRes.defaultModel || "",
    cards: [], selected: 0, composerMode: "series", activeRun: null,
  });
  const { root, state } = session;
  if (params.sharedRecipe) {
    for (const key of ["style", "style2", "layout", "color", "tone", "mood", "mode", "ratio", "resolution", "modelRef"]) {
      if (params.sharedRecipe[key] !== undefined) state[key] = params.sharedRecipe[key];
    }
    state.fusion = Boolean(state.style2);
  }
  params.registerSharedGetter?.(() => ({
    style: state.style,
    style2: state.fusion ? state.style2 : "",
    layout: state.layout,
    color: state.color,
    tone: state.tone,
    mood: state.mood,
    mode: state.mode,
    ratio: state.ratio,
    resolution: state.resolution,
    modelRef: state.modelRef,
  }));
  let planning = false, submitting = false, quoteRevision = 0;

  // Header
  const draftSel = el("select", { class: "select select-sm", style: { maxWidth: "170px" }, "aria-label": "系列草稿" });
  function refreshDraftSel() {
    clear(draftSel);
    draftSel.appendChild(el("option", { value: "" }, "— 打开草稿 —"));
    drafts.forEach((d) => draftSel.appendChild(el("option", { value: d.id }, d.name || d.id)));
    draftSel.value = state.docId;
  }
  draftSel.addEventListener("change", () => loadDraft(draftSel.value));

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row", style: { gap: "12px", flexWrap: "wrap" } },
      el("h1", { class: "page-title" }, "生图"),
      params.modeSwitcher || null,
      el("span", { class: "muted" }, "统一画风与色板，先规划分张画面再按张预览或整套出图")
    ),
    el("div", { class: "row" },
      draftSel,
      el("button", { type: "button", class: "btn btn-sm", onClick: saveDraft }, "💾 保存草稿"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works") }, "查看作品库")
    )
  ));

  // Left Column: Shared Properties + Selected Card Inspector
  const titleIn = el("input", { class: "input", value: state.title, placeholder: "未命名系列图" });
  titleIn.addEventListener("input", () => { state.title = titleIn.value; });

  const recSel = el("select", { class: "select select-sm", style: { flex: "1" }, "aria-label": "快速套用配方" },
    el("option", { value: "" }, "— 套用常用配方 —"),
    ...recipes.map((r) => el("option", { value: r.id }, r.name))
  );
  recSel.addEventListener("change", () => {
    const r = recipes.find((x) => x.id === recSel.value);
    if (!r) return;
    Object.assign(state, {
      style: r.styleIds?.[0] || "", style2: r.styleIds?.[1] || "", fusion: Boolean(r.styleIds?.[1]),
      layout: r.layoutId || "", color: r.colors?.[0] || "", tone: r.tones?.[0] || "", mood: r.mood || "",
      mode: r.mode || "graphic-text", ratio: r.ratio || "3:4",
    });
    controls.sync();
    renderStage();
  });

  const controls = recipeControls(state, { styles, layouts, colors, tones }, () => {
    renderStage();
    session.persist();
  }, { layout: false });

  const strategy = choices("图型策略", [["ai", "AI 推荐"], ["fixed", "固定图型"]], state.layoutMode, (v) => {
    state.layoutMode = v;
    syncStrategy();
    renderStage();
  }, { inline: true });

  const fixedLayoutPicker = resourcePicker("固定图型", layouts, state.layout, (v) => {
    state.layout = v;
    renderStage();
    session.persist();
  }, "自由构图", { allowClear: true });

  const requirement = el("input", { class: "input", value: state.layoutRequirement, placeholder: "例如：前两张分镜，后面图鉴，不要封面图" });
  requirement.addEventListener("input", () => { state.layoutRequirement = requirement.value; });
  const requirementField = field("图型要求（可选）", requirement);

  const resChoices = choices("清晰度", [["1k", "1K"], ["2k", "2K"], ["4k", "4K"]], state.resolution, (v) => {
    state.resolution = v;
    refreshQuote();
    session.persist();
  }, { inline: true });

  function syncStrategy() {
    strategy.sync(state.layoutMode);
    fixedLayoutPicker.classList.toggle("hidden", state.layoutMode !== "fixed");
    requirementField.classList.toggle("hidden", state.layoutMode !== "ai");
  }

  const cardInspector = el("section", { class: "batch-series-selected-settings", "aria-label": "当前选中图属性" });

  const propertiesPane = el("aside", { class: "batch-series-properties", "aria-label": "系列与单张设置" },
    field("系列标题", titleIn),
    el("div", { class: "studio-more-row" }, el("span", { class: "studio-row-label" }, "配方"), recSel),
    controls.node,
    strategy,
    fixedLayoutPicker,
    requirementField,
    resChoices,
    cardInspector
  );

  // Right Column: Toolbar + Focused Stage & Thumbnail Rail + Composer Dock
  const stageStatus = el("strong", null, "尚未规划画面");
  const csvFileIn = el("input", { type: "file", accept: ".csv,.txt", class: "hidden" });
  csvFileIn.addEventListener("change", async () => {
    const f = csvFileIn.files?.[0];
    if (f) await importCSVText(await f.text());
    csvFileIn.value = "";
  });

  const exportBar = el("div", { class: "row" },
    el("button", { type: "button", class: "btn btn-sm", onClick: () => exportBatch("zip") }, "📦 ZIP"),
    el("button", { type: "button", class: "btn btn-sm", onClick: () => exportBatch("xiaohongshu") }, "📕 小红书 3:4"),
    el("button", { type: "button", class: "btn btn-sm", onClick: () => state.activeRun && api("POST", `/api/works/${encodeURIComponent(state.activeRun.id)}/reveal`) }, "📂 目录"),
    el("button", { type: "button", class: "btn btn-sm", onClick: () => state.activeRun && ctx.go("works", { openRun: state.activeRun.id }) }, "☁ 发布")
  );

  const topicsArea = el("textarea", { class: "textarea", rows: "4", placeholder: "每行一个画面主题，可直接粘贴多行文本" });
  topicsArea.addEventListener("input", () => {
    state.cards = topicsArea.value.split(/\r?\n/).filter((x) => x.trim()).map((theme, i) => ({ ...state.cards[i], theme: theme.trim() }));
    renderStage(false);
    refreshQuote();
  });
  const bulkDetails = el("details", { class: "studio-more-card" },
    el("summary", { class: "studio-more-summary" },
      el("span", null, "批量粘贴 / 逐行编辑全部主题"),
      el("span", { class: "studio-more-chevron", "aria-hidden": "true" })
    ),
    el("div", { class: "studio-more-body" }, topicsArea)
  );

  const toolbar = el("div", { class: "batch-series-toolbar" },
    stageStatus,
    el("div", { class: "row" },
      csvFileIn,
      el("button", { type: "button", class: "btn btn-sm", onClick: () => csvFileIn.click() }, "导入 CSV"),
      el("button", { type: "button", class: "btn btn-sm", onClick: openCSVPasteDialog }, "粘贴 CSV"),
      exportBar
    )
  );

  const focusedBox = el("div", { class: "batch-series-focused" });
  const thumbsList = el("div", { class: "batch-series-thumbs", role: "group", "aria-label": "系列卡片列表" });
  const addSlotBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    style: { width: "100%" },
    onClick: () => {
      state.cards.push({ title: "", theme: "", text: "", layout: "" });
      state.selected = state.cards.length - 1;
      state.composerMode = "image";
      renderStage();
      refreshQuote();
    },
  }, "+ 添加");
  const railBox = el("div", { class: "batch-series-thumbs-rail" }, thumbsList, addSlotBtn);
  const stageArea = el("div", { class: "batch-series-stage" }, focusedBox, railBox);

  // Composer Dock (switches cleanly between 整套母题 & 图 N 主题 just like handraw-web!)
  const modeSeriesBtn = el("button", { type: "button" }, "整套母题");
  const modeImageBtn = el("button", { type: "button" }, "当前张主题");
  const composerModesBar = el("div", { class: "batch-series-composer-modes", role: "group", "aria-label": "主题编辑范围" },
    modeSeriesBtn, modeImageBtn
  );
  const composerInput = el("textarea", {
    class: "make-image-composer-subject",
    rows: "2",
    style: { minHeight: "56px" },
    placeholder: "描述整套系列图，如：四张咖啡店治愈日常手账，每张聚焦不同时段…",
  });
  composerInput.addEventListener("input", () => {
    if (state.composerMode === "image" && state.cards[state.selected]) {
      state.cards[state.selected].theme = composerInput.value;
      topicsArea.value = state.cards.map((x) => x.theme || "").join("\n");
      renderFocusedHeaderOnly();
      refreshQuote();
    } else {
      state.topic = composerInput.value;
    }
  });

  modeSeriesBtn.addEventListener("click", () => { state.composerMode = "series"; syncComposer(); });
  modeImageBtn.addEventListener("click", () => { if (state.cards[state.selected]) { state.composerMode = "image"; syncComposer(); } });

  const countIn = el("input", { class: "input", type: "number", min: "1", max: "20", value: String(state.count), style: { width: "68px", padding: "4px 8px" }, "aria-label": "规划张数" });
  countIn.addEventListener("input", () => { state.count = Number(countIn.value); });

  const modelSel = buildGroupedModelSelect(modRes, state.modelRef);
  state.modelRef = modelSel.value;
  modelSel.addEventListener("change", () => { state.modelRef = modelSel.value; refreshQuote(); });

  const quoteSpan = el("span", { class: "badge", role: "status" }, "请先规划或添加画面");
  const planNotice = el("span", { class: "studio-notice", role: "status" }, state.planNotice || "");
  const planBtn = el("button", { type: "button", class: "btn btn-sm", onClick: planFromTopic }, "✨ AI 规划");
  const sampleBtn = el("button", { type: "button", class: "btn btn-sm", onClick: () => generateBatch(true, false) }, "先出第 1 张样张");
  const batchBtn = el("button", { type: "button", class: "btn btn-primary", onClick: () => generateBatch(false, false) }, "生成系列图");

  const dock = el("div", { class: "batch-series-dock" },
    composerModesBar,
    composerInput,
    el("div", { class: "batch-series-dock-footer" },
      el("div", { class: "row" },
        modelSel,
        el("label", { class: "row", style: { gap: "4px", fontSize: "12px" } }, "张数", countIn),
        planBtn,
        quoteSpan
      ),
      el("div", { class: "row" }, sampleBtn, batchBtn)
    ),
    planNotice
  );

  const contentPane = el("section", { class: "batch-series-content", "aria-label": "系列图舞台与规划" },
    toolbar,
    bulkDetails,
    stageArea,
    dock
  );

  root.appendChild(el("div", { class: "batch-series-workspace" }, propertiesPane, contentPane));

  function syncComposer() {
    const cur = state.cards[state.selected];
    if (state.composerMode === "image" && !cur) state.composerMode = "series";
    modeSeriesBtn.classList.toggle("is-active", state.composerMode === "series");
    modeImageBtn.classList.toggle("is-active", state.composerMode === "image");
    modeImageBtn.disabled = !cur;
    modeImageBtn.textContent = cur ? `图 ${state.selected + 1} 主题` : "当前张主题";
    if (state.composerMode === "image" && cur) {
      composerInput.placeholder = `描述第 ${state.selected + 1} 张的画面内容…`;
      composerInput.value = cur.theme || "";
    } else {
      composerInput.placeholder = "描述整套系列图，如：四张咖啡店治愈日常，每张聚焦不同角落…";
      composerInput.value = state.topic || "";
    }
  }

  function cardResultAt(idx) {
    const imgs = state.activeRun?.images || [];
    return imgs[idx] || null;
  }

  function renderFocusedHeaderOnly() {
    const elTitle = focusedBox.querySelector("[data-focused-theme]");
    if (elTitle && state.cards[state.selected]) {
      elTitle.textContent = state.cards[state.selected].theme || "（请在下方填写本张主题）";
    }
  }

  function openLightbox(im, title) {
    showModal(title || "大图预览",
      el("div", { class: "col", style: { alignItems: "center" } },
        el("img", { src: localImg(im.path), alt: title || "", style: { maxWidth: "100%", maxHeight: "70vh", borderRadius: "8px" } }),
        el("div", { class: "muted mono" }, `${im.path}`)
      ),
      [el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭")]
    );
  }

  function renderStage(syncLines = true) {
    clear(cardInspector);
    clear(focusedBox);
    clear(thumbsList);

    const total = state.cards.length;
    state.selected = Math.max(0, Math.min(state.selected, total - 1));
    if (syncLines) topicsArea.value = state.cards.map((c) => c.theme || "").join("\n");
    addSlotBtn.disabled = total >= 20;
    exportBar.classList.toggle("hidden", !(state.activeRun?.images?.some((im) => im.status === "done")));
    stageStatus.textContent = total ? `第 ${state.selected + 1} / ${total} 张` : "尚未添加画面";

    const cur = state.cards[state.selected];
    syncComposer();

    if (!cur) {
      cardInspector.appendChild(el("span", { class: "muted" }, "点击右侧「AI 规划」或「+ 添加」来配置单张细节。"));
      focusedBox.appendChild(el("div", { class: "batch-series-visual" },
        el("p", { class: "muted", style: { textAlign: "center" } }, "输入整套母题后点击「AI 规划」，或从右侧栏点击「+ 添加」创建第一张画面。")
      ));
      return;
    }

    // Left: Selected Card Inspector
    const makeInput = (key, label, placeholder, multiline = false) => {
      const input = el(multiline ? "textarea" : "input", { class: multiline ? "textarea" : "input", rows: "3", value: cur[key] || "", placeholder });
      input.value = cur[key] || "";
      input.addEventListener("input", () => {
        cur[key] = input.value;
        if (key === "theme") {
          topicsArea.value = state.cards.map((x) => x.theme || "").join("\n");
          if (state.composerMode === "image") composerInput.value = cur.theme;
          renderFocusedHeaderOnly();
          refreshQuote();
        }
      });
      return field(label, input);
    };

    const cardLayoutPicker = resourcePicker("本图图型", layouts, cur.layout || "", (v) => {
      cur.layout = v;
      renderStage(false);
    }, state.layoutMode === "fixed" ? "沿用整套图型" : "由 AI 推荐", { allowClear: true });

    cardInspector.append(
      el("strong", { style: { fontSize: "13px" } }, `图 ${state.selected + 1} · 单张属性`),
      makeInput("title", "本图标题", "可选，如：封面 / 第一幕"),
      makeInput("theme", "本图主题", "描述本张画面内容", true),
      ...(state.mode !== "pure-image" ? [makeInput("text", "画面文字", "图内短文案（可选）")] : []),
      cardLayoutPicker,
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm", disabled: state.selected === 0, onClick: () => move(-1) }, "← 前移"),
        el("button", { type: "button", class: "btn btn-sm", disabled: state.selected === total - 1, onClick: () => move(1) }, "后移 →"),
        el("button", { type: "button", class: "btn btn-sm btn-danger", onClick: () => { state.cards.splice(state.selected, 1); renderStage(); refreshQuote(); } }, "删除本图")
      )
    );

    // Right Stage: Main Card
    const im = cardResultAt(state.selected);
    const effLayout = cur.layout || (state.layoutMode === "fixed" ? state.layout : "");
    const layoutObj = layouts.find((l) => resourceId(l) === effLayout);

    focusedBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap" } },
      el("div", { class: "row" },
        el("span", { class: "badge badge-accent" }, `#${state.selected + 1}`),
        el("strong", null, cur.title || `第 ${state.selected + 1} 张`),
        layoutObj ? el("span", { class: "badge" }, `${layoutObj.id} ${layoutObj.name}`) : null
      ),
      el("span", { class: "badge" }, im ? ({ queued: "排队中", running: "绘制中…", done: "已完成", failed: "失败", canceled: "已取消" }[im.status] || im.status) : "待生成")
    ));

    const visual = el("div", { class: "batch-series-visual", style: { aspectRatio: ratioToCss(state.ratio) } });
    if (im && im.status === "done" && im.path) {
      visual.appendChild(el("img", {
        class: "reveal-img",
        src: localImg(im.path),
        alt: cur.title || cur.theme || "",
        onClick: () => openLightbox(im, cur.title || `第 ${state.selected + 1} 张`),
      }));
    } else if (im && (im.status === "queued" || im.status === "running")) {
      visual.append(
        el("span", { class: "dot-pulse" }),
        el("strong", null, im.status === "running" ? "正在绘制本张…" : "排队等待生成…")
      );
    } else if (im && im.status === "failed") {
      visual.append(
        el("span", { class: "badge badge-err" }, "生成失败"),
        el("p", { class: "muted", style: { textAlign: "center" } }, im.error || "未知错误"),
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: async () => { await api("POST", `/api/images/${encodeURIComponent(im.id)}/retry`); toast("已重新入队"); } }, "重试这张")
      );
    } else {
      visual.append(
        el("span", { style: { fontSize: "30px", color: "var(--accent)", opacity: "0.45" } }, "✦"),
        el("strong", null, cur.title || `图 ${state.selected + 1}`),
        el("p", { class: "muted", dataset: { focusedTheme: "1" }, style: { textAlign: "center", maxWidth: "420px", margin: "4px 0" } }, cur.theme || "（请在下方填写本张画面主题）")
      );
    }
    focusedBox.appendChild(visual);

    if (im && im.status === "done" && im.path) {
      focusedBox.appendChild(el("div", { class: "row", style: { justifyContent: "flex-end" } },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => api("POST", `/api/images/${encodeURIComponent(im.id)}/copy`).then(() => toast("已复制图片")) }, "📋 复制")
      ));
    }

    // Right Thumbnail Rail
    state.cards.forEach((c, i) => {
      const r = cardResultAt(i);
      const pic = r?.status === "done" && (r.thumb || r.path)
        ? el("img", { src: localImg(r.thumb || r.path), alt: `图 ${i + 1}` })
        : el("span", null, r?.status === "running" ? "…" : String(i + 1));
      thumbsList.appendChild(el("button", {
        type: "button",
        class: "batch-series-thumb" + (i === state.selected ? " is-selected" : ""),
        "aria-pressed": String(i === state.selected),
        title: c.theme || c.title || `第 ${i + 1} 张`,
        onClick: () => {
          state.selected = i;
          renderStage(false);
        },
      },
        el("div", { class: "batch-series-thumb-picture" }, pic),
        el("span", { class: "batch-series-thumb-number" }, `#${i + 1}${r?.status === "done" ? " ✓" : (r?.status === "failed" ? " !" : "")}`)
      ));
    });
  }

  function move(delta) {
    const i = state.selected, j = i + delta;
    if (j < 0 || j >= state.cards.length) return;
    [state.cards[i], state.cards[j]] = [state.cards[j], state.cards[i]];
    state.selected = j;
    renderStage();
  }

  async function planFromTopic() {
    if (planning) return;
    if (!state.topic.trim()) {
      state.composerMode = "series";
      syncComposer();
      toast("请先在底部输入整套母题");
      composerInput.focus();
      return;
    }
    if (!countIn.reportValidity()) return;
    const topic = state.topic, layoutMode = state.layoutMode, count = state.count;
    const requestKey = JSON.stringify([topic, layoutMode, count, state.layout, state.layoutRequirement, state.style]);
    planning = true; planBtn.disabled = true; planNotice.textContent = "正在规划这套图…";
    try {
      const res = await api("POST", "/api/series/plan", {
        topic, count, layoutMode,
        fixedLayout: state.layout, layoutRequirement: state.layoutRequirement, styleId: state.style,
      });
      if (requestKey !== JSON.stringify([state.topic, state.layoutMode, state.count, state.layout, state.layoutRequirement, state.style])) {
        planNotice.textContent = "规划期间设置已变更，请按新设置重新规划。"; return;
      }
      if (!(res.cards || []).length) throw new Error("未得到有效画面主题，请重试或手动添加");
      const apply = () => {
        state.cards = res.cards; state.selected = 0; state.composerMode = "image";
        state.planNotice = res.source === "local" ? "已使用本地模板规划，可在右侧逐张调整。" : "规划完成，可在右侧逐张查看和微调。";
        planNotice.textContent = state.planNotice;
        renderStage();
        refreshQuote();
        session.persist();
      };
      if (state.cards.some((c) => c.theme?.trim())) {
        planNotice.textContent = "新规划已就绪，确认后替换当前主题。";
        showModal("应用新规划", el("div", { class: "col" }, el("p", null, "新规划将替换当前系列主题。"),
          ...res.cards.map((c, i) => el("p", null, `${i + 1}. ${c.theme}`))), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "保留当前主题"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); apply(); } }, "应用新规划"),
        ]);
      } else apply();
    } catch (e) { planNotice.textContent = e.message; } finally { planning = false; planBtn.disabled = false; }
  }

  async function importCSVText(csv) {
    try {
      const res = await api("POST", "/api/series/plan", { csv });
      if (!res.cards?.length) throw new Error("CSV 中没有有效主题");
      state.cards = res.cards; state.selected = 0; state.composerMode = "image";
      renderStage(); refreshQuote(); session.persist();
      toast(`已导入 ${res.cards.length} 张`);
    } catch (e) { toast(e.message); }
  }

  function openCSVPasteDialog() {
    const input = el("textarea", { class: "textarea", rows: "8", placeholder: "theme,title,layout,text" });
    showModal("粘贴 CSV", field("CSV 数据", input), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); importCSVText(input.value); } }, "导入"),
    ]);
  }

  async function refreshQuote() {
    const count = state.cards.filter((c) => c.theme?.trim()).length;
    const revision = ++quoteRevision;
    if (!count) { quoteSpan.textContent = "请先规划或填写主题"; return; }
    try {
      const q = await api("POST", "/api/quote", { modelRef: state.modelRef, resolution: state.resolution, count });
      if (revision !== quoteRevision) return;
      quoteSpan.textContent = q.source === "provider" ? `自带接口 · ${count} 张` : `预计 ${money(q.totalCents)} · ${count} 张`;
    } catch { if (revision === quoteRevision) quoteSpan.textContent = `${count} 张待生成`; }
  }

  async function generateBatch(sampleOnly, confirmed) {
    if (submitting) return;
    if (!controls.validate()) { toast("请检查比例，并为双画风融合选择两种画风"); return; }
    const cards = sampleOnly ? state.cards.slice(0, 1) : state.cards;
    if (!cards.length || cards.some((c) => !c.theme?.trim())) { toast("请为每张图片填写主题"); return; }
    submitting = true; sampleBtn.disabled = true; batchBtn.disabled = true;
    try {
      const res = await api("POST", "/api/generate", {
        mode: "series", title: (state.title || state.topic || "系列图") + (sampleOnly ? " · 样张" : ""),
        modelRef: state.modelRef, resolution: state.resolution, confirmed,
        items: cards.map((c) => ({
          theme: c.theme.trim(), style: state.style, style2: state.fusion ? state.style2 : "",
          layout: c.layout || (state.layoutMode === "fixed" ? state.layout : ""),
          color: state.color, tone: state.tone, mood: state.mood, ratio: state.ratio,
          text: state.mode === "pure-image" ? "" : c.text || "", mode: state.mode, extra: extraInstructions(state),
        })),
      });
      if (res.needConfirm) {
        showModal("生成费用确认", el("p", null, `本次 ${res.count} 张，预计 ${money(res.totalCents)}，继续生成？`), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); generateBatch(sampleOnly, true); } }, "确认生成"),
        ]);
        return;
      }
      state.activeRun = { ...res.run, images: res.images };
      renderStage(false);
      session.persist();
      toast("已加入生成队列，完成后自动在右侧显影");
    } catch (e) { toast(e.message); } finally { submitting = false; sampleBtn.disabled = false; batchBtn.disabled = false; }
  }

  async function exportBatch(format) {
    if (!state.activeRun) return;
    try {
      const res = await api("POST", `/api/works/${encodeURIComponent(state.activeRun.id)}/export`, { format });
      toast("已导出到：" + res.path);
    } catch (e) { toast(e.message); }
  }

  async function saveDraft() {
    try {
      const res = await api("PUT", `/api/docs/series/${encodeURIComponent(state.docId || "new")}`, {
        name: state.title || state.topic || "未命名系列图", data: { ...state, activeRun: null },
      });
      state.docId = res.doc.id;
      drafts = (await api("GET", "/api/docs/series")).items || [];
      refreshDraftSel(); session.persist(); toast("系列草稿已保存");
    } catch (e) { toast(e.message); }
  }

  async function loadDraft(id) {
    if (!id) return;
    try {
      const r = await api("GET", `/api/docs/series/${encodeURIComponent(id)}`);
      const data = typeof r.doc.data === "string" ? JSON.parse(r.doc.data) : r.doc.data;
      Object.assign(state, data, { docId: r.doc.id, activeRun: null });
      state.fusion = data.fusion ?? Boolean(data.style2);
      titleIn.value = state.title || "";
      countIn.value = String(state.count || 3);
      requirement.value = state.layoutRequirement || "";
      modelSel.value = state.modelRef;
      resChoices.sync(state.resolution);
      fixedLayoutPicker.sync(state.layout);
      controls.sync(); syncStrategy(); renderStage(); refreshQuote(); session.persist();
    } catch (e) { toast(e.message); }
  }

  const unsub = onEvent(async (msg) => {
    if (!root.isConnected) { unsub(); return; }
    const rid = msg.data?.runId || msg.data?.id;
    if ((msg.type === "job" || msg.type === "run") && state.activeRun?.id === rid) {
      try {
        state.activeRun = (await api("GET", `/api/works/${encodeURIComponent(rid)}`)).run;
        renderStage(false);
        session.persist();
      } catch {}
    }
  });

  refreshDraftSel();
  syncStrategy();
  renderStage();
  refreshQuote();
  if (params.docId && params.docId !== state.docId) await loadDraft(params.docId);
  if (state.activeRun?.id) {
    const runId = state.activeRun.id;
    try {
      const detail = await api("GET", `/api/works/${encodeURIComponent(runId)}`);
      if (state.activeRun?.id === runId) { state.activeRun = detail.run; renderStage(false); }
    } catch {}
  }
}
