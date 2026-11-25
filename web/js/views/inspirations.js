import { api, clear, closeModal, copyText, el, localImg, onEvent, openURL, remoteThumb, showModal, toast } from "../api.js";
import { createCardSizeSwitcher, masonry } from "../masonry.js";
import { openBatchShareInspirationsModal, openInspirationRemixModal, openShareInspirationModal } from "./work-remix-modal.js";

const SOURCE_LABELS = {
  x: "X 采集",
  xiaohongshu: "小红书",
  chrome: "浏览器剪藏",
  web: "网页采集",
  local: "我的生图",
  community: "社区收藏",
  import: "手动收集",
};

const UNGROUPED_FOLDER = "__ungrouped__";
const FOLDER_PRESET_SUGGESTIONS = ["小红书封面", "公众号配图", "电商主图", "品牌提案", "待出图参考", "配色灵感"];

const viewState = {
  tab: "vault", // vault | plaza | earnings
  userPickedTab: false,
  q: "",
  folder: "", // "" = all | "__ungrouped__" | custom folder name
  tags: [], // multi-select tag intersection filter
  plazaFilter: "all:latest", // all:latest | all:popular | unlocked:latest | mine:latest
  plazaQ: "",
  batchMode: false,
  selectedIds: new Set(),
  batchPublishing: false,
  pendingRefresh: false,
};

function getShareEligibility(item) {
  if (item?.runPublishedWorkId) return { ok: false, reason: "已在社区作品上架" };
  if (item?.runIsSkill) return { ok: false, reason: "手绘配方作品请去画廊发布" };
  const hasImg = Boolean(item?.imagePath || item?.imageUrl);
  const hasPrompt = Boolean(String(item?.prompt || item?.promptZh || item?.rawText || "").trim());
  if (!hasImg) return { ok: false, reason: "缺少图片" };
  if (!hasPrompt) return { ok: false, reason: "缺少提示词" };
  return { ok: true, published: Boolean(item?.publishedId) };
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function applySlotValues(basePrompt, slots, values) {
  let out = String(basePrompt || "");
  if (!Array.isArray(slots) || !slots.length) return out;
  const extras = [];
  for (const s of slots) {
    const key = s?.key || "";
    const defVal = String(s?.defaultValue || "").trim();
    const curVal = String(values[key] ?? defVal).trim();
    if (key && out.includes(`{{${key}}}`)) {
      out = out.split(`{{${key}}}`).join(curVal || defVal);
      continue;
    }
    if (!curVal || curVal === defVal) continue;
    if (defVal && out.includes(defVal)) {
      out = out.split(defVal).join(curVal);
    } else {
      extras.push(`${s.label || key}：${curVal}`);
    }
  }
  if (extras.length) {
    out = `${out}\n\n【本次同款替换要求】${extras.join("；")}`;
  }
  return out;
}

export function openClipperSetupModal(meta = {}) {
  let curToken = meta.clipToken || "";
  let curExtDir = meta.clipExtensionDir || "";
  let curExtExists = meta.clipExtensionExists !== false;
  const ep = String(meta.clipEndpoint || location.origin)
    .replace(/\/api\/inspirations\/clip\/?$/i, "")
    .replace(/\/+$/, "");
  const portMatch = ep.match(/:(\d+)$/);
  const port = portMatch ? portMatch[1] : (location.port || "18520");
  const isDefaultPort = port === "18520";

  const tokenCode = el("code", { class: "mono insp-token-code" }, curToken || "加载中…");
  const extDirCode = el("code", {
    class: "mono",
    dataset: { role: "clip-ext-dir" },
    style: { wordBreak: "break-all" },
  }, curExtDir || "正在获取扩展目录…");

  const copyExtDirBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    dataset: { role: "clip-ext-copy" },
    disabled: !curExtDir,
    onClick: async () => {
      if (!curExtDir) return;
      toast((await copyText(curExtDir)) ? "已复制扩展文件夹路径" : "复制失败");
    },
  }, "📋 复制路径");

  const openExtDirBtn = el("button", {
    type: "button",
    class: "btn btn-sm" + (!curExtDir || !curExtExists ? " hidden" : ""),
    dataset: { role: "clip-ext-open" },
    onClick: async () => {
      if (!curExtDir) return;
      try {
        await api("POST", "/api/open", { path: curExtDir });
      } catch (e) {
        toast(e?.message || "无法打开扩展目录");
      }
    },
  }, "📂 打开文件夹");

  const syncExtDirUI = () => {
    extDirCode.textContent = curExtDir || "extensions/handraw-clipper";
    copyExtDirBtn.disabled = !curExtDir;
    openExtDirBtn.classList.toggle("hidden", !curExtDir || !curExtExists);
  };

  if (!curExtDir || !curToken) {
    api("GET", "/api/settings").then((r) => {
      if (!curToken && r?.clipToken) {
        curToken = r.clipToken;
        tokenCode.textContent = curToken;
      }
      if (!curExtDir && r?.clipExtensionDir) {
        curExtDir = r.clipExtensionDir;
        curExtExists = r.clipExtensionExists !== false;
        syncExtDirUI();
      }
    }).catch(() => {});
  }

  const body = el("div", { class: "col", style: { gap: "12px" } },
    el("p", { class: "muted", style: { margin: 0 } },
      "安装内置的「手绘风灵感捕手」Chrome / Edge 扩展后，刷 X (Twitter) 或任意网页时，点一下按钮或右键即可把图片和杂乱推文直接收进本机灵感库，并自动用 AI 提炼成可复用提示词。"
    ),
    el("div", { class: "card col", style: { gap: "8px", padding: "12px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap" } },
        el("strong", null, isDefaultPort ? "1. 本地桥接地址（与扩展默认一致，无需修改）" : "1. 本地桥接地址（默认端口被占用，已自动切换）"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => toast((await copyText(ep)) ? "已复制本地桥接地址" : "复制失败"),
        }, "复制地址")
      ),
      el("code", { class: "mono muted", style: { wordBreak: "break-all" } }, ep),
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", marginTop: "4px" } },
        el("strong", null, "2. 本机配对 Token（仅限本机扩展通信）"),
        el("div", { class: "row", style: { gap: "6px" } },
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            onClick: async () => toast((await copyText(curToken)) ? "已复制配对 Token" : "复制失败"),
          }, "📋 复制 Token"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: async () => {
              try {
                const r = await api("POST", "/api/settings/clip-token/rotate", {});
                if (r.clipToken) {
                  curToken = r.clipToken;
                  tokenCode.textContent = curToken;
                  toast("已重置配对 Token，请同步更新到浏览器扩展中");
                }
              } catch (e) { toast(e.message); }
            },
          }, "重置 Token")
        )
      ),
      tokenCode
    ),
    el("div", { class: "card col", style: { gap: "6px", padding: "12px", background: "var(--paper)" } },
      el("strong", null, "3. 如何加载 Chrome / Edge 扩展（30 秒完成）"),
      el("ol", { style: { margin: "4px 0 0", paddingLeft: "20px", fontSize: "12.5px", lineHeight: "1.7" } },
        el("li", null, "打开 Chrome / Edge，在地址栏输入 ", el("code", { class: "mono" }, "chrome://extensions"), " 并开启右上角「开发者模式」。"),
        el("li", null,
          "点击「加载已解压的扩展程序」，选择扩展文件夹：",
          el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", alignItems: "center", marginTop: "4px" } },
            extDirCode,
            copyExtDirBtn,
            openExtDirBtn
          )
        ),
        el("li", null, isDefaultPort
          ? ["点击浏览器右上角「手绘风灵感捕手」图标，扩展默认地址已是 ", el("code", { class: "mono" }, ep), "，直接粘贴上方 Token 点击「保存并测试」即可！"]
          : ["点击浏览器右上角「手绘风灵感捕手」图标，将客户端地址改为 ", el("code", { class: "mono" }, ep), " 并粘贴上方 Token，点击「保存并测试」即可！"]
        )
      )
    )
  );

  showModal("配置 Chrome 灵感捕手扩展", body, [
    el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "知道了"),
  ]);
}

export async function renderInspirations(root, ctx, params = {}) {
  let latestVaultMeta = { clipToken: "", clipEndpoint: "", clipExtensionDir: "", clipExtensionExists: false, siteBase: "", folders: [] };
  let prefetchedVaultRes = null;

  if (params.tab && ["vault", "plaza", "earnings"].includes(params.tab)) {
    viewState.tab = params.tab;
    viewState.userPickedTab = true;
  } else if (!viewState.userPickedTab) {
    const probe = await api("GET", "/api/inspirations").catch(() => null);
    if (!root.isConnected) return;
    if (probe) {
      latestVaultMeta = {
        clipToken: probe.clipToken || "",
        clipEndpoint: probe.clipEndpoint || "",
        clipExtensionDir: probe.clipExtensionDir || "",
        clipExtensionExists: probe.clipExtensionExists,
        siteBase: probe.siteBase || "",
        folders: Array.isArray(probe.folders) ? probe.folders : [],
      };
      const totalLocal = Number(probe.totalCount ?? (probe.items || []).length);
      if (totalLocal === 0) {
        viewState.tab = "plaza";
      } else {
        viewState.tab = "vault";
        if (!viewState.q && !viewState.folder && viewState.tags.length === 0) {
          prefetchedVaultRes = probe;
        }
      }
    }
  }
  clear(root);

  const tabBar = el("div", { class: "tabs" });
  const tabsDef = [
    ["vault", "我的灵感库"],
    ["plaza", "社区灵感广场"],
    ["earnings", "分享与积分收益"],
  ];

  const drawTabs = () => {
    clear(tabBar);
    tabsDef.forEach(([id, label]) => {
      tabBar.appendChild(el("button", {
        type: "button",
        class: "tab" + (viewState.tab === id ? " active" : ""),
        dataset: { tab: id },
        onClick: () => {
          if (id !== "vault" && viewState.batchMode) {
            viewState.batchMode = false;
            viewState.selectedIds.clear();
          }
          viewState.userPickedTab = true;
          viewState.tab = id;
          drawTabs();
          drawBody();
        },
      }, label));
    });
  };
  drawTabs();

  const sizeSwitcher = createCardSizeSwitcher({
    storageKey: "handraw_inspirations_size",
    host: root,
  });

  const headerActions = el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap", alignItems: "center" } },
    el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: () => openClipperSetupModal(latestVaultMeta),
    }, "🧩 Chrome 灵感捕手"),
    el("button", {
      type: "button",
      class: "btn btn-sm btn-primary",
      onClick: () => openCreateInspirationModal(ctx, () => {
        viewState.userPickedTab = true;
        if (viewState.tab !== "vault") {
          viewState.tab = "vault";
          drawTabs();
        }
        drawBody();
      }, {
        ...latestVaultMeta,
        defaultFolder: (viewState.folder && viewState.folder !== UNGROUPED_FOLDER) ? viewState.folder : "",
      }),
    }, "＋ 收集新灵感"),
    sizeSwitcher.el
  );

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row", style: { gap: "12px", flexWrap: "wrap" } },
      el("h1", { class: "page-title" }, "灵感库"),
      tabBar
    ),
    headerActions
  ));

  const stage = el("div", { class: "col", style: { gap: "14px" } });
  root.appendChild(stage);

  let vaultHandle = null;

  async function drawBody() {
    clear(stage);
    vaultHandle = null;
    if (viewState.tab === "vault") {
      const initialRes = prefetchedVaultRes;
      prefetchedVaultRes = null;
      vaultHandle = await renderVaultTab(stage, ctx, (meta) => { latestVaultMeta = meta; }, initialRes);
    } else if (viewState.tab === "plaza") {
      await renderPlazaTab(stage, ctx);
    } else {
      await renderEarningsTab(stage, ctx, () => {
        viewState.userPickedTab = true;
        viewState.tab = "vault";
        drawTabs();
        drawBody();
      });
    }
  }

  const unsub = onEvent((msg) => {
    if (!root.isConnected) {
      unsub();
      return;
    }
    if (msg.type === "inspirations" && viewState.tab === "vault") {
      if (msg.data?.clipped && msg.data?.title) {
        toast(`📌 收到来自浏览器捕手的新灵感：${msg.data.title}`);
      }
      if (viewState.batchPublishing) {
        viewState.pendingRefresh = true;
        return;
      }
      if (vaultHandle) {
        vaultHandle.reload();
      } else {
        drawBody();
      }
    }
  });

  await drawBody();
}

