import { api, clear, closeModal, el, showModal, toast } from "./api.js";

const CLIENT_LABELS = {
  antigravity: "Antigravity",
  claude: "Claude Code",
  codex: "Codex",
  dsh: "DeepSeek Harness",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  qwen: "Qwen Code",
  workbuddy: "WorkBuddy",
  codebuddy: "CodeBuddy",
  cline: "Cline",
  copilot: "GitHub Copilot",
  grok: "Grok Build",
  hermes: "Hermes Agent",
  pi: "Pi Agent",
  kimi: "Kimi Code",
  "agents-shared": "通用共享 (~/.agents)",
  custom: "自定义目录",
};

export function formatSkillSourceLabel(sk) {
  if (!sk) return "";
  if (sk.builtin) return "内置官方";
  const src = String(sk.source || "").trim();
  if (src.startsWith("harness:")) {
    const parts = src.split(":");
    const cid = parts[1] || "";
    return `来自 ${CLIENT_LABELS[cid] || cid || "本机客户端"}`;
  }
  if (src.startsWith("http://") || src.startsWith("https://")) return "远端链接";
  if (src.startsWith("upload:")) return "本地上传";
  if (src === "inline") return "手动创建";
  if (src) return "本地导入";
  return "";
}

export function buildTextModelSelect(modRes, currentVal, scene = "") {
  const sel = el("select", { class: "select select-sm", "aria-label": "选择文本模型", style: { maxWidth: "240px" } });
  const optVals = [];

  const siteGroup = el("optgroup", { label: "手绘风官方文字服务" });
  const siteAI = modRes?.siteAI || {};
  const siteAvailable = Array.isArray(siteAI) ? Boolean(modRes?.loggedIn) : Boolean(siteAI.textAvailable || modRes?.loggedIn);
  const siteLabel = siteAvailable
    ? `官网智能文字服务${siteAI.textLabel ? " · " + siteAI.textLabel : ""}`
    : "官网智能文字服务（需登录）";
  siteGroup.appendChild(el("option", { value: "site:auto" }, siteLabel));
  optVals.push("site:auto");
  sel.appendChild(siteGroup);

  const harnesses = Array.isArray(modRes?.harnesses) ? modRes.harnesses : [];
  const readyHarnesses = harnesses.filter((h) => h && h.available);
  if (readyHarnesses.length) {
    const hGrp = el("optgroup", { label: "本地 AI Harness（本机 CLI）" });
    readyHarnesses.forEach((h) => {
      const val = h.defaultRef || `harness:${h.id}`;
      const sub = h.model ? ` · ${h.model}` : "";
      hGrp.appendChild(el("option", { value: val }, `${h.name || h.id}${sub}`));
      optVals.push(val);
    });
    sel.appendChild(hGrp);
  }

  const textProviders = modRes?.textProviders || [];
  textProviders.forEach((p) => {
    const models = p.models || [];
    if (!models.length) return;
    const grp = el("optgroup", { label: p.name || p.id });
    models.forEach((m) => {
      const val = `${p.id}:${m.id}`;
      grp.appendChild(el("option", { value: val }, `${p.name || p.id} · ${m.label || m.id}`));
      optVals.push(val);
    });
    sel.appendChild(grp);
  });

  const sceneRef = scene ? (modRes?.sceneModels?.[scene] || "") : "";
  const preferred = currentVal || sceneRef || modRes?.defaultTextModel || "";
  const preferredBase = preferred.startsWith("harness:")
    ? `harness:${preferred.slice(8).split(":")[0]}`
    : preferred;
  if (preferredBase && !optVals.includes(preferredBase) && preferredBase.startsWith("harness:")) {
    const hid = preferredBase.slice(8).split(":")[0];
    const hit = harnesses.find((h) => h.id === hid);
    const g = el("optgroup", { label: "当前已选（暂不可用）" });
    g.appendChild(el("option", { value: preferredBase }, `${hit?.name || hid}（未检测或已停用）`));
    sel.appendChild(g);
    optVals.push(preferredBase);
  }
  if (preferredBase && optVals.includes(preferredBase)) {
    sel.value = preferredBase;
  } else if (optVals.length > 1 && !siteAvailable) {
    sel.value = optVals[1];
  } else {
    sel.value = optVals[0] || "site:auto";
  }
  return sel;
}

const harnessModelsClientCache = new Map(); // harnessId -> [{id, label}]

