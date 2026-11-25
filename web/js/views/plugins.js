import { api, clear, closeModal, el, openURL, showModal, toast } from "../api.js";
import { fallbackPluginIcon } from "../plugin-icons.js";
import {
  mirrorTag,
  openExtensionSubmitModal,
  pricingBadge,
  renderGalleriesMarketTab,
  renderObsidianMarketTab,
  renderSkillsHubTab,
} from "./plugins-channels.js";

const VALID_TABS = new Set(["plugins", "galleries", "skills", "obsidian"]);

const state = {
  tab: "plugins", // plugins | galleries | skills | obsidian
  pluginSubMode: "market", // market | installed | builtin (scoped inside plugins tab)
  mirror: "gitee", // gitee | github
  mirrorLoaded: false,
  marketCategory: "",
  marketQuery: "",
  onlyNotInstalled: false,
  checkingUpdates: false,
  updatingAll: false,
  busyIds: new Set(),
  lastCheck: null, // { at, outdatedCount, plugins: [] }
};

function formatCheckTime(ms) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatPublishDate(sec) {
  if (!sec) return "";
  const ms = sec > 1e12 ? sec : sec * 1000;
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return "";
  }
}

function shortSha(sha) {
  const s = String(sha || "").trim();
  return s.length > 7 ? s.slice(0, 7) : s;
}

function isRecentlyUpdated(instMeta) {
  if (!instMeta?.updatedAt) return false;
  return Date.now() - Number(instMeta.updatedAt) < 3 * 24 * 60 * 60 * 1000;
}

function iconURLForMarket(p, token) {
  const fb = fallbackPluginIcon(p);
  if (!p.icon) return { src: fb, fb };
  if (p.icon.startsWith("data:")) return { src: p.icon, fb };
  return {
    src: `/files/market-icon?url=${encodeURIComponent(p.icon)}&t=${encodeURIComponent(token || "")}`,
    fb,
  };
}

function makePluginIcon(src, fb, cls = "pm-logo-img") {
  return el("img", {
    src,
    alt: "",
    class: cls,
    onError: (ev) => {
      if (ev.currentTarget.dataset.fb) return;
      ev.currentTarget.dataset.fb = "1";
      ev.currentTarget.src = fb;
    },
  });
}

