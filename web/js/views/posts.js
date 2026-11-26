// Works → 笔记 (#166): list of finished social notes plus a phone-style
// preview / editor. The preview is a neutral "小红书风格" mock in the app's
// own paper/ink look — no third-party logos or brand colors.
import { api, clear, closeModal, copyText, el, localImg, showModal, toast } from "../api.js";
import { masonry } from "../masonry.js";

const PLATFORMS = [
  { id: "", label: "全部平台" },
  { id: "xiaohongshu", label: "小红书" },
  { id: "wechat", label: "公众号" },
  { id: "douyin", label: "抖音" },
  { id: "moments", label: "朋友圈" },
];
const PLATFORM_LABEL = { xiaohongshu: "小红书", wechat: "公众号", douyin: "抖音", moments: "朋友圈" };
const TITLE_LIMIT = 20;
const BODY_LIMIT = 1000;

const listState = { q: "", platform: "" };

function imgSrc(im) {
  return im ? localImg(im.thumb || im.path) : "";
}
function fullSrc(im) {
  return im ? localImg(im.path || im.thumb) : "";
}
function charLen(s) {
  return Array.from(String(s || "")).length;
}
function tagLine(tags) {
  return (tags || []).map((t) => "#" + t).join(" ");
}
function fullText(p) {
  return [p.title, p.body, tagLine(p.tags)].map((x) => String(x || "").trim()).filter(Boolean).join("\n\n");
}
function relTime(iso) {
  const t = Date.parse(iso || "");
  if (!t) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return new Date(t).toLocaleDateString();
}

// Body text with #话题 highlighted, built from text nodes (no innerHTML).
function richBody(text) {
  const box = el("div", { class: "pp-body" });
  const re = /#[^\s#＃]+/g;
  String(text || "").split("\n").forEach((line, i) => {
    if (i) box.appendChild(el("br"));
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) box.appendChild(document.createTextNode(line.slice(last, m.index)));
      box.appendChild(el("span", { class: "pp-hashtag" }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < line.length) box.appendChild(document.createTextNode(line.slice(last)));
  });
  return box;
}

// ==================== List ====================
export async function drawPosts(stage, ctx, openEditor) {
  const searchIn = el("input", { class: "input", type: "search", value: listState.q, placeholder: "搜标题、正文、话题…", style: { maxWidth: "240px" } });
  const platSel = el("select", { class: "select select-sm", "aria-label": "按平台筛选" },
    ...PLATFORMS.map((p) => el("option", { value: p.id, selected: listState.platform === p.id }, p.label)));
  const newBtn = el("button", {
    type: "button",
    class: "btn btn-sm btn-primary",
    onClick: () => pickWorkImages([], async (refs) => {
      try {
        const res = await api("POST", "/api/posts", { platform: "xiaohongshu", images: refs });
        openEditor(res.post.id);
      } catch (e) { toast(e.message); }
    }, "从作品库挑选配图，新建一篇笔记"),
  }, "+ 新建笔记");

  const grid = masonry();
  stage.append(el("div", { class: "row", style: { marginBottom: "14px", flexWrap: "wrap" } }, searchIn, platSel, newBtn), grid);

  async function load() {
    const qs = new URLSearchParams({ q: listState.q, platform: listState.platform });
    const res = await api("GET", `/api/posts?${qs}`).catch(() => ({ items: [] }));
    const items = res.items || [];
    clear(grid);
    if (!items.length) {
      grid.appendChild(el("div", { class: "card post-empty", style: { gridColumn: "1 / -1" } },
        el("strong", null, "还没有笔记"),
        el("p", { class: "muted" }, "在画布里用「小红书图文」模板或 AI 助手搭建流程，出图和文案完成后会自动在这里生成笔记草稿。也可以点「+ 新建笔记」从作品库挑图。"),
        el("div", { class: "row", style: { gap: "8px" } },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("canvas") }, "去画布"),
        )
      ));
      return;
    }
    items.forEach((p) => grid.appendChild(postCard(p, () => openEditor(p.id))));
  }

  let timer = null;
  searchIn.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { listState.q = searchIn.value; load(); }, 180); });
  platSel.addEventListener("change", () => { listState.platform = platSel.value; load(); });
  await load();
}

