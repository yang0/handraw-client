import { api, clear, closeModal, el, getToken, openURL, showModal, toast } from "../api.js";

const WIKILINK_RE = /(!)?\[\[([^\[\]\r\n]+)\]\]/g;
const MDLINK_RE = /(!)?\[([^\]]*)\]\(([^)\r\n]+)\)/g;

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
  const left = rect.left + marker.offsetLeft - ta.scrollLeft;
  const top = rect.top + marker.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight || "22");
  mirror.remove();
  return {
    left: Math.max(12, Math.min(left, window.innerWidth - 330)),
    top: Math.max(40, Math.min(top + 4, window.innerHeight - 250)),
  };
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

// ---------- Interactive Canvas Force-Directed Graph ----------
function mountForceGraph(container, rawGraph, opts = {}) {
  const {
    mode = "local", // local | global
    activePath = "",
    hops = 1,
    showUnresolved = true,
    query = "",
    interactive = true,
    onNodeClick = null,
  } = opts;

  clear(container);
  const allNodes = Array.isArray(rawGraph?.nodes) ? rawGraph.nodes : [];
  const allEdges = Array.isArray(rawGraph?.edges) ? rawGraph.edges : [];

  // Filter graph based on local vs global mode
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

  let nodes = allNodes
    .filter((n) => keptIds.has(n.id) && (showUnresolved || n.exists))
    .map((n, i) => ({
      ...n,
      isCurrent: Boolean(activePath && n.path && n.path.toLowerCase() === activePath.toLowerCase()),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: n.isCurrent || (activePath && n.path?.toLowerCase() === activePath.toLowerCase()) ? 9 : Math.min(11, 5.2 + Math.sqrt(n.degree || 0) * 1.4),
      _seed: i,
    }));

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = allEdges
    .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
    .map((e) => ({ source: nodeById.get(e.source), target: nodeById.get(e.target), isEmbed: Boolean(e.isEmbed) }));

  if (!nodes.length) {
    container.appendChild(el("div", { class: "ic-link-graph-empty muted" },
      mode === "local" ? "当前文章还没有双向链接。在正文输入 [[ 即可关联其他笔记。" : "当前文章库暂无笔记节点。"
    ));
    return { destroy() {}, resetView() {} };
  }

  const canvas = el("canvas", { class: "ic-link-graph-canvas" });
  const tooltip = el("div", { class: "ic-link-graph-tip hidden" });
  container.append(canvas, tooltip);

  let width = container.clientWidth || 320;
  let height = container.clientHeight || 200;
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const resize = () => {
    width = container.clientWidth || 320;
    height = container.clientHeight || 200;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  };
  resize();

  // Deterministic initial ring placement
  const initR = Math.min(width, height) * 0.28;
  nodes.forEach((n, i) => {
    if (n.isCurrent) {
      n.x = 0;
      n.y = 0;
    } else {
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 + 0.3;
      const dist = initR * (0.55 + ((i * 37) % 10) / 16);
      n.x = Math.cos(angle) * dist;
      n.y = Math.sin(angle) * dist;
    }
  });

  // Adjacency for hover highlighting
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
    const isLarge = width >= 500;
    const repulse = isLarge ? 4600 : 2400;
    const linkDist = isLarge ? 112 : 70;
    const springK = 0.045;
    const centerK = 0.012;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.vx += -a.x * centerK * alpha;
        a.vy += -a.y * centerK * alpha;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const d2 = dx * dx + dy * dy + 16;
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
        n.vx *= 0.82;
        n.vy *= 0.82;
        n.x += Math.max(-18, Math.min(18, n.vx));
        n.y += Math.max(-18, Math.min(18, n.vy));
      }
      alpha *= 0.985;
    }
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
      const hitR = Math.max(10 / camScale, n.radius + 4);
      if (dx * dx + dy * dy <= hitR * hitR) return n;
    }
    return null;
  }

  function draw() {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const isDark = document.querySelector('meta[name="color-scheme"]')?.content === "dark" ||
      (document.querySelector('meta[name="color-scheme"]')?.content !== "light" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);

    const bgColor = isDark ? "#1c1916" : "#faf7f2";
    const inkColor = isDark ? "#efe8dc" : "#2c241b";
    const mutedNode = isDark ? "#7c7266" : "#8e8070";
    const unresolvedColor = isDark ? "#5c5349" : "#bfb4a5";
    const edgeColor = isDark ? "rgba(239,232,220,0.16)" : "rgba(44,36,27,0.16)";
    const accent = isDark ? "#e0674c" : "#c84b31";

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    ctx.translate(width / 2, height / 2);
    ctx.scale(camScale, camScale);
    ctx.translate(camX, camY);

    const focusSet = hoveredNode ? neighbors.get(hoveredNode.id) : null;

    // Edges
    for (const e of edges) {
      const lit = !focusSet || (focusSet.has(e.source.id) && focusSet.has(e.target.id) && (e.source === hoveredNode || e.target === hoveredNode));
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.strokeStyle = lit && focusSet ? accent : edgeColor;
      ctx.lineWidth = (lit && focusSet ? 1.8 : 1.05) / Math.sqrt(camScale);
      if (e.isEmbed) ctx.setLineDash([4, 3]);
      else ctx.setLineDash([]);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Nodes + labels
    const showLabels = camScale >= 0.65 || nodes.length <= 35;
    for (const n of nodes) {
      const matchesQ = !ql || n.label.toLowerCase().includes(ql) || (n.path || "").toLowerCase().includes(ql);
      const lit = (!focusSet || focusSet.has(n.id)) && matchesQ;
      ctx.globalAlpha = lit ? 1 : 0.22;

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = n.isCurrent ? accent : (n.exists ? (hoveredNode === n ? accent : mutedNode) : unresolvedColor);
      ctx.fill();
      if (n.isCurrent || hoveredNode === n) {
        ctx.lineWidth = 2 / Math.sqrt(camScale);
        ctx.strokeStyle = isDark ? "#faf7f2" : "#ffffff";
        ctx.stroke();
      }
      if (!n.exists) {
        ctx.setLineDash([2, 2]);
        ctx.lineWidth = 1.2 / Math.sqrt(camScale);
        ctx.strokeStyle = mutedNode;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (showLabels || n.isCurrent || hoveredNode === n || (ql && matchesQ)) {
        const fontSize = Math.max(9.5, Math.min(12.5, (n.isCurrent ? 12 : 11) / Math.sqrt(camScale)));
        ctx.font = `${n.isCurrent ? "600" : "400"} ${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.fillStyle = n.isCurrent ? accent : inkColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = n.label.length > 18 ? n.label.slice(0, 17) + "…" : n.label;
        ctx.fillText(label, n.x, n.y + n.radius + 4);
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Settle initial positions cleanly
  tickPhysics(prefersReducedMotion() ? 130 : 70);
  draw();

  function loop() {
    if (destroyed) return;
    if (alpha > 0.03 || draggingNode) {
      tickPhysics(1);
      draw();
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = 0;
    }
  }
  if (!prefersReducedMotion()) {
    rafId = requestAnimationFrame(loop);
  }

  function wake(newAlpha = 0.25) {
    alpha = Math.max(alpha, newAlpha);
    if (prefersReducedMotion()) {
      tickPhysics(8);
      draw();
      return;
    }
    if (!rafId) rafId = requestAnimationFrame(loop);
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
        wake(0.18);
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
          tooltip.textContent = `${hit.label}${hit.exists ? "" : "（未创建，点击新建）"} · ${hit.degree || 0} 条关联`;
          tooltip.classList.remove("hidden");
        } else {
          tooltip.classList.add("hidden");
        }
        draw();
      }
      if (hit) {
        const pos = worldToScreen(hit.x, hit.y);
        tooltip.style.left = `${Math.max(8, Math.min(pos.x + 12, width - 190))}px`;
        tooltip.style.top = `${Math.max(8, pos.y - 28)}px`;
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
      const factor = ev.deltaY < 0 ? 1.12 : 0.89;
      camScale = Math.max(0.3, Math.min(3.2, camScale * factor));
      draw();
    }, { passive: false });

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { resize(); draw(); }) : null;
    if (ro) ro.observe(container);

    return {
      destroy() {
        destroyed = true;
        if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener("mouseup", onUp);
        if (ro) ro.disconnect();
      },
      resetView() {
        camX = 0; camY = 0; camScale = 1;
        wake(0.4);
        draw();
      },
    };
  }

  return {
    destroy() { destroyed = true; if (rafId) cancelAnimationFrame(rafId); },
    resetView() {},
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
  let acState = null; // { ta, startIdx, endIdx, isEmbed, headingMode, baseNote, items, selected }
  let miniGraphHandle = null;
  const notePreviewCache = new Map();

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
    const { target } = parseWikilinkInner(rawTarget);
    if (!target) return;
    const res = resolveLocalTarget(target, sourcePath || opts.getActivePath?.() || "");
    if (res?.kind === "note") {
      await opts.openNote?.(res.item.path);
      return;
    }
    if (res?.kind === "attachment") {
      toast(`附件：${res.item.path}`);
      return;
    }
    // Unresolved note -> create and open directly!
    await opts.createAndOpenNote?.(target);
  }

  // ---------- Autocomplete Popup for [[ and ![[ ----------
  function closeAutocomplete() {
    if (acEl) {
      acEl.remove();
      acEl = null;
    }
    acState = null;
  }

  function applyAutocompleteItem(item) {
    if (!acState) return;
    const { ta, startIdx, endIdx, isEmbed } = acState;
    const prefix = isEmbed ? "![[" : "[[";
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
    const { items, selected, isEmbed, headingMode } = acState;
    acEl.appendChild(el("div", { class: "ic-link-ac-head" },
      headingMode ? "选择文内标题 (#)" : (isEmbed ? "嵌入笔记或图片 (![[…]])" : "插入双链笔记 ([[…]])"),
      el("span", { class: "muted", style: { fontSize: "11px" } }, "↑↓ 切换 · Enter 插入")
    ));
    const list = el("div", { class: "ic-link-ac-list" });
    items.forEach((it, idx) => {
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
          el("div", { class: "ic-link-ac-title" }, it.label),
          it.sub ? el("div", { class: "ic-link-ac-sub muted" }, it.sub) : null
        )
      );
      list.appendChild(row);
    });
    acEl.appendChild(list);
    const coords = getTextareaCaretCoords(acState.ta, acState.endIdx);
    acEl.style.left = `${coords.left}px`;
    acEl.style.top = `${coords.top}px`;
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
          .slice(0, 12)
          .forEach((h) => {
            items.push({
              icon: "#",
              label: h,
              sub: resolved.basename,
              insertValue: `${noteQuery ? resolved.basename : ""}#${h}`,
            });
          });
      }
    } else {
      const ql = rawQuery.trim().toLowerCase();
      // Matching notes
      for (const n of data.notes) {
        const hay = `${n.basename} ${n.path} ${n.title} ${(n.aliases || []).join(" ")}`.toLowerCase();
        if (!ql || hay.includes(ql)) {
          items.push({
            icon: "📄",
            label: n.basename,
            sub: n.path !== n.name ? n.path : (n.title && n.title !== n.basename ? n.title : ""),
            insertValue: n.basename,
          });
        }
        if (items.length >= 12) break;
      }
      // Matching images/attachments (especially when ![[ is used)
      if (isEmbed || ql) {
        for (const a of data.attachments) {
          if (!isEmbed && !a.isImage) continue;
          const hay = `${a.name} ${a.path}`.toLowerCase();
          if (!ql || hay.includes(ql)) {
            items.push({
              icon: a.isImage ? "🖼" : "📎",
              label: a.name,
              sub: a.path,
              insertValue: a.path,
            });
          }
          if (items.length >= 18) break;
        }
      }
      // Offer creating a new note link when typing custom title
      if (rawQuery.trim() && !items.some((x) => x.label.toLowerCase() === ql)) {
        items.push({
          icon: "＋",
          label: `链接新笔记「${rawQuery.trim()}」`,
          sub: "插入双链，点击即可一键创建",
          insertValue: rawQuery.trim(),
        });
      }
    }

    if (!items.length) { closeAutocomplete(); return; }
    acState = {
      ta,
      startIdx,
      endIdx: pos,
      isEmbed,
      headingMode,
      items,
      selected: 0,
    };
    renderAutocomplete();
  }

  function attachTextarea(ta) {
    if (!ta || ta.dataset.obsLinksBound) return;
    ta.dataset.obsLinksBound = "1";

    ta.addEventListener("input", () => updateAutocomplete(ta));
    ta.addEventListener("click", (ev) => {
      if (ev.ctrlKey || ev.metaKey) {
        const pos = ta.selectionStart ?? 0;
        const val = ta.value || "";
        // Find [[...]] containing clicked offset
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
      setTimeout(() => {
        if (acState?.ta === ta) closeAutocomplete();
      }, 150);
    });
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
          const img = el("img", {
            src: vaultAssetUrl(res?.item?.path || target, sourcePath),
            alt: widthNum ? target : (alias || target),
            class: "ic-link-embed-img",
            style: widthNum ? { maxWidth: `${widthNum}px`, width: "100%" } : { width: "100%" },
          });
          parent.appendChild(img);
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
    return el("button", {
      type: "button",
      class: "ic-wikilink" + (exists ? "" : " is-unresolved"),
      title: exists ? `跳转到「${target}」` : `「${target}」尚未创建，点击一键新建`,
      onClick: () => navigateToLink(target, sourcePath),
    }, label);
  }

  function buildEmbeddedNoteCard(noteItem, depth) {
    const bodyEl = el("div", { class: "ic-embed-note-body muted" }, "正在加载嵌入笔记…");
    const card = el("div", { class: "ic-embed-note" },
      el("div", { class: "ic-embed-note-head" },
        el("span", null, `📄 ${noteItem.title || noteItem.basename}`),
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
      const lines = stripped.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
      if (!lines.length) {
        bodyEl.textContent = "（空白笔记）";
        return;
      }
      lines.forEach((ln) => {
        const p = el("p", { style: { margin: "4px 0", lineHeight: "1.65" } });
        appendInlineWithLinks(p, ln.replace(/^#+\s*/, ""), noteItem.path, depth);
        bodyEl.appendChild(p);
      });
    };

    if (notePreviewCache.has(noteItem.path)) {
      renderBody(notePreviewCache.get(noteItem.path));
    } else {
      api("GET", `/api/article/vault/file?path=${encodeURIComponent(noteItem.path)}`)
        .then((res) => {
          notePreviewCache.set(noteItem.path, res.content || "");
          renderBody(res.content || "");
        })
        .catch(() => { bodyEl.textContent = "无法加载嵌入笔记内容"; });
    }
    return card;
  }

  function renderPreviewBlock(sheet, blockText, sourcePath) {
    const trimmed = String(blockText || "").trim();
    if (!trimmed) return;
    // Skip raw YAML frontmatter block in preview
    if (trimmed.startsWith("---") && trimmed.endsWith("---") && trimmed.includes("\n")) return;

    const hm = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const level = Math.min(4, hm[1].length + 1);
      const h = el(`h${level}`, { style: { margin: "12px 0 4px" } });
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
    const p = el("p", { style: { margin: "0 0 8px", lineHeight: "1.8" } });
    appendInlineWithLinks(p, trimmed, sourcePath, 0);
    sheet.appendChild(p);
  }

  // ---------- Full Relationship Graph Modal ----------
  function openGraphModal(initialMode = "global") {
    let mode = initialMode;
    let hops = 1;
    let showUnresolved = true;
    let query = "";
    let graphHandle = null;

    const canvasWrap = el("div", { class: "ic-link-graph-modal-canvas" });
    const searchIn = el("input", {
      type: "search",
      class: "input",
      style: { width: "200px" },
      placeholder: "筛选笔记节点…",
    });

    const localBtn = el("button", { type: "button", class: "btn btn-sm" }, "局部图谱");
    const globalBtn = el("button", { type: "button", class: "btn btn-sm" }, "全库图谱");
    const hop1Btn = el("button", { type: "button", class: "btn btn-sm" }, "1 跳");
    const hop2Btn = el("button", { type: "button", class: "btn btn-sm" }, "2 跳");
    const hopsGroup = el("div", { class: "row", style: { gap: "4px" } }, hop1Btn, hop2Btn);

    const unresCb = el("input", { type: "checkbox" });
    unresCb.checked = showUnresolved;
    const statsLbl = el("span", { class: "muted", style: { fontSize: "12px" } }, "");

    const mount = () => {
      if (graphHandle) { graphHandle.destroy(); graphHandle = null; }
      localBtn.classList.toggle("btn-primary", mode === "local");
      globalBtn.classList.toggle("btn-primary", mode === "global");
      hopsGroup.classList.toggle("hidden", mode !== "local");
      hop1Btn.classList.toggle("btn-primary", hops === 1);
      hop2Btn.classList.toggle("btn-primary", hops === 2);

      const nCount = (data.graph?.nodes || []).length;
      const eCount = (data.graph?.edges || []).length;
      statsLbl.textContent = `${nCount} 节点 · ${eCount} 条双链`;

      graphHandle = mountForceGraph(canvasWrap, data.graph, {
        mode,
        activePath: opts.getActivePath?.() || data.activePath || "",
        hops,
        showUnresolved,
        query,
        interactive: true,
        onNodeClick: async (node) => {
          closeModal();
          if (node.exists && node.path) await opts.openNote?.(node.path);
          else await opts.createAndOpenNote?.(node.label);
        },
      });
    };

    localBtn.addEventListener("click", () => { mode = "local"; mount(); });
    globalBtn.addEventListener("click", () => { mode = "global"; mount(); });
    hop1Btn.addEventListener("click", () => { hops = 1; mount(); });
    hop2Btn.addEventListener("click", () => { hops = 2; mount(); });
    unresCb.addEventListener("change", () => { showUnresolved = unresCb.checked; mount(); });
    searchIn.addEventListener("input", () => { query = searchIn.value; mount(); });

    const body = el("div", { class: "ic-link-graph-modal" },
      el("div", { class: "ic-link-graph-bar" },
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          localBtn,
          globalBtn,
          hopsGroup,
          searchIn,
          el("label", { class: "ic-obs-check-lbl" }, unresCb, el("span", null, "显示未创建节点"))
        ),
        el("div", { class: "row", style: { gap: "8px" } },
          statsLbl,
          el("button", { type: "button", class: "btn btn-sm", onClick: () => graphHandle?.resetView() }, "重置视角")
        )
      ),
      canvasWrap,
      el("div", { class: "muted", style: { fontSize: "11.5px" } }, "滚轮缩放 · 拖拽画布平移 · 拖动节点调布局 · 点击节点跳转或新建笔记")
    );

    showModal("关系图谱（Obsidian 双链网络）", body, [
      el("button", { type: "button", class: "btn", onClick: () => { graphHandle?.destroy(); closeModal(); } }, "关闭"),
    ]);
    requestAnimationFrame(() => mount());
  }

  // ---------- Right Drawer "🔗 双链" Panel ----------
  function renderPanel() {
    if (miniGraphHandle) { miniGraphHandle.destroy(); miniGraphHandle = null; }
    clear(panelEl);

    const activePath = opts.getActivePath?.() || data.activePath || "";
    const activeNote = data.notes.find((n) => n.path.toLowerCase() === activePath.toLowerCase());

    const head = el("div", { class: "ic-obs-pane-head" },
      el("strong", { style: { fontSize: "13px" } }, "双向链接与图谱"),
      el("div", { class: "row", style: { gap: "4px" } },
        el("button", { type: "button", class: "btn btn-sm", title: "打开全库关系图谱", onClick: () => openGraphModal("global") }, "🕸 图谱"),
        el("button", { type: "button", class: "btn btn-sm", title: "刷新双链索引", onClick: () => refresh(activePath) }, "↻"),
        el("button", { type: "button", class: "btn btn-sm", title: "关闭右侧抽屉", onClick: () => opts.onCloseDrawer?.() }, "✕")
      )
    );
    panelEl.appendChild(head);

    const scroll = el("div", { class: "ic-links-scroll" });

    // 1. Mini Local Graph Card
    const miniCanvasWrap = el("div", { class: "ic-link-mini-graph" });
    scroll.appendChild(el("div", { class: "ic-links-sec" },
      el("div", { class: "ic-links-sec-head" },
        el("strong", null, "局部关系图谱"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => openGraphModal(activePath ? "local" : "global"),
        }, "放大 ⤢")
      ),
      miniCanvasWrap
    ));

    // 2. Backlinks
    const blSec = el("details", { class: "ic-links-sec", open: true });
    blSec.appendChild(el("summary", { class: "ic-links-sec-head" },
      el("strong", null, `反向链接 (${data.backlinks.length})`),
      el("span", { class: "muted", style: { fontSize: "11px" } }, "谁引用了本文")
    ));
    if (!data.backlinks.length) {
      blSec.appendChild(el("div", { class: "ic-links-empty muted" }, "暂无其他文章引用本篇。"));
    } else {
      const list = el("div", { class: "ic-links-list" });
      data.backlinks.forEach((b) => {
        list.appendChild(el("button", {
          type: "button",
          class: "ic-links-item",
          onClick: () => opts.openNote?.(b.sourcePath),
        },
          el("div", { class: "ic-links-item-top" },
            el("strong", null, b.sourceName),
            el("span", { class: "mono muted", style: { fontSize: "11px" } }, `L${b.line}`)
          ),
          el("div", { class: "ic-links-snippet muted" }, b.snippet || b.raw)
        ));
      });
      blSec.appendChild(list);
    }
    scroll.appendChild(blSec);

    // 3. Outgoing Links
    const noteOutgoing = data.outgoing.filter((x) => !x.isImage);
    const outSec = el("details", { class: "ic-links-sec", open: true });
    outSec.appendChild(el("summary", { class: "ic-links-sec-head" },
      el("strong", null, `出链 (${noteOutgoing.length})`),
      el("span", { class: "muted", style: { fontSize: "11px" } }, "本文引用的笔记")
    ));
    if (!noteOutgoing.length) {
      outSec.appendChild(el("div", { class: "ic-links-empty muted" }, "在正文输入 [[ 可快速插入双链；按 Ctrl/⌘+点击 可直接跳转。"));
    } else {
      const list = el("div", { class: "ic-links-list" });
      noteOutgoing.forEach((o) => {
        list.appendChild(el("button", {
          type: "button",
          class: "ic-links-item",
          onClick: () => navigateToLink(o.target, activePath),
        },
          el("div", { class: "ic-links-item-top" },
            el("span", { class: o.exists ? "" : "muted" }, `${o.isEmbed ? "📌 " : "🔗 "}${o.alias || o.target}`),
            el("span", { class: "badge" + (o.exists ? " ic-obs-badge-ok" : "") }, o.exists ? "打开 ↗" : "＋ 新建")
          ),
          o.resolvedPath ? el("div", { class: "mono muted", style: { fontSize: "11px" } }, o.resolvedPath) : null
        ));
      });
      outSec.appendChild(list);
    }
    scroll.appendChild(outSec);

    // 4. Unlinked Mentions
    const umSec = el("details", { class: "ic-links-sec", open: data.unlinkedMentions.length > 0 });
    umSec.appendChild(el("summary", { class: "ic-links-sec-head" },
      el("strong", null, `未链接提及 (${data.unlinkedMentions.length})`),
      el("span", { class: "muted", style: { fontSize: "11px" } }, "可一键转为双链")
    ));
    if (!data.unlinkedMentions.length) {
      umSec.appendChild(el("div", { class: "ic-links-empty muted" }, "未发现其他文章中的未链接提及。"));
    } else {
      const list = el("div", { class: "ic-links-list" });
      data.unlinkedMentions.forEach((u) => {
        const row = el("div", { class: "ic-links-mention-row" },
          el("div", { class: "ic-links-item-top" },
            el("button", {
              type: "button",
              class: "ic-links-source-btn",
              onClick: () => opts.openNote?.(u.sourcePath),
            }, u.sourceName),
            el("button", {
              type: "button",
              class: "btn btn-sm",
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
          el("div", { class: "ic-links-snippet muted" }, u.snippet)
        );
        list.appendChild(row);
      });
      umSec.appendChild(list);
    }
    scroll.appendChild(umSec);

    panelEl.appendChild(scroll);

    // Mount mini graph once element is laid out
    requestAnimationFrame(() => {
      if (!miniCanvasWrap.isConnected) return;
      miniGraphHandle = mountForceGraph(miniCanvasWrap, data.graph, {
        mode: activePath ? "local" : "global",
        activePath,
        hops: 1,
        showUnresolved: true,
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
    if (miniGraphHandle) { miniGraphHandle.destroy(); miniGraphHandle = null; }
  }

  return {
    data,
    panelEl,
    refresh,
    renderPanel,
    attachTextarea,
    renderPreviewBlock,
    openGraphModal,
    navigateToLink,
    dispose,
  };
}
