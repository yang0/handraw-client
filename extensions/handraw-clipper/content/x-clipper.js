(() => {
  const MARK_ATTR = "data-handraw-clipper-bound";

  const SHOW_MORE_TEXT_RE = /^(显示更多|Show more|もっと見る|もっと表示|Mostrar más|Voir plus|Mehr anzeigen)$/i;

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

  function readTweetText(article) {
    const textNodes = article.querySelectorAll('[data-testid="tweetText"]');
    return Array.from(textNodes)
      .map((n) => (n.innerText || n.textContent || "").trim())
      .filter(Boolean)
      .join("\n\n");
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

  function extractTweetPayload(article, { truncated = false } = {}) {
    const rawText = readTweetText(article);

    const imgs = Array.from(article.querySelectorAll('img[src*="pbs.twimg.com/media"]'))
      .map((img) => normalizeTwimgUrl(img.src))
      .filter(Boolean);

    const sourceUrl = extractCanonicalStatusUrl(article);

    let sourceAuthor = "";
    const userNameBox = article.querySelector('[data-testid="User-Name"]');
    if (userNameBox) {
      const m = (userNameBox.innerText || "").match(/@[A-Za-z0-9_]+/);
      if (m) sourceAuthor = m[0];
    }

    const title = rawText
      ? rawText.replace(/\s+/g, " ").trim().slice(0, 32)
      : (sourceAuthor ? `${sourceAuthor} 的 X 灵感图` : "X 推文灵感");

    return {
      title,
      imageUrl: imgs[0] || "",
      rawText,
      prompt: rawText,
      sourceUrl,
      sourceAuthor,
      sourceChannel: "x",
      truncated: Boolean(truncated || findShowMoreControl(article)),
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
    setTimeout(() => div.remove(), 3200);
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
    btn.title = "一键收藏图片与提示词到手绘风灵感库";
    btn.textContent = "📌 收进手绘风";

    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "收藏中…";
      const expandRes = await tryExpandTweetInline(article);
      const payload = extractTweetPayload(article, { truncated: expandRes.stillTruncated });
      try {
        const res = await chrome.runtime.sendMessage({
          type: "clip",
          payload,
          showToast: false,
        });
        if (res?.ok) {
          btn.classList.add("is-saved");
          btn.textContent = "✓ 已收进灵感库";
          showInlineToast(
            res.channel === "cloud"
              ? "☁ 已存入云端暂存箱，打开手绘风客户端自动同步"
              : "✓ 已收进手绘风灵感库，AI 正在后台整理提示词"
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