function openCreateInspirationModal(ctx, onCreated, clipMeta = {}) {
  let imageDataUrl = "";
  let remoteImageUrl = "";
  let imageCaption = "";
  let sourceUrl = "";
  let extractedAuthor = "";
  let extractedPlatform = "";
  let fetchedImages = [];
  let selectedFetchedIdx = -1;

  const isBareHttpUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || "").trim());
  const isDirectImageUrl = (s) => /^https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:[?#]\S*)?$/i.test(String(s || "").trim());
  const extractFirstUrl = (s) => {
    const m = String(s || "").match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/i);
    return m ? m[0] : "";
  };

  const fetchStatusEl = el("div", { class: "insp-fetch-status hidden" });
  const fetchedThumbsEl = el("div", { class: "insp-fetch-thumbs hidden" });

  const fileIn = el("input", { type: "file", accept: "image/*", class: "hidden" });
  const previewImg = el("img", { class: "insp-drop-preview", alt: "预览图", referrerpolicy: "no-referrer" });
  const previewCaptionEl = el("span", { class: "muted insp-drop-caption" }, "");
  const dropEmptyEl = el("div", { class: "insp-drop-empty" },
    el("span", { class: "muted" }, "点击选图、拖拽图片到这里，或直接按 Ctrl+V 粘贴剪贴板图片")
  );

  const titleIn = el("input", { class: "input", placeholder: "标题（可选，留空由 AI 自动起名）" });

  const syncThumbActive = () => {
    fetchedThumbsEl.querySelectorAll(".insp-fetch-thumb").forEach((btn, bi) => {
      btn.classList.toggle("is-active", bi === selectedFetchedIdx);
    });
  };

  const renderImageState = () => {
    const src = imageDataUrl || remoteImageUrl;
    const hasImg = Boolean(src);
    dropZone.classList.toggle("has-image", hasImg);
    dropEmptyEl.classList.toggle("hidden", hasImg);
    previewWrap.classList.toggle("hidden", !hasImg);
    if (hasImg) {
      previewImg.src = src;
      previewCaptionEl.textContent = imageCaption || (imageDataUrl ? "本地图片" : "远程图片");
    } else {
      previewImg.removeAttribute("src");
      previewCaptionEl.textContent = "";
    }
    syncThumbActive();
  };

  const clearDirectImgStatus = () => {
    if (fetchStatusEl.dataset.kind === "direct-image") {
      delete fetchStatusEl.dataset.kind;
      clear(fetchStatusEl);
      fetchStatusEl.className = "insp-fetch-status hidden";
    }
  };

  const clearPickedImage = (e) => {
    e?.stopPropagation?.();
    imageDataUrl = "";
    remoteImageUrl = "";
    imageCaption = "";
    selectedFetchedIdx = -1;
    fileIn.value = "";
    clearDirectImgStatus();
    renderImageState();
  };

  const setPickedImage = async (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      imageDataUrl = await readFileAsDataURL(file);
      remoteImageUrl = "";
      selectedFetchedIdx = -1;
      imageCaption = file.name ? `本地图：${file.name}` : "剪贴板图片";
      clearDirectImgStatus();
      renderImageState();
    } catch (e) { toast(e.message); }
  };

  const setRemoteImage = (url, caption = "远程图片", fetchedIdx = -1) => {
    const clean = String(url || "").trim();
    imageDataUrl = "";
    fileIn.value = "";
    remoteImageUrl = clean;
    selectedFetchedIdx = fetchedIdx;
    imageCaption = clean ? caption : "";
    renderImageState();
  };

  const replaceImgBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    dataset: { role: "insp-img-replace" },
    onClick: (e) => {
      e.stopPropagation();
      fileIn.click();
    },
  }, "更换");

  const removeImgBtn = el("button", {
    type: "button",
    class: "btn btn-sm insp-drop-remove-btn",
    dataset: { role: "insp-img-remove" },
    title: "删除当前图片",
    onClick: clearPickedImage,
  }, "✕ 删除");

  const previewWrap = el("div", { class: "insp-drop-filled hidden" },
    el("div", { class: "insp-drop-preview-box" }, previewImg),
    el("div", { class: "row insp-drop-toolbar" },
      previewCaptionEl,
      el("div", { class: "row", style: { gap: "6px", flexShrink: "0" } }, replaceImgBtn, removeImgBtn)
    )
  );

  fileIn.addEventListener("change", () => {
    if (fileIn.files?.[0]) setPickedImage(fileIn.files[0]);
  });

  const dropZone = el("div", {
    class: "insp-dropzone",
    tabindex: "0",
    onClick: () => {
      if (!dropZone.classList.contains("has-image")) {
        fileIn.click();
      }
    },
  }, dropEmptyEl, previewWrap, fileIn);
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("is-drag"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-drag"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("is-drag");
    const f = e.dataTransfer?.files?.[0];
    if (f) setPickedImage(f);
  });

  const rawTextIn = el("textarea", {
    class: "input",
    rows: 6,
    placeholder: "粘贴提示词或推文原文；也可直接粘贴 X / 网页链接自动抓取，或粘贴图片直链载入预览…",
  });
  const parseInlineBtn = el("button", {
    type: "button",
    class: "btn btn-sm hidden",
    dataset: { role: "insp-parse-inline" },
  }, "⚡ 解析链接");
  const sourceChipEl = el("div", { class: "insp-source-chip hidden" });
  const autoOrgChk = el("input", { type: "checkbox", checked: true });
  let sourceUrlIn = null;

  const renderSourceChip = () => {
    clear(sourceChipEl);
    if (sourceUrlIn && sourceUrlIn.value.trim() !== sourceUrl) {
      sourceUrlIn.value = sourceUrl || "";
    }
    if (!sourceUrl) {
      sourceChipEl.classList.add("hidden");
      return;
    }
    sourceChipEl.classList.remove("hidden");
    const shortUrl = sourceUrl.replace(/^https?:\/\//i, "").slice(0, 46);
    sourceChipEl.append(
      el("span", { class: "muted", style: { fontSize: "11.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        `🔗 来源：${shortUrl}${sourceUrl.length > 54 ? "…" : ""}`
      ),
      el("button", {
        type: "button",
        class: "insp-source-clear",
        title: "清除来源链接",
        onClick: () => {
          sourceUrl = "";
          extractedPlatform = "";
          extractedAuthor = "";
          renderSourceChip();
        },
      }, "✕")
    );
  };

  const syncInlineParseBtn = () => {
    const found = extractFirstUrl(rawTextIn.value);
    if (found && !isFetching) {
      parseInlineBtn.classList.remove("hidden");
      parseInlineBtn.textContent = isDirectImageUrl(found) ? "🖼 载入图片链接" : "⚡ 解析链接";
    } else if (!isFetching) {
      parseInlineBtn.classList.add("hidden");
    }
  };

  const renderFetchedThumbs = () => {
    clear(fetchedThumbsEl);
    if (!fetchedImages.length) {
      fetchedThumbsEl.classList.add("hidden");
      return;
    }
    const applySelectedImage = (idx) => {
      const u = fetchedImages[idx] || "";
      if (!u) return;
      const caption = fetchedImages.length > 1
        ? `已选第 ${idx + 1}/${fetchedImages.length} 张原图`
        : "已自动获取原图封面";
      setRemoteImage(u, caption, idx);
    };
    if (fetchedImages.length > 1) {
      fetchedThumbsEl.classList.remove("hidden");
      fetchedThumbsEl.appendChild(el("span", { class: "muted", style: { fontSize: "11.5px", width: "100%" } }, `抓取到 ${fetchedImages.length} 张原图（点击切换封面）：`));
      fetchedImages.forEach((u, idx) => {
        fetchedThumbsEl.appendChild(el("button", {
          type: "button",
          class: "insp-fetch-thumb" + (idx === selectedFetchedIdx ? " is-active" : ""),
          title: `选用第 ${idx + 1} 张原图`,
          onClick: () => applySelectedImage(idx),
        }, el("img", { src: u, alt: `图 ${idx + 1}`, referrerpolicy: "no-referrer" })));
      });
    } else {
      fetchedThumbsEl.classList.add("hidden");
    }
    applySelectedImage(0);
  };

  let isFetching = false;
  const runFetchUrl = async (explicitUrl, { clearRawIfBare = false } = {}) => {
    const target = String(explicitUrl ?? extractFirstUrl(rawTextIn.value)).trim();
    if (!target || !isBareHttpUrl(target)) {
      toast("未检测到完整的 http:// 或 https:// 链接");
      return;
    }
    if (isDirectImageUrl(target)) {
      fetchedImages = [];
      fetchedThumbsEl.classList.add("hidden");
      clear(fetchStatusEl);
      fetchStatusEl.dataset.kind = "direct-image";
      fetchStatusEl.className = "insp-fetch-status is-ok";
      fetchStatusEl.appendChild(el("span", null, "✓ 已识别图片直链并载入上方预览"));
      setRemoteImage(target, "远程图片链接", -1);
      if (clearRawIfBare || rawTextIn.value.trim() === target) {
        rawTextIn.value = "";
      }
      syncInlineParseBtn();
      return;
    }
    if (isFetching) return;
    isFetching = true;
    parseInlineBtn.disabled = true;
    parseInlineBtn.classList.remove("hidden");
    parseInlineBtn.textContent = "解析中…";
    clear(fetchStatusEl);
    fetchStatusEl.className = "insp-fetch-status";
    fetchStatusEl.appendChild(el("span", { class: "muted" }, "正在抓取原文与高清原图…"));

    try {
      const res = await api("POST", "/api/inspirations/fetch-url", { url: target });
      const ext = res.extracted || {};
      extractedPlatform = ext.platform || "";
      extractedAuthor = ext.author || "";
      sourceUrl = ext.sourceUrl || target;
      renderSourceChip();

      if (ext.text) {
        rawTextIn.value = ext.text;
      } else if (clearRawIfBare && rawTextIn.value.trim() === target) {
        rawTextIn.value = "";
      }
      if (ext.title && !titleIn.value.trim()) {
        titleIn.value = ext.title;
      }

      fetchedImages = Array.isArray(ext.images) ? ext.images.filter(Boolean) : [];
      selectedFetchedIdx = fetchedImages.length ? 0 : -1;
      renderFetchedThumbs();

      clear(fetchStatusEl);
      if (ext.needClipper) {
        fetchStatusEl.className = "insp-fetch-status is-warn";
        fetchStatusEl.append(
          el("span", null, ext.warning || "该平台受登录态或防爬限制，建议用「Chrome 灵感捕手」一键剪藏。"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            style: { alignSelf: "flex-start" },
            onClick: () => {
              closeModal();
              openClipperSetupModal(clipMeta);
            },
          }, "🧩 配置 Chrome 灵感捕手")
        );
      } else {
        fetchStatusEl.className = "insp-fetch-status is-ok";
        const platformName = SOURCE_LABELS[ext.platform] || ext.platform || "网页";
        const parts = [`✓ 已解析（${ext.adapter || platformName}）`];
        if (ext.author) parts.push(`作者 ${ext.author}`);
        if (fetchedImages.length) parts.push(`${fetchedImages.length} 张原图`);
        fetchStatusEl.appendChild(el("span", null, parts.join(" · ")));
        if (ext.warning) {
          fetchStatusEl.appendChild(el("span", { class: "muted", style: { fontSize: "11.5px" } }, ext.warning));
        }
      }
    } catch (e) {
      sourceUrl = target;
      renderSourceChip();
      clear(fetchStatusEl);
      fetchStatusEl.className = "insp-fetch-status is-warn";
      fetchStatusEl.appendChild(el("span", null, e?.message || "解析失败，可改用「Chrome 灵感捕手」或直接手动粘贴内容"));
    } finally {
      isFetching = false;
      parseInlineBtn.disabled = false;
      syncInlineParseBtn();
    }
  };

  parseInlineBtn.addEventListener("click", () => runFetchUrl(extractFirstUrl(rawTextIn.value), { clearRawIfBare: true }));
  rawTextIn.addEventListener("input", syncInlineParseBtn);
  rawTextIn.addEventListener("paste", (e) => {
    const pasted = (e.clipboardData?.getData("text") || "").trim();
    const curVal = rawTextIn.value.trim();
    const replacingAll = !curVal || (rawTextIn.selectionStart === 0 && rawTextIn.selectionEnd === rawTextIn.value.length);
    if (isDirectImageUrl(pasted) && replacingAll) {
      e.preventDefault();
      runFetchUrl(pasted, { clearRawIfBare: true });
      return;
    }
    if (isBareHttpUrl(pasted) && replacingAll) {
      e.preventDefault();
      rawTextIn.value = pasted;
      runFetchUrl(pasted, { clearRawIfBare: true });
    }
  });

  const onPaste = (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type?.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          setPickedImage(f);
          break;
        }
      }
    }
  };
  document.addEventListener("paste", onPaste);

  const cleanup = () => {
    document.removeEventListener("paste", onPaste);
  };

  sourceUrlIn = el("input", {
    class: "input",
    type: "url",
    placeholder: "来源链接（选填，粘贴网络链接收录时自动保留，分享解锁后可见）",
  });
  sourceUrlIn.addEventListener("input", () => {
    const v = sourceUrlIn.value.trim();
    if (/^https?:\/\//i.test(v)) sourceUrl = v;
    else if (!v) sourceUrl = "";
  });

  const extractFirstHttpUrl = (txt) => {
    const m = String(txt || "").match(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi) || [];
    for (const raw of m) {
      const cleaned = raw.replace(/[.,;:!?)\]}'"]+$/g, "");
      if (!isDirectImageUrl(cleaned)) return cleaned;
    }
    return "";
  };

  const availFolders = Array.isArray(clipMeta.folders) ? clipMeta.folders.filter(Boolean) : [];
  const initFolder = (clipMeta.defaultFolder && clipMeta.defaultFolder !== UNGROUPED_FOLDER) ? clipMeta.defaultFolder : "";
  const folderOpts = Array.from(new Set(initFolder ? [initFolder, ...availFolders] : availFolders));
  const folderSel = el("select", { class: "input insp-create-folder-sel", "aria-label": "所属分组" },
    el("option", { value: "" }, "未分组"),
    ...folderOpts.map((f) => el("option", { value: f, selected: f === initFolder }, f))
  );
  if (initFolder) folderSel.value = initFolder;

  const titleAndFolderRow = folderOpts.length > 0
    ? el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        el("div", { style: { flex: "1 1 220px", minWidth: 0 } }, titleIn),
        folderSel
      )
    : titleIn;

  const body = el("div", { class: "col insp-create-form", style: { gap: "12px" } },
    el("div", { class: "col", style: { gap: "8px" } },
      dropZone,
      fetchedThumbsEl
    ),
    el("div", { class: "field" },
      el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "8px" } },
        el("label", { style: { margin: 0 } }, "提示词 / 原文 / 链接"),
        parseInlineBtn
      ),
      rawTextIn,
      sourceChipEl,
      fetchStatusEl
    ),
    sourceUrlIn,
    titleAndFolderRow,
    el("label", { class: "row", style: { cursor: "pointer", fontSize: "12.5px", alignItems: "center" } },
      autoOrgChk,
      el("span", null, "✨ 保存后用 AI 自动整理（去杂讯、中文翻译、提炼变量与标签）")
    )
  );

  const saveBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    onClick: async () => {
      let rawTxt = rawTextIn.value.trim();
      if (!imageDataUrl && !remoteImageUrl && isDirectImageUrl(rawTxt)) {
        remoteImageUrl = rawTxt;
        rawTxt = "";
      }
      const typedSrc = sourceUrlIn.value.trim();
      const effectiveSrc = (/^https?:\/\//i.test(typedSrc) ? typedSrc : "")
        || sourceUrl
        || (isBareHttpUrl(rawTxt) && !isDirectImageUrl(rawTxt) ? rawTxt : "")
        || extractFirstHttpUrl(rawTxt);
      if (!imageDataUrl && !remoteImageUrl && !rawTxt && !effectiveSrc) {
        toast("请粘贴图片、输入提示词，或直接粘贴链接");
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = autoOrgChk.checked ? "正在保存并 AI 整理…" : "正在保存…";
      try {
        const inferredSource = extractedPlatform
          || (/x\.com|twitter\.com/i.test(effectiveSrc) ? "x" : (/xiaohongshu\.com|xhslink\.com/i.test(effectiveSrc) ? "xiaohongshu" : "import"));
        const res = await api("POST", "/api/inspirations", {
          title: titleIn.value.trim(),
          folder: folderSel.value || "",
          imageDataUrl,
          imageUrl: imageDataUrl ? "" : remoteImageUrl,
          rawText: rawTxt,
          prompt: rawTxt,
          source: inferredSource,
          sourceUrl: effectiveSrc,
          sourceAuthor: extractedAuthor,
          autoOrganize: autoOrgChk.checked,
        });
        closeModal();
        toast(res.item?.aiOrganized ? "已保存并完成 AI 整理！" : "已收进灵感库");
        onCreated?.(res.item);
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = "收进灵感库";
        toast(e?.message || "保存失败");
      }
    },
  }, "收进灵感库");

  showModal("收集新灵感", body, [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
    saveBtn,
  ], { className: "modal-create-insp", onClose: cleanup });
}

