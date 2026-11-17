import { api, clear, closeModal, el, localImg, money, onEvent, showModal, toast } from "../api.js";
import { buildGroupedModelSelect } from "./create.js";

export async function renderSeries(root, ctx, params = {}) {
  clear(root);

  const [stylesRes, layoutsRes, colorsRes, tonesRes, recRes, modRes, draftsRes] = await Promise.all([
    api("GET", "/api/resources/styles").catch(() => ({ items: [] })),
    api("GET", "/api/resources/layouts").catch(() => ({ items: [] })),
    api("GET", "/api/resources/colors").catch(() => ({ items: [] })),
    api("GET", "/api/resources/tones").catch(() => ({ items: [] })),
    api("GET", "/api/mine/recipes").catch(() => ({ items: [] })),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [] })),
    api("GET", "/api/docs/series").catch(() => ({ items: [] })),
  ]);

  const styles = stylesRes.items || [];
  const layouts = layoutsRes.items || [];
  const colors = colorsRes.items || [];
  const tones = tonesRes.items || [];
  const recipes = recRes.items || [];
  let drafts = draftsRes.items || [];

  const state = {
    docId: params.docId || "",
    title: "未命名系列图",
    topic: "",
    count: 5,
    style: styles[0]?.number || "FA-013",
    style2: "",
    layout: "",
    color: "",
    tone: "",
    ratio: "3:4",
    mode: "graphic-text",
    resolution: "2k",
    modelRef: modRes.defaultModel || "site:seedream-4.5",
    cards: [
      { title: "封面", theme: "", text: "", layout: "" },
      { title: "要点 1", theme: "", text: "", layout: "" },
      { title: "要点 2", theme: "", text: "", layout: "" },
    ],
    activeRun: null,
  };

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row" },
      el("h1", { class: "page-title" }, "系列图与 CSV 批量"),
      el("span", { class: "muted" }, "锁定统一画风色彩，一次规划多张连贯套图，支持先出样张")
    ),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn btn-sm", onClick: saveDraft }, "💾 保存系列草稿"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works") }, "查看作品库")
    )
  ));

  const draftSel = el("select", { class: "select select-sm", style: { maxWidth: "200px" } });
  const refreshDraftSel = () => {
    clear(draftSel);
    draftSel.appendChild(el("option", { value: "" }, "— 加载已保存系列 —"));
    drafts.forEach((d) => draftSel.appendChild(el("option", { value: d.id }, d.name || d.id)));
    if (state.docId) draftSel.value = state.docId;
  };
  refreshDraftSel();
  draftSel.addEventListener("change", async () => {
    if (!draftSel.value) return;
    try {
      const r = await api("GET", `/api/docs/series/${encodeURIComponent(draftSel.value)}`);
      const data = typeof r.doc?.data === "string" ? JSON.parse(r.doc.data) : (r.doc?.data || {});
      state.docId = r.doc.id;
      state.title = r.doc.name || data.title || state.title;
      Object.assign(state, data);
      syncBaseControls();
      renderCards();
      toast("已加载系列草稿");
    } catch (e) { toast(e.message); }
  });

  // Base recipe controls
  const recSel = el("select", { class: "select select-sm" },
    el("option", { value: "" }, "— 从配方加载 —"),
    ...recipes.map((r) => el("option", { value: r.id }, r.name))
  );
  recSel.addEventListener("change", () => {
    const r = recipes.find((x) => x.id === recSel.value);
    if (!r) return;
    state.style = r.styleIds?.[0] || state.style;
    state.style2 = r.styleIds?.[1] || "";
    state.layout = r.layoutId || "";
    state.color = r.colors?.[0] || "";
    state.tone = r.tones?.[0] || "";
    state.ratio = r.ratio || state.ratio;
    state.mode = r.mode || state.mode;
    syncBaseControls();
  });

  const mkSel = (items, empty, getId, getLabel, onChange) => {
    const sel = el("select", { class: "select select-sm" });
    if (empty) sel.appendChild(el("option", { value: "" }, empty));
    items.forEach((it) => sel.appendChild(el("option", { value: getId(it) }, getLabel(it))));
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  };

  const styleSel = mkSel(styles, "", (s) => s.number, (s) => `${s.number} · ${s.nameZh || s.generation_name}`, (v) => { state.style = v; });
  const layoutSel = mkSel(layouts, "（默认自由构图）", (l) => l.id, (l) => `${l.id} · ${l.name}`, (v) => { state.layout = v; });
  const colorSel = mkSel(colors, "（随画风）", (c) => c.id, (c) => `${c.id} · ${c.name_zh || c.name_en}`, (v) => { state.color = v; });
  const toneSel = mkSel(tones, "（自然光影）", (t) => t.id, (t) => `${t.id} · ${t.name_zh || t.name_en}`, (v) => { state.tone = v; });
  const ratioSel = mkSel(["3:4", "1:1", "4:3", "9:16", "16:9"], "", (x) => x, (x) => x, (v) => { state.ratio = v; });
  const modeSel = el("select", { class: "select select-sm" },
    el("option", { value: "graphic-text" }, "图文模式"),
    el("option", { value: "pure-image" }, "纯画面")
  );
  modeSel.addEventListener("change", () => { state.mode = modeSel.value; });

  function syncBaseControls() {
    styleSel.value = state.style || "";
    layoutSel.value = state.layout || "";
    colorSel.value = state.color || "";
    toneSel.value = state.tone || "";
    ratioSel.value = state.ratio || "3:4";
    modeSel.value = state.mode === "pure-image" ? "pure-image" : "graphic-text";
    titleIn.value = state.title || "";
    topicIn.value = state.topic || "";
  }

  const titleIn = el("input", { class: "input", style: { maxWidth: "220px" }, value: state.title, placeholder: "系列名称" });
  titleIn.addEventListener("input", () => { state.title = titleIn.value; });

  const recipeCard = el("section", { class: "card", style: { marginBottom: "14px" } },
    el("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "8px" } },
      el("div", { class: "row" }, el("strong", null, "锁定基底配方"), recSel, draftSel),
      titleIn
    ),
    el("div", { class: "row" },
      el("span", { class: "muted" }, "画风"), styleSel,
      el("span", { class: "muted" }, "图型"), layoutSel,
      el("span", { class: "muted" }, "色彩"), colorSel,
      el("span", { class: "muted" }, "影调"), toneSel,
      el("span", { class: "muted" }, "比例"), ratioSel,
      el("span", { class: "muted" }, "模式"), modeSel
    )
  );
  root.appendChild(recipeCard);

  // Plan & CSV bar
  const topicIn = el("input", { class: "input", style: { flex: "1", minWidth: "220px" }, placeholder: "输入系列主题，例如：手冲咖啡入门 6 步指南 / 宋代文人日常审美…" });
  topicIn.addEventListener("input", () => { state.topic = topicIn.value; });
  const countIn = el("input", { class: "input", type: "number", min: "2", max: "20", value: String(state.count), style: { width: "74px" } });
  countIn.addEventListener("input", () => { state.count = Math.max(1, Math.min(20, Number(countIn.value) || 5)); });

  const planBtn = el("button", { type: "button", class: "btn btn-primary", onClick: planFromTopic }, "✨ 拆解分镜");
  const csvFileIn = el("input", { type: "file", accept: ".csv,.txt", class: "hidden" });
  csvFileIn.addEventListener("change", async () => {
    const f = csvFileIn.files?.[0];
    if (!f) return;
    await importCSVText(await f.text());
    csvFileIn.value = "";
  });

  root.appendChild(el("section", { class: "card row", style: { marginBottom: "14px" } },
    topicIn,
    countIn,
    planBtn,
    csvFileIn,
    el("button", { type: "button", class: "btn", onClick: () => csvFileIn.click() }, "📄 导入 CSV 文件"),
    el("button", { type: "button", class: "btn", onClick: openCSVPasteDialog }, "📋 粘贴 CSV"),
    el("button", {
      type: "button",
      class: "btn",
      onClick: () => { state.cards.push({ title: `第 ${state.cards.length + 1} 张`, theme: "", text: "", layout: "" }); renderCards(); refreshQuote(); },
    }, "+ 添加分镜")
  ));

  const cardsWrap = el("div", { class: "col", style: { marginBottom: "14px" } });
  root.appendChild(cardsWrap);

  function renderCards() {
    clear(cardsWrap);
    state.cards.forEach((c, idx) => {
      const cardTitleIn = el("input", { class: "input", style: { maxWidth: "150px" }, value: c.title || "", placeholder: `第 ${idx + 1} 张` });
      cardTitleIn.addEventListener("input", () => { c.title = cardTitleIn.value; });

      const cardThemeIn = el("input", { class: "input", style: { flex: "1", minWidth: "220px" }, value: c.theme || "", placeholder: "本张画面主题描述" });
      cardThemeIn.addEventListener("input", () => { c.theme = cardThemeIn.value; });

      const cardTextIn = el("input", { class: "input", style: { maxWidth: "200px" }, value: c.text || "", placeholder: "画面标注文字（可选）" });
      cardTextIn.addEventListener("input", () => { c.text = cardTextIn.value; });

      const cardLayoutSel = mkSel(layouts, "（沿用基底图型）", (l) => l.id, (l) => `${l.id} ${l.name}`, (v) => { c.layout = v; });
      cardLayoutSel.value = c.layout || "";

      cardsWrap.appendChild(el("div", { class: "card row", style: { padding: "10px 12px" } },
        el("span", { class: "badge badge-accent" }, `#${idx + 1}`),
        cardTitleIn,
        cardThemeIn,
        cardTextIn,
        cardLayoutSel,
        el("button", {
          type: "button",
          class: "btn btn-sm",
          disabled: idx === 0,
          onClick: () => { [state.cards[idx - 1], state.cards[idx]] = [state.cards[idx], state.cards[idx - 1]]; renderCards(); },
        }, "↑"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          disabled: idx === state.cards.length - 1,
          onClick: () => { [state.cards[idx + 1], state.cards[idx]] = [state.cards[idx], state.cards[idx + 1]]; renderCards(); },
        }, "↓"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          disabled: state.cards.length <= 1,
          onClick: () => { state.cards.splice(idx, 1); renderCards(); refreshQuote(); },
        }, "删除")
      ));
    });
  }

  // Execution bar
  const modelSel = buildGroupedModelSelect(modRes, state.modelRef);
  state.modelRef = modelSel.value;
  modelSel.addEventListener("change", () => { state.modelRef = modelSel.value; refreshQuote(); });

  const resSel = el("select", { class: "select select-sm" },
    el("option", { value: "1k" }, "1K"),
    el("option", { value: "2k", selected: true }, "2K"),
    el("option", { value: "4k" }, "4K")
  );
  resSel.addEventListener("change", () => { state.resolution = resSel.value; refreshQuote(); });

  const quoteSpan = el("span", { class: "badge" }, "计算报价…");
  const sampleBtn = el("button", { type: "button", class: "btn", onClick: () => generateBatch(true, false) }, "① 先出第 1 张样张");
  const batchBtn = el("button", { type: "button", class: "btn btn-primary", onClick: () => generateBatch(false, false) }, "② 批量生成全套");

  root.appendChild(el("div", { class: "studio-bar", style: { marginBottom: "16px", flexWrap: "wrap" } },
    modelSel,
    resSel,
    quoteSpan,
    sampleBtn,
    batchBtn
  ));

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
    if (!state.topic.trim()) {
      toast("先输入系列主题");
      topicIn.focus();
      return;
    }
    planBtn.disabled = true;
    try {
      const res = await api("POST", "/api/series/plan", { topic: state.topic.trim(), count: state.count });
      const cards = res.cards || res.raw?.items || res.raw?.cards || [];
      if (!cards.length) {
        toast("未拆解出有效分镜，请手动编辑");
        return;
      }
      state.cards = cards.map((c, i) => ({
        title: c.title || `第 ${i + 1} 张`,
        theme: c.theme || c.prompt || state.topic,
        text: c.text || "",
        layout: c.layout || "",
      }));
      if (!state.title || state.title === "未命名系列图") {
        state.title = state.topic.trim().slice(0, 24);
        titleIn.value = state.title;
      }
      renderCards();
      refreshQuote();
      toast(`已拆解 ${state.cards.length} 张分镜`);
    } catch (e) { toast(e.message); } finally {
      planBtn.disabled = false;
    }
  }

  async function importCSVText(csvText) {
    try {
      const res = await api("POST", "/api/series/plan", { csv: csvText });
      const cards = res.cards || [];
      if (!cards.length) {
        toast("CSV 中没有有效行（首列应为主题）");
        return;
      }
      state.cards = cards.map((c, i) => ({
        title: c.title || `第 ${i + 1} 张`,
        theme: c.theme || "",
        text: c.text || "",
        layout: c.layout || "",
      }));
      renderCards();
      refreshQuote();
      toast(`已从 CSV 导入 ${state.cards.length} 张`);
    } catch (e) { toast(e.message); }
  }

  function openCSVPasteDialog() {
    const ta = el("textarea", {
      class: "textarea mono",
      rows: "8",
      placeholder: "theme,title,layout,text\n挑选浅烘咖啡豆,第一步,SC-001,选豆诀窍\n手冲注水手法,第二步,SC-002,三段式注水",
    });
    showModal("粘贴 CSV 数据", el("div", { class: "col" },
      el("p", { class: "muted", style: { margin: 0 } }, "支持列：theme（主题）、title（标题）、layout（可选图型覆盖）、text（文案）"),
      ta
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => { closeModal(); await importCSVText(ta.value); },
      }, "导入"),
    ]);
  }

  async function refreshQuote() {
    try {
      const q = await api("POST", "/api/quote", {
        modelRef: state.modelRef,
        resolution: state.resolution,
        count: Math.max(1, state.cards.length),
      });
      if (q.source === "provider") {
        quoteSpan.textContent = `自带接口 · ${state.cards.length} 张`;
        quoteSpan.className = "badge badge-ok";
      } else {
        quoteSpan.textContent = `全套预估 ${money(q.totalCents)}（${state.cards.length} 张）`;
        quoteSpan.className = "badge" + (q.overLimit ? " badge-warn" : "");
      }
    } catch {
      quoteSpan.textContent = `${state.cards.length} 张待生图`;
      quoteSpan.className = "badge";
    }
  }

  async function generateBatch(sampleOnly, confirmed) {
    const srcCards = sampleOnly ? state.cards.slice(0, 1) : state.cards;
    const items = srcCards.filter((c) => c.theme.trim()).map((c) => ({
      theme: c.theme.trim(),
      style: state.style,
      style2: state.style2,
      layout: c.layout || state.layout,
      color: state.color,
      tone: state.tone,
      ratio: state.ratio,
      text: c.text || "",
      mode: state.mode,
    }));
    if (!items.length) {
      toast("请至少填写一张卡片的画面主题");
      return;
    }
    try {
      const res = await api("POST", "/api/generate", {
        mode: "series",
        title: (state.title || state.topic || "系列套图") + (sampleOnly ? " · 样张" : ""),
        modelRef: state.modelRef,
        resolution: state.resolution,
        confirmed,
        items,
        recipe: {
          styleIds: [state.style, state.style2].filter(Boolean),
          layoutId: state.layout,
          color: state.color,
          tone: state.tone,
          ratio: state.ratio,
          mode: state.mode,
        },
      });
      if (res.needConfirm) {
        showModal("批量生成费用确认", el("p", null, `预计消耗网站额度 ${money(res.totalCents)}（共 ${res.count} 张，含免费 ${res.freeCount} 次）。确认批量生成？`), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); generateBatch(sampleOnly, true); } }, "确认生成"),
        ]);
        return;
      }
      state.activeRun = { ...res.run, images: res.images };
      renderOutput();
      toast(sampleOnly ? "第 1 张样张已加入队列" : `全套 ${items.length} 张已加入队列`);
    } catch (e) { toast(e.message); }
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
        name: state.title || state.topic || "系列草稿",
        data: {
          title: state.title,
          topic: state.topic,
          style: state.style,
          style2: state.style2,
          layout: state.layout,
          color: state.color,
          tone: state.tone,
          ratio: state.ratio,
          mode: state.mode,
          cards: state.cards,
        },
      });
      state.docId = res.doc.id;
      const dRes = await api("GET", "/api/docs/series").catch(() => ({ items: [] }));
      drafts = dRes.items || [];
      refreshDraftSel();
      toast("系列草稿已保存");
    } catch (e) { toast(e.message); }
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
        renderOutput();
      } catch {}
    }
  });

  syncBaseControls();
  renderCards();
  refreshQuote();
}
