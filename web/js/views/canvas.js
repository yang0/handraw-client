import { api, clear, closeModal, el, localImg, money, onEvent, packImg, showModal, toast } from "../api.js";
import { buildGroupedAIModelSelect, buildGroupedModelSelect } from "./create.js";
import {
  DEFAULT_MOODS,
  RATIOS,
  WHITESPACE_OPTIONS,
  openResourceDialog,
  resourceId,
  resourceName,
  studioMount,
} from "./studio-controls.js";

const PARAM_LABELS = {
  prompt: "主题",
  style1: "画风方案",
  layout: "图型",
  ratio: "比例",
  colors: "配色",
  tones: "影调",
  moods: "氛围",
  whitespace: "留白",
  mode: "创作模式",
};

const NODE_MENU_ENTRIES = [
  { type: "parameters", name: "出图参数", group: "生成流程", detail: "在一张卡里编辑主题、画风、图型和比例", out: true },
  { type: "output", name: "批量出图", group: "生成流程", detail: "接收参数，设置模型与每组出图张数", in: true },
  { type: "combine", name: "参数组合", group: "高级节点", detail: "把来自多条连线的参数合成出图方案", in: true, out: true },
  ...Object.entries(PARAM_LABELS).map(([parameter, name]) => ({
    type: "parameter",
    parameter,
    name,
    group: "单项参数",
    detail: `添加独立的「${name}」候选节点`,
    out: true,
  })),
];

function uid(prefix = "n") {
  return prefix + "_" + Math.random().toString(36).slice(2, 8);
}

function initialCandidate(field, catalog) {
  if (field === "style1") return catalog?.styles?.[0]?.number || "FA-013";
  if (field === "ratio") return "3:4";
  if (field === "mode") return "graphic-text";
  if (field === "whitespace") return "";
  if (field === "colors" || field === "tones" || field === "moods") return [];
  return "";
}

function defaultGraph(catalog) {
  const s1 = catalog?.styles?.[0]?.number || "FA-013";
  const s2 = catalog?.styles?.[1]?.number || "FB-001";
  return {
    format: 2,
    nodes: [
      {
        id: "params",
        type: "parameters",
        mode: "cartesian",
        x: 36,
        y: 36,
        fieldOrder: ["prompt", "style1", "layout", "ratio"],
        fields: {
          prompt: ["雨夜街角亮着暖灯的小书店", "周末草地上打盹的橘猫"],
          style1: [s1, s2],
          layout: [""],
          ratio: ["3:4"],
        },
      },
      {
        id: "output",
        type: "output",
        mode: "cartesian",
        repeat: 1,
        x: 492,
        y: 120,
      },
    ],
    edges: [{ id: "e_init", from: "params", to: "output" }],
  };
}

// Convert legacy client canvas nodes (themes/styles/recipe/generate/export) into parameter-canvas v2 nodes cleanly
function normalizeGraphData(raw, catalog, recipes) {
  const nodes = Array.isArray(raw?.nodes) ? structuredClone(raw.nodes) : [];
  const edges = Array.isArray(raw?.edges) ? structuredClone(raw.edges) : [];
  const hasV2 = nodes.some((n) => ["parameters", "parameter", "combine", "output"].includes(n.type));
  if (hasV2 || !nodes.length) {
    return {
      format: 2,
      nodes: nodes.length ? nodes : defaultGraph(catalog).nodes,
      edges: nodes.length ? edges : defaultGraph(catalog).edges,
    };
  }

  const migratedNodes = [];
  const idMap = new Map();
  for (const n of nodes) {
    if (n.type === "frame" || n.type === "export") continue;
    if (n.type === "themes") {
      migratedNodes.push({ id: n.id, type: "parameter", parameter: "prompt", values: n.data?.items?.length ? n.data.items : [""], x: n.x ?? 40, y: n.y ?? 40 });
    } else if (n.type === "styles") {
      migratedNodes.push({ id: n.id, type: "parameter", parameter: "style1", values: n.data?.items?.length ? n.data.items : ["FA-013"], x: n.x ?? 40, y: n.y ?? 260 });
    } else if (n.type === "recipe") {
      const rec = n.data?.recipeId ? recipes.find((r) => r.id === n.data.recipeId) : null;
      migratedNodes.push({
        id: n.id,
        type: "parameters",
        mode: "cartesian",
        x: n.x ?? 40,
        y: n.y ?? 360,
        fieldOrder: ["style1", "layout", "ratio"],
        fields: {
          style1: [rec?.styleIds?.[0] || n.data?.style || "FA-013"],
          layout: [rec?.layoutId || n.data?.layout || ""],
          ratio: [rec?.ratio || n.data?.ratio || "3:4"],
        },
      });
    } else if (n.type === "generate") {
      migratedNodes.push({
        id: n.id,
        type: "output",
        mode: "cartesian",
        repeat: 1,
        x: n.x ?? 440,
        y: n.y ?? 160,
        runId: n.data?.runId || "",
      });
    }
    idMap.set(n.id, n.id);
  }
  const migratedEdges = edges.filter((e) => idMap.has(e.from) && idMap.has(e.to));
  return {
    format: 2,
    nodes: migratedNodes.length ? migratedNodes : defaultGraph(catalog).nodes,
    edges: migratedEdges,
  };
}

