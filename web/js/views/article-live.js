import { clear, closeModal, el, showModal, toast } from "../api.js";
import {
  Compartment,
  Decoration,
  EditorSelection,
  EditorState,
  EditorView,
  HighlightStyle,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  WidgetType,
  bracketMatching,
  cmAutocomplete,
  cmCommands,
  cmLangMarkdown,
  cmLanguage,
  cmSearch,
  cmState,
  cmView,
  defaultKeymap,
  drawSelection,
  dropCursor,
  history,
  historyKeymap,
  indentOnInput,
  indentWithTab,
  keymap,
  lezerCommon,
  lezerHighlight,
  markdown,
  markdownLanguage,
  placeholder,
  syntaxHighlighting,
  tags,
} from "../../vendor/cm6-bundle.js";
import { openArticleContextMenu } from "./article-links.js";

// Shared CodeMirror 6 & Lezer singletons exposed to Obsidian plugins (#131).
// Sharing exact module instances guarantees Facet/StateField/Decoration identity checks succeed.
export const CM6_SINGLETON_MODULES = Object.freeze({
  "@codemirror/state": cmState,
  "@codemirror/view": cmView,
  "@codemirror/commands": cmCommands,
  "@codemirror/lang-markdown": cmLangMarkdown,
  "@codemirror/language": cmLanguage,
  "@codemirror/autocomplete": cmAutocomplete,
  "@codemirror/search": cmSearch,
  "@lezer/highlight": lezerHighlight,
  "@lezer/common": lezerCommon,
  codemirror: Object.freeze({
    ...cmState,
    ...cmView,
    ...cmCommands,
    ...cmLanguage,
    ...cmAutocomplete,
    ...cmSearch,
  }),
});

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

const HIGHLIGHT_SWATCHES = [
  { id: "default", label: "默认高亮", swatch: "#fde047", kind: "eq" },
  { id: "red", label: "红色", swatch: "#ef4444", bg: "#ffd6d6" },
  { id: "orange", label: "橙色", swatch: "#f97316", bg: "#ffe4c4" },
  { id: "yellow", label: "黄色", swatch: "#eab308", bg: "#fff3b0" },
  { id: "green", label: "绿色", swatch: "#22c55e", bg: "#d3f4d8" },
  { id: "blue", label: "蓝色", swatch: "#3b82f6", bg: "#d4e8ff" },
  { id: "purple", label: "紫色", swatch: "#8b5cf6", bg: "#e8dcff" },
];

const refreshLiveEffect = StateEffect.define();

function splitTableRow(line) {
  let s = String(line || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseTableAlignments(sepLine) {
  return splitTableRow(sepLine).map((cell) => {
    const l = cell.startsWith(":");
    const r = cell.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    return "left";
  });
}

const isTableSepLine = (ln) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(ln || "");

// ---------- CodeMirror 6 Custom Live Preview Widgets ----------

class FrontmatterWidget extends WidgetType {
  constructor(raw, from, to, linksCtrl) {
    super();
    this.raw = raw;
    this.from = from;
    this.to = to;
    this.linksCtrl = linksCtrl;
  }
  eq(other) {
    return other.raw === this.raw && other.from === this.from && other.to === this.to;
  }
  toDOM(view) {
    const entries = this.linksCtrl.parseFrontmatterEntries(this.raw);
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
      ? tagEntry.values.slice(0, 5).map((v) => el("span", { class: "ic-pv-prop-chip" }, `#${v}`))
      : [];
    const editBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      style: { marginLeft: "auto" },
      onMouseDown: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const targetPos = Math.min(this.from + 4, this.to);
        view.dispatch({ selection: { anchor: targetPos }, scrollIntoView: true });
        view.focus();
      },
    }, "✎ 编辑 YAML");

    const det = el("details", { class: "ic-pv-props ic-live-props" },
      el("summary", { class: "ic-pv-props-head ic-live-props-head" },
        el("span", null, `文档属性 (${entries.length})`),
        ...previewChips,
        editBtn
      ),
      grid
    );
    return el("div", { class: "cm-lp-block-widget cm-lp-frontmatter-widget" }, det);
  }
  ignoreEvent() {
    return true;
  }
}

class TableWidget extends WidgetType {
  constructor(raw, from, to, sourcePath, linksCtrl) {
    super();
    this.raw = raw;
    this.from = from;
    this.to = to;
    this.sourcePath = sourcePath;
    this.linksCtrl = linksCtrl;
  }
  eq(other) {
    return other.raw === this.raw && other.from === this.from && other.to === this.to && other.sourcePath === this.sourcePath;
  }
  toDOM(view) {
    const ls = this.raw.split("\n");
    const headers = splitTableRow(ls[0] || "");
    const aligns = parseTableAlignments(ls[1] || "");
    const bodyRows = ls.slice(2).map(splitTableRow);

    const thead = el("thead", null,
      el("tr", null, ...headers.map((h, i) => {
        const th = el("th", { style: { textAlign: aligns[i] || "left" } });
        this.linksCtrl.appendInlineWithLinks(th, h, this.sourcePath, 0);
        return th;
      }))
    );
    const tbody = el("tbody", null, ...bodyRows.map((cells, rIdx) =>
      el("tr", { dataset: { row: String(rIdx) } }, ...headers.map((_, i) => {
        const td = el("td", { style: { textAlign: aligns[i] || "left" } });
        this.linksCtrl.appendInlineWithLinks(td, cells[i] || "", this.sourcePath, 0);
        return td;
      }))
    ));
    const wrap = el("div", {
      class: "ic-live-table-wrap cm-lp-table-widget",
      title: "点击表格可原地编辑 Markdown 表格",
    }, el("table", { class: "ic-live-table" }, thead, tbody));

    wrap.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest("a, button, .ic-wikilink")) return;
      ev.preventDefault();
      // Place cursor right on the clicked row's Markdown line!
      const tr = ev.target.closest("tbody tr");
      const rowOffset = tr ? Number(tr.dataset.row || 0) + 2 : 0;
      const startLine = view.state.doc.lineAt(this.from).number;
      const targetLineNo = Math.min(view.state.doc.lines, startLine + rowOffset);
      const line = view.state.doc.line(targetLineNo);
      view.dispatch({ selection: { anchor: line.from + 2 }, scrollIntoView: true });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent(ev) {
    return ev.type !== "contextmenu";
  }
}

class WikilinkWidget extends WidgetType {
  constructor(inner, from, to, sourcePath, linksCtrl, onOpenNewTab) {
    super();
    this.inner = inner;
    this.from = from;
    this.to = to;
    this.sourcePath = sourcePath;
    this.linksCtrl = linksCtrl;
    this.onOpenNewTab = onOpenNewTab;
  }
  eq(other) {
    return other.inner === this.inner && other.from === this.from && other.to === this.to && other.sourcePath === this.sourcePath;
  }
  toDOM(view) {
    const pipeIdx = this.inner.indexOf("|");
    const targetPart = (pipeIdx >= 0 ? this.inner.slice(0, pipeIdx) : this.inner).trim();
    const alias = pipeIdx >= 0 ? this.inner.slice(pipeIdx + 1).trim() : "";
    const resolved = this.linksCtrl.resolveLocalTarget(targetPart, this.sourcePath);
    const exists = Boolean(resolved);
    const display = alias || targetPart;

    const span = el("span", {
      class: "ic-wikilink cm-lp-wikilink" + (exists ? "" : " is-unresolved"),
      role: "link",
      tabindex: "-1",
      dataset: { target: targetPart, from: String(this.from), to: String(this.to) },
      title: exists
        ? `点击打开「${targetPart}」（Ctrl+点击新标签，方向键移入可编辑）`
        : `待建笔记「${targetPart}」：点击一键新建`,
    }, display);

    if (exists) {
      this.linksCtrl.bindHoverPreview(span, targetPart, this.sourcePath);
    }

    span.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.altKey) {
        // Alt+Click enters inline editing of the wikilink syntax directly
        view.dispatch({ selection: { anchor: this.from + 2 } });
        view.focus();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && resolved?.kind === "note") {
        this.onOpenNewTab?.(resolved.item.path);
        return;
      }
      this.linksCtrl.navigateToLink(targetPart, this.sourcePath);
    });
    return span;
  }
  ignoreEvent(ev) {
    return ev.type !== "contextmenu";
  }
}

class ExtLinkWidget extends WidgetType {
  constructor(label, url, from) {
    super();
    this.label = label;
    this.url = url;
    this.from = from;
  }
  eq(other) {
    return other.label === this.label && other.url === this.url && other.from === this.from;
  }
  toDOM(view) {
    const a = el("a", {
      class: "cm-lp-extlink",
      href: this.url,
      target: "_blank",
      rel: "noopener noreferrer",
      title: `${this.url}（点击打开链接，Alt+点击编辑）`,
    }, this.label);
    a.addEventListener("mousedown", (ev) => {
      if (ev.button === 0 && ev.altKey) {
        ev.preventDefault();
        view.dispatch({ selection: { anchor: this.from + 1 } });
        view.focus();
      }
    });
    return a;
  }
  ignoreEvent(ev) {
    return ev.type !== "contextmenu";
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked, pos) {
    super();
    this.checked = checked;
    this.pos = pos;
  }
  eq(other) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view) {
    const cb = el("input", {
      type: "checkbox",
      class: "ic-live-task-cb cm-lp-cb",
      checked: this.checked,
      "aria-label": "切换任务完成状态",
    });
    cb.checked = this.checked;
    cb.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const next = this.checked ? "[ ]" : "[x]";
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: next },
      });
    });
    return cb;
  }
  ignoreEvent() {
    return true;
  }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    return el("span", { class: "cm-lp-bullet", "aria-hidden": "true" }, "•");
  }
}

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    return el("div", { class: "cm-lp-hr-wrap" }, el("hr", { class: "ic-live-hr" }));
  }
}

