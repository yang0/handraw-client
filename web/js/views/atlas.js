import { api, clear, closeModal, copyText, el, galleryImg, localImg, openURL, packImg, showModal, toast, toWebp } from "../api.js";
import { buildGroupedAIModelSelect } from "./create.js";
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

const BUILTIN_GALLERY_IDS = new Set(["styles", "layouts", "colors", "tones", "assets", "characters", "props", "scenes"]);

const state = {
  tab: "styles", // styles | layouts | colors | tones | assets | <ext-gallery> | dice
  group: "",
  groups: { layouts: "", colors: "", tones: "", assets: "" },
  q: "",
  dice: { style: null, layout: null, color: null, lockStyle: false, lockLayout: false, lockColor: false },
};

const layoutNames = {
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

  root.appendChild(el("div", { class: "page-head atlas-head" },
    el("h1", { class: "page-title" }, "风格画廊"),
    el("div", { class: "row atlas-toolbar" }, tabBar, searchInput)
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
  const [res, mineRes] = await Promise.all([
    mineOnly ? Promise.resolve({ items: [] })
      : api("GET", `/api/resources/styles?q=${encodeURIComponent(state.q)}&group=${encodeURIComponent(state.group)}`),
    api("GET", "/api/mine/styles").catch(() => ({ items: [] })),
  ]);
  const query = state.q.trim().toLowerCase();
  const mineAll = mineRes.items || [];
  const mine = mineAll.filter((m) => !query || JSON.stringify(m).toLowerCase().includes(query));
  const official = (res.items || []).filter((x) => x.source !== "mine");
  // My styles lead "全部流派" and own the "我的画风" group.
  const items = [...(state.group === "" || mineOnly ? mine.map((m) => ({ ...m, _mine: true })) : []), ...official];

  const groupBtn = (key, label, count, extra = "") => el("button", {
    type: "button",
    class: "group-btn" + extra + (state.group === key ? " active" : ""),
    "aria-pressed": String(state.group === key),
    onClick: () => { state.group = key; drawStylesWrap(); },
  }, el("span", null, label), el("span", { class: "muted" }, String(count)));
  const groupNav = el("div", { class: "atlas-groups" },
    groupBtn("", "全部流派", groups.filter((g) => g.code !== "MY").reduce((total, g) => total + g.count, 0) + mineAll.length),
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
      const card = el("div", { class: "style-card" },
        el("img", {
          class: "style-thumb",
          src: packImg(s.image),
          alt: s.generation_name,
          loading: "lazy",
          onClick: () => openStyleDetail(s.number, ctx, drawStylesWrap),
        }),
        el("div", { class: "style-body", onClick: () => openStyleDetail(s.number, ctx, drawStylesWrap) },
          el("div", { class: "row", style: { justifyContent: "space-between" } },
            el("span", { class: "style-code" }, s.number),
            s.source && s.source !== "official" ? el("span", { class: "badge badge-accent" }, s.source === "mine" ? "我的" : "已解锁") : null
          ),
          el("div", { class: "style-name" }, s.nameZh || s.generation_name),
          el("div", { class: "style-traits" }, s.traits || s.reference)
        ),
        el("div", { class: "style-actions" },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { style: s.number }) }, "用于创作")
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

  const toolbar = mineToolbar([
    el("button", { type: "button", class: "btn btn-primary btn-sm", onClick: () => openEditStyleDialog({}, () => { state.group = MINE; drawStylesWrap(); }) }, "+ 新建画风"),
  ], drawStylesWrap, mineOnly ? "自建的画风只描述视觉语言；登录后会同步到你的网站账号，满意后可以发布到社区。" : "");
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

    const body = el("div", { class: "col" },
      imgEl,
      st.grid ? el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => { showGrid = !showGrid; imgEl.src = packImg(showGrid ? st.grid : st.image); },
      }, "切换四宫格参考图 / 单张示例图") : null,
      el("div", { class: "row" },
        el("span", { class: "badge badge-accent" }, st.number),
        el("span", { class: "badge" }, st.group || st.groupZh),
        st.reference ? el("span", { class: "badge" }, "参考：" + st.reference) : null,
        res.decision?.activation ? el("span", { class: "badge" }, "激活：" + res.decision.activation) : null
      ),
      el("p", { style: { margin: "4px 0" } }, st.traits),
      st.traitsEn ? el("p", { class: "muted", style: { margin: 0 } }, st.traitsEn) : null,
      el("strong", { style: { marginTop: "8px" } }, "相近画风（12 个）"),
      simGrid
    );

    showModal(`${st.number} · ${st.nameZh || st.generation_name}`, body, [
      el("button", {
        type: "button",
        class: "btn",
        onClick: () => { closeModal(); state.group = MINE; openEditStyleDialog({ name: (st.nameZh || st.generation_name) + " · 变体", traits: st.traits, traitsEn: st.traitsEn || st.traits }, onRefresh); },
      }, "另存为我的画风"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: () => { closeModal(); ctx.go("create", { style: st.number }); },
      }, "去生图"),
    ]);
  } catch (err) {
    toast(err.message);
  }
}

