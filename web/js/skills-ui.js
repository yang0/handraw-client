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

export function buildTextModelSelect(modRes, currentVal) {
  const sel = el("select", { class: "select select-sm", "aria-label": "选择文本模型", style: { maxWidth: "210px" } });
  const optVals = [];

  const siteGroup = el("optgroup", { label: "手绘风官方文字服务" });
  const siteAI = modRes?.siteAI || {};
  const siteLabel = siteAI.textAvailable
    ? `官网智能文字服务${siteAI.textLabel ? " · " + siteAI.textLabel : ""}`
    : "官网智能文字服务（需登录）";
  siteGroup.appendChild(el("option", { value: "site:auto" }, siteLabel));
  optVals.push("site:auto");
  sel.appendChild(siteGroup);

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

  const preferred = currentVal || modRes?.defaultTextModel || "";
  if (preferred && optVals.includes(preferred)) {
    sel.value = preferred;
  } else if (optVals.length > 1 && !siteAI.textAvailable) {
    sel.value = optVals[1];
  } else {
    sel.value = optVals[0] || "site:auto";
  }
  return sel;
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