class CalloutHeaderWidget extends WidgetType {
  constructor(kind, title) {
    super();
    this.kind = kind;
    this.title = title;
  }
  eq(other) {
    return other.kind === this.kind && other.title === this.title;
  }
  toDOM() {
    const meta = CALLOUT_META[this.kind] || CALLOUT_META.note;
    return el("span", { class: `cm-lp-callout-badge ${meta.cls}` },
      el("span", { "aria-hidden": "true" }, meta.icon),
      el("strong", null, this.title || meta.label)
    );
  }
}

class CodeHeaderWidget extends WidgetType {
  constructor(lang, codeText) {
    super();
    this.lang = lang;
    this.codeText = codeText;
  }
  eq(other) {
    return other.lang === this.lang && other.codeText === this.codeText;
  }
  toDOM() {
    return el("div", { class: "cm-lp-code-header" },
      el("span", { class: "mono" }, this.lang || "code"),
      el("button", {
        type: "button",
        class: "ic-live-code-copy",
        onMouseDown: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          navigator.clipboard?.writeText(this.codeText).catch(() => {});
          toast("已复制代码块");
        },
      }, "复制")
    );
  }
  ignoreEvent() {
    return true;
  }
}

class EmbedWidget extends WidgetType {
  constructor(rawLine, sourcePath, linksCtrl) {
    super();
    this.rawLine = rawLine;
    this.sourcePath = sourcePath;
    this.linksCtrl = linksCtrl;
  }
  eq(other) {
    return other.rawLine === this.rawLine && other.sourcePath === this.sourcePath;
  }
  toDOM() {
    const box = el("div", { class: "cm-lp-embed-widget" });
    this.linksCtrl.renderPreviewBlock(box, this.rawLine.trim(), this.sourcePath);
    return box;
  }
  ignoreEvent(ev) {
    return ev.type !== "contextmenu";
  }
}

class SlotCardWidget extends WidgetType {
  constructor(slot, inlineNo, desc, renderSlotCard) {
    super();
    this.slot = slot;
    this.inlineNo = inlineNo;
    this.desc = desc;
    this.renderSlotCard = renderSlotCard;
    this.sig = `${slot.id}:${slot.imagePath || ""}:${slot.theme || ""}:${slot.error || ""}:${inlineNo}:${desc}`;
  }
  eq(other) {
    return other.sig === this.sig;
  }
  toDOM() {
    return el("div", { class: "cm-lp-slot-widget" }, this.renderSlotCard(this.slot, this.inlineNo, this.desc));
  }
  ignoreEvent() {
    return true;
  }
}

// ---------- Obsidian Live Preview Decoration Builder ----------

