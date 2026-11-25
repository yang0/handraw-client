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

function renderSourceChips(sources, busy, onRemove) {
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
// 1. Featured Tab (Workflow Starter Bundles + 4-Channel Quick Preview)
// =========================================================================

const WORKFLOW_BUNDLES = [
  {
    id: "wechat-writer-pack",
    icon: "✍️",
    title: "公众号图文创作套装",
    subtitle: "文章润色 + 自动配图规划 + 公众号实时预览 + Markdown 规范排版",
    items: [
      { channel: "skill", id: "wechat-article-polish", label: "公众号文章润色", typeLabel: "Skill" },
      { channel: "skill", id: "article-illustration-planner", label: "长文自动配图规划", typeLabel: "Skill" },
      { channel: "obsidian", id: "mp-preview", label: "MP Preview 公众号预览", typeLabel: "写作插件" },
      { channel: "obsidian", id: "obsidian-linter", label: "Linter 文档排版规范", typeLabel: "写作插件" },
    ],
  },
  {
    id: "illustration-pose-pack",
    icon: "🎨",
    title: "角色与姿势插画套装",
    subtitle: "5 视角人体姿态图鉴 + 服饰图鉴 + 角色设定表 + 多页绘本分镜",
    items: [
      { channel: "gallery", id: "ruic-poses", label: "姿态图鉴（5视角）", typeLabel: "扩展图库" },
      { channel: "gallery", id: "ruic-costumes", label: "衣装图鉴（1,407套）", typeLabel: "扩展图库" },
      { channel: "skill", id: "character-sheet-bible", label: "角色设定与三视图", typeLabel: "Skill" },
      { channel: "skill", id: "picturebook-storyboard", label: "多页绘本分镜脚本", typeLabel: "Skill" },
    ],
  },
  {
    id: "ai-pkm-pack",
    icon: "⚡",
    title: "AI 写作与知识库套装",
    subtitle: "去 AI 味审稿 + 长文深度拆解 + 双链笔记整理 + 最近文档导航",
    items: [
      { channel: "skill", id: "de-ai-tone", label: "去 AI 味清理", typeLabel: "Skill" },
      { channel: "skill", id: "deep-article-summary", label: "长文深度拆解", typeLabel: "Skill" },
      { channel: "skill", id: "knowledge-note-linker", label: "Obsidian 双链整理", typeLabel: "Skill" },
      { channel: "obsidian", id: "recent-files-obsidian", label: "Recent Files 导航", typeLabel: "写作插件" },
    ],
  },
];

export function renderFeaturedTab(stage, ctx, helpers) {
  const { getMirror, switchTab, refreshHub, makeSkeletonGrid } = helpers;
  let bundleBusyId = "";
  let data = null;

  const host = el("div", { class: "col", style: { gap: "16px" } });
  stage.appendChild(host);

  const loadAll = async (refresh = false) => {
    data = null;
    paint();
    const m = getMirror();
    const qs = `?mirror=${encodeURIComponent(m)}${refresh ? "&refresh=1" : ""}`;
    const [plugMkt, galMkt, skMkt, obsMkt] = await Promise.all([
      api("GET", `/api/plugins/market${qs}`).catch(() => ({ plugins: [], sources: [] })),
      api("GET", `/api/galleries/market${qs}`).catch(() => ({ packs: [], sources: [] })),
      api("GET", `/api/skills/market${qs}`).catch(() => ({ skills: [], sources: [] })),
      api("GET", `/api/article/obsidian/market${qs}&limit=30`).catch(() => ({ items: [], sources: [] })),
    ]);
    if (!stage.isConnected) return;
    data = { plugMkt, galMkt, skMkt, obsMkt };
    paint();
  };

  const isBundleItemInstalled = (it) => {
    if (!data) return false;
    if (it.channel === "gallery") return Boolean((data.galMkt.packs || []).find((p) => p.id === it.id && p.installed));
    if (it.channel === "skill") return Boolean((data.skMkt.skills || []).find((s) => s.id === it.id && s.installed));
    if (it.channel === "obsidian") return Boolean((data.obsMkt.items || []).find((o) => o.id === it.id && o.installed));
    if (it.channel === "plugin") return Boolean((data.plugMkt.plugins || []).find((p) => p.name === it.id && p.installed));
    return false;
  };

  const installBundle = async (bundle) => {
    if (bundleBusyId) return;
    const missing = bundle.items.filter((it) => !isBundleItemInstalled(it));
    if (!missing.length) return;
    bundleBusyId = bundle.id;
    paint();
    const m = getMirror();
    let okCount = 0;
    const errs = [];
    for (const it of missing) {
      try {
        if (it.channel === "gallery") {
          await api("POST", "/api/galleries/market/install", { id: it.id, mirror: m });
        } else if (it.channel === "skill") {
          await api("POST", "/api/skills/market/install", { id: it.id, mirror: m });
        } else if (it.channel === "obsidian") {
          const found = (data.obsMkt.items || []).find((o) => o.id === it.id);
          await api("POST", "/api/article/obsidian/install", {
            sourceType: "market",
            id: it.id,
            repo: found?.repo || "",
            downloadMirrors: found?.downloadMirrors || undefined,
            files: found?.files || undefined,
            mirror: m,
            enable: true,
          });
        }
        okCount++;
      } catch (e) {
        errs.push(`${it.label}: ${e?.message || "安装失败"}`);
      }
    }
    bundleBusyId = "";
    if (errs.length) toast(`套装已安装 ${okCount}/${missing.length} 项（失败：${errs[0]}）`);
    else toast(`「${bundle.title}」已一键补齐 ${okCount} 项扩展`);
    ctx.refreshNav?.();
    await loadAll(false);
    refreshHub?.();
  };

  const paint = () => {
    clear(host);
    if (!data) {
      host.appendChild(makeSkeletonGrid(6));
      return;
    }

    // Section 1: One-Click Workflow Bundles
    const bundleGrid = el("div", { class: "pm-bundle-grid" });
    WORKFLOW_BUNDLES.forEach((b) => {
      const doneCount = b.items.filter(isBundleItemInstalled).length;
      const allDone = doneCount === b.items.length;
      const isBusy = bundleBusyId === b.id;

      const pills = el("div", { class: "pm-bundle-items" },
        ...b.items.map((it) => {
          const installed = isBundleItemInstalled(it);
          return el("span", { class: "pm-bundle-pill" + (installed ? " is-done" : "") },
            el("span", null, installed ? "✓ " : "○ "),
            el("span", null, it.label),
            el("span", { class: "muted", style: { fontSize: "10.5px" } }, `· ${it.typeLabel}`)
          );
        })
      );

      bundleGrid.appendChild(el("div", { class: "card pm-bundle-card" },
        el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start", gap: "10px" } },
          el("div", { class: "row", style: { gap: "10px", alignItems: "center", minWidth: 0 } },
            el("div", { class: "pm-logo", style: { fontSize: "20px" } }, b.icon),
            el("div", { class: "col", style: { gap: "2px", minWidth: 0 } },
              el("strong", { style: { fontSize: "14.5px" } }, b.title),
              el("span", { class: "muted", style: { fontSize: "12px" } }, b.subtitle)
            )
          ),
          el("button", {
            type: "button",
            class: allDone ? "pm-act done" : "pm-act get",
            disabled: allDone || Boolean(bundleBusyId),
            onClick: () => installBundle(b),
          }, isBusy ? "安装中…" : (allDone ? "✓ 已就绪" : `一键补齐 (${b.items.length - doneCount})`))
        ),
        pills
      ));
    });

    host.appendChild(el("section", { class: "col", style: { gap: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" } },
        el("div", { class: "col", style: { gap: "2px" } },
          el("strong", { style: { fontSize: "15px" } }, "场景一键套装"),
          el("span", { class: "muted", style: { fontSize: "12px" } }, "跨图库、Skills 与写作插件的开箱即用组合，自动跳过已安装项")
        ),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => loadAll(true) }, "↻ 刷新四大市场")
      ),
      bundleGrid
    ));

    // Section 2: 4 Channel Spotlight Summaries
    const makeSpotlight = (title, desc, count, tabKey, cards) => {
      return el("section", { class: "col", style: { gap: "8px" } },
        el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "8px" } },
          el("div", { class: "row", style: { gap: "8px", alignItems: "baseline", flexWrap: "wrap" } },
            el("strong", { style: { fontSize: "14.5px" } }, title),
            el("span", { class: "badge" }, `${count} 项`),
            el("span", { class: "muted", style: { fontSize: "12px" } }, desc)
          ),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => switchTab(tabKey) }, "查看全部 →")
        ),
        el("div", { class: "pm-grid" }, ...cards)
      );
    };

    const galCards = (data.galMkt.packs || []).slice(0, 3).map((p) =>
      el("article", { class: "pm-card", onClick: () => switchTab("galleries") },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, p.multiVariant ? "🧍" : "🖼️"),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, p.name)),
            el("div", { class: "pm-card-by" }, el("span", null, p.badge || "标准图库"), el("span", { class: "pm-author-text" }, p.author || ""))
          ),
          el("span", { class: "pm-act " + (p.installed ? "done" : "get") }, p.installed ? "已安装" : "去安装")
        ),
        el("p", { class: "pm-card-desc" }, p.description || p.id),
        el("div", { class: "pm-card-meta" }, el("span", { class: "pm-chip soft" }, "扩展图库"), p.multiVariant ? el("span", { class: "pm-chip" }, "多视角") : null)
      )
    );

    const skCards = (data.skMkt.skills || []).slice(0, 3).map((s) =>
      el("article", { class: "pm-card", onClick: () => switchTab("skills") },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "⚡"),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, s.name)),
            el("div", { class: "pm-card-by" }, el("span", { class: "mono" }, `/${s.id}`), s.badge ? el("span", { class: "pm-chip soft" }, s.badge) : null)
          ),
          el("span", { class: "pm-act " + (s.installed ? "done" : "get") }, s.installed ? "已安装" : "去安装")
        ),
        el("p", { class: "pm-card-desc" }, s.description || s.id),
        el("div", { class: "pm-card-meta" }, el("span", { class: "pm-chip soft" }, "AI Skill"), pricingBadge(s.pricing))
      )
    );

    const obsCards = (data.obsMkt.items || []).slice(0, 3).map((o) =>
      el("article", { class: "pm-card", onClick: () => switchTab("obsidian") },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "📝"),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, o.name)),
            el("div", { class: "pm-card-by" }, el("span", null, o.featuredTag || "写作插件"), el("span", { class: "pm-author-text" }, o.author || ""))
          ),
          el("span", { class: "pm-act " + (o.installed ? "done" : "get") }, o.installed ? "已安装" : "去安装")
        ),
        el("p", { class: "pm-card-desc" }, o.description || o.repo),
        el("div", { class: "pm-card-meta" },
          el("span", { class: "pm-chip soft" }, o.compatLevel === "partial" ? "🟡 部分兼容" : "🟢 实测兼容"),
          o.mirroredFast ? el("span", { class: "pm-chip up" }, "⚡ 国内加速") : null
        )
      )
    );

    const plugCards = (data.plugMkt.plugins || []).slice(0, 3).map((p) =>
      el("article", { class: "pm-card", onClick: () => switchTab("plugins") },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "🧩"),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, p.title || p.name)),
            el("div", { class: "pm-card-by" }, el("span", { class: "pm-verified-tag" }, "✓ 官方/兼容"), el("span", { class: "pm-author-text" }, p.author || ""))
          ),
          el("span", { class: "pm-act " + (p.installed ? "done" : "get") }, p.installed ? "已安装" : "去安装")
        ),
        el("p", { class: "pm-card-desc" }, p.description || p.name),
        el("div", { class: "pm-card-meta" }, el("span", { class: "pm-ver mono" }, `v${p.latestVersion}`), pricingBadge(p.pricing))
      )
    );

    if (plugCards.length) host.appendChild(makeSpotlight("功能插件（Handraw / DSH）", "独立工作台、模型号池与全能工作流应用", (data.plugMkt.plugins || []).length, "plugins", plugCards));
    if (galCards.length) host.appendChild(makeSpotlight("扩展图库（标准 Format 1）", "姿势、服饰、人像等本机按需缓存视觉参考库", (data.galMkt.packs || []).length, "galleries", galCards));
    if (skCards.length) host.appendChild(makeSpotlight("AI Skills 技能市场", "即装即用的写作、配图分镜与知识整理提示词技能", (data.skMkt.skills || []).length, "skills", skCards));
    if (obsCards.length) host.appendChild(makeSpotlight("写作插件（Obsidian 兼容）", "公众号排版、图床与 Markdown 写作增强", (data.obsMkt.items || []).length, "obsidian", obsCards));
  };

  loadAll(false);
}

