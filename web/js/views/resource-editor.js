import { api, clear, closeModal, el, localImg, showModal, showStackedModal, toast } from "../api.js";
import { createTextModelPicker } from "../skills-ui.js";
import {
  extractClipboardImageFiles,
  openReferencePickerModal,
  readClipboardImagesViaApi,
} from "./ref-picker.js";

const MAX_RESOURCE_IMAGES = 5;

const LAYOUT_STARTER_TEMPLATES = [
  {
    label: "上下留白社媒卡",
    text: "竖版上下分区结构：下方 65% 为主画面视觉区，上方 35% 保持干净暖纸留白用于排印主标题与副标题，四周留均衡呼吸边距，无多余边框装饰。",
  },
  {
    label: "左右双栏对照",
    text: "画面采用左右 1:1 对称双栏结构，中间以柔和细虚线或留白带分隔，顶部通栏放置居中主题标题，左右两栏各含独立小标题、主体配图区与底部精炼要点标注。",
  },
  {
    label: "四宫格手账分镜",
    text: "整体分为 2×2 四宫格圆角分镜面板，顶部留紧凑主标题条，每格配有角标序号与底部简短手写说明区，格间留均匀暖纸缝隙形成连续叙事节奏。",
  },
  {
    label: "居中视觉海报",
    text: "经典中心构图海报：画面正中 60% 聚焦单一核心视觉主体，顶部居中排布大字主标题，底部居中排布精炼副标题与小号标注信息，四周保留宽阔负空间。",
  },
];

function dedupImages(initial) {
  const out = [];
  const push = (p) => {
    const clean = String(p || "").trim();
    if (!clean || out.includes(clean)) return;
    if (out.length < MAX_RESOURCE_IMAGES) out.push(clean);
  };
  if (initial?.image) push(initial.image);
  if (Array.isArray(initial?.images)) {
    for (const p of initial.images) push(p);
  }
  return out;
}

async function uploadLocalFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  const up = await api("POST", "/api/mine/upload", fd);
  if (!up?.path) throw new Error("上传图片失败");
  return up.path;
}