export async function renderPlugins(root, ctx, params = {}) {
  const hashQ = (location.hash.includes("?") ? new URLSearchParams(location.hash.split("?")[1]).get("tab") : "") || "";
  const reqTab = params.tab || hashQ;
  if (reqTab) {
    if (VALID_TABS.has(reqTab)) {
      state.tab = reqTab;
    } else if (reqTab === "installed") {
      state.tab = "plugins";
      state.pluginSubMode = "installed";
    } else if (reqTab === "builtin") {
      state.tab = "plugins";
      state.pluginSubMode = "builtin";
    } else {
      state.tab = "plugins";
      state.pluginSubMode = "market";
    }
  }
  if (!VALID_TABS.has(state.tab)) state.tab = "plugins";

  const [plugRes, skillsRes, obsRes, setRes] = await Promise.all([
    api("GET", "/api/plugins").catch(() => ({ builtin: [], community: [], dshStatus: {} })),
    api("GET", "/api/skills").catch(() => ({ items: [] })),
    api("GET", "/api/article/obsidian/plugins").catch(() => ({ plugins: [] })),
    state.mirrorLoaded ? Promise.resolve(null) : api("GET", "/api/settings").catch(() => null),
  ]);
  if (!root.isConnected) return;

  if (setRes?.settings?.preferredMarketMirror) {
    state.mirror = setRes.settings.preferredMarketMirror === "github" ? "github" : "gitee";
    state.mirrorLoaded = true;
  }

  if (plugRes.updates && (!state.lastCheck || (plugRes.updates.at || 0) >= (state.lastCheck.at || 0))) {
    state.lastCheck = plugRes.updates;
  }

  clear(root);

  const builtins = plugRes.builtin || [];
  const community = plugRes.community || [];
  const skillsList = skillsRes.items || [];
  const obsidianPlugins = obsRes.plugins || [];
  const dshStatus = plugRes.dshStatus || {};
  const dshRuntimeMap = new Map((dshStatus.plugins || []).map((p) => [p.id, p]));
  const permsMap = plugRes.knownPermissions || {};

  const checkMap = new Map(((state.lastCheck?.plugins) || []).map((x) => [x.id, x]));
  const outdatedCount = community.filter((c) => checkMap.get(c.id)?.status === "update").length;

  const switchGlobalMirror = async (nextMirror) => {
    if (state.mirror === nextMirror) return;
    state.mirror = nextMirror;
    state.mirrorLoaded = true;
    try {
      await api("PATCH", "/api/settings", { preferredMarketMirror: nextMirror });
      toast(nextMirror === "gitee" ? "已切换为 Gitee 国内镜像" : "已切换为 GitHub 官方原仓");
    } catch {}
    renderPlugins(root, ctx);
  };

  const mirrorSwitch = el("div", { class: "pm-mirror-switch", role: "group", "aria-label": "市场镜像" },
    el("button", {
      type: "button",
      class: "pm-seg-btn" + (state.mirror === "gitee" ? " is-active" : ""),
      onClick: () => switchGlobalMirror("gitee"),
    }, "Gitee 国内"),
    el("button", {
      type: "button",
      class: "pm-seg-btn" + (state.mirror === "github" ? " is-active" : ""),
      onClick: () => switchGlobalMirror("github"),
    }, "GitHub 原仓")
  );

  const tabs = [
    ["plugins", "工作台插件", outdatedCount],
    ["galleries", "图库插件", 0],
    ["skills", "Skills", 0],
    ["obsidian", "写作插件", 0],
  ];

  const tabBar = el("div", { class: "tabs", role: "tablist", "aria-label": "插件栏目" });
  tabs.forEach(([k, label, dotCount]) => {
    tabBar.appendChild(el("button", {
      type: "button",
      role: "tab",
      class: "tab" + (state.tab === k ? " active" : ""),
      dataset: { pluginTab: k },
      "aria-selected": String(state.tab === k),
      onClick: () => { state.tab = k; renderPlugins(root, ctx); },
    },
      el("span", null, label),
      dotCount > 0 ? el("span", { class: "pm-tab-dot", title: `${dotCount} 个插件可更新` }, String(dotCount)) : null
    ));
  });

  // Minimal single-row header: 4 category tabs on left, mirror switch on far right (no big H1/copy).
  root.appendChild(el("div", { class: "pm-hub-bar" }, tabBar, mirrorSwitch));

  const stage = el("div", { class: "col", style: { gap: "12px" } });
  root.appendChild(stage);

  // Warm update status in background once if installed plugins exist and no check snapshot yet.
  if (community.length > 0 && !state.lastCheck) {
    api("GET", "/api/plugins/updates")
      .then((res) => {
        if (!root.isConnected) return;
        state.lastCheck = { at: res.checkedAt, outdatedCount: res.count, plugins: res.plugins || [] };
        if (res.count > 0) {
          ctx.refreshNav?.();
          renderPlugins(root, ctx);
        }
      })
      .catch(() => {});
  }

  const buildDshDiscover = ({ idPrefix, buttonLabel, onImported } = {}) => {
    const panelId = `dsh-discover-${idPrefix || "panel"}`;
    const discoverBox = el("div", {
      id: panelId,
      class: "col",
      hidden: true,
      style: { gap: "6px", display: "none" },
    });
    const hide = (restoreFocus = false) => {
      discoverBox.hidden = true;
      discoverBox.style.display = "none";
      discoverBox.removeAttribute("aria-busy");
      scanBtn.setAttribute("aria-expanded", "false");
      if (restoreFocus) scanBtn.focus();
    };
    const scanBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      "aria-expanded": "false",
      "aria-controls": panelId,
      onClick: () => load(),
    }, buttonLabel || "扫描本机 DSH");

    const load = async () => {
      discoverBox.hidden = false;
      discoverBox.style.display = "flex";
      discoverBox.setAttribute("aria-busy", "true");
      scanBtn.setAttribute("aria-expanded", "true");
      clear(discoverBox);
      discoverBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "8px" } },
        el("span", { class: "muted" }, "正在扫描本机 ~/.dsh/profiles/desktop 插件…"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => hide(true) }, "收起")
      ));
      try {
        const res = await api("GET", "/api/plugins/dsh/discover");
        discoverBox.removeAttribute("aria-busy");
        clear(discoverBox);
        const items = res.items || [];
        discoverBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          el("span", { class: "muted", role: "status" }, items.length
            ? `已发现 ${items.length} 个本机 DSH 插件`
            : "未在本机 ~/.dsh/profiles/desktop 中发现可导入的 DSH 插件。"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => hide(true) }, "收起")
        ));
        if (!items.length) return;
        items.forEach((it) => {
          const badgeClass = it.compat === "full" ? "badge badge-ok" : (it.compat === "partial" ? "badge badge-warn" : "badge badge-err");
          const badgeText = it.compat === "full" ? "完全兼容" : (it.compat === "partial" ? "部分兼容" : "需完整 DSH");
          let actionEl;
          if (it.installed) {
            actionEl = el("span", { class: "badge" }, "已导入");
          } else {
            actionEl = el("button", {
              type: "button",
              class: "btn btn-sm btn-primary",
              disabled: it.compat === "unsupported",
              "aria-label": `导入 ${it.name}`,
              onClick: async () => {
                actionEl.disabled = true;
                actionEl.textContent = "导入中…";
                try {
                  await api("POST", "/api/plugins/install", { source: "link:" + it.dir });
                  toast(`已导入 DSH 插件「${it.name}」`);
                  if (onImported) await onImported(it);
                } catch (e) {
                  actionEl.disabled = it.compat === "unsupported";
                  actionEl.textContent = "导入";
                  toast(e.message);
                }
              },
            }, "导入");
          }
          discoverBox.appendChild(el("div", { class: "settings-subcard row", style: { justifyContent: "space-between", padding: "8px 10px", gap: "8px" } },
            el("div", { class: "col", style: { gap: "2px", minWidth: 0 } },
              el("div", { class: "row", style: { flexWrap: "wrap" } },
                el("strong", null, `${it.name} (${it.version || "dev"})`),
                el("span", { class: "badge" }, it.packageName),
                el("span", { class: badgeClass, title: (it.compatReasons || []).join("；") }, badgeText)
              ),
              el("span", { class: "muted mono", style: { fontSize: "11px" } }, it.dir)
            ),
            actionEl
          ));
        });
      } catch (e) {
        discoverBox.removeAttribute("aria-busy");
        clear(discoverBox);
        discoverBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "8px" } },
          el("span", { class: "muted", role: "status" }, "扫描失败：" + e.message),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => hide(true) }, "收起")
        ));
      }
    };

    return { button: scanBtn, box: discoverBox, load, hide };
  };

  const hubHelpers = {
    getMirror: () => state.mirror,
    switchTab: (nextTab) => { state.tab = nextTab; renderPlugins(root, ctx); },
    refreshHub: () => renderPlugins(root, ctx),
    makeSkeletonGrid,
  };

  if (state.tab === "plugins") {
    renderWorkbenchPluginsTab(stage, root, ctx, {
      community,
      builtins,
      dshRuntimeMap,
      permsMap,
      dshStatus,
      outdatedCount,
      buildDshDiscover,
    });
  } else if (state.tab === "galleries") {
    renderGalleriesMarketTab(stage, ctx, hubHelpers);
  } else if (state.tab === "skills") {
    renderSkillsHubTab(stage, root, ctx, skillsList, hubHelpers);
  } else if (state.tab === "obsidian") {
    renderObsidianMarketTab(stage, ctx, obsidianPlugins, hubHelpers);
  }
}

