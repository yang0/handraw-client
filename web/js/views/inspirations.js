import { api, clear, closeModal, copyText, el, localImg, onEvent, openURL, remoteThumb, showModal, toast } from "../api.js";
import { masonry } from "../masonry.js";
import { openInspirationRemixModal, openShareInspirationModal } from "./work-remix-modal.js";

const SOURCE_LABELS = {
  x: "X 采集",
  chrome: "浏览器剪藏",
  web: "网页采集",
  local: "我的生图",
  community: "社区收藏",
  import: "手动收集",
};

const viewState = {
  tab: "vault", // vault | plaza | earnings
  q: "",
  source: "all",
  tag: "",
  plazaFilter: "all:latest", // all:latest | all:popular | unlocked:latest | mine:latest
  plazaQ: "",
};

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function applySlotValues(basePrompt, slots, values) {
  let out = String(basePrompt || "");
  if (!Array.isArray(slots) || !slots.length) return out;
  const extras = [];
  for (const s of slots) {
    const key = s?.key || "";
    const defVal = String(s?.defaultValue || "").trim();
    const curVal = String(values[key] ?? defVal).trim();
    if (key && out.includes(`{{${key}}}`)) {
      out = out.split(`{{${key}}}`).join(curVal || defVal);
      continue;
    }
    if (!curVal || curVal === defVal) continue;
    if (defVal && out.includes(defVal)) {
      out = out.split(defVal).join(curVal);
    } else {
      extras.push(`${s.label || key}：${curVal}`);
    }
  }
  if (extras.length) {
    out = `${out}\n\n【本次同款替换要求】${extras.join("；")}`;
  }
  return out;
}

export function openClipperSetupModal(meta = {}) {
  let curToken = meta.clipToken || "";
  const ep = meta.clipEndpoint || `${location.origin}/api/inspirations/clip`;
  const portMatch = ep.match(/:(\d+)\//);
  const port = portMatch ? portMatch[1] : (location.port || "80");

  const tokenCode = el("code", { class: "mono insp-token-code" }, curToken || "加载中…");
  const body = el("div", { class: "col", style: { gap: "12px" } },
    el("p", { class: "muted", style: { margin: 0 } },
      "安装内置的「手绘风灵感捕手」Chrome / Edge 扩展后，刷 X (Twitter) 或任意网页时，点一下按钮或右键即可把图片和杂乱推文直接收进本机灵感库，并自动用 AI 提炼成可复用提示词。"
    ),
    el("div", { class: "card col", style: { gap: "8px", padding: "12px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap" } },
        el("strong", null, "1. 本地桥接地址（扩展自动使用）"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: async () => toast((await copyText(ep)) ? "已复制本地接口地址" : "复制失败"),
        }, "复制地址")
      ),
      el("code", { class: "mono muted", style: { wordBreak: "break-all" } }, `${ep}（端口 ${port}）`),
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", marginTop: "4px" } },
        el("strong", null, "2. 本机配对 Token（仅限本机扩展通信）"),
        el("div", { class: "row", style: { gap: "6px" } },
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            onClick: async () => toast((await copyText(curToken)) ? "已复制配对 Token" : "复制失败"),
          }, "📋 复制 Token"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: async () => {
              try {
                const r = await api("POST", "/api/settings/clip-token/rotate", {});
                if (r.clipToken) {
                  curToken = r.clipToken;
                  tokenCode.textContent = curToken;
                  toast("已重置配对 Token，请同步更新到浏览器扩展中");
                }
              } catch (e) { toast(e.message); }
            },
          }, "重置 Token")
        )
      ),
      tokenCode
    ),
    el("div", { class: "card col", style: { gap: "6px", padding: "12px", background: "var(--paper)" } },
      el("strong", null, "3. 如何加载 Chrome / Edge 扩展（30 秒完成）"),
      el("ol", { style: { margin: "4px 0 0", paddingLeft: "20px", fontSize: "12.5px", lineHeight: "1.7" } },
        el("li", null, "打开 Chrome / Edge，在地址栏输入 ", el("code", { class: "mono" }, "chrome://extensions"), " 并开启右上角「开发者模式」。"),
        el("li", null, "点击「加载已解压的扩展程序」，选择客户端目录下的 ", el("code", { class: "mono" }, "extensions/handraw-clipper"), " 文件夹。"),
        el("li", null, "点击浏览器右上角「手绘风灵感捕手」图标，填入端口 ", el("code", { class: "mono" }, port), " 和上方 Token，点击「测试连接」即可！")
      )
    )
  );

  showModal("配置 Chrome 灵感捕手扩展", body, [
    el("button", { type: "button", class: "btn btn-primary", onClick: closeModal }, "知道了"),
  ]);
}

