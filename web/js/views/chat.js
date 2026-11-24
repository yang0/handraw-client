import { api, clear, closeModal, copyText, el, localImg, money, onEvent, showModal, toast } from "../api.js";
import { openHarnessSkillImportModal } from "../skills-ui.js";
import { buildGroupedAIModelSelect, buildGroupedModelSelect } from "./create.js";
import { bindPageImagePaste, importTempReferenceFile, MAX_REF_IMAGES, openReferencePickerModal } from "./ref-picker.js";
import { RATIOS } from "./studio-controls.js";
import { openShareInspirationModal } from "./work-remix-modal.js";

const chatCss = el("link", { rel: "stylesheet", href: new URL("../../css/chat.css", import.meta.url).href });
document.head.appendChild(chatCss);

const SIDEBAR_COLLAPSED_KEY = "handraw:chat:sidebarCollapsed";

const STARTERS = [
  { tag: "💬 自由对话", text: "帮我构思 3 个小红书手账内容选题，并给出吸睛封面标题建议" },
  { tag: "🎨 对话生图", text: "帮我画 2 张清晨窗台手冲咖啡的手绘治愈插画" },
  { tag: "⚡ 安装 Skill", text: "帮我安装 Skill（可贴入本地目录、GitHub 链接，或直接描述想创建的能力）：" },
  { tag: "🔌 查找插件", text: "帮我搜索插件市场里有什么好用的插件" },
];

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function fmtTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

function getSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
}

function setSidebarCollapsed(collapsed) {
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch {}
}

/**
 * Resolve internal model references like
 * `prov_20261124T025254_3b30cb35e792:auto/deepseek-v4.1-flash`
 * into clean human-readable display labels (never leaking internal prov_* IDs).
 */