/**
 * Unified sleek Single-Pill + Two-Column Cascading Popover text/harness model picker (#139).
 * Replaces stacked double dropdowns across Article, Chat, Canvas, and Settings.
 * Exposes standard `.value` getter/setter and dispatches "change" on `picker.el`.
 */
export function createTextModelPicker(modRes, currentVal, scene = "", onChange = null, opts = {}) {
  const harnesses = Array.isArray(modRes?.harnesses) ? modRes.harnesses : [];
  const readyHarnesses = harnesses.filter((h) => h && h.available);
  const textProviders = Array.isArray(modRes?.textProviders) ? modRes.textProviders.filter((p) => (p?.models || []).length > 0) : [];
  const siteAI = modRes?.siteAI || {};
  const siteAvailable = Array.isArray(siteAI) ? Boolean(modRes?.loggedIn) : Boolean(siteAI.textAvailable || modRes?.loggedIn);
  const allowEmpty = Boolean(opts?.allowEmpty);
  const emptyLabel = String(opts?.emptyLabel || "跟随通用默认文字引擎");

  const sceneRef = scene ? (modRes?.sceneModels?.[scene] || "") : "";
  const resolveInitVal = () => {
    const raw = String(currentVal ?? "").trim();
    if (allowEmpty) return raw;
    const pref = raw || sceneRef || modRes?.defaultTextModel || "";
    if (pref) return pref;
    if (!siteAvailable && readyHarnesses.length) return readyHarnesses[0].defaultRef || `harness:${readyHarnesses[0].id}`;
    return "site:auto";
  };

  let value = resolveInitVal();

  const parseRef = (ref) => {
    const s = String(ref || "").trim();
    if (!s) return { kind: "empty", id: "", sub: "" };
    if (s === "site:auto" || s === "site:text" || s.startsWith("site:")) return { kind: "site", id: "site:auto", sub: "" };
    if (s.startsWith("harness:")) {
      const rest = s.slice(8);
      const idx = rest.indexOf(":");
      if (idx < 0) return { kind: "harness", id: rest.trim(), sub: "" };
      return { kind: "harness", id: rest.slice(0, idx).trim(), sub: rest.slice(idx + 1).trim() };
    }
    const colon = s.indexOf(":");
    if (colon > 0) return { kind: "provider", id: s.slice(0, colon), sub: s.slice(colon + 1) };
    return { kind: "custom", id: s, sub: "" };
  };

  const getHarnessModelLabel = (hid, subId) => {
    if (!subId) return "";
    const list = harnessModelsClientCache.get(hid) || harnesses.find((h) => h.id === hid)?.models || [];
    const hit = list.find((m) => m.id === subId);
    return hit?.label || subId;
  };

  const formatTriggerInfo = (ref) => {
    const p = parseRef(ref);
    if (p.kind === "empty") return { ico: "↻", text: emptyLabel, title: emptyLabel };
    if (p.kind === "site") {
      const lbl = siteAvailable ? "官网智能文字服务" : "官网智能文字服务（需登录）";
      return { ico: "✨", text: lbl, title: lbl };
    }
    if (p.kind === "harness") {
      const h = harnesses.find((x) => x.id === p.id);
      const hName = (h?.name || p.id).replace(/\s*\([^)]*\)\s*$/, "").trim() || (h?.name || p.id);
      const fullHName = h?.name || p.id;
      const subId = p.sub || h?.model || "";
      const subLbl = subId ? getHarnessModelLabel(p.id, subId) : "";
      const text = subLbl ? `${hName} · ${subLbl}` : fullHName;
      const suffix = h && !h.available ? "（暂不可用）" : "";
      return { ico: "⚡", text: text + suffix, title: `${fullHName}${subId ? " · " + subId : ""}${suffix}` };
    }
    if (p.kind === "provider") {
      const prov = textProviders.find((x) => x.id === p.id);
      const mod = prov?.models?.find((m) => m.id === p.sub);
      const mLbl = mod?.label || mod?.name || p.sub;
      const pName = prov?.name || p.id;
      return { ico: "🔌", text: `${pName} · ${mLbl}`, title: `${pName} · ${mLbl}` };
    }
    return { ico: "🤖", text: p.id, title: p.id };
  };

  const icoEl = el("span", { class: "hm-trigger-ico", "aria-hidden": "true" });
  const textEl = el("span", { class: "hm-trigger-text" });
  const caretEl = el("span", { class: "hm-trigger-caret", "aria-hidden": "true" }, "▾");
  const triggerBtn = el("button", {
    type: "button",
    class: "hm-trigger" + (opts?.className ? " " + opts.className : ""),
    "aria-haspopup": "listbox",
    "aria-expanded": "false",
    "aria-label": opts?.ariaLabel || "选择文本模型或本地 AI Harness",
  }, icoEl, textEl, caretEl);

  const wrap = el("div", { class: "hm-picker" }, triggerBtn);

  const syncTrigger = () => {
    const info = formatTriggerInfo(value);
    icoEl.textContent = info.ico;
    textEl.textContent = info.text;
    triggerBtn.title = info.title;
  };
  syncTrigger();

  let popEl = null;
  let popCleanup = null;
  let activeGroup = null; // { kind: "harness" | "provider", id: string }
  let filterQuery = "";
  let fetchSeq = 0;

  const closePopover = () => {
    if (popCleanup) { popCleanup(); popCleanup = null; }
    if (popEl && popEl.isConnected) popEl.remove();
    popEl = null;
    triggerBtn.setAttribute("aria-expanded", "false");
    triggerBtn.classList.remove("is-open");
  };

  const commitValue = (nextVal) => {
    const cleaned = String(nextVal ?? "").trim();
    const changed = cleaned !== value;
    value = cleaned;
    syncTrigger();
    closePopover();
    if (changed) {
      onChange?.(value);
      wrap.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const fetchHarnessModels = async (hid, force = false, onDone = null) => {
    if (!force && harnessModelsClientCache.has(hid)) {
      onDone?.(harnessModelsClientCache.get(hid));
      return;
    }
    const seq = ++fetchSeq;
    try {
      const q = force ? "?refresh=1" : "";
      const res = await api("GET", `/api/harnesses/${encodeURIComponent(hid)}/models${q}`);
      const live = Array.isArray(res?.models) ? res.models : [];
      if (live.length) harnessModelsClientCache.set(hid, live);
      if (seq === fetchSeq) {
        syncTrigger();
        onDone?.(live);
      }
    } catch {
      if (seq === fetchSeq) onDone?.(null);
    }
  };

  const openPopover = () => {
    if (popEl) { closePopover(); return; }
    const cur = parseRef(value);
    if (cur.kind === "harness" && readyHarnesses.some((h) => h.id === cur.id)) {
      activeGroup = { kind: "harness", id: cur.id };
    } else if (cur.kind === "provider" && textProviders.some((p) => p.id === cur.id)) {
      activeGroup = { kind: "provider", id: cur.id };
    } else if (readyHarnesses.length) {
      activeGroup = { kind: "harness", id: readyHarnesses[0].id };
    } else if (textProviders.length) {
      activeGroup = { kind: "provider", id: textProviders[0].id };
    } else {
      activeGroup = null;
    }
    filterQuery = "";

    const leftCol = el("div", { class: "hm-pop-left" });
    const rightCol = el("div", { class: "hm-pop-right" });
    popEl = el("div", { class: "hm-popover", role: "dialog", "aria-label": "选择 AI 模型" }, leftCol, rightCol);
    popEl.addEventListener("click", (e) => e.stopPropagation());

    const renderRight = (loading = false) => {
      clear(rightCol);
      if (!activeGroup) {
        rightCol.appendChild(el("div", { class: "hm-pop-empty muted" }, "暂无子模型，可在左侧选择官网服务，或到「设置 → 本地 Harness / 第三方接口」配置。"));
        return;
      }
      const curParsed = parseRef(value);

      if (activeGroup.kind === "harness") {
        const h = readyHarnesses.find((x) => x.id === activeGroup.id);
        if (!h) return;
        const models = harnessModelsClientCache.get(h.id) || h.models || [];
        const refreshBtn = el("button", {
          type: "button",
          class: "hm-pop-refresh",
          title: "重新扫描该 Harness 的实时模型列表",
          onClick: () => {
            refreshBtn.disabled = true;
            refreshBtn.textContent = "…";
            void fetchHarnessModels(h.id, true, () => {
              if (popEl && activeGroup?.kind === "harness" && activeGroup?.id === h.id) renderRight(false);
            });
          },
        }, "↻");
        rightCol.appendChild(el("div", { class: "hm-pop-rhead" },
          el("span", { class: "hm-pop-rtitle" }, `${h.name || h.id} · 模型`),
          loading ? el("span", { class: "muted", style: { fontSize: "11px" } }, "加载中…") : refreshBtn
        ));

        let searchIn = null;
        if (models.length > 5) {
          searchIn = el("input", {
            type: "search",
            class: "hm-pop-search",
            value: filterQuery,
            placeholder: `搜索 ${models.length} 个模型…`,
          });
          searchIn.addEventListener("input", () => {
            filterQuery = searchIn.value;
            paintModelRows();
          });
          rightCol.appendChild(searchIn);
        }

        const listBox = el("div", { class: "hm-model-list" });
        const paintModelRows = () => {
          clear(listBox);
          const q = filterQuery.trim().toLowerCase();
          const isDefaultSelected = curParsed.kind === "harness" && curParsed.id === h.id && !curParsed.sub;
          if (!q) {
            const defTitle = h.model ? `默认模型 (${h.model})` : "默认模型（由 CLI 自动决定）";
            listBox.appendChild(el("button", {
              type: "button",
              class: "hm-model-row" + (isDefaultSelected ? " is-selected" : ""),
              onClick: () => commitValue(`harness:${h.id}`),
            },
              el("span", { class: "hm-model-name" }, defTitle),
              isDefaultSelected ? el("span", { class: "hm-check" }, "✓") : null
            ));
          }
          const filtered = models.filter((m) => !q || `${m.id} ${m.label || ""}`.toLowerCase().includes(q));
          filtered.forEach((m) => {
            const selected = curParsed.kind === "harness" && curParsed.id === h.id && curParsed.sub === m.id;
            listBox.appendChild(el("button", {
              type: "button",
              class: "hm-model-row" + (selected ? " is-selected" : ""),
              title: m.id,
              onClick: () => commitValue(`harness:${h.id}:${m.id}`),
            },
              el("span", { class: "hm-model-main" },
                el("span", { class: "hm-model-name" }, m.label || m.id),
                m.label && m.label !== m.id ? el("span", { class: "hm-model-id mono" }, m.id) : null
              ),
              selected ? el("span", { class: "hm-check" }, "✓") : null
            ));
          });
          if (!filtered.length && q) {
            listBox.appendChild(el("div", { class: "hm-pop-empty muted" }, "没有匹配的模型，可在下方直接输入自定义模型 ID"));
          }
        };
        paintModelRows();
        rightCol.appendChild(listBox);

        const customIn = el("input", {
          type: "text",
          class: "hm-pop-custom-in",
          placeholder: "自定义模型 ID…",
          value: curParsed.kind === "harness" && curParsed.id === h.id && curParsed.sub && !models.some((m) => m.id === curParsed.sub) ? curParsed.sub : "",
        });
        const applyCustom = () => {
          const cid = customIn.value.trim();
          if (cid) commitValue(`harness:${h.id}:${cid}`);
        };
        customIn.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); applyCustom(); }
        });
        rightCol.appendChild(el("div", { class: "hm-pop-custom-foot" },
          customIn,
          el("button", { type: "button", class: "btn btn-sm", onClick: applyCustom }, "使用")
        ));
      } else if (activeGroup.kind === "provider") {
        const prov = textProviders.find((x) => x.id === activeGroup.id);
        if (!prov) return;
        const models = prov.models || [];
        rightCol.appendChild(el("div", { class: "hm-pop-rhead" },
          el("span", { class: "hm-pop-rtitle" }, `${prov.name || prov.id} · 模型`)
        ));
        const listBox = el("div", { class: "hm-model-list" });
        models.forEach((m) => {
          const ref = `${prov.id}:${m.id}`;
          const selected = value === ref;
          listBox.appendChild(el("button", {
            type: "button",
            class: "hm-model-row" + (selected ? " is-selected" : ""),
            title: m.id,
            onClick: () => commitValue(ref),
          },
            el("span", { class: "hm-model-main" },
              el("span", { class: "hm-model-name" }, m.label || m.name || m.id),
              (m.label || m.name) && (m.label || m.name) !== m.id ? el("span", { class: "hm-model-id mono" }, m.id) : null
            ),
            selected ? el("span", { class: "hm-check" }, "✓") : null
          ));
        });
        rightCol.appendChild(listBox);
      }
    };

    const selectActiveGroup = (nextGroup) => {
      if (activeGroup?.kind === nextGroup.kind && activeGroup?.id === nextGroup.id) return;
      activeGroup = nextGroup;
      filterQuery = "";
      renderLeft();
      if (nextGroup.kind === "harness" && !harnessModelsClientCache.has(nextGroup.id)) {
        renderRight(true);
        void fetchHarnessModels(nextGroup.id, false, () => {
          if (popEl && activeGroup?.kind === "harness" && activeGroup?.id === nextGroup.id) renderRight(false);
        });
      } else {
        renderRight(false);
      }
    };

    const renderLeft = () => {
      clear(leftCol);
      const curParsed = parseRef(value);

      if (allowEmpty) {
        const isSel = curParsed.kind === "empty";
        leftCol.appendChild(el("button", {
          type: "button",
          class: "hm-eng-row" + (isSel ? " is-selected" : ""),
          onClick: () => commitValue(""),
        },
          el("span", { class: "hm-eng-ico" }, "↻"),
          el("span", { class: "hm-eng-name" }, emptyLabel),
          isSel ? el("span", { class: "hm-check" }, "✓") : null
        ));
      }

      const isSiteSel = curParsed.kind === "site";
      leftCol.appendChild(el("button", {
        type: "button",
        class: "hm-eng-row" + (isSiteSel ? " is-selected" : ""),
        onClick: () => commitValue("site:auto"),
      },
        el("span", { class: "hm-eng-ico" }, "✨"),
        el("span", { class: "hm-eng-name" }, siteAvailable ? "官网智能文字服务" : "官网文字服务（需登录）"),
        isSiteSel ? el("span", { class: "hm-check" }, "✓") : null
      ));

      if (readyHarnesses.length) {
        leftCol.appendChild(el("div", { class: "hm-eng-sec" }, "本地 AI Harness"));
        readyHarnesses.forEach((h) => {
          const isCur = curParsed.kind === "harness" && curParsed.id === h.id;
          const isActive = activeGroup?.kind === "harness" && activeGroup?.id === h.id;
          leftCol.appendChild(el("button", {
            type: "button",
            class: "hm-eng-row" + (isActive ? " is-active" : "") + (isCur ? " is-selected" : ""),
            onMouseEnter: () => selectActiveGroup({ kind: "harness", id: h.id }),
            onClick: () => selectActiveGroup({ kind: "harness", id: h.id }),
          },
            el("span", { class: "hm-eng-ico" }, "⚡"),
            el("span", { class: "hm-eng-name" }, h.name || h.id),
            isCur ? el("span", { class: "hm-dot", title: "当前使用" }) : null,
            el("span", { class: "hm-chev" }, "›")
          ));
        });
      }

      if (textProviders.length) {
        leftCol.appendChild(el("div", { class: "hm-eng-sec" }, "第三方接口"));
        textProviders.forEach((p) => {
          const isCur = curParsed.kind === "provider" && curParsed.id === p.id;
          const isActive = activeGroup?.kind === "provider" && activeGroup?.id === p.id;
          leftCol.appendChild(el("button", {
            type: "button",
            class: "hm-eng-row" + (isActive ? " is-active" : "") + (isCur ? " is-selected" : ""),
            onMouseEnter: () => selectActiveGroup({ kind: "provider", id: p.id }),
            onClick: () => selectActiveGroup({ kind: "provider", id: p.id }),
          },
            el("span", { class: "hm-eng-ico" }, "🔌"),
            el("span", { class: "hm-eng-name" }, p.name || p.id),
            isCur ? el("span", { class: "hm-dot", title: "当前使用" }) : null,
            el("span", { class: "hm-chev" }, "›")
          ));
        });
      }
    };

    renderLeft();
    const needsInitialFetch = activeGroup?.kind === "harness" && !harnessModelsClientCache.has(activeGroup.id);
    renderRight(needsInitialFetch);
    if (needsInitialFetch) {
      const hid = activeGroup.id;
      void fetchHarnessModels(hid, false, () => {
        if (popEl && activeGroup?.kind === "harness" && activeGroup?.id === hid) renderRight(false);
      });
    }

    const hostContainer = triggerBtn.closest("dialog") || document.body;
    popEl.style.visibility = "hidden";
    hostContainer.appendChild(popEl);

    const rect = triggerBtn.getBoundingClientRect();
    const pw = popEl.offsetWidth || 444;
    const ph = popEl.offsetHeight || 340;
    let left = rect.right - pw;
    if (left < 10) left = Math.max(10, Math.min(rect.left, window.innerWidth - pw - 10));
    let top = rect.bottom + 6;
    if (top + ph > window.innerHeight - 10 && rect.top - ph - 6 > 10) {
      top = rect.top - ph - 6;
    } else if (top + ph > window.innerHeight - 10) {
      top = Math.max(10, window.innerHeight - ph - 10);
    }
    popEl.style.left = `${Math.round(left)}px`;
    popEl.style.top = `${Math.round(top)}px`;
    popEl.style.visibility = "visible";

    triggerBtn.setAttribute("aria-expanded", "true");
    triggerBtn.classList.add("is-open");

    const onDown = (e) => {
      if (popEl && !popEl.contains(e.target) && !wrap.contains(e.target)) closePopover();
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closePopover(); }
    };
    const onResize = () => closePopover();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    popCleanup = () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  };

  triggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopover();
  });

  // Pre-warm label cache silently if current value already uses a harness sub-model
  const initParsed = parseRef(value);
  if (initParsed.kind === "harness" && initParsed.sub && !harnessModelsClientCache.has(initParsed.id)) {
    void fetchHarnessModels(initParsed.id, false);
  }

  const getValue = () => value;
  const setValue = (v) => {
    value = String(v ?? "").trim();
    syncTrigger();
  };
  const getDisplayLabel = () => formatTriggerInfo(value).text;

  Object.defineProperty(wrap, "value", {
    get: getValue,
    set: setValue,
    configurable: true,
  });

  return {
    el: wrap,
    triggerBtn,
    getValue,
    setValue,
    getDisplayLabel,
    close: closePopover,
  };
}