async function drawLayouts(stage, ctx) {
  const reload = () => { clear(stage); drawLayouts(stage, ctx); };
  const [res, mineRes] = await Promise.all([
    api("GET", "/api/resources/layouts"),
    api("GET", "/api/mine/layouts").catch(() => ({ items: [] })),
  ]);
  const mine = (mineRes.items || []).map((l) => ({ ...l, category: "mine", _mine: true }));
  const items = [...mine, ...(res.items || []).filter((l) => l.source !== "mine")];
  drawCatalog(stage, {
    kind: "layouts", title: "图型", allLabel: "全部图型", items,
    groups: [{ key: "mine", label: "我的图型" }],
    groupKey: (l) => l.category, groupLabel: (l) => (l.category === "mine" ? "我的图型" : layoutNames[l.category] || l.category),
    before: mineToolbar([
      el("button", { type: "button", class: "btn btn-primary btn-sm", onClick: () => openEditLayoutDialog({}, () => { state.groups.layouts = "mine"; reload(); }) }, "+ 新建图型"),
    ], reload, ""),
    empty: (group) => group === "mine" ? el("div", { class: "card mine-empty" },
      el("strong", null, "还没有自己的图型"),
      el("span", { class: "muted" }, "描述区域划分、标题区、配图区和留白，就能在创作时像官方图型一样使用。"),
      el("div", { class: "row" }, el("button", { type: "button", class: "btn btn-primary btn-sm", onClick: () => openEditLayoutDialog({}, reload) }, "新建图型"))
    ) : "",
    card: (l) => l._mine ? mineLayoutCard(l, ctx, reload) : el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: packImg(l.image), alt: l.name, loading: "lazy" }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, `${l.id} · ${l.category}`),
        el("div", { class: "style-name" }, l.name),
        el("div", { class: "style-traits" }, l.prompt_zh || (l.keywords || []).join(" · "))
      ),
      el("div", { class: "style-actions" },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { layout: l.id }) }, "用于创作")
      )
    ),
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
    l.image ? el("img", { class: "style-thumb", src: localImg(l.image), alt: l.name, loading: "lazy", onClick: edit }) : null,
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