function formatModelDisplay(rawRef, modRes = {}, { compact = false } = {}) {
  const s = String(rawRef || "").trim();
  if (!s) return "";
  if (s === "site:text" || s === "site:auto") return compact ? "官方智能" : "网站官方智能";

  const rawSite = modRes?.site;
  const siteModels = Array.isArray(rawSite)
    ? rawSite
    : (rawSite?.specifications || rawSite?.models || rawSite?.items || []);

  if (s.startsWith("site:")) {
    const id = s.slice(5);
    const hit = siteModels.find((m) => (m?.model || m?.id) === id);
    return hit?.label || hit?.name || id;
  }

  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) {
    const provId = s.slice(0, colonIdx);
    let modelId = s.slice(colonIdx + 1).replace(/^auto\//i, "");
    const allProvs = [
      ...(Array.isArray(modRes?.textProviders) ? modRes.textProviders : []),
      ...(Array.isArray(modRes?.providers) ? modRes.providers : []),
    ];
    const prov = allProvs.find((p) => p?.id === provId);
    const modelObj = prov?.models?.find((m) => m?.id === modelId || `auto/${m?.id}` === s.slice(colonIdx + 1));
    const modelLabel = modelObj?.label || modelObj?.name || modelId;
    if (compact) return modelLabel;
    const provName = prov?.name || (provId.startsWith("prov_") ? "" : provId);
    return provName ? `${provName} · ${modelLabel}` : modelLabel;
  }

  return s.replace(/^auto\//i, "");
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (trimmed[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += trimmed[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isTableSeparator(line) {
  const t = line.trim();
  if (!t.includes("-")) return false;
  const cells = splitTableRow(t);
  if (!cells.length) return false;
  if (!t.includes("|") && cells.length < 2) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function parseTableAlignments(line) {
  return splitTableRow(line).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

// Lightweight XSS-safe GFM Markdown renderer built strictly with DOM nodes.
function renderMarkdown(text) {
  const container = el("div", { class: "chat-md" });
  const src = String(text || "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  let i = 0;

  const appendInline = (parent, line) => {
    const tokenRe = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(line)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(line.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith("**") && tok.endsWith("**")) {
        const strong = el("strong");
        appendInline(strong, tok.slice(2, -2));
        parent.appendChild(strong);
      } else if (tok.startsWith("~~") && tok.endsWith("~~")) {
        parent.appendChild(el("del", null, tok.slice(2, -2)));
      } else if (tok.startsWith("`") && tok.endsWith("`")) {
        parent.appendChild(el("code", null, tok.slice(1, -1)));
      } else if (tok.startsWith("*") && tok.endsWith("*") && tok.length > 2) {
        parent.appendChild(el("em", null, tok.slice(1, -1)));
      } else if (tok.startsWith("[")) {
        const sep = tok.indexOf("](");
        const label = tok.slice(1, sep);
        const href = tok.slice(sep + 2, -1);
        parent.appendChild(el("a", { href, target: "_blank", rel: "noopener noreferrer" }, label));
      }
      last = m.index + tok.length;
    }
    if (last < line.length) parent.appendChild(document.createTextNode(line.slice(last)));
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim() || "text";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const codeStr = codeLines.join("\n");
      const copyBtn = el("button", {
        type: "button",
        class: "chat-inline-action",
        onClick: async () => {
          const ok = await copyText(codeStr);
          if (ok) {
            copyBtn.textContent = "已复制";
            setTimeout(() => { copyBtn.textContent = "复制"; }, 1400);
          } else {
            toast("复制失败");
          }
        },
      }, "复制");
      container.appendChild(el("div", { class: "chat-code-block" },
        el("div", { class: "chat-code-head" }, el("span", null, lang), copyBtn),
        el("pre", null, el("code", null, codeStr))
      ));
      continue;
    }

    if (!trimmed) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      container.appendChild(el("hr", { class: "chat-md-hr" }));
      i++;
      continue;
    }

    // GFM Table: header line with '|' followed by separator line
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(trimmed);
      const aligns = parseTableAlignments(lines[i + 1]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const thead = el("thead", null,
        el("tr", null, ...headers.map((cell, ci) => {
          const th = el("th", { scope: "col", style: aligns[ci] ? { textAlign: aligns[ci] } : null });
          appendInline(th, cell);
          return th;
        }))
      );
      const tbody = el("tbody", null,
        ...bodyRows.map((row) => el("tr", null,
          ...headers.map((_, ci) => {
            const td = el("td", { style: aligns[ci] ? { textAlign: aligns[ci] } : null });
            appendInline(td, row[ci] ?? "");
            return td;
          })
        ))
      );
      container.appendChild(el("div", {
        class: "chat-md-table-wrap",
        tabindex: "0",
        role: "region",
        "aria-label": "数据表格",
      }, el("table", { class: "chat-md-table" }, thead, tbody)));
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      const bq = el("blockquote", { class: "chat-md-quote" });
      quoteLines.forEach((ql) => {
        if (!ql) return;
        const p = el("p");
        appendInline(p, ql);
        bq.appendChild(p);
      });
      container.appendChild(bq);
      continue;
    }

    // Headings
    const hm = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hm) {
      const level = Math.min(4, hm[1].length);
      const h = el(`h${level}`);
      appendInline(h, hm[2]);
      container.appendChild(h);
      i++;
      continue;
    }

    // Unordered list
    if (/^[-*•]\s+/.test(trimmed)) {
      const ul = el("ul");
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        const li = el("li");
        appendInline(li, lines[i].trim().replace(/^[-*•]\s+/, ""));
        ul.appendChild(li);
        i++;
      }
      container.appendChild(ul);
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const ol = el("ol");
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        const li = el("li");
        appendInline(li, lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        ol.appendChild(li);
        i++;
      }
      container.appendChild(ol);
      continue;
    }

    // Paragraph (combine consecutive plain lines up to block markers)
    const p = el("p");
    appendInline(p, line);
    container.appendChild(p);
    i++;
  }
  return container;
}

export async function renderChat(root, ctx, params = {}) {
  clear(root);
  const page = el("div", { class: "chat-page" });
  root.appendChild(page);

  const [docsRes, skillsRes, modRes] = await Promise.all([
    api("GET", "/api/docs/chat_session").catch(() => ({ items: [] })),
    api("GET", "/api/skills").catch(() => ({ items: [] })),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [], textProviders: [] })),
  ]);
  if (!page.isConnected) return;

  let skillsList = Array.isArray(skillsRes.items) ? skillsRes.items : [];
  let sessions = (docsRes.items || []).map((d) => {
    let data = {};
    try {
      data = typeof d.data === "string" ? JSON.parse(d.data) : (d.data || {});
    } catch {}
    return {
      id: d.id,
      name: d.name || "新聊天",
      updatedAt: d.updatedAt || data.updatedAt || Date.now(),
      data: {
        messages: Array.isArray(data.messages) ? data.messages : [],
        skillIds: Array.isArray(data.skillIds) ? data.skillIds : [],
        directPrompt: Boolean(data.directPrompt),
        textModelRef: data.textModelRef || modRes.defaultTextModel || "site:auto",
        imageModelRef: data.imageModelRef || modRes.defaultModel || "site:seedream-4.5",
        ratio: data.ratio || "3:4",
      },
    };
  });

  const makeBlankSession = () => ({
    id: uid("chat"),
    name: "新聊天",
    updatedAt: Date.now(),
    persisted: false,
    data: {
      messages: [],
      skillIds: skillsList.filter((sk) => sk.builtin && sk.enabled !== false).map((sk) => sk.id),
      directPrompt: false,
      textModelRef: modRes.defaultTextModel || "site:auto",
      imageModelRef: modRes.defaultModel || "site:seedream-4.5",
      ratio: "3:4",
    },
  });

  if (sessions.length === 0) {
    sessions = [makeBlankSession()];
  } else {
    sessions.forEach((s) => { s.persisted = true; });
  }

  let activeId = sessions[0].id;
  let draftRefs = [];
  let isSending = false;
  let sidebarCollapsed = getSidebarCollapsed();
  let threadQuery = "";
  let editingThreadId = "";
  let modelPopoverOpen = false;

  const activeSession = () => sessions.find((s) => s.id === activeId) || sessions[0];

  async function persistSession(sess) {
    if (!sess) return;
    sess.updatedAt = Date.now();
    try {
      const res = await api("PUT", `/api/docs/chat_session/${encodeURIComponent(sess.id)}`, {
        name: sess.name,
        data: { ...sess.data, updatedAt: sess.updatedAt },
      });
      if (res.doc?.id) sess.id = res.doc.id;
      sess.persisted = true;
    } catch {}
  }

  const startNewChat = () => {
    const ns = makeBlankSession();
    sessions = [ns, ...sessions];
    activeId = ns.id;
    draftRefs = [];
    editingThreadId = "";
    syncModelPickers();
    renderAll();
    inputEl.focus();
  };

  // ---------- Left Sidebar ----------
  const threadSearchInput = el("input", {
    type: "search",
    class: "input chat-thread-search",
    placeholder: "搜索聊天…",
    "aria-label": "搜索聊天",
  });
  threadSearchInput.addEventListener("input", () => {
    threadQuery = threadSearchInput.value.trim().toLowerCase();
    renderThreads();
  });
  const threadSearchWrap = el("div", { class: "chat-thread-search-wrap hidden" }, threadSearchInput);
  const threadList = el("div", { class: "chat-thread-list", role: "listbox", "aria-label": "聊天列表" });

  const sidebar = el("aside", { class: "chat-sidebar", "aria-label": "聊天列表" },
    el("div", { class: "chat-sidebar-head" },
      el("h1", { class: "chat-sidebar-title" }, "聊天"),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: startNewChat,
      }, "＋ 新聊天")
    ),
    threadSearchWrap,
    threadList
  );

  // ---------- Right Main Pane Header ----------
  const sidebarToggleBtn = el("button", {
    type: "button",
    class: "chat-header-icon-btn",
    title: "收起/展开聊天列表",
    "aria-label": "收起或展开聊天列表",
    "aria-expanded": String(!sidebarCollapsed),
    onClick: () => {
      sidebarCollapsed = !sidebarCollapsed;
      setSidebarCollapsed(sidebarCollapsed);
      syncSidebarState();
    },
  }, "☰");

  const headerTitleHost = el("div", { class: "chat-header-title-wrap" });
  const headerMetaBadge = el("span", { class: "chat-header-count" });
  const headerNewBtn = el("button", {
    type: "button",
    class: "btn btn-sm chat-header-new-btn hidden",
    onClick: startNewChat,
  }, "＋ 新聊天");
  const headerModelChip = el("button", {
    type: "button",
    class: "chat-header-model-btn",
    title: "点击切换文字模型、生图模型和默认比例",
    onClick: (e) => {
      e.stopPropagation();
      toggleModelPopover();
    },
  });

  const mainHeader = el("header", { class: "chat-header" },
    el("div", { class: "chat-header-left" }, sidebarToggleBtn, headerTitleHost, headerMetaBadge),
    el("div", { class: "chat-header-right" }, headerModelChip, headerNewBtn)
  );

  // ---------- Messages Area & Scroll-to-Bottom ----------
  const messagesBox = el("div", { class: "chat-messages", "aria-live": "polite" });
  const scrollBottomBtn = el("button", {
    type: "button",
    class: "chat-scroll-bottom-btn hidden",
    "aria-label": "回到底部",
    onClick: () => {
      messagesBox.scrollTo({ top: messagesBox.scrollHeight, behavior: "smooth" });
    },
  }, "↓ 回到底部");

  messagesBox.addEventListener("scroll", () => {
    const gap = messagesBox.scrollHeight - messagesBox.scrollTop - messagesBox.clientHeight;
    scrollBottomBtn.classList.toggle("hidden", gap < 160);
  });

  // ---------- Composer ----------
  const slashMenu = el("div", { class: "chat-slash-menu hidden", role: "listbox", "aria-label": "技能快捷命令" });
  const refsStrip = el("div", { class: "make-image-composer-attachments hidden" });
  const selectedSkillsBar = el("div", { class: "chat-selected-skills hidden", "aria-label": "已选择的 Skill" });
  const fileInput = el("input", { type: "file", accept: "image/*", multiple: true, class: "hidden" });

  async function importRefFile(file) {
    if (!file) return;
    if (draftRefs.length >= MAX_REF_IMAGES) {
      toast(`参考图最多 ${MAX_REF_IMAGES} 张，请先移除一张`);
      return;
    }
    try {
      const path = await importTempReferenceFile(file);
      if (path) {
        if (!draftRefs.includes(path)) {
          draftRefs = [...draftRefs, path];
          renderDraftRefs();
          toast("已添加参考图");
        } else {
          toast("该参考图已在当前列表里");
        }
      }
    } catch (e) { toast(e.message); }
  }

  fileInput.addEventListener("change", async () => {
    for (const f of Array.from(fileInput.files || [])) await importRefFile(f);
    fileInput.value = "";
  });

  function renderDraftRefs() {
    clear(refsStrip);
    refsStrip.classList.toggle("hidden", draftRefs.length === 0);
    draftRefs.forEach((rp, idx) => {
      refsStrip.appendChild(el("div", { class: "make-image-ref-thumb" },
        el("img", { src: localImg(rp), alt: `参考图 ${idx + 1}` }),
        el("button", {
          type: "button",
          "aria-label": `移除参考图 ${idx + 1}`,
          onClick: () => { draftRefs.splice(idx, 1); renderDraftRefs(); },
        }, "×")
      ));
    });
  }

  function renderSelectedSkills() {
    const sess = activeSession();
    const isDirect = Boolean(sess.data.directPrompt);
    const byID = new Map(skillsList.map((sk) => [sk.id, sk]));
    const validIds = (sess.data.skillIds || []).filter((id) => byID.has(id));
    if (validIds.length !== (sess.data.skillIds || []).length) {
      sess.data.skillIds = validIds;
    }

    const visibleIds = isDirect
      ? validIds.filter((id) => {
          const sk = byID.get(id);
          return sk && !sk.builtin && sk.id !== "handraw-skill";
        })
      : validIds;

    clear(selectedSkillsBar);
    selectedSkillsBar.classList.toggle("hidden", !isDirect && visibleIds.length === 0);
    if (isDirect) {
      selectedSkillsBar.appendChild(el("span", {
        class: "chat-skill-chip is-direct-chip",
        title: "已关闭手绘 Skill，发图时将直接透传你的原始提示词",
      }, el("span", { class: "chat-skill-chip-label" }, "⚡ 提示词直出 · 未调用手绘 Skill")));
    }
    visibleIds.forEach((id) => {
      const sk = byID.get(id);
      if (!sk) return;
      selectedSkillsBar.appendChild(el("span", {
        class: "chat-skill-chip",
        title: sk.description ? `${sk.name}：${sk.description}` : sk.name,
      },
        el("span", { class: "chat-skill-chip-label" }, `⚡ ${sk.name}`),
        el("button", {
          type: "button",
          class: "chat-skill-chip-remove",
          "aria-label": `移除 Skill ${sk.name}`,
          title: `移除 ${sk.name}`,
          onClick: () => {
            sess.data.skillIds = (sess.data.skillIds || []).filter((x) => x !== id);
            renderSelectedSkills();
            if (sess.persisted) persistSession(sess);
          },
        }, "×")
      ));
    });

    chatModeSkillBtn.classList.toggle("is-active", !isDirect);
    chatModeDirectBtn.classList.toggle("is-active", isDirect);
    chatModeSkillBtn.setAttribute("aria-pressed", String(!isDirect));
    chatModeDirectBtn.setAttribute("aria-pressed", String(isDirect));
    pickSkillBtn.classList.toggle("hidden", isDirect);
    pickSkillBtn.textContent = validIds.length > 0 ? `⚡ Skill · ${validIds.length}` : "⚡ Skill";
    pickSkillBtn.classList.toggle("is-has-skills", validIds.length > 0);
    inputEl.placeholder = isDirect
      ? "提示词直出模式：输入或粘贴完整提示词直接生图…（Ctrl/⌘ + Enter 发送）"
      : "发消息聊天、描述想画的图，或输入 / 调用 Skill…（Ctrl/⌘ + Enter 发送）";
  }

  const inputEl = el("textarea", {
    class: "chat-composer-input",
    rows: "2",
    "aria-label": "输入聊天消息、生图需求或 /skill 指令",
    placeholder: "发消息聊天、描述想画的图，或输入 / 调用 Skill…（Ctrl/⌘ + Enter 发送）",
  });

  function autoResize() {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(180, Math.max(48, inputEl.scrollHeight))}px`;
  }

  function updateSlashMenu() {
    const val = inputEl.value;
    if (!val.startsWith("/") || val.includes("\n") || val.includes(" ")) {
      slashMenu.classList.add("hidden");
      return;
    }
    const q = val.slice(1).toLowerCase();
    const candidates = [
      ...skillsList.map((sk) => ({
        cmd: `/${sk.id} `,
        title: `/${sk.id}`,
        desc: `${sk.name}${sk.description ? " · " + sk.description : ""}`,
      })),
      { cmd: "/update-skill", title: "/update-skill", desc: "免重启在线热更新内置官方手绘skill" },
      { cmd: "/install-skill ", title: "/install-skill <路径或链接>", desc: "直接从本地目录/文件或 GitHub 链接安装 Skill" },
      { cmd: "/install-plugin ", title: "/install-plugin <插件名或链接>", desc: "直接从市场或地址安装并启用插件" },
    ].filter((c) => !q || c.title.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));

    if (candidates.length === 0) {
      slashMenu.classList.add("hidden");
      return;
    }
    clear(slashMenu);
    candidates.slice(0, 8).forEach((c) => {
      slashMenu.appendChild(el("button", {
        type: "button",
        class: "chat-slash-item",
        onClick: () => {
          inputEl.value = c.cmd;
          slashMenu.classList.add("hidden");
          autoResize();
          inputEl.focus();
        },
      },
        el("strong", { class: "mono", style: { fontSize: "12px", color: "var(--accent)" } }, c.title),
        el("span", { class: "muted", style: { fontSize: "11.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.desc)
      ));
    });
    slashMenu.classList.remove("hidden");
  }

  inputEl.addEventListener("input", () => {
    autoResize();
    updateSlashMenu();
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      slashMenu.classList.add("hidden");
      if (modelPopoverOpen) closeModelPopover();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      slashMenu.classList.add("hidden");
      sendCurrentInput(false);
    }
  });

  // Model & Ratio selects live inside the dedicated clean floating popover
  const textModelSel = buildGroupedAIModelSelect(modRes, activeSession().data.textModelRef, "text");
  textModelSel.style.maxWidth = "100%";
  textModelSel.addEventListener("change", () => {
    const s = activeSession();
    s.data.textModelRef = textModelSel.value;
    syncModelSummary();
    if (s.persisted) persistSession(s);
  });

  const imageModelSel = buildGroupedModelSelect(modRes, activeSession().data.imageModelRef);
  imageModelSel.style.maxWidth = "100%";
  imageModelSel.addEventListener("change", () => {
    const s = activeSession();
    s.data.imageModelRef = imageModelSel.value;
    syncModelSummary();
    if (s.persisted) persistSession(s);
  });

  const ratioSel = el("select", { class: "select select-sm hidden", "aria-label": "默认生图比例" },
    ...RATIOS.map(([val, lbl]) => el("option", { value: val }, `${val} ${lbl}`))
  );
  ratioSel.value = activeSession().data.ratio || "3:4";

  const ratioPillsWrap = el("div", { class: "chat-ratio-pills", role: "group", "aria-label": "默认画幅比例" });
  const renderRatioPills = () => {
    clear(ratioPillsWrap);
    const cur = activeSession().data.ratio || "3:4";
    RATIOS.forEach(([val, lbl]) => {
      const on = cur === val;
      ratioPillsWrap.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm chat-ratio-pill" + (on ? " btn-primary is-active" : ""),
        "aria-pressed": String(on),
        onClick: (e) => {
          e.stopPropagation();
          const s = activeSession();
          s.data.ratio = val;
          ratioSel.value = val;
          renderRatioPills();
          syncModelSummary();
          if (s.persisted) persistSession(s);
        },
      }, `${val} ${lbl}`));
    });
  };

  const modelPopover = el("div", {
    id: "chat-model-popover",
    class: "chat-model-popover hidden",
    role: "region",
    "aria-label": "模型与画幅设置",
  },
    el("div", { class: "chat-model-popover-head" },
      el("strong", null, "模型与画幅设置"),
      el("button", {
        type: "button",
        class: "chat-inline-action",
        "aria-label": "关闭模型与画幅设置",
        onClick: () => closeModelPopover(),
      }, "✕")
    ),
    el("div", { class: "chat-model-popover-field" },
      el("label", { class: "chat-model-popover-label" }, "对话文字模型"),
      textModelSel
    ),
    el("div", { class: "chat-model-popover-field" },
      el("label", { class: "chat-model-popover-label" }, "生图模型"),
      imageModelSel
    ),
    el("div", { class: "chat-model-popover-field" },
      el("span", { class: "chat-model-popover-label" }, "默认生图画幅"),
      ratioPillsWrap
    )
  );

  const modelCapsuleText = el("span", { class: "chat-model-capsule-text" });
  const modelCapsuleBtn = el("button", {
    type: "button",
    class: "btn btn-sm chat-model-capsule-btn",
    "aria-expanded": "false",
    "aria-controls": "chat-model-popover",
    onClick: (e) => {
      e.stopPropagation();
      toggleModelPopover();
    },
  }, modelCapsuleText, el("span", { class: "chat-model-capsule-caret", "aria-hidden": "true" }, "▾"));

  function closeModelPopover() {
    modelPopoverOpen = false;
    modelPopover.classList.add("hidden");
    modelCapsuleBtn.setAttribute("aria-expanded", "false");
    modelCapsuleBtn.classList.remove("is-open");
  }

  function toggleModelPopover() {
    modelPopoverOpen = !modelPopoverOpen;
    modelPopover.classList.toggle("hidden", !modelPopoverOpen);
    modelCapsuleBtn.setAttribute("aria-expanded", String(modelPopoverOpen));
    modelCapsuleBtn.classList.toggle("is-open", modelPopoverOpen);
    if (modelPopoverOpen) renderRatioPills();
  }

  modelPopover.addEventListener("click", (e) => e.stopPropagation());

  const onDocClickClosePopover = (e) => {
    if (!page.isConnected) {
      document.removeEventListener("click", onDocClickClosePopover);
      document.removeEventListener("keydown", onDocKeyClosePopover);
      return;
    }
    if (!modelPopoverOpen) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (
      path.includes(modelPopover) ||
      modelPopover.contains(e.target) ||
      modelCapsuleBtn.contains(e.target) ||
      headerModelChip.contains(e.target)
    ) {
      return;
    }
    closeModelPopover();
  };
  const onDocKeyClosePopover = (e) => {
    if (!page.isConnected) {
      document.removeEventListener("click", onDocClickClosePopover);
      document.removeEventListener("keydown", onDocKeyClosePopover);
      return;
    }
    if (modelPopoverOpen && e.key === "Escape") {
      e.preventDefault();
      closeModelPopover();
      modelCapsuleBtn.focus();
    }
  };
  document.addEventListener("click", onDocClickClosePopover);
  document.addEventListener("keydown", onDocKeyClosePopover);

  function syncModelSummary() {
    const s = activeSession();
    const txtName = formatModelDisplay(s.data.textModelRef, modRes, { compact: true }) || "官方智能";
    const imgName = formatModelDisplay(s.data.imageModelRef, modRes, { compact: true }) || "默认生图";
    const ratio = s.data.ratio || "3:4";
    const fullTip = `文本模型：${formatModelDisplay(s.data.textModelRef, modRes)}\n生图模型：${formatModelDisplay(s.data.imageModelRef, modRes)}\n默认画幅：${ratio}`;
    modelCapsuleText.textContent = `${txtName} · ${ratio}`;
    modelCapsuleBtn.title = fullTip;
    headerModelChip.textContent = `${txtName} · 生图 ${imgName} · ${ratio}`;
    headerModelChip.title = fullTip;
  }

  const addRefBtn = el("button", {
    type: "button",
    class: "make-image-add-reference chat-add-ref-btn",
    title: "从自建图库选择、上传或粘贴参考图（也支持直接 Ctrl/⌘ + V 粘贴）",
    "aria-label": "添加参考图",
    onClick: () => openReferencePickerModal({
      currentRefs: draftRefs || [],
      maxCount: MAX_REF_IMAGES,
      title: "选择参考图（自建图库 / 本地上传 / 粘贴）",
      onConfirm: (nextRefs) => {
        draftRefs = nextRefs;
        renderDraftRefs();
      },
    }),
  }, "+");

  const chatModeSkillBtn = el("button", {
    type: "button",
    class: "mode-seg-btn",
    "data-chat-mode": "skill",
    title: "调用手绘 Skill 画风与图型规范生图",
    onClick: () => setChatDirectMode(false),
  }, "🎨 手绘");

  const chatModeDirectBtn = el("button", {
    type: "button",
    class: "mode-seg-btn",
    "data-chat-mode": "direct",
    title: "不调用手绘 Skill，直接将提示词原样传给生图模型",
    onClick: () => setChatDirectMode(true),
  }, "⚡ 直出");

  const chatModeSwitch = el("div", {
    class: "mode-seg-switch is-compact",
    role: "group",
    "aria-label": "会话生图模式",
  }, chatModeSkillBtn, chatModeDirectBtn);

  function setChatDirectMode(on) {
    const s = activeSession();
    const next = Boolean(on);
    if (Boolean(s.data.directPrompt) === next) return;
    s.data.directPrompt = next;
    renderSelectedSkills();
    if (s.persisted) persistSession(s);
  }

  const pickSkillBtn = el("button", {
    type: "button",
    class: "btn btn-sm chat-pick-skill-btn",
    title: "选择或管理本次会话启用的 Skill",
    onClick: () => openSkillPickerModal(),
  }, "⚡ Skill");

  const sendBtn = el("button", { type: "submit", class: "btn btn-primary btn-sm chat-send-btn" }, "发送");

  const composerForm = el("form", { class: "chat-composer" },
    fileInput,
    ratioSel,
    refsStrip,
    selectedSkillsBar,
    inputEl,
    el("div", { class: "chat-composer-bar" },
      el("div", { class: "chat-composer-left" },
        addRefBtn,
        chatModeSwitch,
        pickSkillBtn,
        modelCapsuleBtn
      ),
      el("div", { class: "chat-composer-right" }, sendBtn)
    )
  );
  composerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    slashMenu.classList.add("hidden");
    closeModelPopover();
    sendCurrentInput(false);
  });
  bindPageImagePaste(composerForm, async (files) => {
    for (const f of files) await importRefFile(f);
  });
  composerForm.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      composerForm.classList.add("is-dragover");
    }
  });
  composerForm.addEventListener("dragleave", () => composerForm.classList.remove("is-dragover"));
  composerForm.addEventListener("drop", async (e) => {
    composerForm.classList.remove("is-dragover");
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      for (const f of files) await importRefFile(f);
    }
  });

  const composerWrap = el("div", { class: "chat-composer-wrap" },
    scrollBottomBtn,
    slashMenu,
    modelPopover,
    composerForm
  );

  const mainPane = el("section", { class: "chat-main", "aria-label": "对话内容" },
    mainHeader,
    messagesBox,
    composerWrap
  );

  const workspace = el("div", { class: "chat-workspace" }, sidebar, mainPane);
  page.appendChild(workspace);

  function syncSidebarState() {
    workspace.classList.toggle("is-sidebar-collapsed", sidebarCollapsed);
    sidebarToggleBtn.setAttribute("aria-expanded", String(!sidebarCollapsed));
    sidebarToggleBtn.title = sidebarCollapsed ? "展开聊天列表" : "收起聊天列表";
    headerNewBtn.classList.toggle("hidden", !sidebarCollapsed);
  }

  // ---------- Render Functions ----------
  function renderHeader() {
    const sess = activeSession();
    const count = sess.data.messages.length;
    headerMetaBadge.textContent = count > 0 ? `${count} 条消息` : "空对话";
    clear(headerTitleHost);
    if (editingThreadId === `header:${sess.id}`) {
      const inp = el("input", {
        type: "text",
        class: "input chat-header-title-input",
        value: sess.name || "新聊天",
        maxlength: "40",
        "aria-label": "重命名当前聊天",
      });
      const finish = async (save) => {
        const next = inp.value.trim();
        editingThreadId = "";
        if (save && next && next !== sess.name) {
          sess.name = next;
          if (sess.persisted) await persistSession(sess);
        }
        renderHeader();
        renderThreads();
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      });
      inp.addEventListener("blur", () => finish(true));
      headerTitleHost.appendChild(inp);
      queueMicrotask(() => { inp.focus(); inp.select(); });
    } else {
      headerTitleHost.appendChild(el("button", {
        type: "button",
        class: "chat-header-title-btn",
        title: "点击重命名聊天",
        onClick: () => {
          editingThreadId = `header:${sess.id}`;
          renderHeader();
        },
      },
        el("span", { class: "chat-header-title-text" }, sess.name || "新聊天"),
        el("span", { class: "chat-header-title-edit", "aria-hidden": "true" }, "✎")
      ));
    }
    syncModelSummary();
  }

  function renderThreads() {
    threadSearchWrap.classList.toggle("hidden", sessions.length < 2);
    clear(threadList);
    const filtered = sessions.filter((sess) => {
      if (!threadQuery) return true;
      const inName = (sess.name || "").toLowerCase().includes(threadQuery);
      const inMsg = (sess.data.messages || []).some((m) => (m.content || "").toLowerCase().includes(threadQuery));
      return inName || inMsg;
    });

    if (!filtered.length) {
      threadList.appendChild(el("p", { class: "muted", style: { fontSize: "12px", textAlign: "center", padding: "16px 8px", margin: 0 } }, "没有匹配的聊天"));
      return;
    }

    filtered.forEach((sess) => {
      const isAct = sess.id === activeId;
      const msgCount = sess.data.messages.length;
      const sub = msgCount > 0 ? `${msgCount} 条 · ${fmtTime(sess.updatedAt)}` : "空聊天";

      if (editingThreadId === sess.id) {
        const inp = el("input", {
          type: "text",
          class: "input chat-thread-rename-input",
          value: sess.name || "新聊天",
          maxlength: "40",
          "aria-label": `重命名聊天 ${sess.name}`,
        });
        const finish = async (save) => {
          const next = inp.value.trim();
          editingThreadId = "";
          if (save && next && next !== sess.name) {
            sess.name = next;
            if (sess.persisted) await persistSession(sess);
          }
          renderThreads();
          renderHeader();
        };
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(true); }
          else if (e.key === "Escape") { e.preventDefault(); finish(false); }
        });
        inp.addEventListener("blur", () => finish(true));
        threadList.appendChild(el("div", { class: "chat-thread-item is-active" }, inp));
        queueMicrotask(() => { inp.focus(); inp.select(); });
        return;
      }

      const row = el("div", {
        class: "chat-thread-item" + (isAct ? " is-active" : ""),
        role: "option",
        "aria-selected": String(isAct),
        tabindex: "0",
        onClick: () => {
          activeId = sess.id;
          syncModelPickers();
          renderAll();
        },
        onKeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activeId = sess.id;
            syncModelPickers();
            renderAll();
          }
        },
      },
        el("div", { class: "chat-thread-meta" },
          el("span", { class: "chat-thread-name", title: sess.name }, sess.name || "新聊天"),
          el("span", { class: "chat-thread-sub" }, sub)
        ),
        el("div", { class: "chat-thread-actions" },
          el("button", {
            type: "button",
            class: "chat-thread-act",
            title: "重命名聊天",
            "aria-label": `重命名聊天 ${sess.name}`,
            onClick: (e) => {
              e.stopPropagation();
              editingThreadId = sess.id;
              renderThreads();
            },
          }, "✎"),
          sessions.length > 1
            ? el("button", {
                type: "button",
                class: "chat-thread-act is-danger",
                title: "删除聊天",
                "aria-label": `删除聊天 ${sess.name}`,
                onClick: async (e) => {
                  e.stopPropagation();
                  if (sess.persisted) {
                    await api("DELETE", `/api/docs/chat_session/${encodeURIComponent(sess.id)}`).catch(() => {});
                  }
                  sessions = sessions.filter((x) => x.id !== sess.id);
                  if (sessions.length === 0) sessions = [makeBlankSession()];
                  if (activeId === sess.id) activeId = sessions[0].id;
                  syncModelPickers();
                  renderAll();
                },
              }, "×")
            : null
        )
      );
      threadList.appendChild(row);
    });
  }

  function syncModelPickers() {
    const s = activeSession();
    if (s.data.textModelRef && Array.from(textModelSel.options).some((o) => o.value === s.data.textModelRef)) {
      textModelSel.value = s.data.textModelRef;
    }
    if (s.data.imageModelRef && Array.from(imageModelSel.options).some((o) => o.value === s.data.imageModelRef)) {
      imageModelSel.value = s.data.imageModelRef;
    }
    ratioSel.value = s.data.ratio || "3:4";
    renderRatioPills();
    syncModelSummary();
  }

  function openLightbox(im, run) {
    const body = el("div", { class: "col", style: { alignItems: "center", gap: "8px" } },
      el("img", { src: localImg(im.path), alt: run?.title || "", style: { maxWidth: "100%", maxHeight: "72vh", borderRadius: "8px" } }),
      im.width ? el("div", { class: "muted mono", style: { fontSize: "12px" } }, `${im.width}×${im.height}`) : null
    );
    showModal(run?.title || "大图预览", body, [
      run?.id ? el("button", { type: "button", class: "btn", onClick: () => api("POST", `/api/works/${encodeURIComponent(run.id)}/reveal`).catch(() => {}) }, "在目录中打开") : null,
      el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭"),
    ].filter(Boolean));
  }

  function renderRunGrid(runs) {
    const grid = el("div", { class: "chat-run-grid" });
    runs.forEach((run) => {
      (run.images || []).forEach((im, idx) => {
        const card = el("div", { class: "chat-run-card" });
        if (im.status === "done" && im.path) {
          card.append(
            el("img", {
              class: "chat-run-img",
              src: localImg(im.thumb || im.path),
              alt: im.theme || run.title || `图 ${idx + 1}`,
              onClick: () => openLightbox(im, run),
            }),
            el("div", { class: "chat-run-actions" },
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: async () => {
                  await api("POST", `/api/images/${encodeURIComponent(im.id)}/copy`).catch((e) => toast(e.message));
                  toast("已复制到剪贴板");
                },
              }, "复制"),
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: () => {
                  if (draftRefs.length >= MAX_REF_IMAGES) return toast(`参考图最多 ${MAX_REF_IMAGES} 张`);
                  if (!draftRefs.includes(im.path)) draftRefs = [...draftRefs, im.path];
                  renderDraftRefs();
                  toast("已设为参考图");
                },
              }, "垫图"),
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: async (ev) => {
                  const btn = ev.currentTarget;
                  btn.disabled = true;
                  let rec = {};
                  try { rec = typeof run.recipe === "string" ? JSON.parse(run.recipe) : (run.recipe || {}); } catch {}
                  try {
                    await api("POST", "/api/inspirations", {
                      title: run.title || im.theme || "聊天生图灵感",
                      imagePath: im.path,
                      prompt: im.prompt || run.promptZh || run.promptEn || im.theme || run.originalRequest || "",
                      promptZh: run.promptZh || "",
                      source: "local",
                      runId: run.id,
                      recipe: rec,
                      suggestedStyle: rec.styleIds?.[0] || "",
                    });
                    btn.textContent = "已收藏";
                    toast("已收进灵感库");
                  } catch (e) {
                    btn.disabled = false;
                    toast(e?.message || "收藏失败");
                  }
                },
              }, "收藏"),
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: async () => {
                  let rec = {};
                  try { rec = typeof run.recipe === "string" ? JSON.parse(run.recipe) : (run.recipe || {}); } catch {}
                  try {
                    const saved = await api("POST", "/api/inspirations", {
                      title: run.title || im.theme || "聊天生图灵感",
                      imagePath: im.path,
                      prompt: im.prompt || run.promptZh || run.promptEn || im.theme || run.originalRequest || "",
                      promptZh: run.promptZh || "",
                      source: "local",
                      runId: run.id,
                      recipe: rec,
                      suggestedStyle: rec.styleIds?.[0] || "",
                    });
                    if (saved.item) {
                      openShareInspirationModal(saved.item, ctx);
                    }
                  } catch (e) {
                    toast(e?.message || "准备分享失败");
                  }
                },
              }, "赚积分"),
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: () => ctx.go("works", { openRun: run.id }),
              }, "发布")
            )
          );
        } else if (im.status === "failed" || im.status === "canceled") {
          card.append(el("div", { class: "chat-run-loader" },
            el("span", { class: "badge badge-err" }, im.status === "canceled" ? "已取消" : "失败"),
            el("span", { class: "muted" }, im.error || "生成未完成"),
            el("button", {
              type: "button",
              class: "btn btn-sm btn-primary",
              onClick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.textContent = "提交中…";
                try {
                  await api("POST", `/api/images/${encodeURIComponent(im.id)}/retry`);
                  im.status = "queued";
                  im.error = "";
                  renderMessages(false);
                  if (run?.id) syncRun(run.id);
                } catch (err) {
                  btn.disabled = false;
                  btn.textContent = "重试";
                  toast(err?.message || "重试失败");
                }
              },
            }, "重试")
          ));
        } else {
          card.append(el("div", { class: "chat-run-loader" },
            el("span", { class: "dot-pulse" }),
            el("strong", null, im.status === "running" ? `正在绘制 #${idx + 1}…` : `排队中 #${idx + 1}…`),
            el("span", { class: "muted" }, (im.theme || "").slice(0, 32))
          ));
        }
        grid.appendChild(card);
      });
    });
    return grid;
  }

  function renderMessages(scrollToBottom = true) {
    const sess = activeSession();
    const prevScrollTop = messagesBox.scrollTop;
    const mainScroller = page.closest(".main");
    const prevMainScrollTop = mainScroller ? mainScroller.scrollTop : 0;
    clear(messagesBox);

    if (!sess.data.messages.length && !isSending) {
      messagesBox.appendChild(el("div", { class: "chat-empty" },
        el("div", { class: "chat-empty-badge", "aria-hidden": "true" }, "✦"),
        el("h2", null, "手绘风 AI 聊天工作台"),
        el("p", null, "自由对话、策划选题、调用 Skill 或直接生图。点击左下角 + 可从自建图库选图或粘贴参考图。"),
        el("div", { class: "chat-starters" },
          ...STARTERS.map((st) => el("button", {
            type: "button",
            class: "chat-starter-card",
            onClick: () => {
              inputEl.value = st.text;
              autoResize();
              inputEl.focus();
            },
          },
            el("span", { class: "badge badge-accent" }, st.tag),
            el("span", null, st.text)
          ))
        )
      ));
      scrollBottomBtn.classList.add("hidden");
      return;
    }

    sess.data.messages.forEach((msg, msgIdx) => {
      const wrap = el("article", { class: `chat-msg is-${msg.role}` });

      if (msg.role === "user") {
        const bubble = el("div", { class: "chat-bubble" });
        if (msg.skillNames?.length) {
          bubble.appendChild(el("div", { class: "chat-user-tags" },
            ...msg.skillNames.map((nm) => el("span", { class: "badge badge-accent" }, `⚡ ${nm}`))
          ));
        }
        if (msg.refs?.length) {
          bubble.appendChild(el("div", { class: "chat-msg-refs" },
            ...msg.refs.map((rp, rIdx) => el("button", {
              type: "button",
              class: "chat-msg-ref-btn",
              "aria-label": `放大查看参考图 ${rIdx + 1}`,
              onClick: () => openLightbox({ path: rp }, { title: `参考图 ${rIdx + 1}` }),
            }, el("img", { src: localImg(rp), alt: `参考图 ${rIdx + 1}` })))
          ));
        }
        bubble.appendChild(el("div", { class: "chat-user-text" }, msg.content || ""));

        const copyUserBtn = el("button", {
          type: "button",
          class: "chat-msg-act-btn",
          onClick: async () => {
            if (await copyText(msg.content || "")) {
              copyUserBtn.textContent = "已复制";
              setTimeout(() => { copyUserBtn.textContent = "复制"; }, 1400);
            }
          },
        }, "复制");

        wrap.append(
          bubble,
          el("div", { class: "chat-user-foot" },
            msg.ts ? el("span", { class: "chat-msg-time" }, fmtTime(msg.ts)) : null,
            copyUserBtn
          )
        );
      } else {
        const body = el("div", { class: "chat-assistant-body" });

        if (msg.toolCalls?.length) {
          const allOk = msg.toolCalls.every((t) => t.ok);
          const det = el("details", { class: "chat-tool-trace", open: !allOk },
            el("summary", null,
              el("span", { class: allOk ? "chat-tool-dot is-ok" : "chat-tool-dot is-err", "aria-hidden": "true" }, allOk ? "✓" : "!"),
              el("span", { class: "chat-tool-summary-text" }, `已调用 ${msg.toolCalls.length} 项工具`),
              el("span", { class: "chat-tool-summary-caret", "aria-hidden": "true" }, "▾")
            ),
            el("div", { class: "chat-tool-list" },
              ...msg.toolCalls.map((tc) => el("div", { class: "chat-tool-item" },
                el("span", { class: tc.ok ? "chat-tool-ok" : "chat-tool-err" }, tc.ok ? "✓" : "✕"),
                el("strong", null, tc.label || tc.name),
                el("span", { class: "muted" }, tc.summary || "")
              ))
            )
          );
          body.appendChild(det);
        }

        if (msg.content) {
          body.appendChild(renderMarkdown(msg.content));
        }

        if (msg.runs?.length) {
          body.appendChild(renderRunGrid(msg.runs));
        }

        if (msg.pendingConfirm) {
          const pc = msg.pendingConfirm;
          body.appendChild(el("div", { class: "chat-confirm-box" },
            el("span", null, `预计生成 ${pc.count || 1} 张，费用 ${money(pc.totalCents || 0)}（超单次阈值 ${money(pc.limitCents || 0)}）`),
            el("button", {
              type: "button",
              class: "btn btn-sm btn-primary",
              onClick: () => {
                msg.pendingConfirm = null;
                retryLastWithConfirm();
              },
            }, "确认继续生成")
          ));
        }

        // Actions (copy / regenerate) + clean human-readable metadata
        const copyMdBtn = el("button", {
          type: "button",
          class: "chat-msg-act-btn",
          title: "复制整条回复内容",
          onClick: async () => {
            if (await copyText(msg.content || "")) {
              copyMdBtn.textContent = "✓ 已复制";
              setTimeout(() => { copyMdBtn.textContent = "复制"; }, 1400);
            }
          },
        }, "复制");

        const regenBtn = el("button", {
          type: "button",
          class: "chat-msg-act-btn",
          disabled: isSending,
          title: "基于上一条提问重新生成本条回复",
          onClick: () => regenerateFromIndex(msgIdx),
        }, "↻ 重新生成");

        const metaItems = [];
        const friendlyText = formatModelDisplay(msg.textModel, modRes);
        const friendlyImg = formatModelDisplay(msg.imageModel, modRes);
        if (friendlyText) metaItems.push(el("span", { class: "chat-meta-model", title: msg.textModel }, friendlyText));
        if (msg.runs?.length && friendlyImg) metaItems.push(el("span", { class: "chat-meta-model" }, `生图 · ${friendlyImg}`));
        if (msg.usedSkills?.length) {
          metaItems.push(el("span", { class: "chat-meta-skill" }, msg.usedSkills.map((s) => s.name).join("、")));
        }
        if (msg.usage?.cache_read_tokens > 0) {
          metaItems.push(el("span", {
            class: "chat-cache-pill",
            title: "已命中 Prompt Cache，节约输入 token 费用",
          }, `⚡ 缓存 ${msg.usage.cache_read_tokens} tok`));
        } else if (msg.usage?.total_tokens > 0) {
          metaItems.push(el("span", { class: "chat-meta-tok" }, `${msg.usage.total_tokens} tok`));
        }

        body.appendChild(el("div", { class: "chat-msg-foot" },
          el("div", { class: "chat-msg-acts" }, copyMdBtn, regenBtn),
          el("div", { class: "chat-msg-meta" }, ...metaItems)
        ));

        wrap.append(
          el("div", { class: "chat-assistant-avatar", "aria-hidden": "true" }, "✦"),
          body
        );
      }

      messagesBox.appendChild(wrap);
    });

    if (isSending) {
      messagesBox.appendChild(el("article", { class: "chat-msg is-assistant" },
        el("div", { class: "chat-assistant-avatar", "aria-hidden": "true" }, "✦"),
        el("div", { class: "chat-assistant-body" },
          el("div", { class: "chat-thinking-pill" },
            el("span", { class: "dot-pulse" }),
            el("span", { class: "muted" }, "正在思考与执行工具…")
          )
        )
      ));
    }

    if (scrollToBottom) {
      messagesBox.scrollTop = messagesBox.scrollHeight;
      scrollBottomBtn.classList.add("hidden");
    } else {
      messagesBox.scrollTop = prevScrollTop;
      if (mainScroller) mainScroller.scrollTop = prevMainScrollTop;
    }
  }

  function renderAll() {
    syncSidebarState();
    renderHeader();
    renderThreads();
    renderSelectedSkills();
    renderDraftRefs();
    renderMessages(true);
    sendBtn.disabled = isSending;
    sendBtn.textContent = isSending ? "思考中…" : "发送";
  }

  // ---------- Skill Picker Modal ----------
  async function reloadSkills() {
    const res = await api("GET", "/api/skills").catch(() => ({ items: [] }));
    if (Array.isArray(res.items)) skillsList = res.items;
  }

  function setSkillInlineBtn(btn, stateName, text, progress = 0, title = "") {
    if (!btn) return;
    btn.disabled = stateName === "busy";
    btn.classList.remove("is-busy", "is-done", "is-error");
    if (stateName === "busy" || stateName === "done" || stateName === "error") {
      btn.classList.add(`is-${stateName}`);
    }
    btn.style.setProperty("--upd-pct", `${Math.max(0, Math.min(100, progress))}%`);
    btn.textContent = text;
    if (title) btn.title = title;
  }

  async function openSkillPickerModal() {
    await reloadSkills();
    const sess = activeSession();
    const selectedSet = new Set(sess.data.skillIds || []);

    const searchIn = el("input", {
      type: "search",
      class: "input",
      placeholder: "搜索已安装的 Skill 名称、命令或说明…",
      "aria-label": "搜索 Skill",
    });
    const listWrap = el("div", { class: "chat-skill-picker-list" });
    const countLabel = el("span", { class: "muted", style: { fontSize: "12px" } });

    const renderList = () => {
      const q = searchIn.value.trim().toLowerCase();
      clear(listWrap);
      const filtered = skillsList.filter((sk) =>
        !q ||
        (sk.name || "").toLowerCase().includes(q) ||
        (sk.id || "").toLowerCase().includes(q) ||
        (sk.description || "").toLowerCase().includes(q)
      );
      countLabel.textContent = `共 ${filtered.length} 个 Skill`;

      if (!skillsList.length) {
        listWrap.appendChild(el("div", { class: "chat-skill-picker-empty" },
          el("p", { class: "muted", style: { margin: 0 } }, "还没有已安装的 Skill。可以直接在聊天框输入指令让 AI 安装或创建。"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            onClick: () => {
              closeModal();
              inputEl.value = STARTERS[2].text;
              autoResize();
              inputEl.focus();
            },
          }, "去输入框安装 Skill")
        ));
        return;
      }

      if (!filtered.length) {
        listWrap.appendChild(el("p", { class: "muted", style: { textAlign: "center", padding: "20px 0", margin: 0 } }, "没有匹配的 Skill"));
        return;
      }

      filtered.forEach((sk) => {
        const isSel = selectedSet.has(sk.id);
        const verBadge = sk.version ? el("span", { class: "badge mono" }, `v${sk.version}`) : null;
        const newBadge = sk.updateAvailable && sk.latestVersion
          ? el("span", { class: "badge badge-ok" }, `可升 v${sk.latestVersion}`)
          : null;

        const mainBtn = el("button", {
          type: "button",
          class: "chat-skill-picker-main",
          "aria-pressed": String(isSel),
          onClick: () => {
            const cur = Array.isArray(sess.data.skillIds) ? [...sess.data.skillIds] : [];
            if (!cur.includes(sk.id)) {
              cur.push(sk.id);
              sess.data.skillIds = cur;
            }
            renderSelectedSkills();
            if (sess.persisted) persistSession(sess);
            closeModal();
            inputEl.focus();
          },
        },
          el("div", { class: "chat-skill-picker-head" },
            el("strong", { class: "chat-skill-picker-name" }, sk.name),
            el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
              sk.builtin ? el("span", { class: "badge badge-accent" }, "内置官方") : null,
              verBadge,
              newBadge,
              el("span", { class: "badge mono" }, `/${sk.id}`),
              isSel ? el("span", { class: "badge badge-accent" }, "已选") : null
            )
          ),
          el("p", { class: "chat-skill-picker-desc" }, sk.description || "暂无介绍")
        );

        let foot = null;
        if (sk.updatable) {
          const updBtn = el("button", {
            type: "button",
            class: "btn btn-sm btn-update-inline",
            "data-skill-update": sk.id,
            onClick: async (e) => {
              e.stopPropagation();
              setSkillInlineBtn(updBtn, "busy", "在线更新中…", 35);
              try {
                const r = await api("POST", `/api/skills/${encodeURIComponent(sk.id)}/update`);
                const ver = r?.version ? ` v${r.version}` : "";
                setSkillInlineBtn(updBtn, "done", r?.updated ? `已更新${ver}` : `已是最新${ver}`, 100);
                await reloadSkills();
                setTimeout(() => {
                  if (listWrap.isConnected) renderList();
                }, 1200);
              } catch (err) {
                setSkillInlineBtn(updBtn, "error", "更新失败，重试", 0, err?.message || "更新失败");
              }
            },
          }, sk.updateAvailable && sk.latestVersion ? `更新至 v${sk.latestVersion}` : "在线更新");

          foot = el("div", { class: "chat-skill-picker-foot" },
            el("span", { class: "chat-skill-picker-foot-meta" },
              sk.updateAvailable && sk.latestVersion
                ? `发现新版本 v${sk.latestVersion}，支持免重启热更新`
                : (sk.builtin ? "内置官方手绘 Skill · 支持免重启在线动态更新" : "远端 Skill · 支持在线同步更新")
            ),
            updBtn
          );
        }

        const card = el("div", {
          class: "chat-skill-picker-item" + (isSel ? " is-selected" : ""),
          "data-skill-id": sk.id,
        }, mainBtn, foot);
        listWrap.appendChild(card);
      });
    };

    const checkAllBtn = el("button", {
      type: "button",
      class: "btn btn-update-inline",
      onClick: async () => {
        setSkillInlineBtn(checkAllBtn, "busy", "检查更新中…", 30);
        try {
          const r = await api("POST", "/api/skills/check-updates");
          const items = Array.isArray(r?.items) ? r.items : [];
          const cnt = items.filter((it) => it.updateAvailable).length;
          await reloadSkills();
          renderList();
          setSkillInlineBtn(checkAllBtn, "done", cnt > 0 ? `发现 ${cnt} 项更新` : "全部已是最新", 100);
          setTimeout(() => {
            if (checkAllBtn.isConnected) setSkillInlineBtn(checkAllBtn, "", "检查 Skill 更新", 0);
          }, 1800);
        } catch (err) {
          setSkillInlineBtn(checkAllBtn, "error", "检查失败，重试", 0, err?.message || "检查失败");
        }
      },
    }, "检查 Skill 更新");

    searchIn.addEventListener("input", renderList);
    renderList();

    showModal("选择 Skill", el("div", { class: "col", style: { gap: "10px" } },
      searchIn,
      countLabel,
      listWrap
    ), [
      el("button", {
        type: "button",
        class: "btn",
        onClick: () => {
          closeModal();
          openHarnessSkillImportModal({
            onImported: async () => {
              await reloadSkills();
              renderSelectedSkills();
              openSkillPickerModal();
            },
          });
        },
      }, "📥 从本机客户端导入"),
      el("button", {
        type: "button",
        class: "btn",
        style: { marginRight: "auto" },
        onClick: () => {
          closeModal();
          inputEl.value = "/install-skill ";
          autoResize();
          inputEl.focus();
        },
      }, "＋ 用指令安装"),
      checkAllBtn,
      el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭"),
    ]);
    searchIn.focus();
  }

  // ---------- Send Turn & Regenerate ----------
  async function sendMessages(sess, confirmed) {
    isSending = true;
    renderAll();
    const apiMessages = sess.data.messages.map((m) => ({ role: m.role, content: m.content || "" }));
    const lastUser = [...sess.data.messages].reverse().find((m) => m.role === "user");
    const isDirect = Boolean(sess.data.directPrompt);
    const byID = new Map(skillsList.map((sk) => [sk.id, sk]));
    const activeIds = (sess.data.skillIds || []).filter((id) => {
      if (!isDirect) return true;
      const sk = byID.get(id);
      return sk && !sk.builtin && sk.id !== "handraw-skill";
    });
    try {
      const res = await api("POST", "/api/chat/turn", {
        sessionId: sess.id,
        messages: apiMessages,
        textModelRef: textModelSel.value,
        imageModelRef: imageModelSel.value,
        skillIds: activeIds,
        directPrompt: isDirect,
        ratio: ratioSel.value,
        refs: lastUser?.refs || [],
        confirmed,
      });
      if (!page.isConnected) return;
      sess.data.messages.push({
        id: uid("msg"),
        role: "assistant",
        content: res.reply || "",
        textModel: res.textModel || "",
        imageModel: res.imageModel || "",
        usedSkills: res.usedSkills || [],
        toolCalls: res.toolCalls || [],
        runs: res.runs || [],
        usage: res.usage || null,
        pendingConfirm: res.pendingConfirm || null,
        ts: Date.now(),
      });
      await persistSession(sess);
      if (res.skillsChanged) await reloadSkills();
      if (res.pluginsChanged) await ctx.refreshNav?.();
      for (const r of (res.runs || [])) {
        if (r?.id && (r.images || []).some((im) => im.status === "queued" || im.status === "running")) {
          syncRun(r.id);
        }
      }
    } catch (e) {
      sess.data.messages.push({
        id: uid("msg"),
        role: "assistant",
        content: `请求失败：${e.message || "未知错误"}`,
        ts: Date.now(),
      });
    } finally {
      isSending = false;
      renderAll();
    }
  }

  async function regenerateFromIndex(assistantIdx) {
    if (isSending) return;
    const sess = activeSession();
    if (assistantIdx <= 0 || assistantIdx >= sess.data.messages.length) return;
    sess.data.messages = sess.data.messages.slice(0, assistantIdx);
    await sendMessages(sess, false);
  }

  async function sendCurrentInput(confirmed) {
    if (isSending) return;
    const text = inputEl.value.trim();
    if (!text) return;
    const sess = activeSession();
    if (sess.data.messages.length === 0) {
      sess.name = text.replace(/^\/\S+\s*/, "").slice(0, 22) || "新聊天";
    }
    const isDirect = Boolean(sess.data.directPrompt);
    const byID = new Map(skillsList.map((sk) => [sk.id, sk]));
    const skillNames = isDirect
      ? ["⚡ 提示词直出"]
      : (sess.data.skillIds || []).map((id) => byID.get(id)?.name).filter(Boolean);
    sess.data.messages.push({
      id: uid("msg"),
      role: "user",
      content: text,
      refs: [...draftRefs],
      skillNames,
      ts: Date.now(),
    });
    inputEl.value = "";
    draftRefs = [];
    autoResize();
    await sendMessages(sess, confirmed);
  }

  async function retryLastWithConfirm() {
    if (isSending) return;
    const sess = activeSession();
    await sendMessages(sess, true);
  }

  // ---------- Live SSE sync for generated images & skills ----------
  const pendingRunSync = new Map();
  async function syncRun(runId) {
    if (!runId || !page.isConnected) return;
    try {
      const detail = await api("GET", `/api/works/${encodeURIComponent(runId)}`);
      const freshRun = detail.run;
      if (!freshRun || !page.isConnected) return;
      let touched = false;
      const sess = activeSession();
      sessions.forEach((s) => {
        s.data.messages.forEach((m) => {
          if (!m.runs?.length) return;
          m.runs = m.runs.map((r) => {
            if (r.id === runId) {
              if (s.id === sess.id) touched = true;
              return freshRun;
            }
            return r;
          });
        });
      });
      if (touched) {
        renderMessages(false);
        await persistSession(sess);
      }
    } catch {}
  }

  const unsub = onEvent((msg) => {
    if (!page.isConnected) {
      unsub();
      return;
    }
    if (msg.type === "skills") {
      reloadSkills();
      return;
    }
    if (msg.type !== "job" && msg.type !== "run") return;
    const rid = msg.data?.runId || msg.data?.id;
    if (!rid) return;
    const tracked = sessions.some((s) => s.data.messages.some((m) => m.runs?.some((r) => r.id === rid)));
    if (!tracked || pendingRunSync.has(rid)) return;
    pendingRunSync.set(rid, setTimeout(() => {
      pendingRunSync.delete(rid);
      syncRun(rid);
    }, 150));
  });

  if (params.directPrompt !== undefined) {
    activeSession().data.directPrompt = Boolean(params.directPrompt);
  }
  if (Array.isArray(params.refs) && params.refs.length) {
    const merged = [...draftRefs];
    for (const rp of params.refs) {
      if (rp && !merged.includes(rp) && merged.length < MAX_REF_IMAGES) merged.push(rp);
    }
    draftRefs = merged;
  }
  if (params.prompt) {
    inputEl.value = params.prompt;
    autoResize();
  }
  syncModelPickers();
  renderAll();
}
