import { api, clear, closeModal, el, localImg, money, onEvent, showModal, toast } from "../api.js";
import { buildGroupedModelSelect } from "./create.js";
import { choices, extraInstructions, field, recipeControls, studioMount, studioSession } from "./studio-controls.js";

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
    docId: "", title: "", topic: "", count: 3, style: styles[0]?.number || "", style2: "",
    layout: "", layoutMode: "ai", layoutRequirement: "", color: "", tone: "", mood: "",
    ratio: "3:4", mode: "graphic-text", resolution: "2k", modelRef: modRes.defaultModel || "",
    cards: [], selected: 0, activeRun: null,
  });
  const { root, state } = session;
  let planning = false, submitting = false, quoteRevision = 0;
  root.appendChild(el("div", { class: "page-head" },
    el("h1", { class: "page-title" }, "系列图"),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn btn-sm", onClick: saveDraft }, "保存系列草稿"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works") }, "查看作品库"))));
  const draftSel = el("select", { class: "select" });
  function refreshDraftSel() {
    clear(draftSel);
    draftSel.appendChild(el("option", { value: "" }, "打开系列草稿"));
    drafts.forEach((d) => draftSel.appendChild(el("option", { value: d.id }, d.name || d.id)));
    draftSel.value = state.docId;
  }
  draftSel.addEventListener("change", () => loadDraft(draftSel.value));
  const titleIn = el("input", { class: "input", value: state.title, placeholder: "未命名系列图" });
  titleIn.addEventListener("input", () => { state.title = titleIn.value; });
  const recSel = el("select", { class: "select" }, el("option", { value: "" }, "套用配方"),
    ...recipes.map((r) => el("option", { value: r.id }, r.name)));
  recSel.addEventListener("change", () => {
    const r = recipes.find((x) => x.id === recSel.value);
    if (!r) return;
    Object.assign(state, { style: r.styleIds?.[0] || "", style2: r.styleIds?.[1] || "", fusion: Boolean(r.styleIds?.[1]),
      layout: r.layoutId || "", color: r.colors?.[0] || "", tone: r.tones?.[0] || "", mood: r.mood || "",
      mode: r.mode || "graphic-text", ratio: r.ratio || "3:4" });
    controls.sync(); renderCards();
  });
  const controls = recipeControls(state, { styles, layouts, colors, tones }, () => { renderCards(); session.persist(); });
  const strategy = choices("图型策略", [["ai", "AI 推荐"], ["fixed", "固定图型"]], state.layoutMode, (v) => {
    state.layoutMode = v; syncStrategy(); renderCards();
  });
  const requirement = el("input", { class: "input", value: state.layoutRequirement, placeholder: "例如：前两张分镜，后面图鉴，不要封面图" });
  requirement.addEventListener("input", () => { state.layoutRequirement = requirement.value; });
  const requirementField = field("图型要求（可选）", requirement);
  function syncStrategy() {
    strategy.sync(state.layoutMode);
    controls.layoutPicker.classList.toggle("hidden", state.layoutMode !== "fixed");
    requirementField.classList.toggle("hidden", state.layoutMode !== "ai");
  }
  const properties = el("aside", { class: "card series-properties" },
    field("系列名称", titleIn), field("系列草稿", draftSel), field("快速套用配方", recSel), controls.node, strategy, requirementField);
  const thumbs = el("div", { class: "series-thumbs", role: "group", "aria-label": "切换系列图" });
  const cardsWrap = el("div", { class: "card col series-editor" });
  const topics = el("textarea", { class: "textarea", rows: "5", placeholder: "每行一个画面主题，可直接粘贴多行文本" });
  const topicsField = field("逐行编辑主题", topics, "每行对应一张图；已有标题和文案会按原位置保留。");
  topics.addEventListener("input", () => {
    state.cards = topics.value.split(/\r?\n/).filter((x) => x.trim()).map((theme, i) => ({ ...state.cards[i], theme: theme.trim() }));
    renderCards(false); refreshQuote();
  });
  function renderCards(syncLines = true) {
    clear(thumbs); clear(cardsWrap);
    state.selected = Math.max(0, Math.min(state.selected, state.cards.length - 1));
    state.cards.forEach((c, i) => thumbs.appendChild(el("button", {
      type: "button", class: "btn btn-sm" + (i === state.selected ? " btn-primary" : ""),
      "aria-pressed": i === state.selected, onClick: () => { state.selected = i; renderCards(); },
    }, `图 ${i + 1}`)));
    thumbs.appendChild(el("button", { type: "button", class: "btn btn-sm", disabled: state.cards.length >= 20, onClick: () => {
      state.cards.push({ title: "", theme: "", text: "", layout: "" }); state.selected = state.cards.length - 1; renderCards(); refreshQuote();
    } }, "+ 添加一张"));
    if (syncLines) topics.value = state.cards.map((c) => c.theme).join("\n");
    topicsField.classList.toggle("hidden", state.layoutMode !== "fixed");
    const c = state.cards[state.selected];
    if (!c) { cardsWrap.appendChild(el("p", { class: "muted" }, "输入整套母题后点击 AI 规划，也可添加画面自行编写。")); return; }
    const makeInput = (key, label, placeholder, multiline = false) => {
      const input = el(multiline ? "textarea" : "input", { class: multiline ? "textarea" : "input", rows: "4", value: c[key] || "", placeholder });
      input.value = c[key] || "";
      input.addEventListener("input", () => { c[key] = input.value; if (key === "theme") topics.value = state.cards.map((x) => x.theme).join("\n"); refreshQuote(); });
      return field(label, input);
    };
    const layoutSel = el("select", { class: "select" }, el("option", { value: "" }, "沿用整套图型"),
      ...layouts.map((l) => el("option", { value: l.id }, `${l.id} · ${l.name}`)));
    layoutSel.value = c.layout || "";
    layoutSel.addEventListener("change", () => { c.layout = layoutSel.value; });
    cardsWrap.append(el("strong", null, `图 ${state.selected + 1} · 单张属性`),
      makeInput("title", "本图标题", "可选"), makeInput("theme", "本图主题", "描述本张画面内容", true),
      ... (state.mode !== "pure-image" ? [makeInput("text", "画面文字", "可选")] : []),
      field("本图图型", layoutSel),
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm", disabled: state.selected === 0, onClick: () => move(-1) }, "前移"),
        el("button", { type: "button", class: "btn btn-sm", disabled: state.selected === state.cards.length - 1, onClick: () => move(1) }, "后移"),
        el("button", { type: "button", class: "btn btn-sm btn-danger", onClick: () => { state.cards.splice(state.selected, 1); renderCards(); refreshQuote(); } }, "删除本图")));
  }
  function move(delta) {
    const i = state.selected, j = i + delta;
    [state.cards[i], state.cards[j]] = [state.cards[j], state.cards[i]];
    state.selected = j; renderCards();
  }
  const topicIn = el("textarea", { class: "textarea", rows: "3", value: state.topic, placeholder: "描述整套系列图，例如：三张咖啡店日常，展示不同生活片段…" });
  topicIn.value = state.topic;
  topicIn.addEventListener("input", () => { state.topic = topicIn.value; });
  const countIn = el("input", { class: "input", type: "number", min: "1", max: "10", value: String(state.count) });
  countIn.addEventListener("input", () => { state.count = Number(countIn.value); });
  const planNotice = el("p", { class: "studio-notice", role: "status" }, state.planNotice || "");
  const planBtn = el("button", { type: "button", class: "btn", onClick: planFromTopic }, "AI 规划");
  const modelSel = buildGroupedModelSelect(modRes, state.modelRef);
  state.modelRef = modelSel.value;
  modelSel.addEventListener("change", () => { state.modelRef = modelSel.value; refreshQuote(); });
  const resSel = el("select", { class: "select" }, ...["1k", "2k", "4k"].map((r) => el("option", { value: r }, r.toUpperCase())));
  resSel.value = state.resolution;
  resSel.addEventListener("change", () => { state.resolution = resSel.value; refreshQuote(); });
  const quoteSpan = el("span", { class: "badge", role: "status" });
  const sampleBtn = el("button", { type: "button", class: "btn", onClick: () => generateBatch(true, false) }, "先出第 1 张样张");
  const batchBtn = el("button", { type: "button", class: "btn btn-primary", onClick: () => generateBatch(false, false) }, "生成系列图");
  const csvFileIn = el("input", { type: "file", accept: ".csv,.txt", class: "hidden" });
  csvFileIn.addEventListener("change", async () => { const f = csvFileIn.files?.[0]; if (f) await importCSVText(await f.text()); csvFileIn.value = ""; });
  root.appendChild(el("div", { class: "series-workspace" }, properties,
    el("section", { class: "col" }, cardsWrap, thumbs, topicsField,
      el("div", { class: "card series-plan-form" }, field("整套母题", topicIn),
        el("div", { class: "row" }, field("规划张数", countIn), planBtn, csvFileIn,
          el("button", { type: "button", class: "btn", onClick: () => csvFileIn.click() }, "导入 CSV"),
          el("button", { type: "button", class: "btn", onClick: openCSVPasteDialog }, "粘贴 CSV")), planNotice))));
  root.appendChild(el("div", { class: "studio-bar" }, field("模型", modelSel), field("分辨率", resSel), quoteSpan, sampleBtn, batchBtn));
  // Output viewer & exports
  const outSection = el("section", { class: "col" });
  root.appendChild(outSection);

  function renderOutput() {
    clear(outSection);
    const run = state.activeRun;
    if (!run) return;
    outSection.appendChild(el("div", { class: "page-head" },
      el("h2", { style: { margin: 0, fontSize: "16px" } }, `当前批次：${run.title || "系列图"}`),
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => exportBatch("zip") }, "📦 导出 ZIP"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => exportBatch("xiaohongshu") }, "📕 导出小红书 3:4 套图"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => api("POST", `/api/works/${encodeURIComponent(run.id)}/reveal`) }, "📂 打开文件夹"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works", { openRun: run.id }) }, "☁ 发布到网站")
      )
    ));
    const grid = el("div", { class: "grid-cards" });
    (run.images || []).forEach((im, idx) => {
      if (im.status === "queued" || im.status === "running") {
        grid.appendChild(el("div", { class: "sketch-loader" },
          el("span", { class: "dot-pulse" }),
          el("span", null, `#${idx + 1} · ${im.status === "running" ? "绘制中…" : "排队中…"}`)
        ));
        return;
      }
      if (im.status !== "done") {
        grid.appendChild(el("div", { class: "sketch-loader" },
          el("span", { class: "badge badge-err" }, "失败"),
          el("span", { class: "muted" }, im.error || "生成失败"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            onClick: async () => { await api("POST", `/api/images/${encodeURIComponent(im.id)}/retry`); toast("已重试该卡片"); },
          }, "重试这张")
        ));
        return;
      }
      grid.appendChild(el("div", { class: "style-card" },
        el("img", { class: "style-thumb reveal-img", src: localImg(im.thumb || im.path), alt: im.theme || "" }),
        el("div", { class: "style-body" },
          el("div", { class: "style-name" }, im.theme || `第 ${idx + 1} 张`),
          el("div", { class: "row", style: { marginTop: "6px" } },
            el("button", { type: "button", class: "btn btn-sm", onClick: () => api("POST", `/api/images/${encodeURIComponent(im.id)}/copy`).then(() => toast("已复制")) }, "复制")
          )
        )
      ));
    });
    outSection.appendChild(grid);
  }


  async function planFromTopic() {
    if (planning) return;
    if (!state.topic.trim()) { toast("请先填写整套母题"); topicIn.focus(); return; }
    if (!countIn.reportValidity()) return;
    const topic = state.topic, layoutMode = state.layoutMode, count = state.count;
    const requestKey = JSON.stringify([topic, layoutMode, count, state.layout, state.layoutRequirement, state.style]);
    planning = true; planBtn.disabled = true; planNotice.textContent = "正在规划这套图…";
    try {
      const res = await api("POST", "/api/series/plan", { topic, count, layoutMode,
        fixedLayout: state.layout, layoutRequirement: state.layoutRequirement, styleId: state.style });
      if (requestKey !== JSON.stringify([state.topic, state.layoutMode, state.count, state.layout, state.layoutRequirement, state.style])) {
        planNotice.textContent = "规划期间设置已变更，请按新设置重新规划。"; return;
      }
      if (!(res.cards || []).length) throw new Error("未得到有效画面主题，请重试或手动添加");
      const apply = () => {
        state.cards = res.cards; state.selected = 0;
        state.planNotice = res.source === "local" ? "已使用本地模板规划，可逐张修改后生成。" : "规划完成，可逐张修改主题与图型。";
        planNotice.textContent = state.planNotice; renderCards(); refreshQuote(); session.persist();
      };
      if (state.cards.some((c) => c.theme?.trim())) {
        planNotice.textContent = "新规划已就绪，确认后替换当前主题。";
        showModal("应用新规划", el("div", { class: "col" }, el("p", null, "新规划将替换当前系列主题。"),
          ...res.cards.map((c, i) => el("p", null, `${i + 1}. ${c.theme}`))), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "保留当前主题"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); apply(); } }, "应用新规划")]);
      } else apply();
    } catch (e) { planNotice.textContent = e.message; } finally { planning = false; planBtn.disabled = false; }
  }
  async function importCSVText(csv) {
    try {
      const res = await api("POST", "/api/series/plan", { csv });
      if (!res.cards?.length) throw new Error("CSV 中没有有效主题");
      state.cards = res.cards; state.selected = 0; renderCards(); refreshQuote(); session.persist();
      toast(`已导入 ${res.cards.length} 张`);
    } catch (e) { toast(e.message); }
  }
  function openCSVPasteDialog() {
    const input = el("textarea", { class: "textarea", rows: "8", placeholder: "theme,title,layout,text" });
    showModal("粘贴 CSV", field("CSV 数据", input), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); importCSVText(input.value); } }, "导入")]);
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
        items: cards.map((c) => ({ theme: c.theme.trim(), style: state.style, style2: state.fusion ? state.style2 : "",
          layout: c.layout || (state.layoutMode === "fixed" ? state.layout : ""), color: state.color, tone: state.tone,
          mood: state.mood, ratio: state.ratio, text: state.mode === "pure-image" ? "" : c.text || "", mode: state.mode, extra: extraInstructions(state) })),
      });
      if (res.needConfirm) {
        showModal("生成费用确认", el("p", null, `本次 ${res.count} 张，预计 ${money(res.totalCents)}，继续生成？`), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); generateBatch(sampleOnly, true); } }, "确认生成")]);
        return;
      }
      state.activeRun = { ...res.run, images: res.images }; renderOutput(); session.persist(); toast("已加入生成队列");
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
        name: state.title || state.topic || "未命名系列图", data: { ...state, activeRun: null } });
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
      titleIn.value = state.title || ""; topicIn.value = state.topic || ""; countIn.value = String(state.count || 3);
      requirement.value = state.layoutRequirement || "";
      modelSel.value = state.modelRef; resSel.value = state.resolution;
      controls.sync(); syncStrategy(); renderCards(); renderOutput(); refreshQuote(); session.persist();
    } catch (e) { toast(e.message); }
  }
  const unsub = onEvent(async (msg) => {
    if (!root.isConnected) { unsub(); return; }
    const rid = msg.data?.runId || msg.data?.id;
    if ((msg.type === "job" || msg.type === "run") && state.activeRun?.id === rid) {
      try { state.activeRun = (await api("GET", `/api/works/${encodeURIComponent(rid)}`)).run; renderOutput(); session.persist(); } catch {}
    }
  });
  refreshDraftSel(); syncStrategy(); renderCards(); renderOutput(); refreshQuote();
  if (params.docId && params.docId !== state.docId) await loadDraft(params.docId);
  if (state.activeRun?.id) {
    const runId = state.activeRun.id;
    try {
      const detail = await api("GET", `/api/works/${encodeURIComponent(runId)}`);
      if (state.activeRun?.id === runId) { state.activeRun = detail.run; renderOutput(); }
    } catch {}
  }
}