export async function renderInspirations(root, ctx, params = {}) {
  if (params.tab && ["vault", "plaza", "earnings"].includes(params.tab)) {
    viewState.tab = params.tab;
  }
  clear(root);

  let latestVaultMeta = { clipToken: "", clipEndpoint: "", siteBase: "" };

  const tabBar = el("div", { class: "tabs" });
  const tabsDef = [
    ["vault", "我的灵感库"],
    ["plaza", "社区灵感广场"],
    ["earnings", "分享与积分收益"],
  ];

  const drawTabs = () => {
    clear(tabBar);
    tabsDef.forEach(([id, label]) => {
      tabBar.appendChild(el("button", {
        type: "button",
        class: "tab" + (viewState.tab === id ? " active" : ""),
        dataset: { tab: id },
        onClick: () => {
          viewState.tab = id;
          drawTabs();
          drawBody();
        },
      }, label));
    });
  };
  drawTabs();

  const headerActions = el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
    el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: () => openClipperSetupModal(latestVaultMeta),
    }, "🧩 Chrome 灵感捕手"),
    el("button", {
      type: "button",
      class: "btn btn-sm btn-primary",
      onClick: () => openCreateInspirationModal(ctx, () => {
        if (viewState.tab !== "vault") {
          viewState.tab = "vault";
          drawTabs();
        }
        drawBody();
      }),
    }, "＋ 收集新灵感")
  );

  root.appendChild(el("div", { class: "page-head" },
    el("div", { class: "row", style: { gap: "12px", flexWrap: "wrap" } },
      el("h1", { class: "page-title" }, "灵感库"),
      tabBar
    ),
    headerActions
  ));

  const stage = el("div", { class: "col", style: { gap: "14px" } });
  root.appendChild(stage);

  async function drawBody() {
    clear(stage);
    if (viewState.tab === "vault") {
      await renderVaultTab(stage, ctx, (meta) => { latestVaultMeta = meta; });
    } else if (viewState.tab === "plaza") {
      await renderPlazaTab(stage, ctx);
    } else {
      await renderEarningsTab(stage, ctx, () => {
        viewState.tab = "vault";
        drawTabs();
        drawBody();
      });
    }
  }

  const unsub = onEvent((msg) => {
    if (!root.isConnected) {
      unsub();
      return;
    }
    if (msg.type === "inspirations" && viewState.tab === "vault") {
      if (msg.data?.clipped && msg.data?.title) {
        toast(`📌 收到来自浏览器捕手的新灵感：${msg.data.title}`);
      }
      drawBody();
    }
  });

  await drawBody();
}

