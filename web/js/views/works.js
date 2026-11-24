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

  const titleIn = el("input", { class: "input", value: run.title || "" });
  const notesIn = el("textarea", { class: "input", rows: 2, maxlength: 2000, placeholder: "可选：创作说明、心得或使用建议（社区用户可见，不泄露收费配方/提示词）" });
  const body = el("div", { class: "col", style: { gap: "12px" } });

  // Versions strip if >1 completed version
  const doneVersions = versions.filter((v) => v.id === run.id || v.status === "done");
  if (doneVersions.length > 1) {
    const vRow = el("div", { class: "row" }, el("span", { class: "muted" }, "修订版本："));
    doneVersions.forEach((v, idx) => {
      vRow.appendChild(el("button", {
        type: "button",
        class: "pill-btn" + (v.id === run.id ? " pill-accent" : ""),
        onClick: () => { closeModal(); openRunDetail(v.id, ctx, onChanged); },
      }, `v${idx + 1} · ${v.title?.slice(0, 10) || v.id.slice(-5)}`));
    });
    body.appendChild(vRow);
  }

  // Images gallery + selection for publishing (completed images only)
  const doneImages = (run.images || []).filter((i) => i.status === "done" && i.path);
  const selectedIds = new Set(doneImages.slice(0, 12).map((i) => i.id));
  const imgGrid = el("div", { class: "row", style: { gap: "10px", alignItems: "stretch", flexWrap: "wrap" } });
  doneImages.forEach((im, idx) => {
    const chk = el("input", { type: "checkbox", checked: selectedIds.has(im.id) });
    chk.addEventListener("change", () => {
      if (chk.checked) selectedIds.add(im.id);
      else selectedIds.delete(im.id);
    });
    imgGrid.appendChild(el("div", { class: "card col", style: { width: "190px", padding: "8px" } },
      el("img", { src: localImg(im.path), alt: `#${idx + 1}`, style: { width: "100%", height: "160px", objectFit: "cover", borderRadius: "6px" } }),
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("label", { class: "row", style: { fontSize: "12px", cursor: "pointer" } }, chk, "选作发布"),
        el("span", { class: "muted mono" }, `${im.width}×${im.height}`)
      ),
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => api("POST", `/api/images/${encodeURIComponent(im.id)}/copy`).then(() => toast("已复制")) }, "复制"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => { closeModal(); ctx.go("create", { editImage: im.path, theme: run.originalRequest || run.title }); } }, "垫图")
      )
    ));
  });
  body.appendChild(imgGrid);

  const parsedRec = parseRunRecipe(run);
  const expandedInfo = extractExpandedPrompts(run, doneImages);

  body.appendChild(el("div", { class: "field" },
    el("label", null, "作品标题（可修改）"),
    el("div", { class: "row", style: { flexWrap: "wrap" } },
      titleIn,
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => { await api("PATCH", `/api/works/${encodeURIComponent(run.id)}`, { title: titleIn.value.trim() }); toast("标题已保存"); onChanged?.(); },
      }, "保存标题"),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => { await api("PATCH", `/api/works/${encodeURIComponent(run.id)}`, { starred: !run.starred }); toast(run.starred ? "已取消星标" : "已标星收藏"); closeModal(); openRunDetail(run.id, ctx, onChanged); onChanged?.(); },
      }, run.starred ? "★ 已标星" : "☆ 标星"),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => {
          const firstImg = doneImages[0];
          try {
            await api("POST", "/api/inspirations", {
              title: titleIn.value.trim() || run.title || "我的创作灵感",
              imagePath: firstImg?.path || "",
              prompt: expandedInfo.defaultPrompt || run.originalRequest || run.title || "",
              promptZh: expandedInfo.zh || "",
              source: "local",
              runId: run.id,
              recipe: parsedRec.raw,
              suggestedStyle: parsedRec.styleIds[0] || "",
            });
            toast("已收进本地灵感库，可随时 AI 整理或定价分享");
          } catch (e) { toast(e.message); }
        },
      }, "💡 暂存到本地灵感库")
    )
  ));

  // ---------- Section ①: Skill 解析前的配方与原始输入 ----------
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

  const originalReqText = String(run.originalRequest || "").trim();
  const preSkillCard = el("div", { class: "work-info-card", "data-work-section": "pre-skill" },
    el("div", { class: "work-info-head" },
      el("div", { class: "work-info-title" },
        el("span", { class: "work-info-step" }, "① Skill 解析前"),
        "配方参数与用户原始输入"
      ),
      originalReqText ? el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => toast((await copyText(originalReqText)) ? "已复制原始输入" : "复制失败"),
      }, "📋 复制原始输入") : null
    ),
    recipeChips.length
      ? el("div", { class: "work-recipe-grid" }, ...recipeChips)
      : el("span", { class: "muted", style: { fontSize: "12px" } }, "本次创作未选择画风/图型配方参数（纯提示词生图）。"),
    el("div", { class: "col", style: { gap: "4px" } },
      el("span", { class: "muted", style: { fontSize: "11.5px", fontWeight: "600" } }, "用户原始输入提示词"),
      el("pre", { class: "work-prompt-viewer" }, originalReqText || "（本次创作未单独记录用户原始输入）")
    )
  );
  body.appendChild(preSkillCard);

  // ---------- Section ②: 经过 Skill 解析的提示词（生图模型实际接收） ----------
  let activeExpandedText = expandedInfo.defaultPrompt;
  const expandedPre = el("pre", { class: "work-prompt-viewer mono", style: { fontSize: "12px" } },
    activeExpandedText || "（未记录发给生图模型的解析后提示词）"
  );
  const expandedSwitchRow = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
  const setExpandedText = (txt, activeBtn) => {
    activeExpandedText = txt;
    expandedPre.textContent = txt || "（无内容）";
    expandedSwitchRow.querySelectorAll("button").forEach((b) => b.classList.toggle("pill-accent", b === activeBtn));
  };
  if (expandedInfo.hasMultiImagePrompts) {
    expandedInfo.perImage.forEach((entry, idx) => {
      const btn = el("button", {
        type: "button",
        class: "pill-btn" + (idx === 0 ? " pill-accent" : ""),
        onClick: () => setExpandedText(entry.prompt, btn),
      }, entry.label);
      expandedSwitchRow.appendChild(btn);
    });
  } else {
    const variants = [];
    const pushVariant = (label, txt) => {
      if (!txt || variants.some((v) => v.txt === txt)) return;
      variants.push({ label, txt });
    };
    if (expandedInfo.perImage[0]?.prompt) pushVariant("生图模型实际稿", expandedInfo.perImage[0].prompt);
    pushVariant("中文解析稿", expandedInfo.zh);
    pushVariant("英文生图稿", expandedInfo.en);
    if (variants.length > 1) {
      variants.forEach((v, idx) => {
        const btn = el("button", {
          type: "button",
          class: "pill-btn" + (idx === 0 ? " pill-accent" : ""),
          onClick: () => setExpandedText(v.txt, btn),
        }, v.label);
        expandedSwitchRow.appendChild(btn);
      });
    }
  }

  const postSkillCard = el("div", { class: "work-info-card", "data-work-section": "post-skill" },
    el("div", { class: "work-info-head" },
      el("div", { class: "work-info-title" },
        el("span", { class: "work-info-step" }, "② Skill 解析后"),
        "生图模型实际接收的提示词"
      ),
      el("div", { class: "row", style: { gap: "6px" } },
        expandedSwitchRow.childNodes.length ? expandedSwitchRow : null,
        activeExpandedText ? el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => toast((await copyText(activeExpandedText)) ? "已复制解析后提示词" : "复制失败"),
        }, "📋 复制解析后提示词") : null
      )
    ),
    expandedPre
  );
  body.appendChild(postSkillCard);

  // ---------- Section ③: 发布二选一 + 强制积分解锁 ----------
  const pubBox = el("div", { class: "card col publish-box", "data-work-section": "publish", style: { gap: "12px" } });
  let publishMode = "work"; // "work" | "inspiration"
  let workPrice = 2; // allowed tiers: 1, 2, 3, 5, 10, 20
  let inspPrice = 5; // 1..20

  const inspPromptIn = el("textarea", {
    class: "input mono",
    rows: 4,
    placeholder: "将分享到灵感库的完整生图提示词（默认取经过 Skill 解析后发给生图模型的提示词）",
  }, expandedInfo.defaultPrompt || originalReqText || "");
  const inspTagsIn = el("input", {
    class: "input",
    placeholder: "可选标签，逗号分隔，例如：手绘，封面，治愈",
  });

  const choiceWorkBtn = el("button", { type: "button", class: "work-publish-choice is-active", "data-publish-choice": "work" },
    el("strong", null, "🎨 发布为「作品」", el("span", { class: "badge badge-accent" }, "配方 + 原始输入")),
    el("span", null, "带手绘 Skill 关联的画风/图型/参数配方 + 用户原始输入提示词 + 图片，进入社区作品广场；他人查看配方需积分解锁。")
  );
  const choiceInspBtn = el("button", { type: "button", class: "work-publish-choice", "data-publish-choice": "inspiration" },
    el("strong", null, "💡 发布为「灵感库」", el("span", { class: "badge" }, "解析后提示词 + 图片")),
    el("span", null, "分享经过 Skill 解析后的完整生图提示词 + 图片，进入社区灵感库；他人查看提示词需积分解锁，被评论后自动进入论坛「贴图与提示词」板块。")
  );

  const dynamicPubArea = el("div", { class: "col", style: { gap: "10px" } });

  const renderPublishedReceipt = (kindLabel, url, price) => {
    const cut = Math.max(1, Math.floor((price * 80) / 100));
    return el("div", { class: "card col", style: { gap: "6px", background: "var(--paper)" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } },
        el("span", { class: "badge badge-ok" }, `✓ 已发布为${kindLabel}${price ? ` · ${price} 积分解锁（作者 +${cut} 积分/次）` : ""}`),
        el("div", { class: "row", style: { gap: "6px" } },
          el("button", { type: "button", class: "btn btn-sm", onClick: async () => toast((await copyText(url)) ? "链接已复制" : "复制失败") }, "复制链接"),
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openURL(url) }, "↗ 在网站打开")
        )
      ),
      el("span", { class: "muted mono", style: { wordBreak: "break-all", fontSize: "11.5px" } }, url)
    );
  };

  let publishedInspReceipt = null;

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

  const renderPublishForm = () => {
    clear(dynamicPubArea);
    choiceWorkBtn.classList.toggle("is-active", publishMode === "work");
    choiceInspBtn.classList.toggle("is-active", publishMode === "inspiration");

    if (publishMode === "work") {
      if (run.publishedWorkId) {
        dynamicPubArea.appendChild(renderPublishedReceipt("社区作品", run.publishedUrl, run._publishedPrice || 0));
        dynamicPubArea.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } }, "如需将「Skill 解析后的完整提示词」另行分享赚积分，可切换到右侧「发布为灵感库」。"));
        return;
      }
      const cutHint = el("span", { class: "muted", style: { fontSize: "12px", fontWeight: "600", color: "var(--accent)" } }, "");
      const presetBtns = [];
      const syncWorkPrice = (p) => {
        workPrice = p;
        const cut = Math.max(1, Math.floor((p * 80) / 100));
        cutHint.textContent = `每被解锁 1 次，你自动获得 +${cut} 积分（80% 分成）`;
        presetBtns.forEach(({ n, btn }) => btn.classList.toggle("pill-accent", n === p));
        submitBtn.textContent = `🔒 发布为作品（${p} 积分解锁配方）`;
      };
      const presetsRow = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
      [1, 2, 3, 5, 10, 20].forEach((n) => {
        const b = el("button", { type: "button", class: "pill-btn", onClick: () => syncWorkPrice(n) }, n === 2 ? `${n} 积分（推荐）` : `${n} 积分`);
        presetBtns.push({ n, btn: b });
        presetsRow.appendChild(b);
      });

      const pricingPanel = el("div", { class: "work-pricing-panel" },
        el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
          el("strong", { style: { fontSize: "13px" } }, "🔒 选择作品配方解锁积分（必选 · 不支持免费）"),
          cutHint
        ),
        presetsRow,
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, "效果图免费展示；画风、图型、参数配方与原始输入提示词需消耗积分后解锁。自建画风仅显示名称，不泄露本机定义。")
      );

      const submitBtn = el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
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
            renderPublishForm();
            onChanged?.();
          } catch (e) {
            toast(e.message || "发布失败");
            submitBtn.disabled = false;
            submitBtn.textContent = prevLabel;
          }
        },
      }, "");

      syncWorkPrice(workPrice);
      dynamicPubArea.appendChild(pricingPanel);
      dynamicPubArea.appendChild(notesIn);
      dynamicPubArea.appendChild(el("div", { class: "row" }, submitBtn));
    } else {
      if (publishedInspReceipt) {
        dynamicPubArea.appendChild(renderPublishedReceipt("灵感库提示词", publishedInspReceipt.url, publishedInspReceipt.price));
        return;
      }
      const cutHint = el("span", { class: "muted", style: { fontSize: "12px", fontWeight: "600", color: "var(--accent)" } }, "");
      const customPriceIn = el("input", { class: "input", type: "number", min: "1", max: "20", value: String(inspPrice), style: { width: "78px" } });
      const presetBtns = [];
      const syncInspPrice = (val) => {
        const p = Math.max(1, Math.min(20, Math.round(Number(val) || 5)));
        inspPrice = p;
        customPriceIn.value = String(p);
        const cut = Math.max(1, Math.floor((p * 80) / 100));
        cutHint.textContent = `每被解锁 1 次，你自动获得 +${cut} 积分（80% 分成）`;
        presetBtns.forEach(({ n, btn }) => btn.classList.toggle("pill-accent", n === p));
        submitBtn.textContent = `🔒 发布到灵感库（${p} 积分解锁提示词）`;
      };
      customPriceIn.addEventListener("input", () => syncInspPrice(customPriceIn.value));
      const presetsRow = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
      [2, 5, 8, 10, 15, 20].forEach((n) => {
        const b = el("button", { type: "button", class: "pill-btn", onClick: () => syncInspPrice(n) }, n === 5 ? `${n} 积分（推荐）` : `${n} 积分`);
        presetBtns.push({ n, btn: b });
        presetsRow.appendChild(b);
      });

      const pricingPanel = el("div", { class: "work-pricing-panel" },
        el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
          el("strong", { style: { fontSize: "13px" } }, "🔒 选择灵感提示词解锁积分（必填 1~20 · 不支持免费）"),
          cutHint
        ),
        presetsRow,
        el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
          el("span", { style: { fontSize: "12px" } }, "自定义积分（1~20）："),
          customPriceIn,
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, "评论后将自动进入论坛「贴图与提示词」板块。")
        )
      );

      const submitBtn = el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          if (!selectedIds.size) return toast("请至少勾选 1 张已完成的图片");
          const promptTxt = inspPromptIn.value.trim();
          if (!promptTxt) return toast("请确认要分享的解析后提示词");
          submitBtn.disabled = true;
          const prevLabel = submitBtn.textContent;
          try {
            const { orderedDataUrls } = await encodeSelectedImages(submitBtn);
            submitBtn.textContent = "正在保存到灵感库并上架…";
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
            const pubUrl = pubRes.fullUrl || pubRes.url || "";
            publishedInspReceipt = { url: pubUrl, price: inspPrice };
            toast(`已上架到灵感库！解锁定价 ${inspPrice} 积分`);
            ctx.refreshTopbar?.();
            renderPublishForm();
            onChanged?.();
          } catch (e) {
            toast(e.message || "发布失败");
            submitBtn.disabled = false;
            submitBtn.textContent = prevLabel;
          }
        },
      }, "");

      syncInspPrice(inspPrice);
      dynamicPubArea.appendChild(el("div", { class: "field" }, el("label", null, "将分享的解析后提示词（可微调）"), inspPromptIn));
      dynamicPubArea.appendChild(pricingPanel);
      dynamicPubArea.appendChild(el("div", { class: "row", style: { gap: "10px", flexWrap: "wrap" } },
        el("div", { class: "field", style: { flex: "1", minWidth: "180px" } }, el("label", null, "标签（可选）"), inspTagsIn),
        el("div", { class: "field", style: { flex: "1", minWidth: "180px" } }, el("label", null, "创作心得（可选）"), notesIn)
      ));
      dynamicPubArea.appendChild(el("div", { class: "row" }, submitBtn));
    }
  };

  choiceWorkBtn.addEventListener("click", () => { publishMode = "work"; renderPublishForm(); });
  choiceInspBtn.addEventListener("click", () => { publishMode = "inspiration"; renderPublishForm(); });

  pubBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
    el("strong", null, "☁ 分享到社区（二选一 · 均需设置积分解锁）"),
    el("span", { class: "badge badge-accent" }, "作者享 80% 积分分成")
  ));
  pubBox.appendChild(el("div", { class: "work-publish-choices" }, choiceWorkBtn, choiceInspBtn));
  pubBox.appendChild(dynamicPubArea);
  renderPublishForm();
  body.appendChild(pubBox);

  showModal(run.title || "作品详情", body, [
    el("button", { type: "button", class: "btn", onClick: () => api("POST", `/api/works/${encodeURIComponent(run.id)}/reveal`) }, "📂 打开文件夹"),
    el("button", { type: "button", class: "btn", onClick: async () => { const r = await api("POST", `/api/works/${encodeURIComponent(run.id)}/export`, { format: "zip" }); toast("已导出：" + r.path); } }, "导出 ZIP"),
    el("button", {
      type: "button",
      class: "btn btn-danger",
      onClick: async () => {
        await api("DELETE", `/api/works/${encodeURIComponent(run.id)}`);
        closeModal();
        toast("已移至 .trash 回收站");
        onChanged?.();
      },
    }, "移入回收站"),
    el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭"),
  ]);
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
