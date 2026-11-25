import { api, clear, closeModal, el, getToken, localImg, showModal, toast } from "../api.js";
import { openArticleContextMenu } from "./article-links.js";

const NODE_COLORS = {
  "": { label: "暖纸白", bg: "#fffdf9", border: "#e2dad0" },
  "1": { label: "朱砂粉", bg: "#fff1ef", border: "#eab4ac" },
  "2": { label: "暖杏橙", bg: "#fff5e9", border: "#ebc59d" },
  "3": { label: "鹅蛋黄", bg: "#fffbe6", border: "#e8d88a" },
  "4": { label: "竹叶绿", bg: "#eef8f1", border: "#a9d6b8" },
  "5": { label: "青瓷蓝", bg: "#eef5fc", border: "#adc9e8" },
  "6": { label: "丁香紫", bg: "#f4f0fc", border: "#c6b7e6" },
};

const INK_COLORS = [
  { id: "red", color: "#d9483b", label: "朱红" },
  { id: "indigo", color: "#5b4fb3", label: "靛青" },
  { id: "yellow", color: "rgba(234, 179, 8, 0.55)", label: "荧光黄", width: 12 },
  { id: "ink", color: "#2b2622", label: "墨黑" },
];

function uid(prefix = "n") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function assetUrl(relPath, fromNote = "") {
  if (!relPath) return "";
  if (/^https?:\/\//i.test(relPath)) return relPath;
  if (relPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relPath)) return localImg(relPath);
  const q = new URLSearchParams({ path: relPath, from: fromNote || "", t: getToken() });
  return `/files/vault-asset?${q.toString()}`;
}