/**
 * Opens the Magpie-inspired Local AI Harness Skill Discovery & Selective Import modal.
 */
export function openHarnessSkillImportModal({ onImported, onClose } = {}) {
  let discovery = null;
  let activeClient = "";
  let query = "";
  let extraDir = "";
  let loading = true;
  let importing = false;
  const selectedDirs = new Map(); // dir -> { dir, clientId, clientName, name }

  const summaryEl = el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } });
  const clientChipsEl = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } });
  const searchIn = el("input", {
    type: "search",
    class: "input",
    placeholder: "搜索发现的 Skill 名称、简介或客户端…",
    "aria-label": "搜索发现的 Skill",
    style: { flex: "1", minWidth: "180px" },
  });
  const bulkBar = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
  const listWrap = el("div", { class: "sk-discover-list" });
  const importBtn = el("button", { type: "button", class: "btn btn-primary", disabled: true }, "导入选中 Skill");

  const getFilteredSkills = () => {
    if (!discovery) return [];
    const clients = discovery.clients || [];
    let all = [];
    clients.forEach((c) => {
      if (activeClient && c.id !== activeClient) return;
      (c.skills || []).forEach((sk) => all.push(sk));
    });
    const q = query.trim().toLowerCase();
    if (q) {
      all = all.filter((sk) => `${sk.name} ${sk.id} ${sk.description} ${sk.clientName}`.toLowerCase().includes(q));
    }
    return all;
  };

  const syncImportBtn = () => {
    const n = selectedDirs.size;
    importBtn.disabled = importing || n === 0;
    importBtn.textContent = importing
      ? "正在导入…"
      : (n > 0 ? `导入选中的 ${n} 个 Skill` : "请勾选要导入的 Skill");
  };

  const paint = () => {
    clear(summaryEl);
    clear(clientChipsEl);
    clear(bulkBar);
    clear(listWrap);

    if (loading) {
      summaryEl.appendChild(el("span", { class: "muted" }, "正在自动扫描本机已安装的 AI Harness 客户端（Claude Code / Codex / Antigravity / Cursor / DSH 等）…"));
      listWrap.appendChild(el("div", { class: "sk-discover-empty muted" }, "扫描中…"));
      syncImportBtn();
      return;
    }

    const clients = discovery?.clients || [];
    const withSkills = clients.filter((c) => (c.skills || []).length > 0);
    const totalSkills = discovery?.totalSkills || 0;

    summaryEl.append(
      el("span", { class: "muted", style: { fontSize: "12.5px" } },
        `已检测到 ${clients.length} 个本机 AI 客户端，共发现 ${totalSkills} 个 Skill（导入后可在聊天、文章和插件中统一调用）`
      ),
      el("div", { class: "row", style: { gap: "6px" } },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => {
            try {
              const r = await api("POST", "/api/host/pick-directory", {});
              if (r?.path) {
                extraDir = r.path;
                await scan();
              }
            } catch {
              const p = window.prompt("请输入存放 Skill 文件夹的本地路径：", extraDir || "");
              if (p && p.trim()) {
                extraDir = p.trim();
                await scan();
              }
            }
          },
        }, "📁 扫描指定目录"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => scan() }, "↻ 重新扫描")
      )
    );

    const addClientChip = (cid, label) => {
      clientChipsEl.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm" + (activeClient === cid ? " btn-primary" : ""),
        onClick: () => { activeClient = cid; paint(); },
      }, label));
    };
    addClientChip("", `全部 (${totalSkills})`);
    withSkills.forEach((c) => addClientChip(c.id, `${c.name} (${c.skillCount})`));

    const visible = getFilteredSkills();
    const unimportedVisible = visible.filter((sk) => !sk.installed);

    bulkBar.append(
      el("button", {
        type: "button",
        class: "btn btn-sm",
        disabled: unimportedVisible.length === 0,
        onClick: () => {
          unimportedVisible.forEach((sk) => selectedDirs.set(sk.dir, sk));
          paint();
        },
      }, `全选未导入 (${unimportedVisible.length})`),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        disabled: selectedDirs.size === 0,
        onClick: () => {
          selectedDirs.clear();
          paint();
        },
      }, "清空勾选")
    );

    if (!visible.length) {
      listWrap.appendChild(el("div", { class: "sk-discover-empty muted" },
        totalSkills === 0
          ? "未在本机常见 AI 客户端中发现 SKILL.md，可点击右上角「📁 扫描指定目录」手动选择。"
          : "当前筛选下没有匹配的 Skill。"
      ));
      syncImportBtn();
      return;
    }

    visible.forEach((sk) => {
      const checked = selectedDirs.has(sk.dir);
      const chk = el("input", {
        type: "checkbox",
        checked,
        disabled: importing,
      });
      const toggle = () => {
        if (importing) return;
        if (selectedDirs.has(sk.dir)) selectedDirs.delete(sk.dir);
        else selectedDirs.set(sk.dir, sk);
        paint();
      };
      chk.addEventListener("change", toggle);

      const row = el("label", {
        class: "sk-discover-row" + (checked ? " is-checked" : "") + (sk.installed ? " is-installed" : ""),
        title: sk.dir,
      },
        chk,
        el("div", { class: "sk-discover-meta" },
          el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
            el("strong", { style: { fontSize: "13px" } }, sk.name || sk.id),
            el("span", { class: "badge" }, sk.clientName),
            sk.version ? el("span", { class: "muted mono", style: { fontSize: "11px" } }, `v${sk.version}`) : null,
            sk.installed ? el("span", { class: "badge badge-ok", title: "已导入到手绘风（勾选可覆盖刷新）" }, "已导入") : null
          ),
          el("span", { class: "sk-discover-desc muted" }, sk.description || sk.dir)
        )
      );
      listWrap.appendChild(row);
    });

    syncImportBtn();
  };

  const scan = async () => {
    loading = true;
    paint();
    try {
      const qs = extraDir ? `?extraDir=${encodeURIComponent(extraDir)}` : "";
      discovery = await api("GET", `/api/skills/discover${qs}`);
    } catch (e) {
      discovery = { clients: [], totalClients: 0, totalSkills: 0 };
      toast("扫描本机客户端失败：" + e.message);
    } finally {
      loading = false;
      if (listWrap.isConnected) paint();
    }
  };

  searchIn.addEventListener("input", () => {
    query = searchIn.value;
    paint();
  });

  importBtn.addEventListener("click", async () => {
    if (importing || selectedDirs.size === 0) return;
    importing = true;
    syncImportBtn();
    try {
      const items = Array.from(selectedDirs.values()).map((sk) => ({
        dir: sk.dir,
        clientId: sk.clientId,
        clientName: sk.clientName,
      }));
      const res = await api("POST", "/api/skills/import-local", { items });
      const okN = (res.imported || []).length;
      const failN = (res.failed || []).length;
      selectedDirs.clear();
      if (failN > 0) {
        toast(`已导入 ${okN} 个 Skill，${failN} 个失败：${res.failed[0]?.error || ""}`);
      } else {
        toast(`已导入 ${okN} 个 Skill，可在聊天、文章和插件中直接调用`);
      }
      if (onImported) await onImported(res);
      closeModal();
    } catch (e) {
      toast("导入失败：" + e.message);
    } finally {
      importing = false;
      if (importBtn.isConnected) syncImportBtn();
    }
  });

  showModal("从本机 AI 客户端导入 Skill", el("div", { class: "col", style: { gap: "10px" } },
    summaryEl,
    clientChipsEl,
    el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, searchIn, bulkBar),
    listWrap
  ), [
    el("button", {
      type: "button",
      class: "btn",
      onClick: () => {
        closeModal();
        onClose?.();
      },
    }, "取消"),
    importBtn,
  ]);

  scan();
}

