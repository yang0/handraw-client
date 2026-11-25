import { api, clear, closeModal, el, getToken, openURL, showModal, toast } from "../api.js";
import { CM6_SINGLETON_MODULES } from "./article-live.js";
import { openArticleContextMenu, sanitizeSvgElement } from "./article-links.js";

function compatBadge(compat) {
  const lvl = compat?.level || "full";
  if (lvl === "unsupported") return el("span", { class: "badge ic-obs-badge-bad" }, "🔴 暂不兼容");
  if (lvl === "partial") return el("span", { class: "badge ic-obs-badge-warn" }, "🟡 部分兼容");
  return el("span", { class: "badge ic-obs-badge-ok" }, "🟢 完整兼容");
}

function cm6Badge(compat, activeCount = 0) {
  if (activeCount > 0) {
    return el("span", {
      class: "badge ic-obs-badge-cm6",
      title: `已实时热注入 ${activeCount} 个 CodeMirror 6 编辑器扩展`,
    }, `⚡ CM6 已接入 (${activeCount})`);
  }
  if (compat?.hasCM6) {
    return el("span", {
      class: "badge ic-obs-badge-cm6",
      title: "支持 CodeMirror 6 编辑器扩展实时注入",
    }, "⚡ CM6 实时扩展");
  }
  return null;
}

function sourceLabel(meta) {
  const t = meta?.sourceType || "";
  if (t === "market") return "社区市场";
  if (t === "github") return "GitHub";
  if (t === "obsidian-vault") return "Obsidian 导入";
  if (t === "zip") return "ZIP 导入";
  if (t === "local") return "本地目录";
  return "";
}

function formatDownloads(n) {
  const num = Number(n || 0);
  if (!num) return "";
  if (num >= 10000) return `${(num / 10000).toFixed(1)} 万下载`;
  return `${num.toLocaleString()} 下载`;
}

