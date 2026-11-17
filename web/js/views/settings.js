import { api, clear, closeModal, el, money, onEvent, openURL, setColorScheme, showModal, toast } from "../api.js";
import { buildGroupedModelSelect } from "./create.js";

function formatEconomyText(balRes) {
  if (!balRes?.loggedIn) return "未登录网站账号";
  const eco = balRes.economy || {};
  const bal = eco.balanceCents ?? eco.walletBalanceCents ?? eco.balance ?? 0;
  const free = eco.freeRemaining ?? eco.dailyFreeRemaining ?? eco.freeQuotaRemaining ?? 0;
  const parts = [`可用余额 ${typeof bal === "number" ? money(bal) : bal}`];
  if (free !== undefined) parts.push(`剩余免费次数 ${free}`);
  if (balRes.offline) parts.push("（离线缓存）");
  return parts.join(" · ");
}

export async function renderSettings(root, ctx) {
  clear(root);

  const [accRes, balRes, settRes, plugRes, updRes, modRes] = await Promise.all([
    api("GET", "/api/account").catch(() => ({ loggedIn: false })),
    api("GET", "/api/account/balance").catch(() => ({ loggedIn: false })),
    api("GET", "/api/settings").catch(() => ({ settings: {}, providers: [] })),
    api("GET", "/api/plugins").catch(() => ({ builtin: [], community: [], knownPermissions: {} })),
    api("GET", "/api/update").catch(() => ({})),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [] })),
  ]);

  const settings = settRes.settings || {};
  const providers = settRes.providers || [];
  let loginPollTimer = null;

  root.appendChild(el("div", { class: "page-head" },
    el("h1", { class: "page-title" }, "设置与管理"),
    el("span", { class: "muted mono" }, `数据目录：${settRes.dataDir || ""}`)
  ));

  // 1. Account & Balance
  const accBox = el("section", { class: "card col", style: { marginBottom: "16px" } });
  const accHead = el("div", { class: "row", style: { justifyContent: "space-between" } },
    el("strong", null, "1. 网站账户与额度同步"),
    el("span", { class: "badge" + (accRes.loggedIn ? " badge-ok" : "") }, accRes.loggedIn ? "已登录" : "未登录")
  );
  accBox.appendChild(accHead);

  if (accRes.skillDetected) {
    accBox.appendChild(el("div", { class: "badge badge-accent" }, `检测到本机 Skill 已配置账号（${accRes.skillUsername || "已登录"}）；客户端使用独立加密令牌存储，互不覆盖`));
  }

  const loginStatusArea = el("div", { class: "col" });
  if (accRes.loggedIn) {
    const uname = accRes.user?.username || accRes.user?.name || accRes.user?.email || "手绘风用户";
    accBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between" } },
      el("div", { class: "col", style: { gap: "2px" } },
        el("span", null, `当前账号：${uname}`),
        el("span", { class: "muted" }, formatEconomyText(balRes))
      ),
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm", onClick: async () => { await ctx.refreshTopbar?.(true); renderSettings(root, ctx); toast("已刷新余额"); } }, "刷新额度"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(accRes.siteBase || settings.siteBase || "https://handraw-style.com") }, "账号控制台 ↗"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          onClick: async () => { await api("POST", "/api/account/logout"); await ctx.refreshTopbar?.(true); renderSettings(root, ctx); toast("已退出登录"); },
        }, "退出登录")
      )
    ));
  } else {
    const loginBtn = el("button", {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        try {
          const st = await api("POST", "/api/account/login");
          clear(loginStatusArea);
          loginStatusArea.appendChild(el("div", { class: "card", style: { background: "var(--paper)" } },
            el("div", null, "浏览器授权页已打开，确认验证码："),
            el("div", { class: "mono", style: { fontSize: "20px", fontWeight: 700, margin: "6px 0", color: "var(--accent)" } }, st.userCode || ""),
            st.verificationUrl ? el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(st.verificationUrl) }, "重新打开授权网页") : null
          ));
          clearInterval(loginPollTimer);
          loginPollTimer = setInterval(async () => {
            if (!root.isConnected) { clearInterval(loginPollTimer); return; }
            const poll = await api("GET", "/api/account/login").catch(() => null);
            if (poll?.loggedIn || poll?.status === "ok") {
              clearInterval(loginPollTimer);
              await ctx.refreshTopbar?.(true);
              renderSettings(root, ctx);
              toast("登录成功");
            } else if (poll?.status === "error") {
              clearInterval(loginPollTimer);
              toast(poll.error || "登录失败");
            }
          }, 2000);
        } catch (e) { toast(e.message); }
      },
    }, "登录手绘风账号");
    accBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between" } },
      el("span", { class: "muted" }, accRes.error || "登录后可使用网站模型、同步余额与免费额度、发布作品与收藏同步"),
      loginBtn
    ));
    accBox.appendChild(loginStatusArea);
  }
  root.appendChild(accBox);

  // 2. Custom Providers & Default Model
  const provBox = el("section", { class: "card col", style: { marginBottom: "16px" } },
    el("div", { class: "row", style: { justifyContent: "space-between" } },
      el("strong", null, "2. 生图与文本接口（自带 OpenAI 兼容 API）"),
      el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openProviderModal(null, () => renderSettings(root, ctx)) }, "+ 添加自定义接口")
    )
  );
  const defModelSel = buildGroupedModelSelect(modRes, settings.defaultModel);
  defModelSel.addEventListener("change", async () => {
    await api("PATCH", "/api/settings", { defaultModel: defModelSel.value });
    toast("已更新默认生图模型");
  });
  provBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between" } },
    el("span", { class: "muted" }, "全局默认生图模型（各工作室页面可随时单独切换）"),
    defModelSel
  ));
  if (!providers.length) {
    provBox.appendChild(el("div", { class: "muted" }, "尚未添加自带 API 接口；当前默认使用网站模型生图（亦可随时添加兼容接口本地直连生图）。"));
  } else {
    providers.forEach((p) => {
      provBox.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", background: "var(--paper)", padding: "10px 12px" } },
        el("div", { class: "col", style: { gap: "2px" } },
          el("div", { class: "row" },
            el("strong", null, p.name),
            el("span", { class: "badge" }, p.purpose === "text" ? "文本助手" : "生图接口"),
            p.hasKey ? el("span", { class: "badge badge-ok" }, "已存密钥") : el("span", { class: "badge badge-warn" }, "未填密钥")
          ),
          el("span", { class: "muted mono" }, `${p.baseUrl} · ${(p.models || []).length} 个模型`)
        ),
        el("div", { class: "row" },
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: async () => {
              const t = await api("POST", `/api/providers/${encodeURIComponent(p.id)}/test`, { model: p.models?.[0]?.id || "" }).catch((e) => ({ ok: false, error: e.message }));
              toast(t.ok ? `连通正常（${t.latencyMs}ms）` : `测试失败：${t.error}`);
            },
          }, "测试连通"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openProviderModal(p, () => renderSettings(root, ctx)) }, "编辑"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-danger",
            onClick: async () => { await api("DELETE", `/api/providers/${encodeURIComponent(p.id)}`); renderSettings(root, ctx); toast("已删除接口"); },
          }, "删除")
        )
      ));
    });
  }
  root.appendChild(provBox);

  // 3. Preferences & Sync
  const themeSel = el("select", { class: "select select-sm" },
    el("option", { value: "light", selected: settings.theme === "light" }, "暖纸浅色"),
    el("option", { value: "dark", selected: settings.theme === "dark" }, "夜墨深色"),
    el("option", { value: "system", selected: settings.theme === "system" }, "跟随系统")
  );
  themeSel.addEventListener("change", async () => {
    setColorScheme(themeSel.value);
    await api("PATCH", "/api/settings", { theme: themeSel.value });
    toast("外观主题已切换");
  });

  const worksIn = el("input", { class: "input", style: { flex: "1" }, value: settings.worksDir || "" });
  const costYuanIn = el("input", { class: "input", type: "number", step: "0.5", min: "0", style: { width: "100px" }, value: String((settings.costLimitCents || 0) / 100) });
  const hotkeyIn = el("input", { class: "input", style: { width: "140px" }, value: settings.quickShotHotkey || "Alt+Space" });
  const quickChk = el("input", { type: "checkbox", checked: Boolean(settings.quickShotEnabled) });
  const trayChk = el("input", { type: "checkbox", checked: Boolean(settings.minimizeToTray) });
  const autoUpdChk = el("input", { type: "checkbox", checked: Boolean(settings.autoCheckUpdate) });
  const autoSyncChk = el("input", { type: "checkbox", checked: Boolean(settings.autoSyncResources) });

  root.appendChild(el("section", { class: "card col", style: { marginBottom: "16px" } },
    el("strong", null, "3. 通用偏好与本地存储"),
    el("div", { class: "row", style: { justifyContent: "space-between" } }, el("span", null, "界面外观主题"), themeSel),
    el("div", { class: "field" },
      el("label", null, "本地作品保存目录"),
      el("div", { class: "row" }, worksIn, el("button", { type: "button", class: "btn btn-sm", onClick: () => api("POST", "/api/open", { path: worksIn.value.trim() }).catch((e) => toast(e.message)) }, "打开目录"))
    ),
    el("div", { class: "row", style: { justifyContent: "space-between" } },
      el("span", null, "网站单次生成费用提醒阈值（元，0 表示每次均不拦截）"),
      costYuanIn
    ),
    el("div", { class: "row", style: { justifyContent: "space-between" } },
      el("label", { class: "row" }, quickChk, "启用全局快门窗快捷键"),
      hotkeyIn
    ),
    el("div", { class: "row" },
      el("label", { class: "row" }, trayChk, "关闭主窗口时最小化到系统托盘"),
      el("label", { class: "row" }, autoUpdChk, "自动检查软件更新"),
      el("label", { class: "row" }, autoSyncChk, "登录后自动同步自定义画风")
    ),
    el("div", { class: "row" },
      el("button", {
        type: "button",
        class: "btn btn-primary btn-sm",
        onClick: async () => {
          try {
            await api("PATCH", "/api/settings", {
              worksDir: worksIn.value.trim(),
              costLimitCents: Math.round(Number(costYuanIn.value || 0) * 100),
              quickShotHotkey: hotkeyIn.value.trim(),
              quickShotEnabled: quickChk.checked,
              minimizeToTray: trayChk.checked,
              autoCheckUpdate: autoUpdChk.checked,
              autoSyncResources: autoSyncChk.checked,
            });
            toast("偏好设置已保存");
          } catch (e) { toast(e.message); }
        },
      }, "保存偏好设置"),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => {
          try {
            const r = await api("POST", "/api/mine/sync");
            toast(r.ok ? `已同步 ${r.pushed || 0} 个自定义资源` : (r.message || r.error || "同步完成"));
          } catch (e) { toast(e.message); }
        },
      }, "🔄 立即同步自定义画风/图型")
    )
  ));

  // 4. Built-in features & Community Plugins
  const plugBox = el("section", { class: "card col", style: { marginBottom: "16px" } },
    el("strong", null, "4. 模块管理与社区插件")
  );
  (plugRes.builtin || []).forEach((b) => {
    const chk = el("input", { type: "checkbox", checked: b.enabled });
    chk.addEventListener("change", async () => {
      try {
        await api("PATCH", `/api/plugins/${encodeURIComponent(b.id)}`, { enabled: chk.checked });
        ctx.refreshNav?.();
        toast(chk.checked ? `已启用「${b.name}」` : `已停用「${b.name}」`);
      } catch (e) {
        chk.checked = !chk.checked;
        toast(e.message);
      }
    });
    const row = el("div", { class: "card col", style: { background: "var(--paper)", padding: "10px 12px" } },
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("div", null, el("strong", null, b.name), " ", el("span", { class: "muted" }, b.desc || "")),
        el("label", { class: "row", style: { cursor: "pointer" } }, chk, b.enabled ? "已开启" : "已关闭")
      )
    );
    (b.settings || []).forEach((sf) => {
      const val = b.config?.[sf.key] ?? sf.default ?? "";
      let ctrl;
      if (sf.type === "enum" && Array.isArray(sf.enum)) {
        ctrl = el("select", { class: "select select-sm", style: { width: "auto" } }, ...sf.enum.map((opt) => el("option", { value: opt, selected: String(val) === opt }, opt)));
        ctrl.addEventListener("change", async () => {
          await api("PATCH", `/api/plugins/${encodeURIComponent(b.id)}`, { config: { ...b.config, [sf.key]: ctrl.value } });
          toast("已更新模块配置");
        });
      } else {
        ctrl = el("input", { class: "input", style: { maxWidth: "180px" }, value: String(val) });
        ctrl.addEventListener("change", async () => {
          await api("PATCH", `/api/plugins/${encodeURIComponent(b.id)}`, { config: { ...b.config, [sf.key]: ctrl.value } });
          toast("已更新模块配置");
        });
      }
      row.appendChild(el("div", { class: "row", style: { justifyContent: "space-between" } }, el("span", { class: "muted" }, sf.title || sf.key), ctrl));
    });
    plugBox.appendChild(row);
  });

  const srcIn = el("input", { class: "input", style: { flex: "1" }, placeholder: "安装社区插件：输入本地文件夹路径或 ZIP/Manifest URL…" });
  plugBox.appendChild(el("div", { class: "row", style: { marginTop: "6px" } },
    srcIn,
    el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: async () => {
        if (!srcIn.value.trim()) return toast("请输入插件来源路径或网址");
        try {
          await api("POST", "/api/plugins/install", { source: srcIn.value.trim() });
          toast("社区插件已安装");
          renderSettings(root, ctx);
        } catch (e) { toast(e.message); }
      },
    }, "安装插件")
  ));

  const permsMap = plugRes.knownPermissions || {};
  (plugRes.community || []).forEach((c) => {
    const chk = el("input", { type: "checkbox", checked: Boolean(c.enabled) });
    chk.addEventListener("change", async () => {
      await api("PATCH", `/api/plugins/community:${encodeURIComponent(c.id)}`, { enabled: chk.checked });
      ctx.refreshNav?.();
      toast(chk.checked ? "插件已启用" : "插件已停用");
    });
    plugBox.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", background: "var(--paper)", padding: "10px 12px" } },
      el("div", { class: "col", style: { gap: "4px" } },
        el("div", { class: "row" },
          el("strong", null, `${c.name} (${c.version})`),
          ...(c.permissions || []).map((pm) => el("span", { class: "badge badge-warn", title: permsMap[pm] || pm }, pm))
        ),
        el("span", { class: "muted" }, c.desc || c.author || "")
      ),
      el("div", { class: "row" },
        el("label", { class: "row" }, chk, "启用"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          onClick: async () => { await api("DELETE", `/api/plugins/${encodeURIComponent(c.id)}`); ctx.refreshNav?.(); renderSettings(root, ctx); toast("已卸载插件"); },
        }, "卸载")
      )
    ));
  });
  root.appendChild(plugBox);

  // 5. Version & Incremental Resource Updates
  const resProg = el("span", { class: "muted" }, "");
  const updBox = el("section", { class: "card col" },
    el("strong", null, "5. 客户端版本与资源包更新"),
    el("div", { class: "muted" }, `客户端当前版本：${updRes.current || "?"} · 远端最新：${updRes.latest || "未检查"} · 本地资源包：${updRes.resourceLocal || "?"}${updRes.resourceNew ? " -> 新版 " + updRes.resourceNew : ""}`),
    resProg,
    el("div", { class: "row" },
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => {
          const r = await api("POST", "/api/update/check").catch((e) => ({ error: e.message }));
          toast(r.status?.available ? `发现新版 ${r.status.latest}` : (r.error || "已是最新版本"));
          renderSettings(root, ctx);
        },
      }, "检查版本与资源更新"),
      updRes.available ? el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: async () => { await api("POST", "/api/update/download"); toast("正在后台下载更新包…"); },
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
            renderSettings(root, ctx);
          } catch (e) { toast(e.message); }
        },
      }, "增量更新资源包")
    )
  );
  root.appendChild(updBox);

  const unsub = onEvent((msg) => {
    if (!root.isConnected) { clearInterval(loginPollTimer); unsub(); return; }
    if (msg.type === "resource_update") {
      resProg.textContent = `资源包增量下载进度：${msg.data?.done || 0} / ${msg.data?.total || 0}`;
    } else if (msg.type === "account" && msg.data?.loggedIn) {
      clearInterval(loginPollTimer);
      ctx.refreshTopbar?.(true);
      renderSettings(root, ctx);
    }
  });
}

