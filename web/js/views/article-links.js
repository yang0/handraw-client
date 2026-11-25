import { api, clear, closeModal, el, getToken, openURL, showModal, toast } from "../api.js";

const WIKILINK_RE = /(!)?\[\[([^\[\]\r\n]+)\]\]/g;

function vaultAssetUrl(rawPath, fromNote = "") {
  const q = new URLSearchParams({ path: String(rawPath || ""), t: getToken() });
  if (fromNote) q.set("from", fromNote);
  return `/files/vault-asset?${q.toString()}`;
}

function isImagePath(p) {
  return /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(String(p || "").trim());
}

function parseWikilinkInner(inner) {
  let targetPart = String(inner || "");
  let alias = "";
  const pipe = targetPart.indexOf("|");
  if (pipe >= 0) {
    alias = targetPart.slice(pipe + 1).trim();
    targetPart = targetPart.slice(0, pipe);
  }
  let heading = "";
  const hash = targetPart.indexOf("#");
  if (hash >= 0) {
    heading = targetPart.slice(hash + 1).trim();
    targetPart = targetPart.slice(0, hash);
  }
  return { target: targetPart.trim(), heading, alias };
}

function parseFrontmatterEntries(rawContent) {
  const m = String(rawContent || "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return [];
  const entries = [];
  const lines = m[1].split(/\r?\n/);
  let cur = null;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    if (/^\s*-\s+/.test(raw) && cur) {
      cur.values.push(t.replace(/^-\s+/, "").replace(/^["']|["']$/g, ""));
      continue;
    }
    const idx = raw.indexOf(":");
    if (idx > 0 && !raw.startsWith(" ")) {
      const key = raw.slice(0, idx).trim();
      const val = raw.slice(idx + 1).trim();
      let values = [];
      if (val.startsWith("[") && val.endsWith("]")) {
        values = val.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      } else if (val) {
        values = [val.replace(/^["']|["']$/g, "")];
      }
      cur = { key, values };
      entries.push(cur);
    }
  }
  return entries.filter((e) => e.values.length > 0);
}

function appendHighlightedSnippet(container, snippet, highlightTerm = "") {
  const text = String(snippet || "");
  if (!text) return;
  // Highlight [[...]] wikilinks and optional match term
  const parts = [];
  const re = /(!?\[\[[^\[\]\r\n]+\]\])/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: "text", val: text.slice(last, m.index) });
    parts.push({ kind: "link", val: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", val: text.slice(last) });

  const termLow = String(highlightTerm || "").trim().toLowerCase();
  for (const p of parts) {
    if (p.kind === "link") {
      container.appendChild(el("mark", { class: "ic-links-mark" }, p.val));
    } else if (termLow) {
      const low = p.val.toLowerCase();
      const idx = low.indexOf(termLow);
      if (idx >= 0) {
        if (idx > 0) container.appendChild(document.createTextNode(p.val.slice(0, idx)));
        container.appendChild(el("mark", { class: "ic-links-mark is-mention" }, p.val.slice(idx, idx + termLow.length)));
        if (idx + termLow.length < p.val.length) container.appendChild(document.createTextNode(p.val.slice(idx + termLow.length)));
      } else {
        container.appendChild(document.createTextNode(p.val));
      }
    } else {
      container.appendChild(document.createTextNode(p.val));
    }
  }
}

function appendMatchHighlight(parent, text, query) {
  const s = String(text || "");
  const q = String(query || "").trim();
  if (!q) {
    parent.textContent = s;
    return;
  }
  const idx = s.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) {
    parent.textContent = s;
    return;
  }
  if (idx > 0) parent.appendChild(document.createTextNode(s.slice(0, idx)));
  parent.appendChild(el("mark", { class: "ic-link-ac-hl" }, s.slice(idx, idx + q.length)));
  if (idx + q.length < s.length) parent.appendChild(document.createTextNode(s.slice(idx + q.length)));
}

function getTextareaCaretCoords(ta, pos) {
  const rect = ta.getBoundingClientRect();
  const cs = window.getComputedStyle(ta);
  const mirror = document.createElement("div");
  const props = [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
    "textTransform", "wordSpacing", "whiteSpace", "wordWrap", "overflowWrap",
  ];
  mirror.style.position = "fixed";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.left = "-9999px";
  mirror.style.top = "0";
  props.forEach((p) => { mirror.style[p] = cs[p]; });
  mirror.style.whiteSpace = "pre-wrap";
  mirror.textContent = ta.value.slice(0, pos);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lh = parseFloat(cs.lineHeight || "22") || 22;
  const left = rect.left + marker.offsetLeft - ta.scrollLeft;
  const top = rect.top + marker.offsetTop - ta.scrollTop + lh;
  mirror.remove();
  const popW = 340;
  const popH = 290;
  return {
    left: Math.max(12, Math.min(left, window.innerWidth - popW - 14)),
    top: top + popH > window.innerHeight - 16
      ? Math.max(48, top - lh - popH - 6)
      : Math.max(48, top + 4),
  };
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

// ---------- Reusable Obsidian-Style Multi-Level Cascading Context Menu (#121, #124) ----------
let activeCtxMenus = [];
let activeCtxCleanup = null;

export function closeArticleContextMenu() {
  if (activeCtxCleanup) { activeCtxCleanup(); activeCtxCleanup = null; }
  while (activeCtxMenus.length) {
    const m = activeCtxMenus.pop();
    if (m && m.isConnected) m.remove();
  }
}

export function openArticleContextMenu(ev, items) {
  ev.preventDefault();
  ev.stopPropagation();
  closeArticleContextMenu();
  const validRoot = (items || []).filter(Boolean);
  if (!validRoot.length) return;

  function trimLevels(keepDepth) {
    while (activeCtxMenus.length > keepDepth) {
      const m = activeCtxMenus.pop();
      if (m && m.isConnected) m.remove();
    }
  }

  function buildMenuLevel(itemList, depth, anchorRect, fallbackX, fallbackY) {
    const valid = (itemList || []).filter(Boolean);
    if (!valid.length) return null;
    trimLevels(depth);

    const menu = el("div", {
      class: "ic-ctx-menu" + (depth > 0 ? " is-sub" : ""),
      role: "menu",
      dataset: { depth: String(depth) },
    });

    let activeSubOwner = null;
    const clearOwnerHighlight = () => {
      if (activeSubOwner) {
        activeSubOwner.classList.remove("is-sub-open");
        activeSubOwner = null;
      }
    };

    valid.forEach((it) => {
      if (it.sep) {
        menu.appendChild(el("div", { class: "ic-ctx-sep", role: "separator" }));
        return;
      }
      if (it.header) {
        menu.appendChild(el("div", { class: "ic-ctx-header" }, it.header));
        return;
      }
      const hasChildren = Array.isArray(it.children) && it.children.filter(Boolean).length > 0;
      const icoNode = it.swatch
        ? el("span", { class: "ic-ctx-swatch", style: { background: it.swatch }, "aria-hidden": "true" })
        : el("span", { class: "ic-ctx-ico", "aria-hidden": "true" }, it.icon || "");

      const btn = el("button", {
        type: "button",
        role: "menuitem",
        "aria-haspopup": hasChildren ? "menu" : undefined,
        class: "ic-ctx-item" + (it.danger ? " is-danger" : "") + (hasChildren ? " has-sub" : ""),
        disabled: Boolean(it.disabled),
        onMouseEnter: () => {
          if (hasChildren && !it.disabled) {
            if (activeSubOwner !== btn) {
              clearOwnerHighlight();
              activeSubOwner = btn;
              btn.classList.add("is-sub-open");
              buildMenuLevel(it.children, depth + 1, btn.getBoundingClientRect(), 0, 0);
            }
          } else {
            clearOwnerHighlight();
            trimLevels(depth + 1);
          }
        },
        onClick: (clickEv) => {
          clickEv.stopPropagation();
          if (hasChildren && !it.disabled) {
            clearOwnerHighlight();
            activeSubOwner = btn;
            btn.classList.add("is-sub-open");
            buildMenuLevel(it.children, depth + 1, btn.getBoundingClientRect(), 0, 0);
            return;
          }
          closeArticleContextMenu();
          it.onClick?.();
        },
      },
        icoNode,
        el("span", { class: "ic-ctx-label" }, it.label || ""),
        it.shortcut ? el("span", { class: "ic-ctx-kbd" }, it.shortcut) : null,
        hasChildren ? el("span", { class: "ic-ctx-chev", "aria-hidden": "true" }, "›") : null
      );
      menu.appendChild(btn);
    });

    menu.style.visibility = "hidden";
    document.body.appendChild(menu);
    const mw = menu.offsetWidth || 216;
    const mh = menu.offsetHeight || 220;

    let x = fallbackX;
    let y = fallbackY;
    if (anchorRect) {
      const rightSpace = window.innerWidth - anchorRect.right;
      x = rightSpace >= mw + 12
        ? anchorRect.right - 2
        : Math.max(8, anchorRect.left - mw + 2);
      y = Math.max(8, Math.min(anchorRect.top - 5, window.innerHeight - mh - 10));
    } else {
      x = Math.max(8, Math.min(fallbackX, window.innerWidth - mw - 10));
      y = Math.max(8, Math.min(fallbackY, window.innerHeight - mh - 10));
    }
    menu.style.left = `${Math.round(x)}px`;
    menu.style.top = `${Math.round(y)}px`;
    menu.style.visibility = "visible";
    activeCtxMenus.push(menu);
    return menu;
  }

  buildMenuLevel(validRoot, 0, null, ev.clientX, ev.clientY);

  const isInsideAny = (target) => activeCtxMenus.some((m) => m && m.contains(target));
  const onDown = (e) => { if (!isInsideAny(e.target)) closeArticleContextMenu(); };
  const onKey = (e) => { if (e.key === "Escape") closeArticleContextMenu(); };
  const onWheel = (e) => { if (!isInsideAny(e.target)) closeArticleContextMenu(); };
  const onResize = () => closeArticleContextMenu();
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("resize", onResize);
  activeCtxCleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("resize", onResize);
  };
}

const FOLDER_PALETTE = [
  "#4c7260", // sage
  "#49688a", // slate ink
  "#a37039", // warm ochre
  "#7b5a82", // muted plum
  "#3b7a7d", // deep teal
  "#a85c48", // terracotta
  "#6e6958", // olive stone
  "#5a7347", // moss
];

function folderOfPath(p) {
  const s = String(p || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const idx = s.indexOf("/");
  return idx > 0 ? s.slice(0, idx) : "根目录";
}

// ---------- Interactive Canvas Force-Directed Graph (Full-Workspace & Mini) ----------
function mountForceGraph(container, rawGraph, opts = {}) {
  const {
    mode = "local", // local | global
    activePath = "",
    hops = 1,
    showUnresolved = true,
    hideOrphans = false,
    colorByFolder = true,
    activeFolder = "",
    repulseMul = 1.0,
    linkDistMul = 1.0,
    nodeScale = 1.0,
    showLegend = false,
    showControls = true,
    query = "",
    interactive = true,
    onNodeClick = null,
    onNodeContextMenu = null,
    onFolderPick = null,
  } = opts;

  clear(container);
  const allNodes = Array.isArray(rawGraph?.nodes) ? rawGraph.nodes : [];
  const allEdges = Array.isArray(rawGraph?.edges) ? rawGraph.edges : [];

  let keptIds = new Set();
  if (mode === "local" && activePath) {
    const startNode = allNodes.find((n) => n.path?.toLowerCase() === activePath.toLowerCase() || n.id?.toLowerCase() === activePath.toLowerCase());
    if (startNode) {
      keptIds.add(startNode.id);
      let frontier = new Set([startNode.id]);
      for (let step = 0; step < Math.max(1, hops); step++) {
        const next = new Set();
        for (const e of allEdges) {
          if (frontier.has(e.source) && !keptIds.has(e.target)) { keptIds.add(e.target); next.add(e.target); }
          if (frontier.has(e.target) && !keptIds.has(e.source)) { keptIds.add(e.source); next.add(e.source); }
        }
        frontier = next;
      }
    }
  } else {
    allNodes.forEach((n) => keptIds.add(n.id));
  }

  // Assign deterministic folder colors
  const folderColorMap = new Map();
  const folderCounts = new Map();
  let colorCursor = 0;
  allNodes.forEach((n) => {
    if (!n.exists) return;
    const f = folderOfPath(n.path);
    folderCounts.set(f, (folderCounts.get(f) || 0) + 1);
    if (!folderColorMap.has(f)) {
      folderColorMap.set(f, FOLDER_PALETTE[colorCursor % FOLDER_PALETTE.length]);
      colorCursor++;
    }
  });

  let nodes = allNodes
    .filter((n) => keptIds.has(n.id) && (showUnresolved || n.exists) && (!hideOrphans || (n.degree || 0) > 0 || (activePath && n.path?.toLowerCase() === activePath.toLowerCase())))
    .map((n, i) => {
      const isCur = Boolean(activePath && n.path && n.path.toLowerCase() === activePath.toLowerCase());
      const folder = n.exists ? folderOfPath(n.path) : "未创建";
      const baseR = isCur ? 10.5 : Math.min(12, 5.8 + Math.sqrt(n.degree || 0) * 1.45);
      return {
        ...n,
        folder,
        folderColor: n.exists ? (folderColorMap.get(folder) || "#7c6e5f") : "#c7bcb0",
        isCurrent: isCur,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        inDeg: 0,
        outDeg: 0,
        radius: baseR * nodeScale,
        _seed: i,
      };
    });

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = allEdges
    .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
    .map((e) => {
      const src = nodeById.get(e.source);
      const dst = nodeById.get(e.target);
      src.outDeg++;
      dst.inDeg++;
      return { source: src, target: dst, isEmbed: Boolean(e.isEmbed) };
    });

  if (!nodes.length) {
    container.appendChild(el("div", { class: "ic-link-graph-empty muted" },
      mode === "local" ? "当前文章还没有双向链接。点击「＋ 插入双链」或在正文输入 [[ 即可关联笔记。" : "当前文章库暂无笔记节点。"
    ));
    return { destroy() {}, fitToView() {}, zoomBy() {} };
  }

  const canvas = el("canvas", { class: "ic-link-graph-canvas" });
  const tooltip = el("div", { class: "ic-link-graph-tip hidden" });
  container.append(canvas, tooltip);

  let width = container.clientWidth || 340;
  let height = container.clientHeight || 220;
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const resize = () => {
    width = container.clientWidth || 340;
    height = container.clientHeight || 220;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  };
  resize();

  const isLarge = width >= 500;
  const initR = Math.min(width, height) * (isLarge ? 0.32 : 0.28);
  nodes.forEach((n, i) => {
    if (n.isCurrent) {
      n.x = 0;
      n.y = 0;
    } else {
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
      const dist = initR * (0.65 + ((i * 29) % 10) / 22);
      n.x = Math.cos(angle) * dist;
      n.y = Math.sin(angle) * dist;
    }
  });

  const neighbors = new Map();
  nodes.forEach((n) => neighbors.set(n.id, new Set([n.id])));
  edges.forEach((e) => {
    neighbors.get(e.source.id)?.add(e.target.id);
    neighbors.get(e.target.id)?.add(e.source.id);
  });

  let camX = 0;
  let camY = 0;
  let camScale = 1;
  let hoveredNode = null;
  let draggingNode = null;
  let panning = false;
  let dragStart = { x: 0, y: 0, camX: 0, camY: 0, moved: false };
  let destroyed = false;
  let rafId = 0;
  let alpha = 1.0;

  const ql = String(query || "").trim().toLowerCase();

  function tickPhysics(steps = 1) {
    const big = width >= 500;
    const repulse = (big ? 5600 : 2800) * repulseMul;
    const linkDist = (big ? 128 : 78) * linkDistMul;
    const springK = 0.048;
    const centerK = 0.011;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.vx += -a.x * centerK * alpha;
        a.vy += -a.y * centerK * alpha;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy + 24;
          const d = Math.sqrt(d2);
          const f = (repulse / d2) * alpha;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }
      for (const e of edges) {
        const dx = e.target.x - e.source.x;
        const dy = e.target.y - e.source.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const diff = (d - linkDist) * springK * alpha;
        const fx = (dx / d) * diff;
        const fy = (dy / d) * diff;
        e.source.vx += fx; e.source.vy += fy;
        e.target.vx -= fx; e.target.vy -= fy;
      }
      for (const n of nodes) {
        if (n === draggingNode) { n.vx = 0; n.vy = 0; continue; }
        n.vx *= 0.80;
        n.vy *= 0.80;
        n.x += Math.max(-18, Math.min(18, n.vx));
        n.y += Math.max(-18, Math.min(18, n.vy));
      }
      alpha *= 0.98;
    }
  }

  function fitToView() {
    if (!nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const labelPadX = Math.min(68, Math.max(36, n.label.length * 5.8));
      minX = Math.min(minX, n.x - labelPadX);
      maxX = Math.max(maxX, n.x + labelPadX);
      minY = Math.min(minY, n.y - n.radius - 20);
      maxY = Math.max(maxY, n.y + n.radius + 32);
    }
    const spanX = Math.max(120, maxX - minX);
    const spanY = Math.max(90, maxY - minY);
    const padRatio = width >= 500 ? 0.84 : 0.88;
    const maxScale = width >= 500 ? 1.55 : 1.05;
    camX = -(minX + maxX) / 2;
    camY = -(minY + maxY) / 2;
    camScale = Math.max(0.35, Math.min(maxScale, Math.min((width * padRatio) / spanX, (height * padRatio) / spanY)));
    draw();
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - width / 2) / camScale - camX,
      y: (sy - height / 2) / camScale - camY,
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: (wx + camX) * camScale + width / 2,
      y: (wy + camY) * camScale + height / 2,
    };
  }

  function hitTest(sx, sy) {
    const w = screenToWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = w.x - n.x;
      const dy = w.y - n.y;
      const hitR = Math.max(12 / camScale, n.radius + 5);
      if (dx * dx + dy * dy <= hitR * hitR) return n;
    }
    return null;
  }

  function draw() {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const isDark = document.querySelector('meta[name="color-scheme"]')?.content === "dark" ||
      (document.querySelector('meta[name="color-scheme"]')?.content !== "light" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);

    const bgColor = isDark ? "#1a1714" : "#fbf8f3";
    const dotColor = isDark ? "rgba(239,232,220,0.06)" : "rgba(44,36,27,0.065)";
    const inkColor = isDark ? "#efe8dc" : "#2c241b";
    const mutedNode = isDark ? "#8b7f72" : "#7c6e5f";
    const unresolvedColor = isDark ? "#5c5349" : "#c7bcb0";
    const edgeColor = isDark ? "rgba(239,232,220,0.20)" : "rgba(44,36,27,0.20)";
    const accent = isDark ? "#e26a4f" : "#c84b31";
    const accentHalo = isDark ? "rgba(226,106,79,0.22)" : "rgba(200,75,49,0.16)";

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    // Subtle tactile warm paper dot grid
    const gridStep = 22;
    ctx.fillStyle = dotColor;
    for (let gx = (width / 2) % gridStep; gx < width; gx += gridStep) {
      for (let gy = (height / 2) % gridStep; gy < height; gy += gridStep) {
        ctx.fillRect(gx, gy, 1.2, 1.2);
      }
    }

    ctx.translate(width / 2, height / 2);
    ctx.scale(camScale, camScale);
    ctx.translate(camX, camY);

    const focusSet = hoveredNode ? neighbors.get(hoveredNode.id) : null;

    // Edges with directional arrowheads
    for (const e of edges) {
      const lit = !focusSet || (focusSet.has(e.source.id) && focusSet.has(e.target.id) && (e.source === hoveredNode || e.target === hoveredNode));
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const startX = e.source.x + ux * (e.source.radius + 2);
      const startY = e.source.y + uy * (e.source.radius + 2);
      const endX = e.target.x - ux * (e.target.radius + 4);
      const endY = e.target.y - uy * (e.target.radius + 4);

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = lit && focusSet ? accent : edgeColor;
      ctx.globalAlpha = lit ? 1 : 0.25;
      ctx.lineWidth = (lit && focusSet ? 1.85 : 1.15) / Math.sqrt(camScale);
      if (e.isEmbed) ctx.setLineDash([4.5, 3]);
      else ctx.setLineDash([]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Directional arrow head
      if (dist > e.source.radius + e.target.radius + 14) {
        const aLen = 6 / Math.sqrt(camScale);
        const angle = Math.atan2(dy, dx);
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - aLen * Math.cos(angle - Math.PI / 6), endY - aLen * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(endX - aLen * Math.cos(angle + Math.PI / 6), endY - aLen * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = lit && focusSet ? accent : edgeColor;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Nodes + crisp labels
    const showLabels = camScale >= 0.52 || nodes.length <= 45;
    for (const n of nodes) {
      const matchesQ = !ql || n.label.toLowerCase().includes(ql) || (n.path || "").toLowerCase().includes(ql) || (n.folder || "").toLowerCase().includes(ql);
      const matchesFolder = !activeFolder || n.folder === activeFolder;
      const lit = (!focusSet || focusSet.has(n.id)) && matchesQ && matchesFolder;
      ctx.globalAlpha = lit ? 1 : 0.16;

      // Halo ring on current or hovered node
      if (n.isCurrent || hoveredNode === n) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + 5.5, 0, Math.PI * 2);
        ctx.fillStyle = accentHalo;
        ctx.fill();
      }

      const nodeFill = n.isCurrent
        ? accent
        : (!n.exists ? unresolvedColor : (hoveredNode === n ? accent : (colorByFolder ? n.folderColor : mutedNode)));
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = nodeFill;
      ctx.fill();

      if (n.isCurrent || hoveredNode === n) {
        ctx.lineWidth = 2 / Math.sqrt(camScale);
        ctx.strokeStyle = isDark ? "#faf7f2" : "#ffffff";
        ctx.stroke();
      } else if (!n.exists) {
        ctx.setLineDash([2.5, 2]);
        ctx.lineWidth = 1.25 / Math.sqrt(camScale);
        ctx.strokeStyle = mutedNode;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (showLabels || n.isCurrent || hoveredNode === n || (ql && matchesQ)) {
        const fontSize = Math.max(10, Math.min(13, (n.isCurrent ? 12.2 : 11.2) / Math.sqrt(camScale)));
        ctx.font = `${n.isCurrent || hoveredNode === n ? "600" : "500"} ${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = n.label.length > 20 ? n.label.slice(0, 19) + "…" : n.label;
        const ly = n.y + n.radius + 5;
        // Soft pill halo behind text so labels never clash with edges
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = isDark ? "rgba(26,23,20,0.78)" : "rgba(251,248,243,0.82)";
        ctx.fillRect(n.x - tw / 2 - 3, ly - 1, tw + 6, fontSize + 3);
        ctx.fillStyle = n.isCurrent || hoveredNode === n ? accent : (n.exists ? inkColor : mutedNode);
        ctx.fillText(label, n.x, ly);
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Settle initial physics completely, THEN auto-fit camera cleanly!
  tickPhysics(110);
  fitToView();

  function loop() {
    if (destroyed) return;
    if (alpha > 0.04 || draggingNode) {
      tickPhysics(1);
      draw();
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = 0;
    }
  }
  if (!prefersReducedMotion() && alpha > 0.04) {
    rafId = requestAnimationFrame(loop);
  }

  function wake(newAlpha = 0.25) {
    alpha = Math.max(alpha, newAlpha);
    if (prefersReducedMotion()) {
      tickPhysics(10);
      draw();
      return;
    }
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function zoomBy(factor, pivotSx = width / 2, pivotSy = height / 2) {
    const before = screenToWorld(pivotSx, pivotSy);
    camScale = Math.max(0.22, Math.min(3.8, camScale * factor));
    const after = screenToWorld(pivotSx, pivotSy);
    camX += after.x - before.x;
    camY += after.y - before.y;
    draw();
  }

  if (showControls) {
    container.appendChild(el("div", { class: "ic-link-graph-ctrls" },
      el("button", { type: "button", class: "ic-link-graph-ctrl-btn", title: "放大", onClick: () => zoomBy(1.22) }, "＋"),
      el("button", { type: "button", class: "ic-link-graph-ctrl-btn", title: "缩小", onClick: () => zoomBy(0.82) }, "－"),
      el("button", { type: "button", class: "ic-link-graph-ctrl-btn", title: "自适应居中", onClick: () => fitToView() }, "⌖")
    ));
  }

  if (showLegend) {
    const legendBox = el("div", { class: "ic-link-graph-legend" },
      el("span", { class: "ic-lg-item" }, el("i", { class: "ic-lg-dot is-current" }), "当前文章"),
      el("span", { class: "ic-lg-item" }, el("i", { class: "ic-lg-dot is-unres" }), "未创建"),
      el("span", { class: "ic-lg-item" }, el("i", { class: "ic-lg-line" }), "引用"),
      el("span", { class: "ic-lg-item" }, el("i", { class: "ic-lg-line is-embed" }), "嵌入")
    );
    if (colorByFolder && folderColorMap.size > 0) {
      const topFolders = Array.from(folderCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 7);
      if (topFolders.length > 1 || (topFolders.length === 1 && topFolders[0][0] !== "根目录")) {
        legendBox.appendChild(el("span", { class: "ic-lg-sep" }));
        topFolders.forEach(([fname, cnt]) => {
          const btn = el("button", {
            type: "button",
            class: "ic-lg-folder-btn" + (activeFolder === fname ? " is-active" : ""),
            title: activeFolder === fname ? "点击取消文件夹筛选" : `点击高亮「${fname}」目录笔记`,
            onClick: () => onFolderPick?.(activeFolder === fname ? "" : fname),
          },
            el("i", { class: "ic-lg-dot", style: { background: folderColorMap.get(fname) } }),
            `${fname} (${cnt})`
          );
          legendBox.appendChild(btn);
        });
      }
    }
    container.appendChild(legendBox);
  }

  if (interactive) {
    canvas.addEventListener("mousemove", (ev) => {
      const r = canvas.getBoundingClientRect();
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;
      if (draggingNode) {
        const w = screenToWorld(sx, sy);
        draggingNode.x = w.x;
        draggingNode.y = w.y;
        dragStart.moved = true;
        wake(0.14);
        draw();
        return;
      }
      if (panning) {
        const dx = (ev.clientX - dragStart.x) / camScale;
        const dy = (ev.clientY - dragStart.y) / camScale;
        if (Math.abs(ev.clientX - dragStart.x) > 3 || Math.abs(ev.clientY - dragStart.y) > 3) dragStart.moved = true;
        camX = dragStart.camX + dx;
        camY = dragStart.camY + dy;
        draw();
        return;
      }
      const hit = hitTest(sx, sy);
      if (hit !== hoveredNode) {
        hoveredNode = hit;
        canvas.style.cursor = hit ? "pointer" : "grab";
        if (hit) {
          clear(tooltip);
          tooltip.append(
            el("div", { style: { fontWeight: "600" } }, hit.label),
            el("div", { style: { opacity: "0.85", fontSize: "11px" } },
              hit.exists
                ? `${hit.path || ""} · 入链 ${hit.inDeg} · 出链 ${hit.outDeg}`
                : "尚未创建 · 点击立即新建笔记"
            )
          );
          tooltip.classList.remove("hidden");
        } else {
          tooltip.classList.add("hidden");
        }
        draw();
      }
      if (hit) {
        const pos = worldToScreen(hit.x, hit.y);
        tooltip.style.left = `${Math.max(8, Math.min(pos.x + 14, width - 220))}px`;
        tooltip.style.top = `${Math.max(8, Math.min(pos.y - 36, height - 56))}px`;
      }
    });

    canvas.addEventListener("mouseleave", () => {
      if (hoveredNode) {
        hoveredNode = null;
        tooltip.classList.add("hidden");
        draw();
      }
    });

    canvas.addEventListener("mousedown", (ev) => {
      const r = canvas.getBoundingClientRect();
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;
      const hit = hitTest(sx, sy);
      dragStart = { x: ev.clientX, y: ev.clientY, camX, camY, moved: false };
      if (hit) {
        draggingNode = hit;
        canvas.style.cursor = "grabbing";
      } else {
        panning = true;
        canvas.style.cursor = "grabbing";
      }
    });

    const onUp = () => {
      if (draggingNode && !dragStart.moved && onNodeClick) {
        onNodeClick(draggingNode);
      }
      draggingNode = null;
      panning = false;
      canvas.style.cursor = hoveredNode ? "pointer" : "grab";
    };
    window.addEventListener("mouseup", onUp);

    canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomBy(ev.deltaY < 0 ? 1.15 : 0.87, ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });

    canvas.addEventListener("contextmenu", (ev) => {
      const r = canvas.getBoundingClientRect();
      const hit = hitTest(ev.clientX - r.left, ev.clientY - r.top);
      if (hit && onNodeContextMenu) {
        onNodeContextMenu(ev, hit);
      }
    });

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { resize(); fitToView(); }) : null;
    if (ro) ro.observe(container);

    return {
      destroy() {
        destroyed = true;
        if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener("mouseup", onUp);
        if (ro) ro.disconnect();
      },
      fitToView,
      zoomBy,
    };
  }

  return {
    destroy() { destroyed = true; if (rafId) cancelAnimationFrame(rafId); },
    fitToView,
    zoomBy,
  };
}

// ---------- Main Controller ----------
export function createArticleLinksController(opts) {
  const data = {
    activePath: "",
    notes: [],
    attachments: [],
    outgoing: [],
    backlinks: [],
    unlinkedMentions: [],
    graph: { nodes: [], edges: [] },
  };

  let acEl = null;
  let acState = null;
  let miniGraphHandle = null;
  const notePreviewCache = new Map();

  // Hover Page Preview state (Obsidian-style floating note preview card)
  let hoverEl = null;
  let hoverShowTimer = null;
  let hoverHideTimer = null;

  const panelEl = el("div", { class: "ic-links-panel" });

  function resolveLocalTarget(rawTarget, sourcePath = "") {
    const t = String(rawTarget || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!t) return null;
    const low = t.toLowerCase();
    const lowNoExt = low.replace(/\.(md|markdown)$/i, "");
    if (sourcePath) {
      const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
      if (dir) {
        const joined = `${dir}/${t}`.toLowerCase();
        const foundRel = data.notes.find((n) => n.path.toLowerCase() === joined || n.path.toLowerCase() === `${joined}.md`);
        if (foundRel) return { kind: "note", item: foundRel };
      }
    }
    const exact = data.notes.find((n) => n.path.toLowerCase() === low || n.path.toLowerCase() === `${low}.md`);
    if (exact) return { kind: "note", item: exact };
    const byBase = data.notes.find((n) => n.basename.toLowerCase() === lowNoExt || n.name.toLowerCase() === low);
    if (byBase) return { kind: "note", item: byBase };
    const byAlias = data.notes.find((n) => (n.aliases || []).some((a) => String(a).toLowerCase() === low));
    if (byAlias) return { kind: "note", item: byAlias };
    const att = data.attachments.find((a) => a.path.toLowerCase() === low || a.name.toLowerCase() === low || a.path.toLowerCase().endsWith("/" + low));
    if (att) return { kind: "attachment", item: att };
    return null;
  }

  async function navigateToLink(rawTarget, sourcePath = "") {
    hideHoverPreview(true);
    const { target } = parseWikilinkInner(rawTarget);
    if (!target) return;
    const res = resolveLocalTarget(target, sourcePath || opts.getActivePath?.() || "");
    if (res?.kind === "note") {
      await opts.openNote?.(res.item.path);
      return;
    }
    if (res?.kind === "attachment") {
      toast(`附件路径：${res.item.path}`);
      return;
    }
    await opts.createAndOpenNote?.(target);
  }

  // ---------- Hover Page Preview Card ----------
  function hideHoverPreview(immediate = false) {
    if (hoverShowTimer) { clearTimeout(hoverShowTimer); hoverShowTimer = null; }
    if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
    const doHide = () => {
      if (hoverEl) { hoverEl.remove(); hoverEl = null; }
    };
    if (immediate) doHide();
    else hoverHideTimer = setTimeout(doHide, 180);
  }

  async function fetchNoteText(relPath) {
    if (notePreviewCache.has(relPath)) return notePreviewCache.get(relPath);
    const res = await api("GET", `/api/article/vault/file?path=${encodeURIComponent(relPath)}`);
    const content = res.content || "";
    notePreviewCache.set(relPath, content);
    return content;
  }

  function bindHoverPreview(anchorEl, targetOrPath, sourcePath = "") {
    if (!anchorEl) return;
    anchorEl.addEventListener("mouseenter", () => {
      if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
      if (hoverShowTimer) clearTimeout(hoverShowTimer);
      hoverShowTimer = setTimeout(async () => {
        const res = resolveLocalTarget(targetOrPath, sourcePath || opts.getActivePath?.() || "");
        if (!res || res.kind !== "note") return;
        const note = res.item;
        const rect = anchorEl.getBoundingClientRect();

        if (hoverEl) hoverEl.remove();
        const bodyBox = el("div", { class: "ic-hover-pv-body muted" }, "正在加载预览…");
        const card = el("div", { class: "ic-hover-pv" },
          el("div", { class: "ic-hover-pv-head" },
            el("div", { class: "ic-hover-pv-title-wrap" },
              el("strong", null, note.title || note.basename),
              el("span", { class: "mono muted", style: { fontSize: "10.5px" } }, note.path)
            ),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => { hideHoverPreview(true); opts.openNote?.(note.path); },
            }, "打开 ↗")
          ),
          note.aliases?.length
            ? el("div", { class: "ic-hover-pv-aliases" }, ...note.aliases.map((a) => el("span", { class: "badge" }, a)))
            : null,
          bodyBox
        );
        card.addEventListener("mouseenter", () => {
          if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
        });
        card.addEventListener("mouseleave", () => hideHoverPreview(false));

        document.body.appendChild(card);
        hoverEl = card;

        const cw = 340;
        const ch = 220;
        const left = rect.right + cw + 16 < window.innerWidth
          ? rect.left
          : Math.max(12, window.innerWidth - cw - 14);
        const top = rect.bottom + ch + 16 < window.innerHeight
          ? rect.bottom + 8
          : Math.max(12, rect.top - ch - 8);
        card.style.left = `${Math.max(12, Math.min(left, window.innerWidth - cw - 14))}px`;
        card.style.top = `${top}px`;

        try {
          const text = await fetchNoteText(note.path);
          if (!card.isConnected) return;
          clear(bodyBox);
          bodyBox.classList.remove("muted");
          const stripped = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
          const lines = stripped.split(/\r?\n/).filter((l) => l.trim()).slice(0, 7);
          if (!lines.length) {
            bodyBox.textContent = "（空白笔记）";
          } else {
            lines.forEach((ln) => {
              const p = el("p", { class: "ic-hover-pv-line" });
              appendHighlightedSnippet(p, ln.replace(/^#+\s*/, ""), "");
              bodyBox.appendChild(p);
            });
          }
        } catch {
          if (card.isConnected) bodyBox.textContent = "无法读取该笔记";
        }
      }, 280);
    });
    anchorEl.addEventListener("mouseleave", () => hideHoverPreview(false));
    anchorEl.addEventListener("mousedown", () => hideHoverPreview(true));
  }

  // ---------- Autocomplete Popup for [[ and ![[ ----------
  function closeAutocomplete() {
    if (acEl) { acEl.remove(); acEl = null; }
    acState = null;
  }

  function applyAutocompleteItem(item) {
    if (!acState) return;
    const { ta, cmView, startIdx, endIdx, isEmbed } = acState;
    const prefix = isEmbed ? "![[" : "[[";
    if (cmView) {
      const docStr = cmView.state.doc.toString();
      const hasClosing = docStr.slice(endIdx, endIdx + 2) === "]]";
      const insertText = `${prefix}${item.insertValue}]]`;
      const replaceEnd = hasClosing ? endIdx + 2 : endIdx;
      cmView.dispatch({
        changes: { from: startIdx, to: replaceEnd, insert: insertText },
        selection: { anchor: startIdx + insertText.length },
      });
      cmView.focus();
      closeAutocomplete();
      return;
    }
    const after = ta.value.slice(endIdx);
    const hasClosing = after.startsWith("]]");
    const insertText = `${prefix}${item.insertValue}]]`;
    const replaceEnd = hasClosing ? endIdx + 2 : endIdx;
    ta.setRangeText(insertText, startIdx, replaceEnd, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
    closeAutocomplete();
  }

  function renderAutocomplete() {
    if (!acState) return;
    if (!acEl) {
      acEl = el("div", { class: "ic-link-ac", role: "listbox" });
      document.body.appendChild(acEl);
    }
    clear(acEl);
    const { items, selected, isEmbed, headingMode, rawQuery } = acState;
    acEl.appendChild(el("div", { class: "ic-link-ac-head" },
      el("span", null, headingMode ? "选择文内标题 (#)" : (isEmbed ? "嵌入笔记或图片 (![[…]])" : "插入双链笔记 ([[…]])")),
      el("span", { class: "muted", style: { fontSize: "10.5px" } }, "↑↓ 选 · Enter 确认")
    ));
    const list = el("div", { class: "ic-link-ac-list" });
    let selectedBtn = null;
    items.forEach((it, idx) => {
      const titleEl = el("div", { class: "ic-link-ac-title" });
      appendMatchHighlight(titleEl, it.label, rawQuery);
      const row = el("button", {
        type: "button",
        role: "option",
        class: "ic-link-ac-item" + (idx === selected ? " is-selected" : ""),
        onMouseDown: (ev) => {
          ev.preventDefault();
          applyAutocompleteItem(it);
        },
      },
        el("span", { class: "ic-link-ac-ico" }, it.icon),
        el("div", { class: "ic-link-ac-text" },
          titleEl,
          it.sub ? el("div", { class: "ic-link-ac-sub muted" }, it.sub) : null
        ),
        it.tag ? el("span", { class: "ic-link-ac-tag" + (it.tagKind ? ` is-${it.tagKind}` : "") }, it.tag) : null
      );
      if (idx === selected) selectedBtn = row;
      list.appendChild(row);
    });
    acEl.appendChild(list);
    acEl.appendChild(el("div", { class: "ic-link-ac-foot muted" }, "输入 # 可补全标题 · Ctrl/⌘+点击 可跳转"));
    let coords;
    if (acState.cmView) {
      const c = acState.cmView.coordsAtPos(acState.endIdx);
      const popW = 340, popH = 290;
      if (c) {
        coords = {
          left: Math.max(12, Math.min(c.left, window.innerWidth - popW - 14)),
          top: c.bottom + popH > window.innerHeight - 16
            ? Math.max(48, c.top - popH - 6)
            : Math.max(48, c.bottom + 4),
        };
      } else {
        coords = { left: 120, top: 140 };
      }
    } else {
      coords = getTextareaCaretCoords(acState.ta, acState.endIdx);
    }
    acEl.style.left = `${coords.left}px`;
    acEl.style.top = `${coords.top}px`;
    if (selectedBtn) selectedBtn.scrollIntoView({ block: "nearest" });
  }

  function buildAutocompleteItems(isEmbed, rawQuery) {
    const items = [];
    const hashIdx = rawQuery.indexOf("#");
    const headingMode = hashIdx >= 0;

    if (headingMode) {
      const noteQuery = rawQuery.slice(0, hashIdx).trim();
      const headQuery = rawQuery.slice(hashIdx + 1).trim().toLowerCase();
      const resolved = noteQuery
        ? resolveLocalTarget(noteQuery, opts.getActivePath?.() || "")?.item
        : data.notes.find((n) => n.path === opts.getActivePath?.());
      if (resolved?.headings?.length) {
        resolved.headings
          .filter((h) => !headQuery || h.toLowerCase().includes(headQuery))
          .slice(0, 14)
          .forEach((h) => {
            items.push({
              icon: "#",
              label: h,
              sub: resolved.basename,
              tag: "标题",
              insertValue: `${noteQuery ? resolved.basename : ""}#${h}`,
            });
          });
      }
    } else {
      const ql = rawQuery.trim().toLowerCase();
      for (const n of data.notes) {
        const aliasStr = (n.aliases || []).join(" / ");
        const hay = `${n.basename} ${n.path} ${n.title} ${aliasStr}`.toLowerCase();
        if (!ql || hay.includes(ql)) {
          const subParts = [];
          if (n.path !== n.name) subParts.push(n.path);
          if (aliasStr) subParts.push(`别名: ${aliasStr}`);
          items.push({
            icon: "📄",
            label: n.basename,
            sub: subParts.join(" · "),
            tag: "笔记",
            insertValue: n.basename,
          });
        }
        if (items.length >= 14) break;
      }
      if (isEmbed || ql) {
        for (const a of data.attachments) {
          if (!isEmbed && !a.isImage) continue;
          const hay = `${a.name} ${a.path}`.toLowerCase();
          if (!ql || hay.includes(ql)) {
            items.push({
              icon: a.isImage ? "🖼" : "📎",
              label: a.name,
              sub: a.path,
              tag: a.isImage ? "图片" : "附件",
              tagKind: "img",
              insertValue: a.path,
            });
          }
          if (items.length >= 20) break;
        }
      }
      if (rawQuery.trim() && !items.some((x) => x.label.toLowerCase() === ql)) {
        items.push({
          icon: "＋",
          label: `链接新笔记「${rawQuery.trim()}」`,
          sub: "插入后点击双链即可一键新建",
          tag: "新建",
          tagKind: "new",
          insertValue: rawQuery.trim(),
        });
      }
    }
    return { items, headingMode, hashIdx };
  }

  function updateAutocomplete(ta) {
    const pos = ta.selectionStart ?? 0;
    if (ta.selectionEnd !== pos) { closeAutocomplete(); return; }
    const before = ta.value.slice(0, pos);
    const m = before.match(/(!)?\[\[([^\[\]\r\n]*)$/);
    if (!m) { closeAutocomplete(); return; }

    const isEmbed = Boolean(m[1]);
    const rawQuery = m[2] || "";
    const startIdx = pos - m[0].length;
    if (rawQuery.includes("|")) { closeAutocomplete(); return; }

    const { items, headingMode, hashIdx } = buildAutocompleteItems(isEmbed, rawQuery);
    if (!items.length) { closeAutocomplete(); return; }
    acState = {
      ta,
      startIdx,
      endIdx: pos,
      isEmbed,
      headingMode,
      rawQuery: headingMode ? rawQuery.slice(hashIdx + 1).trim() : rawQuery.trim(),
      items,
      selected: 0,
    };
    renderAutocomplete();
  }

  function updateAutocompleteFromCM(cmView) {
    if (!cmView) { closeAutocomplete(); return; }
    const sel = cmView.state.selection.main;
    if (!sel.empty) { closeAutocomplete(); return; }
    const pos = sel.head;
    const line = cmView.state.doc.lineAt(pos);
    const before = line.text.slice(0, pos - line.from);
    const m = before.match(/(!)?\[\[([^\[\]\r\n]*)$/);
    if (!m) { closeAutocomplete(); return; }
    const isEmbed = Boolean(m[1]);
    const rawQuery = m[2] || "";
    if (rawQuery.includes("|")) { closeAutocomplete(); return; }
    const startIdx = pos - m[0].length;
    const { items, headingMode, hashIdx } = buildAutocompleteItems(isEmbed, rawQuery);
    if (!items.length) { closeAutocomplete(); return; }
    acState = {
      cmView,
      startIdx,
      endIdx: pos,
      isEmbed,
      headingMode,
      rawQuery: headingMode ? rawQuery.slice(hashIdx + 1).trim() : rawQuery.trim(),
      items,
      selected: 0,
    };
    renderAutocomplete();
  }

  function handleCMKeydown(cmView, ev) {
    if (!acState || acState.cmView !== cmView) return false;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      acState.selected = (acState.selected + 1) % acState.items.length;
      renderAutocomplete();
      return true;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      acState.selected = (acState.selected - 1 + acState.items.length) % acState.items.length;
      renderAutocomplete();
      return true;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      applyAutocompleteItem(acState.items[acState.selected]);
      return true;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeAutocomplete();
      return true;
    }
    return false;
  }

  function triggerInsertWikilinkCM(cmView, isEmbed = false) {
    if (!cmView) return;
    const { from, to } = cmView.state.selection.main;
    const sel = cmView.state.sliceDoc(from, to).trim();
    const prefix = isEmbed ? "![[" : "[[";
    if (sel) {
      const insert = `${prefix}${sel}]]`;
      cmView.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
      cmView.focus();
      return;
    }
    cmView.dispatch({ changes: { from, to, insert: prefix }, selection: { anchor: from + prefix.length } });
    cmView.focus();
    updateAutocompleteFromCM(cmView);
  }

  function triggerInsertWikilink(ta) {
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const sel = ta.value.slice(start, end).trim();
    if (sel) {
      ta.setRangeText(`[[${sel}]]`, start, end, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
      return;
    }
    ta.setRangeText("[[", start, end, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
    updateAutocomplete(ta);
  }

  function attachTextarea(ta) {
    if (!ta || ta.dataset.obsLinksBound) return;
    ta.dataset.obsLinksBound = "1";

    ta.addEventListener("input", () => updateAutocomplete(ta));
    ta.addEventListener("click", (ev) => {
      if (ev.ctrlKey || ev.metaKey) {
        const pos = ta.selectionStart ?? 0;
        const val = ta.value || "";
        const re = new RegExp(WIKILINK_RE.source, "g");
        let m;
        while ((m = re.exec(val)) !== null) {
          if (pos >= m.index && pos <= m.index + m[0].length) {
            ev.preventDefault();
            closeAutocomplete();
            navigateToLink(m[2]);
            return;
          }
        }
      }
      updateAutocomplete(ta);
    });
    ta.addEventListener("keydown", (ev) => {
      if (!acState || acState.ta !== ta) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        acState.selected = (acState.selected + 1) % acState.items.length;
        renderAutocomplete();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        acState.selected = (acState.selected - 1 + acState.items.length) % acState.items.length;
        renderAutocomplete();
      } else if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        applyAutocompleteItem(acState.items[acState.selected]);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closeAutocomplete();
      }
    });
    ta.addEventListener("blur", () => {
      setTimeout(() => { if (acState?.ta === ta) closeAutocomplete(); }, 160);
    });
  }

  // ---------- Interactive Paper Header Quick-Link Bar (1-click in Editor mode!) ----------
  function renderPaperLinksBar(containerEl) {
    if (!containerEl) return;
    clear(containerEl);
    const activePath = opts.getActivePath?.() || "";
    const noteOutgoing = [];
    const seen = new Set();
    for (const o of data.outgoing) {
      if (o.isImage) continue;
      const key = (o.resolvedPath || o.target).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      noteOutgoing.push(o);
    }

    const leftPills = el("div", { class: "ic-paper-links-pills" });

    // Backlinks summary pill
    if (data.backlinks.length > 0) {
      leftPills.appendChild(el("button", {
        type: "button",
        class: "ic-pl-pill is-backlink",
        title: "在右侧打开反向链接列表",
        onClick: () => opts.onOpenLinksTab?.(),
      }, `↩ ${data.backlinks.length} 篇引用本文`));
    }

    // Outgoing note pills (1-click open/create + hover preview!)
    noteOutgoing.slice(0, 8).forEach((o) => {
      const btn = el("button", {
        type: "button",
        class: "ic-pl-pill" + (o.exists ? "" : " is-unresolved"),
        title: o.exists ? `点击打开「${o.target}」` : `「${o.target}」尚未创建，点击一键新建`,
        onClick: () => navigateToLink(o.target, activePath),
      }, `${o.exists ? (o.isEmbed ? "📌 " : "🔗 ") : "＋ "}${o.alias || o.target}`);
      if (o.exists) bindHoverPreview(btn, o.resolvedPath || o.target, activePath);
      leftPills.appendChild(btn);
    });
    if (noteOutgoing.length > 8) {
      leftPills.appendChild(el("button", {
        type: "button",
        class: "ic-pl-pill is-more",
        onClick: () => opts.onOpenLinksTab?.(),
      }, `+${noteOutgoing.length - 8} 更多`));
    }

    if (!data.backlinks.length && !noteOutgoing.length) {
      leftPills.appendChild(el("span", { class: "ic-pl-hint muted" }, "输入 [[ 可建立笔记双链，点击胶囊直接跳转"));
    }

    const rightActs = el("div", { class: "ic-paper-links-acts" },
      el("button", {
        type: "button",
        class: "ic-pl-act-btn",
        title: "在正文插入 [[ 双链并打开补全",
        onClick: () => opts.onTriggerInsertLink?.(),
      }, "＋ 双链"),
      el("button", {
        type: "button",
        class: "ic-pl-act-btn",
        title: "查看当前文章的关系图谱",
        onClick: () => openGraphModal(activePath ? "local" : "global"),
      }, "🕸 图谱")
    );

    containerEl.append(leftPills, rightActs);
  }

  // ---------- Rich Preview & Embed Renderer ----------
  function appendInlineWithLinks(parent, text, sourcePath, depth = 0) {
    const s = String(text || "");
    const tokenRe = /(!?\[\[[^\[\]\r\n]+\]\]|!?\[[^\]]*\]\([^)\r\n]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(s)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
      const tok = m[0];

      if (tok.startsWith("![[") && tok.endsWith("]]")) {
        const { target, alias } = parseWikilinkInner(tok.slice(3, -2));
        const res = resolveLocalTarget(target, sourcePath);
        if (res?.kind === "attachment" || isImagePath(target)) {
          const widthNum = /^\d+$/.test(alias) ? parseInt(alias, 10) : 0;
          parent.appendChild(el("img", {
            src: vaultAssetUrl(res?.item?.path || target, sourcePath),
            alt: widthNum ? target : (alias || target),
            class: "ic-link-embed-img",
            style: widthNum ? { maxWidth: `${widthNum}px`, width: "100%" } : { width: "100%" },
          }));
        } else if (res?.kind === "note" && depth < 1) {
          parent.appendChild(buildEmbeddedNoteCard(res.item, depth + 1));
        } else {
          parent.appendChild(buildWikilinkPill(target, alias || target, false, sourcePath));
        }
      } else if (tok.startsWith("[[") && tok.endsWith("]]")) {
        const { target, heading, alias } = parseWikilinkInner(tok.slice(2, -2));
        const res = resolveLocalTarget(target, sourcePath);
        const label = alias || (heading ? `${target} › ${heading}` : target);
        parent.appendChild(buildWikilinkPill(target, label, Boolean(res), sourcePath));
      } else if (tok.startsWith("![")) {
        const im = tok.match(/^!\[([^\]]*)\]\(([^)\s]+)/);
        if (im) {
          const alt = im[1] || "";
          const href = im[2] || "";
          const src = /^https?:\/\/|^data:|^\//i.test(href) ? href : vaultAssetUrl(href, sourcePath);
          parent.appendChild(el("img", { src, alt, class: "ic-link-embed-img", style: { width: "100%" } }));
        }
      } else if (tok.startsWith("[")) {
        const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)/);
        if (lm) {
          const label = lm[1];
          const href = lm[2];
          if (/^https?:\/\//i.test(href)) {
            parent.appendChild(el("a", {
              href,
              class: "ic-ext-link",
              onClick: (ev) => { ev.preventDefault(); openURL(href); },
            }, label));
          } else {
            const res = resolveLocalTarget(href, sourcePath);
            parent.appendChild(buildWikilinkPill(href, label, Boolean(res), sourcePath));
          }
        }
      } else if (tok.startsWith("**") && tok.endsWith("**")) {
        parent.appendChild(el("strong", null, tok.slice(2, -2)));
      } else if (tok.startsWith("`") && tok.endsWith("`")) {
        parent.appendChild(el("code", { class: "ic-inline-code" }, tok.slice(1, -1)));
      } else if (tok.startsWith("*") && tok.endsWith("*")) {
        parent.appendChild(el("em", null, tok.slice(1, -1)));
      } else {
        parent.appendChild(document.createTextNode(tok));
      }
      last = m.index + tok.length;
    }
    if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
  }

  function buildWikilinkPill(target, label, exists, sourcePath) {
    const btn = el("button", {
      type: "button",
      class: "ic-wikilink" + (exists ? "" : " is-unresolved"),
      title: exists ? `点击跳转到「${target}」` : `「${target}」尚未创建，点击一键新建`,
      onClick: () => navigateToLink(target, sourcePath),
    }, label);
    if (exists) bindHoverPreview(btn, target, sourcePath);
    return btn;
  }

  function buildEmbeddedNoteCard(noteItem, depth) {
    const bodyEl = el("div", { class: "ic-embed-note-body muted" }, "正在加载嵌入笔记…");
    const card = el("div", { class: "ic-embed-note" },
      el("div", { class: "ic-embed-note-head" },
        el("div", { class: "row", style: { gap: "6px", minWidth: "0" } },
          el("span", { style: { fontSize: "13px" } }, "📄"),
          el("strong", { style: { fontSize: "13px" } }, noteItem.title || noteItem.basename),
          el("span", { class: "mono muted", style: { fontSize: "11px" } }, noteItem.path)
        ),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => opts.openNote?.(noteItem.path),
        }, "打开原笔记 ↗")
      ),
      bodyEl
    );

    const renderBody = (content) => {
      clear(bodyEl);
      bodyEl.classList.remove("muted");
      const stripped = String(content || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      const lines = stripped.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
      if (!lines.length) {
        bodyEl.textContent = "（空白笔记）";
        return;
      }
      lines.forEach((ln) => {
        const t = ln.trim();
        const hm = t.match(/^(#{1,6})\s+(.+)$/);
        if (hm) {
          const h = el("div", { class: "ic-embed-note-h" });
          appendInlineWithLinks(h, hm[2], noteItem.path, depth);
          bodyEl.appendChild(h);
        } else {
          const p = el("p", { style: { margin: "4px 0", lineHeight: "1.7" } });
          appendInlineWithLinks(p, t, noteItem.path, depth);
          bodyEl.appendChild(p);
        }
      });
    };

    fetchNoteText(noteItem.path)
      .then(renderBody)
      .catch(() => { bodyEl.textContent = "无法加载嵌入笔记内容"; });
    return card;
  }

  function renderPropertiesBar(sheet, rawContent) {
    const entries = parseFrontmatterEntries(rawContent);
    if (!entries.length) return;
    const keyLabels = { aliases: "别名", alias: "别名", tags: "标签", tag: "标签", author: "作者", date: "日期", title: "标题" };
    const grid = el("div", { class: "ic-pv-props-grid" });
    entries.forEach((e) => {
      grid.appendChild(el("div", { class: "ic-pv-prop-row" },
        el("span", { class: "ic-pv-prop-key" }, keyLabels[e.key.toLowerCase()] || e.key),
        el("div", { class: "ic-pv-prop-vals" },
          ...e.values.map((v) => el("span", { class: "ic-pv-prop-chip" }, v))
        )
      ));
    });
    sheet.appendChild(el("details", { class: "ic-pv-props", open: true },
      el("summary", { class: "ic-pv-props-head" }, `文档属性 (${entries.length})`),
      grid
    ));
  }

  function renderPreviewBlock(sheet, blockText, sourcePath) {
    const trimmed = String(blockText || "").trim();
    if (!trimmed) return;
    if (trimmed.startsWith("---") && trimmed.endsWith("---") && trimmed.includes("\n")) return;

    const hm = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const level = Math.min(4, hm[1].length + 1);
      const h = el(`h${level}`, { style: { margin: "14px 0 6px" } });
      appendInlineWithLinks(h, hm[2], sourcePath, 0);
      sheet.appendChild(h);
      return;
    }
    if (trimmed.startsWith("> ")) {
      const bq = el("blockquote", { class: "ic-pv-quote" });
      appendInlineWithLinks(bq, trimmed.replace(/^>\s?/gm, ""), sourcePath, 0);
      sheet.appendChild(bq);
      return;
    }
    if (/^!\[/.test(trimmed) && !trimmed.includes("\n")) {
      const wrap = el("div", { style: { margin: "10px 0" } });
      appendInlineWithLinks(wrap, trimmed, sourcePath, 0);
      sheet.appendChild(wrap);
      return;
    }
    const p = el("p", { style: { margin: "0 0 10px", lineHeight: "1.85" } });
    appendInlineWithLinks(p, trimmed, sourcePath, 0);
    sheet.appendChild(p);
  }

  function renderPreviewBacklinksFooter(sheet) {
    if (!data.backlinks.length) return;
    const box = el("section", { class: "ic-pv-backlinks-foot" },
      el("div", { class: "ic-pv-backlinks-head" },
        el("strong", null, `↩ 反向链接 (${data.backlinks.length})`),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => openGraphModal("local") }, "🕸 查看局部图谱")
      ),
      el("div", { class: "ic-pv-backlinks-grid" },
        ...data.backlinks.map((b) => {
          const card = el("button", {
            type: "button",
            class: "ic-pv-bl-card",
            onClick: () => opts.openNote?.(b.sourcePath),
          },
            el("div", { class: "ic-pv-bl-card-top" },
              el("strong", null, b.sourceName),
              el("span", { class: "mono muted", style: { fontSize: "11px" } }, `L${b.line}`)
            ),
            el("div", { class: "ic-pv-bl-card-snip muted" })
          );
          appendHighlightedSnippet(card.lastChild, b.snippet || b.raw, "");
          bindHoverPreview(card, b.sourcePath, data.activePath);
          return card;
        })
      )
    );
    sheet.appendChild(box);
  }

  // ---------- Full-Workspace Interactive Graph Stage (#121 — replaces cramped modal) ----------
  let wsGraphHandle = null;
  const wsGraphState = {
    mode: "global", // global | local
    focusPath: "",
    hops: 1,
    showUnresolved: true,
    hideOrphans: false,
    colorByFolder: true,
    activeFolder: "",
    query: "",
    repulseMul: 1.0,
    linkDistMul: 1.0,
    nodeScale: 1.0,
    settingsOpen: false,
  };

  function destroyWorkspaceGraph() {
    if (wsGraphHandle) {
      wsGraphHandle.destroy();
      wsGraphHandle = null;
    }
  }

  function openGraphModal(initialMode = "global", focusPath = "") {
    wsGraphState.mode = initialMode || "global";
    wsGraphState.focusPath = focusPath || (initialMode === "local" ? (opts.getActivePath?.() || data.activePath || "") : "");
    wsGraphState.activeFolder = "";
    if (typeof opts.onOpenGraphView === "function") {
      opts.onOpenGraphView(wsGraphState.mode, wsGraphState.focusPath);
    }
  }

  function renderWorkspaceGraph(stageEl) {
    if (!stageEl) return;
    destroyWorkspaceGraph();
    clear(stageEl);

    const canvasWrap = el("div", { class: "ic-ws-graph-canvas" });
    const searchIn = el("input", {
      type: "search",
      class: "input ic-ws-graph-search",
      value: wsGraphState.query,
      placeholder: "筛选笔记、路径或文件夹…",
    });

    const globalBtn = el("button", { type: "button", class: "ic-article-seg-btn" }, "全库图谱");
    const localBtn = el("button", { type: "button", class: "ic-article-seg-btn" }, "局部图谱");
    const hop1Btn = el("button", { type: "button", class: "btn btn-sm" }, "1 跳");
    const hop2Btn = el("button", { type: "button", class: "btn btn-sm" }, "2 跳");
    const hopsGroup = el("div", { class: "row", style: { gap: "3px" } }, hop1Btn, hop2Btn);

    const unresCb = el("input", { type: "checkbox" });
    unresCb.checked = wsGraphState.showUnresolved;
    const orphanCb = el("input", { type: "checkbox" });
    orphanCb.checked = wsGraphState.hideOrphans;
    const folderCb = el("input", { type: "checkbox" });
    folderCb.checked = wsGraphState.colorByFolder;

    const statsBadge = el("span", { class: "badge" }, "");
    const focusBtn = el("button", {
      type: "button",
      class: "btn btn-sm" + (opts.isGraphFullscreen?.() ? " btn-primary" : ""),
      title: "收起/恢复左右侧栏以全屏浏览图谱",
      onClick: () => {
        opts.onToggleGraphFullscreen?.();
        const isFs = Boolean(opts.isGraphFullscreen?.());
        focusBtn.classList.toggle("btn-primary", isFs);
        focusBtn.textContent = isFs ? "✕ 退出全屏" : "⛶ 专注全屏";
        setTimeout(() => wsGraphHandle?.fitToView(), 80);
      },
    }, opts.isGraphFullscreen?.() ? "✕ 退出全屏" : "⛶ 专注全屏");

    const settingsPop = el("div", { class: "ic-ws-graph-settings" + (wsGraphState.settingsOpen ? "" : " hidden") });
    const makeSliderRow = (label, min, max, step, val, onChange) => {
      const valLbl = el("span", { class: "mono muted", style: { fontSize: "11px" } }, String(val));
      const inp = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(val) });
      inp.addEventListener("input", () => {
        valLbl.textContent = inp.value;
        onChange(Number(inp.value));
      });
      return el("div", { class: "ic-ws-gs-row" },
        el("div", { class: "ic-ws-gs-head" }, el("span", null, label), valLbl),
        inp
      );
    };

    const settingsBtn = el("button", {
      type: "button",
      class: "btn btn-sm" + (wsGraphState.settingsOpen ? " btn-primary" : ""),
      title: "调整图谱排斥力、连线距离与显示筛选",
      onClick: () => {
        wsGraphState.settingsOpen = !wsGraphState.settingsOpen;
        settingsPop.classList.toggle("hidden", !wsGraphState.settingsOpen);
        settingsBtn.classList.toggle("btn-primary", wsGraphState.settingsOpen);
      },
    }, "⚙ 参数");

    const mount = () => {
      destroyWorkspaceGraph();
      const targetFocus = wsGraphState.focusPath || opts.getActivePath?.() || data.activePath || "";
      globalBtn.classList.toggle("is-active", wsGraphState.mode === "global");
      localBtn.classList.toggle("is-active", wsGraphState.mode === "local");
      hopsGroup.classList.toggle("hidden", wsGraphState.mode !== "local");
      hop1Btn.classList.toggle("btn-primary", wsGraphState.hops === 1);
      hop2Btn.classList.toggle("btn-primary", wsGraphState.hops === 2);

      const nCount = (data.graph?.nodes || []).length;
      const eCount = (data.graph?.edges || []).length;
      statsBadge.textContent = `${nCount} 笔记 · ${eCount} 双链`;

      wsGraphHandle = mountForceGraph(canvasWrap, data.graph, {
        mode: wsGraphState.mode,
        activePath: targetFocus,
        hops: wsGraphState.hops,
        showUnresolved: wsGraphState.showUnresolved,
        hideOrphans: wsGraphState.hideOrphans,
        colorByFolder: wsGraphState.colorByFolder,
        activeFolder: wsGraphState.activeFolder,
        repulseMul: wsGraphState.repulseMul,
        linkDistMul: wsGraphState.linkDistMul,
        nodeScale: wsGraphState.nodeScale,
        showLegend: true,
        showControls: true,
        query: wsGraphState.query,
        interactive: true,
        onFolderPick: (fname) => {
          wsGraphState.activeFolder = fname;
          mount();
        },
        onNodeClick: async (node) => {
          if (node.exists && node.path) await opts.openNote?.(node.path);
          else await opts.createAndOpenNote?.(node.label);
        },
        onNodeContextMenu: (ev, node) => {
          openArticleContextMenu(ev, [
            { header: node.label },
            {
              icon: "↗",
              label: node.exists ? "打开此笔记" : "新建并打开此笔记",
              onClick: () => (node.exists && node.path ? opts.openNote?.(node.path) : opts.createAndOpenNote?.(node.label)),
            },
            node.exists && node.path ? {
              icon: "📑",
              label: "在新标签页打开",
              onClick: () => opts.openNote?.(node.path, { newTab: true }),
            } : null,
            node.exists && node.path ? {
              icon: "🎯",
              label: "聚焦此节点的局部图谱",
              onClick: () => {
                wsGraphState.mode = "local";
                wsGraphState.focusPath = node.path;
                mount();
              },
            } : null,
            { sep: true },
            {
              icon: "🔗",
              label: `复制双链 [[${node.label}]]`,
              onClick: () => {
                navigator.clipboard?.writeText(`[[${node.label}]]`).catch(() => {});
                toast(`已复制 [[${node.label}]]`);
              },
            },
            node.exists && node.path ? {
              icon: "📂",
              label: "在系统文件夹中显示",
              onClick: () => api("POST", "/api/article/vault/reveal", { path: node.path }).catch(() => {}),
            } : null,
          ]);
        },
      });
    };

    settingsPop.append(
      el("div", { class: "ic-ws-gs-title" }, "图谱筛选与物理布局"),
      el("label", { class: "ic-obs-check-lbl" }, unresCb, el("span", null, "显示尚未创建的悬空节点")),
      el("label", { class: "ic-obs-check-lbl" }, orphanCb, el("span", null, "隐藏无关联的孤立笔记")),
      el("label", { class: "ic-obs-check-lbl" }, folderCb, el("span", null, "按顶层文件夹自动分组着色")),
      makeSliderRow("节点排斥力", 0.4, 2.6, 0.1, wsGraphState.repulseMul, (v) => { wsGraphState.repulseMul = v; mount(); }),
      makeSliderRow("连线间距", 0.5, 2.2, 0.1, wsGraphState.linkDistMul, (v) => { wsGraphState.linkDistMul = v; mount(); }),
      makeSliderRow("节点大小", 0.7, 1.6, 0.1, wsGraphState.nodeScale, (v) => { wsGraphState.nodeScale = v; mount(); }),
      el("div", { class: "row", style: { justifyContent: "flex-end", marginTop: "4px" } },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => {
            wsGraphState.repulseMul = 1.0;
            wsGraphState.linkDistMul = 1.0;
            wsGraphState.nodeScale = 1.0;
            wsGraphState.activeFolder = "";
            mount();
          },
        }, "恢复默认参数")
      )
    );

    globalBtn.addEventListener("click", () => { wsGraphState.mode = "global"; mount(); });
    localBtn.addEventListener("click", () => { wsGraphState.mode = "local"; mount(); });
    hop1Btn.addEventListener("click", () => { wsGraphState.hops = 1; mount(); });
    hop2Btn.addEventListener("click", () => { wsGraphState.hops = 2; mount(); });
    unresCb.addEventListener("change", () => { wsGraphState.showUnresolved = unresCb.checked; mount(); });
    orphanCb.addEventListener("change", () => { wsGraphState.hideOrphans = orphanCb.checked; mount(); });
    folderCb.addEventListener("change", () => { wsGraphState.colorByFolder = folderCb.checked; mount(); });
    searchIn.addEventListener("input", () => { wsGraphState.query = searchIn.value; mount(); });

    const floatingBar = el("div", { class: "ic-ws-graph-bar" },
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => opts.onExitGraphView?.(),
        }, "← 返回文章"),
        el("div", { class: "ic-article-segmented-switch" }, globalBtn, localBtn),
        hopsGroup,
        searchIn
      ),
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        statsBadge,
        settingsBtn,
        el("button", { type: "button", class: "btn btn-sm", onClick: () => wsGraphHandle?.fitToView() }, "⌖ 居中"),
        focusBtn
      )
    );

    stageEl.append(canvasWrap, floatingBar, settingsPop);
    requestAnimationFrame(() => mount());
  }

  // ---------- Right Drawer "🔗 双链" Panel (zero clipping, full scroll, highlighted snippets) ----------
  function renderPanel() {
    if (miniGraphHandle) { miniGraphHandle.destroy(); miniGraphHandle = null; }
    clear(panelEl);

    const activePath = opts.getActivePath?.() || data.activePath || "";
    const activeNote = data.notes.find((n) => n.path.toLowerCase() === activePath.toLowerCase());

    const head = el("div", { class: "ic-obs-pane-head" },
      el("div", { class: "row", style: { gap: "6px", minWidth: "0" } },
        el("strong", { style: { fontSize: "13px" } }, "双向链接与图谱")
      ),
      el("div", { class: "row", style: { gap: "4px" } },
        el("button", { type: "button", class: "btn btn-sm", title: "打开全库关系图谱", onClick: () => openGraphModal("global") }, "🕸 全库"),
        el("button", { type: "button", class: "btn btn-sm", title: "刷新双链索引", onClick: () => refresh(activePath) }, "↻"),
        el("button", { type: "button", class: "btn btn-sm", title: "关闭右侧抽屉", onClick: () => opts.onCloseDrawer?.() }, "✕")
      )
    );
    panelEl.appendChild(head);

    const scroll = el("div", { class: "ic-links-scroll" });

    // 1. Mini Local Graph Card (with auto-fit + controls!)
    const miniCanvasWrap = el("div", { class: "ic-link-mini-graph" });
    scroll.appendChild(el("section", { class: "ic-links-sec" },
      el("div", { class: "ic-links-sec-head is-static" },
        el("strong", null, "局部关系图谱"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => openGraphModal(activePath ? "local" : "global"),
        }, "大屏展开 ⤢")
      ),
      miniCanvasWrap
    ));

    // 2. Backlinks
    const blSec = el("details", { class: "ic-links-sec", open: true });
    blSec.appendChild(el("summary", { class: "ic-links-sec-head" },
      el("span", { class: "ic-links-sec-title" },
        el("span", { class: "ic-links-chev", "aria-hidden": "true" }, "▾"),
        el("strong", null, "反向链接"),
        el("span", { class: "ic-links-count-pill" }, String(data.backlinks.length))
      ),
      el("span", { class: "muted", style: { fontSize: "11px" } }, "谁引用了本文")
    ));
    if (!data.backlinks.length) {
      blSec.appendChild(el("div", { class: "ic-links-empty muted" }, "暂无其他文章引用本篇。"));
    } else {
      const list = el("div", { class: "ic-links-list" });
      data.backlinks.forEach((b) => {
        const snipEl = el("div", { class: "ic-links-snippet" });
        appendHighlightedSnippet(snipEl, b.snippet || b.raw, "");
        const itemBtn = el("button", {
          type: "button",
          class: "ic-links-item",
          onClick: () => opts.openNote?.(b.sourcePath),
        },
          el("div", { class: "ic-links-item-top" },
            el("strong", { class: "ic-links-item-name" }, b.sourceName),
            el("span", { class: "ic-links-line-pill mono" }, `L${b.line}`)
          ),
          snipEl
        );
        bindHoverPreview(itemBtn, b.sourcePath, activePath);
        list.appendChild(itemBtn);
      });
      blSec.appendChild(list);
    }
    scroll.appendChild(blSec);

    // 3. Outgoing Links (deduplicated with occurrence count)
    const outGrouped = [];
    const outMap = new Map();
    for (const o of data.outgoing) {
      if (o.isImage) continue;
      const key = `${o.isEmbed ? "e:" : "l:"}${(o.resolvedPath || o.target).toLowerCase()}`;
      if (outMap.has(key)) {
        outMap.get(key).count += 1;
      } else {
        const entry = { ...o, count: 1 };
        outMap.set(key, entry);
        outGrouped.push(entry);
      }
    }

    const outSec = el("details", { class: "ic-links-sec", open: true });
    outSec.appendChild(el("summary", { class: "ic-links-sec-head" },
      el("span", { class: "ic-links-sec-title" },
        el("span", { class: "ic-links-chev", "aria-hidden": "true" }, "▾"),
        el("strong", null, "出链"),
        el("span", { class: "ic-links-count-pill" }, String(outGrouped.length))
      ),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: (ev) => { ev.preventDefault(); ev.stopPropagation(); opts.onTriggerInsertLink?.(); },
      }, "＋ 插入")
    ));
    if (!outGrouped.length) {
      outSec.appendChild(el("div", { class: "ic-links-empty muted" }, "点击「＋ 插入」或在正文输入 [[ 即可建立笔记关联。"));
    } else {
      const list = el("div", { class: "ic-links-list" });
      outGrouped.forEach((o) => {
        const itemBtn = el("button", {
          type: "button",
          class: "ic-links-item",
          onClick: () => navigateToLink(o.target, activePath),
        },
          el("div", { class: "ic-links-item-top" },
            el("span", { class: "ic-links-item-name" + (o.exists ? "" : " muted") },
              `${o.isEmbed ? "📌 " : "🔗 "}${o.alias || o.target}${o.count > 1 ? ` ×${o.count}` : ""}`
            ),
            el("span", { class: "badge" + (o.exists ? " ic-obs-badge-ok" : "") }, o.exists ? "打开 ↗" : "＋ 新建")
          ),
          o.resolvedPath ? el("div", { class: "mono muted", style: { fontSize: "11px", wordBreak: "break-all" } }, o.resolvedPath) : null
        );
        if (o.exists) bindHoverPreview(itemBtn, o.resolvedPath || o.target, activePath);
        list.appendChild(itemBtn);
      });
      outSec.appendChild(list);
    }
    scroll.appendChild(outSec);

    // 4. Unlinked Mentions
    const umSec = el("details", { class: "ic-links-sec", open: data.unlinkedMentions.length > 0 });
    umSec.appendChild(el("summary", { class: "ic-links-sec-head" },
      el("span", { class: "ic-links-sec-title" },
        el("span", { class: "ic-links-chev", "aria-hidden": "true" }, "▾"),
        el("strong", null, "未链接提及"),
        el("span", { class: "ic-links-count-pill" }, String(data.unlinkedMentions.length))
      ),
      el("span", { class: "muted", style: { fontSize: "11px" } }, "一键转双链")
    ));
    if (!data.unlinkedMentions.length) {
      umSec.appendChild(el("div", { class: "ic-links-empty muted" }, "未发现其他文章中尚未加双链的提及。"));
    } else {
      const list = el("div", { class: "ic-links-list" });
      data.unlinkedMentions.forEach((u) => {
        const snipEl = el("div", { class: "ic-links-snippet" });
        appendHighlightedSnippet(snipEl, u.snippet, u.matchText);
        const srcBtn = el("button", {
          type: "button",
          class: "ic-links-source-btn",
          onClick: () => opts.openNote?.(u.sourcePath),
        }, u.sourceName);
        bindHoverPreview(srcBtn, u.sourcePath, activePath);
        const row = el("div", { class: "ic-links-mention-row" },
          el("div", { class: "ic-links-item-top" },
            srcBtn,
            el("button", {
              type: "button",
              class: "btn btn-sm btn-primary",
              onClick: async () => {
                try {
                  await api("POST", "/api/article/vault/links/linkify", {
                    sourcePath: u.sourcePath,
                    line: u.line,
                    matchText: u.matchText,
                    targetName: activeNote?.basename || activePath.split("/").pop().replace(/\.(md|markdown)$/i, ""),
                  });
                  toast(`已在「${u.sourceName}」中转为双链`);
                  await refresh(activePath);
                } catch (err) {
                  toast(err.message || "转换双链失败");
                }
              },
            }, "转为双链")
          ),
          snipEl
        );
        list.appendChild(row);
      });
      umSec.appendChild(list);
    }
    scroll.appendChild(umSec);

    panelEl.appendChild(scroll);

    requestAnimationFrame(() => {
      if (!miniCanvasWrap.isConnected) return;
      miniGraphHandle = mountForceGraph(miniCanvasWrap, data.graph, {
        mode: activePath ? "local" : "global",
        activePath,
        hops: 1,
        showUnresolved: true,
        showLegend: false,
        showControls: true,
        interactive: true,
        onNodeClick: async (node) => {
          if (node.exists && node.path) await opts.openNote?.(node.path);
          else await opts.createAndOpenNote?.(node.label);
        },
      });
    });
  }

  async function refresh(activePath = "") {
    notePreviewCache.clear();
    const p = activePath || opts.getActivePath?.() || "";
    try {
      const q = p ? `?path=${encodeURIComponent(p)}` : "";
      const res = await api("GET", `/api/article/vault/links${q}`);
      data.activePath = res.activePath || p;
      data.notes = res.notes || [];
      data.attachments = res.attachments || [];
      data.outgoing = res.outgoing || [];
      data.backlinks = res.backlinks || [];
      data.unlinkedMentions = res.unlinkedMentions || [];
      data.graph = res.graph || { nodes: [], edges: [] };
      renderPanel();
      opts.onLinksUpdated?.(data);
    } catch {}
  }

  function dispose() {
    closeAutocomplete();
    hideHoverPreview(true);
    closeArticleContextMenu();
    destroyWorkspaceGraph();
    if (miniGraphHandle) { miniGraphHandle.destroy(); miniGraphHandle = null; }
  }

  return {
    data,
    panelEl,
    refresh,
    renderPanel,
    renderPaperLinksBar,
    renderPropertiesBar,
    renderPreviewBlock,
    renderPreviewBacklinksFooter,
    renderWorkspaceGraph,
    destroyWorkspaceGraph,
    appendInlineWithLinks,
    parseFrontmatterEntries,
    resolveLocalTarget,
    bindHoverPreview,
    buildEmbeddedNoteCard,
    fetchNoteText,
    triggerInsertWikilink,
    triggerInsertWikilinkCM,
    updateAutocompleteFromCM,
    handleCMKeydown,
    closeAutocomplete,
    attachTextarea,
    openGraphModal,
    navigateToLink,
    dispose,
  };
}