function openResourceEditor(kind, initial = {}, onSaved, opts = {}) {
  const isLayout = kind === "layout";
  const label = isLayout ? "图型" : "画风";
  const isEdit = Boolean(initial?.docId);
  const stacked = Boolean(opts?.stacked);

  let images = dedupImages(initial);
  let isUploading = false;
  let isAnalyzing = false;
  let isSaving = false;
  let selectedModelRef = "";
  let closeThisModal = () => closeModal();

  // Hidden file input for local file selection
  const fileInput = el("input", {
    type: "file",
    accept: "image/*",
    multiple: true,
    class: "hidden",
  });

  // Form controls (single unified description textarea — no CN/EN split!)
  const nameIn = el("input", {
    type: "text",
    class: "input re-name-input",
    value: initial?.name || initial?.nameZh || initial?.generation_name || "",
    maxlength: "120",
    autofocus: true,
    placeholder: isLayout ? "如：双栏要点对照卡、四宫格手账分镜" : "如：暖纸淡彩钢笔、敦煌岩彩绘本",
    "aria-label": `${label}名称`,
  });

  const initialDesc = isLayout
    ? (initial?.description || initial?.prompt_zh || initial?.prompt_en || "")
    : (initial?.description || initial?.traits || initial?.traitsEn || "");

  const descIn = el("textarea", {
    class: "textarea re-desc-textarea",
    rows: "7",
    placeholder: isLayout
      ? "描述区域划分、主标题区、主配图区、要点区和留白比例（中英文皆可，不用分两栏）…"
      : "只描述纯粹视觉艺术语言：媒介、笔触线条、纸张肌理、色彩倾向、光影与氛围（避免出现具体人物、服饰或场景）…",
    "aria-label": isLayout ? "排版与构图约束" : "视觉特征描述",
  }, initialDesc);

  const warnBox = el("div", { class: "re-warn-banner hidden", role: "alert" });
  const uploadStatus = el("span", { class: "muted re-upload-status", role: "status" }, "");

  // Media stage + thumbnails
  const mediaStage = el("div", { class: "re-media-stage" });
  const thumbRail = el("div", { class: "re-thumb-rail" });
  const dropOverlay = el("div", { class: "re-drop-overlay hidden", "aria-hidden": "true" },
    el("div", { class: "re-drop-overlay-box" },
      el("span", { style: { fontSize: "24px" } }, "📥"),
      el("strong", null, `松开鼠标添加${label}参考图`),
      el("span", { class: "muted", style: { fontSize: "12px" } }, `最多支持 ${MAX_RESOURCE_IMAGES} 张，第 1 张自动作为封面`)
    )
  );

  // Unified AI model picker (Website / 3rd-party OpenAI / Local AI Harness + sub-models)
  const modelPillHost = el("div", { class: "studio-model-pill is-plan re-model-pill", title: "选择识别提取引擎（官网视觉服务 / 第三方接口 / 本地 AI Harness）" },
    el("span", { class: "studio-model-pill-tag" }, "识别"),
    el("span", { class: "muted", style: { padding: "0 10px", fontSize: "12px" } }, "加载模型…")
  );

  const analyzeBtn = el("button", {
    type: "button",
    class: "btn btn-sm re-analyze-btn",
    onClick: () => { void runAnalyze(); },
  }, isLayout ? "✨ 提取排版结构" : "✨ 提取视觉特征");

  api("GET", "/api/models").then((modRes) => {
    const initRef = modRes.defaultVisionModel || modRes.sceneModels?.studioPlan || modRes.defaultTextModel || "";
    const picker = createTextModelPicker(modRes, initRef, "studioPlan", (nextRef) => {
      selectedModelRef = nextRef;
    }, {
      ariaLabel: `${label}参考图识别模型（官网 / 第三方接口 / 本地 AI Harness）`,
      className: "hm-trigger-sm",
    });
    selectedModelRef = picker.value;
    clear(modelPillHost);
    modelPillHost.append(
      el("span", { class: "studio-model-pill-tag" }, "识别"),
      picker.el
    );
  }).catch(() => {
    clear(modelPillHost);
    modelPillHost.append(
      el("span", { class: "studio-model-pill-tag" }, "识别"),
      el("span", { class: "muted", style: { padding: "0 10px", fontSize: "12px" } }, "默认服务")
    );
  });

  function addImagePaths(paths) {
    let added = 0;
    for (const raw of paths || []) {
      const p = String(raw || "").trim();
      if (!p || images.includes(p)) continue;
      if (images.length >= MAX_RESOURCE_IMAGES) break;
      images.push(p);
      added++;
    }
    renderMedia();
    return added;
  }

  async function ingestFiles(files, sourceLabel = "添加") {
    const imgFiles = Array.from(files || []).filter((f) =>
      String(f?.type || "").startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f?.name || "")
    );
    if (!imgFiles.length) return toast("请选择或粘贴图片文件");
    const remain = MAX_RESOURCE_IMAGES - images.length;
    if (remain <= 0) return toast(`最多添加 ${MAX_RESOURCE_IMAGES} 张参考图，请先移除一张`);
    isUploading = true;
    uploadStatus.textContent = `正在${sourceLabel}图片…`;
    syncActionButtons();
    try {
      let okCount = 0;
      for (const f of imgFiles.slice(0, remain)) {
        const savedPath = await uploadLocalFile(f);
        okCount += addImagePaths([savedPath]);
      }
      if (okCount > 0) {
        uploadStatus.textContent = `已${sourceLabel} ${okCount} 张参考图`;
      }
    } catch (e) {
      toast(e?.message || `${sourceLabel}图片失败`);
      uploadStatus.textContent = "";
    } finally {
      isUploading = false;
      syncActionButtons();
    }
  }

  async function pasteFromClipboardBtn() {
    try {
      const res = await readClipboardImagesViaApi();
      if (res.supported && res.files.length) {
        await ingestFiles(res.files, "粘贴");
        return;
      }
      if (res.supported && !res.files.length) {
        toast("剪贴板里当前没有图片，请先截图或复制图片后再试");
        return;
      }
    } catch {}
    toast("请直接按 Ctrl/⌘ + V 粘贴剪贴板图片");
  }

  function openLibraryPicker(initialTab = "works") {
    openReferencePickerModal({
      currentRefs: [...images],
      maxCount: MAX_RESOURCE_IMAGES,
      title: `为「${label}」挑选参考图（作品 / 灵感库 / 图库）`,
      initialTab,
      stacked: true,
      onConfirm: (nextRefs) => {
        images = (nextRefs || []).slice(0, MAX_RESOURCE_IMAGES);
        uploadStatus.textContent = images.length ? `已选用 ${images.length} 张参考图` : "";
        renderMedia();
      },
    });
  }

  function syncActionButtons() {
    analyzeBtn.disabled = isAnalyzing || isUploading || images.length === 0;
    analyzeBtn.textContent = isAnalyzing
      ? "识别提取中…"
      : (isLayout ? "✨ 提取排版结构" : "✨ 提取视觉特征");
    saveBtn.disabled = isSaving || isUploading;
    saveBtn.textContent = isSaving ? "保存中…" : (isEdit ? `保存${label}` : `创建${label}`);
  }

  function renderMedia() {
    clear(mediaStage);
    clear(thumbRail);

    if (images.length === 0) {
      mediaStage.classList.add("is-empty");
      mediaStage.append(
        el("div", { class: "re-empty-ico", "aria-hidden": "true" }, isLayout ? "📐" : "🎨"),
        el("strong", { class: "re-empty-title" }, `添加 1–${MAX_RESOURCE_IMAGES} 张参考图（第 1 张作封面）`),
        el("p", { class: "muted re-empty-sub" }, "支持拖拽图片至此、按 Ctrl/⌘ + V 粘贴，或从作品库与灵感库挑选"),
        el("div", { class: "re-source-btns" },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => fileInput.click() }, "📁 本地选图"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { void pasteFromClipboardBtn(); } }, "📋 粘贴"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openLibraryPicker("works") }, "🎨 作品库"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openLibraryPicker("inspirations") }, "💡 灵感库"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openLibraryPicker("mine") }, "🖼️ 图库")
        )
      );
      thumbRail.classList.add("hidden");
    } else {
      mediaStage.classList.remove("is-empty");
      const coverPath = images[0];
      mediaStage.append(
        el("img", { class: "re-hero-img", src: localImg(coverPath), alt: `${label}封面预览` }),
        el("span", { class: "re-cover-pill" }, `封面图 · ${images.length}/${MAX_RESOURCE_IMAGES}`),
        el("div", { class: "re-hero-actions" },
          el("button", { type: "button", class: "btn btn-sm", title: "从本地选择更多图片", onClick: () => fileInput.click() }, "＋ 本地"),
          el("button", { type: "button", class: "btn btn-sm", title: "粘贴剪贴板图片", onClick: () => { void pasteFromClipboardBtn(); } }, "📋 粘贴"),
          el("button", { type: "button", class: "btn btn-sm", title: "从作品库、灵感库或图库挑选", onClick: () => openLibraryPicker("works") }, "🎨 作品/灵感")
        )
      );

      thumbRail.classList.remove("hidden");
      images.forEach((p, idx) => {
        const isCover = idx === 0;
        thumbRail.appendChild(el("div", {
          class: "re-thumb-item" + (isCover ? " is-cover" : ""),
          title: isCover ? "当前封面图" : "点击设为封面图",
          onClick: () => {
            if (idx === 0) return;
            const picked = images.splice(idx, 1)[0];
            images.unshift(picked);
            renderMedia();
          },
        },
          el("img", { src: localImg(p), alt: `参考图 ${idx + 1}` }),
          isCover ? el("span", { class: "re-thumb-badge" }, "封面") : null,
          el("button", {
            type: "button",
            class: "re-thumb-del",
            title: "移除此图",
            "aria-label": `移除参考图 ${idx + 1}`,
            onClick: (e) => {
              e.stopPropagation();
              images.splice(idx, 1);
              renderMedia();
            },
          }, "×")
        ));
      });
    }
    syncActionButtons();
  }

  async function runAnalyze() {
    if (!images.length) return toast(`请先添加 1–${MAX_RESOURCE_IMAGES} 张参考图`);
    isAnalyzing = true;
    uploadStatus.textContent = isLayout ? "正在分析参考图构图与排版结构…" : "正在分析参考图纯粹视觉语言…";
    syncActionButtons();
    try {
      const res = await api("POST", "/api/mine/analyze", {
        images,
        kind,
        purpose: "create",
        modelRef: selectedModelRef,
      });
      const extracted = (res.description || (isLayout ? res.promptZh : res.traitsZh) || res.traitsEn || "").trim();
      if (extracted) {
        descIn.value = extracted;
      }
      if (res.name && !nameIn.value.trim()) {
        nameIn.value = res.name;
      }
      if (!isLayout && Array.isArray(res.violations) && res.violations.length > 0) {
        warnBox.textContent = "⚠ 检测到可能包含具体主体词，建议删改为纯视觉语言：" + res.violations.join("、");
        warnBox.classList.remove("hidden");
      } else {
        warnBox.classList.add("hidden");
      }
      const via = res.model || (res.source === "site" ? "官网智能视觉服务" : res.source || "");
      uploadStatus.textContent = via ? `提取完成（${via}）` : "提取完成";
      toast(isLayout ? "已从参考图提取排版结构" : "已从参考图提取视觉特征");
    } catch (e) {
      toast(e?.message || "提取失败，请重试或切换支持视觉识图的模型");
      uploadStatus.textContent = "";
    } finally {
      isAnalyzing = false;
      syncActionButtons();
    }
  }

  async function handleSave() {
    const name = nameIn.value.trim();
    const desc = descIn.value.trim();
    if (!name) {
      nameIn.focus();
      return toast(`请填写${label}名称`);
    }
    if (!desc) {
      descIn.focus();
      return toast(isLayout ? "请填写排版与构图约束" : "请填写视觉特征描述");
    }
    isSaving = true;
    syncActionButtons();
    try {
      if (isLayout) {
        const res = await api("POST", "/api/mine/layouts", {
          docId: initial?.docId || "",
          id: initial?.id || "",
          name,
          description: desc,
          prompt_zh: desc,
          prompt_en: desc,
          image: images[0] || "",
          images,
        });
        toast(isEdit ? "图型已更新并准备同步" : "图型已创建");
        closeThisModal();
        onSaved?.(res?.layout || res);
      } else {
        const res = await api("POST", "/api/mine/styles", {
          docId: initial?.docId || "",
          number: initial?.number || "",
          name,
          description: desc,
          traits: desc,
          traitsEn: desc,
          image: images[0] || "",
          images,
        });
        if (res.violations?.length) {
          toast("已保存，建议后续移除特征中的主体词：" + res.violations.join("、"));
        } else {
          toast(isEdit ? "画风已更新并准备同步" : "画风已创建");
        }
        closeThisModal();
        onSaved?.(res?.style || res);
      }
    } catch (e) {
      toast(e?.message || `保存${label}失败`);
    } finally {
      isSaving = false;
      syncActionButtons();
    }
  }

  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = "";
    if (files.length) void ingestFiles(files, "上传");
  });

  // Layout quick-starter chips
  const layoutStarterRow = isLayout
    ? el("div", { class: "re-starter-row" },
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, "快捷模板："),
        ...LAYOUT_STARTER_TEMPLATES.map((tpl) => el("button", {
          type: "button",
          class: "btn btn-sm re-starter-chip",
          onClick: () => {
            if (!nameIn.value.trim()) nameIn.value = tpl.label;
            descIn.value = descIn.value.trim() ? `${descIn.value.trim()}\n${tpl.text}` : tpl.text;
            descIn.focus();
          },
        }, tpl.label))
      )
    : null;

  const leftCol = el("div", { class: "re-col-media" },
    mediaStage,
    thumbRail,
    el("div", { class: "re-ai-bar" },
      modelPillHost,
      analyzeBtn
    ),
    uploadStatus
  );

  const rightCol = el("div", { class: "re-col-form" },
    el("div", { class: "field re-field" },
      el("label", { class: "re-label" }, `${label}名称`),
      nameIn
    ),
    el("div", { class: "field re-field re-field-grow" },
      el("div", { class: "re-label-row" },
        el("label", { class: "re-label" }, isLayout ? "排版与构图约束" : "视觉特征描述"),
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, isLayout ? "描述分栏、标题与留白" : "仅描述画风视觉语言，勿写具体人物场景")
      ),
      layoutStarterRow,
      descIn
    ),
    warnBox,
    el("div", { class: "re-sync-note muted" }, "☁ 仅自己可见；登录后自动与网站账号双向同步（含封面图），满意后可随时发布到社区。")
  );

  const rootBody = el("div", { class: "re-workspace" },
    fileInput,
    leftCol,
    rightCol,
    dropOverlay
  );

  // Drag & drop across the editor modal
  let dragDepth = 0;
  rootBody.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.classList.remove("hidden");
  });
  rootBody.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
  });
  rootBody.addEventListener("dragleave", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.add("hidden");
  });
  rootBody.addEventListener("drop", (e) => {
    dragDepth = 0;
    dropOverlay.classList.add("hidden");
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) {
      e.preventDefault();
      void ingestFiles(files, "拖入");
    }
  });

  const cancelBtn = el("button", { type: "button", class: "btn", onClick: () => closeThisModal() }, "取消");
  const saveBtn = el("button", { type: "button", class: "btn btn-primary", onClick: () => { void handleSave(); } }, isEdit ? `保存${label}` : `创建${label}`);

  let dlg = null;
  const onPaste = (e) => {
    if (!dlg?.open) return;
    // If a stacked reference picker is open on top, let that picker own the paste event.
    if (document.querySelector("dialog.modal-ref-picker[open]")) return;
    const files = extractClipboardImageFiles(e);
    if (!files.length) return;
    e.preventDefault();
    void ingestFiles(files, "粘贴");
  };

  const openModalFn = stacked ? showStackedModal : showModal;
  dlg = openModalFn(isEdit ? `编辑我的${label}` : `新建我的${label}`, rootBody, [cancelBtn, saveBtn], {
    className: "modal-resource-editor",
    onClose: () => {
      document.removeEventListener("paste", onPaste);
    },
  });
  if (stacked && dlg?._closeSelf) {
    closeThisModal = dlg._closeSelf;
  }
  document.addEventListener("paste", onPaste);

  renderMedia();

  // If opened from a remote inspiration without local image, materialize it automatically
  if (!images.length && initial?.remoteImageUrl) {
    uploadStatus.textContent = "正在加载参考图…";
    api("POST", "/api/mine/upload", { url: initial.remoteImageUrl, name: initial?.name || label })
      .then((up) => {
        if (up?.path && dlg?.open) {
          addImagePaths([up.path]);
          uploadStatus.textContent = "已带入参考图，可点击「提取」自动生成描述";
        }
      })
      .catch(() => { uploadStatus.textContent = ""; });
  }
}

export function openStyleEditorModal(initial = {}, onSaved, opts = {}) {
  return openResourceEditor("style", initial, onSaved, opts);
}

export function openLayoutEditorModal(initial = {}, onSaved, opts = {}) {
  return openResourceEditor("layout", initial, onSaved, opts);
}
