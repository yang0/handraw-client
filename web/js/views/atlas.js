import { api, clear, closeModal, copyText, el, galleryImg, localImg, openURL, packImg, showModal, toast, toWebp } from "../api.js";
import { openLayoutEditorModal, openStyleEditorModal } from "./resource-editor.js";
import {
  assetCategoryLabel,
  bindPageImagePaste,
  deleteAssetCategory,
  extractClipboardImageFiles,
  fetchAssetCategories,
  fileDisplayName,
  fileToDataUrl,
  readClipboardImagesViaApi,
  saveAssetCategory,
} from "./ref-picker.js";
import { masonry } from "../masonry.js";
import { loadResourceRanking, rankResourceItems } from "./studio-controls.js";

const BUILTIN_GALLERY_IDS = new Set(["styles", "layouts", "colors", "tones", "assets", "characters", "props", "scenes"]);

const state = {
  tab: "styles", // styles | layouts | colors | tones | assets | <ext-gallery> | dice
  group: "",
  groups: { layouts: "", colors: "", tones: "", assets: "" },
  q: "",
  dice: { style: null, layout: null, color: null, lockStyle: false, lockLayout: false, lockColor: false },
};

const layoutNames = {
  community: "社区共享",
  "comic-storyboard": "漫画分镜", ecommerce: "电商图型",
  infographic: "信息图", "ip-character": "角色设计", "social-card": "社媒卡片",
};
const assetNames = { character: "角色", prop: "道具", scene: "场景" };

function categoryName(value) {
  return String(value || "其他").replace(/^[A-Z]{1,4}(?:-\d+)?[\s·:：、-]+(?=[\u3400-\u9fff])/, "");
}

// Add categories using the existing atlas sidebar and card styles.
function drawCatalog(stage, { kind, title, allLabel, items, groupKey, groupLabel, groups = [], card, before, empty }) {
  const categories = new Map(groups.map((g) => [g.key, { ...g, count: 0 }]));
  for (const item of items) {
    const key = groupKey(item) || "other";
    if (!categories.has(key)) categories.set(key, { key, label: groupLabel(item), count: 0 });
    categories.get(key).count++;
  }
  if (state.groups[kind] && !categories.has(state.groups[kind])) state.groups[kind] = "";
  const nav = el("div", { class: "atlas-groups", role: "group", "aria-label": `${title}分类` });
  const right = el("div");
  const grid = masonry();
  if (before) right.appendChild(before);
  right.appendChild(grid);
  if (categories.size > 1) stage.appendChild(el("div", { class: "atlas-wrap" }, nav, right));
  else stage.appendChild(right);

  for (const group of [{ key: "", label: allLabel, count: items.length }, ...categories.values()]) {
    nav.appendChild(el("button", {
      type: "button", class: "group-btn", dataset: { group: group.key },
      onClick: () => { state.groups[kind] = group.key; paint(); },
    }, el("span", null, categoryName(group.label)), el("span", { class: "muted" }, String(group.count))));
  }
  function paint() {
    nav.querySelectorAll("button").forEach((button) => {
      const selected = button.dataset.group === state.groups[kind];
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    clear(grid);
    const query = state.q.trim().toLowerCase();
    const selected = state.groups[kind];
    const visible = items.filter((item) =>
      (!selected || (groupKey(item) || "other") === selected) &&
      (!query || JSON.stringify(item).toLowerCase().includes(query))
    );
    if (!visible.length) {
      const emptyNode = typeof empty === "function" ? empty(selected) : empty;
      grid.appendChild(query ? el("div", { class: "card muted" }, "没有找到匹配的资源")
        : emptyNode instanceof Node ? emptyNode : el("div", { class: "card muted" }, emptyNode || "这个分类暂时没有资源"));
    } else {
      visible.forEach((item) => grid.appendChild(card(item)));
    }
  }
  paint();
}

export async function renderAtlas(root, ctx, params = {}) {
  if (params.tab) state.tab = params.tab;
  if (state.tab === "mine") { state.tab = "styles"; state.group = MINE; }
  if (params.group !== undefined) {
    if (state.tab === "styles") state.group = params.group;
    else if (state.tab === "layouts") state.groups.layouts = params.group;
  }
  if (params.q !== undefined) state.q = params.q;
  clear(root);

  const [summary, galRes] = await Promise.all([
    api("GET", "/api/resources/summary").catch(() => ({ groups: [], counts: {} })),
    api("GET", "/api/galleries").catch(() => ({ galleries: [] })),
  ]);
  const extraGalleries = (galRes.galleries || []).filter((g) => g && g.id && !BUILTIN_GALLERY_IDS.has(g.id));
  const extraById = new Map(extraGalleries.map((g) => [g.id, g]));

  const tabs = [
    ["styles", `画风 (${summary.counts?.styles || 0})`],
    ["layouts", `图型 (${summary.counts?.layouts || 0})`],
    ["colors", `主题色 (${summary.counts?.colors || 0})`],
    ["tones", `影调 (${summary.counts?.tones || 0})`],
    ["assets", "自建图库"],
    ...extraGalleries.map((g) => [g.id, `${g.name || g.id} (${g.count || 0})`]),
    ["dice", "画风骰子"],
  ];
  if (!tabs.some(([k]) => k === state.tab)) state.tab = "styles";

  const tabBar = el("div", { class: "tabs atlas-tabs" });
  tabs.forEach(([k, label]) => {
    tabBar.appendChild(el("button", {
      type: "button",
      class: "tab" + (state.tab === k ? " active" : ""),
      dataset: { tab: k },
      "aria-pressed": String(state.tab === k),
      onClick: () => { state.tab = k; renderAtlas(root, ctx); },
    }, label));
  });

  const searchInput = el("input", {
    class: "input",
    type: "search",
    value: state.q,
    placeholder: "搜索编号（FA-013）、名称、作者或特征…",
    style: { width: "260px" },
  });
  let timer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = searchInput.value; drawContent(); }, 180);
  });

  const extMarketBtn = el("button", {
    type: "button",
    class: "btn btn-sm atlas-market-btn",
    title: "浏览、安装或管理扩展图库插件（支持官方市场、自定义市场源与 JSON/ZIP 链接直装）",
    onClick: () => openExternalPacksModal(
      () => renderAtlas(root, ctx),
      (packId) => {
        state.tab = packId;
        renderAtlas(root, ctx);
      }
    ),
  }, "🧩 扩展图库");

  const quickCreateHeadBtn = state.tab === "styles"
    ? el("button", {
        type: "button",
        class: "btn btn-primary btn-sm atlas-create-btn",
        onClick: () => openEditStyleDialog({}, () => { state.group = MINE; renderAtlas(root, ctx); }),
      }, "＋ 新建画风")
    : (state.tab === "layouts"
      ? el("button", {
          type: "button",
          class: "btn btn-primary btn-sm atlas-create-btn",
          onClick: () => openEditLayoutDialog({}, () => { state.groups.layouts = "mine"; renderAtlas(root, ctx); }),
        }, "＋ 新建图型")
      : null);

  root.appendChild(el("div", { class: "page-head atlas-head" },
    el("h1", { class: "page-title" }, "风格画廊"),
    el("div", { class: "row atlas-toolbar" }, tabBar, searchInput, quickCreateHeadBtn, extMarketBtn)
  ));

  const stage = el("div");
  root.appendChild(stage);

  async function drawContent() {
    clear(stage);
    try {
      if (state.tab === "styles") await drawStyles(stage, summary.groups || [], ctx);
      else if (state.tab === "layouts") await drawLayouts(stage, ctx);
      else if (state.tab === "colors") await drawColors(stage, ctx);
      else if (state.tab === "tones") await drawTones(stage, ctx);
      else if (state.tab === "assets") await drawAssets(stage, ctx);
      else if (extraById.has(state.tab)) await drawExtensionGallery(stage, extraById.get(state.tab), ctx);
      else if (state.tab === "dice") await drawDice(stage, ctx);
    } catch (e) {
      clear(stage);
      stage.appendChild(el("div", { class: "card col", style: { gap: "8px", marginTop: "8px" } },
        el("strong", null, "该分类暂时无法加载"),
        el("span", { class: "muted" }, e?.message || String(e)),
        el("div", { class: "row" },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => drawContent() }, "重试")
        )
      ));
    }
  }

  await drawContent();
  if (params.openStyle) openStyleDetail(params.openStyle, ctx, () => renderAtlas(root, ctx));
}

async function drawStyles(stage, groups, ctx) {
  const mineOnly = state.group === MINE;
  const [res, mineRes, styleRanking] = await Promise.all([
    mineOnly ? Promise.resolve({ items: [] })
      : api("GET", `/api/resources/styles?q=${encodeURIComponent(state.q)}&group=${encodeURIComponent(state.group)}`),
    api("GET", "/api/mine/styles").catch(() => ({ items: [] })),
    mineOnly ? Promise.resolve(null) : loadResourceRanking("style").catch(() => null),
  ]);
  const query = state.q.trim().toLowerCase();
  const mineAll = mineRes.items || [];
  const mine = mineAll.filter((m) => !query || JSON.stringify(m).toLowerCase().includes(query));
  const minePublishedCodes = new Set(
    mineAll.map((m) => String(m?.published?.code || "").toUpperCase()).filter(Boolean)
  );
  const officialRaw = (res.items || []).filter((x) => {
    if (x.source === "mine") return false;
    // Avoid showing duplicate cards in "全部流派" when user's own style is also published to community (#162).
    if (state.group === "" && minePublishedCodes.has(String(x.number || "").toUpperCase())) return false;
    return true;
  });
  const official = styleRanking?.order?.length ? rankResourceItems(officialRaw, styleRanking) : officialRaw;
  // My styles lead "全部流派" and own the "我的画风" group.
  const items = [...(state.group === "" || mineOnly ? mine.map((m) => ({ ...m, _mine: true })) : []), ...official];

  const groupBtn = (key, label, count, extra = "") => el("button", {
    type: "button",
    class: "group-btn" + extra + (state.group === key ? " active" : ""),
    "aria-pressed": String(state.group === key),
    onClick: () => { state.group = key; drawStylesWrap(); },
  }, el("span", null, label), el("span", { class: "muted" }, String(count)));
  const groupNav = el("div", { class: "atlas-groups" },
    groupBtn("", "全部流派", groups.filter((g) => g.code !== "MY" && g.code !== "EXCLUSIVE").reduce((total, g) => total + g.count, 0) + mineAll.length),
    groupBtn(MINE, "我的画风", mineAll.length, " group-mine")
  );
  groups.filter((g) => g.code !== "MY").forEach((g) => {
    groupNav.appendChild(groupBtn(g.code, categoryName(g.zh || g.en), g.count));
  });

  function drawStylesWrap() {
    clear(stage);
    drawStyles(stage, groups, ctx);
  }

  const grid = masonry();
  const sentinel = el("div", { style: { height: "20px" } });
  let offset = 0;
  const batchSize = 36;

  const appendBatch = () => {
    const slice = items.slice(offset, offset + batchSize);
    offset += slice.length;
    slice.forEach((s) => {
      if (s._mine) {
        grid.appendChild(mineStyleCard(s, ctx, drawStylesWrap));
        return;
      }
      const isProtected = Boolean(s.promptHidden || s.siteModelOnly || s.source === "community" || s.source === "exclusive");
      const isLocked = isProtected && !s.unlocked && !s.isMine;
      const cost = Math.max(1, Number(s.unlockCost || 1));
      const badgeEl = isProtected
        ? (isLocked
            ? el("span", { class: "badge badge-warn" }, `🔒 ${cost} 积分`)
            : el("span", { class: "badge badge-ok" }, s.isMine ? "我的共享" : "✓ 已解锁 · 网站模型"))
        : (s.source && s.source !== "official" ? el("span", { class: "badge badge-accent" }, s.source === "mine" ? "我的" : "已解锁") : null);
      const card = el("div", { class: "style-card" },
        el("img", {
          class: "style-thumb",
          src: packImg(s.image),
          alt: s.generation_name,
          loading: "lazy",
          onClick: () => openStyleDetail(s.number, ctx, drawStylesWrap),
        }),
        el("div", { class: "style-body", onClick: () => openStyleDetail(s.number, ctx, drawStylesWrap) },
          el("div", { class: "row", style: { justifyContent: "space-between", gap: "6px" } },
            el("span", { class: "style-code" }, s.number),
            badgeEl
          ),
          el("div", { class: "style-name" }, s.nameZh || s.generation_name),
          isProtected
            ? el("div", { class: "style-traits muted" }, s.source === "exclusive"
                ? "官网限定 · 🔒 提示词已隐藏 · 仅限网站模型生图"
                : `${s.authorName ? `by ${s.authorName} · ` : ""}🔒 提示词已隐藏 · 仅限网站模型生图`)
            : el("div", { class: "style-traits" }, s.traits || s.reference)
        ),
        el("div", { class: "style-actions" },
          isLocked
            ? el("button", {
                type: "button",
                class: "btn btn-sm btn-primary",
                onClick: async (e) => {
                  e.stopPropagation();
                  const btn = e.currentTarget;
                  btn.disabled = true;
                  btn.textContent = "解锁中…";
                  try {
                    await api("POST", `/api/resources/community/${encodeURIComponent(s.number)}/unlock`, {});
                    toast(`已解锁 ${s.nameZh || s.number}，可直接使用网站模型生图`);
                    drawStylesWrap();
                  } catch (err) {
                    toast(err.message || "解锁失败");
                    btn.disabled = false;
                    btn.textContent = `🔓 解锁 (${cost}积分)`;
                  }
                },
              }, `🔓 解锁 (${cost}积分)`)
            : el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { style: s.number }) }, isProtected ? "☁ 网站模型创作" : "用于创作")
        )
      );
      grid.appendChild(card);
    });
    if (offset >= items.length) sentinel.remove();
  };

  appendBatch();
  if (offset < items.length) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) appendBatch();
    }, { rootMargin: "300px" });
    io.observe(sentinel);
  }

  const toolbar = mineToolbar([], drawStylesWrap, mineOnly ? "自建的画风只描述视觉语言；登录后会同步到你的网站账号，满意后可以发布到社区。" : "");
  const emptyMine = el("div", { class: "card mine-empty" },
    el("strong", null, "还没有自己的画风"),
    el("span", { class: "muted" }, "上传 1–5 张参考图，自动提取纯视觉特征；或者在任意画风详情里「另存为我的画风」再微调。"),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn btn-primary btn-sm", onClick: () => openEditStyleDialog({}, drawStylesWrap) }, "从参考图建画风")
    )
  );
  const right = el("div", null,
    toolbar,
    items.length === 0 ? (mineOnly && !query ? emptyMine : el("div", { class: "card muted" }, "没有找到匹配的画风")) : grid,
    sentinel
  );
  stage.appendChild(el("div", { class: "atlas-wrap" }, groupNav, right));
}