/**
 * Shared searchable Skill picker modal (used by Article AI Edit Bar & reusable anywhere).
 */
export async function openSharedSkillPickerModal({
  title = "选择 Skill",
  selectedIds = [],
  onChange,
  onSkillsUpdated,
} = {}) {
  let skillsList = [];
  const chosen = new Set(selectedIds);

  const reload = async () => {
    const res = await api("GET", "/api/skills").catch(() => ({ items: [] }));
    skillsList = (res.items || []).filter((sk) => sk.enabled !== false);
  };
  await reload();

  const searchIn = el("input", {
    type: "search",
    class: "input",
    placeholder: "筛选已安装 Skill 名称、ID 或简介…",
    "aria-label": "筛选 Skill",
  });
  const countLabel = el("div", { class: "muted", style: { fontSize: "12px" } });
  const listWrap = el("div", { class: "sk-discover-list" });

  const renderList = () => {
    clear(listWrap);
    const q = searchIn.value.trim().toLowerCase();
    const filtered = skillsList.filter((sk) =>
      !q || `${sk.name} ${sk.id} ${sk.description || ""}`.toLowerCase().includes(q)
    );
    countLabel.textContent = `已选 ${chosen.size} 项 · 共 ${filtered.length} 个可用 Skill`;

    if (!filtered.length) {
      listWrap.appendChild(el("div", { class: "sk-discover-empty muted" },
        skillsList.length === 0
          ? "暂无已安装 Skill，点击下方「从本机 AI 客户端导入」即可一键引入。"
          : "没有匹配的 Skill。"
      ));
      return;
    }

    filtered.forEach((sk) => {
      const isSel = chosen.has(sk.id);
      const srcLabel = formatSkillSourceLabel(sk);
      const row = el("button", {
        type: "button",
        class: "sk-pick-item" + (isSel ? " is-selected" : ""),
        "data-skill-id": sk.id,
        onClick: () => {
          if (chosen.has(sk.id)) chosen.delete(sk.id);
          else chosen.add(sk.id);
          onChange?.(Array.from(chosen), skillsList);
          renderList();
        },
      },
        el("div", { class: "sk-pick-main" },
          el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
            el("strong", { style: { fontSize: "13px" } }, sk.name || sk.id),
            el("span", { class: "muted mono", style: { fontSize: "11px" } }, `/${sk.id}`),
            srcLabel ? el("span", { class: "badge" + (sk.builtin ? " badge-accent" : "") }, srcLabel) : null
          ),
          el("span", { class: "sk-discover-desc muted" }, sk.description || "无简介")
        ),
        el("span", { class: "sk-pick-check" }, isSel ? "✓ 已选" : "选择")
      );
      listWrap.appendChild(row);
    });
  };

  searchIn.addEventListener("input", renderList);
  renderList();

  showModal(title, el("div", { class: "col", style: { gap: "10px" } },
    searchIn,
    countLabel,
    listWrap
  ), [
    el("button", {
      type: "button",
      class: "btn",
      style: { marginRight: "auto" },
      onClick: () => {
        closeModal();
        openHarnessSkillImportModal({
          onImported: async () => {
            await reload();
            onSkillsUpdated?.(skillsList);
            // Re-open picker so user can immediately select the newly imported skills!
            openSharedSkillPickerModal({
              title,
              selectedIds: Array.from(chosen),
              onChange,
              onSkillsUpdated,
            });
          },
        });
      },
    }, "📥 从本机 AI 客户端导入"),
    el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "完成"),
  ]);
  searchIn.focus();
}