function postCard(p, onOpen) {
  const cover = (p.resolvedImages || [])[0];
  return el("button", { type: "button", class: "post-card", onClick: onOpen, "aria-label": `打开笔记：${p.title || "未命名笔记"}` },
    cover
      ? el("img", { class: "post-card-cover", src: imgSrc(cover), alt: "", loading: "lazy" })
      : el("div", { class: "post-card-cover post-card-cover-empty" }, "暂无配图"),
    el("div", { class: "post-card-body" },
      el("div", { class: "post-card-title" }, p.title || "未命名笔记"),
      p.tags?.length ? el("div", { class: "post-card-tags" }, tagLine(p.tags.slice(0, 3))) : null,
      el("div", { class: "row post-card-meta" },
        el("span", { class: "badge" + (p.status === "exported" ? " badge-ok" : "") }, p.status === "exported" ? "已导出" : "草稿"),
        el("span", { class: "muted" }, `${PLATFORM_LABEL[p.platform] || "小红书"} · ${(p.resolvedImages || []).length} 图 · ${relTime(p.updatedAt)}`)
      )
    )
  );
}

// ==================== Image picker (works library) ====================
function pickWorkImages(existingIds, onPick, title = "从作品库添加配图") {
  const chosen = [];
  const have = new Set(existingIds);
  const grid = el("div", { class: "post-pick-grid" }, el("div", { class: "muted" }, "加载中…"));
  const countEl = el("span", { class: "muted" }, "已选 0 张");
  const confirmBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    onClick: () => { closeModal(); onPick(chosen.slice()); },
  }, "确定");
  showModal(title, el("div", { class: "col", style: { gap: "10px" } }, countEl, grid), [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
    confirmBtn,
  ], { className: "modal-post-pick" });
  api("GET", "/api/works?hasImages=1&limit=60").then((res) => {
    clear(grid);
    const runs = res.items || [];
    let n = 0;
    runs.forEach((run) => (run.images || []).forEach((im) => {
      if (im.status !== "done" || !im.path || have.has(im.id)) return;
      n++;
      const btn = el("button", { type: "button", class: "post-pick-item", "aria-pressed": "false", title: run.title || "" },
        el("img", { src: imgSrc(im), alt: im.theme || run.title || "", loading: "lazy" }),
        el("span", { class: "post-pick-order" }));
      btn.addEventListener("click", () => {
        const i = chosen.findIndex((x) => x.imageId === im.id);
        if (i >= 0) chosen.splice(i, 1);
        else chosen.push({ runId: run.id, imageId: im.id });
        grid.querySelectorAll(".post-pick-item").forEach((b) => b.setAttribute("aria-pressed", "false"));
        chosen.forEach((c, idx) => {
          const b = grid.querySelector(`[data-image-id="${c.imageId}"]`);
          if (b) { b.setAttribute("aria-pressed", "true"); b.querySelector(".post-pick-order").textContent = String(idx + 1); }
        });
        countEl.textContent = `已选 ${chosen.length} 张（按点选顺序排列）`;
      });
      btn.dataset.imageId = im.id;
      grid.appendChild(btn);
    }));
    if (!n) grid.appendChild(el("div", { class: "muted" }, "作品库里没有可添加的图片"));
  }).catch((e) => { clear(grid); grid.appendChild(el("div", { class: "muted" }, e.message)); });
}