async function openStyleDetail(id, ctx, onRefresh) {
  try {
    const res = await api("GET", `/api/resources/styles/${encodeURIComponent(id)}`);
    const st = res.style;
    const simRes = await api("GET", `/api/resources/styles/${encodeURIComponent(id)}/similar?n=12`).catch(() => ({ items: [] }));
    let showGrid = false;
    const imgEl = el("img", { src: packImg(st.image), style: { width: "100%", maxHeight: "340px", objectFit: "contain", borderRadius: "10px", background: "var(--surface-2)" } });

    const simGrid = el("div", { class: "row", style: { marginTop: "8px" } });
    (simRes.items || []).forEach((sim) => {
      simGrid.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => { closeModal(); openStyleDetail(sim.number, ctx, onRefresh); },
      }, `${sim.number} ${sim.nameZh || sim.generation_name}`));
    });

    const isProtected = Boolean(st.promptHidden || st.siteModelOnly || st.source === "community" || st.source === "exclusive");
    const isLocked = isProtected && !st.unlocked && !st.isMine;
    const cost = Math.max(1, Number(st.unlockCost || 1));

    const body = el("div", { class: "col" },
      imgEl,
      !isProtected && st.grid ? el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => { showGrid = !showGrid; imgEl.src = packImg(showGrid ? st.grid : st.image); },
      }, "切换四宫格参考图 / 单张示例图") : null,
      el("div", { class: "row" },
        el("span", { class: "badge badge-accent" }, st.number),
        el("span", { class: "badge" }, st.group || st.groupZh),
        st.authorName ? el("span", { class: "badge" }, "作者：" + st.authorName) : null,
        isProtected ? el("span", { class: "badge badge-warn" }, isLocked ? `🔒 ${cost} 积分解锁` : "☁ 仅限网站模型生图") : null,
        !isProtected && st.reference ? el("span", { class: "badge" }, "参考：" + st.reference) : null,
        !isProtected && res.decision?.activation ? el("span", { class: "badge" }, "激活：" + res.decision.activation) : null
      ),
      isProtected
        ? el("div", { class: "card", style: { padding: "12px", background: "var(--surface-2)", borderStyle: "dashed" } },
            el("strong", { style: { fontSize: "13px" } }, st.source === "exclusive" ? "🔒 官网限定画风 · 提示词云端黑盒保护" : "🔒 特征描述词已加密隐藏"),
            el("p", { class: "muted", style: { margin: "6px 0 0", fontSize: "12.5px", lineHeight: 1.6 } },
              st.description || (st.source === "exclusive"
                ? "官网限定收费画风受云端黑盒保护，不会在任何位置展示明文特征词；解锁后仅支持在客户端选择「网站生图模型」由云端自动注入出图。"
                : "网友分享的收费画风受提示词保护，不会在任何位置展示明文特征词；解锁后仅支持在客户端选择「网站生图模型」由云端自动注入出图。")
            )
          )
        : el("p", { style: { margin: "4px 0" } }, st.traits),
      !isProtected && st.traitsEn ? el("p", { class: "muted", style: { margin: 0 } }, st.traitsEn) : null,
      !isProtected && (simRes.items || []).length ? el("strong", { style: { marginTop: "8px" } }, "相近画风（12 个）") : null,
      !isProtected && (simRes.items || []).length ? simGrid : null
    );

    const footerBtns = [];
    if (!isProtected) {
      footerBtns.push(el("button", {
        type: "button",
        class: "btn",
        onClick: () => { closeModal(); state.group = MINE; openEditStyleDialog({ name: (st.nameZh || st.generation_name) + " · 变体", traits: st.traits, traitsEn: st.traitsEn || st.traits }, onRefresh); },
      }, "另存为我的画风"));
    }
    if (isLocked) {
      footerBtns.push(el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = "解锁中…";
          try {
            await api("POST", `/api/resources/community/${encodeURIComponent(st.number)}/unlock`, {});
            toast(`已解锁 ${st.nameZh || st.number}，现在可用网站模型生图`);
            closeModal();
            if (onRefresh) onRefresh();
            openStyleDetail(st.number, ctx, onRefresh);
          } catch (err) {
            toast(err.message || "解锁失败");
            btn.disabled = false;
            btn.textContent = `🔓 立即解锁（${cost} 积分）`;
          }
        },
      }, `🔓 立即解锁（${cost} 积分）`));
    } else {
      footerBtns.push(el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: () => { closeModal(); ctx.go("create", { style: st.number }); },
      }, isProtected ? "☁ 用网站模型去生图" : "去生图"));
    }

    showModal(`${st.number} · ${st.nameZh || st.generation_name}`, body, footerBtns);
  } catch (err) {
    toast(err.message);
  }
}

async function drawLayouts(stage, ctx) {
  const reload = () => { clear(stage); drawLayouts(stage, ctx); };
  const [res, mineRes, layoutRanking] = await Promise.all([
    api("GET", "/api/resources/layouts"),
    api("GET", "/api/mine/layouts").catch(() => ({ items: [] })),
    loadResourceRanking("layout").catch(() => null),
  ]);
  const mine = (mineRes.items || []).map((l) => ({ ...l, category: "mine", _mine: true }));
  const minePubCodes = new Set(mine.map((m) => String(m?.published?.code || "").toUpperCase()).filter(Boolean));
  const othersRaw = (res.items || []).filter((l) => l.source !== "mine" && !minePubCodes.has(String(l.id || "").toUpperCase()));
  const others = layoutRanking?.order?.length ? rankResourceItems(othersRaw, layoutRanking) : othersRaw;
  const items = [...mine, ...others];
  drawCatalog(stage, {
    kind: "layouts", title: "图型", allLabel: "全部图型", items,
    groups: [{ key: "mine", label: "我的图型" }],
    groupKey: (l) => l.category, groupLabel: (l) => (l.category === "mine" ? "我的图型" : layoutNames[l.category] || l.category),
    before: mineToolbar([], reload, ""),
    empty: (group) => group === "mine" ? el("div", { class: "card mine-empty" },
      el("strong", null, "还没有自己的图型"),
      el("span", { class: "muted" }, "描述区域划分、标题区、配图区和留白，就能在创作时像官方图型一样使用。"),
      el("div", { class: "row" }, el("button", { type: "button", class: "btn btn-primary btn-sm", onClick: () => openEditLayoutDialog({}, reload) }, "新建图型"))
    ) : "",
    card: (l) => {
      if (l._mine) return mineLayoutCard(l, ctx, reload);
      const isProtected = Boolean(l.promptHidden || l.siteModelOnly || l.source === "community" || l.source === "exclusive");
      const isLocked = isProtected && !l.unlocked && !l.isMine;
      const cost = Math.max(1, Number(l.unlockCost || 1));
      return el("div", { class: "style-card" },
        el("img", { class: "style-thumb", src: packImg(l.image), alt: l.name, loading: "lazy" }),
        el("div", { class: "style-body" },
          el("div", { class: "row", style: { justifyContent: "space-between", gap: "6px" } },
            el("div", { class: "style-code" }, `${l.id} · ${layoutNames[l.category] || l.category}`),
            isProtected
              ? el("span", { class: "badge " + (isLocked ? "badge-warn" : "badge-ok") }, isLocked ? `🔒 ${cost} 积分` : "✓ 网站模型")
              : null
          ),
          el("div", { class: "style-name" }, l.name),
          isProtected
            ? el("div", { class: "style-traits muted" }, `${l.authorName ? `by ${l.authorName} · ` : ""}🔒 提示词已隐藏 · 仅限网站模型生图`)
            : el("div", { class: "style-traits" }, l.prompt_zh || (l.keywords || []).join(" · "))
        ),
        el("div", { class: "style-actions" },
          isLocked
            ? el("button", {
                type: "button",
                class: "btn btn-sm btn-primary",
                onClick: async (e) => {
                  const btn = e.currentTarget;
                  btn.disabled = true;
                  btn.textContent = "解锁中…";
                  try {
                    await api("POST", `/api/resources/community/${encodeURIComponent(l.id)}/unlock`, {});
                    toast(`已解锁 ${l.name}，可使用网站模型生图`);
                    reload();
                  } catch (err) {
                    toast(err.message || "解锁失败");
                    btn.disabled = false;
                    btn.textContent = `🔓 解锁 (${cost}积分)`;
                  }
                },
              }, `🔓 解锁 (${cost}积分)`)
            : el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { layout: l.id }) }, isProtected ? "☁ 网站模型创作" : "用于创作")
        )
      );
    },
  });
}

async function drawColors(stage, ctx) {
  const res = await api("GET", "/api/resources/colors");
  drawCatalog(stage, {
    kind: "colors", title: "主题色", allLabel: "全部主题色", items: res.items || [],
    groupKey: (c) => c.category, groupLabel: (c) => c.category_zh || c.category,
    card: (c) => el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: packImg(c.image), alt: c.name_zh, loading: "lazy" }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, `${c.id} · ${c.category_zh}`),
        el("div", { class: "style-name" }, `${c.name_zh} / ${c.name_en}`),
        el("div", { class: "style-traits" }, c.quote_zh)
      ),
      el("div", { class: "style-actions" },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { color: c.id }) }, "选用配色")
      )
    ),
  });
}

async function drawTones(stage, ctx) {
  const res = await api("GET", "/api/resources/tones");
  drawCatalog(stage, {
    kind: "tones", title: "影调", allLabel: "全部影调", items: res.items || [],
    groupKey: (t) => t.category, groupLabel: (t) => t.category_zh || t.category,
    card: (t) => el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: packImg(t.image), alt: t.name_zh, loading: "lazy" }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, `${t.id} · ${t.category_zh}`),
        el("div", { class: "style-name" }, `${t.name_zh} / ${t.name_en}`),
        el("div", { class: "style-traits" }, t.desc_zh)
      ),
      el("div", { class: "style-actions" },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { tone: t.id }) }, "选用影调")
      )
    ),
  });
}