function overlapsSelection(sel, from, to) {
  for (const r of sel.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

function buildLiveDecorations(state, env) {
  const { linksCtrl, getActivePath, getSlots, renderSlotCard, onOpenNoteNewTab } = env;
  const sourcePath = getActivePath() || "";
  const doc = state.doc;
  const sel = state.selection;
  const lineCount = doc.lines;
  const ops = []; // { from, to, deco, order }

  const addOp = (from, to, deco, order = 0) => {
    ops.push({ from, to, deco, order });
  };

  // Pre-compute inline AI slot anchors by line number
  const inlineSlots = (getSlots() || []).filter((s) => s.role !== "cover");
  const slotsByLine = new Map();
  let slotSeq = 0;
  inlineSlots.forEach((sl) => {
    if (!sl.anchor) return;
    for (let ln = 1; ln <= lineCount; ln++) {
      const txt = doc.line(ln).text;
      if (txt.trim() && txt.includes(sl.anchor)) {
        slotSeq += 1;
        if (!slotsByLine.has(ln)) slotsByLine.set(ln, []);
        slotsByLine.get(ln).push({ slot: sl, no: slotSeq, preview: txt.trim().slice(0, 26) });
        break;
      }
    }
  });

  // Track skipped line ranges (multi-line block replacements: frontmatter, tables)
  const replacedLines = new Set();

  // 1. Optional YAML frontmatter starting at line 1
  let startScanLine = 1;
  if (lineCount >= 3 && doc.line(1).text.trim() === "---") {
    let fmEnd = -1;
    for (let j = 2; j <= lineCount; j++) {
      if (doc.line(j).text.trim() === "---") { fmEnd = j; break; }
    }
    if (fmEnd > 1) {
      const fmFrom = doc.line(1).from;
      const fmTo = doc.line(fmEnd).to;
      if (!overlapsSelection(sel, fmFrom, fmTo)) {
        const raw = doc.sliceString(fmFrom, fmTo);
        addOp(fmFrom, fmTo, Decoration.replace({
          widget: new FrontmatterWidget(raw, fmFrom, fmTo, linksCtrl),
          block: true,
        }), -10);
        for (let k = 1; k <= fmEnd; k++) replacedLines.add(k);
      } else {
        for (let k = 1; k <= fmEnd; k++) {
          addOp(doc.line(k).from, doc.line(k).from, Decoration.line({ class: "cm-lp-yaml-line" }), -5);
        }
      }
      startScanLine = fmEnd + 1;
    }
  }

  // 2. Scan lines for fenced code blocks, tables, callouts, headings, lists, HR, embeds, and inline formatting
  let inCode = false;
  let codeFence = "```";
  let codeStartLine = 0;
  let codeLang = "";
  let inCallout = false;
  let calloutCls = "is-note";

  for (let ln = startScanLine; ln <= lineCount; ln++) {
    if (replacedLines.has(ln)) continue;
    const line = doc.line(ln);
    const text = line.text;
    const trimmed = text.trim();
    const lineActive = overlapsSelection(sel, line.from, line.to);

    // Attach any bound AI illustration slot card after this line
    if (slotsByLine.has(ln)) {
      slotsByLine.get(ln).forEach((entry) => {
        addOp(line.to, line.to, Decoration.widget({
          widget: new SlotCardWidget(entry.slot, entry.no, `§ 位于「${entry.preview}」之后`, renderSlotCard),
          block: true,
          side: 1,
        }), 100);
      });
    }

    // Fenced code block handling
    if (!inCode && /^(?:`{3,}|~{3,})/.test(trimmed)) {
      inCode = true;
      codeFence = trimmed.startsWith("~~~") ? "~~~" : "```";
      codeStartLine = ln;
      codeLang = trimmed.replace(/^(`{3,}|~{3,})/, "").trim();
      // Gather full code text for Copy button
      let endCodeLn = lineCount;
      for (let k = ln + 1; k <= lineCount; k++) {
        if (doc.line(k).text.trim().startsWith(codeFence)) { endCodeLn = k; break; }
      }
      const codeBody = endCodeLn > ln + 1
        ? doc.sliceString(doc.line(ln + 1).from, doc.line(endCodeLn - 1).to)
        : "";
      addOp(line.from, line.from, Decoration.line({ class: "cm-lp-code-line cm-lp-code-first" }), -5);
      if (!lineActive) {
        addOp(line.from, line.to, Decoration.replace({ widget: new CodeHeaderWidget(codeLang, codeBody) }), 0);
      }
      continue;
    }
    if (inCode) {
      if (trimmed.startsWith(codeFence)) {
        addOp(line.from, line.from, Decoration.line({ class: "cm-lp-code-line cm-lp-code-last" }), -5);
        if (!lineActive) {
          addOp(line.from, line.to, Decoration.mark({ class: "cm-lp-syntax-dim" }), 0);
        }
        inCode = false;
      } else {
        addOp(line.from, line.from, Decoration.line({ class: "cm-lp-code-line" }), -5);
      }
      continue;
    }

    // GFM Markdown Table block
    if (text.includes("|") && ln + 1 <= lineCount && isTableSepLine(doc.line(ln + 1).text)) {
      let tblEnd = ln + 1;
      while (tblEnd + 1 <= lineCount && doc.line(tblEnd + 1).text.trim() && doc.line(tblEnd + 1).text.includes("|")) {
        tblEnd++;
      }
      const tFrom = line.from;
      const tTo = doc.line(tblEnd).to;
      if (!overlapsSelection(sel, tFrom, tTo)) {
        const rawTbl = doc.sliceString(tFrom, tTo);
        addOp(tFrom, tTo, Decoration.replace({
          widget: new TableWidget(rawTbl, tFrom, tTo, sourcePath, linksCtrl),
          block: true,
        }), -10);
        for (let k = ln; k <= tblEnd; k++) replacedLines.add(k);
        ln = tblEnd;
        continue;
      } else {
        for (let k = ln; k <= tblEnd; k++) {
          const tl = doc.line(k);
          addOp(tl.from, tl.from, Decoration.line({ class: "cm-lp-table-src-line" }), -5);
        }
        ln = tblEnd;
        continue;
      }
    }

    // Horizontal rule
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
      if (!lineActive) {
        addOp(line.from, line.to, Decoration.replace({ widget: new HrWidget() }), 0);
      } else {
        addOp(line.from, line.to, Decoration.mark({ class: "cm-lp-syntax-dim" }), 0);
      }
      inCallout = false;
      continue;
    }

    // Standalone embed line ![[...]] or ![alt](url)
    if (/^\s*!(?:\[\[[^\[\]]+\]\]|\[[^\]]*\]\([^)]+\))\s*$/.test(text)) {
      inCallout = false;
      addOp(line.to, line.to, Decoration.widget({
        widget: new EmbedWidget(text, sourcePath, linksCtrl),
        block: true,
        side: 1,
      }), 50);
      if (!lineActive) {
        addOp(line.from, line.to, Decoration.mark({ class: "cm-lp-embed-src-dim" }), 0);
      }
      continue;
    }

    // Standalone HTML <video ...> / <audio ...> embed block (single-line or multi-line, #141)
    const htmlMediaStart = trimmed.match(/^<(video|audio)\b/i);
    if (htmlMediaStart) {
      const tagName = htmlMediaStart[1].toLowerCase();
      const closeRe = new RegExp(`</${tagName}\\s*>\\s*$`, "i");
      let mediaEndLn = ln;
      if (!closeRe.test(trimmed) && !/\/>\s*$/.test(trimmed)) {
        const maxScan = Math.min(lineCount, ln + 12);
        let foundClose = false;
        for (let k = ln + 1; k <= maxScan; k++) {
          if (closeRe.test(doc.line(k).text.trim())) {
            mediaEndLn = k;
            foundClose = true;
            break;
          }
        }
        if (!foundClose) mediaEndLn = -1;
      }
      if (mediaEndLn >= ln) {
        inCallout = false;
        const mFrom = line.from;
        const mTo = doc.line(mediaEndLn).to;
        const rawHtml = doc.sliceString(mFrom, mTo);
        addOp(mTo, mTo, Decoration.widget({
          widget: new EmbedWidget(rawHtml, sourcePath, linksCtrl),
          block: true,
          side: 1,
        }), 50);
        if (!overlapsSelection(sel, mFrom, mTo)) {
          for (let k = ln; k <= mediaEndLn; k++) {
            const ml = doc.line(k);
            addOp(ml.from, ml.to, Decoration.mark({ class: "cm-lp-embed-src-dim" }), 0);
          }
        }
        ln = mediaEndLn;
        continue;
      }
    }

    // Blockquote / Obsidian Callout
    const qm = text.match(/^(\s*>\s?)(.*)$/);
    if (qm) {
      const prefixLen = qm[1].length;
      const cm = qm[2].match(/^\[!([a-zA-Z]+)\](?:[+-])?\s*(.*)$/);
      if (cm) {
        inCallout = true;
        const kind = cm[1].toLowerCase();
        const meta = CALLOUT_META[kind] || CALLOUT_META.note;
        calloutCls = meta.cls;
        addOp(line.from, line.from, Decoration.line({ class: `cm-lp-callout ${calloutCls} is-first` }), -5);
        if (!lineActive) {
          addOp(line.from, line.to, Decoration.replace({ widget: new CalloutHeaderWidget(kind, cm[2].trim()) }), 0);
          continue;
        }
      } else if (inCallout) {
        addOp(line.from, line.from, Decoration.line({ class: `cm-lp-callout ${calloutCls}` }), -5);
        if (!lineActive) addOp(line.from, line.from + prefixLen, Decoration.replace({}), 0);
      } else {
        addOp(line.from, line.from, Decoration.line({ class: "cm-lp-quote-line" }), -5);
        if (!lineActive) addOp(line.from, line.from + prefixLen, Decoration.replace({}), 0);
      }
    } else {
      inCallout = false;
    }

    // Headings (# .. ######)
    const hm = text.match(/^(\s*)(#{1,6})(\s+)/);
    if (hm) {
      const lvl = hm[2].length;
      addOp(line.from, line.from, Decoration.line({ class: `cm-lp-h cm-lp-h${lvl}` }), -5);
      const prefEnd = line.from + hm[0].length;
      if (!overlapsSelection(sel, line.from, prefEnd)) {
        addOp(line.from, prefEnd, Decoration.replace({}), 0);
      } else {
        addOp(line.from, prefEnd, Decoration.mark({ class: "cm-lp-syntax-dim" }), 0);
      }
    }

    // Task checkboxes & bullet lists
    const taskM = text.match(/^(\s*[-*+]\s+)(\[[ xX]\])(\s+)/);
    if (taskM) {
      const checked = taskM[2].toLowerCase() === "[x]";
      const markerFrom = line.from + taskM[1].length;
      const fullPrefEnd = markerFrom + 3;
      addOp(line.from, line.from, Decoration.line({ class: "cm-lp-list-line" + (checked ? " cm-lp-task-done" : "") }), -5);
      if (!overlapsSelection(sel, line.from, fullPrefEnd)) {
        addOp(line.from, fullPrefEnd, Decoration.replace({ widget: new CheckboxWidget(checked, markerFrom) }), 0);
      }
    } else {
      const ulM = text.match(/^(\s*)([-*+])(\s+)/);
      if (ulM) {
        const dashFrom = line.from + ulM[1].length;
        const dashTo = dashFrom + 1;
        addOp(line.from, line.from, Decoration.line({ class: "cm-lp-list-line" }), -5);
        if (!overlapsSelection(sel, dashFrom, dashTo + 1)) {
          addOp(dashFrom, dashTo, Decoration.replace({ widget: new BulletWidget() }), 0);
        }
      }
    }

    // Inline Markdown decorations within this line
    decorateInlineLine(text, line.from, sel, sourcePath, linksCtrl, onOpenNoteNewTab, addOp);
  }

  // Sort strictly by (from asc, startSide/order asc, to asc) as required by RangeSetBuilder
  ops.sort((a, b) => (a.from - b.from) || (a.order - b.order) || (a.to - b.to));

  const builder = new RangeSetBuilder();
  let lastReplaceTo = -1;
  for (const op of ops) {
    // Skip any inline decoration that falls inside an already-added replace range
    const isLine = op.deco.spec && !op.deco.spec.widget && op.from === op.to && op.deco.spec.attributes;
    if (!isLine && op.from < lastReplaceTo) continue;
    try {
      builder.add(op.from, op.to, op.deco);
      if (op.deco.spec && op.deco.spec.inclusive === undefined && op.to > op.from && !op.deco.spec.class && !op.deco.spec.attributes) {
        lastReplaceTo = Math.max(lastReplaceTo, op.to);
      }
    } catch {
      // Ignore any rare overlapping edge decoration cleanly without breaking editor
    }
  }
  return builder.finish();
}

function decorateInlineLine(text, lineFrom, sel, sourcePath, linksCtrl, onOpenNoteNewTab, addOp) {
  // Helper to claim non-overlapping inline spans cleanly
  const claimed = [];
  const isClaimed = (a, b) => claimed.some(([s, e]) => a < e && b > s);
  const claim = (a, b) => claimed.push([a, b]);

  // 1. Wikilinks [[target|alias]] (non-embed)
  {
    const re = /(?<!!)\[\[([^\[\]\r\n]+)\]\]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = lineFrom + m.index;
      const t = f + m[0].length;
      if (isClaimed(f, t)) continue;
      claim(f, t);
      if (!overlapsSelection(sel, f, t)) {
        addOp(f, t, Decoration.replace({
          widget: new WikilinkWidget(m[1], f, t, sourcePath, linksCtrl, onOpenNoteNewTab),
        }), 1);
      } else {
        addOp(f, f + 2, Decoration.mark({ class: "cm-lp-syntax-dim" }), 1);
        addOp(f + 2, t - 2, Decoration.mark({ class: "cm-lp-wikilink-editing" }), 2);
        addOp(t - 2, t, Decoration.mark({ class: "cm-lp-syntax-dim" }), 3);
      }
    }
  }

  // 2. External links [label](https://...)
  {
    const re = /(?<!!)\[([^\[\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = lineFrom + m.index;
      const t = f + m[0].length;
      if (isClaimed(f, t)) continue;
      claim(f, t);
      if (!overlapsSelection(sel, f, t)) {
        addOp(f, t, Decoration.replace({ widget: new ExtLinkWidget(m[1], m[2], f) }), 1);
      }
    }
  }

  // 3. Inline code `...`
  {
    const re = /`([^`\r\n]+)`/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = lineFrom + m.index;
      const t = f + m[0].length;
      if (isClaimed(f, t)) continue;
      claim(f, t);
      const active = overlapsSelection(sel, f, t);
      if (!active) addOp(f, f + 1, Decoration.replace({}), 1);
      else addOp(f, f + 1, Decoration.mark({ class: "cm-lp-syntax-dim" }), 1);
      addOp(f + 1, t - 1, Decoration.mark({ class: "cm-lp-code" }), 2);
      if (!active) addOp(t - 1, t, Decoration.replace({}), 3);
      else addOp(t - 1, t, Decoration.mark({ class: "cm-lp-syntax-dim" }), 3);
    }
  }

  // 4. Colored HTML highlight <mark style="background:#...">...</mark>
  {
    const re = /<mark\s+style="background:\s*([^";]+);?"\s*>([\s\S]*?)<\/mark>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = lineFrom + m.index;
      const t = f + m[0].length;
      if (isClaimed(f, t)) continue;
      claim(f, t);
      const openLen = m[0].indexOf(">") + 1;
      const closeLen = 7; // </mark>
      const active = overlapsSelection(sel, f, t);
      if (!active) addOp(f, f + openLen, Decoration.replace({}), 1);
      else addOp(f, f + openLen, Decoration.mark({ class: "cm-lp-syntax-dim" }), 1);
      addOp(f + openLen, t - closeLen, Decoration.mark({
        class: "cm-lp-mark",
        attributes: { style: `background:${m[1]}` },
      }), 2);
      if (!active) addOp(t - closeLen, t, Decoration.replace({}), 3);
      else addOp(t - closeLen, t, Decoration.mark({ class: "cm-lp-syntax-dim" }), 3);
    }
  }

  // 5. Default Obsidian highlight ==...==
  {
    const re = /==([^=\r\n]+)==/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = lineFrom + m.index;
      const t = f + m[0].length;
      if (isClaimed(f, t)) continue;
      claim(f, t);
      const active = overlapsSelection(sel, f, t);
      if (!active) addOp(f, f + 2, Decoration.replace({}), 1);
      else addOp(f, f + 2, Decoration.mark({ class: "cm-lp-syntax-dim" }), 1);
      addOp(f + 2, t - 2, Decoration.mark({ class: "cm-lp-mark is-default" }), 2);
      if (!active) addOp(t - 2, t, Decoration.replace({}), 3);
      else addOp(t - 2, t, Decoration.mark({ class: "cm-lp-syntax-dim" }), 3);
    }
  }

  // 6. Bold **...**
  {
    const re = /\*\*([^\*\r\n]+)\*\*/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = lineFrom + m.index;
      const t = f + m[0].length;
      if (isClaimed(f, t)) continue;
      claim(f, t);
      const active = overlapsSelection(sel, f, t);
      if (!active) addOp(f, f + 2, Decoration.replace({}), 1);
      else addOp(f, f + 2, Decoration.mark({ class: "cm-lp-syntax-dim" }), 1);
      addOp(f + 2, t - 2, Decoration.mark({ class: "cm-lp-strong" }), 2);
      if (!active) addOp(t - 2, t, Decoration.replace({}), 3);
      else addOp(t - 2, t, Decoration.mark({ class: "cm-lp-syntax-dim" }), 3);
    }
  }

  // 7. Strikethrough ~~...~~
  {
    const re = /~~([^~\r\n]+)~~/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = lineFrom + m.index;
      const t = f + m[0].length;
      if (isClaimed(f, t)) continue;
      claim(f, t);
      const active = overlapsSelection(sel, f, t);
      if (!active) addOp(f, f + 2, Decoration.replace({}), 1);
      else addOp(f, f + 2, Decoration.mark({ class: "cm-lp-syntax-dim" }), 1);
      addOp(f + 2, t - 2, Decoration.mark({ class: "cm-lp-strike" }), 2);
      if (!active) addOp(t - 2, t, Decoration.replace({}), 3);
      else addOp(t - 2, t, Decoration.mark({ class: "cm-lp-syntax-dim" }), 3);
    }
  }

  // 8. Italic *...*
  {
    const re = /(?<!\*)\*([^\*\r\n]+)\*(?!\*)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = lineFrom + m.index;
      const t = f + m[0].length;
      if (isClaimed(f, t)) continue;
      claim(f, t);
      const active = overlapsSelection(sel, f, t);
      if (!active) addOp(f, f + 1, Decoration.replace({}), 1);
      else addOp(f, f + 1, Decoration.mark({ class: "cm-lp-syntax-dim" }), 1);
      addOp(f + 1, t - 1, Decoration.mark({ class: "cm-lp-em" }), 2);
      if (!active) addOp(t - 1, t, Decoration.replace({}), 3);
      else addOp(t - 1, t, Decoration.mark({ class: "cm-lp-syntax-dim" }), 3);
    }
  }

  // 9. Inline Math $...$
  {
    const re = /(?<!\$)\$([^$\r\n]+)\$(?!\$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = lineFrom + m.index;
      const t = f + m[0].length;
      if (isClaimed(f, t)) continue;
      claim(f, t);
      const active = overlapsSelection(sel, f, t);
      if (!active) addOp(f, f + 1, Decoration.replace({}), 1);
      else addOp(f, f + 1, Decoration.mark({ class: "cm-lp-syntax-dim" }), 1);
      addOp(f + 1, t - 1, Decoration.mark({ class: "cm-lp-math" }), 2);
      if (!active) addOp(t - 1, t, Decoration.replace({}), 3);
      else addOp(t - 1, t, Decoration.mark({ class: "cm-lp-syntax-dim" }), 3);
    }
  }

  // 10. Obsidian Comment %%...%%
  {
    const re = /%%([^%\r\n]+)%%/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const f = lineFrom + m.index;
      const t = f + m[0].length;
      if (isClaimed(f, t)) continue;
      claim(f, t);
      addOp(f, t, Decoration.mark({ class: "cm-lp-comment" }), 2);
    }
  }
}

