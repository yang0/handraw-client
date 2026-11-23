import { api, clear, closeModal, el, money, onEvent, openURL, setColorScheme, showModal, toast } from "../api.js";
import { economySyncHint, formatQuotaSummary, parseEconomy } from "../economy.js";
import { buildGroupedAIModelSelect, buildGroupedModelSelect } from "./create.js";

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

  const [accRes, balRes, settRes, updRes, modRes] = await Promise.all([
    api("GET", "/api/account").catch(() => ({ loggedIn: false })),
    api("GET", "/api/account/balance").catch((e) => ({ loggedIn: false, error: e?.message || "" })),
    api("GET", "/api/settings").catch(() => ({ settings: {}, providers: [] })),
    api("GET", "/api/update").catch(() => ({})),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [] })),
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
      el("span", { class: "muted" }, "配置网站账号与资产同步、模型接口、本地存储、内置模块与客户端更新")
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
            renderSettings(root, ctx, { anchor: "settings-account" });
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
  const accSection = el("section", { id: "settings-account", class: "card settings-section", tabindex: "-1" });
  const accStatusBadge = accRes.loggedIn
    ? el("span", { class: "badge " + (eco.offline ? "badge-warn" : "badge-ok") }, eco.offline ? "已登录 · 离线缓存" : "已登录")
    : el("span", { class: "badge" }, "未登录");

  accSection.appendChild(el("div", { class: "settings-section-head" },
    el("div", { class: "col", style: { gap: "2px" } },
      el("h2", { class: "settings-section-title" }, "1. 网站账户与资产同步"),
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
            renderSettings(root, ctx, { anchor: "settings-account" });
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
      el("span", { class: "muted" }, accRes.error || "登录后可使用网站模型、同步可用余额、社区积分与免费额度，并支持发布作品与收藏同步"),
      el("button", { type: "button", class: "btn btn-primary", onClick: startDeviceLogin(loginStatusArea) }, "登录手绘风账号")
    ));
    accSection.appendChild(loginStatusArea);
  }

  // 2. Models & Providers
  const provSection = el("section", { id: "settings-models", class: "card settings-section", tabindex: "-1" },
    el("div", { class: "settings-section-head" },
      el("div", { class: "col", style: { gap: "2px" } },
        el("h2", { class: "settings-section-title" }, "2. 模型与接口配置"),
        el("p", { class: "muted", style: { margin: 0 } }, "生图模型与文字/视觉服务默认使用网站官方固定接口（平台自动调度），也可自由接入 OpenAI 兼容第三方中转站")
      ),
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openProviderModal(null, () => renderSettings(root, ctx, { preserveScroll: true })) }, "+ 添加第三方接口")
    )
  );

  const defModelSel = buildGroupedModelSelect(modRes, settings.defaultModel);
  defModelSel.id = "def-image-model";
  defModelSel.addEventListener("change", async () => {
    await api("PATCH", "/api/settings", { defaultModel: defModelSel.value });
    toast("已更新默认生图模型");
  });

  const defTextSel = buildGroupedAIModelSelect(modRes, settings.defaultTextModel, "text");
  defTextSel.id = "def-text-model";
  defTextSel.addEventListener("change", async () => {
    await api("PATCH", "/api/settings", { defaultTextModel: defTextSel.value });
    toast("已更新默认文字模型");
  });

  const defVisionSel = buildGroupedAIModelSelect(modRes, settings.defaultVisionModel, "vision");
  defVisionSel.id = "def-vision-model";
  defVisionSel.addEventListener("change", async () => {
    await api("PATCH", "/api/settings", { defaultVisionModel: defVisionSel.value });
    toast("已更新默认视觉解析模型");
  });

  provSection.appendChild(el("div", { class: "settings-rows" },
    el("div", { class: "settings-row" },
      el("div", { class: "settings-row-meta" },
        el("label", { for: "def-image-model", class: "settings-row-label" }, "全局默认生图模型"),
        el("span", { class: "muted" }, "各工作室页面可随时单独切换")
      ),
      defModelSel
    ),
    el("div", { class: "settings-row" },
      el("div", { class: "settings-row-meta" },
        el("label", { for: "def-text-model", class: "settings-row-label" }, "全局文字服务接口"),
        el("span", { class: "muted" }, "用于主题扩写、系列规划、文章配图与画布助手；网站官方自动调度，也可切到第三方 OpenAI 接口")
      ),
      defTextSel
    ),
    el("div", { class: "settings-row" },
      el("div", { class: "settings-row-meta" },
        el("label", { for: "def-vision-model", class: "settings-row-label" }, "全局视觉服务接口"),
        el("span", { class: "muted" }, "用于以图找风格与提取参考图画风特征；网站官方自动调度，也可切到第三方 OpenAI 视觉接口")
      ),
      defVisionSel
    )
  ));

  const provList = el("div", { class: "col", style: { gap: "8px" } },
    el("div", { class: "settings-subhead" }, `第三方中转站 / 自定义接口（${providers.length}）`)
  );
  if (!providers.length) {
    provList.appendChild(el("div", { class: "settings-empty muted" }, "尚未添加第三方中转站；当前默认使用网站线上接口（生图、文字与视觉解析均可随时添加 OpenAI 兼容中转站）。"));
  } else {
    providers.forEach((p) => {
      const isTextProv = p.purpose === "text" || p.purpose === "vision";
      provList.appendChild(el("div", { class: "settings-subcard row", style: { justifyContent: "space-between" } },
        el("div", { class: "col", style: { gap: "2px", minWidth: 0 } },
          el("div", { class: "row" },
            el("strong", null, p.name),
            el("span", { class: "badge" }, isTextProv ? "文字与视觉解析" : "生图接口"),
            p.hasKey ? el("span", { class: "badge badge-ok" }, "已存密钥") : el("span", { class: "badge badge-warn" }, "未填密钥")
          ),
          el("span", { class: "muted mono" }, `${p.baseUrl} · ${(p.models || []).length} 个模型`)
        ),
        el("div", { class: "row" },
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: async () => {
              const firstModel = p.models?.[0]?.id || "";
              const t = await api("POST", `/api/providers/${encodeURIComponent(p.id)}/test`, { model: firstModel }).catch((e) => ({ ok: false, error: e.message }));
              toast(t.ok ? `连通正常（${t.latencyMs}ms）` : `测试失败：${t.error}`);
            },
          }, "测试连通"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openProviderModal(p, () => renderSettings(root, ctx, { preserveScroll: true })) }, "编辑"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-danger",
            onClick: async () => {
              await api("DELETE", `/api/providers/${encodeURIComponent(p.id)}`);
              renderSettings(root, ctx, { preserveScroll: true });
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

  const prefSection = el("section", { id: "settings-preferences", class: "card settings-section", tabindex: "-1" },
    el("div", { class: "settings-section-head" },
      el("div", { class: "col", style: { gap: "2px" } },
        el("h2", { class: "settings-section-title" }, "3. 通用偏好与本地存储"),
        el("p", { class: "muted", style: { margin: 0 } }, "外观配色、本地作品目录、费用保护阈值与托盘快捷键")
      )
    ),
    prefForm
  );

  // 4. Version & Incremental Resource Updates
  const resProg = el("span", { class: "muted" }, "");
  const hasAnyUpdate = Boolean(updRes.available || updRes.ready || updRes.resourceNew);
  const updSection = el("section", { id: "settings-updates", class: "card settings-section", tabindex: "-1" },
    el("div", { class: "settings-section-head" },
      el("div", { class: "col", style: { gap: "2px" } },
        el("h2", { class: "settings-section-title" }, "4. 客户端版本与资源包更新"),
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
          renderSettings(root, ctx, { preserveScroll: true });
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
            renderSettings(root, ctx, { preserveScroll: true });
          } catch (e) {
            toast(e.message);
          }
        },
      }, "增量更新资源包")
    )
  );

  // Two-column settings shell: sticky left anchor navigation + single-page sections
  const navItems = [
    { id: "settings-account", label: "账户与资产", meta: accRes.loggedIn ? "已登录" : "未登录" },
    { id: "settings-models", label: "模型与接口", meta: providers.length ? `${providers.length} 个第三方` : "默认线上" },
    { id: "settings-preferences", label: "通用偏好与存储", meta: "" },
    { id: "settings-updates", label: "版本与资源更新", meta: hasAnyUpdate ? "有更新" : (updRes.current || "") },
  ];

  const navLinks = [];
  const nav = el("nav", { class: "settings-nav", "aria-label": "设置目录" });
  const content = el("div", { class: "settings-content" },
    accSection,
    provSection,
    prefSection,
    updSection
  );

  const supportsScrollTargetGroup = typeof CSS !== "undefined" && CSS.supports("scroll-target-group: auto");
  function setActiveNav(activeId, applyClass = !supportsScrollTargetGroup) {
    for (const link of navLinks) {
      const isActive = link.dataset.target === activeId;
      link.setAttribute("aria-current", isActive ? "true" : "false");
      if (applyClass) link.classList.toggle("target-current", isActive);
    }
  }

  navItems.forEach((item, index) => {
    const link = el("a", {
      class: "settings-nav-link",
      href: `#${item.id}`,
      dataset: { target: item.id },
      "aria-current": index === 0 ? "true" : "false",
      onClick: (e) => {
        e.preventDefault();
        const target = content.querySelector(`#${item.id}`);
        if (!target) return;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
        target.focus({ preventScroll: true });
        setActiveNav(item.id, !supportsScrollTargetGroup);
      },
    },
      el("span", { class: "settings-nav-title" }, `${index + 1}. ${item.label}`),
      item.meta ? el("span", { class: "settings-nav-meta" }, item.meta) : null
    );
    navLinks.push(link);
    nav.appendChild(link);
  });

  const shell = el("div", { class: "settings-shell" }, nav, content);
  root.appendChild(shell);

  // Scrollspy: native :target-current aria sync when supported, IntersectionObserver fallback otherwise
  const scrollContainer = root.closest(".main") || root;
  const sections = [accSection, provSection, prefSection, updSection];
  let observer = null;
  let onScrollEnd = null;

  if (supportsScrollTargetGroup) {
    const syncNativeAria = () => {
      const currentLink = nav.querySelector("a:target-current");
      if (currentLink) {
        setActiveNav(currentLink.dataset.target, false);
      }
    };
    onScrollEnd = syncNativeAria;
    scrollContainer.addEventListener("scrollend", onScrollEnd);
    requestAnimationFrame(syncNativeAria);
  } else {
    setActiveNav(navItems[0].id, true);
    observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (!visible.length) return;
      visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      setActiveNav(visible[0].target.id, true);
    }, { root: scrollContainer === root ? null : scrollContainer, rootMargin: "-10% 0px -70% 0px", threshold: 0 });
    sections.forEach((sec) => observer.observe(sec));
  }

  if (params?.anchor) {
    const anchorTarget = content.querySelector(`#${CSS.escape(params.anchor)}`);
    if (anchorTarget) {
      requestAnimationFrame(() => {
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        anchorTarget.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
        anchorTarget.focus({ preventScroll: true });
        setActiveNav(anchorTarget.id, !supportsScrollTargetGroup);
      });
    }
  } else if (savedScrollTop !== null) {
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = savedScrollTop;
    });
  }

  const cleanup = () => {
    clearInterval(loginPollTimer);
    observer?.disconnect();
    if (onScrollEnd) scrollContainer.removeEventListener("scrollend", onScrollEnd);
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

  const nameIn = el("input", { class: "input", value: prov.name || "", placeholder: "例如：火山方舟 / OpenRouter / 中转站" });
  const purposeSel = el("select", { class: "select" },
    el("option", { value: "image", selected: prov.purpose !== "text" }, "生图接口"),
    el("option", { value: "text", selected: prov.purpose === "text" }, "文字与视觉解析接口")
  );
  const urlIn = el("input", { class: "input", value: prov.baseUrl || "", placeholder: "https://api.example.com/v1", autocorrect: "off", autocapitalize: "none", spellcheck: "false" });
  const keyIn = el("input", { class: "input", type: "password", autocomplete: "new-password", placeholder: prov.hasKey ? "留空则保留现有密钥" : "输入 API Key（存入系统凭据库）" });
  const modelsWrap = el("div", { class: "col", style: { gap: "6px", maxHeight: "190px", overflowY: "auto" } });
  const manualIdIn = el("input", { class: "input", placeholder: "手动添加模型 ID（回车或点添加）", autocorrect: "off", autocapitalize: "none", spellcheck: "false" });
  const fetchedWrap = el("div", { class: "col hidden", style: { gap: "6px", padding: "8px", border: "1px solid var(--line)", borderRadius: "8px", background: "var(--paper)" } });
  let fetchedModels = [];
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

  function renderModels() {
    clear(modelsWrap);
    testViews.clear();
    const isText = purposeSel.value === "text";
    if (!(prov.models || []).length) {
      modelsWrap.appendChild(el("div", { class: "muted", style: { fontSize: "12px" } }, "尚未添加模型，可点击「🔍 拉取 /models」或手动输入模型 ID"));
      return;
    }
    (prov.models || []).forEach((m, idx) => {
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
      const removeButton = el("button", { type: "button", class: "btn btn-sm btn-danger", onClick: () => { prov.models.splice(idx, 1); testStates.delete(m.id); renderModels(); renderFetched(); } }, "×");
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

  let fetchQuery = "";
  function renderFetched() {
    clear(fetchedWrap);
    if (!fetchedModels.length) {
      fetchedWrap.classList.add("hidden");
      return;
    }
    fetchedWrap.classList.remove("hidden");
    const isText = purposeSel.value === "text";
    const existingSet = new Set((prov.models || []).map((m) => m.id));
    const q = fetchQuery.trim().toLowerCase();
    const list = fetchedModels.filter((m) => !q || m.id.toLowerCase().includes(q));
    const searchIn = el("input", { class: "input", value: fetchQuery, placeholder: "筛选拉取的模型 ID…" });
    searchIn.addEventListener("input", () => { fetchQuery = searchIn.value; renderFetched(); });

    const recList = fetchedModels.filter((m) => (isText ? m.isVision && !m.isImage : m.isImage));
    const addRecBtn = recList.length ? el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: () => {
        let added = 0;
        recList.forEach((m) => { if (addModelEntry(m.id, { canVision: m.isVision })) added++; });
        renderModels();
        renderFetched();
        toast(added ? `已添加 ${added} 个推荐模型` : "推荐模型均已添加");
      },
    }, isText ? `+ 添加识图模型 (${recList.length})` : `+ 添加生图模型 (${recList.length})`) : null;

    fetchedWrap.appendChild(el("div", { class: "row", style: { justifyContent: "space-between" } },
      searchIn,
      addRecBtn,
      el("button", { type: "button", class: "btn btn-sm", onClick: () => { fetchedModels = []; renderFetched(); } }, "收起")
    ));

    const listBox = el("div", { class: "col", style: { gap: "4px", maxHeight: "150px", overflowY: "auto" } });
    list.slice(0, 80).forEach((m) => {
      const added = existingSet.has(m.id);
      const badge = m.isImage ? el("span", { class: "badge" }, "生图") : (m.isVision ? el("span", { class: "badge badge-ok" }, "识图") : null);
      listBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", padding: "3px 4px" } },
        el("div", { class: "row" }, el("span", { class: "mono", style: { fontSize: "12px" } }, m.id), badge),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          disabled: added,
          onClick: () => {
            addModelEntry(m.id, { canVision: m.isVision });
            renderModels();
            renderFetched();
          },
        }, added ? "已添加" : "+ 添加")
      ));
    });
    if (list.length > 80) {
      listBox.appendChild(el("div", { class: "muted", style: { fontSize: "11.5px" } }, `仅展示前 80 条，请输入关键词继续筛选（共 ${list.length} 条）`));
    }
    fetchedWrap.appendChild(listBox);
  }

  purposeSel.addEventListener("change", () => {
    renderModels();
    renderFetched();
  });
  manualIdIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (addModelEntry(manualIdIn.value, { canRefImage: purposeSel.value !== "text" })) {
        manualIdIn.value = "";
        renderModels();
      }
    }
  });
  renderModels();

  async function saveProviderPayload() {
    prov.name = nameIn.value.trim();
    prov.purpose = purposeSel.value;
    prov.baseUrl = urlIn.value.trim();
    const res = await api("POST", "/api/providers", { ...prov, apiKey: keyIn.value.trim() });
    const latest = (res.providers || []).find((x) => x.name === prov.name && x.baseUrl === prov.baseUrl) || (res.providers || []).slice(-1)[0];
    if (!prov.id && latest?.id) prov.id = latest.id;
    return res;
  }

  const fetchBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: async () => {
      try {
        if (!prov.id) await saveProviderPayload();
        const r = await api("POST", `/api/providers/${encodeURIComponent(prov.id)}/models`, { baseUrl: urlIn.value.trim(), apiKey: keyIn.value.trim() });
        fetchedModels = (r.models || []).map((item) => (typeof item === "string"
          ? { id: item, isImage: false, isVision: looksVisionModelId(item) }
          : { id: item.id, owned_by: item.owned_by || "", isImage: Boolean(item.isImage), isVision: Boolean(item.isVision) || looksVisionModelId(item.id) }
        )).filter((m) => m.id);
        renderFetched();
        toast(`获取到 ${fetchedModels.length} 个模型，请点击添加需要的模型并保存`);
      } catch (e) { toast(e.message); }
    },
  }, "🔍 拉取 /models");

  const dialog = showModal(isNew ? "添加第三方接口" : "编辑接口", el("div", { class: "col" },
    el("div", { class: "field" }, el("label", null, "接口名称"), nameIn),
    el("div", { class: "field" }, el("label", null, "用途"), purposeSel),
    el("div", { class: "field" }, el("label", null, "Base URL"), urlIn),
    el("div", { class: "field" }, el("label", null, "API Key"), keyIn),
    el("div", { class: "row", style: { justifyContent: "space-between" } }, el("strong", null, "可用模型"), fetchBtn),
    fetchedWrap,
    el("div", { class: "row" },
      manualIdIn,
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => {
          if (addModelEntry(manualIdIn.value, { canRefImage: purposeSel.value !== "text" })) {
            manualIdIn.value = "";
            renderModels();
          }
        },
      }, "+ 添加模型")
    ),
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
          toast("接口已保存");
        } catch (e) { toast(e.message); }
      },
    }, "保存"),
  ]);
  dialog.addEventListener("close", () => {
    dialogClosed = true;
    stopTestClock();
  }, { once: true });
}
