import { api, clear, closeModal, el, localImg, money, showModal, toast } from "../api.js";

function posLabel(x, y) {
  const h = x < 0.33 ? "左侧" : (x > 0.67 ? "右侧" : "中部");
  const v = y < 0.33 ? "上方" : (y > 0.67 ? "下方" : "中部");
  if (h === "中部" && v === "中部") return "画面中央";
  if (h === "中部") return "画面中" + v;
  if (v === "中部") return "画面" + h + "中部";
  return "画面" + h.replace("侧", "") + v;
}

function inferAspectRatio(img, recipe) {
  if (recipe) {
    try {
      const r = typeof recipe === "string" ? JSON.parse(recipe) : recipe;
      if (r?.ratio) return String(r.ratio);
    } catch {}
  }
  const w = Number(img?.width || 0);
  const h = Number(img?.height || 0);
  if (w > 0 && h > 0) {
    const ratio = w / h;
    const candidates = [
      ["1:1", 1],
      ["3:4", 3 / 4],
      ["4:3", 4 / 3],
      ["2:3", 2 / 3],
      ["3:2", 3 / 2],
      ["9:16", 9 / 16],
      ["16:9", 16 / 9],
    ];
    let best = "3:4";
    let bestDiff = Infinity;
    for (const [label, val] of candidates) {
      const d = Math.abs(ratio - val);
      if (d < bestDiff) {
        bestDiff = d;
        best = label;
      }
    }
    return best;
  }
  return "3:4";
}

// Draws a copy of the original image with crisp numbered vermilion circles so
// image-editing models can visually locate each annotation pin (#67).
function renderAnnotatedGuideDataURL(imgEl, annotations) {
  if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight || !annotations.length) return "";
  try {
    const natW = imgEl.naturalWidth;
    const natH = imgEl.naturalHeight;
    const maxEdge = 1440;
    const scale = Math.min(1, maxEdge / Math.max(natW, natH));
    const w = Math.max(1, Math.round(natW * scale));
    const h = Math.max(1, Math.round(natH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d");
    if (!c) return "";
    c.drawImage(imgEl, 0, 0, w, h);

    const minDim = Math.min(w, h);
    const radius = Math.max(18, Math.round(minDim * 0.032));
    const lineW = Math.max(3, Math.round(radius * 0.16));
    const fontSize = Math.max(16, Math.round(radius * 1.15));

    annotations.forEach((a, idx) => {
      const px = Math.max(radius + 4, Math.min(w - radius - 4, a.x * w));
      const py = Math.max(radius + 4, Math.min(h - radius - 4, a.y * h));

      // Outer white halo for contrast on dark or bright areas
      c.beginPath();
      c.arc(px, py, radius + lineW * 0.7, 0, Math.PI * 2);
      c.fillStyle = "#FFFFFF";
      c.fill();

      // Solid vermilion marker disc
      c.beginPath();
      c.arc(px, py, radius, 0, Math.PI * 2);
      c.fillStyle = "#D94126";
      c.fill();

      // Crisp centered number
      c.fillStyle = "#FFFFFF";
      c.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(idx + 1), px, py + 1);
    });
    return canvas.toDataURL("image/jpeg", 0.88);
  } catch {
    return "";
  }
}

