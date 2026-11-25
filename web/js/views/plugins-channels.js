import { api, clear, closeModal, el, openURL, showModal, toast } from "../api.js";
import { formatSkillSourceLabel, openHarnessSkillImportModal } from "../skills-ui.js";

export function mirrorTag(m) {
  if (m === "gitee") return "Gitee";
  if (m === "github") return "GitHub";
  return "";
}

export function pricingBadge(pricing) {
  const model = pricing?.model || "free";
  if (!pricing || model === "free") return null;
  if (model === "pro") return el("span", { class: "pm-chip pm-price-pro" }, "Pro 会员");
  if (model === "credits" && pricing.credits > 0) {
    return el("span", { class: "pm-chip pm-price-paid" }, `${pricing.credits} 积分`);
  }
  if (model === "paid" && pricing.priceCents > 0) {
    return el("span", { class: "pm-chip pm-price-paid" }, `¥${(pricing.priceCents / 100).toFixed(2)}`);
  }
  return null;
}

function formatBytes(n) {
  const b = Number(n || 0);
  if (b <= 0) return "0 KB";
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDownloads(n) {
  const num = Number(n || 0);
  if (!num) return "";
  if (num >= 10000) return `${(num / 10000).toFixed(1)} 万下载`;
  return `${num.toLocaleString()} 下载`;
}

function formatDateShort(raw) {
  if (!raw) return "";
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw);
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

export function renderSourceChips(sources, busy, onRemove) {
  const wrap = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", alignItems: "center" } });
  (sources || []).forEach((s) => {
    const mTag = mirrorTag(s.activeMirror);
    wrap.appendChild(el("span", {
      class: "badge" + (s.official ? " badge-accent" : ""),
      title: s.error
        ? `${s.url}\n加载失败：${s.error}${s.fallback ? "（已使用内置回退索引）" : ""}`
        : (s.activeUrl || s.url),
      style: { display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 9px" },
    },
      s.name || s.id,
      s.fallback ? "（离线索引）" : (s.error ? "（连接失败）" : `${mTag ? " · " + mTag : ""} · ${s.count || 0}`),
      !s.official && onRemove
        ? el("button", {
            type: "button",
            class: "gal-chip-x",
            "aria-label": `移除市场源 ${s.name || s.id}`,
            disabled: Boolean(busy),
            onClick: () => onRemove(s),
          }, "×")
        : null
    ));
  });
  return wrap;
}

// =========================================================================
// Shared: Extension Market Inclusion Submission Modal (integrated with handraw-web #523)
// =========================================================================

const CHANNEL_OPTIONS = [
  { value: "plugin", label: "工作台插件", repoPlaceholder: "https://github.com/owner/repo 或 npm:@scope/pkg" },
  { value: "gallery", label: "图库插件", repoPlaceholder: "https://github.com/owner/gallery-repo 或 index.json / .zip 地址" },
  { value: "skill", label: "Skills", repoPlaceholder: "https://github.com/owner/skill-repo 或 SKILL.md 仓库地址" },
  { value: "obsidian", label: "写作插件", repoPlaceholder: "GitHub 仓库（owner/repo 或 https://github.com/owner/repo）" },
];

const SUBMISSION_STATUS_MAP = {
  pending: { label: "待审核", cls: "badge badge-warn" },
  approved: { label: "已通过", cls: "badge badge-ok" },
  rejected: { label: "已拒绝", cls: "badge badge-err" },
};

export function openExtensionSubmitModal(ctx, { channel = "plugin", prefill = null } = {}) {
  let mode = "form"; // "form" | "mine"
  let submitting = false;
  let mineData = null;
  let mineLoading = false;

  const chSel = el("select", { class: "select" },
    ...CHANNEL_OPTIONS.map((c) => el("option", { value: c.value, selected: c.value === channel }, c.label))
  );
  const currentMeta = () => CHANNEL_OPTIONS.find((c) => c.value === chSel.value) || CHANNEL_OPTIONS[0];

  const nameIn = el("input", {
    class: "input",
    type: "text",
    value: prefill?.name || "",
    placeholder: "插件显示名称（必填）",
  });
  const repoIn = el("input", {
    class: "input mono",
    type: "text",
    value: prefill?.repoUrl || "",
    placeholder: currentMeta().repoPlaceholder,
  });
  chSel.addEventListener("change", () => {
    repoIn.placeholder = currentMeta().repoPlaceholder;
  });

  const descIn = el("textarea", {
    class: "textarea",
    rows: "3",
    placeholder: "简要说明插件用途、核心功能与使用方式（必填）",
  });
  descIn.value = prefill?.description || "";

  const authorIn = el("input", {
    class: "input",
    type: "text",
    value: prefill?.authorName || "",
    placeholder: "作者名称（可选，默认当前账号）",
  });
  const verIn = el("input", {
    class: "input mono",
    type: "text",
    value: prefill?.version || "",
    placeholder: "版本号，如 1.0.0（可选）",
  });
  const homeIn = el("input", {
    class: "input",
    type: "url",
    value: prefill?.homepageUrl || "",
    placeholder: "主页或文档链接 https://...（可选）",
  });
  const contactIn = el("input", {
    class: "input",
    type: "text",
    value: "",
    placeholder: "联系方式：邮箱 / 微信 / GitHub（可选）",
  });
  const tagsIn = el("input", {
    class: "input",
    type: "text",
    value: Array.isArray(prefill?.tags) ? prefill.tags.join(", ") : "",
    placeholder: "标签，逗号分隔（可选）",
  });
  const notesIn = el("textarea", {
    class: "textarea",
    rows: "2",
    placeholder: "补充说明：兼容范围、安装注意事项、Gitee 镜像等（可选）",
  });

  const errBox = el("div", { class: "muted", style: { color: "var(--err, #c62828)", fontSize: "12.5px", display: "none" } });
  const bodyHost = el("div", { class: "col", style: { gap: "10px" } });
  const tabHost = el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "8px" } });
  const submitBtn = el("button", { type: "button", class: "btn btn-primary" }, "提交收录申请");

  const loadMine = async () => {
    mineLoading = true;
    paintBody();
    try {
      mineData = await api("GET", "/api/extensions/submissions/mine?limit=50");
    } catch (e) {
      mineData = { loggedIn: false, items: [], error: e.message };
    } finally {
      mineLoading = false;
      if (bodyHost.isConnected) paintBody();
    }
  };

  const paintTabs = () => {
    clear(tabHost);
    tabHost.appendChild(el("div", { class: "pm-seg-group", role: "tablist" },
      el("button", {
        type: "button",
        class: "pm-seg-btn" + (mode === "form" ? " is-active" : ""),
        onClick: () => { mode = "form"; paintTabs(); paintBody(); },
      }, "提交申请"),
      el("button", {
        type: "button",
        class: "pm-seg-btn" + (mode === "mine" ? " is-active" : ""),
        onClick: () => {
          mode = "mine";
          paintTabs();
          if (!mineData) loadMine();
          else paintBody();
        },
      }, `我的申请${mineData?.items?.length ? ` (${mineData.items.length})` : ""}`)
    ));
    if (mode === "mine") {
      tabHost.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: loadMine,
      }, "↻ 刷新"));
    }
    submitBtn.style.display = mode === "form" ? "" : "none";
  };

  const paintBody = () => {
    clear(bodyHost);
    if (mode === "form") {
      bodyHost.append(
        el("div", { class: "split" },
          el("div", { class: "field" }, el("label", null, "所属栏目"), chSel),
          el("div", { class: "field" }, el("label", null, "插件名称 *"), nameIn)
        ),
        el("div", { class: "field" }, el("label", null, "仓库 / 下载地址 *"), repoIn),
        el("div", { class: "field" }, el("label", null, "插件简介 *"), descIn),
        el("div", { class: "split" },
          el("div", { class: "field" }, el("label", null, "作者名称"), authorIn),
          el("div", { class: "field" }, el("label", null, "版本号"), verIn)
        ),
        el("div", { class: "split" },
          el("div", { class: "field" }, el("label", null, "主页 / 文档链接"), homeIn),
          el("div", { class: "field" }, el("label", null, "联系方式"), contactIn)
        ),
        el("div", { class: "field" }, el("label", null, "标签"), tagsIn),
        el("div", { class: "field" }, el("label", null, "补充说明"), notesIn),
        errBox
      );
      return;
    }

    if (mineLoading) {
      bodyHost.appendChild(el("div", { class: "muted", style: { padding: "18px 0", textAlign: "center" } }, "正在加载申请记录…"));
      return;
    }
    if (mineData && mineData.loggedIn === false) {
      bodyHost.appendChild(el("div", { class: "card col", style: { gap: "8px", alignItems: "center", padding: "20px" } },
        el("span", { class: "muted" }, "登录后可查看你的插件收录申请与审核进度。"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => { closeModal(); ctx.go("settings"); },
        }, "前往登录")
      ));
      return;
    }
    const items = Array.isArray(mineData?.items) ? mineData.items : [];
    if (!items.length) {
      bodyHost.appendChild(el("div", { class: "card muted", style: { padding: "20px", textAlign: "center" } }, "你还没有提交过插件收录申请。"));
      return;
    }
    const listWrap = el("div", { class: "col", style: { gap: "8px", maxHeight: "360px", overflowY: "auto" } });
    items.forEach((it) => {
      const sb = SUBMISSION_STATUS_MAP[it.status] || { label: it.status || "待审核", cls: "badge" };
      listWrap.appendChild(el("div", { class: "card col", style: { gap: "4px", padding: "10px 12px" } },
        el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          el("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap" } },
            el("strong", null, it.name),
            el("span", { class: "badge" }, it.channelLabel || it.channel),
            el("span", { class: sb.cls }, sb.label)
          ),
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, formatDateShort(it.createdAt))
        ),
        el("div", { class: "mono muted", style: { fontSize: "11.5px", wordBreak: "break-all" } }, it.repoUrl),
        it.adminNote
          ? el("div", { class: "muted", style: { fontSize: "12px", borderTop: "1px dashed var(--line)", paddingTop: "4px", marginTop: "2px" } }, `审核备注：${it.adminNote}`)
          : null
      ));
    });
    bodyHost.appendChild(listWrap);
  };

  submitBtn.addEventListener("click", async () => {
    if (submitting) return;
    errBox.style.display = "none";
    errBox.textContent = "";
    const name = nameIn.value.trim();
    const repoUrl = repoIn.value.trim();
    const description = descIn.value.trim();
    if (name.length < 2) {
      errBox.textContent = "请填写插件名称（至少 2 个字符）";
      errBox.style.display = "block";
      return;
    }
    if (!repoUrl) {
      errBox.textContent = "请填写仓库或下载地址";
      errBox.style.display = "block";
      return;
    }
    if (description.length < 4) {
      errBox.textContent = "请填写简短插件简介（至少 4 个字符）";
      errBox.style.display = "block";
      return;
    }
    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "提交中…";
    try {
      const tags = tagsIn.value
        .split(/[,，\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      await api("POST", "/api/extensions/submissions", {
        channel: chSel.value,
        name,
        slug: prefill?.slug || "",
        repoUrl,
        homepageUrl: homeIn.value.trim(),
        description,
        authorName: authorIn.value.trim(),
        version: verIn.value.trim(),
        tags,
        contact: contactIn.value.trim(),
        notes: notesIn.value.trim(),
      });
      toast("收录申请已提交，管理员审核后将收录至官方市场");
      mode = "mine";
      mineData = null;
      paintTabs();
      await loadMine();
    } catch (e) {
      const msg = e?.message || "提交失败";
      errBox.textContent = msg;
      errBox.style.display = "block";
      if (e?.status === 401 || msg.includes("登录")) {
        errBox.append(" ", el("a", {
          href: "#settings",
          onClick: (ev) => { ev.preventDefault(); closeModal(); ctx.go("settings"); },
        }, "去登录 →"));
      }
    } finally {
      submitting = false;
      if (submitBtn.isConnected) {
        submitBtn.disabled = false;
        submitBtn.textContent = "提交收录申请";
      }
    }
  });

  paintTabs();
  paintBody();

  showModal("申请收录到官方市场", el("div", { class: "col", style: { gap: "12px" } }, tabHost, bodyHost), [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    submitBtn,
  ]);
}

// =========================================================================
// 1. Galleries Channel (图库插件：页内独立管理 市场 / 已安装)
// =========================================================================

export function renderGalleriesMarketTab(stage, ctx, helpers) {
  const { getMirror, makeSkeletonGrid, refreshHub } = helpers;
  let subMode = "market"; // "market" | "installed"
  let data = null;
  let activeCat = "";
  let query = "";
  let busyId = "";
  let panelMode = ""; // "" | "add-source" | "direct-url"

  const topHost = el("div", { class: "col", style: { gap: "10px" } });
  const gridHost = el("div", { class: "col", style: { gap: "10px" } });

  const searchIn = el("input", {
    type: "search",
    class: "input pm-search-input",
    placeholder: "搜索图库插件…",
    "aria-label": "搜索图库插件",
  });
  searchIn.addEventListener("input", () => { query = searchIn.value; paint(); });

  stage.append(topHost, gridHost);

  const load = async (refresh = false) => {
    data = null;
    paint();
    try {
      const m = getMirror();
      data = await api("GET", `/api/galleries/market?mirror=${encodeURIComponent(m)}${refresh ? "&refresh=1" : ""}`);
    } catch (e) {
      data = { sources: [], categories: [], packs: [], error: e.message };
    }
    if (stage.isConnected) paint();
  };

  const paint = () => {
    clear(topHost);
    clear(gridHost);
    if (!data) {
      gridHost.appendChild(makeSkeletonGrid(6));
      return;
    }

    const packs = data.packs || [];
    const installedPacks = packs.filter((p) => p.installed);
    const cats = data.categories || [];
    const srcChips = renderSourceChips(data.sources, busyId, async (s) => {
      busyId = "__rm__";
      paint();
      try {
        data = await api("DELETE", `/api/galleries/market/sources/${encodeURIComponent(s.id)}`);
        toast(`已移除图库源「${s.name || s.id}」`);
      } catch (e) { toast(e.message || "移除失败"); }
      finally { busyId = ""; if (stage.isConnected) paint(); }
    });

    const subToggle = el("div", { class: "pm-seg-group", role: "tablist" },
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "market" ? " is-active" : ""), onClick: () => { subMode = "market"; paint(); } }, `市场 (${packs.length})`),
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "installed" ? " is-active" : ""), onClick: () => { subMode = "installed"; paint(); } }, `已安装 (${installedPacks.length})`)
    );

    const catBar = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", alignItems: "center" } }, subToggle);
    if (subMode === "market") {
      catBar.appendChild(el("button", { type: "button", class: "btn btn-sm" + (activeCat === "" ? " btn-primary" : ""), onClick: () => { activeCat = ""; paint(); } }, "全部分类"));
      cats.forEach((c) => {
        catBar.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm" + (activeCat === c.id ? " btn-primary" : ""),
          onClick: () => { activeCat = c.id; paint(); },
        }, `${c.name} (${c.count})`));
      });
    }

    topHost.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
        srcChips,
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openExtensionSubmitModal(ctx, { channel: "gallery" }) }, "＋ 申请收录"),
          el("button", { type: "button", class: "btn btn-sm" + (panelMode === "add-source" ? " btn-primary" : ""), onClick: () => { panelMode = panelMode === "add-source" ? "" : "add-source"; paint(); } }, "+ 添加源"),
          el("button", { type: "button", class: "btn btn-sm" + (panelMode === "direct-url" ? " btn-primary" : ""), onClick: () => { panelMode = panelMode === "direct-url" ? "" : "direct-url"; paint(); } }, "🔗 链接直装"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => load(true) }, "↻ 刷新")
        )
      ),
      el("div", { class: "pm-filter-bar" }, catBar, searchIn)
    ));

    if (panelMode === "add-source") {
      const urlIn = el("input", { class: "input", type: "url", placeholder: "https://.../index.json（Format 1 图库市场）", style: { flex: "1", minWidth: "240px" } });
      const nameIn = el("input", { class: "input", type: "text", placeholder: "市场名称（可选）", style: { maxWidth: "200px" } });
      topHost.appendChild(el("div", { class: "card row", style: { gap: "8px", flexWrap: "wrap", borderColor: "var(--accent)" } },
        urlIn, nameIn,
        el("button", {
          type: "button", class: "btn btn-sm btn-primary", disabled: Boolean(busyId),
          onClick: async () => {
            if (!urlIn.value.trim()) return toast("请填写 index.json 地址");
            busyId = "__add__"; paint();
            try {
              data = await api("POST", "/api/galleries/market/sources", { url: urlIn.value.trim(), name: nameIn.value.trim() });
              panelMode = ""; toast("已订阅图库市场源");
            } catch (e) { toast(e.message || "添加失败"); }
            finally { busyId = ""; if (stage.isConnected) paint(); }
          },
        }, "确认订阅")
      ));
    } else if (panelMode === "direct-url") {
      const urlIn = el("input", { class: "input", type: "url", placeholder: "单个图库插件 .json 或 .zip 链接（https://...）", style: { flex: "1", minWidth: "240px" } });
      const idIn = el("input", { class: "input mono", type: "text", placeholder: "自定义 ID（可选）", style: { maxWidth: "160px" } });
      topHost.appendChild(el("div", { class: "card row", style: { gap: "8px", flexWrap: "wrap", borderColor: "var(--accent)" } },
        urlIn, idIn,
        el("button", {
          type: "button", class: "btn btn-sm btn-primary", disabled: Boolean(busyId),
          onClick: async () => {
            if (!urlIn.value.trim()) return toast("请填写图库链接");
            busyId = "__direct__"; paint();
            try {
              data = await api("POST", "/api/galleries/market/install", { url: urlIn.value.trim(), id: idIn.value.trim(), mirror: getMirror() });
              panelMode = ""; toast("已安装扩展图库"); refreshHub?.();
            } catch (e) { toast(e.message || "安装失败"); }
            finally { busyId = ""; if (stage.isConnected) paint(); }
          },
        }, "立即安装")
      ));
    }

    const q = query.trim().toLowerCase();

    if (subMode === "installed") {
      const list = installedPacks.filter((p) =>
        !q || `${p.id} ${p.name} ${p.nameEn || ""} ${p.description || ""} ${p.author || ""}`.toLowerCase().includes(q)
      );
      if (!list.length) {
        gridHost.appendChild(el("div", { class: "card col", style: { alignItems: "center", gap: "10px", padding: "28px 16px" } },
          el("span", { class: "muted" }, "暂无已安装的图库插件"),
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => { subMode = "market"; paint(); } }, "浏览图库市场")
        ));
        return;
      }
      const listEl = el("div", { class: "pm-installed-list" });
      list.forEach((p) => {
        const isBusy = busyId === p.id;
        listEl.appendChild(el("div", { class: "pm-inst-row" },
          el("div", { class: "row", style: { gap: "11px", minWidth: 0, flex: "1", alignItems: "center" } },
            el("div", { class: "pm-logo", style: { fontSize: "18px" } }, p.multiVariant ? "🧍" : "🖼️"),
            el("div", { class: "col", style: { gap: "3px", minWidth: 0, flex: "1" } },
              el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
                el("strong", { style: { fontSize: "13.5px" } }, p.name),
                p.installedVersion || p.version ? el("span", { class: "pm-ver mono" }, `v${p.installedVersion || p.version}`) : null,
                el("span", { class: "pm-chip soft" }, `${p.itemCount || 0} 条 · ${formatBytes(p.cachedBytes)}`)
              ),
              el("span", { class: "muted", style: { fontSize: "12px" } }, p.description || p.id)
            )
          ),
          el("div", { class: "row", style: { gap: "6px", flexShrink: 0 } },
            el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("atlas", { tab: p.id }) }, "去画廊"),
            !p.customInstall
              ? el("button", {
                  type: "button", class: "btn btn-sm", disabled: Boolean(busyId),
                  onClick: async () => {
                    busyId = p.id; paint();
                    try {
                      data = await api("POST", "/api/galleries/market/install", { id: p.id, mirror: getMirror() });
                      toast(`已更新「${p.name}」`);
                    } catch (e) { toast(e.message || "更新失败"); }
                    finally { busyId = ""; if (stage.isConnected) paint(); }
                  },
                }, isBusy ? "更新中…" : "更新")
              : null,
            p.customInstall
              ? el("button", {
                  type: "button", class: "btn btn-sm",
                  onClick: () => openExtensionSubmitModal(ctx, {
                    channel: "gallery",
                    prefill: { name: p.name, slug: p.id, repoUrl: p.sourceUrl || p.homepage || "", description: p.description || "", authorName: p.author || "", version: p.version || "" },
                  }),
                }, "申请收录")
              : null,
            el("button", {
              type: "button", class: "btn btn-sm btn-danger", disabled: Boolean(busyId),
              onClick: async () => {
                if (!window.confirm(`卸载「${p.name}」并清理本地缓存（${formatBytes(p.cachedBytes)}）？`)) return;
                busyId = p.id; paint();
                try {
                  data = await api("POST", `/api/galleries/market/${encodeURIComponent(p.id)}/uninstall`, { purgeCache: true });
                  toast(`已卸载「${p.name}」`); refreshHub?.();
                } catch (e) { toast(e.message || "卸载失败"); }
                finally { busyId = ""; if (stage.isConnected) paint(); }
              },
            }, "卸载")
          )
        ));
      });
      gridHost.appendChild(listEl);
      return;
    }

    const list = packs.filter((p) => {
      if (activeCat && !(p.categories || []).includes(activeCat)) return false;
      if (!q) return true;
      return `${p.id} ${p.name} ${p.nameEn || ""} ${p.description || ""} ${p.author || ""}`.toLowerCase().includes(q);
    });

    if (!list.length) {
      gridHost.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "28px 16px" } }, "暂无匹配的图库插件。"));
      return;
    }

    const grid = el("div", { class: "pm-grid" });
    list.forEach((p) => {
      const isBusy = busyId === p.id;
      const actBtn = p.installed
        ? el("button", {
            type: "button", class: "pm-act done",
            onClick: () => ctx.go("atlas", { tab: p.id }),
          }, "去画廊")
        : el("button", {
            type: "button", class: "pm-act " + (isBusy ? "busy" : "get"), disabled: Boolean(busyId),
            onClick: async () => {
              busyId = p.id; paint();
              try {
                data = await api("POST", "/api/galleries/market/install", { id: p.id, mirror: getMirror() });
                toast(`已安装「${p.name}」`);
                refreshHub?.();
              } catch (e) { toast(e.message || "安装失败"); }
              finally { busyId = ""; if (stage.isConnected) paint(); }
            },
          }, isBusy ? "安装中" : "安装");

      const footerBtns = p.installed
        ? el("div", { class: "row", style: { gap: "6px" } },
            !p.customInstall
              ? el("button", {
                  type: "button", class: "btn btn-sm", disabled: Boolean(busyId),
                  onClick: async () => {
                    busyId = p.id; paint();
                    try {
                      data = await api("POST", "/api/galleries/market/install", { id: p.id, mirror: getMirror() });
                      toast(`已更新「${p.name}」`);
                    } catch (e) { toast(e.message || "更新失败"); }
                    finally { busyId = ""; if (stage.isConnected) paint(); }
                  },
                }, "更新")
              : null,
            el("button", {
              type: "button", class: "btn btn-sm btn-danger", disabled: Boolean(busyId),
              onClick: async () => {
                if (!window.confirm(`卸载「${p.name}」并清理本地缓存（${formatBytes(p.cachedBytes)}）？`)) return;
                busyId = p.id; paint();
                try {
                  data = await api("POST", `/api/galleries/market/${encodeURIComponent(p.id)}/uninstall`, { purgeCache: true });
                  toast(`已卸载「${p.name}」`); refreshHub?.();
                } catch (e) { toast(e.message || "卸载失败"); }
                finally { busyId = ""; if (stage.isConnected) paint(); }
              },
            }, "卸载")
          )
        : (p.homepage
            ? el("a", { href: p.homepage, class: "muted", style: { fontSize: "11.5px" }, onClick: (e) => { e.preventDefault(); openURL(p.homepage); } }, "主页 ↗")
            : null);

      grid.appendChild(el("article", { class: "pm-card" },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, p.multiVariant ? "🧍" : "🖼️"),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, p.name)),
            el("div", { class: "pm-card-by" },
              p.badge ? el("span", { class: "pm-verified-tag" }, p.badge) : null,
              el("span", { class: "pm-author-text" }, `${p.author || p.id}${p.license ? " · " + p.license : ""}`)
            )
          ),
          actBtn
        ),
        el("p", { class: "pm-card-desc", title: p.description || "" }, p.description || p.id),
        el("div", { class: "pm-card-meta", style: { justifyContent: "space-between" } },
          el("div", { class: "row", style: { gap: "5px", flexWrap: "wrap" } },
            p.version ? el("span", { class: "pm-ver mono" }, `v${p.version}`) : null,
            el("span", { class: "pm-chip soft" }, p.sourceType === "zip" ? "离线 ZIP" : "标准 JSON"),
            p.installed ? el("span", { class: "pm-chip" }, `${p.itemCount || 0} 条 · ${formatBytes(p.cachedBytes)}`) : null
          ),
          footerBtns
        )
      ));
    });
    gridHost.appendChild(grid);
  };

  load(false);
}

