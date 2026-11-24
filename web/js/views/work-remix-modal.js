import { api, clear, closeModal, copyText, el, localImg, openURL, remoteThumb, showModal, toast } from "../api.js";

function absSiteUrl(pathOrUrl, siteBase) {
  if (!pathOrUrl) return "";
  if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith("data:")) return pathOrUrl;
  const base = (siteBase || "https://handraw-style.com").replace(/\/+$/, "");
  return `${base}/${String(pathOrUrl).replace(/^\/+/, "")}`;
}

function resolveSlotPrompt(basePrompt, slots, values) {
  let out = String(basePrompt || "");
  if (!Array.isArray(slots) || !slots.length) return out;
  const replacements = [];
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
      replacements.push(`${s.label || key}：${curVal}`);
    }
  }
  if (replacements.length) {
    out = `${out}\n\n【本次同款替换要求】${replacements.join("；")}`;
  }
  return out;
}

export function openShareInspirationModal(item, ctx, onDone) {
  if (!item?.id) return;
  let priceVal = item.publishedPrice >= 1 && item.publishedPrice <= 20 ? item.publishedPrice : 5;

  const titleIn = el("input", { class: "input", value: item.title || "", placeholder: "给这张灵感起个一眼看懂的中文标题" });
  const promptIn = el("textarea", {
    class: "input mono",
    rows: 5,
    placeholder: "可执行的完整提示词（建议先用 AI 一键整理去掉废话）",
  }, item.prompt || item.promptZh || item.rawText || "");
  const notesIn = el("input", {
    class: "input",
    value: item.notes || "",
    placeholder: "可选：使用心得、适配比例或避坑提示（社区用户可见）",
  });
  const tagsIn = el("input", {
    class: "input",
    value: Array.isArray(item.tags) ? item.tags.join("，") : "",
    placeholder: "标签，用逗号分隔，例如：手绘，小红书封面，治愈",
  });

  const priceInput = el("input", {
    class: "input",
    type: "number",
    min: "1",
    max: "20",
    value: String(priceVal),
    style: { width: "84px" },
  });
  const creatorCutHint = el("span", { class: "muted" }, "");
  const presetBtns = [];
  const updateCutHint = (val) => {
    const p = Math.max(1, Math.min(20, Math.round(Number(val ?? priceInput.value) || 5)));
    priceVal = p;
    priceInput.value = String(p);
    const cut = Math.max(1, Math.floor((p * 80) / 100));
    creatorCutHint.textContent = `每被解锁 1 次，你自动获得 +${cut} 积分（80% 创作者分成）`;
    presetBtns.forEach(({ n, btn }) => {
      btn.classList.toggle("pill-accent", n === p);
    });
  };
  priceInput.addEventListener("input", () => updateCutHint(priceInput.value));

  const presetsRow = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
  [2, 5, 8, 10, 15, 20].forEach((n) => {
    const btn = el("button", {
      type: "button",
      class: "pill-btn" + (n === priceVal ? " pill-accent" : ""),
      onClick: () => updateCutHint(n),
    }, n === 5 ? `${n} 积分（推荐）` : `${n} 积分`);
    presetBtns.push({ n, btn });
    presetsRow.appendChild(btn);
  });
  updateCutHint(priceVal);

  const pricingBox = el("div", { class: "card col", style: { gap: "8px", padding: "12px", background: "var(--accent-soft)", borderColor: "color-mix(in srgb, var(--accent) 32%, var(--line))" } },
    el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
      el("strong", null, "🔒 积分解锁定价（必填 1~20 积分 · 不支持免费）"),
      el("span", { class: "badge badge-accent" }, "作者享 80% 分成")
    ),
    presetsRow,
    el("div", { class: "row", style: { gap: "10px", flexWrap: "wrap" } },
      el("span", { style: { fontSize: "12.5px" } }, "自定义积分（1~20）："),
      priceInput,
      creatorCutHint
    ),
    el("span", { class: "muted", style: { fontSize: "11.5px" } }, "效果图免费展示，完整提示词与可替换变量需消耗积分后解锁。积分仅用于解锁收费提示词、付费画风与社区付费贴，不可兑换生图额度。")
  );

  const previewImgSrc = item.imagePath ? localImg(item.imagePath) : (item.imageUrl ? remoteThumb(item.imageUrl, 360) : "");
  const body = el("div", { class: "col", style: { gap: "12px" } },
    previewImgSrc ? el("div", { class: "row", style: { gap: "12px", alignItems: "center" } },
      el("img", { src: previewImgSrc, alt: "", style: { width: "76px", height: "76px", objectFit: "cover", borderRadius: "8px", border: "1px solid var(--line)" } }),
      el("div", { class: "col", style: { gap: "4px", flex: "1" } },
        el("strong", null, item.title || "准备分享灵感"),
        el("span", { class: "muted" }, "不限图片来源（支持自己创作或从 X / 网页收集整理的优质提示词），系统按内容指纹保护首位分享者的解锁收益权。")
      )
    ) : null,
    el("div", { class: "field" }, el("label", null, "灵感标题"), titleIn),
    el("div", { class: "field" }, el("label", null, "完整提示词"), promptIn),
    pricingBox,
    el("div", { class: "row", style: { gap: "10px" } },
      el("div", { class: "field", style: { flex: "1" } }, el("label", null, "标签"), tagsIn),
      el("div", { class: "field", style: { flex: "1" } }, el("label", null, "一句话心得（可选）"), notesIn)
    )
  );

  const submitBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    onClick: async () => {
      const promptTxt = promptIn.value.trim();
      if (!promptTxt) {
        toast("请填写完整提示词后再分享");
        promptIn.focus();
        return;
      }
      const price = Math.max(1, Math.min(20, Math.round(Number(priceInput.value) || 5)));
      const tags = tagsIn.value.split(/[,，、\s]+/).map((s) => s.replace(/^#/, "").trim()).filter(Boolean);
      submitBtn.disabled = true;
      submitBtn.textContent = "正在上架…";
      try {
        const res = await api("POST", `/api/inspirations/${encodeURIComponent(item.id)}/publish`, {
          title: titleIn.value.trim(),
          prompt: promptTxt,
          notes: notesIn.value.trim(),
          tags,
          price,
        });
        ctx.refreshTopbar?.();
        onDone?.(res);

        const shareUrl = res.fullUrl || res.url || "";
        const cut = Math.max(1, Math.floor((price * 80) / 100));
        const receipt = el("div", { class: "col insp-receipt" },
          el("div", { class: "insp-receipt-badge" }, `🔒 已上架积分解锁 · ${price} 积分/次`),
          el("h3", { style: { margin: "4px 0 0" } }, titleIn.value.trim() || item.title),
          el("p", { class: "muted", style: { margin: 0 } },
            `效果图已公开展示，其他用户每消耗 ${price} 积分解锁一次，你将自动获得 +${cut} 积分创作者分成（80%）！`
          ),
          shareUrl ? el("div", { class: "insp-receipt-link mono" }, shareUrl) : null
        );
        showModal("分享战报", receipt, [
          shareUrl ? el("button", {
            type: "button",
            class: "btn",
            onClick: async () => toast((await copyText(shareUrl)) ? "已复制社区分享链接" : "复制失败"),
          }, "📋 复制链接") : null,
          shareUrl ? el("button", {
            type: "button",
            class: "btn",
            onClick: () => openURL(shareUrl),
          }, "↗ 在网站查看") : null,
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => {
              closeModal();
              ctx.go("inspirations", { tab: "plaza" });
            },
          }, "去社区灵感广场看看"),
        ].filter(Boolean));
      } catch (e) {
        submitBtn.disabled = false;
        submitBtn.textContent = "立即上架积分解锁";
        const msg = e?.message || "发布失败";
        if (/登录|login|401/i.test(msg)) {
          toast("请先在「设置 → 账号」登录手绘风账号后再分享赚积分");
        } else {
          toast(msg);
        }
      }
    },
  }, "立即上架积分解锁");

  showModal("分享到社区赚积分", body, [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
    submitBtn,
  ]);
}