function openCreateFolderModal(existingFolders, onCreated) {
  const existingSet = new Set(Array.isArray(existingFolders) ? existingFolders : []);
  const nameIn = el("input", {
    class: "input",
    placeholder: "输入分组名，例如：小红书封面、茶饮提案、水彩参考",
    maxlength: "40",
  });
  const suggestions = FOLDER_PRESET_SUGGESTIONS.filter((s) => !existingSet.has(s));

  const submit = async () => {
    const name = nameIn.value.trim();
    if (!name) {
      toast("请输入分组名称");
      nameIn.focus();
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "创建中…";
    try {
      const res = await api("POST", "/api/inspirations/folders", { name });
      closeModal();
      toast(`已新建分组「${res.name || name}」`);
      onCreated?.(res.name || name);
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = "创建分组";
      toast(e?.message || "创建分组失败");
    }
  };

  nameIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });

  const saveBtn = el("button", { type: "button", class: "btn btn-primary", onClick: submit }, "创建分组");
  const body = el("div", { class: "col", style: { gap: "12px" } },
    el("div", { class: "field" },
      el("label", null, "分组名称"),
      nameIn
    ),
    suggestions.length
      ? el("div", { class: "col", style: { gap: "6px" } },
          el("span", { class: "muted", style: { fontSize: "12px" } }, "常用灵感分组（点击快捷填入）："),
          el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
            ...suggestions.map((s) => el("button", {
              type: "button",
              class: "pill-btn",
              onClick: () => {
                nameIn.value = s;
                nameIn.focus();
              },
            }, `＋ ${s}`))
          )
        )
      : null
  );

  showModal("新建分组", body, [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
    saveBtn,
  ], { className: "modal-folder-manage" });
  setTimeout(() => nameIn.focus(), 30);
}

function openManageFoldersModal(initialFolderItems, onChanged) {
  let items = Array.isArray(initialFolderItems) ? initialFolderItems.map((x) => ({ ...x })) : [];
  let editingName = "";

  const newIn = el("input", {
    class: "input",
    placeholder: "新建分组名称…",
    maxlength: "40",
    style: { flex: "1", minWidth: "0" },
  });
  const listEl = el("div", { class: "col insp-folder-mgr-list" });

  const addFolder = async () => {
    const name = newIn.value.trim();
    if (!name) return;
    addBtn.disabled = true;
    try {
      const res = await api("POST", "/api/inspirations/folders", { name });
      newIn.value = "";
      items.push({ name: res.name || name, count: 0 });
      renderList();
      onChanged?.();
      toast(`已新建分组「${res.name || name}」`);
    } catch (e) {
      toast(e?.message || "创建失败");
    } finally {
      addBtn.disabled = false;
    }
  };

  newIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFolder();
    }
  });
  const addBtn = el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: addFolder }, "＋ 新建");

  const renderList = () => {
    clear(listEl);
    if (!items.length) {
      listEl.appendChild(el("div", { class: "muted", style: { padding: "18px 8px", textAlign: "center" } }, "还没有自定义分组，可以在上方新建一个。"));
      return;
    }
    items.forEach((f) => {
      if (editingName === f.name) {
        const editIn = el("input", { class: "input", value: f.name, maxlength: "40", style: { flex: "1", minWidth: "0" } });
        const doSave = async () => {
          const next = editIn.value.trim();
          if (!next || next === f.name) {
            editingName = "";
            renderList();
            return;
          }
          try {
            const res = await api("PATCH", "/api/inspirations/folders", { oldName: f.name, newName: next });
            const renamed = res.newName || next;
            if (viewState.folder === f.name) viewState.folder = renamed;
            f.name = renamed;
            editingName = "";
            renderList();
            onChanged?.();
            toast(`已重命名为「${renamed}」`);
          } catch (e) {
            toast(e?.message || "重命名失败");
          }
        };
        editIn.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); doSave(); }
          if (e.key === "Escape") { editingName = ""; renderList(); }
        });
        listEl.appendChild(el("div", { class: "insp-folder-mgr-row", dataset: { folder: f.name } },
          editIn,
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: doSave }, "保存"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { editingName = ""; renderList(); } }, "取消")
        ));
        setTimeout(() => { editIn.focus(); editIn.select(); }, 20);
        return;
      }

      listEl.appendChild(el("div", { class: "insp-folder-mgr-row", dataset: { folder: f.name } },
        el("div", { class: "row", style: { gap: "8px", flex: "1", minWidth: "0", alignItems: "center" } },
          el("span", { class: "insp-folder-mgr-name", title: f.name }, f.name),
          el("span", { class: "muted", style: { fontSize: "12px", flexShrink: "0" } }, `${f.count || 0} 条`)
        ),
        el("div", { class: "row", style: { gap: "6px", flexShrink: "0" } },
          el("button", {
            type: "button",
            class: "btn btn-sm",
            dataset: { role: "folder-rename-btn" },
            onClick: () => {
              editingName = f.name;
              renderList();
            },
          }, "重命名"),
          el("button", {
            type: "button",
            class: "btn btn-sm insp-drop-remove-btn",
            dataset: { role: "folder-delete-btn" },
            onClick: async () => {
              try {
                await api("DELETE", `/api/inspirations/folders?name=${encodeURIComponent(f.name)}`);
                if (viewState.folder === f.name) viewState.folder = "";
                items = items.filter((x) => x.name !== f.name);
                renderList();
                onChanged?.();
                toast(`已删除分组「${f.name}」，原有灵感已移回未分组`);
              } catch (e) {
                toast(e?.message || "删除分组失败");
              }
            },
          }, "删除")
        )
      ));
    });
  };
  renderList();

  const body = el("div", { class: "col", style: { gap: "12px" } },
    el("div", { class: "row", style: { gap: "8px" } }, newIn, addBtn),
    el("span", { class: "muted", style: { fontSize: "12px" } }, "删除分组不会删除里面的图片和提示词，它们会自动回到「未分组」。"),
    listEl
  );

  showModal("管理分组", body, [
    el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "完成"),
  ], { className: "modal-folder-manage" });
}