// =========================================================================
// 2. Skills Channel (Skills：页内独立管理 市场 / 已安装)
// =========================================================================

export function renderSkillsHubTab(stage, root, ctx, initialInstalledSkills, helpers) {
  const { getMirror, makeSkeletonGrid, refreshHub } = helpers;
  let subMode = "market"; // "market" | "installed"
  let marketData = null;
  let installedSkills = Array.isArray(initialInstalledSkills) ? initialInstalledSkills : [];
  let activeCat = "";
  let query = "";
  let busyId = "";

  const topHost = el("div", { class: "col", style: { gap: "10px" } });
  const bodyHost = el("div", { class: "col", style: { gap: "10px" } });

  const searchIn = el("input", {
    type: "search",
    class: "input pm-search-input",
    placeholder: "搜索 Skill…",
    "aria-label": "搜索 Skill",
  });
  searchIn.addEventListener("input", () => { query = searchIn.value; paint(); });

  stage.append(topHost, bodyHost);

  const loadMarket = async (refresh = false) => {
    marketData = null;
    paint();
    try {
      const m = getMirror();
      const [mkt, inst] = await Promise.all([
        api("GET", `/api/skills/market?mirror=${encodeURIComponent(m)}${refresh ? "&refresh=1" : ""}`),
        api("GET", "/api/skills").catch(() => ({ items: installedSkills })),
      ]);
      marketData = mkt;
      if (Array.isArray(inst?.items)) installedSkills = inst.items;
    } catch (e) {
      marketData = { sources: [], categories: [], skills: [], error: e.message };
    }
    if (stage.isConnected) paint();
  };

  const openAddSkillSourceModal = () => {
    const urlIn = el("input", { class: "input", type: "url", placeholder: "https://.../index.json（Format 1 Skill 市场）" });
    const nameIn = el("input", { class: "input", type: "text", placeholder: "市场名称（可选）" });
    showModal("添加 Skill 市场源", el("div", { class: "col", style: { gap: "8px" } }, urlIn, nameIn), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button", class: "btn btn-primary",
        onClick: async () => {
          if (!urlIn.value.trim()) return toast("请填写市场源地址");
          try {
            marketData = await api("POST", "/api/skills/market/sources", { url: urlIn.value.trim(), name: nameIn.value.trim() });
            closeModal(); toast("已订阅 Skill 市场源"); paint();
          } catch (e) { toast(e.message || "添加失败"); }
        },
      }, "添加"),
    ]);
  };

  const openManualInstallSkillModal = () => {
    const srcIn = el("input", { class: "input", placeholder: "本地文件夹、SKILL.md 文件路径或 GitHub/HTTP 链接…" });
    showModal("手动安装 Skill", el("div", { class: "col", style: { gap: "8px" } },
      el("div", { class: "row", style: { gap: "6px" } },
        srcIn,
        el("button", {
          type: "button", class: "btn btn-sm",
          onClick: async () => {
            try { const r = await api("POST", "/api/host/pick-directory", {}); if (r?.path) srcIn.value = r.path; }
            catch (e) { toast(e.message); }
          },
        }, "选择目录")
      )
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button", class: "btn btn-primary",
        onClick: async () => {
          if (!srcIn.value.trim()) return toast("请输入 Skill 路径或链接");
          try {
            const res = await api("POST", "/api/skills/install", { source: srcIn.value.trim() });
            closeModal(); toast(`已安装 Skill「${res.skill?.name || res.skill?.id}」`);
            await loadMarket(false); refreshHub?.();
          } catch (e) { toast(e.message); }
        },
      }, "安装"),
    ]);
  };

  const openSkillDetailModal = (sk) => {
    const editor = el("textarea", { class: "textarea mono", rows: "14", style: { fontSize: "12px", lineHeight: "1.55" } });
    editor.value = sk.content || "";
    showModal(`Skill 详情 · ${sk.name || sk.id}`, el("div", { class: "col", style: { gap: "10px" } },
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        el("span", { class: "badge badge-accent" }, `/${sk.id}`),
        el("span", { class: "badge" }, formatSkillSourceLabel(sk)),
        sk.version ? el("span", { class: "badge" }, `v${sk.version}`) : null
      ),
      editor
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
      el("button", {
        type: "button", class: "btn btn-primary",
        onClick: async () => {
          try {
            await api("PATCH", `/api/skills/${encodeURIComponent(sk.id)}`, { content: editor.value });
            closeModal(); toast("已保存 Skill 内容"); await loadMarket(false);
          } catch (e) { toast(e.message); }
        },
      }, "保存修改"),
    ]);
  };

  const paint = () => {
    clear(topHost);
    clear(bodyHost);

    const subToggle = el("div", { class: "pm-seg-group", role: "tablist" },
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "market" ? " is-active" : ""), onClick: () => { subMode = "market"; paint(); } }, `市场 (${(marketData?.skills || []).length})`),
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "installed" ? " is-active" : ""), onClick: () => { subMode = "installed"; paint(); } }, `已安装 (${installedSkills.length})`)
    );

    const srcChips = marketData
      ? renderSourceChips(marketData.sources, busyId, async (s) => {
          busyId = "__rm__"; paint();
          try {
            marketData = await api("DELETE", `/api/skills/market/sources/${encodeURIComponent(s.id)}`);
            toast(`已移除 Skill 源「${s.name || s.id}」`);
          } catch (e) { toast(e.message || "移除失败"); }
          finally { busyId = ""; if (stage.isConnected) paint(); }
        })
      : el("div", { class: "row" });

    const catBar = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", alignItems: "center" } }, subToggle);
    if (subMode === "market" && marketData) {
      catBar.appendChild(el("button", { type: "button", class: "btn btn-sm" + (activeCat === "" ? " btn-primary" : ""), onClick: () => { activeCat = ""; paint(); } }, "全部分类"));
      (marketData.categories || []).forEach((c) => {
        catBar.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm" + (activeCat === c.id ? " btn-primary" : ""),
          onClick: () => { activeCat = c.id; paint(); },
        }, `${c.name} (${c.count})`));
      });
    }

    topHost.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
        srcChips,
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openExtensionSubmitModal(ctx, { channel: "skill" }) }, "＋ 申请收录"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openHarnessSkillImportModal({ onImported: () => { loadMarket(false); refreshHub?.(); } }) }, "📥 本机导入"),
          el("button", { type: "button", class: "btn btn-sm", onClick: openAddSkillSourceModal }, "+ 添加源"),
          el("button", { type: "button", class: "btn btn-sm", onClick: openManualInstallSkillModal }, "＋ 手动安装"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => loadMarket(true) }, "↻ 刷新")
        )
      ),
      el("div", { class: "pm-filter-bar" }, catBar, searchIn)
    ));

    const q = query.trim().toLowerCase();

    if (subMode === "market") {
      if (!marketData) {
        bodyHost.appendChild(makeSkeletonGrid(6));
        return;
      }
      const list = (marketData.skills || []).filter((sk) => {
        if (activeCat && !(sk.categories || []).includes(activeCat)) return false;
        if (!q) return true;
        return `${sk.id} ${sk.name} ${sk.nameEn || ""} ${sk.description || ""} ${(sk.tags || []).join(" ")}`.toLowerCase().includes(q);
      });
      if (!list.length) {
        bodyHost.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "28px 16px" } }, "暂无匹配的 Skill。"));
        return;
      }
      const grid = el("div", { class: "pm-grid" });
      list.forEach((sk) => {
        const isBusy = busyId === sk.id;
        const instObj = installedSkills.find((x) => x.id === sk.id);
        const actBtn = sk.installed && !sk.hasUpdate
          ? el("button", {
              type: "button", class: "pm-act done",
              onClick: () => { if (instObj) openSkillDetailModal(instObj); else { subMode = "installed"; paint(); } },
            }, "已安装")
          : el("button", {
              type: "button", class: "pm-act " + (isBusy ? "busy" : (sk.hasUpdate ? "pm-up" : "get")),
              disabled: Boolean(busyId),
              onClick: async () => {
                busyId = sk.id; paint();
                try {
                  const res = await api("POST", "/api/skills/market/install", { id: sk.id, mirror: getMirror() });
                  marketData = res;
                  const refreshed = await api("GET", "/api/skills").catch(() => null);
                  if (Array.isArray(refreshed?.items)) installedSkills = refreshed.items;
                  toast(`已安装 Skill「${sk.name}」`);
                  refreshHub?.();
                } catch (e) { toast(e.message || "安装失败"); }
                finally { busyId = ""; if (stage.isConnected) paint(); }
              },
            }, isBusy ? "安装中" : (sk.hasUpdate ? "更新" : "安装"));

        grid.appendChild(el("article", { class: "pm-card" },
          el("div", { class: "pm-card-top" },
            el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "⚡"),
            el("div", { class: "pm-card-who" },
              el("div", { class: "pm-card-name" }, el("strong", null, sk.name)),
              el("div", { class: "pm-card-by" },
                el("span", { class: "mono" }, `/${sk.id}`),
                sk.badge ? el("span", { class: "pm-verified-tag" }, sk.badge) : null
              )
            ),
            actBtn
          ),
          el("p", { class: "pm-card-desc", title: sk.description || "" }, sk.description || sk.id),
          el("div", { class: "pm-card-meta" },
            sk.version ? el("span", { class: "pm-ver mono" }, `v${sk.version}`) : null,
            sk.license ? el("span", { class: "pm-chip soft" }, sk.license) : null,
            pricingBadge(sk.pricing),
            ...(sk.tags || []).slice(0, 2).map((t) => el("span", { class: "pm-chip" }, t))
          )
        ));
      });
      bodyHost.appendChild(grid);
      return;
    }

    // Installed Skills view
    const list = installedSkills.filter((sk) =>
      !q || `${sk.name} ${sk.id} ${sk.description || ""} ${sk.source || ""}`.toLowerCase().includes(q)
    );
    if (!list.length) {
      bodyHost.appendChild(el("div", { class: "card col", style: { alignItems: "center", gap: "10px", padding: "28px 16px" } },
        el("span", { class: "muted" }, "暂无已安装的 Skill"),
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => { subMode = "market"; paint(); } }, "浏览 Skill 市场")
      ));
      return;
    }
    const grid = el("div", { class: "pm-grid" });
    list.forEach((sk) => {
      const srcLabel = formatSkillSourceLabel(sk);
      const chkId = `hub-skill-en-${sk.id}`;
      const chk = el("input", { id: chkId, type: "checkbox", checked: sk.enabled !== false });
      chk.addEventListener("change", async () => {
        try {
          await api("PATCH", `/api/skills/${encodeURIComponent(sk.id)}`, { enabled: chk.checked });
          sk.enabled = chk.checked;
          toast(chk.checked ? `已启用「${sk.name}」` : `已停用「${sk.name}」`);
        } catch (e) { chk.checked = !chk.checked; toast(e.message); }
      });

      grid.appendChild(el("article", { class: "pm-card" },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "⚡"),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, sk.name || sk.id)),
            el("div", { class: "pm-card-by" }, el("span", { class: "mono" }, `/${sk.id}`), srcLabel ? el("span", { class: "pm-chip soft" }, srcLabel) : null)
          ),
          el("label", { for: chkId, class: "pm-toggle-inline" }, chk, "启用")
        ),
        el("p", { class: "pm-card-desc" }, sk.description || "暂无简介"),
        el("div", { class: "pm-card-meta", style: { justifyContent: "space-between" } },
          el("div", { class: "row", style: { gap: "6px" } },
            sk.version ? el("span", { class: "pm-ver mono" }, `v${sk.version}`) : null
          ),
          el("div", { class: "row", style: { gap: "6px" } },
            el("button", { type: "button", class: "btn btn-sm", onClick: () => openSkillDetailModal(sk) }, "查看"),
            !sk.builtin
              ? el("button", {
                  type: "button", class: "btn btn-sm",
                  onClick: () => openExtensionSubmitModal(ctx, {
                    channel: "skill",
                    prefill: {
                      name: sk.name || sk.id,
                      slug: sk.id,
                      repoUrl: /^https?:\/\//i.test(sk.source || "") ? sk.source : "",
                      description: sk.description || "",
                      version: sk.version || "",
                    },
                  }),
                }, "申请收录")
              : null,
            !sk.builtin
              ? el("button", {
                  type: "button", class: "btn btn-sm btn-danger",
                  onClick: async () => {
                    try {
                      await api("DELETE", `/api/skills/${encodeURIComponent(sk.id)}`);
                      toast(`已删除 Skill「${sk.name}」`);
                      await loadMarket(false); refreshHub?.();
                    } catch (e) { toast(e.message); }
                  },
                }, "删除")
              : null
          )
        )
      ));
    });
    bodyHost.appendChild(grid);
  };

  loadMarket(false);
}

