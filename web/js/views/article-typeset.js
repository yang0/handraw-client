import { clear, el, getToken, localImg, toast } from "../api.js";

const STORAGE_KEY = "handraw-article-typeset-v1";

export const TYPESET_THEMES = [
  {
    id: "editorial_paper",
    name: "暖纸社论",
    desc: "手绘风招牌 · 暖纸底色 + 朱红竖标",
    accent: "#c84b31",
    bg: "#fffdf9",
    text: "#2c2825",
    muted: "#736b63",
    quoteBg: "#f9f4ec",
    tableHeadBg: "#f6efe5",
    border: "#e6ddd0",
    codeBg: "#282421",
    codeText: "#f3ece2",
    headingStyle: "bar",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  },
  {
    id: "minimal_ink",
    name: "极简黑金",
    desc: "深度专栏 · 居中底线 + 克制黑白",
    accent: "#1f1f1f",
    bg: "#ffffff",
    text: "#262626",
    muted: "#737373",
    quoteBg: "#f7f7f7",
    tableHeadBg: "#f2f2f2",
    border: "#e5e5e5",
    codeBg: "#1e1e1e",
    codeText: "#e8e8e8",
    headingStyle: "center",
    fontFamily: "'Songti SC', 'Noto Serif SC', Georgia, 'PingFang SC', serif",
  },
  {
    id: "tech_indigo",
    name: "科技靛蓝",
    desc: "AI 干货教程 · 靛蓝胶囊 + 清晰数据表",
    accent: "#4f46e5",
    bg: "#ffffff",
    text: "#1f2937",
    muted: "#6b7280",
    quoteBg: "#f3f4fe",
    tableHeadBg: "#eef2ff",
    border: "#e0e7ff",
    codeBg: "#181a27",
    codeText: "#e5e9f8",
    headingStyle: "pill",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    id: "magazine_red",
    name: "红刊深度",
    desc: "商业杂志 · 醒目朱红顶线 + 强节奏",
    accent: "#d93829",
    bg: "#ffffff",
    text: "#222222",
    muted: "#666666",
    quoteBg: "#fff5f4",
    tableHeadBg: "#fdecea",
    border: "#f3d5d1",
    codeBg: "#231f20",
    codeText: "#f5eceb",
    headingStyle: "underline",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    id: "forest_journal",
    name: "墨绿手账",
    desc: "文艺随笔 · 森绿柔标 + 温润阅读感",
    accent: "#2e6f56",
    bg: "#fcfdf9",
    text: "#26332d",
    muted: "#64756d",
    quoteBg: "#eff6f2",
    tableHeadBg: "#e6f2ec",
    border: "#d4e5dc",
    codeBg: "#1d2924",
    codeText: "#e4f0ea",
    headingStyle: "bar",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    id: "amber_book",
    name: "暖杏书摘",
    desc: "读书复盘 · 琥珀金线 + 便签引用",
    accent: "#c4791d",
    bg: "#fffcf7",
    text: "#33291e",
    muted: "#7c6b58",
    quoteBg: "#fdf5e6",
    tableHeadBg: "#faedd6",
    border: "#eddcc0",
    codeBg: "#28221b",
    codeText: "#f7efe3",
    headingStyle: "bar",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    id: "slate_brief",
    name: "青灰研报",
    desc: "行业账本 · 沉稳青灰 + 紧凑表格",
    accent: "#3b5978",
    bg: "#ffffff",
    text: "#242c35",
    muted: "#64748b",
    quoteBg: "#f3f6f9",
    tableHeadBg: "#eaf0f6",
    border: "#d8e2ec",
    codeBg: "#1c242d",
    codeText: "#e3ecf5",
    headingStyle: "underline",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    id: "violet_creative",
    name: "丁香创意",
    desc: "设计师/IP · 柔和紫罗兰 + 圆润层次",
    accent: "#7c3aed",
    bg: "#ffffff",
    text: "#2b2538",
    muted: "#6d6482",
    quoteBg: "#f6f2ff",
    tableHeadBg: "#efe9fe",
    border: "#e2d7fd",
    codeBg: "#211c2e",
    codeText: "#eee8fc",
    headingStyle: "pill",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    id: "ocean_clean",
    name: "海盐清爽",
    desc: "效率指南 · 清透天蓝 + 极易扫读",
    accent: "#0284c7",
    bg: "#ffffff",
    text: "#1e293b",
    muted: "#64748b",
    quoteBg: "#f0f9ff",
    tableHeadBg: "#e0f2fe",
    border: "#bae6fd",
    codeBg: "#172330",
    codeText: "#e0f2fe",
    headingStyle: "bar",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    id: "classic_wechat",
    name: "微信经典绿",
    desc: "微信原生 · 零花哨最稳妥",
    accent: "#07c160",
    bg: "#ffffff",
    text: "#333333",
    muted: "#888888",
    quoteBg: "#f4fbf7",
    tableHeadBg: "#edf9f2",
    border: "#d9efe2",
    codeBg: "#222624",
    codeText: "#eaf3ee",
    headingStyle: "bar",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
];

const QUICK_ACCENTS = ["#c84b31", "#4f46e5", "#07c160", "#0284c7", "#c4791d", "#7c3aed", "#1f1f1f"];

const CALLOUT_INLINE_COLORS = {
  note: { icon: "📝", label: "说明", border: "#3b6ea5", bg: "#f1f6fb" },
  info: { icon: "ℹ️", label: "信息", border: "#3b6ea5", bg: "#f1f6fb" },
  tip: { icon: "💡", label: "提示", border: "#2f7d57", bg: "#eef8f3" },
  hint: { icon: "💡", label: "提示", border: "#2f7d57", bg: "#eef8f3" },
  important: { icon: "📌", label: "重要", border: "#6b4e9b", bg: "#f5f1fb" },
  warning: { icon: "⚠️", label: "注意", border: "#b45309", bg: "#fdf6ec" },
  caution: { icon: "🚨", label: "警示", border: "#b91c1c", bg: "#fdf1f1" },
  danger: { icon: "🚨", label: "危险", border: "#b91c1c", bg: "#fdf1f1" },
  quote: { icon: "❝", label: "引用", border: "#64748b", bg: "#f5f7fa" },
};

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveImgSrc(raw, activeFile) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s) || /^data:/i.test(s)) return s;
  if (s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s)) return localImg(s);
  const q = new URLSearchParams({ path: s, from: activeFile || "", t: getToken() });
  return `/files/vault-asset?${q.toString()}`;
}

