import { api, clear, closeModal, copyText, el, localImg, onEvent, openURL, remoteThumb, showModal, toast, toWebp } from "../api.js";
import { masonry } from "../masonry.js";

const state = {
  tab: "local", // local | history | collections
  q: "",
  mode: "",
  starred: false,
  published: "",
};

export async function renderWorks(root, ctx, params = {}) {
  if (params.tab) state.tab = params.tab;
  clear(root);

  const tabBar = el("div", { class: "tabs" });
  [
    ["local", "本地作品库"],
    ["history", "网站生图历史"],
    ["collections", "网站收藏"],
  ].forEach(([k, label]) => {
    tabBar.appendChild(el("button", {
      type: "button",
      class: "tab" + (state.tab === k ? " active" : ""),
      onClick: () => { state.tab = k; renderWorks(root, ctx); },
    }, label));
  });

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row" },
      el("h1", { class: "page-title" }, "作品中心"),
      tabBar
    ),
    el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create") }, "+ 新建创作")
  ));

  const stage = el("div");
  root.appendChild(stage);

  async function draw() {
    clear(stage);
    if (state.tab === "local") await drawLocal(stage, ctx, root);
    else if (state.tab === "history") await drawSiteHistory(stage, ctx);
    else await drawSiteCollections(stage, ctx);
  }

  await draw();
  if (params.openRun) openRunDetail(params.openRun, ctx, draw);
}

async function drawLocal(stage, ctx, root) {
  const searchIn = el("input", { class: "input", type: "search", value: state.q, placeholder: "搜标题、主题、提示词…", style: { maxWidth: "240px" } });
  const modeSel = el("select", { class: "select select-sm" },
    el("option", { value: "" }, "全部类型"),
    ...[["quick", "快门"], ["single", "单图"], ["series", "系列"], ["article", "文章配图"], ["canvas", "画布"]].map(([v, l]) => el("option", { value: v, selected: state.mode === v }, l))
  );
  const pubSel = el("select", { class: "select select-sm" },
    el("option", { value: "" }, "发布状态"),
    el("option", { value: "1", selected: state.published === "1" }, "已发布到网站"),
    el("option", { value: "0", selected: state.published === "0" }, "仅保存在本地")
  );
  const starBtn = el("button", {
    type: "button",
    class: "pill-btn" + (state.starred ? " pill-accent" : ""),
    onClick: () => { state.starred = !state.starred; loadGrid(); starBtn.className = "pill-btn" + (state.starred ? " pill-accent" : ""); },
  }, "★ 只看星标");

  let timer = null;
  searchIn.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { state.q = searchIn.value; loadGrid(); }, 180); });
  modeSel.addEventListener("change", () => { state.mode = modeSel.value; loadGrid(); });
  pubSel.addEventListener("change", () => { state.published = pubSel.value; loadGrid(); });

  const filterBar = el("div", { class: "row", style: { marginBottom: "14px" } }, searchIn, modeSel, pubSel, starBtn);
  const grid = masonry();
  stage.appendChild(filterBar);
  stage.appendChild(grid);

  async function loadGrid() {
    const qs = new URLSearchParams({
      q: state.q,
      mode: state.mode,
      starred: state.starred ? "1" : "",
      published: state.published,
      hasImages: "1",
      limit: "60",
    });
    const res = await api("GET", `/api/works?${qs.toString()}`).catch(() => ({ items: [] }));
    const items = (res.items || []).filter((run) => (run.images || []).some((i) => i.status === "done" && i.path));
    clear(grid);
    if (!items.length) {
      grid.appendChild(el("div", { class: "card muted", style: { gridColumn: "1 / -1" } }, "当前筛选下暂无本地作品。所有生成的图片默认均保存于本地目录。"));
      return;
    }
    items.forEach((run) => {
      const doneImgs = (run.images || []).filter((i) => i.status === "done" && i.path);
      const im = doneImgs[0];
      const src = im.thumb ? localImg(im.thumb) : localImg(im.path);
      grid.appendChild(el("div", { class: "style-card", onClick: () => openRunDetail(run.id, ctx, loadGrid) },
        el("img", { class: "style-thumb", src, alt: run.title || "", loading: "lazy" }),
        el("div", { class: "style-body" },
          el("div", { class: "row", style: { justifyContent: "space-between" } },
            el("span", { class: "badge" }, run.mode || "single"),
            run.publishedWorkId ? el("span", { class: "badge badge-ok" }, "已发布") : el("span", { class: "muted" }, "仅本地")
          ),
          el("div", { class: "style-name" }, (run.starred ? "★ " : "") + (run.title || "未命名作品")),
          el("div", { class: "muted" }, `${run.modelLabel || run.model} · ${doneImgs.length} 张`)
        )
      ));
    });
  }

  const unsub = onEvent((msg) => {
    if (!root.isConnected || state.tab !== "local") {
      unsub();
      return;
    }
    if (msg.type === "job" || msg.type === "run" || msg.type === "work_published") loadGrid();
  });

  await loadGrid();
}