export async function openWorkRemixModal(workId, ctx, opts = {}) {
  const loading = el("div", { class: "row", style: { padding: "24px 8px", justifyContent: "center" } },
    el("span", { class: "dot-pulse" }),
    el("span", { class: "muted" }, "正在加载作品配方与提示词…")
  );
  showModal(opts.title || "作品详情与做同款", loading, [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
  ]);

  let detail;
  try {
    detail = await api("GET", `/api/site/works/${encodeURIComponent(workId)}`);
  } catch (e) {
    showModal(opts.title || "作品详情", el("div", { class: "col" },
      el("p", { class: "muted" }, `暂时无法获取作品详情：${e?.message || "网络异常"}`),
      opts.href ? el("button", { type: "button", class: "btn btn-primary", onClick: () => openURL(opts.href) }, "在网站打开 ↗") : null
    ), [el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭")]);
    return;
  }

  const renderWorkDetail = (d) => {
    const w = d.work || d;
    const siteBase = d.siteBase || opts.siteBase || "https://handraw-style.com";
    const imgRaw = w.imageUrl || w.image_url || w.thumbUrl || w.images?.[0]?.url || (typeof w.images?.[0] === "string" ? w.images[0] : "") || opts.image || "";
    const imgUrl = absSiteUrl(imgRaw, siteBase);
    const title = w.title || opts.title || "社区作品";
    const author = w.authorName || w.author || w.username || opts.author || "";
    const price = Math.max(1, Number(w.price ?? w.unlockCost ?? 2));
    const locked = Boolean(w.recipeLocked === true || w.unlocked === false);
    const promptTxt = w.prompt || w.originalRequest || w.original_request || w.subject || w.promptZh || w.prompt_zh || "";
    const stylesArr = Array.isArray(w.styles) ? w.styles : [];
    const styleId = stylesArr[0] || w.styleId || w.style_id || w.style || "";
    const style2Id = stylesArr[1] || w.style2Id || w.style2_id || w.style2 || "";
    const layoutId = w.layoutId || w.layout_id || w.layout || "";
    const colorId = w.color || (Array.isArray(w.colors) ? w.colors[0] : "") || "";
    const toneId = w.tone || (Array.isArray(w.tones) ? w.tones[0] : "") || "";
    const ratio = w.ratio || "3:4";
    const mode = w.mode || "graphic-text";
    const forkCount = Number(w.forkCount ?? w.fork_count ?? w.forks ?? 0);
    const unlockCount = Number(w.unlockCount ?? w.unlock_count ?? 0);
    const recipe = {
      styleIds: [styleId, style2Id].filter(Boolean),
      layoutId,
      colors: colorId ? [colorId] : [],
      tones: toneId ? [toneId] : [],
      ratio,
      mode,
    };
    const webHref = opts.href || `${siteBase.replace(/\/+$/, "")}/t/work-${encodeURIComponent(workId)}`;

    const pills = [
      !locked && styleId ? el("span", { class: "badge badge-accent" }, `画风 ${styleId}`) : null,
      !locked && style2Id ? el("span", { class: "badge badge-accent" }, `融合 ${style2Id}`) : null,
      !locked && layoutId ? el("span", { class: "badge" }, `图型 ${layoutId}`) : null,
      !locked && colorId ? el("span", { class: "badge" }, `色系 ${colorId}`) : null,
      !locked && toneId ? el("span", { class: "badge" }, `影调 ${toneId}`) : null,
      ratio ? el("span", { class: "badge" }, ratio) : null,
      locked
        ? el("span", { class: "badge badge-accent" }, `🔒 ${price} 积分解锁配方`)
        : el("span", { class: "badge badge-ok" }, `🔓 已解锁 (${price} 积分)`),
      unlockCount > 0 ? el("span", { class: "badge" }, `${unlockCount} 人已解锁`) : null,
      forkCount > 0 ? el("span", { class: "badge badge-ok" }, `✨ ${forkCount} 人做过同款`) : null,
    ].filter(Boolean);

    let detailArea;
    if (locked) {
      const unlockHookArea = el("div", { class: "col", style: { gap: "8px" } });
      const cut = Math.max(1, Math.floor((price * 80) / 100));
      const unlockBtn = el("button", {
        type: "button",
        class: "btn btn-primary",
        style: { width: "100%" },
        onClick: async () => {
          unlockBtn.disabled = true;
          unlockBtn.textContent = "正在解锁作品配方…";
          try {
            const uRes = await api("POST", `/api/site/works/${encodeURIComponent(workId)}/unlock`, {});
            ctx.refreshTopbar?.();
            toast(`解锁成功！已消耗 ${price} 积分`);
            const refreshed = uRes.work ? { ...d, work: uRes.work } : await api("GET", `/api/site/works/${encodeURIComponent(workId)}`);
            renderWorkDetail(refreshed);
            opts.onUnlocked?.(refreshed);
          } catch (err) {
            unlockBtn.disabled = false;
            unlockBtn.textContent = `🔓 消耗 ${price} 积分解锁配方与提示词并做同款`;
            const msg = err?.message || "解锁失败";
            clear(unlockHookArea);
            if (/积分不足|insufficient/i.test(msg)) {
              unlockHookArea.appendChild(el("div", { class: "insp-hook-banner col" },
                el("strong", null, "当前积分不足以解锁该作品配方"),
                el("span", { class: "muted" }, "去「作品中心」或「灵感库」分享你的创作与私藏提示词，每次被解锁自动赚取 80% 积分分成！"),
                el("button", {
                  type: "button",
                  class: "btn btn-sm btn-primary",
                  onClick: () => { closeModal(); ctx.go("inspirations", { tab: "vault" }); },
                }, "💡 去灵感库分享赚积分 →")
              ));
            } else if (/登录|login|401/i.test(msg)) {
              unlockHookArea.appendChild(el("div", { class: "insp-hook-banner col" },
                el("strong", null, "请先登录手绘风账号"),
                el("button", {
                  type: "button",
                  class: "btn btn-sm btn-primary",
                  onClick: () => { closeModal(); ctx.go("settings", { anchor: "settings-account" }); },
                }, "去登录账号")
              ));
            } else {
              toast(msg);
            }
          }
        },
      }, `🔓 消耗 ${price} 积分解锁配方与提示词并做同款`);

      detailArea = el("div", { class: "insp-locked-box col" },
        el("div", { class: "row", style: { justifyContent: "space-between" } },
          el("strong", null, "🔒 作品配方（画风/图型/参数）与原始提示词已锁定"),
          el("span", { class: "badge badge-accent" }, `${price} 积分`)
        ),
        el("div", { class: "insp-locked-preview" }, "解锁后可查看完整画风编号、图型、配色影调、原始创作提示词，并一键套用做同款…"),
        unlockBtn,
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, `作者将获得 80% 积分分成（+${cut} 积分）；积分仅用于解锁配方、提示词、付费画风与收费贴，不可兑换生图额度。`),
        unlockHookArea
      );
    } else {
      const saveBtn = el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => {
          saveBtn.disabled = true;
          try {
            await api("POST", "/api/inspirations", {
              title,
              imageUrl: imgUrl,
              prompt: promptTxt || title,
              source: "community",
              sourceUrl: webHref,
              sourceAuthor: author,
              workId,
              recipe,
              suggestedStyle: styleId,
              syncCollection: true,
            });
            saveBtn.textContent = "★ 已收进灵感库";
            toast("已收藏进本地灵感库");
          } catch (e) {
            saveBtn.disabled = false;
            toast(e?.message || "收藏失败");
          }
        },
      }, "★ 收进灵感库");

      detailArea = el("div", { class: "col", style: { gap: "10px" } },
        promptTxt
          ? el("div", { class: "insp-prompt-box" },
              el("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "6px" } },
                el("strong", { style: { fontSize: "12.5px" } }, "🔓 作品原始提示词与配方"),
                el("button", {
                  type: "button",
                  class: "btn btn-sm",
                  onClick: async () => toast((await copyText(promptTxt)) ? "提示词已复制" : "复制失败"),
                }, "📋 复制提示词")
              ),
              el("div", { class: "insp-prompt-text" }, promptTxt)
            )
          : el("p", { class: "muted" }, "该作品未附带公开原文，但你可以直接套用它的画风与图型配方做同款。"),
        el("div", { class: "insp-remix-actions col" },
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => {
              closeModal();
              ctx.go("create", {
                forkOf: workId,
                forkTitle: title,
                recipe,
                theme: promptTxt ? "" : title,
              });
            },
          }, "✨ 套用配方换主题做同款"),
          promptTxt ? el("button", {
            type: "button",
            class: "btn",
            onClick: () => {
              closeModal();
              ctx.go("create", {
                forkOf: workId,
                forkTitle: title,
                recipe,
                theme: promptTxt,
              });
            },
          }, "📝 拿完整提示词微调做同款") : null,
          el("button", {
            type: "button",
            class: "btn",
            onClick: () => {
              closeModal();
              ctx.go("chat", {
                prompt: `帮我参考作品《${title}》${styleId ? `（画风 ${styleId}）` : ""}做一张同款：${promptTxt ? `\n原提示词：${promptTxt}` : ""}\n我想把主题改成：`,
              });
            },
          }, "💬 带入会话让 AI 改写同款"),
          el("div", { class: "row", style: { justifyContent: "space-between", marginTop: "4px" } },
            saveBtn,
            el("span", { class: "muted", style: { fontSize: "11.5px" } }, "做同款将为原作者带来 +2 积分激励")
          )
        )
      );
    }

    const body = el("div", { class: "insp-modal-layout" },
      el("div", { class: "insp-modal-media" },
        imgUrl ? el("img", { src: remoteThumb(imgUrl, 760), alt: title, class: "insp-modal-img" }) : el("div", { class: "muted" }, "暂无预览图")
      ),
      el("div", { class: "insp-modal-info col" },
        el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start" } },
          el("div", { class: "col", style: { gap: "2px" } },
            el("h3", { style: { margin: 0, fontSize: "17px" } }, title),
            author ? el("span", { class: "muted" }, `作者：${author}`) : null
          ),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openURL(webHref) }, "网页 ↗")
        ),
        pills.length ? el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } }, ...pills) : null,
        w.notes ? el("p", { class: "muted", style: { margin: "2px 0 0" } }, `作者说明：${w.notes}`) : null,
        detailArea
      )
    );

    showModal("作品详情与做同款", body, [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    ]);
  };

  renderWorkDetail(detail);
}