function openCreateInspirationModal(ctx, onCreated) {
  let imageDataUrl = "";
  const previewImg = el("img", { class: "insp-drop-preview hidden", alt: "预览图" });
  const dropHint = el("span", { class: "muted" }, "点击选图、拖拽图片到这里，或直接按 Ctrl+V 粘贴剪贴板图片");
  const fileIn = el("input", { type: "file", accept: "image/*", class: "hidden" });

  const setPickedImage = async (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      imageDataUrl = await readFileAsDataURL(file);
      previewImg.src = imageDataUrl;
      previewImg.classList.remove("hidden");
      dropHint.textContent = `已选：${file.name || "剪贴板图片"}（点击可更换）`;
    } catch (e) { toast(e.message); }
  };

  fileIn.addEventListener("change", () => {
    if (fileIn.files?.[0]) setPickedImage(fileIn.files[0]);
  });

  const dropZone = el("div", {
    class: "insp-dropzone",
    tabindex: "0",
    onClick: () => fileIn.click(),
  }, previewImg, dropHint, fileIn);
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("is-drag"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-drag"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("is-drag");
    const f = e.dataTransfer?.files?.[0];
    if (f) setPickedImage(f);
  });

  const imgUrlIn = el("input", { class: "input", placeholder: "或粘贴远程图片链接 https://…（可选）" });
  const rawTextIn = el("textarea", {
    class: "input",
    rows: 5,
    placeholder: "直接粘贴 X (Twitter) 推文全文、小红书文案或任意杂乱提示词…\n勾选下方「AI 自动整理」后，会自动去掉废话、翻译中文并提炼可替换变量！",
  });
  const titleIn = el("input", { class: "input", placeholder: "标题（留空可由 AI 自动起名）" });
  const sourceUrlIn = el("input", { class: "input", placeholder: "来源链接（如推文链接，可选）" });
  const autoOrgChk = el("input", { type: "checkbox", checked: true });

  const onPaste = (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type?.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          setPickedImage(f);
          break;
        }
      }
    }
  };
  document.addEventListener("paste", onPaste);

  const cleanupAndClose = () => {
    document.removeEventListener("paste", onPaste);
    closeModal();
  };

  const body = el("div", { class: "col", style: { gap: "10px" } },
    dropZone,
    el("div", { class: "field" }, el("label", null, "推文原文 / 提示词"), rawTextIn),
    el("div", { class: "row", style: { gap: "10px" } },
      el("div", { class: "field", style: { flex: "1" } }, el("label", null, "灵感标题（可选）"), titleIn),
      el("div", { class: "field", style: { flex: "1" } }, el("label", null, "来源链接（可选）"), sourceUrlIn)
    ),
    el("div", { class: "field" }, el("label", null, "或图片 URL（未传本地图时生效）"), imgUrlIn),
    el("label", { class: "row", style: { cursor: "pointer", fontSize: "13px" } },
      autoOrgChk,
      el("span", null, "✨ 保存后立即调用 AI 自动整理（去推文废话 + 中文翻译 + 提炼同款变量 + 自动打标签）")
    )
  );

  const saveBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    onClick: async () => {
      const rawTxt = rawTextIn.value.trim();
      const urlVal = imgUrlIn.value.trim();
      if (!imageDataUrl && !urlVal && !rawTxt) {
        toast("请至少上传/粘贴一张图片，或输入一段提示词/推文");
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = autoOrgChk.checked ? "正在保存并 AI 整理…" : "正在保存…";
      try {
        const srcUrl = sourceUrlIn.value.trim();
        const inferredSource = /x\.com|twitter\.com/i.test(srcUrl) ? "x" : "import";
        const res = await api("POST", "/api/inspirations", {
          title: titleIn.value.trim(),
          imageDataUrl,
          imageUrl: urlVal,
          rawText: rawTxt,
          prompt: rawTxt,
          source: inferredSource,
          sourceUrl: srcUrl,
          autoOrganize: autoOrgChk.checked,
        });
        cleanupAndClose();
        toast(res.item?.aiOrganized ? "已保存并完成 AI 整理！" : "已收进灵感库");
        onCreated?.(res.item);
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = "收进灵感库";
        toast(e?.message || "保存失败");
      }
    },
  }, "收进灵感库");

  showModal("收集新灵感", body, [
    el("button", { type: "button", class: "btn", onClick: cleanupAndClose }, "取消"),
    saveBtn,
  ]);
}