function parseRunRecipe(run) {
  let rec = {};
  try {
    rec = typeof run?.recipe === "string" ? JSON.parse(run.recipe) : (run?.recipe || {});
  } catch {
    rec = {};
  }
  const uniq = (arr) => Array.from(new Set(arr.map((x) => String(x || "").trim()).filter(Boolean)));
  const styleIds = uniq([
    ...(Array.isArray(rec.styleIds) ? rec.styleIds : []),
    rec.style,
    rec.style1,
    rec.style2,
  ]);
  const layoutId = String(rec.layoutId || rec.layout || "").trim();
  const colors = uniq([...(Array.isArray(rec.colors) ? rec.colors : []), rec.color]);
  const tones = uniq([...(Array.isArray(rec.tones) ? rec.tones : []), rec.tone]);
  const mood = String(rec.mood || "").trim();
  const ratio = String(rec.ratio || "").trim();
  const mode = String(rec.mode || run?.mode || "").trim();
  const quality = String(rec.quality || rec.resolution || "").trim();
  const shootType = String(rec.shootType || "").trim();
  const sc021Type = String(rec.sc021Type || "").trim();
  const count = Number(rec.count || 0) || 0;
  return { raw: rec, styleIds, layoutId, colors, tones, mood, ratio, mode, quality, shootType, sc021Type, count };
}

function extractExpandedPrompts(run, doneImages) {
  const perImage = [];
  (doneImages || []).forEach((im, idx) => {
    const p = String(im?.prompt || "").trim();
    if (p) perImage.push({ label: `图 #${idx + 1}`, prompt: p, theme: String(im?.theme || "").trim() });
  });
  const zh = String(run?.promptZh || "").trim();
  const en = String(run?.promptEn || "").trim();
  const distinctPerImage = new Set(perImage.map((x) => x.prompt));
  const defaultPrompt = perImage[0]?.prompt || zh || en || "";
  return {
    perImage,
    hasMultiImagePrompts: distinctPerImage.size > 1,
    zh,
    en,
    defaultPrompt,
  };
}

function modeLabel(mode) {
  const m = {
    quick: "快门",
    single: "单图",
    series: "系列",
    article: "文章配图",
    canvas: "画布",
    "graphic-text": "图文模式",
    "pure-image": "纯图模式",
  };
  return m[mode] || mode;
}