function openBatchMoveFolderModal(ids, folderItems, onMoved) {
  if (!Array.isArray(ids) || !ids.length) return;
  let picked = "";
  const list = Array.isArray(folderItems) ? folderItems : [];
  const newFolderIn = el("input", {
    class: "input",
    placeholder: "或直接输入新分组名称（自动创建并移入）",
    maxlength: "40",
  });

  const optButtons = [];
  const syncSelection = () => {
    optButtons.forEach(({ val, btn }) => {
      btn.classList.toggle("is-active", !newFolderIn.value.trim() && picked === val);
    });
  };
  newFolderIn.addEventListener("input", syncSelection);

  const optsWrap = el("div", { class: "col insp-folder-mgr-list" });
  const addOpt = (val, label, countText) => {
    const btn = el("button", {
      type: "button",
      class: "insp-folder-pick-btn",
      dataset: { folder: val },
      onClick: () => {
        newFolderIn.value = "";
        picked = val;
        syncSelection();
      },
    },
      el("span", null, label),
      countText ? el("span", { class: "muted", style: { fontSize: "12px" } }, countText) : null
    );
    optButtons.push({ val, btn });
    optsWrap.appendChild(btn);
  };

  addOpt("", "未分组（移除所属分组）", "");
  list.forEach((f) => addOpt(f.name, f.name, `${f.count || 0} 条`));
  if (list.length > 0) picked = list[0].name;
  syncSelection();

  const submitBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    dataset: { role: "batch-move-confirm" },
    onClick: async () => {
      const targetFolder = newFolderIn.value.trim() || picked;
      submitBtn.disabled = true;
      submitBtn.textContent = "移动中…";
      try {
        const res = await api("POST", "/api/inspirations/batch-folder", {
          ids,
          folder: targetFolder,
        });
        closeModal();
        toast(targetFolder
          ? `已将 ${res.updatedCount || ids.length} 项移入「${targetFolder}」`
          : `已将 ${res.updatedCount || ids.length} 项移回未分组`);
        onMoved?.(targetFolder);
      } catch (e) {
        submitBtn.disabled = false;
        submitBtn.textContent = "确认移入";
        toast(e?.message || "移动失败");
      }
    },
  }, "确认移入");

  const body = el("div", { class: "col", style: { gap: "10px" } },
    el("span", { class: "muted", style: { fontSize: "12.5px" } }, `为已选的 ${ids.length} 条灵感选择目标分组：`),
    optsWrap,
    el("div", { class: "field" },
      el("label", null, "或新建分组并移入"),
      newFolderIn
    )
  );

  showModal(`移入分组 (${ids.length} 项)`, body, [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
    submitBtn,
  ], { className: "modal-folder-manage" });
}

function openLocalInspirationDetail(item, ctx, onChanged, availableFolders = []) {
  let cur = { ...item };
  let foldersList = Array.isArray(availableFolders) ? [...availableFolders] : [];
  if (cur.folder && !foldersList.includes(cur.folder)) foldersList.push(cur.folder);
  let showZh = false;

  const renderModal = () => {
    const slots = Array.isArray(cur.slots) ? cur.slots : [];
    const slotValues = {};
    slots.forEach((s) => { if (s?.key) slotValues[s.key] = s.defaultValue || ""; });

    const imgSrc = cur.imagePath ? localImg(cur.imagePath) : (cur.imageUrl ? remoteThumb(cur.imageUrl, 760) : "");
    const promptDisplay = el("div", { class: "insp-prompt-text" }, "");
    const updatePrompt = () => {
      const base = (showZh && cur.promptZh) ? cur.promptZh : (cur.prompt || cur.promptZh || cur.rawText || "");
      promptDisplay.textContent = applySlotValues(base, slots, slotValues);
    };
    updatePrompt();

    const orgBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: async () => {
        orgBtn.disabled = true;
        orgBtn.textContent = "✨ AI 整理中…";
        try {
          const r = await api("POST", `/api/inspirations/${encodeURIComponent(cur.id)}/organize`, {});
          if (r.item) {
            cur = r.item;
            toast("AI 已提炼干净提示词、中文版与可替换变量！");
            onChanged?.();
            renderModal();
          }
        } catch (e) {
          orgBtn.disabled = false;
          orgBtn.textContent = "✨ AI 一键整理";
          toast(e?.message || "AI 整理失败");
        }
      },
    }, cur.aiOrganized ? "✨ 重新 AI 整理" : "✨ AI 一键整理");

    const langBtn = cur.promptZh && cur.prompt && cur.promptZh !== cur.prompt
      ? el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => {
            showZh = !showZh;
            langBtn.textContent = showZh ? "看原版提示词" : "看中文理解版";
            updatePrompt();
          },
        }, showZh ? "看原版提示词" : "看中文理解版")
      : null;

    const slotsEl = slots.length
      ? el("div", { class: "insp-slots-box col" },
          el("span", { class: "muted", style: { fontSize: "12px" } }, "✨ AI 提炼的同款可替换变量（改完直接点下方做同款）："),
          el("div", { class: "insp-slots-grid" },
            ...slots.map((s) => {
              const inp = el("input", { class: "input", value: slotValues[s.key] || "", placeholder: s.defaultValue || s.label });
              inp.addEventListener("input", () => {
                slotValues[s.key] = inp.value;
                updatePrompt();
              });
              return el("label", { class: "insp-slot-field" },
                el("span", { class: "muted" }, s.label || s.key),
                inp
              );
            })
          )
        )
      : null;

    // Interactive Folder selector + Tag editor (#99)
    const folderSel = el("select", {
      class: "input insp-detail-folder-select",
      dataset: { role: "detail-folder-select" },
      "aria-label": "所属分组",
    },
      el("option", { value: "" }, "未分组"),
      ...foldersList.map((f) => el("option", { value: f, selected: cur.folder === f }, f)),
      el("option", { value: "__new__" }, "＋ 新建分组…")
    );
    folderSel.value = cur.folder || "";

    const newFolderRow = el("div", { class: "row hidden", style: { gap: "6px", flex: "1", minWidth: "180px" } });
    const newFolderIn = el("input", { class: "input", placeholder: "输入新分组名…", maxlength: "40", style: { flex: "1", minWidth: "0" } });
    const createAndAssignFolder = async () => {
      const name = newFolderIn.value.trim();
      if (!name) return;
      try {
        const r = await api("PATCH", `/api/inspirations/${encodeURIComponent(cur.id)}`, { folder: name });
        if (r.item) {
          cur = r.item;
          if (!foldersList.includes(cur.folder)) foldersList.push(cur.folder);
          toast(`已移入分组「${cur.folder}」`);
          onChanged?.();
          renderModal();
        }
      } catch (e) { toast(e?.message || "分组保存失败"); }
    };
    newFolderIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); createAndAssignFolder(); }
      if (e.key === "Escape") { newFolderRow.classList.add("hidden"); folderSel.value = cur.folder || ""; }
    });
    newFolderRow.append(
      newFolderIn,
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: createAndAssignFolder }, "确定"),
      el("button", { type: "button", class: "btn btn-sm", onClick: () => { newFolderRow.classList.add("hidden"); folderSel.value = cur.folder || ""; } }, "取消")
    );

    folderSel.addEventListener("change", async () => {
      if (folderSel.value === "__new__") {
        newFolderRow.classList.remove("hidden");
        newFolderIn.value = "";
        newFolderIn.focus();
        return;
      }
      newFolderRow.classList.add("hidden");
      const nextFolder = folderSel.value;
      try {
        const r = await api("PATCH", `/api/inspirations/${encodeURIComponent(cur.id)}`, { folder: nextFolder });
        if (r.item) {
          cur = r.item;
          toast(nextFolder ? `已移入「${nextFolder}」` : "已移回未分组");
          onChanged?.();
        }
      } catch (e) {
        folderSel.value = cur.folder || "";
        toast(e?.message || "修改分组失败");
      }
    });

    const addTagIn = el("input", {
      class: "input insp-detail-tag-input",
      placeholder: "＋ 加标签，回车添加",
      dataset: { role: "detail-tag-input" },
    });
    const saveTags = async (nextTags) => {
      try {
        const r = await api("PATCH", `/api/inspirations/${encodeURIComponent(cur.id)}`, { tags: nextTags });
        if (r.item) {
          cur = r.item;
          onChanged?.();
          renderModal();
        }
      } catch (e) { toast(e?.message || "更新标签失败"); }
    };
    addTagIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const raw = addTagIn.value.trim();
        if (!raw) return;
        const added = raw.split(/[,，、\s]+/).map((s) => s.replace(/^#/, "").trim()).filter(Boolean);
        if (!added.length) return;
        const merged = [...(cur.tags || []), ...added];
        saveTags(merged);
      }
    });

    const organizeBar = el("div", { class: "insp-detail-org-box col" },
      el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap", alignItems: "center" } },
        el("span", { class: "muted", style: { fontSize: "12px", flexShrink: "0" } }, "分组"),
        folderSel,
        newFolderRow
      ),
      el("div", { class: "row", style: { gap: "5px", flexWrap: "wrap", alignItems: "center" } },
        el("span", { class: "muted", style: { fontSize: "12px", flexShrink: "0" } }, "标签"),
        ...(cur.tags || []).map((t) => el("span", { class: "badge insp-detail-tag-chip" },
          `#${t}`,
          el("button", {
            type: "button",
            class: "insp-detail-tag-del",
            title: `移除 #${t}`,
            "aria-label": `移除标签 ${t}`,
            onClick: () => saveTags((cur.tags || []).filter((x) => x !== t)),
          }, "×")
        )),
        addTagIn
      )
    );

    const body = el("div", { class: "insp-modal-layout" },
      el("div", { class: "insp-modal-media" },
        imgSrc ? el("img", { src: imgSrc, alt: cur.title || "", class: "insp-modal-img" }) : el("div", { class: "muted" }, "纯文字提示词灵感")
      ),
      el("div", { class: "insp-modal-info col" },
        el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start", gap: "8px" } },
          el("div", { class: "col", style: { gap: "4px" } },
            el("h3", { style: { margin: 0, fontSize: "17px" } }, cur.title || "未命名灵感"),
            el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
              el("span", { class: "badge" }, SOURCE_LABELS[cur.source] || cur.source || "灵感"),
              cur.aiOrganized ? el("span", { class: "badge badge-ok" }, "✨ AI 已整理") : null,
              cur.suggestedStyle ? el("span", { class: "badge badge-accent" }, `推荐画风 ${cur.suggestedStyle}`) : null,
              cur.publishedId ? el("span", { class: "badge badge-ok" }, cur.publishedPrice > 0 ? `已分享 · ${cur.publishedPrice} 积分解锁` : "已公开分享") : null,
              cur.sourceAuthor ? el("span", { class: "muted" }, `来源：${cur.sourceAuthor}`) : null
            )
          ),
          cur.sourceUrl ? el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(cur.sourceUrl) }, "原帖 ↗") : null
        ),
        organizeBar,
        el("div", { class: "insp-prompt-box" },
          el("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "6px", flexWrap: "wrap", gap: "6px" } },
            el("strong", { style: { fontSize: "12.5px" } }, "提示词内容"),
            el("div", { class: "row", style: { gap: "6px" } },
              orgBtn,
              langBtn,
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: async () => toast((await copyText(promptDisplay.textContent)) ? "提示词已复制" : "复制失败"),
              }, "📋 复制")
            )
          ),
          promptDisplay
        ),
        slotsEl,
        el("div", { class: "insp-remix-actions col" },
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => {
              const finalPrompt = promptDisplay.textContent;
              const hasSkill = Boolean(cur.suggestedStyle || cur.recipe?.styleIds?.length || cur.recipe?.layoutId);
              closeModal();
              ctx.go("create", {
                directPrompt: !hasSkill,
                forkOf: hasSkill ? (cur.workId || "") : "",
                forkTitle: cur.title || "",
                style: hasSkill ? (cur.suggestedStyle || cur.recipe?.styleIds?.[0] || "") : "",
                recipe: hasSkill ? (cur.recipe || (cur.suggestedStyle ? { styleIds: [cur.suggestedStyle] } : {})) : undefined,
                theme: finalPrompt,
              });
            },
          }, "✨ 一键带入生图工作台做同款"),
          el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
            el("button", {
              type: "button",
              class: "btn",
              style: { flex: "1" },
              onClick: () => {
                const finalPrompt = promptDisplay.textContent;
                const hasSkill = Boolean(cur.suggestedStyle || cur.recipe?.styleIds?.length || cur.recipe?.layoutId);
                closeModal();
                ctx.go("chat", {
                  directPrompt: !hasSkill,
                  prompt: hasSkill
                    ? `请参考这份灵感提示词帮我画一张同款：\n${finalPrompt}`
                    : finalPrompt,
                });
              },
            }, "💬 带入聊天改写"),
            el("button", {
              type: "button",
              class: "btn btn-accent-soft",
              style: { flex: "1" },
              onClick: () => openShareInspirationModal(cur, ctx, () => onChanged?.()),
            }, cur.publishedId ? "☁ 更新/再分享" : "☁ 分享到社区赚积分")
          )
        )
      )
    );

    showModal("灵感详情", body, [
      el("button", {
        type: "button",
        class: "btn btn-danger",
        style: { marginRight: "auto" },
        onClick: async () => {
          try {
            await api("DELETE", `/api/inspirations/${encodeURIComponent(cur.id)}`);
            closeModal();
            toast("已从灵感库删除");
            onChanged?.();
          } catch (e) { toast(e.message); }
        },
      }, "删除"),
      cur.publishedUrl ? el("button", { type: "button", class: "btn", onClick: () => openURL(cur.publishedUrl) }, "查看社区页 ↗") : null,
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    ].filter(Boolean));
  };

  renderModal();
}