// ==================== Editor ====================
export async function openPostEditor(root, ctx, postId, onBack) {
  clear(root);
  let post;
  try {
    post = (await api("GET", `/api/posts/${encodeURIComponent(postId)}`)).post;
  } catch (e) {
    toast(e.message || "笔记不存在");
    onBack();
    return;
  }
  const view = { slide: 0, mode: "detail" }; // detail | feed
  let saveTimer = null;
  let pending = {};
  const saveState = el("span", { class: "muted post-save-state", "aria-live": "polite" }, "");

  // Resolved images in post order (only those that still exist).
  const imgById = new Map((post.resolvedImages || []).map((im) => [im.imageId, im]));
  const images = () => (post.images || []).map((r) => imgById.get(r.imageId)).filter(Boolean);

  function queueSave(fields) {
    Object.assign(pending, fields);
    saveState.textContent = "保存中…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 500);
  }
  async function flush() {
    clearTimeout(saveTimer);
    if (!Object.keys(pending).length) return;
    const body = pending;
    pending = {};
    try {
      const res = await api("PUT", `/api/posts/${encodeURIComponent(post.id)}`, body);
      // Keep local edits typed while the request was in flight.
      post = { ...res.post, title: post.title, body: post.body, tags: post.tags, images: post.images };
      (res.post.resolvedImages || []).forEach((im) => imgById.set(im.imageId, im));
      saveState.textContent = "已保存";
    } catch (e) {
      saveState.textContent = "保存失败";
      toast(e.message);
    }
  }

  const back = async () => { await flush(); onBack(); };

  const head = el("div", { class: "page-head post-editor-head" },
    el("div", { class: "row", style: { gap: "10px", alignItems: "center" } },
      el("button", { type: "button", class: "btn btn-sm", onClick: back }, "← 返回笔记"),
      el("h1", { class: "page-title" }, "笔记预览"),
      el("span", { class: "badge" }, PLATFORM_LABEL[post.platform] || "小红书"),
      saveState
    ),
    el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
      post.source?.canvasId
        ? el("button", { type: "button", class: "btn btn-sm", onClick: async () => { await flush(); ctx.go("canvas", { docId: post.source.canvasId }); } }, "回到来源画布")
        : null,
      el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => {
          showModal("删除这篇笔记？", el("p", null, "只删除笔记本身，作品库里的图片会保留。"), [
            el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
            el("button", {
              type: "button",
              class: "btn btn-danger",
              onClick: async () => {
                closeModal();
                try {
                  clearTimeout(saveTimer);
                  pending = {};
                  await api("DELETE", `/api/posts/${encodeURIComponent(post.id)}`);
                  toast("已删除笔记");
                  onBack();
                } catch (e) { toast(e.message); }
              },
            }, "删除"),
          ]);
        },
      }, "删除")
    )
  );

  const phoneHost = el("div", { class: "post-phone-col" });
  const editorHost = el("div", { class: "post-editor-col" });
  root.append(head, el("div", { class: "post-editor-layout" }, phoneHost, editorHost));

  // ---------- Phone preview ----------
  function drawPhone() {
    clear(phoneHost);
    const toggle = el("div", { class: "post-seg", role: "group", "aria-label": "预览方式" },
      ...[["detail", "笔记详情"], ["feed", "信息流封面"]].map(([k, label]) => el("button", {
        type: "button",
        class: "post-seg-btn",
        "aria-pressed": String(view.mode === k),
        onClick: () => { view.mode = k; drawPhone(); },
      }, label)));
    const phone = el("div", { class: "post-phone", "aria-label": "手机预览（示意）" });
    phone.appendChild(view.mode === "feed" ? feedView() : detailView());
    phoneHost.append(toggle, phone, el("p", { class: "muted post-phone-note" }, "仅为排版示意，实际显示以发布平台为准"));
  }

  function detailView() {
    const imgs = images();
    if (view.slide >= imgs.length) view.slide = Math.max(0, imgs.length - 1);
    const wrap = el("div", { class: "pp-detail" });
    wrap.appendChild(el("div", { class: "pp-top" },
      el("span", { class: "pp-avatar", "aria-hidden": "true" }),
      el("span", { class: "pp-author" }, "我的账号"),
      el("span", { class: "pp-follow" }, "关注")
    ));
    const stageEl = el("div", { class: "pp-carousel" });
    let dots = null;
    let paintDots = () => {};
    if (imgs.length) {
      const track = el("div", { class: "pp-track", style: { transform: `translateX(-${view.slide * 100}%)` } },
        ...imgs.map((im, i) => el("img", { src: fullSrc(im), alt: `第 ${i + 1} 张`, loading: i < 2 ? "eager" : "lazy" })));
      stageEl.appendChild(track);
      if (imgs.length > 1) {
        const go = (d) => { view.slide = (view.slide + d + imgs.length) % imgs.length; track.style.transform = `translateX(-${view.slide * 100}%)`; paintDots(); counter.textContent = `${view.slide + 1}/${imgs.length}`; };
        const counter = el("span", { class: "pp-counter" }, `${view.slide + 1}/${imgs.length}`);
        stageEl.append(
          el("button", { type: "button", class: "pp-nav pp-prev", "aria-label": "上一张", onClick: () => go(-1) }, "‹"),
          el("button", { type: "button", class: "pp-nav pp-next", "aria-label": "下一张", onClick: () => go(1) }, "›"),
          counter
        );
        stageEl.tabIndex = 0;
        stageEl.addEventListener("keydown", (e) => {
          if (e.key === "ArrowLeft") go(-1);
          if (e.key === "ArrowRight") go(1);
        });
        dots = el("div", { class: "pp-dots" }, ...imgs.map(() => el("span")));
        paintDots = () => dots.querySelectorAll("span").forEach((d, i) => d.classList.toggle("on", i === view.slide));
        paintDots();
      }
    } else {
      stageEl.appendChild(el("div", { class: "pp-noimg" }, "还没有配图"));
    }
    wrap.appendChild(stageEl);
    if (dots) wrap.appendChild(dots);
    const content = el("div", { class: "pp-content" },
      el("div", { class: "pp-title" }, post.title || "（标题）"),
      richBody(post.body || ""),
      post.tags?.length ? el("div", { class: "pp-tags" }, ...post.tags.map((t) => el("span", { class: "pp-hashtag" }, "#" + t))) : null,
      el("div", { class: "pp-date" }, "编辑于 " + (relTime(post.updatedAt) || "刚刚"))
    );
    wrap.appendChild(content);
    wrap.appendChild(el("div", { class: "pp-bar", "aria-hidden": "true" },
      el("span", { class: "pp-say" }, "说点什么…"),
      el("span", null, "♡ 赞"), el("span", null, "☆ 收藏"), el("span", null, "◌ 评论")
    ));
    return wrap;
  }

  function feedView() {
    const cover = images()[0];
    const mine = el("div", { class: "pf-card pf-mine" },
      cover ? el("img", { src: imgSrc(cover), alt: "我的封面" }) : el("div", { class: "pf-ph", style: { aspectRatio: "3 / 4" } }),
      el("div", { class: "pf-title" }, post.title || "（标题）"),
      el("div", { class: "pf-meta" }, el("span", { class: "pp-avatar sm" }), el("span", null, "我的账号"), el("span", { class: "pf-like" }, "♡"))
    );
    // Neutral placeholder cards with mixed heights, like a real two-column feed.
    const ph = (h) => el("div", { class: "pf-card pf-other", "aria-hidden": "true" },
      el("div", { class: "pf-ph", style: { height: h + "px" } }),
      el("div", { class: "pf-line" }), el("div", { class: "pf-line short" }));
    return el("div", { class: "pf-feed" },
      el("div", { class: "pf-col" }, ph(150), mine, ph(190)),
      el("div", { class: "pf-col" }, ph(210), ph(160), ph(140))
    );
  }

  // ---------- Editor panel ----------
  function drawEditor() {
    clear(editorHost);

    // Title
    const titleIn = el("input", { class: "input post-title-in", value: post.title || "", placeholder: "写一个吸引人的标题", "aria-label": "标题" });
    const titleCount = el("span", { class: "post-count" });
    const paintTitleCount = () => {
      const n = charLen(titleIn.value);
      titleCount.textContent = `${n}/${TITLE_LIMIT}`;
      titleCount.classList.toggle("over", n > TITLE_LIMIT);
    };
    paintTitleCount();
    titleIn.addEventListener("input", () => {
      post.title = titleIn.value;
      paintTitleCount();
      paintChips();
      queueSave({ title: post.title });
      drawPhone();
    });
    const chips = el("div", { class: "post-title-chips", role: "group", "aria-label": "备选标题" });
    const paintChips = () => {
      clear(chips);
      (post.titles || []).forEach((t) => chips.appendChild(el("button", {
        type: "button",
        class: "pc-copy-title-chip",
        "aria-pressed": String(t === post.title),
        onClick: () => { titleIn.value = t; titleIn.dispatchEvent(new Event("input")); },
      }, t)));
    };
    paintChips();

    // Body
    const bodyTa = el("textarea", { class: "textarea post-body-in", rows: "10", "aria-label": "正文", placeholder: "正文内容，可以直接写 #话题" });
    bodyTa.value = post.body || "";
    const bodyCount = el("span", { class: "post-count" });
    const paintBodyCount = () => {
      const n = charLen(bodyTa.value);
      bodyCount.textContent = `${n}/${BODY_LIMIT}`;
      bodyCount.classList.toggle("over", n > BODY_LIMIT);
    };
    paintBodyCount();
    bodyTa.addEventListener("input", () => { post.body = bodyTa.value; paintBodyCount(); queueSave({ body: post.body }); drawPhone(); });

    // Tags
    const tagBox = el("div", { class: "post-tags" });
    const tagIn = el("input", { class: "input post-tag-in", placeholder: "添加话题，回车确认", "aria-label": "添加话题" });
    const paintTags = () => {
      clear(tagBox);
      (post.tags || []).forEach((t, i) => tagBox.appendChild(el("span", { class: "post-tag" }, "#" + t,
        el("button", {
          type: "button",
          "aria-label": `删除话题 ${t}`,
          onClick: () => { post.tags.splice(i, 1); paintTags(); queueSave({ tags: post.tags }); drawPhone(); },
        }, "×"))));
      tagBox.appendChild(tagIn);
    };
    tagIn.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const v = tagIn.value.trim().replace(/^[#＃]+/, "");
      if (!v) return;
      post.tags = [...(post.tags || []).filter((x) => x !== v), v];
      tagIn.value = "";
      paintTags();
      queueSave({ tags: post.tags });
      drawPhone();
      tagIn.focus();
    });
    paintTags();

    // Images
    const strip = el("div", { class: "post-strip", role: "list", "aria-label": "配图顺序，第一张为封面" });
    const commitImages = () => {
      queueSave({ images: post.images, coverIndex: 0 });
      paintStrip();
      drawPhone();
    };
    const move = (from, to) => {
      if (to < 0 || to >= post.images.length || from === to) return;
      const [it] = post.images.splice(from, 1);
      post.images.splice(to, 0, it);
      commitImages();
    };
    let dragFrom = -1;
    const paintStrip = () => {
      clear(strip);
      post.images = (post.images || []).filter((r) => imgById.has(r.imageId));
      post.images.forEach((ref, i) => {
        const im = imgById.get(ref.imageId);
        const item = el("div", { class: "post-strip-item" + (i === 0 ? " is-cover" : ""), role: "listitem", draggable: "true" },
          el("img", { src: imgSrc(im), alt: `第 ${i + 1} 张`, loading: "lazy" }),
          el("span", { class: "post-strip-no" }, i === 0 ? "封面" : String(i + 1)),
          el("div", { class: "post-strip-acts" },
            el("button", { type: "button", title: "前移", "aria-label": `第 ${i + 1} 张前移`, disabled: i === 0, onClick: () => move(i, i - 1) }, "←"),
            i > 0 ? el("button", { type: "button", title: "设为封面", "aria-label": `第 ${i + 1} 张设为封面`, onClick: () => move(i, 0) }, "封") : null,
            el("button", { type: "button", title: "后移", "aria-label": `第 ${i + 1} 张后移`, disabled: i === post.images.length - 1, onClick: () => move(i, i + 1) }, "→"),
            el("button", {
              type: "button",
              title: "从笔记移除（作品库保留）",
              "aria-label": `移除第 ${i + 1} 张`,
              onClick: () => { post.images.splice(i, 1); commitImages(); },
            }, "×")
          )
        );
        item.addEventListener("dragstart", (e) => { dragFrom = i; item.classList.add("is-drag"); e.dataTransfer.effectAllowed = "move"; });
        item.addEventListener("dragend", () => item.classList.remove("is-drag"));
        item.addEventListener("dragover", (e) => { e.preventDefault(); item.classList.add("is-over"); });
        item.addEventListener("dragleave", () => item.classList.remove("is-over"));
        item.addEventListener("drop", (e) => { e.preventDefault(); item.classList.remove("is-over"); if (dragFrom >= 0) move(dragFrom, i); dragFrom = -1; });
        strip.appendChild(item);
      });
      strip.appendChild(el("button", {
        type: "button",
        class: "post-strip-add",
        onClick: () => pickWorkImages(post.images.map((r) => r.imageId), async (refs) => {
          if (!refs.length) return;
          post.images = [...post.images, ...refs];
          queueSave({ images: post.images, coverIndex: 0 });
          await flush();
          paintStrip();
          drawPhone();
        }),
      }, "+ 添加"));
    };
    paintStrip();

    // Export & copy
    const actions = el("div", { class: "post-actions" },
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: async () => {
          await flush();
          try {
            const res = await api("POST", `/api/posts/${encodeURIComponent(post.id)}/export`, { reveal: true });
            post.status = "exported";
            toast(`已导出 ${res.count} 张图和文案到：${res.dir}`);
          } catch (e) { toast(e.message); }
        },
      }, post.platform === "xiaohongshu" ? "导出 3:4 图片 + 文案" : "导出图片 + 文案"),
      el("button", { type: "button", class: "btn", onClick: () => copyText(post.title || "").then(() => toast("已复制标题")) }, "复制标题"),
      el("button", {
        type: "button",
        class: "btn",
        onClick: () => copyText([String(post.body || "").trim(), tagLine(post.tags)].filter(Boolean).join("\n\n")).then(() => toast("已复制正文和话题")),
      }, "复制正文 + 话题"),
      el("button", { type: "button", class: "btn", onClick: () => copyText(fullText(post)).then(() => toast("已复制完整文案")) }, "复制全部")
    );

    editorHost.append(
      section("标题", titleCount, titleIn, chips),
      section("正文", bodyCount, bodyTa),
      section("话题", null, tagBox),
      section("配图", el("span", { class: "muted" }, "拖动排序 · 第一张是封面"), strip),
      section("导出", null, actions,
        el("p", { class: "muted" }, "图片按顺序命名为 01、02…，和「笔记文案.txt」放在同一个文件夹，方便传到手机发布。"))
    );
  }

  function section(label, aside, ...children) {
    return el("section", { class: "post-sec" },
      el("div", { class: "post-sec-head" }, el("span", { class: "studio-row-label" }, label), aside),
      ...children);
  }

  drawPhone();
  drawEditor();
}