async function openRunDetail(runId, ctx, onChanged) {
  let detail;
  try {
    detail = await api("GET", `/api/works/${encodeURIComponent(runId)}`);
  } catch (e) {
    toast(e.message);
    return;
  }
  const run = detail.run;
  const versions = detail.versions || [];
  const doneImages = (run.images || []).filter((i) => i.status === "done" && i.path);
  const doneVersions = versions.filter((v) => v.id === run.id || v.status === "done");
  const parsedRec = parseRunRecipe(run);
  const expandedInfo = extractExpandedPrompts(run, doneImages);
  const originalReqText = String(run.originalRequest || "").trim();

  // Shared modal state
  let activeIdx = 0;
  let zoomed = false;
  let activeTab = "details"; // "details" | "publish"
  let publishMode = "work";  // "work" | "inspiration"
  let workPrice = 2;
  let inspPrice = 5;
  let publishedInspReceipt = null;
  let trashArmed = false;
  let trashTimer = null;
  const selectedIds = new Set(doneImages.slice(0, 12).map((i) => i.id));

  // ---------- LEFT STAGE: Museum-paper hero viewer + filmstrip + action dock ----------
  const stageMetaEl = el("span", { class: "wd-meta-pill" }, "");
  const zoomBtn = el("button", { type: "button", class: "wd-meta-pill", style: { cursor: "pointer" } }, "🔍 放大查看");
  const versionStrip = el("div", { class: "row", style: { gap: "4px", flexWrap: "wrap" } });
  if (doneVersions.length > 1) {
    doneVersions.forEach((v, idx) => {
      versionStrip.appendChild(el("button", {
        type: "button",
        class: "pill-btn" + (v.id === run.id ? " pill-accent" : ""),
        style: { padding: "2px 8px", fontSize: "11.5px" },
        onClick: () => { closeModal(); openRunDetail(v.id, ctx, onChanged); },
      }, `v${idx + 1}`));
    });
  }

  const stageTop = el("div", { class: "wd-stage-top" },
    el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } }, stageMetaEl, versionStrip),
    zoomBtn
  );

  const heroImg = el("img", { class: "wd-hero-img", alt: run.title || "作品预览" });
  const emptyHero = el("div", { class: "muted" }, "暂无已完成图片");
  const prevBtn = el("button", { type: "button", class: "wd-nav-btn is-prev", "aria-label": "上一张" }, "‹");
  const nextBtn = el("button", { type: "button", class: "wd-nav-btn is-next", "aria-label": "下一张" }, "›");
  const canvasWrap = el("div", { class: "wd-canvas-wrap" },
    doneImages.length ? heroImg : emptyHero,
    doneImages.length > 1 ? prevBtn : null,
    doneImages.length > 1 ? nextBtn : null
  );

  const setZoom = (next) => {
    zoomed = Boolean(next);
    canvasWrap.classList.toggle("is-zoomed", zoomed);
    zoomBtn.textContent = zoomed ? "↺ 还原适应" : "🔍 放大查看";
  };
  heroImg.addEventListener("click", () => setZoom(!zoomed));
  zoomBtn.addEventListener("click", () => setZoom(!zoomed));

  const filmstripEl = el("div", { class: "wd-filmstrip" });
  const copyImgBtn = el("button", { type: "button", class: "btn btn-sm" }, "📋 复制图片");
  const editImgBtn = el("button", { type: "button", class: "btn btn-sm" }, "🎨 垫图");
  const remixRecipeBtn = el("button", {
    type: "button",
    class: "btn btn-sm btn-accent-soft",
    onClick: () => {
      closeModal();
      ctx.go("create", {
        recipe: parsedRec.raw,
        theme: originalReqText || run.title || "",
      });
    },
  }, "✨ 同配方再画");
  const revealBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: () => api("POST", `/api/works/${encodeURIComponent(run.id)}/reveal`),
  }, "📂 文件夹");
  const exportBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: async () => {
      const r = await api("POST", `/api/works/${encodeURIComponent(run.id)}/export`, { format: "zip" });
      toast("已导出：" + r.path);
    },
  }, "📦 导出 ZIP");

  copyImgBtn.addEventListener("click", async () => {
    const im = doneImages[activeIdx];
    if (!im) return;
    await api("POST", `/api/images/${encodeURIComponent(im.id)}/copy`);
    toast("图片已复制到剪贴板");
  });
  editImgBtn.addEventListener("click", () => {
    const im = doneImages[activeIdx];
    if (!im) return;
    closeModal();
    ctx.go("create", { editImage: im.path, theme: originalReqText || run.title });
  });

  const stageDock = el("div", { class: "wd-dock" },
    el("div", { class: "wd-dock-group" },
      doneImages.length ? copyImgBtn : null,
      doneImages.length ? editImgBtn : null,
      remixRecipeBtn
    ),
    el("div", { class: "wd-dock-group" }, revealBtn, exportBtn)
  );

  const stageCol = el("div", { class: "wd-stage" },
    stageTop,
    canvasWrap,
    doneImages.length > 1 ? filmstripEl : null,
    stageDock
  );

  // ---------- RIGHT INSPECTOR: Inline title + icon actions + 2 focused tabs ----------
  let lastSavedTitle = run.title || "";
  const titleIn = el("input", {
    class: "wd-title-input",
    value: lastSavedTitle,
    placeholder: "未命名作品（点击编辑标题）",
    maxlength: 60,
    "aria-label": "作品标题",
  });
  const saveHint = el("span", { class: "wd-save-hint", hidden: true }, "✓ 已保存");
  const commitTitle = async () => {
    const next = titleIn.value.trim();
    if (!next || next === lastSavedTitle) {
      if (!next) titleIn.value = lastSavedTitle;
      return;
    }
    try {
      await api("PATCH", `/api/works/${encodeURIComponent(run.id)}`, { title: next });
      lastSavedTitle = next;
      run.title = next;
      saveHint.hidden = false;
      setTimeout(() => { saveHint.hidden = true; }, 1600);
      onChanged?.();
    } catch (e) {
      toast(e.message || "保存标题失败");
    }
  };
  titleIn.addEventListener("blur", commitTitle);
  titleIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); titleIn.blur(); }
  });

  const starBtn = el("button", {
    type: "button",
    class: "wd-ico-btn" + (run.starred ? " is-starred" : ""),
    title: run.starred ? "取消标星收藏" : "标星收藏",
    onClick: async () => {
      const next = !run.starred;
      await api("PATCH", `/api/works/${encodeURIComponent(run.id)}`, { starred: next });
      run.starred = next;
      starBtn.textContent = next ? "★" : "☆";
      starBtn.classList.toggle("is-starred", next);
      starBtn.title = next ? "取消标星收藏" : "标星收藏";
      toast(next ? "已标星收藏" : "已取消星标");
      onChanged?.();
    },
  }, run.starred ? "★" : "☆");

  const saveInspBtn = el("button", {
    type: "button",
    class: "wd-ico-btn",
    title: "暂存到本地灵感库",
    onClick: async () => {
      const activeImg = doneImages[activeIdx] || doneImages[0];
      const activePrompt = String(activeImg?.prompt || expandedInfo.defaultPrompt || originalReqText || run.title || "").trim();
      try {
        await api("POST", "/api/inspirations", {
          title: titleIn.value.trim() || run.title || "我的创作灵感",
          imagePath: activeImg?.path || "",
          prompt: activePrompt,
          promptZh: expandedInfo.zh || "",
          source: "local",
          runId: run.id,
          recipe: parsedRec.raw,
          suggestedStyle: parsedRec.styleIds[0] || "",
        });
        toast("已暂存到本地灵感库，可随时 AI 整理或定价分享");
      } catch (e) { toast(e.message); }
    },
  }, "💡");

  const trashBtn = el("button", {
    type: "button",
    class: "wd-ico-btn",
    title: "移入回收站",
    onClick: async () => {
      if (!trashArmed) {
        trashArmed = true;
        trashBtn.textContent = "确认删除?";
        trashBtn.classList.add("is-danger-arm");
        clearTimeout(trashTimer);
        trashTimer = setTimeout(() => {
          trashArmed = false;
          trashBtn.textContent = "🗑";
          trashBtn.classList.remove("is-danger-arm");
        }, 3500);
        return;
      }
      clearTimeout(trashTimer);
      await api("DELETE", `/api/works/${encodeURIComponent(run.id)}`);
      closeModal();
      toast("已移至 .trash 回收站");
      onChanged?.();
    },
  }, "🗑");

  const closeBtn = el("button", {
    type: "button",
    class: "wd-ico-btn",
    "aria-label": "关闭",
    title: "关闭 (Esc)",
    onClick: closeModal,
  }, "✕");

  const headBar = el("div", { class: "wd-head" },
    el("div", { class: "wd-title-wrap" }, titleIn, saveHint),
    el("div", { class: "wd-head-actions" }, starBtn, saveInspBtn, trashBtn, closeBtn)
  );

  // Two clean tabs
  const tabDetailsBtn = el("button", { type: "button", class: "wd-tab is-active", "data-wd-tab": "details" }, "📋 详情与提示词");
  const pubStatusDot = el("span", { class: "wd-tab-dot", hidden: !run.publishedWorkId });
  const tabPublishBtn = el("button", { type: "button", class: "wd-tab", "data-wd-tab": "publish" }, "☁ 发布到社区", pubStatusDot);
  const tabsBar = el("div", { class: "wd-tabs" }, tabDetailsBtn, tabPublishBtn);

  const pane = el("div", { class: "wd-pane" });
  const inspectorFoot = el("div", { class: "wd-inspector-foot", hidden: true });

  // ---------- Details Tab Components (pre-skill & post-skill synced with active image) ----------
  const recipeChips = [];
  const pushChip = (k, v) => {
    if (!v) return;
    recipeChips.push(el("span", { class: "work-recipe-chip" }, el("span", { class: "k" }, k), el("strong", null, v)));
  };
  if (parsedRec.styleIds.length) pushChip("画风", parsedRec.styleIds.join(" + "));
  if (parsedRec.layoutId) pushChip("图型", parsedRec.layoutId);
  if (parsedRec.colors.length) pushChip("主题色", parsedRec.colors.join(" / "));
  if (parsedRec.tones.length) pushChip("影调", parsedRec.tones.join(" / "));
  if (parsedRec.mood) pushChip("情绪", parsedRec.mood);
  if (parsedRec.ratio) pushChip("比例", parsedRec.ratio);
  if (parsedRec.mode) pushChip("模式", modeLabel(parsedRec.mode));
  if (parsedRec.quality) pushChip("规格", parsedRec.quality);
  if (parsedRec.shootType) pushChip("景别", parsedRec.shootType);
  if (parsedRec.sc021Type) pushChip("版式", parsedRec.sc021Type);
  if (run.modelLabel || run.model) pushChip("生图模型", run.modelLabel || run.model);

  const preSkillCard = el("div", { class: "work-info-card", "data-work-section": "pre-skill" },
    el("div", { class: "work-info-head" },
      el("div", { class: "work-info-title" },
        el("span", { class: "work-info-step" }, "① Skill 解析前"),
        "配方参数与原始输入"
      ),
      originalReqText ? el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => toast((await copyText(originalReqText)) ? "已复制原始输入" : "复制失败"),
      }, "📋 复制") : null
    ),
    recipeChips.length
      ? el("div", { class: "work-recipe-grid" }, ...recipeChips)
      : el("span", { class: "muted", style: { fontSize: "12px" } }, "本次创作未选择画风/图型配方参数（纯提示词生图）。"),
    el("div", { class: "col", style: { gap: "4px" } },
      el("span", { class: "muted", style: { fontSize: "11.5px", fontWeight: "600" } }, "用户原始输入提示词"),
      el("pre", { class: "work-prompt-viewer" }, originalReqText || "（本次创作未单独记录用户原始输入）")
    )
  );

  let activeExpandedText = expandedInfo.defaultPrompt;
  const expandedPre = el("pre", { class: "work-prompt-viewer mono", style: { fontSize: "12px" } }, "");
  const expandedSwitchRow = el("div", { class: "row", style: { gap: "5px", flexWrap: "wrap" } });
  const copyExpandedBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: async () => toast((await copyText(activeExpandedText)) ? "已复制解析后提示词" : "复制失败"),
  }, "📋 复制");

  const syncPostSkillCard = () => {
    const curImg = doneImages[activeIdx];
    const variants = [];
    const pushVariant = (label, txt) => {
      const clean = String(txt || "").trim();
      if (!clean || variants.some((v) => v.txt === clean)) return;
      variants.push({ label, txt: clean });
    };
    if (curImg?.prompt) {
      pushVariant(doneImages.length > 1 ? `图 #${activeIdx + 1} 模型稿` : "生图模型实际稿", curImg.prompt);
    }
    pushVariant("中文解析稿", expandedInfo.zh);
    pushVariant("英文生图稿", expandedInfo.en);

    clear(expandedSwitchRow);
    const applyVariant = (txt, btn) => {
      activeExpandedText = txt;
      expandedPre.textContent = txt || "（未记录发给生图模型的解析后提示词）";
      copyExpandedBtn.hidden = !txt;
      expandedSwitchRow.querySelectorAll("button").forEach((b) => b.classList.toggle("pill-accent", b === btn));
    };
    if (variants.length > 1) {
      variants.forEach((v, idx) => {
        const b = el("button", {
          type: "button",
          class: "pill-btn" + (idx === 0 ? " pill-accent" : ""),
          style: { padding: "2px 8px", fontSize: "11.5px" },
          onClick: () => applyVariant(v.txt, b),
        }, v.label);
        expandedSwitchRow.appendChild(b);
      });
    }
    applyVariant(variants[0]?.txt || "", expandedSwitchRow.firstChild);
  };

  const postSkillCard = el("div", { class: "work-info-card", "data-work-section": "post-skill" },
    el("div", { class: "work-info-head" },
      el("div", { class: "work-info-title" },
        el("span", { class: "work-info-step" }, "② Skill 解析后"),
        "生图模型实际提示词"
      ),
      copyExpandedBtn
    ),
    expandedSwitchRow,
    expandedPre
  );

  // ---------- Publish Tab Components (Two-Choice + Mandatory Paid Pricing) ----------
  const notesIn = el("textarea", {
    class: "input",
    rows: 2,
    maxlength: 2000,
    placeholder: "可选：创作说明、心得或使用建议（社区用户可见，不泄露收费配方/提示词）",
  });
  let inspPromptDirty = false;
  const inspPromptIn = el("textarea", {
    class: "input mono",
    rows: 4,
    placeholder: "将分享到灵感库的完整生图提示词（默认取经过 Skill 解析后发给生图模型的提示词）",
  }, expandedInfo.defaultPrompt || originalReqText || "");
  inspPromptIn.addEventListener("input", () => { inspPromptDirty = true; });
  const inspTagsIn = el("input", {
    class: "input",
    placeholder: "标签（逗号分隔，如：手绘，封面，治愈）",
  });

  const encodeSelectedImages = async (btn) => {
    const ids = Array.from(selectedIds);
    const encoded = {};
    const orderedDataUrls = [];
    let n = 0;
    for (const id of ids) {
      const im = run.images.find((x) => x.id === id);
      btn.textContent = `正在压缩图片 ${++n}/${ids.length}…`;
      const url = im ? await toWebp(localImg(im.path)) : "";
      if (url) {
        encoded[id] = url;
        orderedDataUrls.push(url);
      }
    }
    return { ids, encoded, orderedDataUrls };
  };

  const renderPublishedReceipt = (kindLabel, url, price) => {
    const cut = price ? Math.max(1, Math.floor((price * 80) / 100)) : 0;
    return el("div", { class: "card col", style: { gap: "8px", background: "var(--paper)" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
        el("span", { class: "badge badge-ok" }, `✓ 已发布为${kindLabel}${price ? ` · ${price} 积分解锁 (+${cut}分/次)` : ""}`),
        el("div", { class: "row", style: { gap: "6px" } },
          el("button", { type: "button", class: "btn btn-sm", onClick: async () => toast((await copyText(url)) ? "链接已复制" : "复制失败") }, "复制链接"),
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openURL(url) }, "↗ 网站查看")
        )
      ),
      el("span", { class: "muted mono", style: { wordBreak: "break-all", fontSize: "11.5px" } }, url)
    );
  };

  // ---------- Sync Left Stage (Hero image + filmstrip + selection checkmarks) ----------
  const renderFilmstrip = () => {
    if (doneImages.length <= 1) return;
    clear(filmstripEl);
    doneImages.forEach((im, idx) => {
      const isChecked = selectedIds.has(im.id);
      const pickBtn = el("button", {
        type: "button",
        class: "wd-thumb-pick" + (isChecked ? " is-checked" : ""),
        title: isChecked ? "取消勾选发布" : "勾选参与发布",
        onClick: (e) => {
          e.stopPropagation();
          if (selectedIds.has(im.id)) selectedIds.delete(im.id);
          else selectedIds.add(im.id);
          renderFilmstrip();
          if (activeTab === "publish") renderPane();
        },
      }, isChecked ? "✓" : "");
      const thumb = el("div", {
        class: "wd-thumb-item" + (idx === activeIdx ? " is-active" : ""),
        role: "button",
        tabindex: "0",
        "aria-label": `查看第 ${idx + 1} 张图`,
        onClick: () => selectImage(idx),
      },
        el("img", { src: localImg(im.thumb || im.path), alt: `#${idx + 1}` }),
        activeTab === "publish" ? pickBtn : null
      );
      filmstripEl.appendChild(thumb);
    });
  };

  const selectImage = (idx) => {
    if (!doneImages.length) return;
    activeIdx = ((idx % doneImages.length) + doneImages.length) % doneImages.length;
    const im = doneImages[activeIdx];
    heroImg.src = localImg(im.path);
    heroImg.alt = `${run.title || "作品"} #${activeIdx + 1}`;
    setZoom(false);
    const dim = im.width && im.height ? ` · ${im.width}×${im.height}` : "";
    stageMetaEl.textContent = doneImages.length > 1 ? `第 ${activeIdx + 1} / ${doneImages.length} 张${dim}` : `原图${dim}`;
    renderFilmstrip();
    syncPostSkillCard();
    if (!inspPromptDirty && im.prompt) {
      inspPromptIn.value = String(im.prompt).trim();
    }
  };

  prevBtn.addEventListener("click", () => selectImage(activeIdx - 1));
  nextBtn.addEventListener("click", () => selectImage(activeIdx + 1));

  // ---------- Render Right Inspector Pane ----------
  const renderPane = () => {
    clear(pane);
    clear(inspectorFoot);
    tabDetailsBtn.classList.toggle("is-active", activeTab === "details");
    tabPublishBtn.classList.toggle("is-active", activeTab === "publish");
    pubStatusDot.hidden = !(run.publishedWorkId || publishedInspReceipt);
    renderFilmstrip();

    if (activeTab === "details") {
      inspectorFoot.hidden = false;
      pane.appendChild(preSkillCard);
      pane.appendChild(postSkillCard);
      inspectorFoot.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } },
        run.publishedWorkId ? "✓ 已发布到社区" : "作品仅存于本地，主动发布才公开"
      ));
      inspectorFoot.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => { activeTab = "publish"; renderPane(); },
      }, run.publishedWorkId ? "查看发布 / 分享灵感 →" : "☁ 定价发布赚积分 →"));
      return;
    }

    // Publish tab
    const pubWrap = el("div", { class: "col", "data-work-section": "publish", style: { gap: "11px" } });

    if (doneImages.length > 1) {
      pubWrap.appendChild(el("div", { class: "wd-select-bar" },
        el("span", null, `已选 `, el("strong", null, `${selectedIds.size}/${doneImages.length}`), ` 张（可点左侧缩略图角标增减）`),
        el("div", { class: "row", style: { gap: "4px", flexWrap: "nowrap", flexShrink: "0" } },
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => { doneImages.slice(0, 12).forEach((i) => selectedIds.add(i.id)); renderPane(); },
          }, "全选"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => {
              selectedIds.clear();
              if (doneImages[activeIdx]) selectedIds.add(doneImages[activeIdx].id);
              renderPane();
            },
          }, "仅当前")
        )
      ));
    }

    const choiceWorkBtn = el("button", {
      type: "button",
      class: "work-publish-choice" + (publishMode === "work" ? " is-active" : ""),
      "data-publish-choice": "work",
      onClick: () => { publishMode = "work"; renderPane(); },
    },
      el("strong", null, "🎨 发布为「作品」"),
      el("span", null, "手绘 Skill 配方 + 原始输入；他人查看配方需积分解锁。")
    );
    const choiceInspBtn = el("button", {
      type: "button",
      class: "work-publish-choice" + (publishMode === "inspiration" ? " is-active" : ""),
      "data-publish-choice": "inspiration",
      onClick: () => { publishMode = "inspiration"; renderPane(); },
    },
      el("strong", null, "💡 发布为「灵感库」"),
      el("span", null, "解析后提示词 + 图片；评论后自动进论坛「贴图与提示词」。")
    );
    pubWrap.appendChild(el("div", { class: "wd-publish-choices-compact" }, choiceWorkBtn, choiceInspBtn));

    if (publishMode === "work") {
      if (run.publishedWorkId) {
        pubWrap.appendChild(renderPublishedReceipt("社区作品", run.publishedUrl, run._publishedPrice || 0));
        pubWrap.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } },
          "如需将「Skill 解析后的完整提示词」另行上架赚积分，可点上方右侧切换为「发布为灵感库」。"
        ));
        pane.appendChild(pubWrap);
        inspectorFoot.hidden = true;
        return;
      }

      const cutHint = el("span", { style: { fontSize: "12px", fontWeight: "600", color: "var(--accent)" } }, "");
      const presetBtns = [];
      const submitBtn = el("button", { type: "button", class: "btn btn-primary", style: { width: "100%", justifyContent: "center" } }, "");
      const syncWorkPrice = (p) => {
        workPrice = p;
        const cut = Math.max(1, Math.floor((p * 80) / 100));
        cutHint.textContent = `每次解锁你得 +${cut} 积分 (80%)`;
        presetBtns.forEach(({ n, btn }) => btn.classList.toggle("pill-accent", n === p));
        submitBtn.textContent = `🔒 发布为作品（${p} 积分解锁配方）`;
      };
      const presetsRow = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
      [1, 2, 3, 5, 10, 20].forEach((n) => {
        const b = el("button", { type: "button", class: "pill-btn", onClick: () => syncWorkPrice(n) }, n === 2 ? `${n} 积分 (推荐)` : `${n} 积分`);
        presetBtns.push({ n, btn: b });
        presetsRow.appendChild(b);
      });
      syncWorkPrice(workPrice);

      pubWrap.appendChild(el("div", { class: "work-pricing-panel" },
        el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
          el("strong", { style: { fontSize: "12.5px" } }, "🔒 配方解锁积分（必选 · 不支持免费）"),
          cutHint
        ),
        presetsRow,
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, "效果图免费展示；画风/图型/参数配方与原始提示词需积分解锁。自建画风仅显名称，不泄露本机定义。")
      ));
      pubWrap.appendChild(el("div", { class: "field" }, el("label", null, "创作说明（可选，公开可见）"), notesIn));

      submitBtn.addEventListener("click", async () => {
        if (!selectedIds.size) return toast("请至少勾选 1 张已完成的图片");
        submitBtn.disabled = true;
        const prevLabel = submitBtn.textContent;
        try {
          const { ids, encoded } = await encodeSelectedImages(submitBtn);
          submitBtn.textContent = "正在发布作品…";
          const res = await api("POST", `/api/works/${encodeURIComponent(run.id)}/publish`, {
            title: titleIn.value.trim(),
            notes: notesIn.value.trim(),
            price: workPrice,
            imageIds: ids,
            encoded,
          });
          toast(`作品已发布！配方定价 ${workPrice} 积分`);
          run.publishedWorkId = res.workId;
          run.publishedUrl = res.url;
          run._publishedPrice = workPrice;
          renderPane();
          onChanged?.();
        } catch (e) {
          toast(e.message || "发布失败");
          submitBtn.disabled = false;
          submitBtn.textContent = prevLabel;
        }
      });

      pane.appendChild(pubWrap);
      inspectorFoot.hidden = false;
      inspectorFoot.appendChild(submitBtn);
    } else {
      if (publishedInspReceipt) {
        pubWrap.appendChild(renderPublishedReceipt("灵感库提示词", publishedInspReceipt.url, publishedInspReceipt.price));
        pane.appendChild(pubWrap);
        inspectorFoot.hidden = true;
        return;
      }

      const cutHint = el("span", { style: { fontSize: "12px", fontWeight: "600", color: "var(--accent)" } }, "");
      const customPriceIn = el("input", { class: "input", type: "number", min: "1", max: "20", value: String(inspPrice), style: { width: "74px" } });
      const presetBtns = [];
      const submitBtn = el("button", { type: "button", class: "btn btn-primary", style: { width: "100%", justifyContent: "center" } }, "");
      const syncInspPrice = (val) => {
        const p = Math.max(1, Math.min(20, Math.round(Number(val) || 5)));
        inspPrice = p;
        customPriceIn.value = String(p);
        const cut = Math.max(1, Math.floor((p * 80) / 100));
        cutHint.textContent = `每次解锁你得 +${cut} 积分 (80%)`;
        presetBtns.forEach(({ n, btn }) => btn.classList.toggle("pill-accent", n === p));
        submitBtn.textContent = `🔒 发布到灵感库（${p} 积分解锁提示词）`;
      };
      customPriceIn.addEventListener("input", () => syncInspPrice(customPriceIn.value));
      const presetsRow = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
      [2, 5, 8, 10, 15, 20].forEach((n) => {
        const b = el("button", { type: "button", class: "pill-btn", onClick: () => syncInspPrice(n) }, n === 5 ? `${n} 积分 (推荐)` : `${n} 积分`);
        presetBtns.push({ n, btn: b });
        presetsRow.appendChild(b);
      });
      syncInspPrice(inspPrice);

      pubWrap.appendChild(el("div", { class: "field" }, el("label", null, "将分享的解析后提示词（可微调）"), inspPromptIn));
      pubWrap.appendChild(el("div", { class: "work-pricing-panel" },
        el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
          el("strong", { style: { fontSize: "12.5px" } }, "🔒 提示词解锁积分（1~20 · 不支持免费）"),
          cutHint
        ),
        presetsRow,
        el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
          el("span", { style: { fontSize: "12px" } }, "自定义积分："),
          customPriceIn,
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, "被评论将自动进入论坛「贴图与提示词」")
        )
      ));
      pubWrap.appendChild(el("div", { class: "field" }, el("label", null, "标签（可选）"), inspTagsIn));
      pubWrap.appendChild(el("div", { class: "field" }, el("label", null, "创作心得（可选）"), notesIn));

      submitBtn.addEventListener("click", async () => {
        if (!selectedIds.size) return toast("请至少勾选 1 张已完成的图片");
        const promptTxt = inspPromptIn.value.trim();
        if (!promptTxt) return toast("请确认要分享的解析后提示词");
        submitBtn.disabled = true;
        const prevLabel = submitBtn.textContent;
        try {
          const { orderedDataUrls } = await encodeSelectedImages(submitBtn);
          submitBtn.textContent = "正在上架灵感库…";
          const firstSelectedImg = run.images.find((x) => selectedIds.has(x.id) && x.path) || doneImages[0];
          const tags = inspTagsIn.value.split(/[,，、\s]+/).map((s) => s.replace(/^#/, "").trim()).filter(Boolean);
          const created = await api("POST", "/api/inspirations", {
            title: titleIn.value.trim() || run.title || "我的创作灵感",
            imagePath: firstSelectedImg?.path || "",
            prompt: promptTxt,
            promptZh: expandedInfo.zh || "",
            tags,
            notes: notesIn.value.trim(),
            source: "local",
            runId: run.id,
            recipe: parsedRec.raw,
            suggestedStyle: parsedRec.styleIds[0] || "",
          });
          const inspId = created?.item?.id || created?.id;
          if (!inspId) throw new Error("本地灵感记录创建失败");
          const pubRes = await api("POST", `/api/inspirations/${encodeURIComponent(inspId)}/publish`, {
            title: titleIn.value.trim() || run.title || "我的创作灵感",
            prompt: promptTxt,
            notes: notesIn.value.trim(),
            tags,
            price: inspPrice,
            encoded: orderedDataUrls[0] || "",
            images: orderedDataUrls,
          });
          publishedInspReceipt = { url: pubRes.fullUrl || pubRes.url || "", price: inspPrice };
          toast(`已上架到灵感库！解锁定价 ${inspPrice} 积分`);
          ctx.refreshTopbar?.();
          renderPane();
          onChanged?.();
        } catch (e) {
          toast(e.message || "发布失败");
          submitBtn.disabled = false;
          submitBtn.textContent = prevLabel;
        }
      });

      pane.appendChild(pubWrap);
      inspectorFoot.hidden = false;
      inspectorFoot.appendChild(submitBtn);
    }
  };

  tabDetailsBtn.addEventListener("click", () => { activeTab = "details"; renderPane(); });
  tabPublishBtn.addEventListener("click", () => { activeTab = "publish"; renderPane(); });

  const inspectorCol = el("div", { class: "wd-inspector" }, headBar, tabsBar, pane, inspectorFoot);
  const shell = el("div", { class: "wd-shell" }, stageCol, inspectorCol);

  // Keyboard navigation (←/→ switch images when not editing text)
  const onKeyDown = (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (doneImages.length > 1 && e.key === "ArrowLeft") { e.preventDefault(); selectImage(activeIdx - 1); }
    else if (doneImages.length > 1 && e.key === "ArrowRight") { e.preventDefault(); selectImage(activeIdx + 1); }
  };
  document.addEventListener("keydown", onKeyDown);

  if (doneImages.length) {
    selectImage(0);
  } else {
    stageMetaEl.textContent = "暂无图片";
    zoomBtn.hidden = true;
    syncPostSkillCard();
  }
  renderPane();

  showModal(run.title || "作品详情", shell, [], {
    className: "modal-work-detail",
    hideHeader: true,
    hideFooter: true,
    flush: true,
    onClose: () => {
      document.removeEventListener("keydown", onKeyDown);
      clearTimeout(trashTimer);
    },
  });
}

