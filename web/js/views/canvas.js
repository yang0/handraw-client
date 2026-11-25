import { api, clear, closeModal, el, localImg, money, onEvent, packImg, showModal, toast } from "../api.js";
import { createTextModelPicker } from "../skills-ui.js";
import { buildGroupedModelSelect } from "./create.js";
import {
  MAX_REF_IMAGES,
  bindPageImagePaste,
  importTempReferenceFile,
  openReferencePickerModal,
} from "./ref-picker.js";
import {
  DEFAULT_MOODS,
  RATIOS,
  WHITESPACE_OPTIONS,
  field,
  openResourceDialog,
  resourceId,
  resourceName,
  studioMount,
} from "./studio-controls.js";

const REF_ROLES = [
  "角色长相",
  "构图姿势",
  "画风质感",
  "服装道具",
  "场景氛围",
  "垫图重绘",
  "自定义",
];

const RESOLUTIONS = ["1k", "2k", "4k"];

const PARAM_LABELS = {
  prompt: "主题",
  refs: "参考图",
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
  { type: "reference", name: "🖼️ 参考图", group: "生成流程", detail: "添加 1~6 张参考图并说明每张图的作用（角色/姿势/画风等）", out: true },
  { type: "parameters", name: "🎛️ 出图参数", group: "生成流程", detail: "在一张卡里编辑主题、参考图、画风、图型和比例", out: true },
  { type: "output", name: "🚀 批量出图", group: "生成流程", detail: "接收参数与参考图，设置模型、分辨率与每组张数", in: true },
  { type: "combine", name: "🔀 参数组合", group: "高级节点", detail: "把多条连线的参考图与参数合成出图方案", in: true, out: true },
  ...Object.entries(PARAM_LABELS).filter(([k]) => k !== "refs").map(([parameter, name]) => ({
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

function normalizeRefItem(raw, fallbackRole = "", fallbackNote = "") {
  if (!raw) return null;
  if (typeof raw === "string") {
    const p = raw.trim();
    if (!p) return null;
    return {
      path: p,
      label: p.split(/[\\/]/).pop() || "参考图",
      role: fallbackRole || "",
      note: fallbackNote || "",
      source: "upload",
    };
  }
  const p = String(raw.path || raw.localPath || "").trim();
  if (!p) return null;
  return {
    path: p,
    label: String(raw.label || raw.name || p.split(/[\\/]/).pop() || "参考图"),
    role: String(raw.role ?? fallbackRole ?? ""),
    note: String(raw.note ?? fallbackNote ?? ""),
    source: String(raw.source || "upload"),
    galleryId: String(raw.galleryId || ""),
    itemId: String(raw.itemId || ""),
    variant: String(raw.variant || ""),
    assetId: String(raw.assetId || ""),
  };
}

function normalizeRefList(list, fallbackRole = "", fallbackNote = "") {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const item = normalizeRefItem(raw, fallbackRole, fallbackNote);
    if (!item) continue;
    const key = item.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_REF_IMAGES) break;
  }
  return out;
}

function mergeRefLists(listA, listB) {
  return normalizeRefList([...(Array.isArray(listA) ? listA : []), ...(Array.isArray(listB) ? listB : [])]);
}

function mergeRowPieces(base, piece) {
  const next = { ...(base || {}), ...(piece || {}) };
  if (Array.isArray(base?.refs) || Array.isArray(piece?.refs)) {
    next.refs = mergeRefLists(base?.refs, piece?.refs);
  }
  return next;
}

function initialCandidate(field, catalog) {
  if (field === "style1") return catalog?.styles?.[0]?.number || "FA-013";
  if (field === "ratio") return "3:4";
  if (field === "mode") return "graphic-text";
  if (field === "whitespace") return "";
  if (field === "refs") return [];
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
        resolution: "2k",
        x: 500,
        y: 120,
      },
    ],
    edges: [{ id: "e_init", from: "params", to: "output" }],
  };
}