const ASSET_SIZE_KEY = "handraw:atlas:assetSize";
const ASSET_SIZES = [
  ["sm", "紧凑"],
  ["md", "标准"],
  ["lg", "大图"],
];

function getAssetGridSize() {
  try {
    const v = localStorage.getItem(ASSET_SIZE_KEY);
    if (ASSET_SIZES.some(([k]) => k === v)) return v;
  } catch {}
  return "md";
}

function setAssetGridSize(size) {
  try { localStorage.setItem(ASSET_SIZE_KEY, size); } catch {}
}

async function drawAssets(stage, ctx) {
  const [categoriesList, packRes, mineRes] = await Promise.all([
    fetchAssetCategories(),
    api("GET", "/api/resources/assets").catch(() => ({ items: [] })),
    api("GET", "/api/mine/assets").catch(() => ({ items: [] })),
  ]);
  let categories = categoriesList;
  const mineById = new Map();
  for (const a of (mineRes.items || [])) {
    if (!a?.id) continue;
    mineById.set(a.id, { ...a, source: a.source || "local" });
  }
  const map = new Map();
  for (const a of (packRes.items || [])) {
    if (!a?.id) continue;
    if (mineById.has(a.id)) {
      map.set(a.id, mineById.get(a.id));
    } else {
      map.set(a.id, { ...a, source: a.source || "official" });
    }
  }
  for (const [id, a] of mineById.entries()) {
    if (!map.has(id)) map.set(id, a);
  }
  const items = Array.from(map.values());

  const reload = () => {
    clear(stage);
    drawAssets(stage, ctx);
  };

  let gridSize = getAssetGridSize();
  let showNewCatForm = false;
  let editingCatKey = "";

  const validKeys = new Set(categories.map((c) => c.key));
  for (const it of items) {
    if (it.kind) validKeys.add(it.kind);
  }
  if (state.groups.assets && !validKeys.has(state.groups.assets)) {
    state.groups.assets = "";
  }

  const sidebar = el("aside", { class: "atlas-groups asset-lib-sidebar", "aria-label": "自建图库分类" });
  const mainArea = el("section", { class: "asset-lib-main", "aria-label": "自建图库列表" });
  const toolbarHost = el("div", { class: "asset-lib-toolbar" });
  const grid = el("div", { class: `asset-lib-grid is-size-${gridSize}` });
  mainArea.append(toolbarHost, grid);

  const wrap = el("div", { class: "atlas-wrap asset-lib-wrap" }, sidebar, mainArea);
  stage.appendChild(wrap);

  const countForCat = (key) => {
    if (!key) return items.length;
    return items.filter((a) => (a.kind || "other") === key).length;
  };

  const openQuickCreate = (initialFiles = []) => {
    const defaultKind = state.groups.assets || "character";
    openAssetDialog({
      categories,
      defaultKind,
      initialFiles,
      onCategoriesChanged: (next) => { categories = next; },
      onSaved: reload,
    });
  };

  const renderSidebar = () => {
    clear(sidebar);
    const makeNavItem = (cat, isAll = false) => {
      const key = isAll ? "" : cat.key;
      const label = isAll ? "全部图库" : cat.label;
      const active = state.groups.assets === key;
      const count = countForCat(key);

      if (!isAll && !cat.builtin && editingCatKey === key) {
        const renameIn = el("input", {
          type: "text",
          class: "input asset-cat-inline-input",
          value: cat.label,
          maxlength: "24",
          "aria-label": `重命名分类 ${cat.label}`,
        });
        const saveRename = async () => {
          const nextLabel = renameIn.value.trim();
          if (!nextLabel) return toast("分类名称不能为空");
          try {
            const res = await saveAssetCategory({ key, label: nextLabel });
            if (Array.isArray(res?.items)) categories = res.items;
            editingCatKey = "";
            toast(`已重命名为「${nextLabel}」`);
            renderSidebar();
            renderMain();
          } catch (e) { toast(e?.message || "重命名失败"); }
        };
        renameIn.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); saveRename(); }
          else if (e.key === "Escape") { e.preventDefault(); editingCatKey = ""; renderSidebar(); }
        });
        queueMicrotask(() => { renameIn.focus(); renameIn.select(); });
        return el("div", { class: "asset-cat-edit-row" },
          renameIn,
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: saveRename }, "存"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { editingCatKey = ""; renderSidebar(); } }, "消")
        );
      }

      const mainBtn = el("button", {
        type: "button",
        class: "group-btn asset-cat-btn" + (active ? " active" : ""),
        dataset: { group: key },
        "aria-pressed": String(active),
        onClick: () => {
          state.groups.assets = key;
          renderSidebar();
          renderMain();
        },
      },
        el("span", { class: "asset-cat-name" }, label),
        el("span", { class: "muted asset-cat-count" }, String(count))
      );

      if (isAll || cat.builtin) return mainBtn;

      const actions = el("div", { class: "asset-cat-actions" },
        el("button", {
          type: "button",
          class: "asset-cat-icon-btn",
          title: `重命名分类「${cat.label}」`,
          "aria-label": `重命名分类 ${cat.label}`,
          onClick: (e) => {
            e.stopPropagation();
            editingCatKey = key;
            renderSidebar();
          },
        }, "✎"),
        el("button", {
          type: "button",
          class: "asset-cat-icon-btn is-danger",
          title: `删除分类「${cat.label}」`,
          "aria-label": `删除分类 ${cat.label}`,
          onClick: async (e) => {
            e.stopPropagation();
            const msg = count > 0
              ? `删除自定义分类「${cat.label}」？该分类下的 ${count} 张参考图将自动归入「其他」，不会删除图片。`
              : `删除自定义分类「${cat.label}」？`;
            if (!window.confirm(msg)) return;
            try {
              await deleteAssetCategory(key);
              if (state.groups.assets === key) state.groups.assets = "";
              toast(count > 0 ? `已删除分类「${cat.label}」，${count} 张图片已归入「其他」` : `已删除分类「${cat.label}」`);
              reload();
            } catch (err) { toast(err?.message || "删除分类失败"); }
          },
        }, "×")
      );
      return el("div", { class: "asset-cat-row" + (active ? " is-active" : "") }, mainBtn, actions);
    };

    sidebar.appendChild(makeNavItem(null, true));
    const builtins = categories.filter((c) => c.builtin);
    const customs = categories.filter((c) => !c.builtin);
    builtins.forEach((c) => sidebar.appendChild(makeNavItem(c)));

    if (customs.length) {
      sidebar.appendChild(el("div", { class: "asset-cat-divider" }, "自定义分类"));
      customs.forEach((c) => sidebar.appendChild(makeNavItem(c)));
    }

    if (showNewCatForm) {
      const newIn = el("input", {
        type: "text",
        class: "input asset-cat-inline-input",
        placeholder: "新分类名（如：角色IP）",
        maxlength: "24",
        "aria-label": "新建自建图库分类名称",
      });
      const submitNew = async () => {
        const label = newIn.value.trim();
        if (!label) return toast("请输入分类名称");
        try {
          const res = await saveAssetCategory({ label });
          if (Array.isArray(res?.items)) categories = res.items;
          showNewCatForm = false;
          if (res?.category?.key) state.groups.assets = res.category.key;
          toast(`已创建分类「${label}」`);
          renderSidebar();
          renderMain();
        } catch (err) { toast(err?.message || "创建分类失败"); }
      };
      newIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submitNew(); }
        else if (e.key === "Escape") { e.preventDefault(); showNewCatForm = false; renderSidebar(); }
      });
      queueMicrotask(() => newIn.focus());
      sidebar.appendChild(el("div", { class: "asset-cat-create-box" },
        newIn,
        el("div", { class: "row", style: { gap: "6px", justifyContent: "flex-end" } },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { showNewCatForm = false; renderSidebar(); } }, "取消"),
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: submitNew }, "创建")
        )
      ));
    } else {
      sidebar.appendChild(el("button", {
        type: "button",
        class: "asset-cat-add-btn",
        onClick: () => {
          showNewCatForm = true;
          renderSidebar();
        },
      }, "＋ 新建分类"));
    }
  };

  const openDetail = (asset) => {
    const catName = assetCategoryLabel(asset.kind, categories);
    const isLocal = asset.source !== "skill" && asset.source !== "official";
    const sourceLabel = asset.source === "skill" ? "Skill 图库 (~/.handraw-style)" : (asset.source === "official" ? "内置图库" : "本地自建");
    const body = el("div", { class: "asset-lightbox" },
      el("div", { class: "asset-lightbox-stage" },
        el("img", { src: asset.image ? localImg(asset.image) : "/img/logo.svg", alt: asset.name })
      ),
      el("div", { class: "asset-lightbox-meta" },
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("span", { class: "badge badge-accent" }, catName),
          el("span", { class: "badge mono" }, asset.id),
          el("span", { class: "badge" }, sourceLabel)
        ),
        el("p", { class: "muted", style: { margin: "4px 0 0", fontSize: "12.5px" } }, "作为纯参考图（垫图）带入生图或会话，保持角色、道具与场景跨图特征一致。")
      )
    );
    const footer = [
      isLocal
        ? el("button", {
            type: "button",
            class: "btn",
            onClick: () => {
              closeModal();
              openAssetDialog({
                initial: asset,
                categories,
                onCategoriesChanged: (next) => { categories = next; },
                onSaved: reload,
              });
            },
          }, "编辑")
        : null,
      isLocal
        ? el("button", {
            type: "button",
            class: "btn",
            style: { color: "var(--err, #b83227)" },
            onClick: async () => {
              if (!window.confirm(`删除参考图「${asset.name}」？`)) return;
              try {
                await api("DELETE", `/api/mine/assets/${encodeURIComponent(asset.id)}`);
                closeModal();
                toast("已删除参考图");
                reload();
              } catch (e) { toast(e?.message || "删除失败"); }
            },
          }, "删除")
        : null,
      el("button", {
        type: "button",
        class: "btn",
        onClick: () => {
          closeModal();
          ctx.go("chat", { refs: [asset.image] });
        },
      }, "去会话"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: () => {
          closeModal();
          ctx.go("create", { refs: [asset.image] });
        },
      }, "去生图"),
    ].filter(Boolean);
    showModal(asset.name || asset.id, body, footer, { className: "modal-asset-detail" });
  };

  const renderMain = () => {
    const query = state.q.trim().toLowerCase();
    const activeCat = state.groups.assets;
    const activeTitle = activeCat ? assetCategoryLabel(activeCat, categories) : "全部自建图库";
    const visible = items.filter((a) => {
      const k = a.kind || "other";
      if (activeCat && k !== activeCat) return false;
      if (!query) return true;
      const hay = `${a.id || ""} ${a.name || ""} ${a.nameEn || ""} ${assetCategoryLabel(k, categories)} ${(a.tags || []).join(" ")}`.toLowerCase();
      return hay.includes(query);
    });

    clear(toolbarHost);
    const sizeSwitch = el("div", { class: "asset-size-switch", role: "group", "aria-label": "图库卡片尺寸" },
      ...ASSET_SIZES.map(([sz, lbl]) => el("button", {
        type: "button",
        class: "asset-size-btn" + (gridSize === sz ? " is-active" : ""),
        "aria-pressed": String(gridSize === sz),
        onClick: () => {
          gridSize = sz;
          setAssetGridSize(sz);
          grid.className = `asset-lib-grid is-size-${gridSize}`;
          sizeSwitch.querySelectorAll(".asset-size-btn").forEach((b, idx) => {
            const on = ASSET_SIZES[idx][0] === sz;
            b.classList.toggle("is-active", on);
            b.setAttribute("aria-pressed", String(on));
          });
        },
      }, lbl))
    );

    toolbarHost.append(
      el("div", { class: "asset-lib-heading" },
        el("div", { class: "row", style: { gap: "8px", alignItems: "baseline", flexWrap: "wrap" } },
          el("h2", { class: "asset-lib-title" }, activeTitle),
          el("span", { class: "badge" }, `${visible.length} 张`)
        ),
        el("span", { class: "muted asset-lib-hint" }, "支持拖拽图片至此或按 Ctrl/⌘ + V 快速入库，自动同步读取 ~/.handraw-style 图库")
      ),
      el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        sizeSwitch,
        el("button", {
          type: "button",
          class: "btn btn-primary btn-sm",
          onClick: () => openQuickCreate(),
        }, "＋ 上传 / 粘贴图片")
      )
    );

    clear(grid);
    grid.className = `asset-lib-grid is-size-${gridSize}`;

    if (!visible.length) {
      grid.appendChild(el("div", { class: "asset-lib-empty" },
        el("div", { class: "asset-lib-empty-ico", "aria-hidden": "true" }, "🖼️"),
        el("strong", null, query ? "没有找到匹配的参考图" : `「${activeTitle}」还没有参考图`),
        el("p", { class: "muted" }, query
          ? "可以换个关键词搜索，或切换左侧其他分类查看。"
          : "把常用角色、道具、场景或品牌元素存进自建图库，在「生图」和「会话」中点击 + 即可随时垫图复用。"),
        !query
          ? el("div", { class: "row", style: { gap: "8px", justifyContent: "center", flexWrap: "wrap" } },
              el("button", {
                type: "button",
                class: "btn btn-primary btn-sm",
                onClick: () => openQuickCreate(),
              }, "＋ 选择本地图片上传"),
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: async () => {
                  try {
                    const res = await readClipboardImagesViaApi();
                    if (res.supported && res.files.length) {
                      openQuickCreate(res.files);
                      return;
                    }
                  } catch {}
                  toast("请直接按 Ctrl/⌘ + V 粘贴剪贴板图片");
                },
              }, "📋 粘贴剪贴板图片")
            )
          : null
      ));
      return;
    }

    visible.forEach((a) => {
      const catLabel = assetCategoryLabel(a.kind, categories);
      const isLocal = a.source !== "skill" && a.source !== "official";
      const srcBadge = a.source === "skill"
        ? el("span", { class: "asset-card-src-badge" }, "Skill")
        : (a.source === "official" ? el("span", { class: "asset-card-src-badge" }, "内置") : null);

      const media = el("button", {
        type: "button",
        class: "asset-card-media",
        "aria-label": `预览参考图 ${a.name || a.id}`,
        onClick: () => openDetail(a),
      },
        el("img", {
          src: a.image ? localImg(a.image) : "/img/logo.svg",
          alt: a.name || a.id || "参考图",
          loading: "lazy",
        }),
        el("span", { class: "asset-card-cat-badge" }, catLabel),
        srcBadge
      );

      const actions = el("div", { class: "asset-card-actions" },
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => ctx.go("create", { refs: [a.image] }),
        }, "去生图"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => ctx.go("chat", { refs: [a.image] }),
        }, "去会话"),
        isLocal
          ? el("button", {
              type: "button",
              class: "btn btn-sm asset-card-icon-act",
              title: `编辑 ${a.name}`,
              "aria-label": `编辑 ${a.name}`,
              onClick: () => openAssetDialog({
                initial: a,
                categories,
                onCategoriesChanged: (next) => { categories = next; },
                onSaved: reload,
              }),
            }, "编辑")
          : null,
        isLocal
          ? el("button", {
              type: "button",
              class: "btn btn-sm asset-card-icon-act is-danger",
              title: `删除 ${a.name}`,
              "aria-label": `删除 ${a.name}`,
              onClick: async () => {
                if (!window.confirm(`删除参考图「${a.name}」？`)) return;
                try {
                  await api("DELETE", `/api/mine/assets/${encodeURIComponent(a.id)}`);
                  toast("已删除参考图");
                  reload();
                } catch (e) { toast(e?.message || "删除失败"); }
              },
            }, "删除")
          : null
      );

      grid.appendChild(el("article", { class: "asset-card", dataset: { assetId: a.id || "" } },
        media,
        el("div", { class: "asset-card-body" },
          el("div", { class: "asset-card-name", title: a.name }, a.name || "未命名参考图"),
          el("div", { class: "asset-card-code mono" }, a.id)
        ),
        actions
      ));
    });
  };

  // Page-level drag-and-drop and Ctrl/⌘ + V paste directly into Self-Built Asset Library.
  mainArea.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      mainArea.classList.add("is-dragover");
    }
  });
  mainArea.addEventListener("dragleave", (e) => {
    if (!mainArea.contains(e.relatedTarget)) mainArea.classList.remove("is-dragover");
  });
  mainArea.addEventListener("drop", (e) => {
    mainArea.classList.remove("is-dragover");
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      openQuickCreate(files);
    }
  });
  bindPageImagePaste(mainArea, (files) => {
    openQuickCreate(files);
  });

  renderSidebar();
  renderMain();
}

