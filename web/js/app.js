import { api, clear, closeModal, connectEvents, el, getToken, installDialogLightDismiss, money, onEvent, openURL, setColorScheme, setToken, showModal, toast } from "./api.js";
import { economySyncHint, formatEconomyPillText, parseEconomy } from "./economy.js";
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
  let updatingNow = false;
  let latestUpdateStatus = {};

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
    currentView = view && view !== "community" ? view : "home";
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
      const cnt = Number(queue.active || queue.count || 0);
      qCnt.textContent = String(cnt);
      qBtn.classList.toggle("hidden", cnt <= 0);
    }
    latestUpdateStatus = upd || {};
    if (updBtn) {
      const hasUpd = Boolean(upd.available || upd.ready || upd.resourceNew);
      updBtn.classList.toggle("hidden", !hasUpd);
      updBtn.textContent = "更新";
      updBtn.disabled = updatingNow;
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
    updatingNow = true;
    if (updBtn) updBtn.disabled = true;
    const finish = () => {
      updatingNow = false;
      if (updBtn) updBtn.disabled = false;
    };
    try {
      const st = await api("GET", "/api/update").catch(() => latestUpdateStatus || {});
      if (st.resourceNew) {
        toast("正在更新资源包…");
        const r = await api("POST", "/api/update/resources");
        if (r?.updated) {
          toast("资源包已更新");
        }
      }
      const afterRes = await api("GET", "/api/update").catch(() => st);
      if (afterRes.ready) {
        toast("正在应用更新并重启…");
        await api("POST", "/api/update/apply");
        return;
      }
      if (afterRes.available) {
        toast("正在下载更新…");
        if (!afterRes.downloading) {
          await api("POST", "/api/update/download");
        }
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 800));
          const cur = await api("GET", "/api/update").catch(() => null);
          if (!cur) continue;
          if (cur.ready) {
            toast("正在应用更新并重启…");
            await api("POST", "/api/update/apply");
            return;
          }
          if (!cur.downloading && cur.error) {
            throw new Error(cur.error);
          }
          if (!cur.downloading && !cur.available) {
            break;
          }
        }
      }
      await refreshTopbar();
      finish();
    } catch (e) {
      toast(e?.message || "更新失败");
      finish();
      await refreshTopbar();
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
  if (rawInitial.startsWith("settings-")) {
    await go("settings", { anchor: rawInitial });
  } else {
    await go(rawInitial);
  }
}

start();
