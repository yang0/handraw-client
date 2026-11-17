import { api, clear, closeModal, connectEvents, el, getToken, installDialogLightDismiss, localImg, money, onEvent, setColorScheme, setToken, showModal, toast } from "./api.js";
import { initPalette } from "./palette.js";
import { mountPluginFrame } from "./plugins-host.js";
import { renderHome } from "./views/home.js";
import { renderAtlas } from "./views/atlas.js";
import { renderRecipes } from "./views/recipes.js";
import { renderCreate } from "./views/create.js";
import { renderSeries } from "./views/series.js";
import { renderArticle } from "./views/article.js";
import { renderCanvas } from "./views/canvas.js";
import { renderAnnotate } from "./views/annotate.js";
import { renderWorks } from "./views/works.js";
import { renderCommunity } from "./views/community.js";
import { renderSettings } from "./views/settings.js";

const VIEWS = {
  home: renderHome,
  atlas: renderAtlas,
  recipes: renderRecipes,
  create: renderCreate,
  series: renderSeries,
  article: renderArticle,
  canvas: renderCanvas,
  annotate: renderAnnotate,
  works: renderWorks,
  community: renderCommunity,
  settings: renderSettings,
};

const CORE_NAV = [
  { id: "home", ico: "🏠", label: "首页" },
  { id: "atlas", ico: "🎨", label: "画册" },
  { id: "recipes", ico: "⚗", label: "配方" },
  { id: "create", ico: "✨", label: "单图" },
  { id: "series", ico: "🗂", label: "系列" },
  { id: "article", ico: "📰", label: "文章", plugin: "article" },
  { id: "canvas", ico: "🧩", label: "画布", plugin: "canvas" },
  { id: "annotate", ico: "📌", label: "批注", plugin: "annotate" },
  { id: "works", ico: "🖼", label: "作品" },
  { id: "community", ico: "🌐", label: "社区", plugin: "community" },
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
  const navList = document.getElementById("nav-list");
  const settingsNavBtn = document.querySelector('.sidebar-foot .nav-item[data-view="settings"]');

  try {
    if (localStorage.getItem("nav-expanded") === "1") sidebar.classList.add("expanded");
  } catch {}
  document.getElementById("btn-nav-toggle")?.addEventListener("click", () => {
    sidebar.classList.toggle("expanded");
    try { localStorage.setItem("nav-expanded", sidebar.classList.contains("expanded") ? "1" : "0"); } catch {}
  });

  const ctx = {
    boot,
    get token() { return getToken(); },
    go,
    refreshNav,
    refreshTopbar,
  };

  async function refreshNav() {
    const plugRes = await api("GET", "/api/plugins").catch(() => ({ builtin: [], community: [] }));
    const enabledBuiltins = new Set((plugRes.builtin || []).filter((b) => b.enabled).map((b) => b.id));
    clear(navList);

    const addBtn = (id, ico, label) => {
      const btn = el("button", {
        type: "button",
        class: "nav-item" + (currentView === id ? " active" : ""),
        dataset: { view: id },
        title: label,
        onClick: () => go(id),
      },
        el("span", { class: "nav-ico" }, ico),
        el("span", { class: "nav-label" }, label)
      );
      navList.appendChild(btn);
    };

    for (const item of CORE_NAV) {
      if (item.plugin && !enabledBuiltins.has(item.plugin)) continue;
      addBtn(item.id, item.ico, item.label);
    }

    for (const c of plugRes.community || []) {
      if (!c.enabled) continue;
      (c.panels || []).forEach((p, idx) => {
        if (!p.slot || p.slot === "nav" || p.slot === "page") {
          addBtn(`plugin:${c.id}:${idx}`, "🔌", p.title || c.name);
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

  async function go(view, params = {}) {
    currentView = view || "home";
    currentParams = params || {};
    if (location.hash !== "#" + currentView) {
      history.replaceState(null, "", "#" + currentView);
    }
    updateActiveNav();
    clear(main);

    if (currentView.startsWith("plugin:")) {
      const [, pid, idxStr] = currentView.split(":");
      const plugRes = await api("GET", "/api/plugins").catch(() => ({ community: [] }));
      const comm = (plugRes.community || []).find((x) => x.id === pid && x.enabled);
      const panel = comm?.panels?.[Number(idxStr || 0)];
      if (!comm || !panel) {
        main.appendChild(el("div", { class: "card muted" }, "该社区插件未启用或面板不存在。"));
        return;
      }
      main.appendChild(el("div", { class: "page-head" },
        el("h1", { class: "page-title" }, `${comm.name} · ${panel.title || "扩展页面"}`),
        el("span", { class: "badge" }, "沙箱插件")
      ));
      const frameWrap = el("div", { style: { height: "calc(100vh - 150px)" } }, mountPluginFrame(comm.id, panel.file, { view: currentView }));
      main.appendChild(frameWrap);
      return;
    }

    const renderer = VIEWS[currentView] || renderHome;
    try {
      await renderer(main, ctx, currentParams);
    } catch (e) {
      clear(main);
      main.appendChild(el("div", { class: "card col" },
        el("strong", null, "页面加载遇到问题"),
        el("span", { class: "muted" }, e.message || String(e)),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => go(currentView, currentParams) }, "重试")
      ));
    }
  }

  async function refreshTopbar(forceBalance = false) {
    const [acc, bal, queue, upd] = await Promise.all([
      api("GET", "/api/account").catch(() => ({ loggedIn: false })),
      api("GET", "/api/account/balance").catch(() => ({ loggedIn: false })),
      api("GET", "/api/queue").catch(() => ({ active: 0 })),
      api("GET", "/api/update").catch(() => ({})),
    ]);

    const accBtn = document.getElementById("btn-account");
    const balBtn = document.getElementById("btn-balance");
    const balText = document.getElementById("balance-text");
    const qBtn = document.getElementById("btn-queue");
    const qCnt = document.getElementById("queue-count");
    const updBtn = document.getElementById("btn-update");

    if (accBtn) {
      accBtn.textContent = acc.loggedIn ? (acc.user?.username || acc.user?.name || "已登录") : "登录";
    }
    if (balBtn && balText) {
      if (!acc.loggedIn) {
        balText.textContent = "未登录";
      } else {
        const eco = bal.economy || {};
        const cents = eco.balanceCents ?? eco.walletBalanceCents ?? eco.balance;
        const free = eco.freeRemaining ?? eco.dailyFreeRemaining ?? eco.freeQuotaRemaining;
        const txt = [cents != null ? money(cents) : "已连接", free != null ? `免额 ${free}` : ""].filter(Boolean).join(" · ");
        balText.textContent = txt + (bal.offline ? " (离线)" : "");
      }
      if (forceBalance) balBtn.title = "刚刚已同步额度";
    }
    if (qBtn && qCnt) {
      const cnt = Number(queue.active || queue.count || 0);
      qCnt.textContent = String(cnt);
      qBtn.classList.toggle("hidden", cnt <= 0);
    }
    if (updBtn) {
      const hasUpd = Boolean(upd.available || upd.ready || upd.resourceNew);
      updBtn.classList.toggle("hidden", !hasUpd);
      updBtn.textContent = upd.ready ? "⬆ 重启更新" : (upd.available ? `⬆ 新版 ${upd.latest}` : "⬆ 资源可更新");
    }
  }

  settingsNavBtn?.addEventListener("click", () => go("settings"));
  document.getElementById("btn-account")?.addEventListener("click", () => go("settings"));
  document.getElementById("btn-balance")?.addEventListener("click", async () => {
    await refreshTopbar(true);
    toast("已同步账号额度信息");
  });
  document.getElementById("btn-update")?.addEventListener("click", () => go("settings"));
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
    refreshTopbar(false);
  });

  onEvent((msg) => {
    if (msg.type === "account" || msg.type === "balance" || msg.type === "job" || msg.type === "run" || msg.type === "update") {
      refreshTopbar(false);
    }
    if (msg.type === "plugins") {
      refreshNav();
    }
    if (msg.type === "settings" && msg.data?.theme) {
      setColorScheme(msg.data.theme);
    }
  });

  connectEvents();
  initPalette(ctx);
  await refreshNav();
  await refreshTopbar(false);

  const qView = new URLSearchParams(location.search).get("view");
  const initialView = (location.hash && location.hash.slice(1)) || qView || "home";
  await go(initialView);
}

start();