function openAssetDialog({ initial = null, categories = [], defaultKind = "character", initialFiles = [], onCategoriesChanged, onSaved } = {}) {
  const isEdit = Boolean(initial?.id);
  let cats = categories.length ? [...categories] : [
    { key: "character", label: "角色", builtin: true },
    { key: "prop", label: "道具", builtin: true },
    { key: "scene", label: "场景", builtin: true },
    { key: "other", label: "其他", builtin: true },
  ];
  let chosenKind = initial?.kind || defaultKind || "character";
  if (!cats.some((c) => c.key === chosenKind)) chosenKind = "other";

  let queuedFiles = []; // [{ file, previewUrl, name }]
  let showInlineNewCat = false;
  let isSaving = false;

  const nameIn = el("input", {
    class: "input",
    value: initial?.name || "",
    placeholder: isEdit ? "资产名称" : "名称（选填，多图时作为统一前缀，留空默认用文件名）",
  });
  const fileIn = el("input", { type: "file", accept: "image/*", multiple: !isEdit, class: "hidden" });

  const previewHost = el("div", { class: "asset-modal-previews" });
  const catHost = el("div", { class: "col", style: { gap: "6px" } });

  const addFiles = (files) => {
    const imgs = Array.from(files || []).filter((f) => {
      const t = String(f?.type || "").toLowerCase();
      return t.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f?.name || "");
    });
    if (!imgs.length) return;
    if (isEdit) {
      queuedFiles.forEach((q) => URL.revokeObjectURL(q.previewUrl));
      queuedFiles = [{ file: imgs[0], previewUrl: URL.createObjectURL(imgs[0]), name: imgs[0].name }];
    } else {
      imgs.forEach((f) => {
        queuedFiles.push({ file: f, previewUrl: URL.createObjectURL(f), name: f.name });
      });
    }
    renderPreviews();
  };

  fileIn.addEventListener("change", () => {
    addFiles(fileIn.files);
    fileIn.value = "";
  });

  const renderPreviews = () => {
    clear(previewHost);
    if (queuedFiles.length) {
      const strip = el("div", { class: "asset-modal-preview-grid" });
      queuedFiles.forEach((q, idx) => {
        strip.appendChild(el("div", { class: "asset-modal-preview-item" },
          el("img", { src: q.previewUrl, alt: q.name || `预览 ${idx + 1}` }),
          el("button", {
            type: "button",
            class: "asset-modal-preview-del",
            "aria-label": `移除待上传图片 ${idx + 1}`,
            onClick: () => {
              URL.revokeObjectURL(q.previewUrl);
              queuedFiles.splice(idx, 1);
              renderPreviews();
            },
          }, "×")
        ));
      });
      previewHost.appendChild(strip);
      previewHost.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } },
        isEdit ? "已选择新图片，保存后将替换原参考图" : `已待上传 ${queuedFiles.length} 张图片，可继续添加或按 Ctrl/⌘ + V 粘贴`));
    } else if (isEdit && initial?.image) {
      previewHost.appendChild(el("div", { class: "asset-modal-preview-grid" },
        el("div", { class: "asset-modal-preview-item" },
          el("img", { src: localImg(initial.image), alt: initial.name || "当前参考图" })
        )
      ));
      previewHost.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } }, "保留当前参考图，也可点击上方按钮或粘贴新图替换"));
    }
  };

  const renderCats = () => {
    clear(catHost);
    const groupName = `atlas-asset-cat-${Date.now()}`;
    const pillsRow = el("div", { class: "ref-picker-cat-pills" });
    cats.forEach((c) => {
      const radio = el("input", {
        type: "radio",
        name: groupName,
        value: c.key,
        checked: chosenKind === c.key,
        class: "sr-only",
      });
      const pill = el("label", {
        class: "btn btn-sm ref-picker-cat-pill" + (chosenKind === c.key ? " btn-primary is-active" : ""),
      }, radio, el("span", null, c.label));
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        chosenKind = c.key;
        renderCats();
      });
      pillsRow.appendChild(pill);
    });
    pillsRow.appendChild(el("button", {
      type: "button",
      class: "btn btn-sm ref-picker-add-cat-btn",
      onClick: () => {
        showInlineNewCat = !showInlineNewCat;
        renderCats();
      },
    }, "＋ 新建分类"));

    catHost.appendChild(el("fieldset", { class: "ref-picker-cat-fieldset" },
      el("legend", null, "归入分类"),
      pillsRow
    ));

    if (showInlineNewCat) {
      const catIn = el("input", {
        type: "text",
        class: "input",
        placeholder: "新分类名（如：角色IP、电商主图）",
        maxlength: "24",
        style: { width: "220px", padding: "5px 10px", fontSize: "12.5px" },
      });
      const doCreate = async () => {
        const label = catIn.value.trim();
        if (!label) return toast("请输入分类名称");
        try {
          const res = await saveAssetCategory({ label });
          if (Array.isArray(res?.items)) {
            cats = res.items;
            onCategoriesChanged?.(cats);
          }
          if (res?.category?.key) chosenKind = res.category.key;
          showInlineNewCat = false;
          toast(`已创建分类「${label}」`);
          renderCats();
        } catch (e) { toast(e?.message || "创建分类失败"); }
      };
      catIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); doCreate(); }
        else if (e.key === "Escape") { e.preventDefault(); showInlineNewCat = false; renderCats(); }
      });
      queueMicrotask(() => catIn.focus());
      catHost.appendChild(el("div", { class: "ref-picker-new-cat-bar" },
        el("span", { class: "ref-picker-field-label" }, "新建分类："),
        catIn,
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: doCreate }, "创建"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => { showInlineNewCat = false; renderCats(); } }, "取消")
      ));
    }
  };

  const dropzone = el("div", { class: "ref-picker-dropzone asset-modal-dropzone" },
    el("div", { class: "ref-picker-dropzone-title" }, isEdit ? "点击更换图片、拖拽或 Ctrl/⌘ + V 粘贴替换" : "选择本地图片（可多选）、拖拽至此，或按 Ctrl/⌘ + V 粘贴"),
    el("div", { class: "row", style: { gap: "8px", justifyContent: "center", flexWrap: "wrap" } },
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => fileIn.click() }, isEdit ? "更换图片" : "＋ 选择本地图片"),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => {
          try {
            const res = await readClipboardImagesViaApi();
            if (res.supported && res.files.length) {
              addFiles(res.files);
              return;
            }
          } catch {}
          toast("请直接按 Ctrl/⌘ + V 粘贴剪贴板图片");
        },
      }, "📋 读取剪贴板图片")
    ),
    previewHost
  );
  dropzone.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    }
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover"));
  dropzone.addEventListener("drop", (e) => {
    dropzone.classList.remove("is-dragover");
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    }
  });

  const saveBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    onClick: async () => {
      if (isSaving) return;
      if (isEdit) {
        const finalName = nameIn.value.trim();
        if (!finalName) return toast("名称不能为空");
        isSaving = true;
        saveBtn.disabled = true;
        saveBtn.textContent = "保存中…";
        try {
          const payload = { id: initial.id, kind: chosenKind, name: finalName };
          if (queuedFiles.length) {
            payload.dataUrl = await fileToDataUrl(queuedFiles[0].file);
          }
          await api("POST", "/api/mine/assets", payload);
          closeModal();
          toast("已更新参考图资产");
          onSaved?.();
        } catch (e) {
          isSaving = false;
          saveBtn.disabled = false;
          saveBtn.textContent = "保存修改";
          toast(e?.message || "保存失败");
        }
        return;
      }

      if (!queuedFiles.length) {
        return toast("请先选择、拖入或粘贴至少一张参考图片");
      }
      isSaving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = `正在保存 (${queuedFiles.length})…`;
      try {
        const customPrefix = nameIn.value.trim();
        for (let i = 0; i < queuedFiles.length; i++) {
          const f = queuedFiles[i].file;
          const dataUrl = await fileToDataUrl(f);
          const name = fileDisplayName(f, customPrefix, i, queuedFiles.length);
          await api("POST", "/api/mine/assets", { kind: chosenKind, name, dataUrl });
        }
        closeModal();
        toast(queuedFiles.length > 1 ? `已添加 ${queuedFiles.length} 张参考图到自建图库` : "已添加到自建图库");
        onSaved?.();
      } catch (e) {
        isSaving = false;
        saveBtn.disabled = false;
        saveBtn.textContent = "保存到自建图库";
        toast(e?.message || "保存失败");
      }
    },
  }, isEdit ? "保存修改" : "保存到自建图库");

  const body = el("div", { class: "col", style: { gap: "12px" } },
    fileIn,
    catHost,
    el("div", { class: "field" }, el("label", null, "名称"), nameIn),
    dropzone
  );

  const onModalPaste = (e) => {
    const files = extractClipboardImageFiles(e);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  };

  showModal(isEdit ? `编辑参考图 · ${initial.id}` : "添加参考图到自建图库", body, [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
    saveBtn,
  ], {
    className: "modal-provider",
    onClose: () => {
      document.removeEventListener("paste", onModalPaste);
      queuedFiles.forEach((q) => URL.revokeObjectURL(q.previewUrl));
      queuedFiles = [];
    },
  });
  document.addEventListener("paste", onModalPaste);

  if (initialFiles?.length) addFiles(initialFiles);
  renderCats();
  renderPreviews();
}

