import { api, clear, closeModal, el, money, onEvent, openURL, setColorScheme, showModal, toast } from "../api.js";
import { economySyncHint, formatQuotaSummary, parseEconomy } from "../economy.js";

const VALID_SETTINGS_TABS = new Set([
  "settings-account",
  "settings-models",
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

  const [accRes, balRes, settRes, updRes] = await Promise.all([
    api("GET", "/api/account").catch(() => ({ loggedIn: false })),
    api("GET", "/api/account/balance").catch((e) => ({ loggedIn: false, error: e?.message || "" })),
    api("GET", "/api/settings").catch(() => ({ settings: {}, providers: [] })),
    api("GET", "/api/update").catch(() => ({})),
  ]);
  if (!root.isConnected || root._settingsRenderSeq !== seq) return;

  root._settingsCleanup?.();
  clear(root);

  const settings = settRes.settings || {};
  const providers = settRes.providers || [];
  const siteBase = (accRes.siteBase || settings.siteBase || "https://handraw-style.com").replace(/\/+$/, "");
  const eco = parseEconomy(accRes.loggedIn ? { ...balRes, loggedIn: true } : { loggedIn: false });
  let loginPollTimer = null;

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "col", style: { gap: "2px" } },
      el("h1", { class: "page-title" }, "设置与管理"),
      el("span", { class: "muted" }, "按功能分类管理账号资产、第三方接口、本地偏好与客户端更新")
    ),
    el("span", { class: "muted mono" }, `数据目录：${settRes.dataDir || ""}`)
  ));

  function startDeviceLogin(loginStatusArea) {
    return async () => {
      try {
        const st = await api("POST", "/api/account/login");
        clear(loginStatusArea);
        loginStatusArea.classList.remove("hidden");
        loginStatusArea.appendChild(el("div", { class: "card col", style: { background: "var(--paper)", gap: "6px" } },
          el("div", null, "浏览器授权页已打开，请在网页中确认核对码："),
          el("div", { class: "mono", style: { fontSize: "22px", fontWeight: 700, letterSpacing: "0.08em", color: "var(--accent)" } }, st.userCode || ""),
          st.verificationUrl ? el("div", { class: "row" },
            el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(st.verificationUrl) }, "重新打开授权网页")
          ) : null
        ));
        clearInterval(loginPollTimer);
        loginPollTimer = setInterval(async () => {
          if (!root.isConnected) {
            clearInterval(loginPollTimer);
            return;
          }
          const poll = await api("GET", "/api/account/login").catch(() => null);
          if (poll?.loggedIn || poll?.status === "ok") {
            clearInterval(loginPollTimer);
            await ctx.refreshTopbar?.(true);
            renderSettings(root, ctx, { tab: "settings-account" });
            toast("登录成功");
          } else if (poll?.status === "error") {
            clearInterval(loginPollTimer);
            toast(poll.error || "登录失败");
          }
        }, 2000);
      } catch (e) {
        toast(e.message);
      }
    };
  }

  // 1. Account & Assets
  const accSection = el("section", {
    id: "settings-account",
    class: "card settings-section",
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

  const loginStatusArea = el("div", { class: "col hidden" });
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
          el("span", { class: "muted" }, "可用余额"),
          el("strong", null, eco.balanceCents !== null ? money(eco.balanceCents) : "--"),
          el("span", { class: "muted" }, eco.heldCents > 0 ? `冻结中 ${money(eco.heldCents)}` : "通用人民币余额")
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
      if (eco.aiBonusObj) {
        assetsGrid.appendChild(el("div", { class: "economy-stat" },
          el("span", { class: "muted" }, "AI 体验金"),
          el("strong", null, money(eco.aiBonusCents)),
          el("span", { class: "muted" }, eco.aiClaimableMicros > 0 ? "网页端可领取体验金" : "用于文字与视觉解析")
        ));
      }
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
      accSection.appendChild(el("div", { class: "economy-hint row", style: { justifyContent: "space-between" } },
        el("span", null, syncHint),
        eco.scopeDenied ? el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: startDeviceLogin(loginStatusArea),
        }, "重新授权登录") : null
      ));
    }
    accSection.appendChild(loginStatusArea);
  } else {
    accSection.appendChild(el("div", { class: "settings-account-bar" },
      el("span", { class: "muted" }, accRes.error || "登录后可同步可用余额、社区积分与免费额度，并支持发布作品与收藏同步"),
      el("button", { type: "button", class: "btn btn-primary", onClick: startDeviceLogin(loginStatusArea) }, "登录手绘风账号")
    ));
    accSection.appendChild(loginStatusArea);
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
      const isTextProv = p.purpose === "text" || p.purpose === "vision";
      const modelList = p.models || [];
      const previewChips = modelList.length ? el("div", { class: "provider-model-preview" },
        ...modelList.slice(0, 8).map((m) => el("span", { class: "provider-model-pill" }, m.id)),
        modelList.length > 8 ? el("span", { class: "provider-model-pill" }, `+${modelList.length - 8}`) : null
      ) : null;

      provList.appendChild(el("div", { class: "settings-subcard row", style: { justifyContent: "space-between", alignItems: "flex-start" } },
        el("div", { class: "col", style: { gap: "3px", minWidth: 0, flex: "1 1 280px" } },
          el("div", { class: "row" },
            el("strong", null, p.name),
            el("span", { class: "badge" }, isTextProv ? "文字与视觉解析" : "生图接口"),
            p.hasKey ? el("span", { class: "badge badge-ok" }, "已存密钥") : el("span", { class: "badge badge-warn" }, "未填密钥")
          ),
          el("span", { class: "muted mono", style: { overflowWrap: "anywhere" } }, `${p.baseUrl} · 已勾选 ${modelList.length} 个模型`),
          previewChips
        ),
        el("div", { class: "row", style: { flexShrink: 0 } },
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: async () => {
              const firstModel = p.models?.[0]?.id || "";
              const t = await api("POST", `/api/providers/${encodeURIComponent(p.id)}/test`, { model: firstModel }).catch((e) => ({ ok: false, error: e.message }));
              toast(t.ok ? `连通正常（${t.latencyMs}ms）` : `测试失败：${t.error}`);
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

  const worksIn = el("input", {
    id: "pref-works-dir",
    name: "worksDir",
    class: "input",
    style: { flex: "1", minWidth: "200px" },
    autocorrect: "off",
    autocapitalize: "none",
    spellcheck: "false",
    value: settings.worksDir || "",
  });
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
        await api("PATCH", "/api/settings", {
          worksDir: worksIn.value.trim(),
          costLimitCents: Math.round(Number(costYuanIn.value || 0) * 100),
          quickShotHotkey: hotkeyIn.value.trim(),
          quickShotEnabled: quickChk.checked,
          minimizeToTray: trayChk.checked,
          autoCheckUpdate: autoUpdChk.checked,
          autoSyncResources: autoSyncChk.checked,
          keepSiteGenerationsPrivate: !publicChk.checked,
        });
        prefStatus.textContent = "已保存";
        toast("偏好设置已保存");
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
          el("span", { class: "muted" }, "所有本地生图原图与缩略图均保存在此目录")
        ),
        el("div", { class: "row", style: { flex: "1", maxWidth: "440px" } },
          worksIn,
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
        el("p", { class: "muted", style: { margin: 0 } }, "外观配色、本地作品目录、费用保护阈值与托盘快捷键")
      )
    ),
    prefForm
  );

  // 4. Version & Incremental Resource Updates
  const resProg = el("span", { class: "muted" }, "");
  const hasAnyUpdate = Boolean(updRes.available || updRes.ready || updRes.resourceNew);
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
        el("p", { class: "muted", style: { margin: 0 } }, "检查客户端新版发布与画风/图型静态资源包增量热更新")
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
      )
    ),
    resProg,
    el("div", { class: "row" },
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => {
          const r = await api("POST", "/api/update/check").catch((e) => ({ error: e.message }));
          toast(r.status?.available ? `发现新版 ${r.status.latest}` : (r.error || "已是最新版本"));
          renderSettings(root, ctx, { tab: "settings-updates", preserveScroll: true });
        },
      }, "检查版本与资源更新"),
      updRes.available ? el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: async () => {
          await api("POST", "/api/update/download");
          toast("正在后台下载更新包…");
        },
      }, updRes.downloading ? `下载中 ${updRes.progress}%` : "下载客户端更新") : null,
      updRes.ready ? el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => api("POST", "/api/update/apply"),
      }, "重启完成升级") : null,
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => {
          try {
            const r = await api("POST", "/api/update/resources");
            toast(r.updated ? `已增量更新 ${r.changed} 个资源文件` : "本地资源包已是最新");
            renderSettings(root, ctx, { tab: "settings-updates", preserveScroll: true });
          } catch (e) {
            toast(e.message);
          }
        },
      }, "增量更新资源包")
    )
  );

  // Two-column settings shell: left tab list + single active panel on the right
  const tabDefs = [
    { id: "settings-account", label: "账户与资产", meta: accRes.loggedIn ? "已登录" : "未登录", panel: accSection },
    { id: "settings-models", label: "第三方接口", meta: providers.length ? `${providers.length} 个接口` : "未配置", panel: provSection },
    { id: "settings-preferences", label: "通用偏好与存储", meta: "", panel: prefSection },
    { id: "settings-updates", label: "版本与资源更新", meta: hasAnyUpdate ? "有更新" : (updRes.current || ""), panel: updSection },
  ];

  const navButtons = [];
  const nav = el("div", { class: "settings-nav", role: "tablist", "aria-label": "设置分组", "aria-orientation": "vertical" });
  const content = el("div", { class: "settings-content" },
    accSection,
    provSection,
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

  const cleanup = () => {
    clearInterval(loginPollTimer);
    unsub();
  };
  const unsub = onEvent((msg) => {
    if (!root.isConnected || root._settingsRenderSeq !== seq) {
      cleanup();
      return;
    }
    if (msg.type === "resource_update") {
      resProg.textContent = `资源包增量下载进度：${msg.data?.done || 0} / ${msg.data?.total || 0}`;
    } else if ((msg.type === "account" && msg.data?.loggedIn) || msg.type === "balance") {
      clearInterval(loginPollTimer);
      ctx.refreshTopbar?.(true);
      renderSettings(root, ctx, { preserveScroll: true });
    }
  });
  root._settingsCleanup = cleanup;
}

