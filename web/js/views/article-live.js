import { clear, el, toast } from "../api.js";
import { openArticleContextMenu } from "./article-links.js";

// Lossless Markdown block parser preserving exact line numbers and raw text (#121).
export function parseMarkdownBlocks(rawText) {
  const lines = String(rawText || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  // 1. Optional YAML frontmatter at line 0
  if (lines.length >= 3 && lines[0].trim() === "---") {
    let end = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === "---") { end = j; break; }
    }
    if (end > 0) {
      blocks.push({ type: "frontmatter", startLine: 0, endLine: end, raw: lines.slice(0, end + 1).join("\n") });
      i = end + 1;
    }
  }

  const isTableSep = (ln) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(ln || "");
  const isListLine = (ln) => /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(ln || "");
  const isHrLine = (ln) => /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(ln || "");
  const isHeadingLine = (ln) => /^\s*#{1,6}\s+/.test(ln || "");
  const isFenceLine = (ln) => /^\s*(?:`{3,}|~{3,})/.test(ln || "");
  const isQuoteLine = (ln) => /^\s*>\s?/.test(ln || "");
  const isEmbedLine = (ln) => /^\s*!(?:\[\[[^\[\]]+\]\]|\[[^\]]*\]\([^)]+\))\s*$/.test(ln || "");

  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }

    // Fenced code block
    if (isFenceLine(lines[i])) {
      const start = i;
      const fence = lines[i].trim().startsWith("~~~") ? "~~~" : "```";
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) i++;
      if (i < lines.length) i++;
      blocks.push({ type: "code", startLine: start, endLine: i - 1, raw: lines.slice(start, i).join("\n") });
      continue;
    }

    // GFM Markdown table
    if (lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const start = i;
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) i++;
      blocks.push({ type: "table", startLine: start, endLine: i - 1, raw: lines.slice(start, i).join("\n") });
      continue;
    }

    // Heading
    if (isHeadingLine(lines[i])) {
      blocks.push({ type: "heading", startLine: i, endLine: i, raw: lines[i] });
      i++;
      continue;
    }

    // Horizontal rule
    if (isHrLine(lines[i])) {
      blocks.push({ type: "hr", startLine: i, endLine: i, raw: lines[i] });
      i++;
      continue;
    }

    // Blockquote / Obsidian Callout
    if (isQuoteLine(lines[i])) {
      const start = i;
      i++;
      while (i < lines.length && isQuoteLine(lines[i])) i++;
      blocks.push({ type: "blockquote", startLine: start, endLine: i - 1, raw: lines.slice(start, i).join("\n") });
      continue;
    }

    // List (bullet, ordered, task checkboxes)
    if (isListLine(lines[i])) {
      const start = i;
      i++;
      while (i < lines.length && (isListLine(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && !isFenceLine(lines[i])))) i++;
      blocks.push({ type: "list", startLine: start, endLine: i - 1, raw: lines.slice(start, i).join("\n") });
      continue;
    }

    // Standalone image/note embed
    if (isEmbedLine(lines[i])) {
      blocks.push({ type: "embed", startLine: i, endLine: i, raw: lines[i] });
      i++;
      continue;
    }

    // Normal paragraph
    const start = i;
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isFenceLine(lines[i]) &&
      !isHeadingLine(lines[i]) &&
      !isHrLine(lines[i]) &&
      !isQuoteLine(lines[i]) &&
      !isListLine(lines[i]) &&
      !isEmbedLine(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      i++;
    }
    blocks.push({ type: "paragraph", startLine: start, endLine: i - 1, raw: lines.slice(start, i).join("\n") });
  }

  return { lines, blocks };
}

