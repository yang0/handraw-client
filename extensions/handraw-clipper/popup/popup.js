const statusPill = document.getElementById("status-pill");
const inClientUrl = document.getElementById("in-client-url");
const inClipToken = document.getElementById("in-clip-token");
const inAutoOrg = document.getElementById("in-auto-org");
const inSiteBase = document.getElementById("in-site-base");
const inSiteToken = document.getElementById("in-site-token");
const btnSave = document.getElementById("btn-save");
const btnClipNow = document.getElementById("btn-clip-now");
const msgEl = document.getElementById("msg");
const recentCountEl = document.getElementById("recent-count");
const recentListEl = document.getElementById("recent-list");

function setMsg(text, kind = "") {
  msgEl.textContent = text || "";
  msgEl.className = "msg" + (kind ? ` is-${kind}` : "");
}

function renderStatus(local, hasCloud) {
  if (local?.ok) {
    statusPill.textContent = "🟢 本机已连接";
    statusPill.className = "pill is-ok";
    return;
  }
  if (hasCloud) {
    statusPill.textContent = "☁ 云端暂存模式";
    statusPill.className = "pill is-warn";
    return;
  }
  statusPill.textContent = "🔴 未配对";
  statusPill.className = "pill is-err";
}

function renderRecent(list) {
  const items = Array.isArray(list) ? list : [];
  recentCountEl.textContent = `${items.length} 条`;
  recentListEl.replaceChildren();
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "还没有收集记录。在 X 推文下方点「📌 收进手绘风」或在任意图片上右键即可开始。";
    recentListEl.appendChild(p);
    return;
  }
  const labels = { local: "已进本机", cloud: "云端暂存", failed: "失败" };
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "recent-item";
    const title = document.createElement("span");
    title.className = "recent-title";
    title.textContent = it.title || "未命名灵感";
    title.title = it.error || it.sourceUrl || it.title || "";
    const tag = document.createElement("span");
    tag.className = `recent-tag ${it.channel || ""}`;
    tag.textContent = labels[it.channel] || it.channel || "";
    row.append(title, tag);
    recentListEl.appendChild(row);
  }
}

function normalizeClientInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return "http://127.0.0.1:18520";
  if (/^\d+$/.test(s)) return `http://127.0.0.1:${s}`;
  // Strip trailing /api/inspirations/clip if user pasted full endpoint
  return s.replace(/\/api\/inspirations\/clip\/?$/i, "").replace(/\/+$/, "");
}

async function init() {
  try {
    const st = await chrome.runtime.sendMessage({ type: "getState" });
    if (st?.config) {
      inClientUrl.value = st.config.clientUrl || "";
      inClipToken.value = st.config.clipToken || "";
      inAutoOrg.checked = st.config.autoOrganize !== false;
      inSiteBase.value = st.config.siteBase || "https://handraw-style.com";
      inSiteToken.value = st.config.siteToken || "";
    }
    renderStatus(st?.local, Boolean(st?.config?.siteToken));
    renderRecent(st?.recentClips || []);
    if (!st?.local?.ok && st?.local?.error && st?.config?.clipToken) {
      setMsg(st.local.error, "err");
    }
  } catch (err) {
    setMsg(`初始化失败：${err?.message || err}`, "err");
  }
}

btnSave.addEventListener("click", async () => {
  btnSave.disabled = true;
  setMsg("正在测试本机客户端连接…");
  try {
    const config = {
      clientUrl: normalizeClientInput(inClientUrl.value),
      clipToken: inClipToken.value.trim(),
      autoOrganize: inAutoOrg.checked,
      siteBase: inSiteBase.value.trim() || "https://handraw-style.com",
      siteToken: inSiteToken.value.trim(),
    };
    inClientUrl.value = config.clientUrl;
    const res = await chrome.runtime.sendMessage({ type: "saveConfig", config });
    renderStatus(res?.local, Boolean(config.siteToken));
    if (res?.local?.ok) {
      setMsg(`连接成功！手绘风客户端 ${res.local.version || ""}`, "ok");
    } else if (config.siteToken) {
      setMsg(`本机未开启（${res?.local?.error || "离线"}），已启用云端暂存模式`, "");
    } else {
      setMsg(res?.local?.error || "连接失败，请确认客户端正在运行且 Token 正确", "err");
    }
  } catch (err) {
    setMsg(`保存失败：${err?.message || err}`, "err");
  } finally {
    btnSave.disabled = false;
  }
});

btnClipNow.addEventListener("click", async () => {
  btnClipNow.disabled = true;
  setMsg("正在采集当前标签页内容…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setMsg("无法读取当前标签页", "err");
      return;
    }
    let extracted = { title: tab.title || "", rawText: "", imageUrl: "", sourceUrl: tab.url || "" };
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const sel = window.getSelection()?.toString()?.trim() || "";
          const ogImg = document.querySelector('meta[property="og:image"]')?.content || "";
          const firstLargeImg = Array.from(document.images)
            .find((im) => im.naturalWidth >= 240 && im.naturalHeight >= 240 && /^https?:/i.test(im.src))?.src || "";
          return {
            title: document.title || "",
            rawText: sel || document.querySelector('meta[name="description"]')?.content || "",
            imageUrl: ogImg || firstLargeImg,
            sourceUrl: location.href,
          };
        },
      });
      if (results?.[0]?.result) extracted = results[0].result;
    } catch {}

    const res = await chrome.runtime.sendMessage({
      type: "clip",
      payload: {
        ...extracted,
        prompt: extracted.rawText,
        sourceChannel: /x\.com|twitter\.com/i.test(extracted.sourceUrl) ? "x" : "chrome",
      },
      showToast: true,
    });
    if (res?.ok) {
      setMsg(res.channel === "cloud" ? "☁ 已存入云端暂存箱" : "✓ 已收进本机手绘风灵感库！", "ok");
      await init();
    } else {
      setMsg(`采集失败：${res?.error || "请先配对本机客户端"}`, "err");
    }
  } catch (err) {
    setMsg(`采集失败：${err?.message || err}`, "err");
  } finally {
    btnClipNow.disabled = false;
  }
});

void init();
