import { el } from "../api.js";

function splitBlocks(text) {
  const norm = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!norm) return [];
  return norm.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
}

function charOverlapScore(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(Array.from(a));
  let hit = 0;
  for (const ch of b) {
    if (setA.has(ch)) hit++;
  }
  return (2 * hit) / (a.length + b.length);
}

/**
 * Compute paragraph-level diff hunks between oldText and newText.
 * Returns array of { id, kind: "same"|"change"|"add"|"del", oldText, newText, accepted }.
 */
export function computeParagraphDiff(oldText, newText) {
  const a = splitBlocks(oldText);
  const b = splitBlocks(newText);
  const m = a.length;
  const n = b.length;

  // DP LCS table on paragraph blocks
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rawOps = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rawOps.push({ op: "same", oldText: a[i], newText: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rawOps.push({ op: "del", oldText: a[i], newText: "" });
      i++;
    } else {
      rawOps.push({ op: "add", oldText: "", newText: b[j] });
      j++;
    }
  }
  while (i < m) rawOps.push({ op: "del", oldText: a[i++], newText: "" });
  while (j < n) rawOps.push({ op: "add", oldText: "", newText: b[j++] });

  // Pair adjacent del+add runs into clean "change" hunks where appropriate
  const hunks = [];
  let idx = 0;
  let hid = 1;
  while (idx < rawOps.length) {
    if (rawOps[idx].op === "same") {
      hunks.push({
        id: `h_${hid++}`,
        kind: "same",
        oldText: rawOps[idx].oldText,
        newText: rawOps[idx].newText,
        accepted: true,
      });
      idx++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (idx < rawOps.length && rawOps[idx].op !== "same") {
      if (rawOps[idx].op === "del") dels.push(rawOps[idx].oldText);
      else adds.push(rawOps[idx].newText);
      idx++;
    }
    // Align dels & adds by similarity when counts differ so a deleted heading doesn't shift all following paragraphs
    if (dels.length === adds.length) {
      for (let k = 0; k < dels.length; k++) {
        hunks.push({ id: `h_${hid++}`, kind: "change", oldText: dels[k], newText: adds[k], accepted: true });
      }
    } else if (dels.length > adds.length && adds.length > 0) {
      const usedAdd = new Set();
      const delMatch = new Array(dels.length).fill(-1);
      for (let di = 0; di < dels.length; di++) {
        let bestJ = -1;
        let bestS = 0.16;
        for (let ai = 0; ai < adds.length; ai++) {
          if (usedAdd.has(ai)) continue;
          const s = charOverlapScore(dels[di], adds[ai]);
          if (s > bestS) { bestS = s; bestJ = ai; }
        }
        if (bestJ >= 0) {
          delMatch[di] = bestJ;
          usedAdd.add(bestJ);
        }
      }
      for (let di = 0; di < dels.length; di++) {
        if (delMatch[di] >= 0) {
          hunks.push({ id: `h_${hid++}`, kind: "change", oldText: dels[di], newText: adds[delMatch[di]], accepted: true });
        } else {
          hunks.push({ id: `h_${hid++}`, kind: "del", oldText: dels[di], newText: "", accepted: true });
        }
      }
      for (let ai = 0; ai < adds.length; ai++) {
        if (!usedAdd.has(ai)) {
          hunks.push({ id: `h_${hid++}`, kind: "add", oldText: "", newText: adds[ai], accepted: true });
        }
      }
    } else {
      const pairs = Math.min(dels.length, adds.length);
      for (let k = 0; k < pairs; k++) {
        hunks.push({ id: `h_${hid++}`, kind: "change", oldText: dels[k], newText: adds[k], accepted: true });
      }
      for (let k = pairs; k < dels.length; k++) {
        hunks.push({ id: `h_${hid++}`, kind: "del", oldText: dels[k], newText: "", accepted: true });
      }
      for (let k = pairs; k < adds.length; k++) {
        hunks.push({ id: `h_${hid++}`, kind: "add", oldText: "", newText: adds[k], accepted: true });
      }
    }
  }
  return hunks;
}

/**
 * Reconstruct final Markdown content from paragraph hunks honoring per-hunk `accepted` toggles.
 */
export function mergeAcceptedHunks(hunks) {
  const parts = [];
  for (const h of hunks || []) {
    if (h.kind === "same") {
      parts.push(h.oldText);
    } else if (h.accepted) {
      if (h.newText) parts.push(h.newText);
    } else {
      if (h.oldText) parts.push(h.oldText);
    }
  }
  return parts.join("\n\n");
}

function tokenizeInline(str) {
  // Split into CJK chars, ASCII words, whitespace, or punctuation for clean inline diffing
  return String(str || "").match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+|\s+|[^\s]/g) || [];
}