// ---------- Main Controller Factory ----------

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
    getPluginContextMenuItems,
    tocHostEl,
  } = opts;

  let cmView = null;
  let cmMountBox = null;
  let coverSlotBox = null;
  let orphanSlotsBox = null;
  let backlinksBox = null;
  let tocRailEl = null;
  let tocVisible = true;
  let rootHostEl = null;
  let lastDocVersionPath = "";
  let suppressDocChange = false;

  // Dynamic Compartment for live Obsidian plugin CM6 extensions (#131)
  const pluginExtCompartment = new Compartment();
  let activePluginExtensions = [];

  // Phase 1 (#126): Slash Command Menu, Selection Floating Toolbar, Floating Outline TOC
  let slashEl = null;
  let slashState = null; // { startPos, endPos, query, items, selected }
  let selBarEl = null;
  let selBarPaletteOpen = false;
  let selBarTimer = null;
  let tocTimer = null;

  const liveDecoField = StateField.define({
    create(state) {
      return buildLiveDecorations(state, opts);
    },
    update(deco, tr) {
      if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshLiveEffect))) {
        return buildLiveDecorations(tr.state, opts);
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const mdHighlightStyle = HighlightStyle.define([
    { tag: tags.heading, fontWeight: "750" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.monospace, fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)" },
  ]);

  // ---------- Editing Helpers on CodeMirror 6 ----------

  function wrapSelection(prefix, suffix = prefix, fallback = "") {
    if (!cmView) return;
    const { from, to } = cmView.state.selection.main;
    const sel = cmView.state.sliceDoc(from, to);
    const body = sel || fallback;
    const insert = `${prefix}${body}${suffix}`;
    const anchor = sel ? from + insert.length : from + prefix.length;
    const head = sel ? anchor : anchor + body.length;
    cmView.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.range(anchor, head),
    });
    cmView.focus();
  }

  function applyHighlight(swatch) {
    if (!swatch) return;
    if (swatch.kind === "eq") {
      wrapSelection("==", "==", "高亮文本");
    } else {
      wrapSelection(`<mark style="background:${swatch.bg}">`, "</mark>", "高亮文本");
    }
  }

  function clearFormatting() {
    if (!cmView) return;
    const { from, to } = cmView.state.selection.main;
    if (from === to) {
      toast("请先选中需要清除格式的文本");
      return;
    }
    const sel = cmView.state.sliceDoc(from, to);
    const cleaned = sel
      .replace(/<\/?mark(?:\s+[^>]*)?>/gi, "")
      .replace(/(\*\*|__|~~|==|%%)/g, "")
      .replace(/(?<!\*)\*([^\*\r\n]+)\*(?!\*)/g, "$1")
      .replace(/`([^`\r\n]+)`/g, "$1")
      .replace(/(?<!\$)\$([^$\r\n]+)\$(?!\$)/g, "$1");
    cmView.dispatch({
      changes: { from, to, insert: cleaned },
      selection: EditorSelection.range(from, from + cleaned.length),
    });
    cmView.focus();
  }

  function setParagraphPrefix(prefix) {
    if (!cmView) return;
    const { from, to } = cmView.state.selection.main;
    const startLine = cmView.state.doc.lineAt(from).number;
    const endLine = cmView.state.doc.lineAt(to).number;
    const changes = [];
    for (let ln = startLine; ln <= endLine; ln++) {
      const line = cmView.state.doc.line(ln);
      const stripped = line.text.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+|>\s?)/, "");
      const next = prefix ? `${prefix}${stripped}` : stripped;
      changes.push({ from: line.from, to: line.to, insert: next });
    }
    cmView.dispatch({ changes });
    cmView.focus();
  }

  function insertBlockSnippet(snippet) {
    if (!cmView) return;
    const { to } = cmView.state.selection.main;
    const line = cmView.state.doc.lineAt(to);
    const prefix = line.text.trim() ? "\n\n" : "";
    const insert = `${prefix}${snippet}\n`;
    const pos = line.to;
    cmView.dispatch({
      changes: { from: pos, to: pos, insert },
      selection: { anchor: pos + prefix.length + snippet.length },
      scrollIntoView: true,
    });
    cmView.focus();
  }

  function openExternalLinkModal() {
    if (!cmView) return;
    const { from, to } = cmView.state.selection.main;
    const sel = cmView.state.sliceDoc(from, to).trim();
    const isUrl = /^https?:\/\//i.test(sel);
    const labelIn = el("input", { class: "input", value: isUrl ? "" : sel, placeholder: "链接显示文字" });
    const urlIn = el("input", { class: "input mono", value: isUrl ? sel : "https://", placeholder: "https://example.com" });
    const submit = () => {
      const u = urlIn.value.trim();
      if (!u) return toast("请输入链接地址");
      const lbl = labelIn.value.trim() || u;
      const insert = `[${lbl}](${u})`;
      cmView.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
      closeModal();
      cmView.focus();
    };
    urlIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    showModal("添加外部链接", el("div", { class: "col", style: { gap: "10px" } },
      el("div", { class: "field" }, el("label", null, "显示文字"), labelIn),
      el("div", { class: "field" }, el("label", null, "链接 URL"), urlIn)
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", { type: "button", class: "btn btn-primary", onClick: submit }, "插入链接"),
    ]);
    (isUrl ? labelIn : urlIn).focus();
  }

  function openEditorContextMenu(ev) {
    if (!cmView) return;
    const sourcePath = getActivePath() || "";
    const { from, to } = cmView.state.selection.main;
    const hasSel = to > from;
    const selText = hasSel ? cmView.state.sliceDoc(from, to) : "";
    const activeLine = cmView.state.doc.lineAt(to);
    const aiTargetText = selText.trim() || activeLine.text.trim();

    // Check if right-clicked directly on a wikilink widget
    const wikiEl = ev.target?.closest?.(".cm-lp-wikilink");
    const items = [];

    if (wikiEl) {
      const target = wikiEl.dataset.target || wikiEl.textContent?.trim() || "";
      const wFrom = Number(wikiEl.dataset.from || 0);
      const resolved = linksCtrl.resolveLocalTarget(target, sourcePath);
      items.push(
        { header: `双链：${target}` },
        {
          icon: "↗",
          label: resolved?.kind === "note" ? "打开此笔记" : "一键新建并打开",
          onClick: () => linksCtrl.navigateToLink(target, sourcePath),
        },
        resolved?.kind === "note" ? {
          icon: "📑",
          label: "在新标签页打开",
          onClick: () => onOpenNoteNewTab?.(resolved.item.path),
        } : null,
        {
          icon: "✎",
          label: "编辑双链文字",
          onClick: () => {
            cmView.dispatch({ selection: { anchor: wFrom + 2 } });
            cmView.focus();
          },
        },
        resolved?.kind === "note" ? {
          icon: "🕸",
          label: "查看该笔记局部图谱",
          onClick: () => linksCtrl.openGraphModal("local", resolved.item.path),
        } : null,
        {
          icon: "📋",
          label: `复制 [[${target}]]`,
          onClick: () => {
            navigator.clipboard?.writeText(`[[${target}]]`).catch(() => {});
            toast(`已复制 [[${target}]]`);
          },
        },
        { sep: true }
      );
    }

    // Top Obsidian Link Actions
    items.push(
      {
        icon: "🔗",
        label: hasSel ? "转为内部双链" : "添加内部双链",
        shortcut: "[[",
        onClick: () => linksCtrl.triggerInsertWikilinkCM(cmView, false),
      },
      {
        icon: "🌐",
        label: "添加外部链接",
        shortcut: "Ctrl+K",
        onClick: () => openExternalLinkModal(),
      },
      { sep: true },

      // Format > (with 3rd-level Highlight color palette — matches Obsidian screenshot!)
      {
        icon: "🖌",
        label: "格式 (Format)",
        children: [
          { icon: "B", label: "加粗", shortcut: "Ctrl+B", onClick: () => wrapSelection("**", "**", "加粗文本") },
          { icon: "I", label: "斜体", shortcut: "Ctrl+I", onClick: () => wrapSelection("*", "*", "斜体文本") },
          { icon: "S", label: "删除线", onClick: () => wrapSelection("~~", "~~", "删除线文本") },
          {
            icon: "🖍",
            label: "高亮 (Highlight)",
            children: HIGHLIGHT_SWATCHES.map((sw) => ({
              swatch: sw.id === "default" ? undefined : sw.swatch,
              icon: sw.id === "default" ? "🖍" : undefined,
              label: sw.label,
              onClick: () => applyHighlight(sw),
            })),
          },
          { sep: true },
          { icon: "</>", label: "行内代码", onClick: () => wrapSelection("`", "`", "code") },
          { icon: "Σ", label: "行内公式", onClick: () => wrapSelection("$", "$", "E = mc^2") },
          { icon: "%", label: "注释 (%%)", onClick: () => wrapSelection("%% ", " %%", "仅编辑可见注释") },
          { sep: true },
          { icon: "🧹", label: "清除格式", disabled: !hasSel, onClick: () => clearFormatting() },
        ],
      },

      // Paragraph >
      {
        icon: "¶",
        label: "段落 (Paragraph)",
        children: [
          { icon: "H1", label: "一级标题", onClick: () => setParagraphPrefix("# ") },
          { icon: "H2", label: "二级标题", onClick: () => setParagraphPrefix("## ") },
          { icon: "H3", label: "三级标题", onClick: () => setParagraphPrefix("### ") },
          { icon: "H4", label: "四级标题", onClick: () => setParagraphPrefix("#### ") },
          { sep: true },
          { icon: "•", label: "无序列表", onClick: () => setParagraphPrefix("- ") },
          { icon: "1.", label: "有序列表", onClick: () => setParagraphPrefix("1. ") },
          { icon: "☑", label: "任务列表", onClick: () => setParagraphPrefix("- [ ] ") },
          { sep: true },
          { icon: "❝", label: "引用块", onClick: () => setParagraphPrefix("> ") },
          { icon: "📄", label: "普通正文", onClick: () => setParagraphPrefix("") },
        ],
      },

      // Insert >
      {
        icon: "≡+",
        label: "插入 (Insert)",
        children: [
          {
            icon: "⊞",
            label: "Markdown 表格",
            onClick: () => insertBlockSnippet("| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |"),
          },
          {
            icon: "💡",
            label: "提示框 (Callout)",
            children: [
              { icon: "📝", label: "说明 (Note)", onClick: () => insertBlockSnippet("> [!NOTE] 说明\n> 在此输入说明内容") },
              { icon: "💡", label: "提示 (Tip)", onClick: () => insertBlockSnippet("> [!TIP] 提示\n> 在此输入实用建议") },
              { icon: "📌", label: "重要 (Important)", onClick: () => insertBlockSnippet("> [!IMPORTANT] 重要\n> 在此强调关键结论") },
              { icon: "⚠️", label: "注意 (Warning)", onClick: () => insertBlockSnippet("> [!WARNING] 注意\n> 在此提示潜在风险") },
              { icon: "🚨", label: "警示 (Caution)", onClick: () => insertBlockSnippet("> [!CAUTION] 警示\n> 在此提醒关键坑点") },
              { icon: "❝", label: "引用 (Quote)", onClick: () => insertBlockSnippet("> [!QUOTE] 引用\n> 在此引用原话") },
            ],
          },
          { icon: "—", label: "分割线", onClick: () => insertBlockSnippet("---") },
          { icon: "</>", label: "代码块", onClick: () => insertBlockSnippet("```text\n\n```") },
          { icon: "Σ", label: "数学公式块", onClick: () => insertBlockSnippet("$$\n\n$$") },
          {
            icon: "🏷",
            label: "文档属性 (YAML)",
            onClick: () => {
              const cur = cmView.state.doc.toString();
              if (cur.startsWith("---\n")) {
                cmView.dispatch({ selection: { anchor: 4 }, scrollIntoView: true });
                cmView.focus();
                return;
              }
              const fm = "---\ntags: []\n---\n\n";
              cmView.dispatch({ changes: { from: 0, to: 0, insert: fm }, selection: { anchor: 11 } });
              cmView.focus();
            },
          },
          { sep: true },
          { icon: "📎", label: "嵌入笔记 / 图片 (![[…]])", onClick: () => linksCtrl.triggerInsertWikilinkCM(cmView, true) },
          { icon: "🎨", label: "AI 配图位", onClick: () => insertSlotAt(activeLine.text.trim()) },
        ],
      },

      // AI Assistant >
      {
        icon: "✨",
        label: "AI 写作助手",
        children: [
          {
            icon: "✨",
            label: hasSel ? "改写选中片段" : "改写当前段落",
            disabled: !aiTargetText,
            onClick: () => onAskAiSelection?.(aiTargetText, "edit"),
          },
          {
            icon: "💬",
            label: hasSel ? "诊断 / 提问这段" : "诊断当前段落",
            disabled: !aiTargetText,
            onClick: () => onAskAiSelection?.(aiTargetText, "advise"),
          },
          { sep: true },
          {
            icon: "📄",
            label: "提取选中为新笔记并转双链…",
            disabled: !hasSel || selText.trim().length < 2,
            onClick: async () => {
              const title = await onExtractSelectionToNote?.(selText.trim());
              if (title && cmView) {
                const insert = `[[${title}]]`;
                cmView.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
              }
            },
          },
        ],
      },

      { sep: true },

      // Standard Clipboard Section (matches Obsidian screenshot!)
      {
        icon: "✂",
        label: "剪切",
        shortcut: "Ctrl+X",
        disabled: !hasSel,
        onClick: () => {
          navigator.clipboard?.writeText(selText).catch(() => {});
          cmView.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } });
          cmView.focus();
        },
      },
      {
        icon: "📋",
        label: "复制",
        shortcut: "Ctrl+C",
        disabled: !hasSel,
        onClick: () => {
          navigator.clipboard?.writeText(selText).catch(() => {});
          toast("已复制选中文本");
          cmView.focus();
        },
      },
      {
        icon: "📥",
        label: "粘贴",
        shortcut: "Ctrl+V",
        onClick: async () => {
          try {
            const clip = await navigator.clipboard.readText();
            if (clip) {
              cmView.dispatch({ changes: { from, to, insert: clip }, selection: { anchor: from + clip.length } });
            }
          } catch {
            toast("请使用 Ctrl+V 粘贴");
          }
          cmView.focus();
        },
      },
      {
        icon: "📄",
        label: "粘贴为纯文本",
        shortcut: "Ctrl+Shift+V",
        onClick: async () => {
          try {
            const clip = await navigator.clipboard.readText();
            if (clip) {
              const plain = clip.replace(/\r\n/g, "\n").replace(/<[^>]+>/g, "");
              cmView.dispatch({ changes: { from, to, insert: plain }, selection: { anchor: from + plain.length } });
            }
          } catch {
            toast("请使用 Ctrl+Shift+V 粘贴纯文本");
          }
          cmView.focus();
        },
      },
      {
        icon: "☐",
        label: "全选",
        shortcut: "Ctrl+A",
        onClick: () => {
          cmView.dispatch({ selection: EditorSelection.range(0, cmView.state.doc.length) });
          cmView.focus();
        },
      }
    );

    // Append Obsidian plugin "editor-menu" items (#133)
    const pluginMenuItems = typeof getPluginContextMenuItems === "function" ? (getPluginContextMenuItems() || []) : [];
    if (pluginMenuItems.length > 0) {
      items.push({ sep: true }, { header: "Obsidian 插件" }, ...pluginMenuItems);
    }

    openArticleContextMenu(ev, items);
  }

  // ---------- Phase 1 (#126): Slash Command "/" Popup ----------
  function closeSlashMenu() {
    if (slashEl) { slashEl.remove(); slashEl = null; }
    slashState = null;
  }

  const SLASH_COMMANDS = [
    { group: "基础排版", icon: "H1", label: "一级标题", hint: "# ", kw: "h1 title heading 标题 一级", run: () => setParagraphPrefix("# ") },
    { group: "基础排版", icon: "H2", label: "二级标题", hint: "## ", kw: "h2 subtitle heading 标题 二级", run: () => setParagraphPrefix("## ") },
    { group: "基础排版", icon: "H3", label: "三级标题", hint: "### ", kw: "h3 heading 标题 三级", run: () => setParagraphPrefix("### ") },
    { group: "基础排版", icon: "☑", label: "任务清单", hint: "- [ ]", kw: "todo task check 待办 任务 清单", run: () => setParagraphPrefix("- [ ] ") },
    { group: "基础排版", icon: "•", label: "无序列表", hint: "- ", kw: "ul bullet list 列表 无序", run: () => setParagraphPrefix("- ") },
    { group: "基础排版", icon: "❝", label: "引用块", hint: "> ", kw: "quote blockquote 引用", run: () => setParagraphPrefix("> ") },
    { group: "结构块", icon: "⊞", label: "Markdown 表格", hint: "3×2", kw: "table 表格 gfm", run: () => insertBlockSnippet("| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |") },
    { group: "结构块", icon: "💡", label: "提示框 (Tip Callout)", hint: "[!TIP]", kw: "callout tip 提示 提示框 标注", run: () => insertBlockSnippet("> [!TIP] 提示\n> 在此输入实用要点") },
    { group: "结构块", icon: "⚠️", label: "注意框 (Warning)", hint: "[!WARNING]", kw: "callout warn warning 注意 风险 坑点", run: () => insertBlockSnippet("> [!WARNING] 注意\n> 在此提示关键风险或避坑点") },
    { group: "结构块", icon: "</>", label: "代码块", hint: "```", kw: "code fence 代码 代码块", run: () => insertBlockSnippet("```text\n\n```") },
    { group: "结构块", icon: "Σ", label: "数学公式块", hint: "$$", kw: "math latex 公式 数学", run: () => insertBlockSnippet("$$\n\n$$") },
    { group: "结构块", icon: "—", label: "分割线", hint: "---", kw: "hr divider line 分割线 横线", run: () => insertBlockSnippet("---") },
    { group: "双链与手绘风 AI", icon: "🔗", label: "插入内部双链", hint: "[[…]]", kw: "link wikilink 双链 链接 笔记", run: () => linksCtrl.triggerInsertWikilinkCM(cmView, false) },
    { group: "双链与手绘风 AI", icon: "📎", label: "嵌入笔记 / 图片", hint: "![[…]]", kw: "embed image 嵌入 图片", run: () => linksCtrl.triggerInsertWikilinkCM(cmView, true) },
    { group: "双链与手绘风 AI", icon: "🎨", label: "插入 AI 配图位", hint: "Slot", kw: "illust image ai 配图 插图 画图", run: () => {
      const ln = cmView ? cmView.state.doc.lineAt(cmView.state.selection.main.to).text.trim() : "";
      insertSlotAt(ln);
    } },
    { group: "双链与手绘风 AI", icon: "✨", label: "让 AI 续写 / 润色当前段", hint: "AI", kw: "ai write continue 续写 润色 改写", run: () => {
      const ln = cmView ? cmView.state.doc.lineAt(cmView.state.selection.main.to).text.trim() : "";
      onAskAiSelection?.(ln || "请结合上下文续写下一段内容", "edit");
    } },
  ];

  function applySlashItem(item) {
    if (!slashState || !cmView) return;
    const { startPos, endPos } = slashState;
    closeSlashMenu();
    cmView.dispatch({
      changes: { from: startPos, to: endPos, insert: "" },
      selection: { anchor: startPos },
    });
    item.run?.();
    cmView.focus();
  }

  function renderSlashMenu() {
    if (!slashState || !cmView) { closeSlashMenu(); return; }
    if (!slashEl) {
      slashEl = el("div", { class: "ic-slash-menu", role: "listbox", "aria-label": "斜杠快捷插入菜单" });
      document.body.appendChild(slashEl);
    }
    clear(slashEl);
    slashEl.appendChild(el("div", { class: "ic-slash-head" },
      el("span", null, slashState.query ? `命令筛选：/${slashState.query}` : "输入关键词筛选块或 AI 指令"),
      el("span", { class: "muted", style: { fontSize: "10.5px" } }, "↑↓ · Enter")
    ));
    const list = el("div", { class: "ic-slash-list" });
    let lastGroup = "";
    let selNode = null;
    slashState.items.forEach((it, idx) => {
      if (it.group !== lastGroup) {
        lastGroup = it.group;
        list.appendChild(el("div", { class: "ic-slash-group" }, it.group));
      }
      const row = el("button", {
        type: "button",
        role: "option",
        class: "ic-slash-item" + (idx === slashState.selected ? " is-selected" : ""),
        onMouseDown: (ev) => {
          ev.preventDefault();
          applySlashItem(it);
        },
        onMouseEnter: () => {
          slashState.selected = idx;
          Array.from(list.querySelectorAll(".ic-slash-item")).forEach((n, i) => n.classList.toggle("is-selected", i === idx));
        },
      },
        el("span", { class: "ic-slash-ico", "aria-hidden": "true" }, it.icon),
        el("span", { class: "ic-slash-lbl" }, it.label),
        it.hint ? el("span", { class: "ic-slash-hint mono" }, it.hint) : null
      );
      if (idx === slashState.selected) selNode = row;
      list.appendChild(row);
    });
    slashEl.appendChild(list);

    const coords = cmView.coordsAtPos(slashState.endPos);
    const popW = slashEl.offsetWidth || 292;
    const popH = Math.min(330, slashEl.offsetHeight || 160);
    const left = coords ? Math.max(12, Math.min(coords.left, window.innerWidth - popW - 14)) : 140;
    const top = coords
      ? (coords.bottom + popH + 10 > window.innerHeight - 16 ? Math.max(48, coords.top - popH - 6) : Math.max(48, coords.bottom + 6))
      : 160;
    slashEl.style.left = `${Math.round(left)}px`;
    slashEl.style.top = `${Math.round(top)}px`;
    if (selNode) selNode.scrollIntoView({ block: "nearest" });
  }

  function updateSlashMenu(view) {
    if (!view) { closeSlashMenu(); return; }
    const sel = view.state.selection.main;
    if (!sel.empty) { closeSlashMenu(); return; }
    const pos = sel.head;
    const line = view.state.doc.lineAt(pos);
    const before = line.text.slice(0, pos - line.from);
    // Avoid triggering inside URLs or code fences
    if (/https?:\/\/\S*$/.test(before)) { closeSlashMenu(); return; }
    const m = before.match(/(?:^|\s)(\/[^\s/]{0,20})$/);
    if (!m) { closeSlashMenu(); return; }
    const token = m[1];
    const query = token.slice(1).trim().toLowerCase();
    const startPos = pos - token.length;
    const filtered = query
      ? SLASH_COMMANDS.filter((c) => `${c.label} ${c.kw} ${c.group}`.toLowerCase().includes(query))
      : SLASH_COMMANDS;
    if (!filtered.length) { closeSlashMenu(); return; }
    slashState = {
      startPos,
      endPos: pos,
      query,
      items: filtered,
      selected: slashState && slashState.startPos === startPos ? Math.min(slashState.selected, filtered.length - 1) : 0,
    };
    renderSlashMenu();
  }

  function handleSlashKeydown(ev) {
    if (!slashState) return false;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      slashState.selected = (slashState.selected + 1) % slashState.items.length;
      renderSlashMenu();
      return true;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      slashState.selected = (slashState.selected - 1 + slashState.items.length) % slashState.items.length;
      renderSlashMenu();
      return true;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      applySlashItem(slashState.items[slashState.selected]);
      return true;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeSlashMenu();
      return true;
    }
    return false;
  }

  // ---------- Phase 1 (#126): Selection Floating Format & AI Toolbar ----------
  function closeSelectionBar() {
    if (selBarTimer) { clearTimeout(selBarTimer); selBarTimer = null; }
    if (selBarEl) { selBarEl.remove(); selBarEl = null; }
    selBarPaletteOpen = false;
  }

  function renderSelectionBar() {
    if (!cmView || !cmView.hasFocus) { closeSelectionBar(); return; }
    const { from, to } = cmView.state.selection.main;
    if (to - from < 2) { closeSelectionBar(); return; }
    const selText = cmView.state.sliceDoc(from, to).trim();
    if (selText.length < 2) { closeSelectionBar(); return; }
    if (document.querySelector(".ic-ctx-menu")) { closeSelectionBar(); return; }

    const startCoords = cmView.coordsAtPos(from);
    const endCoords = cmView.coordsAtPos(to);
    if (!startCoords || !endCoords) { closeSelectionBar(); return; }

    if (!selBarEl) {
      selBarEl = el("div", { class: "ic-cm-selbar", role: "toolbar", "aria-label": "划词快捷格式与 AI 工具条" });
      document.body.appendChild(selBarEl);
    }
    clear(selBarEl);

    const mkBtn = (label, title, onClick, cls = "") => el("button", {
      type: "button",
      class: "ic-cm-selbar-btn" + (cls ? ` ${cls}` : ""),
      title,
      onMouseDown: (ev) => ev.preventDefault(),
      onClick: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
      },
    }, label);

    const row = el("div", { class: "ic-cm-selbar-row" },
      mkBtn("B", "加粗 (Ctrl+B)", () => { wrapSelection("**", "**"); closeSelectionBar(); }, "is-bold"),
      mkBtn("I", "斜体 (Ctrl+I)", () => { wrapSelection("*", "*"); closeSelectionBar(); }, "is-italic"),
      mkBtn("S", "删除线", () => { wrapSelection("~~", "~~"); closeSelectionBar(); }, "is-strike"),
      mkBtn("</>", "行内代码", () => { wrapSelection("`", "`"); closeSelectionBar(); }),
      mkBtn("🖍", "彩色高亮", () => { selBarPaletteOpen = !selBarPaletteOpen; renderSelectionBar(); }, selBarPaletteOpen ? "is-active" : ""),
      el("span", { class: "ic-cm-selbar-sep" }),
      mkBtn("[[", "转为内部双链", () => { linksCtrl.triggerInsertWikilinkCM(cmView, false); closeSelectionBar(); }),
      mkBtn("🔗", "添加外部链接 (Ctrl+K)", () => { closeSelectionBar(); openExternalLinkModal(); }),
      el("span", { class: "ic-cm-selbar-sep" }),
      mkBtn("✨ AI 改写", "用 AI 局部改写选中片段", () => { closeSelectionBar(); onAskAiSelection?.(selText, "edit"); }, "is-accent"),
      mkBtn("💬 问 AI", "围绕选中片段提问或诊断", () => { closeSelectionBar(); onAskAiSelection?.(selText, "advise"); }),
      mkBtn("📄 提取笔记", "提取为新笔记并替换为双链", async () => {
        closeSelectionBar();
        const title = await onExtractSelectionToNote?.(selText);
        if (title && cmView) {
          const insert = `[[${title}]]`;
          cmView.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
        }
      })
    );
    selBarEl.appendChild(row);

    if (selBarPaletteOpen) {
      selBarEl.appendChild(el("div", { class: "ic-cm-selbar-palette" },
        ...HIGHLIGHT_SWATCHES.map((sw) => el("button", {
          type: "button",
          class: "ic-cm-selbar-dot",
          title: sw.label,
          style: { background: sw.swatch },
          onMouseDown: (ev) => ev.preventDefault(),
          onClick: () => { applyHighlight(sw); closeSelectionBar(); },
        }))
      ));
    }

    const rect = selBarEl.getBoundingClientRect();
    const midX = (startCoords.left + endCoords.right) / 2;
    const left = Math.max(12, Math.min(midX - rect.width / 2, window.innerWidth - rect.width - 12));
    const topAbove = Math.min(startCoords.top, endCoords.top) - rect.height - 10;
    const top = topAbove < 52 ? Math.max(startCoords.bottom, endCoords.bottom) + 10 : topAbove;
    selBarEl.style.left = `${Math.round(left)}px`;
    selBarEl.style.top = `${Math.round(top)}px`;
  }

  function scheduleSelectionBar() {
    if (selBarTimer) clearTimeout(selBarTimer);
    selBarTimer = setTimeout(() => renderSelectionBar(), 80);
  }

  // ---------- Phase 1 (#126): Minimalist Floating Outline TOC Rail ----------
  function renderTocRail() {
    if (!tocRailEl || !cmView) return;
    clear(tocRailEl);
    const doc = cmView.state.doc;
    const headings = [];
    let inCode = false;
    let inFm = doc.lines >= 3 && doc.line(1).text.trim() === "---";
    for (let ln = 1; ln <= doc.lines; ln++) {
      const txt = doc.line(ln).text;
      const tr = txt.trim();
      if (inFm) {
        if (ln > 1 && tr === "---") inFm = false;
        continue;
      }
      if (/^(?:`{3,}|~{3,})/.test(tr)) { inCode = !inCode; continue; }
      if (inCode) continue;
      const m = txt.match(/^\s*(#{1,4})\s+(.+)$/);
      if (m) {
        headings.push({ level: m[1].length, text: m[2].replace(/[*`[\]]/g, "").trim(), lineNo: ln, pos: doc.line(ln).from });
      }
    }
    tocRailEl.classList.toggle("hidden", !tocVisible || headings.length < 2);
    if (!tocVisible || headings.length < 2) return;

    const activeLineNo = doc.lineAt(cmView.state.selection.main.head).number;
    let activeIdx = 0;
    headings.forEach((h, i) => { if (h.lineNo <= activeLineNo) activeIdx = i; });

    const ticks = el("div", { class: "ic-live-toc-ticks", "aria-hidden": "true" },
      ...headings.map((h, i) => el("span", {
        class: `ic-live-toc-tick is-l${h.level}` + (i === activeIdx ? " is-active" : ""),
      }))
    );
    const list = el("div", { class: "ic-live-toc-pop", role: "navigation", "aria-label": "文章目录大纲" },
      el("div", { class: "ic-live-toc-title" }, `大纲 (${headings.length})`),
      ...headings.map((h, i) => el("button", {
        type: "button",
        class: `ic-live-toc-item is-l${h.level}` + (i === activeIdx ? " is-active" : ""),
        title: h.text,
        onClick: () => {
          cmView.dispatch({ selection: { anchor: h.pos }, scrollIntoView: true });
          cmView.focus();
          renderTocRail();
        },
      }, h.text))
    );
    tocRailEl.append(ticks, list);
  }

  function scheduleTocRender() {
    if (tocTimer) clearTimeout(tocTimer);
    tocTimer = setTimeout(() => renderTocRail(), 160);
  }

  function createCMState(initialText) {
    const docStr = String(initialText || "");
    // If note starts with YAML frontmatter, place initial cursor on the first body line so Properties renders cleanly collapsed!
    let initAnchor = 0;
    const fmMatch = docStr.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)*/);
    if (fmMatch && fmMatch[0].length < docStr.length) {
      initAnchor = fmMatch[0].length;
    }
    return EditorState.create({
      doc: docStr,
      selection: { anchor: initAnchor },
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        EditorView.lineWrapping,
        placeholder("开始自由书写（所见即所得，输入 / 唤起快捷命令，输入 [[ 关联笔记）…"),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(mdHighlightStyle),
        liveDecoField,
        pluginExtCompartment.of(activePluginExtensions),
        Prec.highest(keymap.of([
          {
            key: "ArrowDown",
            run: (view) => {
              if (slashState) {
                slashState.selected = (slashState.selected + 1) % slashState.items.length;
                renderSlashMenu();
                return true;
              }
              return linksCtrl.handleCMKeydown(view, { key: "ArrowDown", preventDefault() {} });
            },
          },
          {
            key: "ArrowUp",
            run: (view) => {
              if (slashState) {
                slashState.selected = (slashState.selected - 1 + slashState.items.length) % slashState.items.length;
                renderSlashMenu();
                return true;
              }
              return linksCtrl.handleCMKeydown(view, { key: "ArrowUp", preventDefault() {} });
            },
          },
          {
            key: "Enter",
            run: (view) => {
              if (slashState) {
                applySlashItem(slashState.items[slashState.selected]);
                return true;
              }
              return linksCtrl.handleCMKeydown(view, { key: "Enter", preventDefault() {} });
            },
          },
          {
            key: "Tab",
            run: (view) => {
              if (slashState) {
                applySlashItem(slashState.items[slashState.selected]);
                return true;
              }
              return linksCtrl.handleCMKeydown(view, { key: "Tab", preventDefault() {} });
            },
          },
          {
            key: "Escape",
            run: (view) => {
              if (slashState) { closeSlashMenu(); return true; }
              if (linksCtrl.handleCMKeydown(view, { key: "Escape", preventDefault() {} })) return true;
              if (selBarEl) { closeSelectionBar(); return true; }
              return false;
            },
          },
          {
            key: "Mod-b",
            run: () => { wrapSelection("**", "**", "加粗文本"); return true; },
          },
          {
            key: "Mod-i",
            run: () => { wrapSelection("*", "*", "斜体文本"); return true; },
          },
          {
            key: "Mod-k",
            run: () => { openExternalLinkModal(); return true; },
          },
          {
            key: "Mod-Shift-h",
            run: () => { wrapSelection("==", "==", "高亮文本"); return true; },
          },
        ])),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.domEventHandlers({
          mouseup: () => { scheduleSelectionBar(); return false; },
          blur: () => {
            setTimeout(() => {
              if (cmView && !cmView.hasFocus) closeSelectionBar();
            }, 150);
            return false;
          },
          contextmenu: (ev) => {
            closeSelectionBar();
            closeSlashMenu();
            openEditorContextMenu(ev);
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressDocChange) {
            setContent(update.state.doc.toString());
            linksCtrl.updateAutocompleteFromCM(update.view);
            updateSlashMenu(update.view);
            closeSelectionBar();
            scheduleTocRender();
          } else if (update.selectionSet) {
            linksCtrl.updateAutocompleteFromCM(update.view);
            updateSlashMenu(update.view);
            if (update.state.selection.main.empty) closeSelectionBar();
            else scheduleSelectionBar();
            scheduleTocRender();
          }
        }),
      ],
    });
  }

  function renderAuxiliaryRegions() {
    const slots = getSlots() || [];
    const coverSlot = slots.find((s) => s.role === "cover");
    const inlineSlots = slots.filter((s) => s.role !== "cover");
    const content = getContent() || "";

    if (coverSlotBox) {
      clear(coverSlotBox);
      if (coverSlot) {
        coverSlotBox.appendChild(renderSlotCard(coverSlot, 0, "固定在文章开头"));
      } else {
        coverSlotBox.appendChild(el("div", { class: "ic-art-gap" },
          el("button", { type: "button", class: "ic-art-gap-btn", onClick: () => insertSlotAt("", "cover") }, "＋ 添加文章封面")
        ));
      }
    }

    if (orphanSlotsBox) {
      clear(orphanSlotsBox);
      const orphans = inlineSlots.filter((sl) => !sl.anchor || !content.includes(sl.anchor));
      orphans.forEach((sl, idx) => {
        orphanSlotsBox.appendChild(renderSlotCard(sl, inlineSlots.length - orphans.length + idx + 1, sl.anchor ? `原位置「${sl.anchor.slice(0, 20)}」未匹配` : "尚未绑定段落", true));
      });
    }

    if (backlinksBox) {
      clear(backlinksBox);
      linksCtrl.renderPreviewBacklinksFooter(backlinksBox);
    }
  }

  function render(container) {
    if (!container) return;
    rootHostEl = container;
    const rawContent = getContent() || "";
    const curPath = getActivePath() || "";

    // Reuse existing mounted CodeMirror 6 view whenever possible so cursor & undo history stay 100% intact!
    if (cmView && cmMountBox && cmMountBox.isConnected && container.contains(cmMountBox)) {
      const sameText = cmView.state.doc.toString() === rawContent;
      if (!sameText || curPath !== lastDocVersionPath) {
        suppressDocChange = true;
        cmView.setState(createCMState(rawContent));
        suppressDocChange = false;
        lastDocVersionPath = curPath;
      } else {
        cmView.dispatch({ effects: refreshLiveEffect.of(null) });
      }
      renderAuxiliaryRegions();
      renderTocRail();
      return;
    }

    // Fresh mount inside container
    if (cmView) {
      cmView.destroy();
      cmView = null;
    }
    clear(container);
    coverSlotBox = el("div", { class: "cm-lp-cover-box" });
    cmMountBox = el("div", { class: "cm-lp-host" });
    orphanSlotsBox = el("div", { class: "cm-lp-orphans" });
    backlinksBox = el("div", { class: "cm-lp-backlinks" });
    if (tocRailEl && tocRailEl.isConnected) tocRailEl.remove();
    tocRailEl = el("div", { class: "ic-live-toc-rail hidden" });
    container.append(coverSlotBox, cmMountBox, orphanSlotsBox, backlinksBox);
    (tocHostEl || container).appendChild(tocRailEl);

    lastDocVersionPath = curPath;
    cmView = new EditorView({
      state: createCMState(rawContent),
      parent: cmMountBox,
    });
    renderAuxiliaryRegions();
    renderTocRail();
  }

  function applyFormat(fmt) {
    if (!cmView) return false;
    if (fmt === "wikilink") { linksCtrl.triggerInsertWikilinkCM(cmView, false); return true; }
    if (fmt === "h1") { setParagraphPrefix("# "); return true; }
    if (fmt === "h2") { setParagraphPrefix("## "); return true; }
    if (fmt === "h3") { setParagraphPrefix("### "); return true; }
    if (fmt === "quote") { setParagraphPrefix("> "); return true; }
    if (fmt === "ul") { setParagraphPrefix("- "); return true; }
    if (fmt === "ol") { setParagraphPrefix("1. "); return true; }
    if (fmt === "hr") { insertBlockSnippet("---"); return true; }
    if (fmt === "bold") { wrapSelection("**", "**", "加粗文本"); return true; }
    if (fmt === "italic") { wrapSelection("*", "*", "斜体文本"); return true; }
    if (fmt === "code") { wrapSelection("`", "`", "code"); return true; }
    return false;
  }

  function resetEditing() {
    lastDocVersionPath = "__reset__";
  }

  function getActiveTextarea() {
    return cmView ? cmView.contentDOM : null;
  }

  function getSelectionRange() {
    if (!cmView) return { start: 0, end: 0 };
    const { from, to } = cmView.state.selection.main;
    return { start: from, end: to };
  }

  function setTocVisible(flag) {
    tocVisible = Boolean(flag);
    if (tocRailEl) {
      if (!tocVisible) tocRailEl.classList.add("hidden");
      else renderTocRail();
    }
  }

  function setPluginExtensions(entries) {
    const appliedCounts = new Map();
    const errors = new Map();
    const validEntries = [];

    for (const entry of entries || []) {
      const pluginId = entry?.pluginId;
      const rawList = Array.isArray(entry?.extensions) ? entry.extensions.filter(Boolean) : [];
      if (!pluginId || !rawList.length) continue;

      const pluginValid = [];
      const pluginErrs = [];
      for (const ext of rawList) {
        try {
          // Dry-run validate extension structure against the exact singleton EditorState
          EditorState.create({ doc: "", extensions: [ext] });
          pluginValid.push(ext);
        } catch (err) {
          pluginErrs.push(err?.message || String(err));
        }
      }
      if (pluginValid.length) {
        validEntries.push({ pluginId, extensions: pluginValid });
        appliedCounts.set(pluginId, pluginValid.length);
      }
      if (pluginErrs.length) {
        errors.set(pluginId, `CM6 扩展校验失败：${pluginErrs[0]}`);
      }
    }

    const flatValid = validEntries.flatMap((e) => e.extensions);
    activePluginExtensions = flatValid;

    if (cmView) {
      try {
        cmView.dispatch({ effects: pluginExtCompartment.reconfigure(flatValid) });
      } catch (batchErr) {
        // Isolate a crashing ViewPlugin/mount-time extension so the live editor never breaks
        const safeFlat = [];
        appliedCounts.clear();
        for (const ve of validEntries) {
          const candidate = [...safeFlat, ...ve.extensions];
          try {
            cmView.dispatch({ effects: pluginExtCompartment.reconfigure(candidate) });
            safeFlat.push(...ve.extensions);
            appliedCounts.set(ve.pluginId, ve.extensions.length);
          } catch (mountErr) {
            errors.set(ve.pluginId, `CM6 扩展挂载异常：${mountErr?.message || String(mountErr)}`);
            try {
              cmView.dispatch({ effects: pluginExtCompartment.reconfigure(safeFlat) });
            } catch {}
          }
        }
        activePluginExtensions = safeFlat;
        if (!errors.size) {
          console.warn("[article-live] CM6 plugin reconfigure fallback:", batchErr);
        }
      }
    }

    return { appliedCounts, errors };
  }

  function getEditorView() {
    return cmView;
  }

  function dispose() {
    closeSlashMenu();
    closeSelectionBar();
    if (tocTimer) { clearTimeout(tocTimer); tocTimer = null; }
    if (tocRailEl) { tocRailEl.remove(); tocRailEl = null; }
    if (cmView) {
      cmView.destroy();
      cmView = null;
    }
  }

  return {
    render,
    applyFormat,
    resetEditing,
    getActiveTextarea,
    getSelectionRange,
    setTocVisible,
    setPluginExtensions,
    getEditorView,
    dispose,
  };
}
