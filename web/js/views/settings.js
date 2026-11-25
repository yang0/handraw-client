import { api, clear, closeModal, copyText, el, money, onEvent, openURL, setColorScheme, showModal, toast } from "../api.js";
import { economySyncHint, formatQuotaSummary, formatYuanMicros, parseEconomy } from "../economy.js";
import { createTextModelPicker } from "../skills-ui.js";
import { openClipperSetupModal } from "./inspirations.js";

const VALID_SETTINGS_TABS = new Set([
  "settings-account",
  "settings-models",
  "settings-harnesses",
  "settings-preferences",
  "settings-updates",
]);
let activeSettingsTab = "settings-account";

function createAccountAvatar(accRes, displayName) {
  const wrap = el("div", { class: "settings-avatar", "aria-hidden": "true" });
  const initial = el("span", null, Array.from(String(displayName || "用").trim())[0]?.toUpperCase() || "用");
  wrap.appendChild(initial);
  const avatarUrl = accRes?.user?.avatarUrl;
  if (avatarUrl) {
    try {
      const src = new URL(avatarUrl, accRes.siteBase || "https://handraw-style.com");
      if (src.protocol === "https:" || src.protocol === "http:") {
        const img = el("img", {
          src: src.href,
          alt: "",
          class: "settings-avatar-img",
          referrerpolicy: "no-referrer",
          onLoad: () => initial.classList.add("hidden"),
          onError: () => {
            img.remove();
            initial.classList.remove("hidden");
          },
        });
        wrap.appendChild(img);
      }
    } catch {}
  }
  return wrap;
}

