(() => {
  const MARK_ATTR = "data-handraw-clipper-bound";
  const SHOW_MORE_TEXT_RE = /^(显示更多|Show more|もっと見る|もっと表示|Mostrar más|Voir plus|Mehr anzeigen)$/i;
  const PROMPT_IN_REPLY_RE = /评论区|楼下|回复里|评论里|见评论|在评论|看评论|附评论|置顶评论|提示词在|咒语在|prompt\b.{0,24}(below|reply|replies|comment|comments|thread)|in the (reply|replies|comments)|reply below|thread below|check (the )?comments|👇|⬇️|⬇|🧵/i;

  function normalizeTwimgUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (u.hostname.includes("pbs.twimg.com")) {
        u.searchParams.set("name", "large");
      }
      return u.toString();
    } catch {
      return rawUrl;
    }
  }

  function isStatusDetailPage() {
    return /^\/[^/]+\/status\/\d+/i.test(location.pathname || "");
  }

  function extractCanonicalStatusUrl(article) {
    const timeEl = article.querySelector("time");
    const timeLink = timeEl ? timeEl.closest('a[href*="/status/"]') : null;
    const fallbackLink = article.querySelector('a[href*="/status/"]');
    const rawHref = (timeLink && timeLink.href) || (fallbackLink && fallbackLink.href) || location.href;
    try {
      const u = new URL(rawHref);
      const m = u.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (m) {
        return `https://x.com/${m[1]}/status/${m[2]}`;
      }
      return u.toString();
    } catch {
      return rawHref;
    }
  }

  function extractAuthorHandle(article) {
    const userNameBox = article.querySelector('[data-testid="User-Name"]');
    if (userNameBox) {
      const m = (userNameBox.innerText || "").match(/@[A-Za-z0-9_]+/);
      if (m) return m[0];
    }
    const statusUrl = extractCanonicalStatusUrl(article);
    const m = statusUrl.match(/x\.com\/([^/]+)\/status\//i);
    return m ? `@${m[1]}` : "";
  }

  function sameHandle(a, b) {
    const na = String(a || "").trim().toLowerCase().replace(/^@/, "");
    const nb = String(b || "").trim().toLowerCase().replace(/^@/, "");
    return Boolean(na && nb && na === nb);
  }

  function readTweetText(article) {
    const textNodes = article.querySelectorAll('[data-testid="tweetText"]');
    return Array.from(textNodes)
      .map((n) => (n.innerText || n.textContent || "").trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function extractImages(article) {
    return Array.from(article.querySelectorAll('img[src*="pbs.twimg.com/media"]'))
      .map((img) => normalizeTwimgUrl(img.src))
      .filter(Boolean);
  }

  function findShowMoreControl(article) {
    const byTestId = article.querySelector('[data-testid="tweet-text-show-more-link"]');
    if (byTestId) return byTestId;
    const candidates = article.querySelectorAll('button, [role="button"], a');
    for (const el of candidates) {
      const txt = (el.textContent || "").trim();
      if (SHOW_MORE_TEXT_RE.test(txt)) return el;
    }
    return null;
  }

  function isSafeInlineExpandControl(ctrl) {
    if (!ctrl) return false;
    // Never click an <a href="..."> that would navigate the timeline tab away.
    if (ctrl.tagName === "A" && ctrl.getAttribute("href")) return false;
    const parentLink = ctrl.closest("a[href]");
    if (parentLink && parentLink.getAttribute("href")) return false;
    return true;
  }

  async function tryExpandTweetInline(article) {
    const ctrl = findShowMoreControl(article);
    if (!ctrl) return { expanded: false, stillTruncated: false };
    if (!isSafeInlineExpandControl(ctrl)) {
      return { expanded: false, stillTruncated: true };
    }
    const beforeLen = readTweetText(article).length;
    ctrl.click();
    const expanded = await new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        obs.disconnect();
        resolve(ok);
      };
      const check = () => {
        const afterLen = readTweetText(article).length;
        const stillHasCtrl = Boolean(findShowMoreControl(article));
        if (afterLen > beforeLen || !stillHasCtrl) {
          finish(true);
        }
      };
      const obs = new MutationObserver(check);
      obs.observe(article, { childList: true, subtree: true, characterData: true });
      const timer = setTimeout(() => finish(readTweetText(article).length > beforeLen), 1800);
      check();
    });
    const stillTruncated = Boolean(findShowMoreControl(article)) || !expanded;
    return { expanded, stillTruncated };
  }

  async function collectAuthorRepliesFromDom(article, authorHandle, mainText) {
    if (!authorHandle) return [];
    const all = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const idx = all.indexOf(article);
    if (idx < 0) return [];

    const replies = [];
    const seen = new Set([mainText.trim()]);
    const onDetail = isStatusDetailPage();
    const maxLookahead = onDetail ? 8 : 2;

    for (let i = idx + 1; i < all.length && i <= idx + maxLookahead; i++) {
      const cand = all[i];
      const candAuthor = extractAuthorHandle(cand);
      if (!sameHandle(candAuthor, authorHandle)) {
        if (!onDetail) break;
        continue;
      }
      if (!onDetail) {
        // On timeline lists, only treat immediately following same-author tweet as a thread reply
        // when visually adjacent (avoid grabbing an unrelated post on the author's profile feed).
        const r1 = article.getBoundingClientRect();
        const r2 = cand.getBoundingClientRect();
        const gap = r2.top - r1.bottom;
        const looksThread = gap >= -4 && gap <= 48 && (PROMPT_IN_REPLY_RE.test(mainText) || Boolean(article.querySelector('[data-testid="Tweet-User-Avatar"]')));
        if (!looksThread) break;
      }
      await tryExpandTweetInline(cand);
      const txt = readTweetText(cand);
      if (!txt || txt.length < 6 || seen.has(txt)) continue;
      seen.add(txt);
      replies.push(txt);
      if (replies.length >= 3) break;
    }
    return replies;
  }

  function findParentTweetMedia(article, authorHandle) {
    if (!isStatusDetailPage()) return null;
    const all = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const idx = all.indexOf(article);
    if (idx <= 0) return null;

    let fallback = null;
    for (let i = idx - 1; i >= 0; i--) {
      const prev = all[i];
      const prevImgs = extractImages(prev);
      if (!prevImgs.length) continue;
      const info = {
        imageUrl: prevImgs[0],
        sourceUrl: extractCanonicalStatusUrl(prev),
        parentText: readTweetText(prev),
      };
      if (sameHandle(extractAuthorHandle(prev), authorHandle)) {
        return info;
      }
      if (!fallback) fallback = info;
    }
    return fallback;
  }

  function mergeMainAndReplies(mainText, replyTexts) {
    const cleanMain = String(mainText || "").trim();
    const cleanReplies = (replyTexts || []).map((t) => String(t || "").trim()).filter(Boolean);
    if (!cleanReplies.length) return cleanMain;
    if (!cleanMain) return cleanReplies.join("\n\n");
    return `[主推文]\n${cleanMain}\n\n[作者评论区补充]\n${cleanReplies.join("\n\n")}`;
  }

  function shouldCheckRepliesOnList(mainText, hasMedia, sourceUrl, sourceAuthor, replyCount) {
    if (isStatusDetailPage() || replyCount > 0) return false;
    if (!/^https:\/\/x\.com\/[^/]+\/status\/\d+/i.test(sourceUrl || "")) return false;
    if (!sourceAuthor) return false;
    const t = String(mainText || "").trim();
    if (PROMPT_IN_REPLY_RE.test(t)) return true;
    // Common X AI-art pattern: image + short teaser caption in main tweet, full prompt in reply.
    if (hasMedia && t.length < 180) return true;
    return false;
  }

  async function extractTweetPayload(article, { truncated = false } = {}) {
    const mainText = readTweetText(article);
    let imgs = extractImages(article);
    let sourceUrl = extractCanonicalStatusUrl(article);
    const sourceAuthor = extractAuthorHandle(article);

    // If user clicks clip on a text-only comment reply on a detail page, borrow cover image from parent tweet (#100).
    let parentMedia = null;
    if (!imgs.length) {
      parentMedia = findParentTweetMedia(article, sourceAuthor);
      if (parentMedia?.imageUrl) {
        imgs = [parentMedia.imageUrl];
        if (parentMedia.sourceUrl) sourceUrl = parentMedia.sourceUrl;
      }
    }

    const replyTexts = await collectAuthorRepliesFromDom(article, sourceAuthor, mainText);
    const mergedText = mergeMainAndReplies(mainText, replyTexts);
    const checkReplies = shouldCheckRepliesOnList(mainText, imgs.length > 0, sourceUrl, sourceAuthor, replyTexts.length);

    const titleSeed = (parentMedia?.parentText || mainText || replyTexts[0] || "").replace(/\s+/g, " ").trim();
    const title = titleSeed
      ? titleSeed.slice(0, 32)
      : (sourceAuthor ? `${sourceAuthor} 的 X 灵感图` : "X 推文灵感");

    return {
      title,
      imageUrl: imgs[0] || "",
      rawText: mergedText,
      prompt: mergedText,
      replyTexts,
      sourceUrl,
      sourceAuthor,
      sourceChannel: "x",
      truncated: Boolean(truncated || findShowMoreControl(article)),
      checkReplies,
    };
  }

  function showInlineToast(message, isError = false) {
    const id = "handraw-x-toast";
    const old = document.getElementById(id);
    if (old) old.remove();
    const div = document.createElement("div");
    div.id = id;
    div.className = "handraw-x-toast" + (isError ? " is-error" : "");
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3400);
  }

  function attachButtonToTweet(article) {
    if (!article || article.getAttribute(MARK_ATTR) === "1") return;
    const hasMedia = Boolean(article.querySelector('img[src*="pbs.twimg.com/media"]'));
    const hasText = Boolean(article.querySelector('[data-testid="tweetText"]'));
    if (!hasMedia && !hasText) return;

    const actionBar = article.querySelector('[role="group"]');
    if (!actionBar) return;
    article.setAttribute(MARK_ATTR, "1");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "handraw-x-clip-btn";
    btn.title = "一键收藏图片与提示词到手绘风灵感库（自动检查展开全文与作者评论区提示词）";
    btn.textContent = "📌 收进手绘风";

    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "收藏中…";
      const expandRes = await tryExpandTweetInline(article);
      const payload = await extractTweetPayload(article, { truncated: expandRes.stillTruncated });
      if (payload.checkReplies) {
        btn.textContent = "检查评论区…";
      }
      try {
        const res = await chrome.runtime.sendMessage({
          type: "clip",
          payload,
          showToast: false,
        });
        if (res?.ok) {
          btn.classList.add("is-saved");
          btn.textContent = "✓ 已收进灵感库";
          const gotReplies = Number(res.repliesFound || 0) > 0 || (payload.replyTexts && payload.replyTexts.length > 0);
          const replyHint = gotReplies ? "（已自动合并作者评论区提示词）" : "";
          showInlineToast(
            res.channel === "cloud"
              ? `☁ 已存入云端暂存箱${replyHint}，打开手绘风客户端自动同步`
              : `✓ 已收进手绘风灵感库${replyHint}，AI 正在后台整理提示词`
          );
        } else {
          btn.disabled = false;
          btn.textContent = "📌 收进手绘风";
          showInlineToast(`收集失败：${res?.error || "请先点击扩展图标配对本机客户端"}`, true);
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "📌 收进手绘风";
        showInlineToast(`收集失败：${err?.message || "扩展通信异常"}`, true);
      }
    });

    actionBar.appendChild(btn);
  }

  let pendingFrame = 0;
  function scheduleScan() {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      const tweets = document.querySelectorAll('article[data-testid="tweet"]:not([' + MARK_ATTR + '="1"])');
      for (const art of tweets) {
        attachButtonToTweet(art);
      }
    });
  }

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.body, { childList: true, subtree: true });
  scheduleScan();
})();