const MINE = "__mine";

// Toolbar shown above the style/layout grid: create + sync with the website.
function mineToolbar(actions, reload, hint) {
  return el("div", { class: "mine-toolbar" },
    el("div", { class: "row" }, ...actions,
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const r = await api("POST", "/api/mine/sync", {});
            toast(`已与网站同步：上传 ${r.pushed || 0}，拉取 ${r.pulled || 0}${(r.conflicts || []).length ? "（有冲突，请检查）" : ""}`);
            reload();
          } catch (err) { toast(err.message); btn.disabled = false; }
        },
      }, "☁ 与网站同步")
    ),
    hint ? el("span", { class: "muted" }, hint) : null
  );
}

async function deleteMine(kindPath, item, name, reload) {
  const published = item.published && item.published.code;
  const msg = published
    ? `删除「${name}」？只会删除本机和你账号里的私有副本，已发布到社区的版本需要在网站上下架。`
    : `删除「${name}」？删除后会同步删除你网站账号里的私有副本。`;
  if (!window.confirm(msg)) return;
  try {
    await api("DELETE", `/api/mine/${kindPath}/${encodeURIComponent(item.docId)}`);
    toast("已删除");
    reload();
  } catch (e) { toast(e.message); }
}

function mineStyleCard(s, ctx, reload) {
  const name = s.nameZh || s.generation_name;
  const edit = () => openEditStyleDialog(s, reload);
  return el("div", { class: "style-card style-card-mine" },
    el("img", { class: "style-thumb", src: s.image ? localImg(s.image) : "/img/logo.svg", alt: name, loading: "lazy", onClick: edit }),
    el("div", { class: "style-body", onClick: edit },
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("span", { class: "style-code" }, s.number),
        el("span", { class: "row", style: { gap: "4px" } }, el("span", { class: "badge badge-accent" }, "我的"), publishBadge(s))
      ),
      el("div", { class: "style-name" }, name),
      el("div", { class: "style-traits" }, s.traits)
    ),
    el("div", { class: "style-actions" },
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { style: s.number }) }, "用于创作"),
      el("button", { type: "button", class: "btn btn-sm", onClick: edit }, "编辑"),
      publishButton("styles", s, name, reload),
      el("button", { type: "button", class: "btn btn-sm btn-ghost-danger", title: "删除", "aria-label": `删除${name}`, onClick: () => deleteMine("styles", s, name, reload) }, "删除")
    )
  );
}

function mineLayoutCard(l, ctx, reload) {
  const edit = () => openEditLayoutDialog(l, reload);
  return el("div", { class: "style-card style-card-mine" },
    l.image
      ? el("img", { class: "style-thumb", src: localImg(l.image), alt: l.name, loading: "lazy", onClick: edit })
      : el("div", { class: "style-thumb style-thumb-empty", onClick: edit, title: "点击添加图型封面与排版约束" }, "📐"),
    el("div", { class: "style-body", onClick: edit },
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("span", { class: "style-code" }, l.id),
        el("span", { class: "row", style: { gap: "4px" } }, el("span", { class: "badge badge-accent" }, "我的"), publishBadge(l))
      ),
      el("div", { class: "style-name" }, l.name),
      el("div", { class: "style-traits" }, l.prompt_zh)
    ),
    el("div", { class: "style-actions" },
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { layout: l.id }) }, "用于创作"),
      el("button", { type: "button", class: "btn btn-sm", onClick: edit }, "编辑"),
      publishButton("layouts", l, l.name, reload),
      el("button", { type: "button", class: "btn btn-sm btn-ghost-danger", title: "删除", "aria-label": `删除${l.name}`, onClick: () => deleteMine("layouts", l, l.name, reload) }, "删除")
    )
  );
}

function publishBadge(item) {
  const p = item.published;
  if (p && p.status === "approved") return el("span", { class: "badge badge-ok" }, "已公开");
  if (p && p.status === "pending") return el("span", { class: "badge badge-warn" }, "评审中");
  if (p && p.status === "changes_requested") return el("span", { class: "badge badge-warn" }, "需修改");
  return el("span", { class: "badge" }, item.dirty ? "待同步" : (item.remoteId ? "已同步" : "仅本地"));
}

function publishButton(kindPath, item, name, reload) {
  const p = item.published;
  if (p && p.code) {
    return el("button", { type: "button", class: "btn btn-sm", onClick: async () => {
      const { siteBase } = await api("GET", "/api/account").catch(() => ({}));
      const url = (siteBase || "https://handraw-style.com").replace(/\/+$/, "") + (p.url || "");
      toast(await copyText(url) ? "社区链接已复制" : url);
    } }, "复制链接");
  }
  return el("button", { type: "button", class: "btn btn-sm", onClick: () => openPublishResourceDialog(kindPath, item, name, reload) }, "发布到社区");
}

// openPublishResourceDialog: 1-click paid-only share aligned with Web (#162).
// Minimum 1 point, presets + custom 1..500, prompt permanently hidden on server.
async function openPublishResourceDialog(kindPath, item, name, reload) {
  const label = kindPath === "styles" ? "画风" : "图型";
  const presets = [1, 5, 10, 20, 50, 100];
  let selectedPrice = 10;
  const hasExistingCover = Boolean(item.image || item.remoteImageUrl || (Array.isArray(item.images) && item.images.length > 0));
  let chosenCoverPath = "";

  const priceInput = el("input", {
    type: "number",
    class: "input",
    min: "1",
    max: "500",
    step: "1",
    value: String(selectedPrice),
    style: { width: "110px", textAlign: "center", fontWeight: "700" },
  });
  const presetWrap = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
  const priceHint = el("span", { class: "muted", style: { fontSize: "12px" } }, "");
  const syncPrice = () => {
    presetWrap.querySelectorAll("button").forEach((b) => {
      const on = Number(b.dataset.price) === selectedPrice;
      b.className = "btn btn-sm" + (on ? " btn-primary" : "");
    });
    priceHint.textContent = `定价 ${selectedPrice} 积分：特征提示词永久加密隐藏，发布后即时上架社区，他人解锁后仅能通过网站模型调用，你将自动获得积分分成。`;
  };
  presets.forEach((p) => {
    presetWrap.appendChild(el("button", {
      type: "button",
      class: "btn btn-sm",
      dataset: { price: String(p) },
      onClick: () => {
        selectedPrice = p;
        priceInput.value = String(p);
        syncPrice();
      },
    }, `${p} 积分`));
  });
  priceInput.addEventListener("input", () => {
    const val = Number(String(priceInput.value || "").trim());
    if (Number.isInteger(val) && val >= 1 && val <= 500) {
      selectedPrice = val;
      syncPrice();
    }
  });
  syncPrice();

  const descIn = el("input", {
    type: "text",
    class: "input",
    maxlength: 200,
    placeholder: `选填公开简介（请勿填写提示词；留空将自动生成安全简介）`,
  });

  // Only ask user to pick a cover from works if the resource has no cover yet.
  let coverPickerSection = null;
  if (!hasExistingCover) {
    const res = await api("GET", "/api/works?limit=30").catch(() => ({ items: [] }));
    const grid = el("div", { class: "publish-pick" });
    const pool = [];
    for (const r of res.items || []) {
      for (const im of r.images || []) {
        if (im.status === "done" && im.path) pool.push(im);
      }
    }
    if (!pool.length) {
      grid.appendChild(el("div", { class: "muted" }, `当前${label}尚无封面图，请先在编辑弹窗上传一张封面图后再发布。`));
    } else {
      pool.slice(0, 24).forEach((im) => {
        const node = el("button", {
          type: "button",
          class: "pick",
          dataset: { path: im.path },
          onClick: () => {
            chosenCoverPath = im.path;
            grid.querySelectorAll(".pick").forEach((n) => n.classList.toggle("on", n.dataset.path === chosenCoverPath));
          },
        }, el("img", { src: localImg(im.thumb || im.path), alt: "", loading: "lazy" }));
        grid.appendChild(node);
      });
    }
    coverPickerSection = el("div", { class: "field" }, el("label", null, "补选 1 张封面图（当前尚无封面）"), grid);
  }

  const body = el("div", { class: "col", style: { gap: "10px" } },
    el("strong", null, `分享「${name}」到社区赚积分`),
    el("span", { class: "muted", style: { fontSize: "12.5px" } }, "🔒 画风与图型最低 1 积分，核心提示词永久加密隐藏，仅允许通过网站生图模型调用。"),
    el("div", { class: "field" },
      el("label", null, "设定解锁积分（预设或自定义 1–500 整数）"),
      presetWrap,
      el("div", { class: "row", style: { gap: "8px", alignItems: "center", marginTop: "4px" } },
        el("span", { class: "muted", style: { fontSize: "12.5px" } }, "自定义积分："),
        priceInput,
        el("span", { class: "muted", style: { fontSize: "12px" } }, "积分（1–500）")
      ),
      priceHint
    ),
    el("div", { class: "field" }, el("label", null, "公开展示简介（选填）"), descIn),
    coverPickerSection
  );
  const submit = el("button", { type: "button", class: "btn btn-primary", onClick: async () => {
    const rawVal = Number(String(priceInput.value || "").trim());
    if (!Number.isInteger(rawVal) || rawVal < 1 || rawVal > 500) {
      return toast("画风与图型不允许免费分享，请输入 1–500 之间的整数积分");
    }
    const desc = descIn.value.trim();
    if (desc && (desc.length < 8 || desc.length > 300)) {
      return toast("若填写公开简介，需要 8 到 300 字（也可留空自动生成）");
    }
    if (!hasExistingCover && !chosenCoverPath) {
      return toast("当前资源尚无封面图，请先补选 1 张封面图");
    }
    submit.disabled = true;
    try {
      const reqBody = { price: rawVal };
      if (desc) reqBody.description = desc;
      if (!hasExistingCover && chosenCoverPath) {
        submit.textContent = "正在压缩封面…";
        const cover = await toWebp(localImg(chosenCoverPath), { maxEdge: 1024, square: true });
        if (!cover) throw new Error("封面压缩失败，请重试");
        reqBody.cover = cover;
      }
      submit.textContent = "正在发布…";
      const r = await api("POST", `/api/mine/${kindPath}/${encodeURIComponent(item.docId)}/publish`, reqBody);
      closeModal();
      const pub = r.published || {};
      const url = (r.siteBase || "").replace(/\/+$/, "") + (pub.url || "");
      toast(`已发布上线（${rawVal} 积分，编号 ${pub.code || ""}），链接已复制`);
      if (url) await copyText(url);
      reload();
    } catch (e) {
      toast(e.message || "发布失败");
      submit.disabled = false;
      submit.textContent = "一键发布上线";
    }
  } }, "一键发布上线");
  showModal(`分享${label}赚积分`, body, [el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"), submit]);
}

export function openEditStyleDialog(initial = {}, onSaved) {
  return openStyleEditorModal(initial, onSaved);
}

export function openEditLayoutDialog(initial = {}, onSaved) {
  return openLayoutEditorModal(initial, onSaved);
}

async function drawDice(stage, ctx) {
  const roll = async () => {
    const q = new URLSearchParams();
    if (state.dice.lockStyle && state.dice.style) q.set("style", state.dice.style.number);
    if (state.dice.lockLayout && state.dice.layout) q.set("layout", state.dice.layout.id);
    if (state.dice.lockColor && state.dice.color) q.set("color", state.dice.color.id);
    const res = await api("GET", "/api/resources/random?" + q.toString());
    state.dice.style = res.style || null;
    state.dice.layout = res.layout || null;
    state.dice.color = res.color || null;
    clear(stage);
    drawDice(stage, ctx);
  };

  if (!state.dice.style) {
    await roll();
    return;
  }

  const d = state.dice;
  const lockBtn = (label, on, fn) => el("button", { type: "button", class: "btn btn-sm" + (on ? " btn-primary" : ""), onClick: fn }, on ? `🔒 已锁定 ${label}` : `锁定 ${label}`);

  stage.appendChild(el("div", { class: "row", style: { marginBottom: "14px" } },
    el("button", { type: "button", class: "btn btn-primary", onClick: roll }, "🎲 再抽一次"),
    el("button", {
      type: "button",
      class: "btn",
      onClick: () => ctx.go("create", {
        style: d.style?.number || "",
        layout: d.layout?.id || "",
        color: d.color?.id || "",
      }),
    }, "带入生图工作台 →")
  ));

  stage.appendChild(masonry({},
    d.style ? el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: packImg(d.style.image) }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, "画风 · " + d.style.number),
        el("div", { class: "style-name" }, d.style.nameZh || d.style.generation_name)
      ),
      el("div", { class: "style-actions" }, lockBtn("画风", d.lockStyle, () => { d.lockStyle = !d.lockStyle; clear(stage); drawDice(stage, ctx); }))
    ) : null,
    d.layout ? el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: packImg(d.layout.image) }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, "图型 · " + d.layout.id),
        el("div", { class: "style-name" }, d.layout.name)
      ),
      el("div", { class: "style-actions" }, lockBtn("图型", d.lockLayout, () => { d.lockLayout = !d.lockLayout; clear(stage); drawDice(stage, ctx); }))
    ) : el("div", { class: "card muted" }, "本轮纯图（无图型）"),
    d.color ? el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: packImg(d.color.image) }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, "主题色 · " + d.color.id),
        el("div", { class: "style-name" }, d.color.name_zh)
      ),
      el("div", { class: "style-actions" }, lockBtn("主题色", d.lockColor, () => { d.lockColor = !d.lockColor; clear(stage); drawDice(stage, ctx); }))
    ) : null
  ));
}