function makeSkeletonGrid(count = 6) {
  const grid = el("div", { class: "pm-grid", "aria-hidden": "true" });
  for (let i = 0; i < count; i++) {
    grid.appendChild(el("div", { class: "pm-card is-skeleton" },
      el("div", { class: "pm-card-top" },
        el("div", { class: "pm-sk pm-sk-ico" }),
        el("div", { class: "pm-card-who" },
          el("div", { class: "pm-sk pm-sk-title" }),
          el("div", { class: "pm-sk pm-sk-sub" })
        ),
        el("div", { class: "pm-sk pm-sk-btn" })
      ),
      el("div", { class: "pm-sk pm-sk-line" }),
      el("div", { class: "pm-sk pm-sk-line short" }),
      el("div", { class: "pm-card-meta" },
        el("div", { class: "pm-sk pm-sk-chip" }),
        el("div", { class: "pm-sk pm-sk-chip short" })
      )
    ));
  }
  return grid;
}

function renderWorkbenchPluginsTab(stage, root, ctx, bundle) {
  const { community, builtins, dshRuntimeMap, permsMap, dshStatus, outdatedCount, buildDshDiscover } = bundle;
  const enabledBuiltins = builtins.filter((b) => b.enabled).length;

  const subToggle = el("div", { class: "pm-seg-group", role: "tablist", "aria-label": "工作台插件视图" },
    el("button", {
      type: "button",
      class: "pm-seg-btn" + (state.pluginSubMode === "market" ? " is-active" : ""),
      onClick: () => { state.pluginSubMode = "market"; renderPlugins(root, ctx); },
    }, "市场"),
    el("button", {
      type: "button",
      class: "pm-seg-btn" + (state.pluginSubMode === "installed" ? " is-active" : ""),
      onClick: () => { state.pluginSubMode = "installed"; renderPlugins(root, ctx); },
    }, outdatedCount > 0 ? `已安装 (${community.length}) · ${outdatedCount} 更新` : `已安装 (${community.length})`),
    el("button", {
      type: "button",
      class: "pm-seg-btn" + (state.pluginSubMode === "builtin" ? " is-active" : ""),
      onClick: () => { state.pluginSubMode = "builtin"; renderPlugins(root, ctx); },
    }, `内置模块 (${enabledBuiltins}/${builtins.length})`)
  );

  if (state.pluginSubMode === "market") {
    renderMarketTab(stage, root, ctx, buildDshDiscover, subToggle);
    return;
  }

  // Installed or Builtin subview within Workbench Plugins
  const dshDiscover = buildDshDiscover({
    idPrefix: "installed",
    buttonLabel: "扫描本机 DSH",
    onImported: () => {
      state.lastCheck = null;
      ctx?.refreshNav?.();
      renderPlugins(root, ctx);
    },
  });

  stage.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
    el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
      subToggle,
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => openExtensionSubmitModal(ctx, { channel: "plugin" }),
        }, "＋ 申请收录"),
        state.pluginSubMode === "installed" ? dshDiscover.button : null
      )
    ),
    state.pluginSubMode === "installed" ? dshDiscover.box : null
  ));

  if (state.pluginSubMode === "builtin") {
    renderBuiltinTab(stage, ctx, builtins);
  } else {
    renderInstalledTab(stage, root, ctx, community, dshRuntimeMap, permsMap, dshStatus);
  }
}

