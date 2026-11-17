import { api, clear, closeModal, el, localImg, money, packImg, showModal, toast } from "../api.js";

const state = {
  tab: "styles", // styles | layouts | colors | tones | assets | mine | compare | dice | find
  group: "",
  q: "",
  compareIds: [],
  dice: { style: null, layout: null, color: null, lockStyle: false, lockLayout: false, lockColor: false },
};

export async function renderAtlas(root, ctx, params = {}) {
  if (params.tab) state.tab = params.tab;
  if (params.q !== undefined) state.q = params.q;
  clear(root);

  const summary = await api("GET", "/api/resources/summary").catch(() => ({ groups: [], counts: {} }));
  const tabs = [
    ["styles", `画风 (${summary.counts?.styles || 0})`],
    ["layouts", `图型 (${summary.counts?.layouts || 0})`],
    ["colors", `主题色 (${summary.counts?.colors || 0})`],
    ["tones", `影调 (${summary.counts?.tones || 0})`],
    ["assets", "角色/道具/场景"],
    ["mine", "我的资源"],
    ["compare", `对比台 (${state.compareIds.length}/4)`],
    ["find", "以图找风格"],
    ["dice", "画风骰子"],
  ];

  const tabBar = el("div", { class: "tabs" });
  tabs.forEach(([k, label]) => {
    tabBar.appendChild(el("button", {
      type: "button",
      class: "tab" + (state.tab === k ? " active" : ""),
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

  root.appendChild(el("div", { class: "page-head" },
    el("h1", { class: "page-title" }, "风格画册"),
    el("div", { class: "row" }, tabBar, searchInput)
  ));

  const stage = el("div");
  root.appendChild(stage);

  async function drawContent() {
    clear(stage);
    if (state.tab === "styles") await drawStyles(stage, summary.groups || [], ctx);
    else if (state.tab === "layouts") await drawLayouts(stage, ctx);
    else if (state.tab === "colors") await drawColors(stage, ctx);
    else if (state.tab === "tones") await drawTones(stage, ctx);
    else if (state.tab === "assets") await drawAssets(stage);
    else if (state.tab === "mine") await drawMine(stage, ctx);
    else if (state.tab === "compare") await drawCompare(stage, ctx);
    else if (state.tab === "find") await drawFindByImage(stage, ctx);
    else if (state.tab === "dice") await drawDice(stage, ctx);
  }

  await drawContent();
  if (params.openStyle) openStyleDetail(params.openStyle, ctx, () => renderAtlas(root, ctx));
}

async function drawStyles(stage, groups, ctx) {
  const res = await api("GET", `/api/resources/styles?q=${encodeURIComponent(state.q)}&group=${encodeURIComponent(state.group)}`);
  const items = res.items || [];

  const groupNav = el("div", { class: "atlas-groups" },
    el("button", {
      type: "button",
      class: "group-btn" + (state.group === "" ? " active" : ""),
      onClick: () => { state.group = ""; drawStylesWrap(); },
    }, el("span", null, "全部流派"), el("span", { class: "muted" }, String(items.length)))
  );
  groups.forEach((g) => {
    groupNav.appendChild(el("button", {
      type: "button",
      class: "group-btn" + (state.group === g.code ? " active" : ""),
      onClick: () => { state.group = g.code; drawStylesWrap(); },
    }, el("span", null, `${g.code} ${g.zh || g.en}`), el("span", { class: "muted" }, String(g.count))));
  });

  function drawStylesWrap() {
    clear(stage);
    drawStyles(stage, groups, ctx);
  }

  const grid = el("div", { class: "grid-cards" });
  const sentinel = el("div", { style: { height: "20px" } });
  let offset = 0;
  const batchSize = 36;

  const appendBatch = () => {
    const slice = items.slice(offset, offset + batchSize);
    offset += slice.length;
    slice.forEach((s) => {
      const inCmp = state.compareIds.includes(s.number);
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
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { style: s.number }) }, "用于创作"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => {
              if (inCmp) state.compareIds = state.compareIds.filter((x) => x !== s.number);
              else if (state.compareIds.length < 4) state.compareIds.push(s.number);
              else return toast("对比台最多选 4 个画风");
              drawStylesWrap();
            },
          }, inCmp ? "已选对比" : "+对比")
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

  const right = el("div", null,
    items.length === 0 ? el("div", { class: "card muted" }, "没有找到匹配的画风") : grid,
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
        onClick: () => { closeModal(); state.tab = "mine"; openEditStyleDialog({ name: (st.nameZh || st.generation_name) + " · 变体", traits: st.traits, traitsEn: st.traitsEn || st.traits }, onRefresh); },
      }, "另存为我的画风"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: () => { closeModal(); ctx.go("create", { style: st.number }); },
      }, "去创作单图"),
    ]);
  } catch (err) {
    toast(err.message);
  }
}