function gallerySourceBadge(source, localOnly = false) {
  if (localOnly || source === "third-party") return el("span", { class: "badge", title: "第三方开源图库，仅保存在本机，不会同步或上传至网站" }, "🔒 仅本机");
  if (!source || source === "official") return null;
  if (source.startsWith("plugin:")) return el("span", { class: "badge badge-accent" }, "插件");
  if (source === "user" || source === "personal") return el("span", { class: "badge" }, "本地");
  return el("span", { class: "badge" }, source);
}

function formatCacheSize(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "0 KB";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export async function openExternalPacksModal(onChanged, onOpenPack) {
  let packs = [];
  let sources = [];
  let categories = [];
  let mirror = "gitee";
  let activeCat = ""; // "" | "__installed__" | categoryId
  let panelMode = ""; // "" | "add-source" | "direct-url"
  let busyId = "";

  const host = el("div", { class: "col", style: { gap: "12px" } },
    el("p", { class: "muted", style: { margin: 0 } }, "正在加载扩展图库市场…")
  );

  const applyCatalog = (res) => {
    packs = Array.isArray(res?.packs) ? res.packs : [];
    sources = Array.isArray(res?.sources) ? res.sources : [];
    categories = Array.isArray(res?.categories) ? res.categories : [];
    if (res?.defaultMirror && !mirror) mirror = res.defaultMirror;
  };

  const loadMarket = async (refresh = false) => {
    const qs = new URLSearchParams();
    if (mirror) qs.set("mirror", mirror);
    if (refresh) qs.set("refresh", "1");
    const res = await api("GET", `/api/galleries/market?${qs.toString()}`);
    applyCatalog(res);
  };

  const sourceTypeLabel = (t) => {
    if (t === "zip") return "离线 ZIP 包";
    if (t === "ruic-poseatlas") return "开源图鉴";
    return "标准 JSON 清单";
  };

  const mirrorTag = (m) => {
    if (m === "gitee") return "Gitee";
    if (m === "github") return "GitHub";
    return "";
  };

  const renderModalBody = () => {
    clear(host);

    // 1. Subscribed Market Sources & Quick Actions Bar
    const srcChips = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", alignItems: "center" } });
    sources.forEach((s) => {
      const mTag = mirrorTag(s.activeMirror);
      const chip = el("span", {
        class: "badge" + (s.official ? " badge-accent" : ""),
        title: s.error
          ? `${s.url}\n加载失败：${s.error}${s.fallback ? "（已使用内置回退索引）" : ""}`
          : (s.activeUrl || s.url),
        style: { display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 9px" },
      },
        s.name || s.id,
        s.fallback
          ? "（离线索引）"
          : (s.error ? "（连接失败）" : `${mTag ? " · " + mTag : ""} · ${s.count || 0}`),
        !s.official
          ? el("button", {
              type: "button",
              class: "gal-chip-x",
              "aria-label": `移除市场源 ${s.name || s.id}`,
              disabled: Boolean(busyId),
              onClick: async () => {
                busyId = "__src__";
                renderModalBody();
                try {
                  const res = await api("DELETE", `/api/galleries/market/sources/${encodeURIComponent(s.id)}`);
                  applyCatalog(res);
                  toast(`已移除图库源「${s.name || s.id}」`);
                } catch (e) {
                  toast(e?.message || "移除失败");
                } finally {
                  busyId = "";
                  renderModalBody();
                }
              },
            }, "×")
          : null
      );
      srcChips.appendChild(chip);
    });

    const topSourceCard = el("div", { class: "card col", style: { padding: "11px 13px", gap: "8px", background: "var(--paper)" } },
      el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
        el("div", { class: "row", style: { gap: "8px", alignItems: "center", flexWrap: "wrap" } },
          el("strong", { style: { fontSize: "13px" } }, "图库插件市场源"),
          el("a", {
            href: "https://gitee.com/yang02010/handraw-galleries",
            class: "muted",
            style: { fontSize: "11.5px" },
            onClick: (e) => { e.preventDefault(); openURL("https://gitee.com/yang02010/handraw-galleries"); },
          }, "Gitee 国内镜像 ↗"),
          el("a", {
            href: "https://github.com/yang0/handraw-galleries",
            class: "muted",
            style: { fontSize: "11.5px" },
            onClick: (e) => { e.preventDefault(); openURL("https://github.com/yang0/handraw-galleries"); },
          }, "GitHub 原仓 ↗"),
          el("a", {
            href: "https://github.com/yang0/handraw-galleries/blob/main/CONTRIBUTING.md",
            class: "muted",
            style: { fontSize: "11.5px" },
            onClick: (e) => { e.preventDefault(); openURL("https://github.com/yang0/handraw-galleries/blob/main/CONTRIBUTING.md"); },
          }, "提交图库 PR ↗")
        ),
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", {
            type: "button",
            class: "btn btn-sm",
            disabled: Boolean(busyId),
            onClick: async () => {
              busyId = "__refresh__";
              renderModalBody();
              try {
                await loadMarket(true);
                toast("已刷新图库市场索引");
              } catch (e) {
                toast(e?.message || "刷新失败");
              } finally {
                busyId = "";
                renderModalBody();
              }
            },
          }, busyId === "__refresh__" ? "刷新中…" : "刷新市场"),
          el("button", {
            type: "button",
            class: "btn btn-sm" + (panelMode === "add-source" ? " btn-primary" : ""),
            disabled: Boolean(busyId),
            onClick: () => { panelMode = panelMode === "add-source" ? "" : "add-source"; renderModalBody(); },
          }, "+ 添加图库源"),
          el("button", {
            type: "button",
            class: "btn btn-sm" + (panelMode === "direct-url" ? " btn-primary" : ""),
            disabled: Boolean(busyId),
            onClick: () => { panelMode = panelMode === "direct-url" ? "" : "direct-url"; renderModalBody(); },
          }, "🔗 链接直装")
        )
      ),
      srcChips,
      el("div", { class: "muted", style: { fontSize: "11.5px" } }, "🔒 全部扩展图库由用户按需选装，索引与图片仅缓存在本机，不会同步或上传至网站。")
    );

    // 2. Optional Drawer: Add Market Source OR Direct URL Install
    let drawer = null;
    if (panelMode === "add-source") {
      const urlIn = el("input", { class: "input", type: "url", placeholder: "输入图库市场 index.json 链接（https://.../index.json）" });
      const nameIn = el("input", { class: "input", type: "text", placeholder: "市场名称（可选，留空自动读取索引标题）", style: { maxWidth: "220px" } });
      drawer = el("div", { class: "card col", style: { padding: "11px 13px", gap: "8px", borderColor: "var(--accent)" } },
        el("strong", { style: { fontSize: "12.5px" } }, "订阅第三方图库市场源（Format 1 index.json）"),
        el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
          el("div", { style: { flex: "1", minWidth: "240px" } }, urlIn),
          nameIn,
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            disabled: Boolean(busyId),
            onClick: async () => {
              const u = urlIn.value.trim();
              if (!u) { toast("请先输入 index.json 地址"); return; }
              busyId = "__add_src__";
              renderModalBody();
              try {
                const res = await api("POST", "/api/galleries/market/sources", { url: u, name: nameIn.value.trim() });
                applyCatalog(res);
                panelMode = "";
                toast("已订阅新的图库市场源");
              } catch (e) {
                toast(e?.message || "添加失败");
              } finally {
                busyId = "";
                renderModalBody();
              }
            },
          }, busyId === "__add_src__" ? "校验中…" : "确认订阅")
        )
      );
    } else if (panelMode === "direct-url") {
      const urlIn = el("input", { class: "input", type: "url", placeholder: "输入单个图库插件的 .json 或 .zip 链接（https://...）" });
      const idIn = el("input", { class: "input mono", type: "text", placeholder: "自定义 ID（可选）", style: { maxWidth: "170px" } });
      drawer = el("div", { class: "card col", style: { padding: "11px 13px", gap: "8px", borderColor: "var(--accent)" } },
        el("strong", { style: { fontSize: "12.5px" } }, "从链接直接安装图库插件（支持声明式 JSON 或离线 ZIP 包）"),
        el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
          el("div", { style: { flex: "1", minWidth: "240px" } }, urlIn),
          idIn,
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            disabled: Boolean(busyId),
            onClick: async () => {
              const u = urlIn.value.trim();
              if (!u) { toast("请先输入图库 JSON 或 ZIP 地址"); return; }
              busyId = "__direct__";
              renderModalBody();
              try {
                const res = await api("POST", "/api/galleries/market/install", { url: u, id: idIn.value.trim(), mirror });
                applyCatalog(res);
                panelMode = "";
                const added = (res.installed || [])[0];
                toast(`已安装扩展图库「${added?.name || added?.id || "新图库"}」`);
                onChanged?.();
              } catch (e) {
                toast(e?.message || "安装失败");
              } finally {
                busyId = "";
                renderModalBody();
              }
            },
          }, busyId === "__direct__" ? "安装中…" : "立即安装")
        )
      );
    }

    // 3. Category Filter Pills + Mirror Switcher
    const installedCount = packs.filter((p) => p.installed).length;
    const catBar = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", alignItems: "center" } },
      el("button", {
        type: "button",
        class: "pill-btn" + (activeCat === "" ? " pill-accent" : ""),
        onClick: () => { activeCat = ""; renderModalBody(); },
      }, `全部 (${packs.length})`),
      el("button", {
        type: "button",
        class: "pill-btn" + (activeCat === "__installed__" ? " pill-accent" : ""),
        onClick: () => { activeCat = "__installed__"; renderModalBody(); },
      }, `已安装 (${installedCount})`),
      ...categories.map((c) => el("button", {
        type: "button",
        class: "pill-btn" + (activeCat === c.id ? " pill-accent" : ""),
        onClick: () => { activeCat = c.id; renderModalBody(); },
      }, `${c.name} (${c.count})`))
    );

    const switchMirror = async (nextMirror) => {
      if (mirror === nextMirror || busyId) return;
      mirror = nextMirror;
      busyId = "__mirror__";
      renderModalBody();
      try {
        await loadMarket(false);
      } catch (e) {
        toast(e?.message || "切换镜像失败");
      } finally {
        busyId = "";
        renderModalBody();
      }
    };

    const mirrorBar = el("div", { class: "row ext-mirror-bar", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } },
      catBar,
      el("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap" } },
        el("span", { class: "muted", style: { fontSize: "12px" } }, "镜像："),
        el("button", {
          type: "button",
          class: "pill-btn" + (mirror === "gitee" ? " pill-accent" : ""),
          disabled: Boolean(busyId),
          onClick: () => switchMirror("gitee"),
        }, "Gitee 国内"),
        el("button", {
          type: "button",
          class: "pill-btn" + (mirror === "github" ? " pill-accent" : ""),
          disabled: Boolean(busyId),
          onClick: () => switchMirror("github"),
        }, "GitHub 原仓")
      )
    );

    // 4. Filtered Gallery Plugin Cards
    const visiblePacks = packs.filter((p) => {
      if (activeCat === "__installed__") return Boolean(p.installed);
      if (activeCat) return Array.isArray(p.categories) && p.categories.includes(activeCat);
      return true;
    });

    const list = el("div", { class: "col", style: { gap: "10px" } });
    if (!visiblePacks.length) {
      list.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "24px 12px" } },
        activeCat === "__installed__"
          ? "当前还没有安装任何扩展图库。切换回「全部」即可按需一键安装开源图鉴或社区图库插件。"
          : "该分类下暂无扩展图库插件。"
      ));
    }

    visiblePacks.forEach((p) => {
      const isBusy = busyId === p.id;
      const metaParts = [];
      if (p.author) metaParts.push(`作者：${p.author}`);
      if (p.license) metaParts.push(p.license);
      if (p.marketName) metaParts.push(`来源：${p.marketName}`);
      const statsText = p.installed
        ? `已安装${p.installedVersion ? " v" + p.installedVersion : ""} · ${p.itemCount || 0} 条 · 本地缓存 ${p.cachedFiles || 0} 张 (${formatCacheSize(p.cachedBytes)})`
        : "未安装（按需选装）";

      const actions = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", flexShrink: "0" } });
      if (p.installed) {
        actions.append(
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            disabled: Boolean(busyId),
            onClick: () => {
              closeModal();
              onOpenPack?.(p.id);
            },
          }, "去浏览"),
          !p.customInstall
            ? el("button", {
                type: "button",
                class: "btn btn-sm" + (p.hasUpdate ? " pill-accent" : ""),
                disabled: Boolean(busyId),
                onClick: async () => {
                  busyId = p.id;
                  renderModalBody();
                  try {
                    const res = await api("POST", "/api/galleries/market/install", { id: p.id, mirror });
                    applyCatalog(res);
                    toast(`已更新「${p.name}」图库索引`);
                    onChanged?.();
                  } catch (e) {
                    toast(e?.message || "更新失败");
                  } finally {
                    busyId = "";
                    renderModalBody();
                  }
                },
              }, isBusy ? "更新中…" : (p.hasUpdate ? `更新至 v${p.version}` : "更新 / 切源"))
            : null,
          el("button", {
            type: "button",
            class: "btn btn-sm btn-danger",
            disabled: Boolean(busyId),
            onClick: async () => {
              if (!window.confirm(`卸载「${p.name}」并清理本地图片缓存（${formatCacheSize(p.cachedBytes)}）？`)) return;
              busyId = p.id;
              renderModalBody();
              try {
                const res = await api("POST", `/api/galleries/market/${encodeURIComponent(p.id)}/uninstall`, { purgeCache: true });
                applyCatalog(res);
                toast(`已卸载「${p.name}」并清理缓存`);
                onChanged?.();
              } catch (e) {
                toast(e?.message || "卸载失败");
              } finally {
                busyId = "";
                renderModalBody();
              }
            },
          }, "卸载")
        );
      } else {
        actions.append(
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            disabled: Boolean(busyId),
            onClick: async () => {
              busyId = p.id;
              renderModalBody();
              try {
                const res = await api("POST", "/api/galleries/market/install", { id: p.id, mirror });
                applyCatalog(res);
                toast(`已安装「${p.name}」，可立即在画廊与生图参考图中使用`);
                onChanged?.();
              } catch (e) {
                toast(e?.message || "安装失败");
              } finally {
                busyId = "";
                renderModalBody();
              }
            },
          }, isBusy ? "正在安装…" : "一键安装")
        );
      }

      list.appendChild(el("div", { class: "card ext-pack-card" },
        el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start", gap: "10px", flexWrap: "wrap" } },
          el("div", { class: "col", style: { gap: "4px", flex: "1", minWidth: "240px" } },
            el("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap" } },
              el("strong", { style: { fontSize: "14.5px" } }, p.name),
              p.version ? el("span", { class: "badge mono" }, `v${p.version}`) : null,
              p.badge ? el("span", { class: "badge badge-accent" }, p.badge) : null,
              el("span", { class: "badge" }, sourceTypeLabel(p.sourceType)),
              p.multiVariant ? el("span", { class: "badge" }, "多视角") : null,
              p.installed ? el("span", { class: "badge badge-ok" }, "已安装") : null
            ),
            p.description ? el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px", lineHeight: "1.5" } }, p.description) : null,
            el("div", { class: "row muted", style: { gap: "10px", fontSize: "11.5px", flexWrap: "wrap" } },
              el("span", null, statsText),
              metaParts.length ? el("span", null, metaParts.join(" · ")) : null,
              p.upstreamUrl
                ? el("a", {
                    href: p.upstreamUrl,
                    onClick: (e) => { e.preventDefault(); openURL(p.upstreamUrl); },
                  }, "项目主页 ↗")
                : null
            )
          ),
          actions
        )
      ));
    });

    host.append(topSourceCard);
    if (drawer) host.append(drawer);
    host.append(mirrorBar, list);
  };

  showModal("扩展图库市场（按需选装 · 仅本机）", host, [
    el("button", {
      type: "button",
      class: "btn",
      onClick: () => {
        closeModal();
        if (typeof window.__handrawGo === "function") window.__handrawGo("plugins", { tab: "galleries" });
        else location.hash = "#plugins";
      },
    }, "在扩展中心管理 ↗"),
    el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
  ], { className: "modal-ext-packs" });

  try {
    await loadMarket(false);
    renderModalBody();
  } catch (e) {
    clear(host);
    host.appendChild(el("p", { class: "muted" }, `加载扩展图库市场失败：${e?.message || e}`));
  }
}