function createSvgEl(svgMarkup) {
  const wrap = document.createElement("span");
  wrap.className = "insp-btn-icon";
  wrap.setAttribute("aria-hidden", "true");
  wrap.innerHTML = svgMarkup;
  return wrap;
}

const SEARCH_ICON_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="5.5"/><path d="m13.5 13.5 3.5 3.5"/></svg>';
const TAG_ICON_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9.8V4.5a1 1 0 0 1 1-1h5.3a1 1 0 0 1 .7.3l6.2 6.2a1 1 0 0 1 0 1.4l-5.3 5.3a1 1 0 0 1-1.4 0L3.8 10.5a1 1 0 0 1-.3-.7Z"/><circle cx="7.2" cy="7.2" r="1" fill="currentColor" stroke="none"/></svg>';
const BATCH_SHARE_ICON_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="10" height="10" rx="2.2"/><path d="m6 9 1.8 1.8L10.8 7.6"/><path d="M7.5 16.5h7.3a2.2 2.2 0 0 0 2.2-2.2V7"/></svg>';
const CLOSE_BATCH_ICON_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5.5 5.5 14.5 14.5M14.5 5.5 5.5 14.5"/></svg>';

async function renderVaultTab(stage, ctx, onMeta, initialRes = null) {
  const searchIn = el("input", {
    class: "insp-search-input",
    type: "search",
    value: viewState.q,
    placeholder: "搜标题、提示词、作者、标签…",
    "aria-label": "搜索个人灵感库",
  });
  const searchWrap = el("div", { class: "insp-search-box" },
    createSvgEl(SEARCH_ICON_SVG),
    searchIn
  );

  // Fine-grained tag picker popover (keeps main view clean even with hundreds of tags #95)
  const tagTriggerLabel = el("span", { class: "insp-tag-trigger-label" }, "标签");
  const tagTriggerCount = el("span", { class: "insp-tag-trigger-count" }, "0");
  const tagTriggerBtn = el("button", {
    type: "button",
    class: "btn btn-sm insp-tag-trigger hidden",
    dataset: { role: "tag-popover-trigger" },
    "aria-expanded": "false",
    "aria-haspopup": "dialog",
  },
    createSvgEl(TAG_ICON_SVG),
    tagTriggerLabel,
    tagTriggerCount,
    el("span", { class: "insp-tag-caret", "aria-hidden": "true" }, "▾")
  );

  const tagSearchIn = el("input", {
    class: "input insp-tag-popover-search",
    type: "search",
    placeholder: "筛选具体标签…",
    "aria-label": "筛选具体标签",
  });
  const tagListWrap = el("div", { class: "insp-tag-popover-list" });
  const tagPopover = el("div", {
    class: "insp-tag-popover hidden",
    role: "dialog",
    "aria-label": "按多维标签筛选",
    dataset: { role: "tag-popover" },
  },
    el("div", { class: "insp-tag-popover-head" },
      el("strong", null, "全部标签（可多选）"),
      el("span", { class: "muted", dataset: { role: "tag-popover-total" } }, "")
    ),
    tagSearchIn,
    tagListWrap
  );
  const tagPickerWrap = el("div", { class: "insp-tag-picker" }, tagTriggerBtn, tagPopover);

  let allFineTags = [];
  let folderItems = [];
  let totalVaultCount = 0;
  let tagPopoverOpen = false;

  const hasSelectedTag = (tag) => viewState.tags.some((t) => t.toLowerCase() === String(tag).toLowerCase());
  const toggleSelectedTag = (tag) => {
    if (hasSelectedTag(tag)) {
      viewState.tags = viewState.tags.filter((t) => t.toLowerCase() !== String(tag).toLowerCase());
    } else {
      viewState.tags = [...viewState.tags, tag];
    }
  };

  const setTagPopoverOpen = (open) => {
    tagPopoverOpen = Boolean(open);
    tagPopover.classList.toggle("hidden", !tagPopoverOpen);
    tagTriggerBtn.setAttribute("aria-expanded", tagPopoverOpen ? "true" : "false");
    tagTriggerBtn.classList.toggle("is-open", tagPopoverOpen);
    if (tagPopoverOpen) {
      tagSearchIn.value = "";
      renderFineTagList("");
      setTimeout(() => tagSearchIn.focus(), 10);
    }
  };

  const renderFineTagList = (filterText) => {
    clear(tagListWrap);
    const needle = String(filterText || "").trim().toLowerCase();
    // Ensure currently selected tags remain visible in the list so they can always be toggled off
    const mergedTags = [...allFineTags];
    const seenKeys = new Set(mergedTags.map((x) => x.tag.toLowerCase()));
    viewState.tags.forEach((t) => {
      if (!seenKeys.has(t.toLowerCase())) {
        mergedTags.unshift({ tag: t, count: 0 });
        seenKeys.add(t.toLowerCase());
      }
    });
    const matched = needle
      ? mergedTags.filter(({ tag }) => tag.toLowerCase().includes(needle))
      : mergedTags;

    if (viewState.tags.length > 0) {
      tagListWrap.appendChild(el("button", {
        type: "button",
        class: "insp-tag-chip is-clear",
        onClick: () => {
          viewState.tags = [];
          renderFineTagList(tagSearchIn.value);
          loadVault();
        },
      }, `✕ 清除全部已选标签 (${viewState.tags.length})`));
    }

    if (!matched.length) {
      tagListWrap.appendChild(el("div", { class: "muted", style: { padding: "12px 4px", textAlign: "center", width: "100%" } }, "没有匹配的标签"));
      return;
    }

    matched.forEach(({ tag, count }) => {
      const active = hasSelectedTag(tag);
      tagListWrap.appendChild(el("button", {
        type: "button",
        class: "insp-tag-chip" + (active ? " is-active" : ""),
        dataset: { tag },
        onClick: () => {
          toggleSelectedTag(tag);
          renderFineTagList(tagSearchIn.value);
          loadVault();
        },
      },
        el("span", null, `${active ? "✓ " : ""}#${tag}`),
        el("span", { class: "insp-tag-chip-cnt" }, String(count))
      ));
    });
  };

  tagTriggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setTagPopoverOpen(!tagPopoverOpen);
  });
  tagPopover.addEventListener("click", (e) => e.stopPropagation());
  tagSearchIn.addEventListener("input", () => renderFineTagList(tagSearchIn.value));

  const onDocClick = (e) => {
    if (!stage.isConnected) {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onDocKey);
      return;
    }
    if (tagPopoverOpen && !tagPickerWrap.contains(e.target)) {
      setTagPopoverOpen(false);
    }
  };
  const onDocKey = (e) => {
    if (!stage.isConnected) {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onDocKey);
      return;
    }
    if (tagPopoverOpen && e.key === "Escape") {
      setTagPopoverOpen(false);
      tagTriggerBtn.focus();
    }
  };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKey);

  // Batch Manage button (supports both Batch Move Folder & Batch Share #89, #99)
  const batchIconSlot = createSvgEl(BATCH_SHARE_ICON_SVG);
  const batchLabelEl = el("span", { class: "insp-batch-toggle-label" }, "批量管理");
  const batchBadgeEl = el("span", { class: "insp-batch-toggle-badge hidden" }, "");
  const batchToggleBtn = el("button", {
    type: "button",
    class: "btn btn-sm insp-batch-toggle",
    dataset: { role: "batch-toggle" },
    onClick: () => {
      if (!currentItems.length && !viewState.batchMode) {
        toast("当前视图没有可操作的灵感条目");
        return;
      }
      viewState.batchMode = !viewState.batchMode;
      if (!viewState.batchMode) {
        viewState.selectedIds.clear();
      }
      renderVaultGrid(currentItems);
    },
  }, batchIconSlot, batchLabelEl, batchBadgeEl);

  const folderBar = el("div", { class: "insp-category-bar", role: "tablist", "aria-label": "灵感自定义分组", dataset: { role: "folder-bar" } });
  const activeTagsBar = el("div", { class: "row insp-active-tags-bar hidden", dataset: { role: "active-tags-bar" } });
  const batchBar = el("div", { class: "card insp-batch-bar hidden", dataset: { role: "batch-bar" } });
  const gridWrap = el("div");

  let currentItems = [];
  let latestRes = { clipToken: "", clipEndpoint: "", folders: [] };
  const cardRefs = new Map();

  let debounce = null;
  searchIn.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      viewState.q = searchIn.value.trim();
      loadVault();
    }, 180);
  });

  stage.appendChild(el("div", { class: "row insp-vault-toolbar" },
    searchWrap,
    el("div", { class: "row insp-toolbar-actions" },
      tagPickerWrap,
      batchToggleBtn
    )
  ));
  stage.appendChild(folderBar);
  stage.appendChild(activeTagsBar);
  stage.appendChild(batchBar);
  stage.appendChild(gridWrap);

  const syncBatchUI = () => {
    const visibleIdSet = new Set(currentItems.map((it) => it.id));
    for (const id of Array.from(viewState.selectedIds)) {
      if (!visibleIdSet.has(id)) viewState.selectedIds.delete(id);
    }

    const eligibleItems = currentItems.filter((it) => getShareEligibility(it).ok);
    const unpubEligible = eligibleItems.filter((it) => !it.publishedId);
    const selectedItems = currentItems.filter((it) => viewState.selectedIds.has(it.id));
    const selectedShareEligible = selectedItems.filter((it) => getShareEligibility(it).ok);

    const active = viewState.batchMode && currentItems.length > 0;
    batchToggleBtn.classList.toggle("is-active", active);
    batchToggleBtn.setAttribute("aria-pressed", active ? "true" : "false");
    batchIconSlot.innerHTML = active ? CLOSE_BATCH_ICON_SVG : BATCH_SHARE_ICON_SVG;
    batchLabelEl.textContent = active ? "退出批量" : "批量管理";
    if (!active && unpubEligible.length > 0) {
      batchBadgeEl.textContent = `${unpubEligible.length} 待分享`;
      batchBadgeEl.classList.remove("hidden");
    } else {
      batchBadgeEl.textContent = "";
      batchBadgeEl.classList.add("hidden");
    }
    batchToggleBtn.disabled = !currentItems.length && !viewState.batchMode;

    cardRefs.forEach((ref, id) => {
      const checked = active && viewState.selectedIds.has(id);
      ref.card.classList.toggle("is-selected", checked);
      if (ref.checkBtn) {
        ref.checkBtn.classList.toggle("is-checked", checked);
        ref.checkBtn.setAttribute("aria-checked", checked ? "true" : "false");
        ref.checkBtn.textContent = checked ? "✓" : "";
      }
      if (ref.footHint) {
        if (checked) {
          ref.footHint.textContent = ref.elig.ok ? "✓ 已选中" : "✓ 已选中（仅移入分组）";
        } else {
          ref.footHint.textContent = ref.elig.ok
            ? (ref.elig.published ? "点击选中（移分组/更新分享）" : "点击卡片选中")
            : `点击选中（移入分组 · ${ref.elig.reason}）`;
        }
      }
    });

    if (!active) {
      batchBar.classList.add("hidden");
      clear(batchBar);
      return;
    }

    const selectedCount = selectedItems.length;
    const shareCount = selectedShareEligible.length;
    batchBar.classList.remove("hidden");
    clear(batchBar);
    batchBar.appendChild(el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap", alignItems: "center" } },
      el("span", { class: "badge badge-accent" }, "批量管理模式"),
      el("strong", { style: { fontSize: "13px" }, dataset: { role: "batch-count" } }, `已选 ${selectedCount} 项`),
      el("span", { class: "muted", style: { fontSize: "12px" } }, `共 ${currentItems.length} 项 · 其中可分享 ${eligibleItems.length} 项（未分享 ${unpubEligible.length} 项）`)
    ));

    const openBatchShareModal = () => {
      if (!selectedShareEligible.length) {
        toast("所选条目中没有可分享的图片+提示词灵感");
        return;
      }
      openBatchShareInspirationsModal(selectedShareEligible, ctx, {
        onStart: () => {
          viewState.batchPublishing = true;
        },
        onFinished: ({ succeededIds }) => {
          for (const sid of succeededIds || []) {
            viewState.selectedIds.delete(sid);
          }
        },
        onClose: ({ anySucceeded, failedIds }) => {
          viewState.batchPublishing = false;
          const shouldRefresh = anySucceeded || viewState.pendingRefresh;
          viewState.pendingRefresh = false;
          if (anySucceeded && (!failedIds || failedIds.length === 0)) {
            viewState.batchMode = false;
            viewState.selectedIds.clear();
          }
          if (shouldRefresh) {
            loadVault();
          } else {
            syncBatchUI();
          }
        },
      });
    };

    const openBatchMoveModal = () => {
      if (!selectedCount) {
        toast("请先勾选要移入分组的灵感");
        return;
      }
      openBatchMoveFolderModal(
        selectedItems.map((it) => it.id),
        folderItems,
        () => {
          viewState.batchMode = false;
          viewState.selectedIds.clear();
          loadVault();
        }
      );
    };

    batchBar.appendChild(el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", alignItems: "center" } },
      el("button", {
        type: "button",
        class: "btn btn-sm",
        dataset: { role: "batch-select-unpublished" },
        disabled: unpubEligible.length === 0,
        onClick: () => {
          viewState.selectedIds.clear();
          unpubEligible.forEach((it) => viewState.selectedIds.add(it.id));
          syncBatchUI();
        },
      }, `全选未分享 (${unpubEligible.length})`),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        dataset: { role: "batch-select-all" },
        disabled: currentItems.length === 0,
        onClick: () => {
          currentItems.forEach((it) => viewState.selectedIds.add(it.id));
          syncBatchUI();
        },
      }, `全选当前 (${currentItems.length})`),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        dataset: { role: "batch-clear" },
        disabled: selectedCount === 0,
        onClick: () => {
          viewState.selectedIds.clear();
          syncBatchUI();
        },
      }, "清空"),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        dataset: { role: "batch-move-folder" },
        disabled: selectedCount === 0,
        onClick: openBatchMoveModal,
      }, `移入分组 (${selectedCount})`),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        dataset: { role: "batch-share-submit" },
        disabled: shareCount === 0,
        onClick: openBatchShareModal,
      }, `☁ 批量分享 (${shareCount})`)
    ));
  };

  function renderVaultGrid(items) {
    currentItems = Array.isArray(items) ? items : [];
    cardRefs.clear();
    clear(gridWrap);

    if (!currentItems.length) {
      if (viewState.batchMode) {
        viewState.batchMode = false;
        viewState.selectedIds.clear();
      }
      syncBatchUI();

      // Contextual empty state: distinguish filtered/empty-folder vs truly empty vault (#99)
      if (totalVaultCount > 0) {
        const inNamedFolder = viewState.folder && viewState.folder !== UNGROUPED_FOLDER && !viewState.q && viewState.tags.length === 0;
        const inUngrouped = viewState.folder === UNGROUPED_FOLDER && !viewState.q && viewState.tags.length === 0;
        gridWrap.appendChild(el("div", { class: "card col insp-empty" },
          el("h3", { style: { margin: 0 } },
            inNamedFolder
              ? `分组「${viewState.folder}」里还没有灵感`
              : (inUngrouped ? "✨ 所有灵感都已归入自定义分组" : "没有符合当前筛选条件的灵感")
          ),
          el("p", { class: "muted", style: { margin: "4px 0 8px", maxWidth: "500px" } },
            inNamedFolder
              ? "你可以直接在这里收集新灵感，或切换到「全部」后用「批量管理 → 移入分组」把已有灵感整理进来。"
              : "试试清除部分标签或切换其他分组查看。"
          ),
          el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
            inNamedFolder ? el("button", {
              type: "button",
              class: "btn btn-primary",
              onClick: () => openCreateInspirationModal(ctx, loadVault, {
                clipToken: latestRes.clipToken,
                clipEndpoint: latestRes.clipEndpoint,
                clipExtensionDir: latestRes.clipExtensionDir,
                clipExtensionExists: latestRes.clipExtensionExists,
                folders: latestRes.folders || [],
                defaultFolder: viewState.folder,
              }),
            }, `＋ 收集灵感并放入「${viewState.folder}」`) : null,
            el("button", {
              type: "button",
              class: "btn",
              onClick: () => {
                viewState.folder = "";
                viewState.tags = [];
                viewState.q = "";
                searchIn.value = "";
                loadVault();
              },
            }, "查看全部灵感")
          )
        ));
        return;
      }

      gridWrap.appendChild(el("div", { class: "card col insp-empty" },
        el("h3", { style: { margin: 0 } }, "💡 你的个人灵感库还是空的"),
        el("p", { class: "muted", style: { margin: "4px 0 8px", maxWidth: "520px" } },
          "无论是在 X (Twitter) 刷到的神级提示词、在画廊看到的惊艳作品，还是你自己刚画出的得意之作，都可以一键收进这里；用 AI 自动剥离废话、提炼变量，再分享到社区赚积分！"
        ),
        el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => openCreateInspirationModal(ctx, loadVault, {
              clipToken: latestRes.clipToken,
              clipEndpoint: latestRes.clipEndpoint,
              clipExtensionDir: latestRes.clipExtensionDir,
              clipExtensionExists: latestRes.clipExtensionExists,
              folders: latestRes.folders || [],
            }),
          }, "＋ 粘贴第一条灵感 / 推文"),
          el("button", {
            type: "button",
            class: "btn",
            onClick: () => openClipperSetupModal({
              clipToken: latestRes.clipToken,
              clipEndpoint: latestRes.clipEndpoint,
              clipExtensionDir: latestRes.clipExtensionDir,
              clipExtensionExists: latestRes.clipExtensionExists,
            }),
          }, "🧩 配置 Chrome 灵感捕手"),
          el("button", {
            type: "button",
            class: "btn",
            onClick: () => ctx.go("inspirations", { tab: "plaza" }),
          }, "去社区灵感广场逛逛 →")
        )
      ));
      return;
    }

    const inBatch = viewState.batchMode;
    const cards = currentItems.map((item) => {
      const imgSrc = item.imagePath ? localImg(item.imagePath) : (item.imageUrl ? remoteThumb(item.imageUrl, 480) : "");
      const excerpt = (item.promptZh || item.prompt || item.rawText || "").replace(/\s+/g, " ").trim().slice(0, 88);
      const elig = getShareEligibility(item);
      const selected = inBatch && viewState.selectedIds.has(item.id);

      const toggleSelect = () => {
        if (viewState.selectedIds.has(item.id)) {
          viewState.selectedIds.delete(item.id);
        } else {
          viewState.selectedIds.add(item.id);
        }
        syncBatchUI();
      };

      let checkBtn = null;
      let cornerOverlay = null;
      if (inBatch) {
        checkBtn = el("button", {
          type: "button",
          role: "checkbox",
          "aria-checked": selected ? "true" : "false",
          "aria-label": `选择 ${item.title || "灵感"}`,
          class: "insp-batch-check" + (selected ? " is-checked" : ""),
          onClick: (e) => {
            e.stopPropagation();
            toggleSelect();
          },
        }, selected ? "✓" : "");
        cornerOverlay = elig.ok
          ? checkBtn
          : el("div", { class: "insp-batch-corner-group" },
              checkBtn,
              el("span", { class: "insp-batch-ineligible-tag insp-batch-inline-note" }, `不可分享 · ${elig.reason}`)
            );
      }

      let footHint = null;
      const footerEl = inBatch
        ? el("footer", { class: "insp-card-foot insp-card-foot-batch" },
            (footHint = el("span", { class: "muted", style: { fontSize: "11.5px", flex: "1" } },
              selected
                ? (elig.ok ? "✓ 已选中" : "✓ 已选中（仅移入分组）")
                : (elig.ok
                    ? (elig.published ? "点击选中（移分组/更新分享）" : "点击卡片选中")
                    : `点击选中（移入分组 · ${elig.reason}）`)
            )),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              style: { flex: "0 0 auto" },
              onClick: (e) => {
                e.stopPropagation();
                openLocalInspirationDetail(item, ctx, loadVault, latestRes.folders || []);
              },
            }, "详情")
          )
        : el("footer", { class: "insp-card-foot" },
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: async () => {
                const hasSkill = Boolean(item.suggestedStyle || item.recipe?.styleIds?.length || item.recipe?.layoutId);
                let remixRefs = [];
                let remixRefMeta = [];
                if (Array.isArray(item.refSpecs) && item.refSpecs.length) {
                  const localOnly = item.refSpecs.filter((rf) => rf && rf.localPath);
                  if (localOnly.length === item.refSpecs.length) {
                    remixRefs = localOnly.map((rf) => rf.localPath);
                    remixRefMeta = localOnly;
                  } else {
                    try {
                      const mat = await api("POST", "/api/inspirations/materialize-refs", { refSpecs: item.refSpecs });
                      remixRefs = mat?.paths || [];
                      remixRefMeta = mat?.refs || [];
                    } catch {}
                  }
                }
                ctx.go("create", {
                  directPrompt: !hasSkill,
                  forkOf: hasSkill ? (item.workId || "") : "",
                  forkTitle: item.title || "",
                  style: hasSkill ? (item.suggestedStyle || item.recipe?.styleIds?.[0] || "") : "",
                  recipe: hasSkill ? (item.recipe || (item.suggestedStyle ? { styleIds: [item.suggestedStyle] } : {})) : undefined,
                  theme: item.prompt || item.promptZh || item.rawText || item.title,
                  ...(remixRefs.length ? { refs: remixRefs, refMeta: remixRefMeta } : {}),
                });
              },
            }, "✨ 做同款"),
            item.runPublishedWorkId || item.runIsSkill
              ? el("button", {
                  type: "button",
                  class: "btn btn-sm",
                  disabled: !item.runPublishedUrl,
                  title: item.runPublishedWorkId ? "该图已作为社区作品上架，同一张图不可重复发布到灵感库" : "手绘配方作品请前往画廊发布为社区作品",
                  onClick: () => {
                    if (item.runPublishedUrl) openURL(item.runPublishedUrl);
                    else toast("手绘配方作品请前往画廊发布为「社区作品」");
                  },
                }, item.runPublishedWorkId ? "已在作品上架 ↗" : "请去画廊发布")
              : el("button", {
                  type: "button",
                  class: "btn btn-sm btn-primary",
                  onClick: () => openShareInspirationModal(item, ctx, loadVault),
                }, item.publishedId ? "已分享" : "☁ 分享赚积分")
          );

      const cardEl = el("article", {
        class: "style-card insp-card"
          + (inBatch ? " is-batch" : "")
          + (selected ? " is-selected" : ""),
        dataset: { id: item.id },
      },
        cornerOverlay,
        el("div", {
          class: "insp-card-click",
          onClick: () => {
            if (inBatch) {
              toggleSelect();
            } else {
              openLocalInspirationDetail(item, ctx, loadVault, latestRes.folders || []);
            }
          },
        },
          imgSrc
            ? el("img", { class: "style-thumb", src: imgSrc, alt: item.title || "", loading: "lazy" })
            : el("div", { class: "insp-text-cover" }, excerpt || item.title),
          el("div", { class: "style-body" },
            el("div", { class: "row", style: { justifyContent: "space-between", gap: "4px", flexWrap: "wrap" } },
              el("div", { class: "row", style: { gap: "4px", flexWrap: "wrap" } },
                item.folder
                  ? el("span", { class: "badge insp-card-folder-badge", title: `分组：${item.folder}` }, item.folder)
                  : el("span", { class: "badge" }, SOURCE_LABELS[item.source] || item.source || "灵感")
              ),
              item.publishedId
                ? el("span", { class: "badge badge-ok" }, item.publishedPrice > 0 ? `🔒 ${item.publishedPrice} 积分` : "已分享")
                : (item.aiOrganized ? el("span", { class: "badge badge-accent" }, "✨ 已整理") : null)
            ),
            el("div", { class: "style-name", title: item.title }, item.title || "未命名灵感"),
            imgSrc && excerpt ? el("p", { class: "style-traits insp-excerpt" }, excerpt) : null,
            (item.tags || []).length
              ? el("div", { class: "row insp-card-tags" },
                  ...item.tags.slice(0, 3).map((t) => el("span", { class: "muted", style: { fontSize: "11px" } }, `#${t}`))
                )
              : null
          )
        ),
        footerEl
      );

      cardRefs.set(item.id, { card: cardEl, checkBtn, footHint, item, elig });
      return cardEl;
    });

    gridWrap.appendChild(masonry({ class: "insp-grid" + (inBatch ? " is-batch-mode" : "") }, cards));
    syncBatchUI();
  }

  let loadSeq = 0;

  async function loadVault() {
    const mySeq = ++loadSeq;
    const qs = new URLSearchParams();
    if (viewState.q) qs.set("q", viewState.q);
    if (viewState.folder) qs.set("folder", viewState.folder);
    if (viewState.tags.length > 0) qs.set("tags", viewState.tags.join(","));
    const usePrefetched = Boolean(initialRes) && !viewState.q && !viewState.folder && viewState.tags.length === 0;
    const res = usePrefetched
      ? initialRes
      : await api("GET", `/api/inspirations?${qs.toString()}`).catch(() => ({ items: [], tags: [], folderItems: [], folders: [], totalCount: 0, ungroupedCount: 0 }));
    initialRes = null;
    if (mySeq !== loadSeq) return;
    latestRes = res;
    onMeta?.({
      clipToken: res.clipToken || "",
      clipEndpoint: res.clipEndpoint || "",
      clipExtensionDir: res.clipExtensionDir || "",
      clipExtensionExists: res.clipExtensionExists,
      siteBase: res.siteBase || "",
      folders: Array.isArray(res.folders) ? res.folders : [],
    });

    allFineTags = Array.isArray(res.tags) ? res.tags : [];
    folderItems = Array.isArray(res.folderItems) ? res.folderItems : [];
    totalVaultCount = Number(res.totalCount ?? (res.items || []).length);
    const ungroupedCount = Number(res.ungroupedCount ?? 0);

    // If active custom folder was deleted externally, reset to all
    if (viewState.folder && viewState.folder !== UNGROUPED_FOLDER && !folderItems.some((f) => f.name === viewState.folder)) {
      viewState.folder = "";
    }

    // Sync multi-select tag popover trigger
    tagTriggerBtn.classList.toggle("hidden", allFineTags.length === 0 && viewState.tags.length === 0);
    tagTriggerBtn.classList.toggle("is-filtered", viewState.tags.length > 0);
    if (viewState.tags.length === 0) {
      tagTriggerLabel.textContent = "标签";
      tagTriggerCount.textContent = String(allFineTags.length);
      tagTriggerCount.classList.remove("hidden");
    } else if (viewState.tags.length === 1) {
      tagTriggerLabel.textContent = `#${viewState.tags[0]}`;
      tagTriggerCount.classList.add("hidden");
    } else {
      tagTriggerLabel.textContent = `标签 · ${viewState.tags.length}`;
      tagTriggerCount.classList.add("hidden");
    }
    const popTotal = tagPopover.querySelector('[data-role="tag-popover-total"]');
    if (popTotal) popTotal.textContent = `共 ${allFineTags.length} 个`;
    if (tagPopoverOpen) renderFineTagList(tagSearchIn.value);

    // Render extensible user Custom Folder Strip (#99)
    clear(folderBar);
    const showFolderBar = totalVaultCount > 0 || folderItems.length > 0;
    folderBar.classList.toggle("hidden", !showFolderBar);
    if (showFolderBar) {
      const makeFolderPill = (folderKey, label, count, extraClass = "") => {
        const active = viewState.folder === folderKey;
        return el("button", {
          type: "button",
          role: "tab",
          "aria-selected": active ? "true" : "false",
          dataset: { folder: folderKey },
          class: "insp-cat-pill" + (active ? " is-active" : "") + (extraClass ? " " + extraClass : ""),
          onClick: () => {
            viewState.folder = folderKey;
            loadVault();
          },
        },
          el("span", null, label),
          typeof count === "number" && count > 0 ? el("span", { class: "insp-cat-count" }, String(count)) : null
        );
      };

      folderBar.appendChild(makeFolderPill("", "全部", totalVaultCount));
      folderItems.forEach(({ name, count }) => {
        folderBar.appendChild(makeFolderPill(name, name, count));
      });
      if (folderItems.length > 0 && ungroupedCount > 0) {
        folderBar.appendChild(makeFolderPill(UNGROUPED_FOLDER, "未分组", ungroupedCount));
      }

      folderBar.appendChild(el("button", {
        type: "button",
        class: "insp-cat-pill insp-folder-add-pill",
        dataset: { role: "folder-create-btn" },
        onClick: () => openCreateFolderModal(
          folderItems.map((f) => f.name),
          (createdName) => {
            if (createdName) viewState.folder = createdName;
            loadVault();
          }
        ),
      }, "＋ 新建分组"));

      if (folderItems.length > 0) {
        folderBar.appendChild(el("button", {
          type: "button",
          class: "insp-cat-pill insp-folder-mgr-pill",
          dataset: { role: "folder-manage-btn" },
          onClick: () => openManageFoldersModal(folderItems, () => loadVault()),
        }, "管理分组"));
      }
    }

    // Render active multi-tag chips bar when 1+ tags are selected
    clear(activeTagsBar);
    activeTagsBar.classList.toggle("hidden", viewState.tags.length === 0);
    if (viewState.tags.length > 0) {
      activeTagsBar.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } }, "已选标签（交集）："));
      viewState.tags.forEach((t) => {
        activeTagsBar.appendChild(el("button", {
          type: "button",
          class: "insp-cat-pill is-tag-active",
          title: `移除 #${t}`,
          onClick: () => {
            toggleSelectedTag(t);
            loadVault();
          },
        }, `#${t} ✕`));
      });
      if (viewState.tags.length > 1) {
        activeTagsBar.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => {
            viewState.tags = [];
            loadVault();
          },
        }, "清空标签"));
      }
    }

    renderVaultGrid(res.items || []);
  }

  await loadVault();
  return { reload: loadVault };
}