function currentThemeName() {
  const cs = document.querySelector('meta[name="color-scheme"]')?.content || "";
  if (cs === "dark") return "dark";
  if (cs === "light") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function createArticleObsidianController(opts) {
  const state = {
    dir: "",
    env: null,
    plugins: [],
    commands: [],
    ribbons: [],
    settingsTabs: [],
    runtimeErrors: new Map(),
    cm6Counts: new Map(),
    cm6Errors: new Map(),
    modalOpen: false,
    viewCount: 0,
    activeViewTitle: "",
    hostReady: false,
    hostAttachedTo: "standby", // standby | drawer | modal
  };

  let nextCallId = 1;
  const pendingCmds = new Map();
  const pluginCm6Map = new Map(); // pluginId -> { extensions: [], stylesCss: "" }
  const mainStyleEls = new Map(); // pluginId -> <style>
  let disposed = false;

  function syncMainCm6Styles() {
    for (const [pid, styleEl] of mainStyleEls.entries()) {
      const rec = pluginCm6Map.get(pid);
      if (!rec || !rec.stylesCss) {
        styleEl.remove();
        mainStyleEls.delete(pid);
      }
    }
    for (const [pid, rec] of pluginCm6Map.entries()) {
      if (!rec.stylesCss) continue;
      let styleEl = mainStyleEls.get(pid);
      if (!styleEl || !styleEl.isConnected) {
        styleEl = document.createElement("style");
        styleEl.dataset.obsCm6Style = pid;
        document.head.appendChild(styleEl);
        mainStyleEls.set(pid, styleEl);
      }
      if (styleEl.textContent !== rec.stylesCss) {
        styleEl.textContent = rec.stylesCss;
      }
    }
  }

  function syncPluginCm6Extensions() {
    const entries = Array.from(pluginCm6Map.entries()).map(([pluginId, rec]) => ({
      pluginId,
      extensions: rec.extensions,
    }));
    const res = opts.setPluginExtensions?.(entries) || { appliedCounts: new Map(), errors: new Map() };
    state.cm6Counts = res.appliedCounts instanceof Map ? res.appliedCounts : new Map();
    state.cm6Errors = res.errors instanceof Map ? res.errors : new Map();
    syncMainCm6Styles();
    opts.onStateChange?.();
    return res;
  }

  function getObsHost() {
    try {
      return iframe.contentWindow?.__HANDRAW_OBS_HOST__ || null;
    } catch {
      return null;
    }
  }

  function mapObsidianMenuItems(sessionId, rawItems) {
    const out = [];
    for (const it of rawItems || []) {
      if (!it) continue;
      if (it.sep) {
        if (out.length && !out[out.length - 1].sep) out.push({ sep: true });
        continue;
      }
      if (it.isLabel) {
        out.push({ header: it.title || "" });
        continue;
      }
      const children = Array.isArray(it.submenu) && it.submenu.length
        ? mapObsidianMenuItems(sessionId, it.submenu)
        : undefined;
      out.push({
        iconSvg: it.svgHtml || "",
        icon: it.svgHtml ? "" : "🧩",
        label: it.title || "",
        checked: Boolean(it.checked),
        disabled: Boolean(it.disabled),
        warning: Boolean(it.warning),
        children,
        onClick: (clickEv) => {
          const host = getObsHost();
          host?.invokeContextMenuItem?.(sessionId, it.id, clickEv?.clientX, clickEv?.clientY);
        },
      });
    }
    while (out.length && out[out.length - 1].sep) out.pop();
    return out;
  }

  function collectContextMenu(eventName, ctx = {}) {
    if (disposed || !state.hostReady) return [];
    const host = getObsHost();
    if (!host?.collectContextMenu) return [];
    try {
      const res = host.collectContextMenu(eventName, { ...ctx, doc: opts.getDoc?.() });
      if (!res?.items?.length) return [];
      return mapObsidianMenuItems(res.sessionId, res.items);
    } catch (err) {
      console.warn(`[article-obsidian] collectContextMenu(${eventName}) failed:`, err);
      return [];
    }
  }

  // Expose live CodeMirror 6 singleton & menu popup bridge for same-origin plugin host (#131, #133).
  const cm6Bridge = {
    modules: CM6_SINGLETON_MODULES,
    getEditorView: () => opts.getEditorView?.() || null,
    setPluginExtensions: (pluginId, extensions, stylesCss = "") => {
      if (!pluginId || disposed) return null;
      const list = Array.isArray(extensions) ? extensions.filter(Boolean) : (extensions ? [extensions] : []);
      if (list.length) {
        pluginCm6Map.set(pluginId, { extensions: list, stylesCss: String(stylesCss || "") });
      } else {
        pluginCm6Map.delete(pluginId);
      }
      return syncPluginCm6Extensions();
    },
    clearPluginExtensions: (pluginId) => {
      if (!pluginId) return;
      if (pluginCm6Map.delete(pluginId)) {
        syncPluginCm6Extensions();
      }
    },
    openPopupMenu: (x, y, sessionId, rawItems) => {
      if (disposed) return;
      const items = mapObsidianMenuItems(sessionId, rawItems);
      if (!items.length) return;
      openArticleContextMenu({ clientX: x, clientY: y }, items);
    },
    // Synchronous cached existence probe for trusted desktop plugins calling fs.existsSync() (#134)
    checkFsExistsSync: (() => {
      const cache = new Map(); // key -> { ok, ts }
      return (pluginId, filePath) => {
        if (disposed || !pluginId || !filePath) return false;
        const key = `${pluginId}\0${String(filePath)}`;
        const now = Date.now();
        const hit = cache.get(key);
        if (hit && now - hit.ts < 3000) return hit.ok;
        try {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/article/obsidian/desktop/fs", false);
          xhr.setRequestHeader("Content-Type", "application/json");
          const tok = getToken();
          if (tok) xhr.setRequestHeader("X-Handraw-Token", tok);
          xhr.send(JSON.stringify({ pluginId, req: { op: "access", path: String(filePath) } }));
          const ok = xhr.status >= 200 && xhr.status < 300 && Boolean(JSON.parse(xhr.responseText || "{}").exists);
          cache.set(key, { ok, ts: now });
          if (cache.size > 200) cache.clear();
          return ok;
        } catch {
          return false;
        }
      };
    })(),
  };
  window.__HANDRAW_CM6_BRIDGE__ = cm6Bridge;

  // Obsidian-style slim left Ribbon Rail for direct 1-click plugin icons (#133)
  const ribbonRailEl = el("nav", {
    class: "ic-obs-ribbon-rail hidden",
    "aria-label": "Obsidian 插件快捷图标栏",
  });
  let ribbonSuppressed = false;

  function renderRibbonRail() {
    clear(ribbonRailEl);
    const items = state.ribbons || [];
    const shouldHide = ribbonSuppressed || items.length === 0;
    ribbonRailEl.classList.toggle("hidden", shouldHide);
    if (!items.length) return;

    const listEl = el("div", { class: "ic-obs-ribbon-list" });
    items.forEach((r) => {
      const svgEl = sanitizeSvgElement(r.svgHtml, 17);
      const label = r.title || r.pluginName || "插件动作";
      const tip = r.pluginName && r.title && r.title !== r.pluginName
        ? `${r.title}（${r.pluginName}）`
        : label;
      listEl.appendChild(el("button", {
        type: "button",
        class: "ic-obs-ribbon-btn",
        title: tip,
        "aria-label": tip,
        dataset: { pluginId: r.pluginId || "", ribbonId: r.id || "" },
        onClick: (ev) => triggerRibbon(r.id, ev),
      }, svgEl || el("span", { class: "ic-obs-ribbon-fallback", "aria-hidden": "true" }, "🧩")));
    });

    const footEl = el("div", { class: "ic-obs-ribbon-foot" },
      el("button", {
        type: "button",
        class: "ic-obs-ribbon-btn ic-obs-ribbon-manage",
        title: `管理 Obsidian 插件（${state.plugins.filter((p) => p.enabled).length} 已启用）`,
        "aria-label": "管理 Obsidian 插件",
        onClick: () => openManagerModal("installed"),
      }, sanitizeSvgElement('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 0 1 0 4h-.09c-.66 0-1.25.4-1.51 1z"/></svg>', 16))
    );

    ribbonRailEl.append(listEl, footEl);
  }

  function setRibbonSuppressed(suppressed) {
    ribbonSuppressed = Boolean(suppressed);
    ribbonRailEl.classList.toggle("hidden", ribbonSuppressed || (state.ribbons || []).length === 0);
  }

  const iframe = el("iframe", {
    src: "/obsidian-host.html",
    class: "ic-obs-host-frame",
    sandbox: "allow-scripts allow-same-origin allow-modals allow-popups allow-downloads",
    allow: "clipboard-write",
    title: "Obsidian 插件运行时",
  });

  const hostWrap = el("div", { class: "ic-obs-host-wrap is-standby" }, iframe);
  let dockSlotEl = null;
  let dockResizeObs = null;
  let lastDockedState = false;

  function syncDockedRect() {
    if (!lastDockedState || state.modalOpen || !dockSlotEl || !dockSlotEl.isConnected) return;
    const r = dockSlotEl.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    hostWrap.style.left = `${Math.round(r.left)}px`;
    hostWrap.style.top = `${Math.round(r.top)}px`;
    hostWrap.style.width = `${Math.round(r.width)}px`;
    hostWrap.style.height = `${Math.round(r.height)}px`;
  }

  function setDockSlot(slotEl) {
    dockSlotEl = slotEl;
    if (dockResizeObs) dockResizeObs.disconnect();
    if (slotEl && typeof ResizeObserver !== "undefined") {
      dockResizeObs = new ResizeObserver(() => syncDockedRect());
      dockResizeObs.observe(slotEl);
    }
    window.addEventListener("resize", syncDockedRect);
  }

  function sendCmd(action, payload = {}) {
    if (!state.hostReady || !iframe.contentWindow) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const callId = nextCallId++;
      pendingCmds.set(callId, { resolve, reject });
      iframe.contentWindow.postMessage({ kind: "obs-cmd", callId, action, payload }, "*");
      setTimeout(() => {
        if (pendingCmds.has(callId)) {
          pendingCmds.delete(callId);
          reject(new Error(`Obsidian 插件宿主响应超时 (${action})`));
        }
      }, 30000);
    });
  }

  function updateHostVisibility(drawerShowingPlugins) {
    lastDockedState = Boolean(drawerShowingPlugins);
    hostWrap.classList.toggle("is-modal-open", state.modalOpen);
    const activeInDrawer = lastDockedState && !state.modalOpen;
    hostWrap.classList.toggle("is-docked", activeInDrawer);
    hostWrap.classList.toggle("is-standby", !state.modalOpen && !activeInDrawer);
    if (activeInDrawer) {
      requestAnimationFrame(syncDockedRect);
    } else {
      hostWrap.style.left = "";
      hostWrap.style.top = "";
      hostWrap.style.width = "";
      hostWrap.style.height = "";
    }
  }

  async function handleRpc(action, payload = {}) {
    switch (action) {
      case "vault.list":
        return api("GET", "/api/article/obsidian/vault/list");
      case "vault.read": {
        const q = new URLSearchParams({ path: payload.path || "" });
        if (payload.binary) q.set("binary", "1");
        return api("GET", `/api/article/obsidian/vault/raw?${q.toString()}`);
      }
      case "vault.write":
        return api("PUT", "/api/article/obsidian/vault/raw", payload);
      case "vault.delete":
        return api("DELETE", `/api/article/obsidian/vault/raw?path=${encodeURIComponent(payload.path || "")}`);
      case "plugin.readData":
        return api("GET", `/api/article/obsidian/plugins/${encodeURIComponent(payload.pluginId)}/data`);
      case "plugin.writeData":
        return api("PUT", `/api/article/obsidian/plugins/${encodeURIComponent(payload.pluginId)}/data`, { data: payload.data ?? null });
      case "secret.get":
        return api("GET", `/api/article/obsidian/secrets?key=${encodeURIComponent(payload.key || "")}`);
      case "secret.set":
        return api("PUT", "/api/article/obsidian/secrets", { key: payload.key || "", value: payload.value ?? "" });
      case "requestUrl":
        return api("POST", "/api/article/obsidian/request", payload);
      case "desktop.fs":
        return api("POST", "/api/article/obsidian/desktop/fs", payload);
      case "desktop.spawn":
        return api("POST", "/api/article/obsidian/desktop/spawn", payload);
      default:
        throw new Error(`未知的桥接方法：${action}`);
    }
  }

  async function onWindowMessage(ev) {
    if (disposed || ev.source !== iframe.contentWindow) return;
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.kind === "obs-cmd-reply") {
      const p = pendingCmds.get(msg.callId);
      if (!p) return;
      pendingCmds.delete(msg.callId);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "执行失败"));
      return;
    }

    if (msg.kind === "obs-rpc") {
      try {
        const result = await handleRpc(msg.action, msg.payload || {});
        iframe.contentWindow?.postMessage({ kind: "obs-rpc-reply", id: msg.id, ok: true, result }, "*");
      } catch (err) {
        iframe.contentWindow?.postMessage({ kind: "obs-rpc-reply", id: msg.id, ok: false, error: err?.message || String(err) }, "*");
      }
      return;
    }

    if (msg.kind === "obs-event") {
      const { event, data } = msg;
      if (event === "host-ready") {
        state.hostReady = true;
        await bootHost();
      } else if (event === "registry") {
        state.commands = data.commands || [];
        state.ribbons = data.ribbons || [];
        state.settingsTabs = data.settingsTabs || [];
        state.runtimeErrors.clear();
        (data.errors || []).forEach((e) => state.runtimeErrors.set(e.pluginId, e.error));
        renderRibbonRail();
        opts.onStateChange?.();
      } else if (event === "ui-state") {
        state.modalOpen = Boolean(data.modalOpen);
        state.viewCount = Number(data.viewCount || 0);
        state.activeViewTitle = data.activeViewTitle || "";
        if (data.revealDrawer && state.viewCount > 0) {
          opts.onRevealPluginPane?.();
        }
        opts.onStateChange?.();
      } else if (event === "editor-set-value") {
        opts.setDocContent?.(data.content ?? "", data.path || "");
      } else if (event === "open-file") {
        opts.openFile?.(data.path || "");
      } else if (event === "notice") {
        if (data.message) toast(data.message);
      } else if (event === "copy-text") {
        try { await navigator.clipboard.writeText(data.text || ""); } catch {}
      } else if (event === "copy-html") {
        try {
          const html = String(data.html || "");
          if (navigator.clipboard && window.ClipboardItem) {
            const plain = html.replace(/<[^>]+>/g, "");
            await navigator.clipboard.write([
              new ClipboardItem({
                "text/html": new Blob([html], { type: "text/html" }),
                "text/plain": new Blob([plain], { type: "text/plain" }),
              }),
            ]);
          }
        } catch {}
      } else if (event === "open-url") {
        if (data.url) openURL(data.url);
      }
    }
  }

  window.addEventListener("message", onWindowMessage);

  async function refreshPluginsList() {
    const res = await api("GET", "/api/article/obsidian/plugins").catch(() => ({ dir: "", env: null, plugins: [] }));
    state.dir = res.dir || "";
    state.env = res.env || null;
    state.plugins = res.plugins || [];
    opts.onStateChange?.();
    return state.plugins;
  }

  async function loadPluginIntoHost(id) {
    if (!state.hostReady) return;
    try {
      const bundle = await api("GET", `/api/article/obsidian/plugins/${encodeURIComponent(id)}/bundle`);
      await sendCmd("load-plugin", bundle);
    } catch (err) {
      state.runtimeErrors.set(id, err?.message || String(err));
      opts.onStateChange?.();
    }
  }

  async function unloadPluginFromHost(id) {
    if (!state.hostReady) return;
    state.runtimeErrors.delete(id);
    cm6Bridge.clearPluginExtensions(id);
    await sendCmd("unload-plugin", { id }).catch(() => {});
  }

  async function bootHost() {
    const [pluginsRes, vaultList] = await Promise.all([
      api("GET", "/api/article/obsidian/plugins").catch(() => ({ dir: "", env: null, plugins: [] })),
      api("GET", "/api/article/obsidian/vault/list").catch(() => ({ rootDir: "", name: "articles", files: [] })),
    ]);
    if (disposed) return;
    state.dir = pluginsRes.dir || "";
    state.env = pluginsRes.env || null;
    state.plugins = pluginsRes.plugins || [];

    await sendCmd("init", {
      env: state.env,
      theme: currentThemeName(),
      vault: vaultList,
      doc: opts.getDoc?.() || { path: "", title: "", content: "", selStart: 0, selEnd: 0 },
    }).catch(() => {});

    for (const p of state.plugins) {
      if (p.enabled) {
        await loadPluginIntoHost(p.id);
      }
    }
    opts.onStateChange?.();
  }

  let docSyncTimer = null;
  function syncDoc(immediate = false) {
    if (!state.hostReady) return;
    const run = () => {
      const doc = opts.getDoc?.();
      if (doc) sendCmd("sync-doc", doc).catch(() => {});
    };
    if (docSyncTimer) clearTimeout(docSyncTimer);
    if (immediate) run();
    else docSyncTimer = setTimeout(run, 180);
  }

  async function syncVault() {
    if (!state.hostReady) return;
    const vaultList = await api("GET", "/api/article/obsidian/vault/list").catch(() => null);
    if (vaultList) await sendCmd("sync-vault", vaultList).catch(() => {});
  }

  async function togglePluginEnabled(plugin, nextEnabled) {
    const res = await api("PATCH", `/api/article/obsidian/plugins/${encodeURIComponent(plugin.id)}`, { enabled: nextEnabled });
    await refreshPluginsList();
    if (nextEnabled) {
      await loadPluginIntoHost(plugin.id);
      toast(`已启用 Obsidian 插件「${plugin.manifest.name}」`);
    } else {
      await unloadPluginFromHost(plugin.id);
      toast(`已停用「${plugin.manifest.name}」`);
    }
    return res.plugin;
  }

  async function execCommand(fullId) {
    syncDoc(true);
    return sendCmd("exec-command", { fullId });
  }

  async function triggerRibbon(ribbonId, ev = null) {
    syncDoc(true);
    const host = getObsHost();
    if (host?.triggerRibbon) {
      const rect = ev?.currentTarget?.getBoundingClientRect?.();
      const x = rect ? Math.round(rect.right + 6) : (ev?.clientX ?? 48);
      const y = rect ? Math.round(rect.top) : (ev?.clientY ?? 80);
      return host.triggerRibbon(ribbonId, x, y);
    }
    return sendCmd("trigger-ribbon", { ribbonId });
  }

  async function openPluginSettings(pluginId) {
    closeModal(); // close Handraw's manager modal so sandbox SettingTab modal sits cleanly on top
    return sendCmd("open-settings", { pluginId });
  }

  // ---------- Quick Actions Popover (Toolbar) ----------
  let quickPopEl = null;
  let quickCleanup = null;
  function closeQuickPopover() {
    if (quickCleanup) { quickCleanup(); quickCleanup = null; }
    if (quickPopEl) { quickPopEl.remove(); quickPopEl = null; }
  }

  function openQuickActionsPopover(anchorEl) {
    if (quickPopEl) { closeQuickPopover(); return; }
    const enabledCount = state.plugins.filter((p) => p.enabled).length;
    const pop = el("div", { class: "ic-obs-quick-pop", role: "menu" });

    pop.appendChild(el("div", { class: "ic-obs-quick-head" },
      el("strong", null, `Obsidian 插件 (${enabledCount} 已启用)`),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => { closeQuickPopover(); openManagerModal("installed"); },
      }, "管理 / 安装")
    ));

    const body = el("div", { class: "ic-obs-quick-body" });

    if (state.ribbons.length > 0) {
      body.appendChild(el("div", { class: "ic-obs-quick-sec" }, "快捷入口 (Ribbon)"));
      state.ribbons.forEach((r) => {
        const svgEl = sanitizeSvgElement(r.svgHtml, 14);
        body.appendChild(el("button", {
          type: "button",
          class: "ic-obs-quick-item",
          onClick: (ev) => { closeQuickPopover(); triggerRibbon(r.id, ev); },
        },
          el("span", { class: "ic-obs-quick-ico" }, svgEl || "🧩"),
          el("span", { class: "ic-obs-quick-label" }, r.title || r.pluginName),
          el("span", { class: "ic-obs-quick-meta muted" }, r.pluginName)
        ));
      });
    }

    if (state.commands.length > 0) {
      body.appendChild(el("div", { class: "ic-obs-quick-sec" }, "插件命令"));
      state.commands.forEach((c) => {
        body.appendChild(el("button", {
          type: "button",
          class: "ic-obs-quick-item",
          onClick: () => { closeQuickPopover(); execCommand(c.fullId); },
        },
          el("span", { class: "ic-obs-quick-ico" }, "⚡"),
          el("span", { class: "ic-obs-quick-label" }, c.name),
          el("span", { class: "ic-obs-quick-meta muted" }, c.pluginName)
        ));
      });
    }

    if (state.settingsTabs.length > 0) {
      body.appendChild(el("div", { class: "ic-obs-quick-sec" }, "插件设置"));
      state.settingsTabs.forEach((t) => {
        body.appendChild(el("button", {
          type: "button",
          class: "ic-obs-quick-item",
          onClick: () => { closeQuickPopover(); openPluginSettings(t.pluginId); },
        },
          el("span", { class: "ic-obs-quick-ico" }, "⚙"),
          el("span", { class: "ic-obs-quick-label" }, `${t.pluginName} 设置`)
        ));
      });
    }

    if (enabledCount === 0) {
      body.appendChild(el("div", { class: "ic-obs-quick-empty muted" },
        "还没有启用的 Obsidian 插件。支持扫描本机 Obsidian 目录一键导入，或从社区市场直接安装公众号排版、Linter、图床等插件。"
      ));
    } else if (!state.ribbons.length && !state.commands.length && !state.settingsTabs.length) {
      body.appendChild(el("div", { class: "ic-obs-quick-empty muted" }, "已启用插件暂未注册可见命令或图标。"));
    }

    pop.appendChild(body);
    pop.appendChild(el("div", { class: "ic-obs-quick-foot" },
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => { closeQuickPopover(); openManagerModal("discover"); },
      }, "📂 扫描 Obsidian 导入"),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => { closeQuickPopover(); openManagerModal("market"); },
      }, "＋ 安装社区插件")
    ));

    document.body.appendChild(pop);
    const rect = anchorEl.getBoundingClientRect();
    const popW = Math.min(360, window.innerWidth - 20);
    pop.style.width = `${popW}px`;
    pop.style.left = `${Math.max(10, Math.min(rect.right - popW, window.innerWidth - popW - 10))}px`;
    pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 160)}px`;
    quickPopEl = pop;

    const onOutside = (e) => {
      if (!pop.contains(e.target) && !anchorEl.contains(e.target)) closeQuickPopover();
    };
    const onKey = (e) => { if (e.key === "Escape") closeQuickPopover(); };
    setTimeout(() => {
      document.addEventListener("mousedown", onOutside);
      document.addEventListener("keydown", onKey);
    }, 0);
    quickCleanup = () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }

  // ---------- Full Obsidian Plugin Manager Modal ----------
  function openManagerModal(initialTab = "installed") {
    let activeTab = initialTab;
    let marketQuery = "";
    let marketFeaturedOnly = true;
    let marketItems = [];
    let marketTotal = 0;
    let marketWarn = "";
    let marketLoading = false;
    let discoverVaults = [];
    let discoverLoading = false;
    let discoverCustomDir = "";
    const selectedDiscoverDirs = new Set();
    let importCopyData = true;
    let importAutoEnable = true;
    const busyIds = new Set();

    const body = el("div", { class: "ic-obs-mgr" });
    const tabBar = el("div", { class: "tabs ic-obs-mgr-tabs", role: "tablist" });
    const panelBox = el("div", { class: "ic-obs-mgr-panel" });
    body.append(tabBar, panelBox);

    function renderTabs() {
      clear(tabBar);
      const defs = [
        ["installed", `已安装 (${state.plugins.length})`],
        ["discover", "扫描 Obsidian 目录"],
        ["market", "社区市场"],
        ["import", "GitHub / ZIP 导入"],
      ];
      defs.forEach(([k, lbl]) => {
        tabBar.appendChild(el("button", {
          type: "button",
          role: "tab",
          class: "tab" + (activeTab === k ? " active" : ""),
          "aria-selected": String(activeTab === k),
          onClick: () => {
            activeTab = k;
            renderTabs();
            renderPanel();
          },
        }, lbl));
      });
    }

    function renderInstalledTab() {
      clear(panelBox);
      panelBox.appendChild(el("div", { class: "ic-obs-global-banner" },
        el("div", { class: "ic-obs-global-banner-text" },
          el("strong", null, "全局插件目录（切换文章库共享生效）"),
          el("div", { class: "mono muted", style: { fontSize: "11.5px", wordBreak: "break-all" } }, state.dir || "handraw-client/obsidian-plugins")
        ),
        el("div", { class: "row", style: { gap: "6px", flexShrink: "0" } },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { activeTab = "discover"; renderTabs(); renderPanel(); } }, "📂 扫描 Obsidian 导入"),
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => { activeTab = "market"; renderTabs(); renderPanel(); } }, "＋ 去社区市场")
        )
      ));

      if (!state.plugins.length) {
        panelBox.appendChild(el("div", { class: "ic-obs-empty" },
          el("p", { style: { fontWeight: "600", margin: "0 0 6px" } }, "尚未安装任何 Obsidian 插件"),
          el("p", { class: "muted", style: { margin: "0 0 12px" } }, "可以直接扫描你本机 Obsidian 仓库里已安装的插件一键导入，或在「社区市场」搜索安装 NoteToMP、MP Preview、Linter、Image Auto Upload 等插件。"),
          el("div", { class: "row", style: { justifyContent: "center", gap: "8px" } },
            el("button", { type: "button", class: "btn btn-primary", onClick: () => { activeTab = "discover"; renderTabs(); renderPanel(); } }, "📂 扫描本机 Obsidian 目录"),
            el("button", { type: "button", class: "btn", onClick: () => { activeTab = "market"; renderTabs(); renderPanel(); } }, "🔍 浏览精选社区市场")
          )
        ));
        return;
      }

      const list = el("div", { class: "ic-obs-list" });
      state.plugins.forEach((p) => {
        const mf = p.manifest || {};
        const isBusy = busyIds.has(p.id);
        const runErr = state.runtimeErrors.get(p.id) || state.cm6Errors.get(p.id);
        const cm6Count = p.enabled ? (state.cm6Counts.get(p.id) || 0) : 0;
        const hasSettings = state.settingsTabs.some((t) => t.pluginId === p.id);
        const pluginCmds = state.commands.filter((c) => c.pluginId === p.id);

        const card = el("div", { class: "ic-obs-card" + (p.enabled ? " is-enabled" : "") });
        const head = el("div", { class: "ic-obs-card-head" },
          el("div", { class: "ic-obs-card-title-wrap" },
            el("div", { class: "ic-obs-card-title-row" },
              el("strong", null, mf.name || p.id),
              el("span", { class: "mono muted", style: { fontSize: "11.5px" } }, `v${mf.version || "?"}`),
              compatBadge(p.compat),
              cm6Badge(p.compat, cm6Count),
              sourceLabel(p.install) ? el("span", { class: "badge" }, sourceLabel(p.install)) : null
            ),
            el("div", { class: "muted", style: { fontSize: "12px" } },
              `${p.id}${mf.author ? ` · 作者 ${mf.author}` : ""}`
            )
          ),
          el("div", { class: "row", style: { gap: "6px", flexShrink: "0" } },
            p.enabled && hasSettings ? el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => openPluginSettings(p.id),
            }, "⚙ 设置") : null,
            el("button", {
              type: "button",
              class: "btn btn-sm" + (p.enabled ? "" : " btn-primary"),
              disabled: isBusy || p.compat?.level === "unsupported",
              onClick: async () => {
                busyIds.add(p.id);
                renderInstalledTab();
                try {
                  await togglePluginEnabled(p, !p.enabled);
                } catch (err) {
                  toast(err.message || "操作失败");
                } finally {
                  busyIds.delete(p.id);
                  renderTabs();
                  renderInstalledTab();
                }
              },
            }, isBusy ? "处理中…" : (p.enabled ? "停用" : "启用")),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              disabled: isBusy,
              onClick: async () => {
                busyIds.add(p.id);
                renderInstalledTab();
                try {
                  await unloadPluginFromHost(p.id);
                  await api("DELETE", `/api/article/obsidian/plugins/${encodeURIComponent(p.id)}`);
                  await refreshPluginsList();
                  toast(`已卸载「${mf.name || p.id}」`);
                } catch (err) {
                  toast(err.message || "卸载失败");
                } finally {
                  busyIds.delete(p.id);
                  renderTabs();
                  renderInstalledTab();
                }
              },
            }, "卸载")
          )
        );
        card.appendChild(head);

        if (mf.description) {
          card.appendChild(el("p", { class: "ic-obs-card-desc muted" }, mf.description));
        }

        if (p.compat?.reasons?.length) {
          const ul = el("div", { class: "ic-obs-reasons" });
          p.compat.reasons.forEach((r) => ul.appendChild(el("div", { class: "ic-obs-reason-line" }, `• ${r}`)));
          card.appendChild(ul);
        }

        if (runErr) {
          card.appendChild(el("div", { class: "ic-obs-runtime-err" }, `运行异常：${runErr}`));
        }

        // Permissions row: Trusted Desktop (fs/spawn) + Localhost Ports (PicGo etc.)
        const permBar = el("div", { class: "ic-obs-perm-bar" });
        if (p.compat?.needsDesktop || p.trustedDesktop) {
          const trustCb = el("input", { type: "checkbox" });
          trustCb.checked = Boolean(p.trustedDesktop);
          trustCb.addEventListener("change", async () => {
            try {
              await api("PATCH", `/api/article/obsidian/plugins/${encodeURIComponent(p.id)}`, { trustedDesktop: trustCb.checked });
              await refreshPluginsList();
              toast(trustCb.checked ? `已为「${mf.name}」开启本地桌面权限 (fs/CLI)` : `已撤销「${mf.name}」本地桌面权限`);
            } catch (err) {
              toast(err.message);
            }
          });
          permBar.appendChild(el("label", { class: "ic-obs-check-lbl" },
            trustCb,
            el("span", null, "信任本地桌面权限（允许该插件读写本地文件 / 调用 CLI）")
          ));
        }

        const portsStr = (p.localPorts || []).join(", ");
        const portIn = el("input", {
          type: "text",
          class: "input ic-obs-port-in",
          value: portsStr,
          placeholder: "本地端口白名单，如 36677",
        });
        const savePorts = async (valStr) => {
          const ports = String(valStr || "").split(/[,，\s]+/).map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 65535);
          try {
            await api("PATCH", `/api/article/obsidian/plugins/${encodeURIComponent(p.id)}`, { localPorts: ports });
            await refreshPluginsList();
            toast(ports.length ? `已放行本机端口：${ports.join(", ")}` : "已清空本机端口白名单");
            renderInstalledTab();
          } catch (err) {
            toast(err.message);
          }
        };
        permBar.appendChild(el("div", { class: "ic-obs-port-row" },
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, "本机服务放行："),
          portIn,
          el("button", { type: "button", class: "btn btn-sm", onClick: () => savePorts(portIn.value) }, "保存"),
          !(p.localPorts || []).includes(36677) ? el("button", {
            type: "button",
            class: "btn btn-sm",
            title: "放行 PicGo 默认本地上传端口 36677",
            onClick: () => savePorts([...(p.localPorts || []), 36677].join(",")),
          }, "+ PicGo(36677)") : null
        ));
        card.appendChild(permBar);

        if (p.enabled && pluginCmds.length > 0) {
          card.appendChild(el("div", { class: "ic-obs-cmd-chips" },
            ...pluginCmds.slice(0, 6).map((c) => el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => { closeModal(); execCommand(c.fullId); },
            }, `⚡ ${c.name}`))
          ));
        }

        list.appendChild(card);
      });
      panelBox.appendChild(list);
    }

    async function loadDiscover(customDir = discoverCustomDir) {
      discoverLoading = true;
      renderDiscoverTab();
      try {
        const q = customDir ? `?dir=${encodeURIComponent(customDir)}` : "";
        const res = await api("GET", `/api/article/obsidian/discover${q}`);
        discoverVaults = res.vaults || [];
      } catch (err) {
        toast(err.message || "扫描 Obsidian 目录失败");
        discoverVaults = [];
      } finally {
        discoverLoading = false;
        renderDiscoverTab();
      }
    }

    function renderDiscoverTab() {
      clear(panelBox);
      const customIn = el("input", {
        type: "text",
        class: "input",
        style: { flex: "1", minWidth: "180px" },
        value: discoverCustomDir,
        placeholder: "输入或选择任意 Obsidian 仓库路径 / .obsidian/plugins 目录…",
      });
      customIn.addEventListener("input", () => { discoverCustomDir = customIn.value; });

      const toolbar = el("div", { class: "ic-obs-toolbar" },
        customIn,
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => {
            try {
              const pick = await api("POST", "/api/host/pick-directory", { title: "选择 Obsidian 仓库或插件目录" });
              if (pick?.dir) {
                discoverCustomDir = pick.dir;
                await loadDiscover(discoverCustomDir);
              }
            } catch (err) {
              toast(err.message || "无法打开目录选择器，请手动粘贴路径");
            }
          },
        }, "📂 选择目录"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => loadDiscover(discoverCustomDir.trim()),
        }, "🔍 扫描")
      );
      panelBox.appendChild(toolbar);

      if (discoverLoading) {
        panelBox.appendChild(el("div", { class: "ic-obs-empty muted" }, "正在扫描本机 Obsidian 仓库与本地文章库中的插件…"));
        return;
      }

      const allFound = discoverVaults.flatMap((v) => v.plugins || []);
      if (!allFound.length) {
        panelBox.appendChild(el("div", { class: "ic-obs-empty muted" },
          "未在已发现的 Obsidian 目录中找到插件。可点击上方「📂 选择目录」手动指定你的 Obsidian 仓库路径。"
        ));
        return;
      }

      const copyDataCb = el("input", { type: "checkbox" });
      copyDataCb.checked = importCopyData;
      copyDataCb.addEventListener("change", () => { importCopyData = copyDataCb.checked; });

      const autoEnableCb = el("input", { type: "checkbox" });
      autoEnableCb.checked = importAutoEnable;
      autoEnableCb.addEventListener("change", () => { importAutoEnable = autoEnableCb.checked; });

      const batchBar = el("div", { class: "ic-obs-batch-bar" },
        el("div", { class: "row", style: { gap: "12px", flexWrap: "wrap" } },
          el("label", { class: "ic-obs-check-lbl" }, copyDataCb, el("span", null, "同时导入配置 (data.json)")),
          el("label", { class: "ic-obs-check-lbl" }, autoEnableCb, el("span", null, "导入后自动启用"))
        ),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          disabled: selectedDiscoverDirs.size === 0,
          onClick: async () => {
            const items = Array.from(selectedDiscoverDirs).map((dir) => ({ dir, copyData: importCopyData }));
            try {
              const res = await api("POST", "/api/article/obsidian/import-batch", { items, enable: importAutoEnable });
              await refreshPluginsList();
              for (const inst of res.installed || []) {
                if (inst.enabled) await loadPluginIntoHost(inst.id);
              }
              selectedDiscoverDirs.clear();
              toast(`已导入 ${(res.installed || []).length} 个 Obsidian 插件到全局目录`);
              activeTab = "installed";
              renderTabs();
              renderPanel();
            } catch (err) {
              toast(err.message || "批量导入失败");
            }
          },
        }, `一键导入所选 (${selectedDiscoverDirs.size})`)
      );
      panelBox.appendChild(batchBar);

      const vaultsWrap = el("div", { class: "ic-obs-list" });
      discoverVaults.forEach((v) => {
        if (!v.plugins?.length) return;
        const sec = el("div", { class: "ic-obs-vault-group" });
        const srcTag = v.source === "obsidian-config" ? "Obsidian 配置发现" : (v.source === "article-vault" ? "文章库" : "自定义目录");
        sec.appendChild(el("div", { class: "ic-obs-vault-group-head" },
          el("strong", null, `📁 ${v.name}`),
          el("span", { class: "badge" }, srcTag),
          el("span", { class: "mono muted", style: { fontSize: "11px" } }, v.dir)
        ));

        v.plugins.forEach((dp) => {
          const cb = el("input", { type: "checkbox" });
          cb.checked = selectedDiscoverDirs.has(dp.pluginDir);
          cb.addEventListener("change", () => {
            if (cb.checked) selectedDiscoverDirs.add(dp.pluginDir);
            else selectedDiscoverDirs.delete(dp.pluginDir);
            renderDiscoverTab();
          });

          const row = el("div", { class: "ic-obs-discover-row" },
            cb,
            el("div", { class: "ic-obs-discover-info" },
              el("div", { class: "ic-obs-card-title-row" },
                el("strong", null, dp.manifest.name || dp.id),
                el("span", { class: "mono muted", style: { fontSize: "11.5px" } }, `v${dp.manifest.version}`),
                compatBadge(dp.compat),
                cm6Badge(dp.compat, 0),
                dp.enabledInObsidian ? el("span", { class: "badge" }, "Obsidian 已启用") : null,
                dp.hasData ? el("span", { class: "badge" }, "含配置") : null,
                dp.alreadyInstalled ? el("span", { class: "badge badge-accent" }, `已装 v${dp.installedVersion}`) : null
              ),
              dp.manifest.description ? el("div", { class: "muted", style: { fontSize: "12px" } }, dp.manifest.description) : null,
              dp.compat?.reasons?.length ? el("div", { class: "muted", style: { fontSize: "11.5px", marginTop: "2px" } }, dp.compat.reasons.join("；")) : null
            ),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: async () => {
                try {
                  const res = await api("POST", "/api/article/obsidian/install", {
                    sourceType: "obsidian-vault",
                    dir: dp.pluginDir,
                    copyData: importCopyData,
                    enable: importAutoEnable,
                  });
                  await refreshPluginsList();
                  if (res.plugin?.enabled) await loadPluginIntoHost(res.plugin.id);
                  toast(`已导入「${dp.manifest.name || dp.id}」`);
                  await loadDiscover(discoverCustomDir);
                } catch (err) {
                  toast(err.message || "导入失败");
                }
              },
            }, dp.alreadyInstalled ? "重新导入" : "导入")
          );
          sec.appendChild(row);
        });
        vaultsWrap.appendChild(sec);
      });
      panelBox.appendChild(vaultsWrap);
    }

    let marketTimer = null;
    async function loadMarket(force = false) {
      marketLoading = true;
      renderMarketTab();
      try {
        const q = new URLSearchParams();
        if (marketQuery.trim()) q.set("q", marketQuery.trim());
        if (marketFeaturedOnly && !marketQuery.trim()) q.set("featured", "1");
        if (force) q.set("refresh", "1");
        q.set("limit", "60");
        const res = await api("GET", `/api/article/obsidian/market?${q.toString()}`);
        marketItems = res.items || [];
        marketTotal = res.total || marketItems.length;
        marketWarn = res.warning || "";
      } catch (err) {
        marketWarn = err.message || "加载社区市场失败";
        marketItems = [];
      } finally {
        marketLoading = false;
        renderMarketTab();
      }
    }

    function renderMarketTab() {
      clear(panelBox);
      const searchIn = el("input", {
        type: "search",
        class: "input",
        style: { flex: "1", minWidth: "200px" },
        value: marketQuery,
        placeholder: "搜索 2000+ Obsidian 社区插件（如 note-to-mp、mp-preview、linter、image）…",
      });
      searchIn.addEventListener("input", () => {
        marketQuery = searchIn.value;
        if (marketTimer) clearTimeout(marketTimer);
        marketTimer = setTimeout(() => loadMarket(false), 260);
      });

      const featuredBtn = el("button", {
        type: "button",
        class: "btn btn-sm" + (marketFeaturedOnly && !marketQuery.trim() ? " btn-primary" : ""),
        onClick: () => { marketFeaturedOnly = true; marketQuery = ""; loadMarket(false); },
      }, "⭐ 写作与公众号精选");
      const allBtn = el("button", {
        type: "button",
        class: "btn btn-sm" + (!marketFeaturedOnly || marketQuery.trim() ? " btn-primary" : ""),
        onClick: () => { marketFeaturedOnly = false; loadMarket(false); },
      }, "全部社区插件");

      panelBox.appendChild(el("div", { class: "ic-obs-toolbar" },
        searchIn,
        featuredBtn,
        allBtn,
        el("button", { type: "button", class: "btn btn-sm", title: "刷新目录", onClick: () => loadMarket(true) }, "↻")
      ));

      if (marketWarn) {
        panelBox.appendChild(el("div", { class: "ic-obs-warn-banner" }, marketWarn));
      }

      if (marketLoading) {
        panelBox.appendChild(el("div", { class: "ic-obs-empty muted" }, "正在拉取 Obsidian 官方社区插件目录…"));
        return;
      }

      if (!marketItems.length) {
        panelBox.appendChild(el("div", { class: "ic-obs-empty muted" }, "没有匹配的社区插件，可切换「GitHub / ZIP 导入」直接粘贴仓库链接安装。"));
        return;
      }

      const list = el("div", { class: "ic-obs-list" });
      marketItems.forEach((it) => {
        const isBusy = busyIds.has(it.id);
        list.appendChild(el("div", { class: "ic-obs-card" },
          el("div", { class: "ic-obs-card-head" },
            el("div", { class: "ic-obs-card-title-wrap" },
              el("div", { class: "ic-obs-card-title-row" },
                el("strong", null, it.name || it.id),
                it.featuredTag ? el("span", { class: "badge badge-accent" }, it.featuredTag) : null,
                it.installed ? el("span", { class: "badge ic-obs-badge-ok" }, `已安装 v${it.installedVersion || ""}`) : null
              ),
              el("div", { class: "muted", style: { fontSize: "12px" } },
                `${it.author || ""} · ${it.repo}${it.downloads ? ` · ${formatDownloads(it.downloads)}` : ""}`
              )
            ),
            el("button", {
              type: "button",
              class: "btn btn-sm" + (it.installed ? "" : " btn-primary"),
              disabled: isBusy,
              onClick: async () => {
                busyIds.add(it.id);
                renderMarketTab();
                try {
                  const res = await api("POST", "/api/article/obsidian/install", {
                    sourceType: "market",
                    repo: it.repo,
                    enable: true,
                  });
                  await refreshPluginsList();
                  if (res.plugin?.enabled) await loadPluginIntoHost(res.plugin.id);
                  toast(`已安装「${res.plugin?.manifest?.name || it.name}」`);
                  await loadMarket(false);
                  renderTabs();
                } catch (err) {
                  toast(err.message || "安装失败");
                } finally {
                  busyIds.delete(it.id);
                  renderMarketTab();
                }
              },
            }, isBusy ? "安装中…" : (it.installed ? "重装/更新" : "一键安装"))
          ),
          el("p", { class: "ic-obs-card-desc muted" }, it.featuredSummary || it.description || "")
        ));
      });
      panelBox.appendChild(list);
      if (marketTotal > marketItems.length) {
        panelBox.appendChild(el("div", { class: "muted", style: { textAlign: "center", fontSize: "12px", padding: "8px 0" } },
          `当前显示前 ${marketItems.length} 项（共 ${marketTotal} 项），输入更精确关键词可快速定位`
        ));
      }
    }

    function renderImportTab() {
      clear(panelBox);
      const ghIn = el("input", {
        type: "text",
        class: "input",
        style: { flex: "1" },
        placeholder: "例如：sunbooshi/note-to-mp 或 https://github.com/owner/repo",
      });
      const ghBtn = el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          const val = ghIn.value.trim();
          if (!val) { toast("请填写 GitHub 仓库地址"); return; }
          ghBtn.disabled = true;
          ghBtn.textContent = "下载安装中…";
          try {
            const res = await api("POST", "/api/article/obsidian/install", {
              sourceType: "github",
              repo: val,
              enable: true,
            });
            await refreshPluginsList();
            if (res.plugin?.enabled) await loadPluginIntoHost(res.plugin.id);
            toast(`已安装「${res.plugin?.manifest?.name || val}」`);
            activeTab = "installed";
            renderTabs();
            renderPanel();
          } catch (err) {
            toast(err.message || "安装失败");
          } finally {
            ghBtn.disabled = false;
            ghBtn.textContent = "一键下载安装";
          }
        },
      }, "一键下载安装");

      const zipIn = el("input", { type: "file", accept: ".zip", class: "hidden" });
      zipIn.addEventListener("change", async () => {
        const f = zipIn.files?.[0];
        if (!f) return;
        const fd = new FormData();
        fd.append("file", f);
        fd.append("enable", "true");
        try {
          const res = await api("POST", "/api/article/obsidian/install", fd);
          await refreshPluginsList();
          if (res.plugin?.enabled) await loadPluginIntoHost(res.plugin.id);
          toast(`已从 ZIP 导入「${res.plugin?.manifest?.name || f.name}」`);
          activeTab = "installed";
          renderTabs();
          renderPanel();
        } catch (err) {
          toast(err.message || "ZIP 导入失败");
        }
        zipIn.value = "";
      });

      const localIn = el("input", {
        type: "text",
        class: "input",
        style: { flex: "1" },
        placeholder: "包含 manifest.json 和 main.js 的本地插件文件夹路径…",
      });

      panelBox.append(
        el("div", { class: "ic-obs-import-box" },
          el("strong", null, "1. 从 GitHub 仓库安装（自动下载最新 Release 三件套）"),
          el("p", { class: "muted", style: { fontSize: "12px", margin: "4px 0 8px" } }, "支持粘贴 GitHub 链接或 owner/repo，内置国内加速镜像自动回退。"),
          el("div", { class: "row", style: { gap: "8px" } }, ghIn, ghBtn)
        ),
        el("div", { class: "ic-obs-import-box" },
          el("strong", null, "2. 导入本地插件 ZIP 压缩包"),
          el("p", { class: "muted", style: { fontSize: "12px", margin: "4px 0 8px" } }, "选择包含 manifest.json 与 main.js 的 .zip 压缩包。"),
          zipIn,
          el("button", { type: "button", class: "btn", onClick: () => zipIn.click() }, "📦 选择 ZIP 文件并安装")
        ),
        el("div", { class: "ic-obs-import-box" },
          el("strong", null, "3. 导入本地单个插件文件夹"),
          el("p", { class: "muted", style: { fontSize: "12px", margin: "4px 0 8px" } }, "适合导入本地开发中的插件目录（会自动复制到全局插件目录）。"),
          el("div", { class: "row", style: { gap: "8px" } },
            localIn,
            el("button", {
              type: "button",
              class: "btn",
              onClick: async () => {
                try {
                  const pick = await api("POST", "/api/host/pick-directory", { title: "选择 Obsidian 插件文件夹" });
                  if (pick?.dir) localIn.value = pick.dir;
                } catch {}
              },
            }, "📂 浏览"),
            el("button", {
              type: "button",
              class: "btn btn-primary",
              onClick: async () => {
                const dir = localIn.value.trim();
                if (!dir) { toast("请选择或填写本地插件目录"); return; }
                try {
                  const res = await api("POST", "/api/article/obsidian/install", {
                    sourceType: "local",
                    dir,
                    copyData: true,
                    enable: true,
                  });
                  await refreshPluginsList();
                  if (res.plugin?.enabled) await loadPluginIntoHost(res.plugin.id);
                  toast(`已导入「${res.plugin?.manifest?.name || dir}」`);
                  activeTab = "installed";
                  renderTabs();
                  renderPanel();
                } catch (err) {
                  toast(err.message || "导入失败");
                }
              },
            }, "导入")
          )
        )
      );
    }

    function renderPanel() {
      if (activeTab === "installed") renderInstalledTab();
      else if (activeTab === "discover") {
        if (!discoverVaults.length && !discoverLoading) loadDiscover();
        else renderDiscoverTab();
      } else if (activeTab === "market") {
        if (!marketItems.length && !marketLoading) loadMarket(false);
        else renderMarketTab();
      } else {
        renderImportTab();
      }
    }

    refreshPluginsList().then(() => {
      renderTabs();
      renderPanel();
    });
    renderTabs();
    renderPanel();

    showModal("Obsidian 插件管理（文章工作台）", body, [
      el("button", {
        type: "button",
        class: "btn",
        onClick: () => {
          closeModal();
          if (typeof window.__handrawGo === "function") window.__handrawGo("plugins", { tab: "obsidian" });
          else location.hash = "#plugins";
        },
      }, "在扩展中心管理 ↗"),
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    ]);
  }

  function dispose() {
    disposed = true;
    closeQuickPopover();
    if (docSyncTimer) clearTimeout(docSyncTimer);
    if (dockResizeObs) dockResizeObs.disconnect();
    window.removeEventListener("resize", syncDockedRect);
    window.removeEventListener("message", onWindowMessage);
    pluginCm6Map.clear();
    syncMainCm6Styles();
    opts.setPluginExtensions?.([]);
    if (window.__HANDRAW_CM6_BRIDGE__ === cm6Bridge) {
      delete window.__HANDRAW_CM6_BRIDGE__;
    }
    hostWrap.remove();
  }

  // Expose live commands on window for optional palette integration
  window.__handrawObsidianRuntime = {
    getCommands: () => state.commands,
    execCommand,
  };

  return {
    state,
    hostWrap,
    ribbonRailEl,
    setRibbonSuppressed,
    setDockSlot,
    updateHostVisibility,
    syncDoc,
    syncVault,
    collectContextMenu,
    openManagerModal,
    openQuickActionsPopover,
    execCommand,
    triggerRibbon,
    openPluginSettings,
    dispose,
  };
}