async function drawSiteHistory(stage, ctx) {
  try {
    const res = await api("GET", "/api/site/history");
    const raw = res.data || {};
    const rawList = Array.isArray(raw) ? raw : (raw.items || raw.generations || raw.runs || []);
    const list = rawList.filter((it) => {
      const st = String(it.status || "").toLowerCase();
      if (st === "failed" || st === "error" || st === "cancelled") return false;
      const imgs = it.images || (it.imageUrl ? [it.imageUrl] : (it.coverUrl ? [it.coverUrl] : []));
      const urls = imgs.map((x) => (typeof x === "string" ? x : (x.url || x.imageUrl || ""))).filter(Boolean);
      return urls.length > 0;
    });
    const base = res.siteBase || "https://handraw-style.com";
    if (!list.length) {
      stage.appendChild(el("div", { class: "card muted" }, "暂无已完成的网站生图历史。"));
      return;
    }
    const grid = masonry();
    list.forEach((it) => {
      const imgs = it.images || (it.imageUrl ? [it.imageUrl] : (it.coverUrl ? [it.coverUrl] : []));
      const urls = imgs.map((x) => (typeof x === "string" ? x : (x.url || x.imageUrl || ""))).filter(Boolean);
      const fullURL = urls[0] ? remoteThumb(urls[0], 480, base) : "/img/logo.svg";
      const pageURL = it.url || (it.workId ? `${base}/t/work-${it.workId}` : `${base}/studio`);
      grid.appendChild(el("div", { class: "style-card" },
        el("img", { class: "style-thumb", src: fullURL, alt: it.title || it.originalRequest || "", loading: "lazy" }),
        el("div", { class: "style-body" },
          el("div", { class: "style-name" }, it.title || it.originalRequest || "网站记录"),
          el("div", { class: "muted" }, it.model || it.createdAt || "")
        ),
        el("div", { class: "style-actions" },
          urls.length ? el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            onClick: async () => {
              try {
                const dl = await api("POST", `/api/site/history/${encodeURIComponent(it.id || it.workId || "site")}/download`, {
                  title: it.title || it.originalRequest || "网站作品",
                  prompt: it.prompt || it.originalRequest || "",
                  model: it.model || "site",
                  images: urls.map((u) => (u.startsWith("http") ? u : base + u)),
                  siteRunId: it.id || "",
                });
                toast("已保存到本地作品库");
                state.tab = "local";
                renderWorks(stage.parentElement, ctx, { openRun: dl.run?.id });
              } catch (e) { toast(e.message); }
            },
          }, "⬇ 下载到本地") : null,
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(pageURL) }, "↗ 在网站查看")
        )
      ));
    });
    stage.appendChild(grid);
  } catch (e) {
    stage.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between" } },
      el("span", { class: "muted" }, e.code === "not_logged_in" ? "请先登录手绘风账号以同步网站生图历史。" : e.message),
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("settings") }, "前往登录")
    ));
  }
}

