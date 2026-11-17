import { api, clear, el, localImg, openURL, packImg, remoteThumb, toast } from "../api.js";
import { mountSlotPanels } from "../plugins-host.js";

export async function renderHome(root, ctx) {
  clear(root);
  const [recRes, sumRes, worksRes, hotRes, settRes] = await Promise.all([
    api("GET", "/api/mine/recipes").catch(() => ({ items: [] })),
    api("GET", "/api/resources/summary").catch(() => ({ counts: {} })),
    api("GET", "/api/works?limit=6").catch(() => ({ items: [] })),
    api("GET", "/api/site/hot").catch(() => ({ works: [], topics: [] })),
    api("GET", "/api/settings").catch(() => ({ settings: {} })),
  ]);

  const recipes = recRes.items || [];
  let activeRecipe = recipes[0] || { id: "", name: "默认画风", styleIds: ["FA-013"], ratio: "3:4", mode: "graphic-text" };
  const themeInput = el("input", { class: "input", type: "text", placeholder: "今天想画什么？例如：雨夜街角亮着暖灯的小书店，一只橘猫在橱窗里打盹…", style: { fontSize: "15px", padding: "12px 14px" } });

  const recipeStrip = el("div", { class: "row", style: { marginTop: "10px" } });
  const drawStrip = () => {
    clear(recipeStrip);
    recipes.slice(0, 8).forEach((rec) => {
      recipeStrip.appendChild(el("button", {
        type: "button",
        class: "pill-btn" + (activeRecipe?.id === rec.id ? " pill-accent" : ""),
        onClick: () => { activeRecipe = rec; drawStrip(); },
      }, rec.name));
    });
  };
  drawStrip();

  const submitQuick = () => {
    const t = themeInput.value.trim();
    ctx.go("create", {
      recipe: activeRecipe,
      theme: t,
    });
  };
  themeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitQuick();
  });

  const hero = el("section", { class: "card", style: { marginBottom: "18px", padding: "18px 20px" } },
    el("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "10px" } },
      el("h1", { class: "page-title" }, "今天想画什么？"),
      el("span", { class: "muted" }, `本地画风 ${sumRes.counts?.styles || 0} · 图型 ${sumRes.counts?.layouts || 0} · 主题色 ${sumRes.counts?.colors || 0} · 影调 ${sumRes.counts?.tones || 0}`)
    ),
    el("div", { class: "row" },
      el("div", { style: { flex: "1", minWidth: "240px" } }, themeInput),
      el("button", { type: "button", class: "btn btn-primary", onClick: submitQuick }, "带入单图创作"),
      el("button", { type: "button", class: "btn", onClick: () => ctx.go("atlas") }, "先翻风格画册")
    ),
    recipeStrip
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
        el("span", { class: "badge badge-accent" }, "1. 在「画册」挑一个手绘画风"),
        el("span", { class: "badge badge-accent" }, "2. 输入主题并在左侧零费用预览"),
        el("span", { class: "badge badge-accent" }, "3. 点生成，默认存本地、按需发布")
      )
    );
    root.appendChild(guide);
  }

  // Recent works
  const recentWorks = worksRes.items || [];
  const secRecent = el("section", { style: { marginBottom: "22px" } },
    el("div", { class: "page-head" },
      el("h2", { style: { margin: 0, fontSize: "16px" } }, "最近创作"),
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("series") }, "系列图"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("article") }, "文章到图文"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("canvas") }, "自由画布"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works") }, "全部作品 →")
      )
    )
  );
  if (recentWorks.length === 0) {
    secRecent.appendChild(el("div", { class: "card muted" }, "还没有本地生图记录。在上方输入主题，或点击「风格画册」挑选一种画风开始第一张创作吧。"));
  } else {
    const grid = el("div", { class: "grid-cards" });
    recentWorks.forEach((run) => {
      const im = run.images?.[0];
      const src = im?.thumb ? localImg(im.thumb) : (im?.path ? localImg(im.path) : "/img/logo.svg");
      grid.appendChild(el("div", { class: "style-card", onClick: () => ctx.go("works", { openRun: run.id }) },
        el("img", { class: "style-thumb", src, alt: run.title, loading: "lazy" }),
        el("div", { class: "style-body" },
          el("div", { class: "style-name" }, run.title || "未命名作品"),
          el("div", { class: "muted" }, `${run.modelLabel || run.model} · ${(run.images || []).length} 张`)
        )
      ));
    });
    secRecent.appendChild(grid);
  }
  root.appendChild(secRecent);

  // Featured styles
  const stRes = await api("GET", "/api/resources/styles").catch(() => ({ items: [] }));
  const featured = (stRes.items || []).slice(0, 6);
  if (featured.length > 0) {
    const grid = el("div", { class: "grid-cards" });
    featured.forEach((s) => {
      grid.appendChild(el("div", { class: "style-card", onClick: () => ctx.go("atlas", { openStyle: s.number }) },
        el("img", { class: "style-thumb", src: packImg(s.image), alt: s.generation_name, loading: "lazy" }),
        el("div", { class: "style-body" },
          el("div", { class: "style-code" }, s.number),
          el("div", { class: "style-name" }, s.nameZh || s.generation_name),
          el("div", { class: "style-traits" }, s.traits)
        )
      ));
    });
    root.appendChild(el("section", { style: { marginBottom: "22px" } },
      el("div", { class: "page-head" },
        el("h2", { style: { margin: 0, fontSize: "16px" } }, "精选画风"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("atlas") }, "浏览全部 →")
      ),
      grid
    ));
  }

  // Community preview
  const hotWorks = Array.isArray(hotRes.works) ? hotRes.works : (hotRes.works?.items || []);
  if (hotWorks.length > 0) {
    const grid = el("div", { class: "grid-cards" });
    hotWorks.slice(0, 6).forEach((w) => {
      const img = w.coverUrl || (w.images && w.images[0]) || "";
      grid.appendChild(el("div", {
        class: "style-card",
        onClick: () => openURL(`${hotRes.siteBase || "https://handraw-style.com"}/t/work-${encodeURIComponent(w.id)}`),
      },
      el("img", { class: "style-thumb", src: remoteThumb(img, 480, hotRes.siteBase || "https://handraw-style.com"), alt: w.title, loading: "lazy" }),
      el("div", { class: "style-body" },
        el("div", { class: "style-name" }, w.title || "社区作品"),
        el("div", { class: "muted" }, `${w.authorName || w.author || ""} · ♥ ${w.likes || 0}`)
      )));
    });
    root.appendChild(el("section", null,
      el("div", { class: "page-head" },
        el("h2", { style: { margin: 0, fontSize: "16px" } }, "社区热门"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("community") }, "查看更多 →")
      ),
      grid
    ));
  }

  await mountSlotPanels(root, "home", { view: "home" });
}