function openLocalInspirationDetail(item, ctx, onChanged) {
  let cur = { ...item };
  let showZh = false;

  const renderModal = () => {
    const slots = Array.isArray(cur.slots) ? cur.slots : [];
    const slotValues = {};
    slots.forEach((s) => { if (s?.key) slotValues[s.key] = s.defaultValue || ""; });

    const imgSrc = cur.imagePath ? localImg(cur.imagePath) : (cur.imageUrl ? remoteThumb(cur.imageUrl, 760) : "");
    const promptDisplay = el("div", { class: "insp-prompt-text" }, "");
    const updatePrompt = () => {
      const base = (showZh && cur.promptZh) ? cur.promptZh : (cur.prompt || cur.promptZh || cur.rawText || "");
      promptDisplay.textContent = applySlotValues(base, slots, slotValues);
    };
    updatePrompt();

    const orgBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: async () => {
        orgBtn.disabled = true;
        orgBtn.textContent = "✨ AI 整理中…";
        try {
          const r = await api("POST", `/api/inspirations/${encodeURIComponent(cur.id)}/organize`, {});
          if (r.item) {
            cur = r.item;
            toast("AI 已提炼干净提示词、中文版与可替换变量！");
            onChanged?.();
            renderModal();
          }
        } catch (e) {
          orgBtn.disabled = false;
          orgBtn.textContent = "✨ AI 一键整理";
          toast(e?.message || "AI 整理失败");
        }
      },
    }, cur.aiOrganized ? "✨ 重新 AI 整理" : "✨ AI 一键整理");

    const langBtn = cur.promptZh && cur.prompt && cur.promptZh !== cur.prompt
      ? el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => {
            showZh = !showZh;
            langBtn.textContent = showZh ? "看原版提示词" : "看中文理解版";
            updatePrompt();
          },
        }, showZh ? "看原版提示词" : "看中文理解版")
      : null;

    const slotsEl = slots.length
      ? el("div", { class: "insp-slots-box col" },
          el("span", { class: "muted", style: { fontSize: "12px" } }, "✨ AI 提炼的同款可替换变量（改完直接点下方做同款）："),
          el("div", { class: "insp-slots-grid" },
            ...slots.map((s) => {
              const inp = el("input", { class: "input", value: slotValues[s.key] || "", placeholder: s.defaultValue || s.label });
              inp.addEventListener("input", () => {
                slotValues[s.key] = inp.value;
                updatePrompt();
              });
              return el("label", { class: "insp-slot-field" },
                el("span", { class: "muted" }, s.label || s.key),
                inp
              );
            })
          )
        )
      : null;

    const body = el("div", { class: "insp-modal-layout" },
      el("div", { class: "insp-modal-media" },
        imgSrc ? el("img", { src: imgSrc, alt: cur.title || "", class: "insp-modal-img" }) : el("div", { class: "muted" }, "纯文字提示词灵感")
      ),
      el("div", { class: "insp-modal-info col" },
        el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start", gap: "8px" } },
          el("div", { class: "col", style: { gap: "4px" } },
            el("h3", { style: { margin: 0, fontSize: "17px" } }, cur.title || "未命名灵感"),
            el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
              el("span", { class: "badge" }, SOURCE_LABELS[cur.source] || cur.source || "灵感"),
              cur.aiOrganized ? el("span", { class: "badge badge-ok" }, "✨ AI 已整理") : null,
              cur.suggestedStyle ? el("span", { class: "badge badge-accent" }, `推荐画风 ${cur.suggestedStyle}`) : null,
              cur.publishedId ? el("span", { class: "badge badge-ok" }, cur.publishedPrice > 0 ? `已分享 · ${cur.publishedPrice} 积分解锁` : "已公开分享") : null,
              cur.sourceAuthor ? el("span", { class: "muted" }, `来源：${cur.sourceAuthor}`) : null
            )
          ),
          cur.sourceUrl ? el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(cur.sourceUrl) }, "原帖 ↗") : null
        ),
        (cur.tags || []).length ? el("div", { class: "row", style: { gap: "5px", flexWrap: "wrap" } },
          ...cur.tags.map((t) => el("span", { class: "badge" }, `#${t}`))
        ) : null,
        el("div", { class: "insp-prompt-box" },
          el("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "6px", flexWrap: "wrap", gap: "6px" } },
            el("strong", { style: { fontSize: "12.5px" } }, "提示词内容"),
            el("div", { class: "row", style: { gap: "6px" } },
              orgBtn,
              langBtn,
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: async () => toast((await copyText(promptDisplay.textContent)) ? "提示词已复制" : "复制失败"),
              }, "📋 复制")
            )
          ),
          promptDisplay
        ),
        slotsEl,
        el("div", { class: "insp-remix-actions col" },
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => {
              const finalPrompt = promptDisplay.textContent;
              closeModal();
              ctx.go("create", {
                forkOf: cur.workId || "",
                forkTitle: cur.title || "",
                style: cur.suggestedStyle || cur.recipe?.styleIds?.[0] || "",
                recipe: cur.recipe || (cur.suggestedStyle ? { styleIds: [cur.suggestedStyle] } : {}),
                theme: finalPrompt,
              });
            },
          }, "✨ 一键带入生图工作台做同款"),
          el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
            el("button", {
              type: "button",
              class: "btn",
              style: { flex: "1" },
              onClick: () => {
                const finalPrompt = promptDisplay.textContent;
                closeModal();
                ctx.go("chat", { prompt: `请参考这份灵感提示词帮我画一张同款：\n${finalPrompt}` });
              },
            }, "💬 带入会话改写"),
            el("button", {
              type: "button",
              class: "btn btn-accent-soft",
              style: { flex: "1" },
              onClick: () => openShareInspirationModal(cur, ctx, () => onChanged?.()),
            }, cur.publishedId ? "☁ 更新/再分享" : "☁ 分享到社区赚积分")
          )
        )
      )
    );

    showModal("灵感详情", body, [
      el("button", {
        type: "button",
        class: "btn btn-danger",
        style: { marginRight: "auto" },
        onClick: async () => {
          try {
            await api("DELETE", `/api/inspirations/${encodeURIComponent(cur.id)}`);
            closeModal();
            toast("已从灵感库删除");
            onChanged?.();
          } catch (e) { toast(e.message); }
        },
      }, "删除"),
      cur.publishedUrl ? el("button", { type: "button", class: "btn", onClick: () => openURL(cur.publishedUrl) }, "查看社区页 ↗") : null,
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    ].filter(Boolean));
  };

  renderModal();
}