export async function openInspirationRemixModal(inspId, ctx, opts = {}) {
  const loading = el("div", { class: "row", style: { padding: "24px 8px", justifyContent: "center" } },
    el("span", { class: "dot-pulse" }),
    el("span", { class: "muted" }, "正在加载社区灵感卡…")
  );
  showModal(opts.title || "社区灵感详情", loading, [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
  ]);

  let detail;
  try {
    detail = await api("GET", `/api/site/inspirations/${encodeURIComponent(inspId)}`);
  } catch (e) {
    showModal(opts.title || "社区灵感详情", el("p", { class: "muted" }, `加载失败：${e?.message || "网络异常"}`), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    ]);
    return;
  }

  const renderDetail = (d) => {
    const item = d.inspiration || d.item || d;
    const siteBase = d.siteBase || opts.siteBase || "https://handraw-style.com";
    const imgUrl = absSiteUrl(item.imageUrl || item.image_url || "", siteBase);
    const title = item.title || "社区灵感";
    const author = item.authorName || item.author || item.sourceAuthor || "匿名创作者";
    const price = Number(item.price || 0);
    const locked = Boolean(item.promptLocked);
    const promptTxt = item.prompt || "";
    const promptZh = item.promptZh || "";
    const slots = Array.isArray(item.slots) ? item.slots : [];
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const suggestedStyle = item.suggestedStyle || item.recipe?.styleIds?.[0] || "";

    let showZh = false;
    const slotValues = {};
    slots.forEach((s) => {
      if (s?.key) slotValues[s.key] = s.defaultValue || "";
    });

    const promptDisplay = el("div", { class: "insp-prompt-text" }, "");
    const updatePromptDisplay = () => {
      const base = (showZh && promptZh) ? promptZh : (promptTxt || promptZh);
      promptDisplay.textContent = resolveSlotPrompt(base, slots, slotValues);
    };

    const unlockHookArea = el("div", { class: "col", style: { gap: "8px" } });

    let promptSection;
    if (locked) {
      const unlockBtn = el("button", {
        type: "button",
        class: "btn btn-primary",
        style: { width: "100%" },
        onClick: async () => {
          unlockBtn.disabled = true;
          unlockBtn.textContent = "正在解锁…";
          try {
            const uRes = await api("POST", `/api/site/inspirations/${encodeURIComponent(inspId)}/unlock`, {});
            ctx.refreshTopbar?.();
            toast(`已消耗 ${price} 积分解锁完整提示词！`);
            const refreshed = uRes.inspiration ? { ...d, inspiration: uRes.inspiration } : await api("GET", `/api/site/inspirations/${encodeURIComponent(inspId)}`);
            renderDetail(refreshed);
            opts.onUnlocked?.(refreshed);
          } catch (err) {
            unlockBtn.disabled = false;
            unlockBtn.textContent = `🔓 消耗 ${price} 积分解锁完整提示词并做同款`;
            const msg = err?.message || "解锁失败";
            clear(unlockHookArea);
            if (/积分不足|insufficient/i.test(msg)) {
              unlockHookArea.appendChild(el("div", { class: "insp-hook-banner col" },
                el("strong", null, "当前积分不足以解锁该提示词"),
                el("span", { class: "muted" }, "去「灵感库」分享你的私藏好图与提示词（设置 1~20 积分解锁），每次被解锁自动赚取 80% 积分分成！"),
                el("button", {
                  type: "button",
                  class: "btn btn-sm btn-primary",
                  onClick: () => {
                    closeModal();
                    ctx.go("inspirations", { tab: "vault" });
                  },
                }, "💡 去灵感库分享 1 张图赚积分 →")
              ));
            } else if (/登录|login|401/i.test(msg)) {
              unlockHookArea.appendChild(el("div", { class: "insp-hook-banner col" },
                el("strong", null, "请先登录手绘风账号"),
                el("button", {
                  type: "button",
                  class: "btn btn-sm btn-primary",
                  onClick: () => {
                    closeModal();
                    ctx.go("settings", { anchor: "settings-account" });
                  },
                }, "去登录账号")
              ));
            } else {
              toast(msg);
            }
          }
        },
      }, `🔓 消耗 ${price} 积分解锁完整提示词并做同款`);

      promptSection = el("div", { class: "insp-locked-box col" },
        el("div", { class: "row", style: { justifyContent: "space-between" } },
          el("strong", null, "🔒 完整提示词与可替换模板已锁定"),
          el("span", { class: "badge badge-accent" }, `${price} 积分`)
        ),
        el("div", { class: "insp-locked-preview" }, item.promptPreview || "解锁后可查看完整双语提示词、替换变量槽位并一键做同款…"),
        unlockBtn,
        el("span", { class: "muted", style: { fontSize: "11.5px" } }, "注：积分仅用于解锁社区提示词、付费画风与收费贴，不可兑换生图额度；作者将获得 80% 积分分成。"),
        unlockHookArea
      );
    } else {
      updatePromptDisplay();
      const langToggle = promptZh && promptTxt && promptZh !== promptTxt
        ? el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => {
              showZh = !showZh;
              langToggle.textContent = showZh ? "切换原版" : "看中文理解版";
              updatePromptDisplay();
            },
          }, "看中文理解版")
        : null;

      const slotsBox = slots.length
        ? el("div", { class: "insp-slots-box col" },
            el("span", { class: "muted", style: { fontSize: "12px" } }, "✨ 快速换词做同款（改完即生效）："),
            el("div", { class: "insp-slots-grid" },
              ...slots.map((s) => {
                const inp = el("input", {
                  class: "input",
                  value: slotValues[s.key] || "",
                  placeholder: s.defaultValue || s.label,
                });
                inp.addEventListener("input", () => {
                  slotValues[s.key] = inp.value;
                  updatePromptDisplay();
                });
                return el("label", { class: "insp-slot-field" },
                  el("span", { class: "muted" }, s.label || s.key),
                  inp
                );
              })
            )
          )
        : null;

      const saveBtn = el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: async () => {
          saveBtn.disabled = true;
          try {
            await api("POST", "/api/inspirations", {
              title,
              imageUrl: imgUrl,
              prompt: promptTxt || promptZh,
              promptZh,
              slots,
              tags,
              notes: item.notes || "",
              source: "community",
              sourceAuthor: author,
              recipe: item.recipe || {},
              suggestedStyle,
            });
            saveBtn.textContent = "★ 已收进灵感库";
            toast("已保存到本地灵感库");
          } catch (e) {
            saveBtn.disabled = false;
            toast(e?.message || "保存失败");
          }
        },
      }, "★ 收进我的灵感库");

      promptSection = el("div", { class: "col", style: { gap: "10px" } },
        el("div", { class: "insp-prompt-box" },
          el("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "6px" } },
            el("strong", { style: { fontSize: "12.5px" } }, price > 0 ? "🔓 已解锁完整提示词" : "完整提示词"),
            el("div", { class: "row", style: { gap: "6px" } },
              langToggle,
              el("button", {
                type: "button",
                class: "btn btn-sm",
                onClick: async () => toast((await copyText(promptDisplay.textContent)) ? "提示词已复制" : "复制失败"),
              }, "📋 复制")
            )
          ),
          promptDisplay
        ),
        slotsBox,
        el("div", { class: "insp-remix-actions col" },
          el("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => {
              const finalPrompt = promptDisplay.textContent;
              closeModal();
              ctx.go("create", {
                forkOf: item.workId || "",
                forkTitle: title,
                style: suggestedStyle || "",
                recipe: item.recipe || (suggestedStyle ? { styleIds: [suggestedStyle] } : {}),
                theme: finalPrompt,
              });
            },
          }, "✨ 一键带入生图工作台做同款"),
          el("div", { class: "row", style: { gap: "8px" } },
            el("button", {
              type: "button",
              class: "btn",
              style: { flex: "1" },
              onClick: () => {
                const finalPrompt = promptDisplay.textContent;
                closeModal();
                ctx.go("chat", { prompt: `帮我按这个灵感提示词生成同款，并微调成更适合中文读者的画面：\n${finalPrompt}` });
              },
            }, "💬 带入会话改写"),
            saveBtn
          )
        )
      );
    }

    // Comments block (commenting auto-syncs the inspiration into forum 'prompts' board #83 / web#502)
    const commentCountSpan = el("span", { class: "muted", style: { fontSize: "12px" } }, "");
    const forumLinkWrap = el("span", null);
    const commentListEl = el("div", { class: "insp-comment-list" }, el("span", { class: "muted", style: { fontSize: "12px" } }, "正在加载评论…"));
    const commentIn = el("textarea", {
      class: "input",
      rows: 2,
      maxlength: 3000,
      placeholder: "写下心得或提问（评论后该灵感将自动进入论坛「贴图与提示词」板块）",
      style: { flex: "1" },
    });
    const renderForumLink = (tid) => {
      clear(forumLinkWrap);
      if (tid) {
        const fUrl = `${siteBase.replace(/\/+$/, "")}/forum/?view=topic&id=${encodeURIComponent(tid)}`;
        forumLinkWrap.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => openURL(fUrl),
        }, "前往论坛「贴图与提示词」讨论 ↗"));
      } else {
        forumLinkWrap.appendChild(el("span", { class: "muted", style: { fontSize: "11.5px" } }, "评论后自动进入论坛「贴图与提示词」板块"));
      }
    };
    renderForumLink(item.topicId || "");

    const drawComments = (items, total, tid) => {
      commentCountSpan.textContent = total > 0 ? `(${total})` : "";
      if (tid) renderForumLink(tid);
      clear(commentListEl);
      if (!items || !items.length) {
        commentListEl.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } }, "暂无评论，抢沙发评论即可同步至论坛「贴图与提示词」板块～"));
        return;
      }
      items.forEach((c) => {
        commentListEl.appendChild(el("div", { class: "insp-comment-item" },
          el("div", { class: "row", style: { justifyContent: "space-between", fontSize: "11.5px", marginBottom: "3px" } },
            el("strong", null, c.name || c.user || "创作者"),
            el("span", { class: "muted" }, c.time || "刚刚")
          ),
          el("div", { style: { whiteSpace: "pre-wrap", wordBreak: "break-word" } }, c.text || "")
        ));
      });
    };

    const loadComments = async () => {
      try {
        const cRes = await api("GET", `/api/site/inspirations/${encodeURIComponent(inspId)}/comments?limit=30`);
        drawComments(cRes.items || [], Number(cRes.total || 0), cRes.topicId || item.topicId || "");
      } catch {
        clear(commentListEl);
        commentListEl.appendChild(el("span", { class: "muted", style: { fontSize: "12px" } }, "暂无法加载评论"));
      }
    };
    loadComments();

    const commentSubmitBtn = el("button", {
      type: "button",
      class: "btn btn-sm btn-primary",
      onClick: async () => {
        const txt = commentIn.value.trim();
        if (!txt) return toast("请输入评论内容");
        commentSubmitBtn.disabled = true;
        commentSubmitBtn.textContent = "发送中…";
        try {
          const postRes = await api("POST", `/api/site/inspirations/${encodeURIComponent(inspId)}/comments`, { text: txt });
          commentIn.value = "";
          if (postRes.topicId) item.topicId = postRes.topicId;
          toast("评论已发布，该灵感已自动同步进入论坛「贴图与提示词」板块");
          await loadComments();
        } catch (err) {
          const msg = err?.message || "发送失败";
          if (/登录|login|401/i.test(msg)) toast("请先在「设置 → 账号」登录手绘风账号后再评论");
          else toast(msg);
        } finally {
          commentSubmitBtn.disabled = false;
          commentSubmitBtn.textContent = "发表评论";
        }
      },
    }, "发表评论");

    const commentsSection = el("div", { class: "insp-comments-box" },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
        el("div", { class: "row", style: { gap: "6px" } }, el("strong", { style: { fontSize: "13px" } }, "💬 讨论与评论"), commentCountSpan),
        forumLinkWrap
      ),
      commentListEl,
      el("div", { class: "row", style: { gap: "8px", alignItems: "flex-end" } }, commentIn, commentSubmitBtn)
    );

    const body = el("div", { class: "col", style: { gap: "10px" } },
      el("div", { class: "insp-modal-layout" },
        el("div", { class: "insp-modal-media" },
          imgUrl ? el("img", { src: remoteThumb(imgUrl, 760), alt: title, class: "insp-modal-img" }) : el("div", { class: "muted" }, "暂无预览图")
        ),
        el("div", { class: "insp-modal-info col" },
          el("div", { class: "col", style: { gap: "4px" } },
            el("h3", { style: { margin: 0, fontSize: "17px" } }, title),
            el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
              el("span", { class: "muted" }, `分享者：${author}`),
              item.sourceChannel === "x" ? el("span", { class: "badge" }, "来自 X") : null,
              suggestedStyle ? el("span", { class: "badge badge-accent" }, `推荐画风 ${suggestedStyle}`) : null,
              price > 0
                ? el("span", { class: "badge badge-accent" }, `${price} 积分解锁 · ${item.unlockCount || 0} 人已解锁`)
                : el("span", { class: "badge badge-ok" }, `免费 · ${item.forkCount || 0} 人做同款`)
            ),
            tags.length ? el("div", { class: "row", style: { gap: "5px", flexWrap: "wrap", marginTop: "2px" } },
              ...tags.map((t) => el("span", { class: "badge" }, `#${t}`))
            ) : null,
            item.notes ? el("p", { class: "muted", style: { margin: "4px 0 0" } }, `作者心得：${item.notes}`) : null
          ),
          promptSection
        )
      ),
      commentsSection
    );

    showModal("社区灵感与做同款", body, [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    ]);
  };

  renderDetail(detail);
}
