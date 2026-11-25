import { api, clear, closeModal, el, galleryImg, localImg, onEvent, showModal, toast } from "../api.js";

const BUILTIN_EXT_IGNORE = new Set(["styles", "layouts", "colors", "tones", "assets", "characters", "props", "scenes"]);

export const MAX_REF_IMAGES = 6;

export const BUILTIN_ASSET_CATEGORIES = [
  { key: "character", label: "角色", builtin: true },
  { key: "prop", label: "道具", builtin: true },
  { key: "scene", label: "场景", builtin: true },
  { key: "other", label: "其他", builtin: true },
];

export async function fetchAssetCategories() {
  try {
    const res = await api("GET", "/api/mine/asset-categories");
    if (Array.isArray(res?.items) && res.items.length) {
      return res.items;
    }
  } catch {}
  return BUILTIN_ASSET_CATEGORIES.map((c) => ({ ...c }));
}

export async function saveAssetCategory({ key = "", label = "" } = {}) {
  return api("POST", "/api/mine/asset-categories", { key, label });
}

export async function deleteAssetCategory(key) {
  return api("DELETE", `/api/mine/asset-categories/${encodeURIComponent(key)}`);
}

export function assetCategoryLabel(kind, categories = BUILTIN_ASSET_CATEGORIES) {
  const k = String(kind || "").trim();
  const hit = (categories || []).find((c) => c.key === k);
  if (hit) return hit.label;
  const fallback = BUILTIN_ASSET_CATEGORIES.find((c) => c.key === k);
  if (fallback) return fallback.label;
  return k || "其他";
}

function defaultPasteName(idx = 0) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return idx > 0 ? `粘贴参考图 ${stamp}-${idx + 1}` : `粘贴参考图 ${stamp}`;
}

export function fileDisplayName(file, customName, idx, total) {
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

export function fileToDataUrl(file) {
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

export async function readClipboardImagesViaApi() {
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
    kind: kind || "other",
    name: name || defaultPasteName(),
    dataUrl,
  });
  const asset = res?.asset;
  if (!asset?.image) throw new Error("保存到自建图库失败");
  return asset;
}

function galleryIcon(g) {
  const id = String(g?.id || "").toLowerCase();
  if (g?.multiVariant || id.includes("pose")) return "🧍";
  if (id.includes("costume") || id.includes("outfit")) return "👗";
  if (id.includes("face") || id.includes("portrait")) return "👩";
  return "🗂️";
}