async function renderVaultTab(stage, ctx, onMeta) {
  const searchIn = el("input", {
    class: "input",
    type: "search",
    value: viewState.q,
    placeholder: "搜标题、提示词、作者、标签…",
    style: { maxWidth: "280px" },
  });

  const srcPills = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
  const srcDefs = [
    ["all", "全部"],
    ["web_clip", "X 与网页捕手"],
    ["local", "我的生图"],
    ["community", "社区收藏"],
    ["import", "手动收集"],
  ];

  const tagsBar = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
  const gridWrap = el("div");

  const drawSrcPills = () => {
    clear(srcPills);
    srcDefs.forEach(([val, lbl]) => {
      srcPills.appendChild(el("button", {
        type: "button",
        class: "pill-btn" + (viewState.source === val ? " pill-accent" : ""),
        onClick: () => {
          viewState.source = val;
          drawSrcPills();
          loadVault();
        },
      }, lbl));
    });
  };
  drawSrcPills();

  let debounce = null;
  searchIn.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      viewState.q = searchIn.value.trim();
      loadVault();
    }, 180);
  });

  stage.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } },
    searchIn,
    srcPills
  ));
  stage.appendChild(tagsBar);
  stage.appendChild(gridWrap);

  async function loadVault() {
    const qs = new URLSearchParams();
    if (viewState.q) qs.set("q", viewState.q);
    if (viewState.source && viewState.source !== "all") qs.set("source", viewState.source);
    if (viewState.tag) qs.set("tag", viewState.tag);
    const res = await api("GET", `/api/inspirations?${qs.toString()}`).catch(() => ({ items: [], tags: [] }));
    onMeta?.({ clipToken: res.clipToken || "", clipEndpoint: res.clipEndpoint || "", siteBase: res.siteBase || "" });

    clear(tagsBar);
    const tags = (res.tags || []).slice(0, 14);
    if (tags.length) {
      tagsBar.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } }, "标签："));
      if (viewState.tag) {
        tagsBar.appendChild(el("button", {
          type: "button",
          class: "pill-btn pill-accent",
          onClick: () => { viewState.tag = ""; loadVault(); },
        }, `#${viewState.tag} ✕`));
      }
      tags.forEach(({ tag, count }) => {
        if (tag === viewState.tag) return;
        tagsBar.appendChild(el("button", {
          type: "button",
          class: "pill-btn",
          onClick: () => { viewState.tag = tag; loadVault(); },
        }, `#${tag} (${count})`));
      });
    }

    clear(gridWrap);
    const items = res.items || [];
    if (!items.length) {
      gridWrap.appendChild(el("div", { class: "card col insp-empty" },
        el("h3", { style: { margin: 0 } }, "💡 你的个人灵感库还是空的"),
        el("p", { class: "muted", style: { margin: "4px 0 8px", maxWidth: "520px" } },
          "无论是在 X (Twitter) 刷到的神级提示词、在画廊看到的惊艳作品，还是你自己刚画出的得意之作，都可以一键收进这里；用 AI 自动剥离废话、提炼变量，再分享到社区赚积分！"
        ),
        el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => openCreateInspirationModal(ctx, loadVault),
          }, "＋ 粘贴第一条灵感 / 推文"),
          el("button", {
            type: "button",
            class: "btn",
            onClick: () => openClipperSetupModal({ clipToken: res.clipToken, clipEndpoint: res.clipEndpoint }),
          }, "🧩 配置 Chrome 灵感捕手"),
          el("button", {
            type: "button",
            class: "btn",
            onClick: () => ctx.go("inspirations", { tab: "plaza" }),
          }, "去社区灵感广场逛逛 →")
        )
      ));
      return;
    }

    const cards = items.map((item) => {
      const imgSrc = item.imagePath ? localImg(item.imagePath) : (item.imageUrl ? remoteThumb(item.imageUrl, 480) : "");
      const excerpt = (item.promptZh || item.prompt || item.rawText || "").replace(/\s+/g, " ").trim().slice(0, 88);
      return el("article", { class: "style-card insp-card" },
        el("div", {
          class: "insp-card-click",
          onClick: () => openLocalInspirationDetail(item, ctx, loadVault),
        },
          imgSrc
            ? el("img", { class: "style-thumb", src: imgSrc, alt: item.title || "", loading: "lazy" })
            : el("div", { class: "insp-text-cover" }, excerpt || item.title),
          el("div", { class: "style-body" },
            el("div", { class: "row", style: { justifyContent: "space-between", gap: "4px", flexWrap: "wrap" } },
              el("span", { class: "badge" }, SOURCE_LABELS[item.source] || item.source || "灵感"),
              item.publishedId
                ? el("span", { class: "badge badge-ok" }, item.publishedPrice > 0 ? `🔒 ${item.publishedPrice} 积分` : "已分享")
                : (item.aiOrganized ? el("span", { class: "badge badge-accent" }, "✨ 已整理") : null)
            ),
            el("div", { class: "style-name", title: item.title }, item.title || "未命名灵感"),
            imgSrc && excerpt ? el("p", { class: "style-traits insp-excerpt" }, excerpt) : null,
            (item.tags || []).length
              ? el("div", { class: "row", style: { gap: "4px", flexWrap: "wrap", marginTop: "4px" } },
                  ...item.tags.slice(0, 3).map((t) => el("span", { class: "muted", style: { fontSize: "11px" } }, `#${t}`))
                )
              : null
          )
        ),
        el("footer", { class: "insp-card-foot" },
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => ctx.go("create", {
              forkOf: item.workId || "",
              forkTitle: item.title || "",
              style: item.suggestedStyle || item.recipe?.styleIds?.[0] || "",
              recipe: item.recipe || (item.suggestedStyle ? { styleIds: [item.suggestedStyle] } : {}),
              theme: item.prompt || item.promptZh || item.rawText || item.title,
            }),
          }, "✨ 做同款"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            onClick: () => openShareInspirationModal(item, ctx, loadVault),
          }, item.publishedId ? "已分享" : "☁ 分享赚积分")
        )
      );
    });

    gridWrap.appendChild(masonry({ class: "insp-grid" }, cards));
  }

  await loadVault();
}