export async function renderSettings(root, ctx, params = {}) {
  const seq = (root._settingsRenderSeq = (root._settingsRenderSeq || 0) + 1);
  const scrollContainerEl = root.closest(".main") || root;
  const savedScrollTop = params?.preserveScroll ? scrollContainerEl.scrollTop : null;

  const requestedTab = params?.tab || params?.anchor;
  if (requestedTab && VALID_SETTINGS_TABS.has(requestedTab)) {
    activeSettingsTab = requestedTab;
  }

  const navSeqAtStart = root._navSeq;
  const [accRes, balRes, settRes, updRes, loginRes, skillsRes, harnessRes, modRes] = await Promise.all([
    api("GET", "/api/account").catch(() => ({ loggedIn: false })),
    api("GET", "/api/account/balance").catch((e) => ({ loggedIn: false, error: e?.message || "" })),
    api("GET", "/api/settings").catch(() => ({ settings: {}, providers: [] })),
    api("GET", "/api/update").catch(() => ({})),
    api("GET", "/api/account/login").catch(() => null),
    api("GET", "/api/skills").catch(() => ({ items: [] })),
    api("GET", params?.rescanHarnesses ? "/api/harnesses?rescan=1" : "/api/harnesses").catch(() => ({ items: [], scenes: [], sceneModels: {} })),
    api("GET", "/api/models").catch(() => ({ textProviders: [], harnesses: [], loggedIn: false })),
  ]);
  if (!root.isConnected || root._settingsRenderSeq !== seq || root._navSeq !== navSeqAtStart || root.dataset.view !== "settings") return;

  root._settingsCleanup?.();
  clear(root);

  const settings = settRes.settings || {};
  const providers = settRes.providers || [];
  const siteBase = (accRes.siteBase || settings.siteBase || "https://handraw-style.com").replace(/\/+$/, "");
  const eco = parseEconomy(accRes.loggedIn ? { ...balRes, loggedIn: true } : { loggedIn: false });
  let loginPollTimer = null;
  let loginTickTimer = null;
  let currentLoginState = null;
  let completingLogin = false;
  let lastFocusCheckAt = 0;

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "col", style: { gap: "2px" } },
      el("h1", { class: "page-title" }, "设置与管理"),
      el("span", { class: "muted" }, "按功能分类管理账号资产、第三方接口、本地偏好与客户端更新")
    ),
    el("span", { class: "muted mono" }, `数据目录：${settRes.dataDir || ""}`)
  ));

  const loginStatusArea = el("div", { class: "col hidden" });
  const loginTriggerButtons = [];

  function setLoginTriggersBusy(busy, label = "登录手绘风账号") {
    for (const btn of loginTriggerButtons) {
      btn.disabled = busy;
      clear(btn);
      if (busy) {
        btn.append(el("span", { class: "login-spinner", "aria-hidden": "true" }), el("span", null, label));
      } else {
        btn.textContent = btn.dataset.defaultLabel || "登录手绘风账号";
      }
    }
  }

  function formatMMSS(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function stopLoginTimers() {
    clearInterval(loginPollTimer);
    clearInterval(loginTickTimer);
    loginPollTimer = null;
    loginTickTimer = null;
  }

  function finishLoginTransition(userObj) {
    if (completingLogin) return;
    completingLogin = true;
    stopLoginTimers();
    renderLoginFlow({
      ...(currentLoginState || {}),
      status: "ok",
      active: false,
      checking: false,
      loggedIn: true,
      user: userObj || currentLoginState?.user || null,
    });
    const minVisualDelay = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? 80 : 420;
    Promise.all([
      ctx.refreshTopbar?.(true)?.catch?.(() => {}) || Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, minVisualDelay)),
    ]).then(() => {
      if (!root.isConnected || root._settingsRenderSeq !== seq) return;
      renderSettings(root, ctx, { tab: "settings-account", justLoggedIn: true });
      toast("登录成功");
    });
  }

  function triggerImmediateLoginCheck(manual = false) {
    if (!currentLoginState?.active || currentLoginState.status !== "pending") return;
    const now = Date.now();
    if (!manual && now - lastFocusCheckAt < 900) return;
    lastFocusCheckAt = now;
    api("GET", "/api/account/login?check=1").then((st) => {
      if (!root.isConnected || root._settingsRenderSeq !== seq || !st) return;
      applyLoginState(st);
      if (manual && st.status === "pending") {
        const nextMs = st.nextCheckAt ? Date.parse(st.nextCheckAt) - Date.now() : 0;
        if (st.checking) {
          toast("正在向官网核对授权状态…");
        } else if (nextMs > 1200) {
          toast(`将在 ${Math.ceil(nextMs / 1000)} 秒后自动核对授权`);
        }
      }
    }).catch(() => {});
  }

  let loginFlowRefs = null;

  function updateLoginCountdowns() {
    if (!loginFlowRefs || !currentLoginState) return;
    const st = currentLoginState;
    if (st.status !== "pending") return;
    if (st.expiresAt) {
      const remSec = Math.max(0, (Date.parse(st.expiresAt) - Date.now()) / 1000);
      loginFlowRefs.expiryEl.textContent = remSec > 0 ? `有效 ${formatMMSS(remSec)}` : "即将过期";
    } else {
      loginFlowRefs.expiryEl.textContent = "";
    }
    if (st.checking) {
      loginFlowRefs.liveText.textContent = "正在向官网核对授权状态…";
    } else if (st.nextCheckAt) {
      const nextSec = Math.max(0, Math.ceil((Date.parse(st.nextCheckAt) - Date.now()) / 1000));
      loginFlowRefs.liveText.textContent = nextSec > 0
        ? `已在浏览器打开授权页，点击「批准授权」后将自动登录（${nextSec} 秒后自动检测）`
        : "正在等待官网返回授权结果…";
    } else {
      loginFlowRefs.liveText.textContent = "已在浏览器打开授权页，点击「批准授权」后将自动登录…";
    }
  }

  function buildStepNode(num, label, state) {
    const cls = "login-step" + (state === "done" ? " is-done" : state === "active" ? " is-active" : "");
    return el("div", { class: cls },
      el("span", { class: "login-step-dot", "aria-hidden": "true" }, state === "done" ? "✓" : String(num)),
      el("span", null, label)
    );
  }

  function renderLoginFlow(st) {
    currentLoginState = st;
    if (!st || st.status === "idle") {
      clear(loginStatusArea);
      loginStatusArea.classList.add("hidden");
      loginFlowRefs = null;
      setLoginTriggersBusy(false);
      return;
    }

    const wasHidden = loginStatusArea.classList.contains("hidden");
    loginStatusArea.classList.remove("hidden");
    const visualStage = st.status === "pending" && st.checking ? "checking" : st.status;
    const isSyncOrOk = st.status === "syncing" || st.status === "ok";
    const isStarting = st.status === "starting";
    const isError = st.status === "error";

    setLoginTriggersBusy(isStarting || st.status === "pending" || isSyncOrOk, isStarting ? "正在申请授权码…" : isSyncOrOk ? "正在同步账号…" : "等待网页授权中…");

    const step1 = isStarting ? "active" : "done";
    const step2 = isStarting ? "upcoming" : isSyncOrOk ? "done" : isError ? "upcoming" : "active";
    const step3 = isSyncOrOk ? "active" : "upcoming";

    clear(loginStatusArea);
    const card = el("div", {
      class: "login-flow-card" + (wasHidden ? " is-entering" : ""),
      dataset: { stage: visualStage },
      role: "status",
      "aria-live": "polite",
    },
      el("div", { class: "login-progress-track", "aria-hidden": "true" }, el("div", { class: "login-progress-bar" })),
      el("div", { class: "login-steps" },
        buildStepNode(1, "打开网页授权", step1),
        buildStepNode(2, "等待网页确认", step2),
        buildStepNode(3, "同步账号资产", step3)
      )
    );

    if (isStarting) {
      card.appendChild(el("div", { class: "login-live-row" },
        el("span", { class: "login-spinner", style: { color: "var(--accent)" }, "aria-hidden": "true" }),
        el("span", null, "正在向手绘风官网申请设备授权码，随后将自动打开浏览器…")
      ));
      loginFlowRefs = null;
    } else if (isSyncOrOk) {
      const who = st.user?.displayName || st.user?.username || "";
      card.appendChild(el("div", { class: "login-success-banner" },
        el("span", { class: "login-success-check", "aria-hidden": "true" }, "✓"),
        el("div", { class: "col", style: { gap: "2px" } },
          el("strong", null, who ? `授权已通过，欢迎回来 ${who}！` : "授权已通过！"),
          el("span", { class: "muted" }, "正在同步账号余额、积分与免费生图额度…")
        ),
        el("span", { class: "login-spinner", style: { marginLeft: "auto", color: "var(--ok)" }, "aria-hidden": "true" })
      ));
      loginFlowRefs = null;
    } else if (isError) {
      card.appendChild(el("div", { class: "login-live-row" },
        el("span", { class: "login-live-dot", "aria-hidden": "true" }),
        el("span", null, st.error || "授权未完成，请重新发起登录")
      ));
      card.appendChild(el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: startDeviceLogin() }, "重新发起登录"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => renderLoginFlow({ status: "idle" }),
        }, "收起")
      ));
      loginFlowRefs = null;
    } else {
      const expiryEl = el("span", { class: "muted mono", style: { fontSize: "12px" } }, "");
      const liveText = el("span", null, "");
      const indicator = st.checking
        ? el("span", { class: "login-spinner", style: { color: "var(--accent)" }, "aria-hidden": "true" })
        : el("span", { class: "login-live-dot", "aria-hidden": "true" });

      card.appendChild(el("div", { class: "login-code-strip" },
        el("div", { class: "col", style: { gap: "2px" } },
          el("span", { class: "muted", style: { fontSize: "12px" } }, "请在浏览器授权页核对此设备码并点击确认"),
          el("div", { class: "login-code-value mono" }, st.userCode || "----")
        ),
        el("div", { class: "row", style: { gap: "8px" } },
          expiryEl,
          st.userCode ? el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: async () => {
              const ok = await copyText(st.userCode);
              toast(ok ? "已复制核对码" : "复制失败");
            },
          }, "复制核对码") : null
        )
      ));

      card.appendChild(el("div", { class: "login-live-row" }, indicator, liveText));

      const checkNowBtn = el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        disabled: Boolean(st.checking),
        onClick: () => triggerImmediateLoginCheck(true),
      }, st.checking ? "正在检测…" : "我已授权，立即检测");

      card.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } },
        el("div", { class: "row" },
          checkNowBtn,
          st.verificationUrl ? el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(st.verificationUrl) }, "重新打开授权页 ↗") : null
        ),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => {
            stopLoginTimers();
            await api("POST", "/api/account/login/cancel").catch(() => {});
            renderLoginFlow({ status: "idle" });
            toast("已取消登录");
          },
        }, "取消登录")
      ));

      loginFlowRefs = { expiryEl, liveText };
      updateLoginCountdowns();
    }

    loginStatusArea.appendChild(card);
  }

  function applyLoginState(st) {
    if (!st) return;
    if (st.status === "ok") {
      finishLoginTransition(st.user);
      return;
    }
    if (st.status === "syncing") {
      stopLoginTimers();
      renderLoginFlow(st);
      // Fallback poll in case SSE missed the final "ok" transition.
      loginPollTimer = setInterval(async () => {
        if (!root.isConnected || completingLogin) { clearInterval(loginPollTimer); return; }
        const p = await api("GET", "/api/account/login").catch(() => null);
        if (p?.status === "ok" || (p?.loggedIn && p?.status !== "syncing")) {
          finishLoginTransition(p.user);
        }
      }, 600);
      return;
    }
    if (st.status === "error") {
      stopLoginTimers();
      renderLoginFlow(st);
      if (st.error) toast(st.error);
      return;
    }
    if (st.status === "idle") {
      stopLoginTimers();
      renderLoginFlow(st);
      return;
    }
    if (st.status === "pending" || st.active) {
      renderLoginFlow(st);
      if (!loginTickTimer) {
        loginTickTimer = setInterval(updateLoginCountdowns, 500);
      }
      if (!loginPollTimer) {
        // Lightweight fallback sync; primary updates arrive instantaneously via SSE.
        loginPollTimer = setInterval(async () => {
          if (!root.isConnected || completingLogin) {
            stopLoginTimers();
            return;
          }
          const poll = await api("GET", "/api/account/login").catch(() => null);
          if (poll && (poll.status !== currentLoginState?.status || poll.checking !== currentLoginState?.checking || poll.pollCount !== currentLoginState?.pollCount)) {
            applyLoginState(poll);
          }
        }, 2500);
      }
    }
  }

  function startDeviceLogin() {
    return async () => {
      completingLogin = false;
      stopLoginTimers();
      renderLoginFlow({ status: "starting", active: true });
      try {
        const st = await api("POST", "/api/account/login");
        applyLoginState(st);
      } catch (e) {
        renderLoginFlow({ status: "error", active: false, error: e.message || "发起登录失败，请检查网络连接" });
        toast(e.message || "发起登录失败");
      }
    };
  }

  // 1. Account & Assets
  const accSection = el("section", {
    id: "settings-account",
    class: "card settings-section" + (params?.justLoggedIn ? " settings-account-enter" : ""),
    role: "tabpanel",
    "aria-labelledby": "tab-settings-account",
    tabindex: "0",
  });
  const accStatusBadge = accRes.loggedIn
    ? el("span", { class: "badge " + (eco.offline ? "badge-warn" : "badge-ok") }, eco.offline ? "已登录 · 离线缓存" : "已登录")
    : el("span", { class: "badge" }, "未登录");

  accSection.appendChild(el("div", { class: "settings-section-head" },
    el("div", { class: "col", style: { gap: "2px" } },
      el("h2", { class: "settings-section-title" }, "网站账户与资产同步"),
      el("p", { class: "muted", style: { margin: 0 } }, "同步手绘风账号、可用余额、社区积分与各档位免费生图额度")
    ),
    accStatusBadge
  ));

  if (accRes.skillDetected) {
    accSection.appendChild(el("div", { class: "badge badge-accent" }, `检测到本机 Skill 已配置账号（${accRes.skillUsername || "已登录"}）；客户端使用独立加密令牌存储，互不覆盖`));
  }

  if (accRes.loggedIn) {
    const displayName = accRes.user?.displayName || accRes.user?.username || accRes.user?.name || "手绘风用户";
    const username = accRes.user?.username || "";
    const identitySub = username && username !== displayName ? `@${username}` : "";

    accSection.appendChild(el("div", { class: "settings-account-bar" },
      el("div", { class: "row", style: { gap: "12px", minWidth: 0 } },
        createAccountAvatar(accRes, displayName),
        el("div", { class: "col", style: { gap: "2px", minWidth: 0 } },
          el("strong", { style: { fontSize: "15px" } }, displayName),
          el("span", { class: "muted" }, identitySub)
        )
      ),
      el("div", { class: "row" },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => {
            await ctx.refreshTopbar?.(true);
            await renderSettings(root, ctx, { preserveScroll: true });
            toast("已刷新账户与资产状态");
          },
        }, "刷新额度"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(`${siteBase}/?view=wallet`) }, "充值钱包 ↗"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(`${siteBase}/?view=profile`) }, "账号控制台 ↗"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          onClick: async () => {
            await api("POST", "/api/account/logout");
            await ctx.refreshTopbar?.(true);
            renderSettings(root, ctx, { tab: "settings-account" });
            toast("已退出登录");
          },
        }, "退出登录")
      )
    ));

    if (eco.hasData) {
      const assetsGrid = el("div", { class: "settings-economy-grid" },
        el("div", { class: "economy-stat" },
          el("span", { class: "muted" }, "余额"),
          el("strong", null, eco.balanceMicros !== null ? formatYuanMicros(eco.balanceMicros, 2, 4) : "--"),
          el("span", { class: "muted" }, eco.heldMicros > 0 ? `冻结中 ${formatYuanMicros(eco.heldMicros, 2, 4)}` : "生图与 AI 通用")
        ),
        el("div", { class: "economy-stat" },
          el("span", { class: "muted" }, "社区积分"),
          el("strong", null, eco.points !== null ? String(eco.points) : "--"),
          el("span", { class: "muted" }, eco.pendingPoints > 0 ? `7日待结算 +${eco.pendingPoints}` : "社区创作与互动积分")
        ),
        el("div", { class: "economy-stat" },
          el("span", { class: "muted" }, "免费生图额度"),
          el("strong", null, eco.tier1k ? `${eco.tier1k.resolution} 剩 ${eco.tier1k.remaining}` : "暂无"),
          el("span", { class: "muted" }, formatQuotaSummary(eco))
        )
      );
      accSection.appendChild(assetsGrid);
    }

    // Creator level (handraw-web #376): loaded separately so an older site
    // without levels never blocks the account panel.
    const levelSlot = el("div", { class: "settings-level-slot" });
    accSection.appendChild(levelSlot);
    api("GET", "/api/account/level").then((lv) => {
      if (!lv || !lv.available) return;
      const pct = Math.round((lv.progress || 0) * 100);
      levelSlot.appendChild(el("div", { class: "settings-level" },
        el("span", { class: "settings-level-seal" }, `Lv${lv.level}`),
        el("div", { class: "col", style: { gap: "4px", flex: "1", minWidth: 0 } },
          el("div", { class: "row", style: { justifyContent: "space-between", gap: "8px" } },
            el("strong", null, `${lv.name} · ${lv.xp} 经验`),
            el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(`${siteBase}/?view=account&section=level`) }, "等级详情 ↗")
          ),
          el("div", { class: "settings-level-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": "距离下一级的进度" },
            el("span", { style: { width: `${pct}%` } })),
          el("span", { class: "muted" }, lv.nextLevel
            ? `再获得 ${lv.nextXp - lv.xp} 经验升到 Lv${lv.nextLevel} ${lv.nextName}` + (lv.priceCap > 100000 ? "" : lv.priceCap ? ` · 收费定价上限 ${lv.priceCap} 积分` : " · Lv3 起可发布收费画风")
            : "已经是最高等级")
        )
      ));
    }).catch(() => {});

    const syncHint = economySyncHint(eco);
    if (syncHint) {
      let reauthBtn = null;
      if (eco.scopeDenied) {
        reauthBtn = el("button", {
          type: "button",
          class: "btn btn-sm",
          dataset: { defaultLabel: "重新授权登录" },
          onClick: startDeviceLogin(),
        }, "重新授权登录");
        loginTriggerButtons.push(reauthBtn);
      }
      accSection.appendChild(el("div", { class: "economy-hint row", style: { justifyContent: "space-between" } },
        el("span", null, syncHint),
        reauthBtn
      ));
    }
    accSection.appendChild(loginStatusArea);
  } else {
    const loginBtn = el("button", {
      type: "button",
      class: "btn btn-primary",
      dataset: { defaultLabel: "登录手绘风账号" },
      onClick: startDeviceLogin(),
    }, "登录手绘风账号");
    loginTriggerButtons.push(loginBtn);
    accSection.appendChild(el("div", { class: "settings-account-bar" },
      el("span", { class: "muted" }, accRes.error || "登录后可同步可用余额、社区积分与免费额度，并支持发布作品与收藏同步"),
      loginBtn
    ));
    accSection.appendChild(loginStatusArea);
  }

  if (loginRes && (loginRes.active || loginRes.status === "pending" || loginRes.status === "syncing")) {
    applyLoginState(loginRes);
  }

  // 2. Third-Party Providers Only (no official interface selectors here)
  const provSection = el("section", {
    id: "settings-models",
    class: "card settings-section",
    role: "tabpanel",
    "aria-labelledby": "tab-settings-models",
    tabindex: "0",
  },
    el("div", { class: "settings-section-head" },
      el("div", { class: "col", style: { gap: "2px" } },
        el("h2", { class: "settings-section-title" }, "第三方接口管理"),
        el("p", { class: "muted", style: { margin: 0 } }, "添加并管理 OpenAI 兼容的第三方生图、文字与视觉解析中转站；拉取模型后直接勾选启用")
      ),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => openProviderModal(null, () => renderSettings(root, ctx, { tab: "settings-models", preserveScroll: true })),
      }, "+ 添加第三方接口")
    )
  );

  const provList = el("div", { class: "col", style: { gap: "10px" } },
    el("div", { class: "settings-subhead" }, `已配置第三方接口（${providers.length}）`)
  );
  if (!providers.length) {
    provList.appendChild(el("div", { class: "settings-empty muted" }, "尚未添加第三方接口。点击右上角「+ 添加第三方接口」，填入地址与密钥后拉取模型并勾选启用。"));
  } else {
    providers.forEach((p) => {
      const modelList = p.models || [];
      const imgModels = modelList.filter((m) => resolveModelKind(p, m) === "image");
      const txtModels = modelList.filter((m) => resolveModelKind(p, m) === "text");
      const previewChips = modelList.length ? el("div", { class: "provider-model-preview" },
        ...modelList.slice(0, 8).map((m) => {
          const isImg = resolveModelKind(p, m) === "image";
          const prefix = isImg ? "🎨 " : (m.canVision || looksVisionModelId(m.id) ? "👁 " : "💬 ");
          return el("span", { class: "provider-model-pill", title: isImg ? "生图模型" : (m.canVision ? "文字 + 视觉识图" : "文字模型") }, `${prefix}${m.id}`);
        }),
        modelList.length > 8 ? el("span", { class: "provider-model-pill" }, `+${modelList.length - 8}`) : null
      ) : null;

      provList.appendChild(el("div", { class: "settings-subcard row", style: { justifyContent: "space-between", alignItems: "flex-start" } },
        el("div", { class: "col", style: { gap: "3px", minWidth: 0, flex: "1 1 280px" } },
          el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
            el("strong", null, p.name),
            imgModels.length ? el("span", { class: "badge badge-accent" }, `🎨 生图 ${imgModels.length}`) : null,
            txtModels.length ? el("span", { class: "badge" }, `💬 文字/视觉 ${txtModels.length}`) : null,
            !imgModels.length && !txtModels.length ? el("span", { class: "badge" }, "综合接口") : null,
            p.hasKey ? el("span", { class: "badge badge-ok" }, "已存密钥") : el("span", { class: "badge badge-warn" }, "未填密钥")
          ),
          el("span", { class: "muted mono", style: { overflowWrap: "anywhere" } }, `${p.baseUrl} · 共启用 ${modelList.length} 个模型`),
          previewChips
        ),
        el("div", { class: "row", style: { flexShrink: 0 } },
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true;
              btn.textContent = "检测中…";
              try {
                const t = await api("POST", `/api/providers/${encodeURIComponent(p.id)}/test`, {}).catch((e) => ({ ok: false, error: e.message }));
                toast(t.ok ? `连通正常 · 发现 ${t.modelsCount ?? 0} 个模型（${t.latencyMs}ms）` : `测试失败：${t.error}`);
              } finally {
                btn.disabled = false;
                btn.textContent = "测试连通";
              }
            },
          }, "测试连通"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => openProviderModal(p, () => renderSettings(root, ctx, { tab: "settings-models", preserveScroll: true })),
          }, "编辑"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-danger",
            onClick: async () => {
              await api("DELETE", `/api/providers/${encodeURIComponent(p.id)}`);
              renderSettings(root, ctx, { tab: "settings-models", preserveScroll: true });
              toast("已删除接口");
            },
          }, "删除")
        )
      ));
    });
  }
  provSection.appendChild(provList);

  // 2.5 Local AI Harnesses & Per-Scene Routing (#119)
  const harnesses = Array.isArray(harnessRes?.items) ? harnessRes.items : [];
  const harnessScenes = Array.isArray(harnessRes?.scenes) ? harnessRes.scenes : [];
  const sceneModels = Object.assign({}, settings.sceneModels || harnessRes?.sceneModels || {});
  const readyHarnessCount = harnesses.filter((h) => h && h.available).length;

  const pickerModRes = {
    ...(modRes || {}),
    harnesses,
  };

  function buildSceneModelSelect(currentValue, allowFollowDefault = true, sceneKey = "") {
    const picker = createTextModelPicker(pickerModRes, currentValue || "", sceneKey, null, {
      allowEmpty: true,
      emptyLabel: allowFollowDefault ? "跟随通用默认文字引擎" : "自动调度（优先官网，回退第三方）",
    });
    return picker.el;
  }

  const sceneRowsWrap = el("div", { class: "harness-scene-list" });
  const defaultTextSel = buildSceneModelSelect(settings.defaultTextModel || "", false);
  defaultTextSel.addEventListener("change", async () => {
    try {
      await api("PATCH", "/api/settings", { defaultTextModel: defaultTextSel.value });
      toast("已更新通用默认文字引擎");
    } catch (e) {
      toast(e.message || "保存失败");
    }
  });
  sceneRowsWrap.appendChild(el("div", { class: "harness-scene-row" },
    el("div", { class: "harness-scene-info" },
      el("strong", null, "通用默认文字引擎"),
      el("span", { class: "muted" }, "各场景未单独指定时默认使用的文字/规划模型")
    ),
    defaultTextSel
  ));

  harnessScenes.forEach((sc) => {
    const sel = buildSceneModelSelect(sceneModels[sc.key] || "", true, sc.key);
    sel.addEventListener("change", async () => {
      try {
        await api("PATCH", "/api/settings", { sceneModels: { [sc.key]: sel.value } });
        sceneModels[sc.key] = sel.value;
        toast(`已更新「${sc.label}」引擎`);
      } catch (e) {
        toast(e.message || "保存失败");
      }
    });
    sceneRowsWrap.appendChild(el("div", { class: "harness-scene-row" },
      el("div", { class: "harness-scene-info" },
        el("strong", null, sc.label),
        el("span", { class: "muted" }, sc.description)
      ),
      sel
    ));
  });

  const harnessCardsWrap = el("div", { class: "harness-list" });
  const moreHarnessCardsWrap = el("div", { class: "harness-list", style: { marginTop: "8px" } });

  function renderHarnessCard(h) {
    const statusBadge = h.available
      ? el("span", { class: "badge badge-ok" }, "已就绪")
      : (h.detected
          ? el("span", { class: "badge" }, "已停用")
          : (h.configDetected && h.diagnosticHint
              ? el("span", { class: "badge badge-warn" }, "仅检测到配置")
              : el("span", { class: "badge badge-warn" }, "未检测到")));

    const testFeedback = el("div", { class: "provider-test-feedback hidden" });
    const testBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      disabled: !h.detected,
      onClick: async () => {
        testBtn.disabled = true;
        const oldTxt = testBtn.textContent;
        testBtn.textContent = "测试中…";
        testFeedback.classList.remove("hidden");
        testFeedback.dataset.state = "loading";
        testFeedback.replaceChildren(el("div", { role: "status", class: "muted" }, `正在调用本机 ${h.name} 执行最小连通测试（首次可能需 10–30 秒）…`));
        try {
          const r = await api("POST", `/api/harnesses/${encodeURIComponent(h.id)}/test`, {});
          if (r.ok) {
            testFeedback.dataset.state = "ok";
            testFeedback.replaceChildren(
              el("div", { role: "status", style: { color: "var(--ok)", fontWeight: "600" } }, `连通正常（耗时 ${r.elapsedMs || 0} ms）`),
              el("pre", { class: "provider-test-detail" }, String(r.text || "").slice(0, 400))
            );
          } else {
            testFeedback.dataset.state = "error";
            testFeedback.replaceChildren(
              el("div", { role: "status" }, "测试失败"),
              el("pre", { class: "provider-test-detail" }, r.error || "未知错误")
            );
          }
        } catch (err) {
          testFeedback.dataset.state = "error";
          testFeedback.replaceChildren(
            el("div", { role: "status" }, "测试失败"),
            el("pre", { class: "provider-test-detail" }, err?.message || "请求异常")
          );
        } finally {
          testBtn.disabled = !h.detected;
          testBtn.textContent = oldTxt;
        }
      },
    }, "测试");

    const toggleBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      disabled: !h.detected && !h.enabled,
      onClick: async () => {
        try {
          await api("PUT", `/api/harnesses/${encodeURIComponent(h.id)}`, {
            id: h.id,
            name: h.name,
            driver: h.driver,
            enabled: !h.enabled,
            command: h.command || "",
            model: h.model || "",
            extraArgs: h.extraArgs || [],
            workDir: h.workDir || "",
            timeoutSec: h.timeoutSec || 180,
          });
          toast(h.enabled ? `已停用 ${h.name}` : `已启用 ${h.name}`);
          renderSettings(root, ctx, { tab: "settings-harnesses", preserveScroll: true });
        } catch (err) {
          toast(err.message || "操作失败");
        }
      },
    }, h.enabled ? "停用" : "启用");

    const metaBits = [];
    if (h.model) metaBits.push(`子模型：${h.model}`);
    if (h.workDir) metaBits.push(`目录：${h.workDir}`);
    if (h.timeoutSec && h.timeoutSec !== 180) metaBits.push(`超时：${h.timeoutSec}s`);
    if (Array.isArray(h.candidates) && h.candidates.length > 1) {
      metaBits.push(`多路径候选：${h.candidates.length} 处`);
    }

    const hasOverride = Boolean(h.command || h.model || (h.extraArgs && h.extraArgs.length) || h.workDir || (h.timeoutSec && h.timeoutSec !== 180));
    const candTitle = Array.isArray(h.candidates) && h.candidates.length > 1
      ? `优先使用：${h.resolvedPath}\n其他发现位置：\n${h.candidates.slice(1).join("\n")}`
      : (h.resolvedPath || "");

    return el("div", { class: "card col harness-card", style: { gap: "8px", padding: "12px 14px", background: "var(--paper)" } },
      el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start", gap: "10px", flexWrap: "wrap" } },
        el("div", { class: "col", style: { gap: "3px", minWidth: "0", flex: "1" } },
          el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
            el("strong", null, h.name),
            el("span", { class: "badge mono" }, h.driver),
            h.custom ? el("span", { class: "badge badge-accent" }, "自定义") : null,
            statusBadge,
            h.detected && h.detectionSource
              ? el("span", { class: "badge", title: "探测来源" }, h.detectionSource)
              : null
          ),
          h.description ? el("span", { class: "muted" }, h.description) : null,
          el("code", { class: "mono muted harness-path", title: candTitle },
            h.resolvedPath ? h.resolvedPath : "未在系统 PATH、注册表/登录 Shell 或常见包管理器目录中检测到，可点「配置」手动填写可执行路径"
          ),
          h.diagnosticHint
            ? el("span", { class: "muted", style: { fontSize: "12px", color: h.detected ? "var(--ink-2)" : "var(--warn, #9a6700)" } }, h.diagnosticHint)
            : null,
          metaBits.length ? el("span", { class: "muted", style: { fontSize: "11.5px" } }, metaBits.join(" · ")) : null
        ),
        el("div", { class: "row", style: { gap: "6px", flexShrink: "0" } },
          toggleBtn,
          testBtn,
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => openHarnessModal(h, () => renderSettings(root, ctx, { tab: "settings-harnesses", preserveScroll: true })),
          }, "配置"),
          h.custom
            ? el("button", {
                type: "button",
                class: "btn btn-sm btn-danger",
                onClick: async () => {
                  await api("DELETE", `/api/harnesses/${encodeURIComponent(h.id)}`);
                  toast(`已删除 ${h.name}`);
                  renderSettings(root, ctx, { tab: "settings-harnesses", preserveScroll: true });
                },
              }, "删除")
            : (hasOverride
                ? el("button", {
                    type: "button",
                    class: "btn btn-sm",
                    onClick: async () => {
                      await api("DELETE", `/api/harnesses/${encodeURIComponent(h.id)}`);
                      toast(`已重置 ${h.name} 为自动检测默认配置`);
                      renderSettings(root, ctx, { tab: "settings-harnesses", preserveScroll: true });
                    },
                  }, "重置")
                : null)
        )
      ),
      testFeedback
    );
  }

  let primaryCount = 0;
  let moreCount = 0;
  harnesses.forEach((h) => {
    const isPrimary = Boolean(h.detected || h.core || h.custom || h.command || (h.configDetected && h.diagnosticHint));
    if (isPrimary) {
      primaryCount++;
      harnessCardsWrap.appendChild(renderHarnessCard(h));
    } else {
      moreCount++;
      moreHarnessCardsWrap.appendChild(renderHarnessCard(h));
    }
  });

  const moreHarnessesDrawer = moreCount > 0
    ? el("details", { style: { marginTop: "6px" } },
        el("summary", { class: "muted", style: { cursor: "pointer", fontSize: "12.5px", userSelect: "none" } },
          `展开更多内置支持的本地 CLI Harness（另有 ${moreCount} 个未检测到）`
        ),
        moreHarnessCardsWrap
      )
    : null;

  const detectedHarnessCount = harnesses.filter((h) => h && h.detected).length;

  const harnessSection = el("section", {
    id: "settings-harnesses",
    class: "card settings-section settings-tabpanel",
    role: "tabpanel",
    "aria-labelledby": "tab-settings-harnesses",
  },
    el("div", { class: "settings-section-head" },
      el("div", null,
        el("h2", { class: "settings-section-title" }, "本地 AI Harness"),
        el("p", { class: "muted settings-section-desc" }, "自动扫描本机 PATH、实时注册表/登录 Shell、npm/Bun/Volta/pnpm/mise/fnm/nvm/Scoop/WinGet/Homebrew 及各 CLI 默认安装目录（涵盖 Antigravity、Claude Code、Codex、OpenCode、Gemini、Kimi、Qwen、Hermes、Grok、omp、Pi 等 20+ 种主流 CLI），按场景自由组合。")
      ),
      el("div", { class: "row", style: { gap: "6px" } },
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => {
            try {
              const r = await api("POST", "/api/harnesses/rescan", {});
              toast(`已重新扫描本机环境：检测到 ${r?.detectedCount ?? 0} 个可用 CLI Harness`);
            } catch {}
            renderSettings(root, ctx, { tab: "settings-harnesses", preserveScroll: true });
          },
        }, "重新检测"),
        el("button", {
          type: "button",
          class: "btn btn-primary btn-sm",
          onClick: () => openHarnessModal(null, () => renderSettings(root, ctx, { tab: "settings-harnesses", preserveScroll: true })),
        }, "+ 添加自定义 CLI")
      )
    ),
    el("div", { class: "settings-subhead" }, "分场景引擎分配（各页面内也可随时临时切换）"),
    sceneRowsWrap,
    el("div", { class: "settings-subhead", style: { marginTop: "6px" } }, `本机 Harness 客户端（已就绪 ${readyHarnessCount} / 已检测 ${detectedHarnessCount} / 内置支持 ${harnesses.length}）`),
    harnessCardsWrap,
    moreHarnessesDrawer
  );

  // 3. Preferences & Storage
  const themeSel = el("select", { id: "pref-theme", name: "theme", class: "select select-sm" },
    el("option", { value: "light", selected: settings.theme === "light" }, "暖纸浅色"),
    el("option", { value: "dark", selected: settings.theme === "dark" }, "夜墨深色"),
    el("option", { value: "system", selected: settings.theme === "system" }, "跟随系统")
  );
  themeSel.addEventListener("change", async () => {
    setColorScheme(themeSel.value);
    await api("PATCH", "/api/settings", { theme: themeSel.value });
    toast("外观主题已切换");
  });

  let savedWorksDir = settings.worksDir || "";
  const worksIn = el("input", {
    id: "pref-works-dir",
    name: "worksDir",
    class: "input",
    style: { flex: "1", minWidth: "200px" },
    autocorrect: "off",
    autocapitalize: "none",
    spellcheck: "false",
    value: savedWorksDir,
  });

  function formatDirBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function applySwitchedWorksDir(res, fallbackDir) {
    const nextDir = res?.settings?.worksDir || fallbackDir;
    savedWorksDir = nextDir;
    worksIn.value = nextDir;
    if (res?.migrated) {
      const skippedPart = res.skippedFiles > 0 ? `（跳过 ${res.skippedFiles} 个同名已存在文件）` : "";
      toast(`已迁移 ${res.movedFiles || 0} 个文件（${formatDirBytes(res.movedBytes)}）并切换作品目录${skippedPart}`);
      prefStatus.textContent = "目录已迁移并切换";
    } else {
      toast("本地作品保存目录已切换，原目录中的历史作品仍可正常浏览");
      prefStatus.textContent = "目录已切换";
    }
  }

  async function promptSwitchWorksDir(targetRaw) {
    const targetDir = String(targetRaw || "").trim();
    if (!targetDir) {
      toast("请选择或输入有效的存储目录");
      return { switched: false, canceled: true };
    }
    const info = await api("POST", "/api/settings/works-dir/inspect", { targetDir });
    if (info.sameDir) {
      savedWorksDir = info.currentDir;
      worksIn.value = info.currentDir;
      return { switched: false, canceled: false };
    }
    // Empty old directory: switch immediately without unnecessary prompt.
    if (!info.hasContent) {
      const res = await api("POST", "/api/settings/works-dir/switch", { targetDir: info.targetDir, migrate: false });
      savedWorksDir = res?.settings?.worksDir || info.targetDir;
      worksIn.value = savedWorksDir;
      prefStatus.textContent = "目录已切换";
      toast("本地作品保存目录已切换");
      return { switched: true, canceled: false };
    }

    // Old directory has content: ask user whether to migrate existing files.
    return new Promise((resolve) => {
      let settled = false;
      let busy = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      const contentSummary = info.fileCount > 0
        ? `共 ${info.fileCount} 个文件，约 ${formatDirBytes(info.totalBytes)}`
        : `共 ${info.dirCount} 个子文件夹`;

      const statusLine = el("p", { class: "muted hidden", style: { margin: 0, fontSize: "12.5px" } });

      const body = el("div", { class: "col works-dir-migrate-modal", style: { gap: "12px" } },
        el("p", { style: { margin: 0, lineHeight: "1.6" } },
          "检测到原作品存储目录中已有内容。是否将原目录中的作品文件一起迁移到新目录？"
        ),
        el("div", { class: "works-dir-summary-box col", style: { gap: "8px" } },
          el("div", { class: "col", style: { gap: "3px" } },
            el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
              el("span", { class: "muted", style: { fontSize: "12px", fontWeight: "600" } }, "原存储目录"),
              el("span", { class: "badge badge-accent" }, contentSummary)
            ),
            el("code", { class: "mono works-dir-path-code" }, info.currentDir)
          ),
          el("div", { class: "col", style: { gap: "3px" } },
            el("span", { class: "muted", style: { fontSize: "12px", fontWeight: "600" } }, "目标存储目录"),
            el("code", { class: "mono works-dir-path-code" }, info.targetDir)
          )
        ),
        info.nested
          ? el("div", { class: "works-dir-warn" }, `⚠ ${info.nestedReason}（此时仅支持「仅切换目录」或更换其他目标目录）`)
          : null,
        info.activeJobs > 0
          ? el("div", { class: "works-dir-warn" }, `⚠ 当前有 ${info.activeJobs} 个进行中的生图任务，请等待任务完成后再执行文件迁移。`)
          : null,
        info.targetHasContent && !info.nested
          ? el("div", { class: "works-dir-hint muted" }, `提示：目标目录中已有 ${info.targetFileCount} 个文件，迁移时遇到同名文件将自动跳过，不会覆盖目标目录已有文件。`)
          : null,
        el("ul", { class: "works-dir-explain muted" },
          el("li", null, el("strong", null, "迁移并切换："), "将原目录内容移动到新目录，并自动更新历史作品的路径索引。"),
          el("li", null, el("strong", null, "仅切换（保留原文件）："), "原目录文件保留不动且历史作品仍可正常查看，后续新作品保存到新目录。")
        ),
        statusLine
      );

      const cancelBtn = el("button", {
        type: "button",
        class: "btn",
        dataset: { role: "works-dir-cancel" },
        onClick: () => {
          if (busy) return;
          worksIn.value = savedWorksDir;
          closeModal();
          finish({ switched: false, canceled: true });
        },
      }, "取消");

      const switchOnlyBtn = el("button", {
        type: "button",
        class: "btn",
        dataset: { role: "works-dir-switch-only" },
        onClick: async () => {
          if (busy) return;
          busy = true;
          cancelBtn.disabled = true;
          switchOnlyBtn.disabled = true;
          migrateBtn.disabled = true;
          switchOnlyBtn.textContent = "切换中…";
          try {
            const res = await api("POST", "/api/settings/works-dir/switch", {
              targetDir: info.targetDir,
              migrate: false,
            });
            applySwitchedWorksDir(res, info.targetDir);
            closeModal();
            finish({ switched: true, canceled: false });
          } catch (err) {
            busy = false;
            cancelBtn.disabled = false;
            switchOnlyBtn.disabled = false;
            migrateBtn.disabled = Boolean(info.nested || info.activeJobs > 0);
            switchOnlyBtn.textContent = "仅切换（保留原文件）";
            statusLine.textContent = err?.message || "切换目录失败";
            statusLine.classList.remove("hidden");
            toast(err?.message || "切换目录失败");
          }
        },
      }, "仅切换（保留原文件）");

      const migrateDisabled = Boolean(info.nested || info.activeJobs > 0);
      const migrateBtn = el("button", {
        type: "button",
        class: "btn btn-primary",
        disabled: migrateDisabled,
        dataset: { role: "works-dir-migrate" },
        onClick: async () => {
          if (busy || migrateDisabled) return;
          busy = true;
          cancelBtn.disabled = true;
          switchOnlyBtn.disabled = true;
          migrateBtn.disabled = true;
          migrateBtn.textContent = "正在迁移文件…";
          statusLine.textContent = "正在迁移原目录内容并更新作品索引，请勿关闭窗口…";
          statusLine.classList.remove("hidden");
          try {
            const res = await api("POST", "/api/settings/works-dir/switch", {
              targetDir: info.targetDir,
              migrate: true,
            });
            applySwitchedWorksDir(res, info.targetDir);
            closeModal();
            finish({ switched: true, canceled: false });
          } catch (err) {
            busy = false;
            cancelBtn.disabled = false;
            switchOnlyBtn.disabled = false;
            migrateBtn.disabled = false;
            migrateBtn.textContent = "迁移原目录内容并切换";
            statusLine.textContent = err?.message || "迁移失败";
            toast(err?.message || "迁移失败");
          }
        },
      }, "迁移原目录内容并切换");

      showModal("切换本地作品保存目录", body, [cancelBtn, switchOnlyBtn, migrateBtn], {
        className: "modal-works-dir-migrate",
        onClose: () => {
          if (!settled) {
            worksIn.value = savedWorksDir;
            finish({ switched: false, canceled: true });
          }
        },
      });
    });
  }

  const pickWorksDirBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    dataset: { role: "pick-works-dir" },
    title: "打开系统文件夹选择器选择存储目录",
    onClick: async () => {
      pickWorksDirBtn.disabled = true;
      const origLabel = pickWorksDirBtn.textContent;
      pickWorksDirBtn.textContent = "选择中…";
      try {
        const picked = await api("POST", "/api/host/pick-directory", {});
        const dir = String(picked?.path || "").trim();
        if (!dir) return;
        worksIn.value = dir;
        await promptSwitchWorksDir(dir);
      } catch (err) {
        toast(err?.message || "无法打开目录选择器，可手动粘贴路径");
      } finally {
        pickWorksDirBtn.disabled = false;
        pickWorksDirBtn.textContent = origLabel;
      }
    },
  }, "📁 选择目录");

  const costYuanIn = el("input", {
    id: "pref-cost-limit",
    name: "costLimitYuan",
    class: "input",
    type: "number",
    step: "0.5",
    min: "0",
    "aria-describedby": "pref-cost-help",
    style: { width: "110px" },
    value: String((settings.costLimitCents || 0) / 100),
  });
  const hotkeyIn = el("input", {
    id: "pref-hotkey",
    name: "quickShotHotkey",
    class: "input",
    style: { width: "140px" },
    autocorrect: "off",
    autocapitalize: "none",
    spellcheck: "false",
    value: settings.quickShotHotkey || "Alt+Space",
  });
  const quickChk = el("input", { id: "pref-quick-enabled", name: "quickShotEnabled", type: "checkbox", checked: Boolean(settings.quickShotEnabled) });
  const trayChk = el("input", { id: "pref-tray", name: "minimizeToTray", type: "checkbox", checked: Boolean(settings.minimizeToTray) });
  const autoUpdChk = el("input", { id: "pref-auto-update", name: "autoCheckUpdate", type: "checkbox", checked: Boolean(settings.autoCheckUpdate) });
  const autoSyncChk = el("input", { id: "pref-auto-sync", name: "autoSyncResources", type: "checkbox", checked: Boolean(settings.autoSyncResources) });
  const publicChk = el("input", { id: "pref-public-gen", name: "publicSiteGenerations", type: "checkbox", checked: !settings.keepSiteGenerationsPrivate });
  const prefStatus = el("span", { class: "muted", role: "status", "aria-live": "polite" });

  const prefForm = el("form", {
    id: "settings-pref-form",
    class: "col",
    style: { gap: "14px" },
    onSubmit: async (e) => {
      e.preventDefault();
      try {
        const nextWorksDir = worksIn.value.trim();
        let dirHandled = false;
        if (nextWorksDir && nextWorksDir !== savedWorksDir) {
          const outcome = await promptSwitchWorksDir(nextWorksDir);
          if (outcome.canceled) return;
          dirHandled = true;
        }
        const payload = {
          costLimitCents: Math.round(Number(costYuanIn.value || 0) * 100),
          quickShotHotkey: hotkeyIn.value.trim(),
          quickShotEnabled: quickChk.checked,
          minimizeToTray: trayChk.checked,
          autoCheckUpdate: autoUpdChk.checked,
          autoSyncResources: autoSyncChk.checked,
          keepSiteGenerationsPrivate: !publicChk.checked,
        };
        if (!dirHandled && nextWorksDir) payload.worksDir = nextWorksDir;
        await api("PATCH", "/api/settings", payload);
        prefStatus.textContent = "已保存";
        if (!dirHandled) toast("偏好设置已保存");
      } catch (err) {
        toast(err.message);
      }
    },
  },
    el("div", { class: "settings-rows" },
      el("div", { class: "settings-row" },
        el("div", { class: "settings-row-meta" },
          el("label", { for: "pref-theme", class: "settings-row-label" }, "界面外观主题"),
          el("span", { class: "muted" }, "暖纸浅色、夜墨深色或跟随系统切换")
        ),
        themeSel
      ),
      el("div", { class: "settings-row" },
        el("div", { class: "settings-row-meta" },
          el("label", { for: "pref-works-dir", class: "settings-row-label" }, "本地作品保存目录"),
          el("span", { class: "muted" }, "所有本地生图原图与缩略图均保存在此目录；切换时若原目录有内容会询问是否迁移")
        ),
        el("div", { class: "row works-dir-input-row", style: { flex: "1", maxWidth: "520px", gap: "6px" } },
          worksIn,
          pickWorksDirBtn,
          el("button", { type: "button", class: "btn btn-sm", onClick: () => api("POST", "/api/open", { path: worksIn.value.trim() }).catch((err) => toast(err.message)) }, "打开目录")
        )
      ),
      el("div", { class: "settings-row" },
        el("div", { class: "settings-row-meta" },
          el("label", { for: "pref-cost-limit", class: "settings-row-label" }, "网站单次费用提醒阈值（元）"),
          el("span", { id: "pref-cost-help", class: "muted" }, "单次预估超出此金额时弹窗确认；设为 0 表示不拦截")
        ),
        costYuanIn
      ),
      el("div", { class: "settings-row" },
        el("div", { class: "settings-row-meta" },
          el("label", { for: "pref-hotkey", class: "settings-row-label" }, "全局快门窗快捷键"),
          el("label", { for: "pref-quick-enabled", class: "row muted", style: { cursor: "pointer" } }, quickChk, "启用全局快门悬浮窗")
        ),
        hotkeyIn
      )
    ),
    el("fieldset", { class: "settings-fieldset" },
      el("legend", null, "窗口、更新与云同步"),
      el("div", { class: "settings-checks" },
        el("label", { for: "pref-tray", class: "settings-check" }, trayChk, el("span", null, "关闭主窗口时最小化到系统托盘")),
        el("label", { for: "pref-auto-update", class: "settings-check" }, autoUpdChk, el("span", null, "自动检查软件更新")),
        el("label", { for: "pref-auto-sync", class: "settings-check" }, autoSyncChk, el("span", null, "登录后自动同步自定义画风")),
        el("label", { for: "pref-public-gen", class: "settings-check" }, publicChk, el("span", null, "网站模型生成的图片自动公开到社区（用了自己参考图的除外）"))
      )
    ),
    el("div", { class: "row", style: { justifyContent: "space-between" } },
      el("div", { class: "row" },
        el("button", { type: "submit", class: "btn btn-primary btn-sm" }, "保存偏好设置"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => {
            try {
              const r = await api("POST", "/api/mine/sync");
              toast(r.ok ? `已同步 ${r.pushed || 0} 个自定义资源` : (r.message || r.error || "同步完成"));
            } catch (err) {
              toast(err.message);
            }
          },
        }, "🔄 立即同步自定义画风/图型")
      ),
      prefStatus
    )
  );

  let curClipToken = settRes.clipToken || settings.clipToken || "";
  const curClipEndpoint = String(settRes.clipEndpoint || location.origin)
    .replace(/\/api\/inspirations\/clip\/?$/i, "")
    .replace(/\/+$/, "");
  const curClipExtDir = settRes.clipExtensionDir || "";
  const curClipExtExists = settRes.clipExtensionExists;
  const clipTokenDisplay = el("code", { class: "mono muted", style: { fontSize: "12px", wordBreak: "break-all" } }, curClipToken || "尚未生成");

  const clipperCard = el("div", { class: "card col", style: { gap: "8px", marginTop: "6px", background: "var(--paper)" } },
    el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } },
      el("div", { class: "col", style: { gap: "2px" } },
        el("strong", null, "🧩 Chrome 灵感捕手扩展配对"),
        el("span", { class: "muted" }, "配合浏览器扩展从 X (Twitter) 与任意网页一键收藏图片和提示词到本机灵感库")
      ),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => openClipperSetupModal({
          clipToken: curClipToken,
          clipEndpoint: curClipEndpoint,
          clipExtensionDir: curClipExtDir,
          clipExtensionExists: curClipExtExists,
        }),
      }, "查看安装指引")
    ),
    el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px" } },
      el("div", { class: "col", style: { gap: "2px", minWidth: 0, flex: "1" } },
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, `桥接地址：${curClipEndpoint}`),
        clipTokenDisplay
      ),
      el("div", { class: "row", style: { gap: "6px" } },
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: async () => toast((await copyText(curClipToken)) ? "已复制配对 Token" : "复制失败"),
        }, "复制 Token"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => {
            try {
              const r = await api("POST", "/api/settings/clip-token/rotate", {});
              if (r.clipToken) {
                curClipToken = r.clipToken;
                clipTokenDisplay.textContent = curClipToken;
                toast("已重置配对 Token");
              }
            } catch (e) { toast(e.message); }
          },
        }, "重置")
      )
    )
  );

  const prefSection = el("section", {
    id: "settings-preferences",
    class: "card settings-section",
    role: "tabpanel",
    "aria-labelledby": "tab-settings-preferences",
    tabindex: "0",
  },
    el("div", { class: "settings-section-head" },
      el("div", { class: "col", style: { gap: "2px" } },
        el("h2", { class: "settings-section-title" }, "通用偏好与本地存储"),
        el("p", { class: "muted", style: { margin: 0 } }, "外观配色、本地作品目录、费用保护阈值、托盘快捷键与浏览器扩展配对")
      )
    ),
    prefForm,
    clipperCard
  );

  // 4. Version, Built-in Handraw Skill & Incremental Resource Updates
  const builtinSkill = (Array.isArray(skillsRes?.items) ? skillsRes.items : []).find((sk) => sk.builtin || sk.id === "handraw-skill") || null;
  const hasAnyUpdate = Boolean(updRes.available || updRes.ready || updRes.resourceNew || builtinSkill?.updateAvailable);
  let dlPollTimer = null;
  let updatingResourcesInline = false;
  let updatingSkillInline = false;

  function setInlineActionBtn(btn, state, label, pct = 0, titleText = "") {
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

  const checkUpdBtn = el("button", {
    type: "button",
    class: "btn btn-sm btn-update-inline",
    onClick: async () => {
      setInlineActionBtn(checkUpdBtn, "busy", "检查更新中…", 20);
      try {
        const r = await api("POST", "/api/update/check");
        const st = r?.status || {};
        const skUpd = Boolean(r?.skill?.updateAvailable);
        if (st.available || st.ready || st.resourceNew || skUpd) {
          const msg = st.available
            ? `发现新版 ${st.latest || ""}`.trim()
            : (skUpd ? "发现手绘 Skill 更新" : "发现资源更新");
          setInlineActionBtn(checkUpdBtn, "done", msg, 100);
          setTimeout(() => {
            if (root.isConnected && root._settingsRenderSeq === seq) {
              renderSettings(root, ctx, { tab: "settings-updates", preserveScroll: true });
            }
          }, 900);
        } else if (r?.error) {
          setInlineActionBtn(checkUpdBtn, "error", "检查失败，重试", 0, r.error);
        } else {
          setInlineActionBtn(checkUpdBtn, "done", "已是最新版本", 100);
          setTimeout(() => {
            if (root.isConnected && root._settingsRenderSeq === seq) {
              setInlineActionBtn(checkUpdBtn, "idle", "检查版本与资源更新", 0);
            }
          }, 1800);
        }
      } catch (e) {
        setInlineActionBtn(checkUpdBtn, "error", "检查失败，重试", 0, e?.message || "检查失败");
      }
    },
  }, "检查版本与资源更新");

  let dlUpdBtn = null;
  function startDownloadPoll() {
    clearInterval(dlPollTimer);
    dlPollTimer = setInterval(async () => {
      if (!root.isConnected || root._settingsRenderSeq !== seq) {
        clearInterval(dlPollTimer);
        return;
      }
      const cur = await api("GET", "/api/update").catch(() => null);
      if (!cur || !dlUpdBtn) return;
      if (cur.ready) {
        clearInterval(dlPollTimer);
        setInlineActionBtn(dlUpdBtn, "done", "下载完成", 100);
        setTimeout(() => {
          if (root.isConnected && root._settingsRenderSeq === seq) {
            renderSettings(root, ctx, { tab: "settings-updates", preserveScroll: true });
          }
        }, 700);
      } else if (cur.downloading) {
        const pct = Math.max(0, Math.min(100, Number(cur.progress || 0)));
        setInlineActionBtn(dlUpdBtn, "busy", pct > 0 ? `下载中 ${pct}%` : "下载更新中…", pct);
      } else if (cur.error) {
        clearInterval(dlPollTimer);
        setInlineActionBtn(dlUpdBtn, "error", "下载失败，重试", 0, cur.error);
      } else {
        clearInterval(dlPollTimer);
        setInlineActionBtn(dlUpdBtn, "idle", "下载客户端更新", 0);
      }
    }, 600);
  }

  if (updRes.available) {
    dlUpdBtn = el("button", {
      type: "button",
      class: "btn btn-sm btn-primary btn-update-inline",
      onClick: async () => {
        setInlineActionBtn(dlUpdBtn, "busy", "准备下载…", 8);
        try {
          await api("POST", "/api/update/download");
          startDownloadPoll();
        } catch (e) {
          setInlineActionBtn(dlUpdBtn, "error", "下载失败，重试", 0, e?.message || "下载失败");
        }
      },
    }, "下载客户端更新");
    if (updRes.downloading) {
      const pct = Math.max(0, Math.min(100, Number(updRes.progress || 0)));
      setInlineActionBtn(dlUpdBtn, "busy", pct > 0 ? `下载中 ${pct}%` : "下载更新中…", pct);
      startDownloadPoll();
    }
  }

  const applyUpdBtn = updRes.ready ? el("button", {
    type: "button",
    class: "btn btn-sm btn-primary btn-update-inline",
    onClick: async () => {
      setInlineActionBtn(applyUpdBtn, "busy", "正在重启升级…", 100);
      try {
        await api("POST", "/api/update/apply");
      } catch (e) {
        setInlineActionBtn(applyUpdBtn, "error", "升级失败，重试", 0, e?.message || "升级失败");
      }
    },
  }, "重启完成升级") : null;

  const resUpdBtn = el("button", {
    type: "button",
    class: "btn btn-sm btn-update-inline",
    onClick: async () => {
      if (updatingResourcesInline) return;
      updatingResourcesInline = true;
      setInlineActionBtn(resUpdBtn, "busy", "更新资源中…", 10);
      try {
        const r = await api("POST", "/api/update/resources");
        updatingResourcesInline = false;
        setInlineActionBtn(resUpdBtn, "done", r?.updated ? `已更新 ${r.changed || 0} 项` : "已是最新资源", 100);
        setTimeout(() => {
          if (root.isConnected && root._settingsRenderSeq === seq) {
            renderSettings(root, ctx, { tab: "settings-updates", preserveScroll: true });
          }
        }, 1400);
      } catch (e) {
        updatingResourcesInline = false;
        setInlineActionBtn(resUpdBtn, "error", "更新失败，重试", 0, e?.message || "资源更新失败");
      }
    },
  }, "增量更新资源包");

  const skillUpdBtn = el("button", {
    type: "button",
    class: "btn btn-sm btn-update-inline",
    id: "btn-update-handraw-skill",
    onClick: async () => {
      if (updatingSkillInline) return;
      updatingSkillInline = true;
      setInlineActionBtn(skillUpdBtn, "busy", "更新手绘 Skill…", 35);
      try {
        const r = await api("POST", "/api/skills/handraw-skill/update");
        updatingSkillInline = false;
        const ver = r?.version ? ` v${r.version}` : "";
        setInlineActionBtn(skillUpdBtn, "done", r?.updated ? `已热更新${ver}` : `已是最新${ver}`, 100);
        setTimeout(() => {
          if (root.isConnected && root._settingsRenderSeq === seq) {
            renderSettings(root, ctx, { tab: "settings-updates", preserveScroll: true });
          }
        }, 1400);
      } catch (e) {
        updatingSkillInline = false;
        setInlineActionBtn(skillUpdBtn, "error", "Skill 更新失败，重试", 0, e?.message || "手绘 Skill 更新失败");
      }
    },
  }, builtinSkill?.updateAvailable && builtinSkill?.latestVersion ? `更新手绘 Skill (v${builtinSkill.latestVersion})` : "更新手绘 Skill");

  const updSection = el("section", {
    id: "settings-updates",
    class: "card settings-section",
    role: "tabpanel",
    "aria-labelledby": "tab-settings-updates",
    tabindex: "0",
  },
    el("div", { class: "settings-section-head" },
      el("div", { class: "col", style: { gap: "2px" } },
        el("h2", { class: "settings-section-title" }, "客户端版本与资源包更新"),
        el("p", { class: "muted", style: { margin: 0 } }, "检查客户端新版发布、内置手绘 Skill 在线热更新与画风/图型资源包增量同步")
      ),
      hasAnyUpdate ? el("span", { class: "badge badge-accent" }, "发现可更新内容") : el("span", { class: "badge" }, `v${updRes.current || "?"}`)
    ),
    el("div", { class: "settings-economy-grid" },
      el("div", { class: "economy-stat" },
        el("span", { class: "muted" }, "客户端当前版本"),
        el("strong", { class: "mono" }, updRes.current || "?")
      ),
      el("div", { class: "economy-stat" },
        el("span", { class: "muted" }, "远端最新版本"),
        el("strong", { class: "mono" }, updRes.latest || "未检查")
      ),
      el("div", { class: "economy-stat" },
        el("span", { class: "muted" }, "本地资源包"),
        el("strong", { class: "mono" }, `${updRes.resourceLocal || "?"}${updRes.resourceNew ? " → " + updRes.resourceNew : ""}`)
      ),
      el("div", { class: "economy-stat" },
        el("span", { class: "muted" }, "内置手绘 Skill"),
        el("strong", { class: "mono" }, builtinSkill
          ? `v${builtinSkill.version || "?"}${builtinSkill.updateAvailable && builtinSkill.latestVersion ? " → v" + builtinSkill.latestVersion : ""}`
          : "未加载")
      )
    ),
    el("div", { class: "row" },
      checkUpdBtn,
      dlUpdBtn,
      applyUpdBtn,
      resUpdBtn,
      skillUpdBtn
    )
  );

  // Two-column settings shell: left tab list + single active panel on the right
  const tabDefs = [
    { id: "settings-account", label: "账户与资产", meta: accRes.loggedIn ? "已登录" : "未登录", panel: accSection },
    { id: "settings-models", label: "第三方接口", meta: providers.length ? `${providers.length} 个接口` : "未配置", panel: provSection },
    { id: "settings-harnesses", label: "本地 Harness", meta: readyHarnessCount ? `${readyHarnessCount} 个就绪` : "未检测", panel: harnessSection },
    { id: "settings-preferences", label: "通用偏好与存储", meta: "", panel: prefSection },
    { id: "settings-updates", label: "版本与资源更新", meta: hasAnyUpdate ? "有更新" : (updRes.current || ""), panel: updSection },
  ];

  const navButtons = [];
  const nav = el("div", { class: "settings-nav", role: "tablist", "aria-label": "设置分组", "aria-orientation": "vertical" });
  const content = el("div", { class: "settings-content" },
    accSection,
    provSection,
    harnessSection,
    prefSection,
    updSection
  );

  function activateTab(tabId, { focusTab = false, resetScroll = false } = {}) {
    if (!VALID_SETTINGS_TABS.has(tabId)) tabId = tabDefs[0].id;
    activeSettingsTab = tabId;
    tabDefs.forEach((def, idx) => {
      const isCurrent = def.id === tabId;
      const btn = navButtons[idx];
      btn.classList.toggle("is-active", isCurrent);
      btn.setAttribute("aria-selected", String(isCurrent));
      btn.tabIndex = isCurrent ? 0 : -1;
      def.panel.hidden = !isCurrent;
      if (isCurrent && focusTab) btn.focus();
    });
    if (resetScroll) {
      scrollContainerEl.scrollTop = 0;
    }
  }

  tabDefs.forEach((item, index) => {
    const btn = el("button", {
      type: "button",
      id: `tab-${item.id}`,
      class: "settings-nav-link",
      role: "tab",
      "aria-controls": item.id,
      "aria-selected": "false",
      dataset: { target: item.id },
      onClick: () => activateTab(item.id, { resetScroll: true }),
      onKeydown: (e) => {
        let nextIdx = -1;
        if (e.key === "ArrowDown" || e.key === "ArrowRight") nextIdx = (index + 1) % tabDefs.length;
        else if (e.key === "ArrowUp" || e.key === "ArrowLeft") nextIdx = (index - 1 + tabDefs.length) % tabDefs.length;
        else if (e.key === "Home") nextIdx = 0;
        else if (e.key === "End") nextIdx = tabDefs.length - 1;
        if (nextIdx >= 0) {
          e.preventDefault();
          activateTab(tabDefs[nextIdx].id, { focusTab: true, resetScroll: true });
        }
      },
    },
      el("span", { class: "settings-nav-title" }, item.label),
      item.meta ? el("span", { class: "settings-nav-meta" }, item.meta) : null
    );
    navButtons.push(btn);
    nav.appendChild(btn);
  });

  const shell = el("div", { class: "settings-shell" }, nav, content);
  root.appendChild(shell);

  activateTab(activeSettingsTab, { resetScroll: savedScrollTop === null });

  if (savedScrollTop !== null) {
    requestAnimationFrame(() => {
      scrollContainerEl.scrollTop = savedScrollTop;
    });
  }

  const onReturnFocus = () => {
    if (document.visibilityState === "hidden") return;
    triggerImmediateLoginCheck(false);
  };
  window.addEventListener("focus", onReturnFocus);
  document.addEventListener("visibilitychange", onReturnFocus);

  const cleanup = () => {
    stopLoginTimers();
    clearInterval(dlPollTimer);
    window.removeEventListener("focus", onReturnFocus);
    document.removeEventListener("visibilitychange", onReturnFocus);
    unsub();
  };
  const unsub = onEvent((msg) => {
    if (!root.isConnected || root._settingsRenderSeq !== seq) {
      cleanup();
      return;
    }
    if (msg.type === "resource_update") {
      const done = Number(msg.data?.done || 0);
      const total = Number(msg.data?.total || 0);
      const pct = total > 0 ? Math.round((done / total) * 100) : 25;
      setInlineActionBtn(resUpdBtn, "busy", total > 0 ? `更新中 ${done}/${total}` : "更新资源中…", pct);
    } else if (msg.type === "account") {
      const data = msg.data || {};
      if (data.status === "pending" || data.status === "syncing" || data.status === "ok" || data.status === "error" || data.status === "idle") {
        applyLoginState(data);
      } else if (data.loggedIn) {
        finishLoginTransition(data.user);
      }
    } else if (msg.type === "balance") {
      if (completingLogin || currentLoginState?.active) return;
      ctx.refreshTopbar?.(true);
      renderSettings(root, ctx, { preserveScroll: true });
    }
  });
  root._settingsCleanup = cleanup;
}