// Convert legacy v1 canvas nodes (themes/styles/recipe/generate/export) into parameter-canvas v2 nodes cleanly
function normalizeGraphData(raw, catalog, recipes) {
  const nodes = Array.isArray(raw?.nodes) ? structuredClone(raw.nodes) : [];
  const edges = Array.isArray(raw?.edges) ? structuredClone(raw.edges) : [];
  const hasV2 = nodes.some((n) => ["parameters", "parameter", "reference", "combine", "output"].includes(n.type));
  if (hasV2 || !nodes.length) {
    const cleanNodes = (nodes.length ? nodes : defaultGraph(catalog).nodes).map((n) => {
      if (n.type === "reference") {
        return {
          ...n,
          title: n.title || "参考图",
          refMode: n.refMode === "variants" ? "variants" : "bundle",
          defaultRole: n.defaultRole || "",
          defaultNote: n.defaultNote || "",
          refs: normalizeRefList(n.refs, n.defaultRole || "", n.defaultNote || ""),
        };
      }
      if (n.type === "output") {
        return {
          ...n,
          repeat: Math.max(1, Math.min(200, Number(n.repeat ?? 1))),
          resolution: RESOLUTIONS.includes(n.resolution) ? n.resolution : "2k",
        };
      }
      return n;
    });
    return {
      format: 2,
      nodes: cleanNodes,
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
        resolution: "2k",
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
    api("GET", "/api/works?mode=canvas&limit=12").catch(() => ({ items: [] })),
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

  const initialRuns = Array.isArray(worksRes.items) ? worksRes.items : [];
  const runsById = new Map();
  initialRuns.forEach((r) => { if (r?.id) runsById.set(r.id, r); });

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
    activePanel: "", // "" | "preview" | "history"
    outputNodeId: "",
    selectedOrdinals: new Set(),
    activeFieldTabs: new Map(),
    graph: defaultGraph(catalog),
    activeRun: initialRuns[0] || null,
    recentRuns: initialRuns,
    runsById,
    undoStack: [],
    redoStack: [],
  };
  let lastSnapshot = JSON.stringify({ name: state.name, graph: state.graph });

  function upsertRun(runObj) {
    if (!runObj?.id) return;
    state.runsById.set(runObj.id, runObj);
    const idx = state.recentRuns.findIndex((r) => r.id === runObj.id);
    if (idx >= 0) state.recentRuns[idx] = runObj;
    else state.recentRuns.unshift(runObj);
    if (state.recentRuns.length > 16) state.recentRuns = state.recentRuns.slice(0, 16);
    if (!state.activeRun || state.activeRun.id === runObj.id) state.activeRun = runObj;
  }

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

  // ==================== Graph Matching & Cartesian / Zip Engine ====================
  function upstreamSources(nodeId, visited = new Set()) {
    if (visited.has(nodeId)) return [];
    visited.add(nodeId);
    const inEdges = state.graph.edges.filter((e) => e.to === nodeId);
    const list = [];
    for (const edge of inEdges) {
      const src = state.graph.nodes.find((n) => n.id === edge.from);
      if (!src) continue;
      if (src.type === "reference") {
        const cleanRefs = normalizeRefList(src.refs, src.defaultRole || "", src.defaultNote || "");
        if (!cleanRefs.length) {
          list.push({
            field: "refs",
            name: src.title || "参考图",
            values: [[]],
            refMode: src.refMode || "bundle",
          });
        } else if (src.refMode === "variants") {
          list.push({
            field: "refs",
            name: src.title || "参考图",
            values: cleanRefs.map((r) => [r]),
            refMode: "variants",
          });
        } else {
          list.push({
            field: "refs",
            name: src.title || "参考图",
            values: [cleanRefs],
            refMode: "bundle",
          });
        }
      } else if (src.type === "parameter") {
        const vals = Array.isArray(src.values) ? src.values : [initialCandidate(src.parameter, catalog)];
        list.push({
          field: src.parameter,
          name: PARAM_LABELS[src.parameter] || src.parameter,
          values: src.parameter === "refs" ? vals.map((g) => normalizeRefList(Array.isArray(g) ? g : [g])) : vals,
        });
      } else if (src.type === "parameters") {
        const order = src.fieldOrder || Object.keys(src.fields || {});
        const fieldSources = order
          .filter((f) => Object.hasOwn(src.fields || {}, f))
          .map((f) => {
            const rawVals = src.fields[f] || [];
            return {
              field: f,
              name: PARAM_LABELS[f] || f,
              values: f === "refs"
                ? (rawVals.length ? rawVals.map((g) => normalizeRefList(Array.isArray(g) ? g : [g])) : [[]])
                : rawVals,
            };
          });
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
    if (!sources.length) return { rows: [], error: "请连接上游参数或参考图节点，或添加候选值", count: 0 };
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
        let merged = {};
        normalized.forEach((arr) => {
          merged = mergeRowPieces(merged, arr[arr.length === 1 ? 0 : i]);
        });
        rows.push(merged);
      }
      return { rows, error: "", count: rows.length };
    }
    // cartesian (with multi-ref merging!)
    let rows = [{}];
    for (const arr of normalized) {
      const next = [];
      for (const base of rows) {
        for (const piece of arr) {
          next.push(mergeRowPieces(base, piece));
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
    const refSpecs = normalizeRefList(row.refs).map((r) => ({
      path: r.path,
      label: r.label || "",
      role: r.role || "",
      note: r.note || "",
      source: r.source || "upload",
      galleryId: r.galleryId || "",
      itemId: r.itemId || "",
      variant: r.variant || "",
      assetId: r.assetId || "",
    }));
    return {
      theme: String(row.prompt || "").trim() || (refSpecs.length ? "基于所附参考图的手绘创作" : "手绘视觉主题展示"),
      style: s1,
      style2: s2,
      layout: row.layout || "",
      color,
      tone,
      mood,
      ratio: row.ratio || "3:4",
      mode,
      extra: extraParts.join("\n"),
      refs: refSpecs.map((r) => r.path),
      refSpecs,
    };
  }

  function expandOutputNode(outNode) {
    if (!outNode) return { items: [], rows: [], error: "请添加「批量出图」节点", count: 0, formula: "" };
    const sources = upstreamSources(outNode.id);
    if (!sources.length) {
      return { items: [], rows: [], error: "请将左侧参数或参考图节点的输出圆点连到这里", count: 0, formula: "" };
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
    const refs = state.graph.nodes.filter((n) => n.type === "reference" && state.graph.edges.some((e) => e.from === n.id && e.to === out.id));
    return { group, refs, output: out };
  }
  function canGuide() {
    return Boolean(simpleFlow());
  }

  function formatValueSummary(fieldName, val) {
    if (fieldName === "refs") {
      const list = normalizeRefList(val);
      if (!list.length) return { text: "", img: "", local: false };
      const label = list.map((r, i) => `图${i + 1}${r.role ? `(${r.role})` : ""}`).join("+");
      return { text: label, img: list[0].path, local: true };
    }
    if (fieldName === "style1") {
      if (typeof val === "object" && val) {
        const n1 = resourceName(catalog.styles.find((s) => s.number === val.style1)) || val.style1;
        const n2 = val.style2 ? resourceName(catalog.styles.find((s) => s.number === val.style2)) || val.style2 : "";
        return { text: n2 ? `${val.style1} + ${val.style2}` : `${val.style1} ${n1}`, img: catalog.styles.find((s) => s.number === val.style1)?.image || "" };
      }
      const st = catalog.styles.find((s) => s.number === val);
      return { text: val ? `${val} ${st ? resourceName(st) : ""}`.trim() : "", img: st?.image || "" };
    }
    if (fieldName === "layout") {
      const l = catalog.layouts.find((x) => resourceId(x) === val);
      return { text: val ? `${val} ${l ? resourceName(l) : ""}`.trim() : "", img: l?.image || "" };
    }
    if (fieldName === "colors") {
      const list = Array.isArray(val) ? val : [val].filter(Boolean);
      const c = catalog.colors.find((x) => resourceId(x) === list[0]);
      return { text: list.join(" / "), img: c?.image || "" };
    }
    if (fieldName === "tones") {
      const list = Array.isArray(val) ? val : [val].filter(Boolean);
      const t = catalog.tones.find((x) => resourceId(x) === list[0]);
      return { text: list.join(" / "), img: t?.image || "" };
    }
    if (fieldName === "mode") {
      return { text: ({ "pure-image": "纯图", "graphic-text": "图文", poster: "海报" })[val] || val, img: "" };
    }
    if (fieldName === "whitespace") {
      return { text: ({ "": "不限", normal: "正常留白", moderate: "适中留白", high: "大量留白" })[val] || val, img: "" };
    }
    if (Array.isArray(val)) return { text: val.join("、"), img: "" };
    return { text: String(val || ""), img: "" };
  }

  // ==================== Header & Toolbar ====================
  const titleIn = el("input", {
    type: "text",
    class: "pc-title-input",
    value: state.name || "参数组合画布",
    "aria-label": "当前画布名称",
    title: "点击直接修改画布名称",
  });
  titleIn.addEventListener("input", () => {
    state.name = titleIn.value.trim() || "未命名画布";
    recordEdit(false);
  });

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
  }, "📂 打开 ⌄");
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
        toast("当前使用多节点自定义连线，切回「出图参数→批量出图」主流程可使用引导视图");
        return;
      }
      state.view = state.view === "guided" ? "free" : "guided";
      renderWorkspace();
    },
  }, "引导视图");
  const quickAddRefBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    title: "添加参考图节点（也支持直接 Ctrl+V 粘贴或拖入图片）",
    onClick: () => addNodeOfType("reference"),
  }, "＋ 参考图");
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
      titleIn,
      el("button", { type: "button", class: "btn btn-sm", onClick: newCanvas }, "＋ 新建"),
      el("button", { type: "button", class: "btn btn-sm", onClick: openSaveDialog }, "💾 保存"),
      recentWrap,
      el("button", { type: "button", class: "btn btn-sm", onClick: openTemplatesModal }, "📐 模板库"),
      el("button", { type: "button", class: "btn btn-sm", onClick: openAssistantModal }, "✨ AI 助手"),
      el("button", { type: "button", class: "btn btn-sm", onClick: syncCanvas }, "☁ 同步")
    ),
    el("div", { class: "pc-toolbar" },
      statusSpan,
      viewSwitchBtn,
      quickAddRefBtn,
      addNodeBtn,
      historyBtn,
      previewBtn,
      runAllBtn
    )
  );

  // ==================== Floating Controls, Context Menu & Drop Overlay ====================
  const undoBtn = el("button", { type: "button", class: "pc-floating-btn", title: "撤销 (Ctrl+Z)", "aria-label": "撤销", onClick: undo }, "↶");
  const redoBtn = el("button", { type: "button", class: "pc-floating-btn", title: "重做 (Ctrl+Y)", "aria-label": "重做", onClick: redo }, "↷");
  const zoomOutBtn = el("button", {
    type: "button",
    class: "pc-floating-btn",
    title: "缩小画布",
    "aria-label": "缩小画布",
    onClick: () => { state.scale = Math.max(0.45, +(state.scale * 0.88).toFixed(2)); applyTransform(); },
  }, "−");
  const zoomResetBtn = el("button", {
    type: "button",
    class: "pc-floating-btn",
    title: "重置为 100%",
    onClick: () => { state.panX = 0; state.panY = 0; state.scale = 1; applyTransform(); },
  }, "100%");
  const zoomInBtn = el("button", {
    type: "button",
    class: "pc-floating-btn",
    title: "放大画布",
    "aria-label": "放大画布",
    onClick: () => { state.scale = Math.min(1.8, +(state.scale * 1.14).toFixed(2)); applyTransform(); },
  }, "＋");
  const fitViewBtn = el("button", {
    type: "button",
    class: "pc-floating-btn",
    title: "适配全画布视野",
    onClick: fitView,
  }, "⊡ 适配");
  const autoLayoutBtn = el("button", {
    type: "button",
    class: "pc-floating-btn",
    title: "按连线层级自动整理节点位置",
    onClick: autoLayoutNodes,
  }, "⊞ 整理");
  const floatingControls = el("div", { class: "pc-floating-history" },
    undoBtn, redoBtn, zoomOutBtn, zoomResetBtn, zoomInBtn, fitViewBtn, autoLayoutBtn
  );

  const edgeActionsBar = el("div", { class: "pc-edge-actions", hidden: true },
    el("span", null, "已选中连线"),
    el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: deleteSelectedEdge }, "删除连线"),
    el("button", { type: "button", class: "btn btn-sm", onClick: () => { state.selectedEdgeId = ""; drawEdges(); } }, "取消")
  );
  const wireHint = el("p", { class: "pc-wire-hint", "aria-live": "polite" },
    "按住输出圆点拖拽拉线（或点击连线） · 右键空白快速添节点 · 支持 Ctrl+V 粘贴或拖入图片建参考图节点"
  );

  const dropOverlay = el("div", { class: "pc-drop-overlay hidden", "aria-hidden": "true" },
    el("div", { class: "pc-drop-overlay-card" },
      el("span", { style: { fontSize: "24px" } }, "🖼️"),
      el("strong", null, "松开鼠标，立即创建「参考图」节点"),
      el("span", { class: "muted", style: { fontSize: "12px" } }, "支持单张或多张本地图片直接拖入画布")
    )
  );

  const ctxMenuEl = el("div", { class: "pc-ctx-menu", role: "menu", "aria-label": "画布快捷操作", hidden: true });
  let ctxWorldPos = { x: 80, y: 80 };
  function closeCtxMenu() {
    ctxMenuEl.hidden = true;
  }
  function openCtxMenu(clientX, clientY, worldX, worldY) {
    ctxWorldPos = { x: Math.max(16, Math.round(worldX)), y: Math.max(16, Math.round(worldY)) };
    clear(ctxMenuEl);
    const items = [
      { label: "🖼️ 添加参考图节点", hint: "支持多图与作用说明", fn: () => addNodeOfType("reference", "", ctxWorldPos) },
      { label: "🎛️ 添加出图参数卡", hint: "主题/画风/图型/比例", fn: () => addNodeOfType("parameters", "", ctxWorldPos) },
      { label: "🚀 添加批量出图节点", hint: "模型/分辨率/预览", fn: () => addNodeOfType("output", "", ctxWorldPos) },
      { label: "🔀 添加参数组合节点", hint: "汇聚多条连线", fn: () => addNodeOfType("combine", "", ctxWorldPos) },
      { sep: true },
      { label: "⊞ 自动整理节点排布", fn: () => autoLayoutNodes() },
      { label: "⊡ 适配全画布视野", fn: () => fitView() },
    ];
    items.forEach((it) => {
      if (it.sep) {
        ctxMenuEl.appendChild(el("div", { class: "pc-ctx-sep", role: "separator" }));
        return;
      }
      ctxMenuEl.appendChild(el("button", {
        type: "button",
        role: "menuitem",
        onClick: () => { closeCtxMenu(); it.fn(); },
      }, el("span", null, it.label), it.hint ? el("small", { class: "muted", style: { fontSize: "10.5px" } }, it.hint) : null));
    });
    ctxMenuEl.hidden = false;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mw = ctxMenuEl.offsetWidth || 210;
    const mh = ctxMenuEl.offsetHeight || 220;
    ctxMenuEl.style.left = `${Math.max(8, Math.min(clientX, vw - mw - 8))}px`;
    ctxMenuEl.style.top = `${Math.max(8, Math.min(clientY, vh - mh - 8))}px`;
    ctxMenuEl.querySelector("button")?.focus();
  }

  // ==================== Canvas Board & World ====================
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
    dropOverlay,
    drawerEl,
    ctxMenuEl
  );

  root.appendChild(el("div", { class: "pc-stage" }, headerBar, workspaceArea));

  // ==================== Coordinate, Pan, Zoom, Paste & Drop ====================
  function clientToWorld(clientX, clientY) {
    const rect = scrollBoard.getBoundingClientRect();
    return {
      x: (clientX - rect.left + scrollBoard.scrollLeft - state.panX) / state.scale,
      y: (clientY - rect.top + scrollBoard.scrollTop - state.panY) / state.scale,
    };
  }

  function applyTransform() {
    world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    zoomResetBtn.textContent = `${Math.round(state.scale * 100)}%`;
  }

  function fitView() {
    if (!state.graph.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.graph.nodes.forEach((n) => {
      const card = nodesLayer.querySelector(`[data-card="${n.id}"]`);
      const w = card?.offsetWidth || (n.type === "parameters" ? 390 : n.type === "reference" ? 340 : 300);
      const h = card?.offsetHeight || 260;
      const x = n.x || 0;
      const y = n.y || 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    });
    const bw = Math.max(320, scrollBoard.clientWidth - 72);
    const bh = Math.max(260, scrollBoard.clientHeight - 96);
    const contentW = Math.max(100, maxX - minX);
    const contentH = Math.max(100, maxY - minY);
    const nextScale = Math.max(0.45, Math.min(1.1, Math.min(bw / contentW, bh / contentH)));
    state.scale = +nextScale.toFixed(2);
    scrollBoard.scrollLeft = 0;
    scrollBoard.scrollTop = 0;
    state.panX = Math.round(36 - minX * state.scale);
    state.panY = Math.round(56 - minY * state.scale);
    applyTransform();
  }

  function autoLayoutNodes() {
    const nodes = state.graph.nodes;
    if (!nodes.length) return;
    // Compute topological column depth (0 = inputs, middle = combine, rightmost = output)
    const depth = new Map();
    const getDepth = (id, seen = new Set()) => {
      if (depth.has(id)) return depth.get(id);
      if (seen.has(id)) return 0;
      seen.add(id);
      const inEdges = state.graph.edges.filter((e) => e.to === id);
      const d = inEdges.length ? Math.max(...inEdges.map((e) => getDepth(e.from, seen) + 1)) : 0;
      depth.set(id, d);
      return d;
    };
    nodes.forEach((n) => getDepth(n.id));
    const maxDepth = Math.max(1, ...Array.from(depth.values()));
    nodes.forEach((n) => {
      if (n.type === "output") depth.set(n.id, Math.max(depth.get(n.id) || 1, maxDepth));
    });

    const cols = new Map();
    nodes.forEach((n) => {
      const c = depth.get(n.id) || 0;
      if (!cols.has(c)) cols.set(c, []);
      cols.get(c).push(n);
    });
    const sortedCols = Array.from(cols.keys()).sort((a, b) => a - b);
    let curX = 44;
    sortedCols.forEach((c) => {
      const colNodes = cols.get(c);
      let colMaxW = 300;
      let curY = 56;
      colNodes.forEach((n) => {
        const card = nodesLayer.querySelector(`[data-card="${n.id}"]`);
        const w = card?.offsetWidth || (n.type === "parameters" ? 390 : n.type === "reference" ? 340 : 310);
        const h = card?.offsetHeight || 260;
        n.x = curX;
        n.y = curY;
        if (w > colMaxW) colMaxW = w;
        curY += h + 28;
      });
      curX += colMaxW + 92;
    });
    recordEdit(true);
    setTimeout(fitView, 20);
    toast("已按流程层级自动整理排布");
  }

  // Global dismiss & keyboard shortcuts
  const onDocClick = (e) => {
    if (!recentWrap.contains(e.target)) {
      recentWrap.classList.remove("is-open");
      recentBtn.setAttribute("aria-expanded", "false");
    }
    if (!ctxMenuEl.hidden && !ctxMenuEl.contains(e.target)) {
      closeCtxMenu();
    }
  };
  document.addEventListener("click", onDocClick);

  root.addEventListener("keydown", (e) => {
    if (!ctxMenuEl.hidden && e.key === "Escape") {
      e.preventDefault();
      closeCtxMenu();
      return;
    }
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); redo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && state.selectedEdgeId) { e.preventDefault(); deleteSelectedEdge(); }
    else if (e.key === "Escape") { state.connectFrom = ""; state.selectedEdgeId = ""; drawEdges(); updatePortsHighlight(); }
  });

  // Paste image directly onto Canvas -> auto-create Reference node (#155)
  async function createReferenceNodeFromFiles(files, dropPos = null) {
    const imgs = Array.from(files || []).filter((f) => String(f.type || "").startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name || "")).slice(0, MAX_REF_IMAGES);
    if (!imgs.length) return;
    toast(`正在导入 ${imgs.length} 张参考图到画布…`);
    const imported = [];
    for (const f of imgs) {
      try {
        const path = await importTempReferenceFile(f);
        imported.push({
          path,
          label: (f.name || "参考图").replace(/\.[^.]+$/, "") || "参考图",
          role: "角色长相",
          note: "",
          source: "upload",
        });
      } catch (err) {
        toast(err.message || "导入参考图失败");
      }
    }
    if (!imported.length) return;
    const pos = dropPos || clientToWorld(
      scrollBoard.getBoundingClientRect().left + Math.min(260, scrollBoard.clientWidth * 0.35),
      scrollBoard.getBoundingClientRect().top + Math.min(180, scrollBoard.clientHeight * 0.35)
    );
    const id = uid("ref");
    const node = {
      id,
      type: "reference",
      title: imported.length > 1 ? `参考图组 (${imported.length} 张)` : imported[0].label,
      refMode: "bundle",
      defaultRole: "角色长相",
      defaultNote: "",
      refs: imported,
      x: Math.max(20, Math.round(pos.x)),
      y: Math.max(20, Math.round(pos.y)),
    };
    state.graph.nodes.push(node);
    // Convenience: if there's an output node and no edge yet, auto-connect to primary output or combine
    const targetNode = state.graph.nodes.find((n) => n.type === "combine") || primaryOutputNode();
    if (targetNode && !canConnect(id, targetNode.id)) {
      state.graph.edges.push({ id: uid("edge"), from: id, to: targetNode.id });
    }
    state.selectedId = id;
    recordEdit(true);
    toast(`已创建参考图节点并连入流程，可选择每张图的作用`);
  }

  const unbindPaste = bindPageImagePaste(root, (files) => createReferenceNodeFromFiles(files, null));

  let dragDepth = 0;
  scrollBoard.addEventListener("dragenter", (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.classList.remove("hidden");
  });
  scrollBoard.addEventListener("dragover", (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault();
  });
  scrollBoard.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.add("hidden");
  });
  scrollBoard.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.add("hidden");
    if (e.dataTransfer?.files?.length) {
      createReferenceNodeFromFiles(e.dataTransfer.files, clientToWorld(e.clientX, e.clientY));
    }
  });

  // Right-click blank canvas -> quick context menu (#155)
  scrollBoard.addEventListener("contextmenu", (e) => {
    if (e.target !== scrollBoard && e.target !== world && e.target !== edgeSvg) return;
    e.preventDefault();
    const wp = clientToWorld(e.clientX, e.clientY);
    openCtxMenu(e.clientX, e.clientY, wp.x, wp.y);
  });

  // Pan & zoom on scrollBoard
  let panning = null;
  scrollBoard.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target !== scrollBoard && e.target !== world && e.target !== edgeSvg) return;
    closeCtxMenu();
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

  // ==================== Edges & Drag-to-Wire ====================
  let dragWireState = null; // { fromId, startX, startY, curX, curY, active }
  let previewWireEl = null;

  function primaryOutputNode() {
    return state.graph.nodes.find((n) => n.id === state.selectedId && n.type === "output")
      || state.graph.nodes.find((n) => n.id === state.outputNodeId && n.type === "output")
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
    if (fromNode.type === "output" || toNode.type === "parameter" || toNode.type === "parameters" || toNode.type === "reference") {
      return "只能从参考图/参数/组合右侧连接到组合/出图左侧";
    }
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
        x: card.offsetLeft + port.offsetLeft + port.offsetWidth / 2,
        y: card.offsetTop + port.offsetTop + port.offsetHeight / 2,
      };
    }
    const n = state.graph.nodes.find((x) => x.id === nodeId);
    if (!n) return { x: 0, y: 0 };
    const w = n.type === "parameters" ? 390 : n.type === "reference" ? 340 : 300;
    return { x: (n.x || 0) + (direction === "out" ? w : 0), y: (n.y || 0) + 60 };
  }

  function drawPreviewWire() {
    if (previewWireEl) {
      previewWireEl.remove();
      previewWireEl = null;
    }
    if (!dragWireState?.active) return;
    const a = portPosition(dragWireState.fromId, "out");
    const b = { x: dragWireState.curX, y: dragWireState.curY };
    const bend = Math.max(45, Math.abs(b.x - a.x) * 0.45);
    const d = `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
    previewWireEl = document.createElementNS(svgNS, "path");
    previewWireEl.setAttribute("class", "pc-wire-preview");
    previewWireEl.setAttribute("d", d);
    edgeSvg.appendChild(previewWireEl);
  }

  function drawEdges() {
    while (edgeSvg.firstChild) edgeSvg.removeChild(edgeSvg.firstChild);
    previewWireEl = null;
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
    drawPreviewWire();
    edgeActionsBar.hidden = !state.selectedEdgeId;
  }

  function updatePortsHighlight() {
    const activeFrom = dragWireState?.active ? dragWireState.fromId : state.connectFrom;
    nodesLayer.querySelectorAll("[data-port]").forEach((p) => {
      const nid = p.dataset.node;
      const dir = p.dataset.port;
      p.setAttribute("aria-pressed", String(dir === "out" && activeFrom === nid));
      p.classList.toggle("is-available", Boolean(activeFrom && dir === "in" && !canConnect(activeFrom, nid)));
    });
  }

  function findSnappedInPort(clientX, clientY, fromId) {
    const direct = document.elementFromPoint(clientX, clientY)?.closest?.('[data-port="in"]');
    if (direct && direct.dataset.node && !canConnect(fromId, direct.dataset.node)) {
      return direct.dataset.node;
    }
    let bestId = "";
    let bestDist = 28;
    nodesLayer.querySelectorAll('[data-port="in"]').forEach((p) => {
      const nid = p.dataset.node;
      if (!nid || canConnect(fromId, nid)) return;
      const r = p.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dist = Math.hypot(clientX - cx, clientY - cy);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = nid;
      }
    });
    return bestId;
  }

  // ==================== Shared Reference List Editor (with Roles & Purpose Note) ====================
  function openImageLightbox(imgPath, titleText, extraActions = []) {
    showModal(titleText || "大图预览",
      el("div", { class: "col", style: { alignItems: "center", gap: "10px" } },
        el("img", { src: localImg(imgPath), alt: titleText || "", style: { maxWidth: "100%", maxHeight: "70vh", borderRadius: "8px" } })
      ),
      [
        ...extraActions,
        el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭"),
      ]
    );
  }

  function openRefPickerForList(currentList, { defaultRole = "", defaultNote = "", title = "选择画布参考图", onPicked } = {}) {
    const existing = normalizeRefList(currentList, defaultRole, defaultNote);
    const prevByPath = new Map(existing.map((r) => [r.path, r]));
    openReferencePickerModal({
      currentRefs: existing.map((r) => r.path),
      maxCount: MAX_REF_IMAGES,
      title,
      onConfirm: (nextPaths, nextMeta) => {
        const metaByPath = new Map((nextMeta || []).map((m) => [m.localPath, m]));
        const merged = (nextPaths || []).map((p) => {
          const prev = prevByPath.get(p);
          const m = metaByPath.get(p);
          if (prev) return { ...prev, label: prev.label || m?.label || "" };
          return {
            path: p,
            label: m?.label || p.split(/[\\/]/).pop() || "参考图",
            role: defaultRole || "角色长相",
            note: defaultNote || "",
            source: m?.source || "upload",
            galleryId: m?.galleryId || "",
            itemId: m?.itemId || "",
            variant: m?.variant || "",
            assetId: m?.assetId || "",
          };
        });
        onPicked(merged);
      },
    });
  }

  function renderReferenceItemsEditor(refList, { defaultRole = "", defaultNote = "", onChange, emptyText = "点击选择参考图（自建图库 / 扩展图鉴 / 本地上传 / 粘贴）" } = {}) {
    const listWrap = el("div", { class: "pc-ref-list" });
    const items = normalizeRefList(refList, defaultRole, defaultNote);

    if (!items.length) {
      listWrap.appendChild(el("button", {
        type: "button",
        class: "pc-ref-drop-hint",
        onClick: () => openRefPickerForList(items, {
          defaultRole,
          defaultNote,
          onPicked: (next) => onChange(next, true),
        }),
      }, `🖼️ ${emptyText}`));
      return listWrap;
    }

    items.forEach((item, idx) => {
      const rolePills = el("div", { class: "pc-ref-roles", role: "group", "aria-label": `参考图 ${idx + 1} 作用` },
        ...REF_ROLES.map((rk) => el("button", {
          type: "button",
          class: "pc-ref-role-pill",
          "aria-pressed": String((item.role || "") === rk),
          onClick: () => {
            const next = items.map((x, j) => (j === idx ? { ...x, role: x.role === rk ? "" : rk } : x));
            onChange(next, true);
          },
        }, rk))
      );

      const noteIn = el("input", {
        type: "text",
        class: "input pc-ref-note-in",
        value: item.note || "",
        placeholder: item.role === "角色长相"
          ? "说明作用：如保留五官发型，衣服按主题重画…"
          : item.role === "构图姿势"
          ? "说明作用：如只参考动作机位，不照搬背景…"
          : "用一句话描述这张参考图的作用（选填）…",
        "aria-label": `参考图 ${idx + 1} 作用说明`,
      });
      noteIn.addEventListener("input", () => {
        items[idx].note = noteIn.value;
        onChange(items, false);
      });

      listWrap.appendChild(el("div", { class: "pc-ref-item" },
        el("div", { class: "pc-ref-item-top" },
          el("div", {
            class: "pc-ref-thumb",
            title: "点击查看大图",
            onClick: () => openImageLightbox(item.path, item.label || `参考图 ${idx + 1}`),
          },
            el("img", { src: localImg(item.path), alt: item.label || `参考图 ${idx + 1}` }),
            el("span", { class: "pc-ref-idx-badge" }, `图${idx + 1}`)
          ),
          el("div", { class: "pc-ref-item-meta" },
            el("div", { class: "pc-ref-item-head" },
              el("span", { class: "pc-ref-item-name", title: item.label || item.path }, item.label || `参考图 ${idx + 1}`),
              el("button", {
                type: "button",
                class: "btn btn-sm",
                style: { padding: "1px 6px", fontSize: "10.5px" },
                onClick: () => {
                  const next = items.filter((_, j) => j !== idx);
                  onChange(next, true);
                },
              }, "移除")
            ),
            rolePills
          )
        ),
        noteIn
      ));
    });

    if (items.length < MAX_REF_IMAGES) {
      listWrap.appendChild(el("button", {
        type: "button",
        class: "pc-add-candidate",
        onClick: () => openRefPickerForList(items, {
          defaultRole,
          defaultNote,
          onPicked: (next) => onChange(next, true),
        }),
      }, `＋ 添加/更换参考图 (${items.length}/${MAX_REF_IMAGES})`));
    }

    return listWrap;
  }

  // ==================== Apply My Recipe Dialog ====================
  function openApplyRecipeModal(paramsNode) {
    if (!recipes.length) {
      toast("暂无已保存的「我的配方」，可先在画廊/生图页保存常用配方");
      return;
    }
    const list = el("div", { class: "col", style: { gap: "8px", maxHeight: "56vh", overflowY: "auto" } });
    recipes.forEach((rec) => {
      const s1 = rec.styleIds?.[0] || rec.style || "";
      const s2 = rec.styleIds?.[1] || rec.style2 || "";
      const stObj = catalog.styles.find((s) => s.number === s1);
      const summary = [s1 && (s2 ? `${s1}+${s2}` : s1), rec.layoutId || rec.layout, rec.ratio, rec.colorId || rec.color].filter(Boolean).join(" · ");
      list.appendChild(el("button", {
        type: "button",
        class: "card row",
        style: { justifyContent: "space-between", padding: "9px 12px", textAlign: "left", cursor: "pointer", gap: "10px" },
        onClick: () => {
          const order = new Set(paramsNode.fieldOrder || Object.keys(paramsNode.fields || {}));
          if (s1) {
            paramsNode.fields.style1 = [s2 ? { style1: s1, style2: s2 } : s1];
            order.add("style1");
          }
          if (rec.layoutId || rec.layout) {
            paramsNode.fields.layout = [rec.layoutId || rec.layout];
            order.add("layout");
          }
          if (rec.ratio) {
            paramsNode.fields.ratio = [rec.ratio];
            order.add("ratio");
          }
          if (rec.colorId || rec.color) {
            paramsNode.fields.colors = [[rec.colorId || rec.color]];
            order.add("colors");
          }
          if (rec.toneId || rec.tone) {
            paramsNode.fields.tones = [[rec.toneId || rec.tone]];
            order.add("tones");
          }
          paramsNode.fieldOrder = Array.from(order);
          closeModal();
          recordEdit(true);
          toast(`已套用配方：${rec.name || s1}`);
        },
      },
      el("div", { class: "row", style: { gap: "10px", minWidth: "0" } },
        stObj?.image ? el("img", { src: packImg(stObj.image), alt: "", style: { width: "36px", height: "36px", borderRadius: "6px", objectFit: "cover" } }) : null,
        el("div", { class: "col", style: { gap: "2px", minWidth: "0" } },
          el("strong", null, rec.name || "未命名配方"),
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, summary || "画风配方")
        )
      ),
      el("span", { class: "badge badge-accent" }, "套用")));
    });
    showModal("套用我的配方", list, [el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭")]);
  }

  // ==================== Spawn Reference Node From Generated Image (Visual Loop #155) ====================
  function promoteImageToReferenceNode(im, anchorNode = null) {
    const imgPath = String(im?.path || "").trim();
    if (!imgPath) return;
    const baseNode = anchorNode || primaryOutputNode();
    const x = baseNode ? Math.round((baseNode.x || 480) + 360) : 840;
    const y = baseNode ? Math.round(baseNode.y || 120) : 120;
    const id = uid("ref");
    const newNode = {
      id,
      type: "reference",
      title: `衍生参考 · ${String(im.theme || "成品图").slice(0, 14)}`,
      refMode: "bundle",
      defaultRole: "垫图重绘",
      defaultNote: "",
      refs: [{
        path: imgPath,
        label: im.theme || "画布生成图",
        role: "垫图重绘",
        note: "基于上轮生成图继续微调或延展",
        source: "work",
      }],
      x,
      y,
    };
    state.graph.nodes.push(newNode);
    state.selectedId = id;
    if (state.view === "guided") state.view = "free";
    recordEdit(true);
    toast("已将成品图转为新的「参考图」节点，可继续连线迭代创作");
  }

  // ==================== Parameter Field Editor ====================
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

      if (fieldName === "refs") {
        card.appendChild(renderReferenceItemsEditor(Array.isArray(val) ? val : [val], {
          defaultRole: "角色长相",
          onChange: (next, shouldReRender) => {
            values[idx] = next;
            recordEdit(shouldReRender);
          },
          emptyText: "添加本组参考图并设定作用",
        }));
      } else if (fieldName === "prompt") {
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
    }, fieldName === "refs" ? "＋ 添加下一组参考图方案" : `＋ 添加${PARAM_LABELS[fieldName] || fieldName}候选`));

    return wrap;
  }

  function buildMatchingBlock(node, isGuided = false) {
    const outInfo = node.type === "output" ? expandOutputNode(node) : null;
    const sources = node.type === "parameters"
      ? (node.fieldOrder || Object.keys(node.fields || {})).filter((f) => Object.hasOwn(node.fields || {}, f)).map((f) => ({
          field: f,
          name: PARAM_LABELS[f] || f,
          values: f === "refs"
            ? (node.fields[f]?.length ? node.fields[f].map((g) => normalizeRefList(Array.isArray(g) ? g : [g])) : [[]])
            : (node.fields[f] || []),
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
            info.img ? el("img", { src: info.local ? localImg(info.img) : packImg(info.img), alt: "" }) : null,
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

  // ==================== Node Card Renderer ====================
  function duplicateNode(node) {
    const copy = structuredClone(node);
    copy.id = uid(node.type);
    copy.x = Math.round((node.x || 40) + 36);
    copy.y = Math.round((node.y || 40) + 36);
    if (copy.type === "output") delete copy.runId;
    state.graph.nodes.push(copy);
    state.selectedId = copy.id;
    recordEdit(true);
    toast("已复制节点");
  }

  function renderNodeCard(node, guidedMode = false) {
    const titleText = node.type === "reference" ? (node.title || "参考图")
      : node.type === "parameters" ? "出图参数"
      : node.type === "parameter" ? (PARAM_LABELS[node.parameter] || node.parameter)
      : node.type === "combine" ? "参数组合"
      : "批量出图";

    const typeCls = node.type === "parameters" ? " pc-parameter-group"
      : node.type === "reference" ? " pc-reference-node"
      : node.type === "output" ? " pc-output-node"
      : "";

    const card = el("section", {
      class: "pc-node" + typeCls + (guidedMode ? " pc-parameter-guided" : "") + (state.selectedId === node.id ? " is-selected" : ""),
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
          title: "输入锚点：点击完成连线或拖线至此",
          "aria-label": `${titleText}输入锚点`,
          onClick: (e) => {
            e.stopPropagation();
            if (!state.connectFrom) return toast("请先点击或按住上游节点右侧的输出圆点拉线");
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
        let suppressClick = false;
        const outPort = el("button", {
          type: "button",
          class: "pc-port pc-port-out" + (state.graph.edges.some((e) => e.from === node.id) ? " is-linked" : ""),
          dataset: { port: "out", node: node.id },
          title: "输出锚点：按住拖拽拉线，或点击后点目标输入锚点",
          "aria-label": `${titleText}输出锚点`,
          onClick: (e) => {
            e.stopPropagation();
            if (suppressClick) { suppressClick = false; return; }
            state.connectFrom = state.connectFrom === node.id ? "" : node.id;
            updatePortsHighlight();
          },
        }, el("span"));

        // Drag-to-wire with live Bezier preview (#155)
        outPort.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const sx = e.clientX;
          const sy = e.clientY;
          dragWireState = { fromId: node.id, startX: sx, startY: sy, curX: 0, curY: 0, active: false };
          const onMove = (me) => {
            if (!dragWireState) return;
            if (!dragWireState.active && Math.hypot(me.clientX - sx, me.clientY - sy) > 5) {
              dragWireState.active = true;
              state.connectFrom = "";
              updatePortsHighlight();
            }
            if (dragWireState.active) {
              const wp = clientToWorld(me.clientX, me.clientY);
              dragWireState.curX = wp.x;
              dragWireState.curY = wp.y;
              drawPreviewWire();
            }
          };
          const onUp = (ue) => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            if (dragWireState?.active) {
              suppressClick = true;
              const targetId = findSnappedInPort(ue.clientX, ue.clientY, node.id);
              dragWireState = null;
              if (targetId && !canConnect(node.id, targetId)) {
                state.graph.edges.push({ id: uid("edge"), from: node.id, to: targetId });
                recordEdit(true);
              } else {
                drawEdges();
                updatePortsHighlight();
              }
            } else {
              dragWireState = null;
            }
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          window.addEventListener("pointercancel", onUp);
        });
        card.appendChild(outPort);
      }
    }

    const headTitleEl = node.type === "reference"
      ? (() => {
          const inp = el("input", {
            type: "text",
            class: "pc-node-title-in",
            value: node.title || "参考图",
            "aria-label": "参考图节点名称",
          });
          inp.addEventListener("input", () => { node.title = inp.value; recordEdit(false); });
          return inp;
        })()
      : el("strong", null, titleText);

    const headActs = el("div", { class: "pc-node-head-acts" },
      !guidedMode
        ? el("button", {
            type: "button",
            class: "icon-btn",
            style: { width: "24px", height: "24px", fontSize: "12px" },
            title: "复制节点",
            "aria-label": `复制${titleText}`,
            onClick: (e) => { e.stopPropagation(); duplicateNode(node); },
          }, "❐")
        : null,
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

    const head = el("header", null, headTitleEl, headActs);

    if (!guidedMode) {
      head.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button, input")) return;
        e.stopPropagation();
        closeCtxMenu();
        state.selectedId = node.id;
        head.classList.add("is-dragging");
        const sx = e.clientX, sy = e.clientY, ox = node.x || 0, oy = node.y || 0;
        const onMove = (me) => {
          node.x = Math.round(ox + (me.clientX - sx) / state.scale);
          node.y = Math.round(oy + (me.clientY - sy) / state.scale);
          card.style.left = `${node.x}px`;
          card.style.top = `${node.y}px`;
          drawEdges();
        };
        const onUp = () => {
          head.classList.remove("is-dragging");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
          recordEdit(false);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
      });
    }

    const body = el("div", { class: "pc-node-body" });

    if (node.type === "reference") {
      const curMode = node.refMode === "variants" ? "variants" : "bundle";
      body.appendChild(el("div", { class: "pc-ref-mode-row", role: "group", "aria-label": "参考图组合模式" },
        el("button", {
          type: "button",
          class: "pc-ref-mode-btn",
          "aria-pressed": String(curMode === "bundle"),
          onClick: () => { node.refMode = "bundle"; recordEdit(true); },
        }, el("strong", null, "固定组合"), el("span", null, "全部参考图同用于每张")),
        el("button", {
          type: "button",
          class: "pc-ref-mode-btn",
          "aria-pressed": String(curMode === "variants"),
          onClick: () => { node.refMode = "variants"; recordEdit(true); },
        }, el("strong", null, "候选轮换"), el("span", null, "每张图参与批量交叉"))
      ));
      body.appendChild(renderReferenceItemsEditor(node.refs || [], {
        defaultRole: node.defaultRole || "角色长相",
        defaultNote: node.defaultNote || "",
        onChange: (next, shouldReRender) => {
          node.refs = next;
          recordEdit(shouldReRender);
        },
      }));
      if (!(node.refs || []).length) {
        body.appendChild(el("span", { class: "muted", style: { fontSize: "11px" } },
          "💡 多个参考图节点连到同一出图/组合节点时，会自动合并为图 1、图 2 并按作用注入提示词。"
        ));
      }
    } else if (node.type === "parameters") {
      const order = (node.fieldOrder || Object.keys(node.fields || {})).filter((f) => Object.hasOwn(node.fields || {}, f));
      const activeField = order.includes(state.activeFieldTabs.get(node.id)) ? state.activeFieldTabs.get(node.id) : (order[0] || "prompt");
      state.activeFieldTabs.set(node.id, activeField);

      const tabsBar = el("div", { class: "pc-field-tabs" },
        ...order.map((f) => {
          const cnt = f === "refs"
            ? (node.fields[f] || []).reduce((acc, g) => acc + normalizeRefList(Array.isArray(g) ? g : [g]).length, 0)
            : (node.fields[f]?.length || 0);
          return el("button", {
            type: "button",
            "aria-pressed": String(f === activeField),
            onClick: () => { state.activeFieldTabs.set(node.id, f); renderWorkspace(); },
          }, `${PARAM_LABELS[f] || f}${cnt > (f === "refs" ? 0 : 1) ? ` (${cnt})` : ""}`);
        })
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

      tabsBar.appendChild(el("button", {
        type: "button",
        title: "从「我的配方」一键填入画风、图型与比例",
        onClick: () => openApplyRecipeModal(node),
      }, "📋 套用配方"));

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
      const repIn = el("input", { class: "input", type: "number", min: "1", max: "200", value: String(node.repeat ?? 1), style: { width: "70px" } });
      repIn.addEventListener("input", () => { node.repeat = Math.max(1, Math.min(200, Number(repIn.value) || 1)); updateStatusAndSummaries(); recordEdit(false); });
      const curRes = RESOLUTIONS.includes(node.resolution) ? node.resolution : "2k";
      const resPills = el("div", { class: "pc-res-pills", role: "group", "aria-label": "分辨率" },
        ...RESOLUTIONS.map((rv) => el("button", {
          type: "button",
          class: "btn btn-sm" + (curRes === rv ? " btn-primary" : ""),
          onClick: () => { node.resolution = rv; recordEdit(true); },
        }, rv.toUpperCase()))
      );
      const exp = expandOutputNode(node);

      body.append(
        el("div", { class: "row", style: { gap: "6px" } }, el("span", { class: "muted", style: { flexShrink: "0" } }, "模型"), mSel),
        el("div", { class: "row", style: { gap: "10px", justifyContent: "space-between", flexWrap: "wrap" } },
          el("div", { class: "row", style: { gap: "6px" } }, el("span", { class: "muted" }, "分辨率"), resPills),
          el("div", { class: "row", style: { gap: "5px" } }, el("span", { class: "muted" }, "张数"), repIn)
        ),
        el("div", { class: "badge" + (exp.error ? " badge-warn" : " badge-accent"), dataset: { outputSummary: node.id } }, exp.error || `预计输出 ${exp.count} 张 · ${curRes.toUpperCase()}`),
        el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => runOutputNode(node, false) }, "▶ 运行生成"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { state.outputNodeId = node.id; state.activePanel = "preview"; renderDrawer(); } }, "预览清单")
        )
      );

      // Embedded Live Results & Result-to-Reference Loop inside Output Node (#155)
      const nodeRun = node.runId ? state.runsById.get(node.runId) : null;
      if (nodeRun && Array.isArray(nodeRun.images) && nodeRun.images.length) {
        const imgs = nodeRun.images;
        const doneCnt = imgs.filter((im) => im.status === "done").length;
        const activeCnt = imgs.filter((im) => im.status === "queued" || im.status === "running").length;
        const thumbs = el("div", { class: "pc-out-thumbs" });
        imgs.slice(0, 6).forEach((im) => {
          if (im.status === "done" && (im.thumb || im.path)) {
            thumbs.appendChild(el("div", { class: "pc-out-thumb-card" },
              el("img", {
                src: localImg(im.thumb || im.path),
                alt: im.theme || "成品图",
                title: "点击查看大图",
                onClick: () => openImageLightbox(im.path, im.theme || "成品预览", [
                  el("button", {
                    type: "button",
                    class: "btn",
                    onClick: () => { closeModal(); promoteImageToReferenceNode(im, node); },
                  }, "🔁 设为参考图节点"),
                ]),
              }),
              el("button", {
                type: "button",
                class: "pc-out-thumb-refbtn",
                title: "将此图转为新的参考图节点继续迭代",
                onClick: (e) => { e.stopPropagation(); promoteImageToReferenceNode(im, node); },
              }, "🔁 设参考")
            ));
          } else {
            thumbs.appendChild(el("div", { class: "pc-out-thumb-card" },
              el("span", { class: "muted", style: { fontSize: "10.5px", textAlign: "center", padding: "4px" } },
                im.status === "failed" ? "失败" : im.status === "running" ? "绘制中…" : "排队中"
              )
            ));
          }
        });
        body.appendChild(el("div", { class: "pc-out-results" },
          el("div", { class: "pc-out-results-head" },
            el("span", null, activeCnt > 0 ? `绘制中 ${doneCnt}/${imgs.length}` : `最近结果 ${doneCnt}/${imgs.length}`),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              style: { padding: "1px 6px", fontSize: "10.5px" },
              onClick: () => { state.activeRun = nodeRun; state.activePanel = "history"; renderDrawer(); },
            }, "全部结果 →")
          ),
          thumbs
        ));
      }
    }

    card.append(head, body);
    return card;
  }

  // ==================== Guided View ====================
  function renderGuidedView() {
    clear(guidedContainer);
    const flow = simpleFlow();
    if (!flow) return;
    const { group, refs, output } = flow;
    const exp = expandOutputNode(output);
    const mSel = buildGroupedModelSelect(modRes, output.modelRef || state.modelRef);
    mSel.style.maxWidth = "100%";
    mSel.addEventListener("change", () => { output.modelRef = mSel.value; state.modelRef = mSel.value; recordEdit(false); });
    const repIn = el("input", { class: "input", type: "number", min: "1", max: "200", value: String(output.repeat ?? 1), style: { width: "76px" } });
    repIn.addEventListener("input", () => { output.repeat = Math.max(1, Math.min(200, Number(repIn.value) || 1)); renderGuidedView(); });
    const curRes = RESOLUTIONS.includes(output.resolution) ? output.resolution : "2k";
    const resPills = el("div", { class: "pc-res-pills" },
      ...RESOLUTIONS.map((rv) => el("button", {
        type: "button",
        class: "btn btn-sm" + (curRes === rv ? " btn-primary" : ""),
        onClick: () => { output.resolution = rv; recordEdit(true); },
      }, rv.toUpperCase()))
    );

    const leftMain = el("main", { class: "col", style: { gap: "12px" } },
      el("div", { class: "pc-step-title" },
        el("span", null, "1"),
        el("div", null, el("h2", null, "准备参数与参考图"), el("p", null, "填写主题、画风、图型，也可添加参考图并说明每张图的作用。"))
      ),
      ...refs.map((rn) => renderNodeCard(rn, true)),
      renderNodeCard(group, true)
    );

    const sidebarRight = el("aside", { class: "pc-guide-sidebar" },
      el("div", null,
        el("div", { class: "pc-step-title" }, el("span", null, "2"), el("div", null, el("h2", null, "这批怎么画"))),
        buildMatchingBlock(group, true),
        el("div", { class: "col", style: { gap: "8px", marginTop: "10px" } },
          el("div", { class: "row", style: { gap: "8px" } }, el("span", { class: "muted" }, "生图模型"), mSel),
          el("div", { class: "row", style: { gap: "8px" } }, el("span", { class: "muted" }, "分辨率"), resPills),
          el("div", { class: "row", style: { gap: "8px" } }, el("span", { class: "muted" }, "每组张数"), repIn)
        )
      ),
      el("div", { style: { borderTop: "1px solid var(--line)", paddingTop: "14px" } },
        el("div", { class: "pc-step-title" }, el("span", null, "3"), el("div", null, el("h2", null, "预览与出图"), el("p", null, "先核对参考图、生成内容与张数，再开始。"))),
        exp.error
          ? el("p", { class: "badge badge-warn" }, exp.error)
          : el("div", { class: "col", style: { gap: "4px" } },
              el("div", { class: "pc-total" }, el("strong", null, String(exp.count)), el("span", null, `张图片 · ${curRes.toUpperCase()}`)),
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

  // ==================== Right Drawer (Preview Plan & History Runs) ====================
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
      const effModel = out?.modelRef || state.modelRef;
      const effRes = RESOLUTIONS.includes(out?.resolution) ? out.resolution : "2k";
      if (!state.selectedOrdinals.size || state.selectedOrdinals.size > exp.items.length) {
        state.selectedOrdinals = new Set(exp.items.map((_, i) => i));
      }

      const quoteLine = el("div", { class: "badge", role: "status" }, "核对预计费用中…");
      const selCount = state.selectedOrdinals.size;
      const goBtn = el("button", {
        type: "button",
        class: "btn btn-primary",
        disabled: selCount === 0,
        onClick: () => runItems(exp.items.filter((_, i) => state.selectedOrdinals.has(i)), false, out),
      }, `开始生成选中的 ${selCount} 张 (${effRes.toUpperCase()})`);

      const listEl = el("div", { class: "pc-plan-list" });
      exp.items.forEach((it, idx) => {
        const chk = el("input", { type: "checkbox", checked: state.selectedOrdinals.has(idx) });
        chk.addEventListener("change", () => {
          if (chk.checked) state.selectedOrdinals.add(idx);
          else state.selectedOrdinals.delete(idx);
          renderDrawer();
        });
        const refRow = Array.isArray(it.refSpecs) && it.refSpecs.length
          ? el("div", { class: "pc-plan-refs" },
              ...it.refSpecs.map((rs, rIdx) => el("span", {
                class: "pc-plan-ref-chip",
                title: rs.note ? `${rs.role || "参考"}：${rs.note}` : (rs.role || rs.label || "参考图"),
              },
                el("img", { src: localImg(rs.path), alt: "" }),
                `图${rIdx + 1}${rs.role ? `·${rs.role}` : ""}${rs.note ? `(${rs.note.slice(0, 12)}${rs.note.length > 12 ? "…" : ""})` : ""}`
              ))
            )
          : null;
        listEl.appendChild(el("label", { class: "pc-plan-item" },
          chk,
          el("div", { class: "col", style: { gap: "3px", minWidth: "0", flex: "1" } },
            el("strong", null, `${idx + 1}. ${it.theme.slice(0, 48)}`),
            el("span", { class: "muted" }, [it.style, it.style2, it.layout, it.ratio, it.color].filter(Boolean).join(" · ")),
            refRow
          )
        ));
      });

      drawerBody.append(quoteLine, goBtn, listEl);

      if (selCount > 0) {
        api("POST", "/api/quote", { modelRef: effModel, resolution: effRes, count: selCount })
          .then((q) => {
            quoteLine.className = "badge " + (q.source === "provider" || q.freeCount > 0 ? "badge-ok" : "");
            quoteLine.textContent = q.source === "provider"
              ? `自带接口直出 · ${effRes.toUpperCase()} · 已选 ${selCount} 张`
              : `已选 ${selCount} 张 (${effRes.toUpperCase()}) · 免费 ${q.freeCount || 0} 张 · 预计 ${money(q.totalCents)}`;
          })
          .catch(() => { quoteLine.textContent = `已选 ${selCount} / ${exp.items.length} 张 · ${effRes.toUpperCase()}`; });
      }
      return;
    }

    // History & Output Results panel with recentRuns switcher (#155)
    drawerTitle.textContent = "出图历史与结果";
    if (state.recentRuns.length > 1) {
      drawerBody.appendChild(el("div", { class: "pc-run-switcher", role: "tablist", "aria-label": "历次生成批次" },
        ...state.recentRuns.slice(0, 10).map((r, idx) => el("button", {
          type: "button",
          class: "pc-run-chip" + (state.activeRun?.id === r.id ? " is-active" : ""),
          title: r.title || r.id,
          onClick: async () => {
            state.activeRun = r;
            renderDrawer();
            try {
              const detail = await api("GET", `/api/works/${encodeURIComponent(r.id)}`);
              if (detail?.run) {
                upsertRun(detail.run);
                state.activeRun = detail.run;
                renderDrawer();
              }
            } catch {}
          },
        }, `${idx === 0 ? "最新 · " : ""}${(r.title || "画布生成").slice(0, 14)}`))
      ));
    }

    const run = state.activeRun;
    if (!run) {
      drawerBody.appendChild(el("p", { class: "muted" }, "当前画布暂无出图记录；先运行一次批量生成即可在此查看成品。"));
      return;
    }
    drawerBody.append(
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
        el("strong", null, run.title || "画布生成结果"),
        el("div", { class: "row", style: { gap: "4px" } },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => exportRun("xiaohongshu") }, "📕 3:4"),
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
          onClick: () => openImageLightbox(im.path, im.theme || "大图预览", [
            el("button", {
              type: "button",
              class: "btn",
              onClick: () => { closeModal(); promoteImageToReferenceNode(im); },
            }, "🔁 设为参考图节点"),
          ]),
        }));
        card.appendChild(el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => api("POST", `/api/images/${encodeURIComponent(im.id)}/copy`).then(() => toast("已复制到剪贴板")) }, "📋 复制"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => promoteImageToReferenceNode(im) }, "🔁 设为参考图节点")
        ));
      } else if (im.status === "failed") {
        card.appendChild(el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => api("POST", `/api/images/${encodeURIComponent(im.id)}/retry`).then(() => toast("已重新入队")) }, "重试"));
      }
      gallery.appendChild(card);
    });
    drawerBody.appendChild(gallery);
  }

  function updateStatusAndSummaries() {
    if (document.activeElement !== titleIn) titleIn.value = state.name || "参数组合画布";
    statusSpan.textContent = state.dirty ? "有未保存改动" : "已保存";
    undoBtn.disabled = !state.undoStack.length;
    redoBtn.disabled = !state.redoStack.length;
    state.graph.nodes.filter((n) => n.type === "output").forEach((n) => {
      const badge = nodesLayer.querySelector(`[data-output-summary="${n.id}"]`);
      if (badge) {
        const exp = expandOutputNode(n);
        const curRes = RESOLUTIONS.includes(n.resolution) ? n.resolution : "2k";
        badge.className = "badge" + (exp.error ? " badge-warn" : " badge-accent");
        badge.textContent = exp.error || `预计输出 ${exp.count} 张 · ${curRes.toUpperCase()}`;
      }
    });
  }

  function renderWorkspace() {
    const guided = state.view === "guided" && canGuide();
    scrollBoard.classList.toggle("hidden", guided);
    guidedContainer.classList.toggle("hidden", !guided);
    edgeActionsBar.hidden = guided || !state.selectedEdgeId;
    wireHint.classList.toggle("hidden", guided);
    zoomOutBtn.classList.toggle("hidden", guided);
    zoomResetBtn.classList.toggle("hidden", guided);
    zoomInBtn.classList.toggle("hidden", guided);
    fitViewBtn.classList.toggle("hidden", guided);
    autoLayoutBtn.classList.toggle("hidden", guided);
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

  // ==================== Actions ====================
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

  function addNodeOfType(type, parameter = "", customPos = null) {
    const existing = state.graph.nodes;
    const x = customPos ? customPos.x : (existing.length
      ? Math.round(existing.reduce((mx, n) => Math.max(mx, (n.x || 0) + (n.type === "parameters" ? 410 : 350)), 36))
      : 36);
    const y = customPos ? customPos.y : (existing.length ? Math.round(48 + ((existing.length - 1) % 3) * 44) : 48);
    const id = uid(type === "reference" ? "ref" : type);
    let node;
    if (type === "reference") {
      const refCount = existing.filter((n) => n.type === "reference").length;
      node = {
        id,
        type: "reference",
        title: refCount ? `参考图 ${refCount + 1}` : "参考图",
        refMode: "bundle",
        defaultRole: "角色长相",
        defaultNote: "",
        refs: [],
        x,
        y,
      };
    } else if (type === "parameters") {
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
      node = { id, type: "output", mode: "cartesian", repeat: 1, resolution: "2k", x, y };
    }
    state.graph.nodes.push(node);
    state.selectedId = id;
    recordEdit(true);
  }

  function openAddNodeDialog() {
    const searchIn = el("input", { class: "input", type: "search", placeholder: "搜索节点，如：参考图、主题、画风、参数组合…" });
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
      toast(exp.error || "请先连接包含有效主题、画风或参考图的节点");
      return;
    }
    await runItems(exp.items, confirmed, outNode);
  }

  async function runItems(items, confirmed, outNode = null) {
    if (!items.length) return;
    const targetOut = outNode || primaryOutputNode();
    const effModel = targetOut?.modelRef || state.modelRef;
    const effRes = RESOLUTIONS.includes(targetOut?.resolution) ? targetOut.resolution : "2k";
    try {
      const res = await api("POST", "/api/generate", {
        mode: "canvas",
        title: `${state.name || "画布"} · 组合`,
        modelRef: effModel,
        resolution: effRes,
        confirmed,
        items,
      });
      if (res.needConfirm) {
        showModal("画布组合费用确认", el("p", null, `本次将批量生成 ${res.count} 张图片（${effRes.toUpperCase()}），预计 ${money(res.totalCents)}。确认执行？`), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); runItems(items, true, targetOut); } }, "确认生成"),
        ]);
        return;
      }
      const runObj = { ...res.run, images: res.images || [] };
      upsertRun(runObj);
      state.activeRun = runObj;
      if (targetOut) targetOut.runId = runObj.id;
      state.activePanel = "history";
      renderWorkspace();
      toast(`已提交 ${items.length} 张组合生图（${effRes.toUpperCase()}）`);
    } catch (e) { toast(e.message); }
  }

  function openTemplatesModal() {
    const body = el("div", { class: "col", style: { gap: "8px", maxHeight: "56vh", overflowY: "auto" } });
    [...builtins, ...userTpls].forEach((tpl) => {
      const data = typeof tpl.data === "string" ? JSON.parse(tpl.data) : (tpl.data || tpl);
      const hasRef = (data.nodes || []).some((n) => n.type === "reference");
      body.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", padding: "10px 12px", gap: "10px" } },
        el("div", { class: "col", style: { gap: "3px", minWidth: "0" } },
          el("div", { class: "row", style: { gap: "6px" } },
            el("strong", null, tpl.name),
            hasRef ? el("span", { class: "badge badge-accent" }, "含参考图") : null
          ),
          el("span", { class: "muted", style: { fontSize: "12px" } }, data.desc || `包含 ${(data.nodes || []).length} 个节点`)
        ),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          style: { flexShrink: "0" },
          onClick: () => {
            state.name = tpl.name;
            state.graph = normalizeGraphData(data, catalog, recipes);
            closeModal();
            recordEdit(true);
            setTimeout(fitView, 20);
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
      placeholder: "描述你想搭建的流程，例如：用 1 张角色参考图保持主角五官，在 4 个四季场景里批量出图，并用 2 种画风横评…",
    });
    const textPicker = createTextModelPicker(modRes, modRes.sceneModels?.canvas || modRes.defaultTextModel || "", "canvas");
    const textSel = textPicker.el;
    textSel.style.maxWidth = "290px";
    showModal("✨ 画布工作流助手", el("div", { class: "col" },
      promptIn,
      el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "10px" } },
        el("span", { class: "muted", style: { fontSize: "12px", flexShrink: "0" } }, "文字服务接口"),
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
            setTimeout(fitView, 20);
            toast("已生成画布节点流程");
          } catch (e) { toast(e.message); }
        },
      }, "自动搭建"),
    ]);
  }

  // ==================== SSE Live Updates (Multi-Run & Embedded Output Cards) ====================
  const unsub = onEvent(async (msg) => {
    if (!root.isConnected) {
      document.removeEventListener("click", onDocClick);
      unbindPaste();
      unsub();
      return;
    }
    const rid = msg.data?.runId || msg.data?.id;
    const isTracked = rid && (
      state.runsById.has(rid)
      || state.activeRun?.id === rid
      || state.graph.nodes.some((n) => n.type === "output" && n.runId === rid)
    );
    if ((msg.type === "job" || msg.type === "run") && isTracked) {
      try {
        const detail = await api("GET", `/api/works/${encodeURIComponent(rid)}`);
        if (detail?.run) {
          upsertRun(detail.run);
          renderWorkspace();
        }
      } catch {}
    }
  });

  renderWorkspace();
}
