import { api, clear, el, localImg, openURL, remoteThumb, toast } from "../api.js";
import { mountSlotPanels } from "../plugins-host.js";
import { createCardSizeSwitcher, masonry } from "../masonry.js";
import { openWorkRemixModal } from "./work-remix-modal.js";

const discoveryLabels = { work: "作品", style: "画风", layout: "图型", topic: "论坛" };

function openWebsite(url) {
  void openURL(url).catch((error) => toast(error.message));
}

function discoveryCard(item, siteBase, ctx) {
  let image;
  let absImageUrl = "";
  if (item.image) {
    const src = new URL(item.image, `${siteBase.replace(/\/+$/, "")}/`);
    if (src.protocol === "https:" || src.protocol === "http:") {
      absImageUrl = src.href;
      const ratio = Math.min(3, Math.max(0.5, Number(item.aspectRatio) || (item.kind === "topic" ? 4 / 3 : 3 / 4)));
      image = el("img", {
        class: "discover-image", src: remoteThumb(src.href, 480), alt: "", loading: "lazy", decoding: "async",
        style: { aspectRatio: `auto ${ratio}` },
        onError: (event) => event.currentTarget.remove(),
      });
    }
  }
  const resource = item.kind === "style" || item.kind === "layout";
  const summary = item.summary?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 110);
  const openCard = (event) => {
    event.preventDefault();
    if (item.kind === "work" && item.id) {
      openWorkRemixModal(item.id, ctx, {
        title: item.title,
        author: item.author,
        href: item.href,
        image: absImageUrl,
        siteBase,
      });
      return;
    }
    openWebsite(item.href);
  };
  const primary = el("a", {
    class: "discover-primary", href: item.href,
    onClick: openCard,
  }, image, el("div", { class: "style-body" },
    el("span", { class: "style-code" }, discoveryLabels[item.kind] + (resource ? ` · ${item.id}` : "")),
    el("h3", { class: "style-name", title: item.title }, item.title),
    summary ? el("p", { class: "style-traits discover-excerpt" }, summary) : null,
    item.author ? el("div", { class: "muted discover-author" }, item.author) : null
  ));

  let footer = null;
  if (item.kind === "work" && item.id) {
    footer = el("footer", { class: "discover-footer discover-work-actions" },
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await api("POST", "/api/inspirations", {
              title: item.title || "社区作品",
              imageUrl: absImageUrl,
              prompt: summary || item.title || "",
              source: "community",
              sourceUrl: item.href || "",
              sourceAuthor: item.author || "",
              workId: item.id,
              syncCollection: true,
            });
            btn.textContent = "★ 已收藏";
            toast("已收进灵感库");
          } catch (err) {
            btn.disabled = false;
            toast(err?.message || "收藏失败");
          }
        },
      }, "★ 收藏"),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => openWorkRemixModal(item.id, ctx, {
          title: item.title,
          author: item.author,
          href: item.href,
          image: absImageUrl,
          siteBase,
        }),
      }, "✨ 做同款"),
      item.extraWorkCount > 0 && item.moreHref
        ? el("a", {
          class: "discover-more", href: item.moreHref,
          "aria-label": `更多 +${item.extraWorkCount}，查看 ${item.author || item.authorKey} 的全部作品`,
          onClick: (event) => { event.preventDefault(); openWebsite(item.moreHref); },
        }, `+${item.extraWorkCount}`)
        : null
    );
  }
  return el("article", { class: "style-card discover-card discover-" + item.kind }, primary, footer);
}

function mountDiscovery(root, initialBase, ctx) {
  let siteBase = initialBase || "https://handraw-style.com";
  const stage = el("div", { "aria-live": "polite" });
  root.appendChild(el("section", { class: "discover-section", "aria-labelledby": "discover-title" },
    el("div", { class: "page-head" },
      el("h2", { id: "discover-title" }, "发现"),
      el("div", { class: "row", style: { gap: "6px" } },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("inspirations", { tab: "plaza" }) }, "💡 社区灵感广场"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => openWebsite(`${siteBase.replace(/\/+$/, "")}/`) }, "浏览全部 ↗")
      )
    ), stage
  ));

  function unavailable() {
    stage.appendChild(el("div", { class: "card row muted" }, "暂时无法加载网站内容。",
      el("button", { type: "button", class: "btn btn-sm", onClick: load }, "重试")));
  }

  async function load() {
    stage.replaceChildren(el("p", { class: "muted" }, "正在加载发现内容…"));
    try {
      const feed = await api("GET", "/api/site/discover");
      siteBase = feed.siteBase || siteBase;
      clear(stage);
      if (!feed.items?.length) {
        if (feed.offline) unavailable();
        else stage.appendChild(el("p", { class: "muted" }, "暂无发现内容。"));
        return;
      }
      if (feed.offline) stage.appendChild(el("p", { class: "muted" }, "暂时无法连接网站，正在显示本地缓存。"));
      stage.appendChild(masonry({ class: "discover-grid" }, feed.items.map((item) => discoveryCard(item, siteBase, ctx))));
    } catch {
      clear(stage);
      unavailable();
    }
  }

  void load();
}

