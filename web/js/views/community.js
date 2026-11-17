import { api, clear, el, openURL, remoteThumb, toast } from "../api.js";

export async function renderCommunity(root, ctx) {
  clear(root);

  const stage = el("div", { class: "col", style: { gap: "20px" } });
  const refreshBtn = el("button", { type: "button", class: "btn btn-sm", onClick: () => load(true) }, "🔄 刷新热榜");

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row" },
      el("h1", { class: "page-title" }, "社区作品与热帖"),
      el("span", { class: "muted" }, "发现近期高赞作品，一键套用同款手绘配方")
    ),
    refreshBtn
  ));
  root.appendChild(stage);

  async function load(force) {
    refreshBtn.disabled = true;
    clear(stage);
    stage.appendChild(el("div", { class: "card muted" }, "正在加载社区热门内容…"));
    try {
      const res = await api("GET", force ? "/api/site/hot?refresh=1" : "/api/site/hot");
      clear(stage);
      const base = res.siteBase || "https://handraw-style.com";
      const worksRaw = res.works;
      const topicsRaw = res.topics;
      const works = Array.isArray(worksRaw) ? worksRaw : (worksRaw?.items || worksRaw?.works || []);
      const topics = Array.isArray(topicsRaw) ? topicsRaw : (topicsRaw?.items || topicsRaw?.topics || []);

      if (res.offline) {
        stage.appendChild(el("div", { class: "card badge-warn", style: { padding: "10px 14px" } }, "当前离线，以下为本地缓存的热门内容。"));
      }

      // Popular works section
      const worksHead = el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("h2", { style: { margin: 0, fontSize: "16px" } }, "🔥 热门社区作品"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(base) }, "前往网页版社区 ↗")
      );
      stage.appendChild(worksHead);

      if (!works.length) {
        stage.appendChild(el("div", { class: "card muted" }, "暂无热门作品数据（可点击右上角「刷新热榜」重试，或前往网页版查看）。"));
      } else {
        const grid = el("div", { class: "grid-cards" });
        works.forEach((w) => {
          const rawThumb = w.coverUrl || w.imageUrl || w.thumbnailUrl || w.image || "/img/logo.svg";
          const thumb = remoteThumb(rawThumb, 480, base);
          const workURL = w.url ? (w.url.startsWith("/") ? base + w.url : w.url) : (w.id ? `${base}/t/work-${w.id}` : base);
          const styleId = w.styleId || w.style || w.styleNumber || w.recipe?.styleIds?.[0] || "FA-013";
          const layoutId = w.layoutId || w.layout || w.recipe?.layoutId || "";
          grid.appendChild(el("div", { class: "style-card" },
            el("img", { class: "style-thumb", src: thumb, alt: w.title || "", loading: "lazy", onClick: () => openURL(workURL) }),
            el("div", { class: "style-body" },
              el("div", { class: "style-code" }, [styleId, layoutId].filter(Boolean).join(" + ")),
              el("div", { class: "style-name" }, w.title || w.theme || "社区精选"),
              el("div", { class: "muted" }, [w.authorName || w.username || "", w.likes != null ? `♥ ${w.likes}` : ""].filter(Boolean).join(" · "))
            ),
            el("div", { class: "style-actions" },
              el("button", {
                type: "button",
                class: "btn btn-sm btn-primary",
                onClick: () => ctx.go("create", {
                  style: styleId,
                  layout: layoutId,
                  theme: w.theme || w.originalRequest || "",
                }),
              }, "用同款配方"),
              el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(workURL) }, "在网站看 ↗")
            )
          ));
        });
        stage.appendChild(grid);
      }

      // Popular forum topics
      stage.appendChild(el("h2", { style: { margin: "8px 0 0", fontSize: "16px" } }, "💬 论坛热帖讨论"));
      if (!topics.length) {
        stage.appendChild(el("div", { class: "card muted" }, "暂无论坛热帖数据。"));
      } else {
        const listCard = el("div", { class: "card col", style: { gap: "6px" } });
        topics.forEach((t) => {
          const url = t.url ? (t.url.startsWith("/") ? base + t.url : t.url) : `${base}/t/${t.slug ? t.slug + "/" : ""}${t.id || ""}`;
          listCard.appendChild(el("button", {
            type: "button",
            class: "cmd-row",
            onClick: () => openURL(url),
          },
            el("span", null, t.title || t.fancy_title || "讨论帖"),
            el("span", { class: "muted" }, [t.category || "", t.posts_count != null ? `${t.posts_count} 回复` : ""].filter(Boolean).join(" · ") || "查看 ↗")
          ));
        });
        stage.appendChild(listCard);
      }
    } catch (e) {
      clear(stage);
      stage.appendChild(el("div", { class: "card muted" }, "加载社区热榜失败：" + e.message));
      toast(e.message);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  await load(false);
}
