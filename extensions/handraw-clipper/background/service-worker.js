const MENU_ID = "handraw-clip-inspiration";
const DEFAULT_CONFIG = {
  clientUrl: "http://127.0.0.1:18520",
  clipToken: "",
  siteBase: "https://handraw-style.com",
  siteToken: "",
  autoOrganize: true,
};

async function loadBundledDefaults() {
  try {
    const resp = await fetch(chrome.runtime.getURL("defaults.json"), { cache: "no-store" });
    if (!resp.ok) return {};
    const data = await resp.json();
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function loadConfig() {
  const [stored, bundled] = await Promise.all([
    chrome.storage.local.get(["config", "lastBundledToken"]),
    loadBundledDefaults(),
  ]);
  const saved = stored.config || {};
  const bundledToken = String(bundled.clipToken || "").trim();
  const bundledUrl = normalizeBase(bundled.clientUrl || "");
  const bundledSite = normalizeBase(bundled.siteBase || "");

  const merged = {
    ...DEFAULT_CONFIG,
    ...(bundledUrl ? { clientUrl: bundledUrl } : {}),
    ...(bundledSite ? { siteBase: bundledSite } : {}),
    ...(bundledToken ? { clipToken: bundledToken } : {}),
    ...saved,
  };

  // Auto-adopt pre-paired token on fresh install or when rotated by the local
  // desktop client (without clobbering an explicit manual user override) (#185).
  const savedToken = String(saved.clipToken || "").trim();
  const lastBundled = String(stored.lastBundledToken || "").trim();
  if (bundledToken && (!savedToken || (lastBundled && savedToken === lastBundled && bundledToken !== lastBundled))) {
    merged.clipToken = bundledToken;
    if (bundledUrl) merged.clientUrl = bundledUrl;
    if (bundledSite && !saved.siteBase) merged.siteBase = bundledSite;
    await chrome.storage.local.set({ config: merged, lastBundledToken: bundledToken });
  }
  return merged;
}

async function saveConfig(next) {
  const merged = { ...(await loadConfig()), ...next };
  await chrome.storage.local.set({ config: merged });
  return merged;
}

async function recordClip(entry) {
  const { recentClips = [] } = await chrome.storage.local.get("recentClips");
  const next = [entry, ...recentClips].slice(0, 12);
  await chrome.storage.local.set({ recentClips: next });
}

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/api\/inspirations\/clip\/?$/i, "").replace(/\/+$/, "");
}

async function pingLocalClient(cfg) {
  const base = normalizeBase(cfg.clientUrl);
  if (!base || !cfg.clipToken) {
    return { ok: false, error: "未配置本机客户端地址或配对 Token" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const resp = await fetch(`${base}/api/inspirations/clip/ping`, {
      method: "GET",
      headers: {
        "X-Handraw-Clip-Token": cfg.clipToken,
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, error: resp.status === 403 ? "配对 Token 无效，请从手绘风客户端复制最新 Token" : `客户端返回 HTTP ${resp.status}` };
    }
    const data = await resp.json();
    return { ok: Boolean(data?.ok), version: data?.version || "", loggedIn: Boolean(data?.loggedIn) };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "连接本机客户端超时" : "未检测到运行中的手绘风客户端" };
  } finally {
    clearTimeout(timer);
  }
}

async function sendToLocalClient(cfg, payload) {
  const base = normalizeBase(cfg.clientUrl);
  if (!base || !cfg.clipToken) {
    return { ok: false, error: "未配置本机客户端地址或配对 Token" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(`${base}/api/inspirations/clip`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Handraw-Clip-Token": cfg.clipToken,
      },
      body: JSON.stringify({
        ...payload,
        autoOrganize: cfg.autoOrganize !== false,
      }),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: data?.error || (resp.status === 403 ? "配对 Token 不匹配" : `HTTP ${resp.status}`),
      };
    }
    return { ok: true, channel: "local", item: data.item || null, imageWarning: data.imageWarning || "" };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "本地接口响应超时" : "无法连接本机客户端" };
  } finally {
    clearTimeout(timer);
  }
}

async function sendToCloudFallback(cfg, payload) {
  const base = normalizeBase(cfg.siteBase || "https://handraw-style.com");
  const token = String(cfg.siteToken || "").trim();
  if (!base || !token) {
    return { ok: false, error: "未配置云端 Token" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(`${base}/api/me/inspirations/clip`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, error: data?.error || `云端返回 HTTP ${resp.status}` };
    }
    return { ok: true, channel: "cloud", item: data.clip || data.item || null };
  } catch (err) {
    return { ok: false, error: err?.message || "云端暂存失败" };
  } finally {
    clearTimeout(timer);
  }
}

