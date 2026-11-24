import { api, clear, closeModal, el, localImg, showModal, toast } from "../api.js";

export const MAX_REF_IMAGES = 6;

const ASSET_CATEGORIES = [
  { key: "character", label: "角色" },
  { key: "prop", label: "道具" },
  { key: "scene", label: "场景" },
];

const ASSET_CATEGORY_LABELS = Object.fromEntries(ASSET_CATEGORIES.map((c) => [c.key, c.label]));

function categoryLabel(kind) {
  return ASSET_CATEGORY_LABELS[kind] || "其他";
}

function defaultPasteName(idx = 0) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return idx > 0 ? `粘贴参考图 ${stamp}-${idx + 1}` : `粘贴参考图 ${stamp}`;
}

function fileDisplayName(file, customName, idx, total) {
  const cleanCustom = String(customName || "").trim();
  if (cleanCustom) {
    return total > 1 ? `${cleanCustom} ${idx + 1}` : cleanCustom;
  }
  const raw = String(file?.name || "").replace(/\.[^.]+$/, "").trim();
  if (!raw || /^image$/i.test(raw) || /^blob$/i.test(raw)) {
    return defaultPasteName(idx);
  }
  return raw;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onerror = () => reject(new Error("读取图片失败，请重试"));
    rd.onload = () => resolve(String(rd.result || ""));
    rd.readAsDataURL(file);
  });
}

/**
 * Extract all image File objects from a ClipboardEvent (items + files fallback).
 */
export function extractClipboardImageFiles(event) {
  const cd = event?.clipboardData;
  if (!cd) return [];
  const out = [];
  const seen = new Set();
  const pushFile = (f) => {
    if (!f) return;
    const type = String(f.type || "").toLowerCase();
    const isImg = type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name || "");
    if (!isImg) return;
    const sig = `${f.name || ""}:${f.size || 0}:${type}`;
    if (seen.has(sig) && f.size > 0) return;
    seen.add(sig);
    out.push(f);
  };
  for (const it of Array.from(cd.items || [])) {
    if (it.kind === "file" && (!it.type || it.type.startsWith("image/"))) {
      pushFile(it.getAsFile());
    }
  }
  if (!out.length) {
    for (const f of Array.from(cd.files || [])) {
      pushFile(f);
    }
  }
  return out;
}

export function bindPageImagePaste(scopeEl, onFiles) {
  const onDocPaste = async (e) => {
    if (!scopeEl?.isConnected) {
      document.removeEventListener("paste", onDocPaste);
      return;
    }
    if (e.defaultPrevented) return;
    if (document.querySelector("dialog[open]")) return;
    const target = e.target;
    if (target instanceof HTMLElement && !scopeEl.contains(target) && target.closest("input, textarea, [contenteditable]")) {
      return;
    }
    const files = extractClipboardImageFiles(e);
    if (!files.length) return;
    e.preventDefault();
    await onFiles(files);
  };
  document.addEventListener("paste", onDocPaste);
  return () => document.removeEventListener("paste", onDocPaste);
}

async function readClipboardImagesViaApi() {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {
    return { supported: false, files: [] };
  }
  const items = await navigator.clipboard.read();
  const files = [];
  for (const item of items) {
    const imgType = (item.types || []).find((t) => t.startsWith("image/"));
    if (!imgType) continue;
    const blob = await item.getType(imgType);
    const ext = imgType.split("/")[1]?.replace("jpeg", "jpg") || "png";
    files.push(new File([blob], `clipboard.${ext}`, { type: imgType }));
  }
  return { supported: true, files };
}

/**
 * Import a single image File as a temporary reference via /api/images/import.
 */
export async function importTempReferenceFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await api("POST", "/api/images/import", fd);
  if (!res?.path) throw new Error("导入参考图失败");
  return res.path;
}

/**
 * Upload an image File into the user's self-built asset library via /api/mine/assets.
 */
export async function saveReferenceToAssetLibrary(file, { kind = "character", name = "" } = {}) {
  const dataUrl = await fileToDataUrl(file);
  const res = await api("POST", "/api/mine/assets", {
    kind: kind || "character",
    name: name || defaultPasteName(),
    dataUrl,
  });
  const asset = res?.asset;
  if (!asset?.image) throw new Error("保存到自建图库失败");
  return asset;
}