export async function renderAnnotate(root, ctx, params = {}) {
  clear(root);
  let runId = params.runId || "";
  if (!runId) {
    const recent = await api("GET", "/api/works?limit=12").catch(() => ({ items: [] }));
    const list = recent.items || [];
    root.appendChild(el("div", { class: "page-head" }, el("h1", { class: "page-title" }, "批注改图")));
    if (list.length === 0) {
      root.appendChild(el("div", { class: "card muted" }, "暂无本地图片可批注。请先在生图或会话页生成一张图片，再点击「批注改图」。"));
      return;
    }
    const grid = el("div", { class: "grid-cards" });
    list.forEach((run) => {
      const im = (run.images || []).find((i) => i.path);
      if (!im?.path) return;
      grid.appendChild(el("div", { class: "style-card", onClick: () => renderAnnotate(root, ctx, { runId: run.id }) },
        el("img", { class: "style-thumb", src: localImg(im.thumb || im.path), alt: run.title }),
        el("div", { class: "style-body" }, el("div", { class: "style-name" }, run.title))
      ));
    });
    root.appendChild(grid);
    return;
  }

  const data = await api("GET", `/api/works/${encodeURIComponent(runId)}`);
  const run = data.run;
  const versions = data.versions || [run];
  const completedImgs = (run.images || []).filter((i) => i.path);
  if (completedImgs.length === 0) {
    root.appendChild(el("div", { class: "card muted" }, "该任务尚无已完成的图片"));
    return;
  }
  const img = completedImgs.find((i) => i.id === params.imageId) || completedImgs[0];

  const annotations = [];
  let draftPin = null;
  const pinsLayer = el("div");
  const listBox = el("div", { class: "col", style: { gap: "8px" } });
  const modRes = await api("GET", "/api/models").catch(() => ({ providers: [], site: [], defaultModel: "" }));
  const modelSel = el("select", { class: "select" });
  const siteList = Array.isArray(modRes.site)
    ? modRes.site
    : (modRes.site?.specifications || modRes.site?.models || modRes.site?.items || []);
  const seenSite = new Set();
  siteList.forEach((s) => {
    const id = s?.model || s?.id;
    if (id && !seenSite.has(id)) {
      seenSite.add(id);
      modelSel.appendChild(el("option", { value: "site:" + id, selected: modRes.defaultModel === "site:" + id }, `网站 · ${s.label || s.name || id}`));
    }
  });
  (modRes.providers || []).forEach((p) => (p.models || []).forEach((m) => {
    const ref = `${p.id}:${m.id}`;
    modelSel.appendChild(el("option", { value: ref, selected: modRes.defaultModel === ref }, `${p.name} · ${m.label || m.id}${m.canEdit ? " (支持局部重绘)" : " (整图指令编辑)"}`));
  }));

  const drawPins = () => {
    clear(pinsLayer);
    clear(listBox);
    annotations.forEach((a, idx) => {
      pinsLayer.appendChild(el("div", {
        class: "annotate-pin",
        title: `#${idx + 1} ${a.text}`,
        style: { left: (a.x * 100) + "%", top: (a.y * 100) + "%" },
      }, String(idx + 1)));
      const loc = `${posLabel(a.x, a.y)} (${Math.round(a.x * 100)}%, ${Math.round(a.y * 100)}%)`;
      listBox.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", alignItems: "flex-start", padding: "8px 10px", gap: "8px" } },
        el("div", { class: "col", style: { gap: "2px", flex: "1", minWidth: 0 } },
          el("div", null, el("strong", null, `#${idx + 1} `), el("span", null, a.text)),
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, loc)
        ),
        el("div", { class: "row", style: { gap: "4px", flexShrink: 0 } },
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => openNoteModal(a.x, a.y, idx),
          }, "编辑"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-danger",
            onClick: () => { annotations.splice(idx, 1); drawPins(); },
          }, "删除")
        )
      ));
    });
    if (draftPin) {
      pinsLayer.appendChild(el("div", {
        class: "annotate-pin",
        style: { left: (draftPin.x * 100) + "%", top: (draftPin.y * 100) + "%", opacity: "0.7" },
      }, "+"));
    }
    if (annotations.length === 0) {
      listBox.appendChild(el("div", { class: "muted" }, "点击左侧图片上的任意位置添加批注，例如「这里改成金色」「这里加一只小黑猫」「背景换成黄昏暖光」"));
    }
  };

  function openNoteModal(x, y, editIdx = -1) {
    const isEdit = editIdx >= 0;
    const curText = isEdit ? annotations[editIdx].text : "";
    if (!isEdit) {
      draftPin = { x, y };
      drawPins();
    }
    const loc = `${posLabel(x, y)}（约 x=${Math.round(x * 100)}%, y=${Math.round(y * 100)}%）`;
    const noteIn = el("input", {
      class: "input",
      type: "text",
      placeholder: "输入此处修改要求，例如：把这里的极光改成金色、这里添一只小猫…",
      value: curText,
      "aria-label": "批注修改内容",
    });
    const commit = () => {
      const val = noteIn.value.trim();
      if (!val) {
        noteIn.focus();
        return;
      }
      if (isEdit) {
        annotations[editIdx].text = val;
      } else {
        annotations.push({ x, y, text: val });
      }
      draftPin = null;
      closeModal();
      drawPins();
    };
    const cancel = () => {
      draftPin = null;
      closeModal();
      drawPins();
    };
    noteIn.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      }
    });
    showModal(
      isEdit ? `编辑批注 #${editIdx + 1}` : `添加批注 #${annotations.length + 1}`,
      el("div", { class: "col", style: { gap: "8px" } },
        el("span", { class: "muted", style: { fontSize: "12.5px" } }, `标注位置：${loc}`),
        noteIn
      ),
      [
        el("button", { type: "button", class: "btn", onClick: cancel }, "取消"),
        el("button", { type: "button", class: "btn btn-primary", onClick: commit }, isEdit ? "保存修改" : "添加批注"),
      ]
    );
    setTimeout(() => { noteIn.focus(); noteIn.select(); }, 20);
  }

  const mainImg = el("img", {
    src: localImg(img.path),
    alt: run.title || "待批注图片",
    style: { maxWidth: "100%", maxHeight: "66vh", borderRadius: "10px", display: "block", cursor: "crosshair" },
    onClick: (e) => {
      const r = mainImg.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      openNoteModal(x, y);
    },
  });

  const timeline = el("div", { class: "row", style: { marginBottom: "12px", flexWrap: "wrap", gap: "6px" } }, el("span", { class: "muted" }, "版本时间线："));
  versions.forEach((v, idx) => {
    timeline.appendChild(el("button", {
      type: "button",
      class: "pill-btn" + (v.id === run.id ? " pill-accent" : ""),
      onClick: () => renderAnnotate(root, ctx, { runId: v.id }),
    }, `v${idx + 1} · ${v.title?.slice(0, 12) || v.id.slice(-6)}`));
  });

  let imgSwitcher = null;
  if (completedImgs.length > 1) {
    imgSwitcher = el("div", { class: "row", style: { marginBottom: "12px", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
      el("span", { class: "muted" }, "选择要批注的图片："),
      ...completedImgs.map((ci, idx) => el("button", {
        type: "button",
        class: "pill-btn" + (ci.id === img.id ? " pill-accent" : ""),
        onClick: () => renderAnnotate(root, ctx, { runId: run.id, imageId: ci.id }),
      }, `图 ${idx + 1}`))
    );
  }

  let submitting = false;
  const submitEdit = async (payload) => {
    const res = await api("POST", "/api/generate", payload);
    if (res.needConfirm) {
      return new Promise((resolve) => {
        showModal("确认生成费用", el("p", { style: { margin: 0 } }, `预计花费 ${money(res.totalCents)}，确认基于原图生成批注修订版？`), [
          el("button", { type: "button", class: "btn", onClick: () => { closeModal(); resolve(null); } }, "取消"),
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: async () => {
              closeModal();
              try {
                const res2 = await api("POST", "/api/generate", { ...payload, confirmed: true });
                resolve(res2);
              } catch (err) {
                toast(err?.message || "提交失败");
                resolve(null);
              }
            },
          }, "确认执行"),
        ]);
      });
    }
    return res;
  };

  const execBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    onClick: async () => {
      if (submitting) return;
      if (annotations.length === 0) return toast("请至少添加 1 条批注");
      const mRef = modelSel.value || modRes.defaultModel;
      if (!mRef) return toast("请先配置或选择生图模型");

      submitting = true;
      execBtn.disabled = true;
      execBtn.textContent = "正在提交批注改图…";
      try {
        const annotatedGuideDataUrl = renderAnnotatedGuideDataURL(mainImg, annotations);
        const ratio = inferAspectRatio(img, run.recipe);
        const payload = {
          mode: "edit",
          title: (run.title || "批注改图") + " (修订)",
          parentId: run.id,
          modelRef: mRef,
          refs: [img.path],
          annotatedGuideDataUrl,
          annotations,
          input: {
            theme: img.theme || run.originalRequest || run.title,
            ratio,
            mode: "edit",
          },
        };
        const res = await submitEdit(payload);
        if (res?.run?.id) {
          toast("已提交批注修订版本，原图完整保留");
          ctx.go("works", { openRun: res.run.id });
        }
      } catch (e) {
        toast(e?.message || "提交批注改图失败");
      } finally {
        submitting = false;
        execBtn.disabled = false;
        execBtn.textContent = "全部执行，生成新版本";
      }
    },
  }, "全部执行，生成新版本");

  drawPins();
  root.appendChild(el("div", { class: "page-head" },
    el("h1", { class: "page-title" }, "批注改图"),
    el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works", { openRun: run.id }) }, "← 返回作品详情")
  ));
  root.appendChild(timeline);
  if (imgSwitcher) root.appendChild(imgSwitcher);
  root.appendChild(el("div", { class: "split" },
    el("div", { class: "card", style: { textAlign: "center" } },
      el("div", { class: "annotate-wrap" }, mainImg, pinsLayer),
      el("p", { class: "muted", style: { fontSize: "12px", marginTop: "8px", marginBottom: 0 } }, "点击图片任意位置添加编号批注，提交时会自动附带原图与位置指引图发给编辑模型")
    ),
    el("div", { class: "card col" },
      el("div", { class: "field" }, el("label", null, "改图模型（自动上传原图 + 位置指引图进行精准编辑）"), modelSel),
      listBox,
      el("div", { style: { marginTop: "auto", paddingTop: "12px" } }, execBtn)
    )
  ));
}