function looksVisionModelId(id) {
  const s = String(id || "").toLowerCase();
  if (!s) return false;
  if (/(image|dall-e|dalle|flux|seedream|jimeng|kolors|imagen|midjourney|ideogram|recraft|nano-banana)/.test(s)) return false;
  return /(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision|gpt-5|claude-3|claude-4|claude-sonnet-4|claude-opus-4|claude-haiku-4|gemini-1\.5|gemini-2|gemini-3|qwen.*vl|qvq|glm-4.*v|doubao.*vision|kimi-vl|internvl|minicpm-v|pixtral|llama-4|grok-2-vision|grok-4|vision|-vl|_vl|multimodal)/.test(s);
}

function openProviderModal(existing, onSaved) {
  const isNew = !existing;
  const prov = existing ? structuredClone(existing) : { id: "", name: "", kind: "openai", purpose: "image", baseUrl: "", enabled: true, models: [] };
  if (prov.purpose === "vision") prov.purpose = "text";
  if (!Array.isArray(prov.models)) prov.models = [];

  const nameIn = el("input", { class: "input", value: prov.name || "", placeholder: "例如：火山方舟 / OpenRouter / 本地号池" });
  const purposeSel = el("select", { class: "select" },
    el("option", { value: "image", selected: prov.purpose !== "text" }, "生图接口"),
    el("option", { value: "text", selected: prov.purpose === "text" }, "文字与视觉解析接口")
  );
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
  const tagPanel = el("div", { class: "provider-tag-panel" }, tagToolbar, tagGrid, tagHint);

  const selectedHead = el("div", { class: "provider-selected-head hidden" });
  const modelsWrap = el("div", { class: "col", style: { gap: "6px", maxHeight: "170px", overflowY: "auto" } });

  let fetchedModels = [];
  let fetchQuery = "";
  let activeFilter = "all"; // all | recommended | selected
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
      throw new Error("请先拉取模型并勾选至少一个模型");
    }
  }

  async function saveProviderPayload() {
    validateBeforeSave();
    prov.name = nameIn.value.trim();
    prov.purpose = purposeSel.value;
    prov.baseUrl = urlIn.value.trim();
    const res = await api("POST", "/api/providers", { ...prov, apiKey: keyIn.value.trim() });
    const latest = (res.providers || []).find((x) => x.name === prov.name && x.baseUrl === prov.baseUrl) || (res.providers || []).slice(-1)[0];
    if (!prov.id && latest?.id) prov.id = latest.id;
    return res;
  }

  async function testModel(model, isText) {
    if (hasRunningTest()) return;
    const vision = isText && Boolean(model.canVision);
    const mode = vision ? "视觉识图" : isText ? "文字模型" : "生图模型";
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
      test.message = `正在测试${mode}，等待接口返回…`;
      updateTestViews();
      const result = await api("POST", `/api/providers/${encodeURIComponent(prov.id)}/test`, {
        model: model.id,
        vision,
      });
      test.ok = Boolean(result.ok);
      const latency = Number.isFinite(result.latencyMs) ? result.latencyMs : performance.now() - test.startedAt;
      test.message = `${mode}测试${test.ok ? "成功" : "失败"} · 用时 ${elapsedLabel(latency)}`;
      if (!test.ok) test.detail = result.error || "接口未返回具体失败原因";
      else if (result.reply) test.detail = `模型回复：\n${typeof result.reply === "string" ? result.reply : JSON.stringify(result.reply, null, 2)}`;
      else if (result.imagesCount !== undefined) test.detail = `接口返回 ${result.imagesCount} 张测试图片`;
      else test.detail = "接口已正常响应";
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
    const isText = purposeSel.value === "text";
    prov.models.push({
      id: cleanId,
      label: cleanId,
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
      addModelEntry(item.id, { canVision: item.isVision });
    }
    syncModelSelectionUI();
  }

  function buildCatalog() {
    const map = new Map();
    for (const item of fetchedModels) {
      map.set(item.id, item);
    }
    for (const m of prov.models || []) {
      if (!map.has(m.id)) {
        map.set(m.id, {
          id: m.id,
          isImage: purposeSel.value !== "text" && !looksVisionModelId(m.id),
          isVision: Boolean(m.canVision) || looksVisionModelId(m.id),
        });
      }
    }
    return [...map.values()];
  }

  function updateSelectedCount() {
    const count = (prov.models || []).length;
    selectedCountBadge.textContent = `已勾选 ${count} 个`;
    selectedCountBadge.className = count > 0 ? "badge badge-ok" : "badge";
  }

  function renderTagGrid() {
    clear(filterPillsWrap);
    clear(tagGrid);

    const isText = purposeSel.value === "text";
    const selectedSet = new Set((prov.models || []).map((m) => m.id));
    const catalog = buildCatalog();

    if (!catalog.length) {
      tagToolbar.classList.add("hidden");
      tagHint.textContent = "请先填写 Base URL 与 API Key，点击「🔍 拉取模型」后在模型标签上直接打勾选择。";
      return;
    }

    tagToolbar.classList.remove("hidden");

    const recList = catalog.filter((m) => (isText ? m.isVision && !m.isImage : m.isImage));
    const filterItems = [
      { id: "all", label: `全部 (${catalog.length})` },
      ...(recList.length ? [{ id: "recommended", label: isText ? `识图推荐 (${recList.length})` : `生图推荐 (${recList.length})` }] : []),
      { id: "selected", label: `已勾选 (${selectedSet.size})` },
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

    if (selectedSet.size > 0) {
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
    if (activeFilter === "recommended") {
      visible = visible.filter((m) => (isText ? m.isVision && !m.isImage : m.isImage));
    } else if (activeFilter === "selected") {
      visible = visible.filter((m) => selectedSet.has(m.id));
    }

    // Show checked tags first only when viewing "all" without active search? Keep stable order so chips don't jump under cursor!
    const shown = visible.slice(0, 120);
    if (!shown.length) {
      tagGrid.appendChild(el("span", { class: "muted", style: { fontSize: "12px", padding: "4px 2px" } }, "没有匹配的模型标签"));
    } else {
      shown.forEach((m) => {
        const checked = selectedSet.has(m.id);
        const kindLabel = m.isImage ? "生图" : (m.isVision ? "识图" : "");
        tagGrid.appendChild(el("button", {
          type: "button",
          class: "model-tag-chip" + (checked ? " is-checked" : ""),
          "aria-pressed": String(checked),
          dataset: { modelId: m.id },
          onClick: () => toggleModelEntry(m),
        },
          el("span", { class: "model-tag-check", "aria-hidden": "true" }, checked ? "✓" : ""),
          el("span", { class: "model-tag-id mono" }, m.id),
          kindLabel ? el("span", { class: "model-tag-kind" }, kindLabel) : null
        ));
      });
    }

    if (!fetchedModels.length) {
      tagHint.textContent = "当前展示已勾选模型；点击「🔍 拉取模型」可刷新远端列表并增减勾选。";
    } else if (visible.length > 120) {
      tagHint.textContent = `当前展示前 120 个标签（共匹配 ${visible.length} 个），请输入关键词继续筛选。点击标签直接打勾即可选择。`;
    } else {
      tagHint.textContent = "点击模型标签即可打勾选中或取消选中。";
    }
  }

  function renderSelectedModels() {
    clear(modelsWrap);
    testViews.clear();
    const isText = purposeSel.value === "text";
    const list = prov.models || [];
    if (!list.length) {
      selectedHead.classList.add("hidden");
      return;
    }
    selectedHead.classList.remove("hidden");
    selectedHead.textContent = `已勾选模型能力配置与测试（${list.length}）`;

    list.forEach((m) => {
      const controls = el("div", { class: "row" });
      if (isText) {
        const visChk = el("input", { type: "checkbox", checked: Boolean(m.canVision) });
        visChk.addEventListener("change", () => { m.canVision = visChk.checked; });
        controls.appendChild(el("label", { class: "row", style: { fontSize: "11.5px" } }, visChk, "视觉识图"));
      } else {
        const refChk = el("input", { type: "checkbox", checked: Boolean(m.canRefImage) });
        refChk.addEventListener("change", () => { m.canRefImage = refChk.checked; });
        const editChk = el("input", { type: "checkbox", checked: Boolean(m.canEdit) });
        editChk.addEventListener("change", () => { m.canEdit = editChk.checked; });
        controls.append(
          el("label", { class: "row", style: { fontSize: "11.5px" } }, refChk, "垫图"),
          el("label", { class: "row", style: { fontSize: "11.5px" } }, editChk, "编辑")
        );
      }
      const testButton = el("button", { type: "button", class: "btn btn-sm", onClick: () => testModel(m, isText) }, "测试");
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
      modelsWrap.appendChild(el("div", { class: "col provider-model-entry", style: { gap: "6px", background: "var(--paper)", padding: "6px 8px", borderRadius: "6px", minWidth: 0 } },
        el("div", { class: "row", style: { justifyContent: "space-between" } },
          el("span", { class: "mono", style: { fontSize: "12px", overflowWrap: "anywhere" } }, m.id),
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

  purposeSel.addEventListener("change", () => {
    syncModelSelectionUI();
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
        fetchedModels = (r.models || []).map((item) => (typeof item === "string"
          ? { id: item, isImage: false, isVision: looksVisionModelId(item) }
          : { id: item.id, owned_by: item.owned_by || "", isImage: Boolean(item.isImage), isVision: Boolean(item.isVision) || looksVisionModelId(item.id) }
        )).filter((m) => m.id);
        activeFilter = "all";
        syncModelSelectionUI();
        if (fetchedModels.length) {
          toast(`已拉取 ${fetchedModels.length} 个模型，请点击标签打勾选择`);
        } else {
          toast("接口未返回任何可用模型");
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
    el("div", { class: "field" }, el("label", null, "接口名称"), nameIn),
    el("div", { class: "field" }, el("label", null, "接口用途"), purposeSel),
    el("div", { class: "field" }, el("label", null, "Base URL"), urlIn),
    el("div", { class: "field" }, el("label", null, "API Key"), keyIn),
    el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", marginTop: "4px" } },
      el("div", { class: "row", style: { gap: "8px" } },
        el("strong", null, "模型选择"),
        selectedCountBadge
      ),
      fetchBtn
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