// =========================================================================
// 2. Galleries Market Channel (Full-page Grid backed by /api/galleries/market)
// =========================================================================

export function renderGalleriesMarketTab(stage, ctx, helpers) {
  const { getMirror, makeSkeletonGrid, refreshHub } = helpers;
  let data = null;
  let activeCat = "";
  let query = "";
  let panelMode = ""; // "" | "add-source" | "direct-url"
  let busyId = "";

  const topHost = el("div", { class: "col", style: { gap: "10px" } });
  const gridHost = el("div", { class: "col", style: { gap: "10px" } });
  const searchIn = el("input", {
    type: "search",
    class: "input pm-search-input",
    placeholder: "搜索扩展图库…",
    "aria-label": "搜索扩展图库",
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

    const catBar = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
      el("button", { type: "button", class: "btn btn-sm" + (activeCat === "" ? " btn-primary" : ""), onClick: () => { activeCat = ""; paint(); } }, `全部 (${packs.length})`),
      el("button", { type: "button", class: "btn btn-sm" + (activeCat === "__installed__" ? " btn-primary" : ""), onClick: () => { activeCat = "__installed__"; paint(); } }, `已安装 (${packs.filter((p) => p.installed).length})`),
      ...cats.map((c) => el("button", {
        type: "button",
        class: "btn btn-sm" + (activeCat === c.id ? " btn-primary" : ""),
        onClick: () => { activeCat = c.id; paint(); },
      }, `${c.name} (${c.count})`))
    );

    topHost.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
        el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap", alignItems: "center" } },
          el("strong", null, "图库市场源"),
          srcChips,
          el("a", { href: "https://gitee.com/yang02010/handraw-galleries", class: "muted", style: { fontSize: "11.5px" }, onClick: (e) => { e.preventDefault(); openURL("https://gitee.com/yang02010/handraw-galleries"); } }, "Gitee 镜像 ↗"),
          el("a", { href: "https://github.com/yang0/handraw-galleries/blob/main/CONTRIBUTING.md", class: "muted", style: { fontSize: "11.5px" }, onClick: (e) => { e.preventDefault(); openURL("https://github.com/yang0/handraw-galleries/blob/main/CONTRIBUTING.md"); } }, "提交图库 PR ↗")
        ),
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm" + (panelMode === "add-source" ? " btn-primary" : ""), onClick: () => { panelMode = panelMode === "add-source" ? "" : "add-source"; paint(); } }, "+ 添加图库源"),
          el("button", { type: "button", class: "btn btn-sm" + (panelMode === "direct-url" ? " btn-primary" : ""), onClick: () => { panelMode = panelMode === "direct-url" ? "" : "direct-url"; paint(); } }, "🔗 链接直装"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => load(true) }, "↻ 刷新市场")
        )
      ),
      el("div", { class: "pm-filter-bar" }, catBar, searchIn),
      el("span", { class: "muted", style: { fontSize: "11.5px" } }, "🔒 全部扩展图库采用 Format 1 标准接口，按需选装且索引与图片仅缓存在本机，不会同步至云端。")
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
    const list = packs.filter((p) => {
      if (activeCat === "__installed__" && !p.installed) return false;
      if (activeCat && activeCat !== "__installed__" && !(p.categories || []).includes(activeCat)) return false;
      if (!q) return true;
      return `${p.id} ${p.name} ${p.nameEn || ""} ${p.description || ""} ${p.author || ""}`.toLowerCase().includes(q);
    });

    if (!list.length) {
      gridHost.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "28px 16px" } }, "当前筛选下暂无扩展图库。"));
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
                toast(`已安装「${p.name}」，可立即在画廊与生图参考图中使用`);
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
// 3. Skills Channel (Skill Market + Installed Skills Switcher)
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
    placeholder: "搜索 Skill 名称、用途或标签…",
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
    showModal("添加 Skill 市场源", el("div", { class: "col", style: { gap: "8px" } },
      el("span", { class: "muted", style: { fontSize: "12.5px" } }, "输入兼容 Handraw Format 1 规范的 Skill 市场 index.json 地址："),
      urlIn, nameIn
    ), [
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
      el("span", { class: "muted", style: { fontSize: "12.5px" } }, "输入包含 SKILL.md 的本地目录、文件路径或远端链接："),
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
      el("span", { class: "muted", style: { fontSize: "12px" } }, "可在「聊天」、「文章 AI 改稿」及兼容插件中通过 Skill 选择器或 /" + sk.id + " 直接调用。"),
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
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "market" ? " is-active" : ""), onClick: () => { subMode = "market"; paint(); } }, `Skill 市场 (${(marketData?.skills || []).length})`),
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
      : null;

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
        el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap", alignItems: "center" } },
          el("strong", null, "AI Skills 技能市场"),
          srcChips,
          el("a", { href: "https://gitee.com/yang02010/handraw-skills", class: "muted", style: { fontSize: "11.5px" }, onClick: (e) => { e.preventDefault(); openURL("https://gitee.com/yang02010/handraw-skills"); } }, "Gitee 镜像 ↗"),
          el("a", { href: "https://github.com/yang0/handraw-skills/blob/main/CONTRIBUTING.md", class: "muted", style: { fontSize: "11.5px" }, onClick: (e) => { e.preventDefault(); openURL("https://github.com/yang0/handraw-skills/blob/main/CONTRIBUTING.md"); } }, "提交 Skill PR ↗")
        ),
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openHarnessSkillImportModal({ onImported: () => { loadMarket(false); refreshHub?.(); } }) }, "📥 本机 AI 客户端导入"),
          el("button", { type: "button", class: "btn btn-sm", onClick: openAddSkillSourceModal }, "+ 添加市场源"),
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
        bodyHost.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "28px 16px" } }, "当前筛选下暂无匹配的 Skill。"));
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
                  toast(`已安装 Skill「${sk.name}」，可在聊天与文章改稿中使用`);
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
        el("strong", null, "暂无匹配的已安装 Skill"),
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => { subMode = "market"; paint(); } }, "去 Skill 市场挑选")
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
            el("button", { type: "button", class: "btn btn-sm", onClick: () => openSkillDetailModal(sk) }, "查看 / 编辑"),
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
// 4. Obsidian Writing Plugins Market Channel (/api/article/obsidian/market)
// =========================================================================