async function flashBadge(ok) {
  try {
    await chrome.action.setBadgeText({ text: ok ? "OK" : "!" });
    await chrome.action.setBadgeBackgroundColor({ color: ok ? "#286E49" : "#B8332A" });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "" }).catch(() => {});
    }, 3000);
  } catch {}
}

async function showPageToast(tabId, message, isError = false) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [message, isError],
      func: (msg, err) => {
        const id = "handraw-clipper-toast";
        const old = document.getElementById(id);
        if (old) old.remove();
        const box = document.createElement("div");
        box.id = id;
        box.textContent = msg;
        Object.assign(box.style, {
          position: "fixed",
          right: "20px",
          bottom: "20px",
          zIndex: "2147483647",
          padding: "10px 16px",
          borderRadius: "10px",
          background: err ? "#B8332A" : "#1E1B18",
          color: "#FFFDF9",
          fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
          fontSize: "13px",
          fontWeight: "600",
          boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
          border: "1px solid rgba(255,253,249,0.16)",
        });
        document.body.appendChild(box);
        setTimeout(() => box.remove(), 3200);
      },
    });
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_CLIP_IMAGE_BYTES = 8 * 1024 * 1024;

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Fetch the target image inside Chrome's network context (inheriting browser
// proxy extensions & session cookies) and pass it as a data URL so the local
// desktop client never fails downloading pbs.twimg.com directly (#193).
async function fetchImageAsDataUrl(imageUrl) {
  const url = String(imageUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) return "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(url, {
      method: "GET",
      credentials: "omit",
      cache: "force-cache",
      signal: ctrl.signal,
    });
    if (!resp.ok) return "";
    const ct = String(resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (ct && !ct.startsWith("image/")) return "";
    const buf = await resp.arrayBuffer();
    if (!buf || buf.byteLength < 16 || buf.byteLength > MAX_CLIP_IMAGE_BYTES) return "";
    const mime = ct && ct.startsWith("image/") ? ct : "image/jpeg";
    return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function mergeMainAndReplies(mainText, replyTexts) {
  const cleanMain = String(mainText || "").trim();
  const cleanReplies = (replyTexts || []).map((t) => String(t || "").trim()).filter(Boolean);
  if (!cleanReplies.length) return cleanMain;
  if (!cleanMain) return cleanReplies.join("\n\n");
  return `[主推文]\n${cleanMain}\n\n[作者评论区补充]\n${cleanReplies.join("\n\n")}`;
}

async function fetchTweetAndAuthorRepliesViaBgTab(sourceUrl, expectedAuthor) {
  if (!/^https:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(String(sourceUrl || ""))) {
    return null;
  }
  const statusIdMatch = String(sourceUrl).match(/\/status\/(\d+)/i);
  const statusId = statusIdMatch ? statusIdMatch[1] : "";
  let bgTab = null;
  try {
    bgTab = await chrome.tabs.create({ url: sourceUrl, active: false });
    if (!bgTab?.id) return null;

    const deadline = Date.now() + 6500;
    let firstMainSeenAt = 0;
    let lastSnapshot = null;

    while (Date.now() < deadline) {
      await sleep(450);
      let execRes = null;
      try {
        execRes = await chrome.scripting.executeScript({
          target: { tabId: bgTab.id },
          args: [statusId, String(expectedAuthor || "")],
          func: async (targetId, wantAuthor) => {
            const showMoreRe = /^(显示更多|Show more|もっと見る|もっと表示|Mostrar más|Voir plus|Mehr anzeigen)$/i;
            const normHandle = (h) => String(h || "").trim().toLowerCase().replace(/^@/, "");
            const getHandle = (art) => {
              const box = art.querySelector('[data-testid="User-Name"]');
              if (box) {
                const m = (box.innerText || "").match(/@[A-Za-z0-9_]+/);
                if (m) return m[0];
              }
              return "";
            };
            const readText = (art) => Array.from(art.querySelectorAll('[data-testid="tweetText"]'))
              .map((n) => (n.innerText || n.textContent || "").trim())
              .filter(Boolean)
              .join("\n\n");
            const expandSafe = (art) => {
              const ctrl = art.querySelector('[data-testid="tweet-text-show-more-link"]') ||
                Array.from(art.querySelectorAll('button, [role="button"]')).find((el) => showMoreRe.test((el.textContent || "").trim()));
              if (ctrl && !(ctrl.tagName === "A" && ctrl.getAttribute("href")) && !ctrl.closest("a[href]")) {
                ctrl.click();
                return true;
              }
              return false;
            };

            const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            if (!articles.length) return { ready: false, count: 0 };

            let mainIdx = 0;
            if (targetId) {
              const foundIdx = articles.findIndex((a) => Boolean(a.querySelector(`a[href*="/status/${targetId}"]`)));
              if (foundIdx >= 0) mainIdx = foundIdx;
            }
            const mainArt = articles[mainIdx];
            const authorHandle = getHandle(mainArt) || wantAuthor;
            const wantNorm = normHandle(authorHandle || wantAuthor);

            let clickedExpand = expandSafe(mainArt);
            const authorReplyArts = [];
            for (let i = mainIdx + 1; i < articles.length && i <= mainIdx + 8; i++) {
              const cand = articles[i];
              const h = getHandle(cand);
              if (wantNorm && normHandle(h) === wantNorm) {
                if (expandSafe(cand)) clickedExpand = true;
                authorReplyArts.push(cand);
                if (authorReplyArts.length >= 3) break;
              }
            }
            if (clickedExpand) {
              await new Promise((r) => setTimeout(r, 550));
            }

            const mainText = readText(mainArt);
            const seen = new Set([mainText]);
            const replyTexts = [];
            for (const ra of authorReplyArts) {
              const t = readText(ra);
              if (t && t.length >= 6 && !seen.has(t)) {
                seen.add(t);
                replyTexts.push(t);
              }
            }
            const imgEl = mainArt.querySelector('img[src*="pbs.twimg.com/media"]');
            let imageUrl = imgEl ? imgEl.src : "";
            try {
              if (imageUrl) {
                const u = new URL(imageUrl);
                if (u.hostname.includes("pbs.twimg.com")) u.searchParams.set("name", "large");
                imageUrl = u.toString();
              }
            } catch {}
            return {
              ready: Boolean(mainText || imageUrl),
              count: articles.length,
              mainText,
              replyTexts,
              imageUrl,
              author: authorHandle,
            };
          },
        });
      } catch {
        // Tab still loading / navigating — retry on next poll tick.
        continue;
      }

      const snap = execRes?.[0]?.result;
      if (!snap || !snap.ready) continue;
      lastSnapshot = snap;
      if (!firstMainSeenAt) firstMainSeenAt = Date.now();
      // Exit early as soon as author self-replies are found, or once other replies loaded and settled.
      if (snap.replyTexts && snap.replyTexts.length > 0) {
        return snap;
      }
      if (snap.count >= 3 && Date.now() - firstMainSeenAt >= 900) {
        return snap;
      }
      if (Date.now() - firstMainSeenAt >= 2200) {
        return snap;
      }
    }
    return lastSnapshot;
  } catch {
    return null;
  } finally {
    if (bgTab?.id) {
      await chrome.tabs.remove(bgTab.id).catch(() => {});
    }
  }
}

async function deliverClip(payload, tabId = null) {
  const nextPayload = { ...(payload || {}) };
  let repliesFound = Array.isArray(nextPayload.replyTexts) ? nextPayload.replyTexts.length : 0;

  if (nextPayload.checkReplies && nextPayload.sourceUrl && repliesFound === 0) {
    const bg = await fetchTweetAndAuthorRepliesViaBgTab(nextPayload.sourceUrl, nextPayload.sourceAuthor);
    if (bg) {
      const baseMain = String(nextPayload.rawText || nextPayload.prompt || "");
      const betterMain = (bg.mainText && bg.mainText.length > baseMain.length) ? bg.mainText : baseMain;
      const bgReplies = Array.isArray(bg.replyTexts) ? bg.replyTexts.filter(Boolean) : [];
      if (bgReplies.length > 0 || betterMain.length > baseMain.length) {
        const merged = mergeMainAndReplies(betterMain, bgReplies);
        nextPayload.rawText = merged;
        nextPayload.prompt = merged;
        nextPayload.replyTexts = bgReplies;
        if (bgReplies.length > 0) {
          repliesFound = bgReplies.length;
        }
      }
      if (!nextPayload.imageUrl && bg.imageUrl) {
        nextPayload.imageUrl = bg.imageUrl;
      }
      if (!nextPayload.sourceAuthor && bg.author) {
        nextPayload.sourceAuthor = bg.author;
      }
      if (bg.mainText && bg.mainText.length > baseMain.length) {
        nextPayload.truncated = false;
      }
    }
  }

  // Grab image bytes inside Chrome so browser-scoped proxies (e.g. SwitchyOmega
  // for X/Twitter) work seamlessly without requiring a system-wide proxy (#193).
  if (!nextPayload.imageDataUrl && nextPayload.imageUrl) {
    const dataUrl = await fetchImageAsDataUrl(nextPayload.imageUrl);
    if (dataUrl) {
      nextPayload.imageDataUrl = dataUrl;
    }
  }

  const cfg = await loadConfig();
  let res = await sendToLocalClient(cfg, nextPayload);
  if (!res.ok && cfg.siteToken) {
    const cloudPayload = { ...nextPayload };
    if (cloudPayload.imageDataUrl && cloudPayload.imageDataUrl.length > 4 * 1024 * 1024) {
      delete cloudPayload.imageDataUrl;
    }
    const cloud = await sendToCloudFallback(cfg, cloudPayload);
    if (cloud.ok) {
      res = cloud;
    }
  }
  const title = nextPayload.title || (nextPayload.rawText || nextPayload.prompt || "网页灵感").slice(0, 28);
  await recordClip({
    title,
    sourceUrl: nextPayload.sourceUrl || "",
    sourceAuthor: nextPayload.sourceAuthor || "",
    imageUrl: nextPayload.imageUrl || "",
    channel: res.ok ? res.channel : "failed",
    error: res.ok ? (res.imageWarning || "") : res.error,
    ts: Date.now(),
  });
  await flashBadge(res.ok);
  if (tabId) {
    const replyHint = repliesFound > 0 ? "（含作者评论区提示词）" : "";
    const warnHint = res.ok && res.imageWarning ? `（${res.imageWarning}）` : "";
    await showPageToast(
      tabId,
      res.ok
        ? (res.channel === "cloud" ? `☁ 已存入云端灵感暂存箱${replyHint}，打开客户端后自动同步` : `✓ 已收进手绘风灵感库${replyHint}${warnHint}`)
        : `收集失败：${res.error}`,
      !res.ok
    );
  }
  return { ...res, repliesFound };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "收进手绘风灵感库",
      contexts: ["image", "selection", "page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const pageUrl = info.pageUrl || tab?.url || "";
  const pageTitle = tab?.title || "";
  const imageUrl = info.mediaType === "image" ? (info.srcUrl || "") : "";
  const rawText = (info.selectionText || "").trim();

  let fallbackText = rawText;
  let fallbackImg = imageUrl;
  if (!fallbackText && !fallbackImg && tab?.id) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const sel = window.getSelection()?.toString()?.trim() || "";
          const ogImg = document.querySelector('meta[property="og:image"]')?.content || "";
          return { sel, ogImg };
        },
      });
      const r = results?.[0]?.result;
      if (r?.sel) fallbackText = r.sel;
      if (!fallbackImg && r?.ogImg) fallbackImg = r.ogImg;
    } catch {}
  }

  await deliverClip({
    title: pageTitle.slice(0, 48),
    imageUrl: fallbackImg,
    rawText: fallbackText || pageTitle,
    prompt: fallbackText,
    sourceUrl: pageUrl,
    sourceChannel: /x\.com|twitter\.com/i.test(pageUrl) ? "x" : "chrome",
  }, tab?.id || null);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "clip") {
        const res = await deliverClip(msg.payload || {}, msg.showToast ? sender?.tab?.id : null);
        sendResponse(res);
        return;
      }
      if (msg?.type === "ping") {
        const cfg = msg.config ? await saveConfig(msg.config) : await loadConfig();
        const local = await pingLocalClient(cfg);
        sendResponse({ ok: true, local, hasCloud: Boolean(cfg.siteToken), config: cfg });
        return;
      }
      if (msg?.type === "getState") {
        const cfg = await loadConfig();
        const { recentClips = [] } = await chrome.storage.local.get("recentClips");
        const local = await pingLocalClient(cfg);
        sendResponse({ ok: true, config: cfg, recentClips, local });
        return;
      }
      if (msg?.type === "saveConfig") {
        const cfg = await saveConfig(msg.config || {});
        const local = await pingLocalClient(cfg);
        sendResponse({ ok: true, config: cfg, local });
        return;
      }
      sendResponse({ ok: false, error: "unknown message" });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});
