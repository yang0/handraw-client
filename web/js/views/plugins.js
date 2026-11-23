import { api, clear, closeModal, el, showModal, toast } from "../api.js";

const state = {
  tab: "market", // market | installed | builtin
  marketCategory: "",
  marketQuery: "",
};

export async function renderPlugins(root, ctx, params = {}) {
  if (params.tab) state.tab = params.tab;
  const plugRes = await api("GET", "/api/plugins").catch(() => ({ builtin: [], community: [], dshStatus: {} }));
  if (!root.isConnected) return;
  clear(root);

  const builtins = plugRes.builtin || [];
  const community = plugRes.community || [];
  const enabledBuiltinsCount = builtins.filter((b) => b.enabled).length;
  const dshStatus = plugRes.dshStatus || {};
  const dshRuntimeMap = new Map((dshStatus.plugins || []).map((p) => [p.id, p]));
  const permsMap = plugRes.knownPermissions || {};

  const dshNodeBadge = dshStatus.nodeVersion
    ? el("span", { class: "badge" + (dshStatus.running ? " badge-ok" : "") },
      dshStatus.running
        ? `DSH 兼容运行时运行中 · Node ${dshStatus.nodeVersion}`
        : `DSH 兼容就绪 · Node ${dshStatus.nodeVersion}（按需启动）`)
    : el("span", { class: "badge badge-warn" }, "未检测到 Node.js（启用 DSH 插件需要 Node >= 20）");

  const tabs = [
    ["market", "官方插件市场"],
    ["installed", `已安装与扩展 (${community.length})`],
    ["builtin", `内置模块 (${enabledBuiltinsCount}/${builtins.length})`],
  ];

  const tabBar = el("div", { class: "tabs", role: "tablist", "aria-label": "插件分类" });
  tabs.forEach(([k, label]) => {
    tabBar.appendChild(el("button", {
      type: "button",
      role: "tab",
      class: "tab" + (state.tab === k ? " active" : ""),
      dataset: { pluginTab: k },
      "aria-selected": String(state.tab === k),
      onClick: () => { state.tab = k; renderPlugins(root, ctx); },
    }, label));
  });

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "col", style: { gap: "4px" } },
      el("div", { class: "row", style: { gap: "10px", flexWrap: "wrap" } },
        el("h1", { class: "page-title" }, "插件"),
        dshNodeBadge
      ),
      el("span", { class: "muted" }, "探索官方与 DSH 兼容插件市场、导入本地扩展或按需开关工作区内置模块")
    ),
    tabBar
  ));

  const stage = el("div", { class: "col", style: { gap: "12px" } });
  root.appendChild(stage);

  if (state.tab === "market") {
    renderMarketTab(stage, root, ctx);
  } else if (state.tab === "installed") {
    renderInstalledTab(stage, root, ctx, community, dshRuntimeMap, permsMap);
  } else {
    renderBuiltinTab(stage, ctx, builtins);
  }
}