// openPublishResourceDialog: pick a cover and examples from finished works,
// choose free or a point price, publish (handraw-web docs/sharing-v2.md §2.1).
async function openPublishResourceDialog(kindPath, item, name, reload) {
  const label = kindPath === "styles" ? "画风" : "图型";
  const code = item.number || item.id;
  // Images made with this resource come first; any finished image can be used.
  const res = await api("GET", "/api/works?limit=60").catch(() => ({ items: [] }));
  const pool = [];
  for (const r of res.items || []) {
    const matches = Boolean(code) && JSON.stringify(r.recipe || {}).includes(code);
    for (const im of r.images || []) {
      if (im.status === "done" && im.path) pool.push({ path: im.path, thumb: im.thumb, matches });
    }
  }
  pool.sort((a, b) => Number(b.matches) - Number(a.matches));
  const chosen = [];
  const grid = el("div", { class: "publish-pick" });
  const counter = el("span", { class: "muted" }, "");
  const refresh = () => {
    grid.querySelectorAll(".pick").forEach((node) => {
      const idx = chosen.indexOf(node.dataset.path);
      node.classList.toggle("on", idx >= 0);
      node.querySelector(".pick-n").textContent = idx === 0 ? "封面" : idx > 0 ? String(idx) : "";
    });
    counter.textContent = `已选 ${chosen.length} 张（第 1 张作封面，自动裁成正方形；至少 3 张，最多 10 张）`;
  };
  if (!pool.length) {
    grid.appendChild(el("div", { class: "muted" }, `还没有可用的作品图。先用这个${label}生成 3 张以上不同主题的图，再回来发布。`));
  }
  pool.slice(0, 60).forEach((im) => {
    const node = el("button", { type: "button", class: "pick", dataset: { path: im.path }, onClick: () => {
      const idx = chosen.indexOf(im.path);
      if (idx >= 0) chosen.splice(idx, 1);
      else if (chosen.length < 10) chosen.push(im.path);
      refresh();
    } },
      el("img", { src: localImg(im.thumb || im.path), alt: "", loading: "lazy" }),
      el("span", { class: "pick-n" }),
      im.matches ? el("span", { class: "pick-tag" }, `用了此${label}`) : null
    );
    grid.appendChild(node);
  });
  refresh();

  const descIn = el("textarea", { class: "textarea", rows: 3, maxlength: 300, placeholder: `介绍这个${label}：适合什么主题、有什么特点（8–300 字）` });
  const priceSel = el("select", { class: "input" },
    el("option", { value: "0" }, "免费公开（定义可见，别人可加入并在本地使用）")
  );
  const priceHint = el("span", { class: "muted", style: { fontSize: "12px" } }, "正在读取你的等级…");
  // Paid tiers depend on the creator level (handraw-web #376).
  api("GET", "/api/account/level").then((lv) => {
    const cap = lv && lv.available ? Number(lv.priceCap || 0) : 500;
    const tiers = [10, 30, 50, 100, 200, 500].filter((v) => v <= cap);
    tiers.forEach((v) => priceSel.appendChild(el("option", { value: String(v) }, `${v} 积分（定义保密，别人解锁后只能用网站模型生成）`)));
    priceHint.textContent = !lv || !lv.available ? ""
      : tiers.length ? `你现在是 Lv${lv.level}，收费定价最高 ${cap > 100000 ? 500 : cap} 积分。`
      : `你现在是 Lv${lv.level}，达到 Lv3 后可以发布收费画风/图型；现在可以先免费发布积累经验。`;
  }).catch(() => { priceHint.textContent = ""; });
  const note = el("span", { class: "muted", style: { fontSize: "12px" } }, "免费资源立即上架；收费资源由社区评审团审核通过后开售。积分只用于站内解锁，不能提现。");
  priceSel.addEventListener("change", () => {
    note.textContent = priceSel.value === "0"
      ? "免费资源立即上架；违规内容可被举报下架。"
      : "收费资源由社区评审团审核通过后开售。别人解锁时你获得积分（只能用于站内解锁）。";
  });
  const body = el("div", { class: "col", style: { gap: "10px" } },
    el("strong", null, `发布「${name}」到手绘风社区`),
    el("span", { class: "muted" }, "发布后所有人都能在网站看到它的名称、封面和示例图。"),
    counter, grid,
    el("div", { class: "field" }, el("label", null, "简介"), descIn),
    el("div", { class: "field" }, el("label", null, "价格"), priceSel, priceHint),
    note
  );
  const submit = el("button", { type: "button", class: "btn btn-primary", onClick: async () => {
    if (chosen.length < 3) return toast("请至少选择 3 张图（含封面）");
    if (descIn.value.trim().length < 8) return toast("简介至少 8 个字");
    submit.disabled = true;
    try {
      submit.textContent = "正在压缩图片…";
      const cover = await toWebp(localImg(chosen[0]), { maxEdge: 1024, square: true });
      const images = [];
      for (const p of chosen.slice(1)) {
        const url = await toWebp(localImg(p));
        if (url) images.push(url);
      }
      if (!cover || images.length < 2) throw new Error("当前系统无法压缩为 WebP，请更新系统 WebView 后重试");
      submit.textContent = "正在发布…";
      const r = await api("POST", `/api/mine/${kindPath}/${encodeURIComponent(item.docId)}/publish`, {
        price: Number(priceSel.value), description: descIn.value.trim(), cover, images,
      });
      closeModal();
      const pub = r.published || {};
      const url = (r.siteBase || "").replace(/\/+$/, "") + (pub.url || "");
      if (pub.status === "approved") {
        toast("已公开到社区，链接已复制");
        await copyText(url);
        openURL(url);
      } else {
        toast("已提交社区评审，通过后自动开售");
      }
      reload();
    } catch (e) {
      const byCode = { level_too_low: "你的等级还不能发布收费资源，请选择免费发布", price_above_level_cap: "这个价格超过了你当前等级的上限，请选低一档" };
      toast(byCode[e.code] || e.message);
      submit.disabled = false;
      submit.textContent = "确认发布";
    }
  } }, "确认发布");
  showModal(`发布${label}`, body, [el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"), submit]);
}

export function openEditStyleDialog(initial = {}, onSaved) {
  const nameIn = el("input", { class: "input", value: initial.name || initial.nameZh || initial.generation_name || "", placeholder: "画风名称，如：暖纸淡彩钢笔" });
  const zhIn = el("textarea", { class: "textarea", placeholder: "只描述视觉语言：媒介、线条、材质、色彩、光影、空间（禁止写人物/服饰/场景）" }, initial.traits || "");
  const enIn = el("textarea", { class: "textarea", placeholder: "English pure visual-language traits..." }, initial.traitsEn || "");
  const warnBox = el("div", { class: "badge badge-warn hidden" });
  const uploadedPaths = [];
  const fileIn = el("input", { type: "file", accept: "image/*", multiple: true });
  const previewRow = el("div", { class: "row", style: { marginTop: "6px" } });

  fileIn.addEventListener("change", async () => {
    for (const f of Array.from(fileIn.files || []).slice(0, 5)) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        const up = await api("POST", "/api/mine/upload", fd);
        uploadedPaths.push(up.path);
        previewRow.appendChild(el("img", { src: up.url, style: { width: "64px", height: "64px", objectFit: "cover", borderRadius: "6px" } }));
      } catch (e) { toast(e.message); }
    }
  });

  let selectedVisionRef = "";
  const visionWrap = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", alignItems: "center" } },
    el("span", { class: "muted", style: { fontSize: "12px" } }, "视觉接口：")
  );
  api("GET", "/api/models").then((modRes) => {
    const sel = buildGroupedAIModelSelect(modRes, modRes.defaultVisionModel || "", "vision");
    selectedVisionRef = sel.value;
    sel.addEventListener("change", () => { selectedVisionRef = sel.value; });
    visionWrap.appendChild(sel);
  }).catch(() => {});

  const analyzeBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: async () => {
      if (uploadedPaths.length === 0) return toast("请先上传 1–5 张风格参考图");
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = "提取特征中…";
      try {
        const res = await api("POST", "/api/mine/analyze", {
          images: uploadedPaths,
          purpose: "create",
          modelRef: selectedVisionRef,
        });
        if (res.traitsZh) zhIn.value = res.traitsZh;
        if (res.traitsEn) enIn.value = res.traitsEn;
        if (res.name && !nameIn.value) nameIn.value = res.name;
        if (res.violations?.length) {
          warnBox.textContent = "⚠ 检测到可能包含具体主体词，请删改：" + res.violations.join("、");
          warnBox.classList.remove("hidden");
        } else {
          warnBox.classList.add("hidden");
        }
      } catch (e) { toast(e.message); }
      finally { analyzeBtn.disabled = false; analyzeBtn.textContent = "✨ 从参考图提取纯视觉特征"; }
    },
  }, "✨ 从参考图提取纯视觉特征");

  showModal(initial.docId ? "编辑我的画风" : "新建我的画风", el("div", null,
    el("div", { class: "field" },
      el("label", null, "参考图（可选 1–5 张，用于提取视觉特征）"),
      fileIn,
      previewRow,
      el("div", { class: "row", style: { marginTop: "6px", justifyContent: "space-between", flexWrap: "wrap" } }, analyzeBtn, visionWrap)
    ),
    el("div", { class: "field" }, el("label", null, "画风名称"), nameIn),
    el("div", { class: "field" }, el("label", null, "中文视觉特征（严禁出现具体人物/物品/场景）"), zhIn),
    el("div", { class: "field" }, el("label", null, "英文视觉特征"), enIn),
    warnBox
  ), [
    el("button", {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        try {
          const res = await api("POST", "/api/mine/styles", {
            docId: initial.docId || "",
            number: initial.number || "",
            name: nameIn.value,
            traits: zhIn.value,
            traitsEn: enIn.value,
            image: uploadedPaths[0] || initial.image || "",
            images: uploadedPaths,
          });
          if (res.violations?.length) {
            toast("已保存，建议后续移除特征中的主体词：" + res.violations.join("、"));
          } else {
            toast("画风已保存");
          }
          closeModal();
          if (onSaved) onSaved();
        } catch (e) { toast(e.message); }
      },
    }, "保存画风"),
  ]);
}

