let token = "";

function readCookie(name) {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

export function getToken() {
  if (!token) token = readCookie("hw") || "";
  return token;
}

export function setToken(t) {
  if (t) token = t;
}

export async function api(method, path, body) {
  const opts = {
    method,
    headers: { "X-Handraw-Token": getToken() },
  };
  if (body !== undefined && body !== null) {
    if (body instanceof FormData) {
      opts.body = body;
    } else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
  }
  const resp = await fetch(path, opts);
  const txt = await resp.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { error: txt };
  }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `请求失败（${resp.status}）`);
    err.status = resp.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs && typeof attrs === "object") {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "dataset" && typeof v === "object") Object.assign(node.dataset, v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  const append = (c) => {
    if (c === undefined || c === null || c === false) return;
    if (Array.isArray(c)) c.forEach(append);
    else if (c instanceof Node) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  };
  children.forEach(append);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function toast(msg) {
  const reg = document.getElementById("toast-region");
  if (!reg) return;
  const t = el("div", { class: "toast" }, msg);
  reg.appendChild(t);
  setTimeout(() => t.remove(), 3400);
}

export function packImg(rel) {
  if (!rel) return "/img/logo.svg";
  if (rel.startsWith("http") || rel.startsWith("/") || rel.startsWith("data:")) return rel;
  if (!rel.startsWith("images/")) return localImg(rel);
  return "/files/pack/" + rel.split("/").map(encodeURIComponent).join("/") + "?t=" + encodeURIComponent(getToken());
}

export function localImg(p) {
  if (!p) return "/img/logo.svg";
  if (p.startsWith("/files/") || p.startsWith("http") || p.startsWith("data:")) return p;
  if (p.startsWith("images/")) return packImg(p);
  return "/files/local?p=" + encodeURIComponent(p) + "&t=" + encodeURIComponent(getToken());
}

export function galleryImg(url) {
  if (!url) return "/img/logo.svg";
  if (url.startsWith("http") || url.startsWith("data:")) return url;
  if (url.startsWith("/api/galleries/")) {
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + "t=" + encodeURIComponent(getToken());
  }
  if (url.startsWith("/")) return url;
  return packImg(url);
}

export function remoteThumb(src, width = 480, siteBase = "") {
  if (!src) return "/img/logo.svg";
  if (src.startsWith("/img/") || src.startsWith("/files/") || src.startsWith("data:")) return src;
  let full = src;
  if (src.startsWith("/")) {
    full = (siteBase ? siteBase.replace(/\/+$/, "") : "") + src;
  }
  if (!full.startsWith("http://") && !full.startsWith("https://") && !full.startsWith("/")) {
    return src;
  }
  return `/files/remote?url=${encodeURIComponent(full)}&w=${encodeURIComponent(width)}&t=${encodeURIComponent(getToken())}`;
}

// toWebp encodes an image as a WebP data URL for sharing (docs/sharing-v2.md:
// long edge <= maxEdge, quality 0.85). square crops to the centre square.
// Resolves "" when the WebView cannot encode WebP; the backend then falls back.
export function toWebp(src, { maxEdge = 2048, quality = 0.85, square = false } = {}) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
      if (square) {
        const side = Math.min(sw, sh);
        sx = (sw - side) / 2; sy = (sh - side) / 2; sw = sh = side;
      }
      const scale = Math.min(1, maxEdge / Math.max(sw, sh));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/webp", quality);
      resolve(url.startsWith("data:image/webp") ? url : "");
    };
    img.onerror = () => resolve("");
    img.src = src;
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea", { style: { position: "fixed", opacity: "0" } }, text);
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function money(cents) {
  return "¥" + (Number(cents || 0) / 100).toFixed(2);
}

export function openURL(url) {
  return api("POST", "/api/open", { url });
}

export function setColorScheme(mode) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (mode === "light" || mode === "dark") {
    try { localStorage.setItem("color-scheme", mode); } catch {}
    if (meta) meta.content = mode;
  } else {
    try { localStorage.removeItem("color-scheme"); } catch {}
    if (meta) meta.content = "light dark";
  }
}

export function installDialogLightDismiss() {
  if ("closedBy" in HTMLDialogElement.prototype) return;
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener("pointerdown", (e) => { pressedOutside = outside(e, dialog); });
    dialog.addEventListener("pointerup", (e) => {
      if (pressedOutside && outside(e, dialog)) dialog.close("");
    });
  }
}

let _activeModalCleanup = null;

export function showModal(title, bodyNode, footerNodes = [], opts = {}) {
  const dlg = document.getElementById("app-dialog");
  const headEl = dlg.querySelector(".modal-head");
  const titleEl = document.getElementById("app-dialog-title");
  const bodyEl = document.getElementById("app-dialog-body");
  const footEl = document.getElementById("app-dialog-foot");
  if (_activeModalCleanup) {
    try { _activeModalCleanup(); } catch {}
    _activeModalCleanup = null;
  }
  dlg.className = "modal" + (opts.className ? " " + opts.className : "");
  if (headEl) headEl.hidden = Boolean(opts.hideHeader);
  footEl.hidden = Boolean(opts.hideFooter);
  bodyEl.classList.toggle("modal-body-flush", Boolean(opts.flush));
  titleEl.textContent = title || "";
  clear(bodyEl);
  clear(footEl);
  if (bodyNode) bodyEl.appendChild(bodyNode);
  for (const fn of footerNodes) footEl.appendChild(fn);
  if (typeof opts.onClose === "function") {
    const fn = opts.onClose;
    const handler = () => {
      if (_activeModalCleanup === cleanup) _activeModalCleanup = null;
      fn();
    };
    const cleanup = () => {
      dlg.removeEventListener("close", handler);
      fn();
    };
    _activeModalCleanup = cleanup;
    dlg.addEventListener("close", handler, { once: true });
  }
  dlg.returnValue = "";
  if (!dlg.open) dlg.showModal();
  return dlg;
}

export function closeModal() {
  const dlg = document.getElementById("app-dialog");
  if (dlg && dlg.open) {
    dlg.returnValue = "";
    dlg.close();
  }
}

const listeners = new Set();
export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let es = null;
export function connectEvents() {
  if (es) return;
  const openES = () => {
    if (es) return;
    es = new EventSource("/api/events?t=" + encodeURIComponent(getToken()));
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        for (const fn of listeners) fn(msg);
      } catch {}
    };
  };
  if (document.readyState === "complete") openES();
  else window.addEventListener("load", openES, { once: true });
}