function renderMarketTab(stage, root, ctx, buildDshDiscover, subToggle) {
  const sourcesRow = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } });
  const filterRow = el("div", { class: "pm-filter-bar" });
  const gridHost = el("div", { class: "col", style: { gap: "10px" } });
  let marketData = null;

  const installOrUpdateMarketPlugin = async (p, version) => {
    const busyKey = `mkt:${p.name}`;
    if (state.busyIds.has(busyKey)) return;
    state.busyIds.add(busyKey);
    paint();
    try {
      await api("POST", "/api/plugins/market/install", {
        sourceId: p.sourceId,
        name: p.name,
        version: version || p.latestVersion,
        enable: true,
      });
      state.lastCheck = null;
      ctx.refreshNav?.();
      toast(p.installed ? `已更新「${p.title || p.name}」到 v${version || p.latestVersion}` : `已安装并启用「${p.title || p.name}」`);
      closeModal();
      await loadMarket(false);
    } catch (e) {
      toast(e.message || "操作失败");
    } finally {
      state.busyIds.delete(busyKey);
      if (stage.isConnected) paint();
    }
  };

  const openDetailModal = (p, labelsMap, catsMap) => {
    const { src, fb } = iconURLForMarket(p, ctx.token);
    const busyKey = `mkt:${p.name}`;
    const isBusy = state.busyIds.has(busyKey);
    const hasUp = Boolean(p.updateAvailable);

    const facts = el("div", { class: "pm-facts" },
      el("div", { class: "pm-fact" },
        el("span", { class: "pm-fact-k" }, "最新版本"),
        el("span", { class: "pm-fact-v mono" }, `v${p.latestVersion}${p.latestCommit ? ` (${p.latestCommit})` : ""}`)
      ),
      el("div", { class: "pm-fact" },
        el("span", { class: "pm-fact-k" }, "当前状态"),
        el("span", { class: "pm-fact-v mono" }, p.installed ? `已安装 v${p.installedVersion || "?"}` : "未安装")
      ),
      el("div", { class: "pm-fact" },
        el("span", { class: "pm-fact-k" }, "安装方式"),
        el("span", { class: "pm-fact-v" }, p.installType === "npm" ? "npm 包" : "Git 仓库")
      ),
      el("div", { class: "pm-fact" },
        el("span", { class: "pm-fact-k" }, "来源市场"),
        el("span", { class: "pm-fact-v" }, p.sourceName || p.sourceId)
      )
    );

    const links = el("div", { class: "row", style: { flexWrap: "wrap", gap: "8px" } });
    if (p.homepage) {
      links.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => openURL(p.homepage),
      }, "🌐 主页"));
    }
    if (p.repositoryUrl && p.repositoryUrl !== p.homepage) {
      links.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => openURL(p.repositoryUrl),
      }, "📦 源码仓库"));
    }

    const versionRows = (p.versions || []).slice(0, 5).map((v, idx) =>
      el("div", { class: "pm-ver-row" },
        el("div", { class: "row", style: { gap: "6px" } },
          el("span", { class: "mono", style: { fontWeight: idx === 0 ? "700" : "500" } }, `v${v.version}`),
          v.source?.commit ? el("span", { class: "muted mono", style: { fontSize: "11px" } }, shortSha(v.source.commit)) : null,
          idx === 0 ? el("span", { class: "badge badge-accent" }, "最新") : null
        ),
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, formatPublishDate(v.publishTimestamp))
      )
    );

    const chips = [];
    (p.labels || []).forEach((lk) => {
      const cls = lk === "official" ? "badge badge-accent" : (lk === "handraw-verified" ? "badge badge-ok" : "badge");
      chips.push(el("span", { class: cls }, labelsMap[lk] || lk));
    });
    (p.categories || []).forEach((ck) => {
      chips.push(el("span", { class: "badge" }, catsMap[ck] || ck));
    });

    const body = el("div", { class: "col", style: { gap: "14px" } },
      el("div", { class: "row", style: { gap: "12px", alignItems: "center" } },
        el("div", { class: "pm-logo big" }, makePluginIcon(src, fb)),
        el("div", { class: "col", style: { gap: "4px", minWidth: 0, flex: "1" } },
          el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
            el("strong", { style: { fontSize: "15px" } }, p.title || p.name),
            ...chips
          ),
          el("span", { class: "muted mono", style: { fontSize: "12px" } }, `${p.author ? `作者：${p.author} · ` : ""}${p.name}`)
        )
      ),
      el("p", { style: { margin: 0, fontSize: "13px", lineHeight: "1.6", color: "var(--ink)" } }, p.description || "暂无简介"),
      facts,
      links.childNodes.length ? links : null,
      versionRows.length
        ? el("div", { class: "col", style: { gap: "6px" } },
            el("span", { class: "muted", style: { fontSize: "12px", fontWeight: "600" } }, "发布版本"),
            el("div", { class: "pm-ver-list" }, ...versionRows)
          )
        : null
    );

    const footerBtns = [];
    if (p.installed && p.enabled && p.installedId) {
      footerBtns.push(el("button", {
        type: "button",
        class: "btn",
        onClick: () => { closeModal(); ctx.go(`dsh:${p.installedId}`); },
      }, "打开插件"));
    }
    if (!p.installed || hasUp) {
      const modalActBtn = el("button", {
        type: "button",
        class: "btn btn-primary",
        disabled: isBusy,
        onClick: async () => {
          modalActBtn.disabled = true;
          modalActBtn.textContent = hasUp ? "更新中…" : "安装中…";
          await installOrUpdateMarketPlugin(p, p.latestVersion);
          if (modalActBtn.isConnected) {
            modalActBtn.disabled = false;
            modalActBtn.textContent = hasUp ? `更新到 v${p.latestVersion}` : "安装并启用";
          }
        },
      }, isBusy ? (hasUp ? "更新中…" : "安装中…") : (hasUp ? `更新到 v${p.latestVersion}` : "安装并启用"));
      footerBtns.push(modalActBtn);
    } else {
      footerBtns.push(el("button", { type: "button", class: "btn", disabled: true }, "已安装最新"));
    }
    footerBtns.push(el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"));

    showModal(p.title || p.name, body, footerBtns);
  };

  const openAddMarketDialog = () => {
    const urlIn = el("input", { class: "input", placeholder: "https://.../index.json（DSH Format 1 标准）", style: { width: "100%" } });
    const nameIn = el("input", { class: "input", placeholder: "显示名称（可选）", style: { width: "100%" } });
    const body = el("div", { class: "col", style: { gap: "8px" } }, urlIn, nameIn);
    showModal("添加工作台插件市场源", body, [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          if (!urlIn.value.trim()) return toast("请填写市场源 URL");
          try {
            await api("POST", "/api/plugins/market/sources", { url: urlIn.value.trim(), name: nameIn.value.trim() });
            closeModal();
            toast("已添加插件市场源");
            loadMarket(true);
          } catch (e) { toast(e.message); }
        },
      }, "添加"),
    ]);
  };

  const searchBox = el("input", {
    class: "input pm-search-input",
    type: "search",
    value: state.marketQuery,
    placeholder: "搜索工作台插件…",
    "aria-label": "搜索工作台插件",
  });
  searchBox.addEventListener("input", () => {
    state.marketQuery = searchBox.value;
    paint();
  });

  const paint = () => {
    clear(sourcesRow);
    clear(filterRow);
    clear(gridHost);
    if (!marketData) {
      gridHost.appendChild(makeSkeletonGrid(6));
      return;
    }

    (marketData.sources || []).forEach((src) => {
      const mTag = mirrorTag(src.activeMirror);
      sourcesRow.appendChild(el("span", { class: "badge" + (src.official ? " badge-accent" : ""), title: src.activeUrl || src.url },
        src.name || src.id,
        src.error ? "（连接失败）" : `${mTag ? " · " + mTag : ""}${src.count ? " · " + src.count : ""}`,
        !src.official ? el("button", {
          type: "button",
          style: { border: 0, background: "transparent", cursor: "pointer", marginLeft: "4px", padding: "0 2px", color: "inherit" },
          title: "移除市场源",
          onClick: async () => {
            try {
              await api("DELETE", `/api/plugins/market/sources/${encodeURIComponent(src.id)}`);
              toast("已移除市场源");
              loadMarket(true);
            } catch (e) { toast(e.message); }
          },
        }, "×") : null
      ));
    });

    (marketData.errors || []).forEach((er) => {
      gridHost.appendChild(el("div", { class: "card", style: { borderColor: "var(--accent)" } },
        el("span", { class: "muted" }, `市场源「${er.name || er.sourceId}」拉取失败：${er.error}`)
      ));
    });

    const allPlugins = marketData.plugins || [];
    const cats = marketData.categories || {};
    const labelsMap = marketData.labels || {};

    const catBar = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", alignItems: "center" } }, subToggle);
    const addCat = (key, label) => {
      catBar.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm" + (state.marketCategory === key ? " btn-primary" : ""),
        onClick: () => { state.marketCategory = key; paint(); },
      }, label));
    };
    addCat("", `全部 (${allPlugins.length})`);
    Object.entries(cats).forEach(([k, label]) => {
      const n = allPlugins.filter((p) => (p.categories || []).includes(k)).length;
      if (n > 0) addCat(k, `${label || k} (${n})`);
    });

    const notInstChk = el("input", { type: "checkbox", checked: state.onlyNotInstalled });
    notInstChk.addEventListener("change", () => {
      state.onlyNotInstalled = notInstChk.checked;
      paint();
    });
    const rightFilters = el("div", { class: "row", style: { gap: "10px", flexWrap: "wrap" } },
      el("label", { class: "pm-toggle-inline" }, notInstChk, el("span", null, "仅看未安装")),
      searchBox
    );
    filterRow.append(catBar, rightFilters);

    const q = state.marketQuery.trim().toLowerCase();
    const list = allPlugins.filter((p) => {
      if (state.marketCategory && !(p.categories || []).includes(state.marketCategory)) return false;
      if (state.onlyNotInstalled && p.installed) return false;
      if (!q) return true;
      return `${p.name} ${p.title} ${p.description} ${p.author}`.toLowerCase().includes(q);
    });

    if (!list.length) {
      gridHost.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "28px 16px" } }, "暂无匹配的插件。"));
      return;
    }

    const grid = el("div", { class: "pm-grid" });
    list.forEach((p) => {
      const { src, fb } = iconURLForMarket(p, ctx.token);
      const busyKey = `mkt:${p.name}`;
      const isBusy = state.busyIds.has(busyKey);
      const hasUp = Boolean(p.updateAvailable);

      let actBtn;
      if (isBusy) {
        actBtn = el("button", { type: "button", class: "pm-act busy", disabled: true },
          el("span", { class: "pm-spin", "aria-hidden": "true" }),
          el("span", null, hasUp ? "更新中" : "安装中")
        );
      } else if (hasUp) {
        actBtn = el("button", {
          type: "button",
          class: "pm-act pm-up",
          title: p.updateReason === "new_commits" ? "检测到新提交，点击更新" : `从 v${p.installedVersion} 更新到 v${p.latestVersion}`,
          onClick: (ev) => { ev.stopPropagation(); installOrUpdateMarketPlugin(p, p.latestVersion); },
        }, "更新");
      } else if (p.installed && p.enabled && p.installedId) {
        actBtn = el("button", {
          type: "button",
          class: "pm-act done",
          title: "打开插件工作区",
          onClick: (ev) => { ev.stopPropagation(); ctx.go(`dsh:${p.installedId}`); },
        }, "打开");
      } else if (p.installed) {
        actBtn = el("button", {
          type: "button",
          class: "pm-act done",
          title: "查看已安装管理",
          onClick: (ev) => { ev.stopPropagation(); state.pluginSubMode = "installed"; renderPlugins(root, ctx); },
        }, "已安装");
      } else {
        actBtn = el("button", {
          type: "button",
          class: "pm-act get",
          onClick: (ev) => { ev.stopPropagation(); installOrUpdateMarketPlugin(p, p.latestVersion); },
        }, "安装");
      }

      const isOfficial = (p.labels || []).includes("official");
      const isVerified = (p.labels || []).includes("handraw-verified");
      const byline = el("div", { class: "pm-card-by" },
        isOfficial
          ? el("span", { class: "pm-verified-tag", title: "官方维护" }, "✓ 官方维护")
          : (isVerified
            ? el("span", { class: "pm-verified-tag", title: "实测兼容" }, "✓ 实测兼容")
            : null),
        p.author ? el("span", { class: "pm-author-text" }, p.author) : el("span", { class: "pm-author-text mono" }, p.name)
      );

      const metaChips = [
        el("span", { class: "pm-ver mono" }, hasUp && p.installedVersion && p.installedVersion !== p.latestVersion
          ? `v${p.installedVersion} → v${p.latestVersion}`
          : `v${p.latestVersion}`),
      ];
      if (hasUp) {
        metaChips.push(el("span", { class: "pm-chip up" }, p.updateReason === "new_commits" ? "有新提交" : "可更新"));
      }
      if (p.installType) {
        metaChips.push(el("span", { class: "pm-chip soft" }, p.installType));
      }
      const pb = pricingBadge(p.pricing);
      if (pb) metaChips.push(pb);
      (p.categories || []).slice(0, 1).forEach((ck) => {
        metaChips.push(el("span", { class: "pm-chip" }, cats[ck] || ck));
      });

      const card = el("article", {
        class: "pm-card",
        tabindex: "0",
        role: "button",
        "aria-label": `${p.title || p.name}，点击查看详情`,
        onClick: () => openDetailModal(p, labelsMap, cats),
        onKeydown: (ev) => {
          if (ev.target === card && (ev.key === "Enter" || ev.key === " ")) {
            ev.preventDefault();
            openDetailModal(p, labelsMap, cats);
          }
        },
      },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo" }, makePluginIcon(src, fb)),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, p.title || p.name)),
            byline
          ),
          actBtn
        ),
        el("p", { class: "pm-card-desc", title: p.description || "" }, p.description || p.name),
        el("div", { class: "pm-card-meta" }, ...metaChips)
      );
      grid.appendChild(card);
    });
    gridHost.appendChild(grid);
  };

  const loadMarket = async (refresh = false) => {
    marketData = null;
    paint();
    try {
      marketData = await api("GET", `/api/plugins/market?mirror=${encodeURIComponent(state.mirror)}${refresh ? "&refresh=1" : ""}`);
      if (stage.isConnected) paint();
    } catch (e) {
      marketData = { sources: [], categories: {}, labels: {}, plugins: [], errors: [{ sourceId: "market", name: "插件市场", error: e.message }] };
      if (stage.isConnected) paint();
    }
  };

  const dshDiscover = buildDshDiscover({
    idPrefix: "market",
    buttonLabel: "扫描本机 DSH",
    onImported: async () => {
      state.lastCheck = null;
      ctx?.refreshNav?.();
      await dshDiscover.load();
      loadMarket(false);
    },
  });

  stage.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
    el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
      sourcesRow,
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openExtensionSubmitModal(ctx, { channel: "plugin" }) }, "＋ 申请收录"),
        dshDiscover.button,
        el("button", { type: "button", class: "btn btn-sm", onClick: openAddMarketDialog }, "+ 添加源"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => loadMarket(true) }, "↻ 刷新")
      )
    ),
    filterRow,
    dshDiscover.box
  ));
  stage.appendChild(gridHost);
  loadMarket(false);
}