function seedCanvasFromMarkdown(title, content, slots, outgoingNotes, notePath) {
  const nodes = [];
  const edges = [];
  const stripped = String(content || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const lines = stripped.split(/\r?\n/);

  // Split markdown into logical sections by H1/H2 headings
  const sections = [];
  let cur = { heading: title || "文章导语", lines: [] };
  for (const ln of lines) {
    const hm = ln.match(/^#{1,2}\s+(.+)$/);
    if (hm) {
      if (cur.lines.some((x) => x.trim())) sections.push(cur);
      cur = { heading: hm[1].trim(), lines: [ln] };
    } else {
      cur.lines.push(ln);
    }
  }
  if (cur.lines.some((x) => x.trim()) || !sections.length) sections.push(cur);

  // Main article outline Frame
  const cols = Math.min(3, Math.max(1, sections.length));
  const cardW = 300;
  const cardH = 190;
  const gapX = 48;
  const gapY = 44;
  const rows = Math.ceil(sections.length / cols);
  const frameW = cols * cardW + (cols + 1) * gapX;
  const frameH = rows * cardH + (rows + 1) * gapY + 42;

  nodes.push({
    id: uid("frame"),
    type: "group",
    label: `01 · ${title || "文章结构"}`,
    x: 60,
    y: 60,
    width: Math.max(420, frameW),
    height: Math.max(300, frameH),
    color: "5",
    handraw: { slideOrder: 1, ratio: "free" },
  });

  let prevSecId = "";
  sections.forEach((sec, idx) => {
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    const id = uid("sec");
    const text = sec.lines.join("\n").trim() || `# ${sec.heading}`;
    nodes.push({
      id,
      type: "text",
      text: text.slice(0, 600),
      x: 60 + gapX + c * (cardW + gapX),
      y: 102 + gapY + r * (cardH + gapY),
      width: cardW,
      height: cardH,
      color: idx === 0 ? "3" : "",
      handraw: { sourceHeading: sec.heading },
    });
    if (prevSecId) {
      edges.push({
        id: uid("e"),
        fromNode: prevSecId,
        fromSide: c === 0 ? "bottom" : "right",
        toNode: id,
        toSide: c === 0 ? "top" : "left",
      });
    }
    prevSecId = id;
  });

  // Add AI Illustration Slots Frame if present
  const validSlots = (slots || []).slice(0, 6);
  if (validSlots.length) {
    const fx = 60 + Math.max(420, frameW) + 80;
    const fh = validSlots.length * 220 + 80;
    nodes.push({
      id: uid("frame"),
      type: "group",
      label: "02 · 手绘风 AI 配图板",
      x: fx,
      y: 60,
      width: 380,
      height: Math.max(300, fh),
      color: "2",
      handraw: { slideOrder: 2, ratio: "3:4" },
    });
    validSlots.forEach((sl, idx) => {
      const sid = uid("ai");
      nodes.push({
        id: sid,
        type: sl.imagePath ? "file" : "text",
        file: sl.imagePath || undefined,
        text: sl.imagePath ? undefined : `🎨 ${sl.title || "配图位"}\n${sl.theme || "点击生成手绘配图"}`,
        x: fx + 34,
        y: 112 + idx * 214,
        width: 312,
        height: 192,
        color: "2",
        handraw: {
          kind: "ai_slot",
          slotId: sl.id || "",
          theme: sl.theme || "",
          ratio: sl.ratio || "4:3",
          imagePath: sl.imagePath || "",
          title: sl.title || "AI 配图",
        },
      });
    });
  }

  // Add Related Wikilinks Notes Frame if present
  const relNotes = (outgoingNotes || []).filter((o) => o.exists && !o.isImage).slice(0, 5);
  if (relNotes.length) {
    const fy = 60 + Math.max(300, frameH) + 70;
    nodes.push({
      id: uid("frame"),
      type: "group",
      label: "03 · 关联双链参考",
      x: 60,
      y: fy,
      width: Math.max(420, relNotes.length * 250 + 50),
      height: 210,
      color: "6",
      handraw: { slideOrder: 3, ratio: "free" },
    });
    relNotes.forEach((o, idx) => {
      nodes.push({
        id: uid("note"),
        type: "file",
        file: o.resolvedPath || `${o.target}.md`,
        x: 92 + idx * 244,
        y: fy + 56,
        width: 224,
        height: 122,
        color: "6",
      });
    });
  }

  return {
    nodes,
    edges,
    handraw: {
      version: 1,
      sourceNote: notePath || "",
      strokes: [],
    },
  };
}

function getPortPoint(node, side) {
  const x = Number(node.x || 0);
  const y = Number(node.y || 0);
  const w = Number(node.width || 240);
  const h = Number(node.height || 140);
  if (side === "top") return { x: x + w / 2, y };
  if (side === "bottom") return { x: x + w / 2, y: y + h };
  if (side === "left") return { x, y: y + h / 2 };
  return { x: x + w, y: y + h / 2 };
}

function bezierPath(p1, s1, p2, s2) {
  const dist = Math.max(48, Math.min(180, Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.42));
  const off = (p, s) => {
    if (s === "top") return { x: p.x, y: p.y - dist };
    if (s === "bottom") return { x: p.x, y: p.y + dist };
    if (s === "left") return { x: p.x - dist, y: p.y };
    return { x: p.x + dist, y: p.y };
  };
  const c1 = off(p1, s1);
  const c2 = off(p2, s2);
  return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
}

export function createArticleEdgelessController(opts) {
  const {
    getActiveNote,
    getActiveCanvasPath,
    getContent,
    getTitle,
    getSlots,
    getOutgoingLinks,
    getVaultNotes,
    onOpenNote,
    onExitEdgeless,
    onToggleFullscreen,
    isFullscreen,
    onProposeSyncToMarkdown,
    onGenerateSlotImage,
    onVaultMutated,
  } = opts;

  const board = {
    canvasPath: "",
    notePath: "",
    data: { nodes: [], edges: [], handraw: { version: 1, strokes: [] } },
    panX: 40,
    panY: 40,
    zoom: 0.9,
    tool: "select", // select | pan | brush
    inkColor: INK_COLORS[0].color,
    inkWidth: 3,
    selectedId: "",
    editingNodeId: "",
    saving: false,
    dirty: false,
    presentingSlide: -1,
    undoStack: [],
    redoStack: [],
  };

  let hostEl = null;
  let stageEl = null;
  let worldEl = null;
  let svgLayer = null;
  let nodesLayer = null;
  let saveStatusEl = null;
  let zoomLblEl = null;
  let saveTimer = null;
  let connectingState = null; // { fromNodeId, fromSide, curX, curY }
  let drawingStroke = null;
  let spaceHeld = false;

  function pushUndo() {
    board.undoStack.push(JSON.stringify(board.data));
    if (board.undoStack.length > 40) board.undoStack.shift();
    board.redoStack = [];
  }

  function undo() {
    if (!board.undoStack.length) return;
    board.redoStack.push(JSON.stringify(board.data));
    board.data = JSON.parse(board.undoStack.pop());
    board.selectedId = "";
    renderWorld();
    scheduleSave();
  }

  function redo() {
    if (!board.redoStack.length) return;
    board.undoStack.push(JSON.stringify(board.data));
    board.data = JSON.parse(board.redoStack.pop());
    board.selectedId = "";
    renderWorld();
    scheduleSave();
  }

  async function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!board.canvasPath && !board.notePath) return;
    board.saving = true;
    if (saveStatusEl) saveStatusEl.textContent = "保存中…";
    try {
      const res = await api("PUT", "/api/article/vault/canvas", {
        path: board.canvasPath || "",
        note: board.canvasPath ? "" : board.notePath,
        data: board.data,
      });
      if (res.path && !board.canvasPath && board.notePath) {
        // companion path confirmed
      }
      board.dirty = false;
      if (saveStatusEl) saveStatusEl.textContent = "✓ 已保存 .canvas";
    } catch (e) {
      if (saveStatusEl) saveStatusEl.textContent = "保存失败";
      toast(e.message || "保存白板失败");
    } finally {
      board.saving = false;
    }
  }

  function scheduleSave() {
    board.dirty = true;
    if (saveStatusEl) saveStatusEl.textContent = "未保存 ●";
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 650);
  }

  function screenToWorld(clientX, clientY) {
    const rect = stageEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left - board.panX) / board.zoom,
      y: (clientY - rect.top - board.panY) / board.zoom,
    };
  }

  function applyTransform() {
    if (!worldEl || !stageEl) return;
    worldEl.style.transform = `translate(${board.panX}px, ${board.panY}px) scale(${board.zoom})`;
    const gridGap = Math.max(12, Math.round(24 * board.zoom));
    stageEl.style.backgroundSize = `${gridGap}px ${gridGap}px`;
    stageEl.style.backgroundPosition = `${Math.round(board.panX)}px ${Math.round(board.panY)}px`;
    if (zoomLblEl) zoomLblEl.textContent = `${Math.round(board.zoom * 100)}%`;
  }

  function fitToView(targetNodes = null) {
    if (!stageEl) return;
    const list = targetNodes && targetNodes.length ? targetNodes : (board.data.nodes || []);
    const rect = stageEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (!list.length) {
      board.zoom = 1;
      board.panX = Math.round(rect.width * 0.15);
      board.panY = 80;
      applyTransform();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    list.forEach((n) => {
      minX = Math.min(minX, Number(n.x || 0));
      minY = Math.min(minY, Number(n.y || 0));
      maxX = Math.max(maxX, Number(n.x || 0) + Number(n.width || 240));
      maxY = Math.max(maxY, Number(n.y || 0) + Number(n.height || 140));
    });
    const bw = Math.max(200, maxX - minX);
    const bh = Math.max(160, maxY - minY);
    const pad = 90;
    const z = Math.min(1.15, Math.max(0.28, Math.min((rect.width - pad * 2) / bw, (rect.height - pad * 2) / bh)));
    board.zoom = z;
    board.panX = Math.round((rect.width - bw * z) / 2 - minX * z);
    board.panY = Math.round((rect.height - bh * z) / 2 - minY * z + 14);
    applyTransform();
  }

  function getFramesOrdered() {
    return (board.data.nodes || [])
      .filter((n) => n.type === "group")
      .sort((a, b) => (Number(a.handraw?.slideOrder || 999) - Number(b.handraw?.slideOrder || 999)) || (a.x - b.x));
  }

  function addNodeAtCenter(nodePartial) {
    pushUndo();
    const rect = stageEl ? stageEl.getBoundingClientRect() : { left: 0, top: 0, width: 1000, height: 640 };
    const center = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const w = nodePartial.width || 280;
    const h = nodePartial.height || 160;
    const node = {
      id: uid(nodePartial.type === "group" ? "frame" : "n"),
      x: Math.round(center.x - w / 2 + (Math.random() - 0.5) * 40),
      y: Math.round(center.y - h / 2 + (Math.random() - 0.5) * 40),
      width: w,
      height: h,
      ...nodePartial,
    };
    board.data.nodes.push(node);
    board.selectedId = node.id;
    renderWorld();
    scheduleSave();
    return node;
  }

  function deleteNode(nodeId) {
    pushUndo();
    board.data.nodes = (board.data.nodes || []).filter((n) => n.id !== nodeId);
    board.data.edges = (board.data.edges || []).filter((e) => e.fromNode !== nodeId && e.toNode !== nodeId);
    if (board.selectedId === nodeId) board.selectedId = "";
    renderWorld();
    scheduleSave();
  }

  function openPickVaultNoteModal() {
    const notes = getVaultNotes?.() || [];
    const filterIn = el("input", { class: "input", placeholder: "搜索笔记标题加入白板…" });
    const listBox = el("div", { class: "col", style: { gap: "4px", maxHeight: "300px", overflowY: "auto" } });
    const renderList = () => {
      clear(listBox);
      const q = filterIn.value.trim().toLowerCase();
      notes.filter((n) => !q || `${n.basename} ${n.path}`.toLowerCase().includes(q)).slice(0, 30).forEach((n) => {
        listBox.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm",
          style: { justifyContent: "flex-start" },
          onClick: () => {
            addNodeAtCenter({ type: "file", file: n.path, width: 240, height: 130, color: "6" });
            closeModal();
          },
        }, `📄 ${n.basename}`, el("span", { class: "muted mono", style: { marginLeft: "auto", fontSize: "11px" } }, n.path)));
      });
    };
    filterIn.addEventListener("input", renderList);
    renderList();
    showModal("将已有笔记添加到白板", el("div", { class: "col", style: { gap: "8px" } }, filterIn, listBox), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    ]);
    filterIn.focus();
  }

  function openSaveAsCanvasModal() {
    const baseName = (getTitle?.() || board.notePath?.split("/").pop()?.replace(/\.md$/i, "") || "新白板").replace(/[\\/:*?"<>|]/g, "-");
    const pathIn = el("input", { class: "input", value: `${baseName}.canvas`, placeholder: "例如：专题分镜.canvas" });
    const submit = async () => {
      const p = pathIn.value.trim();
      if (!p) return toast("请输入白板文件名");
      try {
        const res = await api("PUT", "/api/article/vault/canvas", { path: p, data: board.data });
        closeModal();
        onVaultMutated?.(res.path);
        toast(`已另存为独立白板 ${res.path}（兼容 Obsidian Canvas）`);
      } catch (e) {
        toast(e.message || "另存为白板失败");
      }
    };
    pathIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    showModal("另存为独立 .canvas 白板", el("div", { class: "col", style: { gap: "8px" } },
      el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px" } }, "将遵循 JSON Canvas 1.0 规范保存，左侧目录树与 Obsidian 均可直接打开。"),
      pathIn
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", { type: "button", class: "btn btn-primary", onClick: submit }, "保存"),
    ]);
    pathIn.focus();
  }

  function syncBoardBackToMarkdown() {
    const nodes = board.data.nodes || [];
    const textNodes = nodes
      .filter((n) => n.type === "text" && n.handraw?.kind !== "ai_slot" && String(n.text || "").trim())
      .sort((a, b) => (Math.round(a.y / 120) - Math.round(b.y / 120)) || (a.x - b.x));
    if (!textNodes.length) {
      toast("白板上暂无可同步的文本卡片");
      return;
    }
    const existing = getContent?.() || "";
    const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const fmPrefix = fmMatch ? fmMatch[0] + "\n" : "";
    const nextMd = fmPrefix + textNodes.map((n) => String(n.text || "").trim()).join("\n\n") + "\n";
    onProposeSyncToMarkdown?.(nextMd);
  }

  function renderSvgLayer() {
    if (!svgLayer) return;
    const ns = "http://www.w3.org/2000/svg";
    clear(svgLayer);
    const defs = document.createElementNS(ns, "defs");
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", "ic-edge-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const mPath = document.createElementNS(ns, "path");
    mPath.setAttribute("d", "M 0 1 L 10 5 L 0 9 z");
    mPath.setAttribute("fill", "#6c639e");
    marker.appendChild(mPath);
    defs.appendChild(marker);
    svgLayer.appendChild(defs);

    const byId = new Map((board.data.nodes || []).map((n) => [n.id, n]));

    // 1. Render Connectors (Edges)
    (board.data.edges || []).forEach((edge) => {
      const fn = byId.get(edge.fromNode);
      const tn = byId.get(edge.toNode);
      if (!fn || !tn) return;
      const p1 = getPortPoint(fn, edge.fromSide || "right");
      const p2 = getPortPoint(tn, edge.toSide || "left");
      const d = bezierPath(p1, edge.fromSide || "right", p2, edge.toSide || "left");
      const pathEl = document.createElementNS(ns, "path");
      pathEl.setAttribute("d", d);
      pathEl.setAttribute("fill", "none");
      pathEl.setAttribute("stroke", "#6c639e");
      pathEl.setAttribute("stroke-width", "2");
      pathEl.setAttribute("marker-end", "url(#ic-edge-arrow)");
      pathEl.style.pointerEvents = "stroke";
      pathEl.style.cursor = "pointer";
      pathEl.addEventListener("contextmenu", (ev) => {
        openArticleContextMenu(ev, [
          { header: "连线操作" },
          {
            icon: "✎",
            label: "编辑连线文字",
            onClick: () => {
              const inp = el("input", { class: "input", value: edge.label || "", placeholder: "输入连线说明文字…" });
              showModal("编辑连线标签", inp, [
                el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
                el("button", {
                  type: "button",
                  class: "btn btn-primary",
                  onClick: () => {
                    pushUndo();
                    edge.label = inp.value.trim();
                    closeModal();
                    renderSvgLayer();
                    scheduleSave();
                  },
                }, "确定"),
              ]);
              inp.focus();
            },
          },
          {
            icon: "🗑",
            label: "删除此连线",
            danger: true,
            onClick: () => {
              pushUndo();
              board.data.edges = board.data.edges.filter((x) => x.id !== edge.id);
              renderSvgLayer();
              scheduleSave();
            },
          },
        ]);
      });
      svgLayer.appendChild(pathEl);

      if (edge.label) {
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2 - 6;
        const txt = document.createElementNS(ns, "text");
        txt.setAttribute("x", String(mx));
        txt.setAttribute("y", String(my));
        txt.setAttribute("text-anchor", "middle");
        txt.setAttribute("fill", "#524a42");
        txt.setAttribute("font-size", "12");
        txt.textContent = edge.label;
        svgLayer.appendChild(txt);
      }
    });

    // Active drag-connecting preview edge
    if (connectingState) {
      const fn = byId.get(connectingState.fromNodeId);
      if (fn) {
        const p1 = getPortPoint(fn, connectingState.fromSide);
        const d = bezierPath(p1, connectingState.fromSide, { x: connectingState.curX, y: connectingState.curY }, "left");
        const prev = document.createElementNS(ns, "path");
        prev.setAttribute("d", d);
        prev.setAttribute("fill", "none");
        prev.setAttribute("stroke", "#5b4fb3");
        prev.setAttribute("stroke-width", "2");
        prev.setAttribute("stroke-dasharray", "5 4");
        svgLayer.appendChild(prev);
      }
    }

    // 2. Render Freehand Ink Strokes
    const strokes = board.data.handraw?.strokes || [];
    const allStrokes = drawingStroke ? [...strokes, drawingStroke] : strokes;
    allStrokes.forEach((st) => {
      if (!Array.isArray(st.points) || st.points.length < 2) return;
      const d = st.points.map((pt, i) => `${i === 0 ? "M" : "L"} ${pt[0]} ${pt[1]}`).join(" ");
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", st.color || "#d9483b");
      p.setAttribute("stroke-width", String(st.width || 3));
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      svgLayer.appendChild(p);
    });
  }

  function renderWorld() {
    if (!nodesLayer) return;
    clear(nodesLayer);
    const nodes = board.data.nodes || [];
    // Render groups (Frames) first so they sit cleanly behind cards
    const sorted = [...nodes].sort((a, b) => (a.type === "group" ? 0 : 1) - (b.type === "group" ? 0 : 1));

    sorted.forEach((node) => {
      const palette = NODE_COLORS[String(node.color || "")] || NODE_COLORS[""];
      const isSelected = board.selectedId === node.id;
      const isFrame = node.type === "group";
      const isAiSlot = node.handraw?.kind === "ai_slot";
      const isNoteFile = node.type === "file" && /\.(md|markdown)$/i.test(String(node.file || ""));
      const isImgFile = node.type === "file" && !isNoteFile;

      const card = el("div", {
        class: `ic-eg-node is-${node.type}` + (isAiSlot ? " is-ai-slot" : "") + (isSelected ? " is-selected" : ""),
        dataset: { nodeId: node.id },
        style: {
          left: `${Math.round(node.x || 0)}px`,
          top: `${Math.round(node.y || 0)}px`,
          width: `${Math.round(node.width || 260)}px`,
          height: `${Math.round(node.height || 150)}px`,
          background: isFrame ? `color-mix(in srgb, ${palette.bg} 72%, transparent)` : palette.bg,
          borderColor: isSelected ? "#5b4fb3" : palette.border,
        },
      });

      if (isFrame) {
        const frameHead = el("div", { class: "ic-eg-frame-head" },
          el("span", { class: "ic-eg-frame-badge" }, `Frame ${node.handraw?.slideOrder || ""}`),
          el("span", { class: "ic-eg-frame-label" }, node.label || "未命名画框"),
          node.handraw?.ratio && node.handraw.ratio !== "free"
            ? el("span", { class: "ic-eg-frame-ratio mono" }, node.handraw.ratio)
            : null
        );
        frameHead.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          const inp = el("input", { class: "input", value: node.label || "" });
          showModal("重命名画框 Frame", inp, [
            el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
            el("button", {
              type: "button",
              class: "btn btn-primary",
              onClick: () => {
                pushUndo();
                node.label = inp.value.trim() || "画框";
                closeModal();
                renderWorld();
                scheduleSave();
              },
            }, "确定"),
          ]);
          inp.focus();
        });
        card.appendChild(frameHead);
      } else if (isAiSlot) {
        const imgPath = node.handraw?.imagePath || (isImgFile ? node.file : "");
        card.append(
          el("div", { class: "ic-eg-ai-head" },
            el("span", { class: "badge badge-accent" }, `🎨 ${node.handraw?.title || "AI 配图"}`),
            el("span", { class: "mono muted", style: { fontSize: "11px" } }, node.handraw?.ratio || "4:3")
          ),
          imgPath
            ? el("div", { class: "ic-eg-img-wrap" }, el("img", { src: assetUrl(imgPath, board.notePath), alt: node.handraw?.title || "AI 配图" }))
            : el("div", { class: "ic-eg-ai-body" },
                el("p", { style: { margin: 0, fontSize: "12.5px", lineHeight: "1.5" } }, node.handraw?.theme || node.text || "双击填写画面主题…"),
                el("button", {
                  type: "button",
                  class: "btn btn-sm btn-primary",
                  onMouseDown: (ev) => ev.stopPropagation(),
                  onClick: (ev) => {
                    ev.stopPropagation();
                    onGenerateSlotImage?.(node.handraw);
                  },
                }, "✨ 生成此图")
              )
        );
      } else if (isNoteFile) {
        const noteName = String(node.file || "").split("/").pop().replace(/\.(md|markdown)$/i, "");
        card.append(
          el("div", { class: "ic-eg-note-head" },
            el("span", null, "📄 关联笔记"),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onMouseDown: (ev) => ev.stopPropagation(),
              onClick: (ev) => { ev.stopPropagation(); onOpenNote?.(node.file); },
            }, "打开 ↗")
          ),
          el("div", { class: "ic-eg-note-title" }, noteName),
          el("div", { class: "mono muted", style: { fontSize: "11px", wordBreak: "break-all" } }, node.file)
        );
      } else if (isImgFile) {
        card.appendChild(el("div", { class: "ic-eg-img-wrap" },
          el("img", { src: assetUrl(node.file, board.notePath), alt: node.file })
        ));
      } else {
        // Text / Sticky Note card
        if (board.editingNodeId === node.id) {
          const ta = el("textarea", { class: "ic-eg-text-ta" });
          ta.value = node.text || "";
          ta.addEventListener("mousedown", (ev) => ev.stopPropagation());
          ta.addEventListener("input", () => { node.text = ta.value; scheduleSave(); });
          ta.addEventListener("blur", () => {
            board.editingNodeId = "";
            renderWorld();
          });
          ta.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape") { board.editingNodeId = ""; renderWorld(); }
          });
          card.appendChild(ta);
          requestAnimationFrame(() => ta.focus());
        } else {
          const textBody = el("div", { class: "ic-eg-text-body" }, node.text || "双击编辑内容…");
          textBody.addEventListener("dblclick", (ev) => {
            ev.stopPropagation();
            pushUndo();
            board.editingNodeId = node.id;
            renderWorld();
          });
          card.appendChild(textBody);
        }
      }

      // 4 Connector Anchor Ports (top/right/bottom/left)
      ["top", "right", "bottom", "left"].forEach((side) => {
        const port = el("div", {
          class: `ic-eg-port is-${side}`,
          title: "拖出连线到另一张卡片",
          onMouseDown: (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            const pt = screenToWorld(ev.clientX, ev.clientY);
            connectingState = { fromNodeId: node.id, fromSide: side, curX: pt.x, curY: pt.y };
            renderSvgLayer();
            const onMove = (mEv) => {
              const p = screenToWorld(mEv.clientX, mEv.clientY);
              connectingState.curX = p.x;
              connectingState.curY = p.y;
              renderSvgLayer();
            };
            const onUp = (uEv) => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
              const targetEl = document.elementFromPoint(uEv.clientX, uEv.clientY)?.closest?.(".ic-eg-node");
              const targetId = targetEl?.dataset?.nodeId;
              if (targetId && targetId !== node.id) {
                pushUndo();
                board.data.edges.push({
                  id: uid("e"),
                  fromNode: node.id,
                  fromSide: side,
                  toNode: targetId,
                  toSide: side === "right" ? "left" : (side === "left" ? "right" : (side === "bottom" ? "top" : "bottom")),
                });
                scheduleSave();
              }
              connectingState = null;
              renderSvgLayer();
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          },
        });
        card.appendChild(port);
      });

      // Resize corner handle
      const resizeHandle = el("div", {
        class: "ic-eg-resize",
        title: "拖动调整卡片大小",
        onMouseDown: (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          pushUndo();
          const sx = ev.clientX, sy = ev.clientY;
          const sw = Number(node.width || 260), sh = Number(node.height || 150);
          const onMove = (mEv) => {
            node.width = Math.max(160, Math.round(sw + (mEv.clientX - sx) / board.zoom));
            node.height = Math.max(90, Math.round(sh + (mEv.clientY - sy) / board.zoom));
            card.style.width = `${node.width}px`;
            card.style.height = `${node.height}px`;
            renderSvgLayer();
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            scheduleSave();
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        },
      });
      card.appendChild(resizeHandle);

      // Node Dragging (if Frame, automatically carry enclosed child nodes!)
      card.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0 || board.tool !== "select" || spaceHeld) return;
        if (ev.target.closest("textarea, button, .ic-eg-port, .ic-eg-resize")) return;
        ev.stopPropagation();
        board.selectedId = node.id;
        nodesLayer.querySelectorAll(".ic-eg-node.is-selected").forEach((n) => n.classList.remove("is-selected"));
        card.classList.add("is-selected");

        const sx = ev.clientX, sy = ev.clientY;
        const ox = Number(node.x || 0), oy = Number(node.y || 0);
        // Find enclosed child nodes when dragging a Frame!
        const carried = isFrame
          ? (board.data.nodes || []).filter((other) => {
              if (other.id === node.id || other.type === "group") return false;
              const cx = Number(other.x || 0) + Number(other.width || 0) / 2;
              const cy = Number(other.y || 0) + Number(other.height || 0) / 2;
              return cx >= ox && cx <= ox + Number(node.width || 0) && cy >= oy && cy <= oy + Number(node.height || 0);
            }).map((other) => ({ node: other, ox: Number(other.x || 0), oy: Number(other.y || 0), el: nodesLayer.querySelector(`[data-node-id="${other.id}"]`) }))
          : [];

        let moved = false;
        const onMove = (mEv) => {
          const dx = (mEv.clientX - sx) / board.zoom;
          const dy = (mEv.clientY - sy) / board.zoom;
          if (!moved && Math.hypot(dx, dy) > 3) {
            moved = true;
            pushUndo();
          }
          if (!moved) return;
          node.x = Math.round(ox + dx);
          node.y = Math.round(oy + dy);
          card.style.left = `${node.x}px`;
          card.style.top = `${node.y}px`;
          carried.forEach((c) => {
            c.node.x = Math.round(c.ox + dx);
            c.node.y = Math.round(c.oy + dy);
            if (c.el) {
              c.el.style.left = `${c.node.x}px`;
              c.el.style.top = `${c.node.y}px`;
            }
          });
          renderSvgLayer();
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          if (moved) scheduleSave();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });

      // Right-click node context menu
      card.addEventListener("contextmenu", (ev) => {
        board.selectedId = node.id;
        openArticleContextMenu(ev, [
          { header: isFrame ? `Frame：${node.label || "画框"}` : "卡片操作" },
          node.type === "text" && !isAiSlot ? {
            icon: "✎",
            label: "编辑文字",
            onClick: () => { pushUndo(); board.editingNodeId = node.id; renderWorld(); },
          } : null,
          isNoteFile ? { icon: "↗", label: "打开关联笔记", onClick: () => onOpenNote?.(node.file) } : null,
          {
            icon: "🎨",
            label: "卡片颜色",
            children: Object.entries(NODE_COLORS).map(([cid, info]) => ({
              swatch: info.bg,
              label: info.label,
              onClick: () => {
                pushUndo();
                node.color = cid;
                renderWorld();
                scheduleSave();
              },
            })),
          },
          {
            icon: "⧉",
            label: "复制一份",
            onClick: () => {
              pushUndo();
              const copy = structuredClone(node);
              copy.id = uid("n");
              copy.x = Number(node.x || 0) + 32;
              copy.y = Number(node.y || 0) + 32;
              board.data.nodes.push(copy);
              board.selectedId = copy.id;
              renderWorld();
              scheduleSave();
            },
          },
          { sep: true },
          { icon: "🗑", label: "删除", danger: true, onClick: () => deleteNode(node.id) },
        ]);
      });

      nodesLayer.appendChild(card);
    });

    renderSvgLayer();
  }

  function stepSlide(delta) {
    const frames = getFramesOrdered();
    if (!frames.length) {
      toast("白板上还没有 Frame 画框，请先点击底部「▭ 画框」添加");
      return;
    }
    if (board.presentingSlide < 0) board.presentingSlide = 0;
    else board.presentingSlide = (board.presentingSlide + delta + frames.length) % frames.length;
    const f = frames[board.presentingSlide];
    fitToView([f]);
    toast(`分镜演示 ${board.presentingSlide + 1}/${frames.length}：${f.label || "画框"}`);
  }

  async function mount(container, { canvasPath = "", notePath = "" } = {}) {
    if (!container) return;
    hostEl = container;
    board.canvasPath = canvasPath || "";
    board.notePath = notePath || (canvasPath ? "" : (getActiveNote?.() || ""));
    board.selectedId = "";
    board.editingNodeId = "";
    board.presentingSlide = -1;
    board.undoStack = [];
    board.redoStack = [];

    clear(container);

    // Load saved .canvas (or seed automatically from current Markdown note!)
    try {
      const qs = board.canvasPath
        ? `path=${encodeURIComponent(board.canvasPath)}`
        : `note=${encodeURIComponent(board.notePath)}`;
      const res = await api("GET", `/api/article/vault/canvas?${qs}`);
      if (res.exists && res.data && Array.isArray(res.data.nodes) && res.data.nodes.length > 0) {
        board.data = res.data;
        if (!board.data.handraw) board.data.handraw = { version: 1, strokes: [] };
        if (!Array.isArray(board.data.handraw.strokes)) board.data.handraw.strokes = [];
      } else if (board.notePath) {
        board.data = seedCanvasFromMarkdown(
          getTitle?.() || "",
          getContent?.() || "",
          getSlots?.() || [],
          getOutgoingLinks?.() || [],
          board.notePath
        );
        scheduleSave();
      } else {
        board.data = { nodes: [], edges: [], handraw: { version: 1, strokes: [] } };
      }
    } catch {
      board.data = { nodes: [], edges: [], handraw: { version: 1, strokes: [] } };
    }

    const ns = "http://www.w3.org/2000/svg";
    svgLayer = document.createElementNS(ns, "svg");
    svgLayer.setAttribute("class", "ic-eg-svg");
    nodesLayer = el("div", { class: "ic-eg-nodes" });
    worldEl = el("div", { class: "ic-eg-world" }, svgLayer, nodesLayer);
    stageEl = el("div", { class: "ic-eg-stage" }, worldEl);

    // Stage Mouse Interactions: Pan / Brush Draw / Right-click Empty Canvas
    stageEl.addEventListener("mousedown", (ev) => {
      if (ev.button === 1 || (ev.button === 0 && (board.tool === "pan" || spaceHeld))) {
        ev.preventDefault();
        const sx = ev.clientX, sy = ev.clientY;
        const spx = board.panX, spy = board.panY;
        stageEl.classList.add("is-panning");
        const onMove = (mEv) => {
          board.panX = Math.round(spx + (mEv.clientX - sx));
          board.panY = Math.round(spy + (mEv.clientY - sy));
          applyTransform();
        };
        const onUp = () => {
          stageEl.classList.remove("is-panning");
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return;
      }
      if (ev.button === 0 && board.tool === "brush") {
        ev.preventDefault();
        const pt = screenToWorld(ev.clientX, ev.clientY);
        drawingStroke = { id: uid("s"), color: board.inkColor, width: board.inkWidth, points: [[Math.round(pt.x), Math.round(pt.y)]] };
        renderSvgLayer();
        const onMove = (mEv) => {
          const p = screenToWorld(mEv.clientX, mEv.clientY);
          drawingStroke.points.push([Math.round(p.x), Math.round(p.y)]);
          renderSvgLayer();
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          if (drawingStroke && drawingStroke.points.length >= 2) {
            pushUndo();
            if (!board.data.handraw) board.data.handraw = { version: 1, strokes: [] };
            if (!Array.isArray(board.data.handraw.strokes)) board.data.handraw.strokes = [];
            board.data.handraw.strokes.push(drawingStroke);
            scheduleSave();
          }
          drawingStroke = null;
          renderSvgLayer();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return;
      }
      if (ev.button === 0 && ev.target === stageEl) {
        board.selectedId = "";
        board.editingNodeId = "";
        renderWorld();
      }
    });

    stageEl.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) > 0) {
        const rect = stageEl.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const factor = ev.deltaY < 0 ? 1.1 : 0.91;
        const nextZoom = Math.min(2.4, Math.max(0.22, board.zoom * factor));
        const wx = (mx - board.panX) / board.zoom;
        const wy = (my - board.panY) / board.zoom;
        board.zoom = nextZoom;
        board.panX = Math.round(mx - wx * nextZoom);
        board.panY = Math.round(my - wy * nextZoom);
        applyTransform();
      }
    }, { passive: false });

    stageEl.addEventListener("contextmenu", (ev) => {
      if (ev.target.closest(".ic-eg-node")) return;
      const pt = screenToWorld(ev.clientX, ev.clientY);
      openArticleContextMenu(ev, [
        { header: "白板画布操作" },
        {
          icon: "📝",
          label: "在此新建便签卡片",
          onClick: () => {
            pushUndo();
            const n = { id: uid("n"), type: "text", text: "新灵感便签", x: Math.round(pt.x), y: Math.round(pt.y), width: 260, height: 140, color: "3" };
            board.data.nodes.push(n);
            board.editingNodeId = n.id;
            renderWorld();
            scheduleSave();
          },
        },
        {
          icon: "▭",
          label: "在此新建 Frame 画框",
          onClick: () => {
            pushUndo();
            const ord = getFramesOrdered().length + 1;
            board.data.nodes.push({
              id: uid("frame"),
              type: "group",
              label: `0${ord} · 新画框`,
              x: Math.round(pt.x),
              y: Math.round(pt.y),
              width: 480,
              height: 340,
              color: "5",
              handraw: { slideOrder: ord, ratio: "free" },
            });
            renderWorld();
            scheduleSave();
          },
        },
        { icon: "📄", label: "插入已有笔记卡片…", onClick: () => openPickVaultNoteModal() },
        {
          icon: "🎨",
          label: "在此新建 AI 配图卡",
          onClick: () => {
            pushUndo();
            board.data.nodes.push({
              id: uid("ai"),
              type: "text",
              x: Math.round(pt.x),
              y: Math.round(pt.y),
              width: 300,
              height: 180,
              color: "2",
              handraw: { kind: "ai_slot", title: "新 AI 配图", theme: "暖纸水彩风格插画", ratio: "4:3" },
            });
            renderWorld();
            scheduleSave();
          },
        },
        { sep: true },
        { icon: "⌖", label: "自适应缩放显示全部", onClick: () => fitToView() },
        {
          icon: "🧹",
          label: "清空所有手绘涂鸦",
          danger: true,
          onClick: () => {
            pushUndo();
            if (board.data.handraw) board.data.handraw.strokes = [];
            renderSvgLayer();
            scheduleSave();
          },
        },
      ]);
    });

    // Top Floating Bar
    saveStatusEl = el("span", { class: "badge" }, "JSON Canvas 1.0");
    zoomLblEl = el("span", { class: "mono muted", style: { fontSize: "11.5px", minWidth: "38px", textAlign: "center" } }, "90%");
    const fsBtn = el("button", {
      type: "button",
      class: "btn btn-sm" + (isFullscreen?.() ? " btn-primary" : ""),
      onClick: () => {
        onToggleFullscreen?.();
        const fs = Boolean(isFullscreen?.());
        fsBtn.classList.toggle("btn-primary", fs);
        fsBtn.textContent = fs ? "✕ 退出全屏" : "⛶ 专注全屏";
        setTimeout(() => fitToView(), 80);
      },
    }, isFullscreen?.() ? "✕ 退出全屏" : "⛶ 专注全屏");

    const topBar = el("div", { class: "ic-ws-graph-bar ic-eg-topbar" },
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => onExitEdgeless?.() }, "← 返回文章"),
        el("strong", { style: { fontSize: "13px" } }, board.canvasPath ? `🎨 ${board.canvasPath}` : `🎨 白板 · ${getTitle?.() || "当前文章"}`),
        saveStatusEl
      ),
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        board.notePath ? el("button", {
          type: "button",
          class: "btn btn-sm",
          title: "按当前文章章节重新生成初始白板卡片",
          onClick: () => {
            pushUndo();
            board.data = seedCanvasFromMarkdown(getTitle?.() || "", getContent?.() || "", getSlots?.() || [], getOutgoingLinks?.() || [], board.notePath);
            renderWorld();
            fitToView();
            scheduleSave();
            toast("已从当前文章重新提取章节与配图卡片");
          },
        }, "↻ 从正文提取") : null,
        board.notePath ? el("button", {
          type: "button",
          class: "btn btn-sm",
          title: "汇总白板文本卡片并打开差异 Diff 审阅确认回写",
          onClick: () => syncBoardBackToMarkdown(),
        }, "📝 同步回正文") : null,
        el("button", { type: "button", class: "btn btn-sm", title: "按 Frame 顺序分镜巡览", onClick: () => stepSlide(1) }, "▶ 分镜演示"),
        el("button", { type: "button", class: "btn btn-sm", title: "另存为独立 .canvas 文件（Obsidian 互通）", onClick: () => openSaveAsCanvasModal() }, "💾 存为 .canvas"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => fitToView() }, "⌖ 适应"),
        zoomLblEl,
        fsBtn
      )
    );

    // Bottom Floating AFFiNE-Style Creation Dock
    const toolBtns = {};
    const setTool = (t) => {
      board.tool = t;
      Object.entries(toolBtns).forEach(([k, btn]) => btn.classList.toggle("is-active", k === t));
      stageEl.dataset.tool = t;
      inkSwatchesWrap.classList.toggle("hidden", t !== "brush");
    };

    const inkSwatchesWrap = el("div", { class: "ic-eg-ink-dots hidden" },
      ...INK_COLORS.map((ic, idx) => {
        const dot = el("button", {
          type: "button",
          class: "ic-eg-ink-dot" + (idx === 0 ? " is-active" : ""),
          title: `画笔颜色：${ic.label}`,
          style: { background: ic.color },
          onClick: () => {
            board.inkColor = ic.color;
            board.inkWidth = ic.width || 3;
            inkSwatchesWrap.querySelectorAll(".ic-eg-ink-dot").forEach((d) => d.classList.remove("is-active"));
            dot.classList.add("is-active");
          },
        });
        return dot;
      })
    );

    toolBtns.select = el("button", { type: "button", class: "ic-eg-dock-btn is-active", title: "选择与拖动 (V)", onClick: () => setTool("select") }, "↖ 选择");
    toolBtns.pan = el("button", { type: "button", class: "ic-eg-dock-btn", title: "平移画布 (H / 按住空格)", onClick: () => setTool("pan") }, "✋ 抓手");
    toolBtns.brush = el("button", { type: "button", class: "ic-eg-dock-btn", title: "自由手绘涂鸦 (P)", onClick: () => setTool("brush") }, "🖌 画笔");

    const dock = el("div", { class: "ic-eg-dock", role: "toolbar", "aria-label": "无边白板工具条" },
      toolBtns.select,
      toolBtns.pan,
      toolBtns.brush,
      inkSwatchesWrap,
      el("span", { class: "ic-eg-dock-sep" }),
      el("button", {
        type: "button",
        class: "ic-eg-dock-btn",
        title: "新增便签卡片",
        onClick: () => {
          setTool("select");
          const n = addNodeAtCenter({ type: "text", text: "新灵感便签", width: 260, height: 145, color: "3" });
          board.editingNodeId = n.id;
          renderWorld();
        },
      }, "📝 便签"),
      el("button", {
        type: "button",
        class: "ic-eg-dock-btn",
        title: "新增 Frame 分组画框",
        onClick: () => {
          setTool("select");
          const ord = getFramesOrdered().length + 1;
          addNodeAtCenter({
            type: "group",
            label: `0${ord} · 新分镜画框`,
            width: 500,
            height: 350,
            color: "5",
            handraw: { slideOrder: ord, ratio: "3:4" },
          });
        },
      }, "▭ 画框"),
      el("button", {
        type: "button",
        class: "ic-eg-dock-btn",
        title: "插入手绘风 AI 配图卡片",
        onClick: () => {
          setTool("select");
          addNodeAtCenter({
            type: "text",
            width: 300,
            height: 185,
            color: "2",
            handraw: { kind: "ai_slot", title: "白板 AI 配图", theme: "暖纸手绘风格插画", ratio: "4:3" },
          });
        },
      }, "🎨 配图卡"),
      el("button", {
        type: "button",
        class: "ic-eg-dock-btn",
        title: "关联一篇已有 Markdown 笔记",
        onClick: () => openPickVaultNoteModal(),
      }, "📄 笔记卡"),
      el("span", { class: "ic-eg-dock-sep" }),
      el("button", { type: "button", class: "ic-eg-dock-btn", title: "撤销 (Ctrl+Z)", onClick: undo }, "↩"),
      el("button", { type: "button", class: "ic-eg-dock-btn", title: "重做 (Ctrl+Y)", onClick: redo }, "↪")
    );

    container.append(stageEl, topBar, dock);
    renderWorld();
    requestAnimationFrame(() => fitToView());
  }

  function destroy() {
    if (saveTimer) {
      saveNow();
    }
    if (hostEl) clear(hostEl);
    stageEl = null;
    worldEl = null;
    svgLayer = null;
    nodesLayer = null;
  }

  return {
    mount,
    destroy,
    fitToView,
    saveNow,
    undo,
    redo,
  };
}