async function renderPlazaTab(stage, ctx) {
  const searchIn = el("input", {
    class: "input",
    type: "search",
    value: viewState.plazaQ,
    placeholder: "搜索社区灵感、提示词、标签…",
    style: { maxWidth: "280px" },
  });
  const pricePills = el("div", { class: "row", style: { gap: "6px" } });
  const gridWrap = el("div");

  const drawPricePills = () => {
    clear(pricePills);
    [
      ["all:latest", "最新上架"],
      ["all:popular", "热门解锁"],
      ["unlocked:latest", "我已解锁"],
      ["mine:latest", "我发布的"],
    ].forEach(([val, lbl]) => {
      pricePills.appendChild(el("button", {
        type: "button",
        class: "pill-btn" + (viewState.plazaFilter === val ? " pill-accent" : ""),
        onClick: () => {
          viewState.plazaFilter = val;
          drawPricePills();
          loadPlaza();
        },
      }, lbl));
    });
  };
  drawPricePills();

  let debounce = null;
  searchIn.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      viewState.plazaQ = searchIn.value.trim();
      loadPlaza();
    }, 200);
  });

  stage.appendChild(el("div", { class: "card row insp-plaza-banner", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } },
    el("div", { class: "col", style: { gap: "2px" } },
      el("strong", null, "社区灵感广场 · 看图选灵感，积分解锁完整提示词并一键做同款"),
      el("span", { class: "muted" }, "提示词统一采用 1~20 积分解锁（作者享 80% 积分分成），积分仅用于解锁收费提示词、付费画风与收费贴，不兑换生图额度。")
    ),
    el("button", {
      type: "button",
      class: "btn btn-sm btn-primary",
      onClick: () => ctx.go("inspirations", { tab: "vault" }),
    }, "去分享我的提示词赚积分 →")
  ));
  stage.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } }, searchIn, pricePills));
  stage.appendChild(gridWrap);

  async function loadPlaza() {
    clear(gridWrap);
    gridWrap.appendChild(el("p", { class: "muted" }, "正在加载社区灵感广场…"));
    try {
      const [scope, sort] = String(viewState.plazaFilter || "all:latest").split(":");
      const qs = new URLSearchParams({ limit: "36", sort: sort || "latest" });
      if (viewState.plazaQ) qs.set("q", viewState.plazaQ);
      if (scope && scope !== "all") qs.set("pricing", scope);
      const res = await api("GET", `/api/site/inspirations?${qs.toString()}`);
      const siteBase = (res.siteBase || "https://handraw-style.com").replace(/\/+$/, "");
      const items = res.items || [];
      clear(gridWrap);
      if (!items.length) {
        gridWrap.appendChild(el("div", { class: "card col insp-empty" },
          el("h3", { style: { margin: 0 } }, "广场正在等待第一批灵感分享者！"),
          el("p", { class: "muted", style: { margin: "4px 0 8px" } }, "成为首批分享者：在「我的灵感库」分享 1 张好图和提示词，设置 1~20 积分解锁即可赚取 80% 创作者分成。"),
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => ctx.go("inspirations", { tab: "vault" }),
          }, "去分享第一条灵感 →")
        ));
        return;
      }

      const cards = items.map((it) => {
        const rawImg = it.imageUrl || "";
        const imgUrl = rawImg ? (/^https?:\/\//i.test(rawImg) ? rawImg : `${siteBase}/${rawImg.replace(/^\/+/, "")}`) : "";
        const price = Number(it.price || 0);
        const locked = Boolean(it.promptLocked);
        return el("article", {
          class: "style-card insp-card",
          onClick: () => openInspirationRemixModal(it.id, ctx, { title: it.title, siteBase, onUnlocked: loadPlaza }),
        },
          imgUrl ? el("img", { class: "style-thumb", src: remoteThumb(imgUrl, 480), alt: it.title || "", loading: "lazy" }) : null,
          el("div", { class: "style-body" },
            el("div", { class: "row", style: { justifyContent: "space-between", gap: "4px", flexWrap: "wrap" } },
              el("span", { class: "badge " + (locked ? "badge-accent" : "badge-ok") }, locked ? `🔒 ${price} 积分解锁` : `🔓 已解锁 (${price} 积分)`),
              el("span", { class: "muted", style: { fontSize: "11.5px" } }, `${it.unlockCount || 0} 解锁`)
            ),
            el("div", { class: "style-name", title: it.title }, it.title || "社区灵感"),
            it.promptPreview ? el("p", { class: "style-traits insp-excerpt" }, it.promptPreview) : null,
            el("div", { class: "muted", style: { fontSize: "11.5px", marginTop: "4px" } }, it.authorName || it.sourceAuthor || "社区创作者")
          )
        );
      });
      gridWrap.appendChild(masonry({ class: "insp-grid" }, cards));
    } catch (e) {
      clear(gridWrap);
      const msg = e?.message || "网络异常";
      if (/灰度|内测|feature_not_enabled|403/i.test(msg)) {
        gridWrap.appendChild(el("div", { class: "card col insp-empty" },
          el("h3", { style: { margin: 0 } }, "🚦 社区灵感广场正在灰度内测中"),
          el("p", { class: "muted", style: { margin: "4px 0 8px", maxWidth: "500px" } },
            "当前社区广场按「管理员/运营 → 版主 → 指定内测网友 → 逐步放量」的节奏开放。你的「我的灵感库」（本地收集、Chrome 捕手、AI 整理与做同款）不受影响，可照常使用。"
          ),
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => ctx.go("inspirations", { tab: "vault" }),
          }, "返回我的本地灵感库")
        ));
        return;
      }
      gridWrap.appendChild(el("div", { class: "card row muted" },
        `加载社区灵感广场失败：${msg}`,
        el("button", { type: "button", class: "btn btn-sm", onClick: loadPlaza }, "重试")
      ));
    }
  }

  await loadPlaza();
}

