import { api, clear, closeModal, el, localImg, showModal, showStackedModal, toast } from "../api.js";
import { createTextModelPicker } from "../skills-ui.js";
import {
  extractClipboardImageFiles,
  openReferencePickerModal,
  readClipboardImagesViaApi,
} from "./ref-picker.js";

async function uploadLocalFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  const up = await api("POST", "/api/mine/upload", fd);
  if (!up?.path) throw new Error("上传图片失败");
  return up.path;
}

function initialCoverImage(initial) {
  const direct = String(initial?.image || "").trim();
  if (direct) return direct;
  if (Array.isArray(initial?.images)) {
    for (const p of initial.images) {
      const clean = String(p || "").trim();
      if (clean) return clean;
    }
  }
  return "";
}

function openResourceEditor(kind, initial = {}, onSaved, opts = {}) {
  const isLayout = kind === "layout";
  const label = isLayout ? "图型" : "画风";
  const isEdit = Boolean(initial?.docId);
  const stacked = Boolean(opts?.stacked);

  let coverImage = initialCoverImage(initial);
  let isUploading = false;
  let busyAction = ""; // "" | "vision" | "prompt"
  let isSuggestingName = false;
  let isSaving = false;
  let selectedModelRef = "";
  let pendingPromptOffer = null; // { text, sourceLabel }
  let pendingAIResult = null; // { mode: "vision"|"prompt", description, name, via, violations }
  let closeThisModal = () => closeModal();

  // Hidden file input for single local cover image selection
  const fileInput = el("input", {
    type: "file",
    accept: "image/*",
    class: "hidden",
  });

  // Name input with embedded AI recommend-name icon button
  const nameIn = el("input", {
    type: "text",
    class: "input re-name-input",
    value: initial?.name || initial?.nameZh || initial?.generation_name || "",
    maxlength: "120",
    autofocus: true,
    placeholder: isLayout ? "如：双栏要点对照卡、四宫格手账分镜" : "如：暖纸淡彩钢笔、敦煌岩彩绘本",
    "aria-label": `${label}名称`,
  });

  const suggestNameBtn = el("button", {
    type: "button",
    class: "re-name-ai-btn",
    title: "根据下方描述让 AI 推荐名称",
    "aria-label": `根据描述让 AI 推荐${label}名称`,
    onClick: () => { void runSuggestName(); },
  }, "✨");

  const nameFieldWrap = el("div", { class: "re-name-wrap" }, nameIn, suggestNameBtn);

  // Single unified description textarea (never triggers AI automatically)
  const initialDesc = isLayout
    ? (initial?.description || initial?.prompt_zh || initial?.prompt_en || initial?.prompt || "")
    : (initial?.description || initial?.traits || initial?.traitsEn || initial?.prompt || "");

  const descIn = el("textarea", {
    class: "textarea re-desc-textarea",
    rows: "8",
    placeholder: isLayout
      ? "描述区域划分、主标题区、主配图区、要点区和留白比例（可先粘贴/带入提示词，再点左侧「从提示词提炼」）…"
      : "只描述纯粹视觉艺术语言：媒介、笔触线条、纸张肌理、色彩倾向、光影与氛围（可先带入提示词，再点左侧「从提示词提炼」）…",
    "aria-label": isLayout ? "排版与构图约束" : "视觉特征描述",
  }, initialDesc);

  descIn.addEventListener("input", () => {
    syncActionButtons();
  });

  const promptOfferBar = el("div", { class: "re-prompt-offer hidden" });
  const aiResultCard = el("div", { class: "re-ai-result-card hidden", role: "region", "aria-label": "AI 提取结果确认" });
  const warnBox = el("div", { class: "re-warn-banner hidden", role: "alert" });
  const uploadStatus = el("span", { class: "muted re-upload-status", role: "status" }, "");

  // Media stage (single cover image only)
  const mediaStage = el("div", { class: "re-media-stage" });
  const mediaActionsBar = el("div", { class: "re-media-actions hidden" });
  const dropOverlay = el("div", { class: "re-drop-overlay hidden", "aria-hidden": "true" },
    el("div", { class: "re-drop-overlay-box" },
      el("span", { style: { fontSize: "24px" } }, "📥"),
      el("strong", null, `松开鼠标设为${label}参考封面图`),
      el("span", { class: "muted", style: { fontSize: "12px" } }, "仅需 1 张参考图，不会自动调用 AI")
    )
  );

  // Explicit AI assist card (no toggle switch; never auto-runs; user explicitly triggers 1 of 2 modes)
  const modelPillHost = el("div", { class: "studio-model-pill is-plan re-model-pill", title: "选择 AI 模型（官网服务 / 第三方接口 / 本地 AI Harness）" },
    el("span", { class: "studio-model-pill-tag" }, "模型"),
    el("span", { class: "muted", style: { padding: "0 10px", fontSize: "12px" } }, "加载模型…")
  );

  const visionBtn = el("button", {
    type: "button",
    class: "btn btn-sm re-analyze-btn",
    title: `基于左侧参考图进行视觉识别，提取${label}描述（需先添加参考图）`,
    onClick: () => { void runVisionExtract(); },
  }, "👁 从图片视觉识别");

  const distillBtn = el("button", {
    type: "button",
    class: "btn btn-sm re-distill-btn",
    title: `读取右侧文本框中的提示词，提炼出纯粹的${label}描述`,
    onClick: () => { void runPromptDistill(); },
  }, "✨ 从提示词提炼");

  const aiCard = el("div", { class: "re-ai-card" },
    el("div", { class: "re-ai-card-head" },
      el("span", { class: "re-ai-card-title" }, `AI 辅助获取${label}`),
      el("span", { class: "muted re-ai-card-sub" }, "手动点击触发，提炼后先预览确认")
    ),
    modelPillHost,
    el("div", { class: "re-ai-btn-row" }, visionBtn, distillBtn)
  );

  api("GET", "/api/models").then((modRes) => {
    const initRef = modRes.sceneModels?.studioPlan || modRes.defaultVisionModel || modRes.defaultTextModel || "";
    const picker = createTextModelPicker(modRes, initRef, "studioPlan", (nextRef) => {
      selectedModelRef = nextRef;
    }, {
      ariaLabel: `${label} AI 辅助模型（官网 / 第三方接口 / 本地 AI Harness）`,
      className: "hm-trigger-sm",
    });
    selectedModelRef = picker.value;
    clear(modelPillHost);
    modelPillHost.append(
      el("span", { class: "studio-model-pill-tag" }, "模型"),
      picker.el
    );
  }).catch(() => {
    clear(modelPillHost);
    modelPillHost.append(
      el("span", { class: "studio-model-pill-tag" }, "模型"),
      el("span", { class: "muted", style: { padding: "0 10px", fontSize: "12px" } }, "默认服务")
    );
  });

  function renderPromptOffer() {
    clear(promptOfferBar);
    if (!pendingPromptOffer || !pendingPromptOffer.text) {
      promptOfferBar.classList.add("hidden");
      return;
    }
    const { text, sourceLabel } = pendingPromptOffer;
    promptOfferBar.classList.remove("hidden");
    promptOfferBar.append(
      el("span", { class: "re-prompt-offer-text" }, `💡 所选${sourceLabel}附带提示词`),
      el("div", { class: "row", style: { gap: "6px", flexShrink: "0" } },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => {
            descIn.value = text;
            pendingPromptOffer = null;
            renderPromptOffer();
            syncActionButtons();
            descIn.focus();
            toast(`已带入该${sourceLabel}的提示词`);
          },
        }, "替换填入"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => {
            descIn.value = descIn.value.trim() ? `${descIn.value.trim()}\n${text}` : text;
            pendingPromptOffer = null;
            renderPromptOffer();
            syncActionButtons();
            descIn.focus();
            toast(`已追加该${sourceLabel}的提示词`);
          },
        }, "追加"),
        el("button", {
          type: "button",
          class: "icon-btn",
          style: { width: "22px", height: "22px", fontSize: "12px" },
          title: "忽略",
          "aria-label": "忽略提示词带入",
          onClick: () => { pendingPromptOffer = null; renderPromptOffer(); },
        }, "×")
      )
    );
  }

  function renderAIResultCard() {
    clear(aiResultCard);
    if (!pendingAIResult || !pendingAIResult.description) {
      aiResultCard.classList.add("hidden");
      return;
    }
    const { mode, description, name, via, violations } = pendingAIResult;
    const hasExisting = Boolean(descIn.value.trim());
    const heading = mode === "vision" ? "👁 图片视觉识别结果" : "✨ 提示词提炼结果";

    aiResultCard.classList.remove("hidden");
    const cardNodes = [
      el("div", { class: "re-ai-result-head" },
        el("strong", { class: "re-ai-result-title" }, heading),
        via ? el("span", { class: "badge", style: { fontSize: "10.5px" } }, via) : null
      ),
      el("div", { class: "re-ai-result-preview" }, description),
    ];
    if (Array.isArray(violations) && violations.length > 0) {
      cardNodes.push(el("div", { class: "re-ai-result-warn" }, `⚠ 提示：仍检测到可能包含具体主体词（${violations.join("、")}），应用后可再微调。`));
    }
    cardNodes.push(el("div", { class: "re-ai-result-actions" },
      el("span", { class: "muted", style: { fontSize: "11.5px", marginRight: "auto" } },
        hasExisting ? "确认替换当前描述？" : "确认填入描述？"
      ),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => {
          pendingAIResult = null;
          renderAIResultCard();
          toast("已放弃本次 AI 提取结果，原描述未改动");
        },
      }, "放弃"),
      hasExisting
        ? el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => {
              descIn.value = `${descIn.value.trim()}\n${description}`;
              if (name && !nameIn.value.trim()) nameIn.value = name;
              pendingAIResult = null;
              renderAIResultCard();
              syncActionButtons();
              descIn.focus();
              toast("已追加到描述末尾");
            },
          }, "＋ 追加")
        : null,
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => {
          descIn.value = description;
          if (name && !nameIn.value.trim()) nameIn.value = name;
          if (!isLayout && Array.isArray(violations) && violations.length > 0) {
            warnBox.textContent = "⚠ 检测到可能包含具体主体词，建议删改为纯视觉语言：" + violations.join("、");
            warnBox.classList.remove("hidden");
          } else {
            warnBox.classList.add("hidden");
          }
          pendingAIResult = null;
          renderAIResultCard();
          syncActionButtons();
          descIn.focus();
          toast(hasExisting ? `已替换为 AI 提取的${label}描述` : `已填入 AI 提取的${label}描述`);
        },
      }, hasExisting ? "✓ 替换描述" : "✓ 填入描述")
    ));
    aiResultCard.append(...cardNodes);
  }

  function applyPickedPrompt(promptText, sourceLabel = "作品") {
    const clean = String(promptText || "").trim();
    if (!clean) return;
    if (!descIn.value.trim()) {
      descIn.value = clean;
      pendingPromptOffer = null;
      renderPromptOffer();
      syncActionButtons();
      uploadStatus.textContent = `已带入该${sourceLabel}的提示词，可手动微调或点「从提示词提炼」`;
      toast(`已带入该${sourceLabel}的提示词`);
    } else if (descIn.value.trim() !== clean) {
      pendingPromptOffer = { text: clean, sourceLabel };
      renderPromptOffer();
    }
  }

  async function ingestSingleFile(file, sourceLabel = "添加") {
    const isImg = String(file?.type || "").startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file?.name || "");
    if (!isImg) return toast("请选择或粘贴图片文件");
    isUploading = true;
    uploadStatus.textContent = `正在${sourceLabel}参考图…`;
    syncActionButtons();
    try {
      const savedPath = await uploadLocalFile(file);
      coverImage = savedPath;
      pendingPromptOffer = null;
      renderPromptOffer();
      uploadStatus.textContent = `已${sourceLabel}参考封面图（如需识图，请点击下方「从图片视觉识别」）`;
      renderMedia();
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
        await ingestSingleFile(res.files[0], "粘贴");
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
      currentRefs: coverImage ? [coverImage] : [],
      maxCount: 1,
      title: `为「${label}」选择 1 张参考封面图`,
      initialTab,
      stacked: true,
      onConfirm: (nextRefs, nextMeta) => {
        coverImage = (nextRefs && nextRefs[0]) ? String(nextRefs[0]).trim() : "";
        uploadStatus.textContent = coverImage ? "已选用参考封面图" : "";
        renderMedia();
        const meta = Array.isArray(nextMeta) ? nextMeta[0] : null;
        if (meta && (meta.source === "work" || meta.source === "inspiration")) {
          const pickedPrompt = String(meta.promptZh || meta.prompt || "").trim();
          const srcLbl = meta.source === "inspiration" ? "灵感" : "作品";
          if (pickedPrompt) applyPickedPrompt(pickedPrompt, srcLbl);
        }
      },
    });
  }

  function syncActionButtons() {
    const busy = Boolean(busyAction) || isUploading;
    const hasText = Boolean(descIn.value.trim());
    visionBtn.disabled = busy || !coverImage;
    visionBtn.textContent = busyAction === "vision" ? "视觉识别中…" : "👁 从图片视觉识别";
    distillBtn.disabled = busy || !hasText;
    distillBtn.textContent = busyAction === "prompt" ? "提示词提炼中…" : "✨ 从提示词提炼";
    suggestNameBtn.disabled = isSuggestingName || isSaving;
    suggestNameBtn.classList.toggle("is-busy", isSuggestingName);
    suggestNameBtn.textContent = isSuggestingName ? "…" : "✨";
    saveBtn.disabled = isSaving || isUploading;
    saveBtn.textContent = isSaving ? "保存中…" : (isEdit ? `保存${label}` : `创建${label}`);
  }

  function renderMedia() {
    clear(mediaStage);
    clear(mediaActionsBar);

    if (!coverImage) {
      mediaStage.classList.add("is-empty");
      mediaStage.append(
        el("div", { class: "re-empty-ico", "aria-hidden": "true" }, isLayout ? "📐" : "🎨"),
        el("strong", { class: "re-empty-title" }, "添加 1 张参考封面图（选填）"),
        el("p", { class: "muted re-empty-sub" }, "支持拖拽、Ctrl/⌘ + V 粘贴，或从作品库 / 灵感库挑选并带入提示词"),
        el("div", { class: "re-source-btns" },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => fileInput.click() }, "📁 本地选图"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { void pasteFromClipboardBtn(); } }, "📋 粘贴"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openLibraryPicker("works") }, "🎨 作品库"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openLibraryPicker("inspirations") }, "💡 灵感库"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openLibraryPicker("mine") }, "🖼️ 图库")
        )
      );
      mediaActionsBar.classList.add("hidden");
    } else {
      mediaStage.classList.remove("is-empty");
      mediaStage.append(
        el("img", { class: "re-hero-img", src: localImg(coverImage), alt: `${label}封面预览` }),
        el("span", { class: "re-cover-pill" }, "封面参考图")
      );
      mediaActionsBar.classList.remove("hidden");
      mediaActionsBar.append(
        el("button", { type: "button", class: "btn btn-sm", onClick: () => fileInput.click() }, "📁 换本地图"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => { void pasteFromClipboardBtn(); } }, "📋 粘贴"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => openLibraryPicker("works") }, "🎨 作品/灵感"),
        el("button", {
          type: "button",
          class: "btn btn-sm re-remove-img-btn",
          title: "移除当前封面图",
          onClick: () => {
            coverImage = "";
            uploadStatus.textContent = "";
            renderMedia();
          },
        }, "移除")
      );
    }
    syncActionButtons();
  }

  async function runVisionExtract() {
    if (!coverImage) return toast("请先添加 1 张参考图再进行视觉识别");
    if (busyAction) return;
    busyAction = "vision";
    uploadStatus.textContent = isLayout ? "正在视觉识别参考图排版结构…" : "正在视觉识别参考图画风特征…";
    syncActionButtons();
    try {
      const res = await api("POST", "/api/mine/analyze", {
        mode: "vision",
        images: [coverImage],
        kind,
        purpose: "create",
        modelRef: selectedModelRef,
      });
      const extracted = (res.description || (isLayout ? res.promptZh : res.traitsZh) || res.traitsEn || "").trim();
      if (!extracted) throw new Error("未提取到有效描述，请重试");
      const via = res.model || (res.source === "site" ? "官网视觉服务" : res.source || "");
      pendingAIResult = {
        mode: "vision",
        description: extracted,
        name: String(res.name || "").trim(),
        via,
        violations: !isLayout && Array.isArray(res.violations) ? res.violations : [],
      };
      renderAIResultCard();
      uploadStatus.textContent = via ? `视觉识别完成（${via}），请在右侧确认是否替换` : "视觉识别完成，请在右侧确认是否替换";
    } catch (e) {
      toast(e?.message || "视觉识别失败，请重试或切换支持看图的模型");
      uploadStatus.textContent = "";
    } finally {
      busyAction = "";
      syncActionButtons();
    }
  }

  async function runPromptDistill() {
    const rawPrompt = descIn.value.trim();
    if (!rawPrompt) {
      descIn.focus();
      return toast("请先在右侧输入或从作品/灵感带入提示词，再点击提炼");
    }
    if (busyAction) return;
    busyAction = "prompt";
    uploadStatus.textContent = isLayout ? "正在从提示词提炼纯排版构图约束…" : "正在从提示词提炼纯视觉画风特征…";
    syncActionButtons();
    try {
      const res = await api("POST", "/api/mine/analyze", {
        mode: "prompt",
        sourceText: rawPrompt,
        kind,
        purpose: "create",
        modelRef: selectedModelRef,
      });
      const extracted = (res.description || (isLayout ? res.promptZh : res.traitsZh) || res.traitsEn || "").trim();
      if (!extracted) throw new Error("未提炼到有效描述，请重试");
      const via = res.model || (res.source === "site" ? "官网文字服务" : res.source || "");
      pendingAIResult = {
        mode: "prompt",
        description: extracted,
        name: String(res.name || "").trim(),
        via,
        violations: !isLayout && Array.isArray(res.violations) ? res.violations : [],
      };
      renderAIResultCard();
      uploadStatus.textContent = via ? `提示词提炼完成（${via}），请在右侧确认是否替换` : "提示词提炼完成，请在右侧确认是否替换";
    } catch (e) {
      toast(e?.message || "提示词提炼失败，请重试或切换其他模型");
      uploadStatus.textContent = "";
    } finally {
      busyAction = "";
      syncActionButtons();
    }
  }

  async function runSuggestName() {
    const desc = descIn.value.trim();
    if (!desc) {
      descIn.focus();
      return toast(`请先填写${isLayout ? "排版与构图约束" : "视觉特征描述"}，再让 AI 推荐名称`);
    }
    if (isSuggestingName) return;
    isSuggestingName = true;
    syncActionButtons();
    try {
      const res = await api("POST", "/api/mine/suggest-name", {
        kind,
        description: desc,
        modelRef: selectedModelRef,
      });
      const suggested = String(res?.name || "").trim();
      if (!suggested) throw new Error("未获取到推荐名称，请重试");
      nameIn.value = suggested;
      nameIn.focus();
      nameIn.select();
      toast(`已推荐${label}名称：${suggested}`);
    } catch (e) {
      toast(e?.message || "AI 推荐名称失败，请检查模型配置");
    } finally {
      isSuggestingName = false;
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
    const singleImages = coverImage ? [coverImage] : [];
    try {
      if (isLayout) {
        const res = await api("POST", "/api/mine/layouts", {
          docId: initial?.docId || "",
          id: initial?.id || "",
          name,
          description: desc,
          prompt_zh: desc,
          prompt_en: desc,
          image: coverImage,
          images: singleImages,
        });
        toast(isEdit ? "图型已更新并准备同步" : "图型已创建");
        closeThisModal();
        window.dispatchEvent(new CustomEvent("handraw:custom-resource-saved", { detail: { kind: "layout", item: res?.layout || res } }));
        onSaved?.(res?.layout || res);
      } else {
        const res = await api("POST", "/api/mine/styles", {
          docId: initial?.docId || "",
          number: initial?.number || "",
          name,
          description: desc,
          traits: desc,
          traitsEn: desc,
          image: coverImage,
          images: singleImages,
        });
        if (res.violations?.length) {
          toast("已保存，建议后续移除特征中的主体词：" + res.violations.join("、"));
        } else {
          toast(isEdit ? "画风已更新并准备同步" : "画风已创建");
        }
        closeThisModal();
        window.dispatchEvent(new CustomEvent("handraw:custom-resource-saved", { detail: { kind: "style", item: res?.style || res } }));
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
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) void ingestSingleFile(file, "上传");
  });

  const leftCol = el("div", { class: "re-col-media" },
    mediaStage,
    mediaActionsBar,
    aiCard,
    uploadStatus
  );

  const rightCol = el("div", { class: "re-col-form" },
    el("div", { class: "field re-field" },
      el("div", { class: "re-label-row" },
        el("label", { class: "re-label" }, `${label}名称`),
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, "点右侧 ✨ 可按描述让 AI 起名")
      ),
      nameFieldWrap
    ),
    el("div", { class: "field re-field re-field-grow" },
      el("div", { class: "re-label-row" },
        el("label", { class: "re-label" }, isLayout ? "排版与构图约束" : "视觉特征描述"),
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, isLayout ? "描述分栏、标题与留白" : "仅描述画风视觉语言，勿写具体人物场景")
      ),
      promptOfferBar,
      aiResultCard,
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

  // Drag & drop across the editor modal (never auto-triggers AI)
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
      void ingestSingleFile(files[0], "拖入");
    }
  });

  const cancelBtn = el("button", { type: "button", class: "btn", onClick: () => closeThisModal() }, "取消");
  const saveBtn = el("button", { type: "button", class: "btn btn-primary", onClick: () => { void handleSave(); } }, isEdit ? `保存${label}` : `创建${label}`);

  let dlg = null;
  const onPaste = (e) => {
    if (!dlg?.open) return;
    if (document.querySelector("dialog.modal-ref-picker[open]")) return;
    const files = extractClipboardImageFiles(e);
    if (!files.length) return;
    e.preventDefault();
    void ingestSingleFile(files[0], "粘贴");
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

  if (!coverImage && initial?.remoteImageUrl) {
    uploadStatus.textContent = "正在加载参考封面图…";
    api("POST", "/api/mine/upload", { url: initial.remoteImageUrl, name: initial?.name || label })
      .then((up) => {
        if (up?.path && dlg?.open) {
          coverImage = up.path;
          renderMedia();
          uploadStatus.textContent = "已带入参考封面图";
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