function renderMarketTab(stage, root, ctx) {
  const sourcesRow = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } });
  const filterRow = el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } });
  const listWrap = el("div", { class: "col", style: { gap: "8px" } });
  let marketData = null;

  const openAddMarketDialog = () => {
    const urlIn = el("input", { class: "input", placeholder: "https://.../index.json（DSH Format 1 标准）", style: { width: "100%" } });
    const nameIn = el("input", { class: "input", placeholder: "显示名称（可留空，自动读取索引标题）", style: { width: "100%" } });
    const body = el("div", { class: "col", style: { gap: "8px" } },
      el("span", { class: "muted" }, "输入任意兼容 DeepSeek Harness Format 1 的插件市场 index.json 网址："),
      urlIn,
      nameIn
    );
    showModal("添加插件市场源", body, [
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

  const paint = () => {
    clear(sourcesRow);
    clear(filterRow);
    clear(listWrap);
    if (!marketData) {
      listWrap.appendChild(el("div", { class: "card muted" }, "正在加载插件市场…"));
      return;
    }

    (marketData.sources || []).forEach((src) => {
      sourcesRow.appendChild(el("span", { class: "badge" + (src.official ? " badge-accent" : ""), title: src.url },
        src.name || src.id,
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
      listWrap.appendChild(el("div", { class: "card", style: { borderColor: "var(--accent)" } },
        el("span", { class: "muted" }, `市场源「${er.name || er.sourceId}」拉取失败：${er.error}`)
      ));
    });

    const cats = marketData.categories || {};
    const catBar = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } });
    const addCat = (key, label) => {
      catBar.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm" + (state.marketCategory === key ? " btn-primary" : ""),
        onClick: () => { state.marketCategory = key; paint(); },
      }, label));
    };
    addCat("", `全部 (${(marketData.plugins || []).length})`);
    Object.entries(cats).forEach(([k, label]) => addCat(k, label || k));

    const searchBox = el("input", {
      class: "input",
      type: "search",
      value: state.marketQuery,
      placeholder: "搜索市场插件…",
      style: { width: "220px" },
    });
    searchBox.addEventListener("input", () => { state.marketQuery = searchBox.value; paint(); });
    filterRow.appendChild(catBar);
    filterRow.appendChild(searchBox);

    const q = state.marketQuery.trim().toLowerCase();
    const labelsMap = marketData.labels || {};
    const list = (marketData.plugins || []).filter((p) => {
      if (state.marketCategory && !(p.categories || []).includes(state.marketCategory)) return false;
      if (!q) return true;
      return `${p.name} ${p.title} ${p.description} ${p.author}`.toLowerCase().includes(q);
    });
    if (!list.length) {
      listWrap.appendChild(el("div", { class: "card muted" }, "当前筛选下暂无插件。"));
      return;
    }

    list.forEach((p) => {
      const iconUrl = p.icon
        ? (p.icon.startsWith("data:") ? p.icon : `/files/market-icon?url=${encodeURIComponent(p.icon)}&t=${encodeURIComponent(ctx.token || "")}`)
        : "";
      const iconNode = iconUrl
        ? el("img", {
          src: iconUrl,
          alt: "",
          style: { width: "40px", height: "40px", borderRadius: "10px", objectFit: "contain", flex: "none", background: "var(--paper)", border: "1px solid var(--line)" },
          onError: (ev) => { ev.currentTarget.style.display = "none"; },
        })
        : el("span", { style: { width: "40px", height: "40px", borderRadius: "10px", display: "grid", placeItems: "center", background: "var(--paper)", border: "1px solid var(--line)", flex: "none" } }, "🧩");

      const badges = [el("span", { class: "badge" }, `v${p.latestVersion}`)];
      if (p.installType) badges.push(el("span", { class: "badge" }, p.installType));
      (p.labels || []).forEach((lk) => {
        const cls = lk === "official" ? "badge badge-accent" : (lk === "handraw-verified" ? "badge badge-ok" : "badge");
        badges.push(el("span", { class: cls }, labelsMap[lk] || lk));
      });

      const actionBtn = el("button", {
        type: "button",
        class: "btn btn-sm" + (!p.installed || p.updateAvailable ? " btn-primary" : ""),
        disabled: p.installed && !p.updateAvailable,
        onClick: async () => {
          actionBtn.disabled = true;
          const prevText = actionBtn.textContent;
          actionBtn.textContent = "安装中…";
          try {
            await api("POST", "/api/plugins/market/install", {
              sourceId: p.sourceId,
              name: p.name,
              version: p.latestVersion,
              enable: true,
            });
            ctx.refreshNav?.();
            toast(`已安装并启用「${p.title}」`);
            renderPlugins(root, ctx);
          } catch (e) {
            actionBtn.disabled = false;
            actionBtn.textContent = prevText;
            toast(e.message);
          }
        },
      }, p.updateAvailable ? `更新到 v${p.latestVersion}` : (p.installed ? "已安装" : "安装并启用"));

      listWrap.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" } },
        el("div", { class: "row", style: { gap: "12px", flex: "1", minWidth: "240px", alignItems: "flex-start" } },
          iconNode,
          el("div", { class: "col", style: { gap: "4px", minWidth: 0 } },
            el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
              el("strong", null, p.title || p.name),
              ...badges
            ),
            el("span", { class: "muted" }, p.description || p.name),
            p.author ? el("span", { class: "muted", style: { fontSize: "12px" } }, `作者：${p.author} · ${p.name}`) : null
          )
        ),
        el("div", { class: "row", style: { gap: "6px" } },
          p.installed && p.enabled && p.installedId
            ? el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go(`dsh:${p.installedId}`) }, "打开")
            : null,
          actionBtn
        )
      ));
    });
  };

  const loadMarket = async (refresh = false) => {
    marketData = null;
    paint();
    try {
      marketData = await api("GET", `/api/plugins/market${refresh ? "?refresh=1" : ""}`);
      if (stage.isConnected) paint();
    } catch (e) {
      marketData = { sources: [], categories: {}, labels: {}, plugins: [], errors: [{ sourceId: "market", name: "插件市场", error: e.message }] };
      if (stage.isConnected) paint();
    }
  };

  stage.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
    el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } },
      el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
        el("strong", null, "已订阅市场源"),
        sourcesRow
      ),
      el("div", { class: "row", style: { gap: "6px" } },
        el("button", { type: "button", class: "btn btn-sm", onClick: openAddMarketDialog }, "+ 添加市场源"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => loadMarket(true) }, "刷新市场")
      )
    ),
    filterRow
  ));
  stage.appendChild(listWrap);
  loadMarket(false);
}