function splitTableRow(ln) {
  let s = String(ln || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const isTableSep = (ln) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(ln || "");

function renderInlineHTML(rawText, cfg, accent) {
  // Preserve explicit colored <mark style="background:#...">...</mark> spans safely before escaping
  const marks = [];
  let s = String(rawText || "").replace(/<mark\s+style="background:\s*([^";]+);?"\s*>([\s\S]*?)<\/mark>/gi, (_, bg, inner) => {
    const idx = marks.length;
    marks.push({ bg: bg.replace(/[^#a-zA-Z0-9(),.\s%-]/g, ""), inner });
    return `@@MARK_${idx}@@`;
  });

  s = escHtml(s);

  // Wikilinks [[target|alias]] -> clean text or subtle underlined accent (no ugly [[ ]] brackets in WeChat!)
  s = s.replace(/\[\[([^\[\]\r\n]+)\]\]/g, (match, inner, offset, str) => {
    if (offset > 0 && str.charCodeAt(offset - 1) === 33) return match;
    const parts = inner.split("|");
    const label = (parts[1] || parts[0] || "").trim();
    if (cfg.linkMode === "accent") {
      return `<span style="color:${accent};border-bottom:1px solid ${accent};padding-bottom:1px;">${label}</span>`;
    }
    return label;
  });

  // External links [label](url)
  s = s.replace(/\[([^\[\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, lbl, url, offset, str) => {
    if (offset > 0 && str.charCodeAt(offset - 1) === 33) return match;
    return `<a href="${url}" style="color:${accent};text-decoration:underline;">${lbl}</a>`;
  });

  // Inline code `...`
  s = s.replace(/`([^`\r\n]+)`/g, (_, code) =>
    `<code style="font-family:Menlo,Consolas,monospace;font-size:0.88em;background:${cfg.quoteBg};color:${accent};padding:2px 5px;border-radius:4px;">${code}</code>`
  );

  // Default highlight ==...==
  s = s.replace(/==([^=\r\n]+)==/g, (_, hl) =>
    `<mark style="background:#fff1a6;color:#222;padding:1px 4px;border-radius:3px;">${hl}</mark>`
  );

  // Bold **...**
  s = s.replace(/\*\*([^\*\r\n]+)\*\*/g, (_, b) =>
    `<strong style="font-weight:700;color:${cfg.text};">${b}</strong>`
  );

  // Strikethrough ~~...~~
  s = s.replace(/~~([^~\r\n]+)~~/g, (_, st) =>
    `<del style="color:${cfg.muted};">${st}</del>`
  );

  // Italic *...*
  s = s.replace(/\*([^\*\r\n]+)\*(?!\*)/g, (match, em, offset, str) => {
    if (offset > 0 && str.charCodeAt(offset - 1) === 42) return match;
    return `<em style="font-style:italic;">${em}</em>`;
  });

  // Strip Obsidian %%comments%% from published output
  s = s.replace(/%%[^%\r\n]+%%/g, "");

  // Restore colored <mark> highlights
  s = s.replace(/@@MARK_(\d+)@@/g, (_, idxStr) => {
    const item = marks[Number(idxStr)];
    if (!item) return "";
    return `<mark style="background:${item.bg};color:#222;padding:1px 4px;border-radius:3px;">${escHtml(item.inner)}</mark>`;
  });

  return s;
}

function headingInlineHTML(level, innerHTML, styleKind, accent, theme) {
  if (level === 1) {
    if (styleKind === "center") {
      return `<h1 style="margin:24px 0 16px;font-size:21px;font-weight:700;line-height:1.4;text-align:center;color:${theme.text};padding-bottom:10px;border-bottom:2px solid ${accent};">${innerHTML}</h1>`;
    }
    return `<h1 style="margin:24px 0 14px;font-size:21px;font-weight:700;line-height:1.4;color:${theme.text};padding-bottom:8px;border-bottom:1.5px solid ${theme.border};">${innerHTML}</h1>`;
  }
  if (level === 2) {
    if (styleKind === "pill") {
      return `<h2 style="margin:24px 0 12px;font-size:17px;font-weight:700;line-height:1.4;"><span style="display:inline-block;background:${accent};color:#ffffff;padding:4px 14px;border-radius:6px;">${innerHTML}</span></h2>`;
    }
    if (styleKind === "center") {
      return `<h2 style="margin:26px 0 14px;font-size:18px;font-weight:700;line-height:1.4;text-align:center;color:${theme.text};"><span style="display:inline-block;padding:0 12px 6px;border-bottom:2.5px solid ${accent};">${innerHTML}</span></h2>`;
    }
    if (styleKind === "underline") {
      return `<h2 style="margin:24px 0 12px;font-size:18px;font-weight:700;line-height:1.4;color:${accent};padding-bottom:6px;border-bottom:2px solid ${accent};">${innerHTML}</h2>`;
    }
    if (styleKind === "plain") {
      return `<h2 style="margin:24px 0 10px;font-size:18px;font-weight:700;line-height:1.4;color:${theme.text};">${innerHTML}</h2>`;
    }
    // default "bar"
    return `<h2 style="margin:24px 0 12px;font-size:17.5px;font-weight:700;line-height:1.4;color:${theme.text};padding-left:11px;border-left:4px solid ${accent};">${innerHTML}</h2>`;
  }
  if (level === 3) {
    return `<h3 style="margin:18px 0 8px;font-size:16px;font-weight:700;line-height:1.45;color:${accent};">${innerHTML}</h3>`;
  }
  return `<h4 style="margin:14px 0 6px;font-size:15px;font-weight:700;line-height:1.5;color:${theme.text};">${innerHTML}</h4>`;
}

function figureHTML(src, alt, cfg, theme) {
  const shadow = cfg.imgShadow ? "box-shadow:0 6px 20px rgba(0,0,0,0.08);" : "";
  const cap = cfg.showCaption && alt
    ? `<figcaption style="margin-top:6px;text-align:center;font-size:12.5px;color:${theme.muted};">${escHtml(alt)}</figcaption>`
    : "";
  return `<figure style="margin:16px 0;padding:0;text-align:center;"><img src="${escHtml(src)}" alt="${escHtml(alt)}" style="display:block;max-width:100%;height:auto;margin:0 auto;border-radius:${cfg.imgRadius}px;${shadow}" />${cap}</figure>`;
}

export function compileWeChatInlineHTML({ title, content, slots, activeFile, cfg }) {
  const theme = TYPESET_THEMES.find((t) => t.id === cfg.themeId) || TYPESET_THEMES[0];
  const accent = cfg.accentOverride || theme.accent;
  const hStyle = cfg.headingStyle === "theme" ? theme.headingStyle : cfg.headingStyle;
  const rt = { ...theme, linkMode: cfg.linkMode };

  const stripped = String(content || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const lines = stripped.replace(/\r\n/g, "\n").split("\n");
  const out = [];

  // Optional article title if not already duplicated as first H1
  const firstNonEmpty = lines.find((l) => l.trim()) || "";
  if (title && !firstNonEmpty.trim().startsWith("# ")) {
    out.push(headingInlineHTML(1, escHtml(title), hStyle, accent, theme));
  }

  // Cover slot
  const coverSlot = (slots || []).find((s) => s.role === "cover");
  if (coverSlot) {
    if (coverSlot.imagePath) {
      out.push(figureHTML(localImg(coverSlot.imagePath), coverSlot.title || "文章封面", cfg, theme));
    } else {
      out.push(`<section style="margin:14px 0;padding:12px 14px;border-radius:8px;border:1px dashed ${accent};background:${theme.quoteBg};font-size:13px;color:${accent};text-align:center;">🎨 封面配图位（待生成）：${escHtml(coverSlot.theme || coverSlot.title || "")}</section>`);
    }
  }

  const inlineSlots = (slots || []).filter((s) => s.role !== "cover");
  const usedSlots = new Set();
  const appendMatchedSlots = (blockRaw) => {
    inlineSlots.forEach((sl) => {
      if (usedSlots.has(sl.id)) return;
      if (sl.anchor && blockRaw.includes(sl.anchor)) {
        usedSlots.add(sl.id);
        if (sl.imagePath) {
          out.push(figureHTML(localImg(sl.imagePath), sl.title || "", cfg, theme));
        } else {
          out.push(`<section style="margin:14px 0;padding:10px 14px;border-radius:8px;border:1px dashed ${theme.border};background:${theme.quoteBg};font-size:12.5px;color:${theme.muted};text-align:center;">🖼 正文配图位（待生成）：${escHtml(sl.theme || sl.title || "")}</section>`);
        }
      }
    });
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) { i++; continue; }

    // 1. Fenced code block
    if (/^(?:`{3,}|~{3,})/.test(trimmed)) {
      const fence = trimmed.startsWith("~~~") ? "~~~" : "```";
      const lang = trimmed.replace(/^(`{3,}|~{3,})/, "").trim() || "code";
      const start = i;
      i++;
      const bodyLines = [];
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        bodyLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push(
        `<section style="margin:16px 0;border-radius:8px;overflow:hidden;background:${theme.codeBg};border:1px solid rgba(0,0,0,0.08);">` +
        `<section style="padding:7px 12px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;">` +
        `<span style="font-size:11px;letter-spacing:2px;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#ff5f56;margin-right:5px;"></span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#ffbd2e;margin-right:5px;"></span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#27c93f;"></span></span>` +
        `<span style="font-family:Menlo,Consolas,monospace;font-size:11px;color:rgba(255,255,255,0.55);">${escHtml(lang)}</span>` +
        `</section>` +
        `<pre style="margin:0;padding:12px 14px;overflow-x:auto;font-family:Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;color:${theme.codeText};white-space:pre;"><code>${escHtml(bodyLines.join("\n"))}</code></pre>` +
        `</section>`
      );
      appendMatchedSlots(lines.slice(start, i).join("\n"));
      continue;
    }

    // 2. GFM Markdown Table
    if (raw.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const start = i;
      const headers = splitTableRow(lines[i]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const ths = headers.map((h) =>
        `<th style="padding:8px 10px;border:1px solid ${theme.border};background:${theme.tableHeadBg};color:${theme.text};font-weight:700;text-align:left;">${renderInlineHTML(h, rt, accent)}</th>`
      ).join("");
      const trs = bodyRows.map((cells, rIdx) => {
        const rowBg = rIdx % 2 === 1 ? theme.quoteBg : theme.bg;
        const tds = headers.map((_, ci) =>
          `<td style="padding:8px 10px;border:1px solid ${theme.border};background:${rowBg};color:${theme.text};vertical-align:top;">${renderInlineHTML(cells[ci] || "", rt, accent)}</td>`
        ).join("");
        return `<tr>${tds}</tr>`;
      }).join("");
      out.push(`<section style="margin:16px 0;overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:${Math.max(12.5, cfg.fontSize - 1.5)}px;line-height:1.55;"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></section>`);
      appendMatchedSlots(lines.slice(start, i).join("\n"));
      continue;
    }

    // 3. Heading
    const hm = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      out.push(headingInlineHTML(hm[1].length, renderInlineHTML(hm[2], rt, accent), hStyle, accent, theme));
      appendMatchedSlots(raw);
      i++;
      continue;
    }

    // 4. Horizontal Rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push(`<hr style="border:0;border-top:1px solid ${theme.border};margin:20px 0;" />`);
      i++;
      continue;
    }

    // 5. Standalone media/image embed ![[...]], ![alt](src), or HTML <video>/<audio> (#141)
    const videoExtRe = /\.(mp4|webm|mov|m4v|ogv|mkv)(?:[?#].*)?$/i;
    const audioExtRe = /\.(mp3|wav|ogg|m4a|flac|aac|opus)(?:[?#].*)?$/i;
    const imgExtRe = /\.(png|jpe?g|webp|gif|svg|bmp|avif|ico)(?:[?#].*)?$/i;
    const cleanMdHref = (h) => {
      let s = String(h || "").trim();
      if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).trim();
      const ti = s.search(/\s+["']/);
      return ti > 0 ? s.slice(0, ti).trim() : s;
    };
    const videoFigureHTML = (src, caption, widthPx = 0) => {
      const capHtml = caption ? `<figcaption style="margin-top:6px;font-size:12px;color:${theme.muted};text-align:center;">${escHtml(caption)}</figcaption>` : "";
      const wStyle = widthPx ? `max-width:${widthPx}px;` : "max-width:100%;";
      return `<figure style="margin:18px 0;text-align:center;"><video controls playsinline preload="metadata" src="${escHtml(src)}" style="${wStyle}width:100%;border-radius:10px;background:#141210;display:block;margin:0 auto;"></video>${capHtml}</figure>`;
    };
    const audioFigureHTML = (src, caption) => {
      const capHtml = caption ? `<figcaption style="margin-top:6px;font-size:12px;color:${theme.muted};text-align:center;">${escHtml(caption)}</figcaption>` : "";
      return `<figure style="margin:18px 0;padding:12px 14px;border-radius:10px;border:1px solid ${theme.border};background:${theme.quoteBg};"><audio controls preload="metadata" src="${escHtml(src)}" style="width:100%;display:block;"></audio>${capHtml}</figure>`;
    };

    const imgWiki = trimmed.match(/^!\[\[([^\[\]|]+?)(?:\|([^\[\]]*))?\]\]$/);
    if (imgWiki) {
      const wTarget = imgWiki[1].trim();
      const wAlias = (imgWiki[2] || "").trim();
      const wNum = /^\d+$/.test(wAlias) ? parseInt(wAlias, 10) : 0;
      const wCap = wNum ? "" : wAlias;
      if (videoExtRe.test(wTarget)) {
        out.push(videoFigureHTML(resolveImgSrc(wTarget, activeFile), wCap, wNum));
        i++;
        continue;
      }
      if (audioExtRe.test(wTarget)) {
        out.push(audioFigureHTML(resolveImgSrc(wTarget, activeFile), wCap));
        i++;
        continue;
      }
      if (imgExtRe.test(wTarget)) {
        out.push(figureHTML(resolveImgSrc(wTarget, activeFile), wCap, cfg, theme));
        i++;
        continue;
      }
    }
    const imgMd = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMd) {
      const mAlt = imgMd[1] || "";
      const mHref = cleanMdHref(imgMd[2]);
      if (videoExtRe.test(mHref)) {
        out.push(videoFigureHTML(resolveImgSrc(mHref, activeFile), mAlt));
      } else if (audioExtRe.test(mHref)) {
        out.push(audioFigureHTML(resolveImgSrc(mHref, activeFile), mAlt));
      } else {
        out.push(figureHTML(resolveImgSrc(mHref, activeFile), mAlt, cfg, theme));
      }
      i++;
      continue;
    }
    const htmlMediaStart = trimmed.match(/^<(video|audio)\b/i);
    if (htmlMediaStart) {
      const tagName = htmlMediaStart[1].toLowerCase();
      const closeRe = new RegExp(`</${tagName}\\s*>\\s*$`, "i");
      let j = i;
      let block = trimmed;
      if (!closeRe.test(trimmed) && !/\/>\s*$/.test(trimmed)) {
        while (j + 1 < lines.length && j - i < 12) {
          j++;
          block += "\n" + lines[j].trim();
          if (closeRe.test(lines[j].trim())) break;
        }
      }
      const srcM = block.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const rawSrc = srcM ? (srcM[1] || srcM[2] || srcM[3] || "").trim() : "";
      if (rawSrc) {
        const wM = block.match(/\bwidth\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i);
        const wPx = wM ? parseInt(wM[1] || wM[2] || wM[3], 10) : 0;
        const resolvedSrc = resolveImgSrc(rawSrc, activeFile);
        out.push(tagName === "video" ? videoFigureHTML(resolvedSrc, "", wPx) : audioFigureHTML(resolvedSrc, ""));
        i = j + 1;
        continue;
      }
    }

    // 6. Blockquote / Obsidian Callout
    if (/^>\s?/.test(trimmed)) {
      const start = i;
      const qLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const cm = (qLines[0] || "").match(/^\[!([a-zA-Z]+)\](?:[+-])?\s*(.*)$/);
      if (cm) {
        const meta = CALLOUT_INLINE_COLORS[cm[1].toLowerCase()] || CALLOUT_INLINE_COLORS.note;
        const cTitle = cm[2].trim() || meta.label;
        const cBody = qLines.slice(1).filter((l) => l.trim()).map((l) =>
          `<p style="margin:6px 0 0;color:${theme.text};">${renderInlineHTML(l, rt, accent)}</p>`
        ).join("");
        out.push(
          `<section style="margin:16px 0;padding:12px 14px;border-radius:8px;border-left:4px solid ${meta.border};background:${meta.bg};">` +
          `<p style="margin:0;font-weight:700;color:${meta.border};font-size:${cfg.fontSize - 0.5}px;">${meta.icon} ${escHtml(cTitle)}</p>` +
          `${cBody}</section>`
        );
      } else {
        const qBody = qLines.filter((l) => l.trim()).map((l) =>
          `<p style="margin:4px 0;color:${theme.muted};">${renderInlineHTML(l, rt, accent)}</p>`
        ).join("");
        out.push(`<blockquote style="margin:16px 0;padding:10px 14px;border-left:3.5px solid ${accent};background:${theme.quoteBg};border-radius:0 6px 6px 0;">${qBody}</blockquote>`);
      }
      appendMatchedSlots(lines.slice(start, i).join("\n"));
      continue;
    }

    // 7. Lists (bullet, ordered, task)
    if (/^(?:[-*+]\s+|\d+\.\s+)/.test(trimmed)) {
      const start = i;
      const ordered = /^\d+\.\s+/.test(trimmed);
      const listItems = [];
      while (i < lines.length && /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(lines[i])) {
        const itemRaw = lines[i].trim().replace(/^(?:[-*+]\s+|\d+\.\s+)/, "");
        const tm = itemRaw.match(/^\[([ xX])\]\s+(.+)$/);
        if (tm) {
          const done = tm[1].toLowerCase() === "x";
          const mark = done ? "☑" : "☐";
          const st = done ? `color:${theme.muted};text-decoration:line-through;` : `color:${theme.text};`;
          listItems.push(`<li style="margin:5px 0;list-style:none;margin-left:-18px;${st}"><span style="color:${accent};margin-right:6px;">${mark}</span>${renderInlineHTML(tm[2], rt, accent)}</li>`);
        } else {
          listItems.push(`<li style="margin:5px 0;color:${theme.text};">${renderInlineHTML(itemRaw, rt, accent)}</li>`);
        }
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag} style="margin:12px 0;padding-left:22px;">${listItems.join("")}</${tag}>`);
      appendMatchedSlots(lines.slice(start, i).join("\n"));
      continue;
    }

    // 8. Normal paragraph
    const start = i;
    const pLines = [trimmed];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+|`{3,}|~{3,}|-{3,}$|!\[\[|!\[)/.test(lines[i].trim()) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      pLines.push(lines[i].trim());
      i++;
    }
    const pRaw = pLines.join("\n");
    out.push(`<p style="margin:12px 0;color:${theme.text};">${renderInlineHTML(pLines.join(" "), rt, accent)}</p>`);
    appendMatchedSlots(pRaw);
  }

  return `<section style="font-family:${theme.fontFamily};font-size:${cfg.fontSize}px;line-height:${cfg.lineHeight};color:${theme.text};background:${theme.bg};padding:22px 20px 28px;letter-spacing:0.02em;word-break:break-word;box-sizing:border-box;">${out.join("\n")}</section>`;
}

async function copyRichHTMLToClipboard(html, plainText) {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
      toast("✓ 已复制带样式富文本，直接去微信公众号后台 Ctrl+V 粘贴！");
      return;
    }
  } catch {
    // Fall through to hidden DOM rich selection copy
  }
  const holder = document.createElement("div");
  holder.contentEditable = "true";
  holder.style.position = "fixed";
  holder.style.left = "-9999px";
  holder.style.top = "0";
  holder.innerHTML = html;
  document.body.appendChild(holder);
  const range = document.createRange();
  range.selectNodeContents(holder);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  try {
    document.execCommand("copy");
    toast("✓ 已复制带样式富文本，直接去微信公众号后台 Ctrl+V 粘贴！");
  } catch {
    toast("复制失败，请切换到「内联 HTML」手动复制");
  } finally {
    sel.removeAllRanges();
    holder.remove();
  }
}

export function createArticleTypesetController(opts) {
  const { getTitle, getContent, getSlots, getActivePath, onExport } = opts;

  let cfg = {
    themeId: "editorial_paper",
    accentOverride: "",
    fontSize: 15,
    lineHeight: 1.75,
    headingStyle: "theme", // theme | bar | pill | center | underline | plain
    imgRadius: 8,
    imgShadow: true,
    showCaption: true,
    linkMode: "plain", // plain | accent
    device: "mobile", // mobile | desktop | html
  };

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") cfg = { ...cfg, ...saved };
  } catch {}

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch {}
  }

  function render(container) {
    if (!container) return;
    clear(container);

    const activeTheme = TYPESET_THEMES.find((t) => t.id === cfg.themeId) || TYPESET_THEMES[0];
    const effectiveAccent = cfg.accentOverride || activeTheme.accent;

    const compiledHTML = compileWeChatInlineHTML({
      title: getTitle?.() || "",
      content: getContent?.() || "",
      slots: getSlots?.() || [],
      activeFile: getActivePath?.() || "",
      cfg,
    });

    // ---- Left Controls Panel (Theme Picker + Typography Tuning) ----
    const themeGrid = el("div", { class: "ic-ts-theme-grid" },
      ...TYPESET_THEMES.map((t) => {
        const selected = t.id === cfg.themeId;
        return el("button", {
          type: "button",
          class: "ic-ts-theme-card" + (selected ? " is-active" : ""),
          dataset: { themeId: t.id },
          onClick: () => {
            cfg.themeId = t.id;
            cfg.accentOverride = "";
            persist();
            render(container);
          },
        },
          el("div", { class: "ic-ts-theme-swatch", style: { background: t.bg, borderColor: t.border } },
            el("span", { class: "ic-ts-sw-bar", style: { background: t.accent } }),
            el("span", { class: "ic-ts-sw-lines" },
              el("i", { style: { background: t.text, width: "68%" } }),
              el("i", { style: { background: t.muted, width: "92%" } })
            )
          ),
          el("div", { class: "ic-ts-theme-meta" },
            el("strong", null, t.name),
            el("span", { class: "muted" }, t.desc)
          )
        );
      })
    );

    const colorInput = el("input", {
      type: "color",
      class: "ic-ts-color-picker",
      value: effectiveAccent,
      title: "自定义主强调色",
    });
    colorInput.addEventListener("input", () => {
      cfg.accentOverride = colorInput.value;
      persist();
      render(container);
    });

    const mkSeg = (options, curVal, onPick) => el("div", { class: "ic-ts-seg" },
      ...options.map(([v, lbl]) => el("button", {
        type: "button",
        class: "ic-ts-seg-btn" + (curVal === v ? " is-active" : ""),
        onClick: () => { onPick(v); persist(); render(container); },
      }, lbl))
    );

    const captionCb = el("input", { type: "checkbox", checked: cfg.showCaption });
    captionCb.checked = Boolean(cfg.showCaption);
    captionCb.addEventListener("change", () => { cfg.showCaption = captionCb.checked; persist(); render(container); });

    const shadowCb = el("input", { type: "checkbox", checked: cfg.imgShadow });
    shadowCb.checked = Boolean(cfg.imgShadow);
    shadowCb.addEventListener("change", () => { cfg.imgShadow = shadowCb.checked; persist(); render(container); });

    const leftPanel = el("aside", { class: "ic-ts-panel", "aria-label": "多主题排版设置" },
      el("div", { class: "ic-ts-sec" },
        el("div", { class: "ic-ts-sec-head" },
          el("strong", null, "排版主题皮肤 (10)"),
          el("span", { class: "muted", style: { fontSize: "11px" } }, "不改原 MD")
        ),
        themeGrid
      ),
      el("div", { class: "ic-ts-sec" },
        el("div", { class: "ic-ts-sec-head" }, el("strong", null, "强调主色")),
        el("div", { class: "ic-ts-accent-row" },
          ...QUICK_ACCENTS.map((hex) => el("button", {
            type: "button",
            class: "ic-ts-accent-dot" + (effectiveAccent.toLowerCase() === hex.toLowerCase() ? " is-active" : ""),
            style: { background: hex },
            title: hex,
            onClick: () => { cfg.accentOverride = hex; persist(); render(container); },
          })),
          colorInput
        )
      ),
      el("div", { class: "ic-ts-sec" },
        el("div", { class: "ic-ts-sec-head" }, el("strong", null, "正文字号")),
        mkSeg([[14, "14px"], [15, "15px"], [16, "16px"], [17, "17px"]], cfg.fontSize, (v) => { cfg.fontSize = v; })
      ),
      el("div", { class: "ic-ts-sec" },
        el("div", { class: "ic-ts-sec-head" }, el("strong", null, "行间距")),
        mkSeg([[1.6, "紧凑"], [1.75, "舒适"], [1.9, "宽松"]], cfg.lineHeight, (v) => { cfg.lineHeight = v; })
      ),
      el("div", { class: "ic-ts-sec" },
        el("div", { class: "ic-ts-sec-head" }, el("strong", null, "二级标题样式")),
        mkSeg([["theme", "跟随主题"], ["bar", "左竖条"], ["pill", "胶囊"], ["center", "居中线"], ["underline", "底线"]], cfg.headingStyle, (v) => { cfg.headingStyle = v; })
      ),
      el("div", { class: "ic-ts-sec" },
        el("div", { class: "ic-ts-sec-head" }, el("strong", null, "配图圆角与修饰")),
        mkSeg([[0, "直角"], [8, "微圆角"], [14, "大圆角"]], cfg.imgRadius, (v) => { cfg.imgRadius = v; }),
        el("div", { class: "row", style: { gap: "12px", marginTop: "6px" } },
          el("label", { class: "ic-obs-check-lbl" }, captionCb, el("span", null, "显示图注")),
          el("label", { class: "ic-obs-check-lbl" }, shadowCb, el("span", null, "柔和阴影"))
        )
      ),
      el("div", { class: "ic-ts-sec" },
        el("div", { class: "ic-ts-sec-head" }, el("strong", null, "双链 [[…]] 导出")),
        mkSeg([["plain", "转为纯正文"], ["accent", "保留主题下划线"]], cfg.linkMode, (v) => { cfg.linkMode = v; })
      )
    );

    // ---- Right Live Preview Stage ----
    const deviceSwitch = el("div", { class: "ic-article-segmented-switch", role: "group", "aria-label": "预览设备切换" },
      ...[
        ["mobile", "📱 微信手机 (414px)"],
        ["desktop", "🖥 桌面宽幅"],
        ["html", "</> 内联 HTML"],
      ].map(([k, lbl]) => el("button", {
        type: "button",
        class: "ic-article-seg-btn" + (cfg.device === k ? " is-active" : ""),
        onClick: () => { cfg.device = k; persist(); render(container); },
      }, lbl))
    );

    const stageTopbar = el("div", { class: "ic-ts-topbar" },
      deviceSwitch,
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          title: "复制带完整内联 CSS 的富文本，可直接 Ctrl+V 粘贴到微信公众号后台",
          onClick: () => copyRichHTMLToClipboard(compiledHTML, getContent?.() || ""),
        }, "📋 复制富文本（粘贴公众号）"),
        el("button", {
          type: "button",
          class: "btn btn-sm",
          onClick: () => {
            navigator.clipboard?.writeText(compiledHTML).catch(() => {});
            toast("已复制纯内联 HTML 代码");
          },
        }, "</> 复制 HTML"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => onExport?.("markdown_zip", false) }, "📦 MD+图 ZIP"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => onExport?.("images_zip", false) }, "🖼 配图包")
      )
    );

    const previewScroll = el("div", { class: "ic-ts-preview-scroll" });
    if (cfg.device === "html") {
      previewScroll.appendChild(el("div", { class: "ic-ts-html-box" },
        el("pre", { class: "mono" }, compiledHTML)
      ));
    } else if (cfg.device === "mobile") {
      const renderMount = el("div", { class: "ic-ts-render-mount" });
      renderMount.innerHTML = compiledHTML;
      previewScroll.appendChild(el("div", { class: "ic-ts-phone-frame" },
        el("div", { class: "ic-ts-phone-nav" },
          el("span", null, "‹"),
          el("strong", null, activeTheme.name + " · 公众号预览"),
          el("span", null, "···")
        ),
        renderMount
      ));
    } else {
      const renderMount = el("div", { class: "ic-ts-render-mount ic-ts-desktop-sheet" });
      renderMount.innerHTML = compiledHTML;
      previewScroll.appendChild(renderMount);
    }

    const rightStage = el("div", { class: "ic-ts-stage" }, stageTopbar, previewScroll);
    container.appendChild(el("div", { class: "ic-ts-layout" }, leftPanel, rightStage));
  }

  return { render };
}
