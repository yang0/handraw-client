import { api, clear, closeModal, el, localImg, money, onEvent, showModal, toast } from "../api.js";
import { buildGroupedModelSelect } from "./create.js";

export async function renderCanvas(root, ctx, params = {}) {
  clear(root);

  const [docsRes, tplRes, modRes, recRes] = await Promise.all([
    api("GET", "/api/docs/canvas").catch(() => ({ items: [] })),
    api("GET", "/api/docs/template").catch(() => ({ items: [], builtin: [] })),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [] })),
    api("GET", "/api/mine/recipes").catch(() => ({ items: [] })),
  ]);

  let docs = docsRes.items || [];
  const builtins = tplRes.builtin || [];
  const userTpls = tplRes.items || [];
  const recipes = recRes.items || [];

  const state = {
    docId: params.docId || docs[0]?.id || "",
    name: docs[0]?.name || "自由组合画布",
    modelRef: modRes.defaultModel || "site:seedream-4.5",
    panX: 0,
    panY: 0,
    scale: 1,
    selectedId: "",
    connectFrom: "",
    nodes: [
      { id: "n1", type: "themes", x: 60, y: 80, data: { label: "主题列表", items: ["雨夜街角亮着暖灯的小书店", "周末草地上打盹的橘猫"] } },
      { id: "n2", type: "styles", x: 60, y: 310, data: { label: "画风组合", items: ["FA-013", "FB-001"] } },
      { id: "n3", type: "generate", x: 400, y: 180, data: { label: "交叉生成", runId: "", images: [] } },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n3" },
      { id: "e2", from: "n2", to: "n3" },
    ],
  };

  if (state.docId) {
    try {
      const got = await api("GET", `/api/docs/canvas/${encodeURIComponent(state.docId)}`);
      if (got.doc) loadDocObj(got.doc);
    } catch {}
  }

  function loadDocObj(doc) {
    state.docId = doc.id || "";
    state.name = doc.name || "未命名画布";
    const d = typeof doc.data === "string" ? JSON.parse(doc.data) : (doc.data || {});
    if (Array.isArray(d.nodes)) state.nodes = d.nodes;
    if (Array.isArray(d.edges)) state.edges = d.edges;
    if (typeof d.panX === "number") state.panX = d.panX;
    if (typeof d.panY === "number") state.panY = d.panY;
    if (typeof d.scale === "number") state.scale = d.scale;
  }

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row" },
      el("h1", { class: "page-title" }, "自由画布与节点工作流"),
      el("span", { class: "muted" }, "自由拖拽节点、连接组合（M 主题 × N 画风自动展开），点击连线可断开")
    ),
    el("div", { class: "row" },
      el("button", { type: "button", class: "btn btn-sm", onClick: openTemplatesModal }, "📐 模板库"),
      el("button", { type: "button", class: "btn btn-sm", onClick: openAssistantModal }, "✨ AI 助手搭建"),
      el("button", { type: "button", class: "btn btn-sm", onClick: saveCanvas }, "💾 保存"),
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: syncCanvas }, "☁ 同步到网站")
    )
  ));

  const docSel = el("select", { class: "select select-sm", style: { maxWidth: "180px" } });
  const refreshDocSel = () => {
    clear(docSel);
    docSel.appendChild(el("option", { value: "" }, "— 新建未保存画布 —"));
    docs.forEach((d) => docSel.appendChild(el("option", { value: d.id }, d.name || d.id)));
    docSel.value = state.docId || "";
  };
  refreshDocSel();
  docSel.addEventListener("change", async () => {
    if (!docSel.value) {
      state.docId = "";
      state.name = "新画布";
      state.nodes = [];
      state.edges = [];
      nameIn.value = state.name;
      renderWorld();
      return;
    }
    try {
      const r = await api("GET", `/api/docs/canvas/${encodeURIComponent(docSel.value)}`);
      if (r.doc) {
        loadDocObj(r.doc);
        nameIn.value = state.name;
        renderWorld();
      }
    } catch (e) { toast(e.message); }
  });

  const nameIn = el("input", { class: "input", style: { maxWidth: "170px", padding: "5px 8px" }, value: state.name, placeholder: "画布名称" });
  nameIn.addEventListener("input", () => { state.name = nameIn.value; });

  const modelSel = buildGroupedModelSelect(modRes, state.modelRef);
  state.modelRef = modelSel.value;
  modelSel.addEventListener("change", () => { state.modelRef = modelSel.value; renderWorld(); });

  const zoomLabel = el("span", { class: "muted mono" }, "100%");
  const toolbar = el("div", { class: "card row", style: { marginBottom: "10px", padding: "8px 12px", justifyContent: "space-between" } },
    el("div", { class: "row" },
      docSel,
      nameIn,
      el("button", { type: "button", class: "btn btn-sm", onClick: () => addNode("themes") }, "+ 主题组"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => addNode("styles") }, "+ 画风组"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => addNode("recipe") }, "+ 配方"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => addNode("generate") }, "+ 生成器"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => addNode("export") }, "+ 导出"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => addNode("frame") }, "+ 画框便签")
    ),
    el("div", { class: "row" },
      modelSel,
      el("button", { type: "button", class: "btn btn-sm", onClick: () => { state.panX = 0; state.panY = 0; state.scale = 1; applyTransform(); } }, "重置视角"),
      zoomLabel
    )
  );
  root.appendChild(toolbar);

  const board = el("div", { class: "canvas-board" });
  const world = el("div", { class: "canvas-world" });
  const svgNS = "http://www.w3.org/2000/svg";
  const edgeSvg = document.createElementNS(svgNS, "svg");
  edgeSvg.setAttribute("width", "4000");
  edgeSvg.setAttribute("height", "4000");
  edgeSvg.style.position = "absolute";
  edgeSvg.style.left = "0";
  edgeSvg.style.top = "0";
  edgeSvg.style.overflow = "visible";
  edgeSvg.style.pointerEvents = "auto";
  world.appendChild(edgeSvg);

  const nodesLayer = el("div");
  world.appendChild(nodesLayer);
  board.appendChild(world);
  root.appendChild(board);

  function applyTransform() {
    world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  }

  // Board pan & zoom
  let panning = null;
  board.addEventListener("pointerdown", (e) => {
    if (e.target !== board && e.target !== world && e.target !== edgeSvg) return;
    state.selectedId = "";
    state.connectFrom = "";
    panning = { sx: e.clientX, sy: e.clientY, px: state.panX, py: state.panY };
    board.setPointerCapture(e.pointerId);
  });
  board.addEventListener("pointermove", (e) => {
    if (!panning) return;
    state.panX = panning.px + (e.clientX - panning.sx);
    state.panY = panning.py + (e.clientY - panning.sy);
    applyTransform();
  });
  board.addEventListener("pointerup", () => { panning = null; });
  board.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    state.scale = Math.max(0.4, Math.min(2.0, state.scale * factor));
    applyTransform();
  }, { passive: false });

  function addNode(type) {
    const id = "n_" + Math.random().toString(36).slice(2, 7);
    const x = Math.round((120 - state.panX) / state.scale + state.nodes.length * 24);
    const y = Math.round((100 - state.panY) / state.scale + state.nodes.length * 20);
    const defaults = {
      themes: { label: "主题列表", items: ["雨夜里的小书店"] },
      styles: { label: "画风组", items: ["FA-013"] },
      recipe: { label: "固定配方", recipeId: recipes[0]?.id || "", style: "FA-013", layout: "", ratio: "3:4" },
      generate: { label: "生图执行器", runId: "", images: [] },
      export: { label: "批量导出", format: "xiaohongshu" },
      frame: { label: "灵感分组", notes: "在这里记录构图或系列思路…" },
    };
    state.nodes.push({ id, type, x, y, data: defaults[type] || { label: type } });
    state.selectedId = id;
    renderWorld();
  }

  function upstreamNodes(nodeId) {
    const ids = state.edges.filter((e) => e.to === nodeId).map((e) => e.from);
    return ids.map((id) => state.nodes.find((n) => n.id === id)).filter(Boolean);
  }

  function expandGenerateItems(genNode) {
    const ups = upstreamNodes(genNode.id);
    const themeNode = ups.find((n) => n.type === "themes");
    const stylesNode = ups.find((n) => n.type === "styles");
    const recipeNode = ups.find((n) => n.type === "recipe");

    const themes = (themeNode?.data?.items || []).map((x) => x.trim()).filter(Boolean);
    const baseRecipe = recipeNode?.data?.recipeId ? recipes.find((r) => r.id === recipeNode.data.recipeId) : null;
    const styleList = (stylesNode?.data?.items || []).map((x) => x.trim()).filter(Boolean);

    const effThemes = themes.length ? themes : ["手绘风场景灵感展示"];
    const effStyles = styleList.length ? styleList : [baseRecipe?.styleIds?.[0] || recipeNode?.data?.style || "FA-013"];

    const items = [];
    for (const th of effThemes) {
      for (const st of effStyles) {
        items.push({
          theme: th,
          style: st,
          style2: baseRecipe?.styleIds?.[1] || "",
          layout: baseRecipe?.layoutId || recipeNode?.data?.layout || "",
          color: baseRecipe?.colors?.[0] || "",
          tone: baseRecipe?.tones?.[0] || "",
          ratio: baseRecipe?.ratio || recipeNode?.data?.ratio || "3:4",
          mode: baseRecipe?.mode || "graphic-text",
        });
      }
    }
    return items;
  }

  function drawEdges() {
    while (edgeSvg.firstChild) edgeSvg.removeChild(edgeSvg.firstChild);
    for (const edge of state.edges) {
      const from = state.nodes.find((n) => n.id === edge.from);
      const to = state.nodes.find((n) => n.id === edge.to);
      if (!from || !to) continue;
      const x1 = from.x + 240;
      const y1 = from.y + 42;
      const x2 = to.x;
      const y2 = to.y + 42;
      const mx = (x1 + x2) / 2;
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "var(--accent)");
      path.setAttribute("stroke-width", "2.2");
      path.style.cursor = "pointer";
      path.title = "点击断开连线";
      path.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.edges = state.edges.filter((x) => x.id !== edge.id);
        renderWorld();
      });
      edgeSvg.appendChild(path);
    }
  }

  function renderWorld() {
    applyTransform();
    clear(nodesLayer);
    drawEdges();

    state.nodes.forEach((node) => {
      const data = node.data || (node.data = {});
      const isFrame = node.type === "frame";
      const box = el("div", {
        class: "canvas-node" + (state.selectedId === node.id ? " selected" : ""),
        style: {
          left: `${node.x}px`,
          top: `${node.y}px`,
          width: isFrame ? "320px" : "240px",
          background: isFrame ? "var(--accent-soft)" : "var(--surface)",
          zIndex: isFrame ? "1" : "2",
        },
      });

      const header = el("div", {
        class: "row",
        style: { justifyContent: "space-between", marginBottom: "8px", cursor: "grab", paddingBottom: "4px", borderBottom: "1px solid var(--line)" },
      },
        el("strong", { style: { fontSize: "12.5px" } }, data.label || node.type),
        el("div", { class: "row", style: { gap: "4px" } },
          el("button", {
            type: "button",
            class: "btn btn-sm" + (state.connectFrom === node.id ? " btn-primary" : ""),
            style: { padding: "2px 6px", fontSize: "11px" },
            title: state.connectFrom ? "连接到此节点 / 取消连线" : "从此处连线出去",
            onClick: (e) => {
              e.stopPropagation();
              if (!state.connectFrom) {
                state.connectFrom = node.id;
                renderWorld();
              } else if (state.connectFrom === node.id) {
                state.connectFrom = "";
                renderWorld();
              } else {
                const exists = state.edges.some((x) => x.from === state.connectFrom && x.to === node.id);
                if (!exists) {
                  state.edges.push({ id: "e_" + Math.random().toString(36).slice(2, 7), from: state.connectFrom, to: node.id });
                }
                state.connectFrom = "";
                renderWorld();
              }
            },
          }, state.connectFrom ? (state.connectFrom === node.id ? "取消" : "← 连入") : "连出 →"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-danger",
            style: { padding: "2px 6px", fontSize: "11px" },
            onClick: (e) => {
              e.stopPropagation();
              state.nodes = state.nodes.filter((n) => n.id !== node.id);
              state.edges = state.edges.filter((ed) => ed.from !== node.id && ed.to !== node.id);
              renderWorld();
            },
          }, "×")
        )
      );

      header.addEventListener("pointerdown", (e) => {
        if (e.target.tagName === "BUTTON") return;
        e.stopPropagation();
        state.selectedId = node.id;
        const startX = e.clientX;
        const startY = e.clientY;
        const origX = node.x;
        const origY = node.y;
        const onMove = (me) => {
          node.x = Math.round(origX + (me.clientX - startX) / state.scale);
          node.y = Math.round(origY + (me.clientY - startY) / state.scale);
          box.style.left = `${node.x}px`;
          box.style.top = `${node.y}px`;
          drawEdges();
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });

      const body = el("div", { class: "col", style: { gap: "6px", cursor: "default" } });
      if (node.type === "themes") {
        const ta = el("textarea", {
          class: "textarea",
          rows: "4",
          style: { fontSize: "12px", minHeight: "70px" },
          placeholder: "每行一个主题…",
        });
        ta.value = (data.items || []).join("\n");
        ta.addEventListener("input", () => {
          data.items = ta.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          updateGenerateBadges();
        });
        body.appendChild(ta);
      } else if (node.type === "styles") {
        const ta = el("input", {
          class: "input",
          style: { fontSize: "12px" },
          value: (data.items || []).join(", "),
          placeholder: "逗号分隔画风编号，如 FA-013, FB-001",
        });
        ta.addEventListener("input", () => {
          data.items = ta.value.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
          updateGenerateBadges();
        });
        body.appendChild(ta);
      } else if (node.type === "recipe") {
        const rSel = el("select", { class: "select select-sm" },
          el("option", { value: "" }, "— 自定义参数 —"),
          ...recipes.map((r) => el("option", { value: r.id, selected: data.recipeId === r.id }, r.name))
        );
        rSel.addEventListener("change", () => { data.recipeId = rSel.value; updateGenerateBadges(); });
        const stIn = el("input", { class: "input", style: { fontSize: "12px" }, value: data.style || "", placeholder: "画风编号，如 FA-013" });
        stIn.addEventListener("input", () => { data.style = stIn.value.trim(); });
        body.appendChild(rSel);
        body.appendChild(stIn);
      } else if (node.type === "generate") {
        const expanded = expandGenerateItems(node);
        const countEl = el("div", { class: "badge badge-accent", dataset: { genCountFor: node.id } }, `当前上游组合：${expanded.length} 张`);
        const runBtn = el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => runCanvasNode(node, false),
        }, "▶ 执行交叉生图");
        body.appendChild(countEl);
        body.appendChild(runBtn);
        if (Array.isArray(data.images) && data.images.length) {
          const thumbs = el("div", { class: "row", style: { gap: "4px", marginTop: "4px" } });
          data.images.slice(0, 6).forEach((im) => {
            if (im.path || im.thumb) {
              thumbs.appendChild(el("img", { src: localImg(im.thumb || im.path), alt: "", style: { width: "44px", height: "44px", objectFit: "cover", borderRadius: "5px" } }));
            } else {
              thumbs.appendChild(el("span", { class: "badge" }, im.status === "running" ? "绘制中" : "排队"));
            }
          });
          body.appendChild(thumbs);
        }
      } else if (node.type === "export") {
        const fmtSel = el("select", { class: "select select-sm" },
          el("option", { value: "xiaohongshu", selected: data.format === "xiaohongshu" }, "小红书 3:4 套图"),
          el("option", { value: "zip", selected: data.format === "zip" }, "原图打包 ZIP")
        );
        fmtSel.addEventListener("change", () => { data.format = fmtSel.value; });
        const expBtn = el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => {
            const up = upstreamNodes(node.id).find((n) => n.type === "generate" && n.data?.runId);
            if (!up) return toast("请先把此导出节点连接到已生图的「生成器」节点");
            try {
              const res = await api("POST", `/api/works/${encodeURIComponent(up.data.runId)}/export`, { format: data.format || "zip" });
              toast("已导出：" + res.path);
            } catch (e) { toast(e.message); }
          },
        }, "📦 导出结果");
        body.appendChild(fmtSel);
        body.appendChild(expBtn);
      } else if (node.type === "frame") {
        const ta = el("textarea", { class: "textarea", rows: "3", style: { fontSize: "12px", minHeight: "60px" } });
        ta.value = data.notes || "";
        ta.addEventListener("input", () => { data.notes = ta.value; });
        body.appendChild(ta);
      }

      box.appendChild(header);
      box.appendChild(body);
      nodesLayer.appendChild(box);
    });
  }

  function updateGenerateBadges() {
    state.nodes.filter((n) => n.type === "generate").forEach((n) => {
      const badge = nodesLayer.querySelector(`[data-gen-count-for="${n.id}"]`);
      if (badge) badge.textContent = `当前上游组合：${expandGenerateItems(n).length} 张`;
    });
  }

  async function runCanvasNode(node, confirmed) {
    const items = expandGenerateItems(node);
    if (!items.length) {
      toast("上游节点没有可用主题或画风");
      return;
    }
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
        showModal("画布组合费用确认", el("p", null, `本次将交叉生成 ${res.count} 张图片，预计消耗网站额度 ${money(res.totalCents)}。确认执行？`), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); runCanvasNode(node, true); } }, "确认生成"),
        ]);
        return;
      }
      node.data.runId = res.run.id;
      node.data.images = res.images || [];
      renderWorld();
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
            nameIn.value = tpl.name;
            state.nodes = structuredClone(data.nodes || []);
            state.edges = structuredClone(data.edges || []);
            closeModal();
            renderWorld();
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
      placeholder: "描述你想生成的组合流程，例如：把清晨咖啡的 4 个步骤做成 2 种不同画风的横评对比矩阵…",
    });
    showModal("✨ 画布工作流助手", el("div", { class: "col" }, promptIn), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          try {
            const res = await api("POST", "/api/canvas/assistant", { prompt: promptIn.value.trim() });
            const nodes = res.nodes || res.raw?.nodes;
            const edges = res.edges || res.raw?.edges;
            if (!Array.isArray(nodes) || !nodes.length) {
              toast("助手未能解析出节点图");
              return;
            }
            state.nodes = nodes;
            state.edges = Array.isArray(edges) ? edges : [];
            closeModal();
            renderWorld();
            toast("已生成画布节点流程");
          } catch (e) { toast(e.message); }
        },
      }, "自动搭建"),
    ]);
  }

  async function saveCanvas() {
    try {
      const res = await api("PUT", `/api/docs/canvas/${encodeURIComponent(state.docId || "new")}`, {
        name: state.name || "未命名画布",
        data: { nodes: state.nodes, edges: state.edges, panX: state.panX, panY: state.panY, scale: state.scale },
      });
      state.docId = res.doc.id;
      const dRes = await api("GET", "/api/docs/canvas").catch(() => ({ items: [] }));
      docs = dRes.items || [];
      refreshDocSel();
      toast("画布已保存到本地");
    } catch (e) { toast(e.message); }
  }

  async function syncCanvas() {
    await saveCanvas();
    try {
      const res = await api("POST", "/api/canvas/sync", { id: state.docId });
      if (res.conflicts?.length) {
        toast("检测到云端版本冲突，请在稍后对比合并");
      } else if (res.ok) {
        toast(`已同步画布（上传 ${res.pushed || 0} 份）`);
      } else {
        toast(res.error || "同步未完成");
      }
    } catch (e) { toast(e.message); }
  }

  const unsub = onEvent(async (msg) => {
    if (!root.isConnected) {
      unsub();
      return;
    }
    const rid = msg.data?.runId || msg.data?.id;
    const hit = state.nodes.find((n) => n.type === "generate" && n.data?.runId === rid);
    if ((msg.type === "job" || msg.type === "run") && hit) {
      try {
        const detail = await api("GET", `/api/works/${encodeURIComponent(rid)}`);
        hit.data.images = detail.run.images || [];
        renderWorld();
      } catch {}
    }
  });

  renderWorld();
}