function splitTableRow(row) {
  let s = String(row || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseTableAlignments(sepRow) {
  return splitTableRow(sepRow).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

const CALLOUT_META = {
  note: { icon: "📝", label: "说明", cls: "is-note" },
  info: { icon: "ℹ️", label: "信息", cls: "is-note" },
  tip: { icon: "💡", label: "提示", cls: "is-tip" },
  hint: { icon: "💡", label: "提示", cls: "is-tip" },
  important: { icon: "📌", label: "重要", cls: "is-important" },
  warning: { icon: "⚠️", label: "注意", cls: "is-warn" },
  caution: { icon: "🚨", label: "警示", cls: "is-danger" },
  danger: { icon: "🚨", label: "危险", cls: "is-danger" },
  quote: { icon: "❝", label: "引用", cls: "is-note" },
  example: { icon: "✨", label: "示例", cls: "is-tip" },
};

export function createArticleLiveEditor(opts) {
  const {
    linksCtrl,
    getContent,
    setContent,
    getActivePath,
    getSlots,
    renderSlotCard,
    insertSlotAt,
    onAskAiSelection,
    onExtractSelectionToNote,
    onOpenNoteNewTab,
  } = opts;

  let editingIdx = -1;
  let activeLiveTa = null;
  let hostEl = null;

  function autoResize(ta) {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(30, ta.scrollHeight + 2)}px`;
  }

  function replaceBlockRaw(parsed, blockIdx, nextRaw) {
    const blk = parsed.blocks[blockIdx];
    if (!blk) return;
    const nextLines = [...parsed.lines];
    const repLines = nextRaw === null ? [] : String(nextRaw).replace(/\r\n/g, "\n").split("\n");
    nextLines.splice(blk.startLine, blk.endLine - blk.startLine + 1, ...repLines);
    setContent(nextLines.join("\n"));
  }

  function insertRawAfterBlock(parsed, blockIdx, snippet) {
    const nextLines = [...parsed.lines];
    const insertAt = blockIdx >= 0 && parsed.blocks[blockIdx]
      ? parsed.blocks[blockIdx].endLine + 1
      : nextLines.length;
    const toAdd = ["", ...String(snippet || "").split("\n")];
    nextLines.splice(insertAt, 0, ...toAdd);
    setContent(nextLines.join("\n"));
    return blockIdx + 1;
  }

  function openBlockContextMenu(ev, parsed, blockIdx) {
    const blk = parsed.blocks[blockIdx];
    const selText = activeLiveTa && activeLiveTa.isConnected
      ? activeLiveTa.value.slice(activeLiveTa.selectionStart ?? 0, activeLiveTa.selectionEnd ?? 0).trim()
      : (window.getSelection?.()?.toString() || "").trim();

    // Check if user right-clicked directly on a wikilink pill
    const wikiBtn = ev.target?.closest?.(".ic-wikilink");
    if (wikiBtn) {
      const linkLabel = wikiBtn.textContent?.trim() || "";
      const targetMatch = (wikiBtn.title || "").match(/「([^」]+)」/);
      const target = targetMatch ? targetMatch[1] : linkLabel;
      const resolved = linksCtrl.resolveLocalTarget(target, getActivePath());
      openArticleContextMenu(ev, [
        { header: `双链：${target}` },
        {
          icon: "↗",
          label: resolved?.kind === "note" ? "在当前标签打开" : "一键新建并打开",
          onClick: () => linksCtrl.navigateToLink(target, getActivePath()),
        },
        resolved?.kind === "note" ? {
          icon: "📑",
          label: "在新标签页打开",
          onClick: () => onOpenNoteNewTab?.(resolved.item.path),
        } : null,
        resolved?.kind === "note" ? {
          icon: "🕸",
          label: "查看该笔记的局部图谱",
          onClick: () => linksCtrl.openGraphModal("local", resolved.item.path),
        } : null,
        { sep: true },
        {
          icon: "📋",
          label: `复制 [[${target}]]`,
          onClick: () => {
            navigator.clipboard?.writeText(`[[${target}]]`).catch(() => {});
            toast(`已复制 [[${target}]]`);
          },
        },
      ]);
      return;
    }

    const anchorLine = blk ? blk.raw.split("\n").find((l) => l.trim())?.trim() || "" : "";
    const items = [];

    if (selText && selText.length >= 2) {
      items.push(
        { header: `选中文本 (${selText.length} 字)` },
        {
          icon: "✨",
          label: "让 AI 改写选中片段",
          onClick: () => onAskAiSelection?.(selText, "edit"),
        },
        {
          icon: "💬",
          label: "向 AI 提问 / 诊断这段",
          onClick: () => onAskAiSelection?.(selText, "advise"),
        },
        {
          icon: "🔗",
          label: `转为双链 [[${selText.slice(0, 14)}${selText.length > 14 ? "…" : ""}]]`,
          onClick: () => {
            if (activeLiveTa && activeLiveTa.isConnected) {
              linksCtrl.triggerInsertWikilink(activeLiveTa);
            } else if (blk) {
              const nextRaw = blk.raw.replace(selText, `[[${selText}]]`);
              replaceBlockRaw(parsed, blockIdx, nextRaw);
              render(hostEl);
            }
          },
        },
        {
          icon: "📄",
          label: "提取为新笔记并替换为双链",
          onClick: async () => {
            const createdName = await onExtractSelectionToNote?.(selText);
            if (!createdName) return;
            if (activeLiveTa && activeLiveTa.isConnected) {
              const a = activeLiveTa.selectionStart ?? 0;
              const b = activeLiveTa.selectionEnd ?? a;
              activeLiveTa.setRangeText(`[[${createdName}]]`, a, b, "end");
              activeLiveTa.dispatchEvent(new Event("input", { bubbles: true }));
            } else if (blk) {
              replaceBlockRaw(parsed, blockIdx, blk.raw.replace(selText, `[[${createdName}]]`));
              render(hostEl);
            }
          },
        },
        { sep: true }
      );
    }

    items.push(
      blk ? {
        icon: "✎",
        label: "原位编辑此段 Markdown",
        onClick: () => { editingIdx = blockIdx; render(hostEl); },
      } : null,
      {
        icon: "🔗",
        label: "插入双链笔记 [[…]]",
        shortcut: "[[",
        onClick: () => {
          if (activeLiveTa && activeLiveTa.isConnected) {
            linksCtrl.triggerInsertWikilink(activeLiveTa);
          } else {
            const nextIdx = insertRawAfterBlock(parsed, blockIdx, "[[");
            editingIdx = nextIdx;
            render(hostEl, { caretEnd: true, openAc: true });
          }
        },
      },
      {
        icon: "🎨",
        label: "在此段后插入 AI 配图位",
        onClick: () => insertSlotAt?.(anchorLine, "inline"),
      },
      { sep: true },
      {
        icon: "📊",
        label: "在下方插入 Markdown 表格",
        onClick: () => {
          const nextIdx = insertRawAfterBlock(parsed, blockIdx, "| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 A | 内容 B | 内容 C |");
          editingIdx = nextIdx;
          render(hostEl);
        },
      },
      {
        icon: "💡",
        label: "在下方插入提示框 (Callout)",
        onClick: () => {
          const nextIdx = insertRawAfterBlock(parsed, blockIdx, "> [!TIP] 提示\n> 在这里写重点提示内容…");
          editingIdx = nextIdx;
          render(hostEl);
        },
      },
      blk ? { sep: true } : null,
      blk ? {
        icon: "📋",
        label: "复制此段 Markdown",
        onClick: () => {
          navigator.clipboard?.writeText(blk.raw).catch(() => {});
          toast("已复制此段 Markdown");
        },
      } : null,
      blk ? {
        icon: "🗑",
        label: "删除此段",
        danger: true,
        onClick: () => {
          editingIdx = -1;
          replaceBlockRaw(parsed, blockIdx, null);
          render(hostEl);
        },
      } : null
    );

    openArticleContextMenu(ev, items);
  }

  function renderRenderedBlock(parsed, blk, idx, sourcePath) {
    if (blk.type === "frontmatter") {
      const entries = linksCtrl.parseFrontmatterEntries(blk.raw);
      const keyLabels = { aliases: "别名", alias: "别名", tags: "标签", tag: "标签", author: "作者", date: "日期", title: "标题" };
      const grid = el("div", { class: "ic-pv-props-grid" });
      entries.forEach((e) => {
        grid.appendChild(el("div", { class: "ic-pv-prop-row" },
          el("span", { class: "ic-pv-prop-key" }, keyLabels[e.key.toLowerCase()] || e.key),
          el("div", { class: "ic-pv-prop-vals" }, ...e.values.map((v) => el("span", { class: "ic-pv-prop-chip" }, v)))
        ));
      });
      const tagEntry = entries.find((e) => /^tags?$/i.test(e.key));
      const previewChips = tagEntry
        ? tagEntry.values.slice(0, 4).map((v) => el("span", { class: "ic-pv-prop-chip" }, `#${v}`))
        : [];
      const det = el("details", { class: "ic-pv-props ic-live-props" },
        el("summary", { class: "ic-pv-props-head ic-live-props-head" },
          el("span", null, `文档属性 (${entries.length})`),
          ...previewChips,
          el("button", {
            type: "button",
            class: "btn btn-sm",
            style: { marginLeft: "auto" },
            onClick: (ev) => { ev.preventDefault(); ev.stopPropagation(); editingIdx = idx; render(hostEl); },
          }, "✎ 编辑 YAML")
        ),
        grid
      );
      return det;
    }

    if (blk.type === "heading") {
      const m = blk.raw.trim().match(/^(#{1,6})\s+(.+)$/);
      const lvl = m ? m[1].length : 2;
      const tag = `h${Math.min(4, lvl)}`;
      const h = el(tag, { class: `ic-live-h ic-live-h${lvl}` });
      linksCtrl.appendInlineWithLinks(h, m ? m[2] : blk.raw, sourcePath, 0);
      return h;
    }

    if (blk.type === "hr") {
      return el("hr", { class: "ic-live-hr" });
    }

    if (blk.type === "code") {
      const ls = blk.raw.split("\n");
      const lang = ls[0].trim().replace(/^(`{3,}|~{3,})/, "").trim() || "text";
      const codeBody = ls.slice(1, ls[ls.length - 1].trim().startsWith("```") || ls[ls.length - 1].trim().startsWith("~~~") ? -1 : undefined).join("\n");
      return el("div", { class: "ic-live-code-card" },
        el("div", { class: "ic-live-code-head" },
          el("span", { class: "mono" }, lang),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: (ev) => {
              ev.stopPropagation();
              navigator.clipboard?.writeText(codeBody).catch(() => {});
              toast("已复制代码");
            },
          }, "📋 复制")
        ),
        el("pre", { class: "ic-live-pre" }, el("code", null, codeBody))
      );
    }

    if (blk.type === "table") {
      const ls = blk.raw.split("\n").filter((l) => l.trim());
      const headers = splitTableRow(ls[0]);
      const aligns = parseTableAlignments(ls[1] || "");
      const bodyRows = ls.slice(2).map(splitTableRow);
      const thead = el("thead", null,
        el("tr", null, ...headers.map((cell, ci) => {
          const th = el("th", { style: { textAlign: aligns[ci] || "left" } });
          linksCtrl.appendInlineWithLinks(th, cell, sourcePath, 0);
          return th;
        }))
      );
      const tbody = el("tbody", null, ...bodyRows.map((row) =>
        el("tr", null, ...headers.map((_, ci) => {
          const td = el("td", { style: { textAlign: aligns[ci] || "left" } });
          linksCtrl.appendInlineWithLinks(td, row[ci] || "", sourcePath, 0);
          return td;
        }))
      ));
      return el("div", { class: "ic-live-table-wrap" }, el("table", { class: "ic-live-table" }, thead, tbody));
    }

    if (blk.type === "blockquote") {
      const rawLines = blk.raw.split("\n").map((l) => l.replace(/^\s*>\s?/, ""));
      const cm = rawLines[0].trim().match(/^\[!([A-Za-z]+)\]\s*(.*)$/);
      if (cm) {
        const meta = CALLOUT_META[cm[1].toLowerCase()] || CALLOUT_META.note;
        const titleText = cm[2]?.trim() || meta.label;
        const body = el("div", { class: "ic-callout-body" });
        rawLines.slice(1).forEach((ln) => {
          const p = el("p", { style: { margin: "3px 0" } });
          linksCtrl.appendInlineWithLinks(p, ln, sourcePath, 0);
          body.appendChild(p);
        });
        return el("div", { class: `ic-callout ${meta.cls}` },
          el("div", { class: "ic-callout-head" }, el("span", null, meta.icon), el("strong", null, titleText)),
          body
        );
      }
      const bq = el("blockquote", { class: "ic-pv-quote ic-live-quote" });
      rawLines.forEach((ln) => {
        const p = el("p", { style: { margin: "3px 0" } });
        linksCtrl.appendInlineWithLinks(p, ln, sourcePath, 0);
        bq.appendChild(p);
      });
      return bq;
    }

    if (blk.type === "list") {
      const ls = blk.raw.split("\n");
      const firstOrdered = /^\s*\d+\.\s+/.test(ls[0]);
      const listEl = el(firstOrdered ? "ol" : "ul", { class: "ic-live-list" });
      ls.forEach((ln, liOffset) => {
        const indentMatch = ln.match(/^(\s*)/);
        const indentLevel = Math.min(4, Math.floor((indentMatch?.[1]?.length || 0) / 2));
        const taskMatch = ln.match(/^(\s*[-*+]\s+)\[([ xX])\]\s*(.*)$/);
        if (taskMatch) {
          const checked = taskMatch[2].toLowerCase() === "x";
          const cb = el("input", { type: "checkbox", class: "ic-live-task-cb" });
          cb.checked = checked;
          cb.addEventListener("click", (ev) => ev.stopPropagation());
          cb.addEventListener("change", () => {
            const nextListLines = blk.raw.split("\n");
            nextListLines[liOffset] = `${taskMatch[1]}[${cb.checked ? "x" : " "}] ${taskMatch[3]}`;
            replaceBlockRaw(parsed, idx, nextListLines.join("\n"));
            render(hostEl);
          });
          const textSpan = el("span", { class: checked ? "ic-live-task-done" : "" });
          linksCtrl.appendInlineWithLinks(textSpan, taskMatch[3], sourcePath, 0);
          listEl.appendChild(el("li", {
            class: "ic-live-task-li",
            style: indentLevel ? { marginLeft: `${indentLevel * 18}px` } : null,
          }, cb, textSpan));
          return;
        }
        const stripped = ln.replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/, "");
        const li = el("li", { style: indentLevel ? { marginLeft: `${indentLevel * 18}px` } : null });
        linksCtrl.appendInlineWithLinks(li, stripped, sourcePath, 0);
        listEl.appendChild(li);
      });
      return listEl;
    }

    if (blk.type === "embed") {
      const wrap = el("div", { class: "ic-live-embed" });
      linksCtrl.appendInlineWithLinks(wrap, blk.raw.trim(), sourcePath, 0);
      return wrap;
    }

    // Normal paragraph
    const p = el("p", { class: "ic-live-p" });
    const pLines = blk.raw.split("\n");
    pLines.forEach((ln, k) => {
      if (k > 0) p.appendChild(document.createElement("br"));
      linksCtrl.appendInlineWithLinks(p, ln, sourcePath, 0);
    });
    return p;
  }

  function render(container, focusOpts = {}) {
    if (!container) return;
    hostEl = container;
    clear(container);
    activeLiveTa = null;

    const rawContent = getContent() || "";
    const sourcePath = getActivePath() || "";
    const parsed = parseMarkdownBlocks(rawContent);
    const slots = getSlots() || [];
    const coverSlot = slots.find((s) => s.role === "cover");
    const inlineSlots = slots.filter((s) => s.role !== "cover");

    // 1. Cover slot card (or subtle add cover button)
    if (coverSlot) {
      container.appendChild(renderSlotCard(coverSlot, 0, "固定在文章开头"));
    } else {
      container.appendChild(el("div", { class: "ic-art-gap" },
        el("button", { type: "button", class: "ic-art-gap-btn", onClick: () => insertSlotAt("", "cover") }, "＋ 添加文章封面")
      ));
    }

    // Map inline illustration slots to the block containing their anchor
    const blockSlots = new Map();
    const orphans = [];
    inlineSlots.forEach((sl) => {
      let matchedBlockIdx = -1;
      if (sl.anchor) {
        matchedBlockIdx = parsed.blocks.findIndex((b) => b.raw.includes(sl.anchor));
      }
      if (matchedBlockIdx >= 0) {
        if (!blockSlots.has(matchedBlockIdx)) blockSlots.set(matchedBlockIdx, []);
        blockSlots.get(matchedBlockIdx).push(sl);
      } else {
        orphans.push(sl);
      }
    });

    let inlineNo = 0;

    if (!parsed.blocks.length) {
      // Empty note -> open initial seamless editor immediately
      const emptyTa = el("textarea", {
        class: "ic-live-ta is-paragraph",
        rows: "10",
        placeholder: "开始撰写你的文章（所见即所得，输入 [[ 关联笔记，支持表格、任务清单与代码块）…",
      });
      emptyTa.value = rawContent;
      linksCtrl.attachTextarea(emptyTa);
      emptyTa.addEventListener("input", () => {
        setContent(emptyTa.value);
        autoResize(emptyTa);
      });
      emptyTa.addEventListener("blur", () => {
        if (emptyTa.value.trim()) render(container);
      });
      activeLiveTa = emptyTa;
      container.appendChild(emptyTa);
      requestAnimationFrame(() => autoResize(emptyTa));
    } else {
      parsed.blocks.forEach((blk, idx) => {
        const isEditing = editingIdx === idx;
        const rowWrap = el("div", {
          class: "ic-live-block" + (isEditing ? " is-editing" : "") + ` is-type-${blk.type}`,
          onContextMenu: (ev) => openBlockContextMenu(ev, parsed, idx),
        });

        // Subtle left-margin '+' insert handle on hover
        const addHandle = el("button", {
          type: "button",
          class: "ic-live-gutter-add",
          title: "在此段下方插入新段落（右键可插表格/提示框/配图）",
          onClick: (ev) => {
            ev.stopPropagation();
            const nextIdx = insertRawAfterBlock(parsed, idx, "");
            editingIdx = nextIdx;
            render(container, { caretEnd: true });
          },
        }, "＋");
        rowWrap.appendChild(addHandle);

        if (isEditing) {
          const ta = el("textarea", {
            class: `ic-live-ta is-${blk.type}`,
            spellcheck: "false",
          });
          ta.value = blk.raw;
          linksCtrl.attachTextarea(ta);
          let committed = false;
          const commitAndClose = (nextEditIdx = -1) => {
            if (committed) return;
            committed = true;
            if (ta.value !== blk.raw) {
              replaceBlockRaw(parsed, idx, ta.value);
            }
            editingIdx = nextEditIdx;
            render(container);
          };

          ta.addEventListener("input", () => {
            autoResize(ta);
            replaceBlockRaw(parsed, idx, ta.value);
            // Update parsed block reference in place so subsequent edits stay synced
            const nextParsed = parseMarkdownBlocks(getContent() || "");
            parsed.lines = nextParsed.lines;
            parsed.blocks = nextParsed.blocks;
          });
          ta.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape") {
              ev.preventDefault();
              commitAndClose(-1);
              return;
            }
            if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "b") {
              ev.preventDefault();
              const a = ta.selectionStart ?? 0, b = ta.selectionEnd ?? a;
              ta.setRangeText(`**${ta.value.slice(a, b) || "加粗"}**`, a, b, "end");
              ta.dispatchEvent(new Event("input", { bubbles: true }));
              return;
            }
            if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "i") {
              ev.preventDefault();
              const a = ta.selectionStart ?? 0, b = ta.selectionEnd ?? a;
              ta.setRangeText(`*${ta.value.slice(a, b) || "斜体"}*`, a, b, "end");
              ta.dispatchEvent(new Event("input", { bubbles: true }));
              return;
            }
            if (ev.key === "Tab") {
              ev.preventDefault();
              const a = ta.selectionStart ?? 0, b = ta.selectionEnd ?? a;
              ta.setRangeText("  ", a, b, "end");
              ta.dispatchEvent(new Event("input", { bubbles: true }));
              return;
            }
            // Seamless cross-block ArrowUp / ArrowDown navigation!
            if (ev.key === "ArrowUp" && !ev.shiftKey && !document.querySelector(".ic-link-ac")) {
              const before = ta.value.slice(0, ta.selectionStart ?? 0);
              if (!before.includes("\n") && idx > 0) {
                ev.preventDefault();
                commitAndClose(idx - 1);
              }
            } else if (ev.key === "ArrowDown" && !ev.shiftKey && !document.querySelector(".ic-link-ac")) {
              const after = ta.value.slice(ta.selectionEnd ?? ta.value.length);
              if (!after.includes("\n") && idx < parsed.blocks.length - 1) {
                ev.preventDefault();
                commitAndClose(idx + 1);
              }
            }
          });
          ta.addEventListener("blur", () => {
            // Delay briefly so autocomplete clicks / toolbar clicks can settle
            setTimeout(() => {
              if (document.activeElement === ta) return;
              if (document.querySelector(".ic-link-ac")) return;
              if (editingIdx === idx) commitAndClose(-1);
            }, 140);
          });

          activeLiveTa = ta;
          rowWrap.appendChild(ta);
          requestAnimationFrame(() => {
            autoResize(ta);
            ta.focus();
            if (focusOpts.caretEnd) {
              ta.setSelectionRange(ta.value.length, ta.value.length);
            }
            if (focusOpts.openAc) {
              ta.dispatchEvent(new Event("input", { bubbles: true }));
            }
          });
        } else {
          const rendered = renderRenderedBlock(parsed, blk, idx, sourcePath);
          const contentWrap = el("div", { class: "ic-live-rendered" }, rendered);
          contentWrap.addEventListener("click", (ev) => {
            // Don't hijack interactive links, buttons, checkboxes, or details summary!
            if (ev.target.closest("a, button, input, summary, .ic-wikilink, .ic-embed-note-head")) return;
            const sel = window.getSelection?.()?.toString() || "";
            if (sel.length >= 2) return; // user is selecting text (for copy or AI)
            editingIdx = idx;
            render(container, { caretEnd: true });
          });
          rowWrap.appendChild(contentWrap);
        }

        container.appendChild(rowWrap);

        // Interleave any AI illustration slot cards bound to this block
        const boundSlots = blockSlots.get(idx) || [];
        boundSlots.forEach((sl) => {
          inlineNo += 1;
          const anchorPreview = blk.raw.split("\n")[0].trim().slice(0, 26);
          container.appendChild(renderSlotCard(sl, inlineNo, `§ 位于「${anchorPreview}」之后`));
        });
      });

      // Orphan illustration slots
      orphans.forEach((sl, oIdx) => {
        container.appendChild(renderSlotCard(sl, inlineNo + oIdx + 1, sl.anchor ? `原位置「${sl.anchor.slice(0, 20)}」未匹配` : "尚未绑定段落", true));
      });

      // Clickable empty canvas tail -> click to append & keep writing naturally!
      const tailPad = el("div", {
        class: "ic-live-tail",
        title: "点击此处继续追加新段落",
        onClick: () => {
          const nextIdx = insertRawAfterBlock(parsed, parsed.blocks.length - 1, "");
          editingIdx = nextIdx;
          render(container, { caretEnd: true });
        },
        onContextMenu: (ev) => openBlockContextMenu(ev, parsed, parsed.blocks.length - 1),
      },
        el("span", { class: "ic-live-tail-hint muted" }, "点击此处继续书写，或右键插入双链 / 表格 / 配图位…")
      );
      container.appendChild(tailPad);
    }

    // Append subtle Backlinks Footer right at the bottom of Live Preview too!
    linksCtrl.renderPreviewBacklinksFooter(container);
  }

  function applyFormat(fmt) {
    if (activeLiveTa && activeLiveTa.isConnected) {
      if (fmt === "wikilink") {
        linksCtrl.triggerInsertWikilink(activeLiveTa);
        return true;
      }
      const ta = activeLiveTa;
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const sel = ta.value.slice(start, end);
      const wrapLine = (prefix) => {
        const ls = ta.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
        ta.setRangeText(prefix, ls, ls, "end");
      };
      if (fmt === "h1") wrapLine("# ");
      else if (fmt === "h2") wrapLine("## ");
      else if (fmt === "h3") wrapLine("### ");
      else if (fmt === "quote") wrapLine("> ");
      else if (fmt === "ul") wrapLine("- ");
      else if (fmt === "ol") wrapLine("1. ");
      else if (fmt === "hr") ta.setRangeText("\n---\n", start, end, "end");
      else if (fmt === "bold") ta.setRangeText(`**${sel || "加粗文本"}**`, start, end, "end");
      else if (fmt === "italic") ta.setRangeText(`*${sel || "斜体文本"}*`, start, end, "end");
      else if (fmt === "code") ta.setRangeText(sel.includes("\n") ? `\n\`\`\`\n${sel}\n\`\`\`\n` : `\`${sel || "code"}\``, start, end, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
      return true;
    }
    // No block currently focused -> append a new block with that formatting!
    const parsed = parseMarkdownBlocks(getContent() || "");
    const templates = {
      h1: "# ",
      h2: "## ",
      h3: "### ",
      quote: "> ",
      ul: "- ",
      ol: "1. ",
      hr: "---",
      bold: "**加粗文本**",
      italic: "*斜体文本*",
      code: "```\n\n```",
      wikilink: "[[",
    };
    const nextIdx = insertRawAfterBlock(parsed, parsed.blocks.length - 1, templates[fmt] || "");
    editingIdx = nextIdx;
    render(hostEl, { caretEnd: true, openAc: fmt === "wikilink" });
    return true;
  }

  function resetEditing() {
    editingIdx = -1;
    activeLiveTa = null;
  }

  function getActiveTextarea() {
    return activeLiveTa && activeLiveTa.isConnected ? activeLiveTa : null;
  }

  return {
    render,
    applyFormat,
    resetEditing,
    getActiveTextarea,
  };
}
