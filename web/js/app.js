import { api, clear, closeModal, connectEvents, el, getToken, installDialogLightDismiss, money, onEvent, openURL, setColorScheme, setToken, showModal, toast } from "./api.js";
import { economySyncHint, formatEconomyPillText, parseEconomy } from "./economy.js";
import { initPalette } from "./palette.js";
import { fallbackPluginIcon } from "./plugin-icons.js";
import { mountPluginFrame } from "./plugins-host.js";
import { renderHome } from "./views/home.js";
import { renderAtlas } from "./views/atlas.js";
import { renderStudio } from "./views/studio.js";
import { renderChat } from "./views/chat.js";
import { renderArticle } from "./views/article.js";
import { renderCanvas } from "./views/canvas.js";
import { renderWorks } from "./views/works.js";
import { renderInspirations } from "./views/inspirations.js";
import { renderPlugins } from "./views/plugins.js";
import { renderSettings } from "./views/settings.js";
import { openLayoutEditorModal, openStyleEditorModal } from "./views/resource-editor.js";

const VIEWS = {
  home: renderHome,
  atlas: renderAtlas,
  create: renderStudio,
  chat: renderChat,
  article: renderArticle,
  canvas: renderCanvas,
  works: renderWorks,
  inspirations: renderInspirations,
  plugins: renderPlugins,
  settings: renderSettings,
};

const CORE_NAV = [
  { id: "home", ico: "🏠", label: "首页" },
  { id: "atlas", ico: "🎨", label: "画廊" },
  { id: "create", ico: "✨", label: "生图" },
  { id: "chat", ico: "💬", label: "聊天" },
  { id: "article", ico: "📰", label: "文章", plugin: "article" },
  { id: "canvas", ico: "🧩", label: "画布", plugin: "canvas" },
  { id: "works", ico: "🖼", label: "作品" },
  { id: "inspirations", ico: "💡", label: "灵感库" },
  { id: "plugins", ico: "🔌", label: "插件" },
];

let currentView = "home";
let currentParams = {};
let lastFocusRefresh = 0;