function renderInstalledTab(stage, root, ctx, community, dshRuntimeMap, permsMap, dshStatus) {
  const checkMap = new Map(((state.lastCheck?.plugins) || []).map((x) => [x.id, x]));
  const outdated = community.filter((c) => checkMap.get(c.id)?.status === "update");

  const runCheckUpdates = async () => {
    if (state.checkingUpdates || state.updatingAll || state.busyIds.size > 0) return;
    state.checkingUpdates = true;
    renderPlugins(root, ctx);
    try {
      const res = await api("POST", "/api/plugins/check", {});
      state.lastCheck = { at: res.at, outdatedCount: res.outdatedCount, plugins: res.plugins || [] };
      const asked = (res.plugins || []).filter((x) => x.status !== "local");
      const ups = asked.filter((x) => x.status === "update").length;
      const unknown = asked.filter((x) => x.status === "unknown");
      ctx.refreshNav?.();
      if (ups > 0) {
        toast(`发现 ${ups} 个插件有新版本可用${unknown.length ? `（另有 ${unknown.length} 个检查失败）` : ""}`);
      } else if (unknown.length > 0 && unknown.length === asked.length) {
        toast(`检查更新失败：${unknown[0].error || "无法连接远端源"}`);
      } else if (unknown.length > 0) {
        toast(`已检查插件均为最新（${unknown.length} 个检查失败）`);
      } else {
        toast("所有插件均已是最新版本");
      }
    } catch (e) {
      toast("检查更新失败：" + e.message);
    } finally {
      state.checkingUpdates = false;
      if (root.isConnected) renderPlugins(root, ctx);
    }
  };

  const runUpdateSingle = async (c) => {
    if (state.busyIds.has(c.id) || state.updatingAll) return;
    state.busyIds.add(c.id);
    renderPlugins(root, ctx);
    try {
      const res = await api("POST", `/api/plugins/${encodeURIComponent(c.id)}/update`, {});
      if (res.updates) state.lastCheck = res.updates;
      ctx.refreshNav?.();
      toast(`已更新「${c.name}」到 v${res.plugin?.version || ""}`);
    } catch (e) {
      toast(`更新「${c.name}」失败：${e.message}`);
    } finally {
      state.busyIds.delete(c.id);
      if (root.isConnected) renderPlugins(root, ctx);
    }
  };

  const runUpdateAll = async () => {
    if (state.updatingAll || state.checkingUpdates || state.busyIds.size > 0) return;
    state.updatingAll = true;
    renderPlugins(root, ctx);
    try {
      const res = await api("POST", "/api/plugins/update", {});
      if (res.updates) state.lastCheck = res.updates;
      ctx.refreshNav?.();
      const okN = (res.updated || []).length;
      const failN = (res.failed || []).length;
      if (failN > 0) {
        toast(`已更新 ${okN} 个插件，${failN} 个失败：${res.failed[0]?.error || ""}`);
      } else if (okN > 0) {
        toast(`已全部更新 ${okN} 个插件`);
      } else {
        toast("当前没有可更新的插件");
      }
    } catch (e) {
      toast("批量更新失败：" + e.message);
    } finally {
      state.updatingAll = false;
      if (root.isConnected) renderPlugins(root, ctx);
    }
  };

  if (outdated.length > 0) {
    const names = outdated.map((c) => c.name || c.id).join("、");
    stage.appendChild(el("div", { class: "pm-updates-banner", role: "status" },
      el("span", { class: "pm-dot", "aria-hidden": "true" }),
      el("span", { class: "pm-updates-text" },
        outdated.length === 1
          ? `「${names}」有新版本可用`
          : `有 ${outdated.length} 个插件可更新：${names}`
      ),
      el("button", {
        type: "button",
        class: "pm-act pm-up",
        disabled: state.updatingAll || state.checkingUpdates || state.busyIds.size > 0,
        onClick: runUpdateAll,
      },
        state.updatingAll ? el("span", { class: "pm-spin", "aria-hidden": "true" }) : null,
        el("span", null, state.updatingAll ? "正在更新…" : `全部更新 (${outdated.length})`)
      )
    ));
  }

  // Manual install bar
  const srcIn = el("input", {
    id: "plugin-install-src",
    class: "input",
    style: { flex: "1", minWidth: "220px" },
    autocorrect: "off",
    autocapitalize: "none",
    spellcheck: "false",
    placeholder: "输入本地目录、Git 仓库（GitHub/Gitee）、npm:包名 或 .tar.gz / .zip 地址…",
  });

  stage.appendChild(el("div", { class: "card row", style: { flexWrap: "wrap", gap: "8px" } },
    srcIn,
    el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: async () => {
        try {
          const r = await api("POST", "/api/host/pick-directory", {});
          if (r?.path) srcIn.value = r.path;
        } catch (e) { toast(e.message); }
      },
    }, "选择目录"),
    el("button", {
      type: "button",
      class: "btn btn-sm btn-primary",
      onClick: async () => {
        if (!srcIn.value.trim()) return toast("请输入插件来源路径或网址");
        try {
          await api("POST", "/api/plugins/install", { source: srcIn.value.trim() });
          state.lastCheck = null;
          toast("插件已安装（请在下方开关中启用）");
          renderPlugins(root, ctx);
        } catch (e) { toast(e.message); }
      },
    }, "手动安装")
  ));

  if (!community.length) {
    stage.appendChild(el("div", { class: "card col", style: { gap: "8px", alignItems: "center", padding: "28px 16px" } },
      el("span", { class: "muted" }, "暂无已安装的工作台插件"),
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => { state.pluginSubMode = "market"; renderPlugins(root, ctx); } }, "浏览市场")
    ));
    return;
  }

  const listCard = el("div", { class: "pm-installed-list" });
  community.forEach((c) => {
    const isDSH = c.kind === "dsh";
    const rt = dshRuntimeMap.get(c.id);
    const ck = checkMap.get(c.id);
    const isUpdating = state.busyIds.has(c.id);
    const hasUpdate = ck?.status === "update";
    const instMeta = c.install || null;
    const commitShort = shortSha(instMeta?.commit);

    const chkId = `comm-${c.id}`;
    const chk = el("input", {
      id: chkId,
      type: "checkbox",
      checked: Boolean(c.enabled),
      disabled: (isDSH && c.dsh?.compat === "unsupported") || isUpdating || state.updatingAll,
    });
    chk.addEventListener("change", async () => {
      try {
        await api("PATCH", `/api/plugins/community:${encodeURIComponent(c.id)}`, { enabled: chk.checked });
        ctx.refreshNav?.();
        toast(chk.checked ? "插件已启用" : "插件已停用");
        renderPlugins(root, ctx);
      } catch (e) {
        chk.checked = !chk.checked;
        toast(e.message);
      }
    });

    const badges = [];
    if (c.version) badges.push(el("span", { class: "pm-ver mono" }, `v${c.version}`));
    if (commitShort) badges.push(el("span", { class: "pm-ver mono", title: `已安装提交 ${instMeta.commit}` }, commitShort));

    if (hasUpdate) {
      const label = ck.reason === "new_commits" ? "有新提交" : (ck.latestVersion ? `v${ck.latestVersion} 可更新` : "有更新");
      badges.push(el("span", { class: "pm-chip up" }, label));
    } else if (ck?.status === "unknown") {
      badges.push(el("span", { class: "pm-chip warn", title: ck.error || "暂不支持自动检查" }, "无法检查"));
    } else if (ck?.status === "local" || instMeta?.type === "local") {
      badges.push(el("span", { class: "pm-chip soft" }, "本地目录"));
    } else if (isRecentlyUpdated(instMeta)) {
      badges.push(el("span", { class: "pm-chip soft" }, "已更新"));
    } else if (ck?.status === "current") {
      badges.push(el("span", { class: "pm-chip soft" }, "已是最新"));
    }

    if (isDSH) {
      badges.push(el("span", { class: "badge badge-accent" }, "DSH · L2"));
      const cmp = c.dsh?.compat || "full";
      const cmpClass = cmp === "full" ? "badge badge-ok" : (cmp === "partial" ? "badge badge-warn" : "badge badge-err");
      const cmpLabel = cmp === "full" ? "完全兼容" : (cmp === "partial" ? "部分兼容" : "需完整 DSH");
      badges.push(el("span", { class: cmpClass, title: (c.dsh?.compatReasons || []).join("；") }, cmpLabel));
      if (rt?.error) badges.push(el("span", { class: "badge badge-err", title: rt.error }, "加载异常"));
    } else {
      (c.permissions || []).forEach((pm) => {
        badges.push(el("span", { class: "badge badge-warn", title: permsMap[pm] || pm }, pm));
      });
    }

    const subText = rt?.error
      ? `启动异常：${rt.error}`
      : (c.dsh?.compatReasons?.length ? `${c.description || c.dsh.packageName} · ${c.dsh.compatReasons.join("；")}` : (c.description || c.desc || c.author || c.source || ""));

    const plugIcon = el("div", { class: "pm-logo" }, makePluginIcon(fallbackPluginIcon(c), fallbackPluginIcon(c)));

    const updateBtn = hasUpdate || isUpdating
      ? el("button", {
          type: "button",
          class: "pm-act " + (isUpdating ? "busy" : "pm-up"),
          disabled: isUpdating || state.updatingAll || state.checkingUpdates,
          onClick: () => runUpdateSingle(c),
        },
          isUpdating ? el("span", { class: "pm-spin", "aria-hidden": "true" }) : null,
          el("span", null, isUpdating ? "更新中" : "更新")
        )
      : null;

    listCard.appendChild(el("div", { class: "pm-inst-row" + (!c.enabled ? " is-off" : "") },
      el("div", { class: "row", style: { gap: "11px", minWidth: 0, flex: "1", alignItems: "center" } },
        plugIcon,
        el("div", { class: "col", style: { gap: "3px", minWidth: 0, flex: "1" } },
          el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
            el("strong", { style: { fontSize: "13.5px" } }, c.name || c.id),
            ...badges
          ),
          el("span", { class: "muted", style: { fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: subText }, subText)
        )
      ),
      el("div", { class: "row", style: { gap: "6px", flexShrink: 0 } },
        updateBtn,
        isDSH && c.enabled && c.dsh?.clientEntry
          ? el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go(`dsh:${c.id}`) }, "打开")
          : null,
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => openExtensionSubmitModal(ctx, {
            channel: "plugin",
            prefill: {
              name: c.name || c.id,
              slug: c.id,
              repoUrl: /^https?:\/\/|^npm:/i.test(c.source || "") ? c.source : "",
              description: c.description || c.desc || "",
              authorName: c.author || "",
              version: c.version || "",
            },
          }),
        }, "申请收录"),
        el("label", { for: chkId, class: "row", style: { cursor: "pointer", fontSize: "12.5px" } }, chk, "启用"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          disabled: isUpdating || state.updatingAll,
          onClick: async () => {
            await api("DELETE", `/api/plugins/${encodeURIComponent(c.id)}`);
            state.lastCheck = null;
            ctx.refreshNav?.();
            renderPlugins(root, ctx);
            toast("已卸载插件");
          },
        }, "卸载")
      )
    ));
  });
  stage.appendChild(listCard);

  const canCheckAny = community.some((c) => c.install?.type !== "local");
  const footLeft = el("span", { class: "muted", style: { fontSize: "12px" } },
    [
      dshStatus?.nodeVersion ? `DSH 运行时 Node ${dshStatus.nodeVersion}` : "未检测到 Node.js（DSH 插件需 Node >= 20）",
      state.lastCheck?.at ? `上次检查更新：${formatCheckTime(state.lastCheck.at)}` : "",
    ].filter(Boolean).join(" · ")
  );
  const checkBtn = canCheckAny
    ? el("button", {
        type: "button",
        class: "btn btn-sm pm-check-btn",
        disabled: state.checkingUpdates || state.updatingAll || state.busyIds.size > 0,
        onClick: runCheckUpdates,
      },
        state.checkingUpdates ? el("span", { class: "pm-spin", "aria-hidden": "true" }) : null,
        el("span", null, state.checkingUpdates ? "正在检查更新…" : "↻ 检查更新")
      )
    : null;

  stage.appendChild(el("div", { class: "pm-installed-foot" }, footLeft, checkBtn));
}

