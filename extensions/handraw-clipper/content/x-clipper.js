(() => {
  const MARK_ATTR = "data-handraw-clipper-bound";

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

  function extractTweetPayload(article) {
    const textNodes = article.querySelectorAll('[data-testid="tweetText"]');
    const rawText = Array.from(textNodes)
      .map((n) => (n.innerText || n.textContent || "").trim())
      .filter(Boolean)
      .join("\n\n");

    const imgs = Array.from(article.querySelectorAll('img[src*="pbs.twimg.com/media"]'))
      .map((img) => normalizeTwimgUrl(img.src))
      .filter(Boolean);

    const statusLink = article.querySelector('a[href*="/status/"]');
    const sourceUrl = statusLink ? statusLink.href : location.href;

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
      const payload = extractTweetPayload(article);
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