export async function renderCanvas(host, ctx, params = {}) {
  host = studioMount(host);

  const [docsRes, tplRes, modRes, recRes, stylesRes, layoutsRes, colorsRes, tonesRes, worksRes] = await Promise.all([
    api("GET", "/api/docs/canvas").catch(() => ({ items: [] })),
    api("GET", "/api/docs/template").catch(() => ({ items: [], builtin: [] })),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [] })),
    api("GET", "/api/mine/recipes").catch(() => ({ items: [] })),
    api("GET", "/api/resources/styles").catch(() => ({ items: [] })),
    api("GET", "/api/resources/layouts").catch(() => ({ items: [] })),
    api("GET", "/api/resources/colors").catch(() => ({ items: [] })),
    api("GET", "/api/resources/tones").catch(() => ({ items: [] })),
    api("GET", "/api/works?mode=canvas&limit=10").catch(() => ({ items: [] })),
  ]);
  if (!host.isConnected) return;

  const catalog = {
    styles: stylesRes.items || [],
    layouts: layoutsRes.items || [],
    colors: colorsRes.items || [],
    tones: tonesRes.items || [],
  };
  let docs = docsRes.items || [];
  const builtins = tplRes.builtin || [];
  const userTpls = tplRes.items || [];
  const recipes = recRes.items || [];

  const root = el("div", { class: "creation-page creation-canvas" });
  host.appendChild(root);

  const state = {
    docId: params.docId || docs[0]?.id || "",
    name: docs[0]?.name || "参数组合画布",
    modelRef: modRes.defaultModel || "site:seedream-4.5",
    view: "free", // free | guided
    panX: 0,
    panY: 0,
    scale: 1,
    selectedId: "",
    selectedEdgeId: "",
    connectFrom: "",
    dirty: false,
    activePanel: "", // "" | "preview" | "history" | "output"
    outputNodeId: "",
    selectedOrdinals: new Set(),
    activeFieldTabs: new Map(),
    graph: defaultGraph(catalog),
    activeRun: worksRes.items?.[0] || null,
    recentRuns: worksRes.items || [],
    undoStack: [],
    redoStack: [],
  };
  let lastSnapshot = JSON.stringify({ name: state.name, graph: state.graph });

  function loadDocObj(doc) {
    state.docId = doc.id || "";
    state.name = doc.name || "未命名画布";
    const d = typeof doc.data === "string" ? JSON.parse(doc.data) : (doc.data || {});
    state.graph = normalizeGraphData(d, catalog, recipes);
    if (typeof d.panX === "number") state.panX = d.panX;
    if (typeof d.panY === "number") state.panY = d.panY;
    if (typeof d.scale === "number") state.scale = d.scale;
    if (d.view === "guided" && canGuide()) state.view = "guided";
    else state.view = "free";
    state.dirty = false;
    state.undoStack = [];
    state.redoStack = [];
    lastSnapshot = JSON.stringify({ name: state.name, graph: state.graph });
  }

  if (state.docId) {
    try {
      const got = await api("GET", `/api/docs/canvas/${encodeURIComponent(state.docId)}`);
      if (got.doc) loadDocObj(got.doc);
    } catch {}
  }

  function recordEdit(reRender = false) {
    const snap = JSON.stringify({ name: state.name, graph: state.graph });
    if (snap !== lastSnapshot) {
      state.undoStack.push(lastSnapshot);
      if (state.undoStack.length > 40) state.undoStack.shift();
      state.redoStack = [];
      lastSnapshot = snap;
      state.dirty = true;
    }
    updateStatusAndSummaries();
    if (reRender) renderWorkspace();
  }

  function undo() {
    if (!state.undoStack.length) return;
    state.redoStack.push(JSON.stringify({ name: state.name, graph: state.graph }));
    const prev = JSON.parse(state.undoStack.pop());
    state.name = prev.name;
    state.graph = prev.graph;
    lastSnapshot = JSON.stringify(prev);
    state.dirty = true;
    renderWorkspace();
  }

  function redo() {
    if (!state.redoStack.length) return;
    state.undoStack.push(JSON.stringify({ name: state.name, graph: state.graph }));
    const next = JSON.parse(state.redoStack.pop());
    state.name = next.name;
    state.graph = next.graph;
    lastSnapshot = JSON.stringify(next);
    state.dirty = true;
    renderWorkspace();
  }

  // Graph matching & Cartesian / Zip engine
  function upstreamSources(nodeId, visited = new Set()) {
    if (visited.has(nodeId)) return [];
    visited.add(nodeId);
    const inEdges = state.graph.edges.filter((e) => e.to === nodeId);
    const list = [];
    for (const edge of inEdges) {
      const src = state.graph.nodes.find((n) => n.id === edge.from);
      if (!src) continue;
      if (src.type === "parameter") {
        list.push({
          field: src.parameter,
          name: PARAM_LABELS[src.parameter] || src.parameter,
          values: Array.isArray(src.values) ? src.values : [""],
        });
      } else if (src.type === "parameters") {
        const order = src.fieldOrder || Object.keys(src.fields || {});
        const fieldSources = order
          .filter((f) => Object.hasOwn(src.fields || {}, f))
          .map((f) => ({ field: f, name: PARAM_LABELS[f] || f, values: src.fields[f] || [] }));
        const combined = expandSourceList(fieldSources, src.mode || "cartesian");
        list.push({
          combinedRows: combined.rows,
          count: combined.rows.length,
          name: "出图参数",
          error: combined.error || "",
          mode: src.mode || "cartesian",
          fieldCountSummary: fieldSources.filter((s) => (s.values || []).length > 1).map((s) => `${s.values.length} 个${s.name}`),
        });
      } else if (src.type === "combine") {
        const up = upstreamSources(src.id, visited);
        const expanded = expandRowsFromSources(up, src.mode || "cartesian");
        list.push({
          combinedRows: expanded.rows,
          count: expanded.rows.length,
          name: "上游组合",
          error: expanded.error || "",
          mode: src.mode || "cartesian",
        });
      }
    }
    return list;
  }

  function expandSourceList(sources, mode = "cartesian") {
    const clean = sources.filter((s) => (s.values || []).length > 0);
    return { sources: clean, ...expandRowsFromSources(clean, mode) };
  }

  function expandRowsFromSources(sources, mode = "cartesian") {
    if (!sources.length) return { rows: [], error: "请连接上游参数节点，或添加候选值", count: 0 };
    const normalized = sources.map((s) => {
      if (s.combinedRows) return s.combinedRows;
      return (s.values || []).map((val) => ({ [s.field]: val }));
    });
    const lengths = normalized.map((arr) => arr.length);
    const longest = Math.max(1, ...lengths);
    if (mode === "zip") {
      if (lengths.some((len) => len !== 1 && len !== longest)) {
        return { rows: [], error: "按顺序配对时，各多项参数的候选数需一致（仅 1 项的参数会复用）", count: 0 };
      }
      const rows = [];
      for (let i = 0; i < longest; i++) {
        const merged = {};
        normalized.forEach((arr) => Object.assign(merged, arr[arr.length === 1 ? 0 : i]));
        rows.push(merged);
      }
      return { rows, error: "", count: rows.length };
    }
    // cartesian
    let rows = [{}];
    for (const arr of normalized) {
      const next = [];
      for (const base of rows) {
        for (const piece of arr) {
          next.push({ ...base, ...piece });
        }
      }
      rows = next;
      if (rows.length > 200) {
        return { rows: rows.slice(0, 200), error: "组合数已超 200 张上限，请适当精简候选数量", count: rows.length };
      }
    }
    return { rows, error: "", count: rows.length };
  }

  function rowToGenerateItem(row) {
    const s1 = typeof row.style1 === "object" && row.style1 ? (row.style1.style1 || "") : (row.style1 || "FA-013");
    const s2 = typeof row.style1 === "object" && row.style1 ? (row.style1.style2 || "") : "";
    const color = Array.isArray(row.colors) ? (row.colors[0] || "") : (row.colors || "");
    const tone = Array.isArray(row.tones) ? (row.tones[0] || "") : (row.tones || "");
    const mood = Array.isArray(row.moods) ? row.moods.join("，") : (row.moods || "");
    const ws = row.whitespace || "";
    const mode = row.mode || "graphic-text";
    const extraParts = [];
    if (ws) extraParts.push(`留白程度：${({ normal: "正常", moderate: "适中", high: "大量" })[ws] || ws}`);
    if (mode === "poster") extraParts.push("海报设计，文字参与构图，突出主标题与视觉层级。");
    return {
      theme: String(row.prompt || "").trim() || "手绘视觉主题展示",
      style: s1,
      style2: s2,
      layout: row.layout || "",
      color,
      tone,
      mood,
      ratio: row.ratio || "3:4",
      mode,
      extra: extraParts.join("\n"),
    };
  }

  function expandOutputNode(outNode) {
    if (!outNode) return { items: [], rows: [], error: "请添加「批量出图」节点", count: 0, formula: "" };
    const sources = upstreamSources(outNode.id);
    if (!sources.length) {
      return { items: [], rows: [], error: "请将左侧参数节点的右侧输出锚点连接到这里", count: 0, formula: "" };
    }
    const errSource = sources.find((s) => s.error);
    if (errSource) return { items: [], rows: [], error: errSource.error, count: 0, formula: "" };
    const mode = sources.length === 1 ? "cartesian" : (outNode.mode || "cartesian");
    const expanded = expandRowsFromSources(sources, mode);
    if (expanded.error) return { items: [], rows: [], error: expanded.error, count: expanded.count, formula: "" };
    const repeat = Math.max(1, Math.min(200, Number(outNode.repeat ?? 1)));
    const rows = [];
    for (const row of expanded.rows) {
      for (let r = 0; r < repeat; r++) rows.push(row);
    }
    if (rows.length > 200) {
      return { items: [], rows: [], error: `总计 ${rows.length} 张，超过单批 200 张上限`, count: rows.length, formula: "" };
    }
    let formula = "";
    if (sources.length === 1 && sources[0].combinedRows) {
      const s0 = sources[0];
      formula = s0.mode === "zip"
        ? `按顺序配对 ${s0.count} 组 × 每组 ${repeat} 张`
        : `${s0.fieldCountSummary?.length ? s0.fieldCountSummary.join(" × ") : `${s0.count} 组`} × 每组 ${repeat} 张`;
    } else {
      const terms = sources.map((s) => (s.combinedRows ? `${s.count} 组` : `${(s.values || []).length} 个${s.name}`));
      formula = `${terms.join(" × ")} × 每组 ${repeat} 张`;
    }
    const items = rows.map(rowToGenerateItem);
    return { items, rows, error: "", count: items.length, formula };
  }

  function simpleFlow() {
    const out = state.graph.nodes.find((n) => n.type === "output");
    const group = state.graph.nodes.find((n) => n.type === "parameters");
    if (!out || !group) return null;
    if (!state.graph.edges.some((e) => e.from === group.id && e.to === out.id)) return null;
    return { group, output: out };
  }
  function canGuide() {
    return Boolean(simpleFlow());
  }

  function formatValueSummary(field, val) {
    if (field === "style1") {
      if (typeof val === "object" && val) {
        const n1 = resourceName(catalog.styles.find((s) => s.number === val.style1)) || val.style1;
        const n2 = val.style2 ? resourceName(catalog.styles.find((s) => s.number === val.style2)) || val.style2 : "";
        return { text: n2 ? `${val.style1} + ${val.style2}` : `${val.style1} ${n1}`, img: catalog.styles.find((s) => s.number === val.style1)?.image || "" };
      }
      const st = catalog.styles.find((s) => s.number === val);
      return { text: val ? `${val} ${st ? resourceName(st) : ""}`.trim() : "", img: st?.image || "" };
    }
    if (field === "layout") {
      const l = catalog.layouts.find((x) => resourceId(x) === val);
      return { text: val ? `${val} ${l ? resourceName(l) : ""}`.trim() : "", img: l?.image || "" };
    }
    if (field === "colors") {
      const list = Array.isArray(val) ? val : [val].filter(Boolean);
      const c = catalog.colors.find((x) => resourceId(x) === list[0]);
      return { text: list.join(" / "), img: c?.image || "" };
    }
    if (field === "tones") {
      const list = Array.isArray(val) ? val : [val].filter(Boolean);
      const t = catalog.tones.find((x) => resourceId(x) === list[0]);
      return { text: list.join(" / "), img: t?.image || "" };
    }
    if (field === "mode") {
      return { text: ({ "pure-image": "纯图", "graphic-text": "图文", poster: "海报" })[val] || val, img: "" };
    }
    if (field === "whitespace") {
      return { text: ({ "": "不限", normal: "正常留白", moderate: "适中留白", high: "大量留白" })[val] || val, img: "" };
    }
    if (Array.isArray(val)) return { text: val.join("、"), img: "" };
    return { text: String(val || ""), img: "" };
  }

  // Header & Toolbar
  const recentBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    "aria-expanded": "false",
    onClick: (e) => {
      e.stopPropagation();
      const wrap = recentBtn.closest(".pc-open-canvases");
      const open = !wrap.classList.contains("is-open");
      wrap.classList.toggle("is-open", open);
      recentBtn.setAttribute("aria-expanded", String(open));
      if (open) renderRecentMenu();
    },
  }, "📂 打开画布 ⌄");
  const recentList = el("div", { class: "pc-recent-list", role: "menu" });
  const recentWrap = el("div", { class: "pc-open-canvases" }, recentBtn, recentList);

  function renderRecentMenu() {
    clear(recentList);
    recentList.appendChild(el("span", { class: "muted", style: { padding: "4px 8px", fontSize: "11px" } }, `已保存画布 (${docs.length})`));
    if (!docs.length) {
      recentList.appendChild(el("span", { class: "muted", style: { padding: "8px" } }, "暂无已保存画布"));
      return;
    }
    docs.forEach((d) => {
      recentList.appendChild(el("button", {
        type: "button",
        role: "menuitem",
        onClick: async () => {
          recentWrap.classList.remove("is-open");
          recentBtn.setAttribute("aria-expanded", "false");
          try {
            const r = await api("GET", `/api/docs/canvas/${encodeURIComponent(d.id)}`);
            if (r.doc) { loadDocObj(r.doc); renderWorkspace(); }
          } catch (err) { toast(err.message); }
        },
      }, el("strong", null, d.name || d.id), el("small", null, String(d.updatedAt || "").slice(0, 10) || "本地保存")));
    });
  }

  const statusSpan = el("span", { dataset: { pcStatus: "1" }, role: "status" }, "已就绪");
  const viewSwitchBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: () => {
      if (state.view === "free" && !canGuide()) {
        toast("当前使用自定义多节点连线，可在引导视图查看主参数流程");
        return;
      }
      state.view = state.view === "guided" ? "free" : "guided";
      renderWorkspace();
    },
  }, "引导视图");
  const addNodeBtn = el("button", { type: "button", class: "btn btn-sm", onClick: openAddNodeDialog }, "＋ 添加节点");
  const historyBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: () => {
      state.activePanel = state.activePanel === "history" ? "" : "history";
      renderDrawer();
    },
  }, "出图历史");
  const previewBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: () => {
      state.activePanel = state.activePanel === "preview" ? "" : "preview";
      renderDrawer();
    },
  }, "预览清单");
  const runAllBtn = el("button", {
    type: "button",
    class: "btn btn-sm btn-primary",
    onClick: () => runOutputNode(primaryOutputNode(), false),
  }, "▶ 运行生成");

  const headerBar = el("header", { class: "pc-header" },
    el("div", { class: "pc-document-actions", role: "toolbar", "aria-label": "画布文档" },
      el("button", { type: "button", class: "btn btn-sm", onClick: newCanvas }, "＋ 新建画布"),
      el("button", { type: "button", class: "btn btn-sm", onClick: openSaveDialog }, "💾 保存"),
      recentWrap,
      el("button", { type: "button", class: "btn btn-sm", onClick: openTemplatesModal }, "📐 模板库"),
      el("button", { type: "button", class: "btn btn-sm", onClick: openAssistantModal }, "✨ AI 助手"),
      el("button", { type: "button", class: "btn btn-sm", onClick: syncCanvas }, "☁ 同步")
    ),
    el("div", { class: "pc-toolbar" },
      statusSpan,
      viewSwitchBtn,
      addNodeBtn,
      historyBtn,
      previewBtn,
      runAllBtn
    )
  );

  // Floating Undo / Redo / Zoom + Wire Bar
  const undoBtn = el("button", { type: "button", class: "pc-floating-btn", title: "撤销 (Ctrl+Z)", onClick: undo }, "↶");
  const redoBtn = el("button", { type: "button", class: "pc-floating-btn", title: "重做 (Ctrl+Y)", onClick: redo }, "↷");
  const zoomResetBtn = el("button", {
    type: "button",
    class: "pc-floating-btn",
    title: "重置视角",
    onClick: () => { state.panX = 0; state.panY = 0; state.scale = 1; applyTransform(); },
  }, "100%");
  const floatingControls = el("div", { class: "pc-floating-history" }, undoBtn, redoBtn, zoomResetBtn);

  const edgeActionsBar = el("div", { class: "pc-edge-actions", hidden: true },
    el("span", null, "已选中连线"),
    el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: deleteSelectedEdge }, "删除连线"),
    el("button", { type: "button", class: "btn btn-sm", onClick: () => { state.selectedEdgeId = ""; drawEdges(); } }, "取消")
  );
  const wireHint = el("p", { class: "pc-wire-hint", "aria-live": "polite" }, "拖动空白区域平移 · 滚轮缩放 · 点击节点右侧圆点连向左侧圆点 · 点击连线可删除");

  // Canvas Board & World
  const svgNS = "http://www.w3.org/2000/svg";
  const edgeSvg = document.createElementNS(svgNS, "svg");
  edgeSvg.setAttribute("class", "pc-edges");
  const nodesLayer = el("div");
  const world = el("div", { class: "pc-world" }, edgeSvg, nodesLayer);
  const scrollBoard = el("div", { class: "pc-scroll", tabindex: "0", "aria-label": "参数节点画布" }, world);
  const guidedContainer = el("div", { class: "pc-guided-body hidden" });

  // Right Drawer
  const drawerTitle = el("h2", null, "预览清单");
  const drawerBody = el("div", { class: "pc-drawer-body" });
  const drawerEl = el("aside", { class: "pc-drawer", hidden: true },
    el("div", { class: "pc-drawer-header" },
      drawerTitle,
      el("button", { type: "button", class: "icon-btn", "aria-label": "收起面板", onClick: () => { state.activePanel = ""; renderDrawer(); } }, "✕")
    ),
    drawerBody
  );

  const workspaceArea = el("div", { class: "pc-workspace" },
    floatingControls,
    edgeActionsBar,
    scrollBoard,
    guidedContainer,
    wireHint,
    drawerEl
  );

  root.appendChild(el("div", { class: "pc-stage" }, headerBar, workspaceArea));

  // Global dismiss & keyboard shortcuts
  const onDocClick = (e) => {
    if (!recentWrap.contains(e.target)) {
      recentWrap.classList.remove("is-open");
      recentBtn.setAttribute("aria-expanded", "false");
    }
  };
  document.addEventListener("click", onDocClick);

  root.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); redo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && state.selectedEdgeId) { e.preventDefault(); deleteSelectedEdge(); }
    else if (e.key === "Escape") { state.connectFrom = ""; state.selectedEdgeId = ""; drawEdges(); updatePortsHighlight(); }
  });

  // Pan & zoom on scrollBoard
  let panning = null;
  scrollBoard.addEventListener("pointerdown", (e) => {
    if (e.target !== scrollBoard && e.target !== world && e.target !== edgeSvg) return;
    state.selectedId = "";
    state.selectedEdgeId = "";
    state.connectFrom = "";
    drawEdges();
    updatePortsHighlight();
    panning = { sx: e.clientX, sy: e.clientY, px: state.panX, py: state.panY };
    scrollBoard.classList.add("is-panning");
    scrollBoard.setPointerCapture(e.pointerId);
  });
  scrollBoard.addEventListener("pointermove", (e) => {
    if (!panning) return;
    state.panX = panning.px + (e.clientX - panning.sx);
    state.panY = panning.py + (e.clientY - panning.sy);
    applyTransform();
  });
  scrollBoard.addEventListener("pointerup", () => {
    panning = null;
    scrollBoard.classList.remove("is-panning");
  });
  scrollBoard.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.07 : 0.93;
    state.scale = Math.max(0.45, Math.min(1.8, state.scale * factor));
    applyTransform();
  }, { passive: false });

  function applyTransform() {
    world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    zoomResetBtn.textContent = `${Math.round(state.scale * 100)}%`;
  }

  function primaryOutputNode() {
    return state.graph.nodes.find((n) => n.id === state.selectedId && n.type === "output")
      || state.graph.nodes.find((n) => n.type === "output");
  }

  function deleteSelectedEdge() {
    if (!state.selectedEdgeId) return;
    state.graph.edges = state.graph.edges.filter((e) => e.id !== state.selectedEdgeId);
    state.selectedEdgeId = "";
    recordEdit(true);
  }

  function canConnect(fromId, toId) {
    if (fromId === toId) return "不能连接自身";
    const fromNode = state.graph.nodes.find((n) => n.id === fromId);
    const toNode = state.graph.nodes.find((n) => n.id === toId);
    if (!fromNode || !toNode) return "节点不存在";
    if (fromNode.type === "output" || toNode.type === "parameter" || toNode.type === "parameters") return "只能从参数/组合右侧连接到组合/出图左侧";
    if (state.graph.edges.some((e) => e.from === fromId && e.to === toId)) return "连线已存在";
    // Cycle detection
    const stack = [toId];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (cur === fromId) return "连线会形成闭环";
      if (seen.has(cur)) continue;
      seen.add(cur);
      state.graph.edges.filter((e) => e.from === cur).forEach((e) => stack.push(e.to));
    }
    return "";
  }

  function portPosition(nodeId, direction) {
    const card = nodesLayer.querySelector(`[data-card="${nodeId}"]`);
    const port = card?.querySelector(`[data-port="${direction}"]`);
    if (port && card) {
      return {
        x: (card.offsetLeft + port.offsetLeft + port.offsetWidth / 2),
        y: (card.offsetTop + port.offsetTop + port.offsetHeight / 2),
      };
    }
    const n = state.graph.nodes.find((x) => x.id === nodeId);
    if (!n) return { x: 0, y: 0 };
    const w = n.type === "parameters" ? 390 : 290;
    return { x: (n.x || 0) + (direction === "out" ? w : 0), y: (n.y || 0) + 60 };
  }

  function drawEdges() {
    while (edgeSvg.firstChild) edgeSvg.removeChild(edgeSvg.firstChild);
    for (const edge of state.graph.edges) {
      const a = portPosition(edge.from, "out");
      const b = portPosition(edge.to, "in");
      const bend = Math.max(45, Math.abs(b.x - a.x) * 0.45);
      const d = `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("class", "pc-wire" + (state.selectedEdgeId === edge.id ? " is-selected" : ""));
      const line = document.createElementNS(svgNS, "path");
      line.setAttribute("class", "pc-wire-line");
      line.setAttribute("d", d);
      const hit = document.createElementNS(svgNS, "path");
      hit.setAttribute("class", "pc-wire-hit");
      hit.setAttribute("d", d);
      hit.addEventListener("click", (e) => {
        e.stopPropagation();
        state.selectedEdgeId = state.selectedEdgeId === edge.id ? "" : edge.id;
        drawEdges();
      });
      g.append(line, hit);
      edgeSvg.appendChild(g);
    }
    edgeActionsBar.hidden = !state.selectedEdgeId;
  }

  function updatePortsHighlight() {
    nodesLayer.querySelectorAll("[data-port]").forEach((p) => {
      const nid = p.dataset.node;
      const dir = p.dataset.port;
      p.setAttribute("aria-pressed", String(dir === "out" && state.connectFrom === nid));
      p.classList.toggle("is-available", Boolean(state.connectFrom && dir === "in" && !canConnect(state.connectFrom, nid)));
    });
  }

  // Render Parameter Editor (used inside both Parameters Group card and single Parameter node)
  function renderFieldEditor(node, fieldName, values) {
    const wrap = el("div", { class: "col", style: { gap: "8px" } });

    values.forEach((val, idx) => {
      const card = el("div", { class: "pc-candidate" });
      card.appendChild(el("div", { class: "pc-candidate-heading" },
        el("span", null, `${PARAM_LABELS[fieldName] || fieldName} ${idx + 1}`),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          style: { padding: "1px 6px", fontSize: "10.5px" },
          onClick: () => {
            if (values.length === 1) values[0] = initialCandidate(fieldName, catalog);
            else values.splice(idx, 1);
            recordEdit(true);
          },
        }, "移除")
      ));

      if (fieldName === "prompt") {
        const ta = el("textarea", { class: "textarea", rows: "2", style: { minHeight: "56px", fontSize: "12.5px" }, placeholder: "描述想要画的主题内容，如：雨夜书店窗边的猫…" });
        ta.value = String(val || "");
        ta.addEventListener("input", () => { values[idx] = ta.value; recordEdit(false); });
        card.appendChild(ta);
      } else if (fieldName === "style1") {
        const pair = typeof val === "object" && val ? { ...val } : { style1: String(val || ""), style2: "" };
        const makeStyleCard = (subKey, lbl) => {
          const code = pair[subKey] || "";
          const obj = catalog.styles.find((s) => s.number === code);
          return el("button", {
            type: "button",
            class: "make-image-picker-card" + (code ? " is-selected" : ""),
            style: { minHeight: "56px", padding: "6px 8px" },
            onClick: () => {
              openResourceDialog(lbl, catalog.styles, code, (picked) => {
                pair[subKey] = picked;
                values[idx] = !pair.style1 ? "" : (pair.style2 ? pair : pair.style1);
                recordEdit(true);
              }, { empty: subKey === "style2" ? "不融合第二画风" : "" });
            },
          },
          el("div", { class: "make-image-picker-thumb", style: { width: "34px", height: "38px", flexBasis: "34px" } },
            obj?.image ? el("img", { src: packImg(obj.image), alt: "" }) : el("span", { class: "make-image-picker-placeholder" }, "＋")
          ),
          el("div", { class: "make-image-picker-info" },
            el("span", { class: "make-image-picker-badge" }, code ? `${lbl} · ${code}` : lbl),
            el("strong", { class: "make-image-picker-name" }, obj ? resourceName(obj) : (subKey === "style2" ? "可选融合副画风" : "点击选择画风"))
          ));
        };
        card.appendChild(makeStyleCard("style1", "主画风"));
        if (pair.style1) card.appendChild(makeStyleCard("style2", "融合副画风"));
      } else if (fieldName === "layout") {
        const code = String(val || "");
        const obj = catalog.layouts.find((l) => resourceId(l) === code);
        card.appendChild(el("button", {
          type: "button",
          class: "make-image-picker-card" + (code ? " is-selected" : ""),
          style: { minHeight: "56px", padding: "6px 8px" },
          onClick: () => {
            openResourceDialog("图型", catalog.layouts, code, (picked) => {
              values[idx] = picked;
              recordEdit(true);
            }, { empty: "自由构图" });
          },
        },
        el("div", { class: "make-image-picker-thumb", style: { width: "34px", height: "38px", flexBasis: "34px" } },
          obj?.image ? el("img", { src: packImg(obj.image), alt: "" }) : el("span", { class: "make-image-picker-placeholder" }, "＋")
        ),
        el("div", { class: "make-image-picker-info" },
          el("span", { class: "make-image-picker-badge" }, code ? `图型 · ${code}` : "图型"),
          el("strong", { class: "make-image-picker-name" }, obj ? resourceName(obj) : "自由构图（点击挑选）")
        )));
      } else if (fieldName === "ratio") {
        const inp = el("input", { class: "input", style: { fontSize: "12px", fontFamily: "var(--font-mono)" }, value: String(val || "3:4"), placeholder: "如 3:4 或 16:9" });
        inp.addEventListener("input", () => { values[idx] = inp.value.trim(); recordEdit(false); });
        const pills = el("div", { class: "row", style: { gap: "4px", flexWrap: "wrap" } },
          ...RATIOS.slice(0, 5).map(([rv, rl]) => el("button", {
            type: "button",
            class: "btn btn-sm" + (val === rv ? " btn-primary" : ""),
            style: { padding: "2px 7px", fontSize: "11px" },
            onClick: () => { values[idx] = rv; recordEdit(true); },
          }, `${rl} ${rv}`))
        );
        card.append(pills, inp);
      } else if (fieldName === "mode") {
        card.appendChild(el("div", { class: "row", style: { gap: "5px", flexWrap: "wrap" } },
          ...[["graphic-text", "图文"], ["pure-image", "纯图"], ["poster", "海报"]].map(([mv, ml]) => el("button", {
            type: "button",
            class: "btn btn-sm" + (val === mv ? " btn-primary" : ""),
            onClick: () => { values[idx] = mv; recordEdit(true); },
          }, ml))
        ));
      } else if (fieldName === "whitespace") {
        card.appendChild(el("div", { class: "row", style: { gap: "5px", flexWrap: "wrap" } },
          ...WHITESPACE_OPTIONS.map(([wv, wl]) => el("button", {
            type: "button",
            class: "btn btn-sm" + ((val || "") === wv ? " btn-primary" : ""),
            onClick: () => { values[idx] = wv; recordEdit(true); },
          }, wl))
        ));
      } else if (fieldName === "colors" || fieldName === "tones") {
        const list = Array.isArray(val) ? val : [val].filter(Boolean);
        const catalogList = fieldName === "colors" ? catalog.colors : catalog.tones;
        const first = catalogList.find((x) => resourceId(x) === list[0]);
        card.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => {
            openResourceDialog(PARAM_LABELS[fieldName], catalogList, list[0] || "", (picked) => {
              values[idx] = picked ? [picked] : [];
              recordEdit(true);
            }, { empty: "不指定" });
          },
        }, list[0] ? `${list[0]} ${first ? resourceName(first) : ""}（更换）` : `＋ 选择${PARAM_LABELS[fieldName]}`));
      } else if (fieldName === "moods") {
        const list = Array.isArray(val) ? val : [val].filter(Boolean);
        card.appendChild(el("div", { class: "row", style: { gap: "4px", flexWrap: "wrap" } },
          ...DEFAULT_MOODS.map((m) => el("button", {
            type: "button",
            class: "btn btn-sm studio-chip-btn" + (list.includes(m) ? " btn-primary" : ""),
            onClick: () => {
              values[idx] = list.includes(m) ? list.filter((x) => x !== m) : [...list, m];
              recordEdit(true);
            },
          }, m))
        ));
      }

      wrap.appendChild(card);
    });

    wrap.appendChild(el("button", {
      type: "button",
      class: "pc-add-candidate",
      onClick: () => {
        values.push(initialCandidate(fieldName, catalog));
        recordEdit(true);
      },
    }, `＋ 添加${PARAM_LABELS[fieldName] || fieldName}候选`));

    return wrap;
  }

  function buildMatchingBlock(node, isGuided = false) {
    const outInfo = node.type === "output" ? expandOutputNode(node) : null;
    const sources = node.type === "parameters"
      ? (node.fieldOrder || Object.keys(node.fields || {})).filter((f) => Object.hasOwn(node.fields || {}, f)).map((f) => ({
          field: f, name: PARAM_LABELS[f] || f, values: node.fields[f] || [],
        }))
      : upstreamSources(node.id);
    const expanded = expandRowsFromSources(sources, node.mode || "cartesian");
    const box = el("div", { class: "pc-matching-preview" });

    if (expanded.error) {
      box.appendChild(el("p", { class: "badge badge-warn" }, expanded.error));
      return box;
    }

    const varying = sources.filter((s) => (s.values?.length || s.count || 0) > 1);
    if (varying.length > 1 || node.type === "parameters" || node.type === "combine") {
      const cart = expandRowsFromSources(sources, "cartesian");
      const zip = expandRowsFromSources(sources, "zip");
      const curMode = node.mode || "cartesian";
      box.appendChild(el("div", { class: "pc-match-choices", role: "group", "aria-label": "搭配方式" },
        el("button", {
          type: "button",
          "aria-pressed": String(curMode === "cartesian"),
          onClick: () => { node.mode = "cartesian"; recordEdit(true); },
        }, el("strong", null, "逐个交叉搭配"), el("span", null, `共 ${cart.count} 组`)),
        el("button", {
          type: "button",
          "aria-pressed": String(curMode === "zip"),
          onClick: () => { node.mode = "zip"; recordEdit(true); },
        }, el("strong", null, "按顺序一一配对"), el("span", null, zip.error ? "数量不同需对齐" : `共 ${zip.count} 组`))
      ));
    }

    const sampleRows = (outInfo ? outInfo.rows : expanded.rows).slice(0, isGuided ? 6 : 3);
    if (sampleRows.length) {
      box.appendChild(el("span", { class: "muted", style: { fontSize: "11px" } }, `预览组合 (${(outInfo ? outInfo.count : expanded.count)} 项)：`));
      const ol = el("ol", { class: "pc-match-examples" });
      sampleRows.forEach((row, idx) => {
        const li = el("li", null, el("span", { class: "muted mono" }, `${idx + 1}.`));
        const valsWrap = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", minWidth: "0" } });
        Object.keys(PARAM_LABELS).forEach((fk) => {
          if (!Object.hasOwn(row, fk)) return;
          const info = formatValueSummary(fk, row[fk]);
          if (!info.text) return;
          valsWrap.appendChild(el("span", { style: { display: "inline-flex", alignItems: "center", gap: "3px" } },
            info.img ? el("img", { src: packImg(info.img), alt: "" }) : null,
            info.text.slice(0, 26)
          ));
        });
        li.appendChild(valsWrap);
        ol.appendChild(li);
      });
      box.appendChild(ol);
    }
    return box;
  }

  function renderNodeCard(node, guidedMode = false) {
    const titleText = node.type === "parameters" ? "出图参数"
      : node.type === "parameter" ? (PARAM_LABELS[node.parameter] || node.parameter)
      : node.type === "combine" ? "参数组合"
      : "批量出图";

    const card = el("section", {
      class: "pc-node" + (node.type === "parameters" ? " pc-parameter-group" : "") + (guidedMode ? " pc-parameter-guided" : "") + (state.selectedId === node.id ? " is-selected" : ""),
      dataset: { card: node.id },
      style: guidedMode ? {} : { left: `${node.x || 36}px`, top: `${node.y || 36}px` },
    });

    if (!guidedMode) {
      const hasIn = node.type === "output" || node.type === "combine";
      const hasOut = node.type !== "output";
      if (hasIn) {
        const inPort = el("button", {
          type: "button",
          class: "pc-port pc-port-in" + (state.graph.edges.some((e) => e.to === node.id) ? " is-linked" : ""),
          dataset: { port: "in", node: node.id },
          title: "输入锚点",
          "aria-label": `${titleText}输入锚点`,
          onClick: (e) => {
            e.stopPropagation();
            if (!state.connectFrom) return toast("请先点击上游节点右侧的输出圆点");
            const err = canConnect(state.connectFrom, node.id);
            if (err) return toast(err);
            state.graph.edges.push({ id: uid("edge"), from: state.connectFrom, to: node.id });
            state.connectFrom = "";
            recordEdit(true);
          },
        }, el("span"));
        card.appendChild(inPort);
      }
      if (hasOut) {
        const outPort = el("button", {
          type: "button",
          class: "pc-port pc-port-out" + (state.graph.edges.some((e) => e.from === node.id) ? " is-linked" : ""),
          dataset: { port: "out", node: node.id },
          title: "输出锚点：点击开始连线",
          "aria-label": `${titleText}输出锚点`,
          onClick: (e) => {
            e.stopPropagation();
            state.connectFrom = state.connectFrom === node.id ? "" : node.id;
            updatePortsHighlight();
          },
        }, el("span"));
        card.appendChild(outPort);
      }
    }

    const head = el("header", null,
      el("strong", null, titleText),
      el("button", {
        type: "button",
        class: "icon-btn",
        style: { width: "24px", height: "24px" },
        title: "移除节点",
        "aria-label": `移除${titleText}`,
        onClick: (e) => {
          e.stopPropagation();
          state.graph.nodes = state.graph.nodes.filter((n) => n.id !== node.id);
          state.graph.edges = state.graph.edges.filter((ed) => ed.from !== node.id && ed.to !== node.id);
          if (state.view === "guided" && !canGuide()) state.view = "free";
          recordEdit(true);
        },
      }, "×")
    );

    if (!guidedMode) {
      head.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        e.stopPropagation();
        state.selectedId = node.id;
        const sx = e.clientX, sy = e.clientY, ox = node.x || 0, oy = node.y || 0;
        const onMove = (me) => {
          node.x = Math.round(ox + (me.clientX - sx) / state.scale);
          node.y = Math.round(oy + (me.clientY - sy) / state.scale);
          card.style.left = `${node.x}px`;
          card.style.top = `${node.y}px`;
          drawEdges();
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          recordEdit(false);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    }

    const body = el("div", { class: "pc-node-body" });

    if (node.type === "parameters") {
      const order = (node.fieldOrder || Object.keys(node.fields || {})).filter((f) => Object.hasOwn(node.fields || {}, f));
      const activeField = order.includes(state.activeFieldTabs.get(node.id)) ? state.activeFieldTabs.get(node.id) : (order[0] || "prompt");
      state.activeFieldTabs.set(node.id, activeField);

      const tabsBar = el("div", { class: "pc-field-tabs" },
        ...order.map((f) => el("button", {
          type: "button",
          "aria-pressed": String(f === activeField),
          onClick: () => { state.activeFieldTabs.set(node.id, f); renderWorkspace(); },
        }, `${PARAM_LABELS[f] || f}${node.fields[f]?.length > 1 ? ` (${node.fields[f].length})` : ""}`))
      );

      const avail = Object.keys(PARAM_LABELS).filter((f) => !order.includes(f));
      if (avail.length) {
        tabsBar.appendChild(el("details", { class: "pc-field-menu" },
          el("summary", null, "＋ 参数"),
          el("div", null,
            ...avail.map((f) => el("button", {
              type: "button",
              onClick: () => {
                node.fields[f] = [initialCandidate(f, catalog)];
                node.fieldOrder = [...order, f];
                state.activeFieldTabs.set(node.id, f);
                recordEdit(true);
              },
            }, PARAM_LABELS[f]))
          )
        ));
      }
      body.appendChild(tabsBar);
      if (Object.hasOwn(node.fields || {}, activeField)) {
        body.appendChild(renderFieldEditor(node, activeField, node.fields[activeField]));
        if (order.length > 1 && activeField !== "prompt") {
          body.appendChild(el("button", {
            type: "button",
            class: "btn btn-sm",
            style: { alignSelf: "flex-end" },
            onClick: () => {
              delete node.fields[activeField];
              node.fieldOrder = order.filter((f) => f !== activeField);
              recordEdit(true);
            },
          }, `移除「${PARAM_LABELS[activeField]}」`));
        }
      }
      if (!guidedMode) body.appendChild(buildMatchingBlock(node));
    } else if (node.type === "parameter") {
      body.appendChild(renderFieldEditor(node, node.parameter, node.values || (node.values = [initialCandidate(node.parameter, catalog)])));
    } else if (node.type === "combine") {
      body.appendChild(buildMatchingBlock(node));
    } else if (node.type === "output") {
      const mSel = buildGroupedModelSelect(modRes, node.modelRef || state.modelRef);
      mSel.style.maxWidth = "100%";
      mSel.addEventListener("change", () => { node.modelRef = mSel.value; state.modelRef = mSel.value; recordEdit(false); });
      const repIn = el("input", { class: "input", type: "number", min: "1", max: "200", value: String(node.repeat ?? 1), style: { width: "76px" } });
      repIn.addEventListener("input", () => { node.repeat = Math.max(1, Math.min(200, Number(repIn.value) || 1)); updateStatusAndSummaries(); recordEdit(false); });
      const exp = expandOutputNode(node);

      body.append(
        el("div", { class: "row", style: { gap: "6px" } }, el("span", { class: "muted" }, "模型"), mSel),
        el("div", { class: "row", style: { gap: "6px" } }, el("span", { class: "muted" }, "每组张数"), repIn),
        el("div", { class: "badge" + (exp.error ? " badge-warn" : " badge-accent"), dataset: { outputSummary: node.id } }, exp.error || `预计输出 ${exp.count} 张`),
        el("div", { class: "row" },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => runOutputNode(node, false) }, "▶ 运行生成"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { state.outputNodeId = node.id; state.activePanel = "preview"; renderDrawer(); } }, "预览清单"),
          state.activeRun ? el("button", { type: "button", class: "btn btn-sm", onClick: () => { state.activePanel = "history"; renderDrawer(); } }, "查看结果") : null
        )
      );
    }

    card.append(head, body);
    return card;
  }

  function renderGuidedView() {
    clear(guidedContainer);
    const flow = simpleFlow();
    if (!flow) return;
    const { group, output } = flow;
    const exp = expandOutputNode(output);
    const mSel = buildGroupedModelSelect(modRes, output.modelRef || state.modelRef);
    mSel.style.maxWidth = "100%";
    mSel.addEventListener("change", () => { output.modelRef = mSel.value; state.modelRef = mSel.value; recordEdit(false); });
    const repIn = el("input", { class: "input", type: "number", min: "1", max: "200", value: String(output.repeat ?? 1), style: { width: "76px" } });
    repIn.addEventListener("input", () => { output.repeat = Math.max(1, Math.min(200, Number(repIn.value) || 1)); renderGuidedView(); });

    const leftMain = el("main", { class: "col", style: { gap: "12px" } },
      el("div", { class: "pc-step-title" },
        el("span", null, "1"),
        el("div", null, el("h2", null, "准备参数"), el("p", null, "填写想画的内容，画风、图型和比例都可添加多个候选。"))
      ),
      renderNodeCard(group, true)
    );

    const sidebarRight = el("aside", { class: "pc-guide-sidebar" },
      el("div", null,
        el("div", { class: "pc-step-title" }, el("span", null, "2"), el("div", null, el("h2", null, "这批怎么画"))),
        buildMatchingBlock(group, true),
        el("div", { class: "col", style: { gap: "8px", marginTop: "10px" } },
          el("div", { class: "row", style: { gap: "8px" } }, el("span", { class: "muted" }, "生图模型"), mSel),
          el("div", { class: "row", style: { gap: "8px" } }, el("span", { class: "muted" }, "每组张数"), repIn)
        )
      ),
      el("div", { style: { borderTop: "1px solid var(--line)", paddingTop: "14px" } },
        el("div", { class: "pc-step-title" }, el("span", null, "3"), el("div", null, el("h2", null, "预览与出图"), el("p", null, "先核对生成内容与张数，再开始。"))),
        exp.error
          ? el("p", { class: "badge badge-warn" }, exp.error)
          : el("div", { class: "col", style: { gap: "4px" } },
              el("div", { class: "pc-total" }, el("strong", null, String(exp.count)), el("span", null, "张图片")),
              exp.formula ? el("p", { class: "muted", style: { margin: "0", fontSize: "12px" } }, exp.formula) : null
            ),
        el("div", { class: "col", style: { gap: "8px", marginTop: "10px" } },
          el("button", { type: "button", class: "btn btn-primary", onClick: () => runOutputNode(output, false) }, "▶ 运行生成"),
          el("button", { type: "button", class: "btn", onClick: () => { state.outputNodeId = output.id; state.activePanel = "preview"; renderDrawer(); } }, "预览清单 & 核对费用")
        )
      )
    );

    guidedContainer.append(leftMain, sidebarRight);
  }

  async function renderDrawer() {
    if (!state.activePanel) {
      drawerEl.hidden = true;
      historyBtn.classList.remove("btn-primary");
      previewBtn.classList.remove("btn-primary");
      return;
    }
    drawerEl.hidden = false;
    historyBtn.classList.toggle("btn-primary", state.activePanel === "history");
    previewBtn.classList.toggle("btn-primary", state.activePanel === "preview");
    clear(drawerBody);

    if (state.activePanel === "preview") {
      drawerTitle.textContent = "预览清单";
      const out = primaryOutputNode();
      const exp = expandOutputNode(out);
      if (exp.error || !exp.items.length) {
        drawerBody.appendChild(el("p", { class: "badge badge-warn" }, exp.error || "暂无待生成组合"));
        return;
      }
      if (!state.selectedOrdinals.size || state.selectedOrdinals.size > exp.items.length) {
        state.selectedOrdinals = new Set(exp.items.map((_, i) => i));
      }

      const quoteLine = el("div", { class: "badge", role: "status" }, "核对预计费用中…");
      const selCount = state.selectedOrdinals.size;
      const goBtn = el("button", {
        type: "button",
        class: "btn btn-primary",
        disabled: selCount === 0,
        onClick: () => runItems(exp.items.filter((_, i) => state.selectedOrdinals.has(i)), false),
      }, `开始生成选中的 ${selCount} 张`);

      const listEl = el("div", { class: "pc-plan-list" });
      exp.items.forEach((it, idx) => {
        const chk = el("input", { type: "checkbox", checked: state.selectedOrdinals.has(idx) });
        chk.addEventListener("change", () => {
          if (chk.checked) state.selectedOrdinals.add(idx);
          else state.selectedOrdinals.delete(idx);
          renderDrawer();
        });
        listEl.appendChild(el("label", { class: "pc-plan-item" },
          chk,
          el("div", { class: "col", style: { gap: "3px", minWidth: "0" } },
            el("strong", null, `${idx + 1}. ${it.theme.slice(0, 48)}`),
            el("span", { class: "muted" }, [it.style, it.style2, it.layout, it.ratio, it.color].filter(Boolean).join(" · "))
          )
        ));
      });

      drawerBody.append(quoteLine, goBtn, listEl);

      if (selCount > 0) {
        api("POST", "/api/quote", { modelRef: state.modelRef, resolution: "2k", count: selCount })
          .then((q) => {
            quoteLine.className = "badge " + (q.source === "provider" || q.freeCount > 0 ? "badge-ok" : "");
            quoteLine.textContent = q.source === "provider"
              ? `自带接口直出 · 已选 ${selCount} 张`
              : `已选 ${selCount} 张 · 免费 ${q.freeCount || 0} 张 · 预计 ${money(q.totalCents)}`;
          })
          .catch(() => { quoteLine.textContent = `已选 ${selCount} / ${exp.items.length} 张`; });
      }
      return;
    }

    // History & Output Results panel
    drawerTitle.textContent = "出图历史与结果";
    const run = state.activeRun;
    if (!run) {
      drawerBody.appendChild(el("p", { class: "muted" }, "当前画布暂无出图记录；先运行一次批量生成即可在此查看成品。"));
      return;
    }
    drawerBody.append(
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap" } },
        el("strong", null, run.title || "画布生成结果"),
        el("div", { class: "row" },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => exportRun("xiaohongshu") }, "📕 小红书 3:4"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => exportRun("zip") }, "📦 ZIP"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works", { openRun: run.id }) }, "☁ 发布")
        )
      )
    );
    const gallery = el("div", { class: "pc-gallery" });
    (run.images || []).forEach((im, idx) => {
      const card = el("article", null,
        el("strong", null, `${idx + 1}. ${im.theme || "组合生成图"}`),
        el("span", { class: "badge" }, ({ queued: "排队中", running: "绘制中…", done: "已完成", failed: "生成失败" })[im.status] || im.status)
      );
      if (im.status === "done" && (im.path || im.thumb)) {
        card.appendChild(el("img", {
          src: localImg(im.thumb || im.path),
          alt: im.theme || "",
          onClick: () => showModal(im.theme || "大图预览",
            el("img", { src: localImg(im.path), alt: "", style: { maxWidth: "100%", maxHeight: "72vh", borderRadius: "8px" } }),
            [el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭")]
          ),
        }));
        card.appendChild(el("div", { class: "row" },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => api("POST", `/api/images/${encodeURIComponent(im.id)}/copy`).then(() => toast("已复制到剪贴板")) }, "📋 复制"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("annotate", { runId: run.id }) }, "📌 批注")
        ));
      } else if (im.status === "failed") {
        card.appendChild(el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => api("POST", `/api/images/${encodeURIComponent(im.id)}/retry`).then(() => toast("已重新入队")) }, "重试"));
      }
      gallery.appendChild(card);
    });
    drawerBody.appendChild(gallery);
  }

  function updateStatusAndSummaries() {
    statusSpan.textContent = state.dirty ? "有未保存改动" : "已保存";
    undoBtn.disabled = !state.undoStack.length;
    redoBtn.disabled = !state.redoStack.length;
    state.graph.nodes.filter((n) => n.type === "output").forEach((n) => {
      const badge = nodesLayer.querySelector(`[data-output-summary="${n.id}"]`);
      if (badge) {
        const exp = expandOutputNode(n);
        badge.className = "badge" + (exp.error ? " badge-warn" : " badge-accent");
        badge.textContent = exp.error || `预计输出 ${exp.count} 张`;
      }
    });
  }

  function renderWorkspace() {
    const guided = state.view === "guided" && canGuide();
    scrollBoard.classList.toggle("hidden", guided);
    guidedContainer.classList.toggle("hidden", !guided);
    edgeActionsBar.hidden = guided || !state.selectedEdgeId;
    wireHint.classList.toggle("hidden", guided);
    zoomResetBtn.classList.toggle("hidden", guided);
    viewSwitchBtn.textContent = guided ? "自由连线画布" : "引导视图";
    viewSwitchBtn.disabled = !guided && !canGuide();

    if (guided) {
      renderGuidedView();
    } else {
      applyTransform();
      clear(nodesLayer);
      state.graph.nodes.forEach((node) => nodesLayer.appendChild(renderNodeCard(node, false)));
      drawEdges();
      updatePortsHighlight();
    }
    updateStatusAndSummaries();
    renderDrawer();
  }

  // Actions
  function newCanvas() {
    state.docId = "";
    state.name = "参数组合画布";
    state.graph = defaultGraph(catalog);
    state.view = "free";
    state.dirty = false;
    state.undoStack = [];
    state.redoStack = [];
    lastSnapshot = JSON.stringify({ name: state.name, graph: state.graph });
    renderWorkspace();
    toast("已新建空白画布");
  }

  function addNodeOfType(type, parameter = "") {
    const existing = state.graph.nodes;
    const x = existing.length
      ? Math.round(existing.reduce((mx, n) => Math.max(mx, (n.x || 0) + (n.type === "parameters" ? 410 : 310)), 36))
      : 36;
    const y = existing.length ? Math.round(48 + ((existing.length - 1) % 3) * 44) : 48;
    const id = uid(type);
    let node;
    if (type === "parameters") {
      node = {
        id,
        type: "parameters",
        mode: "cartesian",
        x,
        y,
        fieldOrder: ["prompt", "style1", "layout", "ratio"],
        fields: { prompt: [""], style1: [initialCandidate("style1", catalog)], layout: [""], ratio: ["3:4"] },
      };
    } else if (type === "parameter") {
      node = { id, type: "parameter", parameter, values: [initialCandidate(parameter, catalog)], x, y };
    } else if (type === "combine") {
      node = { id, type: "combine", mode: "cartesian", x, y };
    } else {
      node = { id, type: "output", mode: "cartesian", repeat: 1, x, y };
    }
    state.graph.nodes.push(node);
    state.selectedId = id;
    recordEdit(true);
  }

  function openAddNodeDialog() {
    const searchIn = el("input", { class: "input", type: "search", placeholder: "搜索节点，如：主题、画风、参数组合…" });
    const listBox = el("div", { class: "col", style: { gap: "6px", maxHeight: "52vh", overflowY: "auto" } });
    const paint = () => {
      clear(listBox);
      const q = searchIn.value.trim().toLowerCase();
      ["生成流程", "高级节点", "单项参数"].forEach((grp) => {
        const items = NODE_MENU_ENTRIES.filter((it) => it.group === grp && `${it.name} ${it.detail} ${it.parameter || ""}`.toLowerCase().includes(q));
        if (!items.length) return;
        listBox.appendChild(el("span", { class: "studio-row-label", style: { marginTop: "6px" } }, grp));
        items.forEach((it) => {
          listBox.appendChild(el("button", {
            type: "button",
            class: "card row",
            style: { justifyContent: "space-between", padding: "9px 12px", textAlign: "left", cursor: "pointer" },
            onClick: () => {
              closeModal();
              addNodeOfType(it.type, it.parameter || "");
            },
          },
          el("div", { class: "col", style: { gap: "2px" } },
            el("strong", null, it.name),
            it.detail ? el("span", { class: "muted" }, it.detail) : null
          ),
          el("span", { class: "badge" }, "添加")));
        });
      });
    };
    searchIn.addEventListener("input", paint);
    showModal("添加画布节点", el("div", { class: "col", style: { gap: "10px" } }, searchIn, listBox), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    ]);
    paint();
    searchIn.focus();
  }

  function openSaveDialog() {
    const nameInput = el("input", { class: "input", value: state.name || "", placeholder: "例如：封面画风对比测试" });
    showModal("保存画布", field("画布名称", nameInput), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          state.name = nameInput.value.trim() || "未命名画布";
          closeModal();
          await saveCanvas();
        },
      }, "保存"),
    ]);
    nameInput.focus();
  }

  async function saveCanvas() {
    try {
      const res = await api("PUT", `/api/docs/canvas/${encodeURIComponent(state.docId || "new")}`, {
        name: state.name || "未命名画布",
        data: { format: 2, nodes: state.graph.nodes, edges: state.graph.edges, view: state.view, panX: state.panX, panY: state.panY, scale: state.scale },
      });
      state.docId = res.doc.id;
      state.dirty = false;
      lastSnapshot = JSON.stringify({ name: state.name, graph: state.graph });
      docs = (await api("GET", "/api/docs/canvas").catch(() => ({ items: [] }))).items || [];
      updateStatusAndSummaries();
      toast("画布已保存到本地");
    } catch (e) { toast(e.message); }
  }

  async function syncCanvas() {
    await saveCanvas();
    try {
      const res = await api("POST", "/api/canvas/sync", { id: state.docId });
      if (res.conflicts?.length) toast("检测到云端版本冲突，请在稍后对比合并");
      else if (res.ok) toast(`已同步画布（上传 ${res.pushed || 0} 份）`);
      else toast(res.error || "同步未完成");
    } catch (e) { toast(e.message); }
  }

  async function exportRun(format) {
    if (!state.activeRun?.id) return;
    try {
      const res = await api("POST", `/api/works/${encodeURIComponent(state.activeRun.id)}/export`, { format });
      toast("已导出：" + res.path);
    } catch (e) { toast(e.message); }
  }

  async function runOutputNode(outNode, confirmed) {
    const exp = expandOutputNode(outNode);
    if (exp.error || !exp.items.length) {
      toast(exp.error || "请先连接包含有效主题与画风的节点");
      return;
    }
    await runItems(exp.items, confirmed);
  }

  async function runItems(items, confirmed) {
    if (!items.length) return;
    try {
      const res = await api("POST", "/api/generate", {
        mode: "canvas",
        title: `${state.name || "画布"} · 组合`,
        modelRef: state.modelRef,
        resolution: "2k",
        confirmed,
        items,
      });
      if (res.needConfirm) {
        showModal("画布组合费用确认", el("p", null, `本次将批量生成 ${res.count} 张图片，预计 ${money(res.totalCents)}。确认执行？`), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); runItems(items, true); } }, "确认生成"),
        ]);
        return;
      }
      state.activeRun = { ...res.run, images: res.images || [] };
      state.activePanel = "history";
      renderDrawer();
      toast(`已提交 ${items.length} 张组合生图`);
    } catch (e) { toast(e.message); }
  }

  function openTemplatesModal() {
    const body = el("div", { class: "col" });
    [...builtins, ...userTpls].forEach((tpl) => {
      const data = typeof tpl.data === "string" ? JSON.parse(tpl.data) : (tpl.data || tpl);
      body.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", padding: "10px 12px" } },
        el("div", { class: "col", style: { gap: "2px" } },
          el("strong", null, tpl.name),
          el("span", { class: "muted" }, data.desc || `包含 ${(data.nodes || []).length} 个节点`)
        ),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => {
            state.name = tpl.name;
            state.graph = normalizeGraphData(data, catalog, recipes);
            closeModal();
            recordEdit(true);
            toast("已套用模板：" + tpl.name);
          },
        }, "套用模板")
      ));
    });
    showModal("工作流模板库", body, [el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭")]);
  }

  function openAssistantModal() {
    const promptIn = el("textarea", {
      class: "textarea",
      rows: "4",
      placeholder: "描述你想生成的组合流程，例如：把清晨咖啡的 4 个步骤做成 2 种不同画风的对比矩阵…",
    });
    const textSel = buildGroupedAIModelSelect(modRes, modRes.defaultTextModel || "", "text");
    showModal("✨ 画布工作流助手", el("div", { class: "col" },
      promptIn,
      el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center" } },
        el("span", { class: "muted", style: { fontSize: "12px" } }, "文字服务接口"),
        textSel
      )
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          try {
            const res = await api("POST", "/api/canvas/assistant", { prompt: promptIn.value.trim(), modelRef: textSel.value });
            const nodes = res.nodes || res.raw?.nodes;
            const edges = res.edges || res.raw?.edges;
            if (!Array.isArray(nodes) || !nodes.length) { toast("助手未能解析出节点图"); return; }
            state.graph = normalizeGraphData({ nodes, edges }, catalog, recipes);
            closeModal();
            recordEdit(true);
            toast("已生成画布节点流程");
          } catch (e) { toast(e.message); }
        },
      }, "自动搭建"),
    ]);
  }

  const unsub = onEvent(async (msg) => {
    if (!root.isConnected) {
      document.removeEventListener("click", onDocClick);
      unsub();
      return;
    }
    const rid = msg.data?.runId || msg.data?.id;
    if ((msg.type === "job" || msg.type === "run") && state.activeRun?.id === rid) {
      try {
        const detail = await api("GET", `/api/works/${encodeURIComponent(rid)}`);
        state.activeRun = detail.run;
        if (state.activePanel === "history") renderDrawer();
      } catch {}
    }
  });

  renderWorkspace();
}
