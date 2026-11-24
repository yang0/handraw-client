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
    ...[["quick", "快门"], ["single", "单图"], ["series", "系列"], ["article", "文章配图"], ["canvas", "画布"], ["edit", "批注改图"]].map(([v, l]) => el("option", { value: v, selected: state.mode === v }, l))
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
      limit: "60",
    });
    const res = await api("GET", `/api/works?${qs.toString()}`).catch(() => ({ items: [] }));
    const items = res.items || [];
    clear(grid);
    if (!items.length) {
      grid.appendChild(el("div", { class: "card muted", style: { gridColumn: "1 / -1" } }, "当前筛选下暂无本地作品。所有生成的图片默认均保存于本地目录。"));
      return;
    }
    items.forEach((run) => {
      const im = run.images?.[0];
      const src = im?.thumb ? localImg(im.thumb) : (im?.path ? localImg(im.path) : "/img/logo.svg");
      grid.appendChild(el("div", { class: "style-card", onClick: () => openRunDetail(run.id, ctx, loadGrid) },
        el("img", { class: "style-thumb", src, alt: run.title || "", loading: "lazy" }),
        el("div", { class: "style-body" },
          el("div", { class: "row", style: { justifyContent: "space-between" } },
            el("span", { class: "badge" }, run.mode || "single"),
            run.publishedWorkId ? el("span", { class: "badge badge-ok" }, "已发布") : el("span", { class: "muted" }, "仅本地")
          ),
          el("div", { class: "style-name" }, (run.starred ? "★ " : "") + (run.title || "未命名作品")),
          el("div", { class: "muted" }, `${run.modelLabel || run.model} · ${(run.images || []).length} 张`)
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
  const notesIn = el("textarea", { class: "input", rows: 2, maxlength: 2000, placeholder: "可选：创作说明、心得或配方要点（别人做同款时能看到）" });
  const body = el("div", { class: "col", style: { gap: "12px" } });

  // Versions strip if >1
  if (versions.length > 1) {
    const vRow = el("div", { class: "row" }, el("span", { class: "muted" }, "修订版本："));
    versions.forEach((v, idx) => {
      vRow.appendChild(el("button", {
        type: "button",
        class: "pill-btn" + (v.id === run.id ? " pill-accent" : ""),
        onClick: () => { closeModal(); openRunDetail(v.id, ctx, onChanged); },
      }, `v${idx + 1} · ${v.title?.slice(0, 10) || v.id.slice(-5)}`));
    });
    body.appendChild(vRow);
  }

  // Images gallery + selection for publishing
  const selectedIds = new Set((run.images || []).filter((i) => i.status === "done" && i.path).slice(0, 12).map((i) => i.id));
  const imgGrid = el("div", { class: "row", style: { gap: "10px", alignItems: "stretch" } });
  (run.images || []).forEach((im, idx) => {
    if (im.status !== "done" || !im.path) {
      imgGrid.appendChild(el("div", { class: "card col", style: { width: "160px", padding: "10px" } },
        el("span", { class: "badge badge-warn" }, im.status),
        el("span", { class: "muted" }, im.error || "未完成"),
        im.status === "failed" ? el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: async () => { await api("POST", `/api/images/${encodeURIComponent(im.id)}/retry`); toast("已重试"); closeModal(); onChanged?.(); },
        }, "重试") : null
      ));
      return;
    }
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

  body.appendChild(el("div", { class: "field" },
    el("label", null, "作品标题（可修改）"),
    el("div", { class: "row" },
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
          const firstImg = (run.images || []).find((i) => i.status === "done" && i.path);
          let rec = {};
          try { rec = typeof run.recipe === "string" ? JSON.parse(run.recipe) : (run.recipe || {}); } catch {}
          try {
            await api("POST", "/api/inspirations", {
              title: titleIn.value.trim() || run.title || "我的创作灵感",
              imagePath: firstImg?.path || "",
              prompt: run.promptZh || run.promptEn || run.originalRequest || run.title || "",
              promptZh: run.promptZh || "",
              source: "local",
              runId: run.id,
              recipe: rec,
              suggestedStyle: rec.styleIds?.[0] || "",
            });
            toast("已收进灵感库，可随时 AI 整理或分享赚积分");
          } catch (e) { toast(e.message); }
        },
      }, "💡 收进灵感库")
    )
  ));

  if (run.promptZh || run.promptEn) {
    body.appendChild(el("details", { class: "card", style: { padding: "8px 10px" } },
      el("summary", { style: { cursor: "pointer", fontSize: "12.5px" } }, "查看完整提示词与记录"),
      el("pre", { class: "mono", style: { whiteSpace: "pre-wrap", fontSize: "11.5px", margin: "8px 0 0" } }, run.promptZh || run.promptEn)
    ));
  }

  // Publish panel
  const pubBox = el("div", { class: "card col publish-box" });
  const showPublished = (url) => {
    clear(pubBox);
    pubBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } },
      el("span", { class: "badge badge-ok" }, "已发布到手绘风社区"),
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm", onClick: async () => toast(await copyText(url) ? "链接已复制，可以发给朋友或贴到社媒" : "复制失败，请手动复制") }, "复制链接"),
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openURL(url) }, "↗ 在网站打开")
      )
    ));
    pubBox.appendChild(el("span", { class: "muted mono", style: { wordBreak: "break-all", fontSize: "11.5px" } }, url));
  };
  if (run.publishedWorkId) {
    showPublished(run.publishedUrl);
  } else {
    pubBox.appendChild(el("strong", null, "☁ 分享到手绘风社区"));
    pubBox.appendChild(el("span", { class: "muted" }, "上传勾选的图片（WebP，长边 2048）、标题、说明和配方编号，别人可以一键做同款。自建画风只显示名称和网站链接，不会带上本机的定义。"));
    pubBox.appendChild(notesIn);
    const pubBtn = el("button", {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        if (!selectedIds.size) return toast("请至少勾选 1 张已完成的图片");
        pubBtn.disabled = true;
        const label = pubBtn.textContent;
        try {
          const ids = Array.from(selectedIds);
          const encoded = {};
          let n = 0;
          for (const id of ids) {
            const im = run.images.find((x) => x.id === id);
            pubBtn.textContent = `正在压缩 ${++n}/${ids.length}…`;
            const url = im ? await toWebp(localImg(im.path)) : "";
            if (url) encoded[id] = url;
          }
          pubBtn.textContent = "正在上传…";
          const res = await api("POST", `/api/works/${encodeURIComponent(run.id)}/publish`, {
            title: titleIn.value.trim(),
            notes: notesIn.value.trim(),
            imageIds: ids,
            encoded,
          });
          toast("已发布到社区");
          run.publishedWorkId = res.workId;
          run.publishedUrl = res.url;
          showPublished(res.url);
          onChanged?.();
        } catch (e) {
          toast(e.message);
          pubBtn.disabled = false;
          pubBtn.textContent = label;
        }
      },
    }, "发布所选图片");
    pubBox.appendChild(el("div", { class: "row" }, pubBtn));
  }
  body.appendChild(pubBox);

  showModal(run.title || "作品详情", body, [
    el("button", { type: "button", class: "btn", onClick: () => api("POST", `/api/works/${encodeURIComponent(run.id)}/reveal`) }, "📂 打开文件夹"),
    el("button", { type: "button", class: "btn", onClick: async () => { const r = await api("POST", `/api/works/${encodeURIComponent(run.id)}/export`, { format: "zip" }); toast("已导出：" + r.path); } }, "导出 ZIP"),
    el("button", { type: "button", class: "btn", onClick: () => { closeModal(); ctx.go("annotate", { runId: run.id }); } }, "📌 批注改图"),
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
    const list = Array.isArray(raw) ? raw : (raw.items || raw.generations || raw.runs || []);
    const base = res.siteBase || "https://handraw-style.com";
    if (!list.length) {
      stage.appendChild(el("div", { class: "card muted" }, "暂无网站生图历史。"));
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