// =========================================================================
// 3. Obsidian Writing Plugins Channel (写作插件：页内独立管理 市场 / 已安装)
// =========================================================================

export function renderObsidianMarketTab(stage, ctx, initialInstalledPlugins, helpers) {
  const { getMirror, makeSkeletonGrid, refreshHub } = helpers;
  let subMode = "market"; // "market" | "installed"
  let data = null;
  let installedPlugins = Array.isArray(initialInstalledPlugins) ? initialInstalledPlugins : [];
  let activeCat = "";
  let query = "";
  let includeCommunity = false;
  let busyId = "";

  const topHost = el("div", { class: "col", style: { gap: "10px" } });
  const gridHost = el("div", { class: "col", style: { gap: "10px" } });

  const searchIn = el("input", {
    type: "search",
    class: "input pm-search-input",
    placeholder: "搜索写作插件…",
    "aria-label": "搜索写作插件",
  });
  let searchTimer = null;
  searchIn.addEventListener("input", () => {
    query = searchIn.value;
    if (subMode === "market" && includeCommunity) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(false), 260);
    } else {
      paint();
    }
  });

  stage.append(topHost, gridHost);

  const load = async (refresh = false) => {
    data = null;
    paint();
    try {
      const qs = new URLSearchParams({ mirror: getMirror(), limit: "80" });
      if (refresh) qs.set("refresh", "1");
      if (includeCommunity) qs.set("community", "1");
      if (includeCommunity && query.trim()) qs.set("q", query.trim());
      const [mkt, inst] = await Promise.all([
        api("GET", `/api/article/obsidian/market?${qs.toString()}`),
        api("GET", "/api/article/obsidian/plugins").catch(() => ({ plugins: installedPlugins })),
      ]);
      data = mkt;
      if (Array.isArray(inst?.plugins)) installedPlugins = inst.plugins;
    } catch (e) {
      data = { sources: [], categories: [], items: [], warning: e.message };
    }
    if (stage.isConnected) paint();
  };

  const openAddObsSourceModal = () => {
    const urlIn = el("input", { class: "input", type: "url", placeholder: "https://.../index.json（Format 1 写作插件市场）" });
    const nameIn = el("input", { class: "input", type: "text", placeholder: "市场名称（可选）" });
    showModal("添加写作插件市场源", el("div", { class: "col", style: { gap: "8px" } }, urlIn, nameIn), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button", class: "btn btn-primary",
        onClick: async () => {
          if (!urlIn.value.trim()) return toast("请填写市场源 URL");
          try {
            data = await api("POST", "/api/article/obsidian/market/sources", { url: urlIn.value.trim(), name: nameIn.value.trim() });
            closeModal(); toast("已添加写作插件市场源"); paint();
          } catch (e) { toast(e.message || "添加失败"); }
        },
      }, "添加"),
    ]);
  };

  const openManualInstallObsModal = () => {
    const repoIn = el("input", { class: "input", placeholder: "GitHub 仓库（如 sunbooshi/note-to-mp）或本地插件目录" });
    showModal("手动安装写作插件", el("div", { class: "col", style: { gap: "8px" } }, repoIn), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button", class: "btn btn-primary",
        onClick: async () => {
          const v = repoIn.value.trim();
          if (!v) return toast("请输入仓库地址或本地路径");
          const isLocal = /^[a-zA-Z]:[\\/]|^\/|^~/.test(v);
          try {
            await api("POST", "/api/article/obsidian/install", isLocal ? { sourceType: "local", dir: v, enable: true } : { sourceType: "github", repo: v, enable: true });
            closeModal(); toast("已安装写作插件"); await load(false); refreshHub?.();
          } catch (e) { toast(e.message || "安装失败"); }
        },
      }, "安装并启用"),
    ]);
  };

  const paint = () => {
    clear(topHost);
    clear(gridHost);
    if (!data && subMode === "market") {
      gridHost.appendChild(makeSkeletonGrid(6));
      return;
    }

    const items = data?.items || [];
    const cats = data?.categories || [];
    const srcChips = data
      ? renderSourceChips(data.sources, busyId, async (s) => {
          busyId = "__rm__"; paint();
          try {
            data = await api("DELETE", `/api/article/obsidian/market/sources/${encodeURIComponent(s.id)}`);
            toast(`已移除市场源「${s.name || s.id}」`);
          } catch (e) { toast(e.message || "移除失败"); }
          finally { busyId = ""; if (stage.isConnected) paint(); }
        })
      : el("div", { class: "row" });

    const subToggle = el("div", { class: "pm-seg-group", role: "tablist" },
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "market" ? " is-active" : ""), onClick: () => { subMode = "market"; paint(); } }, `市场 (${items.length})`),
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "installed" ? " is-active" : ""), onClick: () => { subMode = "installed"; paint(); } }, `已安装 (${installedPlugins.length})`)
    );

    const commChk = el("input", { type: "checkbox", checked: includeCommunity });
    commChk.addEventListener("change", () => {
      includeCommunity = commChk.checked;
      load(false);
    });

    const catBar = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", alignItems: "center" } }, subToggle);
    if (subMode === "market") {
      catBar.appendChild(el("button", { type: "button", class: "btn btn-sm" + (activeCat === "" ? " btn-primary" : ""), onClick: () => { activeCat = ""; paint(); } }, "全部分类"));
      cats.forEach((c) => {
        catBar.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm" + (activeCat === c.id ? " btn-primary" : ""),
          onClick: () => { activeCat = c.id; paint(); },
        }, `${c.name} (${c.count})`));
      });
    }

    topHost.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
        srcChips,
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openExtensionSubmitModal(ctx, { channel: "obsidian" }) }, "＋ 申请收录"),
          el("button", { type: "button", class: "btn btn-sm", onClick: openAddObsSourceModal }, "+ 添加源"),
          el("button", { type: "button", class: "btn btn-sm", onClick: openManualInstallObsModal }, "＋ 手动安装"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => load(true) }, "↻ 刷新")
        )
      ),
      el("div", { class: "pm-filter-bar" },
        catBar,
        el("div", { class: "row", style: { gap: "10px", flexWrap: "wrap", alignItems: "center" } },
          subMode === "market"
            ? el("label", { class: "pm-toggle-inline" }, commChk, el("span", null, "包含全量 Obsidian 社区"))
            : null,
          searchIn
        )
      ),
      data?.warning ? el("span", { class: "muted", style: { fontSize: "11.5px" } }, `⚠️ ${data.warning}`) : null
    ));

    const q = query.trim().toLowerCase();

    if (subMode === "installed") {
      const list = installedPlugins.filter((op) =>
        !q || `${op.id} ${op.manifest?.name || ""} ${op.manifest?.description || ""} ${op.manifest?.author || ""}`.toLowerCase().includes(q)
      );
      if (!list.length) {
        gridHost.appendChild(el("div", { class: "card col", style: { alignItems: "center", gap: "10px", padding: "28px 16px" } },
          el("span", { class: "muted" }, "暂无已安装的写作插件"),
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => { subMode = "market"; paint(); } }, "浏览写作插件市场")
        ));
        return;
      }
      const listEl = el("div", { class: "pm-installed-list" });
      list.forEach((op) => {
        const chkId = `obs-inst-en-${op.id}`;
        const chk = el("input", { id: chkId, type: "checkbox", checked: Boolean(op.enabled) });
        chk.addEventListener("change", async () => {
          try {
            await api("PATCH", `/api/article/obsidian/plugins/${encodeURIComponent(op.id)}`, { enabled: chk.checked });
            op.enabled = chk.checked;
            toast(chk.checked ? `已启用「${op.manifest?.name || op.id}」` : "已停用写作插件");
          } catch (e) { chk.checked = !chk.checked; toast(e.message); }
        });
        listEl.appendChild(el("div", { class: "pm-inst-row" + (!op.enabled ? " is-off" : "") },
          el("div", { class: "row", style: { gap: "11px", minWidth: 0, flex: "1", alignItems: "center" } },
            el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "📝"),
            el("div", { class: "col", style: { gap: "3px", minWidth: 0, flex: "1" } },
              el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
                el("strong", { style: { fontSize: "13.5px" } }, op.manifest?.name || op.id),
                op.manifest?.version ? el("span", { class: "pm-ver mono" }, `v${op.manifest.version}`) : null
              ),
              el("span", { class: "muted", style: { fontSize: "12px" } }, op.manifest?.description || op.id)
            )
          ),
          el("div", { class: "row", style: { gap: "6px", flexShrink: 0 } },
            el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("article") }, "去文章"),
            el("button", {
              type: "button", class: "btn btn-sm",
              onClick: () => openExtensionSubmitModal(ctx, {
                channel: "obsidian",
                prefill: {
                  name: op.manifest?.name || op.id,
                  slug: op.id,
                  repoUrl: op.sourceRepo || "",
                  description: op.manifest?.description || "",
                  authorName: op.manifest?.author || "",
                  version: op.manifest?.version || "",
                },
              }),
            }, "申请收录"),
            el("label", { for: chkId, class: "row", style: { cursor: "pointer", fontSize: "12.5px" } }, chk, "启用"),
            el("button", {
              type: "button", class: "btn btn-sm btn-danger",
              onClick: async () => {
                if (!window.confirm(`卸载写作插件「${op.manifest?.name || op.id}」？`)) return;
                try {
                  await api("DELETE", `/api/article/obsidian/plugins/${encodeURIComponent(op.id)}`);
                  toast("已卸载写作插件"); await load(false); refreshHub?.();
                } catch (e) { toast(e.message); }
              },
            }, "卸载")
          )
        ));
      });
      gridHost.appendChild(listEl);
      return;
    }

    const list = items.filter((it) => {
      if (activeCat && !(it.categories || []).includes(activeCat)) return false;
      if (!q || includeCommunity) return true;
      return `${it.id} ${it.name} ${it.author || ""} ${it.description || ""} ${it.repo || ""} ${it.featuredTag || ""}`.toLowerCase().includes(q);
    });

    if (!list.length) {
      gridHost.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "28px 16px" } }, "暂无匹配的写作插件。"));
      return;
    }

    const grid = el("div", { class: "pm-grid" });
    list.forEach((it) => {
      const isBusy = busyId === it.id;
      const actBtn = it.installed
        ? el("button", { type: "button", class: "pm-act done", onClick: () => ctx.go("article") }, "去文章")
        : el("button", {
            type: "button", class: "pm-act " + (isBusy ? "busy" : "get"), disabled: Boolean(busyId),
            onClick: async () => {
              busyId = it.id; paint();
              try {
                await api("POST", "/api/article/obsidian/install", {
                  sourceType: "market",
                  id: it.id,
                  repo: it.repo,
                  downloadMirrors: it.downloadMirrors || undefined,
                  files: it.files || undefined,
                  mirror: getMirror(),
                  enable: true,
                });
                toast(`已安装并启用「${it.name}」`);
                await load(false); refreshHub?.();
              } catch (e) { toast(e.message || "安装失败"); }
              finally { busyId = ""; if (stage.isConnected) paint(); }
            },
          }, isBusy ? "安装中" : "安装");

      const compatEl = it.compatLevel === "partial"
        ? el("span", { class: "pm-chip warn" }, "🟡 部分兼容")
        : (it.compatLevel === "unsupported"
          ? el("span", { class: "pm-chip" }, "🔴 暂不兼容")
          : el("span", { class: "pm-chip soft" }, "🟢 实测兼容"));

      grid.appendChild(el("article", { class: "pm-card" },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "📝"),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, it.name || it.id)),
            el("div", { class: "pm-card-by" },
              it.featuredTag ? el("span", { class: "pm-verified-tag" }, it.featuredTag) : null,
              el("span", { class: "pm-author-text" }, `${it.author || ""}${it.downloads ? " · " + formatDownloads(it.downloads) : ""}`)
            )
          ),
          actBtn
        ),
        el("p", { class: "pm-card-desc", title: it.description || "" }, it.description || it.repo),
        el("div", { class: "pm-card-meta", style: { justifyContent: "space-between" } },
          el("div", { class: "row", style: { gap: "5px", flexWrap: "wrap" } },
            it.version && it.version !== "latest" ? el("span", { class: "pm-ver mono" }, `v${it.version}`) : null,
            compatEl,
            it.mirroredFast ? el("span", { class: "pm-chip up" }, "⚡ 国内加速") : null,
            pricingBadge(it.pricing)
          ),
          it.installed
            ? el("button", {
                type: "button", class: "btn btn-sm btn-danger", disabled: Boolean(busyId),
                onClick: async () => {
                  if (!window.confirm(`卸载写作插件「${it.name}」？`)) return;
                  busyId = it.id; paint();
                  try {
                    await api("DELETE", `/api/article/obsidian/plugins/${encodeURIComponent(it.id)}`);
                    toast(`已卸载「${it.name}」`); await load(false); refreshHub?.();
                  } catch (e) { toast(e.message || "卸载失败"); }
                  finally { busyId = ""; if (stage.isConnected) paint(); }
                },
              }, "卸载")
            : (it.repo
                ? el("a", { href: `https://github.com/${it.repo}`, class: "muted", style: { fontSize: "11.5px" }, onClick: (e) => { e.preventDefault(); openURL(`https://github.com/${it.repo}`); } }, "仓库 ↗")
                : null)
        )
      ));
    });
    gridHost.appendChild(grid);
  };

  load(false);
}