async function renderEarningsTab(stage, ctx, goVault) {
  stage.appendChild(el("p", { class: "muted" }, "正在同步你的创作与积分收益…"));
  try {
    const data = await api("GET", "/api/site/creator-earnings");
    clear(stage);

    const stats = [
      ["已分享灵感 / 作品", String(data.publishedCount ?? data.inspirationCount ?? 0), "公开或积分解锁"],
      ["被做同款总次数", String(data.totalForks ?? 0), "每次有效同款 +2 积分"],
      ["被积分解锁次数", String(data.totalUnlocks ?? 0), "作者享 80% 积分分成"],
      ["累计赚取积分", String(data.totalEarned ?? data.totalPointsEarned ?? 0), data.pendingPoints > 0 ? `含待结算 +${data.pendingPoints}` : "可用于解锁收费画风与提示词"],
    ];

    stage.appendChild(el("div", { class: "insp-stats-grid" },
      ...stats.map(([label, val, sub]) => el("div", { class: "card col insp-stat-card" },
        el("span", { class: "muted" }, label),
        el("strong", { class: "insp-stat-val" }, val),
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, sub)
      ))
    ));

    stage.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } },
      el("div", { class: "col", style: { gap: "3px" } },
        el("strong", null, "积分生态说明"),
        el("span", { class: "muted" }, "灵感提示词统一采用 1~20 积分解锁（作者享 80% 分成），社区公开作品被做同款享 +2 积分/人。积分仅用于解锁收费提示词、付费画风与社区付费贴，不兑换生图额度。")
      ),
      el("button", { type: "button", class: "btn btn-primary btn-sm", onClick: goVault }, "去灵感库继续分享 →")
    ));

    const myItems = Array.isArray(data.items) ? data.items : (Array.isArray(data.inspirations) ? data.inspirations : []);
    if (myItems.length) {
      stage.appendChild(el("h2", { style: { fontSize: "15px", margin: "6px 0 0" } }, "我已分享的社区灵感"));
      const list = el("div", { class: "col", style: { gap: "8px" } });
      myItems.forEach((it) => {
        list.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", padding: "10px 14px" } },
          el("div", { class: "col", style: { gap: "2px" } },
            el("strong", null, it.title || "未命名灵感"),
            el("span", { class: "muted" }, `${it.price > 0 ? `积分解锁 ${it.price} 分 · ${it.unlockCount || 0} 人解锁` : `免费公开 · ${it.forkCount || 0} 人做同款`}`)
          ),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => openInspirationRemixModal(it.id, ctx, { title: it.title }),
          }, "查看详情")
        ));
      });
      stage.appendChild(list);
    }

    const events = Array.isArray(data.recentEvents) ? data.recentEvents : (Array.isArray(data.earnings) ? data.earnings : []);
    if (events.length) {
      stage.appendChild(el("h2", { style: { fontSize: "15px", margin: "6px 0 0" } }, "近期积分入账记录"));
      const evBox = el("div", { class: "card col", style: { gap: "8px" } });
      events.slice(0, 20).forEach((ev) => {
        const delta = Number(ev.delta ?? ev.amount ?? ev.points ?? 0);
        evBox.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", borderBottom: "1px solid var(--line)", paddingBottom: "6px" } },
          el("span", null, ev.note || ev.reason || ev.kind || "创作积分"),
          el("strong", { style: { color: "var(--ok)" } }, `+${delta} 积分`)
        ));
      });
      stage.appendChild(evBox);
    }
  } catch (e) {
    clear(stage);
    const needLogin = /登录|login|401/i.test(e?.message || "");
    stage.appendChild(el("div", { class: "card col insp-empty" },
      el("h3", { style: { margin: 0 } }, needLogin ? "登录后查看你的分享与积分收益" : "暂时无法拉取收益数据"),
      el("p", { class: "muted", style: { margin: "4px 0 8px" } }, needLogin ? "登录手绘风账号后，你分享的每一条灵感与获得的解锁分成、同款积分都会自动汇总在这里。" : (e?.message || "请稍后重试")),
      needLogin
        ? el("button", { type: "button", class: "btn btn-primary", onClick: () => ctx.go("settings", { anchor: "settings-account" }) }, "前往登录手绘风账号")
        : el("button", { type: "button", class: "btn", onClick: () => renderEarningsTab(stage, ctx, goVault) }, "重试")
    ));
  }
}
