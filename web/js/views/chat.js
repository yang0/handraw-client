import { api, clear, closeModal, el, localImg, money, onEvent, showModal, toast } from "../api.js";
import { openHarnessSkillImportModal } from "../skills-ui.js";
import { buildGroupedAIModelSelect, buildGroupedModelSelect } from "./create.js";
import { RATIOS } from "./studio-controls.js";
import { openShareInspirationModal } from "./work-remix-modal.js";

const chatCss = el("link", { rel: "stylesheet", href: new URL("../../css/chat.css", import.meta.url).href });
document.head.appendChild(chatCss);

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

// Lightweight XSS-safe Markdown renderer built strictly with DOM nodes.
function renderMarkdown(text) {
  const container = el("div", { class: "chat-md" });
  const src = String(text || "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  let i = 0;

  const appendInline = (parent, line) => {
    const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(line)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(line.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith("**") && tok.endsWith("**")) {
        parent.appendChild(el("strong", null, tok.slice(2, -2)));
      } else if (tok.startsWith("`") && tok.endsWith("`")) {
        parent.appendChild(el("code", null, tok.slice(1, -1)));
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
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim() || "text";
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
        class: "btn btn-sm",
        style: { padding: "2px 7px", fontSize: "11px" },
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(codeStr);
            toast("已复制代码");
          } catch {
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
    if (!line.trim()) {
      i++;
      continue;
    }
    const hm = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (hm) {
      const tag = "h" + Math.min(3, hm[1].length);
      const h = el(tag);
      appendInline(h, hm[2]);
      container.appendChild(h);
      i++;
      continue;
    }
    if (/^[-*•]\s+/.test(line.trim())) {
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
    if (/^\d+[.)]\s+/.test(line.trim())) {
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
      name: d.name || "新会话",
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
    name: "新会话",
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

  // ---------- Left Sidebar (clean thread list only) ----------
  const threadList = el("div", { class: "chat-thread-list", role: "listbox", "aria-label": "会话列表" });

  const sidebar = el("aside", { class: "chat-sidebar", "aria-label": "会话列表" },
    el("div", { class: "chat-sidebar-head" },
      el("h1", { class: "chat-sidebar-title" }, "会话"),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => {
          const ns = makeBlankSession();
          sessions = [ns, ...sessions];
          activeId = ns.id;
          draftRefs = [];
          syncModelPickers();
          renderAll();
          inputEl.focus();
        },
      }, "＋ 新会话")
    ),
    threadList
  );

  // ---------- Right Main Pane ----------
  const messagesBox = el("div", { class: "chat-messages", "aria-live": "polite" });

  // Composer
  const slashMenu = el("div", { class: "chat-slash-menu hidden", role: "listbox", "aria-label": "技能快捷命令" });
  const refsStrip = el("div", { class: "make-image-composer-attachments hidden" });
  const selectedSkillsBar = el("div", { class: "chat-selected-skills hidden", "aria-label": "已选择的 Skill" });
  const fileInput = el("input", { type: "file", accept: "image/*", multiple: true, class: "hidden" });

  async function importRefFile(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await api("POST", "/api/images/import", fd);
      if (res.path) {
        draftRefs = [...draftRefs, res.path];
        renderDraftRefs();
        toast("已添加参考图");
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
    pickSkillBtn.textContent = validIds.length > 0 ? `选择 Skill (${validIds.length})` : "选择 Skill";
    pickSkillBtn.classList.toggle("is-has-skills", validIds.length > 0);
    inputEl.placeholder = isDirect
      ? "已开启提示词直出（不调用手绘 Skill）：直接粘贴外部提示词或发消息生图，将原样传给生图模型…（Ctrl/⌘ + Enter 发送）"
      : "发消息聊天、描述想画的图，或输入 / 调用已安装 Skill、安装新 Skill / 插件…（Ctrl/⌘ + Enter 发送）";
  }

  const inputEl = el("textarea", {
    class: "chat-composer-input",
    rows: "2",
    "aria-label": "输入聊天消息、生图需求或 /skill 指令",
    placeholder: "发消息聊天、描述想画的图，或输入 / 调用已安装 Skill、安装新 Skill / 插件…（Ctrl/⌘ + Enter 发送）",
  });

  function autoResize() {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(180, Math.max(54, inputEl.scrollHeight))}px`;
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
  inputEl.addEventListener("paste", async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imgItem = items.find((it) => it.type && it.type.startsWith("image/"));
    if (imgItem) {
      const f = imgItem.getAsFile();
      if (f) {
        e.preventDefault();
        await importRefFile(f);
      }
    }
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      slashMenu.classList.add("hidden");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      slashMenu.classList.add("hidden");
      sendCurrentInput(false);
    }
  });

  const textModelSel = buildGroupedAIModelSelect(modRes, activeSession().data.textModelRef, "text");
  textModelSel.addEventListener("change", () => {
    const s = activeSession();
    s.data.textModelRef = textModelSel.value;
    if (s.persisted) persistSession(s);
  });

  const imageModelSel = buildGroupedModelSelect(modRes, activeSession().data.imageModelRef);
  imageModelSel.addEventListener("change", () => {
    const s = activeSession();
    s.data.imageModelRef = imageModelSel.value;
    if (s.persisted) persistSession(s);
  });

  const ratioSel = el("select", { class: "select select-sm", style: { maxWidth: "105px" }, "aria-label": "默认生图比例" },
    ...RATIOS.map(([val, lbl]) => el("option", { value: val }, `${val} ${lbl}`))
  );
  ratioSel.value = activeSession().data.ratio || "3:4";
  ratioSel.addEventListener("change", () => {
    const s = activeSession();
    s.data.ratio = ratioSel.value;
    if (s.persisted) persistSession(s);
  });

  const addRefBtn = el("button", {
    type: "button",
    class: "make-image-add-reference",
    title: "添加参考图（也可粘贴或拖拽图片）",
    "aria-label": "添加参考图",
    onClick: () => fileInput.click(),
  }, "+");

  const chatModeSkillBtn = el("button", {
    type: "button",
    class: "mode-seg-btn",
    "data-chat-mode": "skill",
    title: "调用手绘 Skill 画风与图型规范生图",
    onClick: () => setChatDirectMode(false),
  }, "🎨 手绘 Skill");

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
    onClick: () => openSkillPickerModal(),
  }, "选择 Skill");

  const sendBtn = el("button", { type: "submit", class: "btn btn-primary btn-sm" }, "发送");

  const composerForm = el("form", { class: "chat-composer" },
    fileInput,
    refsStrip,
    selectedSkillsBar,
    inputEl,
    el("div", { class: "chat-composer-bar" },
      addRefBtn,
      chatModeSwitch,
      el("label", { class: "chat-model-chip" }, el("span", null, "文本"), textModelSel),
      el("label", { class: "chat-model-chip" }, el("span", null, "生图"), imageModelSel),
      ratioSel,
      el("div", { class: "chat-composer-right" }, pickSkillBtn, sendBtn)
    )
  );
  composerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    slashMenu.classList.add("hidden");
    sendCurrentInput(false);
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

  const mainPane = el("section", { class: "chat-main", "aria-label": "对话内容" },
    messagesBox,
    el("div", { class: "chat-composer-wrap" }, slashMenu, composerForm)
  );

  page.appendChild(el("div", { class: "chat-workspace" }, sidebar, mainPane));

  // ---------- Render Functions ----------
  function renderThreads() {
    clear(threadList);
    sessions.forEach((sess) => {
      const isAct = sess.id === activeId;
      const cnt = sess.data.messages.length;
      const sub = cnt > 0 ? `${cnt} 条消息 · ${fmtTime(sess.updatedAt)}` : "空会话";
      const row = el("div", {
        class: "chat-thread-item" + (isAct ? " is-active" : ""),
        role: "option",
        "aria-selected": String(isAct),
        onClick: () => {
          activeId = sess.id;
          syncModelPickers();
          renderAll();
        },
      },
        el("div", { class: "chat-thread-meta" },
          el("span", { class: "chat-thread-name", title: sess.name }, sess.name || "新会话"),
          el("span", { class: "chat-thread-sub" }, sub)
        ),
        sessions.length > 1
          ? el("button", {
              type: "button",
              class: "chat-thread-del",
              title: "删除会话",
              "aria-label": `删除会话 ${sess.name}`,
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
  }

  function openLightbox(im, run) {
    const body = el("div", { class: "col", style: { alignItems: "center", gap: "8px" } },
      el("img", { src: localImg(im.path), alt: run?.title || "", style: { maxWidth: "100%", maxHeight: "72vh", borderRadius: "8px" } }),
      el("div", { class: "muted mono", style: { fontSize: "12px" } }, `${im.path}${im.width ? ` (${im.width}×${im.height})` : ""}`)
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
              }, "📋 复制"),
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: () => {
                  if (!draftRefs.includes(im.path)) draftRefs = [...draftRefs, im.path];
                  renderDraftRefs();
                  toast("已设为参考图");
                },
              }, "🔁 垫图"),
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
                      title: run.title || im.theme || "会话生图灵感",
                      imagePath: im.path,
                      prompt: im.prompt || run.promptZh || run.promptEn || im.theme || run.originalRequest || "",
                      promptZh: run.promptZh || "",
                      source: "local",
                      runId: run.id,
                      recipe: rec,
                      suggestedStyle: rec.styleIds?.[0] || "",
                    });
                    btn.textContent = "★ 已收藏";
                    toast("已收进灵感库");
                  } catch (e) {
                    btn.disabled = false;
                    toast(e?.message || "收藏失败");
                  }
                },
              }, "★ 收藏"),
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: async () => {
                  let rec = {};
                  try { rec = typeof run.recipe === "string" ? JSON.parse(run.recipe) : (run.recipe || {}); } catch {}
                  try {
                    const saved = await api("POST", "/api/inspirations", {
                      title: run.title || im.theme || "会话生图灵感",
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
              }, "💎 赚积分"),
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: () => ctx.go("works", { openRun: run.id }),
              }, "☁ 发布")
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
        el("div", { class: "chat-empty-badge", "aria-hidden": "true" }, "💬"),
        el("h2", null, "手绘风 AI 会话工作台"),
        el("p", null, "像 Codex / DSH 一样自由对话：可随时切换文本模型与生图模型，在发送旁选择自定义 Skill，直接在聊天中生图、装 Skill 或安装插件。"),
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
      return;
    }

    sess.data.messages.forEach((msg) => {
      const wrap = el("article", { class: `chat-msg is-${msg.role}` });
      const bubble = el("div", { class: "chat-bubble" });

      if (msg.role === "user") {
        if (msg.skillNames?.length) {
          bubble.appendChild(el("div", { class: "row", style: { gap: "4px", flexWrap: "wrap", marginBottom: "4px" } },
            ...msg.skillNames.map((nm) => el("span", { class: "badge badge-accent" }, `⚡ ${nm}`))
          ));
        }
        if (msg.refs?.length) {
          bubble.appendChild(el("div", { class: "chat-msg-refs" },
            ...msg.refs.map((rp) => el("img", { src: localImg(rp), alt: "参考图" }))
          ));
        }
        bubble.appendChild(el("div", { style: { whiteSpace: "pre-wrap" } }, msg.content || ""));
      } else {
        if (msg.toolCalls?.length) {
          const allOk = msg.toolCalls.every((t) => t.ok);
          const det = el("details", { class: "chat-tool-trace", open: !allOk },
            el("summary", null,
              el("span", null, `🔧 执行了 ${msg.toolCalls.length} 项工具调用`),
              el("span", { class: allOk ? "chat-tool-ok" : "chat-tool-err" }, allOk ? "全部完成" : "部分异常")
            ),
            el("div", { class: "chat-tool-list" },
              ...msg.toolCalls.map((tc) => el("div", { class: "chat-tool-item" },
                el("span", { class: tc.ok ? "chat-tool-ok" : "chat-tool-err" }, tc.ok ? "✓" : "✕"),
                el("strong", null, tc.label || tc.name),
                el("span", { class: "muted" }, tc.summary || "")
              ))
            )
          );
          bubble.appendChild(det);
        }

        if (msg.content) {
          bubble.appendChild(renderMarkdown(msg.content));
        }

        if (msg.runs?.length) {
          bubble.appendChild(renderRunGrid(msg.runs));
        }

        if (msg.pendingConfirm) {
          const pc = msg.pendingConfirm;
          bubble.appendChild(el("div", { class: "chat-confirm-box" },
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

        const footItems = [];
        if (msg.textModel) footItems.push(el("span", { class: "mono" }, `文本: ${msg.textModel}`));
        if (msg.runs?.length && msg.imageModel) footItems.push(el("span", { class: "mono" }, `生图: ${msg.imageModel}`));
        if (msg.usedSkills?.length) {
          footItems.push(el("span", null, `Skills: ${msg.usedSkills.map((s) => s.name).join("、")}`));
        }
        if (msg.usage?.cache_read_tokens > 0) {
          footItems.push(el("span", { class: "badge badge-ok", title: "已命中中转站 Prompt Cache，显著节约输入 token 费用" }, `⚡ 缓存命中 ${msg.usage.cache_read_tokens} tok`));
        } else if (msg.usage?.total_tokens > 0) {
          footItems.push(el("span", { class: "mono" }, `${msg.usage.total_tokens} tok`));
        }
        if (footItems.length) {
          bubble.appendChild(el("div", { class: "chat-msg-foot" }, ...footItems));
        }
      }

      wrap.appendChild(bubble);
      messagesBox.appendChild(wrap);
    });

    if (isSending) {
      messagesBox.appendChild(el("article", { class: "chat-msg is-assistant" },
        el("div", { class: "chat-bubble" },
          el("div", { class: "row", style: { gap: "8px" } },
            el("span", { class: "dot-pulse" }),
            el("span", { class: "muted" }, "正在思考与执行工具…")
          )
        )
      ));
    }

    if (scrollToBottom) {
      messagesBox.scrollTop = messagesBox.scrollHeight;
    } else {
      messagesBox.scrollTop = prevScrollTop;
      if (mainScroller) mainScroller.scrollTop = prevMainScrollTop;
    }
  }

  function renderAll() {
    renderThreads();
    renderSelectedSkills();
    renderDraftRefs();
    renderMessages(true);
    sendBtn.disabled = isSending;
    sendBtn.textContent = isSending ? "处理中…" : "发送";
  }

  // ---------- Skill Picker Modal ----------
  async function reloadSkills() {
    const r = await api("GET", "/api/skills").catch(() => ({ items: [] }));
    skillsList = Array.isArray(r.items) ? r.items : [];
    renderSelectedSkills();
  }

  function setSkillInlineBtn(btn, state, label, pct = 0, titleText = "") {
    if (!btn) return;
    btn.classList.add("btn-update-inline");
    btn.dataset.state = state;
    btn.style.setProperty("--upd-pct", `${Math.max(0, Math.min(100, Number(pct || 0)))}%`);
    btn.disabled = state === "busy";
    btn.setAttribute("aria-busy", String(state === "busy"));
    if (titleText) btn.title = titleText;
    clear(btn);
    if (state === "busy") {
      btn.append(el("span", { class: "upd-spinner", "aria-hidden": "true" }), el("span", null, label));
    } else if (state === "done") {
      btn.append(el("span", { class: "upd-check", "aria-hidden": "true" }, "✓"), el("span", null, label));
    } else {
      btn.append(el("span", null, label));
    }
  }

  async function openSkillPickerModal() {
    await reloadSkills();
    const sess = activeSession();
    const searchIn = el("input", {
      class: "input",
      type: "search",
      placeholder: "筛选 Skill 名称、ID 或介绍…",
      "aria-label": "筛选 Skill",
    });
    const listWrap = el("div", { class: "chat-skill-picker-list" });
    const countLabel = el("span", { class: "muted", style: { fontSize: "12px" } }, "");

    const renderList = () => {
      clear(listWrap);
      const q = searchIn.value.trim().toLowerCase();
      const selectedSet = new Set(sess.data.skillIds || []);
      const filtered = skillsList.filter((sk) => {
        if (!q) return true;
        return `${sk.name} ${sk.id} ${sk.description || ""}`.toLowerCase().includes(q);
      });
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
          if (listWrap.isConnected) renderList();
          setSkillInlineBtn(checkAllBtn, "done", cnt > 0 ? `发现 ${cnt} 项更新` : "全部已是最新", 100);
          setTimeout(() => {
            if (checkAllBtn.isConnected) setSkillInlineBtn(checkAllBtn, "idle", "检查 Skill 更新", 0);
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

  // ---------- Send Turn ----------
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

  async function sendCurrentInput(confirmed) {
    if (isSending) return;
    const text = inputEl.value.trim();
    if (!text) return;
    const sess = activeSession();
    if (sess.data.messages.length === 0) {
      sess.name = text.replace(/^\/\S+\s*/, "").slice(0, 22) || "新会话";
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
  if (params.prompt) {
    inputEl.value = params.prompt;
    autoResize();
  }
  syncModelPickers();
  renderAll();
}