export async function renderHome(container, ctx) {
  const root = el("div");
  container.replaceChildren(root);
  const [sumRes, worksRes, settRes] = await Promise.all([
    api("GET", "/api/resources/summary").catch(() => ({ counts: {} })),
    api("GET", "/api/works?limit=6&hasImages=1").catch(() => ({ items: [] })),
    api("GET", "/api/settings").catch(() => ({ settings: {} })),
  ]);

  const themeInput = el("textarea", {
    id: "home-theme-input",
    class: "home-composer-input",
    rows: "2",
    placeholder: "描述想画的画面、氛围或分镜，例如：雨夜街角亮着暖灯的小书店，一只橘猫在橱窗里打盹…",
  });

  const composerField = el("div", { class: "home-composer-field", dataset: { replicatedValue: "" } }, themeInput);
  const charCount = el("span", { class: "home-composer-count", "aria-live": "polite" });
  const clearBtn = el("button", {
    type: "button",
    class: "home-composer-clear",
    onClick: () => {
      themeInput.value = "";
      syncComposerState();
      themeInput.focus();
    },
  }, "清空");

  const composerForm = el("form", { class: "home-composer", novalidate: true });
  const supportsFieldSizing = typeof CSS !== "undefined"
    && typeof CSS.supports === "function"
    && CSS.supports("field-sizing", "content");

  const syncComposerState = () => {
    const raw = themeInput.value;
    const trimmed = raw.trim();
    const len = Array.from(trimmed).length;
    composerForm.classList.toggle("has-content", len > 0);
    charCount.textContent = len > 0 ? `${len} 字` : "";
    if (!supportsFieldSizing) {
      composerField.dataset.replicatedValue = raw;
    }
  };

  themeInput.addEventListener("input", syncComposerState);

  themeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      composerForm.requestSubmit();
    }
  });

  composerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const theme = themeInput.value.trim();
    ctx.go("create", theme ? { theme } : {});
  });

  composerForm.append(
    el("label", { for: "home-theme-input", class: "sr-only" }, "画面主题描述"),
    composerField,
    el("div", { class: "home-composer-bar" },
      el("div", { class: "home-composer-meta" },
        el("span", { class: "home-composer-hint" },
          el("kbd", null, "Enter"),
          "带入工作台",
          el("span", { class: "home-composer-sep", "aria-hidden": "true" }, "·"),
          el("kbd", null, "Shift + Enter"),
          "换行"
        ),
        el("span", { class: "home-composer-status" }, charCount, clearBtn)
      ),
      el("div", { class: "home-composer-actions" },
        el("button", {
          type: "button",
          class: "btn home-composer-atlas",
          onClick: () => ctx.go("atlas"),
        }, "先翻风格画廊"),
        el("button", {
          type: "submit",
          class: "btn btn-primary home-composer-submit",
        }, "带入生图工作台", el("span", { class: "home-composer-submit-arrow", "aria-hidden": "true" }, "→"))
      )
    )
  );
  syncComposerState();

  const sizeSwitcher = createCardSizeSwitcher({
    storageKey: "handraw_home_size",
    host: root,
  });

  const hero = el("section", { class: "home-hero", "aria-labelledby": "home-hero-title" },
    el("div", { class: "home-hero-head" },
      el("h1", { id: "home-hero-title", class: "home-hero-title" }, "今天想画什么？"),
      el("div", { class: "home-hero-meta" },
        el("span", { class: "home-hero-stats" }, `本地画风 ${sumRes.counts?.styles || 0} · 图型 ${sumRes.counts?.layouts || 0} · 主题色 ${sumRes.counts?.colors || 0} · 影调 ${sumRes.counts?.tones || 0}`),
        sizeSwitcher.el
      )
    ),
    composerForm
  );
  root.appendChild(hero);

  // Onboarding guide on first run
  if (!settRes.settings?.onboarded) {
    const guide = el("section", { class: "card", style: { marginBottom: "18px", borderColor: "var(--accent)" } },
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("strong", null, "✨ 上手 3 步：先看到，再出图"),
        el("button", { type: "button", class: "btn btn-sm", onClick: async () => { await api("PATCH", "/api/settings", { onboarded: true }); guide.remove(); } }, "知道了")
      ),
      el("div", { class: "row", style: { marginTop: "8px", gap: "16px" } },
        el("span", { class: "badge badge-accent" }, "1. 在「画廊」挑一个手绘画风"),
        el("span", { class: "badge badge-accent" }, "2. 输入主题并在左侧零费用预览"),
        el("span", { class: "badge badge-accent" }, "3. 点生成，默认存本地、按需发布")
      )
    );
    root.appendChild(guide);
  }

  // Recent works (only completed works with real images, #80)
  const recentWorks = (worksRes.items || []).filter((run) => (run.images || []).some((i) => i.status === "done" && i.path));
  const secRecent = el("section", { style: { marginBottom: "22px" } },
    el("div", { class: "page-head" },
      el("h2", { style: { margin: 0, fontSize: "16px" } }, "最近创作"),
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("create") }, "生图工作台"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("article") }, "文章到图文"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("canvas") }, "自由画布"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works") }, "全部作品 →")
      )
    )
  );
  if (recentWorks.length === 0) {
    secRecent.appendChild(el("div", { class: "card muted" }, "还没有本地生图记录。在上方输入主题，或点击「风格画廊」挑选一种画风开始第一张创作吧。"));
  } else {
    const grid = masonry();
    recentWorks.forEach((run) => {
      const doneImgs = (run.images || []).filter((i) => i.status === "done" && i.path);
      const im = doneImgs[0];
      const src = im.thumb ? localImg(im.thumb) : localImg(im.path);
      grid.appendChild(el("div", { class: "style-card", onClick: () => ctx.go("works", { openRun: run.id }) },
        el("img", { class: "style-thumb", src, alt: run.title, loading: "lazy" }),
        el("div", { class: "style-body" },
          el("div", { class: "style-name" }, run.title || "未命名作品"),
          el("div", { class: "muted" }, `${run.modelLabel || run.model} · ${doneImgs.length} 张`)
        )
      ));
    });
    secRecent.appendChild(grid);
  }
  root.appendChild(secRecent);

  if (!root.isConnected) return;
  mountDiscovery(root, settRes.settings?.siteBase, ctx);
  await mountSlotPanels(root, "home", { view: "home" });
}
