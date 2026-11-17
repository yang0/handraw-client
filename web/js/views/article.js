import { api, clear, closeModal, el, localImg, money, onEvent, showModal, toast } from "../api.js";
import { buildGroupedModelSelect } from "./create.js";
import { extraInstructions, field, ratioControl, recipeControls, studioMount, studioSession } from "./studio-controls.js";


export async function renderArticle(root, ctx, params = {}) {
  const host = studioMount(root);

  const [stylesRes, colorsRes, tonesRes, modRes, draftsRes, layoutsRes] = await Promise.all([
    api("GET", "/api/resources/styles").catch(() => ({ items: [] })),
    api("GET", "/api/resources/colors").catch(() => ({ items: [] })),
    api("GET", "/api/resources/tones").catch(() => ({ items: [] })),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [] })),
    api("GET", "/api/docs/article").catch(() => ({ items: [] })),
    api("GET", "/api/resources/layouts").catch(() => ({ items: [] })),
  ]);
  if (!host.isConnected) return;

  const styles = stylesRes.items || [];
  const colors = colorsRes.items || [];
  const tones = tonesRes.items || [];
  let drafts = draftsRes.items || [];

  const session = studioSession(host, "article", {
    docId: params.docId || "",
    title: "",
    content: "",
    style: styles[0]?.number || "FA-013",
    color: "",
    tone: "",
    mode: "graphic-text",
    style2: "", layout: "", mood: "",
    coverRatio: "2.35:1", inlineRatio: "4:3", includeCover: true,
    resolution: "2k",
    modelRef: modRes.defaultModel || "site:seedream-4.5",
    recommendedStyles: [],
    slots: [],
    previewTab: "wechat", // markdown | wechat
    activeRun: null,
    slotMap: [], // stable slot IDs, independent of reordering or deletion
  });
  root = session.root;
  const state = session.state;
  let submitting = false, planning = false;
  const slotRatios = new Map();
  const slotSignature = (sl) => JSON.stringify([sl.role, sl.anchor, sl.theme, sl.ratio, sl.layout, state.style, state.fusion ? state.style2 : "", state.color, state.tone, state.mood, state.mode, extraInstructions(state)]);

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row" },
      el("h1", { class: "page-title" }, "文章配图"),
      el("span", { class: "muted" }, "导入长文或链接，一键规划封面与正文锚点配图并导出公众号排版")
    ),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn btn-sm", onClick: saveDraft }, "保存文章"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works") }, "查看作品库")
    )
  ));

  // Top import/plan toolbar
  const titleIn = el("input", { class: "input", value: state.title, style: { flex: "1", minWidth: "200px" }, placeholder: "输入文章标题…" });
  titleIn.addEventListener("input", () => { state.title = titleIn.value; renderPreview(); });

  const draftSel = el("select", { class: "select select-sm", style: { maxWidth: "180px" } });
  const refreshDraftSel = () => {
    clear(draftSel);
    draftSel.appendChild(el("option", { value: "" }, "— 打开草稿 —"));
    drafts.forEach((d) => draftSel.appendChild(el("option", { value: d.id }, d.name || d.id)));
    if (state.docId) draftSel.value = state.docId;
  };
  refreshDraftSel();
  draftSel.addEventListener("change", () => loadDraft(draftSel.value));
  async function loadDraft(id) {
    if (!id) return;
    try {
      const r = await api("GET", `/api/docs/article/${encodeURIComponent(id)}`);
      const data = typeof r.doc?.data === "string" ? JSON.parse(r.doc.data) : (r.doc?.data || {});
      Object.assign(state, data, { docId: r.doc.id, activeRun: null, slotMap: [] });
      state.fusion = data.fusion ?? Boolean(data.style2);
      state.title = data.title || r.doc.name || "";
      state.slots = Array.isArray(data.slots) ? data.slots : [];
      syncInputs();
      renderSlots();
      renderPreview();
      session.persist();
      toast("已加载文章草稿");
    } catch (e) { toast(e.message); }
  }

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
      session.persist();
      toast("已导入文稿");
    } catch (e) { toast(e.message); }
    fileIn.value = "";
  });

  const planBtn = el("button", { type: "button", class: "btn btn-primary", onClick: planArticle }, "AI 规划配图");

  root.appendChild(el("section", { class: "card col", style: { marginBottom: "14px" } },
    el("div", { class: "row" },
      field("文章标题", titleIn),
      field("文章草稿", draftSel),
      fileIn,
      el("button", { type: "button", class: "btn", onClick: () => fileIn.click() }, "📄 导入 MD/TXT/DOCX"),
      el("button", { type: "button", class: "btn", onClick: openURLImportDialog }, "🔗 抓取网页链接"),
      planBtn
    )
  ));

  const controls = recipeControls(state, { styles, colors, tones, layouts: layoutsRes.items || [] }, () => session.persist(), { article: true });
  const coverRatio = ratioControl("封面比例", state.coverRatio, (v) => { state.coverRatio = v; });
  const inlineRatio = ratioControl("章节插图比例", state.inlineRatio, (v) => { state.inlineRatio = v; });
  const coverCheck = el("input", { type: "checkbox", checked: state.includeCover !== false });
  coverCheck.addEventListener("change", () => { state.includeCover = coverCheck.checked; });
  const modelSel = buildGroupedModelSelect(modRes, state.modelRef);
  state.modelRef = modelSel.value;
  modelSel.addEventListener("change", () => { state.modelRef = modelSel.value; });
  const resSel = el("select", { class: "select" }, ...["1k", "2k", "4k"].map((v) => el("option", { value: v }, v.toUpperCase())));
  resSel.value = state.resolution;
  resSel.addEventListener("change", () => { state.resolution = resSel.value; });
  const planNotice = el("p", { class: "studio-notice", role: "status" });
  const sampleBtn = el("button", { type: "button", class: "btn", onClick: () => runGenerate(true, false) }, "先出封面样张");
  const batchBtn = el("button", { type: "button", class: "btn btn-primary", onClick: () => runGenerate(false, false) }, "生成选中配图");
  root.appendChild(el("details", { class: "card article-settings" }, el("summary", null, "配图设置"), controls.node,
    el("div", { class: "col" }, coverRatio, inlineRatio, el("label", { class: "row" }, coverCheck, "规划包含封面")),
    el("p", { class: "muted" }, "这些设置用于新规划的配图；已有配图可逐张调整。")));
  root.appendChild(planNotice);

  // Split: left editor + slots, right dual preview + export
  const contentArea = el("textarea", {
    class: "textarea",
    rows: "12", value: state.content,
    placeholder: "在此粘贴或编写 Markdown 正文，规划配图后将按锚点自动插图…",
  });
  contentArea.addEventListener("input", () => { state.content = contentArea.value; renderPreview(); });

  const slotsBox = el("div", { class: "col", style: { marginTop: "10px" } });
  const leftCol = el("div", { class: "card col" },
    field("文章正文", contentArea),
    el("div", { class: "row", style: { justifyContent: "space-between", marginTop: "6px" } },
      el("strong", null, "配图位"),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => {
          const isCover = state.slots.length === 0 && state.includeCover;
          state.slots.push({ id: crypto.randomUUID(), role: isCover ? "cover" : "inline", anchor: "", title: `配图 ${state.slots.length + 1}`, theme: "", ratio: isCover ? state.coverRatio : state.inlineRatio, imagePath: "", selected: true });
          renderSlots(); renderPreview();
        },
      }, "+ 添加配图位")
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

  root.appendChild(el("div", { class: "article-layout" }, leftCol, rightCol));
  root.appendChild(el("div", { class: "studio-bar" }, field("模型", modelSel), field("分辨率", resSel), sampleBtn, batchBtn));
  root.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveDraft(); }
  });

  function syncInputs() {
    titleIn.value = state.title || "";
    contentArea.value = state.content || "";
    controls.sync();
    coverRatio.sync(state.coverRatio); inlineRatio.sync(state.inlineRatio);
    coverCheck.checked = state.includeCover !== false;
    modelSel.value = state.modelRef; resSel.value = state.resolution;
  }

  function renderSlots() {
    clear(slotsBox);
    slotRatios.clear();
    if (!state.slots.length) {
      slotsBox.appendChild(el("p", { class: "muted" }, "编辑文章后点击 AI 规划配图，或手动添加配图位。"));
      return;
    }
    const pending = state.slots.filter((sl) => !sl.imagePath);
    const selectAll = el("input", { type: "checkbox", checked: pending.length > 0 && pending.every((sl) => sl.selected !== false) });
    selectAll.indeterminate = pending.some((sl) => sl.selected !== false) && pending.some((sl) => sl.selected === false);
    selectAll.addEventListener("change", () => { pending.forEach((sl) => { sl.selected = selectAll.checked; }); renderSlots(); });
    slotsBox.appendChild(el("label", { class: "row" }, selectAll, "全选待生成配图（已有图片自动跳过）"));
    state.slots.forEach((sl, idx) => {
      if (!sl.id) sl.id = crypto.randomUUID();
      const selected = el("input", { type: "checkbox", checked: sl.selected !== false, disabled: Boolean(sl.imagePath) });
      selected.addEventListener("change", () => { sl.selected = selected.checked; });
      const role = el("select", { class: "select" }, el("option", { value: "cover" }, "封面"), el("option", { value: "inline" }, "正文"));
      role.value = sl.role;
      role.addEventListener("change", () => { sl.role = role.value; sl.ratio = role.value === "cover" ? state.coverRatio : state.inlineRatio; renderSlots(); renderPreview(); });
      const anchor = el("input", { class: "input", value: sl.anchor || "", placeholder: "插在这段原文之后" });
      anchor.addEventListener("input", () => { sl.anchor = anchor.value; renderPreview(); });
      const theme = el("textarea", { class: "textarea", rows: "3", value: sl.theme || "", placeholder: "配图画面描述" });
      theme.value = sl.theme || "";
      theme.addEventListener("input", () => { sl.theme = theme.value; renderPreview(); });
      const ratio = ratioControl("本图比例", sl.ratio || (sl.role === "cover" ? state.coverRatio : state.inlineRatio), (v) => { sl.ratio = v; }, { compact: true });
      slotRatios.set(sl.id, ratio);
      const layout = el("select", { class: "select" }, el("option", { value: "" }, "沿用文章图型"),
        ...(layoutsRes.items || []).map((l) => el("option", { value: l.id }, `${l.id} · ${l.name}`)));
      layout.value = sl.layout || "";
      layout.addEventListener("change", () => { sl.layout = layout.value; });
      const mismatch = sl.role !== "cover" && (!sl.anchor || !state.content.includes(sl.anchor));
      slotsBox.appendChild(el("section", { class: "card col article-slot" },
        el("div", { class: "row" }, el("label", { class: "row" }, selected, sl.title || `配图 ${idx + 1}`),
          sl.imagePath ? el("img", { src: localImg(sl.imagePath), alt: sl.title || "配图", style: { width: "80px", height: "60px", objectFit: "cover" } }) : null),
        el("div", { class: "row" }, field("配图类型", role), field("本图图型", layout)),
        field("配图主题", theme), sl.role === "cover" ? null : field("正文锚点", anchor), ratio,
        el("span", { class: "article-slot-status" }, sl.imagePath ? "已采用图片" : (sl.error || "待生成")),
        mismatch ? el("span", { class: "badge badge-warn" }, "待重新定位：请填写正文中存在的原文片段") : null,
        el("div", { class: "row" },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { if (ratio.validate()) runGenerate(sl.id, false); } }, sl.imagePath ? "重新生成本图" : "生成本图"),
          el("button", { type: "button", class: "btn btn-sm btn-danger", onClick: () => { state.slots = state.slots.filter((s) => s.id !== sl.id); renderSlots(); renderPreview(); } }, "删除配图位"))));
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
    if (planning) return;
    if (!state.content.trim()) { toast("请先输入或导入文章正文"); contentArea.focus(); return; }
    if (!coverRatio.validate() || !inlineRatio.validate()) return;
    planning = true; planBtn.disabled = true; planNotice.textContent = "正在分析文章结构与配图位置…";
    const request = { title: state.title, content: state.content, styleId: state.style,
      coverRatio: state.coverRatio, inlineRatio: state.inlineRatio, includeCover: state.includeCover };
    try {
      const res = await api("POST", "/api/article/plan", request);
      if (request.content !== state.content || request.title !== state.title) {
        planNotice.textContent = "文章已修改，请按当前正文重新规划。"; return;
      }
      const fresh = (res.slots || []).map((sl) => ({ ...sl, id: crypto.randomUUID(), imagePath: "", selected: true }));
      const apply = () => {
        const used = new Set();
        const merged = fresh.map((sl) => {
          const matches = state.slots.filter((old) => !used.has(old.id) && old.role === sl.role && (sl.role === "cover" || (sl.anchor && old.anchor === sl.anchor)));
          if (matches.length !== 1) return sl;
          const old = matches[0]; used.add(old.id); return old;
        });
        // Keep unmatched positions and existing adopted images until explicitly deleted.
        state.slots = [...merged, ...state.slots.filter((sl) => !used.has(sl.id))];
        state.recommendedStyles = res.recommendedStyles || [];
        planNotice.textContent = res.source === "local" ? "已使用本地模板规划，可调整主题和位置后生成。" : "配图规划完成，可逐张调整；已有配图已保留。";
        renderSlots(); renderPreview(); session.persist();
      };
      if (state.slots.length) {
        showModal("更新配图规划", el("div", { class: "col" }, el("p", null, "匹配的配图位保留已有设置和图片，未匹配的旧图位也会保留，可自行删除。"),
          ...fresh.map((sl) => el("p", null, `${sl.role === "cover" ? "封面" : "正文"}：${sl.theme}`))), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "保留当前规划"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); apply(); } }, "更新规划")]);
        planNotice.textContent = "新规划已就绪，等待应用。";
      } else apply();
    } catch (e) { planNotice.textContent = e.message; } finally { planning = false; planBtn.disabled = false; }
  }

  async function runGenerate(target, confirmed) {
    if (submitting) return;
    if (state.activeRun?.images?.some((im) => im.status === "queued" || im.status === "running")) {
      toast("本篇文章的配图仍在生成，请等待当前批次完成"); return;
    }
    if (!controls.validate()) { toast("请为双画风融合选择两种画风"); return; }
    const single = typeof target === "string";
    const slots = single ? state.slots.filter((sl) => sl.id === target) : target === true
      ? state.slots.filter((sl) => sl.role === "cover" && !sl.imagePath).slice(0, 1)
      : state.slots.filter((sl) => sl.selected !== false && !sl.imagePath);
    if (!slots.length) { toast(target === true ? "没有待生成的封面，请先规划封面或在配图位中重新生成" : "没有选中的待生成配图"); return; }
    if (slots.some((sl) => slotRatios.get(sl.id) && !slotRatios.get(sl.id).validate())) return;
    if (slots.some((sl) => !sl.theme?.trim())) { toast("请先填写选中配图的主题"); return; }
    if (slots.some((sl) => sl.role !== "cover" && (!sl.anchor || !state.content.includes(sl.anchor)))) {
      toast("请先为正文配图填写有效的正文锚点"); return;
    }
    const signatures = slots.map(slotSignature);
    submitting = true; sampleBtn.disabled = true; batchBtn.disabled = true;
    try {
      const res = await api("POST", "/api/generate", {
        mode: "article", title: state.title || "文章配图", modelRef: state.modelRef, resolution: state.resolution, confirmed,
        items: slots.map((sl) => ({ theme: sl.theme.trim(), style: state.style, style2: state.fusion ? state.style2 : "",
          layout: sl.layout || state.layout, color: state.color, tone: state.tone, mood: state.mood,
          ratio: sl.ratio || (sl.role === "cover" ? state.coverRatio : state.inlineRatio), mode: state.mode, extra: extraInstructions(state) })),
      });
      if (res.needConfirm) {
        showModal("生成费用确认", el("p", null, `本次 ${res.count} 张，预计 ${money(res.totalCents)}，继续生成？`), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); runGenerate(target, true); } }, "确认生成")]);
        return;
      }
      state.activeRun = { ...res.run, images: res.images };
      state.slotMap = slots.map((sl, i) => ({ id: sl.id, signature: signatures[i] }));
      planNotice.textContent = `已提交 ${slots.length} 张配图，完成后自动插入。`;
      session.persist();
    } catch (e) { toast(e.message); } finally { submitting = false; sampleBtn.disabled = false; batchBtn.disabled = false; }
  }

  async function doExport(format, copyToClipboard) {
    if (state.slots.some((sl) => sl.imagePath && sl.role !== "cover" && (!sl.anchor || !state.content.includes(sl.anchor)))) {
      toast("已有配图需要重新定位，请先修正正文锚点再导出"); return;
    }
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
        data: { ...state, activeRun: null, slotMap: [] },
      });
      state.docId = res.doc.id;
      const dRes = await api("GET", "/api/docs/article").catch(() => ({ items: [] }));
      drafts = dRes.items || [];
      refreshDraftSel();
      session.persist();
      toast("文稿与配图位已保存");
    } catch (e) { toast(e.message); }
  }

  async function refreshRun() {
    const runId = state.activeRun?.id;
    if (!runId) return;
    const detail = await api("GET", `/api/works/${encodeURIComponent(runId)}`);
    if (state.activeRun?.id !== runId) return;
    state.activeRun = detail.run;
    (detail.run.images || []).forEach((im, i) => {
      const mapped = state.slotMap[i];
      const slot = state.slots.find((sl) => sl.id === mapped?.id);
      if (slot && slotSignature(slot) === mapped.signature) {
        if (im.status === "done" && im.path) { slot.imagePath = im.path; slot.error = ""; }
        if (im.status === "failed") slot.error = im.error || "生成失败，可重试；已有图片已保留";
      }
    });
    renderSlots(); renderPreview(); session.persist();
  }
  const unsub = onEvent(async (msg) => {
    if (!root.isConnected) {
      unsub();
      return;
    }
    const rid = msg.data?.runId || msg.data?.id;
    if ((msg.type === "job" || msg.type === "run") && state.activeRun && rid === state.activeRun.id) {
      try {
        await refreshRun();
      } catch {}
    }
  });

  syncInputs();
  renderSlots();
  renderPreview();
  refreshRun().catch(() => {});
  if (params.docId) await loadDraft(params.docId);
}