function openEditLayoutDialog(initial = {}, onSaved) {
  const nameIn = el("input", { class: "input", value: initial.name || "", placeholder: "图型名称，如：双栏要点对照卡" });
  const zhIn = el("textarea", { class: "textarea", placeholder: "描述区域划分、主标题区、配图区与留白约束" }, initial.prompt_zh || "");
  const enIn = el("textarea", { class: "textarea", placeholder: "English layout instructions..." }, initial.prompt_en || "");
  showModal(initial.docId ? "编辑我的图型" : "新建我的图型", el("div", null,
    el("div", { class: "field" }, el("label", null, "图型名称"), nameIn),
    el("div", { class: "field" }, el("label", null, "中文排版约束"), zhIn),
    el("div", { class: "field" }, el("label", null, "英文排版约束"), enIn)
  ), [
    el("button", {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        try {
          await api("POST", "/api/mine/layouts", {
            docId: initial.docId || "", id: initial.id || "", image: initial.image || "",
            name: nameIn.value, prompt_zh: zhIn.value, prompt_en: enIn.value,
          });
          closeModal();
          toast("图型已保存");
          onSaved();
        } catch (e) { toast(e.message); }
      },
    }, "保存图型"),
  ]);
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
  let mirror = "gitee";
  let busyId = "";

  const host = el("div", { class: "col", style: { gap: "12px" } },
    el("p", { class: "muted", style: { margin: 0 } }, "正在加载扩展图库列表…")
  );

  const renderModalBody = () => {
    clear(host);
    const mirrorBar = el("div", { class: "row ext-mirror-bar", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } },
      el("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap" } },
        el("span", { style: { fontSize: "12.5px", fontWeight: "700" } }, "下载源："),
        el("button", {
          type: "button",
          class: "pill-btn" + (mirror === "gitee" ? " pill-accent" : ""),
          disabled: Boolean(busyId),
          onClick: () => { mirror = "gitee"; renderModalBody(); },
        }, "🇨🇳 Gitee 国内镜像（推荐）"),
        el("button", {
          type: "button",
          class: "pill-btn" + (mirror === "github" ? " pill-accent" : ""),
          disabled: Boolean(busyId),
          onClick: () => { mirror = "github"; renderModalBody(); },
        }, "GitHub 原仓")
      ),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        disabled: Boolean(busyId) || packs.every((p) => p.installed),
        onClick: async () => {
          const targets = packs.filter((p) => !p.installed).map((p) => p.id);
          if (!targets.length) return;
          busyId = "__all__";
          renderModalBody();
          try {
            const res = await api("POST", "/api/galleries/packs/install", { ids: targets, mirror });
            packs = res.packs || packs;
            toast(`已一键安装 ${(res.installed || []).length} 套扩展图库（索引就绪，图片按需缓存）`);
            onChanged?.();
          } catch (e) {
            toast(e?.message || "安装失败");
          } finally {
            busyId = "";
            renderModalBody();
          }
        },
      }, busyId === "__all__" ? "正在安装全部…" : (packs.every((p) => p.installed) ? "✓ 全部已安装" : "⚡ 一键安装全部 3 套"))
    );

    const notice = el("div", { class: "card", style: { padding: "10px 12px", background: "var(--paper)", fontSize: "12px", lineHeight: "1.6" } },
      el("div", null,
        el("strong", null, "RuiC-PoseAtlas 开源视觉图鉴（MIT 协议）"),
        " · 由客户端直接从 ",
        el("a", {
          href: mirror === "gitee" ? "https://gitee.com/mingtian2018/RuiC-PoseAtlas" : "https://github.com/HRuiCcc/RuiC-PoseAtlas",
          onClick: (e) => { e.preventDefault(); openURL(mirror === "gitee" ? "https://gitee.com/mingtian2018/RuiC-PoseAtlas" : "https://github.com/HRuiCcc/RuiC-PoseAtlas"); },
        }, mirror === "gitee" ? "Gitee 镜像" : "GitHub 原仓"),
        " 安装索引（仅 ~1 MB，秒装完成），浏览或选用时自动按需缓存到本机。",
      ),
      el("div", { class: "muted", style: { marginTop: "3px" } }, "🔒 严格仅限本机使用：图库文件与缓存不会同步或上传至手绘风网站，网站也不托管这些第三方图库。")
    );

    const list = el("div", { class: "col", style: { gap: "10px" } });
    packs.forEach((p) => {
      const isBusy = busyId === p.id || busyId === "__all__";
      const statsText = p.installed
        ? `已安装 · ${p.itemCount || 0} 条 · 本地已缓存 ${p.cachedFiles || 0} 张 (${formatCacheSize(p.cachedBytes)}) · 源：${p.mirror === "github" ? "GitHub" : "Gitee"}`
        : "未安装";
      const actions = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
      if (p.installed) {
        actions.append(
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            disabled: isBusy,
            onClick: () => {
              closeModal();
              onOpenPack?.(p.id);
            },
          }, "去浏览"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            disabled: isBusy,
            onClick: async () => {
              busyId = p.id;
              renderModalBody();
              try {
                const res = await api("POST", "/api/galleries/packs/install", { id: p.id, mirror });
                packs = res.packs || packs;
                toast(`已更新「${p.name}」索引`);
                onChanged?.();
              } catch (e) {
                toast(e?.message || "更新失败");
              } finally {
                busyId = "";
                renderModalBody();
              }
            },
          }, isBusy ? "更新中…" : "更新 / 切源"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            disabled: isBusy,
            onClick: async () => {
              if (!window.confirm(`卸载「${p.name}」并清理本地图片缓存（${formatCacheSize(p.cachedBytes)}）？`)) return;
              busyId = p.id;
              renderModalBody();
              try {
                const res = await api("POST", `/api/galleries/packs/${encodeURIComponent(p.id)}/uninstall`, { purgeCache: true });
                packs = res.packs || packs;
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
            disabled: isBusy,
            onClick: async () => {
              busyId = p.id;
              renderModalBody();
              try {
                const res = await api("POST", "/api/galleries/packs/install", { id: p.id, mirror });
                packs = res.packs || packs;
                toast(`已安装「${p.name}」，可立即在画廊和生图参考图中使用`);
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
          el("div", { class: "col", style: { gap: "4px", flex: "1", minWidth: "220px" } },
            el("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap" } },
              el("strong", { style: { fontSize: "14.5px" } }, p.name),
              el("span", { class: "badge badge-accent" }, p.badge),
              p.multiVariant ? el("span", { class: "badge" }, "5 视角可选") : null,
              el("span", { class: "badge" }, "🔒 仅本机")
            ),
            el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px", lineHeight: "1.5" } }, p.description),
            el("span", { class: "muted", style: { fontSize: "11.5px" } }, statsText)
          ),
          actions
        )
      ));
    });

    host.append(notice, mirrorBar, list);
  };

  showModal("扩展视觉图库（仅本机安装）", host, [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
  ], { className: "modal-ext-packs" });

  try {
    const res = await api("GET", "/api/galleries/packs");
    packs = res.packs || [];
    if (res.defaultMirror) mirror = res.defaultMirror;
    renderModalBody();
  } catch (e) {
    clear(host);
    host.appendChild(el("p", { class: "muted" }, `加载失败：${e?.message || e}`));
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