/**
 * Unified Reference Image Picker Modal aligned with handraw-web:
 * - Pick from 自建图库 (/api/mine/assets, including ~/.handraw-style)
 * - Pick from 官方图库 (/api/resources/assets built-in pack assets, if present)
 * - Local upload (single or multi-file) with optional save-to-library + category pills
 * - Direct clipboard paste (Ctrl/⌘ + V anywhere in modal, clipboard button, or drag-and-drop)
 */
export function openReferencePickerModal({
  currentRefs = [],
  maxCount = MAX_REF_IMAGES,
  title = "选择参考图",
  onConfirm,
} = {}) {
  const limit = Math.max(1, Number(maxCount) || MAX_REF_IMAGES);
  let selectedRefs = [];
  for (const r of Array.isArray(currentRefs) ? currentRefs : []) {
    const p = String(r || "").trim();
    if (p && !selectedRefs.includes(p)) selectedRefs.push(p);
  }

  let mineItems = [];
  let officialItems = [];
  const itemByPath = new Map();
  let loading = true;
  let activeTab = "mine"; // "mine" | "official" | "upload"
  let activeCategory = "ALL";
  let uploadCategory = "character";
  let saveToLibrary = true;
  let isUploading = false;
  let searchQuery = "";
  let newlyAddedPath = "";

  const topTabsWrap = el("div", { class: "ref-picker-tabs", role: "tablist", "aria-label": "参考图来源" });
  const quickPasteBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    title: "读取剪贴板图片并直接添加（也可直接按 Ctrl/⌘ + V）",
  }, "📋 粘贴剪贴板图片");
  const topBar = el("div", { class: "ref-picker-topbar" }, topTabsWrap, quickPasteBtn);

  const searchInput = el("input", {
    type: "search",
    class: "input",
    placeholder: "搜索自建图库编号、名称或分类…",
    "aria-label": "搜索参考图",
  });
  const countEl = el("span", { class: "muted ref-picker-count", role: "status" }, "正在加载自建图库…");
  const searchRow = el("div", { class: "ref-picker-search-row" }, searchInput, countEl);

  const catBar = el("div", { class: "studio-cat-tabs", role: "group", "aria-label": "图库分类筛选" });
  const uploadHost = el("div", { class: "ref-picker-upload-host hidden" });
  const grid = el("div", { class: "studio-resource-grid ref-picker-grid" });

  const selectedBar = el("div", { class: "ref-picker-selected-bar hidden", "aria-label": "当前已选参考图" });

  const clearBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: () => {
      selectedRefs = [];
      syncSelectionUI();
    },
  }, "清空已选");

  const cancelBtn = el("button", {
    type: "button",
    class: "btn",
    onClick: () => closeModal(),
  }, "取消");

  const confirmBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    onClick: () => {
      const result = [...selectedRefs];
      closeModal();
      if (typeof onConfirm === "function") onConfirm(result);
    },
  }, `✓ 确认选用 (${selectedRefs.length}/${limit})`);

  const uploadNameInput = el("input", {
    type: "text",
    class: "input",
    placeholder: "图参名称（选填，留空默认使用文件名或时间戳）",
    "aria-label": "图参名称",
  });

  const saveToLibChk = el("input", {
    type: "checkbox",
    checked: saveToLibrary,
  });
  saveToLibChk.addEventListener("change", () => {
    saveToLibrary = Boolean(saveToLibChk.checked);
    syncUploadMetaVisibility();
  });

  const localFileInput = el("input", {
    type: "file",
    accept: "image/*",
    multiple: true,
    class: "hidden",
  });

  function indexItems() {
    itemByPath.clear();
    for (const it of [...mineItems, ...officialItems]) {
      if (it?.image) itemByPath.set(it.image, it);
    }
  }

  function currentPool() {
    if (activeTab === "official") return officialItems;
    return mineItems;
  }

  function renderTabs() {
    clear(topTabsWrap);
    const tabs = [
      { id: "mine", label: `自建图库 (${mineItems.length})` },
    ];
    if (officialItems.length > 0) {
      tabs.push({ id: "official", label: `官方图库 (${officialItems.length})` });
    }
    tabs.push({ id: "upload", label: "本地上传 / 粘贴" });
    if (!tabs.some((t) => t.id === activeTab)) activeTab = "mine";

    tabs.forEach((t) => {
      const active = activeTab === t.id;
      topTabsWrap.appendChild(el("button", {
        type: "button",
        role: "tab",
        class: "btn btn-sm" + (active ? " btn-primary is-active" : ""),
        "aria-selected": String(active),
        "data-ref-tab": t.id,
        onClick: () => {
          if (activeTab === t.id) return;
          activeTab = t.id;
          renderTabs();
          renderView();
        },
      }, t.label));
    });
  }

  function renderSelectedBar() {
    clear(selectedBar);
    selectedBar.classList.toggle("hidden", selectedRefs.length === 0);
    if (!selectedRefs.length) return;
    selectedBar.appendChild(el("span", { class: "ref-picker-selected-label" }, `已选 (${selectedRefs.length}/${limit})`));
    const strip = el("div", { class: "ref-picker-selected-thumbs" });
    selectedRefs.forEach((rp, idx) => {
      const meta = itemByPath.get(rp);
      const label = meta?.name || `参考图 ${idx + 1}`;
      strip.appendChild(el("div", { class: "make-image-ref-thumb", title: label },
        el("img", { src: localImg(rp), alt: label }),
        el("button", {
          type: "button",
          "aria-label": `移除参考图 ${label}`,
          title: `移除 ${label}`,
          onClick: () => {
            selectedRefs.splice(idx, 1);
            syncSelectionUI();
          },
        }, "×")
      ));
    });
    selectedBar.appendChild(strip);
  }

  function syncSelectionUI() {
    confirmBtn.textContent = `✓ 确认选用 (${selectedRefs.length}/${limit})`;
    clearBtn.disabled = selectedRefs.length === 0;
    renderSelectedBar();
    if (activeTab !== "upload") {
      grid.querySelectorAll(".ref-picker-card").forEach((card) => {
        const p = card.dataset.refPath || "";
        const isSel = selectedRefs.includes(p);
        card.classList.toggle("is-selected", isSel);
        card.setAttribute("aria-pressed", String(isSel));
        const badge = card.querySelector(".ref-picker-check");
        if (badge) badge.textContent = isSel ? "✓ 已选" : "";
      });
    }
  }

  function toggleSelectPath(path) {
    if (!path) return;
    const idx = selectedRefs.indexOf(path);
    if (idx >= 0) {
      selectedRefs.splice(idx, 1);
      syncSelectionUI();
      return;
    }
    if (selectedRefs.length >= limit) {
      toast(`最多选用 ${limit} 张参考图，请先取消一张`);
      return;
    }
    selectedRefs.push(path);
    syncSelectionUI();
  }

  function renderCategoryPills() {
    const pool = currentPool();
    clear(catBar);
    const groups = [
      { key: "ALL", label: `全部 (${pool.length})` },
      ...ASSET_CATEGORIES.map((c) => ({
        key: c.key,
        label: `${c.label} (${pool.filter((x) => x.kind === c.key).length})`,
      })),
    ];
    const otherCount = pool.filter((x) => !ASSET_CATEGORY_LABELS[x.kind]).length;
    if (otherCount > 0) {
      groups.push({ key: "other", label: `其他 (${otherCount})` });
    }
    if (!groups.some((g) => g.key === activeCategory)) activeCategory = "ALL";

    groups.forEach((g) => {
      const active = activeCategory === g.key;
      catBar.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm" + (active ? " btn-primary" : ""),
        "aria-pressed": String(active),
        onClick: () => {
          activeCategory = g.key;
          renderCategoryPills();
          renderGrid();
        },
      }, g.label));
    });
  }

  function renderGrid() {
    clear(grid);
    if (loading) {
      countEl.textContent = "正在加载图库…";
      grid.appendChild(el("p", { class: "muted", style: { gridColumn: "1 / -1", textAlign: "center", padding: "28px 0" } }, "正在加载自建图库…"));
      return;
    }
    const pool = currentPool();
    const q = searchQuery.trim().toLowerCase();
    const visible = pool.filter((it) => {
      if (activeCategory === "other") {
        if (ASSET_CATEGORY_LABELS[it.kind]) return false;
      } else if (activeCategory !== "ALL" && it.kind !== activeCategory) {
        return false;
      }
      if (!q) return true;
      const hay = `${it.id || ""} ${it.name || ""} ${it.nameEn || ""} ${categoryLabel(it.kind)} ${(it.tags || []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });

    countEl.textContent = `共 ${visible.length} 项 · 已选 ${selectedRefs.length}/${limit} · 支持直接 Ctrl/⌘ + V 粘贴`;

    if (!pool.length && activeTab === "mine") {
      grid.appendChild(el("div", { class: "ref-picker-empty" },
        el("strong", null, "自建图库还没有参考图"),
        el("p", { class: "muted" }, "可以点击下方按钮从本地上传，或直接按 Ctrl/⌘ + V 粘贴剪贴板图片并自动存入自建图库，下次出图随时复用。"),
        el("div", { class: "row", style: { gap: "8px", justifyContent: "center", flexWrap: "wrap" } },
          el("button", {
            type: "button",
            class: "btn btn-primary btn-sm",
            onClick: () => {
              activeTab = "upload";
              renderTabs();
              renderView();
            },
          }, "＋ 本地上传 / 粘贴图片"),
          officialItems.length > 0
            ? el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: () => {
                  activeTab = "official";
                  renderTabs();
                  renderView();
                },
              }, `查看官方图库 (${officialItems.length})`)
            : null
        )
      ));
      return;
    }

    if (!visible.length) {
      grid.appendChild(el("p", { class: "muted", style: { gridColumn: "1 / -1", textAlign: "center", padding: "28px 0" } }, "当前筛选条件下没有匹配的参考图"));
      return;
    }

    visible.forEach((it, idx) => {
      const isSel = selectedRefs.includes(it.image);
      const wrap = el("div", { class: "studio-resource-thumb-wrap", dataset: { fallback: it.id || "图" } });
      const img = el("img", {
        src: localImg(it.image),
        alt: it.name || it.id || "参考图",
        decoding: "async",
        loading: idx < 18 ? "eager" : "lazy",
      });
      img.addEventListener("load", () => {
        img.classList.remove("is-error");
        img.classList.add("is-loaded");
        wrap.classList.remove("is-error");
      });
      img.addEventListener("error", () => {
        img.classList.remove("is-loaded", "is-instant");
        img.classList.add("is-error");
        wrap.classList.add("is-error");
      });
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add("is-loaded", "is-instant");
      }
      const checkBadge = el("span", { class: "ref-picker-check", "aria-hidden": "true" }, isSel ? "✓ 已选" : "");
      wrap.append(img, checkBadge);

      const card = el("button", {
        type: "button",
        class: "studio-resource-option ref-picker-card" + (isSel ? " is-selected" : ""),
        "aria-pressed": String(isSel),
        dataset: { refPath: it.image, assetId: it.id || "" },
        onClick: () => toggleSelectPath(it.image),
      },
        wrap,
        el("small", { class: "mono" }, `${it.id || "本地"} · ${categoryLabel(it.kind)}`),
        el("strong", null, it.name || it.id || "未命名参考图")
      );
      grid.appendChild(card);

      if (newlyAddedPath && it.image === newlyAddedPath) {
        newlyAddedPath = "";
        requestAnimationFrame(() => {
          card.scrollIntoView({ block: "nearest", behavior: "smooth" });
          card.classList.add("is-just-added");
          setTimeout(() => card.classList.remove("is-just-added"), 1400);
        });
      }
    });
  }

  let uploadMetaRow = null;
  let uploadCatFieldset = null;
  let uploadDropBtn = null;
  let uploadStatusText = null;

  function syncUploadMetaVisibility() {
    if (uploadMetaRow) uploadMetaRow.classList.toggle("hidden", !saveToLibrary);
    if (uploadCatFieldset) uploadCatFieldset.classList.toggle("hidden", !saveToLibrary);
  }

  function setUploadingState(busy, message = "") {
    isUploading = busy;
    quickPasteBtn.disabled = busy;
    if (uploadDropBtn) {
      uploadDropBtn.disabled = busy;
      uploadDropBtn.textContent = busy ? "正在处理图片…" : "＋ 选择本地图片";
    }
    if (uploadStatusText) {
      uploadStatusText.textContent = message || (saveToLibrary
        ? "上传或粘贴后将自动存入自建图库并勾选为本次参考图"
        : "仅作为本次会话/生图的临时参考图导入，不写入自建图库");
    }
  }

  async function processIncomingFiles(files, sourceLabel = "上传") {
    const imgFiles = Array.from(files || []).filter((f) => {
      const t = String(f?.type || "").toLowerCase();
      return t.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f?.name || "");
    });
    if (!imgFiles.length) return;
    if (isUploading) {
      toast("正在处理上一张图片，请稍候");
      return;
    }

    const shouldSave = Boolean(saveToLibrary);
    if (!shouldSave && selectedRefs.length >= limit) {
      toast(`最多选用 ${limit} 张参考图，请先移除一张`);
      return;
    }

    setUploadingState(true, `正在${sourceLabel} ${imgFiles.length} 张图片…`);
    let addedToSelection = 0;
    let savedToLibCount = 0;
    let skippedByLimit = 0;
    const customName = uploadNameInput.value.trim();

    try {
      for (let i = 0; i < imgFiles.length; i++) {
        const f = imgFiles[i];
        if (shouldSave) {
          const name = fileDisplayName(f, customName, i, imgFiles.length);
          const asset = await saveReferenceToAssetLibrary(f, { kind: uploadCategory, name });
          mineItems = [asset, ...mineItems.filter((x) => x.id !== asset.id && x.image !== asset.image)];
          indexItems();
          savedToLibCount++;
          newlyAddedPath = asset.image;
          if (!selectedRefs.includes(asset.image)) {
            if (selectedRefs.length < limit) {
              selectedRefs.push(asset.image);
              addedToSelection++;
            } else {
              skippedByLimit++;
            }
          }
        } else {
          if (selectedRefs.length >= limit) {
            skippedByLimit++;
            continue;
          }
          const path = await importTempReferenceFile(f);
          if (!selectedRefs.includes(path)) {
            selectedRefs.push(path);
            addedToSelection++;
          }
        }
      }

      uploadNameInput.value = "";
      if (savedToLibCount > 0) {
        activeTab = "mine";
        activeCategory = uploadCategory;
        renderTabs();
        renderView();
      }
      syncSelectionUI();

      if (savedToLibCount > 0) {
        toast(skippedByLimit > 0
          ? `已存入自建图库 ${savedToLibCount} 张（已达 ${limit} 张上限，部分未自动勾选）`
          : `已${sourceLabel} ${savedToLibCount} 张图片并存入自建图库`);
      } else if (addedToSelection > 0) {
        toast(skippedByLimit > 0
          ? `已添加 ${addedToSelection} 张参考图（最多 ${limit} 张，超出已忽略）`
          : `已${sourceLabel}并添加 ${addedToSelection} 张参考图`);
      }
    } catch (e) {
      toast(e?.message || `${sourceLabel}图片失败`);
    } finally {
      setUploadingState(false);
    }
  }

  localFileInput.addEventListener("change", async () => {
    const files = Array.from(localFileInput.files || []);
    localFileInput.value = "";
    if (files.length) await processIncomingFiles(files, "上传");
  });

  quickPasteBtn.addEventListener("click", async () => {
    try {
      const res = await readClipboardImagesViaApi();
      if (!res.supported) {
        toast("请直接按 Ctrl/⌘ + V 粘贴剪贴板图片");
        return;
      }
      if (!res.files.length) {
        toast("剪贴板里暂无图片，请先截图或复制图片后再试");
        return;
      }
      await processIncomingFiles(res.files, "粘贴");
    } catch {
      toast("请直接按 Ctrl/⌘ + V 粘贴剪贴板图片");
    }
  });

  function renderUploadPanel() {
    clear(uploadHost);
    const catName = `ref-upload-cat-${Date.now()}`;
    const catPillsWrap = el("div", { class: "ref-picker-cat-pills" });
    ASSET_CATEGORIES.forEach((c) => {
      const radio = el("input", {
        type: "radio",
        name: catName,
        value: c.key,
        checked: uploadCategory === c.key,
        class: "sr-only",
      });
      const pill = el("label", {
        class: "btn btn-sm ref-picker-cat-pill" + (uploadCategory === c.key ? " btn-primary is-active" : ""),
      }, radio, el("span", null, c.label));
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        uploadCategory = c.key;
        catPillsWrap.querySelectorAll(".ref-picker-cat-pill").forEach((p) => {
          const inp = p.querySelector("input");
          const on = Boolean(inp && inp.value === uploadCategory);
          p.classList.toggle("btn-primary", on);
          p.classList.toggle("is-active", on);
        });
      });
      catPillsWrap.appendChild(pill);
    });

    uploadCatFieldset = el("fieldset", { class: "ref-picker-cat-fieldset" },
      el("legend", null, "归入自建图库分类"),
      catPillsWrap
    );

    uploadMetaRow = el("div", { class: "ref-picker-upload-meta" },
      el("label", { class: "ref-picker-field-label" }, "图参名称"),
      uploadNameInput
    );

    uploadDropBtn = el("button", {
      type: "button",
      class: "btn btn-primary btn-sm",
      onClick: () => localFileInput.click(),
    }, "＋ 选择本地图片");

    const pasteNowBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: () => quickPasteBtn.click(),
    }, "📋 读取剪贴板图片");

    uploadStatusText = el("p", { class: "muted", style: { margin: 0, fontSize: "12px" } }, "");

    const dropzone = el("div", { class: "ref-picker-dropzone" },
      el("div", { class: "ref-picker-dropzone-title" }, "选择本地图片、拖拽至此，或直接按 Ctrl/⌘ + V 粘贴图片"),
      el("div", { class: "row", style: { gap: "8px", justifyContent: "center", flexWrap: "wrap" } },
        uploadDropBtn,
        pasteNowBtn
      ),
      uploadStatusText
    );
    dropzone.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
        dropzone.classList.add("is-dragover");
      }
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover"));
    dropzone.addEventListener("drop", async (e) => {
      dropzone.classList.remove("is-dragover");
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) {
        e.preventDefault();
        await processIncomingFiles(files, "拖入");
      }
    });

    const saveToggleRow = el("label", { class: "ref-picker-save-toggle" },
      saveToLibChk,
      el("span", null, "同时存入自建图库（下次可直接在自建图库复用）")
    );

    uploadHost.appendChild(el("div", { class: "ref-picker-upload-card" },
      saveToggleRow,
      uploadMetaRow,
      uploadCatFieldset,
      dropzone
    ));
    syncUploadMetaVisibility();
    setUploadingState(isUploading);
  }

  function renderView() {
    const isUpload = activeTab === "upload";
    searchRow.classList.toggle("hidden", isUpload);
    catBar.classList.toggle("hidden", isUpload);
    grid.classList.toggle("hidden", isUpload);
    uploadHost.classList.toggle("hidden", !isUpload);

    if (isUpload) {
      renderUploadPanel();
    } else {
      renderCategoryPills();
      renderGrid();
    }
    syncSelectionUI();
  }

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderGrid, 60);
  });

  const body = el("div", { class: "studio-picker-dialog-body ref-picker-body" },
    localFileInput,
    topBar,
    searchRow,
    catBar,
    uploadHost,
    grid,
    selectedBar
  );

  const onDialogPaste = async (e) => {
    if (!dlg?.open) return;
    const files = extractClipboardImageFiles(e);
    if (!files.length) return;
    e.preventDefault();
    await processIncomingFiles(files, "粘贴");
  };

  const dlg = showModal(title, body, [clearBtn, cancelBtn, confirmBtn], {
    className: "modal-picker modal-ref-picker",
    onClose: () => {
      clearTimeout(searchTimer);
      document.removeEventListener("paste", onDialogPaste);
    },
  });
  document.addEventListener("paste", onDialogPaste);

  renderTabs();
  renderView();

  // Hydrate自建图库 & 官方图库 asynchronously without blocking modal open.
  Promise.all([
    api("GET", "/api/mine/assets").catch(() => ({ items: [] })),
    api("GET", "/api/resources/assets").catch(() => ({ items: [] })),
  ]).then(([mineRes, packRes]) => {
    const mMap = new Map();
    for (const a of (mineRes?.items || [])) {
      if (!a?.image) continue;
      const key = a.id || a.image;
      if (!mMap.has(key)) mMap.set(key, a);
    }
    mineItems = Array.from(mMap.values());
    const mineIds = new Set(mineItems.map((x) => x.id).filter(Boolean));
    const mineImgs = new Set(mineItems.map((x) => x.image).filter(Boolean));

    const oMap = new Map();
    for (const a of (packRes?.items || [])) {
      if (!a?.image) continue;
      if ((a.id && mineIds.has(a.id)) || mineImgs.has(a.image)) continue;
      const key = a.id || a.image;
      if (!oMap.has(key)) oMap.set(key, a);
    }
    officialItems = Array.from(oMap.values());

    loading = false;
    indexItems();
    renderTabs();
    renderView();
  });
}