async function drawSiteCollections(stage, ctx) {
  try {
    const res = await api("GET", "/api/site/collections");
    const raw = res.data || {};
    const list = Array.isArray(raw) ? raw : (raw.items || raw.collections || []);
    const base = res.siteBase || "https://handraw-style.com";
    if (!list.length) {
      stage.appendChild(el("div", { class: "card muted" }, "暂无网站收藏。"));
      return;
    }
    const grid = masonry();
    list.forEach((it) => {
      const thumb = it.coverUrl || it.imageUrl || it.image || "/img/logo.svg";
      const src = thumb === "/img/logo.svg" ? thumb : remoteThumb(thumb, 480, base);
      const pageURL = it.url || (it.workId ? `${base}/t/work-${it.workId}` : (it.id ? `${base}/t/${it.id}` : base));
      grid.appendChild(el("div", { class: "style-card" },
        el("img", { class: "style-thumb", src, alt: it.title || it.name || "", loading: "lazy" }),
        el("div", { class: "style-body" },
          el("div", { class: "style-name" }, it.title || it.name || "收藏项目"),
          el("div", { class: "muted" }, it.author || it.kind || "")
        ),
        el("div", { class: "style-actions" },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openURL(pageURL) }, "↗ 在网站打开")
        )
      ));
    });
    stage.appendChild(grid);
  } catch (e) {
    stage.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between" } },
      el("span", { class: "muted" }, e.code === "not_logged_in" ? "请先登录手绘风账号以查看网站收藏。" : e.message),
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("settings") }, "前往登录")
    ));
  }
}
