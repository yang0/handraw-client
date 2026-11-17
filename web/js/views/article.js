import { api, clear, closeModal, el, localImg, money, onEvent, showModal, toast } from "../api.js";
import { buildGroupedModelSelect } from "./create.js";

function normalizeArticleRatio(r) {
  if (!r || r === "2.35:1") return "21:9";
  return r;
}

export async function renderArticle(root, ctx, params = {}) {
  clear(root);

  const [stylesRes, colorsRes, tonesRes, modRes, draftsRes] = await Promise.all([
    api("GET", "/api/resources/styles").catch(() => ({ items: [] })),
    api("GET", "/api/resources/colors").catch(() => ({ items: [] })),
    api("GET", "/api/resources/tones").catch(() => ({ items: [] })),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [] })),
    api("GET", "/api/docs/article").catch(() => ({ items: [] })),
  ]);

  const styles = stylesRes.items || [];
  const colors = colorsRes.items || [];
  const tones = tonesRes.items || [];
  let drafts = draftsRes.items || [];

  const state = {
    docId: params.docId || "",
    title: "",
    content: "",
    style: styles[0]?.number || "FA-013",
    color: "",
    tone: "",
    mode: "graphic-text",
    resolution: "2k",
    modelRef: modRes.defaultModel || "site:seedream-4.5",
    recommendedStyles: ["FA-013", "FB-001", "FE-001"],
    slots: [],
    previewTab: "wechat", // markdown | wechat
    activeRun: null,
    slotMap: [], // index -> slot index in state.slots
  };

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row" },
      el("h1", { class: "page-title" }, "文章到图文"),
      el("span", { class: "muted" }, "导入长文或链接，一键规划封面与正文锚点配图并导出公众号排版")
    ),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn btn-sm", onClick: saveDraft }, "💾 保存文稿"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works") }, "查看作品库")
    )
  ));

  // Top import/plan toolbar
  const titleIn = el("input", { class: "input", style: { flex: "1", minWidth: "200px" }, placeholder: "输入文章标题…" });
  titleIn.addEventListener("input", () => { state.title = titleIn.value; renderPreview(); });

  const draftSel = el("select", { class: "select select-sm", style: { maxWidth: "180px" } });
  const refreshDraftSel = () => {
    clear(draftSel);
    draftSel.appendChild(el("option", { value: "" }, "— 打开草稿 —"));
    drafts.forEach((d) => draftSel.appendChild(el("option", { value: d.id }, d.name || d.id)));
    if (state.docId) draftSel.value = state.docId;
  };
  refreshDraftSel();
  draftSel.addEventListener("change", async () => {
    if (!draftSel.value) return;
    try {
      const r = await api("GET", `/api/docs/article/${encodeURIComponent(draftSel.value)}`);
      const data = typeof r.doc?.data === "string" ? JSON.parse(r.doc.data) : (r.doc?.data || {});
      state.docId = r.doc.id;
      state.title = data.title || r.doc.name || "";
      state.content = data.content || "";
      state.style = data.style || state.style;
      state.color = data.color || "";
      state.tone = data.tone || "";
      state.slots = Array.isArray(data.slots) ? data.slots : [];
      syncInputs();
      renderSlots();
      renderPreview();
      toast("已加载文章草稿");
    } catch (e) { toast(e.message); }
  });

  const fileIn = el("input", { type: "file", accept: ".md,.markdown,.txt,.docx", class: "hidden" });
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const res = await api("POST", "/api/article/import", fd);
      if (res.title) state.title = res.title;
      state.content = res.content || "";
      syncInputs();
      renderPreview();
      toast("已导入文稿");
    } catch (e) { toast(e.message); }
    fileIn.value = "";
  });

  const planBtn = el("button", { type: "button", class: "btn btn-primary", onClick: planArticle }, "🧭 智能规划配图位");

  root.appendChild(el("section", { class: "card col", style: { marginBottom: "14px" } },
    el("div", { class: "row" },
      titleIn,
      draftSel,
      fileIn,
      el("button", { type: "button", class: "btn", onClick: () => fileIn.click() }, "📄 导入 MD/TXT/DOCX"),
      el("button", { type: "button", class: "btn", onClick: openURLImportDialog }, "🔗 抓取网页链接"),
      planBtn
    )
  ));

  // Style & model strip
  const recChips = el("div", { class: "row" });
  const styleSel = el("select", { class: "select select-sm" });
  styles.forEach((s) => styleSel.appendChild(el("option", { value: s.number }, `${s.number} · ${s.nameZh || s.generation_name}`)));
  styleSel.value = state.style;
  styleSel.addEventListener("change", () => { state.style = styleSel.value; renderRecChips(); });

  const colorSel = el("select", { class: "select select-sm" }, el("option", { value: "" }, "配色随画风"));
  colors.forEach((c) => colorSel.appendChild(el("option", { value: c.id }, `${c.id} · ${c.name_zh || c.name_en}`)));
  colorSel.addEventListener("change", () => { state.color = colorSel.value; });

  const toneSel = el("select", { class: "select select-sm" }, el("option", { value: "" }, "自然影调"));
  tones.forEach((t) => toneSel.appendChild(el("option", { value: t.id }, `${t.id} · ${t.name_zh || t.name_en}`)));
  toneSel.addEventListener("change", () => { state.tone = toneSel.value; });

  const modelSel = buildGroupedModelSelect(modRes, state.modelRef);
  state.modelRef = modelSel.value;
  modelSel.addEventListener("change", () => { state.modelRef = modelSel.value; });

  function renderRecChips() {
    clear(recChips);
    recChips.appendChild(el("span", { class: "muted" }, "推荐画风："));
    (state.recommendedStyles || []).forEach((id) => {
      recChips.appendChild(el("button", {
        type: "button",
        class: "pill-btn" + (state.style === id ? " pill-accent" : ""),
        onClick: () => { state.style = id; styleSel.value = id; renderRecChips(); },
      }, id));
    });
  }
  renderRecChips();

  root.appendChild(el("section", { class: "card row", style: { marginBottom: "14px", justifyContent: "space-between" } },
    el("div", { class: "row" }, recChips, styleSel, colorSel, toneSel, modelSel),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn btn-sm", onClick: () => runGenerate(true, false) }, "① 先出封面样张"),
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => runGenerate(false, false) }, "② 生成全部配图")
    )
  ));

  // Split: left editor + slots, right dual preview + export
  const contentArea = el("textarea", {
    class: "textarea",
    rows: "12",
    placeholder: "在此粘贴或编写 Markdown 正文，规划配图后将按锚点自动插图…",
  });
  contentArea.addEventListener("input", () => { state.content = contentArea.value; renderPreview(); });

  const slotsBox = el("div", { class: "col", style: { marginTop: "10px" } });
  const leftCol = el("div", { class: "card col" },
    el("strong", null, "文章正文"),
    contentArea,
    el("div", { class: "row", style: { justifyContent: "space-between", marginTop: "6px" } },
      el("strong", null, "配图规划槽位"),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => {
          state.slots.push({ id: `slot_${Date.now()}`, role: state.slots.length === 0 ? "cover" : "inline", anchor: "", title: `配图 ${state.slots.length + 1}`, theme: "", ratio: state.slots.length === 0 ? "2.35:1" : "16:9", imagePath: "" });
          renderSlots();
        },
      }, "+ 添加槽位")
    ),
    slotsBox
  );

  const previewTabBar = el("div", { class: "tabs" });
  const previewBody = el("div", { style: { flex: "1", overflowY: "auto", padding: "12px", background: "var(--paper)", borderRadius: "8px", border: "1px solid var(--line)", minHeight: "340px" } });

  const rightCol = el("div", { class: "card col" },
    el("div", { class: "row", style: { justifyContent: "space-between" } },
      previewTabBar,
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => doExport("wechat_html", true) }, "📋 复制公众号 HTML"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => doExport("markdown_zip", false) }, "📦 导出 MD+图 ZIP"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => doExport("images_zip", false) }, "🖼 仅导出配图包")
      )
    ),
    previewBody
  );

  root.appendChild(el("div", { class: "split" }, leftCol, rightCol));

  function syncInputs() {
    titleIn.value = state.title || "";
    contentArea.value = state.content || "";
    styleSel.value = state.style || "";
    colorSel.value = state.color || "";
    toneSel.value = state.tone || "";
  }

  function renderSlots() {
    clear(slotsBox);
    if (!state.slots.length) {
      slotsBox.appendChild(el("div", { class: "muted" }, "点击右上角「智能规划配图位」，或手动「+ 添加槽位」。"));
      return;
    }
    state.slots.forEach((sl, idx) => {
      const roleSel = el("select", { class: "select select-sm", style: { width: "90px" } },
        el("option", { value: "cover", selected: sl.role === "cover" }, "封面"),
        el("option", { value: "inline", selected: sl.role !== "cover" }, "正文")
      );
      roleSel.addEventListener("change", () => { sl.role = roleSel.value; renderPreview(); });

      const anchorIn = el("input", { class: "input", style: { maxWidth: "170px" }, value: sl.anchor || "", placeholder: "锚点原文片段（可空）" });
      anchorIn.addEventListener("input", () => { sl.anchor = anchorIn.value; renderPreview(); });

      const themeIn = el("input", { class: "input", style: { flex: "1", minWidth: "180px" }, value: sl.theme || "", placeholder: "配图画面描述" });
      themeIn.addEventListener("input", () => { sl.theme = themeIn.value; });

      const ratioSel = el("select", { class: "select select-sm", style: { width: "86px" } },
        ...["2.35:1", "21:9", "16:9", "4:3", "3:4", "1:1"].map((r) => el("option", { value: r, selected: (sl.ratio || "16:9") === r }, r))
      );
      ratioSel.addEventListener("change", () => { sl.ratio = ratioSel.value; });

      slotsBox.appendChild(el("div", { class: "card row", style: { padding: "8px 10px", background: "var(--paper)" } },
        sl.imagePath ? el("img", { src: localImg(sl.imagePath), alt: sl.title || "", style: { width: "44px", height: "44px", objectFit: "cover", borderRadius: "6px" } }) : el("span", { class: "badge" }, `#${idx + 1}`),
        roleSel,
        anchorIn,
        themeIn,
        ratioSel,
        el("button", { type: "button", class: "btn btn-sm btn-danger", onClick: () => { state.slots.splice(idx, 1); renderSlots(); renderPreview(); } }, "删除")
      ));
    });
  }

  function renderPreview() {
    clear(previewTabBar);
    [["wechat", "公众号图文预览"], ["markdown", "Markdown 源码"]].forEach(([k, label]) => {
      previewTabBar.appendChild(el("button", {
        type: "button",
        class: "tab" + (state.previewTab === k ? " active" : ""),
        onClick: () => { state.previewTab = k; renderPreview(); },
      }, label));
    });

    clear(previewBody);
    const paras = (state.content || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const coverSlot = state.slots.find((s) => s.role === "cover");

    if (state.previewTab === "markdown") {
      const lines = [];
      if (state.title) lines.push(`# ${state.title}\n`);
      if (coverSlot) lines.push(`![${coverSlot.title || "封面"}](${coverSlot.imagePath || "待生成封面"})\n`);
      paras.forEach((p) => {
        lines.push(p + "\n");
        state.slots.forEach((sl) => {
          if (sl.role !== "cover" && sl.anchor && p.includes(sl.anchor)) {
            lines.push(`![${sl.title || "配图"}](${sl.imagePath || "待生成：" + sl.theme})\n`);
          }
        });
      });
      previewBody.appendChild(el("pre", { class: "mono", style: { margin: 0, whiteSpace: "pre-wrap", fontSize: "12.5px" } }, lines.join("\n")));
      return;
    }

    const articleEl = el("article", { class: "col", style: { gap: "12px" } });
    if (state.title) articleEl.appendChild(el("h2", { style: { margin: 0 } }, state.title));
    if (coverSlot) {
      articleEl.appendChild(coverSlot.imagePath
        ? el("img", { src: localImg(coverSlot.imagePath), alt: coverSlot.title || "封面", style: { width: "100%", borderRadius: "8px" } })
        : el("div", { class: "badge badge-accent" }, `封面配图位：${coverSlot.theme || coverSlot.title || "待生成"}`));
    }
    paras.forEach((p) => {
      articleEl.appendChild(p.startsWith("#")
        ? el("h3", { style: { margin: "8px 0 2px" } }, p.replace(/^#+\s*/, ""))
        : el("p", { style: { margin: 0, lineHeight: 1.75 } }, p));
      state.slots.forEach((sl) => {
        if (sl.role !== "cover" && sl.anchor && p.includes(sl.anchor)) {
          articleEl.appendChild(sl.imagePath
            ? el("img", { src: localImg(sl.imagePath), alt: sl.title || "", style: { width: "100%", borderRadius: "8px" } })
            : el("div", { class: "badge" }, `正文配图位：${sl.theme || sl.title || "待生成"}`));
        }
      });
    });
    if (!state.title && paras.length === 0) {
      articleEl.appendChild(el("span", { class: "muted" }, "导入或粘贴文章后，这里会实时显示配图插入位置。"));
    }
    previewBody.appendChild(articleEl);
  }

  function openURLImportDialog() {
    const urlIn = el("input", { class: "input", type: "url", placeholder: "https://example.com/article" });
    showModal("抓取网页文章正文", el("div", { class: "field" }, el("label", null, "文章 URL（仅支持 http/https）"), urlIn), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          try {
            const res = await api("POST", "/api/article/import", { url: urlIn.value.trim() });
            if (res.title) state.title = res.title;
            state.content = res.content || "";
            closeModal();
            syncInputs();
            renderPreview();
            toast("已抓取网页正文");
          } catch (e) { toast(e.message); }
        },
      }, "抓取"),
    ]);
  }

  async function planArticle() {
    if (!state.content.trim()) {
      toast("请先输入或导入文章正文");
      return;
    }
    planBtn.disabled = true;
    try {
      const res = await api("POST", "/api/article/plan", { title: state.title, content: state.content, count: 5 });
      const rec = res.recommendedStyles || res.raw?.recommendedStyles;
      const slots = res.slots || res.raw?.slots || [];
      if (Array.isArray(rec) && rec.length) {
        state.recommendedStyles = rec;
        if (!params.keepStyle) {
          state.style = rec[0];
          styleSel.value = rec[0];
        }
        renderRecChips();
      }
      state.slots = slots.map((s, i) => ({
        id: s.id || `slot_${i}`,
        role: s.role || (i === 0 ? "cover" : "inline"),
        anchor: s.anchor || "",
        title: s.title || (i === 0 ? "文章封面" : `正文配图 ${i}`),
        theme: s.theme || "",
        ratio: s.ratio || (i === 0 ? "2.35:1" : "16:9"),
        imagePath: "",
      }));
      renderSlots();
      renderPreview();
      toast(`已规划 ${state.slots.length} 个配图位`);
    } catch (e) { toast(e.message); } finally {
      planBtn.disabled = false;
    }
  }

  async function runGenerate(coverOnly, confirmed) {
    if (!state.slots.length) {
      toast("请先规划配图位或添加至少一个槽位");
      return;
    }
    const indices = [];
    const items = [];
    state.slots.forEach((sl, idx) => {
      if (coverOnly && idx > 0 && sl.role !== "cover") return;
      if (coverOnly && items.length >= 1) return;
      if (!sl.theme.trim()) return;
      indices.push(idx);
      items.push({
        theme: sl.theme.trim(),
        style: state.style,
        color: state.color,
        tone: state.tone,
        ratio: normalizeArticleRatio(sl.ratio),
        mode: state.mode,
      });
    });
    if (!items.length) {
      toast("请先为配图槽位填写画面描述");
      return;
    }
    try {
      const res = await api("POST", "/api/generate", {
        mode: "article",
        title: (state.title || "文章配图") + (coverOnly ? " · 封面样张" : ""),
        modelRef: state.modelRef,
        resolution: state.resolution,
        confirmed,
        items,
      });
      if (res.needConfirm) {
        showModal("生成费用确认", el("p", null, `预计消耗网站额度 ${money(res.totalCents)}（${res.count} 张）。继续生成？`), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); runGenerate(coverOnly, true); } }, "确认继续"),
        ]);
        return;
      }
      state.activeRun = { ...res.run, images: res.images };
      state.slotMap = indices;
      toast(coverOnly ? "封面样张已加入队列" : `全部 ${items.length} 张配图已加入队列`);
    } catch (e) { toast(e.message); }
  }

  async function doExport(format, copyToClipboard) {
    try {
      const res = await api("POST", "/api/article/export", {
        title: state.title,
        content: state.content,
        format,
        slots: state.slots.map((s) => ({ role: s.role, anchor: s.anchor, title: s.title, imagePath: s.imagePath || "" })),
      });
      if (copyToClipboard && res.html) {
        try { await navigator.clipboard.writeText(res.html); } catch {}
        toast("已生成公众号 HTML 并复制到剪贴板：" + res.path);
      } else {
        toast("已导出到：" + res.path);
      }
    } catch (e) { toast(e.message); }
  }

  async function saveDraft() {
    try {
      const res = await api("PUT", `/api/docs/article/${encodeURIComponent(state.docId || "new")}`, {
        name: state.title || "未命名文章",
        data: { title: state.title, content: state.content, style: state.style, color: state.color, tone: state.tone, slots: state.slots },
      });
      state.docId = res.doc.id;
      const dRes = await api("GET", "/api/docs/article").catch(() => ({ items: [] }));
      drafts = dRes.items || [];
      refreshDraftSel();
      toast("文稿与配图位已保存");
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
        (detail.run.images || []).forEach((im, i) => {
          const slotIdx = state.slotMap[i];
          if (slotIdx !== undefined && state.slots[slotIdx] && im.status === "done" && im.path) {
            state.slots[slotIdx].imagePath = im.path;
          }
        });
        renderSlots();
        renderPreview();
      } catch {}
    }
  });

  renderSlots();
  renderPreview();
}