function renderInstalledTab(stage, root, ctx, community, dshRuntimeMap, permsMap) {
  const srcIn = el("input", {
    id: "plugin-install-src",
    class: "input",
    style: { flex: "1", minWidth: "220px" },
    autocorrect: "off",
    autocapitalize: "none",
    spellcheck: "false",
    placeholder: "输入本地目录、Git 仓库（GitHub/Gitee）、npm:包名 或 .tar.gz / .zip 地址…",
  });

  const discoverBox = el("div", { class: "col", style: { gap: "6px", display: "none" } });
  const loadDiscover = async () => {
    discoverBox.style.display = "flex";
    clear(discoverBox);
    discoverBox.appendChild(el("span", { class: "muted" }, "正在扫描本机 ~/.dsh/profiles/desktop 插件…"));
    try {
      const res = await api("GET", "/api/plugins/dsh/discover");
      clear(discoverBox);
      const items = res.items || [];
      if (!items.length) {
        discoverBox.appendChild(el("span", { class: "muted" }, "未在本机 ~/.dsh/profiles/desktop 中发现可导入的 DSH 插件。"));
        return;
      }
      items.forEach((it) => {
        const badgeClass = it.compat === "full" ? "badge badge-ok" : (it.compat === "partial" ? "badge badge-warn" : "badge badge-err");
        const badgeText = it.compat === "full" ? "完全兼容" : (it.compat === "partial" ? "部分兼容" : "需完整 DSH");
        discoverBox.appendChild(el("div", { class: "settings-subcard row", style: { justifyContent: "space-between", padding: "8px 10px" } },
          el("div", { class: "col", style: { gap: "2px", minWidth: 0 } },
            el("div", { class: "row", style: { flexWrap: "wrap" } },
              el("strong", null, `${it.name} (${it.version || "dev"})`),
              el("span", { class: "badge" }, it.packageName),
              el("span", { class: badgeClass, title: (it.compatReasons || []).join("；") }, badgeText)
            ),
            el("span", { class: "muted mono", style: { fontSize: "11px" } }, it.dir)
          ),
          it.installed
            ? el("span", { class: "badge" }, "已导入")
            : el("button", {
              type: "button",
              class: "btn btn-sm btn-primary",
              disabled: it.compat === "unsupported",
              onClick: async () => {
                try {
                  await api("POST", "/api/plugins/install", { source: "link:" + it.dir });
                  toast(`已导入 DSH 插件「${it.name}」`);
                  renderPlugins(root, ctx);
                } catch (e) { toast(e.message); }
              },
            }, "导入")
        ));
      });
    } catch (e) {
      clear(discoverBox);
      discoverBox.appendChild(el("span", { class: "muted" }, "扫描失败：" + e.message));
    }
  };

  stage.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
    el("strong", null, "手动安装或导入本地 DSH 插件"),
    el("div", { class: "row", style: { flexWrap: "wrap" } },
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
            toast("插件已安装（请在下方开关中启用）");
            renderPlugins(root, ctx);
          } catch (e) { toast(e.message); }
        },
      }, "安装插件"),
      el("button", { type: "button", class: "btn btn-sm", onClick: loadDiscover }, "扫描本机 DSH 插件")
    ),
    discoverBox
  ));

  if (!community.length) {
    stage.appendChild(el("div", { class: "card col", style: { gap: "8px", alignItems: "flex-start" } },
      el("strong", null, "尚未安装外部或 DSH 插件"),
      el("span", { class: "muted" }, "你可以前往「官方插件市场」一键安装，或点击上方「扫描本机 DSH 插件」直接导入已装好的 DSH 插件。"),
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => { state.tab = "market"; renderPlugins(root, ctx); } }, "去逛插件市场")
    ));
    return;
  }

  community.forEach((c) => {
    const isDSH = c.kind === "dsh";
    const rt = dshRuntimeMap.get(c.id);
    const chkId = `comm-${c.id}`;
    const chk = el("input", {
      id: chkId,
      type: "checkbox",
      checked: Boolean(c.enabled),
      disabled: isDSH && c.dsh?.compat === "unsupported",
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
    if (isDSH) {
      badges.push(el("span", { class: "badge badge-accent", title: "本地 Node 进程运行（L2 本机权限）" }, "DSH · L2"));
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
      : (c.dsh?.compatReasons?.length ? `${c.description || c.dsh.packageName} · ${c.dsh.compatReasons.join("；")}` : (c.description || c.desc || c.author || ""));

    stage.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } },
      el("div", { class: "col", style: { gap: "4px", minWidth: 0, flex: "1" } },
        el("div", { class: "row", style: { flexWrap: "wrap" } },
          el("strong", null, `${c.name} (${c.version || "dev"})`),
          ...badges
        ),
        el("span", { class: "muted" }, subText)
      ),
      el("div", { class: "row" },
        isDSH && c.enabled && c.dsh?.clientEntry
          ? el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go(`dsh:${c.id}`) }, "打开")
          : null,
        el("label", { for: chkId, class: "row", style: { cursor: "pointer" } }, chk, "启用"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          onClick: async () => {
            await api("DELETE", `/api/plugins/${encodeURIComponent(c.id)}`);
            ctx.refreshNav?.();
            renderPlugins(root, ctx);
            toast("已卸载插件");
          },
        }, "卸载")
      )
    ));
  });
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
