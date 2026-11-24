import { api, clear, closeModal, el, localImg, money, onEvent, packImg, showModal, toast } from "../api.js";
import { buildTextModelSelect, openSharedSkillPickerModal } from "../skills-ui.js";
import { computeParagraphDiff, mergeAcceptedHunks, renderCopilotMarkdown, renderInlineWordDiff } from "./article-diff.js";
import { createArticleObsidianController } from "./article-obsidian.js";
import { buildGroupedModelSelect } from "./create.js";
import {
  choices,
  extraInstructions,
  field,
  openResourceDialog,
  ratioControl,
  ratioToCss,
  recipeControls,
  resourceId,
  resourceName,
  resourcePicker,
  studioMount,
  studioSession,
  validRatio,
} from "./studio-controls.js";

export async function renderArticle(root, ctx, params = {}) {
  const host = studioMount(root);

  const [stylesRes, colorsRes, tonesRes, modRes, draftsRes, layoutsRes, vaultRes, skillsRes] = await Promise.all([
    api("GET", "/api/resources/styles").catch(() => ({ items: [] })),
    api("GET", "/api/resources/colors").catch(() => ({ items: [] })),
    api("GET", "/api/resources/tones").catch(() => ({ items: [] })),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [] })),
    api("GET", "/api/docs/article").catch(() => ({ items: [] })),
    api("GET", "/api/resources/layouts").catch(() => ({ items: [] })),
    api("GET", "/api/article/vault/tree").catch(() => ({ dir: "", name: "articles", exists: false, tree: [], fileCount: 0 })),
    api("GET", "/api/skills").catch(() => ({ items: [] })),
  ]);
  if (!host.isConnected) return;

  const styles = stylesRes.items || [];
  const colors = colorsRes.items || [];
  const tones = tonesRes.items || [];
  const layouts = layoutsRes.items || [];
  let drafts = draftsRes.items || [];
  let vault = vaultRes || { dir: "", name: "articles", exists: false, tree: [], fileCount: 0, vaults: [] };
  let installedSkills = (skillsRes.items || []).filter((sk) => sk.enabled !== false);

  const session = studioSession(host, "article", {
    docId: params.docId || "",
    activeFile: "",
    selectedDir: "",
    editorActive: Boolean(params.docId),
    dirty: false,
    title: "",
    content: "",
    style: styles[0]?.number || "FA-013",
    color: "",
    tone: "",
    mode: "graphic-text",
    style2: "",
    layout: "",
    mood: "",
    coverRatio: "2.35:1",
    inlineRatio: "4:3",
    includeCover: true,
    resolution: "2k",
    modelRef: modRes.defaultModel || "site:seedream-4.5",
    textModelRef: modRes.defaultTextModel || "",
    aiSkillIds: [],
    aiDrawerOpen: typeof window !== "undefined" ? window.innerWidth >= 1240 : true,
    rightDrawerTab: "ai", // ai | obsidian
    aiMode: "edit", // edit | advise
    aiChat: [],
    recommendedStyles: [],
    slots: [],
    viewMode: "editor", // editor | preview
    previewKind: "wechat_desktop", // wechat_desktop | wechat_mobile | markdown
    activeRun: null,
    slotMap: [],
  });
  root = session.root;
  const state = session.state;
  let submitting = false;
  let planning = false;
  let activeSegTextarea = null;
  let treeQuery = "";
  const EXPANDED_STORAGE_KEY = "article-vault-expanded-v2";
  let expandedDirs = new Set();

  function readExpandedMap() {
    try {
      const raw = JSON.parse(localStorage.getItem(EXPANDED_STORAGE_KEY) || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }
  function loadExpandedForVault(dir, tree) {
    const map = readExpandedMap();
    const key = String(dir || "").toLowerCase();
    const saved = map[key];
    expandedDirs = new Set();
    if (Array.isArray(saved)) {
      saved.forEach((p) => expandedDirs.add(p));
    } else if (Array.isArray(tree)) {
      // First visit to this vault: expand top-level folders so .md files are visible immediately.
      tree.forEach((n) => { if (n.kind === "dir") expandedDirs.add(n.path); });
    }
  }
  function persistExpanded() {
    if (!vault?.dir) return;
    try {
      const map = readExpandedMap();
      map[String(vault.dir).toLowerCase()] = Array.from(expandedDirs);
      localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(map));
    } catch {}
  }
  function collectAllDirPaths(nodes, out = []) {
    (nodes || []).forEach((n) => {
      if (n.kind === "dir") {
        out.push(n.path);
        collectAllDirPaths(n.children || [], out);
      }
    });
    return out;
  }
  loadExpandedForVault(vault.dir, vault.tree);

  const slotSignature = (sl) =>
    JSON.stringify([
      sl.role,
      sl.anchor,
      sl.theme,
      sl.ratio,
      sl.layout,
      state.style,
      state.fusion ? state.style2 : "",
      state.color,
      state.tone,
      state.mood,
      state.mode,
      extraInstructions(state),
    ]);

  // Hidden file input for MD/TXT/DOCX import
  const fileIn = el("input", { type: "file", accept: ".md,.markdown,.txt,.docx", class: "hidden" });
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const res = await api("POST", "/api/article/import", fd);
      state.activeFile = "";
      state.docId = "";
      state.editorActive = true;
      state.dirty = true;
      state.viewMode = "editor";
      if (res.title) state.title = res.title;
      state.content = res.content || "";
      state.slots = [];
      renderAll();
      session.persist();
      toast("已导入文稿，可点击保存写入本地 Markdown");
    } catch (e) {
      toast(e.message);
    }
    fileIn.value = "";
  });

  // Format helper applied to active markdown segment textarea
  function applyFormat(fmt) {
    if (fmt === "illust") {
      insertSlotAt("");
      return;
    }
    const ta = activeSegTextarea && activeSegTextarea.isConnected
      ? activeSegTextarea
      : flowBox.querySelector("textarea.ic-art-seg-ta");
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const sel = ta.value.slice(start, end);
    const wrapLine = (prefix) => {
      const ls = ta.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      ta.setRangeText(prefix, ls, ls, "end");
    };
    if (fmt === "h1") wrapLine("# ");
    else if (fmt === "h2") wrapLine("## ");
    else if (fmt === "h3") wrapLine("### ");
    else if (fmt === "quote") wrapLine("> ");
    else if (fmt === "ul") wrapLine("- ");
    else if (fmt === "ol") wrapLine("1. ");
    else if (fmt === "hr") ta.setRangeText("\n---\n", start, end, "end");
    else if (fmt === "bold") ta.setRangeText(`**${sel || "加粗文本"}**`, start, end, "end");
    else if (fmt === "italic") ta.setRangeText(`*${sel || "斜体文本"}*`, start, end, "end");
    else if (fmt === "code") ta.setRangeText(sel.includes("\n") ? `\n\`\`\`\n${sel}\n\`\`\`\n` : `\`${sel || "code"}\``, start, end, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
  }

  // 1. Fixed Top Toolbar
  const toolsGroup = el("div", { class: "ic-wechat-tools-group" },
    ...[
      ["h1", "H1"],
      ["h2", "H2"],
      ["h3", "H3"],
    ].map(([k, lbl]) => el("button", { type: "button", class: "ic-wechat-tool-btn", onClick: () => applyFormat(k) }, lbl)),
    el("div", { class: "ic-wechat-tool-sep" }),
    ...[
      ["bold", "B"],
      ["italic", "I"],
      ["quote", "❝"],
      ["hr", "—"],
      ["ul", "• 列表"],
      ["ol", "1. 列表"],
      ["code", "</>"],
    ].map(([k, lbl]) => el("button", { type: "button", class: "ic-wechat-tool-btn", onClick: () => applyFormat(k) }, lbl)),
    el("div", { class: "ic-wechat-tool-sep" }),
    el("button", { type: "button", class: "ic-wechat-tool-btn", onClick: () => applyFormat("illust") }, "＋ 插入配图位")
  );

  const editSwitchBtn = el("button", {
    type: "button",
    class: "ic-article-seg-btn",
    onClick: () => { state.viewMode = "editor"; renderStageMode(); },
  }, "编辑");
  const previewSwitchBtn = el("button", {
    type: "button",
    class: "ic-article-seg-btn",
    onClick: () => { state.viewMode = "preview"; renderStageMode(); },
  }, "预览");

  const activeBreadcrumb = el("span", { class: "ic-vault-breadcrumb mono" }, "");
  const aiUndoTopBtn = el("button", {
    type: "button",
    class: "btn btn-sm hidden",
    title: "撤销最近一次应用的 AI 改稿",
    onClick: () => undoLastAiRevision(),
  }, "↩ 撤销改稿");
  const aiDrawerToggleBtn = el("button", {
    type: "button",
    class: "btn btn-sm ic-art-copilot-toggle",
    title: "打开或收起右侧 AI 写作助手 (Ctrl+L)",
    "aria-label": "打开或收起右侧 AI 写作助手",
    "aria-pressed": "false",
    onClick: () => {
      if (state.aiDrawerOpen && state.rightDrawerTab !== "ai") {
        state.rightDrawerTab = "ai";
        renderStageMode();
        session.persist();
      } else {
        state.rightDrawerTab = "ai";
        toggleAiDrawer();
      }
    },
  }, "✨ AI 助手");
  const obsidianQuickBtn = el("button", {
    type: "button",
    class: "btn btn-sm ic-obs-top-btn",
    title: "运行或管理 Obsidian 插件",
    onClick: () => obsidianCtrl.openQuickActionsPopover(obsidianQuickBtn),
  }, "🧩 插件");
  const saveBtn = el("button", { type: "button", class: "btn btn-sm", onClick: saveDraft }, "💾 保存");

  const topbar = el("header", { class: "ic-wechat-topbar" },
    el("div", { class: "row", style: { minWidth: "0", gap: "8px" } },
      fileIn,
      activeBreadcrumb,
      el("button", { type: "button", class: "btn btn-sm", onClick: () => fileIn.click() }, "📄 导入"),
      el("button", { type: "button", class: "btn btn-sm", onClick: openURLImportDialog }, "🔗 抓取链接")
    ),
    toolsGroup,
    el("div", { class: "row", style: { gap: "6px" } },
      aiUndoTopBtn,
      el("div", { class: "ic-article-segmented-switch", role: "group", "aria-label": "编辑与预览切换" },
        editSwitchBtn,
        previewSwitchBtn
      ),
      obsidianQuickBtn,
      aiDrawerToggleBtn,
      saveBtn
    )
  );

  // 2. Left Sidebar: Obsidian-style Local Markdown Vault File Tree + Bottom Vault Switcher (#65, #66, #71)
  function makeIconSvg(d, size = 15) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.45");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const paths = Array.isArray(d) ? d : [d];
    paths.forEach((pd) => {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", pd);
      svg.appendChild(p);
    });
    return svg;
  }

  const ICONS = {
    newNote: ["M9.5 2H4.2A1.2 1.2 0 0 0 3 3.2v9.6A1.2 1.2 0 0 0 4.2 14h7.6a1.2 1.2 0 0 0 1.2-1.2V6.5", "M12.6 2.4a1.1 1.1 0 0 1 1.55 1.55L8.6 9.5l-2.1.55.55-2.1 5.55-5.55Z"],
    newFolder: ["M2 4.2A1.2 1.2 0 0 1 3.2 3h2.9l1.3 1.5h5.4A1.2 1.2 0 0 1 14 5.7v6.1a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V4.2Z", "M8 7v3.6", "M6.2 8.8h3.6"],
    collapse: ["M4.5 5.5 8 2.5l3.5 3", "M4.5 10.5 8 13.5l3.5-3"],
    expand: ["M4.5 6.5 8 3.5l3.5 3", "M4.5 9.5 8 12.5l3.5-3"],
    refresh: ["M13 8a5 5 0 1 1-1.35-3.42", "M13 2.5v2.7h-2.7"],
    rename: ["M11.8 2.7a1.2 1.2 0 0 1 1.7 1.7L6 11.9l-2.6.7.7-2.6 7.7-7.3Z"],
    duplicate: ["M5.5 5.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z", "M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"],
    reveal: ["M2.2 4.5A1.2 1.2 0 0 1 3.4 3.3h2.8l1.2 1.4h5.2a1.2 1.2 0 0 1 1.2 1.2v5.8a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V4.5Z"],
    copy: ["M6 2.8h5.6a1.2 1.2 0 0 1 1.2 1.2v6.6", "M4.4 5.2h5.2a1.2 1.2 0 0 1 1.2 1.2v6a1.2 1.2 0 0 1-1.2 1.2H4.4a1.2 1.2 0 0 1-1.2-1.2v-6a1.2 1.2 0 0 1 1.2-1.2Z"],
    trash: ["M3 4.5h10", "M6 4.5V3.2A1 1 0 0 1 7 2.2h2a1 1 0 0 1 1 1v1.3", "M4.5 4.5l.6 8.3a1.1 1.1 0 0 0 1.1 1h3.6a1.1 1.1 0 0 0 1.1-1l.6-8.3"],
    open: ["M9.5 2.5h4v4", "M13.5 2.5 8 8", "M11.5 9v3.3a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2V5.7a1.2 1.2 0 0 1 1.2-1.2H7"],
  };

  const sidebarCountBadge = el("span", { class: "ic-vault-count-pill" });
  const newNoteBtn = el("button", {
    type: "button",
    class: "ic-vault-ico-btn",
    title: "新建 Markdown 文件",
    "aria-label": "新建 Markdown 文件",
    onClick: () => openNewMarkdownModal(state.selectedDir || ""),
  }, makeIconSvg(ICONS.newNote));
  const newFolderBtn = el("button", {
    type: "button",
    class: "ic-vault-ico-btn",
    title: "新建文件夹",
    "aria-label": "新建文件夹",
    onClick: () => openNewFolderModal(state.selectedDir || ""),
  }, makeIconSvg(ICONS.newFolder));
  const collapseAllBtn = el("button", {
    type: "button",
    class: "ic-vault-ico-btn",
    title: "折叠全部文件夹",
    "aria-label": "折叠或展开全部文件夹",
    onClick: () => {
      const allDirs = collectAllDirPaths(vault.tree || []);
      if (!allDirs.length) return;
      if (expandedDirs.size > 0) expandedDirs.clear();
      else allDirs.forEach((p) => expandedDirs.add(p));
      persistExpanded();
      renderSidebar();
    },
  }, makeIconSvg(ICONS.collapse));

  const vaultFilterIn = el("input", {
    type: "search",
    class: "input ic-vault-search",
    placeholder: "筛选本地 .md 文件…",
    "aria-label": "筛选本地 Markdown 文件",
  });
  vaultFilterIn.addEventListener("input", () => {
    treeQuery = vaultFilterIn.value.trim().toLowerCase();
    renderSidebar();
  });

  const selectedDirBar = el("div", { class: "ic-vault-selected-dir hidden" });
  const treeBox = el("div", { class: "ic-vault-tree", role: "tree", "aria-label": "本地 Markdown 文件树" });
  treeBox.addEventListener("click", (e) => {
    if (e.target === treeBox && state.selectedDir) {
      state.selectedDir = "";
      renderSidebar();
      session.persist();
    }
  });
  treeBox.addEventListener("contextmenu", (e) => {
    if (e.target === treeBox || e.target.closest(".ic-vault-tree-empty")) {
      openTreeContextMenu(e, { kind: "root", path: "", name: vault.name || "根目录" });
    }
  });
  const legacyDraftsWrap = el("details", { class: "ic-vault-legacy hidden" });

  const vaultSwitcherName = el("span", { class: "ic-vault-switcher-name" }, vault.name || "articles");
  const vaultSwitcherCount = el("span", { class: "ic-vault-switcher-count hidden" }, "");
  const vaultSwitcherBtn = el("button", {
    type: "button",
    class: "ic-vault-switcher-btn",
    title: vault.dir || "切换本地目录",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    onClick: (e) => {
      e.stopPropagation();
      toggleVaultPopover();
    },
  },
    el("span", { class: "ic-vault-switcher-ico", "aria-hidden": "true" }, "⇅"),
    vaultSwitcherName,
    vaultSwitcherCount
  );

  const sidebarObsidianBtn = el("button", {
    type: "button",
    class: "ic-vault-ico-btn",
    title: "Obsidian 插件管理与安装",
    "aria-label": "Obsidian 插件管理与安装",
    onClick: () => { closeVaultPopover(); obsidianCtrl.openManagerModal("installed"); },
  }, "🧩");

  const vaultFooter = el("div", { class: "ic-vault-footer" },
    vaultSwitcherBtn,
    el("div", { class: "ic-vault-footer-actions" },
      sidebarObsidianBtn,
      el("button", {
        type: "button",
        class: "ic-vault-ico-btn",
        title: "添加本地目录",
        "aria-label": "添加本地目录",
        onClick: () => { closeVaultPopover(); openAddVaultDialog(); },
      }, "＋"),
      el("button", {
        type: "button",
        class: "ic-vault-ico-btn",
        title: "管理本地目录",
        "aria-label": "管理本地目录",
        onClick: () => { closeVaultPopover(); openManageVaultsModal(); },
      }, "⚙")
    )
  );

  const sidebar = el("aside", { class: "ic-pv-outline ic-vault-sidebar", "aria-label": "本地 Markdown 文件树" },
    el("div", { class: "ic-vault-head" },
      el("div", { class: "ic-vault-head-title" },
        el("strong", { class: "ic-vault-name" }, "本地文档"),
        sidebarCountBadge
      ),
      el("div", { class: "ic-vault-actions" },
        newNoteBtn,
        newFolderBtn,
        collapseAllBtn,
        el("button", { type: "button", class: "ic-vault-ico-btn", title: "刷新目录树", "aria-label": "刷新目录树", onClick: refreshVaultTree }, makeIconSvg(ICONS.refresh))
      )
    ),
    vaultFilterIn,
    selectedDirBar,
    treeBox,
    legacyDraftsWrap,
    vaultFooter
  );

  // 3. Center Scroll Area (Vault Empty Welcome / Paper Editor / Preview Sheet)
  const welcomeBox = el("div", { class: "ic-vault-welcome" });
  const titleInput = el("input", {
    type: "text",
    class: "ic-wechat-title-input",
    maxlength: "64",
    value: state.title || "",
    placeholder: "请输入文章主标题（留空则自动使用首行标题）",
  });
  const titleCount = el("span", { class: "ic-wechat-title-count" }, `${(state.title || "").length}/64`);
  titleInput.addEventListener("input", () => {
    state.title = titleInput.value;
    state.dirty = true;
    titleCount.textContent = `${state.title.length}/64`;
    syncTopbarBreadcrumb();
    session.persist();
  });

  const recStylesBar = el("div", { class: "row hidden", style: { flexWrap: "wrap" } });
  const planNotice = el("p", { class: "studio-notice", role: "status" });
  const batchSummaryBox = el("div", { class: "hidden" });
  const flowBox = el("div", { id: "art-editor-flow" });

  const paperSheet = el("article", { class: "ic-wechat-paper" },
    el("div", { class: "ic-wechat-title-box" }, titleInput, titleCount),
    el("div", { class: "ic-wechat-paper-divider" }),
    recStylesBar,
    planNotice,
    batchSummaryBox,
    flowBox
  );

  const diffReviewBox = el("section", { class: "ic-wechat-paper ic-art-diff-paper hidden", "aria-label": "AI 改稿内联审阅" });
  const previewStageBox = el("div", { class: "col hidden", style: { gap: "12px" } });
  const scrollArea = el("div", { class: "ic-wechat-scroll-area" }, welcomeBox, paperSheet, diffReviewBox, previewStageBox);
  const centerCol = el("div", { class: "ic-wechat-center-col" }, scrollArea);

  // 3.5. Right Collapsible AI Writing Copilot + Inline Paper Diff Review + Selection Bubble (#70, #74)
  let aiEditing = false;
  let lastAiUndo = null; // { title, content, msgId }
  let activeDiffReview = null; // { msgId, summary, usedSkills, prevTitle, newTitle, titleAccepted, hunks, isSelection }
  let pinnedSelection = null; // { text, start, end, segIdx }
  let selBubbleEl = null;
  let selBubbleCleanup = null;

  function closeSelectionBubble() {
    if (selBubbleCleanup) {
      selBubbleCleanup();
      selBubbleCleanup = null;
    }
    if (selBubbleEl) {
      selBubbleEl.remove();
      selBubbleEl = null;
    }
  }

  function pinSelectionToCopilot(sel, { openDrawer = true, focusInput = false, mode = null } = {}) {
    if (!sel?.text) return;
    pinnedSelection = { ...sel };
    if (mode === "edit" || mode === "advise") state.aiMode = mode;
    if (openDrawer) state.aiDrawerOpen = true;
    renderStageMode();
    renderCopilotPanel();
    session.persist();
    if (focusInput) setTimeout(() => aiInput.focus(), 40);
  }

  function showSelectionBubble(ta, segIdx, anchorX, anchorY) {
    closeSelectionBubble();
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    if (end - start < 2) return;
    const text = ta.value.slice(start, end).trim();
    if (text.length < 2) return;

    const sel = { text, start, end, segIdx };
    const bubble = el("div", { class: "ic-sel-bubble", role: "toolbar", "aria-label": "划词 AI 局部操作" },
      el("button", {
        type: "button",
        class: "ic-sel-bubble-btn is-accent",
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => {
          closeSelectionBubble();
          pinSelectionToCopilot(sel, { openDrawer: true, focusInput: true, mode: "edit" });
        },
      }, "✨ 改写"),
      el("button", {
        type: "button",
        class: "ic-sel-bubble-btn",
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => {
          closeSelectionBubble();
          pinSelectionToCopilot(sel, { openDrawer: true, mode: "edit" });
          runAiArticleEdit({ instructionOverride: "精简压缩这段话，去掉冗余修饰，保留核心意思和节奏感", modeOverride: "edit", selectionOverride: sel });
        },
      }, "精简"),
      el("button", {
        type: "button",
        class: "ic-sel-bubble-btn",
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => {
          closeSelectionBubble();
          pinSelectionToCopilot(sel, { openDrawer: true, mode: "edit" });
          runAiArticleEdit({ instructionOverride: "扩写润色这段话，补充具体画面细节或有说服力的表达", modeOverride: "edit", selectionOverride: sel });
        },
      }, "扩写"),
      el("button", {
        type: "button",
        class: "ic-sel-bubble-btn",
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => {
          closeSelectionBubble();
          pinSelectionToCopilot(sel, { openDrawer: true, mode: "edit" });
          runAiArticleEdit({ instructionOverride: "去掉这段话的 AI 味和书面腔，改得更像真人自然口吻", modeOverride: "edit", selectionOverride: sel });
        },
      }, "去 AI 味"),
      el("span", { class: "ic-sel-bubble-sep", "aria-hidden": "true" }),
      el("button", {
        type: "button",
        class: "ic-sel-bubble-btn",
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => {
          closeSelectionBubble();
          pinSelectionToCopilot(sel, { openDrawer: true, focusInput: true, mode: "advise" });
        },
      }, "💬 问助手")
    );

    bubble.style.left = "0px";
    bubble.style.top = "0px";
    bubble.style.visibility = "hidden";
    document.body.appendChild(bubble);

    const rect = bubble.getBoundingClientRect();
    const taRect = ta.getBoundingClientRect();
    const baseX = typeof anchorX === "number" && anchorX > 0 ? anchorX - rect.width / 2 : taRect.left + taRect.width / 2 - rect.width / 2;
    const baseY = typeof anchorY === "number" && anchorY > 0 ? anchorY - rect.height - 14 : taRect.top - rect.height - 8;
    const left = Math.max(10, Math.min(baseX, window.innerWidth - rect.width - 10));
    const top = baseY < 56 ? Math.min(window.innerHeight - rect.height - 10, (anchorY || taRect.top) + 22) : baseY;
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.visibility = "visible";
    selBubbleEl = bubble;

    const onDocDown = (e) => {
      if (!bubble.contains(e.target)) closeSelectionBubble();
    };
    const onKey = (e) => {
      if (e.key === "Escape") closeSelectionBubble();
    };
    const onScroll = () => closeSelectionBubble();
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    scrollArea.addEventListener("scroll", onScroll, { passive: true });
    selBubbleCleanup = () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
      scrollArea.removeEventListener("scroll", onScroll);
    };
  }

  function undoLastAiRevision() {
    if (!lastAiUndo) return;
    state.title = lastAiUndo.title;
    state.content = lastAiUndo.content;
    state.dirty = true;
    if (lastAiUndo.msgId && Array.isArray(state.aiChat)) {
      const m = state.aiChat.find((x) => x.id === lastAiUndo.msgId);
      if (m) m.applied = false;
    }
    lastAiUndo = null;
    activeDiffReview = null;
    renderFlow();
    syncBottomBar();
    syncTopbarBreadcrumb();
    renderStageMode();
    renderCopilotPanel();
    session.persist();
    toast("已撤销上次 AI 改稿");
  }

  function openInlineDiffReview(msg) {
    if (!msg || !msg.revision) return;
    const rev = msg.revision;
    const hunks = computeParagraphDiff(rev.prevContent || "", rev.content || "");
    activeDiffReview = {
      msgId: msg.id,
      summary: rev.summary || "已完成文章修改",
      usedSkills: rev.usedSkills || [],
      prevTitle: rev.prevTitle || "",
      newTitle: rev.title ?? rev.prevTitle ?? "",
      titleAccepted: true,
      hunks,
      isSelection: rev.kind === "selection",
    };
    state.viewMode = "editor";
    renderStageMode();
    renderInlineDiffReview();
    renderCopilotPanel();
    scrollArea.scrollTop = 0;
  }

  function exitInlineDiffReview() {
    if (!activeDiffReview) return;
    activeDiffReview = null;
    renderStageMode();
    renderCopilotPanel();
  }

  function applyRevisionDirect(msg, customTitle, customContent) {
    if (!msg?.revision) return;
    const nextTitle = customTitle !== undefined ? customTitle : msg.revision.title;
    const nextContent = customContent !== undefined ? customContent : msg.revision.content;
    lastAiUndo = { title: state.title || "", content: state.content || "", msgId: msg.id };
    state.title = nextTitle;
    state.content = nextContent;
    state.dirty = true;
    msg.applied = true;
    msg.discarded = false;
    activeDiffReview = null;
    renderFlow();
    syncBottomBar();
    syncTopbarBreadcrumb();
    renderStageMode();
    renderCopilotPanel();
    session.persist();
    toast("已应用 AI 改稿到正文，按 Ctrl+S 可写回本地 Markdown");
  }

  function renderInlineDiffReview() {
    clear(diffReviewBox);
    const rev = activeDiffReview;
    if (!rev) return;

    const titleChanged = (rev.prevTitle || "") !== (rev.newTitle || "");
    const changedHunks = rev.hunks.filter((h) => h.kind !== "same");
    const totalChanges = changedHunks.length + (titleChanged ? 1 : 0);
    const acceptedCount = changedHunks.filter((h) => h.accepted).length + (titleChanged && rev.titleAccepted ? 1 : 0);

    const msg = (state.aiChat || []).find((m) => m.id === rev.msgId);

    const applySelected = () => {
      const mergedTitle = titleChanged ? (rev.titleAccepted ? rev.newTitle : rev.prevTitle) : rev.prevTitle;
      const mergedContent = mergeAcceptedHunks(rev.hunks);
      if (msg) {
        applyRevisionDirect(msg, mergedTitle, mergedContent);
      } else {
        lastAiUndo = { title: state.title || "", content: state.content || "", msgId: "" };
        state.title = mergedTitle;
        state.content = mergedContent;
        state.dirty = true;
        activeDiffReview = null;
        renderFlow();
        syncBottomBar();
        syncTopbarBreadcrumb();
        renderStageMode();
        renderCopilotPanel();
        session.persist();
        toast("已应用选中的 AI 改动");
      }
    };

    const banner = el("div", { class: "ic-diff-banner" },
      el("div", { class: "ic-diff-banner-info" },
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("span", { class: "badge badge-accent" }, rev.isSelection ? "局部改写审阅" : "AI 改稿审阅"),
          el("strong", { style: { fontSize: "13px" } }, `共 ${totalChanges} 处改动 · 已勾选 ${acceptedCount} 处`),
          ...(rev.usedSkills || []).map((u) => el("span", { class: "badge" }, `⚡ ${u.name || u.id}`))
        ),
        el("p", { class: "muted", style: { margin: 0, fontSize: "12px", lineHeight: "1.45" } }, rev.summary)
      ),
      el("div", { class: "row", style: { gap: "6px", flexShrink: 0, flexWrap: "wrap" } },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => {
            const allOn = acceptedCount === totalChanges;
            rev.titleAccepted = !allOn;
            changedHunks.forEach((h) => { h.accepted = !allOn; });
            renderInlineDiffReview();
          },
        }, acceptedCount === totalChanges ? "全部不采纳" : "全部采纳"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          disabled: acceptedCount === 0,
          onClick: applySelected,
        }, `✓ 应用已选 (${acceptedCount})`),
        el("button", { type: "button", class: "btn btn-sm", onClick: exitInlineDiffReview }, "退出审阅")
      )
    );
    diffReviewBox.appendChild(banner);

    // Title diff section
    if (titleChanged) {
      const titleHunkEl = el("div", {
        class: "ic-diff-hunk" + (rev.titleAccepted ? " is-accepted" : " is-rejected"),
        dataset: { hunkKind: "title" },
      },
        el("div", { class: "ic-diff-hunk-head" },
          el("span", { class: "ic-diff-hunk-tag" }, "标题改动"),
          el("button", {
            type: "button",
            class: "ic-diff-hunk-toggle" + (rev.titleAccepted ? " is-on" : ""),
            onClick: () => {
              rev.titleAccepted = !rev.titleAccepted;
              renderInlineDiffReview();
            },
          }, rev.titleAccepted ? "✓ 采纳此改动" : "✕ 保留原标题")
        ),
        el("div", { class: "ic-diff-hunk-title" },
          rev.titleAccepted
            ? renderInlineWordDiff(rev.prevTitle, rev.newTitle)
            : el("span", null, rev.prevTitle || "（无标题）")
        )
      );
      diffReviewBox.appendChild(titleHunkEl);
    } else if (rev.prevTitle) {
      diffReviewBox.appendChild(el("h1", { class: "ic-diff-static-title" }, rev.prevTitle));
    }

    diffReviewBox.appendChild(el("div", { class: "ic-wechat-paper-divider" }));

    // Body paragraph hunks
    const bodyFlow = el("div", { class: "ic-diff-body" });
    if (totalChanges === 0) {
      bodyFlow.appendChild(el("p", { class: "muted", style: { textAlign: "center", padding: "24px 0" } }, "AI 改稿结果与原文内容完全一致，没有文本差异。"));
    }
    rev.hunks.forEach((h) => {
      if (h.kind === "same") {
        bodyFlow.appendChild(el("div", { class: "ic-diff-same" }, h.oldText));
        return;
      }
      const kindLabel = h.kind === "add" ? "新增段落" : (h.kind === "del" ? "删除段落" : "修改段落");
      const contentBox = el("div", { class: "ic-diff-hunk-body" });
      if (!h.accepted) {
        contentBox.appendChild(el("span", { class: "ic-diff-kept-orig" }, h.oldText || "（不新增此段）"));
      } else if (h.kind === "change") {
        contentBox.appendChild(renderInlineWordDiff(h.oldText, h.newText));
      } else if (h.kind === "add") {
        contentBox.appendChild(el("ins", { class: "ic-diff-ins" }, h.newText));
      } else {
        contentBox.appendChild(el("del", { class: "ic-diff-del" }, h.oldText));
      }

      bodyFlow.appendChild(el("div", {
        class: "ic-diff-hunk" + (h.accepted ? " is-accepted" : " is-rejected"),
        dataset: { hunkId: h.id, hunkKind: h.kind },
      },
        el("div", { class: "ic-diff-hunk-head" },
          el("span", { class: "ic-diff-hunk-tag" }, kindLabel),
          el("button", {
            type: "button",
            class: "ic-diff-hunk-toggle" + (h.accepted ? " is-on" : ""),
            onClick: () => {
              h.accepted = !h.accepted;
              renderInlineDiffReview();
            },
          }, h.accepted ? "✓ 采纳" : "✕ 保留原文")
        ),
        contentBox
      ));
    });
    diffReviewBox.appendChild(bodyFlow);
  }

  // Copilot Sidebar Controls
  const textModelSel = buildTextModelSelect(modRes, state.textModelRef);
  textModelSel.classList.add("ic-cop-model-sel");
  state.textModelRef = textModelSel.value;
  textModelSel.addEventListener("change", () => {
    state.textModelRef = textModelSel.value;
    session.persist();
  });

  const aiModeEditBtn = el("button", {
    type: "button",
    class: "ic-cop-mode-btn",
    onClick: () => {
      state.aiMode = "edit";
      renderCopilotPanel();
      session.persist();
    },
  }, "改稿");
  const aiModeAdviseBtn = el("button", {
    type: "button",
    class: "ic-cop-mode-btn",
    onClick: () => {
      state.aiMode = "advise";
      renderCopilotPanel();
      session.persist();
    },
  }, "诊断 / 建议");

  const aiClearChatBtn = el("button", {
    type: "button",
    class: "ic-vault-ico-btn",
    title: "清空本次对话记录",
    "aria-label": "清空对话记录",
    onClick: () => {
      state.aiChat = [];
      activeDiffReview = null;
      pinnedSelection = null;
      renderStageMode();
      renderCopilotPanel();
      session.persist();
    },
  }, makeIconSvg(ICONS.trash, 14));

  const aiCloseDrawerBtn = el("button", {
    type: "button",
    class: "ic-vault-ico-btn",
    title: "收起 AI 写作助手 (Ctrl+L)",
    "aria-label": "收起 AI 写作助手",
    onClick: () => toggleAiDrawer(false),
  }, "×");

  const copilotFeed = el("div", { class: "ic-cop-feed", role: "log", "aria-live": "polite" });
  const copilotSelectionChip = el("div", { class: "ic-cop-sel-chip hidden" });
  const aiSkillsStrip = el("div", { class: "ic-art-ai-skills hidden" });

  const aiInput = el("textarea", {
    class: "ic-cop-input",
    rows: "2",
    placeholder: "输入改稿或诊断要求…（Ctrl+Enter 发送）",
    "aria-label": "AI 写作助手指令输入框",
  });
  const resizeAiInput = () => {
    aiInput.style.height = "auto";
    aiInput.style.height = `${Math.min(132, Math.max(52, aiInput.scrollHeight))}px`;
  };
  aiInput.addEventListener("input", resizeAiInput);
  aiInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runAiArticleEdit();
    }
  });

  const aiPickSkillBtn = el("button", {
    type: "button",
    class: "btn btn-sm ic-art-ai-skill-btn",
    onClick: () => {
      openSharedSkillPickerModal({
        title: "选择写作 / 诊断 Skill",
        selectedIds: Array.isArray(state.aiSkillIds) ? state.aiSkillIds : [],
        onChange: (ids, freshSkills) => {
          state.aiSkillIds = ids;
          if (Array.isArray(freshSkills)) installedSkills = freshSkills;
          renderAiSkillsBar();
          session.persist();
        },
        onSkillsUpdated: (freshSkills) => {
          if (Array.isArray(freshSkills)) installedSkills = freshSkills;
          renderAiSkillsBar();
        },
      });
    },
  }, "⚡ 选择 Skill");

  const aiRunBtn = el("button", {
    type: "button",
    class: "btn btn-sm btn-primary",
    onClick: () => runAiArticleEdit(),
  }, "发送");

  const copilotBackdrop = el("div", {
    class: "ic-cop-backdrop hidden",
    onClick: () => toggleAiDrawer(false),
  });

  // Obsidian plugin sandbox controller (#115)
  const drawerTabAiBtn = el("button", {
    type: "button",
    class: "ic-obs-drawer-tab is-active",
    onClick: () => {
      state.rightDrawerTab = "ai";
      renderStageMode();
      session.persist();
    },
  }, "✨ AI 助手");
  const drawerTabObsBtn = el("button", {
    type: "button",
    class: "ic-obs-drawer-tab",
    onClick: () => {
      state.rightDrawerTab = "obsidian";
      renderStageMode();
      session.persist();
    },
  }, "🧩 插件视图");

  function computeActiveDocSnapshot() {
    let selStart = 0;
    let selEnd = 0;
    const content = state.content || "";
    if (activeSegTextarea && activeSegTextarea.isConnected) {
      const segs = Array.from(flowBox.querySelectorAll("textarea.ic-art-seg-ta"));
      let baseOff = 0;
      for (const ta of segs) {
        if (ta === activeSegTextarea) {
          selStart = baseOff + (ta.selectionStart ?? 0);
          selEnd = baseOff + (ta.selectionEnd ?? 0);
          break;
        }
        baseOff += ta.value.length + 1;
      }
    }
    return {
      path: state.activeFile || "",
      title: state.title || "",
      content,
      selStart,
      selEnd,
    };
  }

  function syncObsidianBadges() {
    const enabledCount = (obsidianCtrl.state.plugins || []).filter((p) => p.enabled).length;
    obsidianQuickBtn.textContent = enabledCount > 0 ? `🧩 插件 (${enabledCount})` : "🧩 插件";
    obsidianQuickBtn.classList.toggle("is-active", enabledCount > 0);
    const vc = obsidianCtrl.state.viewCount || 0;
    drawerTabObsBtn.textContent = vc > 0 ? `🧩 插件视图 (${vc})` : "🧩 插件视图";
    const showingObs = Boolean(state.editorActive) && Boolean(state.aiDrawerOpen) && state.rightDrawerTab === "obsidian";
    obsidianCtrl.updateHostVisibility(showingObs);
  }

  const obsidianCtrl = createArticleObsidianController({
    getDoc: computeActiveDocSnapshot,
    setDocContent: (nextContent) => {
      state.content = String(nextContent ?? "");
      state.dirty = true;
      renderFlow();
      syncTopbarBreadcrumb();
      if (state.viewMode === "preview") renderPreviewStage();
      session.persist();
    },
    openFile: (relPath) => {
      if (relPath) openVaultFile(relPath);
    },
    onStateChange: () => syncObsidianBadges(),
    onRevealPluginPane: () => {
      state.rightDrawerTab = "obsidian";
      state.aiDrawerOpen = true;
      renderStageMode();
      session.persist();
    },
  });

  const aiPaneHead = el("div", { class: "ic-cop-head" },
    el("div", { class: "ic-cop-head-top" },
      el("div", { class: "row", style: { gap: "6px", minWidth: "0" } },
        el("span", { class: "ic-cop-spark", "aria-hidden": "true" }, "✨"),
        el("strong", { class: "ic-cop-title" }, "AI 写作助手")
      ),
      el("div", { class: "row", style: { gap: "2px" } },
        aiClearChatBtn,
        aiCloseDrawerBtn
      )
    ),
    el("div", { class: "ic-cop-controls" },
      el("div", { class: "ic-cop-mode-seg", role: "group", "aria-label": "助手工作模式" },
        aiModeEditBtn,
        aiModeAdviseBtn
      ),
      textModelSel
    )
  );
  const aiPaneComposer = el("div", { class: "ic-cop-composer-wrap" },
    copilotSelectionChip,
    aiSkillsStrip,
    el("div", { class: "ic-cop-composer" },
      aiInput,
      el("div", { class: "ic-cop-composer-foot" },
        aiPickSkillBtn,
        el("div", { class: "row", style: { gap: "6px" } },
          el("span", { class: "ic-cop-kbd muted" }, "Ctrl+Enter"),
          aiRunBtn
        )
      )
    )
  );
  const aiPaneBody = el("div", { class: "ic-obs-drawer-pane" }, aiPaneHead, copilotFeed, aiPaneComposer);

  const obsPaneHeader = el("div", { class: "ic-obs-pane-head" },
    el("strong", { style: { fontSize: "13px" } }, "Obsidian 插件视图"),
    el("div", { class: "row", style: { gap: "4px" } },
      el("button", { type: "button", class: "btn btn-sm", onClick: () => obsidianCtrl.openManagerModal("installed") }, "管理"),
      el("button", { type: "button", class: "btn btn-sm", title: "关闭右侧抽屉", onClick: () => toggleAiDrawer(false) }, "✕")
    )
  );
  const obsPaneSlot = el("div", { class: "ic-obs-pane-slot" });
  obsidianCtrl.setDockSlot(obsPaneSlot);
  const obsPaneBody = el("div", { class: "ic-obs-drawer-pane ic-obs-pane-body hidden" },
    obsPaneHeader,
    obsPaneSlot
  );

  const aiDrawer = el("aside", { class: "ic-art-copilot hidden", "aria-label": "右侧工具与插件面板" },
    el("div", { class: "ic-obs-drawer-tabs", role: "tablist" },
      drawerTabAiBtn,
      drawerTabObsBtn
    ),
    aiPaneBody,
    obsPaneBody
  );

  function toggleAiDrawer(force) {
    const next = typeof force === "boolean" ? force : !state.aiDrawerOpen;
    state.aiDrawerOpen = next;
    renderStageMode();
    renderCopilotPanel();
    session.persist();
    if (next && state.editorActive) {
      setTimeout(() => aiInput.focus(), 40);
    }
  }

  function renderAiSkillsBar() {
    clear(aiSkillsStrip);
    const ids = Array.isArray(state.aiSkillIds) ? state.aiSkillIds : [];
    const byId = new Map(installedSkills.map((sk) => [sk.id, sk]));
    const valid = ids.filter((id) => byId.has(id));
    if (valid.length !== ids.length) state.aiSkillIds = valid;
    aiSkillsStrip.classList.toggle("hidden", valid.length === 0);
    aiPickSkillBtn.textContent = valid.length > 0 ? `⚡ Skill (${valid.length})` : "⚡ 选择 Skill";
    aiPickSkillBtn.classList.toggle("is-has-skills", valid.length > 0);
    valid.forEach((id) => {
      const sk = byId.get(id);
      aiSkillsStrip.appendChild(el("span", { class: "ic-art-skill-chip", title: sk.description || sk.id },
        el("span", null, `⚡ ${sk.name || sk.id}`),
        el("button", {
          type: "button",
          class: "ic-art-skill-chip-x",
          "aria-label": `移除 Skill ${sk.name || sk.id}`,
          onClick: () => {
            state.aiSkillIds = (state.aiSkillIds || []).filter((x) => x !== id);
            renderAiSkillsBar();
            session.persist();
          },
        }, "×")
      ));
    });
  }

  const COPILOT_PRESETS = [
    { label: "去 AI 味", mode: "edit", prompt: "去掉文章里的 AI 味、机器套话和书面腔，改得更像真人自然表达，保留全部事实与配图链接。" },
    { label: "优化开头", mode: "edit", prompt: "重写文章开头两段，用更有画面感或反常识的切入点留住读者，正文其余部分保持不变。" },
    { label: "起 5 个标题", mode: "advise", prompt: "结合文章核心亮点，给出 5 个不同切入角度的公众号/小红书标题，每个附一句话说明适合人群。" },
    { label: "共鸣与逻辑诊断", mode: "advise", prompt: "像资深主编一样逐段诊断这篇文章哪里容易流失读者、哪里论证偏虚，并给出具体修改方向（先诊断不重写）。" },
    { label: "精简 20% 篇幅", mode: "edit", prompt: "删去重复啰嗦的过渡句，压缩约 20% 篇幅，提升信息密度与阅读节奏，保留所有配图链接。" },
  ];

  function renderCopilotPanel() {
    renderAiSkillsBar();
    const isAdvise = state.aiMode === "advise";
    aiModeEditBtn.classList.toggle("is-active", !isAdvise);
    aiModeAdviseBtn.classList.toggle("is-active", isAdvise);
    aiInput.placeholder = pinnedSelection
      ? (isAdvise ? "围绕选中片段提问或诊断…（Ctrl+Enter）" : "告诉 AI 如何改写这段选中内容…（Ctrl+Enter）")
      : (isAdvise ? "让 AI 诊断文章、起标题、查风险或给建议…（Ctrl+Enter）" : "告诉 AI 如何修改这篇文章，或先选好 Skill…（Ctrl+Enter）");
    aiRunBtn.disabled = aiEditing;
    aiRunBtn.textContent = aiEditing ? "处理中…" : (isAdvise ? "提问" : "改稿 ✨");
    aiUndoTopBtn.classList.toggle("hidden", !lastAiUndo);
    aiDrawerToggleBtn.classList.toggle("is-active", Boolean(state.aiDrawerOpen));
    aiDrawerToggleBtn.setAttribute("aria-pressed", String(Boolean(state.aiDrawerOpen)));

    const chat = Array.isArray(state.aiChat) ? state.aiChat : [];
    aiClearChatBtn.disabled = chat.length === 0 && !aiEditing;

    // Pinned selection context chip
    clear(copilotSelectionChip);
    if (pinnedSelection?.text) {
      copilotSelectionChip.classList.remove("hidden");
      const preview = pinnedSelection.text.replace(/\s+/g, " ");
      copilotSelectionChip.append(
        el("span", { class: "ic-cop-sel-chip-ico", "aria-hidden": "true" }, "📌"),
        el("span", { class: "ic-cop-sel-chip-text", title: pinnedSelection.text },
          `选中片段 (${pinnedSelection.text.length} 字)：${preview.slice(0, 32)}${preview.length > 32 ? "…" : ""}`
        ),
        el("button", {
          type: "button",
          class: "ic-art-skill-chip-x",
          title: "取消引用选中片段",
          "aria-label": "取消引用选中片段",
          onClick: () => {
            pinnedSelection = null;
            renderCopilotPanel();
          },
        }, "×")
      );
    } else {
      copilotSelectionChip.classList.add("hidden");
    }

    clear(copilotFeed);
    if (!chat.length && !aiEditing) {
      copilotFeed.appendChild(el("div", { class: "ic-cop-empty" },
        el("div", { class: "ic-cop-empty-title" }, "边写边聊，所见即所得改稿"),
        el("p", { class: "muted ic-cop-empty-desc" }, "支持调用已安装的写作 / 排雷 Skill；在左侧正文划选任意段落，还能只改局部不伤全文。"),
        el("div", { class: "ic-cop-presets" },
          ...COPILOT_PRESETS.map((p) => el("button", {
            type: "button",
            class: "ic-cop-preset-btn",
            onClick: () => {
              state.aiMode = p.mode;
              runAiArticleEdit({ instructionOverride: p.prompt, modeOverride: p.mode });
            },
          },
            el("span", { class: "ic-cop-preset-tag" }, p.mode === "advise" ? "建议" : "改稿"),
            el("span", null, p.label)
          ))
        )
      ));
      return;
    }

    chat.forEach((msg) => {
      if (msg.role === "user") {
        copilotFeed.appendChild(el("div", { class: "ic-cop-msg is-user" },
          msg.selection ? el("div", { class: "ic-cop-msg-quote" }, `📌 ${msg.selection.slice(0, 60)}${msg.selection.length > 60 ? "…" : ""}`) : null,
          el("div", { class: "ic-cop-msg-text" }, msg.text || ""),
          Array.isArray(msg.skills) && msg.skills.length
            ? el("div", { class: "ic-cop-msg-tags" }, ...msg.skills.map((s) => el("span", { class: "badge badge-accent" }, `⚡ ${s}`)))
            : null
        ));
        return;
      }

      // Assistant advice message
      if (msg.kind === "advise") {
        copilotFeed.appendChild(el("div", { class: "ic-cop-msg is-ai" },
          el("div", { class: "ic-cop-msg-meta" },
            el("span", { class: "badge" }, "诊断 / 建议"),
            ...(msg.usedSkills || []).map((u) => el("span", { class: "badge badge-accent" }, `⚡ ${u.name || u.id}`)),
            msg.model ? el("span", { class: "muted", style: { fontSize: "11px" } }, msg.model) : null
          ),
          renderCopilotMarkdown(msg.reply || ""),
          el("div", { class: "ic-cop-msg-actions" },
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(msg.reply || "");
                  toast("已复制建议内容");
                } catch { toast("复制失败"); }
              },
            }, "复制"),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => {
                state.aiMode = "edit";
                aiInput.value = "请按照你刚才给出的诊断建议，直接帮我修改文章正文。";
                resizeAiInput();
                renderCopilotPanel();
                aiInput.focus();
              },
            }, "按此建议改稿 →")
          )
        ));
        return;
      }

      // Assistant revision card (edit or selection)
      if (msg.revision) {
        const rev = msg.revision;
        const isReviewing = activeDiffReview?.msgId === msg.id;
        const charDelta = rev.kind === "selection"
          ? `${(rev.selection || "").length} → ${(rev.replacement || "").length} 字`
          : `${(rev.prevContent || "").length} → ${(rev.content || "").length} 字`;
        const canUndoThis = Boolean(lastAiUndo && lastAiUndo.msgId === msg.id);

        copilotFeed.appendChild(el("div", {
          class: "ic-cop-msg is-ai ic-cop-rev-card" + (isReviewing ? " is-reviewing" : "") + (msg.applied ? " is-applied" : ""),
        },
          el("div", { class: "ic-cop-msg-meta" },
            el("span", { class: "badge badge-accent" }, rev.kind === "selection" ? "局部改写" : "全文修订"),
            ...(rev.usedSkills || []).map((u) => el("span", { class: "badge" }, `⚡ ${u.name || u.id}`)),
            el("span", { class: "muted mono", style: { fontSize: "11px" } }, charDelta),
            msg.applied ? el("span", { class: "badge badge-ok" }, "✓ 已应用") : null,
            msg.discarded ? el("span", { class: "badge" }, "已忽略") : null
          ),
          el("p", { class: "ic-cop-rev-summary" }, rev.summary || "已完成文章修改"),
          rev.kind === "selection" && rev.replacement
            ? el("div", { class: "ic-cop-sel-preview" }, renderInlineWordDiff(rev.selection || "", rev.replacement || ""))
            : null,
          el("div", { class: "ic-cop-msg-actions" },
            !msg.applied && !msg.discarded
              ? el("button", {
                  type: "button",
                  class: "btn btn-sm" + (isReviewing ? " is-active" : ""),
                  onClick: () => (isReviewing ? exitInlineDiffReview() : openInlineDiffReview(msg)),
                }, isReviewing ? "收起审阅" : "🔍 审阅改动")
              : null,
            !msg.applied && !msg.discarded
              ? el("button", {
                  type: "button",
                  class: "btn btn-sm btn-primary",
                  onClick: () => applyRevisionDirect(msg),
                }, rev.kind === "selection" ? "✓ 替换选中" : "✓ 应用全部")
              : null,
            !msg.applied && !msg.discarded
              ? el("button", {
                  type: "button",
                  class: "btn btn-sm",
                  onClick: () => {
                    msg.discarded = true;
                    if (activeDiffReview?.msgId === msg.id) activeDiffReview = null;
                    renderStageMode();
                    renderCopilotPanel();
                    session.persist();
                  },
                }, "放弃")
              : null,
            canUndoThis
              ? el("button", { type: "button", class: "btn btn-sm", onClick: undoLastAiRevision }, "↩ 撤销这次改动")
              : null,
            msg.discarded
              ? el("button", {
                  type: "button",
                  class: "btn btn-sm",
                  onClick: () => {
                    msg.discarded = false;
                    openInlineDiffReview(msg);
                  },
                }, "重新查看")
              : null
          )
        ));
      }
    });

    if (aiEditing) {
      copilotFeed.appendChild(el("div", { class: "ic-cop-msg is-ai ic-cop-thinking" },
        el("span", { class: "ic-cop-dot" }),
        el("span", null, state.aiMode === "advise" ? "正在通读文章并整理诊断建议…" : "正在分析文章并生成修改方案…")
      ));
    }

    copilotFeed.scrollTop = copilotFeed.scrollHeight;
  }

  function replaceSelectionInContent(fullContent, selObj, replacement) {
    const src = String(fullContent || "");
    const target = selObj?.text || "";
    if (!target) return src;
    const idx = src.indexOf(target);
    if (idx >= 0) {
      return src.slice(0, idx) + replacement + src.slice(idx + target.length);
    }
    return src;
  }

  async function runAiArticleEdit({ instructionOverride, modeOverride, selectionOverride } = {}) {
    if (aiEditing) return;
    const instruction = (typeof instructionOverride === "string" ? instructionOverride : aiInput.value).trim();
    if (!instruction) {
      toast("请先输入希望 AI 处理文章的要求");
      aiInput.focus();
      return;
    }
    if (!state.content?.trim() && !state.title?.trim()) {
      toast("当前文章正文为空，请先打开或输入文章内容");
      return;
    }

    const mode = modeOverride || state.aiMode || "edit";
    const selObj = selectionOverride || pinnedSelection;
    const selText = selObj?.text || "";
    const skillIds = Array.isArray(state.aiSkillIds) ? state.aiSkillIds : [];
    const byId = new Map(installedSkills.map((sk) => [sk.id, sk]));
    const skillNames = skillIds.map((id) => byId.get(id)?.name || id);

    if (!Array.isArray(state.aiChat)) state.aiChat = [];
    const history = state.aiChat.slice(-6).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.role === "user" ? (m.text || "") : (m.kind === "advise" ? (m.reply || "") : (m.revision?.summary || "已完成改稿")),
    })).filter((h) => h.content);

    state.aiChat.push({
      id: `u_${Date.now()}`,
      role: "user",
      text: instruction,
      selection: selText,
      skills: skillNames,
    });
    if (typeof instructionOverride !== "string") {
      aiInput.value = "";
      resizeAiInput();
    }
    state.aiDrawerOpen = true;
    aiEditing = true;
    renderStageMode();
    renderCopilotPanel();

    const prevTitle = state.title || "";
    const prevContent = state.content || "";
    try {
      const res = await api("POST", "/api/article/edit", {
        title: prevTitle,
        content: prevContent,
        instruction,
        mode,
        selection: selText,
        history,
        skillIds,
        textModelRef: state.textModelRef,
      });

      if (res.mode === "advise") {
        state.aiChat.push({
          id: `a_${Date.now()}`,
          role: "assistant",
          kind: "advise",
          reply: res.reply || "",
          usedSkills: res.usedSkills || [],
          model: res.model || "",
        });
        toast("AI 诊断建议已生成");
      } else if (res.mode === "selection") {
        const replacement = res.replacement ?? selText;
        const nextContent = replaceSelectionInContent(prevContent, selObj, replacement);
        const aiMsg = {
          id: `a_${Date.now()}`,
          role: "assistant",
          kind: "selection",
          applied: false,
          discarded: false,
          revision: {
            kind: "selection",
            title: prevTitle,
            content: nextContent,
            prevTitle,
            prevContent,
            selection: selText,
            replacement,
            summary: res.summary || "已完成局部片段改写",
            usedSkills: res.usedSkills || [],
          },
        };
        state.aiChat.push(aiMsg);
        pinnedSelection = null;
        openInlineDiffReview(aiMsg);
        toast("局部改写已就绪，已在纸面高亮差异");
      } else {
        const aiMsg = {
          id: `a_${Date.now()}`,
          role: "assistant",
          kind: "edit",
          applied: false,
          discarded: false,
          revision: {
            kind: "edit",
            title: res.title ?? prevTitle,
            content: res.content ?? prevContent,
            prevTitle,
            prevContent,
            summary: res.summary || "已完成文章修改",
            usedSkills: res.usedSkills || [],
          },
        };
        state.aiChat.push(aiMsg);
        openInlineDiffReview(aiMsg);
        toast("AI 改稿完成，已在纸面高亮差异供逐段审阅");
      }
      if (state.aiChat.length > 24) state.aiChat = state.aiChat.slice(-24);
      session.persist();
    } catch (e) {
      state.aiChat.push({
        id: `err_${Date.now()}`,
        role: "assistant",
        kind: "advise",
        reply: `⚠️ 请求失败：${e.message || "AI 改稿失败"}`,
      });
      toast(e.message || "AI 处理失败");
    } finally {
      aiEditing = false;
      if (aiDrawer.isConnected) {
        renderStageMode();
        renderCopilotPanel();
      }
    }
  }

  // 4. Fixed Bottom Bar
  const modelSel = buildGroupedModelSelect(modRes, state.modelRef);
  state.modelRef = modelSel.value;
  modelSel.addEventListener("change", () => { state.modelRef = modelSel.value; });

  const charCounter = el("span", { style: { fontSize: "12px", color: "var(--ink-muted)", whiteSpace: "nowrap" } });
  const styleBadgeImg = el("img", { class: "ic-wechat-style-thumb", alt: "" });
  const styleBadgeId = el("span", { class: "ic-wechat-style-id" });
  const styleBadgeName = el("span", { class: "ic-wechat-style-name" });
  const styleBadgeBtn = el("button", {
    type: "button",
    class: "ic-wechat-style-badge",
    title: "点击更换手绘画风",
    onClick: () => openResourceDialog("画风", styles, state.style, (id) => {
      if (!id) return;
      state.style = id;
      syncBottomBar();
      renderRecommendedStyles();
      session.persist();
    }, { empty: "" }),
  },
    styleBadgeImg,
    el("div", { class: "ic-wechat-style-meta" }, styleBadgeId, styleBadgeName),
    el("span", { class: "muted", style: { fontSize: "10.5px" } }, "更换 ▾")
  );

  const coverRatioMiniIn = el("input", { class: "input", value: state.coverRatio, title: "封面比例", "aria-label": "封面比例" });
  coverRatioMiniIn.addEventListener("input", () => {
    if (validRatio(coverRatioMiniIn.value.trim())) { state.coverRatio = coverRatioMiniIn.value.trim(); session.persist(); }
  });
  const inlineRatioMiniIn = el("input", { class: "input", value: state.inlineRatio, title: "插图比例", "aria-label": "章节插图比例" });
  inlineRatioMiniIn.addEventListener("input", () => {
    if (validRatio(inlineRatioMiniIn.value.trim())) { state.inlineRatio = inlineRatioMiniIn.value.trim(); session.persist(); }
  });

  const moreParamsBtn = el("button", { type: "button", class: "btn btn-sm", onClick: openMoreSettingsModal }, "⚙ 配图参数");
  const planBtn = el("button", { type: "button", class: "btn btn-sm", onClick: planArticle }, "✨ AI 规划配图");
  const sampleBtn = el("button", { type: "button", class: "btn btn-sm", onClick: () => runGenerate(true, false) }, "封面样张");
  const batchBtn = el("button", { type: "button", class: "btn btn-sm", onClick: () => runGenerate(false, false) }, "生成配图");
  const exportBtn = el("button", { type: "button", class: "btn btn-sm", onClick: openExportModal }, "导出");

  const bottombar = el("footer", { class: "ic-wechat-bottombar" },
    el("div", { class: "ic-wechat-bottombar-left" },
      modelSel,
      charCounter,
      styleBadgeBtn,
      el("label", { class: "ic-wechat-ratio-mini" }, el("span", null, "封面"), coverRatioMiniIn),
      el("label", { class: "ic-wechat-ratio-mini" }, el("span", null, "插图"), inlineRatioMiniIn),
      moreParamsBtn
    ),
    el("div", { class: "ic-wechat-bottombar-right" },
      planBtn,
      sampleBtn,
      batchBtn,
      exportBtn
    )
  );

  root.appendChild(el("div", { class: "ic-wechat-editor-root" },
    topbar,
    el("div", { class: "ic-wechat-body" }, sidebar, centerCol, copilotBackdrop, aiDrawer),
    bottombar,
    obsidianCtrl.hostWrap
  ));

  const onArticleGlobalKeydown = (e) => {
    if (!root.isConnected) {
      document.removeEventListener("keydown", onArticleGlobalKeydown);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveDraft();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l" && state.editorActive) {
      e.preventDefault();
      toggleAiDrawer();
    }
  };
  document.addEventListener("keydown", onArticleGlobalKeydown);

  // Paragraph helpers
  function paragraphBlocks() {
    return (state.content || "").split(/\r?\n/).map((line, lineIdx) => ({ lineIdx, text: line, trimmed: line.trim() })).filter((b) => b.trimmed);
  }

  function syncTopbarBreadcrumb() {
    if (state.activeFile) {
      activeBreadcrumb.textContent = state.activeFile + (state.dirty ? " ●" : "");
      activeBreadcrumb.title = `${vault.dir}/${state.activeFile}`;
      saveBtn.textContent = state.dirty ? "💾 保存 MD ●" : "💾 保存 MD";
    } else if (state.docId) {
      activeBreadcrumb.textContent = (state.title || "本地草稿") + (state.dirty ? " ●" : "");
      activeBreadcrumb.title = "本地草稿";
      saveBtn.textContent = "💾 保存草稿";
    } else {
      activeBreadcrumb.textContent = state.dirty ? "未保存文稿 ●" : "";
      activeBreadcrumb.title = "";
      saveBtn.textContent = "💾 存为 MD";
    }
  }

  let vaultPopoverEl = null;
  let vaultPopoverCleanup = null;
  let treeCtxMenuEl = null;
  let treeCtxMenuCleanup = null;
  let treeCtxTargetEl = null;

  function parentDirOf(relPath) {
    const clean = String(relPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const idx = clean.lastIndexOf("/");
    return idx > 0 ? clean.slice(0, idx) : "";
  }

  function closeTreeContextMenu() {
    if (treeCtxMenuCleanup) {
      treeCtxMenuCleanup();
      treeCtxMenuCleanup = null;
    }
    if (treeCtxMenuEl) {
      treeCtxMenuEl.remove();
      treeCtxMenuEl = null;
    }
    if (treeCtxTargetEl) {
      treeCtxTargetEl.classList.remove("is-ctx-target");
      treeCtxTargetEl = null;
    }
  }

  function closeVaultPopover() {
    if (vaultPopoverCleanup) {
      vaultPopoverCleanup();
      vaultPopoverCleanup = null;
    }
    if (vaultPopoverEl) {
      vaultPopoverEl.remove();
      vaultPopoverEl = null;
    }
    vaultSwitcherBtn.setAttribute("aria-expanded", "false");
    vaultSwitcherBtn.classList.remove("is-open");
  }

  function applyVaultPayload(res, { resetEditor = false } = {}) {
    closeTreeContextMenu();
    closeSelectionBubble();
    vault = res || vault;
    if (!Array.isArray(vault.vaults)) vault.vaults = [];
    loadExpandedForVault(vault.dir, vault.tree);
    if (resetEditor) {
      state.activeFile = "";
      state.selectedDir = "";
      state.docId = "";
      state.editorActive = false;
      state.dirty = false;
      state.aiChat = [];
      activeDiffReview = null;
      pinnedSelection = null;
      lastAiUndo = null;
    }
    renderAll();
    session.persist();
  }

  function guardDirtyBeforeSwitch(proceed) {
    if (!state.editorActive || !state.dirty) {
      proceed();
      return;
    }
    showModal("当前文档有未保存修改", el("p", null, "切换目录前是否先保存当前文档的修改？"), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn",
        onClick: () => {
          closeModal();
          proceed();
        },
      }, "放弃修改并切换"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          await saveDraft();
          closeModal();
          proceed();
        },
      }, "保存并切换"),
    ]);
  }

  async function refreshVaultTree() {
    try {
      const res = await api("GET", "/api/article/vault/tree");
      vault = res || vault;
      if (!Array.isArray(vault.vaults)) vault.vaults = [];
      renderSidebar();
      if (!state.editorActive) renderWelcome();
      obsidianCtrl.syncVault();
    } catch (e) {
      toast(e.message || "刷新目录失败");
    }
  }

  async function switchVaultDir(dir) {
    if (!dir) return;
    const same = String(vault.dir || "").toLowerCase() === String(dir).toLowerCase();
    if (same) {
      closeVaultPopover();
      return;
    }
    guardDirtyBeforeSwitch(async () => {
      try {
        const res = await api("POST", "/api/article/vault/root", { dir });
        treeQuery = "";
        vaultFilterIn.value = "";
        applyVaultPayload(res, { resetEditor: true });
        obsidianCtrl.syncVault();
        obsidianCtrl.syncDoc(true);
        toast(`已切换目录：${vault.name || vault.dir}`);
      } catch (e) {
        toast(e.message || "切换目录失败");
      }
    });
  }

  async function addVaultDir(dir, activate = true) {
    const res = await api("POST", "/api/article/vault/vaults", { dir, activate });
    if (activate) {
      treeQuery = "";
      vaultFilterIn.value = "";
    }
    applyVaultPayload(res, { resetEditor: activate });
    toast(`已添加本地目录：${res.name || dir}`);
  }

  async function removeVaultDir(v, { skipConfirm = false } = {}) {
    if (!v?.dir) return;
    const list = Array.isArray(vault.vaults) ? vault.vaults : [];
    if (list.length <= 1 && v.isDefault) {
      toast("默认文章目录不可移出，可先添加其他目录");
      return;
    }
    const doRemove = async () => {
      try {
        const wasActive = Boolean(v.active);
        const res = await api("DELETE", `/api/article/vault/vaults?dir=${encodeURIComponent(v.dir)}`);
        if (wasActive) {
          treeQuery = "";
          vaultFilterIn.value = "";
        }
        applyVaultPayload(res, { resetEditor: wasActive });
        toast(`已从列表移出「${v.name}」（本地文件未删除）`);
      } catch (e) {
        toast(e.message || "移出目录失败");
      }
    };
    if (skipConfirm) {
      await doRemove();
      return;
    }
    showModal("从目录列表移出", el("div", { class: "col", style: { gap: "6px" } },
      el("p", { style: { margin: 0 } }, `确定将「${v.name}」从左侧目录列表中移出吗？`),
      el("p", { class: "muted mono", style: { margin: 0, fontSize: "12px", wordBreak: "break-all" } }, v.dir),
      el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px" } }, "仅从手绘风目录列表中移除，不会删除磁盘上的任何文件夹或 Markdown 文件。")
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-danger",
        onClick: async () => {
          closeModal();
          await doRemove();
        },
      }, "移出列表"),
    ]);
  }

  function openManualAddVaultModal() {
    const dirIn = el("input", {
      class: "input mono",
      placeholder: "例如：D:\\ObsidianVault\\知识库 或 /Users/me/Notes",
    });
    showModal("添加本地 Markdown 目录", el("div", { class: "col", style: { gap: "8px" } },
      el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px" } }, "可添加多个 Obsidian 仓库或任意本地 Markdown 文件夹，随时在左侧底部一键切换："),
      dirIn
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          if (!dirIn.value.trim()) return toast("请输入目录路径");
          try {
            await addVaultDir(dirIn.value.trim(), true);
            closeModal();
          } catch (e) { toast(e.message); }
        },
      }, "添加并切换"),
    ]);
    dirIn.focus();
  }

  async function openAddVaultDialog() {
    try {
      const picked = await api("POST", "/api/host/pick-directory", {});
      if (picked && typeof picked.path === "string") {
        if (!picked.path.trim()) return; // user cancelled native dialog
        await addVaultDir(picked.path.trim(), true);
        return;
      }
    } catch {
      // Fall back to manual directory path modal (e.g. browser/web mode).
    }
    openManualAddVaultModal();
  }

  function parentHint(fullPath) {
    const norm = String(fullPath || "").replace(/[\\/]+$/, "");
    const parts = norm.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 1) return "";
    return parts.slice(Math.max(0, parts.length - 3), parts.length - 1).join("/");
  }

  function openManageVaultsModal() {
    const listWrap = el("div", { class: "ic-vault-mgr-list" });
    const renderMgrList = () => {
      clear(listWrap);
      const list = Array.isArray(vault.vaults) ? vault.vaults : [];
      if (!list.length) {
        listWrap.appendChild(el("p", { class: "muted", style: { margin: "8px 0", textAlign: "center" } }, "暂无已添加目录"));
        return;
      }
      list.forEach((v) => {
        const canRemove = list.length > 1 || !v.isDefault;
        listWrap.appendChild(el("div", { class: "ic-vault-mgr-item" + (v.active ? " is-active" : "") },
          el("div", { class: "ic-vault-mgr-meta" },
            el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
              el("strong", { style: { fontSize: "13px" } }, v.name || v.dir),
              v.active ? el("span", { class: "badge badge-accent" }, "当前使用") : null,
              v.isDefault ? el("span", { class: "badge" }, "默认目录") : null,
              !v.exists ? el("span", { class: "badge badge-warn" }, "路径不存在") : null
            ),
            el("div", { class: "ic-vault-mgr-path mono", title: v.dir }, v.dir)
          ),
          el("div", { class: "row", style: { gap: "6px", flexShrink: 0 } },
            !v.active && v.exists
              ? el("button", {
                  type: "button",
                  class: "btn btn-sm",
                  onClick: () => {
                    closeModal();
                    switchVaultDir(v.dir);
                  },
                }, "切换")
              : null,
            el("button", {
              type: "button",
              class: "btn btn-sm btn-danger",
              disabled: !canRemove,
              title: canRemove ? "仅从列表移出，不删除本地文件" : "默认目录不可移出，可先添加其他目录",
              onClick: async () => {
                await removeVaultDir(v, { skipConfirm: true });
                renderMgrList();
              },
            }, "移出")
          )
        ));
      });
    };
    renderMgrList();

    showModal("管理本地 Markdown 目录", el("div", { class: "col", style: { gap: "10px" } },
      el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px" } }, "可添加多个 Obsidian 仓库或本地文章目录；移出目录仅从软件列表中移除，绝不会删除本地文件。"),
      listWrap
    ), [
      el("button", {
        type: "button",
        class: "btn",
        onClick: () => {
          closeModal();
          openManualAddVaultModal();
        },
      }, "手动输入路径"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          closeModal();
          await openAddVaultDialog();
        },
      }, "＋ 添加本地目录"),
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    ]);
  }

  function openVaultPopover() {
    closeTreeContextMenu();
    closeVaultPopover();
    const list = Array.isArray(vault.vaults) ? vault.vaults : [];
    const nameCounts = new Map();
    list.forEach((v) => {
      const k = String(v.name || "").toLowerCase();
      nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
    });

    let popQuery = "";
    const popList = el("div", { class: "ic-vault-pop-list", role: "menu" });
    const renderPopItems = () => {
      clear(popList);
      const filtered = popQuery
        ? list.filter((v) => `${v.name} ${v.dir}`.toLowerCase().includes(popQuery))
        : list;
      if (!filtered.length) {
        popList.appendChild(el("div", { class: "ic-vault-pop-empty muted" }, "没有匹配的目录"));
        return;
      }
      filtered.forEach((v) => {
        const dupName = (nameCounts.get(String(v.name || "").toLowerCase()) || 0) > 1;
        const canRemove = list.length > 1 || !v.isDefault;
        const mainBtn = el("button", {
          type: "button",
          class: "ic-vault-pop-item" + (v.active ? " is-active" : ""),
          role: "menuitemradio",
          "aria-checked": String(Boolean(v.active)),
          title: v.dir,
          disabled: !v.exists && !v.active,
          onClick: () => {
            closeVaultPopover();
            switchVaultDir(v.dir);
          },
        },
          el("span", { class: "ic-vault-pop-label" },
            el("span", { class: "ic-vault-pop-name" }, v.name || v.dir),
            dupName ? el("span", { class: "ic-vault-pop-sub mono" }, parentHint(v.dir)) : null,
            !v.exists ? el("span", { class: "ic-vault-pop-missing" }, "失效") : null
          ),
          v.active ? el("span", { class: "ic-vault-pop-check", "aria-hidden": "true" }, "✓") : null
        );
        const delBtn = canRemove
          ? el("button", {
              type: "button",
              class: "ic-vault-pop-del",
              title: `从列表移出「${v.name}」（不删除本地文件）`,
              "aria-label": `移出目录 ${v.name}`,
              onClick: (e) => {
                e.stopPropagation();
                closeVaultPopover();
                removeVaultDir(v);
              },
            }, "×")
          : null;
        popList.appendChild(el("div", { class: "ic-vault-pop-row" + (v.active ? " is-active" : "") }, mainBtn, delBtn));
      });
    };

    const popSearch = list.length >= 6
      ? el("input", {
          type: "search",
          class: "input ic-vault-pop-search",
          placeholder: "快速筛选目录…",
          "aria-label": "筛选本地目录",
        })
      : null;
    if (popSearch) {
      popSearch.addEventListener("input", () => {
        popQuery = popSearch.value.trim().toLowerCase();
        renderPopItems();
      });
    }

    renderPopItems();

    const pop = el("div", { class: "ic-vault-popover", role: "dialog", "aria-label": "切换本地目录" },
      popSearch ? el("div", { class: "ic-vault-pop-search-wrap" }, popSearch) : null,
      popList,
      el("div", { class: "ic-vault-pop-foot" },
        el("button", {
          type: "button",
          class: "ic-vault-pop-action",
          onClick: () => {
            closeVaultPopover();
            openAddVaultDialog();
          },
        },
          el("span", { "aria-hidden": "true" }, "＋"),
          el("span", null, "添加本地目录…")
        ),
        el("button", {
          type: "button",
          class: "ic-vault-pop-action",
          onClick: () => {
            closeVaultPopover();
            openManageVaultsModal();
          },
        },
          el("span", { "aria-hidden": "true" }, "⚙"),
          el("span", null, `管理目录 (${list.length})…`)
        )
      )
    );

    const rect = vaultSwitcherBtn.getBoundingClientRect();
    const popWidth = Math.min(310, Math.max(252, Math.round(rect.width + 64)));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popWidth - 8));
    const bottom = Math.max(12, window.innerHeight - rect.top + 6);
    pop.style.left = `${left}px`;
    pop.style.bottom = `${bottom}px`;
    pop.style.width = `${popWidth}px`;

    document.body.appendChild(pop);
    vaultPopoverEl = pop;
    vaultSwitcherBtn.setAttribute("aria-expanded", "true");
    vaultSwitcherBtn.classList.add("is-open");
    if (popSearch) popSearch.focus();

    const onDocDown = (e) => {
      if (!pop.contains(e.target) && !vaultSwitcherBtn.contains(e.target)) {
        closeVaultPopover();
      }
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") closeVaultPopover();
    };
    const onResize = () => closeVaultPopover();
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
    vaultPopoverCleanup = () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize);
    };
  }

  function toggleVaultPopover() {
    if (vaultPopoverEl) closeVaultPopover();
    else openVaultPopover();
  }

  function buildTargetDirBanner(initialDir, onChange) {
    let dir = String(initialDir || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const banner = el("div", { class: "ic-vault-modal-target" });
    const render = () => {
      clear(banner);
      banner.appendChild(el("span", { class: "ic-vault-modal-target-label" }, "位置"));
      banner.appendChild(el("span", { class: "ic-vault-modal-target-path mono", title: dir || vault.dir || "" },
        dir ? `${dir}/` : `${vault.name || "根目录"}（根目录）`
      ));
      if (dir) {
        banner.appendChild(el("button", {
          type: "button",
          class: "ic-vault-modal-target-reset",
          onClick: () => {
            dir = "";
            onChange("");
            render();
          },
        }, "切到根目录"));
      }
    };
    render();
    return { el: banner, getDir: () => dir };
  }

  function openNewMarkdownModal(targetDir) {
    const initialDir = typeof targetDir === "string" ? targetDir : (state.selectedDir || "");
    let currentDir = String(initialDir || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const targetBanner = buildTargetDirBanner(currentDir, (next) => { currentDir = next; });
    const pathIn = el("input", {
      class: "input",
      placeholder: currentDir ? "例如：春日手账 或 子目录/咖啡笔记" : "例如：春日手账.md 或 2026/咖啡笔记.md",
    });

    const submit = async () => {
      const raw = pathIn.value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
      if (!raw) return toast("请输入文件名");
      const fullRel = currentDir ? `${currentDir}/${raw}` : raw;
      const baseName = raw.split("/").pop().replace(/\.(md|markdown)$/i, "") || "未命名文章";
      try {
        const created = await api("PUT", "/api/article/vault/file", {
          path: fullRel,
          title: baseName,
          content: `# ${baseName}\n\n`,
        });
        closeModal();
        const parts = String(created.path || "").split("/");
        for (let i = 1; i < parts.length; i++) {
          expandedDirs.add(parts.slice(0, i).join("/"));
        }
        persistExpanded();
        state.selectedDir = parentDirOf(created.path);
        await refreshVaultTree();
        await openVaultFile(created.path);
        toast(`已创建 ${created.path}`);
      } catch (e) { toast(e.message); }
    };

    pathIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    showModal("新建本地 Markdown 文章", el("div", { class: "col", style: { gap: "10px" } },
      targetBanner.el,
      pathIn,
      el("p", { class: "muted", style: { margin: 0, fontSize: "12px" } }, "自动补全 .md 后缀，也支持用 / 一次创建多级子目录。")
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", { type: "button", class: "btn btn-primary", onClick: submit }, "创建并编辑"),
    ]);
    pathIn.focus();
  }

  function openNewFolderModal(targetDir) {
    const initialDir = typeof targetDir === "string" ? targetDir : (state.selectedDir || "");
    let currentDir = String(initialDir || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const targetBanner = buildTargetDirBanner(currentDir, (next) => { currentDir = next; });
    const nameIn = el("input", {
      class: "input",
      placeholder: currentDir ? "例如：灵感草稿 或 01-素材" : "例如：2026/随笔 或 公众号合集",
    });

    const submit = async () => {
      const raw = nameIn.value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (!raw) return toast("请输入文件夹名称");
      const fullRel = currentDir ? `${currentDir}/${raw}` : raw;
      try {
        const created = await api("POST", "/api/article/vault/mkdir", { path: fullRel });
        closeModal();
        const parts = String(created.path || "").split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
          expandedDirs.add(parts.slice(0, i).join("/"));
        }
        persistExpanded();
        state.selectedDir = created.path || fullRel;
        await refreshVaultTree();
        session.persist();
        toast(`已新建文件夹 ${state.selectedDir}`);
      } catch (e) { toast(e.message); }
    };

    nameIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    showModal("新建文件夹", el("div", { class: "col", style: { gap: "10px" } },
      targetBanner.el,
      nameIn,
      el("p", { class: "muted", style: { margin: 0, fontSize: "12px" } }, "新建后会自动选中该文件夹，随后新建的 Markdown 文件会直接放入其中。")
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", { type: "button", class: "btn btn-primary", onClick: submit }, "创建文件夹"),
    ]);
    nameIn.focus();
  }

  function rewritePathPrefix(value, oldPrefix, newPrefix) {
    if (!value) return value;
    if (value === oldPrefix) return newPrefix;
    if (value.startsWith(`${oldPrefix}/`)) return `${newPrefix}${value.slice(oldPrefix.length)}`;
    return value;
  }

  function openRenameModal(target) {
    if (!target?.path) return;
    const isFile = target.kind === "file";
    const parent = parentDirOf(target.path);
    const currentBase = target.name || target.path.split("/").pop() || "";
    const initialVal = isFile ? currentBase.replace(/\.(md|markdown)$/i, "") : currentBase;
    const nameIn = el("input", {
      class: "input",
      value: initialVal,
      placeholder: isFile ? "输入新文件名（自动保留 .md）" : "输入新文件夹名称",
    });

    const submit = async () => {
      const raw = nameIn.value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (!raw) return toast(isFile ? "请输入新文件名" : "请输入新文件夹名");
      if (raw.includes("/")) return toast("名称不能包含斜杠 /");
      const finalLeaf = isFile && !/\.(md|markdown)$/i.test(raw) ? `${raw}.md` : raw;
      const toPath = parent ? `${parent}/${finalLeaf}` : finalLeaf;
      if (toPath === target.path) {
        closeModal();
        return;
      }
      try {
        const res = await api("POST", "/api/article/vault/rename", {
          from: target.path,
          to: toPath,
        });
        closeModal();
        const nextPath = res.path || toPath;
        if (isFile) {
          if (state.activeFile === target.path) {
            state.activeFile = nextPath;
            syncTopbarBreadcrumb();
          }
        } else {
          const nextExpanded = new Set();
          expandedDirs.forEach((p) => nextExpanded.add(rewritePathPrefix(p, target.path, nextPath)));
          expandedDirs = nextExpanded;
          persistExpanded();
          state.selectedDir = rewritePathPrefix(state.selectedDir, target.path, nextPath);
          if (state.activeFile) {
            const rewritten = rewritePathPrefix(state.activeFile, target.path, nextPath);
            if (rewritten !== state.activeFile) {
              state.activeFile = rewritten;
              syncTopbarBreadcrumb();
            }
          }
        }
        await refreshVaultTree();
        session.persist();
        toast(`已重命名为 ${nextPath}`);
      } catch (e) { toast(e.message); }
    };

    nameIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    showModal(isFile ? "重命名 Markdown 文件" : "重命名文件夹", el("div", { class: "col", style: { gap: "8px" } },
      el("p", { class: "muted mono", style: { margin: 0, fontSize: "12px", wordBreak: "break-all" } }, `当前路径：${target.path}`),
      nameIn
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", { type: "button", class: "btn btn-primary", onClick: submit }, "确认重命名"),
    ]);
    nameIn.focus();
    nameIn.select();
  }

  async function duplicateVaultFile(relPath) {
    if (!relPath) return;
    try {
      const res = await api("POST", "/api/article/vault/duplicate", { path: relPath });
      const parts = String(res.path || "").split("/");
      for (let i = 1; i < parts.length; i++) {
        expandedDirs.add(parts.slice(0, i).join("/"));
      }
      persistExpanded();
      await refreshVaultTree();
      if (res.path) await openVaultFile(res.path);
      toast(`已创建副本 ${res.path}`);
    } catch (e) {
      toast(e.message || "创建副本失败");
    }
  }

  async function revealVaultPath(relPath) {
    try {
      await api("POST", "/api/article/vault/reveal", { path: relPath || "" });
      toast("已在系统文件管理器中打开");
    } catch (e) {
      toast(e.message || "打开系统目录失败");
    }
  }

  async function copyVaultRelPath(relPath) {
    const text = relPath || vault.dir || "";
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = el("textarea", { value: text, style: { position: "fixed", opacity: "0" } });
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      toast(`已复制路径：${text}`);
    } catch {
      toast("复制路径失败");
    }
  }

  function confirmDeleteFile(node) {
    if (!node?.path) return;
    showModal("删除本地 Markdown 文件", el("p", null, `确定删除「${node.path}」吗？该操作会直接从本地目录移除文件。`), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-danger",
        onClick: async () => {
          try {
            await api("DELETE", `/api/article/vault/file?path=${encodeURIComponent(node.path)}`);
            closeModal();
            if (state.activeFile === node.path) {
              state.activeFile = "";
              state.editorActive = false;
              state.dirty = false;
            }
            await refreshVaultTree();
            renderStageMode();
            session.persist();
            toast(`已删除 ${node.name || node.path}`);
          } catch (err) { toast(err.message); }
        },
      }, "确认删除"),
    ]);
  }

  function confirmDeleteDir(node) {
    if (!node?.path) return;
    showModal("删除文件夹", el("div", { class: "col", style: { gap: "6px" } },
      el("p", { style: { margin: 0 } }, `确定删除文件夹「${node.path}」吗？`),
      el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px" } }, "该操作会直接移除磁盘上的该文件夹及其中的全部子文件和子目录，无法撤销。")
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-danger",
        onClick: async () => {
          try {
            await api("DELETE", `/api/article/vault/dir?path=${encodeURIComponent(node.path)}`);
            closeModal();
            const prefix = `${node.path}/`;
            if (state.activeFile === node.path || String(state.activeFile || "").startsWith(prefix)) {
              state.activeFile = "";
              state.editorActive = false;
              state.dirty = false;
            }
            if (state.selectedDir === node.path || String(state.selectedDir || "").startsWith(prefix)) {
              state.selectedDir = parentDirOf(node.path);
            }
            Array.from(expandedDirs).forEach((p) => {
              if (p === node.path || p.startsWith(prefix)) expandedDirs.delete(p);
            });
            persistExpanded();
            await refreshVaultTree();
            renderStageMode();
            session.persist();
            toast(`已删除文件夹 ${node.name || node.path}`);
          } catch (err) { toast(err.message); }
        },
      }, "确认删除"),
    ]);
  }

  function openTreeContextMenu(ev, target, rowEl = null) {
    ev.preventDefault();
    ev.stopPropagation();
    closeVaultPopover();
    closeTreeContextMenu();

    const kind = target?.kind || "root";
    const relPath = target?.path || "";
    const allDirs = collectAllDirPaths(vault.tree || []);
    const items = [];

    if (kind === "dir") {
      const isExpanded = expandedDirs.has(relPath);
      items.push(
        { label: "在此新建 Markdown", icon: ICONS.newNote, run: () => openNewMarkdownModal(relPath) },
        { label: "新建子文件夹", icon: ICONS.newFolder, run: () => openNewFolderModal(relPath) },
        { sep: true },
        {
          label: isExpanded ? "折叠文件夹" : "展开文件夹",
          icon: isExpanded ? ICONS.collapse : ICONS.expand,
          run: () => {
            if (expandedDirs.has(relPath)) expandedDirs.delete(relPath);
            else expandedDirs.add(relPath);
            persistExpanded();
            renderSidebar();
          },
        },
        { label: "重命名", icon: ICONS.rename, run: () => openRenameModal(target) },
        { sep: true },
        { label: "在文件管理器中打开", icon: ICONS.reveal, run: () => revealVaultPath(relPath) },
        { label: "复制相对路径", icon: ICONS.copy, run: () => copyVaultRelPath(relPath) },
        { sep: true },
        { label: "删除文件夹", icon: ICONS.trash, danger: true, run: () => confirmDeleteDir(target) }
      );
    } else if (kind === "file") {
      const parent = parentDirOf(relPath);
      items.push(
        { label: "打开编辑", icon: ICONS.open, run: () => openVaultFile(relPath) },
        { label: "在同目录新建 Markdown", icon: ICONS.newNote, run: () => openNewMarkdownModal(parent) },
        { sep: true },
        { label: "重命名", icon: ICONS.rename, run: () => openRenameModal(target) },
        { label: "创建副本", icon: ICONS.duplicate, run: () => duplicateVaultFile(relPath) },
        { sep: true },
        { label: "在文件管理器中打开", icon: ICONS.reveal, run: () => revealVaultPath(relPath) },
        { label: "复制相对路径", icon: ICONS.copy, run: () => copyVaultRelPath(relPath) },
        { sep: true },
        { label: "删除文件", icon: ICONS.trash, danger: true, run: () => confirmDeleteFile(target) }
      );
    } else {
      const anyExpanded = expandedDirs.size > 0;
      items.push(
        { label: "在根目录新建 Markdown", icon: ICONS.newNote, run: () => openNewMarkdownModal("") },
        { label: "在根目录新建文件夹", icon: ICONS.newFolder, run: () => openNewFolderModal("") },
        { sep: true },
        { label: "刷新目录树", icon: ICONS.refresh, run: () => refreshVaultTree() },
        ...(allDirs.length > 0 ? [{
          label: anyExpanded ? "折叠全部文件夹" : "展开全部文件夹",
          icon: anyExpanded ? ICONS.collapse : ICONS.expand,
          run: () => {
            if (expandedDirs.size > 0) expandedDirs.clear();
            else allDirs.forEach((p) => expandedDirs.add(p));
            persistExpanded();
            renderSidebar();
          },
        }] : []),
        { sep: true },
        { label: "在文件管理器中打开", icon: ICONS.reveal, run: () => revealVaultPath("") }
      );
    }

    const menu = el("div", {
      class: "ic-vault-ctx-menu",
      role: "menu",
      "aria-label": kind === "dir" ? `文件夹操作：${target.name}` : (kind === "file" ? `文件操作：${target.name}` : "目录操作"),
    });

    const headerText = kind === "root" ? `${vault.name || "根目录"}（根目录）` : relPath;
    menu.appendChild(el("div", { class: "ic-vault-ctx-head mono", title: headerText }, headerText));

    const buttons = [];
    items.forEach((item) => {
      if (item.sep) {
        menu.appendChild(el("div", { class: "ic-vault-ctx-sep", role: "separator" }));
        return;
      }
      const btn = el("button", {
        type: "button",
        class: "ic-vault-ctx-item" + (item.danger ? " is-danger" : ""),
        role: "menuitem",
        onClick: () => {
          closeTreeContextMenu();
          item.run();
        },
      },
        el("span", { class: "ic-vault-ctx-ico", "aria-hidden": "true" }, makeIconSvg(item.icon, 14)),
        el("span", { class: "ic-vault-ctx-label" }, item.label)
      );
      buttons.push(btn);
      menu.appendChild(btn);
    });

    menu.style.left = "0px";
    menu.style.top = "0px";
    menu.style.visibility = "hidden";
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(ev.clientX, window.innerWidth - rect.width - pad));
    const top = Math.max(pad, Math.min(ev.clientY, window.innerHeight - rect.height - pad));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = "visible";

    treeCtxMenuEl = menu;
    if (rowEl) {
      rowEl.classList.add("is-ctx-target");
      treeCtxTargetEl = rowEl;
    }

    let focusedIdx = -1;
    const onDocDown = (e) => {
      if (!menu.contains(e.target)) closeTreeContextMenu();
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeTreeContextMenu();
        return;
      }
      if (!buttons.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusedIdx = (focusedIdx + 1) % buttons.length;
        buttons[focusedIdx].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusedIdx = (focusedIdx - 1 + buttons.length) % buttons.length;
        buttons[focusedIdx].focus();
      }
    };
    const onResize = () => closeTreeContextMenu();
    const onScroll = () => closeTreeContextMenu();
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
    treeBox.addEventListener("scroll", onScroll, { passive: true });
    treeCtxMenuCleanup = () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize);
      treeBox.removeEventListener("scroll", onScroll);
    };
  }

  async function openVaultFile(relPath) {
    if (!relPath) return;
    try {
      const res = await api("GET", `/api/article/vault/file?path=${encodeURIComponent(relPath)}`);
      let meta = {};
      try {
        meta = typeof res.meta === "string" ? JSON.parse(res.meta) : (res.meta || {});
      } catch {}
      const switchedFile = state.activeFile !== res.path;
      activeDiffReview = null;
      pinnedSelection = null;
      lastAiUndo = null;
      closeSelectionBubble();
      if (switchedFile) state.aiChat = [];
      Object.assign(state, {
        docId: "",
        activeFile: res.path,
        selectedDir: parentDirOf(res.path),
        editorActive: true,
        dirty: false,
        title: meta.title || res.title || "",
        content: res.content || "",
        style: meta.style || state.style || styles[0]?.number || "FA-013",
        style2: meta.style2 || "",
        fusion: meta.fusion ?? Boolean(meta.style2),
        layout: meta.layout || "",
        color: meta.color || "",
        tone: meta.tone || "",
        mood: meta.mood || "",
        mode: meta.mode || state.mode || "graphic-text",
        coverRatio: meta.coverRatio || state.coverRatio || "2.35:1",
        inlineRatio: meta.inlineRatio || state.inlineRatio || "4:3",
        includeCover: meta.includeCover !== false,
        recommendedStyles: Array.isArray(meta.recommendedStyles) ? meta.recommendedStyles : [],
        slots: Array.isArray(meta.slots) ? meta.slots : [],
        viewMode: "editor",
        activeRun: null,
        slotMap: [],
      });
      planNotice.textContent = "";
      renderAll();
      obsidianCtrl.syncDoc(true);
      session.persist();
    } catch (e) {
      toast(e.message || "打开 Markdown 文件失败");
    }
  }

  async function loadDraft(id) {
    if (!id) return;
    try {
      const r = await api("GET", `/api/docs/article/${encodeURIComponent(id)}`);
      const data = typeof r.doc?.data === "string" ? JSON.parse(r.doc.data) : (r.doc?.data || {});
      Object.assign(state, data, {
        docId: r.doc.id,
        activeFile: "",
        editorActive: true,
        dirty: false,
        viewMode: "editor",
        activeRun: null,
        slotMap: [],
      });
      state.fusion = data.fusion ?? Boolean(data.style2);
      state.title = data.title || r.doc.name || "";
      state.slots = Array.isArray(data.slots) ? data.slots : [];
      renderAll();
      session.persist();
      toast("已加载文章草稿");
    } catch (e) {
      toast(e.message);
    }
  }

  function filterTreeNodes(nodes, q) {
    if (!q) return nodes || [];
    const out = [];
    for (const n of (nodes || [])) {
      if (n.kind === "dir") {
        const sub = filterTreeNodes(n.children || [], q);
        if (sub.length > 0 || n.name.toLowerCase().includes(q)) {
          out.push({ ...n, children: sub.length > 0 ? sub : (n.children || []) });
        }
      } else if (`${n.name} ${n.path}`.toLowerCase().includes(q)) {
        out.push(n);
      }
    }
    return out;
  }

  function makeChevronSvg() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.65");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M6 3.75L10.25 8L6 12.25");
    svg.appendChild(path);
    return svg;
  }

  function renderTreeBranch(nodes, depth) {
    const frag = document.createDocumentFragment();
    (nodes || []).forEach((node) => {
      if (node.kind === "dir") {
        const isOpen = Boolean(treeQuery) || expandedDirs.has(node.path);
        const isSelected = Boolean(state.selectedDir && state.selectedDir === node.path);
        const dirWrap = el("div", {
          class: "ic-vault-dir-wrap" + (isSelected ? " is-selected" : ""),
          "data-dir-path": node.path,
        });
        const dirBtn = el("button", {
          type: "button",
          class: "ic-vault-row ic-vault-dir" + (isOpen ? " is-open" : "") + (isSelected ? " is-selected" : ""),
          role: "treeitem",
          "aria-expanded": String(isOpen),
          "aria-selected": String(isSelected),
          style: { paddingLeft: `${6 + depth * 16}px` },
          onClick: () => {
            state.selectedDir = node.path;
            if (expandedDirs.has(node.path)) expandedDirs.delete(node.path);
            else expandedDirs.add(node.path);
            persistExpanded();
            renderSidebar();
            session.persist();
          },
        },
          el("span", { class: "ic-vault-chevron", "aria-hidden": "true" }, makeChevronSvg()),
          el("span", { class: "ic-vault-node-name", title: node.path }, node.name)
        );
        const quickAddBtn = el("button", {
          type: "button",
          class: "ic-vault-dir-add",
          title: `在「${node.name}」中新建 Markdown`,
          "aria-label": `在 ${node.name} 中新建 Markdown`,
          onClick: (e) => {
            e.stopPropagation();
            state.selectedDir = node.path;
            renderSidebar();
            session.persist();
            openNewMarkdownModal(node.path);
          },
        }, "＋");
        dirWrap.append(dirBtn, quickAddBtn);
        dirWrap.addEventListener("contextmenu", (e) => {
          state.selectedDir = node.path;
          session.persist();
          renderSidebar();
          const freshWrap = Array.from(treeBox.querySelectorAll(".ic-vault-dir-wrap")).find(
            (elNode) => elNode.getAttribute("data-dir-path") === node.path
          ) || null;
          openTreeContextMenu(e, { kind: "dir", path: node.path, name: node.name }, freshWrap);
        });
        frag.appendChild(dirWrap);
        if (isOpen && node.children?.length) {
          frag.appendChild(renderTreeBranch(node.children, depth + 1));
        }
        return;
      }

      const isActive = Boolean(state.activeFile && state.activeFile === node.path);
      const displayName = node.name.replace(/\.(md|markdown)$/i, "");
      const row = el("div", {
        class: "ic-vault-file-wrap" + (isActive ? " is-active" : ""),
        "data-file-path": node.path,
      },
        el("button", {
          type: "button",
          class: "ic-vault-row ic-vault-file",
          role: "treeitem",
          "aria-selected": String(isActive),
          title: node.path,
          style: { paddingLeft: `${22 + depth * 16}px` },
          onClick: () => openVaultFile(node.path),
        },
          el("span", { class: "ic-vault-file-ico", "aria-hidden": "true" }, "📄"),
          el("span", { class: "ic-vault-node-name" }, displayName)
        ),
        el("button", {
          type: "button",
          class: "ic-vault-file-del",
          title: `删除 ${node.name}`,
          "aria-label": `删除文件 ${node.name}`,
          onClick: (e) => {
            e.stopPropagation();
            confirmDeleteFile(node);
          },
        }, "×")
      );
      row.addEventListener("contextmenu", (e) => {
        openTreeContextMenu(e, { kind: "file", path: node.path, name: node.name }, row);
      });
      frag.appendChild(row);
    });
    return frag;
  }

  function renderSidebar() {
    clear(treeBox);

    const visible = filterTreeNodes(vault.tree || [], treeQuery);
    sidebarCountBadge.textContent = `${vault.fileCount || 0} 篇`;
    sidebarCountBadge.title = vault.dir || "";

    const allDirs = collectAllDirPaths(vault.tree || []);
    const dirSet = new Set(allDirs);
    if (state.selectedDir && !dirSet.has(state.selectedDir)) {
      state.selectedDir = "";
    }

    const activeTargetLabel = state.selectedDir ? `「${state.selectedDir}」` : "根目录";
    newNoteBtn.title = `在${activeTargetLabel}新建 Markdown 文件`;
    newFolderBtn.title = `在${activeTargetLabel}新建文件夹`;

    clear(selectedDirBar);
    if (state.selectedDir) {
      selectedDirBar.classList.remove("hidden");
      selectedDirBar.append(
        el("span", { class: "ic-vault-selected-dir-ico", "aria-hidden": "true" }, makeIconSvg(ICONS.reveal, 13)),
        el("span", {
          class: "ic-vault-selected-dir-path mono",
          title: `新建文件与文件夹将放入：${state.selectedDir}`,
        }, state.selectedDir),
        el("button", {
          type: "button",
          class: "ic-vault-selected-dir-clear",
          title: "取消选中（切回根目录）",
          "aria-label": "取消选中文件夹，切回根目录",
          onClick: () => {
            state.selectedDir = "";
            renderSidebar();
            session.persist();
          },
        }, "×")
      );
    } else {
      selectedDirBar.classList.add("hidden");
    }

    collapseAllBtn.disabled = allDirs.length === 0;
    const anyExpanded = expandedDirs.size > 0;
    clear(collapseAllBtn);
    collapseAllBtn.appendChild(makeIconSvg(anyExpanded ? ICONS.collapse : ICONS.expand));
    collapseAllBtn.title = anyExpanded ? "折叠全部文件夹" : "展开全部文件夹";

    // Update Obsidian-style bottom Vault Switcher footer
    const vaultsList = Array.isArray(vault.vaults) ? vault.vaults : [];
    vaultSwitcherName.textContent = vault.name || "本地文章库";
    vaultSwitcherBtn.title = `${vault.dir || "切换本地目录"}（点击切换目录）`;
    if (vaultsList.length > 1) {
      vaultSwitcherCount.textContent = String(vaultsList.length);
      vaultSwitcherCount.classList.remove("hidden");
    } else {
      vaultSwitcherCount.classList.add("hidden");
    }

    if (!visible.length) {
      treeBox.appendChild(el("div", { class: "ic-vault-tree-empty" },
        el("p", { class: "muted", style: { margin: 0, fontSize: "12px", lineHeight: "1.55" } },
          treeQuery ? "没有匹配的 .md 文件" : "当前目录下还没有 .md 文件，可在左下角切换/添加本地目录，或点击顶部新建文件 / 文件夹。"
        )
      ));
    } else {
      treeBox.appendChild(renderTreeBranch(visible, 0));
    }

    // Preserve access to any legacy SQLite drafts in a compact collapsible footer
    clear(legacyDraftsWrap);
    if (drafts.length > 0) {
      legacyDraftsWrap.classList.remove("hidden");
      const listEl = el("div", { class: "ic-vault-legacy-list" });
      drafts.forEach((d) => {
        const active = !state.activeFile && state.docId === d.id;
        listEl.appendChild(el("button", {
          type: "button",
          class: "ic-vault-row ic-vault-file" + (active ? " is-active" : ""),
          onClick: () => loadDraft(d.id),
        },
          el("span", { class: "ic-vault-file-ico" }, "📝"),
          el("span", { class: "ic-vault-node-name" }, d.name || "未命名草稿")
        ));
      });
      legacyDraftsWrap.append(
        el("summary", { class: "ic-vault-legacy-sum" }, `历史草稿箱 (${drafts.length})`),
        listEl
      );
    } else {
      legacyDraftsWrap.classList.add("hidden");
    }
  }

  function renderWelcome() {
    clear(welcomeBox);
    const vaultsList = Array.isArray(vault.vaults) ? vault.vaults : [];
    const quickVaultChips = vaultsList.length > 1
      ? el("div", { class: "ic-vault-quick-chips" },
          ...vaultsList.slice(0, 8).map((v) => el("button", {
            type: "button",
            class: "ic-vault-quick-chip" + (v.active ? " is-active" : ""),
            title: v.dir,
            onClick: () => switchVaultDir(v.dir),
          }, v.name || v.dir))
        )
      : null;

    welcomeBox.appendChild(el("div", { class: "ic-vault-welcome-card" },
      el("div", { class: "ic-vault-welcome-ico", "aria-hidden": "true" }, "📚"),
      el("h2", { style: { margin: 0, fontSize: "18px" } }, "本地 Markdown 文章库"),
      el("p", { class: "muted", style: { margin: 0, maxWidth: "460px", lineHeight: "1.6", fontSize: "13px" } },
        "点击左侧目录树中的任意 .md 文件即可进入编辑与配图模式；选中文件夹或右键目录树可快速新建、重命名与管理文件。"
      ),
      el("div", { class: "ic-vault-path-pill mono", title: vault.dir || "" }, vault.dir || "未选择目录"),
      quickVaultChips,
      el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap", justifyContent: "center" } },
        el("button", { type: "button", class: "btn btn-primary", onClick: openAddVaultDialog }, "＋ 添加本地目录（如 Obsidian 库）"),
        el("button", { type: "button", class: "btn", onClick: () => openNewMarkdownModal(state.selectedDir || "") }, "＋ 新建 Markdown"),
        el("button", { type: "button", class: "btn", onClick: () => fileIn.click() }, "📄 导入文档")
      )
    ));
  }

  function syncBottomBar() {
    titleInput.value = state.title || "";
    titleCount.textContent = `${(state.title || "").length}/64`;
    charCounter.textContent = `正文字数 ${(state.content || "").length}`;
    coverRatioMiniIn.value = state.coverRatio;
    inlineRatioMiniIn.value = state.inlineRatio;
    modelSel.value = state.modelRef;

    const stObj = styles.find((s) => s.number === state.style);
    if (stObj?.image) {
      styleBadgeImg.src = packImg(stObj.image);
      styleBadgeImg.classList.remove("hidden");
    } else {
      styleBadgeImg.classList.add("hidden");
    }
    styleBadgeId.textContent = `#${state.style || "FA-013"}`;
    styleBadgeName.textContent = stObj ? resourceName(stObj) : "选择画风";

    const pendingCount = state.slots.filter((sl) => sl.selected !== false && !sl.imagePath).length;
    const hasPending = pendingCount > 0;
    planBtn.className = "btn btn-sm" + (!hasPending ? " btn-primary" : "");
    batchBtn.className = "btn btn-sm" + (hasPending ? " btn-primary" : "");
    batchBtn.textContent = hasPending ? `生成待出配图 (${pendingCount})` : "生成配图";
  }

  function renderRecommendedStyles() {
    clear(recStylesBar);
    const recs = state.recommendedStyles || [];
    recStylesBar.classList.toggle("hidden", !recs.length);
    if (!recs.length) return;
    recStylesBar.appendChild(el("span", { class: "studio-row-label" }, "AI 推荐画风"));
    recs.forEach((sid) => {
      const obj = styles.find((x) => x.number === sid);
      recStylesBar.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm" + (state.style === sid ? " btn-primary" : ""),
        onClick: () => {
          state.style = sid;
          syncBottomBar();
          renderRecommendedStyles();
          session.persist();
        },
      }, obj ? `${sid} ${resourceName(obj)}` : sid));
    });
  }

  function renderBatchSummary() {
    clear(batchSummaryBox);
    const run = state.activeRun;
    if (!run || !Array.isArray(run.images) || !run.images.length) {
      batchSummaryBox.className = "hidden";
      return;
    }
    const total = run.images.length;
    const done = run.images.filter((im) => im.status === "done").length;
    const failed = run.images.filter((im) => im.status === "failed").length;
    const active = run.images.some((im) => im.status === "queued" || im.status === "running");
    const pct = Math.round((100 * (done + failed)) / Math.max(1, total));
    batchSummaryBox.className = "hw-article-generation-summary";
    batchSummaryBox.append(
      el("div", { class: "hw-article-summary-head" },
        el("strong", null, active ? "正在并发生图…" : "本批配图结果"),
        el("span", null, `${done + failed} / ${total} 已处理 · 成功 ${done} · 失败 ${failed}`)
      ),
      el("div", { class: "hw-article-summary-meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done + failed) },
        el("span", { style: { width: `${pct}%` } })
      )
    );
  }

  function insertSlotAt(anchorText, role = "inline") {
    const isCover = role === "cover";
    const slot = {
      id: crypto.randomUUID(),
      role: isCover ? "cover" : "inline",
      anchor: isCover ? "" : anchorText,
      title: isCover ? "文章封面" : `插图 ${state.slots.length + 1}`,
      theme: "",
      ratio: isCover ? state.coverRatio : state.inlineRatio,
      imagePath: "",
      variants: [],
      selected: true,
    };
    if (isCover) state.slots.unshift(slot);
    else state.slots.push(slot);
    renderFlow();
    syncBottomBar();
    session.persist();
    openSlotPromptDialog(slot);
  }

  function openLightbox(path, title) {
    showModal(title || "配图预览",
      el("div", { class: "col", style: { alignItems: "center" } },
        el("img", { src: localImg(path), alt: title || "", style: { maxWidth: "100%", maxHeight: "70vh", borderRadius: "8px" } })
      ),
      [el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭")]
    );
  }

  function openSlotPromptDialog(sl) {
    const isCoverInit = sl.role === "cover";
    let tempRole = sl.role || "inline";
    let tempLayout = sl.layout || "";
    let tempRatio = sl.ratio || (isCoverInit ? state.coverRatio : state.inlineRatio);
    let tempAnchor = sl.anchor || "";
    let tempSelected = sl.selected !== false;

    const blocks = paragraphBlocks();
    const themeArea = el("textarea", { class: "textarea", rows: "4", value: sl.theme || "", placeholder: "描述这张配图的画面内容与表达重点…" });
    themeArea.value = sl.theme || "";

    const roleCtrl = choices("配图类型", [["cover", "文章封面"], ["inline", "正文插图"]], tempRole, (v) => {
      tempRole = v;
      anchorWrap.classList.toggle("hidden", tempRole === "cover");
      if (tempRole === "cover" && !sl.layout) tempRatio = state.coverRatio;
      ratioCtrl.sync(tempRatio);
    }, { inline: true });

    const layoutPick = resourcePicker("本图图型", layouts, tempLayout, (v) => { tempLayout = v; }, "沿用文章图型", { allowClear: true });
    const ratioCtrl = ratioControl("本图比例", tempRatio, (v) => { tempRatio = v; }, { compact: true });

    const anchorIn = el("input", { class: "input", value: tempAnchor, placeholder: "插在这段原文之后…" });
    anchorIn.addEventListener("input", () => { tempAnchor = anchorIn.value; });
    const anchorSel = blocks.length ? el("select", { class: "select", "aria-label": "从正文段落选择插入位置" },
      el("option", { value: "" }, "— 从正文段落定位 —"),
      ...blocks.slice(0, 40).map((b) => el("option", { value: b.trimmed }, b.trimmed.slice(0, 42) + (b.trimmed.length > 42 ? "…" : "")))
    ) : null;
    if (anchorSel) {
      if (tempAnchor) anchorSel.value = tempAnchor;
      anchorSel.addEventListener("change", () => {
        if (!anchorSel.value) return;
        tempAnchor = anchorSel.value;
        anchorIn.value = tempAnchor;
      });
    }
    const anchorWrap = el("div", { class: "col" + (tempRole === "cover" ? " hidden" : ""), style: { gap: "6px" } },
      field("正文插入位置（紧跟在该段之后）", anchorIn),
      anchorSel
    );

    const selChk = el("input", { type: "checkbox", checked: tempSelected });
    selChk.addEventListener("change", () => { tempSelected = selChk.checked; });

    const variantsBox = Array.isArray(sl.variants) && sl.variants.length > 1
      ? el("div", { class: "col", style: { gap: "6px" } },
          el("span", { class: "studio-row-label" }, `历史版本对比 (${sl.variants.length})`),
          el("div", { class: "ic-art-variants" },
            ...sl.variants.map((vp, i) => el("button", {
              type: "button",
              class: "ic-art-variant-btn" + (vp === sl.imagePath ? " is-active" : ""),
              onClick: () => {
                sl.imagePath = vp;
                closeModal();
                renderFlow();
                renderPreviewStage();
                toast(`已切换到版本 ${i + 1}`);
              },
            }, el("img", { src: localImg(vp), alt: `版本 ${i + 1}` })))
          )
        )
      : null;

    const saveFields = () => {
      if (!ratioCtrl.validate()) return false;
      sl.role = tempRole;
      sl.layout = tempLayout;
      sl.ratio = tempRatio;
      sl.theme = themeArea.value.trim();
      sl.anchor = tempRole === "cover" ? "" : tempAnchor;
      sl.selected = tempSelected;
      return true;
    };

    const body = el("div", { class: "col", style: { gap: "12px" } },
      roleCtrl,
      layoutPick,
      field("画面主题 / 提示词要点", themeArea),
      anchorWrap,
      ratioCtrl,
      el("label", { class: "row", style: { cursor: "pointer" } }, selChk, el("span", null, "加入批量生成队列")),
      variantsBox
    );

    showModal(`调提示词 · ${sl.role === "cover" ? "封面" : (sl.title || "配图")}`, body, [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn",
        onClick: () => {
          if (!saveFields()) return;
          closeModal();
          renderFlow();
          renderPreviewStage();
          syncBottomBar();
          session.persist();
          runGenerate(sl.id, false);
        },
      }, "保存并生成此图"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: () => {
          if (!saveFields()) return;
          closeModal();
          renderFlow();
          renderPreviewStage();
          syncBottomBar();
          session.persist();
        },
      }, "确定"),
    ]);
  }

  function renderSlotCard(sl, inlineNo, anchorDesc, isOrphan = false) {
    if (!sl.id) sl.id = crypto.randomUUID();
    if (!Array.isArray(sl.variants)) sl.variants = sl.imagePath ? [sl.imagePath] : [];
    else if (sl.imagePath && !sl.variants.includes(sl.imagePath)) sl.variants.unshift(sl.imagePath);

    const isCover = sl.role === "cover";
    const isGenerating = state.activeRun?.images?.some((im, i) => state.slotMap[i]?.id === sl.id && (im.status === "queued" || im.status === "running"));
    const status = isGenerating ? "generating" : (sl.imagePath ? "done" : (sl.error ? "error" : "idle"));
    const statusLabel = { generating: "生成中…", done: "✓ 已完成", error: "! 生成失败", idle: "待生成" }[status];

    const ratioText = sl.ratio || (isCover ? state.coverRatio : state.inlineRatio);
    const layoutObj = layouts.find((l) => resourceId(l) === sl.layout);
    const specMeta = `${ratioText}${layoutObj ? ` · ${layoutObj.id} ${layoutObj.name}` : ""}`;

    const mediaBox = el("div", {
      class: (isCover ? "ic-art-cover-box" : "ic-art-thumb-box") + (sl.imagePath ? " has-image" : " is-empty"),
      style: { aspectRatio: ratioToCss(ratioText) },
      title: sl.imagePath ? "点击查看大图" : "点击编辑配图主题或生成",
      onClick: () => (sl.imagePath ? openLightbox(sl.imagePath, sl.title || "配图") : openSlotPromptDialog(sl)),
    },
    sl.imagePath
      ? el("img", { src: localImg(sl.imagePath), alt: sl.title || "配图" })
      : el("div", { class: "col", style: { alignItems: "center", gap: "4px", padding: "10px", textAlign: "center" } },
          el("span", { style: { fontSize: "20px", opacity: "0.45", color: "var(--accent)" } }, status === "generating" ? "⏳" : "🖼"),
          el("span", { class: "muted", style: { fontSize: "11px" } }, status === "generating" ? "正在绘制…" : `${ratioText} · 点击设提示词`)
        )
    );

    const cardHead = el("div", { class: "ic-art-card-head" },
      el("div", { class: "row" },
        el("span", { class: "ic-art-chip-role", dataset: { role: isCover ? "cover" : "inline" } }, isCover ? "封面" : `插图 ${inlineNo}`),
        el("span", { class: "badge" + (status === "done" ? " badge-ok" : (status === "error" ? " badge-err" : "")) }, statusLabel),
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, specMeta)
      ),
      el("div", { class: "row" },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          disabled: isGenerating,
          onClick: () => runGenerate(sl.id, false),
        }, sl.imagePath ? "重新生成" : "生成"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => openSlotPromptDialog(sl),
        }, "调提示词"),
        sl.variants.length > 1
          ? el("button", { type: "button", class: "btn btn-sm", onClick: () => openSlotPromptDialog(sl) }, `版本对比 (${sl.variants.length})`)
          : null,
        el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          title: "删除配图位",
          onClick: () => {
            state.slots = state.slots.filter((s) => s.id !== sl.id);
            renderFlow();
            syncBottomBar();
            session.persist();
          },
        }, "🗑")
      )
    );

    const metaCol = el("div", { class: "col", style: { gap: "5px", minWidth: "0" } },
      !isCover ? el("div", { class: "row" },
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, anchorDesc),
        isOrphan ? el("span", { class: "badge badge-warn" }, "待重新定位") : null
      ) : null,
      el("div", { style: { fontSize: "13px", lineHeight: "1.5" } },
        el("strong", { style: { color: "var(--ink-muted)" } }, "主题："),
        el("span", null, sl.theme || "未指定主题（点击「调提示词」编辑）")
      ),
      sl.error ? el("div", { class: "badge badge-err" }, sl.error) : null
    );

    return el("section", { class: "ic-art-card", dataset: { status, role: sl.role || "inline" } },
      cardHead,
      isCover
        ? el("div", { class: "col", style: { gap: "10px" } }, mediaBox, metaCol)
        : el("div", { class: "ic-art-inline-grid" }, mediaBox, metaCol)
    );
  }

  function renderFlow() {
    clear(flowBox);
    const coverSlot = state.slots.find((s) => s.role === "cover");
    const inlineSlots = state.slots.filter((s) => s.role !== "cover");

    // 1. Top Cover slot (or insert cover gap)
    if (coverSlot) {
      flowBox.appendChild(renderSlotCard(coverSlot, 0, "固定在文章开头"));
    } else {
      flowBox.appendChild(el("div", { class: "ic-art-gap" },
        el("button", { type: "button", class: "ic-art-gap-btn", onClick: () => insertSlotAt("", "cover") }, "＋ 添加文章封面")
      ));
    }

    // 2. Interleave raw markdown lines cleanly around matched inline anchors
    const rawLines = (state.content || "").split(/\r?\n/);
    const cuts = [];
    const orphans = [];
    inlineSlots.forEach((sl) => {
      const idx = sl.anchor ? rawLines.findIndex((line) => line.trim() && line.includes(sl.anchor)) : -1;
      if (idx >= 0) cuts.push({ lineIdx: idx, slot: sl });
      else orphans.push(sl);
    });
    cuts.sort((a, b) => a.lineIdx - b.lineIdx);

    // Group cuts by lineIdx
    const lineGroups = new Map();
    cuts.forEach((c) => {
      if (!lineGroups.has(c.lineIdx)) lineGroups.set(c.lineIdx, []);
      lineGroups.get(c.lineIdx).push(c.slot);
    });
    const sortedCutLines = Array.from(lineGroups.keys()).sort((a, b) => a - b);

    const segTextareas = [];
    const syncContentFromSegments = () => {
      state.content = segTextareas.map((ta) => ta.value).join("\n");
      state.dirty = true;
      charCounter.textContent = `正文字数 ${state.content.length}`;
      syncTopbarBreadcrumb();
      obsidianCtrl.syncDoc(false);
      session.persist();
    };

    const appendSegmentTa = (textValue, placeholder, minRows) => {
      const segIdx = segTextareas.length;
      const linesCount = Math.max(minRows, Math.min(24, textValue.split("\n").length + 1));
      const ta = el("textarea", {
        class: "ic-art-seg-ta",
        rows: String(linesCount),
        placeholder: placeholder || "在此撰写或粘贴文章正文（支持 Markdown）…",
      });
      ta.value = textValue;
      ta.addEventListener("focus", () => { activeSegTextarea = ta; });
      ta.addEventListener("input", () => {
        closeSelectionBubble();
        syncContentFromSegments();
      });
      ta.addEventListener("mouseup", (e) => {
        setTimeout(() => {
          if (ta.selectionEnd - ta.selectionStart >= 2) {
            showSelectionBubble(ta, segIdx, e.clientX, e.clientY);
          } else {
            closeSelectionBubble();
          }
        }, 0);
      });
      ta.addEventListener("keyup", (e) => {
        if (e.shiftKey || e.key === "Shift") {
          if (ta.selectionEnd - ta.selectionStart >= 2) {
            showSelectionBubble(ta, segIdx, 0, 0);
          } else {
            closeSelectionBubble();
          }
        }
      });
      segTextareas.push(ta);
      flowBox.appendChild(ta);
    };

    if (!sortedCutLines.length) {
      appendSegmentTa(
        state.content || "",
        "# 文章主标题\n\n导语与背景介绍…\n\n## 第一节：核心观点\n正文段落内容…\n\n写好后点击底部「✨ AI 规划配图」，封面与插图卡会自动插入到对应段落之后。",
        14
      );
    } else {
      let cursor = 0;
      let inlineNo = 0;
      sortedCutLines.forEach((cutIdx) => {
        const chunk = rawLines.slice(cursor, cutIdx + 1).join("\n");
        appendSegmentTa(chunk, "继续编写本段内容…", 3);
        const matchedLine = (rawLines[cutIdx] || "").trim().slice(0, 26);
        lineGroups.get(cutIdx).forEach((sl) => {
          inlineNo += 1;
          flowBox.appendChild(renderSlotCard(sl, inlineNo, `§ 位于「${matchedLine}」之后`));
        });
        cursor = cutIdx + 1;
      });
      const tail = rawLines.slice(cursor).join("\n");
      appendSegmentTa(tail, "继续编写后续段落…", 5);
    }

    // Orphan slots (not yet matched to a paragraph line)
    orphans.forEach((sl, oIdx) => {
      const num = cuts.length + oIdx + 1;
      flowBox.appendChild(renderSlotCard(sl, num, sl.anchor ? `原位置「${sl.anchor.slice(0, 20)}」未匹配` : "尚未绑定段落", true));
    });

    // End insertion gap
    flowBox.appendChild(el("div", { class: "ic-art-gap" },
      el("button", {
        type: "button",
        class: "ic-art-gap-btn",
        onClick: () => {
          const blocks = paragraphBlocks();
          const lastAnchor = blocks.length ? blocks[blocks.length - 1].trimmed : "";
          insertSlotAt(lastAnchor, "inline");
        },
      }, "＋ 在文末添加插图")
    ));
  }

  function renderPreviewStage() {
    clear(previewStageBox);
    const tabBar = el("div", { class: "tabs" },
      ...[
        ["wechat_desktop", "公众号桌面排版"],
        ["wechat_mobile", "手机预览 (430px)"],
        ["markdown", "Markdown 源码"],
      ].map(([k, lbl]) => el("button", {
        type: "button",
        class: "tab" + (state.previewKind === k ? " active" : ""),
        onClick: () => { state.previewKind = k; renderPreviewStage(); },
      }, lbl))
    );

    const previewActions = el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", maxWidth: "820px", margin: "0 auto", width: "100%" } },
      tabBar,
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => doExport("wechat_html", true) }, "📋 复制公众号 HTML"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => doExport("markdown_zip", false) }, "📦 MD+图 ZIP"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => doExport("images_zip", false) }, "🖼 配图包")
      )
    );
    previewStageBox.appendChild(previewActions);

    const paras = paragraphBlocks().map((b) => b.trimmed);
    const coverSlot = state.slots.find((s) => s.role === "cover");

    if (state.previewKind === "markdown") {
      const lines = [];
      if (state.title) lines.push(`# ${state.title}\n`);
      if (coverSlot) lines.push(`![${coverSlot.title || "封面"}](${coverSlot.imagePath || "待生成封面"})\n`);
      paras.forEach((p) => {
        lines.push(p + "\n");
        state.slots.forEach((sl) => {
          if (sl.role !== "cover" && sl.anchor && p.includes(sl.anchor)) {
            lines.push(`![${sl.title || "配图"}](${sl.imagePath || "待生成：" + sl.theme})\n`);
          }
        });
      });
      previewStageBox.appendChild(el("div", { class: "ic-pv-article-sheet" },
        el("pre", { class: "mono", style: { margin: "0", whiteSpace: "pre-wrap", fontSize: "12.5px" } }, lines.join("\n"))
      ));
      return;
    }

    const sheet = el("article", { class: "ic-pv-article-sheet" + (state.previewKind === "wechat_mobile" ? " is-mobile" : "") });
    if (state.title) sheet.appendChild(el("h2", { style: { margin: "0 0 8px" } }, state.title));
    if (coverSlot) {
      sheet.appendChild(coverSlot.imagePath
        ? el("img", { src: localImg(coverSlot.imagePath), alt: coverSlot.title || "封面", style: { width: "100%", borderRadius: "8px" } })
        : el("div", { class: "badge badge-accent" }, `封面配图位：${coverSlot.theme || coverSlot.title || "待生成"}`));
    }
    paras.forEach((p) => {
      sheet.appendChild(p.startsWith("#")
        ? el("h3", { style: { margin: "10px 0 2px" } }, p.replace(/^#+\s*/, ""))
        : el("p", { style: { margin: "0", lineHeight: "1.8" } }, p));
      state.slots.forEach((sl) => {
        if (sl.role !== "cover" && sl.anchor && p.includes(sl.anchor)) {
          sheet.appendChild(sl.imagePath
            ? el("img", { src: localImg(sl.imagePath), alt: sl.title || "", style: { width: "100%", borderRadius: "8px" } })
            : el("div", { class: "badge" }, `正文配图位：${sl.theme || sl.title || "待生成"}`));
        }
      });
    });
    if (!state.title && paras.length === 0) {
      sheet.appendChild(el("p", { class: "muted", style: { textAlign: "center", padding: "32px 0" } }, "导入或输入文章正文后，这里将实时预览公众号图文效果。"));
    }
    previewStageBox.appendChild(sheet);
  }

  function renderStageMode() {
    const active = Boolean(state.editorActive);
    topbar.classList.toggle("hidden", !active);
    bottombar.classList.toggle("hidden", !active);
    welcomeBox.classList.toggle("hidden", active);
    if (!active) {
      paperSheet.classList.add("hidden");
      diffReviewBox.classList.add("hidden");
      previewStageBox.classList.add("hidden");
      aiDrawer.classList.add("hidden");
      copilotBackdrop.classList.add("hidden");
      obsidianCtrl.updateHostVisibility(false);
      closeSelectionBubble();
      renderWelcome();
      return;
    }
    syncTopbarBreadcrumb();
    const isEditor = state.viewMode !== "preview";
    const isReviewing = isEditor && Boolean(activeDiffReview);
    const drawerOpen = Boolean(state.aiDrawerOpen);
    const showingObs = drawerOpen && state.rightDrawerTab === "obsidian";

    editSwitchBtn.classList.toggle("is-active", isEditor);
    previewSwitchBtn.classList.toggle("is-active", !isEditor);
    toolsGroup.classList.toggle("hidden", !isEditor || isReviewing);
    paperSheet.classList.toggle("hidden", !isEditor || isReviewing);
    diffReviewBox.classList.toggle("hidden", !isReviewing);
    previewStageBox.classList.toggle("hidden", isEditor);

    aiDrawer.classList.toggle("hidden", !drawerOpen);
    copilotBackdrop.classList.toggle("hidden", !drawerOpen);
    drawerTabAiBtn.classList.toggle("is-active", state.rightDrawerTab !== "obsidian");
    drawerTabObsBtn.classList.toggle("is-active", state.rightDrawerTab === "obsidian");
    aiPaneBody.classList.toggle("hidden", state.rightDrawerTab === "obsidian");
    obsPaneBody.classList.toggle("hidden", state.rightDrawerTab !== "obsidian");
    obsidianCtrl.updateHostVisibility(showingObs);
    renderCopilotPanel();
    if (isReviewing) renderInlineDiffReview();
    else if (!isEditor) renderPreviewStage();
  }

  function renderAll() {
    renderSidebar();
    syncBottomBar();
    renderRecommendedStyles();
    renderBatchSummary();
    renderFlow();
    renderStageMode();
  }

  function openMoreSettingsModal() {
    const ctrl = recipeControls(state, { styles, colors, tones, layouts }, () => {
      syncBottomBar();
      renderRecommendedStyles();
      session.persist();
    }, { article: true });
    const cRatio = ratioControl("封面比例", state.coverRatio, (v) => { state.coverRatio = v; syncBottomBar(); });
    const iRatio = ratioControl("章节插图比例", state.inlineRatio, (v) => { state.inlineRatio = v; syncBottomBar(); });
    const resCtrl = choices("清晰度", [["1k", "1K"], ["2k", "2K"], ["4k", "4K"]], state.resolution, (v) => { state.resolution = v; }, { inline: true });
    const coverChk = el("input", { type: "checkbox", checked: state.includeCover !== false });
    coverChk.addEventListener("change", () => { state.includeCover = coverChk.checked; });

    const body = el("div", { class: "col", style: { gap: "14px" } },
      ctrl.node,
      cRatio,
      iRatio,
      resCtrl,
      el("label", { class: "row", style: { cursor: "pointer" } }, coverChk, el("span", null, "AI 规划包含文章封面"))
    );
    showModal("文章配图参数设置", body, [
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: () => {
          if (!cRatio.validate() || !iRatio.validate()) return;
          closeModal();
          syncBottomBar();
          session.persist();
        },
      }, "完成"),
    ]);
  }

  function openExportModal() {
    const hasDoneImgs = state.slots.some((sl) => Boolean(sl.imagePath));
    showModal("导出与写回 Markdown",
      el("div", { class: "col", style: { gap: "10px" } },
        el("p", { class: "muted", style: { margin: "0" } }, "选择将文章与已生成的本地配图写回本地 Markdown 或导出为其他格式："),
        state.activeFile
          ? el("button", {
              type: "button",
              class: "btn btn-primary",
              disabled: !hasDoneImgs,
              onClick: async () => {
                await saveVaultFile(true);
                closeModal();
              },
            }, hasDoneImgs ? "📝 将已生成配图写入当前 MD（适配 Obsidian）" : "📝 写入当前 MD（尚无已生成配图）")
          : null,
        el("button", { type: "button", class: "btn" + (!state.activeFile ? " btn-primary" : ""), onClick: async () => { await doExport("wechat_html", true); closeModal(); } }, "📋 复制公众号 HTML（含图链接）"),
        el("button", { type: "button", class: "btn", onClick: async () => { await doExport("markdown_zip", false); closeModal(); } }, "📦 导出 Markdown + 配图 ZIP 包"),
        el("button", { type: "button", class: "btn", onClick: async () => { await doExport("images_zip", false); closeModal(); } }, "🖼 仅导出全部配图 ZIP 包")
      ),
      [el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭")]
    );
  }

  function openURLImportDialog() {
    const urlIn = el("input", { class: "input", type: "url", placeholder: "https://example.com/article" });
    showModal("抓取网页文章正文", el("div", { class: "field" }, el("label", null, "文章 URL（仅支持 http/https）"), urlIn), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          try {
            const res = await api("POST", "/api/article/import", { url: urlIn.value.trim() });
            state.activeFile = "";
            state.docId = "";
            state.editorActive = true;
            state.dirty = true;
            state.viewMode = "editor";
            if (res.title) state.title = res.title;
            state.content = res.content || "";
            state.slots = [];
            closeModal();
            renderAll();
            session.persist();
            toast("已抓取网页正文");
          } catch (e) { toast(e.message); }
        },
      }, "抓取"),
    ]);
  }

  async function planArticle() {
    if (planning) return;
    if (!state.content.trim()) {
      toast("请先输入或导入文章正文");
      return;
    }
    if (!validRatio(state.coverRatio) || !validRatio(state.inlineRatio)) {
      toast("请检查封面与插图比例格式");
      return;
    }
    planning = true;
    planBtn.disabled = true;
    const prevPlanText = planBtn.textContent;
    planBtn.textContent = "⏳ AI 规划中…";
    planNotice.textContent = "正在调用 AI 分析文章结构并设计配图方案…";
    const request = {
      title: state.title,
      content: state.content,
      styleId: state.style,
      coverRatio: state.coverRatio,
      inlineRatio: state.inlineRatio,
      includeCover: state.includeCover,
      modelRef: state.textModelRef || "",
    };
    try {
      const res = await api("POST", "/api/article/plan", request);
      if (request.content !== state.content || request.title !== state.title) {
        planNotice.textContent = "文章已修改，请按当前正文重新规划。";
        return;
      }
      const fresh = (res.slots || []).map((sl) => ({ ...sl, id: crypto.randomUUID(), imagePath: "", variants: [], selected: true }));
      const viaModel = res.model ? `（${res.model}）` : (res.source === "site" ? "（官方智能文字服务）" : (res.source === "provider" ? "（自定义文本模型）" : ""));
      const noticeMsg = res.source === "local"
        ? (res.fallbackReason
            ? `AI 规划暂不可用（${res.fallbackReason}），已降级为本地规则分段模板。`
            : "已使用本地规则分段模板（未调用 AI，可登录账号或在底部选择文本模型后重试）。")
        : `AI 规划完成${viaModel}，已生成 ${fresh.length} 个配图位并插入正文对应段落下方。`;
      const apply = () => {
        const used = new Set();
        const merged = fresh.map((sl) => {
          const matches = state.slots.filter((old) => !used.has(old.id) && old.role === sl.role && (sl.role === "cover" || (sl.anchor && old.anchor === sl.anchor)));
          if (matches.length !== 1) return sl;
          const old = matches[0];
          used.add(old.id);
          return old;
        });
        state.slots = [...merged, ...state.slots.filter((sl) => !used.has(sl.id))];
        state.recommendedStyles = res.recommendedStyles || [];
        planNotice.textContent = noticeMsg;
        toast(res.source === "local" ? "AI 暂不可用，已降级为本地模板规划" : `AI 规划完成${viaModel}`);
        renderAll();
        session.persist();
      };
      if (state.slots.length) {
        showModal("更新配图规划", el("div", { class: "col" },
          el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px" } }, noticeMsg),
          el("p", null, "匹配的配图位保留已有设置和图片，未匹配的旧图位也会保留，可自行删除。"),
          ...fresh.map((sl) => el("p", null, `${sl.role === "cover" ? "封面" : "正文"}：${sl.theme}`))
        ), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "保留当前规划"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); apply(); } }, "更新规划"),
        ]);
        planNotice.textContent = "新规划已就绪，等待应用。";
      } else apply();
    } catch (e) {
      planNotice.textContent = e.message;
      toast(e.message || "AI 规划配图失败");
    } finally {
      planning = false;
      planBtn.disabled = false;
      planBtn.textContent = prevPlanText;
    }
  }

  async function runGenerate(target, confirmed) {
    if (submitting) return;
    if (state.activeRun?.images?.some((im) => im.status === "queued" || im.status === "running")) {
      toast("本篇文章的配图仍在生成，请等待当前批次完成");
      return;
    }
    if (state.fusion && (!state.style || !state.style2)) {
      toast("双画风融合请先在「⚙ 配图参数」中选择角色与场景画风");
      return;
    }
    const single = typeof target === "string";
    const slots = single
      ? state.slots.filter((sl) => sl.id === target)
      : target === true
      ? state.slots.filter((sl) => sl.role === "cover" && !sl.imagePath).slice(0, 1)
      : state.slots.filter((sl) => sl.selected !== false && !sl.imagePath);
    if (!slots.length) {
      toast(target === true ? "没有待生成的封面，请先规划或添加封面" : "没有待生成的配图");
      return;
    }
    if (slots.some((sl) => !sl.theme?.trim())) {
      toast("请先点击「调提示词」为待生成配图填写主题");
      return;
    }
    if (slots.some((sl) => sl.role !== "cover" && (!sl.anchor || !state.content.includes(sl.anchor)))) {
      toast("部分正文插图尚未匹配到正文段落，请点「调提示词」选择插入段落");
      return;
    }
    const signatures = slots.map(slotSignature);
    submitting = true;
    sampleBtn.disabled = true;
    batchBtn.disabled = true;
    try {
      const res = await api("POST", "/api/generate", {
        mode: "article",
        title: state.title || "文章配图",
        modelRef: state.modelRef,
        resolution: state.resolution,
        confirmed,
        items: slots.map((sl) => ({
          theme: sl.theme.trim(),
          style: state.style,
          style2: state.fusion ? state.style2 : "",
          layout: sl.layout || state.layout,
          color: state.color,
          tone: state.tone,
          mood: state.mood,
          ratio: sl.ratio || (sl.role === "cover" ? state.coverRatio : state.inlineRatio),
          mode: state.mode,
          extra: extraInstructions(state),
        })),
      });
      if (res.needConfirm) {
        showModal("生成费用确认", el("p", null, `本次 ${res.count} 张，预计 ${money(res.totalCents)}，继续生成？`), [
          el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
          el("button", { type: "button", class: "btn btn-primary", onClick: () => { closeModal(); runGenerate(target, true); } }, "确认生成"),
        ]);
        return;
      }
      slots.forEach((sl) => { sl.error = ""; });
      state.activeRun = { ...res.run, images: res.images };
      state.slotMap = slots.map((sl, i) => ({ id: sl.id, signature: signatures[i] }));
      planNotice.textContent = `已提交 ${slots.length} 张配图，完成后自动插入正文。`;
      renderBatchSummary();
      renderFlow();
      session.persist();
    } catch (e) {
      toast(e.message);
    } finally {
      submitting = false;
      sampleBtn.disabled = false;
      batchBtn.disabled = false;
    }
  }

  async function doExport(format, copyToClipboard) {
    if (state.slots.some((sl) => sl.imagePath && sl.role !== "cover" && (!sl.anchor || !state.content.includes(sl.anchor)))) {
      toast("已有配图需要重新定位，请先点击「调提示词」重新选择正文段落");
      return;
    }
    try {
      const res = await api("POST", "/api/article/export", {
        title: state.title,
        content: state.content,
        format,
        slots: state.slots.map((s) => ({ role: s.role, anchor: s.anchor, title: s.title, imagePath: s.imagePath || "" })),
      });
      if (copyToClipboard && res.html) {
        try { await navigator.clipboard.writeText(res.html); } catch {}
        toast("已生成公众号 HTML 并复制到剪贴板：" + res.path);
      } else {
        toast("已导出到：" + res.path);
      }
    } catch (e) {
      toast(e.message);
    }
  }

  async function saveVaultFile(embedImages = false) {
    let targetPath = state.activeFile;
    if (!targetPath) {
      const safe = (state.title || "未命名文章").replace(/[\\/:*?"<>|]/g, "-").trim() || "未命名文章";
      targetPath = `${safe}.md`;
    }
    try {
      const res = await api("PUT", "/api/article/vault/file", {
        path: targetPath,
        title: state.title,
        content: state.content,
        embedImages,
        slots: state.slots.map((s) => ({
          role: s.role,
          anchor: s.anchor,
          title: s.title,
          imagePath: s.imagePath || "",
        })),
        meta: {
          title: state.title,
          style: state.style,
          style2: state.style2,
          fusion: state.fusion,
          layout: state.layout,
          color: state.color,
          tone: state.tone,
          mood: state.mood,
          mode: state.mode,
          coverRatio: state.coverRatio,
          inlineRatio: state.inlineRatio,
          includeCover: state.includeCover,
          recommendedStyles: state.recommendedStyles,
          slots: state.slots,
        },
      });
      state.activeFile = res.path;
      state.dirty = false;
      if (embedImages && res.content) {
        state.content = res.content;
        renderFlow();
      }
      syncTopbarBreadcrumb();
      await refreshVaultTree();
      session.persist();
      toast(embedImages
        ? `已将 ${res.writtenImages || 0} 张配图写入 ${res.path}`
        : `已保存到 ${res.path}`);
    } catch (e) {
      toast(e.message || "保存失败");
    }
  }

  async function saveDraft() {
    if (!state.editorActive) return;
    if (state.activeFile || !state.docId) {
      await saveVaultFile(false);
      return;
    }
    try {
      const res = await api("PUT", `/api/docs/article/${encodeURIComponent(state.docId || "new")}`, {
        name: state.title || "未命名文章",
        data: { ...state, activeRun: null, slotMap: [] },
      });
      state.docId = res.doc.id;
      state.dirty = false;
      const dRes = await api("GET", "/api/docs/article").catch(() => ({ items: [] }));
      drafts = dRes.items || [];
      syncTopbarBreadcrumb();
      renderSidebar();
      session.persist();
      toast("文稿与配图位已保存");
    } catch (e) {
      toast(e.message);
    }
  }

  async function refreshRun() {
    const runId = state.activeRun?.id;
    if (!runId) return;
    const detail = await api("GET", `/api/works/${encodeURIComponent(runId)}`);
    if (state.activeRun?.id !== runId) return;
    state.activeRun = detail.run;
    (detail.run.images || []).forEach((im, i) => {
      const mapped = state.slotMap[i];
      const slot = state.slots.find((sl) => sl.id === mapped?.id);
      if (slot && slotSignature(slot) === mapped.signature) {
        if (im.status === "done" && im.path) {
          if (!Array.isArray(slot.variants)) slot.variants = [];
          if (!slot.variants.includes(im.path)) slot.variants.push(im.path);
          slot.imagePath = im.path;
          slot.error = "";
        }
        if (im.status === "failed") slot.error = im.error || "生成失败，可重试；已有图片已保留";
      }
    });
    renderBatchSummary();
    renderFlow();
    syncBottomBar();
    if (state.viewMode === "preview") renderPreviewStage();
    session.persist();
  }

  const unsub = onEvent(async (msg) => {
    if (!root.isConnected) {
      document.removeEventListener("keydown", onArticleGlobalKeydown);
      closeVaultPopover();
      closeTreeContextMenu();
      closeSelectionBubble();
      obsidianCtrl.dispose();
      unsub();
      return;
    }
    const rid = msg.data?.runId || msg.data?.id;
    if ((msg.type === "job" || msg.type === "run") && state.activeRun && rid === state.activeRun.id) {
      try {
        await refreshRun();
      } catch {}
    }
    if (msg.type === "skills") {
      try {
        const sRes = await api("GET", "/api/skills");
        installedSkills = (sRes.items || []).filter((sk) => sk.enabled !== false);
        renderAiSkillsBar();
      } catch {}
    }
  });

  renderAll();
  refreshRun().catch(() => {});
  if (params.docId) await loadDraft(params.docId);
}