async function drawLayouts(stage, ctx) {
  const res = await api("GET", `/api/resources/layouts?q=${encodeURIComponent(state.q)}`);
  const grid = el("div", { class: "grid-cards" });
  (res.items || []).forEach((l) => {
    grid.appendChild(el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: packImg(l.image), alt: l.name, loading: "lazy" }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, `${l.id} · ${l.category}`),
        el("div", { class: "style-name" }, l.name),
        el("div", { class: "style-traits" }, l.prompt_zh || (l.keywords || []).join(" · "))
      ),
      el("div", { class: "style-actions" },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { layout: l.id }) }, "用于创作")
      )
    ));
  });
  stage.appendChild(grid);
}

async function drawColors(stage, ctx) {
  const res = await api("GET", `/api/resources/colors?q=${encodeURIComponent(state.q)}`);
  const grid = el("div", { class: "grid-cards" });
  (res.items || []).forEach((c) => {
    grid.appendChild(el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: packImg(c.image), alt: c.name_zh, loading: "lazy" }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, `${c.id} · ${c.category_zh}`),
        el("div", { class: "style-name" }, `${c.name_zh} / ${c.name_en}`),
        el("div", { class: "style-traits" }, c.quote_zh)
      ),
      el("div", { class: "style-actions" },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { color: c.id }) }, "选用配色")
      )
    ));
  });
  stage.appendChild(grid);
}

async function drawTones(stage, ctx) {
  const res = await api("GET", `/api/resources/tones?q=${encodeURIComponent(state.q)}`);
  const grid = el("div", { class: "grid-cards" });
  (res.items || []).forEach((t) => {
    grid.appendChild(el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: packImg(t.image), alt: t.name_zh, loading: "lazy" }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, `${t.id} · ${t.category_zh}`),
        el("div", { class: "style-name" }, `${t.name_zh} / ${t.name_en}`),
        el("div", { class: "style-traits" }, t.desc_zh)
      ),
      el("div", { class: "style-actions" },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { tone: t.id }) }, "选用影调")
      )
    ));
  });
  stage.appendChild(grid);
}

async function drawAssets(stage) {
  const [packRes, mineRes] = await Promise.all([
    api("GET", "/api/resources/assets").catch(() => ({ items: [] })),
    api("GET", "/api/mine/assets").catch(() => ({ items: [] })),
  ]);
  const map = new Map();
  for (const a of [...(packRes.items || []), ...(mineRes.items || [])]) {
    if (a.id) map.set(a.id, a);
  }
  const items = Array.from(map.values());
  const addBtn = el("button", {
    type: "button",
    class: "btn btn-primary btn-sm",
    onClick: () => openAssetDialog(() => { clear(stage); drawAssets(stage); }),
  }, "+ 添加角色/道具/场景参考图");
  stage.appendChild(el("div", { class: "row", style: { marginBottom: "12px", justifyContent: "space-between" } },
    el("span", { class: "muted" }, "支持本地图库与 Skill ~/.handraw-style 图库同步读取"),
    addBtn
  ));
  const grid = el("div", { class: "grid-cards" });
  items.forEach((a) => {
    const src = a.image ? (a.image.startsWith("images/") ? packImg(a.image) : localImg(a.image)) : "/img/logo.svg";
    grid.appendChild(el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src, alt: a.name, loading: "lazy" }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, `${a.id} · ${a.kind}`),
        el("div", { class: "style-name" }, a.name)
      )
    ));
  });
  stage.appendChild(grid);
}