async function renderPlazaTab(stage, ctx) {
  const searchIn = el("input", {
    class: "input",
    type: "search",
    value: viewState.plazaQ,
    placeholder: "搜索社区灵感、提示词、标签…",
    style: { maxWidth: "280px" },
  });
  const pricePills = el("div", { class: "row", style: { gap: "6px" } });
  const gridWrap = el("div");

  const drawPricePills = () => {
    clear(pricePills);
    [
      ["all:latest", "最新上架"],
      ["all:popular", "热门解锁"],
      ["unlocked:latest", "我已解锁"],
      ["mine:latest", "我发布的"],
    ].forEach(([val, lbl]) => {
      pricePills.appendChild(el("button", {
        type: "button",
        class: "pill-btn" + (viewState.plazaFilter === val ? " pill-accent" : ""),
        onClick: () => {
          viewState.plazaFilter = val;
          drawPricePills();
          loadPlaza();
        },
      }, lbl));
    });
  };
  drawPricePills();

  let debounce = null;
  searchIn.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      viewState.plazaQ = searchIn.value.trim();
      loadPlaza();
    }, 200);
  });

  stage.appendChild(el("div", { class: "card row insp-plaza-banner", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } },
    el("div", { class: "col", style: { gap: "2px" } },
      el("strong", null, "社区灵感广场 · 看图选灵感，积分解锁完整提示词并一键做同款"),
      el("span", { class: "muted" }, "提示词统一采用 1~20 积分解锁（作者享 80% 积分分成），积分仅用于解锁收费提示词、付费画风与收费贴，不兑换生图额度。")
    ),
    el("button", {
      type: "button",
      class: "btn btn-sm btn-primary",
      onClick: () => ctx.go("inspirations", { tab: "vault" }),
    }, "去分享我的提示词赚积分 →")
  ));
  stage.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } }, searchIn, pricePills));
  stage.appendChild(gridWrap);

  async function loadPlaza() {
    clear(gridWrap);
    gridWrap.appendChild(el("p", { class: "muted" }, "正在加载社区灵感广场…"));
    try {
      const [scope, sort] = String(viewState.plazaFilter || "all:latest").split(":");
      const qs = new URLSearchParams({ limit: "36", sort: sort || "latest" });
      if (viewState.plazaQ) qs.set("q", viewState.plazaQ);
      if (scope && scope !== "all") qs.set("pricing", scope);
      const res = await api("GET", `/api/site/inspirations?${qs.toString()}`);
      const siteBase = (res.siteBase || "https://handraw-style.com").replace(/\/+$/, "");
      const items = res.items || [];
      clear(gridWrap);
      if (!items.length) {
        gridWrap.appendChild(el("div", { class: "card col insp-empty" },
          el("h3", { style: { margin: 0 } }, "广场正在等待第一批灵感分享者！"),
          el("p", { class: "muted", style: { margin: "4px 0 8px" } }, "成为首批分享者：在「我的灵感库」分享 1 张好图和提示词，设置 1~20 积分解锁即可赚取 80% 创作者分成。"),
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => ctx.go("inspirations", { tab: "vault" }),
          }, "去分享第一条灵感 →")
        ));
        return;
      }

      const cards = items.map((it) => {
        const rawImg = it.imageUrl || "";
        const imgUrl = rawImg ? (/^https?:\/\//i.test(rawImg) ? rawImg : `${siteBase}/${rawImg.replace(/^\/+/, "")}`) : "";
        const price = Number(it.price || 0);
        const locked = Boolean(it.promptLocked);
        return el("article", {
          class: "style-card insp-card",
          onClick: () => openInspirationRemixModal(it.id, ctx, { title: it.title, siteBase, onUnlocked: loadPlaza }),
        },
          imgUrl ? el("img", { class: "style-thumb", src: remoteThumb(imgUrl, 480), alt: it.title || "", loading: "lazy" }) : null,
          el("div", { class: "style-body" },
            el("div", { class: "row", style: { justifyContent: "space-between", gap: "4px", flexWrap: "wrap" } },
              el("span", { class: "badge " + (locked ? "badge-accent" : "badge-ok") }, locked ? `🔒 ${price} 积分解锁` : `🔓 已解锁 (${price} 积分)`),
              el("span", { class: "muted", style: { fontSize: "11.5px" } }, `${it.unlockCount || 0} 解锁 · 💬 ${it.commentCount || 0}`)
            ),
            el("div", { class: "style-name", title: it.title }, it.title || "社区灵感"),
            it.promptPreview ? el("p", { class: "style-traits insp-excerpt" }, it.promptPreview) : null,
            el("div", { class: "muted", style: { fontSize: "11.5px", marginTop: "4px" } }, it.authorName || it.sourceAuthor || "社区创作者")
          )
        );
      });
      gridWrap.appendChild(masonry({ class: "insp-grid" }, cards));
    } catch (e) {
      clear(gridWrap);
      const msg = e?.message || "网络异常";
      if (/灰度|内测|feature_not_enabled|403/i.test(msg)) {
        gridWrap.appendChild(el("div", { class: "card col insp-empty" },
          el("h3", { style: { margin: 0 } }, "🚦 社区灵感广场正在灰度内测中"),
          el("p", { class: "muted", style: { margin: "4px 0 8px", maxWidth: "500px" } },
            "当前社区广场按「管理员/运营 → 版主 → 指定内测网友 → 逐步放量」的节奏开放。你的「我的灵感库」（本地收集、Chrome 捕手、AI 整理与做同款）不受影响，可照常使用。"
          ),
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => ctx.go("inspirations", { tab: "vault" }),
          }, "返回我的本地灵感库")
        ));
        return;
      }
      gridWrap.appendChild(el("div", { class: "card row muted" },
        `加载社区灵感广场失败：${msg}`,
        el("button", { type: "button", class: "btn btn-sm", onClick: loadPlaza }, "重试")
      ));
    }
  }

  await loadPlaza();
}