function looksImageModelId(id) {
  const s = String(id || "").toLowerCase().trim();
  if (!s) return false;
  if (s.includes("image-to-text") || s.includes("image-caption")) return false;
  return /(image|dall-e|dalle|flux|stable-diffusion|sdxl|sd3|sd-xl|sd_xl|sd-1\.|sd-2\.|seedream|jimeng|kolors|imagen|midjourney|mj-|mj_|ideogram|recraft|nano-banana|gpt-image|wanx|cogview|playground-v|kandinsky|z-image)/.test(s);
}

function looksVisionModelId(id) {
  const s = String(id || "").toLowerCase().trim();
  if (!s) return false;
  if (looksImageModelId(s)) return false;
  if (/(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision|gpt-5|claude-3|claude-4|claude-sonnet-4|claude-opus-4|claude-haiku-4|gemini-1\.5|gemini-2|gemini-3|gemma-3|deepseek-vl|deepseek-v4|deepseek-flash-4|deepseek-4|qwen.*vl|qwen3\.5|qwen-omni|qvq|glm-4.*v|glm-4\.5|glm-4\.6|glm-5|doubao.*vision|doubao-seed|kimi-vl|kimi-k2\.5|step-1v|step-1o|minimax-01|minimax-vl|internvl|minicpm-v|pixtral|mistral-small-3\.1|llama-3\.2-.*vision|llama-4|grok-2-vision|grok-3|grok-4|vision|-vl|_vl|multimodal|omni)/.test(s)) {
    return true;
  }
  return /(^|[/:._-])(o1|o3|o4)($|[/:._-])/.test(s);
}