function openAssetDialog(onSaved) {
  const nameIn = el("input", { class: "input", placeholder: "名称，例如：小橘猫店员" });
  const kindSel = el("select", { class: "select" },
    el("option", { value: "character" }, "角色"),
    el("option", { value: "prop" }, "道具"),
    el("option", { value: "scene" }, "场景")
  );
  const fileIn = el("input", { type: "file", accept: "image/*" });
  let dataUrl = "";
  fileIn.addEventListener("change", () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { dataUrl = rd.result; };
    rd.readAsDataURL(f);
  });
  showModal("新建自建图库资产", el("div", null,
    el("div", { class: "field" }, el("label", null, "分类"), kindSel),
    el("div", { class: "field" }, el("label", null, "名称"), nameIn),
    el("div", { class: "field" }, el("label", null, "参考图片"), fileIn)
  ), [
    el("button", {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        try {
          await api("POST", "/api/mine/assets", { kind: kindSel.value, name: nameIn.value, dataUrl });
          closeModal();
          toast("已添加到个人图库");
          onSaved();
        } catch (e) { toast(e.message); }
      },
    }, "保存"),
  ]);
}

async function drawMine(stage, ctx) {
  const [stRes, layRes] = await Promise.all([
    api("GET", "/api/mine/styles").catch(() => ({ items: [] })),
    api("GET", "/api/mine/layouts").catch(() => ({ items: [] })),
  ]);
  const reload = () => { clear(stage); drawMine(stage, ctx); };

  stage.appendChild(el("div", { class: "row", style: { marginBottom: "14px", justifyContent: "space-between" } },
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn btn-primary btn-sm", onClick: () => openEditStyleDialog({}, reload) }, "+ 新建/从参考图建画风"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => openEditLayoutDialog({}, reload) }, "+ 新建图型")
    ),
    el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: async () => {
        try {
          const r = await api("POST", "/api/mine/sync", {});
          toast(`同步完成：上传 ${r.pushed || 0}，拉取 ${r.pulled || 0}${(r.conflicts || []).length ? "（存在冲突）" : ""}`);
          reload();
        } catch (e) { toast(e.message); }
      },
    }, "☁ 立即与网站私有库同步")
  ));

  const styles = stRes.items || [];
  const layouts = layRes.items || [];
  if (styles.length === 0 && layouts.length === 0) {
    stage.appendChild(el("div", { class: "card muted" }, "暂无自定义画风或图型。点击上方按钮创建，登录后将默认同步到你的网站私有库。"));
    return;
  }
  const grid = el("div", { class: "grid-cards" });
  styles.forEach((s) => {
    grid.appendChild(el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: s.image ? localImg(s.image) : "/img/logo.svg", alt: s.generation_name }),
      el("div", { class: "style-body" },
        el("div", { class: "row", style: { justifyContent: "space-between" } },
          el("span", { class: "style-code" }, s.number),
          el("span", { class: "badge" }, s.dirty ? "待同步" : (s.remoteId ? "已同步私有" : "仅本地"))
        ),
        el("div", { class: "style-name" }, s.nameZh || s.generation_name),
        el("div", { class: "style-traits" }, s.traits)
      ),
      el("div", { class: "style-actions" },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { style: s.number }) }, "创作"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => openEditStyleDialog(s, reload) }, "编辑"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          onClick: async () => { await api("DELETE", `/api/mine/styles/${encodeURIComponent(s.docId)}`); toast("已删除"); reload(); },
        }, "删除")
      )
    ));
  });
  layouts.forEach((l) => {
    grid.appendChild(el("div", { class: "style-card" },
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, l.id),
        el("div", { class: "style-name" }, l.name),
        el("div", { class: "style-traits" }, l.prompt_zh)
      ),
      el("div", { class: "style-actions" },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { layout: l.id }) }, "创作"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          onClick: async () => { await api("DELETE", `/api/mine/layouts/${encodeURIComponent(l.docId)}`); toast("已删除"); reload(); },
        }, "删除")
      )
    ));
  });
  stage.appendChild(grid);
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

  const analyzeBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: async () => {
      if (uploadedPaths.length === 0) return toast("请先上传 1–5 张风格参考图");
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = "提取特征中…";
      try {
        const res = await api("POST", "/api/mine/analyze", { images: uploadedPaths, purpose: "create" });
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

  showModal(initial.docId ? "编辑自定义画风" : "新建自定义画风", el("div", null,
    el("div", { class: "field" }, el("label", null, "参考图（可选 1–5 张，用于提取视觉特征）"), fileIn, previewRow, el("div", { style: { marginTop: "6px" } }, analyzeBtn)),
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
            toast("自定义画风已保存");
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
  showModal("新建自定义图型", el("div", null,
    el("div", { class: "field" }, el("label", null, "图型名称"), nameIn),
    el("div", { class: "field" }, el("label", null, "中文排版约束"), zhIn),
    el("div", { class: "field" }, el("label", null, "英文排版约束"), enIn)
  ), [
    el("button", {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        try {
          await api("POST", "/api/mine/layouts", { name: nameIn.value, prompt_zh: zhIn.value, prompt_en: enIn.value });
          closeModal();
          toast("自定义图型已保存");
          onSaved();
        } catch (e) { toast(e.message); }
      },
    }, "保存图型"),
  ]);
}

async function drawCompare(stage, ctx) {
  if (state.compareIds.length === 0) {
    stage.appendChild(el("div", { class: "card muted" }, "对比台为空。请在「画风」列表点击卡片上的「+对比」选择最多 4 个画风并排比较，并可用同一主题一键生成真实对比。"));
    return;
  }
  const styles = [];
  for (const id of state.compareIds) {
    const r = await api("GET", `/api/resources/styles/${encodeURIComponent(id)}`).catch(() => null);
    if (r?.style) styles.push(r.style);
  }
  const themeIn = el("input", { class: "input", placeholder: "输入同一主题，一键对比各画风真实出图效果…", style: { flex: "1" } });
  const modRes = await api("GET", "/api/models").catch(() => ({ defaultModel: "", site: [], providers: [] }));
  const modelRef = modRes.defaultModel || (modRes.site?.[0]?.model ? "site:" + modRes.site[0].model : (modRes.providers?.[0]?.models?.[0]?.id ? `${modRes.providers[0].id}:${modRes.providers[0].models[0].id}` : ""));

  const genBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    onClick: async () => {
      if (!themeIn.value.trim()) return toast("请先输入对比主题");
      try {
        const res = await api("POST", "/api/generate", {
          mode: "compare",
          title: `画风对比：${themeIn.value.trim()}`,
          modelRef,
          items: styles.map((s) => ({ style: s.number, theme: themeIn.value.trim(), ratio: "3:4", mode: "pure-image" })),
        });
        if (res.needConfirm) {
          if (!confirm(`预计花费 ${money(res.totalCents)}（${res.count} 张），是否继续？`)) return;
          await api("POST", "/api/generate", {
            mode: "compare", title: `画风对比：${themeIn.value.trim()}`, modelRef, confirmed: true,
            items: styles.map((s) => ({ style: s.number, theme: themeIn.value.trim(), ratio: "3:4", mode: "pure-image" })),
          });
        }
        toast(`已提交 ${styles.length} 张对比生图任务`);
        ctx.go("works");
      } catch (e) { toast(e.message); }
    },
  }, `用同一主题生成 ${styles.length} 张对比`);

  stage.appendChild(el("div", { class: "card row", style: { marginBottom: "14px" } }, themeIn, genBtn));
  const grid = el("div", { class: "grid-cards" });
  styles.forEach((s) => {
    grid.appendChild(el("div", { class: "style-card" },
      el("img", { class: "style-thumb", src: packImg(s.image), alt: s.generation_name }),
      el("div", { class: "style-body" },
        el("div", { class: "style-code" }, s.number),
        el("div", { class: "style-name" }, s.nameZh || s.generation_name),
        el("div", { class: "muted", style: { marginTop: "4px" } }, s.traits)
      ),
      el("div", { class: "style-actions" },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => { state.compareIds = state.compareIds.filter((x) => x !== s.number); clear(stage); drawCompare(stage, ctx); },
        }, "移出")
      )
    ));
  });
  stage.appendChild(grid);
}