async function renderEarningsTab(stage, ctx, goVault) {
  stage.appendChild(el("p", { class: "muted" }, "正在同步你的创作与积分收益…"));
  try {
    const data = await api("GET", "/api/site/creator-earnings");
    clear(stage);

    const stats = [
      ["已分享灵感 / 作品", String(data.publishedCount ?? data.inspirationCount ?? 0), "公开或积分解锁"],
      ["被做同款总次数", String(data.totalForks ?? 0), "每次有效同款 +2 积分"],
      ["被积分解锁次数", String(data.totalUnlocks ?? 0), "作者享 80% 积分分成"],
      ["累计赚取积分", String(data.totalEarned ?? data.totalPointsEarned ?? 0), data.pendingPoints > 0 ? `含待结算 +${data.pendingPoints}` : "可用于解锁收费画风与提示词"],
    ];

    stage.appendChild(el("div", { class: "insp-stats-grid" },
      ...stats.map(([label, val, sub]) => el("div", { class: "card col insp-stat-card" },
        el("span", { class: "muted" }, label),
        el("strong", { class: "insp-stat-val" }, val),
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, sub)
      ))
    ));

    stage.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } },
      el("div", { class: "col", style: { gap: "3px" } },
        el("strong", null, "积分生态说明"),
        el("span", { class: "muted" }, "灵感提示词统一采用 1~20 积分解锁（作者享 80% 分成），社区公开作品被做同款享 +2 积分/人。积分仅用于解锁收费提示词、付费画风与社区付费贴，不兑换生图额度。")
      ),
      el("button", { type: "button", class: "btn btn-primary btn-sm", onClick: goVault }, "去灵感库继续分享 →")
    ));

    const myItems = Array.isArray(data.items) ? data.items : (Array.isArray(data.inspirations) ? data.inspirations : []);
    if (myItems.length) {
      stage.appendChild(el("h2", { style: { fontSize: "15px", margin: "6px 0 0" } }, "我已分享的社区灵感"));
      const list = el("div", { class: "col", style: { gap: "8px" } });
      myItems.forEach((it) => {
        list.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", padding: "10px 14px" } },
          el("div", { class: "col", style: { gap: "2px" } },
            el("strong", null, it.title || "未命名灵感"),
            el("span", { class: "muted" }, `${it.price > 0 ? `积分解锁 ${it.price} 分 · ${it.unlockCount || 0} 人解锁` : `免费公开 · ${it.forkCount || 0} 人做同款`}`)
          ),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => openInspirationRemixModal(it.id, ctx, { title: it.title }),
          }, "查看详情")
        ));
      });
      stage.appendChild(list);
    }

    const events = Array.isArray(data.recentEvents) ? data.recentEvents : (Array.isArray(data.earnings) ? data.earnings : []);
    if (events.length) {
      stage.appendChild(el("h2", { style: { fontSize: "15px", margin: "6px 0 0" } }, "近期积分入账记录"));
      const evBox = el("div", { class: "card col", style: { gap: "8px" } });
      events.slice(0, 20).forEach((ev) => {
        const delta = Number(ev.delta ?? ev.amount ?? ev.points ?? 0);
        evBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", borderBottom: "1px solid var(--line)", paddingBottom: "6px" } },
          el("span", null, ev.note || ev.reason || ev.kind || "创作积分"),
          el("strong", { style: { color: "var(--ok)" } }, `+${delta} 积分`)
        ));
      });
      stage.appendChild(evBox);
    }
  } catch (e) {
    clear(stage);
    const needLogin = /登录|login|401/i.test(e?.message || "");
    stage.appendChild(el("div", { class: "card col insp-empty" },
      el("h3", { style: { margin: 0 } }, needLogin ? "登录后查看你的分享与积分收益" : "暂时无法拉取收益数据"),
      el("p", { class: "muted", style: { margin: "4px 0 8px" } }, needLogin ? "登录手绘风账号后，你分享的每一条灵感与获得的解锁分成、同款积分都会自动汇总在这里。" : (e?.message || "请稍后重试")),
      needLogin
        ? el("button", { type: "button", class: "btn btn-primary", onClick: () => ctx.go("settings", { anchor: "settings-account" }) }, "前往登录手绘风账号")
        : el("button", { type: "button", class: "btn", onClick: () => renderEarningsTab(stage, ctx, goVault) }, "重试")
    ));
  }
}