async function start() {
  installDialogLightDismiss();

  const boot = await api("GET", "/api/boot").catch(() => ({}));
  if (boot.token) setToken(boot.token);

  const settRes = await api("GET", "/api/settings").catch(() => ({ settings: {} }));
  if (settRes.settings?.theme) setColorScheme(settRes.settings.theme);

  const main = document.getElementById("main");
  const sidebar = document.getElementById("sidebar");
  const sidebarResizer = document.getElementById("sidebar-resizer");
  const navList = document.getElementById("nav-list");
  const settingsNavBtn = document.querySelector('.sidebar-foot .nav-item[data-view="settings"]');

  const MIN_SIDEBAR_W = 156;
  const MAX_SIDEBAR_W = 340;
  const COLLAPSE_THRESHOLD = 104;

  const applySavedSidebarWidth = () => {
    try {
      const saved = Number(localStorage.getItem("nav-width") || 0);
      if (Number.isFinite(saved) && saved >= MIN_SIDEBAR_W && saved <= MAX_SIDEBAR_W) {
        sidebar.style.setProperty("--sidebar-width", `${Math.round(saved)}px`);
      } else {
        sidebar.style.removeProperty("--sidebar-width");
      }
    } catch {}
  };

  try {
    if (localStorage.getItem("nav-expanded") === "1") {
      sidebar.classList.add("expanded");
      applySavedSidebarWidth();
    }
  } catch {}

  document.getElementById("btn-nav-toggle")?.addEventListener("click", () => {
    const expanded = sidebar.classList.toggle("expanded");
    if (expanded) applySavedSidebarWidth();
    try { localStorage.setItem("nav-expanded", expanded ? "1" : "0"); } catch {}
  });

  const qcPop = document.getElementById("quick-create-popover");
  if (qcPop) {
    qcPop.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-quick-create]");
      if (!btn) return;
      const action = btn.dataset.quickCreate;
      if (typeof qcPop.hidePopover === "function") {
        try { qcPop.hidePopover(); } catch {}
      }
      if (action === "style") {
        openStyleEditorModal({}, () => {
          if (currentView === "atlas") go("atlas", { tab: "styles", group: "__mine" });
          else if (currentView === "home") go("home");
        });
      } else if (action === "layout") {
        openLayoutEditorModal({}, () => {
          if (currentView === "atlas") go("atlas", { tab: "layouts", group: "mine" });
          else if (currentView === "home") go("home");
        });
      } else if (action === "create") {
        go("create");
      }
    });
  }

  if (sidebarResizer) {
    sidebarResizer.addEventListener("dblclick", () => {
      sidebar.classList.add("expanded");
      sidebar.style.removeProperty("--sidebar-width");
      try {
        localStorage.removeItem("nav-width");
        localStorage.setItem("nav-expanded", "1");
      } catch {}
    });
    sidebarResizer.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      sidebarResizer.setPointerCapture(ev.pointerId);
      document.body.classList.add("is-resizing-sidebar");
      const startLeft = sidebar.getBoundingClientRect().left;
      const onMove = (e) => {
        const w = Math.round(e.clientX - startLeft);
        if (w < COLLAPSE_THRESHOLD) {
          sidebar.classList.remove("expanded");
          try { localStorage.setItem("nav-expanded", "0"); } catch {}
          return;
        }
        const clamped = Math.max(MIN_SIDEBAR_W, Math.min(MAX_SIDEBAR_W, w));
        sidebar.classList.add("expanded");
        sidebar.style.setProperty("--sidebar-width", `${clamped}px`);
        try {
          localStorage.setItem("nav-expanded", "1");
          localStorage.setItem("nav-width", String(clamped));
        } catch {}
      };
      const onUp = (e) => {
        document.body.classList.remove("is-resizing-sidebar");
        try { sidebarResizer.releasePointerCapture(e.pointerId); } catch {}
        sidebarResizer.removeEventListener("pointermove", onMove);
        sidebarResizer.removeEventListener("pointerup", onUp);
        sidebarResizer.removeEventListener("pointercancel", onUp);
      };
      sidebarResizer.addEventListener("pointermove", onMove);
      sidebarResizer.addEventListener("pointerup", onUp);
      sidebarResizer.addEventListener("pointercancel", onUp);
    });
  }

  const ctx = {
    boot,
    get token() { return getToken(); },
    go,
    refreshNav,
    refreshTopbar,
  };
  let updatingNow = false;
  let latestUpdateStatus = {};

  async function refreshNav() {
    const plugRes = await api("GET", "/api/plugins").catch(() => ({ builtin: [], community: [] }));
    const enabledBuiltins = new Set((plugRes.builtin || []).filter((b) => b.enabled).map((b) => b.id));
    const pluginUpdateCount = Number(plugRes.updates?.outdatedCount || 0);
    clear(navList);

    const addBtn = (id, ico, label, dotCount = 0) => {
      const isImg = typeof ico === "string" && (ico.startsWith("/") || ico.startsWith("http") || ico.startsWith("data:"));
      const icoNode = isImg
        ? el("span", { class: "nav-ico" }, el("img", { src: ico, alt: "", class: "nav-ico-img" }))
        : el("span", { class: "nav-ico" }, ico);
      const btn = el("button", {
        type: "button",
        class: "nav-item" + (currentView === id ? " active" : ""),
        dataset: { view: id },
        title: dotCount > 0 ? `${label}（${dotCount} 个插件可更新）` : label,
        onClick: () => go(id),
      },
        icoNode,
        el("span", { class: "nav-label" }, label),
        dotCount > 0 ? el("span", { class: "nav-update-dot", "aria-label": `${dotCount} 个插件可更新` }) : null
      );
      navList.appendChild(btn);
    };

    for (const item of CORE_NAV) {
      if (item.plugin && !enabledBuiltins.has(item.plugin)) continue;
      addBtn(item.id, item.ico, item.label, item.id === "plugins" ? pluginUpdateCount : 0);
    }

    for (const c of plugRes.community || []) {
      if (!c.enabled) continue;
      const plugIco = c.page?.icon || fallbackPluginIcon(c);
      if (c.kind === "dsh" && c.dsh?.clientEntry) {
        addBtn(`dsh:${c.id}`, plugIco, c.name || c.id);
        continue;
      }
      if (c.page && c.page.file) {
        addBtn(`plugin:${c.id}:page`, plugIco, c.page.title || c.name);
      }
      (c.panels || []).forEach((p, idx) => {
        if (!p.slot || p.slot === "nav" || p.slot === "page") {
          addBtn(`plugin:${c.id}:${idx}`, plugIco, p.title || c.name);
        }
      });
    }
    updateActiveNav();
  }

  function updateActiveNav() {
    document.querySelectorAll(".sidebar .nav-item[data-view]").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === currentView);
    });
  }

  const PADDED_VIEWS = new Set(["home", "atlas", "works", "inspirations", "plugins", "settings"]);
  let navSeq = 0;

  async function go(view, params = {}) {
    const myNavSeq = ++navSeq;
    main._navSeq = myNavSeq;
    if (view === "series") {
      view = "create";
    }
    if (view === "recipes") {
      view = "create";
      params = { ...(params || {}), openRecipes: true };
    }
    if (view === "settings" && params?.anchor === "settings-plugins") {
      view = "plugins";
      params = {};
    }
    currentView = view && view !== "community" ? view : "home";
    currentParams = params || {};
    if (location.hash !== "#" + currentView) {
      history.replaceState(null, "", "#" + currentView);
    }
    window.__handrawGo = go;
    updateActiveNav();
    const viewKind = currentView.startsWith("dsh:") ? "dsh" : (currentView.startsWith("plugin:") ? "plugin" : currentView);
    main.dataset.view = viewKind;
    main.classList.toggle("is-padded-view", PADDED_VIEWS.has(viewKind));
    clear(main);

    if (currentView.startsWith("dsh:")) {
      const pid = currentView.slice(4);
      const plugRes = await api("GET", "/api/plugins").catch(() => ({ community: [] }));
      if (navSeq !== myNavSeq) return;
      const comm = (plugRes.community || []).find((x) => x.id === pid && x.enabled && x.kind === "dsh");
      if (!comm) {
        main.appendChild(el("div", { class: "card muted", style: { margin: "14px" } }, "该 DSH 插件未启用或不存在。请先在侧栏「插件」中启用。"));
        return;
      }
      const titleEl = el("h1", { class: "page-title" }, comm.name || comm.id);
      const onMeta = (ev) => {
        if (ev.origin !== location.origin || ev.data?.kind !== "dsh-panel-meta" || ev.data?.pluginId !== comm.id) return;
        if (ev.data.label) titleEl.textContent = ev.data.label;
      };
      window.addEventListener("message", onMeta);
      const frame = el("iframe", {
        src: `/dsh-host.html?plugin=${encodeURIComponent(comm.id)}`,
        class: "dsh-plugin-frame",
        "data-dsh-plugin": comm.id,
        style: {
          width: "100%",
          flex: "1 1 auto",
          minHeight: "0",
          border: "0",
          background: "var(--surface)",
          display: "block",
        },
      });
      main.appendChild(el("div", { class: "page-head plugin-host-head" },
        titleEl,
        el("div", { class: "row" },
          el("span", { class: "badge badge-accent" }, "DSH 兼容插件"),
          comm.dsh?.compat === "partial" ? el("span", { class: "badge badge-warn", title: (comm.dsh.compatReasons || []).join("；") }, "部分兼容") : null,
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { frame.src = frame.src; } }, "刷新")
        )
      ));
      main.appendChild(frame);
      return;
    }

    if (currentView.startsWith("plugin:")) {
      const [, pid, idxStr] = currentView.split(":");
      const plugRes = await api("GET", "/api/plugins").catch(() => ({ community: [] }));
      if (navSeq !== myNavSeq) return;
      const comm = (plugRes.community || []).find((x) => x.id === pid && x.enabled);
      const panel = idxStr === "page" ? comm?.page : comm?.panels?.[Number(idxStr || 0)];
      if (!comm || !panel) {
        main.appendChild(el("div", { class: "card muted", style: { margin: "14px" } }, "该社区插件未启用或面板不存在。"));
        return;
      }
      main.appendChild(el("div", { class: "page-head plugin-host-head" },
        el("h1", { class: "page-title" }, `${comm.name} · ${panel.title || "扩展页面"}`),
        el("span", { class: "badge" }, "沙箱插件")
      ));
      const frameWrap = el("div", { style: { flex: "1 1 auto", minHeight: "0", display: "flex", flexDirection: "column" } }, mountPluginFrame(comm.id, panel.file, { view: currentView }));
      main.appendChild(frameWrap);
      return;
    }

    const renderer = VIEWS[currentView] || renderHome;
    try {
      await renderer(main, ctx, currentParams);
    } catch (e) {
      if (navSeq !== myNavSeq) return;
      clear(main);
      main.appendChild(el("div", { class: "card col" },
        el("strong", null, "页面加载遇到问题"),
        el("span", { class: "muted" }, e.message || String(e)),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => go(currentView, currentParams) }, "重试")
      ));
    }
  }

  async function refreshTopbar() {
    const [acc, bal, queue, upd] = await Promise.all([
      api("GET", "/api/account").catch(() => ({ loggedIn: false })),
      api("GET", "/api/account/balance").catch((e) => ({ loggedIn: false, error: e?.message || "" })),
      api("GET", "/api/queue").catch(() => ({ active: 0 })),
      api("GET", "/api/update").catch(() => ({})),
    ]);

    const accBtn = document.getElementById("btn-account");
    const ecoBtn = document.getElementById("btn-economy");
    const ecoPop = document.getElementById("economy-popover");
    const qBtn = document.getElementById("btn-queue");
    const qCnt = document.getElementById("queue-count");
    const updBtn = document.getElementById("btn-update");
    const siteBase = acc.siteBase || "https://handraw-style.com";

    if (ecoBtn && ecoPop) {
      if (!acc.loggedIn) {
        ecoBtn.classList.add("hidden");
        if (typeof ecoPop.hidePopover === "function") {
          try { ecoPop.hidePopover(); } catch {}
        }
        clear(ecoPop);
      } else {
        const eco = parseEconomy({ ...bal, loggedIn: true });
        ecoBtn.classList.remove("hidden");
        ecoBtn.classList.toggle("is-muted", !eco.hasData);
        ecoBtn.textContent = formatEconomyPillText(eco);
        renderEconomyPopover(ecoPop, eco, siteBase);
      }
    }

    if (accBtn) {
      const name = acc.user?.displayName || acc.user?.username || acc.user?.name || "用户";
      const label = acc.loggedIn ? `${name} · 账号设置` : "登录";
      accBtn.classList.toggle("account-avatar", Boolean(acc.loggedIn));
      accBtn.setAttribute("aria-label", label);
      accBtn.title = label;
      clear(accBtn);
      if (acc.loggedIn) {
        const fallback = el("span", { "aria-hidden": "true" }, Array.from(name.trim())[0]?.toUpperCase() || "用");
        accBtn.appendChild(fallback);
        if (acc.user?.avatarUrl) {
          try {
            const src = new URL(acc.user.avatarUrl, acc.siteBase);
            if (src.protocol === "https:" || src.protocol === "http:") {
              const img = el("img", {
                src: src.href, alt: "", class: "account-avatar-img",
                referrerpolicy: "no-referrer",
                onLoad: () => fallback.classList.add("hidden"),
                onError: () => { img.remove(); fallback.classList.remove("hidden"); },
              });
              accBtn.appendChild(img);
            }
          } catch {}
        }
      } else {
        accBtn.textContent = "登录";
      }
    }
    if (qBtn && qCnt) {
      const rawCount = Number.isFinite(Number(queue?.count))
        ? Number(queue.count)
        : (Array.isArray(queue?.active) ? queue.active.length : (Number.isFinite(Number(queue?.active)) ? Number(queue.active) : 0));
      const cnt = Math.max(0, Math.trunc(rawCount));
      qCnt.textContent = cnt > 0 ? `绘图中 ${cnt}` : "0";
      qBtn.title = cnt > 0 ? `后台有 ${cnt} 张图正在绘制，点击查看队列` : "后台任务队列";
      qBtn.classList.toggle("hidden", cnt <= 0);
    }
    latestUpdateStatus = upd || {};
    if (updBtn && !updatingNow && !updateFeedbackHold) {
      const hasUpd = Boolean(upd.available || upd.ready || upd.resourceNew || upd.downloading);
      updBtn.classList.toggle("hidden", !hasUpd);
      if (upd.downloading) {
        const pct = Math.max(0, Math.min(100, Number(upd.progress || 0)));
        setTopbarUpdateBtn("busy", pct > 0 ? `下载中 ${pct}%` : "下载更新中…", pct);
      } else if (upd.ready) {
        setTopbarUpdateBtn("idle", "重启升级", 0, "新版本已下载完成，点击重启并升级");
      } else {
        setTopbarUpdateBtn("idle", "更新", 0, "点击立即更新");
      }
    }
  }

  let updateFeedbackHold = false;
  let updateFeedbackTimer = null;

  function setTopbarUpdateBtn(state, label, pct = 0, titleText = "") {
    const updBtn = document.getElementById("btn-update");
    if (!updBtn) return;
    updBtn.classList.add("btn-update-inline");
    updBtn.dataset.state = state;
    updBtn.style.setProperty("--upd-pct", `${Math.max(0, Math.min(100, Number(pct || 0)))}%`);
    updBtn.disabled = state === "busy";
    updBtn.setAttribute("aria-busy", String(state === "busy"));
    if (titleText) updBtn.title = titleText;
    clear(updBtn);
    if (state === "busy") {
      updBtn.append(
        el("span", { class: "upd-spinner", "aria-hidden": "true" }),
        el("span", null, label)
      );
    } else if (state === "done") {
      updBtn.append(
        el("span", { class: "upd-check", "aria-hidden": "true" }, "✓"),
        el("span", null, label)
      );
    } else {
      updBtn.append(el("span", null, label));
    }
  }

  function buildEconomyDetailsNode(eco, siteBase, onClose) {
    const wrap = el("div", { class: "col", style: { gap: "10px" } });
    if (eco.hasData) {
      const grid = el("div", { class: "economy-pop-grid" },
        el("div", { class: "economy-stat" },
          el("span", { class: "muted" }, "可用余额"),
          el("strong", null, eco.balanceCents !== null ? money(eco.balanceCents) : "--"),
          eco.heldCents > 0 ? el("span", { class: "muted" }, `冻结中 ${money(eco.heldCents)}`) : null
        ),
        el("div", { class: "economy-stat" },
          el("span", { class: "muted" }, "社区积分"),
          el("strong", null, eco.points !== null ? String(eco.points) : "--"),
          eco.pendingPoints > 0 ? el("span", { class: "muted" }, `待结算 +${eco.pendingPoints}`) : null
        )
      );
      wrap.appendChild(grid);

      if (eco.quotaTiers.length) {
        const qList = el("div", { class: "row", style: { gap: "6px" } },
          ...eco.quotaTiers.map((q) => el("span", { class: "badge" + (q.remaining > 0 ? " badge-ok" : "") }, `${q.resolution} 剩 ${q.remaining}`))
        );
        wrap.appendChild(el("div", { class: "col", style: { gap: "4px" } },
          el("span", { class: "muted" }, "免费生图额度"),
          qList
        ));
      }
      if (eco.aiBonusObj) {
        wrap.appendChild(el("div", { class: "row", style: { justifyContent: "space-between" } },
          el("span", { class: "muted" }, "AI 体验金"),
          el("strong", null, money(eco.aiBonusCents))
        ));
      }
    }
    const hint = economySyncHint(eco);
    if (hint) {
      wrap.appendChild(el("div", { class: "economy-hint" }, hint));
    }
    wrap.appendChild(el("div", { class: "row", style: { justifyContent: "flex-end", paddingTop: "4px", borderTop: "1px solid var(--line)" } },
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => {
          await refreshTopbar();
          toast("已刷新资产状态");
        },
      }, "刷新"),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => openURL(`${siteBase.replace(/\/+$/, "")}/?view=wallet`),
      }, "充值钱包 ↗"),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => {
          onClose?.();
          go("settings", { anchor: "settings-account" });
        },
      }, "账户设置")
    ));
    return wrap;
  }

  function renderEconomyPopover(popEl, eco, siteBase) {
    clear(popEl);
    popEl.appendChild(el("div", { class: "economy-pop-head" },
      el("strong", null, "账户资产明细"),
      eco.offline ? el("span", { class: "badge badge-warn" }, "离线缓存") : null
    ));
    popEl.appendChild(buildEconomyDetailsNode(eco, siteBase, () => {
      if (typeof popEl.hidePopover === "function") {
        try { popEl.hidePopover(); } catch {}
      }
    }));
  }

  const ecoBtnEl = document.getElementById("btn-economy");
  const ecoPopEl = document.getElementById("economy-popover");
  if (ecoBtnEl && ecoPopEl && !("popover" in HTMLElement.prototype)) {
    ecoBtnEl.addEventListener("click", () => {
      const clone = el("div", { class: "col" }, ...Array.from(ecoPopEl.childNodes).map((n) => n.cloneNode(true)));
      showModal("账户资产明细", clone, [el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭")]);
    });
  }

  async function runImmediateUpdate() {
    if (updatingNow) return;
    const updBtn = document.getElementById("btn-update");
    clearTimeout(updateFeedbackTimer);
    updateFeedbackHold = false;
    updatingNow = true;
    if (updBtn) {
      updBtn.classList.remove("hidden");
      setTopbarUpdateBtn("busy", "准备更新…", 6, "正在检查并执行更新");
    }
    try {
      const st = await api("GET", "/api/update").catch(() => latestUpdateStatus || {});
      let didResourceUpdate = false;
      if (st.resourceNew) {
        setTopbarUpdateBtn("busy", "更新资源中…", 10, "正在增量更新本地资源包");
        const r = await api("POST", "/api/update/resources");
        if (r?.updated) {
          didResourceUpdate = true;
        }
      }
      const afterRes = await api("GET", "/api/update").catch(() => st);
      if (afterRes.ready) {
        setTopbarUpdateBtn("busy", "正在重启…", 100, "正在应用新版本并重启客户端");
        await api("POST", "/api/update/apply");
        return;
      }
      if (afterRes.available) {
        setTopbarUpdateBtn("busy", "下载更新…", Math.max(8, Number(afterRes.progress || 0)), "正在下载客户端新版安装包");
        if (!afterRes.downloading) {
          await api("POST", "/api/update/download");
        }
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 600));
          const cur = await api("GET", "/api/update").catch(() => null);
          if (!cur) continue;
          if (cur.ready) {
            setTopbarUpdateBtn("busy", "正在重启…", 100, "正在应用新版本并重启客户端");
            await api("POST", "/api/update/apply");
            return;
          }
          if (cur.downloading) {
            const pct = Math.max(0, Math.min(100, Number(cur.progress || 0)));
            setTopbarUpdateBtn("busy", pct > 0 ? `下载中 ${pct}%` : "下载更新…", pct, `正在下载新版 ${cur.latest || ""}`);
          }
          if (!cur.downloading && cur.error) {
            throw new Error(cur.error);
          }
          if (!cur.downloading && !cur.available) {
            break;
          }
        }
      }
      updatingNow = false;
      updateFeedbackHold = true;
      setTopbarUpdateBtn("done", didResourceUpdate ? "已更新" : "已是最新", 100, "更新已完成");
      updateFeedbackTimer = setTimeout(async () => {
        updateFeedbackHold = false;
        await refreshTopbar();
      }, 2000);
    } catch (e) {
      updatingNow = false;
      updateFeedbackHold = true;
      setTopbarUpdateBtn("error", "更新失败，点击重试", 0, e?.message || "更新失败，点击重试");
      updateFeedbackTimer = setTimeout(async () => {
        updateFeedbackHold = false;
        await refreshTopbar();
      }, 4500);
    }
  }

  settingsNavBtn?.addEventListener("click", () => go("settings"));
  document.getElementById("btn-account")?.addEventListener("click", () => go("settings", { anchor: "settings-account" }));
  document.getElementById("btn-update")?.addEventListener("click", () => runImmediateUpdate());
  document.getElementById("btn-queue")?.addEventListener("click", async () => {
    const running = await api("GET", "/api/works?limit=12").catch(() => ({ items: [] }));
    const body = el("div", { class: "col" });
    const list = (running.items || []).filter((r) => r.status === "queued" || r.status === "running");
    if (!list.length) {
      body.appendChild(el("div", { class: "muted" }, "当前没有正在进行中的任务。"));
    } else {
      list.forEach((r) => {
        body.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", padding: "8px 10px" } },
          el("span", null, `${r.title || "创作"} · ${r.status}`),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => { closeModal(); go("works", { openRun: r.id }); } }, "查看")
        ));
      });
    }
    showModal("后台生图队列", body, [el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "关闭")]);
  });

  window.addEventListener("focus", () => {
    const now = Date.now();
    if (now - lastFocusRefresh < 15000) return;
    lastFocusRefresh = now;
    refreshTopbar();
  });

  onEvent((msg) => {
    if (msg.type === "resource_update" && updatingNow) {
      const done = Number(msg.data?.done || 0);
      const total = Number(msg.data?.total || 0);
      const pct = total > 0 ? Math.round((done / total) * 100) : 25;
      setTopbarUpdateBtn("busy", total > 0 ? `资源 ${done}/${total}` : "更新资源中…", pct, "正在增量更新本地资源包");
      return;
    }
    if (msg.type === "account" || msg.type === "balance" || msg.type === "job" || msg.type === "run" || msg.type === "update") {
      refreshTopbar();
    }
    if (msg.type === "plugins") {
      refreshNav();
    }
    if (msg.type === "galleries" && currentView === "atlas") {
      go("atlas", currentParams);
    }
    if (msg.type === "settings" && msg.data?.theme) {
      setColorScheme(msg.data.theme);
    }
  });

  connectEvents();
  initPalette(ctx);
  await refreshNav();
  await refreshTopbar();

  const qView = new URLSearchParams(location.search).get("view");
  const rawInitial = (location.hash && location.hash.slice(1)) || qView || "home";
  if (rawInitial === "settings-plugins") {
    await go("plugins");
  } else if (rawInitial.startsWith("settings-")) {
    await go("settings", { anchor: rawInitial });
  } else {
    await go(rawInitial);
  }
}

start();