/**
 * Render fine-grained word/character inline diff as a DocumentFragment (<del> + <ins>).
 */
export function renderInlineWordDiff(oldStr, newStr) {
  const frag = document.createDocumentFragment();
  const a = tokenizeInline(oldStr);
  const b = tokenizeInline(newStr);

  // Fallback to clean stacked old/new when paragraphs are huge or mostly rewritten (avoids choppy single-char soup)
  if (a.length * b.length > 90000 || (oldStr && newStr && charOverlapScore(oldStr, newStr) < 0.24)) {
    if (oldStr) frag.appendChild(el("div", { class: "ic-diff-stack-old" }, el("del", { class: "ic-diff-del" }, oldStr)));
    if (newStr) frag.appendChild(el("div", { class: "ic-diff-stack-new" }, el("ins", { class: "ic-diff-ins" }, newStr)));
    return frag;
  }

  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const runs = [];
  const pushRun = (type, tok) => {
    if (runs.length && runs[runs.length - 1].type === type) {
      runs[runs.length - 1].text += tok;
    } else {
      runs.push({ type, text: tok });
    }
  };

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pushRun("same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushRun("del", a[i]);
      i++;
    } else {
      pushRun("ins", b[j]);
      j++;
    }
  }
  while (i < m) pushRun("del", a[i++]);
  while (j < n) pushRun("ins", b[j++]);

  for (const r of runs) {
    if (r.type === "same") frag.appendChild(document.createTextNode(r.text));
    else if (r.type === "del") frag.appendChild(el("del", { class: "ic-diff-del" }, r.text));
    else frag.appendChild(el("ins", { class: "ic-diff-ins" }, r.text));
  }
  return frag;
}

function renderInlineMd(text) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith("**")) {
      frag.appendChild(el("strong", null, tok.slice(2, -2)));
    } else if (tok.startsWith("`")) {
      frag.appendChild(el("code", { class: "ic-cop-code" }, tok.slice(1, -1)));
    }
    last = re.lastIndex;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

/**
 * Safely render Markdown feedback in the Copilot sidebar without innerHTML.
 */
export function renderCopilotMarkdown(md) {
  const wrap = el("div", { class: "ic-cop-md" });
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  let listEl = null;
  let listTag = "";

  const flushList = () => {
    if (listEl) {
      wrap.appendChild(listEl);
      listEl = null;
      listTag = "";
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flushList();
      wrap.appendChild(el("div", { class: "ic-cop-md-h" }, renderInlineMd(hMatch[2])));
      continue;
    }
    if (line.startsWith(">")) {
      flushList();
      wrap.appendChild(el("blockquote", { class: "ic-cop-md-quote" }, renderInlineMd(line.replace(/^>\s?/, ""))));
      continue;
    }
    const ulMatch = line.match(/^[-*•]\s+(.+)$/);
    if (ulMatch) {
      if (listTag !== "ul") {
        flushList();
        listTag = "ul";
        listEl = el("ul", { class: "ic-cop-md-list" });
      }
      listEl.appendChild(el("li", null, renderInlineMd(ulMatch[1])));
      continue;
    }
    const olMatch = line.match(/^\d+[.)、]\s+(.+)$/);
    if (olMatch) {
      if (listTag !== "ol") {
        flushList();
        listTag = "ol";
        listEl = el("ol", { class: "ic-cop-md-list" });
      }
      listEl.appendChild(el("li", null, renderInlineMd(olMatch[1])));
      continue;
    }
    flushList();
    wrap.appendChild(el("p", { class: "ic-cop-md-p" }, renderInlineMd(line)));
  }
  flushList();
  return wrap;
}
