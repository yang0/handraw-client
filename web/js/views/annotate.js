import { api, clear, closeModal, el, localImg, money, onEvent, showModal, toast } from "../api.js";

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

      c.beginPath();
      c.arc(px, py, radius + lineW * 0.7, 0, Math.PI * 2);
      c.fillStyle = "#FFFFFF";
      c.fill();

      c.beginPath();
      c.arc(px, py, radius, 0, Math.PI * 2);
      c.fillStyle = "#D94126";
      c.fill();

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

function openImageLightbox(path, title) {
  showModal(
    title || "大图预览",
    el("div", { class: "col", style: { alignItems: "center" } },
      el("img", {
        src: localImg(path),
        alt: title || "",
        style: { maxWidth: "100%", maxHeight: "74vh", borderRadius: "10px", objectFit: "contain" },
      })
    ),
    [el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭")]
  );
}

export async function renderAnnotate(root, ctx, params = {}) {
  clear(root);
  const runId = params.runId || "";

  // 1. Picker Landing State when no runId is selected
  if (!runId) {
    const recent = await api("GET", "/api/works?limit=18").catch(() => ({ items: [] }));
    const list = (recent.items || []).filter((r) => (r.images || []).some((i) => i.path));
    root.appendChild(el("div", { class: "page-head" },
      el("div", { class: "col", style: { gap: "3px" } },
        el("h1", { class: "page-title" }, "批注改图"),
        el("p", { class: "muted", style: { margin: 0, fontSize: "13px" } }, "选择一张已有作品，点击画面任意位置打点批注，原地生成并对比前后效果。")
      )
    ));
    if (list.length === 0) {
      root.appendChild(el("div", { class: "card muted", style: { padding: "28px", textAlign: "center" } },
        "暂无本地图片可批注。请先在「生图」或「会话」中生成一张图片，再来这里进行精准批注改图。"
      ));
      return;
    }
    const grid = el("div", { class: "grid-cards" });
    list.forEach((r) => {
      const im = (r.images || []).find((i) => i.path);
      const count = (r.images || []).filter((i) => i.path).length;
      grid.appendChild(el("div", {
        class: "style-card",
        style: { cursor: "pointer" },
        onClick: () => renderAnnotate(root, ctx, { runId: r.id }),
      },
        el("img", { class: "style-thumb", src: localImg(im.thumb || im.path), alt: r.title }),
        el("div", { class: "style-body" },
          el("div", { class: "style-name" }, r.title || "未命名作品"),
          el("div", { class: "muted", style: { fontSize: "11.5px" } }, `${r.modelLabel || r.model || ""} · ${count} 张`)
        )
      ));
    });
    root.appendChild(grid);
    return;
  }

  const [data, modRes] = await Promise.all([
    api("GET", `/api/works/${encodeURIComponent(runId)}`),
    api("GET", "/api/models").catch(() => ({ providers: [], site: [], defaultModel: "" })),
  ]);
  if (!root.isConnected) return;

  const run = data.run;
  let versions = Array.isArray(data.versions) && data.versions.length ? data.versions : [run];
  const completedImgs = (run.images || []).filter((i) => i.path);
  if (completedImgs.length === 0) {
    root.appendChild(el("div", { class: "card muted" }, "该任务尚无已完成的图片"));
    return;
  }
  const img = completedImgs.find((i) => i.id === params.imageId) || completedImgs[0];

  // Studio State (all in-place — never unexpectedly leaves the page!)
  const annotations = [];
  let draftPin = null; // { x, y }
  let activePinIdx = -1; // highlighted/hovered pin index
  let pinsVisible = true;
  let globalExtra = "";
  let submitting = false;
  let stageMode = "annotate"; // "annotate" | "compare"
  let compareMode = "slider"; // "slider" | "side" | "result"
  let sliderPct = 50;
  let activeRevision = null; // { runId, status: "running"|"done"|"failed", imagePath, imageId, error, startedAt }

  let popoverEl = null;
  let popoverCleanup = null;
  let pollTimer = null;
  let elapsedTimer = null;

  function closeNotePopover() {
    if (popoverCleanup) {
      popoverCleanup();
      popoverCleanup = null;
    }
    if (popoverEl) {
      popoverEl.remove();
      popoverEl = null;
    }
    if (draftPin) {
      draftPin = null;
      drawPins();
    }
  }

  function stopRevisionWatchers() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  // Model selector
  const modelSel = el("select", { class: "select", "aria-label": "改图模型" });
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
    modelSel.appendChild(el("option", { value: ref, selected: modRes.defaultModel === ref }, `${p.name} · ${m.label || m.id}${m.canEdit ? " (局部重绘)" : " (指令编辑)"}`));
  }));

  // DOM Containers
  const timelineWrap = el("div", { class: "ann-timeline" });
  const stageBar = el("div", { class: "ann-stage-bar" });
  const stageCanvas = el("div", { class: "ann-stage-canvas" });
  const pinsLayer = el("div", { class: "ann-pins-layer" });
  const listBox = el("div", { class: "ann-list" });
  const revStatusBox = el("div", { class: "ann-rev-status hidden", role: "status" });

  const globalExtraIn = el("textarea", {
    class: "textarea ann-global-input",
    rows: "2",
    placeholder: "可选：补充整体风格、色调或光影要求（不打点也可单独改图）",
    "aria-label": "整体补充要求",
  });
  globalExtraIn.addEventListener("input", () => {
    globalExtra = globalExtraIn.value;
    syncExecButton();
  });

  // Main base image (kept alive so we can always render the numbered guide canvas)
  let suppressNextImgClick = false;
  const mainImg = el("img", {
    class: "ann-base-img",
    src: localImg(img.path),
    alt: run.title || "待批注图片",
    draggable: false,
    onClick: (e) => {
      if (suppressNextImgClick) {
        suppressNextImgClick = false;
        return;
      }
      if (activeRevision?.status === "running") return;
      const r = mainImg.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = Math.max(0.02, Math.min(0.98, (e.clientX - r.left) / r.width));
      const y = Math.max(0.02, Math.min(0.98, (e.clientY - r.top) / r.height));
      openInlinePopover(x, y, -1, e.clientX, e.clientY);
    },
  });
  const annotateWrap = el("div", { class: "annotate-wrap" }, mainImg, pinsLayer);

  function renderTimeline() {
    clear(timelineWrap);
    const visibleVersions = versions.filter((v) => v.id === run.id || v.status === "done");
    timelineWrap.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } }, "版本："));
    visibleVersions.forEach((v, idx) => {
      const isCur = v.id === run.id;
      const isNewestRev = activeRevision?.status === "done" && activeRevision?.runId === v.id;
      timelineWrap.appendChild(el("button", {
        type: "button",
        class: "pill-btn" + (isCur ? " pill-accent" : ""),
        title: v.title || v.id,
        onClick: () => {
          if (isCur) return;
          closeNotePopover();
          stopRevisionWatchers();
          renderAnnotate(root, ctx, { runId: v.id });
        },
      }, `v${idx + 1}${isNewestRev ? " · 新" : ""}`));
    });
    if (completedImgs.length > 1) {
      timelineWrap.appendChild(el("span", { class: "ann-tl-sep", "aria-hidden": "true" }));
      timelineWrap.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } }, "画面："));
      completedImgs.forEach((ci, idx) => {
        timelineWrap.appendChild(el("button", {
          type: "button",
          class: "pill-btn" + (ci.id === img.id ? " pill-accent" : ""),
          onClick: () => {
            if (ci.id === img.id) return;
            closeNotePopover();
            stopRevisionWatchers();
            renderAnnotate(root, ctx, { runId: run.id, imageId: ci.id });
          },
        }, `图 ${idx + 1}`));
      });
    }
  }

  function highlightPin(idx) {
    activePinIdx = idx;
    pinsLayer.querySelectorAll(".annotate-pin[data-pin-idx]").forEach((p) => {
      p.classList.toggle("is-highlighted", Number(p.dataset.pinIdx) === idx);
    });
    listBox.querySelectorAll(".ann-note-card[data-pin-idx]").forEach((c) => {
      c.classList.toggle("is-highlighted", Number(c.dataset.pinIdx) === idx);
    });
  }

  function openInlinePopover(x, y, editIdx = -1, anchorClientX = 0, anchorClientY = 0) {
    closeNotePopover();
    const isEdit = editIdx >= 0;
    const curText = isEdit ? annotations[editIdx].text : "";
    if (!isEdit) {
      draftPin = { x, y };
      drawPins();
    } else {
      highlightPin(editIdx);
    }

    const loc = `${posLabel(x, y)} · ${Math.round(x * 100)}%, ${Math.round(y * 100)}%`;
    const noteIn = el("input", {
      class: "input ann-pop-input",
      type: "text",
      value: curText,
      placeholder: "写下此处修改要求（如：把这里改成金色）…",
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
      closeNotePopover();
      drawPins();
      syncExecButton();
      renderStageBar();
    };

    const cancel = () => {
      closeNotePopover();
      highlightPin(-1);
    };

    noteIn.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cancel();
      }
    });

    const pop = el("div", { class: "ann-popover", role: "dialog", "aria-label": isEdit ? `编辑批注 #${editIdx + 1}` : "添加批注" },
      el("div", { class: "ann-pop-head" },
        el("span", { class: "ann-pop-badge" }, String(isEdit ? editIdx + 1 : annotations.length + 1)),
        el("span", { class: "ann-pop-loc" }, loc),
        el("button", { type: "button", class: "ann-pop-close", "aria-label": "关闭", onClick: cancel }, "×")
      ),
      noteIn,
      el("div", { class: "ann-pop-foot" },
        isEdit
          ? el("button", {
              type: "button",
              class: "btn btn-sm btn-danger",
              onClick: () => {
                annotations.splice(editIdx, 1);
                closeNotePopover();
                highlightPin(-1);
                drawPins();
                syncExecButton();
                renderStageBar();
              },
            }, "删除")
          : el("span", { class: "muted", style: { fontSize: "11px" } }, "Enter 保存 · Esc 取消"),
        el("div", { class: "row", style: { gap: "6px" } },
          el("button", { type: "button", class: "btn btn-sm", onClick: cancel }, "取消"),
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: commit }, isEdit ? "保存" : "确定")
        )
      )
    );

    pop.style.left = "0px";
    pop.style.top = "0px";
    pop.style.visibility = "hidden";
    document.body.appendChild(pop);

    const imgRect = mainImg.getBoundingClientRect();
    const px = anchorClientX || (imgRect.left + x * imgRect.width);
    const py = anchorClientY || (imgRect.top + y * imgRect.height);
    const pr = pop.getBoundingClientRect();
    const pad = 12;
    let left = px + 18;
    if (left + pr.width > window.innerWidth - pad) {
      left = Math.max(pad, px - pr.width - 18);
    }
    let top = py - 24;
    top = Math.max(pad, Math.min(window.innerHeight - pr.height - pad, top));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.visibility = "visible";
    popoverEl = pop;

    const onDocDown = (e) => {
      if (!pop.contains(e.target) && !e.target.closest(".annotate-pin")) {
        cancel();
      }
    };
    const onResize = () => cancel();
    document.addEventListener("pointerdown", onDocDown, true);
    window.addEventListener("resize", onResize);
    popoverCleanup = () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      window.removeEventListener("resize", onResize);
    };

    setTimeout(() => { noteIn.focus(); noteIn.select(); }, 15);
  }

  function makeDraggablePin(a, idx) {
    const pin = el("button", {
      type: "button",
      class: "annotate-pin" + (activePinIdx === idx ? " is-highlighted" : ""),
      title: `#${idx + 1} ${a.text}（点击编辑，拖动调整位置）`,
      dataset: { pinIdx: String(idx) },
      style: { left: `${a.x * 100}%`, top: `${a.y * 100}%` },
    }, String(idx + 1));

    pin.addEventListener("mouseenter", () => highlightPin(idx));
    pin.addEventListener("mouseleave", () => highlightPin(-1));

    pin.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || activeRevision?.status === "running") return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;

      const onMove = (me) => {
        if (!moved && Math.hypot(me.clientX - startX, me.clientY - startY) > 4) {
          moved = true;
          closeNotePopover();
          pin.classList.add("is-dragging");
        }
        if (!moved) return;
        const r = mainImg.getBoundingClientRect();
        if (!r.width || !r.height) return;
        a.x = Math.max(0.02, Math.min(0.98, (me.clientX - r.left) / r.width));
        a.y = Math.max(0.02, Math.min(0.98, (me.clientY - r.top) / r.height));
        pin.style.left = `${a.x * 100}%`;
        pin.style.top = `${a.y * 100}%`;
      };

      const onUp = (ue) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        pin.classList.remove("is-dragging");
        if (moved) {
          suppressNextImgClick = true;
          setTimeout(() => { suppressNextImgClick = false; }, 60);
          drawPins();
        } else {
          openInlinePopover(a.x, a.y, idx, ue.clientX, ue.clientY);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    return pin;
  }

  function drawPins() {
    clear(pinsLayer);
    clear(listBox);
    pinsLayer.classList.toggle("hidden", !pinsVisible);

    annotations.forEach((a, idx) => {
      pinsLayer.appendChild(makeDraggablePin(a, idx));

      const loc = `${posLabel(a.x, a.y)} (${Math.round(a.x * 100)}%, ${Math.round(a.y * 100)}%)`;
      const card = el("div", {
        class: "ann-note-card" + (activePinIdx === idx ? " is-highlighted" : ""),
        dataset: { pinIdx: String(idx) },
        onMouseEnter: () => highlightPin(idx),
        onMouseLeave: () => highlightPin(-1),
        onClick: (e) => {
          if (e.target.closest("button")) return;
          if (stageMode !== "annotate") {
            stageMode = "annotate";
            renderStage();
          }
          openInlinePopover(a.x, a.y, idx);
        },
      },
        el("span", { class: "ann-note-num" }, String(idx + 1)),
        el("div", { class: "ann-note-body" },
          el("div", { class: "ann-note-text" }, a.text),
          el("div", { class: "ann-note-loc muted" }, loc)
        ),
        el("button", {
          type: "button",
          class: "ann-note-del",
          title: `删除批注 #${idx + 1}`,
          "aria-label": `删除批注 #${idx + 1}`,
          onClick: (e) => {
            e.stopPropagation();
            annotations.splice(idx, 1);
            drawPins();
            syncExecButton();
            renderStageBar();
          },
        }, "×")
      );
      listBox.appendChild(card);
    });

    if (draftPin) {
      pinsLayer.appendChild(el("div", {
        class: "annotate-pin is-draft",
        style: { left: `${draftPin.x * 100}%`, top: `${draftPin.y * 100}%` },
      }, "+"));
    }

    if (annotations.length === 0) {
      listBox.appendChild(el("div", { class: "ann-empty-guide" },
        el("div", { class: "ann-empty-step" }, el("span", { class: "ann-step-num" }, "1"), el("span", null, "在左侧图片想修改的位置直接点击打点")),
        el("div", { class: "ann-empty-step" }, el("span", { class: "ann-step-num" }, "2"), el("span", null, "在图钉旁的气泡里输入修改要求并回车")),
        el("div", { class: "ann-empty-step" }, el("span", { class: "ann-step-num" }, "3"), el("span", null, "点「生成修订版」，原地查看前后对比"))
      ));
    }
  }

  function renderStageBar() {
    clear(stageBar);
    const isRunning = activeRevision?.status === "running";
    const hasResult = activeRevision?.status === "done" && Boolean(activeRevision.imagePath);

    if (stageMode === "compare" && hasResult) {
      stageBar.append(
        el("div", { class: "ann-seg", role: "group", "aria-label": "对比视图切换" },
          ...[
            ["slider", "滑块对比"],
            ["side", "并排对比"],
            ["result", "仅看新图"],
          ].map(([key, label]) => el("button", {
            type: "button",
            class: "ann-seg-btn" + (compareMode === key ? " is-active" : ""),
            onClick: () => {
              compareMode = key;
              renderStage();
            },
          }, label))
        ),
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => {
              stageMode = "annotate";
              renderStage();
            },
          }, "↩ 返回原图微调"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            onClick: () => {
              closeNotePopover();
              stopRevisionWatchers();
              renderAnnotate(root, ctx, { runId: activeRevision.runId, imageId: activeRevision.imageId });
            },
          }, "以此新图继续批注 →"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => api("POST", `/api/works/${encodeURIComponent(activeRevision.runId)}/reveal`).then(() => toast("已打开文件目录")).catch((e) => toast(e.message)),
          }, "打开目录"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => ctx.go("works", { openRun: activeRevision.runId }),
          }, "作品详情")
        )
      );
      return;
    }

    stageBar.append(
      el("span", { class: "muted", style: { fontSize: "12px" } },
        isRunning
          ? "正在原地生成修订版，原图与批注完整保留…"
          : "点击画面任意位置打点批注 · 拖动红点可微调位置"
      ),
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        annotations.length > 0
          ? el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => {
                pinsVisible = !pinsVisible;
                drawPins();
                renderStageBar();
              },
            }, pinsVisible ? "隐藏批注点" : "显示批注点")
          : null,
        annotations.length > 0 && !isRunning
          ? el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => {
                annotations.length = 0;
                closeNotePopover();
                drawPins();
                syncExecButton();
                renderStageBar();
              },
            }, "清空批注")
          : null,
        hasResult
          ? el("button", {
              type: "button",
              class: "btn btn-sm btn-primary",
              onClick: () => {
                stageMode = "compare";
                renderStage();
              },
            }, "查看修订对比 →")
          : null
      )
    );
  }

  function renderCompareView() {
    const newPath = activeRevision?.imagePath;
    if (!newPath) return el("div", { class: "muted" }, "暂无修订图片");

    if (compareMode === "result") {
      return el("div", { class: "ann-result-single" },
        el("img", {
          class: "ann-base-img",
          src: localImg(newPath),
          alt: "批注修订版",
          style: { cursor: "zoom-in" },
          onClick: () => openImageLightbox(newPath, "批注修订版"),
        })
      );
    }

    if (compareMode === "side") {
      return el("div", { class: "ann-compare-side" },
        el("figure", { class: "ann-compare-fig" },
          el("figcaption", { class: "ann-compare-cap" }, "原图"),
          el("img", {
            src: localImg(img.path),
            alt: "原图",
            onClick: () => openImageLightbox(img.path, "原图"),
          })
        ),
        el("figure", { class: "ann-compare-fig is-new" },
          el("figcaption", { class: "ann-compare-cap is-new" }, "修订版"),
          el("img", {
            src: localImg(newPath),
            alt: "修订版",
            onClick: () => openImageLightbox(newPath, "修订版"),
          })
        )
      );
    }

    // Default: interactive Before/After Wipe Slider
    const afterLayer = el("div", {
      class: "ann-slider-after",
      style: { clipPath: `inset(0 0 0 ${sliderPct}%)` },
    }, el("img", { src: localImg(newPath), alt: "修订版", draggable: false }));

    const handle = el("div", {
      class: "ann-slider-handle",
      style: { left: `${sliderPct}%` },
    }, el("span", { class: "ann-slider-knob", "aria-hidden": "true" }, "◂ ▸"));

    const rangeIn = el("input", {
      type: "range",
      min: "0",
      max: "100",
      value: String(sliderPct),
      class: "ann-slider-range",
      "aria-label": "拖动对比原图与修订版",
    });

    const updateSplit = (pct) => {
      sliderPct = Math.max(0, Math.min(100, Math.round(pct)));
      afterLayer.style.clipPath = `inset(0 0 0 ${sliderPct}%)`;
      handle.style.left = `${sliderPct}%`;
      rangeIn.value = String(sliderPct);
    };

    rangeIn.addEventListener("input", () => updateSplit(Number(rangeIn.value)));

    const sliderWrap = el("div", { class: "ann-slider-wrap" },
      el("img", { class: "ann-slider-before", src: localImg(img.path), alt: "原图", draggable: false }),
      afterLayer,
      handle,
      el("span", { class: "ann-slider-tag is-left" }, "原图"),
      el("span", { class: "ann-slider-tag is-right" }, "修订版"),
      rangeIn
    );
    return sliderWrap;
  }

  function renderRevisionStatusBox() {
    clear(revStatusBox);
    if (!activeRevision) {
      revStatusBox.classList.add("hidden");
      return;
    }
    revStatusBox.classList.remove("hidden");
    if (activeRevision.status === "running") {
      const sec = Math.max(0, Math.floor((Date.now() - (activeRevision.startedAt || Date.now())) / 1000));
      revStatusBox.className = "ann-rev-status is-running";
      revStatusBox.append(
        el("span", { class: "ann-live-dot" }),
        el("div", { class: "col", style: { gap: "2px", flex: "1", minWidth: 0 } },
          el("strong", { style: { fontSize: "12.5px" } }, `正在生成修订版…（${sec}s）`),
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, "留在当前页即可，完成后将自动展示前后对比")
        )
      );
    } else if (activeRevision.status === "failed") {
      revStatusBox.className = "ann-rev-status is-failed";
      revStatusBox.append(
        el("div", { class: "col", style: { gap: "3px", flex: "1", minWidth: 0 } },
          el("strong", { style: { fontSize: "12.5px", color: "var(--err)" } }, "本次批注改图失败"),
          el("span", { style: { fontSize: "12px", color: "var(--ink)" } }, activeRevision.error || "生成失败，请重试或更换改图模型")
        ),
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => runAnnotateGenerate() }, "重试")
      );
    } else {
      revStatusBox.className = "ann-rev-status is-done";
      revStatusBox.append(
        el("div", { class: "col", style: { gap: "2px", flex: "1", minWidth: 0 } },
          el("strong", { style: { fontSize: "12.5px", color: "#18643d" } }, "✓ 修订版已生成"),
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, "可在左侧滑块对比原图与新图，满意后继续批注")
        )
      );
    }
  }

  function renderStage() {
    renderStageBar();
    renderRevisionStatusBox();
    clear(stageCanvas);

    if (stageMode === "compare" && activeRevision?.status === "done" && activeRevision.imagePath) {
      stageCanvas.appendChild(renderCompareView());
      return;
    }

    const stageInner = el("div", { class: "ann-stage-inner" }, annotateWrap);
    if (activeRevision?.status === "running") {
      const sec = Math.max(0, Math.floor((Date.now() - (activeRevision.startedAt || Date.now())) / 1000));
      stageInner.appendChild(el("div", { class: "ann-gen-overlay", role: "status" },
        el("span", { class: "ann-live-dot" }),
        el("span", { class: "ann-gen-overlay-text" }, `正在按批注精准改图…（${sec}s）`)
      ));
    }
    stageCanvas.appendChild(stageInner);
  }

  let refreshingRev = false;
  async function refreshActiveRevision() {
    if (refreshingRev || !activeRevision?.runId || activeRevision.status !== "running") return;
    refreshingRev = true;
    try {
      const detail = await api("GET", `/api/works/${encodeURIComponent(activeRevision.runId)}`);
      if (!activeRevision || activeRevision.status !== "running" || activeRevision.runId !== detail.run?.id) return;
      if (Array.isArray(detail.versions) && detail.versions.length) {
        versions = detail.versions;
        renderTimeline();
      }
      const im = (detail.run?.images || [])[0];
      if (im?.status === "done" && im.path) {
        activeRevision.status = "done";
        activeRevision.imagePath = im.path;
        activeRevision.imageId = im.id;
        activeRevision.error = "";
        stopRevisionWatchers();
        stageMode = "compare";
        sliderPct = 50;
        syncExecButton();
        renderStage();
        toast("修订版已生成，可直接在画布前后对比");
      } else if (im?.status === "failed" || detail.run?.status === "failed") {
        activeRevision.status = "failed";
        activeRevision.error = im?.error || detail.run?.error || "生成失败，请重试";
        stopRevisionWatchers();
        renderTimeline();
        syncExecButton();
        renderStage();
        toast(activeRevision.error);
      }
    } catch {} finally {
      refreshingRev = false;
    }
  }

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

  function syncExecButton() {
    const running = submitting || activeRevision?.status === "running";
    execBtn.disabled = running;
    if (running) {
      execBtn.textContent = "⏳ 正在绘制修订版…";
    } else if (activeRevision?.status === "done") {
      execBtn.textContent = annotations.length > 0 ? `🔄 再生成一版（${annotations.length} 处批注）` : "🔄 再生成一版";
    } else if (annotations.length > 0) {
      execBtn.textContent = `✨ 生成修订版（${annotations.length} 处批注）`;
    } else {
      execBtn.textContent = "✨ 生成修订版";
    }
  }

  async function runAnnotateGenerate() {
    if (submitting || activeRevision?.status === "running") return;
    const extra = globalExtra.trim();
    if (annotations.length === 0 && !extra) {
      toast("请先在左侧图片点击添加批注，或填写整体补充要求");
      return;
    }
    const mRef = modelSel.value || modRes.defaultModel;
    if (!mRef) return toast("请先配置或选择生图模型");

    closeNotePopover();
    submitting = true;
    syncExecButton();
    try {
      const annotatedGuideDataUrl = annotations.length > 0 ? renderAnnotatedGuideDataURL(mainImg, annotations) : "";
      const ratio = inferAspectRatio(img, run.recipe);
      const payload = {
        mode: "edit",
        title: (run.title || "批注改图") + " (修订)",
        parentId: run.id,
        modelRef: mRef,
        refs: [img.path],
        annotatedGuideDataUrl,
        annotations: annotations.map((a) => ({ x: a.x, y: a.y, text: a.text })),
        input: {
          theme: img.theme || run.originalRequest || run.title,
          ratio,
          mode: "edit",
          extra,
        },
      };
      const res = await submitEdit(payload);
      if (res?.run?.id) {
        // Stay right inside Annotate Studio — NO jumping to #works, NO Work Detail popup (#75)!
        activeRevision = {
          runId: res.run.id,
          status: "running",
          imagePath: "",
          imageId: "",
          error: "",
          startedAt: Date.now(),
        };
        stageMode = "annotate";
        stopRevisionWatchers();
        pollTimer = setInterval(() => {
          if (!root.isConnected) {
            stopRevisionWatchers();
            return;
          }
          refreshActiveRevision();
        }, 2200);
        elapsedTimer = setInterval(() => {
          if (!root.isConnected || activeRevision?.status !== "running") {
            if (elapsedTimer) {
              clearInterval(elapsedTimer);
              elapsedTimer = null;
            }
            return;
          }
          renderRevisionStatusBox();
          const ov = stageCanvas.querySelector(".ann-gen-overlay-text");
          if (ov) {
            const sec = Math.max(0, Math.floor((Date.now() - activeRevision.startedAt) / 1000));
            ov.textContent = `正在按批注精准改图…（${sec}s）`;
          }
        }, 1000);
        renderStage();
        refreshActiveRevision();
      }
    } catch (e) {
      toast(e?.message || "提交批注改图失败");
    } finally {
      submitting = false;
      syncExecButton();
    }
  }

  const execBtn = el("button", {
    type: "button",
    class: "btn btn-primary ann-exec-btn",
    onClick: () => runAnnotateGenerate(),
  }, "✨ 生成修订版");

  // Subscribe to SSE job/run updates for instant in-place completion
  const unsub = onEvent((msg) => {
    if (!root.isConnected) {
      closeNotePopover();
      stopRevisionWatchers();
      unsub();
      return;
    }
    const rid = msg.data?.runId || msg.data?.id;
    if ((msg.type === "job" || msg.type === "run") && activeRevision?.runId && rid === activeRevision.runId) {
      refreshActiveRevision();
    }
  });

  // Initial mount
  renderTimeline();
  drawPins();
  syncExecButton();
  renderStage();

  root.appendChild(el("div", { class: "ann-page" },
    el("div", { class: "page-head ann-head" },
      el("div", { class: "row", style: { gap: "10px", minWidth: "0", flexWrap: "wrap" } },
        el("h1", { class: "page-title" }, "批注改图"),
        el("span", { class: "ann-work-pill", title: run.title || "" }, run.title || "未命名作品")
      ),
      el("div", { class: "row", style: { gap: "6px" } },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => {
            closeNotePopover();
            stopRevisionWatchers();
            renderAnnotate(root, ctx, {});
          },
        }, "换一张图"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => ctx.go("works", { openRun: run.id }),
        }, "查看作品详情")
      )
    ),
    timelineWrap,
    el("div", { class: "ann-studio" },
      el("section", { class: "card ann-stage-card", "aria-label": "批注画布与对比区" },
        stageBar,
        stageCanvas
      ),
      el("aside", { class: "card ann-panel", "aria-label": "批注清单与控制面板" },
        el("div", { class: "field" },
          el("label", { style: { fontSize: "12px", fontWeight: 600 } }, "改图模型"),
          modelSel
        ),
        revStatusBox,
        el("div", { class: "ann-panel-sec-head" },
          el("strong", { style: { fontSize: "12.5px" } }, "画面批注"),
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, "悬停联动 · 点击编辑")
        ),
        listBox,
        el("div", { class: "field ann-global-field" },
          el("label", { style: { fontSize: "12px", fontWeight: 600 } }, "整体补充要求（可选）"),
          globalExtraIn
        ),
        el("div", { class: "ann-panel-foot" }, execBtn)
      )
    )
  ));
}
