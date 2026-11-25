import { api, clear, closeModal, el, getToken, showModal, toast } from "../api.js";
import { openArticleContextMenu } from "./article-links.js";

const STATUS_BADGE_TONE = {
  "选题池": "is-slate",
  "写作中": "is-indigo",
  "待配图": "is-amber",
  "校对中": "is-purple",
  "已发布": "is-emerald",
};

function fmtRelTime(unixSec) {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getRowStatus(row, fallback = "选题池") {
  const s = row?.properties?.status;
  return typeof s === "string" && s.trim() ? s.trim() : fallback;
}

function getRowTags(row) {
  const t = row?.properties?.tags ?? row?.properties?.tag;
  if (Array.isArray(t)) return t.map((x) => String(x || "").trim()).filter(Boolean);
  if (typeof t === "string" && t.trim()) return t.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}

function assetThumbUrl(coverPath, notePath) {
  if (!coverPath) return "";
  if (/^https?:\/\//i.test(coverPath)) return coverPath;
  const q = new URLSearchParams({ path: coverPath, from: notePath || "", t: getToken() });
  return `/files/vault-asset?${q.toString()}`;
}

export function createArticleBoardController(opts) {
  const {
    getVaultDirs,
    onOpenNote,
    onOpenLocalGraph,
    onExitBoard,
    onVaultMutated,
  } = opts;

  const state = {
    dir: "",
    view: "kanban", // kanban | table | gallery
    query: "",
    tagFilter: "",
    sortKey: "modTime",
    sortAsc: false,
    rows: [],
    statusOptions: ["选题池", "写作中", "待配图", "校对中", "已发布"],
    loading: false,
  };

  let hostEl = null;
  let draggingPath = "";

  async function loadData() {
    state.loading = true;
    try {
      const q = state.dir ? `?dir=${encodeURIComponent(state.dir)}` : "";
      const res = await api("GET", `/api/article/vault/table${q}`);
      state.rows = Array.isArray(res.rows) ? res.rows : [];
      if (Array.isArray(res.statusOptions) && res.statusOptions.length) {
        state.statusOptions = res.statusOptions;
      }
    } catch (e) {
      toast(e.message || "加载选题库失败");
    } finally {
      state.loading = false;
      if (hostEl && hostEl.isConnected) render(hostEl);
    }
  }

  async function patchNoteProp(relPath, setObj, removeArr = []) {
    try {
      const res = await api("PATCH", "/api/article/vault/frontmatter", {
        path: relPath,
        set: setObj,
        remove: removeArr,
      });
      const row = state.rows.find((r) => r.path === relPath);
      if (row && res.properties) {
        row.properties = res.properties;
      }
      if (hostEl && hostEl.isConnected) render(hostEl);
      onVaultMutated?.(relPath);
      return true;
    } catch (e) {
      toast(e.message || "更新文档属性失败");
      return false;
    }
  }

  function openNewTopicModal(defaultStatus = "选题池") {
    const titleIn = el("input", { class: "input", placeholder: "输入选题 / 文章标题…" });
    const statusSel = el("select", { class: "select" },
      ...state.statusOptions.map((s) => el("option", { value: s, selected: s === defaultStatus }, s))
    );
    const tagsIn = el("input", { class: "input", placeholder: "逗号分隔标签，如：公众号, AI漫剧" });
    const submit = async () => {
      const title = titleIn.value.trim();
      if (!title) return toast("请输入选题标题");
      const safe = title.replace(/[\\/:*?"<>|]/g, "-");
      const rel = state.dir ? `${state.dir}/${safe}.md` : `${safe}.md`;
      const tagList = tagsIn.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const today = new Date().toISOString().slice(0, 10);
      const fm = [
        "---",
        `title: ${title}`,
        `status: ${statusSel.value}`,
        `tags: [${tagList.join(", ")}]`,
        `date: ${today}`,
        "---",
        "",
        `# ${title}`,
        "",
        "",
      ].join("\n");
      try {
        const res = await api("PUT", "/api/article/vault/file", {
          path: rel,
          title,
          content: fm,
        });
        closeModal();
        toast(`已新建选题「${title}」`);
        onVaultMutated?.(res.path || rel);
        await loadData();
      } catch (e) {
        toast(e.message || "新建选题失败");
      }
    };
    titleIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    showModal("新建选题卡片", el("div", { class: "col", style: { gap: "10px" } },
      el("div", { class: "field" }, el("label", null, "选题标题"), titleIn),
      el("div", { class: "field" }, el("label", null, "初始状态"), statusSel),
      el("div", { class: "field" }, el("label", null, "标签（可选）"), tagsIn)
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", { type: "button", class: "btn btn-primary", onClick: submit }, "创建选题"),
    ]);
    titleIn.focus();
  }

  function openEditTagsModal(row) {
    const cur = getRowTags(row);
    const tagsIn = el("input", { class: "input", value: cur.join(", "), placeholder: "逗号分隔标签，如：AI, 案例拆解" });
    const submit = async () => {
      const next = tagsIn.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      closeModal();
      const ok = await patchNoteProp(row.path, { tags: next });
      if (ok) toast(`已更新「${row.title}」标签`);
    };
    tagsIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    showModal(`编辑标签 · ${row.title}`, el("div", { class: "field" },
      el("label", null, "标签列表（英文或中文逗号分隔）"),
      tagsIn
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", { type: "button", class: "btn btn-primary", onClick: submit }, "保存"),
    ]);
    tagsIn.focus();
  }

  function openRowContextMenu(ev, row) {
    const curStatus = getRowStatus(row);
    openArticleContextMenu(ev, [
      { header: row.path },
      { icon: "↗", label: "打开编辑", onClick: () => onOpenNote?.(row.path) },
      { icon: "📑", label: "在新标签页打开", onClick: () => onOpenNote?.(row.path, { newTab: true }) },
      { icon: "🕸", label: "查看局部关系图谱", onClick: () => onOpenLocalGraph?.(row.path) },
      { sep: true },
      {
        icon: "🏷",
        label: "切换进度状态",
        children: state.statusOptions.map((st) => ({
          icon: st === curStatus ? "✓" : "○",
          label: st,
          onClick: async () => {
            if (await patchNoteProp(row.path, { status: st })) toast(`「${row.title}」→ ${st}`);
          },
        })),
      },
      { icon: "#", label: "编辑标签…", onClick: () => openEditTagsModal(row) },
    ]);
  }

  function filteredRows() {
    const q = state.query.trim().toLowerCase();
    const tf = state.tagFilter;
    const out = state.rows.filter((r) => {
      if (tf && !getRowTags(r).includes(tf)) return false;
      if (q) {
        const hay = `${r.title} ${r.path} ${getRowStatus(r)} ${getRowTags(r).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const mul = state.sortAsc ? 1 : -1;
    out.sort((a, b) => {
      const k = state.sortKey;
      if (k === "title") return a.title.localeCompare(b.title) * mul;
      if (k === "status") return getRowStatus(a).localeCompare(getRowStatus(b)) * mul;
      if (k === "wordCount") return (a.wordCount - b.wordCount) * mul;
      if (k === "backlinkCount") return (a.backlinkCount - b.backlinkCount) * mul;
      return (a.modTime - b.modTime) * mul;
    });
    return out;
  }

  function renderKanban(body, rows) {
    const board = el("div", { class: "ic-board-kanban" });
    const cols = [...state.statusOptions];

    cols.forEach((statusName) => {
      const colRows = rows.filter((r) => getRowStatus(r, cols[0]) === statusName);
      const tone = STATUS_BADGE_TONE[statusName] || "is-slate";
      const cardsWrap = el("div", { class: "ic-board-col-cards" });

      colRows.forEach((row) => {
        const tags = getRowTags(row);
        const card = el("article", {
          class: "ic-board-card",
          draggable: "true",
          dataset: { path: row.path },
          onClick: () => onOpenNote?.(row.path),
          onContextMenu: (ev) => openRowContextMenu(ev, row),
        },
          row.coverImage ? el("div", { class: "ic-board-card-cover" },
            el("img", { src: assetThumbUrl(row.coverImage, row.path), alt: row.title, loading: "lazy" })
          ) : null,
          el("div", { class: "ic-board-card-title" }, row.title),
          row.folder ? el("div", { class: "ic-board-card-folder mono muted" }, row.folder) : null,
          tags.length ? el("div", { class: "ic-board-card-tags" },
            ...tags.slice(0, 4).map((t) => el("span", { class: "ic-board-tag" }, `#${t}`))
          ) : null,
          el("div", { class: "ic-board-card-foot muted" },
            el("span", null, `${row.wordCount} 字`),
            row.backlinkCount > 0 ? el("span", { class: "ic-board-card-links" }, `↩ ${row.backlinkCount}`) : null,
            row.outlinkCount > 0 ? el("span", null, `↗ ${row.outlinkCount}`) : null
          )
        );
        card.addEventListener("dragstart", (ev) => {
          draggingPath = row.path;
          card.classList.add("is-dragging");
          ev.dataTransfer?.setData("text/plain", row.path);
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
        });
        card.addEventListener("dragend", () => {
          draggingPath = "";
          card.classList.remove("is-dragging");
          board.querySelectorAll(".ic-board-col.is-drop-over").forEach((c) => c.classList.remove("is-drop-over"));
        });
        cardsWrap.appendChild(card);
      });

      const colEl = el("section", { class: "ic-board-col", dataset: { status: statusName } },
        el("header", { class: "ic-board-col-head" },
          el("div", { class: "row", style: { gap: "6px" } },
            el("span", { class: `ic-board-status-dot ${tone}` }),
            el("strong", { class: "ic-board-col-title" }, statusName),
            el("span", { class: "ic-board-col-count" }, String(colRows.length))
          ),
          el("button", {
            type: "button",
            class: "ic-vault-ico-btn",
            title: `在「${statusName}」新建选题`,
            onClick: () => openNewTopicModal(statusName),
          }, "＋")
        ),
        cardsWrap,
        el("button", {
          type: "button",
          class: "ic-board-col-add",
          onClick: () => openNewTopicModal(statusName),
        }, "＋ 添加选题")
      );

      colEl.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
        colEl.classList.add("is-drop-over");
      });
      colEl.addEventListener("dragleave", (ev) => {
        if (!colEl.contains(ev.relatedTarget)) colEl.classList.remove("is-drop-over");
      });
      colEl.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        colEl.classList.remove("is-drop-over");
        const path = draggingPath || ev.dataTransfer?.getData("text/plain") || "";
        if (!path) return;
        const row = state.rows.find((r) => r.path === path);
        if (!row || getRowStatus(row, cols[0]) === statusName) return;
        if (await patchNoteProp(path, { status: statusName })) {
          toast(`已将「${row.title}」移至「${statusName}」并写入 YAML`);
        }
      });

      board.appendChild(colEl);
    });
    body.appendChild(board);
  }

  function renderTable(body, rows) {
    const mkTh = (key, label) => {
      const active = state.sortKey === key;
      const arrow = active ? (state.sortAsc ? " ↑" : " ↓") : "";
      return el("th", {
        class: "ic-board-th-sort" + (active ? " is-active" : ""),
        onClick: () => {
          if (state.sortKey === key) state.sortAsc = !state.sortAsc;
          else { state.sortKey = key; state.sortAsc = false; }
          render(hostEl);
        },
      }, `${label}${arrow}`);
    };

    const tbody = el("tbody");
    rows.forEach((row) => {
      const curSt = getRowStatus(row);
      const tone = STATUS_BADGE_TONE[curSt] || "is-slate";
      const tags = getRowTags(row);
      const sel = el("select", {
        class: `ic-board-status-sel ${tone}`,
        "aria-label": `修改 ${row.title} 的状态`,
      }, ...state.statusOptions.map((s) => el("option", { value: s, selected: s === curSt }, s)));
      sel.value = curSt;
      sel.addEventListener("change", async () => {
        if (await patchNoteProp(row.path, { status: sel.value })) {
          toast(`已更新「${row.title}」状态为「${sel.value}」`);
        }
      });

      tbody.appendChild(el("tr", { onContextMenu: (ev) => openRowContextMenu(ev, row) },
        el("td", { class: "ic-board-td-title" },
          el("button", {
            type: "button",
            class: "ic-board-title-btn",
            onClick: () => onOpenNote?.(row.path),
          }, row.title),
          row.folder ? el("span", { class: "ic-board-folder-pill mono" }, row.folder) : null
        ),
        el("td", null, sel),
        el("td", null,
          el("div", { class: "ic-board-card-tags" },
            ...tags.map((t) => el("span", { class: "ic-board-tag" }, `#${t}`)),
            el("button", {
              type: "button",
              class: "ic-board-tag-edit",
              title: "编辑标签",
              onClick: () => openEditTagsModal(row),
            }, "✎")
          )
        ),
        el("td", { class: "mono muted" }, String(row.wordCount)),
        el("td", { class: "mono muted" }, `↩${row.backlinkCount} · ↗${row.outlinkCount}`),
        el("td", { class: "mono muted", style: { fontSize: "12px" } }, fmtRelTime(row.modTime))
      ));
    });

    body.appendChild(el("div", { class: "ic-board-table-wrap" },
      el("table", { class: "ic-board-table" },
        el("thead", null, el("tr", null,
          mkTh("title", "文章标题"),
          mkTh("status", "进度状态"),
          el("th", null, "标签"),
          mkTh("wordCount", "字数"),
          mkTh("backlinkCount", "双链"),
          mkTh("modTime", "最近更新")
        )),
        tbody
      )
    ));
  }

  function renderGallery(body, rows) {
    const grid = el("div", { class: "ic-board-gallery" });
    rows.forEach((row) => {
      const curSt = getRowStatus(row);
      const tone = STATUS_BADGE_TONE[curSt] || "is-slate";
      const tags = getRowTags(row);
      grid.appendChild(el("article", {
        class: "ic-board-gcard",
        onClick: () => onOpenNote?.(row.path),
        onContextMenu: (ev) => openRowContextMenu(ev, row),
      },
        el("div", { class: "ic-board-gcard-media" },
          row.coverImage
            ? el("img", { src: assetThumbUrl(row.coverImage, row.path), alt: row.title, loading: "lazy" })
            : el("div", { class: "ic-board-gcard-placeholder" }, row.title.slice(0, 2))
        ),
        el("div", { class: "ic-board-gcard-body" },
          el("div", { class: "row", style: { justifyContent: "space-between", gap: "6px" } },
            el("span", { class: `ic-board-status-pill ${tone}` }, curSt),
            el("span", { class: "muted mono", style: { fontSize: "11px" } }, `${row.wordCount} 字`)
          ),
          el("strong", { class: "ic-board-gcard-title" }, row.title),
          tags.length ? el("div", { class: "ic-board-card-tags" }, ...tags.slice(0, 3).map((t) => el("span", { class: "ic-board-tag" }, `#${t}`))) : null
        )
      ));
    });
    body.appendChild(grid);
  }

  function render(container, initOpts = null) {
    if (!container) return;
    hostEl = container;
    if (initOpts && typeof initOpts.dir === "string" && initOpts.dir !== state.dir) {
      state.dir = initOpts.dir;
      loadData();
    } else if (!state.rows.length && !state.loading) {
      loadData();
    }

    clear(container);

    // Collect all tags for quick filter strip
    const tagCounts = new Map();
    state.rows.forEach((r) => getRowTags(r).forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
    const topTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12);

    const dirList = getVaultDirs?.() || [];
    const dirSel = el("select", { class: "select ic-board-dir-sel", "aria-label": "筛选文件夹范围" },
      el("option", { value: "" }, "📂 全库文章"),
      ...dirList.map((d) => el("option", { value: d, selected: d === state.dir }, `📁 ${d}`))
    );
    dirSel.value = state.dir;
    dirSel.addEventListener("change", () => {
      state.dir = dirSel.value;
      loadData();
    });

    const searchIn = el("input", {
      type: "search",
      class: "input ic-board-search",
      value: state.query,
      placeholder: "搜索标题、标签或状态…",
    });
    searchIn.addEventListener("input", () => {
      state.query = searchIn.value;
      renderBodyOnly();
    });

    const viewSwitch = el("div", { class: "ic-article-segmented-switch", role: "group", "aria-label": "选题库视图切换" },
      ...[
        ["kanban", "📋 看板"],
        ["table", "⊞ 表格"],
        ["gallery", "🃏 画廊"],
      ].map(([k, lbl]) => el("button", {
        type: "button",
        class: "ic-article-seg-btn" + (state.view === k ? " is-active" : ""),
        onClick: () => { state.view = k; render(hostEl); },
      }, lbl))
    );

    const topBar = el("div", { class: "ic-board-bar" },
      el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => onExitBoard?.() }, "← 返回文章"),
        dirSel,
        viewSwitch,
        searchIn
      ),
      el("div", { class: "row", style: { gap: "6px" } },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => loadData() }, "↻ 刷新"),
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openNewTopicModal() }, "＋ 新建选题")
      )
    );

    const tagStrip = topTags.length ? el("div", { class: "ic-board-tag-strip" },
      el("button", {
        type: "button",
        class: "ic-board-tag-filter" + (!state.tagFilter ? " is-active" : ""),
        onClick: () => { state.tagFilter = ""; render(hostEl); },
      }, `全部 (${state.rows.length})`),
      ...topTags.map(([tag, cnt]) => el("button", {
        type: "button",
        class: "ic-board-tag-filter" + (state.tagFilter === tag ? " is-active" : ""),
        onClick: () => { state.tagFilter = state.tagFilter === tag ? "" : tag; render(hostEl); },
      }, `#${tag} (${cnt})`))
    ) : null;

    const body = el("div", { class: "ic-board-body" });
    const renderBodyOnly = () => {
      clear(body);
      const rows = filteredRows();
      if (!rows.length) {
        body.appendChild(el("div", { class: "ic-board-empty muted" },
          state.loading ? "正在扫描文章 YAML 属性…" : "当前筛选条件下暂无文章，点击右上角「＋ 新建选题」开始管理。"
        ));
        return;
      }
      if (state.view === "kanban") renderKanban(body, rows);
      else if (state.view === "table") renderTable(body, rows);
      else renderGallery(body, rows);
    };
    renderBodyOnly();

    container.append(topBar, tagStrip, body);
  }

  return {
    render,
    refresh: loadData,
    setDir: (d) => { state.dir = d || ""; },
  };
}