function renderBuiltinTab(stage, ctx, builtins) {
  builtins.forEach((b) => {
    const chkId = `builtin-${b.id}`;
    const chk = el("input", { id: chkId, type: "checkbox", checked: b.enabled });
    const statusText = el("span", null, b.enabled ? "已开启" : "已关闭");
    chk.addEventListener("change", async () => {
      try {
        await api("PATCH", `/api/plugins/${encodeURIComponent(b.id)}`, { enabled: chk.checked });
        statusText.textContent = chk.checked ? "已开启" : "已关闭";
        ctx.refreshNav?.();
        toast(chk.checked ? `已启用「${b.name}」` : `已停用「${b.name}」`);
      } catch (e) {
        chk.checked = !chk.checked;
        toast(e.message);
      }
    });
    const row = el("div", { class: "card col", style: { gap: "8px" } },
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("div", { class: "col", style: { gap: "2px", minWidth: 0 } },
          el("strong", null, b.name),
          b.desc ? el("span", { class: "muted" }, b.desc) : null
        ),
        el("label", { for: chkId, class: "row", style: { cursor: "pointer" } }, chk, statusText)
      )
    );
    (b.settings || []).forEach((sf) => {
      const sfId = `plugin-cfg-${b.id}-${sf.key}`;
      const val = b.config?.[sf.key] ?? sf.default ?? "";
      let ctrl;
      if (sf.type === "enum" && Array.isArray(sf.enum)) {
        ctrl = el("select", { id: sfId, class: "select select-sm", style: { width: "auto" } }, ...sf.enum.map((opt) => el("option", { value: opt, selected: String(val) === opt }, opt)));
      } else {
        ctrl = el("input", { id: sfId, class: "input", style: { maxWidth: "200px" }, value: String(val) });
      }
      ctrl.addEventListener("change", async () => {
        await api("PATCH", `/api/plugins/${encodeURIComponent(b.id)}`, { config: { ...b.config, [sf.key]: ctrl.value } });
        toast("已更新模块配置");
      });
      row.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", paddingTop: "6px", borderTop: "1px dashed var(--line)" } },
        el("label", { for: sfId, class: "muted" }, sf.title || sf.key),
        ctrl
      ));
    });
    stage.appendChild(row);
  });
}