function resolveModelKind(prov, model) {
  const k = String(model?.kind || "").toLowerCase().trim();
  if (k === "image") return "image";
  if (k === "text" || k === "vision") return "text";
  const purp = String(prov?.purpose || "").toLowerCase().trim();
  if (purp === "image") return "image";
  if (purp === "text" || purp === "vision") return "text";
  return looksImageModelId(model?.id) ? "image" : "text";
}

function openProviderModal(existing, onSaved) {
  const isNew = !existing;
  const prov = existing ? structuredClone(existing) : { id: "", name: "", kind: "openai", purpose: "all", baseUrl: "", enabled: true, models: [] };
  if (!Array.isArray(prov.models)) prov.models = [];
  // Normalize existing models so each carries explicit kind ("image" | "text")
  prov.models = prov.models.map((m) => {
    const kind = resolveModelKind(prov, m);
    return {
      ...m,
      kind,
      canVision: kind === "text" ? Boolean(m.canVision) : false,
      canRefImage: kind === "image" ? Boolean(m.canRefImage) : false,
      canEdit: kind === "image" ? Boolean(m.canEdit) : false,
    };
  });

  const nameIn = el("input", { class: "input", value: prov.name || "", placeholder: "例如：OpenRouter / OneAPI / 火山方舟" });
  const urlIn = el("input", { class: "input", value: prov.baseUrl || "", placeholder: "https://api.example.com/v1", autocorrect: "off", autocapitalize: "none", spellcheck: "false" });
  const keyIn = el("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: prov.hasKey ? "留空则保留现有密钥" : "输入 API Key（存入系统凭据库）" });

  const selectedCountBadge = el("span", { class: "badge" }, `已勾选 ${prov.models.length} 个`);
  const tagSearchIn = el("input", {
    class: "input",
    placeholder: "搜索模型标签…",
    autocorrect: "off",
    autocapitalize: "none",
    spellcheck: "false",
  });
  const filterPillsWrap = el("div", { class: "provider-filter-pills" });
  const tagGrid = el("div", { class: "model-tag-grid" });
  const tagHint = el("div", { class: "muted", style: { fontSize: "12px" } });
  const tagToolbar = el("div", { class: "provider-tag-toolbar hidden" }, tagSearchIn, filterPillsWrap);

  // Manual model quick-add row (handles unlisted custom/private model IDs)
  const manualIdIn = el("input", {
    class: "input",
    placeholder: "手动添加未列出的模型 ID（如 gpt-image-1 / gemini-2.5-pro）…",
    autocorrect: "off",
    autocapitalize: "none",
    spellcheck: "false",
    style: { flex: "1", minWidth: "180px" },
  });
  const manualKindSel = el("select", { class: "select select-sm", "aria-label": "手动添加模型类型" },
    el("option", { value: "auto" }, "自动识别类型"),
    el("option", { value: "image" }, "🎨 生图模型"),
    el("option", { value: "text" }, "💬 文字/视觉模型")
  );
  const addManualModel = () => {
    const id = manualIdIn.value.trim();
    if (!id) return;
    const picked = manualKindSel.value;
    const kind = picked === "auto" ? (looksImageModelId(id) ? "image" : "text") : picked;
    if (addModelEntry(id, { kind, isImage: kind === "image", canVision: kind === "text" && looksVisionModelId(id) })) {
      manualIdIn.value = "";
      syncModelSelectionUI();
      toast(`已添加 ${kind === "image" ? "生图" : "文字/视觉"} 模型：${id}`);
    } else {
      toast("该模型已在勾选列表中");
    }
  };
  manualIdIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addManualModel();
    }
  });
  const manualRow = el("div", { class: "provider-manual-row" },
    manualIdIn,
    manualKindSel,
    el("button", { type: "button", class: "btn btn-sm", onClick: addManualModel }, "+ 手动添加")
  );

  const tagPanel = el("div", { class: "provider-tag-panel" }, tagToolbar, tagGrid, tagHint, manualRow);

  const selectedHead = el("div", { class: "provider-selected-head hidden" });
  const modelsWrap = el("div", { class: "col", style: { gap: "6px", maxHeight: "220px", overflowY: "auto" } });

  let fetchedModels = [];
  let fetchQuery = "";
  let activeFilter = "all"; // all | image | text | vision | selected
  let fetching = false;
  const testStates = new Map();
  const testViews = new Map();
  let testTimer = null;
  let dialogClosed = false;

  const hasRunningTest = () => [...testStates.values()].some((test) => test.running);
  const elapsedLabel = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)} 秒`;

  function stopTestClock() {
    clearInterval(testTimer);
    testTimer = null;
  }

  function revealTestFeedback(id) {
    requestAnimationFrame(() => {
      if (!dialogClosed) testViews.get(id)?.feedback.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function updateTestViews() {
    if (dialogClosed) return;
    const busy = hasRunningTest();
    for (const [id, view] of testViews) {
      const test = testStates.get(id);
      view.button.disabled = busy;
      view.button.textContent = test?.running ? "测试中…" : "测试";
      view.button.setAttribute("aria-busy", String(Boolean(test?.running)));
      view.remove.disabled = Boolean(test?.running);
      view.feedback.hidden = !test;
      view.progress.hidden = !test?.running;
      view.elapsed.hidden = !test?.running;
      view.message.textContent = test?.message || "";
      view.feedback.dataset.state = test?.running ? "running" : test?.ok ? "success" : "error";
      view.detail.textContent = test?.detail || "";
      view.detail.hidden = !test?.detail;
      if (test?.running) view.elapsed.textContent = `已等待 ${elapsedLabel(performance.now() - test.startedAt)}`;
    }
  }

  function validateBeforeSave() {
    if (!nameIn.value.trim()) {
      nameIn.focus();
      throw new Error("请填写接口名称");
    }
    if (!urlIn.value.trim()) {
      urlIn.focus();
      throw new Error("请填写 Base URL");
    }
    if (!(prov.models || []).length) {
      throw new Error("请先拉取模型并勾选至少一个模型（或手动添加模型 ID）");
    }
  }

  function derivePurpose() {
    const hasImg = (prov.models || []).some((m) => m.kind === "image");
    const hasTxt = (prov.models || []).some((m) => m.kind !== "image");
    if (hasImg && hasTxt) return "all";
    if (hasImg) return "image";
    if (hasTxt) return "text";
    return "all";
  }

  async function saveProviderPayload() {
    validateBeforeSave();
    prov.name = nameIn.value.trim();
    prov.purpose = derivePurpose();
    prov.baseUrl = urlIn.value.trim();
    const res = await api("POST", "/api/providers", { ...prov, apiKey: keyIn.value.trim() });
    const latest = (res.providers || []).find((x) => x.name === prov.name && x.baseUrl === prov.baseUrl) || (res.providers || []).slice(-1)[0];
    if (!prov.id && latest?.id) prov.id = latest.id;
    return res;
  }

  async function testModel(model) {
    if (hasRunningTest()) return;
    const isText = model.kind !== "image";
    const vision = isText && Boolean(model.canVision);
    const mode = isText ? (vision ? "视觉识图" : "文字/视觉探测") : "生图模型";
    const test = { running: true, startedAt: performance.now(), message: "正在准备测试…", detail: "" };
    testStates.set(model.id, test);
    updateTestViews();
    revealTestFeedback(model.id);
    stopTestClock();
    testTimer = setInterval(() => {
      if (dialogClosed) { stopTestClock(); return; }
      const view = testViews.get(model.id);
      if (view) view.elapsed.textContent = `已等待 ${elapsedLabel(performance.now() - test.startedAt)}`;
    }, 1000);
    try {
      await saveProviderPayload();
      test.message = isText ? "正在实测文字与视觉识图能力，等待接口返回…" : "正在测试生图模型，等待接口返回…";
      updateTestViews();
      const result = await api("POST", `/api/providers/${encodeURIComponent(prov.id)}/test`, {
        model: model.id,
        kind: isText ? "text" : "image",
        vision,
        autoProbeVision: isText,
      });
      test.ok = Boolean(result.ok);
      const latency = Number.isFinite(result.latencyMs) ? result.latencyMs : performance.now() - test.startedAt;
      if (!test.ok) {
        test.message = `${mode}测试失败 · 用时 ${elapsedLabel(latency)}`;
        test.detail = result.error || "接口未返回具体失败原因";
      } else if (isText && typeof result.visionDetected === "boolean") {
        let capabilityChanged = false;
        if (result.visionDetected && !model.canVision) {
          model.canVision = true;
          capabilityChanged = true;
          test.message = `文字 + 视觉识图测试成功（已自动勾选视觉识图）· 用时 ${elapsedLabel(latency)}`;
        } else if (!result.visionDetected && model.canVision) {
          model.canVision = false;
          capabilityChanged = true;
          test.message = `纯文字可用，但不支持视觉识图（已自动取消勾选）· 用时 ${elapsedLabel(latency)}`;
        } else if (result.visionDetected) {
          test.message = `视觉识图测试成功 · 用时 ${elapsedLabel(latency)}`;
        } else {
          test.message = `纯文字模型测试成功（不支持视觉识图）· 用时 ${elapsedLabel(latency)}`;
        }
        const detailLines = [];
        if (result.reply) {
          detailLines.push(`模型回复：\n${typeof result.reply === "string" ? result.reply : JSON.stringify(result.reply, null, 2)}`);
        }
        if (!result.visionDetected && result.visionError) {
          detailLines.push(`视觉探测反馈：${result.visionError}`);
        }
        test.detail = detailLines.join("\n\n") || "接口已正常响应";
        if (capabilityChanged) {
          await saveProviderPayload().catch(() => {});
          syncModelSelectionUI();
        }
      } else {
        test.message = `${mode}测试成功 · 用时 ${elapsedLabel(latency)}`;
        if (result.reply) test.detail = `模型回复：\n${typeof result.reply === "string" ? result.reply : JSON.stringify(result.reply, null, 2)}`;
        else if (result.imagesCount !== undefined) test.detail = `接口返回 ${result.imagesCount} 张测试图片`;
        else test.detail = "接口已正常响应";
      }
    } catch (error) {
      test.ok = false;
      test.message = `${mode}测试失败 · 用时 ${elapsedLabel(performance.now() - test.startedAt)}`;
      test.detail = error.message || "请求失败，请重试";
    } finally {
      test.running = false;
      stopTestClock();
      updateTestViews();
      revealTestFeedback(model.id);
    }
  }

  function addModelEntry(id, meta = {}) {
    const cleanId = String(id || "").trim();
    if (!cleanId) return false;
    if ((prov.models || []).some((m) => m.id === cleanId)) return false;
    const kind = meta.kind === "image" || meta.kind === "text"
      ? meta.kind
      : (meta.isImage || looksImageModelId(cleanId) ? "image" : "text");
    const isText = kind === "text";
    prov.models.push({
      id: cleanId,
      label: cleanId,
      kind,
      canRefImage: !isText && Boolean(meta.canRefImage),
      canEdit: !isText && Boolean(meta.canEdit),
      canVision: isText ? (meta.canVision !== undefined ? Boolean(meta.canVision) : looksVisionModelId(cleanId)) : false,
    });
    return true;
  }

  function removeModelEntry(id) {
    const idx = (prov.models || []).findIndex((m) => m.id === id);
    if (idx < 0) return false;
    prov.models.splice(idx, 1);
    testStates.delete(id);
    return true;
  }

  function toggleModelEntry(item) {
    const exists = (prov.models || []).some((m) => m.id === item.id);
    if (exists) {
      removeModelEntry(item.id);
    } else {
      addModelEntry(item.id, { isImage: item.isImage, canVision: item.isVision });
    }
    syncModelSelectionUI();
  }

  function buildCatalog() {
    const map = new Map();
    for (const item of fetchedModels) {
      map.set(item.id, item);
    }
    for (const m of prov.models || []) {
      const isImg = m.kind === "image";
      if (!map.has(m.id)) {
        map.set(m.id, {
          id: m.id,
          isImage: isImg,
          isVision: !isImg && (Boolean(m.canVision) || looksVisionModelId(m.id)),
        });
      }
    }
    return [...map.values()];
  }

  function updateSelectedCount() {
    const list = prov.models || [];
    const imgCnt = list.filter((m) => m.kind === "image").length;
    const txtCnt = list.length - imgCnt;
    if (list.length === 0) {
      selectedCountBadge.textContent = "未勾选模型";
      selectedCountBadge.className = "badge";
    } else {
      const parts = [];
      if (imgCnt > 0) parts.push(`生图 ${imgCnt}`);
      if (txtCnt > 0) parts.push(`文字/视觉 ${txtCnt}`);
      selectedCountBadge.textContent = `已选 ${list.length}（${parts.join(" · ")}）`;
      selectedCountBadge.className = "badge badge-ok";
    }
  }

  function renderTagGrid() {
    clear(filterPillsWrap);
    clear(tagGrid);

    const selectedById = new Map((prov.models || []).map((m) => [m.id, m]));
    const catalog = buildCatalog();

    if (!catalog.length) {
      tagToolbar.classList.add("hidden");
      tagHint.textContent = "填好 Base URL 与 API Key 后点击「🔍 拉取模型」，即可在同一接口下同时勾选生图模型与文字/视觉解析模型。";
      return;
    }

    tagToolbar.classList.remove("hidden");

    const imgList = catalog.filter((m) => m.isImage);
    const txtList = catalog.filter((m) => !m.isImage);
    const visList = catalog.filter((m) => !m.isImage && m.isVision);
    const filterItems = [
      { id: "all", label: `全部 (${catalog.length})` },
      ...(imgList.length ? [{ id: "image", label: `🎨 生图 (${imgList.length})` }] : []),
      ...(txtList.length ? [{ id: "text", label: `💬 文字 (${txtList.length})` }] : []),
      ...(visList.length ? [{ id: "vision", label: `👁 视觉识图 (${visList.length})` }] : []),
      { id: "selected", label: `已勾选 (${selectedById.size})` },
    ];
    if (!filterItems.some((f) => f.id === activeFilter)) activeFilter = "all";

    filterItems.forEach((f) => {
      filterPillsWrap.appendChild(el("button", {
        type: "button",
        class: "provider-filter-pill" + (activeFilter === f.id ? " is-active" : ""),
        onClick: () => {
          activeFilter = f.id;
          renderTagGrid();
        },
      }, f.label));
    });

    if (selectedById.size > 0) {
      filterPillsWrap.appendChild(el("button", {
        type: "button",
        class: "provider-filter-pill",
        onClick: () => {
          prov.models = [];
          testStates.clear();
          syncModelSelectionUI();
        },
      }, "清空勾选"));
    }

    const q = fetchQuery.trim().toLowerCase();
    let visible = catalog.filter((m) => !q || m.id.toLowerCase().includes(q));
    if (activeFilter === "image") {
      visible = visible.filter((m) => m.isImage);
    } else if (activeFilter === "text") {
      visible = visible.filter((m) => !m.isImage);
    } else if (activeFilter === "vision") {
      visible = visible.filter((m) => !m.isImage && m.isVision);
    } else if (activeFilter === "selected") {
      visible = visible.filter((m) => selectedById.has(m.id));
    }

    const shown = visible.slice(0, 120);
    if (!shown.length) {
      tagGrid.appendChild(el("span", { class: "muted", style: { fontSize: "12px", padding: "4px 2px" } }, "没有匹配的模型标签，可在下方手动输入模型 ID 添加"));
    } else {
      shown.forEach((m) => {
        const picked = selectedById.get(m.id);
        const checked = Boolean(picked);
        const effImg = picked ? picked.kind === "image" : m.isImage;
        const effVis = picked ? (!effImg && Boolean(picked.canVision)) : (!effImg && Boolean(m.isVision));
        const kindLabel = effImg ? "生图" : (effVis ? "识图" : "文字");
        const srcHint = m.capabilitySource === "metadata" ? "接口元数据声明" : "按模型名预估（勾选后点「测试」可自动实测校正识图能力）";
        tagGrid.appendChild(el("button", {
          type: "button",
          class: "model-tag-chip" + (checked ? " is-checked" : ""),
          "aria-pressed": String(checked),
          title: `${m.id} · ${kindLabel}（${srcHint}）`,
          dataset: { modelId: m.id },
          onClick: () => toggleModelEntry(m),
        },
          el("span", { class: "model-tag-check", "aria-hidden": "true" }, checked ? "✓" : ""),
          el("span", { class: "model-tag-id mono" }, m.id),
          el("span", { class: "model-tag-kind" + (effImg ? " is-img" : "") }, kindLabel)
        ));
      });
    }

    if (!fetchedModels.length) {
      tagHint.textContent = "当前展示已勾选模型；点击「🔍 拉取模型」可刷新远端列表并同时勾选生图与文字/视觉模型。";
    } else if (visible.length > 120) {
      tagHint.textContent = `当前展示前 120 个标签（共匹配 ${visible.length} 个），请输入关键词筛选；勾选后可在下方随时切换「生图 / 文字」归类。`;
    } else {
      tagHint.textContent = "点击标签打勾选择，系统会自动识别生图或文字/视觉类型；如识别有误可在下方一键切换。";
    }
  }

  function renderSelectedModels() {
    clear(modelsWrap);
    testViews.clear();
    const list = prov.models || [];
    if (!list.length) {
      selectedHead.classList.add("hidden");
      return;
    }
    const imgCnt = list.filter((m) => m.kind === "image").length;
    const txtCnt = list.length - imgCnt;
    selectedHead.classList.remove("hidden");
    selectedHead.textContent = `已勾选模型能力配置与实测（共 ${list.length} 个：生图 ${imgCnt} · 文字/视觉 ${txtCnt}）`;

    list.forEach((m) => {
      const isText = m.kind !== "image";
      const kindSwitch = el("div", { class: "provider-kind-switch", role: "group", "aria-label": `${m.id} 类型` },
        el("button", {
          type: "button",
          class: "provider-kind-btn" + (!isText ? " is-active" : ""),
          "aria-pressed": String(!isText),
          onClick: () => {
            if (m.kind === "image") return;
            m.kind = "image";
            m.canVision = false;
            syncModelSelectionUI();
          },
        }, "🎨 生图"),
        el("button", {
          type: "button",
          class: "provider-kind-btn" + (isText ? " is-active" : ""),
          "aria-pressed": String(isText),
          onClick: () => {
            if (m.kind === "text") return;
            m.kind = "text";
            m.canRefImage = false;
            m.canEdit = false;
            m.canVision = looksVisionModelId(m.id);
            syncModelSelectionUI();
          },
        }, "💬 文字")
      );

      const controls = el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, kindSwitch);
      if (isText) {
        const visChk = el("input", { type: "checkbox", checked: Boolean(m.canVision) });
        visChk.addEventListener("change", () => { m.canVision = visChk.checked; });
        controls.appendChild(el("label", { class: "row", style: { fontSize: "11.5px", cursor: "pointer" } }, visChk, "视觉识图"));
      } else {
        const refChk = el("input", { type: "checkbox", checked: Boolean(m.canRefImage) });
        refChk.addEventListener("change", () => { m.canRefImage = refChk.checked; });
        const editChk = el("input", { type: "checkbox", checked: Boolean(m.canEdit) });
        editChk.addEventListener("change", () => { m.canEdit = editChk.checked; });
        controls.append(
          el("label", { class: "row", style: { fontSize: "11.5px", cursor: "pointer" } }, refChk, "垫图"),
          el("label", { class: "row", style: { fontSize: "11.5px", cursor: "pointer" } }, editChk, "编辑")
        );
      }
      const testButton = el("button", { type: "button", class: "btn btn-sm", onClick: () => testModel(m) }, "测试");
      const removeButton = el("button", {
        type: "button",
        class: "btn btn-sm btn-danger",
        title: "取消勾选此模型",
        onClick: () => {
          removeModelEntry(m.id);
          syncModelSelectionUI();
        },
      }, "×");
      controls.append(testButton, removeButton);
      const progress = el("progress", { "aria-label": `${m.id} 测试中`, style: { width: "64px", height: "6px" } });
      const message = el("span", { role: "status", "aria-live": "polite", "aria-atomic": "true" });
      const elapsed = el("span", { class: "muted", "aria-live": "off" });
      const detail = el("pre", { class: "provider-test-detail" });
      const feedback = el("div", { class: "provider-test-feedback" },
        el("div", { class: "row" }, progress, message, elapsed),
        detail
      );
      testViews.set(m.id, { button: testButton, remove: removeButton, progress, message, elapsed, detail, feedback });
      modelsWrap.appendChild(el("div", { class: "col provider-model-entry", style: { gap: "6px", background: "var(--paper)", padding: "7px 9px", borderRadius: "8px", minWidth: 0, border: "1px solid var(--line)" } },
        el("div", { class: "row", style: { justifyContent: "space-between", gap: "8px", flexWrap: "wrap" } },
          el("span", { class: "mono", style: { fontSize: "12px", fontWeight: "600", overflowWrap: "anywhere" } }, m.id),
          controls
        ),
        feedback
      ));
    });
    updateTestViews();
  }

  function syncModelSelectionUI() {
    updateSelectedCount();
    renderTagGrid();
    renderSelectedModels();
  }

  tagSearchIn.addEventListener("input", () => {
    fetchQuery = tagSearchIn.value;
    renderTagGrid();
  });

  syncModelSelectionUI();

  const fetchBtn = el("button", {
    type: "button",
    class: "btn btn-sm btn-primary",
    onClick: async () => {
      if (fetching) return;
      const baseUrl = urlIn.value.trim();
      if (!baseUrl) {
        urlIn.focus();
        toast("请先填写 Base URL");
        return;
      }
      fetching = true;
      fetchBtn.disabled = true;
      fetchBtn.textContent = "拉取中…";
      try {
        const targetId = prov.id || "_preview";
        const r = await api("POST", `/api/providers/${encodeURIComponent(targetId)}/models`, {
          baseUrl,
          apiKey: keyIn.value.trim(),
        });
        fetchedModels = (r.models || []).map((item) => {
          if (typeof item === "string") {
            return { id: item, isImage: looksImageModelId(item), isVision: looksVisionModelId(item), capabilitySource: "heuristic" };
          }
          const fromMeta = item.capabilitySource === "metadata";
          return {
            id: item.id,
            owned_by: item.owned_by || "",
            isImage: fromMeta ? Boolean(item.isImage) : (Boolean(item.isImage) || looksImageModelId(item.id)),
            isVision: fromMeta ? Boolean(item.isVision) : (Boolean(item.isVision) || looksVisionModelId(item.id)),
            capabilitySource: item.capabilitySource || "heuristic",
          };
        }).filter((m) => m.id);
        activeFilter = "all";
        syncModelSelectionUI();
        if (fetchedModels.length) {
          toast(`已拉取 ${fetchedModels.length} 个模型，可同时勾选生图与文字/视觉模型`);
        } else {
          toast("接口未返回任何可用模型，可在下方手动添加模型 ID");
        }
      } catch (e) {
        toast(e.message || "拉取模型失败");
      } finally {
        fetching = false;
        fetchBtn.disabled = false;
        fetchBtn.textContent = "🔍 拉取模型";
      }
    },
  }, "🔍 拉取模型");

  const dialog = showModal(isNew ? "添加第三方接口" : "编辑第三方接口", el("div", { class: "col", style: { gap: "10px" } },
    el("p", { class: "muted", style: { margin: 0 } }, "同一个中转站或官方接口只需添加一次，即可同时勾选里面的生图模型与文字/视觉解析模型。"),
    el("div", { class: "split" },
      el("div", { class: "field" }, el("label", null, "接口名称"), nameIn),
      el("div", { class: "field" }, el("label", null, "API Key"), keyIn)
    ),
    el("div", { class: "field" },
      el("label", null, "Base URL"),
      el("div", { class: "row", style: { gap: "8px" } },
        el("div", { style: { flex: "1", minWidth: "200px" } }, urlIn),
        fetchBtn
      )
    ),
    el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", marginTop: "2px" } },
      el("div", { class: "row", style: { gap: "8px" } },
        el("strong", null, "选择模型"),
        selectedCountBadge
      )
    ),
    tagPanel,
    selectedHead,
    modelsWrap
  ), [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
    el("button", {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        try {
          await saveProviderPayload();
          closeModal();
          onSaved?.();
          toast("第三方接口已保存");
        } catch (e) { toast(e.message); }
      },
    }, "保存"),
  ]);
  dialog.classList.add("modal-provider");
  dialog.addEventListener("close", () => {
    dialogClosed = true;
    dialog.classList.remove("modal-provider");
    stopTestClock();
  }, { once: true });
}

function openHarnessModal(existing, onSaved) {
  const isNew = !existing;
  const idIn = el("input", {
    class: "input mono",
    type: "text",
    value: existing?.id || "",
    disabled: !isNew,
    placeholder: "如：my-cli（仅小写字母、数字、短横线）",
  });
  const nameIn = el("input", {
    class: "input",
    type: "text",
    value: existing?.name || "",
    placeholder: "显示名称，如：我的本地 Agent",
  });
  const driverSel = el("select", { class: "select" },
    el("option", { value: "agy", selected: existing?.driver === "agy" }, "Antigravity (agy)"),
    el("option", { value: "claude", selected: existing?.driver === "claude" }, "Claude Code (claude)"),
    el("option", { value: "codex", selected: existing?.driver === "codex" }, "Codex CLI (codex)"),
    el("option", { value: "opencode", selected: existing?.driver === "opencode" }, "OpenCode (opencode)"),
    el("option", { value: "gemini", selected: existing?.driver === "gemini" }, "Gemini CLI (gemini)"),
    el("option", { value: "dsh", selected: existing?.driver === "dsh" }, "DeepSeek Harness (dsh)"),
    el("option", { value: "kimi", selected: existing?.driver === "kimi" }, "Kimi Code (kimi)"),
    el("option", { value: "qwen", selected: existing?.driver === "qwen" }, "Qwen Code (qwen)"),
    el("option", { value: "hermes", selected: existing?.driver === "hermes" }, "Hermes Agent (hermes)"),
    el("option", { value: "grok", selected: existing?.driver === "grok" }, "Grok Build (grok)"),
    el("option", { value: "omp", selected: existing?.driver === "omp" }, "Oh My Pi (omp)"),
    el("option", { value: "pi", selected: existing?.driver === "pi" }, "Pi Coding Agent (pi)"),
    el("option", { value: "cursor", selected: existing?.driver === "cursor" }, "Cursor CLI (cursor)"),
    el("option", { value: "codebuddy", selected: existing?.driver === "codebuddy" }, "CodeBuddy CLI (codebuddy)"),
    el("option", { value: "copilot", selected: existing?.driver === "copilot" }, "GitHub Copilot CLI (copilot)"),
    el("option", { value: "goose", selected: existing?.driver === "goose" }, "Goose CLI (goose)"),
    el("option", { value: "cline", selected: existing?.driver === "cline" }, "Cline CLI (cline)"),
    el("option", { value: "droid", selected: existing?.driver === "droid" }, "Factory Droid (droid)"),
    el("option", { value: "crush", selected: existing?.driver === "crush" }, "Crush (crush)"),
    el("option", { value: "qoder", selected: existing?.driver === "qoder" }, "Qoder CLI (qoder)"),
    el("option", { value: "kiro", selected: existing?.driver === "kiro" }, "Kiro CLI (kiro)"),
    el("option", { value: "custom", selected: !existing || existing?.driver === "custom" }, "通用自定义 CLI（通过 stdin 或 {{prompt}} 传参）")
  );
  const cmdIn = el("input", {
    class: "input mono",
    type: "text",
    value: existing?.command || "",
    placeholder: existing?.builtin ? `留空则自动探测（当前：${existing?.resolvedPath || "未检测到"}）` : "必填：命令名或完整可执行文件路径",
  });
  const modelIn = el("input", {
    class: "input mono",
    type: "text",
    value: existing?.model || "",
    placeholder: "可选：覆盖默认子模型，如 sonnet / o3 / gemini-2.5-pro",
  });
  const extraArgsIn = el("input", {
    class: "input mono",
    type: "text",
    value: (existing?.extraArgs || []).join(" "),
    placeholder: "可选：额外参数（空格分隔），自定义 CLI 可写 {{prompt}}",
  });
  const workDirIn = el("input", {
    class: "input mono",
    type: "text",
    value: existing?.workDir || "",
    placeholder: "可选：默认使用只读隔离临时目录，如需读特定文件夹可填写路径",
  });
  const timeoutIn = el("input", {
    class: "input",
    type: "number",
    min: "15",
    max: "600",
    step: "5",
    value: String(existing?.timeoutSec || 180),
  });
  const enabledChk = el("input", {
    type: "checkbox",
    checked: existing ? Boolean(existing.enabled) : true,
  });

  function splitArgs(raw) {
    const out = [];
    const s = String(raw || "").trim();
    if (!s) return out;
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      out.push(m[1] ?? m[2] ?? m[3]);
    }
    return out;
  }

  function buildPayload() {
    const id = idIn.value.trim().toLowerCase();
    if (!id) throw new Error("请填写 Harness ID");
    return {
      id,
      name: nameIn.value.trim() || id,
      driver: driverSel.value,
      enabled: enabledChk.checked,
      command: cmdIn.value.trim(),
      model: modelIn.value.trim(),
      extraArgs: splitArgs(extraArgsIn.value),
      workDir: workDirIn.value.trim(),
      timeoutSec: Number(timeoutIn.value) || 180,
    };
  }

  const testBox = el("div", { class: "provider-test-feedback hidden" });
  const testModalBtn = el("button", {
    type: "button",
    class: "btn",
    onClick: async () => {
      let payload;
      try {
        payload = buildPayload();
      } catch (e) {
        toast(e.message);
        return;
      }
      testModalBtn.disabled = true;
      testModalBtn.textContent = "测试中…";
      testBox.classList.remove("hidden");
      testBox.dataset.state = "loading";
      testBox.replaceChildren(el("div", { role: "status", class: "muted" }, "正在调用本机 CLI 测试连通性…"));
      try {
        const r = await api("POST", `/api/harnesses/${encodeURIComponent(payload.id)}/test`, payload);
        if (r.ok) {
          testBox.dataset.state = "ok";
          testBox.replaceChildren(
            el("div", { role: "status", style: { color: "var(--ok)", fontWeight: "600" } }, `连通成功（${r.elapsedMs || 0} ms）`),
            el("pre", { class: "provider-test-detail" }, String(r.text || "").slice(0, 400))
          );
        } else {
          testBox.dataset.state = "error";
          testBox.replaceChildren(
            el("div", { role: "status" }, "测试失败"),
            el("pre", { class: "provider-test-detail" }, r.error || "未知错误")
          );
        }
      } catch (err) {
        testBox.dataset.state = "error";
        testBox.replaceChildren(
          el("div", { role: "status" }, "测试失败"),
          el("pre", { class: "provider-test-detail" }, err?.message || "请求异常")
        );
      } finally {
        testModalBtn.disabled = false;
        testModalBtn.textContent = "测试连通";
      }
    },
  }, "测试连通");

  showModal(isNew ? "添加自定义本地 Harness" : `配置 ${existing.name}`, el("div", { class: "col", style: { gap: "10px" } },
    el("div", { class: "split" },
      el("div", { class: "field" }, el("label", null, "标识 ID"), idIn),
      el("div", { class: "field" }, el("label", null, "显示名称"), nameIn)
    ),
    el("div", { class: "split" },
      el("div", { class: "field" }, el("label", null, "协议驱动"), driverSel),
      el("div", { class: "field" }, el("label", null, "单次超时（秒）"), timeoutIn)
    ),
    el("div", { class: "field" }, el("label", null, "可执行命令或完整路径"), cmdIn),
    el("div", { class: "field" }, el("label", null, "默认子模型（可选）"), modelIn),
    el("div", { class: "field" }, el("label", null, "额外启动参数（可选）"), extraArgsIn),
    el("div", { class: "field" }, el("label", null, "工作目录（可选，留空为安全只读临时目录）"), workDirIn),
    el("label", { class: "row", style: { gap: "8px", cursor: "pointer" } }, enabledChk, el("span", null, "启用此本地 Harness（启用后将出现在各工作区的模型选择器中）")),
    testBox
  ), [
    testModalBtn,
    el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
    el("button", {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        try {
          const payload = buildPayload();
          await api("PUT", `/api/harnesses/${encodeURIComponent(payload.id)}`, payload);
          closeModal();
          onSaved?.();
          toast("本地 Harness 配置已保存");
        } catch (err) {
          toast(err.message || "保存失败");
        }
      },
    }, "保存"),
  ]);
}
