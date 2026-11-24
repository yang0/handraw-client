import { api, clear, closeModal, copyText, el, localImg, openURL, remoteThumb, showModal, toast, toWebp } from "../api.js";

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
  const sourceUrlIn = el("input", {
    class: "input",
    type: "url",
    value: item.sourceUrl || "",
    placeholder: "来源链接（选填，解锁后可见）",
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
    ),
    el("div", { class: "field" }, el("label", null, "来源链接（选填，解锁后展示给已解锁用户）"), sourceUrlIn)
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
      const rawSource = sourceUrlIn.value.trim();
      const sourceUrl = /^https?:\/\//i.test(rawSource) ? rawSource : "";
      if (rawSource && !sourceUrl) {
        toast("来源链接须以 http:// 或 https:// 开头");
        sourceUrlIn.focus();
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = "正在压缩 WebP 并上架…";
      try {
        let encoded = "";
        if (item.imagePath) {
          encoded = await toWebp(localImg(item.imagePath), { maxEdge: 1024, quality: 0.85 });
        }
        const res = await api("POST", `/api/inspirations/${encodeURIComponent(item.id)}/publish`, {
          title: titleIn.value.trim(),
          prompt: promptTxt,
          notes: notesIn.value.trim(),
          tags,
          sourceUrl,
          price,
          encoded,
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

function parseTagList(raw) {
  return String(raw || "")
    .split(/[,，、\s]+/)
    .map((s) => s.replace(/^#/, "").trim())
    .filter(Boolean);
}

function mergeTags(baseTags, extraTags) {
  const out = [];
  const seen = new Set();
  for (const t of [...(Array.isArray(baseTags) ? baseTags : []), ...(extraTags || [])]) {
    const clean = String(t || "").replace(/^#/, "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export function openBatchShareInspirationsModal(items, ctx, opts = {}) {
  const initialList = Array.isArray(items) ? items.filter((it) => it && it.id) : [];
  if (!initialList.length) {
    toast("请先选择至少一张要分享的灵感图片");
    return;
  }

  let queue = initialList.map((item) => ({
    item,
    status: "idle", // idle | queued | running | done | error | cancelled
    error: "",
    url: item.publishedUrl || "",
  }));

  let priceVal = 5;
  let running = false;
  let stopRequested = false;
  let authFailed = false;
  let hasRun = false;
  let closeNotified = false;

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
    creatorCutHint.textContent = `每张每被解锁 1 次，你自动获得 +${cut} 积分（80% 分成）`;
    presetBtns.forEach(({ n, btn }) => btn.classList.toggle("pill-accent", n === p));
  };
  priceInput.addEventListener("input", () => updateCutHint(priceInput.value));

  const presetsRow = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });
  [2, 5, 8, 10, 15, 20].forEach((n) => {
    const btn = el("button", {
      type: "button",
      class: "pill-btn" + (n === priceVal ? " pill-accent" : ""),
      onClick: () => {
        if (running) return;
        updateCutHint(n);
      },
    }, n === 5 ? `${n} 积分（推荐）` : `${n} 积分`);
    presetBtns.push({ n, btn });
    presetsRow.appendChild(btn);
  });
  updateCutHint(priceVal);

  const extraTagsIn = el("input", {
    class: "input",
    placeholder: "可选：用逗号分隔，会追加到每条原有标签中",
  });
  const fallbackNotesIn = el("input", {
    class: "input",
    placeholder: "可选：仅填充给未填写心得的条目",
  });

  const pricingBox = el("div", {
    class: "card col",
    style: {
      gap: "8px",
      padding: "12px",
      background: "var(--accent-soft)",
      borderColor: "color-mix(in srgb, var(--accent) 32%, var(--line))",
    },
  },
    el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "6px" } },
      el("strong", null, "🔒 统一积分解锁定价（必填 1~20 积分 · 不支持免费）"),
      el("span", { class: "badge badge-accent" }, "作者享 80% 分成")
    ),
    presetsRow,
    el("div", { class: "row", style: { gap: "10px", flexWrap: "wrap" } },
      el("span", { style: { fontSize: "12.5px" } }, "自定义积分（1~20）："),
      priceInput,
      creatorCutHint
    ),
    el("span", { class: "muted", style: { fontSize: "11.5px" } }, "批量上架保留每张图各自的标题、提示词与标签，效果图公开展示，完整提示词按上述统一定价解锁。")
  );

  const metaFieldsRow = el("div", { class: "row insp-batch-meta-row", style: { gap: "10px", flexWrap: "wrap" } },
    el("div", { class: "field", style: { flex: "1 1 220px" } }, el("label", null, "统一追加标签（可选）"), extraTagsIn),
    el("div", { class: "field", style: { flex: "1 1 220px" } }, el("label", null, "默认补充心得（可选）"), fallbackNotesIn)
  );

  const progressWrap = el("div", { class: "insp-batch-progress hidden" });
  const progressLabel = el("div", { class: "row", style: { justifyContent: "space-between", fontSize: "12.5px" } });
  const progressTitle = el("strong", null, "");
  const progressPct = el("span", { class: "muted mono" }, "");
  progressLabel.appendChild(progressTitle);
  progressLabel.appendChild(progressPct);
  const progressFill = el("div", { class: "insp-batch-progress-fill", style: { width: "0%" } });
  progressWrap.appendChild(progressLabel);
  progressWrap.appendChild(el("div", { class: "insp-batch-progress-track" }, progressFill));

  const summaryWrap = el("div", { class: "insp-batch-summary hidden" });
  const queueHeader = el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } });
  const queueListEl = el("div", { class: "insp-batch-list col" });
  const footerBox = el("div", { class: "row insp-batch-footer", style: { width: "100%", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" } });

  const setControlsDisabled = (disabled) => {
    priceInput.disabled = disabled;
    extraTagsIn.disabled = disabled;
    fallbackNotesIn.disabled = disabled;
    presetBtns.forEach(({ btn }) => { btn.disabled = disabled; });
  };

  const getStats = () => {
    let done = 0;
    let error = 0;
    let cancelled = 0;
    let pending = 0;
    for (const q of queue) {
      if (q.status === "done") done++;
      else if (q.status === "error") error++;
      else if (q.status === "cancelled") cancelled++;
      else pending++;
    }
    return { done, error, cancelled, pending, total: queue.length };
  };

  const notifyCloseOnce = () => {
    if (closeNotified) return;
    closeNotified = true;
    stopRequested = true;
    const succeededIds = queue.filter((q) => q.status === "done").map((q) => q.item.id);
    const failedIds = queue.filter((q) => q.status === "error" || q.status === "cancelled").map((q) => q.item.id);
    opts.onClose?.({
      succeededIds,
      failedIds,
      anySucceeded: succeededIds.length > 0,
      wasRunning: running,
    });
  };

  const renderQueue = () => {
    clear(queueHeader);
    const alreadyPubCount = queue.filter((q) => q.item.publishedId && q.status === "idle").length;
    const stats = getStats();
    const headerTitle = hasRun
      ? `分享清单 · 共 ${stats.total} 项（成功 ${stats.done}${stats.error ? ` · 失败 ${stats.error}` : ""}${stats.cancelled ? ` · 取消 ${stats.cancelled}` : ""}）`
      : `待分享清单 · 共 ${stats.total} 项`;
    queueHeader.appendChild(el("strong", { style: { fontSize: "13px" } }, headerTitle));
    if (!running && !hasRun && alreadyPubCount > 0) {
      queueHeader.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: () => {
          queue = queue.filter((q) => !q.item.publishedId);
          renderQueue();
          renderFooter();
        },
      }, `移除已分享项 (${alreadyPubCount})`));
    }

    clear(queueListEl);
    if (!queue.length) {
      queueListEl.appendChild(el("div", { class: "muted", style: { padding: "18px 8px", textAlign: "center" } }, "清单已清空，请关闭窗口重新选择要分享的灵感图片。"));
      return;
    }

    queue.forEach((entry) => {
      const it = entry.item;
      const thumbSrc = it.imagePath ? localImg(it.imagePath) : (it.imageUrl ? remoteThumb(it.imageUrl, 160) : "");
      const excerpt = (it.promptZh || it.prompt || it.rawText || "").replace(/\s+/g, " ").trim().slice(0, 72);

      let statusNode = null;
      if (entry.status === "idle") {
        statusNode = el("span", { class: "badge" }, it.publishedId ? "已分享 · 将更新" : "待分享");
      } else if (entry.status === "queued") {
        statusNode = el("span", { class: "badge" }, "等待中");
      } else if (entry.status === "running") {
        statusNode = el("span", { class: "badge badge-accent insp-batch-status-running" },
          el("span", { class: "dot-pulse" }),
          "上传中…"
        );
      } else if (entry.status === "done") {
        statusNode = el("span", { class: "badge badge-ok" }, "✓ 已分享");
      } else if (entry.status === "error") {
        statusNode = el("span", { class: "badge insp-badge-err" }, "✕ 失败");
      } else if (entry.status === "cancelled") {
        statusNode = el("span", { class: "badge" }, "已取消");
      }

      const rowActions = el("div", { class: "row", style: { gap: "6px", flexShrink: "0", alignItems: "center" } },
        statusNode,
        entry.status === "done" && entry.url
          ? el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => openURL(entry.url),
            }, "查看 ↗")
          : null,
        !running && entry.status === "idle"
          ? el("button", {
              type: "button",
              class: "btn btn-sm insp-batch-remove-btn",
              title: "从本次批量分享中移除",
              "aria-label": `移除 ${it.title || "该条目"}`,
              onClick: () => {
                queue = queue.filter((q) => q.item.id !== it.id);
                renderQueue();
                renderFooter();
              },
            }, "✕")
          : null
      );

      const rowEl = el("div", {
        class: "insp-batch-row" + (entry.status === "running" ? " is-running" : "") + (entry.status === "done" ? " is-done" : "") + (entry.status === "error" ? " is-error" : ""),
        dataset: { id: it.id, status: entry.status },
      },
        thumbSrc
          ? el("img", { class: "insp-batch-thumb", src: thumbSrc, alt: it.title || "" })
          : el("div", { class: "insp-batch-thumb insp-batch-thumb-empty" }, "文"),
        el("div", { class: "col insp-batch-row-info" },
          el("div", { class: "insp-batch-row-title", title: it.title || "未命名灵感" }, it.title || "未命名灵感"),
          entry.error
            ? el("div", { class: "insp-batch-row-err" }, entry.error)
            : el("div", { class: "muted insp-batch-row-sub" }, excerpt || "无提示词预览")
        ),
        rowActions
      );
      entry._node = rowEl;
      queueListEl.appendChild(rowEl);
    });
  };

  const renderSummary = () => {
    clear(summaryWrap);
    if (!hasRun || running) {
      summaryWrap.classList.add("hidden");
      return;
    }
    const stats = getStats();
    const cut = Math.max(1, Math.floor((priceVal * 80) / 100));
    summaryWrap.classList.remove("hidden");
    summaryWrap.classList.toggle("is-ok", stats.error === 0 && stats.cancelled === 0 && stats.done > 0);
    summaryWrap.classList.toggle("is-warn", stats.error > 0 || stats.cancelled > 0);

    if (authFailed) {
      summaryWrap.appendChild(el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
        el("div", { class: "col", style: { gap: "2px" } },
          el("strong", null, "请先登录手绘风账号后再批量分享"),
          el("span", { class: "muted", style: { fontSize: "12px" } }, "已暂停剩余分享队列，登录后回到灵感库即可继续上架赚积分。")
        ),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => {
            closeModal();
            ctx.go("settings", { anchor: "settings-account" });
          },
        }, "前往登录账号")
      ));
      return;
    }

    if (stats.error === 0 && stats.cancelled === 0 && stats.done > 0) {
      summaryWrap.appendChild(el("div", { class: "col", style: { gap: "3px" } },
        el("strong", null, `🎉 批量分享完成！已成功上架 ${stats.done} 张灵感（${priceVal} 积分解锁）`),
        el("span", { class: "muted", style: { fontSize: "12px" } }, `每张灵感每被解锁 1 次，你将自动获得 +${cut} 积分创作者分成（80%）。`)
      ));
      return;
    }

    const parts = [`成功 ${stats.done} 项`];
    if (stats.error > 0) parts.push(`失败 ${stats.error} 项`);
    if (stats.cancelled > 0) parts.push(`已取消 ${stats.cancelled} 项`);
    summaryWrap.appendChild(el("div", { class: "col", style: { gap: "3px" } },
      el("strong", null, `批量分享结束：${parts.join(" · ")}`),
      el("span", { class: "muted", style: { fontSize: "12px" } }, "已成功的灵感已经上架到社区；你可以点击下方「重试未完成项」继续处理未完成条目。")
    ));
  };

  const runBatch = async (onlyRetry = false) => {
    const targets = onlyRetry
      ? queue.filter((q) => q.status === "error" || q.status === "cancelled")
      : queue.filter((q) => q.status !== "done");
    if (!targets.length) return;

    const price = Math.max(1, Math.min(20, Math.round(Number(priceInput.value) || 5)));
    updateCutHint(price);
    const extraTags = parseTagList(extraTagsIn.value);
    const fallbackNote = fallbackNotesIn.value.trim();

    running = true;
    stopRequested = false;
    authFailed = false;
    hasRun = true;
    setControlsDisabled(true);
    opts.onStart?.();

    targets.forEach((q) => {
      q.status = "queued";
      q.error = "";
    });
    summaryWrap.classList.add("hidden");
    progressWrap.classList.remove("hidden");

    const updateProgress = (completedInRun) => {
      const pct = Math.round((completedInRun / targets.length) * 100);
      progressTitle.textContent = stopRequested
        ? `正在停止剩余任务… (${completedInRun} / ${targets.length})`
        : `正在批量分享到社区… (${completedInRun} / ${targets.length})`;
      progressPct.textContent = `${pct}%`;
      progressFill.style.width = `${pct}%`;
    };

    updateProgress(0);
    renderQueue();
    renderFooter();

    let processed = 0;
    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    for (let i = 0; i < targets.length; i++) {
      const entry = targets[i];
      if (stopRequested) {
        entry.status = "cancelled";
        entry.error = "已手动停止";
        continue;
      }

      entry.status = "running";
      entry.error = "";
      renderQueue();
      if (entry._node?.scrollIntoView) {
        try {
          entry._node.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
        } catch {}
      }

      const it = entry.item;
      const promptTxt = String(it.prompt || it.promptZh || it.rawText || "").trim();
      const titleTxt = String(it.title || "").trim() || promptTxt.replace(/\s+/g, " ").slice(0, 24) || "未命名灵感";
      const mergedTags = mergeTags(it.tags, extraTags);
      const notesTxt = String(it.notes || "").trim() || fallbackNote;

      try {
        const res = await api("POST", `/api/inspirations/${encodeURIComponent(it.id)}/publish`, {
          title: titleTxt,
          prompt: promptTxt,
          notes: notesTxt,
          tags: mergedTags,
          price,
        });
        entry.status = "done";
        entry.url = res.fullUrl || res.url || "";
        if (res.item) {
          entry.item = res.item;
        }
      } catch (err) {
        const msg = err?.message || "发布失败";
        entry.status = "error";
        entry.error = msg;
        if (/登录|login|401/i.test(msg)) {
          authFailed = true;
          for (let j = i + 1; j < targets.length; j++) {
            targets[j].status = "cancelled";
            targets[j].error = "需先登录手绘风账号";
          }
          processed = targets.length;
          updateProgress(processed);
          break;
        }
      }

      processed++;
      updateProgress(processed);
      renderQueue();
    }

    running = false;
    setControlsDisabled(false);
    progressWrap.classList.add("hidden");
    renderQueue();
    renderSummary();
    renderFooter();

    const succeededIds = queue.filter((q) => q.status === "done").map((q) => q.item.id);
    const failedIds = queue.filter((q) => q.status === "error" || q.status === "cancelled").map((q) => q.item.id);
    if (succeededIds.length > 0) {
      ctx.refreshTopbar?.();
    }
    opts.onFinished?.({ succeededIds, failedIds, total: queue.length });
  };

  const renderFooter = () => {
    clear(footerBox);
    if (running) {
      footerBox.appendChild(el("button", {
        type: "button",
        class: "btn btn-danger",
        onClick: () => {
          stopRequested = true;
          toast("将在当前这张完成后停止剩余分享");
        },
      }, "停止剩余任务"));
      return;
    }

    const stats = getStats();
    if (!hasRun) {
      footerBox.appendChild(el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"));
      footerBox.appendChild(el("button", {
        type: "button",
        class: "btn btn-primary",
        disabled: queue.length === 0,
        onClick: () => runBatch(false),
      }, `立即批量上架 (${queue.length} 项)`));
      return;
    }

    const retryCount = stats.error + stats.cancelled;
    if (retryCount > 0 && !authFailed) {
      footerBox.appendChild(el("button", {
        type: "button",
        class: "btn btn-primary",
        onClick: () => runBatch(true),
      }, `🔄 重试未完成项 (${retryCount})`));
    }
    if (stats.done > 0) {
      footerBox.appendChild(el("button", {
        type: "button",
        class: retryCount > 0 ? "btn" : "btn btn-primary",
        onClick: () => {
          closeModal();
          ctx.go("inspirations", { tab: "plaza" });
        },
      }, "去社区灵感广场看看"));
    }
    footerBox.appendChild(el("button", {
      type: "button",
      class: "btn",
      onClick: closeModal,
    }, "完成并关闭"));
  };

  renderQueue();
  renderFooter();

  const body = el("div", { class: "col insp-batch-modal-body", style: { gap: "12px" } },
    pricingBox,
    metaFieldsRow,
    progressWrap,
    summaryWrap,
    queueHeader,
    queueListEl
  );

  showModal(`批量分享到社区 (${initialList.length} 项)`, body, [footerBox], {
    className: "modal-batch-share",
    onClose: notifyCloseOnce,
  });
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
                directPrompt: false,
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
                directPrompt: false,
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
          }, "💬 带入聊天让 AI 改写同款"),
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
    ], { className: "modal-remix" });
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
              const hasSkill = Boolean(suggestedStyle || item.recipe?.styleIds?.length || item.recipe?.layoutId);
              closeModal();
              ctx.go("create", {
                directPrompt: !hasSkill,
                forkOf: hasSkill ? (item.workId || "") : "",
                forkTitle: title,
                style: hasSkill ? (suggestedStyle || "") : "",
                recipe: hasSkill ? (item.recipe || (suggestedStyle ? { styleIds: [suggestedStyle] } : {})) : undefined,
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
                const hasSkill = Boolean(suggestedStyle || item.recipe?.styleIds?.length || item.recipe?.layoutId);
                closeModal();
                ctx.go("chat", {
                  directPrompt: !hasSkill,
                  prompt: hasSkill
                    ? `帮我按这个灵感提示词生成同款，并微调成更适合中文读者的画面：\n${finalPrompt}`
                    : finalPrompt,
                });
              },
            }, "💬 带入聊天改写"),
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
            item.notes ? el("p", { class: "muted", style: { margin: "4px 0 0" } }, `作者心得：${item.notes}`) : null,
            (!locked && /^https?:\/\//i.test(String(item.sourceUrl || "").trim()))
              ? el("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "4px" } },
                el("span", { class: "muted", style: { fontSize: "12px" } }, "🔗 来源："),
                el("a", {
                  href: String(item.sourceUrl).trim(),
                  target: "_blank",
                  rel: "noopener noreferrer nofollow",
                  referrerpolicy: "no-referrer",
                  style: { fontSize: "12px", color: "var(--accent)", wordBreak: "break-all" },
                  onClick: (e) => { e.preventDefault(); openURL(String(item.sourceUrl).trim()); },
                }, String(item.sourceUrl).trim())
              )
              : null
          ),
          promptSection
        )
      ),
      commentsSection
    );

    showModal("社区灵感与做同款", body, [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    ], { className: "modal-remix" });
  };

  renderDetail(detail);
}