export function renderObsidianMarketTab(stage, ctx, helpers) {
  const { getMirror, makeSkeletonGrid, refreshHub } = helpers;
  let data = null;
  let activeCat = "";
  let query = "";
  let includeCommunity = false;
  let busyId = "";

  const topHost = el("div", { class: "col", style: { gap: "10px" } });
  const gridHost = el("div", { class: "col", style: { gap: "10px" } });

  const searchIn = el("input", {
    type: "search",
    class: "input pm-search-input",
    placeholder: "搜索写作插件（支持公众号、排版、Dataview 等）…",
    "aria-label": "搜索写作插件",
  });
  let searchTimer = null;
  searchIn.addEventListener("input", () => {
    query = searchIn.value;
    if (includeCommunity) {
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
      data = await api("GET", `/api/article/obsidian/market?${qs.toString()}`);
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
    showModal("手动安装 Obsidian 写作插件", el("div", { class: "col", style: { gap: "8px" } },
      el("span", { class: "muted", style: { fontSize: "12.5px" } }, "输入 GitHub 仓库名（owner/repo）或包含 manifest.json 与 main.js 的本地目录："),
      repoIn
    ), [
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
    if (!data) {
      gridHost.appendChild(makeSkeletonGrid(6));
      return;
    }

    const items = data.items || [];
    const cats = data.categories || [];
    const srcChips = renderSourceChips(data.sources, busyId, async (s) => {
      busyId = "__rm__"; paint();
      try {
        data = await api("DELETE", `/api/article/obsidian/market/sources/${encodeURIComponent(s.id)}`);
        toast(`已移除市场源「${s.name || s.id}」`);
      } catch (e) { toast(e.message || "移除失败"); }
      finally { busyId = ""; if (stage.isConnected) paint(); }
    });

    const commChk = el("input", { type: "checkbox", checked: includeCommunity });
    commChk.addEventListener("change", () => {
      includeCommunity = commChk.checked;
      load(false);
    });

    const catBar = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
      el("button", { type: "button", class: "btn btn-sm" + (activeCat === "" ? " btn-primary" : ""), onClick: () => { activeCat = ""; paint(); } }, `全部 (${items.length})`),
      ...cats.map((c) => el("button", {
        type: "button",
        class: "btn btn-sm" + (activeCat === c.id ? " btn-primary" : ""),
        onClick: () => { activeCat = c.id; paint(); },
      }, `${c.name} (${c.count})`))
    );

    topHost.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
        el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap", alignItems: "center" } },
          el("strong", null, "写作插件市场（Obsidian 兼容）"),
          srcChips,
          el("a", { href: "https://gitee.com/yang02010/handraw-obsidian-plugins", class: "muted", style: { fontSize: "11.5px" }, onClick: (e) => { e.preventDefault(); openURL("https://gitee.com/yang02010/handraw-obsidian-plugins"); } }, "Gitee 镜像 ↗"),
          el("a", { href: "https://github.com/yang0/handraw-obsidian-plugins/blob/main/CONTRIBUTING.md", class: "muted", style: { fontSize: "11.5px" }, onClick: (e) => { e.preventDefault(); openURL("https://github.com/yang0/handraw-obsidian-plugins/blob/main/CONTRIBUTING.md"); } }, "提交插件 PR ↗")
        ),
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm", onClick: openAddObsSourceModal }, "+ 添加市场源"),
          el("button", { type: "button", class: "btn btn-sm", onClick: openManualInstallObsModal }, "＋ 手动安装"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => load(true) }, "↻ 刷新")
        )
      ),
      el("div", { class: "pm-filter-bar" },
        catBar,
        el("div", { class: "row", style: { gap: "10px", flexWrap: "wrap", alignItems: "center" } },
          el("label", { class: "pm-toggle-inline" }, commChk, el("span", null, "包含全量 Obsidian 社区")),
          searchIn
        )
      ),
      data.warning ? el("span", { class: "muted", style: { fontSize: "11.5px" } }, `⚠️ ${data.warning}`) : null
    ));

    const q = query.trim().toLowerCase();
    const list = items.filter((it) => {
      if (activeCat && !(it.categories || []).includes(activeCat)) return false;
      if (!q || includeCommunity) return true;
      return `${it.id} ${it.name} ${it.author || ""} ${it.description || ""} ${it.repo || ""} ${it.featuredTag || ""}`.toLowerCase().includes(q);
    });

    if (!list.length) {
      gridHost.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "28px 16px" } }, "暂无匹配的写作插件。可勾选上方「包含全量 Obsidian 社区」搜索全部社区插件。"));
      return;
    }

    const grid = el("div", { class: "pm-grid" });
    list.forEach((it) => {
      const isBusy = busyId === it.id;
      const actBtn = it.installed
        ? el("button", { type: "button", class: "pm-act done", onClick: () => ctx.go("article") }, "去文章使用")
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
                toast(`已安装并启用写作插件「${it.name}」`);
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

// =========================================================================
// 5. Unified Installed Extensions Summary (Galleries + Skills + Obsidian)
// =========================================================================

export function renderExtraInstalledSections(stage, ctx, { galleries, skills, obsidianPlugins, builtins, filterType, refreshHub, renderBuiltinList }) {
  const showGal = filterType === "all" || filterType === "galleries";
  const showSk = filterType === "all" || filterType === "skills";
  const showObs = filterType === "all" || filterType === "obsidian";
  const showBuilt = filterType === "builtin";

  if (showBuilt) {
    renderBuiltinList(stage);
    return;
  }

  if (showGal && galleries.length > 0) {
    const list = el("div", { class: "pm-installed-list" });
    galleries.forEach((g) => {
      list.appendChild(el("div", { class: "pm-inst-row" },
        el("div", { class: "row", style: { gap: "11px", minWidth: 0, flex: "1", alignItems: "center" } },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, g.multiVariant ? "🧍" : "🖼️"),
          el("div", { class: "col", style: { gap: "3px", minWidth: 0, flex: "1" } },
            el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
              el("strong", { style: { fontSize: "13.5px" } }, g.name),
              el("span", { class: "badge badge-accent" }, "扩展图库"),
              g.installedVersion ? el("span", { class: "pm-ver mono" }, `v${g.installedVersion}`) : null,
              el("span", { class: "pm-chip soft" }, `${g.itemCount || 0} 条 · 缓存 ${formatBytes(g.cachedBytes)}`)
            ),
            el("span", { class: "muted", style: { fontSize: "12px" } }, g.description || g.id)
          )
        ),
        el("div", { class: "row", style: { gap: "8px", flexShrink: 0 } },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("atlas", { tab: g.id }) }, "去画廊"),
          el("button", {
            type: "button", class: "btn btn-sm btn-danger",
            onClick: async () => {
              if (!window.confirm(`卸载扩展图库「${g.name}」并清理缓存？`)) return;
              try {
                await api("POST", `/api/galleries/market/${encodeURIComponent(g.id)}/uninstall`, { purgeCache: true });
                toast(`已卸载「${g.name}」`); refreshHub?.();
              } catch (e) { toast(e.message || "卸载失败"); }
            },
          }, "卸载")
        )
      ));
    });
    stage.appendChild(el("div", { class: "col", style: { gap: "6px" } },
      el("strong", { style: { fontSize: "13px" } }, `已安装扩展图库 (${galleries.length})`),
      list
    ));
  }

  if (showSk && skills.length > 0) {
    const list = el("div", { class: "pm-installed-list" });
    skills.forEach((sk) => {
      const chkId = `u-sk-${sk.id}`;
      const chk = el("input", { id: chkId, type: "checkbox", checked: sk.enabled !== false });
      chk.addEventListener("change", async () => {
        try {
          await api("PATCH", `/api/skills/${encodeURIComponent(sk.id)}`, { enabled: chk.checked });
          toast(chk.checked ? `已启用 Skill「${sk.name}」` : `已停用 Skill「${sk.name}」`);
        } catch (e) { chk.checked = !chk.checked; toast(e.message); }
      });
      list.appendChild(el("div", { class: "pm-inst-row" + (sk.enabled === false ? " is-off" : "") },
        el("div", { class: "row", style: { gap: "11px", minWidth: 0, flex: "1", alignItems: "center" } },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "⚡"),
          el("div", { class: "col", style: { gap: "3px", minWidth: 0, flex: "1" } },
            el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
              el("strong", { style: { fontSize: "13.5px" } }, sk.name || sk.id),
              el("span", { class: "badge" }, "AI Skill"),
              el("span", { class: "pm-ver mono" }, `/${sk.id}`),
              sk.builtin ? el("span", { class: "pm-chip soft" }, "官方内置") : null
            ),
            el("span", { class: "muted", style: { fontSize: "12px" } }, sk.description || "")
          )
        ),
        el("div", { class: "row", style: { gap: "8px", flexShrink: 0 } },
          el("label", { for: chkId, class: "row", style: { cursor: "pointer", fontSize: "12.5px" } }, chk, "启用"),
          !sk.builtin
            ? el("button", {
                type: "button", class: "btn btn-sm btn-danger",
                onClick: async () => {
                  try {
                    await api("DELETE", `/api/skills/${encodeURIComponent(sk.id)}`);
                    toast(`已删除 Skill「${sk.name}」`); refreshHub?.();
                  } catch (e) { toast(e.message); }
                },
              }, "卸载")
            : null
        )
      ));
    });
    stage.appendChild(el("div", { class: "col", style: { gap: "6px" } },
      el("strong", { style: { fontSize: "13px" } }, `已安装 AI Skills (${skills.length})`),
      list
    ));
  }

  if (showObs && obsidianPlugins.length > 0) {
    const list = el("div", { class: "pm-installed-list" });
    obsidianPlugins.forEach((op) => {
      const chkId = `u-obs-${op.id}`;
      const chk = el("input", { id: chkId, type: "checkbox", checked: Boolean(op.enabled) });
      chk.addEventListener("change", async () => {
        try {
          await api("PATCH", `/api/article/obsidian/plugins/${encodeURIComponent(op.id)}`, { enabled: chk.checked });
          toast(chk.checked ? `已启用写作插件「${op.manifest?.name || op.id}」` : `已停用写作插件`);
        } catch (e) { chk.checked = !chk.checked; toast(e.message); }
      });
      list.appendChild(el("div", { class: "pm-inst-row" + (!op.enabled ? " is-off" : "") },
        el("div", { class: "row", style: { gap: "11px", minWidth: 0, flex: "1", alignItems: "center" } },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "📝"),
          el("div", { class: "col", style: { gap: "3px", minWidth: 0, flex: "1" } },
            el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
              el("strong", { style: { fontSize: "13.5px" } }, op.manifest?.name || op.id),
              el("span", { class: "badge" }, "写作插件"),
              op.manifest?.version ? el("span", { class: "pm-ver mono" }, `v${op.manifest.version}`) : null
            ),
            el("span", { class: "muted", style: { fontSize: "12px" } }, op.manifest?.description || op.id)
          )
        ),
        el("div", { class: "row", style: { gap: "8px", flexShrink: 0 } },
          el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("article") }, "去文章"),
          el("label", { for: chkId, class: "row", style: { cursor: "pointer", fontSize: "12.5px" } }, chk, "启用"),
          el("button", {
            type: "button", class: "btn btn-sm btn-danger",
            onClick: async () => {
              if (!window.confirm(`卸载写作插件「${op.manifest?.name || op.id}」？`)) return;
              try {
                await api("DELETE", `/api/article/obsidian/plugins/${encodeURIComponent(op.id)}`);
                toast("已卸载写作插件"); refreshHub?.();
              } catch (e) { toast(e.message); }
            },
          }, "卸载")
        )
      ));
    });
    stage.appendChild(el("div", { class: "col", style: { gap: "6px" } },
      el("strong", { style: { fontSize: "13px" } }, `已安装写作插件 (${obsidianPlugins.length})`),
      list
    ));
  }
}