function pickItemVariant(item, preferredKey) {
  const vars = Array.isArray(item?.variants) ? item.variants : [];
  if (!vars.length) return null;
  if (preferredKey) {
    const hit = vars.find((v) => v.key === preferredKey);
    if (hit) return hit;
  }
  return vars[0];
}

async function drawExtensionGallery(stage, meta, ctx) {
  const res = await api("GET", `/api/galleries/${encodeURIComponent(meta.id)}/items`).catch(() => ({ items: [] }));
  const allItems = res.items || [];
  if (state.groups[meta.id] === undefined) state.groups[meta.id] = "";
  const seriesStateKey = `${meta.id}__series`;
  const angleStateKey = `${meta.id}__angle`;
  if (state.groups[seriesStateKey] === undefined) state.groups[seriesStateKey] = "";
  if (state.groups[angleStateKey] === undefined) state.groups[angleStateKey] = "front";

  const isMultiVariant = Boolean(meta.multiVariant || allItems.some((it) => Array.isArray(it.variants) && it.variants.length > 1));

  // Collect series list (e.g. 性感全身 / 标准全身 / 上半身 / 双人 for RuiC Poses)
  const seriesMap = new Map();
  allItems.forEach((it) => {
    const sk = it.meta?.series;
    if (!sk) return;
    if (!seriesMap.has(sk)) {
      seriesMap.set(sk, { key: sk, label: it.meta?.seriesShort || it.meta?.seriesName || sk, count: 0 });
    }
    seriesMap.get(sk).count++;
  });

  // Collect canonical angle options for multi-variant galleries
  const angleOptions = [];
  if (isMultiVariant) {
    const seenAngle = new Set();
    for (const it of allItems) {
      for (const v of (it.variants || [])) {
        if (!v?.key || seenAngle.has(v.key)) continue;
        seenAngle.add(v.key);
        angleOptions.push({ key: v.key, label: v.label || v.key });
      }
      if (angleOptions.length >= 5) break;
    }
    if (angleOptions.length && !angleOptions.some((a) => a.key === state.groups[angleStateKey])) {
      state.groups[angleStateKey] = angleOptions[0].key;
    }
  }

  // Categories sidebar
  const catMap = new Map();
  allItems.forEach((it) => {
    const ck = it.category || "other";
    if (!catMap.has(ck)) catMap.set(ck, { key: ck, label: it.categoryName || it.category || "其他", count: 0 });
    catMap.get(ck).count++;
  });
  if (state.groups[meta.id] && !catMap.has(state.groups[meta.id])) state.groups[meta.id] = "";

  const nav = el("div", { class: "atlas-groups", role: "group", "aria-label": `${meta.name || meta.id}分类` });
  const right = el("div");
  const filterStrip = el("div", { class: "col", style: { gap: "8px", marginBottom: "10px" } });
  const grid = masonry();
  const sentinel = el("div", { style: { height: "24px" } });
  let io = null;

  const headerNote = el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "8px" } },
    el("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap" } },
      meta.description ? el("span", { class: "muted", style: { fontSize: "12.5px" } }, meta.description) : null,
      gallerySourceBadge(meta.source, meta.localOnly)
    ),
    meta.localOnly
      ? el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => openExternalPacksModal(() => drawExtensionGallery(stage, meta, ctx)),
        }, "管理扩展图库")
      : null
  );

  right.append(headerNote, filterStrip, grid, sentinel);
  if (catMap.size > 1) stage.appendChild(el("div", { class: "atlas-wrap" }, nav, right));
  else stage.appendChild(right);

  const rebuildNav = () => {
    clear(nav);
    const activeSeries = state.groups[seriesStateKey];
    const seriesItems = activeSeries ? allItems.filter((x) => (x.meta?.series || "") === activeSeries) : allItems;
    const localCats = new Map();
    seriesItems.forEach((it) => {
      const ck = it.category || "other";
      if (!localCats.has(ck)) localCats.set(ck, { key: ck, label: it.categoryName || it.category || "其他", count: 0 });
      localCats.get(ck).count++;
    });
    if (state.groups[meta.id] && !localCats.has(state.groups[meta.id])) state.groups[meta.id] = "";

    [{ key: "", label: `全部${meta.name || meta.id}`, count: seriesItems.length }, ...localCats.values()].forEach((g) => {
      const active = state.groups[meta.id] === g.key;
      nav.appendChild(el("button", {
        type: "button",
        class: "group-btn" + (active ? " active" : ""),
        "aria-pressed": String(active),
        onClick: () => { state.groups[meta.id] = g.key; rebuildNav(); paint(); },
      }, el("span", null, categoryName(g.label)), el("span", { class: "muted" }, String(g.count))));
    });
  };

  const rebuildFilters = () => {
    clear(filterStrip);
    if (seriesMap.size > 1) {
      const sRow = el("div", { class: "row pose-angle-bar", role: "group", "aria-label": "系列筛选" },
        el("span", { class: "muted", style: { fontSize: "12px", marginRight: "2px" } }, "系列："),
        ...[{ key: "", label: "全部", count: allItems.length }, ...seriesMap.values()].map((s) =>
          el("button", {
            type: "button",
            class: "pill-btn" + (state.groups[seriesStateKey] === s.key ? " pill-accent" : ""),
            onClick: () => {
              state.groups[seriesStateKey] = s.key;
              rebuildFilters();
              rebuildNav();
              paint();
            },
          }, `${s.label} (${s.count})`)
        )
      );
      filterStrip.appendChild(sRow);
    }
    if (isMultiVariant && angleOptions.length > 1) {
      const aRow = el("div", { class: "row pose-angle-bar", role: "group", "aria-label": "全局预览视角" },
        el("span", { class: "muted", style: { fontSize: "12px", marginRight: "2px" } }, "统一预览视角："),
        ...angleOptions.map((a) =>
          el("button", {
            type: "button",
            class: "pill-btn" + (state.groups[angleStateKey] === a.key ? " pill-accent" : ""),
            dataset: { globalAngle: a.key },
            onClick: () => {
              state.groups[angleStateKey] = a.key;
              rebuildFilters();
              paint();
            },
          }, a.label)
        ),
        el("span", { class: "muted", style: { fontSize: "11.5px", marginLeft: "4px" } }, "点卡片下方角度标签可单独切换，点「用于创作」将带入当前所选视角")
      );
      filterStrip.appendChild(aRow);
    }
  };

  const renderCard = (item) => {
    const displayName = item.name || item.nameEn || item.id;
    const snippet = item.traits || item.promptZh || item.promptEn || (item.tags || []).join(" · ");
    const variants = Array.isArray(item.variants) ? item.variants : [];
    let activeVar = pickItemVariant(item, state.groups[angleStateKey]);

    const currentThumbUrl = () => {
      if (activeVar) return galleryImg(activeVar.thumbUrl || activeVar.imageUrl || "");
      return item.thumbUrl || item.imageUrl ? galleryImg(item.thumbUrl || item.imageUrl) : "/img/logo.svg";
    };

    const imgEl = el("img", {
      class: "style-thumb",
      src: currentThumbUrl(),
      alt: displayName,
      loading: "lazy",
      decoding: "async",
      onClick: () => openExtensionItemDetail(meta, item, ctx, activeVar?.key || ""),
    });
    const angleBadgeEl = activeVar
      ? el("span", { class: "pose-card-angle-badge" }, `${variants.length}视角 · ${activeVar.label}`)
      : null;

    const thumbWrap = el("div", { class: "pose-card-thumb-wrap" }, imgEl, angleBadgeEl);

    let angleChipsBar = null;
    if (variants.length > 1) {
      angleChipsBar = el("div", { class: "pose-card-angles", role: "group", "aria-label": `${displayName} 视角切换` });
      variants.forEach((v) => {
        const chip = el("button", {
          type: "button",
          class: "pose-angle-chip" + (activeVar && activeVar.key === v.key ? " is-active" : ""),
          dataset: { angleKey: v.key },
          onClick: (e) => {
            e.stopPropagation();
            activeVar = v;
            imgEl.src = currentThumbUrl();
            if (angleBadgeEl) angleBadgeEl.textContent = `${variants.length}视角 · ${v.label}`;
            angleChipsBar.querySelectorAll(".pose-angle-chip").forEach((b) => {
              b.classList.toggle("is-active", b.dataset.angleKey === v.key);
            });
            useBtn.textContent = `用「${v.label}」创作`;
          },
        }, v.label);
        angleChipsBar.appendChild(chip);
      });
    }

    const useInCreate = () => ctx.go("create", {
      galleryRef: {
        kind: meta.id,
        galleryName: meta.name || meta.id,
        id: item.id,
        variant: activeVar?.key || "",
        name: activeVar ? `${displayName} · ${activeVar.label}` : displayName,
        imageUrl: activeVar ? (activeVar.thumbUrl || activeVar.imageUrl || "") : (item.thumbUrl || item.imageUrl || ""),
      },
    });

    const useBtn = el("button", {
      type: "button",
      class: "btn btn-sm btn-primary",
      onClick: useInCreate,
    }, activeVar ? `用「${activeVar.label}」创作` : "用于创作");

    return el("div", { class: "style-card" + (variants.length > 1 ? " is-pose-card" : ""), dataset: { extItemId: item.id } },
      thumbWrap,
      angleChipsBar,
      el("div", { class: "style-body", onClick: () => openExtensionItemDetail(meta, item, ctx, activeVar?.key || "") },
        el("div", { class: "row", style: { justifyContent: "space-between" } },
          el("span", { class: "style-code" }, item.meta?.no || item.id),
          gallerySourceBadge(item.source || meta.source, meta.localOnly)
        ),
        el("div", { class: "style-name" }, displayName),
        snippet ? el("div", { class: "style-traits" }, snippet) : null
      ),
      el("div", { class: "style-actions" },
        useBtn,
        el("button", { type: "button", class: "btn btn-sm", onClick: () => openExtensionItemDetail(meta, item, ctx, activeVar?.key || "") }, variants.length > 1 ? "5视角对比" : "详情")
      )
    );
  };

  function paint() {
    if (io) { io.disconnect(); io = null; }
    clear(grid);
    const query = state.q.trim().toLowerCase();
    const selCat = state.groups[meta.id];
    const selSeries = state.groups[seriesStateKey];

    const visible = allItems.filter((item) => {
      if (selSeries && (item.meta?.series || "") !== selSeries) return false;
      if (selCat && (item.category || "other") !== selCat) return false;
      if (!query) return true;
      const hay = `${item.id || ""} ${item.name || ""} ${item.nameEn || ""} ${item.categoryName || ""} ${item.traits || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
      return hay.includes(query);
    });

    if (!visible.length) {
      sentinel.classList.add("hidden");
      grid.appendChild(el("div", { class: "card muted" }, query ? "没有找到匹配的图库条目" : `「${meta.name || meta.id}」当前分类暂时没有条目`));
      return;
    }

    let offset = 0;
    const batchSize = 48;
    sentinel.classList.remove("hidden");
    const appendBatch = () => {
      const slice = visible.slice(offset, offset + batchSize);
      offset += slice.length;
      slice.forEach((item) => grid.appendChild(renderCard(item)));
      if (offset >= visible.length) {
        sentinel.classList.add("hidden");
        if (io) { io.disconnect(); io = null; }
      }
    };
    appendBatch();
    if (offset < visible.length) {
      io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) appendBatch();
      }, { rootMargin: "360px" });
      io.observe(sentinel);
    }
  }

  rebuildFilters();
  rebuildNav();
  paint();
}

function openExtensionItemDetail(meta, item, ctx, initialVariantKey = "") {
  const displayName = item.name || item.nameEn || item.id;
  const variants = Array.isArray(item.variants) ? item.variants : [];
  let activeVar = pickItemVariant(item, initialVariantKey);
  const pickedKeys = new Set(activeVar ? [activeVar.key] : []);

  const stageImg = el("img", {
    src: activeVar
      ? galleryImg(activeVar.thumbUrl || activeVar.imageUrl || "")
      : (item.thumbUrl || item.imageUrl ? galleryImg(item.thumbUrl || item.imageUrl) : ""),
    alt: displayName,
    style: { width: "100%", height: "320px", maxHeight: "360px", objectFit: "contain", borderRadius: "10px", background: "#fff", border: "1px solid var(--line)" },
  });
  let stageLoadSeq = 0;
  const loadStageVar = (v) => {
    if (!v) return;
    const seq = ++stageLoadSeq;
    const thumb = galleryImg(v.thumbUrl || v.imageUrl || "");
    const full = galleryImg(v.imageUrl || v.thumbUrl || "");
    if (thumb) stageImg.src = thumb;
    if (full && full !== thumb) {
      const pre = new Image();
      pre.onload = () => { if (seq === stageLoadSeq) stageImg.src = full; };
      pre.src = full;
    }
  };
  if (activeVar) loadStageVar(activeVar);

  const activeAngleTitle = activeVar
    ? el("span", { class: "badge badge-accent" }, `当前视角：${activeVar.label}`)
    : null;

  let primaryCtaBtn = null;
  let multiCtaBtn = null;
  let filmstripEl = null;

  const syncModalState = () => {
    if (activeVar) {
      loadStageVar(activeVar);
      if (activeAngleTitle) activeAngleTitle.textContent = `当前视角：${activeVar.label}`;
      if (primaryCtaBtn) primaryCtaBtn.textContent = `用「${activeVar.label}」去生图`;
    }
    if (multiCtaBtn) {
      multiCtaBtn.classList.toggle("hidden", pickedKeys.size < 2);
      multiCtaBtn.textContent = `带入已勾选 ${pickedKeys.size} 个视角去生图`;
    }
    if (filmstripEl) {
      filmstripEl.querySelectorAll(".pose-film-item").forEach((card) => {
        const k = card.dataset.variantKey;
        card.classList.toggle("is-active", activeVar && activeVar.key === k);
        const chk = card.querySelector("input[type=checkbox]");
        if (chk) chk.checked = pickedKeys.has(k);
      });
    }
  };

  if (variants.length > 1) {
    filmstripEl = el("div", { class: "pose-filmstrip", role: "listbox", "aria-label": "5 视角对比切换" });
    variants.forEach((v) => {
      const chk = el("input", {
        type: "checkbox",
        checked: pickedKeys.has(v.key),
        title: `多选：同时带入 ${v.label} 视角`,
        onClick: (e) => e.stopPropagation(),
        onChange: () => {
          if (chk.checked) pickedKeys.add(v.key);
          else pickedKeys.delete(v.key);
          syncModalState();
        },
      });
      const tile = el("div", {
        class: "pose-film-item" + (activeVar && activeVar.key === v.key ? " is-active" : ""),
        dataset: { variantKey: v.key },
        onClick: () => {
          activeVar = v;
          if (pickedKeys.size <= 1) {
            pickedKeys.clear();
            pickedKeys.add(v.key);
          }
          syncModalState();
        },
      },
        el("img", { src: galleryImg(v.thumbUrl || v.imageUrl || ""), alt: v.label, loading: "lazy" }),
        el("div", { class: "pose-film-foot" },
          el("span", null, v.label),
          chk
        )
      );
      filmstripEl.appendChild(tile);
    });
  }

  const onKeyNav = (e) => {
    if (!variants.length) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const idx = variants.findIndex((v) => v.key === activeVar?.key);
    if (idx < 0) return;
    e.preventDefault();
    const nextIdx = e.key === "ArrowRight" ? (idx + 1) % variants.length : (idx - 1 + variants.length) % variants.length;
    activeVar = variants[nextIdx];
    syncModalState();
  };
  document.addEventListener("keydown", onKeyNav);

  const body = el("div", { class: "col", style: { gap: "10px" } },
    stageImg.getAttribute("src") ? stageImg : null,
    filmstripEl ? el("div", { class: "col", style: { gap: "6px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" } },
        el("strong", { style: { fontSize: "12.5px" } }, `全部 ${variants.length} 个视角（点击预览，可按 ← / → 切换，右下勾选可多角度同选）`),
        activeAngleTitle
      ),
      filmstripEl
    ) : null,
    el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
      el("span", { class: "badge badge-accent" }, item.meta?.no || item.id),
      el("span", { class: "badge" }, meta.name || meta.id),
      item.categoryName || item.category ? el("span", { class: "badge" }, item.categoryName || item.category) : null,
      gallerySourceBadge(item.source || meta.source, meta.localOnly),
      ...(item.tags || []).slice(0, 6).map((t) => el("span", { class: "badge" }, t))
    ),
    item.traits ? el("p", { style: { margin: "2px 0" } }, item.traits) : null,
    item.promptZh && item.promptZh !== item.traits ? el("p", { style: { margin: "2px 0", fontSize: "13px" } }, item.promptZh) : null,
    item.promptEn ? el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px" } }, item.promptEn) : null
  );

  multiCtaBtn = variants.length > 1
    ? el("button", {
        type: "button",
        class: "btn hidden",
        onClick: () => {
          const chosen = variants.filter((v) => pickedKeys.has(v.key));
          if (!chosen.length) return;
          closeModal();
          ctx.go("create", {
            galleryRefs: chosen.map((v) => ({
              kind: meta.id,
              galleryName: meta.name || meta.id,
              id: item.id,
              variant: v.key,
              name: `${displayName} · ${v.label}`,
              imageUrl: v.thumbUrl || v.imageUrl || "",
            })),
          });
        },
      }, "带入多视角去生图")
    : null;

  primaryCtaBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    onClick: () => {
      closeModal();
      ctx.go("create", {
        galleryRef: {
          kind: meta.id,
          galleryName: meta.name || meta.id,
          id: item.id,
          variant: activeVar?.key || "",
          name: activeVar ? `${displayName} · ${activeVar.label}` : displayName,
          imageUrl: activeVar ? (activeVar.thumbUrl || activeVar.imageUrl || "") : (item.thumbUrl || item.imageUrl || ""),
        },
      });
    },
  }, activeVar ? `用「${activeVar.label}」去生图` : "去生图");

  showModal(`${item.meta?.no || item.id} · ${displayName}`, body, [
    multiCtaBtn,
    primaryCtaBtn,
  ].filter(Boolean), {
    className: variants.length > 1 ? "modal-pose-detail" : "",
    onClose: () => document.removeEventListener("keydown", onKeyNav),
  });
}