function openProviderModal(existing, onSaved) {
  const isNew = !existing;
  const prov = existing ? structuredClone(existing) : { id: "", name: "", kind: "openai", purpose: "image", baseUrl: "", enabled: true, models: [] };

  const nameIn = el("input", { class: "input", value: prov.name || "", placeholder: "例如：火山方舟 / 中转站" });
  const purposeSel = el("select", { class: "select" },
    el("option", { value: "image", selected: prov.purpose !== "text" }, "生图接口"),
    el("option", { value: "text", selected: prov.purpose === "text" }, "文本扩写/规划助手")
  );
  const urlIn = el("input", { class: "input", value: prov.baseUrl || "", placeholder: "https://api.example.com/v1" });
  const keyIn = el("input", { class: "input", type: "password", placeholder: prov.hasKey ? "留空则保留现有密钥" : "输入 API Key（存入系统凭据库）" });
  const modelsWrap = el("div", { class: "col", style: { gap: "6px", maxHeight: "200px", overflowY: "auto" } });
  const manualIdIn = el("input", { class: "input", placeholder: "手动添加模型 ID（回车或点添加）" });

  function renderModels() {
    clear(modelsWrap);
    (prov.models || []).forEach((m, idx) => {
      const refChk = el("input", { type: "checkbox", checked: Boolean(m.canRefImage) });
      refChk.addEventListener("change", () => { m.canRefImage = refChk.checked; });
      const editChk = el("input", { type: "checkbox", checked: Boolean(m.canEdit) });
      editChk.addEventListener("change", () => { m.canEdit = editChk.checked; });
      modelsWrap.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", background: "var(--paper)", padding: "6px 8px", borderRadius: "6px" } },
        el("span", { class: "mono", style: { fontSize: "12px" } }, m.id),
        el("div", { class: "row" },
          el("label", { class: "row", style: { fontSize: "11.5px" } }, refChk, "垫图"),
          el("label", { class: "row", style: { fontSize: "11.5px" } }, editChk, "编辑"),
          el("button", { type: "button", class: "btn btn-sm btn-danger", onClick: () => { prov.models.splice(idx, 1); renderModels(); } }, "×")
        )
      ));
    });
  }
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
        const existingSet = new Set((prov.models || []).map((m) => m.id));
        (r.models || []).forEach((id) => {
          if (!existingSet.has(id)) prov.models.push({ id, label: id, canRefImage: false, canEdit: false });
        });
        renderModels();
        toast(`获取到 ${(r.models || []).length} 个模型，请勾留需要显示的条目并保存`);
      } catch (e) { toast(e.message); }
    },
  }, "🔍 拉取 /models");

  showModal(isNew ? "添加自定义接口" : "编辑接口", el("div", { class: "col" },
    el("div", { class: "field" }, el("label", null, "接口名称"), nameIn),
    el("div", { class: "field" }, el("label", null, "用途"), purposeSel),
    el("div", { class: "field" }, el("label", null, "Base URL"), urlIn),
    el("div", { class: "field" }, el("label", null, "API Key"), keyIn),
    el("div", { class: "row", style: { justifyContent: "space-between" } }, el("strong", null, "可用模型"), fetchBtn),
    el("div", { class: "row" },
      manualIdIn,
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => {
          const id = manualIdIn.value.trim();
          if (id) { prov.models.push({ id, label: id, canRefImage: true, canEdit: false }); manualIdIn.value = ""; renderModels(); }
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
}