async function drawFindByImage(stage, ctx) {
  const fileIn = el("input", { type: "file", accept: "image/*" });
  const resultBox = el("div", { style: { marginTop: "14px" } });
  const analyzeFile = async (f) => {
    const fd = new FormData();
    fd.append("file", f);
    clear(resultBox);
    resultBox.appendChild(el("div", { class: "sketch-loader" }, el("span", null, "正在分析参考图视觉语言并匹配最相近画风…")));
    try {
      const up = await api("POST", "/api/mine/upload", fd);
      const res = await api("POST", "/api/mine/analyze", { images: [up.path], purpose: "find" });
      clear(resultBox);
      resultBox.appendChild(el("div", { class: "card", style: { marginBottom: "12px" } },
        el("strong", null, "提取的视觉语言特征"),
        el("p", { style: { margin: "6px 0" } }, res.traitsZh || "—"),
        el("p", { class: "muted", style: { margin: 0 } }, res.traitsEn || ""),
        el("div", { style: { marginTop: "8px" } },
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            onClick: () => openEditStyleDialog({ traits: res.traitsZh, traitsEn: res.traitsEn, image: up.path }, () => { state.tab = "mine"; clear(stage); drawMine(stage, ctx); }),
          }, "据此新建我的画风")
        )
      ));
      const grid = el("div", { class: "grid-cards" });
      (res.matches || []).forEach((s) => {
        grid.appendChild(el("div", { class: "style-card" },
          el("img", { class: "style-thumb", src: packImg(s.image), alt: s.generation_name }),
          el("div", { class: "style-body" },
            el("div", { class: "style-code" }, s.number),
            el("div", { class: "style-name" }, s.nameZh || s.generation_name),
            el("div", { class: "style-traits" }, s.traits)
          ),
          el("div", { class: "style-actions" },
            el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { style: s.number }) }, "用于创作")
          )
        ));
      });
      resultBox.appendChild(grid);
    } catch (e) {
      clear(resultBox);
      resultBox.appendChild(el("div", { class: "card badge-err" }, e.message));
    }
  };
  fileIn.addEventListener("change", () => { if (fileIn.files?.[0]) analyzeFile(fileIn.files[0]); });

  const drop = el("div", { class: "card", style: { textAlign: "center", padding: "28px", borderStyle: "dashed" } },
    el("p", null, "拖入任意参考图片，或点击选择文件：提取纯视觉语言并找出最接近的 5 种画风"),
    fileIn
  );
  drop.addEventListener("dragover", (e) => e.preventDefault());
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) analyzeFile(f);
  });
  stage.appendChild(drop);
  stage.appendChild(resultBox);
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
    }, "带入单图工作区 →")
  ));

  stage.appendChild(el("div", { class: "grid-cards" },
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