/**
 * Studio 3-Zone Reference Image Picker Modal (#110):
 * - Left Rail: Sources (自建图库, 官方图库, 本地上传/粘贴, 扩展视觉参考库) + nested series/categories
 * - Center Canvas: Single compact toolbar + generous image-first card grid
 * - Right Dock: Live high-res preview & 5-angle visual picker + readable 已选参考图 list
 * - Global drag-and-drop overlay & Ctrl/⌘ + V clipboard paste anywhere in modal
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

  let categories = BUILTIN_ASSET_CATEGORIES.map((c) => ({ ...c }));
  let mineItems = [];
  let officialItems = [];
  let extGalleries = []; // merged installed galleries + catalog packs
  const extItemsCache = new Map();
  const extLoadingSet = new Set();
  const extInstallingSet = new Set();
  const extKeyToPath = new Map();
  const itemByPath = new Map();

  let loading = true;
  let activeTab = "mine"; // "mine" | "official" | "ext:<kind>" | "upload"
  let activeCategory = "ALL";
  let extSeries = "";
  let extAngle = "front";
  let extPageLimit = 48;

  // Right inspector state: { mode: "ext"|"asset", gal?, item, angleKey? }
  let inspected = null;
  let inspectStageSeq = 0;

  let materializingKey = "";
  let uploadCategory = "character";
  let showNewCatForm = false;
  let saveToLibrary = false;
  let isUploading = false;
  let searchQuery = "";
  let newlyAddedPath = "";

  // DOM shells
  const localFileInput = el("input", {
    type: "file",
    accept: "image/*",
    multiple: true,
    class: "hidden",
  });

  const leftRail = el("aside", { class: "rp-rail", "aria-label": "参考图来源与分类" });
  const toolbarEl = el("div", { class: "rp-toolbar" });
  const searchInput = el("input", {
    type: "search",
    class: "input rp-search-input",
    placeholder: "搜索编号、名称、角度或分类…",
    "aria-label": "搜索参考图",
  });
  const quickPasteBtn = el("button", {
    type: "button",
    class: "btn btn-sm rp-paste-btn",
    title: "读取剪贴板图片并直接添加（也可随时按 Ctrl/⌘ + V）",
  }, "📋 粘贴");
  const toolbarExtras = el("div", { class: "rp-toolbar-extras" });
  const statusStrip = el("div", { class: "rp-status-strip muted", role: "status" }, "正在加载图库…");

  const grid = el("div", { class: "rp-grid" });
  const uploadHost = el("div", { class: "rp-upload-host hidden" });
  const centerPane = el("section", { class: "rp-center", "aria-label": "参考图画布" },
    toolbarEl,
    statusStrip,
    uploadHost,
    grid
  );

  const inspectorHost = el("div", { class: "rp-inspector hidden", "aria-label": "实时预览与角度选择" });
  const selectedDock = el("div", { class: "rp-selected-dock", "aria-label": "当前已选参考图" });
  const rightDock = el("aside", { class: "rp-dock" }, inspectorHost, selectedDock);

  const dropOverlay = el("div", { class: "rp-drop-overlay hidden", "aria-hidden": "true" },
    el("div", { class: "rp-drop-overlay-box" },
      el("span", { style: { fontSize: "26px" } }, "📥"),
      el("strong", null, "松开鼠标即可添加为本次参考图"),
      el("span", { class: "muted", style: { fontSize: "12px" } }, "支持单张或多张本地图片直接拖入")
    )
  );

  const workspace = el("div", { class: "rp-workspace" },
    leftRail,
    centerPane,
    rightDock,
    dropOverlay
  );

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
      const resultMeta = result.map((p, idx) => {
        const meta = itemByPath.get(p);
        if (meta?.source === "gallery" && meta.galleryId && meta.itemId) {
          return {
            index: idx + 1,
            source: "gallery",
            galleryId: meta.galleryId,
            itemId: meta.itemId,
            variant: meta.variant || "",
            label: meta.name || meta.itemId,
            localPath: p,
          };
        }
        if (meta?.id) {
          return {
            index: idx + 1,
            source: "asset",
            assetId: meta.id,
            label: meta.name || "",
            localPath: p,
          };
        }
        return {
          index: idx + 1,
          source: "upload",
          label: meta?.name || "",
          localPath: p,
        };
      });
      closeModal();
      if (typeof onConfirm === "function") onConfirm(result, resultMeta);
    },
  }, `✓ 确认选用 (${selectedRefs.length}/${limit})`);

  const uploadNameInput = el("input", {
    type: "text",
    class: "input",
    placeholder: "图参名称（选填，留空默认使用文件名或时间戳）",
    "aria-label": "图参名称",
  });
  const saveToLibChk = el("input", { type: "checkbox", checked: saveToLibrary });
  saveToLibChk.addEventListener("change", () => {
    saveToLibrary = Boolean(saveToLibChk.checked);
    syncUploadMetaVisibility();
  });

  function indexItems() {
    for (const it of [...mineItems, ...officialItems]) {
      if (it?.image) itemByPath.set(it.image, it);
    }
  }

  function currentPool() {
    return activeTab === "official" ? officialItems : mineItems;
  }

  function activeExtGallery() {
    if (!activeTab.startsWith("ext:")) return null;
    const id = activeTab.slice(4);
    return extGalleries.find((g) => g.id === id) || null;
  }

  function mergeExtGalleries(galList, packList) {
    const byId = new Map();
    for (const g of (galList || [])) {
      if (!g || !g.id || BUILTIN_EXT_IGNORE.has(g.id)) continue;
      if (!g.supportsRefImage) continue;
      byId.set(g.id, {
        ...g,
        installed: true,
        count: Number(g.count || 0),
      });
    }
    for (const p of (packList || [])) {
      if (!p || !p.id) continue;
      const existing = byId.get(p.id);
      if (existing) {
        existing.badge = p.badge || existing.badge;
        existing.description = p.description || existing.description;
        existing.multiVariant = Boolean(existing.multiVariant || p.multiVariant);
        existing.localOnly = true;
      } else {
        byId.set(p.id, {
          id: p.id,
          name: p.name || p.id,
          nameEn: p.nameEn || "",
          description: p.description || "",
          badge: p.badge || "",
          multiVariant: Boolean(p.multiVariant),
          localOnly: true,
          supportsRefImage: true,
          installed: Boolean(p.installed),
          count: Number(p.itemCount || 0),
        });
      }
    }
    // Keep RuiC packs in a stable intuitive order: poses -> costumes -> faces -> others
    const order = ["ruic-poses", "ruic-costumes", "ruic-faces"];
    return Array.from(byId.values()).sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-CN");
    });
  }

  function ensureExtItemsLoaded(gal, force = false) {
    if (!gal || !gal.installed) return;
    if (!force && (extItemsCache.has(gal.id) || extLoadingSet.has(gal.id))) return;
    extLoadingSet.add(gal.id);
    api("GET", `/api/galleries/${encodeURIComponent(gal.id)}/items`)
      .then((res) => {
        const list = Array.isArray(res?.items) ? res.items : [];
        extItemsCache.set(gal.id, list);
        if (activeTab === `ext:${gal.id}` && gal.multiVariant && list.length && (!inspected || inspected.gal?.id !== gal.id)) {
          inspected = { mode: "ext", gal, item: list[0], angleKey: extAngle };
        }
      })
      .catch(() => {
        extItemsCache.set(gal.id, []);
      })
      .finally(() => {
        extLoadingSet.delete(gal.id);
        if (activeTab === `ext:${gal.id}`) renderAll();
      });
  }

  async function installPackInline(gal) {
    if (!gal || extInstallingSet.has(gal.id)) return;
    extInstallingSet.add(gal.id);
    renderCenter();
    try {
      await api("POST", "/api/galleries/packs/install", { id: gal.id, mirror: "gitee" });
      toast(`已安装「${gal.name}」到本地`);
      await refreshGalleryMetadata(true);
      const updated = extGalleries.find((g) => g.id === gal.id);
      if (updated) ensureExtItemsLoaded(updated, true);
    } catch (e) {
      toast(e?.message || `安装「${gal.name}」失败`);
    } finally {
      extInstallingSet.delete(gal.id);
      renderAll();
    }
  }

  async function toggleExtGalleryItem(gal, item, variantObj = null) {
    const vKey = variantObj?.key || "";
    const compKey = `${gal.id}:${item.id}:${vKey}`;
    const knownPath = extKeyToPath.get(compKey);
    if (knownPath && selectedRefs.includes(knownPath)) {
      toggleSelectPath(knownPath);
      return;
    }
    if (selectedRefs.length >= limit) {
      toast(`最多选用 ${limit} 张参考图，请先取消一张`);
      return;
    }
    if (materializingKey) return;
    materializingKey = compKey;
    renderInspector();
    if (activeTab === `ext:${gal.id}`) renderExtGrid();
    try {
      const res = await api("POST", `/api/galleries/${encodeURIComponent(gal.id)}/items/${encodeURIComponent(item.id)}/materialize`, {
        variant: vKey,
      });
      if (!res?.path) throw new Error("缓存参考图失败");
      extKeyToPath.set(compKey, res.path);
      itemByPath.set(res.path, {
        name: res.name || (variantObj ? `${item.name} · ${variantObj.label}` : item.name),
        image: res.path,
        source: "gallery",
        galleryId: gal.id,
        itemId: item.id,
        variant: res.variant || vKey || "",
        sourceLabel: gal.name || gal.id,
        angleLabel: variantObj?.label || "",
        localOnly: Boolean(gal.localOnly),
      });
      if (!selectedRefs.includes(res.path)) {
        selectedRefs.push(res.path);
      }
      syncSelectionUI();
    } catch (e) {
      toast(e?.message || "加载参考图失败");
    } finally {
      materializingKey = "";
      renderInspector();
      if (activeTab === `ext:${gal.id}`) renderExtGrid();
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

  function createInlineCategoryForm({ onCreated, onCancel }) {
    const nameIn = el("input", {
      type: "text",
      class: "input",
      placeholder: "输入新分类名…",
      maxlength: "24",
      style: { width: "100%", padding: "5px 8px", fontSize: "12px" },
    });
    const createBtn = el("button", { type: "button", class: "btn btn-sm btn-primary" }, "创建");
    const submit = async () => {
      const label = nameIn.value.trim();
      if (!label) return toast("请输入分类名称");
      createBtn.disabled = true;
      try {
        const res = await saveAssetCategory({ label });
        if (Array.isArray(res?.items) && res.items.length) categories = res.items;
        toast(`已创建分类「${label}」`);
        onCreated?.(res?.category);
      } catch (e) {
        createBtn.disabled = false;
        toast(e?.message || "创建分类失败");
      }
    };
    createBtn.addEventListener("click", submit);
    nameIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel?.(); }
    });
    queueMicrotask(() => nameIn.focus());
    return el("div", { class: "rp-rail-newcat" },
      nameIn,
      el("div", { class: "row", style: { gap: "4px", justifyContent: "flex-end" } },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => onCancel?.() }, "取消"),
        createBtn
      )
    );
  }

  function switchTab(nextTab) {
    if (activeTab === nextTab) return;
    activeTab = nextTab;
    activeCategory = "ALL";
    extSeries = "";
    extPageLimit = 48;
    showNewCatForm = false;
    const gal = activeExtGallery();
    if (gal) {
      ensureExtItemsLoaded(gal);
      const cached = extItemsCache.get(gal.id);
      if (gal.multiVariant && cached?.length) {
        inspected = { mode: "ext", gal, item: cached[0], angleKey: extAngle };
      } else {
        inspected = null;
      }
    } else {
      inspected = null;
    }
    renderAll();
  }

  // ---------- Left Navigation Rail ----------

  function renderRail() {
    clear(leftRail);

    const makeSourceBtn = (id, ico, label, countText, extraBadge = "") => {
      const active = activeTab === id;
      return el("button", {
        type: "button",
        role: "tab",
        class: "rp-rail-item" + (active ? " is-active" : ""),
        "aria-selected": String(active),
        "data-ref-tab": id,
        onClick: () => switchTab(id),
      },
        el("span", { class: "rp-rail-ico", "aria-hidden": "true" }, ico),
        el("span", { class: "rp-rail-label" }, label),
        extraBadge ? el("span", { class: "rp-rail-tag" }, extraBadge) : null,
        countText !== "" ? el("span", { class: "rp-rail-count" }, String(countText)) : null
      );
    };

    // Group 1: 我的素材
    const myGroup = el("div", { class: "rp-rail-group" },
      el("div", { class: "rp-rail-heading" }, "我的素材"),
      makeSourceBtn("mine", "🖼️", "自建图库", mineItems.length)
    );

    // Nested categories when 自建图库 is active
    if (activeTab === "mine") {
      const subList = el("div", { class: "rp-rail-sublist", role: "group", "aria-label": "自建图库分类" });
      const known = new Set(categories.map((c) => c.key));
      const catEntries = [
        { key: "ALL", label: "全部", count: mineItems.length },
        ...categories.map((c) => ({
          key: c.key,
          label: c.label,
          count: mineItems.filter((x) => (x.kind || "other") === c.key).length,
        })),
      ];
      for (const it of mineItems) {
        const k = it.kind || "other";
        if (!known.has(k)) {
          known.add(k);
          catEntries.push({ key: k, label: k, count: mineItems.filter((x) => (x.kind || "other") === k).length });
        }
      }
      if (!catEntries.some((c) => c.key === activeCategory)) activeCategory = "ALL";
      catEntries.forEach((c) => {
        subList.appendChild(el("button", {
          type: "button",
          class: "rp-rail-sub" + (activeCategory === c.key ? " is-active" : ""),
          onClick: () => { activeCategory = c.key; renderRail(); renderGrid(); },
        }, el("span", null, c.label), el("span", { class: "rp-rail-count" }, String(c.count))));
      });
      if (showNewCatForm) {
        subList.appendChild(createInlineCategoryForm({
          onCreated: (created) => {
            showNewCatForm = false;
            if (created?.key) { activeCategory = created.key; uploadCategory = created.key; }
            renderRail();
            renderGrid();
          },
          onCancel: () => { showNewCatForm = false; renderRail(); },
        }));
      } else {
        subList.appendChild(el("button", {
          type: "button",
          class: "rp-rail-sub rp-rail-sub-add",
          onClick: () => { showNewCatForm = true; renderRail(); },
        }, "＋ 新建分类"));
      }
      myGroup.appendChild(subList);
    }

    if (officialItems.length > 0) {
      myGroup.appendChild(makeSourceBtn("official", "✨", "官方图库", officialItems.length));
    }
    myGroup.appendChild(makeSourceBtn("upload", "📤", "本地上传 / 粘贴", ""));
    leftRail.appendChild(myGroup);

    // Group 2: 视觉参考库 (RuiC-PoseAtlas & any installed extension galleries)
    if (extGalleries.length > 0) {
      const extGroup = el("div", { class: "rp-rail-group" },
        el("div", { class: "rp-rail-heading" },
          el("span", null, "视觉参考库"),
          el("span", { class: "rp-rail-lock", title: "仅存本机，不同步至网站" }, "🔒 仅本机")
        )
      );
      extGalleries.forEach((g) => {
        const tabId = `ext:${g.id}`;
        const countDisplay = g.installed ? (g.count || "") : "未装";
        extGroup.appendChild(makeSourceBtn(tabId, galleryIcon(g), g.name || g.id, countDisplay, g.multiVariant ? "5视角" : ""));

        // Nested series or categories right underneath the active extension library!
        if (activeTab === tabId && g.installed && extItemsCache.has(g.id)) {
          const items = extItemsCache.get(g.id) || [];
          const seriesMap = new Map();
          items.forEach((it) => {
            const sk = it.meta?.series;
            if (!sk) return;
            if (!seriesMap.has(sk)) seriesMap.set(sk, { key: sk, label: it.meta?.seriesShort || sk, count: 0 });
            seriesMap.get(sk).count++;
          });

          const subList = el("div", { class: "rp-rail-sublist", role: "group", "aria-label": `${g.name} 筛选` });
          if (seriesMap.size > 1) {
            [{ key: "", label: "全部系列", count: items.length }, ...seriesMap.values()].forEach((s) => {
              subList.appendChild(el("button", {
                type: "button",
                class: "rp-rail-sub" + (extSeries === s.key ? " is-active" : ""),
                onClick: () => {
                  extSeries = s.key;
                  activeCategory = "ALL";
                  extPageLimit = 48;
                  renderRail();
                  renderToolbar();
                  renderExtGrid();
                },
              }, el("span", null, s.label), el("span", { class: "rp-rail-count" }, String(s.count))));
            });
            extGroup.appendChild(subList);
          } else {
            const cMap = new Map();
            items.forEach((it) => {
              const ck = it.category || "other";
              if (!cMap.has(ck)) cMap.set(ck, { key: ck, label: it.categoryName || ck, count: 0 });
              cMap.get(ck).count++;
            });
            if (cMap.size > 1 && cMap.size <= 12) {
              [{ key: "ALL", label: "全部", count: items.length }, ...cMap.values()].forEach((c) => {
                subList.appendChild(el("button", {
                  type: "button",
                  class: "rp-rail-sub" + (activeCategory === c.key ? " is-active" : ""),
                  onClick: () => {
                    activeCategory = c.key;
                    extPageLimit = 48;
                    renderRail();
                    renderExtGrid();
                  },
                }, el("span", null, c.label), el("span", { class: "rp-rail-count" }, String(c.count))));
              });
              extGroup.appendChild(subList);
            }
          }
        }
      });
      leftRail.appendChild(extGroup);
    }
  }

  // ---------- Center Top Toolbar (Single Clean Row!) ----------

  function renderToolbar() {
    clear(toolbarEl);
    clear(toolbarExtras);
    const isUpload = activeTab === "upload";
    toolbarEl.classList.toggle("hidden", isUpload);
    statusStrip.classList.toggle("hidden", isUpload);
    if (isUpload) return;

    const gal = activeExtGallery();
    if (gal && gal.installed && extItemsCache.has(gal.id)) {
      const items = extItemsCache.get(gal.id) || [];
      if (gal.multiVariant) {
        const angles = [];
        const seen = new Set();
        for (const it of items) {
          for (const v of (it.variants || [])) {
            if (!v?.key || seen.has(v.key)) continue;
            seen.add(v.key);
            angles.push({ key: v.key, label: v.label || v.key });
          }
          if (angles.length >= 5) break;
        }
        if (angles.length) {
          if (!angles.some((a) => a.key === extAngle)) extAngle = angles[0].key;
          const seg = el("div", { class: "rp-angle-seg", role: "group", "aria-label": "列表预览视角" },
            ...angles.map((a) => el("button", {
              type: "button",
              class: "rp-angle-btn" + (extAngle === a.key ? " is-active" : ""),
              onClick: () => {
                extAngle = a.key;
                if (inspected?.mode === "ext" && inspected.gal?.id === gal.id) {
                  inspected.angleKey = a.key;
                }
                renderToolbar();
                renderExtGrid();
                renderInspector();
              },
            }, a.label))
          );
          toolbarExtras.appendChild(seg);
        }
      }

      // Sub-category compact select when series exist in sidebar (e.g. poses 21 sub-categories) or > 12 categories
      const basePool = extSeries ? items.filter((it) => (it.meta?.series || "") === extSeries) : items;
      const hasSeriesInRail = new Set(items.map((it) => it.meta?.series).filter(Boolean)).size > 1;
      const cMap = new Map();
      basePool.forEach((it) => {
        const ck = it.category || "other";
        if (!cMap.has(ck)) cMap.set(ck, { key: ck, label: it.categoryName || ck, count: 0 });
        cMap.get(ck).count++;
      });
      if (activeCategory !== "ALL" && !cMap.has(activeCategory)) activeCategory = "ALL";
      if ((hasSeriesInRail && cMap.size > 1) || cMap.size > 12) {
        const sel = el("select", {
          class: "select rp-subcat-select",
          "aria-label": "按细分分类筛选",
          onChange: () => {
            activeCategory = sel.value;
            extPageLimit = 48;
            renderExtGrid();
          },
        },
          el("option", { value: "ALL", selected: activeCategory === "ALL" }, `全部分类 (${basePool.length})`),
          ...Array.from(cMap.values()).map((c) =>
            el("option", { value: c.key, selected: activeCategory === c.key }, `${c.label} (${c.count})`)
          )
        );
        toolbarExtras.appendChild(sel);
      }
    }

    toolbarEl.append(searchInput, toolbarExtras, quickPasteBtn);
  }

  // ---------- Center Grid (自建图库 / 官方图库) ----------

  function renderGrid() {
    clear(grid);
    grid.classList.remove("is-ext-grid");
    if (loading) {
      statusStrip.textContent = "正在加载图库…";
      grid.appendChild(el("p", { class: "muted rp-grid-msg" }, "正在加载自建图库…"));
      return;
    }
    const pool = currentPool();
    const q = searchQuery.trim().toLowerCase();
    const visible = pool.filter((it) => {
      const k = it.kind || "other";
      if (activeCategory !== "ALL" && k !== activeCategory) return false;
      if (!q) return true;
      const hay = `${it.id || ""} ${it.name || ""} ${it.nameEn || ""} ${assetCategoryLabel(k, categories)} ${(it.tags || []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });

    statusStrip.textContent = `共 ${visible.length} 项 · 单击图片直接选用/取消，也可拖入文件或按 Ctrl/⌘ + V 粘贴`;

    if (!pool.length && activeTab === "mine") {
      grid.appendChild(el("div", { class: "ref-picker-empty" },
        el("strong", null, "自建图库还没有参考图"),
        el("p", { class: "muted" }, "可在左侧直接切换「姿态图鉴 / 衣装图鉴 / 人像图鉴」选用参考图，或点下方上传/粘贴本地图片。"),
        el("div", { class: "row", style: { gap: "8px", justifyContent: "center", flexWrap: "wrap" } },
          el("button", {
            type: "button",
            class: "btn btn-primary btn-sm",
            onClick: () => switchTab("upload"),
          }, "＋ 本地上传 / 粘贴图片"),
          extGalleries.length > 0
            ? el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: () => switchTab(`ext:${extGalleries[0].id}`),
              }, `${galleryIcon(extGalleries[0])} 浏览${extGalleries[0].name}`)
            : null
        )
      ));
      return;
    }

    if (!visible.length) {
      grid.appendChild(el("p", { class: "muted rp-grid-msg" }, "当前筛选条件下没有匹配的参考图"));
      return;
    }

    visible.forEach((it, idx) => {
      const isSel = selectedRefs.includes(it.image);
      const wrap = el("div", { class: "rp-thumb-wrap", dataset: { fallback: it.id || "图" } });
      const img = el("img", {
        src: localImg(it.image),
        alt: it.name || it.id || "参考图",
        decoding: "async",
        loading: idx < 18 ? "eager" : "lazy",
      });
      img.addEventListener("load", () => { img.classList.add("is-loaded"); wrap.classList.remove("is-error"); });
      img.addEventListener("error", () => { img.classList.add("is-error"); wrap.classList.add("is-error"); });
      if (img.complete && img.naturalWidth > 0) img.classList.add("is-loaded", "is-instant");

      const checkBadge = el("span", { class: "rp-check-badge", "aria-hidden": "true" }, isSel ? "✓ 已选" : "");
      const previewBtn = el("button", {
        type: "button",
        class: "rp-card-quick-btn",
        title: "在右侧大图预览",
        onClick: (e) => {
          e.stopPropagation();
          inspected = { mode: "asset", item: it };
          renderInspector();
        },
      }, "预览");
      wrap.append(img, checkBadge, previewBtn);

      const card = el("div", {
        role: "button",
        tabindex: "0",
        class: "rp-card" + (isSel ? " is-selected" : "") + (newlyAddedPath && it.image === newlyAddedPath ? " is-just-added" : ""),
        "aria-pressed": String(isSel),
        dataset: { refPath: it.image, assetId: it.id || "" },
        onClick: () => {
          toggleSelectPath(it.image);
          inspected = { mode: "asset", item: it };
          renderInspector();
        },
        onKeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleSelectPath(it.image);
          }
        },
      },
        wrap,
        el("div", { class: "rp-card-meta" },
          el("small", { class: "mono" }, `${it.id || ""} · ${assetCategoryLabel(it.kind, categories)}`),
          el("strong", null, it.name || it.id || "参考图")
        )
      );
      grid.appendChild(card);
    });
    if (newlyAddedPath) {
      const target = newlyAddedPath;
      newlyAddedPath = "";
      setTimeout(() => {
        grid.querySelectorAll(".rp-card.is-just-added").forEach((c) => {
          if (c.dataset.refPath === target) c.classList.remove("is-just-added");
        });
      }, 1500);
    }
  }

  // ---------- Center Grid (Extension Visual Libraries: 姿态 / 衣装 / 人像) ----------

  function renderExtGrid() {
    const gal = activeExtGallery();
    if (!gal) return;
    clear(grid);
    grid.classList.add("is-ext-grid");

    if (!gal.installed) {
      const installing = extInstallingSet.has(gal.id);
      statusStrip.textContent = `${gal.name} · 🔒 仅存本机，不同步至网站`;
      grid.appendChild(el("div", { class: "ref-picker-empty" },
        el("div", { style: { fontSize: "28px" } }, galleryIcon(gal)),
        el("strong", null, installing ? `正在安装「${gal.name}」索引…` : `「${gal.name}」尚未安装到本地`),
        el("p", { class: "muted" }, gal.description || "由客户端直接从 Gitee 国内镜像安装轻量索引（约 1 秒完成），图片按需缓存在本机，绝不上传或同步到网站。"),
        el("button", {
          type: "button",
          class: "btn btn-primary btn-sm",
          disabled: installing,
          onClick: () => installPackInline(gal),
        }, installing ? "正在从 Gitee 安装…" : `⚡ 一键安装「${gal.name}」`)
      ));
      return;
    }

    if (extLoadingSet.has(gal.id) || !extItemsCache.has(gal.id)) {
      statusStrip.textContent = `正在加载 ${gal.name || gal.id}…`;
      grid.appendChild(el("p", { class: "muted rp-grid-msg" }, `正在加载 ${gal.name || gal.id}…`));
      return;
    }

    const items = extItemsCache.get(gal.id) || [];
    const q = searchQuery.trim().toLowerCase();
    const visible = items.filter((it) => {
      if (extSeries && (it.meta?.series || "") !== extSeries) return false;
      if (activeCategory !== "ALL" && (it.category || "other") !== activeCategory) return false;
      if (!q) return true;
      const hay = `${it.id || ""} ${it.name || ""} ${it.nameEn || ""} ${it.categoryName || ""} ${it.traits || ""} ${(it.tags || []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });

    statusStrip.textContent = gal.multiVariant
      ? `共 ${visible.length} 组姿态 · 点击卡片在右侧对比 5 视角，或直接点卡片右下「＋ 选视角」快速添加 · 🔒 仅本机`
      : `共 ${visible.length} 项 · 单击卡片直接选用/取消 · 🔒 仅本机参考，不同步至网站`;

    if (!visible.length) {
      grid.appendChild(el("p", { class: "muted rp-grid-msg" }, "当前筛选条件下没有匹配条目"));
      return;
    }

    // Auto-focus first visible pose in Right Inspector if nothing in this gallery is inspected yet
    if (gal.multiVariant && (!inspected || inspected.gal?.id !== gal.id)) {
      inspected = { mode: "ext", gal, item: visible[0], angleKey: extAngle };
      renderInspector();
    }

    const slice = visible.slice(0, extPageLimit);
    slice.forEach((it, idx) => {
      const vars = Array.isArray(it.variants) ? it.variants : [];
      const activeVar = vars.length ? (vars.find((v) => v.key === extAngle) || vars[0]) : null;
      const thumbSrc = activeVar
        ? galleryImg(activeVar.thumbUrl || activeVar.imageUrl || "")
        : galleryImg(it.thumbUrl || it.imageUrl || "");

      const pickedAngles = vars.length
        ? vars.filter((v) => {
            const p = extKeyToPath.get(`${gal.id}:${it.id}:${v.key}`);
            return Boolean(p && selectedRefs.includes(p));
          })
        : [];
      const singlePath = !vars.length ? extKeyToPath.get(`${gal.id}:${it.id}:`) : "";
      const isSel = vars.length ? pickedAngles.length > 0 : Boolean(singlePath && selectedRefs.includes(singlePath));
      const isFocused = inspected?.mode === "ext" && inspected.gal?.id === gal.id && inspected.item?.id === it.id;

      const curAngleKey = activeVar?.key || "";
      const curAnglePath = extKeyToPath.get(`${gal.id}:${it.id}:${curAngleKey}`);
      const isCurAngleSel = Boolean(curAnglePath && selectedRefs.includes(curAnglePath));
      const isBusy = materializingKey === `${gal.id}:${it.id}:${curAngleKey}`;

      const wrap = el("div", { class: "rp-thumb-wrap is-ext-thumb", dataset: { fallback: it.id || "图" } });
      const img = el("img", {
        src: thumbSrc,
        alt: it.name || it.id,
        decoding: "async",
        loading: idx < 18 ? "eager" : "lazy",
      });
      img.addEventListener("load", () => { img.classList.add("is-loaded"); wrap.classList.remove("is-error"); });
      img.addEventListener("error", () => { img.classList.add("is-error"); wrap.classList.add("is-error"); });
      if (img.complete && img.naturalWidth > 0) img.classList.add("is-loaded", "is-instant");

      const badgeText = isSel
        ? (pickedAngles.length ? `✓ ${pickedAngles.map((v) => v.label).join("/")}` : "✓ 已选")
        : "";
      const checkBadge = el("span", { class: "rp-check-badge", "aria-hidden": "true" }, badgeText);
      const anglePill = (!isSel && vars.length > 1)
        ? el("span", { class: "rp-angle-pill", "aria-hidden": "true" }, `${vars.length}视角`)
        : null;

      // Hover quick action button
      const quickAction = vars.length > 1
        ? el("button", {
            type: "button",
            class: "rp-card-quick-btn" + (isCurAngleSel ? " is-picked" : ""),
            dataset: { quickPickPose: it.id },
            title: isCurAngleSel ? `取消已选「${activeVar.label}」` : `一键选用当前「${activeVar.label}」视角`,
            onClick: (e) => {
              e.stopPropagation();
              inspected = { mode: "ext", gal, item: it, angleKey: activeVar.key };
              toggleExtGalleryItem(gal, it, activeVar);
            },
          }, isBusy ? "缓存中…" : (isCurAngleSel ? `✓ ${activeVar.label}` : `＋ 选${activeVar.label}`))
        : el("button", {
            type: "button",
            class: "rp-card-quick-btn",
            title: "在右侧查看大图",
            onClick: (e) => {
              e.stopPropagation();
              inspected = { mode: "ext", gal, item: it, angleKey: "" };
              renderInspector();
            },
          }, "大图");

      wrap.append(img, anglePill, checkBadge, quickAction);

      const card = el("div", {
        role: "button",
        tabindex: "0",
        class: "rp-card is-ext-card" + (isSel ? " is-selected" : "") + (isFocused ? " is-focused" : ""),
        "aria-pressed": String(isSel),
        dataset: { extKind: gal.id, assetId: it.id || "" },
        onClick: () => {
          if (vars.length > 1) {
            inspected = { mode: "ext", gal, item: it, angleKey: activeVar?.key || vars[0].key };
            renderInspector();
            // Highlight active card without resetting grid scroll
            grid.querySelectorAll(".rp-card.is-focused").forEach((c) => c.classList.remove("is-focused"));
            card.classList.add("is-focused");
          } else {
            inspected = { mode: "ext", gal, item: it, angleKey: "" };
            toggleExtGalleryItem(gal, it, null);
          }
        },
        onKeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            card.click();
          }
        },
      },
        wrap,
        el("div", { class: "rp-card-meta" },
          el("small", { class: "mono" }, vars.length > 1
            ? `${it.meta?.no || it.id} · ${it.categoryName || ""}`
            : `${it.id} · ${it.categoryName || ""}`),
          el("strong", null, isBusy ? "正在缓存…" : (it.name || it.id))
        )
      );
      grid.appendChild(card);
    });

    if (visible.length > extPageLimit) {
      grid.appendChild(el("div", { style: { gridColumn: "1 / -1", textAlign: "center", padding: "12px 0 4px" } },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => { extPageLimit += 48; renderExtGrid(); },
        }, `加载更多（已显示 ${slice.length} / ${visible.length}）`)
      ));
    }
  }

  // ---------- Right Inspector (5-Angle Pose Picker / Large Preview) ----------

  function renderInspector() {
    clear(inspectorHost);
    if (!inspected || !inspected.item) {
      inspectorHost.classList.add("hidden");
      return;
    }
    inspectorHost.classList.remove("hidden");

    // Case A: Extension gallery item (5-angle pose OR costume/face preview)
    if (inspected.mode === "ext") {
      const { gal, item } = inspected;
      const vars = Array.isArray(item.variants) ? item.variants : [];
      const isPose = vars.length > 1;
      let activeVar = isPose
        ? (vars.find((v) => v.key === inspected.angleKey) || vars.find((v) => v.key === extAngle) || vars[0])
        : null;
      if (activeVar) inspected.angleKey = activeVar.key;

      const compKey = `${gal.id}:${item.id}:${activeVar?.key || ""}`;
      const curPath = extKeyToPath.get(compKey);
      const isCurSel = Boolean(curPath && selectedRefs.includes(curPath));
      const isBusy = materializingKey === compKey;

      const thumbSrc = activeVar
        ? galleryImg(activeVar.thumbUrl || activeVar.imageUrl || "")
        : galleryImg(item.thumbUrl || item.imageUrl || "");
      const fullSrc = activeVar
        ? galleryImg(activeVar.imageUrl || activeVar.thumbUrl || "")
        : galleryImg(item.imageUrl || item.thumbUrl || "");

      const stageImg = el("img", { src: thumbSrc, alt: item.name || item.id });
      const seq = ++inspectStageSeq;
      if (fullSrc && fullSrc !== thumbSrc) {
        const pre = new Image();
        pre.onload = () => { if (seq === inspectStageSeq) stageImg.src = fullSrc; };
        pre.src = fullSrc;
      }

      const stepAngle = (delta) => {
        if (!isPose) return;
        const idx = vars.findIndex((v) => v.key === activeVar?.key);
        const nextIdx = (idx + delta + vars.length) % vars.length;
        inspected.angleKey = vars[nextIdx].key;
        renderInspector();
      };

      const stageBox = el("div", { class: "rp-inspect-stage" },
        stageImg,
        isPose
          ? el("button", {
              type: "button",
              class: "rp-stage-nav is-prev",
              title: "上一个视角 (←)",
              "aria-label": "上一个视角",
              onClick: () => stepAngle(-1),
            }, "‹")
          : null,
        isPose
          ? el("button", {
              type: "button",
              class: "rp-stage-nav is-next",
              title: "下一个视角 (→)",
              "aria-label": "下一个视角",
              onClick: () => stepAngle(1),
            }, "›")
          : null,
        activeVar
          ? el("span", { class: "rp-stage-angle-tag" }, activeVar.label)
          : null
      );

      let strip = null;
      if (isPose) {
        strip = el("div", { class: "rp-angle-strip", role: "listbox", "aria-label": "选择姿态视角" });
        vars.forEach((v) => {
          const vk = `${gal.id}:${item.id}:${v.key}`;
          const vp = extKeyToPath.get(vk);
          const vSel = Boolean(vp && selectedRefs.includes(vp));
          const vActive = activeVar && activeVar.key === v.key;
          const vBusy = materializingKey === vk;
          strip.appendChild(el("div", {
            role: "option",
            tabindex: "0",
            "aria-selected": String(vActive),
            class: "rp-angle-tile" + (vActive ? " is-active" : "") + (vSel ? " is-picked" : ""),
            dataset: { poseAnglePick: v.key },
            onClick: () => {
              inspected.angleKey = v.key;
              renderInspector();
            },
            onKeydown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleExtGalleryItem(gal, item, v);
              }
            },
          },
            el("img", { src: galleryImg(v.thumbUrl || v.imageUrl || ""), alt: v.label, loading: "eager" }),
            el("button", {
              type: "button",
              class: "rp-angle-tile-pick" + (vSel ? " is-picked" : ""),
              title: vSel ? `取消已选「${v.label}」` : `直接选用「${v.label}」`,
              dataset: { poseAngleToggle: v.key },
              onClick: (e) => {
                e.stopPropagation();
                inspected.angleKey = v.key;
                toggleExtGalleryItem(gal, item, v);
              },
            }, vBusy ? "…" : (vSel ? "✓" : "＋")),
            el("span", { class: "rp-angle-tile-label" }, v.label)
          ));
        });
      }

      const ctaBtn = el("button", {
        type: "button",
        class: "btn btn-sm rp-inspect-cta" + (isCurSel ? "" : " btn-primary"),
        dataset: { role: "rp-inspect-toggle" },
        disabled: Boolean(materializingKey && !isBusy),
        onClick: () => toggleExtGalleryItem(gal, item, activeVar),
      }, isBusy
        ? "正在缓存到本地…"
        : isPose
          ? (isCurSel ? `✓ 已选「${activeVar.label}」（点击取消）` : `＋ 选用「${activeVar.label}」视角`)
          : (isCurSel ? "✓ 已选用（点击取消）" : "＋ 选用为参考图")
      );

      inspectorHost.append(
        el("div", { class: "rp-inspect-head" },
          el("div", { class: "col", style: { gap: "2px", minWidth: 0 } },
            el("strong", { class: "rp-inspect-title", title: item.name || item.id }, item.name || item.id),
            el("span", { class: "muted", style: { fontSize: "11.5px" } },
              `${item.meta?.no || item.id} · ${item.categoryName || gal.name}`
            )
          ),
          !isPose
            ? el("button", {
                type: "button",
                class: "icon-btn rp-inspect-close",
                title: "收起预览",
                "aria-label": "收起预览",
                onClick: () => { inspected = null; renderInspector(); },
              }, "✕")
            : el("span", { class: "badge", style: { fontSize: "10.5px", flexShrink: 0 } }, "🔒 仅本机")
        ),
        stageBox,
        strip,
        ctaBtn
      );
      return;
    }

    // Case B: Personal / official asset preview
    const item = inspected.item;
    const isSel = selectedRefs.includes(item.image);
    inspectorHost.append(
      el("div", { class: "rp-inspect-head" },
        el("div", { class: "col", style: { gap: "2px", minWidth: 0 } },
          el("strong", { class: "rp-inspect-title" }, item.name || item.id || "参考图"),
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, assetCategoryLabel(item.kind, categories))
        ),
        el("button", {
          type: "button",
          class: "icon-btn rp-inspect-close",
          title: "收起预览",
          "aria-label": "收起预览",
          onClick: () => { inspected = null; renderInspector(); },
        }, "✕")
      ),
      el("div", { class: "rp-inspect-stage" },
        el("img", { src: localImg(item.image), alt: item.name || "参考图" })
      ),
      el("button", {
        type: "button",
        class: "btn btn-sm rp-inspect-cta" + (isSel ? "" : " btn-primary"),
        onClick: () => toggleSelectPath(item.image),
      }, isSel ? "✓ 已选用（点击取消）" : "＋ 选用为参考图")
    );
  }

  // ---------- Right Selected References Dock ----------

  function renderSelectedDock() {
    clear(selectedDock);
    selectedDock.appendChild(
      el("div", { class: "rp-selected-head" },
        el("strong", { style: { fontSize: "12.5px" } }, `已选参考图 (${selectedRefs.length}/${limit})`),
        selectedRefs.length > 0
          ? el("button", {
              type: "button",
              class: "rp-link-btn",
              onClick: () => { selectedRefs = []; syncSelectionUI(); },
            }, "清空")
          : null
      )
    );

    if (!selectedRefs.length) {
      selectedDock.appendChild(
        el("div", { class: "rp-selected-empty muted" },
          "暂未选择参考图。点选左侧图片、直接拖入本地图片，或按 Ctrl/⌘ + V 粘贴。"
        )
      );
      return;
    }

    const list = el("div", { class: "rp-selected-list" });
    selectedRefs.forEach((rp, idx) => {
      const meta = itemByPath.get(rp);
      const label = meta?.name || `参考图 ${idx + 1}`;
      const sub = meta?.sourceLabel || (meta?.kind ? assetCategoryLabel(meta.kind, categories) : "本次临时参考图");
      list.appendChild(el("div", { class: "rp-selected-row" },
        el("img", { class: "rp-selected-thumb", src: localImg(rp), alt: label }),
        el("div", { class: "rp-selected-meta" },
          el("strong", { title: label }, label),
          el("span", { class: "muted" }, sub)
        ),
        el("button", {
          type: "button",
          class: "rp-selected-rm",
          title: `移除 ${label}`,
          "aria-label": `移除参考图 ${label}`,
          onClick: () => {
            selectedRefs.splice(idx, 1);
            syncSelectionUI();
          },
        }, "×")
      ));
    });
    selectedDock.appendChild(list);
  }

  function syncSelectionUI() {
    confirmBtn.textContent = `✓ 确认选用 (${selectedRefs.length}/${limit})`;
    clearBtn.disabled = selectedRefs.length === 0;
    renderSelectedDock();
    renderInspector();
    if (activeExtGallery()) {
      renderExtGrid();
    } else if (activeTab !== "upload") {
      grid.querySelectorAll(".rp-card").forEach((card) => {
        const p = card.dataset.refPath || "";
        const isSel = selectedRefs.includes(p);
        card.classList.toggle("is-selected", isSel);
        card.setAttribute("aria-pressed", String(isSel));
        const badge = card.querySelector(".rp-check-badge");
        if (badge) badge.textContent = isSel ? "✓ 已选" : "";
      });
    }
  }

  // ---------- Local Upload / Clipboard Panel ----------

  let uploadMetaRow = null;
  let uploadCatFieldset = null;
  let uploadDropBtn = null;
  let uploadStatusText = null;
  let showUploadNewCatForm = false;

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
          itemByPath.set(path, { name: fileDisplayName(f, customName, i, imgFiles.length), image: path, sourceLabel: `${sourceLabel}临时参考图` });
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
        renderAll();
      } else {
        syncSelectionUI();
      }

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
        toast("剪贴板里当前没有图片，请先截图或复制图片后再试");
        return;
      }
      await processIncomingFiles(res.files, "粘贴");
    } catch {
      toast("请直接按 Ctrl/⌘ + V 粘贴剪贴板图片");
    }
  });

  function renderUploadPanel() {
    clear(uploadHost);
    if (!categories.some((c) => c.key === uploadCategory)) {
      uploadCategory = categories[0]?.key || "character";
    }
    const catPillsWrap = el("div", { class: "ref-picker-cat-pills" });
    categories.forEach((c) => {
      const active = uploadCategory === c.key;
      const radio = el("input", {
        type: "radio",
        name: "ref-picker-upload-cat",
        value: c.key,
        checked: active,
        class: "sr-only",
      });
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        uploadCategory = c.key;
        catPillsWrap.querySelectorAll(".ref-picker-cat-pill").forEach((lbl) => {
          lbl.classList.toggle("btn-primary", lbl.dataset.catKey === c.key);
        });
      });
      catPillsWrap.appendChild(el("label", {
        class: "btn btn-sm ref-picker-cat-pill" + (active ? " btn-primary" : ""),
        dataset: { catKey: c.key },
      }, radio, el("span", null, c.label)));
    });
    catPillsWrap.appendChild(el("button", {
      type: "button",
      class: "btn btn-sm ref-picker-add-cat-btn",
      onClick: () => { showUploadNewCatForm = !showUploadNewCatForm; renderUploadPanel(); },
    }, "＋ 新建分类"));

    uploadCatFieldset = el("fieldset", { class: "ref-picker-cat-fieldset" },
      el("legend", null, "归入自建图库分类"),
      catPillsWrap,
      showUploadNewCatForm
        ? createInlineCategoryForm({
            onCreated: (created) => {
              showUploadNewCatForm = false;
              if (created?.key) uploadCategory = created.key;
              renderUploadPanel();
            },
            onCancel: () => { showUploadNewCatForm = false; renderUploadPanel(); },
          })
        : null
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

    const saveToggleRow = el("label", { class: "ref-picker-save-toggle" },
      saveToLibChk,
      el("span", null, "同时存入自建图库（默认仅作为本次临时参考图，勾选后才存入自建图库）")
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

  function renderCenter() {
    const isUpload = activeTab === "upload";
    const extGal = activeExtGallery();
    renderToolbar();
    grid.classList.toggle("hidden", isUpload);
    uploadHost.classList.toggle("hidden", !isUpload);

    if (isUpload) {
      renderUploadPanel();
    } else if (extGal) {
      renderExtGrid();
    } else {
      renderGrid();
    }
  }

  function renderAll() {
    renderRail();
    renderCenter();
    renderInspector();
    renderSelectedDock();
    confirmBtn.textContent = `✓ 确认选用 (${selectedRefs.length}/${limit})`;
    clearBtn.disabled = selectedRefs.length === 0;
  }

  // Global drag-and-drop across the entire modal workspace
  let dragDepth = 0;
  workspace.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.classList.remove("hidden");
  });
  workspace.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
  });
  workspace.addEventListener("dragleave", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.add("hidden");
  });
  workspace.addEventListener("drop", async (e) => {
    dragDepth = 0;
    dropOverlay.classList.add("hidden");
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) {
      e.preventDefault();
      await processIncomingFiles(files, "拖入");
    }
  });

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    extPageLimit = 48;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (activeExtGallery()) renderExtGrid();
      else renderGrid();
    }, 60);
  });

  const onDialogPaste = async (e) => {
    if (!dlg?.open) return;
    const files = extractClipboardImageFiles(e);
    if (!files.length) return;
    e.preventDefault();
    await processIncomingFiles(files, "粘贴");
  };

  const onDialogKeydown = (e) => {
    if (!dlg?.open) return;
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && inspected?.mode === "ext") {
      const vars = Array.isArray(inspected.item?.variants) ? inspected.item.variants : [];
      if (vars.length > 1) {
        e.preventDefault();
        const idx = vars.findIndex((v) => v.key === inspected.angleKey);
        const delta = e.key === "ArrowRight" ? 1 : -1;
        inspected.angleKey = vars[(idx + delta + vars.length) % vars.length].key;
        renderInspector();
      }
    }
  };

  const body = el("div", { class: "ref-picker-studio-body" }, localFileInput, workspace);

  const unsubEvents = onEvent((ev) => {
    if (ev?.kind === "galleries" && dlg?.open) {
      refreshGalleryMetadata(true);
    }
  });

  const dlg = showModal(title, body, [cancelBtn, confirmBtn], {
    className: "modal-picker modal-ref-picker modal-ref-picker-studio",
    flush: true,
    onClose: () => {
      clearTimeout(searchTimer);
      unsubEvents?.();
      document.removeEventListener("paste", onDialogPaste);
      document.removeEventListener("keydown", onDialogKeydown);
    },
  });
  document.addEventListener("paste", onDialogPaste);
  document.addEventListener("keydown", onDialogKeydown);

  async function refreshGalleryMetadata(reloadActiveExt = false) {
    const [galRes, packsRes] = await Promise.all([
      api("GET", "/api/galleries").catch(() => ({ galleries: [] })),
      api("GET", "/api/galleries/packs").catch(() => ({ packs: [] })),
    ]);
    extGalleries = mergeExtGalleries(galRes?.galleries || [], packsRes?.packs || []);
    if (reloadActiveExt) {
      const curGal = activeExtGallery();
      if (curGal && curGal.installed) ensureExtItemsLoaded(curGal, true);
    }
    renderRail();
    renderCenter();
  }

  renderAll();

  // Initial hydration
  Promise.all([
    fetchAssetCategories(),
    api("GET", "/api/mine/assets").catch(() => ({ items: [] })),
    api("GET", "/api/resources/assets").catch(() => ({ items: [] })),
    api("GET", "/api/galleries").catch(() => ({ galleries: [] })),
    api("GET", "/api/galleries/packs").catch(() => ({ packs: [] })),
  ]).then(([cats, mineRes, packRes, galRes, packsRes]) => {
    if (Array.isArray(cats) && cats.length) categories = cats;
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
    extGalleries = mergeExtGalleries(galRes?.galleries || [], packsRes?.packs || []);

    loading = false;
    indexItems();
    renderAll();
  });
}
