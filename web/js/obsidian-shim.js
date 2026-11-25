// Sandboxed Obsidian Plugin Runtime & API Compatibility Shim (#115)
// Runs inside /obsidian-host.html (opaque sandbox iframe, no access to parent token/DOM).
// Communicates with the Handraw Article Workbench strictly via window.parent.postMessage.

// Provide isolated in-memory localStorage/sessionStorage so plugins never hit SecurityError
// inside an opaque sandboxed iframe (lacking allow-same-origin).
function createMemoryStorage() {
  const store = new Map();
  return new Proxy({
    get length() { return store.size; },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    getItem(k) { const s = String(k); return store.has(s) ? store.get(s) : null; },
    setItem(k, v) { store.set(String(k), String(v)); },
    removeItem(k) { store.delete(String(k)); },
    clear() { store.clear(); },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      const s = String(prop);
      return store.has(s) ? store.get(s) : undefined;
    },
    set(target, prop, val) {
      if (prop in target) return false;
      store.set(String(prop), String(val));
      return true;
    },
    deleteProperty(target, prop) {
      store.delete(String(prop));
      return true;
    },
  });
}
const memLocalStorage = createMemoryStorage();
const memSessionStorage = createMemoryStorage();
try { Object.defineProperty(window, "localStorage", { value: memLocalStorage, configurable: true }); } catch {}
try { Object.defineProperty(window, "sessionStorage", { value: memSessionStorage, configurable: true }); } catch {}

const PARENT = window.parent;
let nextRpcId = 1;
const pendingRpcs = new Map();

function rpc(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    pendingRpcs.set(id, { resolve, reject });
    PARENT.postMessage({ kind: "obs-rpc", id, action, payload }, "*");
  });
}

function notifyParent(event, data = {}) {
  PARENT.postMessage({ kind: "obs-event", event, data }, "*");
}

// ---------- Obsidian HTMLElement DOM Helpers ----------
function installDomHelpers() {
  const applyOpts = (el, o, cb) => {
    if (typeof o === "string") {
      el.className = o;
    } else if (o && typeof o === "object") {
      if (o.cls) {
        const clsList = Array.isArray(o.cls) ? o.cls : String(o.cls).split(/\s+/);
        clsList.filter(Boolean).forEach((c) => el.classList.add(c));
      }
      if (o.text !== undefined) {
        if (o.text instanceof DocumentFragment) el.appendChild(o.text);
        else el.textContent = String(o.text);
      }
      if (o.attr && typeof o.attr === "object") {
        for (const [k, v] of Object.entries(o.attr)) {
          if (v === null || v === undefined || v === false) el.removeAttribute(k);
          else el.setAttribute(k, v === true ? "" : String(v));
        }
      }
      if (o.title !== undefined) el.title = String(o.title);
      if (o.type !== undefined) el.setAttribute("type", String(o.type));
      if (o.value !== undefined) el.value = String(o.value);
      if (o.placeholder !== undefined) el.setAttribute("placeholder", String(o.placeholder));
      if (o.href !== undefined) el.setAttribute("href", String(o.href));
    }
    if (typeof cb === "function") cb(el);
    return el;
  };

  const createElImpl = function (tag, o, cb) {
    const child = document.createElement(tag);
    applyOpts(child, o, cb);
    if (o && typeof o === "object" && o.prepend) this.prepend(child);
    else this.appendChild(child);
    return child;
  };

  for (const proto of [HTMLElement.prototype, DocumentFragment.prototype]) {
    if (!proto.createEl) proto.createEl = createElImpl;
    if (!proto.createDiv) proto.createDiv = function (o, cb) { return this.createEl("div", o, cb); };
    if (!proto.createSpan) proto.createSpan = function (o, cb) { return this.createEl("span", o, cb); };
    if (!proto.appendText) proto.appendText = function (s) { this.appendChild(document.createTextNode(String(s ?? ""))); return this; };
  }

  const EP = HTMLElement.prototype;
  EP.empty = function () { this.textContent = ""; return this; };
  EP.addClass = function (...cls) { cls.flat().forEach((c) => String(c || "").split(/\s+/).filter(Boolean).forEach((x) => this.classList.add(x))); return this; };
  EP.addClasses = function (cls) { return this.addClass(...(cls || [])); };
  EP.removeClass = function (...cls) { cls.flat().forEach((c) => String(c || "").split(/\s+/).filter(Boolean).forEach((x) => this.classList.remove(x))); return this; };
  EP.removeClasses = function (cls) { return this.removeClass(...(cls || [])); };
  EP.toggleClass = function (cls, val) {
    const list = Array.isArray(cls) ? cls : String(cls || "").split(/\s+/).filter(Boolean);
    list.forEach((c) => this.classList.toggle(c, val));
    return this;
  };
  EP.hasClass = function (cls) { return this.classList.contains(cls); };
  EP.setText = function (val) {
    if (val instanceof DocumentFragment) { this.textContent = ""; this.appendChild(val); }
    else this.textContent = String(val ?? "");
    return this;
  };
  EP.getText = function () { return this.textContent || ""; };
  EP.setAttr = function (k, v) {
    if (v === null || v === undefined || v === false) this.removeAttribute(k);
    else this.setAttribute(k, v === true ? "" : String(v));
    return this;
  };
  EP.setAttrs = function (obj) { if (obj) for (const [k, v] of Object.entries(obj)) this.setAttr(k, v); return this; };
  EP.setCssProps = function (props) { if (props) for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v); return this; };
  EP.setCssStyles = function (styles) { if (styles) Object.assign(this.style, styles); return this; };
  EP.show = function () { this.style.display = ""; return this; };
  EP.hide = function () { this.style.display = "none"; return this; };
  EP.isShown = function () { return this.style.display !== "none" && this.offsetParent !== null; };
  EP.find = function (sel) { return this.querySelector(sel); };
  EP.findAll = function (sel) { return Array.from(this.querySelectorAll(sel)); };
  EP.onClickEvent = function (cb) { this.addEventListener("click", cb); return this; };
  EP.on = function (type, selector, listener, options) {
    const fn = (ev) => {
      const target = ev.target && ev.target.closest ? ev.target.closest(selector) : null;
      if (target && this.contains(target)) listener.call(target, ev, target);
    };
    this.addEventListener(type, fn, options);
    return fn;
  };

  window.createEl = (tag, o, cb) => applyOpts(document.createElement(tag), o, cb);
  window.createDiv = (o, cb) => window.createEl("div", o, cb);
  window.createSpan = (o, cb) => window.createEl("span", o, cb);
  window.createFragment = (cb) => {
    const frag = document.createDocumentFragment();
    if (typeof cb === "function") cb(frag);
    return frag;
  };
}
installDomHelpers();

// ---------- Encoding & Crypto Helpers ----------
function uint8ToBase64(u8) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToUint8(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function arrayBufferToBase64(buf) {
  return uint8ToBase64(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
}

function base64ToArrayBuffer(b64) {
  return base64ToUint8(b64).buffer;
}

// Compact Buffer polyfill (covers utf8/base64/hex/latin1, alloc, from, concat, isBuffer)
class BufferPolyfill extends Uint8Array {
  static isBuffer(obj) { return obj instanceof BufferPolyfill || obj instanceof Uint8Array; }
  static alloc(size, fill = 0) {
    const b = new BufferPolyfill(size);
    if (fill) b.fill(typeof fill === "number" ? fill : String(fill).charCodeAt(0));
    return b;
  }
  static allocUnsafe(size) { return new BufferPolyfill(size); }
  static byteLength(str, enc = "utf8") {
    if (str instanceof Uint8Array) return str.byteLength;
    return BufferPolyfill.from(String(str), enc).byteLength;
  }
  static concat(list, totalLength) {
    const arrays = (list || []).map((x) => (x instanceof Uint8Array ? x : BufferPolyfill.from(x)));
    const len = totalLength ?? arrays.reduce((a, b) => a + b.byteLength, 0);
    const out = new BufferPolyfill(len);
    let off = 0;
    for (const a of arrays) {
      if (off >= len) break;
      out.set(a.subarray(0, len - off), off);
      off += a.byteLength;
    }
    return out;
  }
  static from(value, enc = "utf8") {
    if (value instanceof ArrayBuffer) return new BufferPolyfill(value);
    if (ArrayBuffer.isView(value)) return new BufferPolyfill(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    if (Array.isArray(value)) return new BufferPolyfill(value);
    const s = String(value ?? "");
    const e = String(enc || "utf8").toLowerCase();
    if (e === "base64") return new BufferPolyfill(base64ToUint8(s));
    if (e === "hex") {
      const clean = s.replace(/[^0-9a-f]/gi, "");
      const out = new BufferPolyfill(Math.floor(clean.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    if (e === "latin1" || e === "binary") {
      const out = new BufferPolyfill(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
      return out;
    }
    return new BufferPolyfill(new TextEncoder().encode(s));
  }
  toString(enc = "utf8") {
    const e = String(enc || "utf8").toLowerCase();
    if (e === "base64") return uint8ToBase64(this);
    if (e === "hex") return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
    if (e === "latin1" || e === "binary") {
      let s = "";
      for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]);
      return s;
    }
    return new TextDecoder("utf-8").decode(this);
  }
}
window.Buffer = BufferPolyfill;

// Pure-JS synchronous SHA-256 & MD5 for node:crypto createHash()
function sha256Bytes(bytes) {
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);
  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new BufferPolyfill(32);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((val, idx) => ov.setUint32(idx * 4, val, false));
  return out;
}

function md5Bytes(bytes) {
  const s = [
    7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
    5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
    6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);
  for (let off = 0; off < paddedLen; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const t = (A + F + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((t << s[i]) | (t >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new BufferPolyfill(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((val, idx) => ov.setUint32(idx * 4, val, true));
  return out;
}

// ---------- Obsidian Core Classes & Utilities ----------
function normalizePath(p) {
  if (!p) return "/";
  let s = String(p).replace(/\\/g, "/").replace(/\/+/g, "/");
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  return s || "/";
}

function debounce(cb, timeout = 0, resetTimer = false) {
  let timer = null;
  const fn = function (...args) {
    if (timer && resetTimer) clearTimeout(timer);
    if (!timer || resetTimer) {
      timer = setTimeout(() => {
        timer = null;
        cb.apply(this, args);
      }, timeout);
    }
    return fn;
  };
  fn.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } return fn; };
  return fn;
}

function parseYaml(yamlStr) {
  const out = {};
  const lines = String(yamlStr || "").replace(/\r\n/g, "\n").split("\n");
  let currentKey = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\s*-\s+/.test(raw) && currentKey) {
      if (!Array.isArray(out[currentKey])) out[currentKey] = [];
      out[currentKey].push(parseYamlScalar(trimmed.replace(/^-\s+/, "")));
      continue;
    }
    const idx = raw.indexOf(":");
    if (idx > 0 && !raw.startsWith(" ")) {
      const k = raw.slice(0, idx).trim();
      const v = raw.slice(idx + 1).trim();
      currentKey = k;
      if (v === "") out[k] = [];
      else if (v.startsWith("[") && v.endsWith("]")) {
        const inner = v.slice(1, -1).trim();
        out[k] = inner ? inner.split(",").map((x) => parseYamlScalar(x.trim())) : [];
      } else {
        out[k] = parseYamlScalar(v);
      }
    }
  }
  return out;
}

function parseYamlScalar(v) {
  const s = String(v || "").trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function stringifyYaml(obj) {
  if (!obj || typeof obj !== "object") return "";
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`);
      else {
        lines.push(`${k}:`);
        v.forEach((item) => lines.push(`  - ${typeof item === "string" && /[:#\n]/.test(item) ? JSON.stringify(item) : item}`));
      }
    } else if (typeof v === "string") {
      lines.push(`${k}: ${/[:#\n]/.test(v) ? JSON.stringify(v) : v}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

function getFrontMatterInfo(content) {
  const s = String(content || "");
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  return { exists: true, frontmatter: m[1], from: 4, to: 4 + m[1].length, contentStart: m[0].length };
}

function parseFrontMatterEntry(fm, key) {
  if (!fm || typeof fm !== "object") return null;
  const keys = Array.isArray(key) ? key : [key];
  for (const k of keys) {
    if (k in fm) return fm[k];
    const low = String(k).toLowerCase();
    for (const fk of Object.keys(fm)) {
      if (fk.toLowerCase() === low) return fm[fk];
    }
  }
  return null;
}

function parseFrontMatterStringArray(fm, key) {
  const val = parseFrontMatterEntry(fm, key);
  if (val == null) return null;
  if (Array.isArray(val)) return val.map((x) => String(x));
  return String(val).split(/[,\s]+/).filter(Boolean);
}

function getLinkpath(linktext) {
  return String(linktext || "").split("#")[0].split("|")[0].trim();
}

function stripHeading(h) {
  return String(h || "").replace(/^#+\s*/, "").trim();
}

function prepareSimpleSearch(query) {
  const tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return (text) => {
    const low = String(text || "").toLowerCase();
    if (!tokens.length) return { score: 0, matches: [] };
    const matches = [];
    for (const t of tokens) {
      const idx = low.indexOf(t);
      if (idx < 0) return null;
      matches.push([idx, idx + t.length]);
    }
    return { score: -matches[0][0], matches };
  };
}

// Lightweight moment.js compatible helper
function createMoment(input) {
  const d = input ? new Date(input) : new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const api = {
    toDate: () => new Date(d.getTime()),
    valueOf: () => d.getTime(),
    unix: () => Math.floor(d.getTime() / 1000),
    isValid: () => !Number.isNaN(d.getTime()),
    format(fmt = "YYYY-MM-DDTHH:mm:ss") {
      return String(fmt)
        .replace(/YYYY/g, String(d.getFullYear()))
        .replace(/YY/g, String(d.getFullYear()).slice(-2))
        .replace(/MM/g, pad(d.getMonth() + 1))
        .replace(/DD/g, pad(d.getDate()))
        .replace(/HH/g, pad(d.getHours()))
        .replace(/mm/g, pad(d.getMinutes()))
        .replace(/ss/g, pad(d.getSeconds()));
    },
    add(n, unit) {
      const next = new Date(d.getTime());
      const u = String(unit || "d").toLowerCase();
      if (u.startsWith("d")) next.setDate(next.getDate() + n);
      else if (u.startsWith("h")) next.setHours(next.getHours() + n);
      else if (u.startsWith("m")) next.setMinutes(next.getMinutes() + n);
      else if (u.startsWith("s")) next.setSeconds(next.getSeconds() + n);
      return createMoment(next);
    },
    subtract(n, unit) { return api.add(-n, unit); },
  };
  return api;
}
createMoment.locale = () => "zh-cn";
window.moment = createMoment;

// Clean SVG Icon Registry (Lucide-like)
const CUSTOM_ICONS = new Map();
const BUILTIN_ICONS = {
  "send": '<path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9 22 2Z"/>',
  "upload": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  "copy": '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  "eye": '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 0 1 0 4h-.09c-.66 0-1.25.4-1.51 1z"/>',
  "refresh-cw": '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  "check": '<polyline points="20 6 9 17 4 12"/>',
  "x": '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  "sparkles": '<path d="m12 3-1.9 5.8L4.3 10.7l5.8 1.9L12 18.4l1.9-5.8 5.8-1.9-5.8-1.9L12 3Z"/>',
  "trash": '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  "plus": '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  "image": '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  "default": '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
};

function addIcon(iconId, svgContent) {
  CUSTOM_ICONS.set(String(iconId), String(svgContent || ""));
}

function getIcon(iconId) {
  const wrap = document.createElement("div");
  setIcon(wrap, iconId);
  return wrap.firstElementChild || null;
}

function getIconIds() {
  return [...Object.keys(BUILTIN_ICONS), ...Array.from(CUSTOM_ICONS.keys())];
}

function setIcon(parent, iconId) {
  if (!parent) return;
  parent.textContent = "";
  const id = String(iconId || "");
  if (CUSTOM_ICONS.has(id)) {
    const raw = CUSTOM_ICONS.get(id);
    parent.innerHTML = raw.trim().startsWith("<svg")
      ? raw
      : `<svg viewBox="0 0 100 100" width="16" height="16" fill="currentColor">${raw}</svg>`;
    return;
  }
  const inner = BUILTIN_ICONS[id] || BUILTIN_ICONS.default;
  parent.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

class Events {
  constructor() { this._listeners = new Map(); }
  on(name, callback, ctx) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    const ref = { name, callback, ctx };
    this._listeners.get(name).add(ref);
    return ref;
  }
  off(name, callback) {
    const set = this._listeners.get(name);
    if (!set) return;
    for (const ref of set) {
      if (ref.callback === callback) set.delete(ref);
    }
  }
  offref(ref) {
    if (!ref || !ref.name) return;
    this._listeners.get(ref.name)?.delete(ref);
  }
  trigger(name, ...data) {
    const set = this._listeners.get(name);
    if (!set) return;
    for (const ref of Array.from(set)) {
      try { ref.callback.apply(ref.ctx, data); } catch (err) { console.error("[obsidian-shim] event error:", name, err); }
    }
  }
  tryTrigger(evt, args) { this.trigger(evt.name, ...(args || [])); }
}

class Component {
  constructor() {
    this._loaded = false;
    this._cleanups = [];
    this._children = new Set();
  }
  load() {
    if (this._loaded) return;
    this._loaded = true;
    if (typeof this.onload === "function") this.onload();
    for (const c of this._children) c.load();
  }
  onload() {}
  unload() {
    if (!this._loaded) return;
    this._loaded = false;
    for (const c of Array.from(this._children)) c.unload();
    this._children.clear();
    if (typeof this.onunload === "function") {
      try { this.onunload(); } catch (err) { console.error("[obsidian-shim] onunload error:", err); }
    }
    for (const fn of this._cleanups.splice(0)) {
      try { fn(); } catch {}
    }
  }
  onunload() {}
  addChild(comp) {
    this._children.add(comp);
    if (this._loaded && typeof comp.load === "function") comp.load();
    return comp;
  }
  removeChild(comp) {
    this._children.delete(comp);
    if (typeof comp.unload === "function") comp.unload();
    return comp;
  }
  register(cb) { if (typeof cb === "function") this._cleanups.push(cb); }
  registerEvent(eventRef) {
    if (eventRef && eventRef._owner) {
      this._cleanups.push(() => eventRef._owner.offref(eventRef));
    } else if (eventRef) {
      this._cleanups.push(() => {
        appInstance?.workspace?.offref(eventRef);
        appInstance?.vault?.offref(eventRef);
        appInstance?.metadataCache?.offref(eventRef);
      });
    }
  }
  registerDomEvent(el, type, cb, options) {
    el.addEventListener(type, cb, options);
    this._cleanups.push(() => el.removeEventListener(type, cb, options));
  }
  registerInterval(id) {
    this._cleanups.push(() => clearInterval(id));
    return id;
  }
}

// ---------- Vault & FileSystemAdapter ----------
class TAbstractFile {
  constructor(vault, path, name) {
    this.vault = vault;
    this.path = path;
    this.name = name;
    this.parent = null;
  }
}

class TFile extends TAbstractFile {
  constructor(vault, entry) {
    super(vault, entry.path, entry.name);
    this.basename = entry.basename || entry.name.replace(/\.[^.]+$/, "");
    this.extension = entry.extension || "";
    this.stat = { ctime: entry.ctime || Date.now(), mtime: entry.mtime || Date.now(), size: entry.size || 0 };
  }
}

class TFolder extends TAbstractFile {
  constructor(vault, path, name) {
    super(vault, path, name);
    this.children = [];
  }
  isRoot() { return this.path === "/" || this.path === ""; }
}

class TExternalFile extends TAbstractFile {
  constructor(vault, path, name) {
    super(vault, path || "", name || "");
  }
}

class MarkdownRenderChild extends Component {
  constructor(containerEl) {
    super();
    this.containerEl = containerEl;
  }
}

class PopoverSuggest {
  constructor(app, scope) {
    this.app = app || appInstance;
    this.scope = scope || new Scope();
  }
  open() {}
  close() {}
  renderSuggestion() {}
  selectSuggestion() {}
}

class HoverPopover extends Component {
  constructor(parent, targetEl) {
    super();
    this.hoverEl = document.createElement("div");
    this.targetEl = targetEl;
    this.state = 0;
  }
}

class Scope {
  constructor(parent) { this.parent = parent || null; this._keys = []; }
  register(modifiers, key, func) { const h = { modifiers, key, func }; this._keys.push(h); return h; }
  unregister(h) { this._keys = this._keys.filter((x) => x !== h); }
}

const Keymap = {
  isModifier: () => false,
  isModEvent: (ev) => Boolean(ev && (ev.ctrlKey || ev.metaKey)),
};

class AbstractInputSuggest {
  constructor(app, inputEl) {
    this.app = app || appInstance;
    this.inputEl = inputEl;
    this.limit = 100;
  }
  setValue(v) { if (this.inputEl) this.inputEl.value = String(v ?? ""); }
  getValue() { return this.inputEl?.value ?? ""; }
  open() {}
  close() {}
  selectSuggestion() {}
  getSuggestions() { return []; }
  renderSuggestion() {}
}

class EditorSuggest {
  constructor(app) {
    this.app = app || appInstance;
    this.limit = 50;
  }
  open() {}
  close() {}
  onTrigger() { return null; }
  getSuggestions() { return []; }
  renderSuggestion() {}
  selectSuggestion() {}
}

function sanitizeHTMLToDom(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(html || "");
  tpl.content.querySelectorAll("script,iframe,object,embed").forEach((n) => n.remove());
  return tpl.content;
}

function displayTooltip(el, msg) {
  if (el && msg) el.title = String(msg);
}

function getLanguage() {
  return "zh";
}

class DataAdapter {}

class FileSystemAdapter extends DataAdapter {
  constructor(vault) {
    super();
    this._vault = vault;
    this.basePath = "";
  }
  getName() { return "FileSystemAdapter"; }
  getBasePath() { return this.basePath || ""; }
  getFullPath(normalizedPath) {
    const base = this.getBasePath().replace(/[\\/]+$/, "");
    const rel = normalizePath(normalizedPath);
    if (!base) return rel;
    const sep = hostEnv.pathSep || "/";
    return base + sep + rel.replace(/\//g, sep);
  }
  async exists(normalizedPath) {
    const p = normalizePath(normalizedPath);
    return this._vault._byPath.has(p);
  }
  async stat(normalizedPath) {
    const f = this._vault.getAbstractFileByPath(normalizedPath);
    if (!f) return null;
    if (f instanceof TFolder) return { type: "folder", ctime: 0, mtime: 0, size: 0 };
    return { type: "file", ctime: f.stat.ctime, mtime: f.stat.mtime, size: f.stat.size };
  }
  async read(normalizedPath) {
    const res = await rpc("vault.read", { path: normalizePath(normalizedPath), binary: false });
    return res.text ?? "";
  }
  async readBinary(normalizedPath) {
    const res = await rpc("vault.read", { path: normalizePath(normalizedPath), binary: true });
    return base64ToArrayBuffer(res.base64 || "");
  }
  async write(normalizedPath, data) {
    await rpc("vault.write", { path: normalizePath(normalizedPath), text: String(data ?? "") });
    await this._vault._refresh();
  }
  async writeBinary(normalizedPath, data) {
    await rpc("vault.write", { path: normalizePath(normalizedPath), base64: arrayBufferToBase64(data) });
    await this._vault._refresh();
  }
  async append(normalizedPath, data) {
    const prev = await this.read(normalizedPath).catch(() => "");
    await this.write(normalizedPath, prev + String(data ?? ""));
  }
  async mkdir(normalizedPath) {
    await rpc("vault.write", { path: normalizePath(normalizedPath), mkdir: true });
    await this._vault._refresh();
  }
  async remove(normalizedPath) {
    await rpc("vault.delete", { path: normalizePath(normalizedPath) });
    await this._vault._refresh();
  }
  async list(normalizedPath) {
    const norm = normalizePath(normalizedPath);
    const prefix = norm === "/" ? "" : norm + "/";
    const files = [];
    const folders = [];
    for (const f of this._vault._byPath.values()) {
      if (f.path === norm) continue;
      if (prefix && !f.path.startsWith(prefix)) continue;
      const rest = prefix ? f.path.slice(prefix.length) : f.path;
      if (rest.includes("/")) continue;
      if (f instanceof TFolder) folders.push(f.path);
      else files.push(f.path);
    }
    return { files, folders };
  }
  getResourcePath(normalizedPath) {
    // Returns a proxy marker or relative path; MarkdownRenderer resolves via data URLs when needed.
    return normalizePath(normalizedPath);
  }
}

class Vault extends Events {
  constructor() {
    super();
    this.configDir = ".obsidian";
    this.config = {};
    this.adapter = new FileSystemAdapter(this);
    this._name = "articles";
    this._byPath = new Map();
    this._root = new TFolder(this, "/", "");
    this._textCache = new Map();
  }
  getConfig(key) { return this.config[key]; }
  setConfig(key, val) { this.config[key] = val; }
  getName() { return this._name; }
  getRoot() { return this._root; }
  _syncFromList(payload) {
    this._name = payload.name || "articles";
    this.adapter.basePath = payload.rootDir || "";
    this._byPath.clear();
    this._root = new TFolder(this, "/", "");
    this._byPath.set("/", this._root);
    const entries = Array.isArray(payload.files) ? payload.files : [];
    for (const e of entries) {
      if (e.isDir) {
        const folder = new TFolder(this, e.path, e.name);
        this._byPath.set(e.path, folder);
      } else {
        const file = new TFile(this, e);
        this._byPath.set(e.path, file);
      }
    }
    for (const item of this._byPath.values()) {
      if (item === this._root) continue;
      const idx = item.path.lastIndexOf("/");
      const parentPath = idx > 0 ? item.path.slice(0, idx) : "/";
      const parent = this._byPath.get(parentPath) || this._root;
      item.parent = parent;
      if (parent instanceof TFolder) parent.children.push(item);
    }
    // Pre-populate known existing paths for sync fs.existsSync
    for (const item of this._byPath.values()) {
      if (item !== this._root && this.adapter.basePath) {
        knownExistingPaths.add(normFsKey(this.adapter.getFullPath(item.path)));
      }
    }
  }
  async _refresh() {
    const res = await rpc("vault.list");
    this._syncFromList(res);
  }
  getAbstractFileByPath(p) {
    const norm = normalizePath(p);
    return this._byPath.get(norm) || null;
  }
  getFileByPath(p) {
    const f = this.getAbstractFileByPath(p);
    return f instanceof TFile ? f : null;
  }
  getFolderByPath(p) {
    const f = this.getAbstractFileByPath(p);
    return f instanceof TFolder ? f : null;
  }
  getAllLoadedFiles() { return Array.from(this._byPath.values()); }
  getFiles() { return Array.from(this._byPath.values()).filter((x) => x instanceof TFile); }
  getMarkdownFiles() { return this.getFiles().filter((f) => f.extension === "md" || f.extension === "markdown"); }
  async read(file) {
    const p = typeof file === "string" ? normalizePath(file) : file.path;
    if (activeDoc.path && normalizePath(activeDoc.path) === p && typeof activeDoc.content === "string") {
      this._textCache.set(p, activeDoc.content);
      return activeDoc.content;
    }
    const text = await this.adapter.read(p);
    this._textCache.set(p, text);
    return text;
  }
  async cachedRead(file) { return this.read(file); }
  async readBinary(file) {
    const p = typeof file === "string" ? normalizePath(file) : file.path;
    return this.adapter.readBinary(p);
  }
  async modify(file, data) {
    const p = typeof file === "string" ? normalizePath(file) : file.path;
    const text = String(data ?? "");
    this._textCache.set(p, text);
    if (activeDoc.path && normalizePath(activeDoc.path) === p) {
      activeDoc.content = text;
      notifyParent("editor-set-value", { path: p, content: text });
    }
    await this.adapter.write(p, text);
    const f = this.getFileByPath(p);
    if (f) this.trigger("modify", f);
  }
  async process(file, fn) {
    const cur = await this.read(file);
    const next = fn(cur);
    if (next !== cur) await this.modify(file, next);
    return next;
  }
  async create(p, data) {
    const norm = normalizePath(p);
    await this.adapter.write(norm, String(data ?? ""));
    const f = this.getFileByPath(norm);
    if (f) this.trigger("create", f);
    return f;
  }
  async createBinary(p, data) {
    const norm = normalizePath(p);
    await this.adapter.writeBinary(norm, data);
    const f = this.getFileByPath(norm);
    if (f) this.trigger("create", f);
    return f;
  }
  async createFolder(p) {
    await this.adapter.mkdir(p);
    return this.getFolderByPath(p);
  }
  async append(file, data) {
    const cur = await this.read(file);
    await this.modify(file, cur + String(data ?? ""));
  }
  async delete(file) {
    const p = typeof file === "string" ? normalizePath(file) : file.path;
    await this.adapter.remove(p);
    this.trigger("delete", file);
  }
  async trash(file) { return this.delete(file); }
  getResourcePath(file) {
    const p = typeof file === "string" ? file : file.path;
    return this.adapter.getResourcePath(p);
  }
}

class MetadataCache extends Events {
  constructor(vault) {
    super();
    this._vault = vault;
    this._cache = new Map();
  }
  _computeCache(text) {
    const s = String(text || "");
    const fmInfo = getFrontMatterInfo(s);
    const frontmatter = fmInfo.exists ? parseYaml(fmInfo.frontmatter) : undefined;
    const headings = [];
    const links = [];
    const embeds = [];
    const tags = [];
    const lines = s.split(/\r?\n/);
    lines.forEach((ln, idx) => {
      const hm = ln.match(/^(#{1,6})\s+(.+)$/);
      if (hm) headings.push({ heading: hm[2].trim(), level: hm[1].length, position: { start: { line: idx, col: 0 }, end: { line: idx, col: ln.length } } });
      for (const m of ln.matchAll(/(!)?\[\[([^\]]+)\]\]/g)) {
        const isEmbed = Boolean(m[1]);
        const raw = m[2];
        const [target, display] = raw.split("|");
        const entry = { link: target.trim(), original: m[0], displayText: (display || target).trim() };
        if (isEmbed) embeds.push(entry);
        else links.push(entry);
      }
      for (const m of ln.matchAll(/(!)?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const isEmbed = Boolean(m[1]);
        const entry = { link: m[3].trim(), original: m[0], displayText: m[2] };
        if (isEmbed) embeds.push(entry);
        else links.push(entry);
      }
      for (const m of ln.matchAll(/(?:^|\s)(#[\w\u4e00-\u9fa5/-]+)/g)) {
        tags.push({ tag: m[1] });
      }
    });
    return { frontmatter, headings, links, embeds, tags };
  }
  _updateActive(path, content) {
    if (!path) return;
    const norm = normalizePath(path);
    const cache = this._computeCache(content);
    this._cache.set(norm, cache);
    const f = this._vault.getFileByPath(norm);
    if (f) this.trigger("changed", f, content, cache);
  }
  getFileCache(file) {
    if (!file) return null;
    const p = typeof file === "string" ? normalizePath(file) : file.path;
    if (activeDoc.path && normalizePath(activeDoc.path) === p) {
      const c = this._computeCache(activeDoc.content || "");
      this._cache.set(p, c);
      return c;
    }
    return this._cache.get(p) || null;
  }
  getCache(p) { return this.getFileCache(p); }
  getFirstLinkpathDest(linkpath, sourcePath = "") {
    let target = getLinkpath(linkpath);
    if (!target) return null;
    try { target = decodeURIComponent(target); } catch {}
    const files = this._vault.getFiles();

    // 1. Relative to sourcePath directory
    if (sourcePath) {
      const srcDir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
      const joined = normalizePath(srcDir ? `${srcDir}/${target.replace(/^\.\//, "")}` : target.replace(/^\.\//, ""));
      const exactRel = this._vault.getFileByPath(joined) || this._vault.getFileByPath(joined + ".md");
      if (exactRel) return exactRel;
    }
    // 2. Direct vault-relative path
    const norm = normalizePath(target.replace(/^\.\//, ""));
    const direct = this._vault.getFileByPath(norm) || this._vault.getFileByPath(norm + ".md");
    if (direct) return direct;

    // 3. Basename or filename match (Obsidian shortest-path resolution)
    const low = target.toLowerCase();
    for (const f of files) {
      if (f.name.toLowerCase() === low || f.basename.toLowerCase() === low || f.path.toLowerCase().endsWith("/" + low)) {
        return f;
      }
    }
    return null;
  }
  fileToLinktext(file, sourcePath = "") {
    if (!file) return "";
    return file.extension === "md" ? file.basename : file.name;
  }
}

// ---------- Editor & Views ----------
class Editor {
  constructor() {}
  getValue() { return activeDoc.content || ""; }
  setValue(val) {
    activeDoc.content = String(val ?? "");
    notifyParent("editor-set-value", { path: activeDoc.path, content: activeDoc.content });
    appInstance.metadataCache._updateActive(activeDoc.path, activeDoc.content);
  }
  getSelection() {
    const s = activeDoc.content || "";
    const a = Math.max(0, activeDoc.selStart || 0);
    const b = Math.max(a, activeDoc.selEnd || a);
    return s.slice(a, b);
  }
  somethingSelected() { return (activeDoc.selEnd || 0) > (activeDoc.selStart || 0); }
  replaceSelection(replacement) {
    const s = activeDoc.content || "";
    const a = Math.max(0, activeDoc.selStart || 0);
    const b = Math.max(a, activeDoc.selEnd || a);
    const rep = String(replacement ?? "");
    const next = s.slice(0, a) + rep + s.slice(b);
    activeDoc.selStart = a;
    activeDoc.selEnd = a + rep.length;
    this.setValue(next);
  }
  _lines() { return (activeDoc.content || "").split(/\r?\n/); }
  lineCount() { return this._lines().length; }
  lastLine() { return Math.max(0, this.lineCount() - 1); }
  getLine(n) { return this._lines()[n] ?? ""; }
  setLine(n, text) {
    const lines = this._lines();
    lines[n] = String(text ?? "");
    this.setValue(lines.join("\n"));
  }
  posToOffset(pos) {
    const lines = this._lines();
    const ln = Math.max(0, Math.min(pos?.line || 0, lines.length - 1));
    let off = 0;
    for (let i = 0; i < ln; i++) off += lines[i].length + 1;
    return off + Math.max(0, Math.min(pos?.ch || 0, lines[ln].length));
  }
  offsetToPos(offset) {
    const s = activeDoc.content || "";
    const clamped = Math.max(0, Math.min(offset || 0, s.length));
    const head = s.slice(0, clamped);
    const lines = head.split("\n");
    return { line: lines.length - 1, ch: lines[lines.length - 1].length };
  }
  getCursor(which = "from") {
    const off = which === "to" ? (activeDoc.selEnd || 0) : (activeDoc.selStart || 0);
    return this.offsetToPos(off);
  }
  setCursor(pos, ch) {
    const p = typeof pos === "number" ? { line: pos, ch: ch || 0 } : pos;
    const off = this.posToOffset(p);
    activeDoc.selStart = off;
    activeDoc.selEnd = off;
  }
  getRange(from, to) {
    return (activeDoc.content || "").slice(this.posToOffset(from), this.posToOffset(to));
  }
  replaceRange(replacement, from, to) {
    const s = activeDoc.content || "";
    const a = this.posToOffset(from);
    const b = to ? this.posToOffset(to) : a;
    this.setValue(s.slice(0, a) + String(replacement ?? "") + s.slice(b));
  }
  listSelections() { return [{ anchor: this.getCursor("from"), head: this.getCursor("to") }]; }
  focus() {}
  transaction(tx) {
    if (!tx || !Array.isArray(tx.changes)) return;
    // Apply reverse-sorted changes cleanly
    const sorted = [...tx.changes].sort((a, b) => this.posToOffset(b.from) - this.posToOffset(a.from));
    let s = activeDoc.content || "";
    for (const ch of sorted) {
      const a = this.posToOffset(ch.from);
      const b = ch.to ? this.posToOffset(ch.to) : a;
      s = s.slice(0, a) + String(ch.text ?? "") + s.slice(b);
    }
    this.setValue(s);
  }
}

class View extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf?.workspace?._app || window.app || null;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "view-container";
  }
  getViewType() { return "empty"; }
  getDisplayText() { return "View"; }
  getIcon() { return "file-text"; }
  async onOpen() {}
  async onClose() {}
}

class ItemView extends View {
  constructor(leaf) {
    super(leaf);
    // Obsidian convention: containerEl.children[0] is header, containerEl.children[1] is contentEl!
    this.headerEl = this.containerEl.createDiv({ cls: "view-header" });
    this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
  }
}

class FileView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.file = null;
  }
}

class MarkdownView extends FileView {
  constructor(leaf) {
    super(leaf);
    this.editor = new Editor();
    this.data = "";
  }
  getViewType() { return "markdown"; }
  getDisplayText() { return this.file?.basename || activeDoc.title || "当前文章"; }
  getMode() { return "source"; }
  getViewData() { return this.editor.getValue(); }
  setViewData(data) { this.editor.setValue(data); }
}

class WorkspaceLeaf {
  constructor(workspace, id) {
    this.workspace = workspace;
    this._id = id;
    this.view = null;
    this._state = { type: "empty" };
  }
  getViewState() { return { ...this._state }; }
  async setViewState(state) {
    if (this.view && typeof this.view.onClose === "function") {
      try { await this.view.onClose(); } catch {}
    }
    this._state = { ...state };
    const creator = this.workspace._viewCreators.get(state.type);
    if (creator) {
      this.view = creator(this);
      if (this.view) {
        if (typeof this.view.load === "function") this.view.load();
        if (typeof this.view.onOpen === "function") await this.view.onOpen();
      }
      this.workspace._registerOpenLeaf(this, Boolean(state.active));
    }
  }
  async openFile(file) {
    if (file?.path) {
      notifyParent("open-file", { path: file.path });
    }
  }
  detach() {
    if (this.view) {
      try { this.view.onClose?.(); } catch {}
      try { this.view.unload?.(); } catch {}
    }
    this.workspace._removeLeaf(this);
  }
}

class Workspace extends Events {
  constructor(app) {
    super();
    this._app = app;
    this._viewCreators = new Map();
    this._leaves = [];
    this._activeCustomLeaf = null;
    this._mdLeaf = new WorkspaceLeaf(this, "markdown-active");
    this._mdView = new MarkdownView(this._mdLeaf);
    this._mdLeaf.view = this._mdView;
    this.activeLeaf = this._mdLeaf;
    this.rightSplit = { collapsed: true };
    this.leftSplit = { collapsed: false };
    this._layoutReady = true;
    this._leafSeq = 1;
  }
  onLayoutReady(cb) {
    if (typeof cb === "function") setTimeout(cb, 0);
  }
  updateOptions() {}
  requestSaveLayout() {}
  getActiveFile() {
    if (!activeDoc.path) return null;
    const existing = this._app.vault.getFileByPath(activeDoc.path);
    if (existing) return existing;
    const name = activeDoc.path.split("/").pop() || "untitled.md";
    return new TFile(this._app.vault, {
      path: normalizePath(activeDoc.path),
      name,
      basename: name.replace(/\.[^.]+$/, ""),
      extension: "md",
    });
  }
  getActiveViewOfType(cls) {
    this._mdView.file = this.getActiveFile();
    this._mdView.data = activeDoc.content || "";
    if (!cls || cls === MarkdownView || this._mdView instanceof cls) {
      return this._mdView;
    }
    if (this._activeCustomLeaf?.view instanceof cls) {
      return this._activeCustomLeaf.view;
    }
    return null;
  }
  getLeavesOfType(type) {
    if (type === "markdown") return [this._mdLeaf];
    return this._leaves.filter((l) => l.getViewState().type === type);
  }
  iterateAllLeaves(cb) {
    cb(this._mdLeaf);
    for (const l of this._leaves) cb(l);
  }
  getRightLeaf() {
    const leaf = new WorkspaceLeaf(this, `leaf-${this._leafSeq++}`);
    this._leaves.push(leaf);
    return leaf;
  }
  getLeftLeaf() { return this.getRightLeaf(); }
  getLeaf() { return this.getRightLeaf(); }
  revealLeaf(leaf) {
    if (!leaf) return;
    if (leaf === this._mdLeaf) return;
    if (!this._leaves.includes(leaf)) this._leaves.push(leaf);
    this._activeCustomLeaf = leaf;
    renderOpenViews();
    notifyParent("ui-state", buildUiState(true));
  }
  detachLeavesOfType(type) {
    for (const l of this.getLeavesOfType(type)) l.detach();
  }
  _registerOpenLeaf(leaf, activate) {
    if (!this._leaves.includes(leaf)) this._leaves.push(leaf);
    if (activate || !this._activeCustomLeaf) this._activeCustomLeaf = leaf;
    renderOpenViews();
    notifyParent("ui-state", buildUiState(Boolean(activate)));
  }
  _removeLeaf(leaf) {
    this._leaves = this._leaves.filter((l) => l !== leaf);
    if (this._activeCustomLeaf === leaf) {
      this._activeCustomLeaf = this._leaves[0] || null;
    }
    renderOpenViews();
    notifyParent("ui-state", buildUiState(false));
  }
  async openLinkText(linktext, sourcePath) {
    const dest = this._app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
    if (dest) notifyParent("open-file", { path: dest.path });
  }
}

// ---------- MarkdownRenderer ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderBasicMarkdown(md) {
  const src = String(md || "").replace(/\r\n/g, "\n");
  const fm = getFrontMatterInfo(src);
  const body = fm.exists ? src.slice(fm.contentStart) : src;
  const lines = body.split("\n");
  const out = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let inList = null;

  const flushList = () => {
    if (inList) { out.push(`</${inList}>`); inList = null; }
  };

  const inline = (txt) => {
    let s = escapeHtml(txt);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, url) => `<img src="${url}" alt="${alt}" data-obs-src="${url}">`);
    s = s.replace(/!\[\[([^\]]+)\]\]/g, (_, inner) => {
      const [t, alt] = inner.split("|");
      return `<img src="${t.trim()}" alt="${(alt || t).trim()}" data-obs-src="${t.trim()}">`;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return s;
  };

  for (const ln of lines) {
    if (ln.trim().startsWith("```")) {
      flushList();
      if (!inCode) {
        inCode = true;
        codeLang = ln.trim().slice(3).trim();
        codeBuf = [];
      } else {
        out.push(`<pre><code class="language-${escapeHtml(codeLang)}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        inCode = false;
      }
      continue;
    }
    if (inCode) { codeBuf.push(ln); continue; }
    const t = ln.trim();
    if (!t) { flushList(); continue; }
    const hm = t.match(/^(#{1,6})\s+(.+)$/);
    if (hm) { flushList(); out.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushList(); out.push("<hr>"); continue; }
    if (t.startsWith("> ")) { flushList(); out.push(`<blockquote><p>${inline(t.slice(2))}</p></blockquote>`); continue; }
    const ulm = t.match(/^[-*+]\s+(.+)$/);
    if (ulm) {
      if (inList !== "ul") { flushList(); inList = "ul"; out.push("<ul>"); }
      out.push(`<li>${inline(ulm[1])}</li>`);
      continue;
    }
    const olm = t.match(/^\d+\.\s+(.+)$/);
    if (olm) {
      if (inList !== "ol") { flushList(); inList = "ol"; out.push("<ol>"); }
      out.push(`<li>${inline(olm[1])}</li>`);
      continue;
    }
    flushList();
    out.push(`<p>${inline(t)}</p>`);
  }
  flushList();
  return out.join("\n");
}

const markdownPostProcessors = [];

const MarkdownRenderer = {
  async render(app, markdown, el, sourcePath = "", component = null) {
    if (!el) return;
    el.classList.add("markdown-rendered");
    el.innerHTML = renderBasicMarkdown(markdown);
    // Resolve local vault images to inline data URLs so WeChat/preview plugins render & copy cleanly!
    const imgs = Array.from(el.querySelectorAll("img[data-obs-src]"));
    await Promise.all(imgs.map(async (img) => {
      const rawSrc = img.getAttribute("data-obs-src") || "";
      if (!rawSrc || /^https?:\/\/|^data:/i.test(rawSrc)) return;
      const dest = app?.metadataCache?.getFirstLinkpathDest(rawSrc, sourcePath);
      if (!dest) return;
      try {
        const res = await rpc("vault.read", { path: dest.path, binary: true });
        if (res?.base64) {
          const ext = (dest.extension || "png").toLowerCase();
          const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
            : ext === "webp" ? "image/webp"
            : ext === "gif" ? "image/gif"
            : ext === "svg" ? "image/svg+xml"
            : "image/png";
          img.src = `data:${mime};base64,${res.base64}`;
        }
      } catch {}
    }));
    const ctx = { sourcePath, frontmatter: app?.metadataCache?.getCache(sourcePath)?.frontmatter || {}, addChild: (c) => component?.addChild?.(c) };
    for (const pp of markdownPostProcessors) {
      try { await pp(el, ctx); } catch (err) { console.error("[obsidian-shim] postProcessor error:", err); }
    }
  },
  async renderMarkdown(markdown, el, sourcePath = "", component = null) {
    return MarkdownRenderer.render(appInstance, markdown, el, sourcePath, component);
  },
};

// ---------- UI Components: Notice, Modal, SuggestModal, Setting, Menu ----------
class Notice {
  constructor(message, timeout = 4500) {
    this.noticeEl = document.createElement("div");
    this.noticeEl.className = "notice";
    this.setMessage(message);
    const region = document.getElementById("obs-notice-region");
    if (region) region.appendChild(this.noticeEl);
    const text = this.noticeEl.textContent || "";
    if (text) notifyParent("notice", { message: text });
    if (timeout > 0) {
      this._timer = setTimeout(() => this.hide(), timeout);
    }
  }
  setMessage(msg) {
    if (msg instanceof DocumentFragment) { this.noticeEl.textContent = ""; this.noticeEl.appendChild(msg); }
    else this.noticeEl.textContent = String(msg ?? "");
    return this;
  }
  hide() {
    if (this._timer) clearTimeout(this._timer);
    this.noticeEl.remove();
  }
}

const openModals = [];

class Modal {
  constructor(app) {
    this.app = app || appInstance;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "modal-container";
    this.modalEl = this.containerEl.createDiv({ cls: "modal" });
    this._headerEl = this.modalEl.createDiv({ cls: "modal-header" });
    this.titleEl = this._headerEl.createEl("div", { cls: "modal-title" });
    const closeBtn = this._headerEl.createEl("button", { cls: "modal-close-button", type: "button", text: "✕", attr: { "aria-label": "关闭" } });
    closeBtn.addEventListener("click", () => this.close());
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
  }
  setTitle(title) {
    this.titleEl.textContent = String(title ?? "");
    return this;
  }
  open() {
    const overlay = document.getElementById("obs-modal-overlay");
    if (!overlay) return;
    if (!openModals.includes(this)) openModals.push(this);
    overlay.textContent = "";
    overlay.appendChild(this.containerEl);
    overlay.classList.add("is-open");
    document.body.classList.add("has-modal");
    notifyParent("ui-state", buildUiState(false));
    try { this.onOpen(); } catch (err) { console.error("[obsidian-shim] Modal.onOpen error:", err); }
  }
  close() {
    try { this.onClose(); } catch (err) { console.error("[obsidian-shim] Modal.onClose error:", err); }
    const idx = openModals.indexOf(this);
    if (idx >= 0) openModals.splice(idx, 1);
    const overlay = document.getElementById("obs-modal-overlay");
    if (overlay) {
      overlay.textContent = "";
      if (openModals.length > 0) {
        overlay.appendChild(openModals[openModals.length - 1].containerEl);
      } else {
        overlay.classList.remove("is-open");
        document.body.classList.remove("has-modal");
      }
    }
    notifyParent("ui-state", buildUiState(false));
  }
  onOpen() {}
  onClose() {}
}

class SuggestModal extends Modal {
  constructor(app) {
    super(app);
    this.emptyStateText = "无匹配项";
    this.inputEl = null;
    this.resultContainerEl = null;
  }
  setPlaceholder(p) { this._placeholder = p; if (this.inputEl) this.inputEl.placeholder = p; }
  setInstructions() {}
  onOpen() {
    this.contentEl.empty();
    this.inputEl = this.contentEl.createEl("input", { cls: "prompt-input", type: "search", placeholder: this._placeholder || "输入关键词筛选…" });
    this.resultContainerEl = this.contentEl.createDiv({ cls: "prompt-results" });
    const renderList = async () => {
      const items = await Promise.resolve(this.getSuggestions(this.inputEl.value || ""));
      this.resultContainerEl.empty();
      if (!items || !items.length) {
        this.resultContainerEl.createDiv({ cls: "obs-empty-view", text: this.emptyStateText });
        return;
      }
      items.forEach((it, idx) => {
        const row = this.resultContainerEl.createDiv({ cls: "suggestion-item" + (idx === 0 ? " is-selected" : "") });
        this.renderSuggestion(it, row);
        row.addEventListener("click", (ev) => {
          this.onChooseSuggestion(it, ev);
          this.close();
        });
      });
    };
    this.inputEl.addEventListener("input", renderList);
    renderList();
    setTimeout(() => this.inputEl?.focus(), 0);
  }
  getSuggestions() { return []; }
  renderSuggestion(value, el) { el.setText(String(value)); }
  onChooseSuggestion() {}
}

class FuzzySuggestModal extends SuggestModal {
  getItems() { return []; }
  getItemText(item) { return String(item); }
  getSuggestions(query) {
    const search = prepareSimpleSearch(query);
    return (this.getItems() || [])
      .map((item) => ({ item, match: search(this.getItemText(item)) }))
      .filter((x) => x.match !== null);
  }
  renderSuggestion(match, el) { el.setText(this.getItemText(match.item)); }
  onChooseSuggestion(match, ev) { this.onChooseItem(match.item, ev); }
  onChooseItem() {}
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app || appInstance;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "obs-setting-tab";
  }
  display() {}
  hide() {}
}

// Setting Component Builders
class BaseComponent {
  constructor() { this.disabled = false; }
  setDisabled(d) { this.disabled = Boolean(d); if (this.inputEl) this.inputEl.disabled = this.disabled; return this; }
  then(cb) { cb(this); return this; }
}

class TextComponent extends BaseComponent {
  constructor(containerEl) {
    super();
    this.inputEl = containerEl.createEl("input", { type: "text" });
    this._cb = null;
    this.inputEl.addEventListener("input", () => this._cb?.(this.inputEl.value));
  }
  getValue() { return this.inputEl.value; }
  setValue(v) { this.inputEl.value = String(v ?? ""); return this; }
  setPlaceholder(p) { this.inputEl.placeholder = String(p ?? ""); return this; }
  onChange(cb) { this._cb = cb; return this; }
}

class MomentFormatComponent extends TextComponent {
  setDefaultFormat(f) { this._defaultFormat = f; return this; }
  setSampleEl(el) { this._sampleEl = el; return this; }
  updateSample() { return this; }
}

class ProgressBarComponent extends BaseComponent {
  constructor(containerEl) {
    super();
    this.progressEl = containerEl.createEl("progress");
  }
  setValue(v) { this.progressEl.value = Number(v || 0); return this; }
  getValue() { return Number(this.progressEl.value || 0); }
}

class SearchComponent extends TextComponent {
  constructor(containerEl) {
    super(containerEl);
    this.inputEl.type = "search";
  }
}

class TextAreaComponent extends BaseComponent {
  constructor(containerEl) {
    super();
    this.inputEl = containerEl.createEl("textarea");
    this.inputEl.rows = 3;
    this._cb = null;
    this.inputEl.addEventListener("input", () => this._cb?.(this.inputEl.value));
  }
  getValue() { return this.inputEl.value; }
  setValue(v) { this.inputEl.value = String(v ?? ""); return this; }
  setPlaceholder(p) { this.inputEl.placeholder = String(p ?? ""); return this; }
  onChange(cb) { this._cb = cb; return this; }
}

class ToggleComponent extends BaseComponent {
  constructor(containerEl) {
    super();
    this.toggleEl = containerEl.createDiv({ cls: "checkbox-container" });
    this.inputEl = this.toggleEl.createEl("input", { type: "checkbox" });
    this._val = false;
    this._cb = null;
    this.toggleEl.addEventListener("click", () => {
      if (this.disabled) return;
      this.setValue(!this._val);
      this._cb?.(this._val);
    });
  }
  getValue() { return this._val; }
  setValue(v) {
    this._val = Boolean(v);
    this.inputEl.checked = this._val;
    this.toggleEl.classList.toggle("is-enabled", this._val);
    return this;
  }
  setTooltip(t) { this.toggleEl.title = String(t ?? ""); return this; }
  onChange(cb) { this._cb = cb; return this; }
}

class DropdownComponent extends BaseComponent {
  constructor(containerEl) {
    super();
    this.selectEl = containerEl.createEl("select");
    this.inputEl = this.selectEl;
    this._cb = null;
    this.selectEl.addEventListener("change", () => this._cb?.(this.selectEl.value));
  }
  addOption(val, display) {
    const opt = this.selectEl.createEl("option", { value: String(val), text: String(display ?? val) });
    opt.value = String(val);
    return this;
  }
  addOptions(map) {
    if (map && typeof map === "object") {
      for (const [k, v] of Object.entries(map)) this.addOption(k, v);
    }
    return this;
  }
  getValue() { return this.selectEl.value; }
  setValue(v) { this.selectEl.value = String(v ?? ""); return this; }
  onChange(cb) { this._cb = cb; return this; }
}

class ButtonComponent extends BaseComponent {
  constructor(containerEl) {
    super();
    this.buttonEl = containerEl.createEl("button", { type: "button" });
    this.inputEl = this.buttonEl;
  }
  setButtonText(t) { this.buttonEl.textContent = String(t ?? ""); return this; }
  setIcon(id) { setIcon(this.buttonEl, id); return this; }
  setTooltip(t) { this.buttonEl.title = String(t ?? ""); return this; }
  setCta() { this.buttonEl.classList.add("mod-cta"); return this; }
  removeCta() { this.buttonEl.classList.remove("mod-cta"); return this; }
  setWarning() { this.buttonEl.classList.add("mod-warning"); return this; }
  setClass(c) { this.buttonEl.classList.add(c); return this; }
  onClick(cb) { this.buttonEl.addEventListener("click", cb); return this; }
}

class ExtraButtonComponent extends ButtonComponent {
  constructor(containerEl) {
    super(containerEl);
    this.extraSettingsEl = this.buttonEl;
    this.buttonEl.classList.add("clickable-icon");
  }
}

class SliderComponent extends BaseComponent {
  constructor(containerEl) {
    super();
    this.sliderEl = containerEl.createEl("input", { type: "range" });
    this.inputEl = this.sliderEl;
    this._cb = null;
    this.sliderEl.addEventListener("input", () => this._cb?.(Number(this.sliderEl.value)));
  }
  setLimits(min, max, step) {
    if (min != null) this.sliderEl.min = String(min);
    if (max != null) this.sliderEl.max = String(max);
    if (step != null && step !== "any") this.sliderEl.step = String(step);
    return this;
  }
  getValue() { return Number(this.sliderEl.value); }
  setValue(v) { this.sliderEl.value = String(v ?? 0); return this; }
  setDynamicTooltip() { return this; }
  onChange(cb) { this._cb = cb; return this; }
}

class ColorComponent extends BaseComponent {
  constructor(containerEl) {
    super();
    this.inputEl = containerEl.createEl("input", { type: "color" });
    this._cb = null;
    this.inputEl.addEventListener("input", () => this._cb?.(this.inputEl.value));
  }
  getValue() { return this.inputEl.value; }
  setValue(v) { this.inputEl.value = String(v || "#000000"); return this; }
  onChange(cb) { this._cb = cb; return this; }
}

class Setting {
  constructor(containerEl) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
    this.components = [];
  }
  setName(name) { this.nameEl.setText(name); return this; }
  setDesc(desc) { this.descEl.setText(desc); return this; }
  setClass(cls) { this.settingEl.addClass(cls); return this; }
  setTooltip(t) { this.settingEl.title = String(t ?? ""); return this; }
  setHeading() { this.settingEl.addClass("setting-item-heading"); return this; }
  setDisabled(d) { this.components.forEach((c) => c.setDisabled?.(d)); return this; }
  clear() { this.controlEl.empty(); this.components = []; return this; }
  then(cb) { cb(this); return this; }
  _add(comp, cb) { this.components.push(comp); if (typeof cb === "function") cb(comp); return this; }
  addText(cb) { return this._add(new TextComponent(this.controlEl), cb); }
  addSearch(cb) { return this._add(new SearchComponent(this.controlEl), cb); }
  addTextArea(cb) { return this._add(new TextAreaComponent(this.controlEl), cb); }
  addToggle(cb) { return this._add(new ToggleComponent(this.controlEl), cb); }
  addDropdown(cb) { return this._add(new DropdownComponent(this.controlEl), cb); }
  addButton(cb) { return this._add(new ButtonComponent(this.controlEl), cb); }
  addExtraButton(cb) { return this._add(new ExtraButtonComponent(this.controlEl), cb); }
  addSlider(cb) { return this._add(new SliderComponent(this.controlEl), cb); }
  addColorPicker(cb) { return this._add(new ColorComponent(this.controlEl), cb); }
}

class Menu {
  constructor() { this._items = []; }
  addItem(cb) {
    const item = { title: "", icon: "", onClick: null, setTitle(t) { this.title = t; return this; }, setIcon(i) { this.icon = i; return this; }, onClick(fn) { this._click = fn; return this; } };
    cb(item);
    this._items.push(item);
    return this;
  }
  addSeparator() { this._items.push({ sep: true }); return this; }
  showAtPosition(pos) {
    document.querySelectorAll(".menu").forEach((m) => m.remove());
    const menuEl = document.body.createDiv({ cls: "menu" });
    menuEl.style.left = `${Math.max(8, Math.min(pos.x, window.innerWidth - 190))}px`;
    menuEl.style.top = `${Math.max(8, Math.min(pos.y, window.innerHeight - 200))}px`;
    for (const it of this._items) {
      if (it.sep) { menuEl.createDiv({ cls: "menu-separator" }); continue; }
      const row = menuEl.createDiv({ cls: "menu-item" });
      if (it.icon) { const ico = row.createSpan(); setIcon(ico, it.icon); }
      row.createSpan({ text: it.title });
      row.addEventListener("click", (ev) => { menuEl.remove(); it._click?.(ev); });
    }
    const dismiss = (ev) => { if (!menuEl.contains(ev.target)) { menuEl.remove(); document.removeEventListener("mousedown", dismiss); } };
    setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
  }
  showAtMouseEvent(ev) { this.showAtPosition({ x: ev.clientX || 20, y: ev.clientY || 20 }); }
}

// ---------- Plugin Base Class & Registry ----------
const loadedPlugins = new Map(); // pluginId -> { instance, manifest, styleEl, commands, ribbons, settingTab, viewTypes }

class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app || appInstance;
    this.manifest = manifest || { id: "unknown", name: "Unknown", version: "0.0.0" };
    this._commands = [];
    this._ribbons = [];
    this._settingTab = null;
    this._viewTypes = [];
  }
  addCommand(cmd) {
    const fullId = `${this.manifest.id}:${cmd.id}`;
    const entry = { ...cmd, fullId, pluginId: this.manifest.id, pluginName: this.manifest.name };
    this._commands.push(entry);
    if (this.app?.commands?.commands) this.app.commands.commands[fullId] = entry;
    syncRegistryToParent();
    return entry;
  }
  addRibbonIcon(icon, title, callback) {
    const id = `${this.manifest.id}:ribbon:${this._ribbons.length}`;
    const el = document.createElement("button");
    el.type = "button";
    el.title = title;
    setIcon(el, icon);
    el.addEventListener("click", callback);
    this._ribbons.push({ id, icon, title, callback, el, pluginId: this.manifest.id, pluginName: this.manifest.name });
    syncRegistryToParent();
    return el;
  }
  addStatusBarItem() { return document.createElement("span"); }
  addSettingTab(tab) {
    this._settingTab = tab;
    syncRegistryToParent();
  }
  registerView(type, viewCreator) {
    this._viewTypes.push(type);
    this.app.workspace._viewCreators.set(type, viewCreator);
    this.register(() => {
      this.app.workspace.detachLeavesOfType(type);
      this.app.workspace._viewCreators.delete(type);
    });
  }
  registerExtensions() {}
  registerMarkdownPostProcessor(pp) {
    markdownPostProcessors.push(pp);
    this.register(() => {
      const i = markdownPostProcessors.indexOf(pp);
      if (i >= 0) markdownPostProcessors.splice(i, 1);
    });
    return pp;
  }
  registerMarkdownCodeBlockProcessor() {}
  registerEditorExtension() {
    // Graceful no-op in segmented textarea mode (Phase 1)
  }
  registerObsidianProtocolHandler() {}
  registerHoverLinkSource() {}
  async loadData() {
    const res = await rpc("plugin.readData", { pluginId: this.manifest.id });
    return res.data ?? null;
  }
  async saveData(data) {
    await rpc("plugin.writeData", { pluginId: this.manifest.id, data: data ?? null });
  }
}

// ---------- requestUrl Bridge ----------
function makeRequestUrl(pluginId) {
  return async function requestUrl(param) {
    const reqObj = typeof param === "string" ? { url: param, method: "GET" } : { ...(param || {}) };
    const payload = {
      url: reqObj.url,
      method: reqObj.method || "GET",
      contentType: reqObj.contentType || "",
      headers: reqObj.headers || {},
    };
    if (reqObj.body !== undefined && reqObj.body !== null) {
      if (typeof reqObj.body === "string") payload.bodyText = reqObj.body;
      else if (reqObj.body instanceof ArrayBuffer || ArrayBuffer.isView(reqObj.body)) {
        payload.bodyBase64 = arrayBufferToBase64(reqObj.body);
      } else {
        payload.bodyText = String(reqObj.body);
      }
    }
    const res = await rpc("requestUrl", { pluginId, request: payload });
    const u8 = base64ToUint8(res.bodyBase64 || "");
    const text = new TextDecoder("utf-8").decode(u8);
    const out = {
      status: res.status || 200,
      headers: res.headers || {},
      arrayBuffer: u8.buffer,
      text,
      get json() {
        try { return JSON.parse(text); } catch { return null; }
      },
    };
    if (reqObj.throw !== false && out.status >= 400) {
      const err = new Error(`Request failed, status ${out.status}`);
      err.status = out.status;
      err.headers = out.headers;
      err.text = out.text;
      throw err;
    }
    return out;
  };
}

// ---------- Node.js / Electron Lightweight Polyfills ----------
let hostEnv = { platform: "win32", tmpDir: "/tmp", homeDir: "/", pathSep: "/", delimiter: ":", pathEnv: "", knownExecutables: {} };
const knownExistingPaths = new Set();

function normFsKey(p) {
  const s = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return hostEnv.platform === "win32" ? s.toLowerCase() : s;
}

function createPathModule() {
  const isWin = hostEnv.platform === "win32";
  const sep = isWin ? "\\" : "/";
  const delimiter = isWin ? ";" : ":";
  const splitParts = (p) => String(p || "").replace(/\\/g, "/").split("/");
  const isAbsolute = (p) => {
    const s = String(p || "");
    return s.startsWith("/") || s.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(s);
  };
  const normalize = (p) => {
    let s = String(p || "").replace(/\\/g, "/");
    let prefix = "";
    const drive = s.match(/^([A-Za-z]:)(\/|$)/);
    if (drive) { prefix = drive[1] + (drive[2] ? "/" : ""); s = s.slice(prefix.length); }
    else if (s.startsWith("/")) { prefix = "/"; s = s.slice(1); }
    const stack = [];
    for (const seg of s.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        if (stack.length && stack[stack.length - 1] !== "..") stack.pop();
        else if (!prefix) stack.push("..");
      } else stack.push(seg);
    }
    const res = prefix + stack.join("/");
    return (isWin ? res.replace(/\//g, "\\") : res) || ".";
  };
  const join = (...args) => normalize(args.filter((x) => x !== undefined && x !== null && x !== "").join("/"));
  const resolve = (...args) => {
    let resolved = "";
    for (let i = args.length - 1; i >= 0; i--) {
      const part = String(args[i] || "");
      if (!part) continue;
      resolved = resolved ? `${part}/${resolved}` : part;
      if (isAbsolute(part)) break;
    }
    return normalize(resolved);
  };
  const dirname = (p) => {
    const s = String(p || "").replace(/[\\/]+$/, "");
    const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    if (idx < 0) return ".";
    if (idx === 0) return s[0];
    if (idx === 2 && /^[A-Za-z]:/.test(s)) return s.slice(0, 3);
    return s.slice(0, idx);
  };
  const basename = (p, ext) => {
    const s = String(p || "").replace(/[\\/]+$/, "");
    const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    let base = idx >= 0 ? s.slice(idx + 1) : s;
    if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
    return base;
  };
  const extname = (p) => {
    const base = basename(p);
    const idx = base.lastIndexOf(".");
    return idx > 0 ? base.slice(idx) : "";
  };
  const relative = (from, to) => {
    const a = normalize(from).replace(/\\/g, "/").split("/").filter(Boolean);
    const b = normalize(to).replace(/\\/g, "/").split("/").filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && (isWin ? a[i].toLowerCase() === b[i].toLowerCase() : a[i] === b[i])) i++;
    const up = new Array(a.length - i).fill("..");
    return [...up, ...b.slice(i)].join(sep) || ".";
  };
  const parse = (p) => {
    const dir = dirname(p);
    const base = basename(p);
    const ext = extname(p);
    return { root: isAbsolute(p) ? (p.match(/^[A-Za-z]:[\\/]/)?.[0] || sep) : "", dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
  };
  const mod = { sep, delimiter, isAbsolute, normalize, join, resolve, dirname, basename, extname, relative, parse };
  mod.posix = mod;
  mod.win32 = mod;
  mod.default = mod;
  return mod;
}

class NodeEventEmitter {
  constructor() { this._ev = new Map(); }
  on(n, fn) { if (!this._ev.has(n)) this._ev.set(n, []); this._ev.get(n).push(fn); return this; }
  once(n, fn) { const w = (...a) => { this.off(n, w); fn(...a); }; return this.on(n, w); }
  off(n, fn) { const l = this._ev.get(n); if (l) this._ev.set(n, l.filter((x) => x !== fn)); return this; }
  removeListener(n, fn) { return this.off(n, fn); }
  emit(n, ...a) { const l = this._ev.get(n) || []; l.forEach((fn) => fn(...a)); return l.length > 0; }
}

function createDesktopFsModules(pluginId) {
  const promises = {
    async readFile(p, opts) {
      const res = await rpc("desktop.fs", { pluginId, req: { op: "readFile", path: String(p) } });
      const buf = BufferPolyfill.from(res.base64 || "", "base64");
      const enc = typeof opts === "string" ? opts : opts?.encoding;
      return enc ? buf.toString(enc) : buf;
    },
    async writeFile(p, data) {
      const req = { op: "writeFile", path: String(p) };
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) req.dataBase64 = arrayBufferToBase64(data);
      else req.dataText = String(data ?? "");
      await rpc("desktop.fs", { pluginId, req });
      knownExistingPaths.add(normFsKey(p));
    },
    async mkdir(p, opts) {
      await rpc("desktop.fs", { pluginId, req: { op: "mkdir", path: String(p), recursive: Boolean(opts?.recursive) } });
      knownExistingPaths.add(normFsKey(p));
    },
    async mkdtemp(prefix) {
      const res = await rpc("desktop.fs", { pluginId, req: { op: "mkdtemp", path: String(prefix) } });
      knownExistingPaths.add(normFsKey(res.path));
      return res.path;
    },
    async rm(p, opts) {
      await rpc("desktop.fs", { pluginId, req: { op: "rm", path: String(p), recursive: Boolean(opts?.recursive), force: Boolean(opts?.force) } });
      knownExistingPaths.delete(normFsKey(p));
    },
    async unlink(p) { return promises.rm(p, { force: false }); },
    async stat(p) {
      const res = await rpc("desktop.fs", { pluginId, req: { op: "stat", path: String(p) } });
      return {
        size: res.size || 0,
        mtimeMs: res.mtime || 0,
        mtime: new Date(res.mtime || 0),
        isFile: () => Boolean(res.isFile),
        isDirectory: () => Boolean(res.isDir),
      };
    },
    async realpath(p) {
      const res = await rpc("desktop.fs", { pluginId, req: { op: "realpath", path: String(p) } });
      return res.path || String(p);
    },
    async access(p) {
      const res = await rpc("desktop.fs", { pluginId, req: { op: "access", path: String(p) } });
      if (!res.exists) throw new Error(`ENOENT: no such file or directory, access '${p}'`);
    },
    async readdir(p, opts) {
      const res = await rpc("desktop.fs", { pluginId, req: { op: "readdir", path: String(p) } });
      const entries = res.entries || [];
      if (opts?.withFileTypes) {
        return entries.map((e) => ({ name: e.name, isDirectory: () => Boolean(e.isDir), isFile: () => !e.isDir }));
      }
      return entries.map((e) => e.name);
    },
    async copyFile(src, dst) {
      await rpc("desktop.fs", { pluginId, req: { op: "copyFile", path: String(src), destPath: String(dst) } });
      knownExistingPaths.add(normFsKey(dst));
    },
  };

  const fsMod = {
    promises,
    existsSync(p) {
      const key = normFsKey(p);
      if (knownExistingPaths.has(key)) return true;
      // Match known executables by full path
      for (const exePath of Object.values(hostEnv.knownExecutables || {})) {
        if (normFsKey(exePath) === key) return true;
      }
      return false;
    },
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
  };
  fsMod.default = fsMod;
  return { fsMod, promises };
}

function createChildProcessModule(pluginId) {
  const spawn = (executable, args = [], opts = {}) => {
    const child = new NodeEventEmitter();
    child.stdout = new NodeEventEmitter();
    child.stderr = new NodeEventEmitter();
    child.stdin = { write() {}, end() {} };
    child.killed = false;
    child.kill = () => { child.killed = true; };

    // Resolve known executable name if bare
    let exe = String(executable || "");
    const known = hostEnv.knownExecutables || {};
    if (known[exe]) exe = known[exe];

    const envOverrides = {};
    if (opts?.env && typeof opts.env === "object") {
      for (const [k, v] of Object.entries(opts.env)) {
        if (v !== undefined && v !== null && k !== "PATH") envOverrides[k] = String(v);
      }
    }

    rpc("desktop.spawn", {
      pluginId,
      req: {
        executable: exe,
        args: (args || []).map((a) => String(a)),
        cwd: opts?.cwd || "",
        env: envOverrides,
        timeoutMs: opts?.timeout || 60000,
      },
    }).then((res) => {
      if (res.stdout) child.stdout.emit("data", BufferPolyfill.from(res.stdout, "utf8"));
      if (res.stderr) child.stderr.emit("data", BufferPolyfill.from(res.stderr, "utf8"));
      if (res.error && res.exitCode !== 0 && !res.stderr) {
        child.emit("error", new Error(res.error));
      }
      child.emit("close", res.exitCode ?? 0);
      child.emit("exit", res.exitCode ?? 0);
    }).catch((err) => {
      child.emit("error", err);
      child.emit("close", 1);
    });
    return child;
  };

  const execFile = (file, args, opts, cb) => {
    if (typeof args === "function") { cb = args; args = []; opts = {}; }
    else if (typeof opts === "function") { cb = opts; opts = {}; }
    const child = spawn(file, args, opts);
    let out = "", errText = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { errText += d.toString("utf8"); });
    child.on("close", (code) => {
      if (cb) cb(code === 0 ? null : new Error(errText || `exit ${code}`), out, errText);
    });
    return child;
  };

  const mod = { spawn, execFile, exec: (cmd, opts, cb) => execFile(cmd, [], opts, cb) };
  mod.default = mod;
  return mod;
}

function createCryptoModule() {
  const createHash = (alg) => {
    const chunks = [];
    const h = {
      update(data, enc) {
        chunks.push(data instanceof Uint8Array ? data : BufferPolyfill.from(String(data ?? ""), enc || "utf8"));
        return h;
      },
      digest(enc) {
        const merged = BufferPolyfill.concat(chunks);
        const a = String(alg || "sha256").toLowerCase();
        const bytes = a === "md5" ? md5Bytes(merged) : sha256Bytes(merged);
        return enc ? bytes.toString(enc) : bytes;
      },
    };
    return h;
  };
  const randomUUID = () => (crypto?.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  }));
  const randomBytes = (n) => {
    const out = new BufferPolyfill(n);
    if (crypto?.getRandomValues) crypto.getRandomValues(out);
    return out;
  };
  const mod = { createHash, randomUUID, randomBytes };
  mod.default = mod;
  return mod;
}

function createRequireForPlugin(pluginId, obsidianExports) {
  const pathMod = createPathModule();
  const { fsMod, promises: fsPromises } = createDesktopFsModules(pluginId);
  const cpMod = createChildProcessModule(pluginId);
  const cryptoMod = createCryptoModule();
  const osMod = {
    tmpdir: () => hostEnv.tmpDir || "/tmp",
    homedir: () => hostEnv.homeDir || "/",
    platform: () => hostEnv.platform || "win32",
    EOL: hostEnv.platform === "win32" ? "\r\n" : "\n",
    type: () => (hostEnv.platform === "win32" ? "Windows_NT" : hostEnv.platform === "darwin" ? "Darwin" : "Linux"),
    arch: () => "x64",
    constants: {
      signals: { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGTERM: 15 },
      errno: { ENOENT: 2, EACCES: 13, EEXIST: 17 },
    },
  };
  osMod.default = osMod;

  class StreamBase extends NodeEventEmitter {
    pipe(dest) { return dest; }
    destroy() { return this; }
    end() { this.emit("finish"); this.emit("end"); return this; }
    write() { return true; }
  }
  const streamMod = {
    Stream: StreamBase,
    Readable: StreamBase,
    Writable: StreamBase,
    Duplex: StreamBase,
    Transform: StreamBase,
    PassThrough: StreamBase,
    pipeline: (...args) => { const cb = args[args.length - 1]; if (typeof cb === "function") cb(null); },
  };
  streamMod.default = streamMod;

  const assertFn = (cond, msg) => { if (!cond) throw new Error(msg || "Assertion failed"); };
  assertFn.ok = assertFn;
  assertFn.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `Expected ${a} === ${b}`); };
  assertFn.equal = (a, b, msg) => { if (a != b) throw new Error(msg || `Expected ${a} == ${b}`); };
  assertFn.notStrictEqual = (a, b, msg) => { if (a === b) throw new Error(msg || `Expected ${a} !== ${b}`); };
  assertFn.default = assertFn;

  const urlMod = {
    URL,
    URLSearchParams,
    fileURLToPath: (u) => String(u).replace(/^file:\/\/\/?/, ""),
    pathToFileURL: (p) => new URL("file:///" + String(p).replace(/\\/g, "/").replace(/^\/+/, "")),
  };
  urlMod.default = urlMod;

  const processShim = {
    platform: hostEnv.platform || "win32",
    env: { PATH: hostEnv.pathEnv || "", HOME: hostEnv.homeDir || "", USERPROFILE: hostEnv.homeDir || "" },
    cwd: () => appInstance.vault.adapter.getBasePath() || "/",
    nextTick: (fn, ...a) => Promise.resolve().then(() => fn(...a)),
    versions: { node: "20.0.0" },
    version: "v20.0.0",
  };

  const electronMod = {
    clipboard: {
      writeText: (t) => navigator.clipboard?.writeText?.(String(t ?? "")).catch(() => notifyParent("copy-text", { text: String(t ?? "") })),
      writeHTML: (h) => notifyParent("copy-html", { html: String(h ?? "") }),
      readText: () => "",
    },
    shell: {
      openExternal: (u) => notifyParent("open-url", { url: String(u || "") }),
    },
  };

  // Recursive, constructible, callable stub for optional @codemirror/* & @lezer/* modules
  // so `class X extends cm.WidgetType {}` and `lezer.tags.modifier` never throw.
  function createDeepStub() {
    function StubClass() {}
    return new Proxy(StubClass, {
      get(target, prop) {
        if (prop === "__esModule") return true;
        if (prop === "prototype") return target.prototype;
        if (prop === "then") return undefined;
        if (prop === Symbol.toPrimitive) return () => "";
        if (prop === Symbol.iterator) return function* () {};
        return createDeepStub();
      },
      apply() { return createDeepStub(); },
      construct() { return createDeepStub(); },
    });
  }
  const cmStub = createDeepStub();

  window.process = processShim;

  return function customRequire(spec) {
    const norm = String(spec || "").replace(/^node:/, "");
    if (norm === "obsidian") return obsidianExports;
    if (norm === "path") return pathMod;
    if (norm === "buffer") return { Buffer: BufferPolyfill, default: { Buffer: BufferPolyfill } };
    if (norm === "os") return osMod;
    if (norm === "crypto") return cryptoMod;
    if (norm === "url") return urlMod;
    if (norm === "events") return { EventEmitter: NodeEventEmitter, default: NodeEventEmitter };
    if (norm === "process") return processShim;
    if (norm === "fs") return fsMod;
    if (norm === "fs/promises") return fsPromises;
    if (norm === "child_process") return cpMod;
    if (norm === "electron" || norm.startsWith("@electron/")) return electronMod;
    if (norm === "moment") return createMoment;
    if (norm === "util") return { promisify: (fn) => (...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v)))), inherits: () => {} };
    if (norm === "stream") return streamMod;
    if (norm === "assert") return assertFn;
    if (norm === "querystring") return { parse: (s) => Object.fromEntries(new URLSearchParams(s)), stringify: (o) => new URLSearchParams(o).toString() };
    if (norm.startsWith("@codemirror/") || norm === "codemirror" || norm.startsWith("@lezer/")) return cmStub;
    console.warn(`[obsidian-shim] Unsupported require("${spec}") requested by ${pluginId}`);
    return createDeepStub();
  };
}

// ---------- App Singleton ----------
let activeDoc = { path: "", title: "", content: "", selStart: 0, selEnd: 0 };

class App {
  constructor() {
    this.vault = new Vault();
    this.metadataCache = new MetadataCache(this.vault);
    this.workspace = new Workspace(this);
    this.fileManager = {
      processFrontMatter: async (file, fn) => {
        const raw = await this.vault.read(file);
        const info = getFrontMatterInfo(raw);
        const fm = info.exists ? parseYaml(info.frontmatter) : {};
        fn(fm);
        const body = info.exists ? raw.slice(info.contentStart) : raw;
        const next = `---\n${stringifyYaml(fm)}---\n${body}`;
        await this.vault.modify(file, next);
      },
      renameFile: async (file, newPath) => {
        const content = await this.vault.read(file);
        await this.vault.create(newPath, content);
        await this.vault.delete(file);
      },
      generateMarkdownLink: (file, sourcePath) => `![${file.basename}](${file.path})`,
    };
    this.secretStorage = {
      getSecret: async (key) => {
        const res = await rpc("secret.get", { key: String(key || "") });
        return res.value || null;
      },
      setSecret: async (key, value) => {
        await rpc("secret.set", { key: String(key || ""), value: String(value ?? "") });
      },
      listSecrets: async () => {
        const res = await rpc("secret.get", { key: "" });
        return res.keys || [];
      },
    };
    this.commands = {
      commands: {},
      executeCommandById: (id) => executePluginCommand(id),
      listCommands: () => Object.values(this.commands.commands),
    };
    this.hotkeyManager = {
      customKeys: {},
      defaultKeys: {},
      getHotkeys: () => [],
    };
    this.keymap = {
      pushScope: () => {},
      popScope: () => {},
    };
    this.isVimEnabled = () => false;
    this.loadLocalStorage = (key) => {
      try {
        const raw = memLocalStorage.getItem(String(key));
        return raw === null ? null : JSON.parse(raw);
      } catch {
        return memLocalStorage.getItem(String(key));
      }
    };
    this.saveLocalStorage = (key, val) => {
      if (val === null || val === undefined) memLocalStorage.removeItem(String(key));
      else memLocalStorage.setItem(String(key), typeof val === "string" ? val : JSON.stringify(val));
    };
    this.plugins = {
      plugins: {},
      enabledPlugins: new Set(),
      getPlugin: (id) => loadedPlugins.get(id)?.instance || null,
    };
    this.internalPlugins = { getPluginById: () => null, plugins: {} };
    this.setting = {
      open: () => {},
      openTabById: (id) => openPluginSettings(id),
    };
  }
}

const appInstance = new App();
window.app = appInstance;

function buildObsidianExports(pluginId) {
  const reqUrl = makeRequestUrl(pluginId);
  return {
    apiVersion: "1.11.4",
    requireApiVersion: () => true,
    Platform: {
      isDesktop: true,
      isDesktopApp: true,
      isMobile: false,
      isMobileApp: false,
      isIosApp: false,
      isAndroidApp: false,
      isMacOS: hostEnv.platform === "darwin",
      isWin: hostEnv.platform === "win32",
      isLinux: hostEnv.platform === "linux",
      resourcePathPrefix: "",
    },
    Component,
    Events,
    Plugin,
    App,
    Vault,
    DataAdapter,
    FileSystemAdapter,
    TAbstractFile,
    TFile,
    TFolder,
    TExternalFile,
    MarkdownRenderChild,
    AbstractInputSuggest,
    EditorSuggest,
    PopoverSuggest,
    HoverPopover,
    Scope,
    Keymap,
    EditableFileView: FileView,
    TextFileView: FileView,
    MarkdownPreviewView: ItemView,
    BaseComponent,
    ValueComponent: BaseComponent,
    AbstractTextComponent: TextComponent,
    SecretComponent: TextComponent,
    MomentFormatComponent,
    ProgressBarComponent,
    MetadataCache,
    Workspace,
    WorkspaceLeaf,
    View,
    ItemView,
    FileView,
    MarkdownView,
    Editor,
    MarkdownRenderer,
    Notice,
    Modal,
    SuggestModal,
    FuzzySuggestModal,
    PluginSettingTab,
    Setting,
    ButtonComponent,
    ExtraButtonComponent,
    TextComponent,
    SearchComponent,
    TextAreaComponent,
    ToggleComponent,
    DropdownComponent,
    SliderComponent,
    ColorComponent,
    Menu,
    requestUrl: reqUrl,
    request: async (p) => (await reqUrl(p)).text,
    normalizePath,
    debounce,
    arrayBufferToBase64,
    base64ToArrayBuffer,
    parseYaml,
    stringifyYaml,
    getFrontMatterInfo,
    parseFrontMatterEntry,
    parseFrontMatterStringArray,
    parseFrontMatterAliases: (fm) => parseFrontMatterStringArray(fm, ["aliases", "alias"]),
    parseFrontMatterTags: (fm) => parseFrontMatterStringArray(fm, ["tags", "tag"]),
    getLinkpath,
    stripHeading,
    prepareSimpleSearch,
    prepareFuzzySearch: prepareSimpleSearch,
    htmlToMarkdown: (html) => {
      const div = document.createElement("div");
      div.innerHTML = String(html || "");
      return div.textContent || "";
    },
    sanitizeHTMLToDom,
    displayTooltip,
    getLanguage,
    setIcon,
    getIcon,
    getIconIds,
    addIcon,
    loadMathJax: async () => {},
    finishRenderMath: async () => {},
    renderMath: (src) => { const s = document.createElement("span"); s.textContent = String(src || ""); return s; },
    loadPrism: async () => ({}),
    loadMermaid: async () => ({}),
    loadPdfJs: async () => ({}),
    moment: createMoment,
  };
}

// ---------- Open View Rendering & UI State ----------
function renderOpenViews() {
  const tabsEl = document.getElementById("obs-view-tabs");
  const rootEl = document.getElementById("obs-view-root");
  if (!tabsEl || !rootEl) return;
  tabsEl.textContent = "";
  rootEl.textContent = "";

  const leaves = appInstance.workspace._leaves.filter((l) => l.view);
  if (!leaves.length) {
    rootEl.innerHTML = '<div class="obs-empty-view">暂无打开的 Obsidian 插件视图。<br>可从工具栏点击插件图标或运行插件命令打开。</div>';
    return;
  }
  if (!appInstance.workspace._activeCustomLeaf || !leaves.includes(appInstance.workspace._activeCustomLeaf)) {
    appInstance.workspace._activeCustomLeaf = leaves[0];
  }
  const active = appInstance.workspace._activeCustomLeaf;
  leaves.forEach((leaf) => {
    const tab = tabsEl.createEl("button", {
      cls: "obs-view-tab" + (leaf === active ? " is-active" : ""),
      type: "button",
    });
    tab.createSpan({ text: leaf.view.getDisplayText?.() || leaf.getViewState().type || "插件视图" });
    const close = tab.createEl("span", { cls: "obs-view-tab-close", text: "✕", title: "关闭此视图" });
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      leaf.detach();
    });
    tab.addEventListener("click", () => {
      appInstance.workspace._activeCustomLeaf = leaf;
      renderOpenViews();
    });
  });

  if (active?.view?.containerEl) {
    rootEl.appendChild(active.view.containerEl);
  }
}

function buildUiState(revealDrawer = false) {
  const leaves = appInstance.workspace._leaves.filter((l) => l.view);
  return {
    modalOpen: openModals.length > 0,
    viewCount: leaves.length,
    activeViewTitle: appInstance.workspace._activeCustomLeaf?.view?.getDisplayText?.() || "",
    revealDrawer,
  };
}

function syncRegistryToParent() {
  const commands = [];
  const ribbons = [];
  const settingsTabs = [];
  const errors = [];
  for (const [id, rec] of loadedPlugins.entries()) {
    if (rec.error) {
      errors.push({ pluginId: id, error: rec.error });
      continue;
    }
    const inst = rec.instance;
    if (!inst) continue;
    for (const c of inst._commands || []) {
      commands.push({ fullId: c.fullId, id: c.id, name: c.name, pluginId: id, pluginName: rec.manifest.name });
    }
    for (const r of inst._ribbons || []) {
      ribbons.push({ id: r.id, icon: r.icon, title: r.title, pluginId: id, pluginName: rec.manifest.name });
    }
    if (inst._settingTab) {
      settingsTabs.push({ pluginId: id, pluginName: rec.manifest.name });
    }
  }
  notifyParent("registry", { commands, ribbons, settingsTabs, errors });
}

// ---------- Plugin Lifecycle Execution ----------
async function loadPluginBundle(bundle) {
  const id = bundle.id;
  await unloadPlugin(id);

  let styleEl = null;
  if (bundle.stylesCss) {
    styleEl = document.createElement("style");
    styleEl.dataset.obsPlugin = id;
    styleEl.textContent = bundle.stylesCss;
    document.head.appendChild(styleEl);
  }

  try {
    const obsidianExports = buildObsidianExports(id);
    const reqFn = createRequireForPlugin(id, obsidianExports);
    const moduleObj = { exports: {} };
    const factory = new Function(
      "require",
      "module",
      "exports",
      "global",
      "process",
      "Buffer",
      "localStorage",
      "sessionStorage",
      `${bundle.mainJs}\n//# sourceURL=obsidian-plugin-${id}.js`
    );
    factory(reqFn, moduleObj, moduleObj.exports, window, window.process, BufferPolyfill, memLocalStorage, memSessionStorage);

    const exported = moduleObj.exports;
    const PluginClass = exported?.default || exported;
    if (typeof PluginClass !== "function") {
      throw new Error("插件 main.js 未导出有效的 Plugin 类");
    }

    const instance = new PluginClass(appInstance, bundle.manifest);
    loadedPlugins.set(id, { instance, manifest: bundle.manifest, styleEl, error: "" });
    appInstance.plugins.plugins[id] = instance;
    appInstance.plugins.enabledPlugins.add(id);

    await Promise.resolve(instance.load());
    syncRegistryToParent();
    return { ok: true, id };
  } catch (err) {
    console.error(`[obsidian-shim] Failed loading plugin ${id}:`, err);
    if (styleEl) styleEl.remove();
    const msg = err?.message || String(err);
    loadedPlugins.set(id, { instance: null, manifest: bundle.manifest, styleEl: null, error: msg });
    syncRegistryToParent();
    return { ok: false, id, error: msg };
  }
}

async function unloadPlugin(id) {
  const rec = loadedPlugins.get(id);
  if (!rec) return;
  loadedPlugins.delete(id);
  delete appInstance.plugins.plugins[id];
  appInstance.plugins.enabledPlugins.delete(id);
  if (rec.instance) {
    try { await Promise.resolve(rec.instance.unload()); } catch (err) { console.error("[obsidian-shim] unload error:", id, err); }
  }
  if (rec.styleEl) rec.styleEl.remove();
  syncRegistryToParent();
}

function executePluginCommand(fullId) {
  for (const rec of loadedPlugins.values()) {
    const cmd = rec.instance?._commands?.find((c) => c.fullId === fullId || c.id === fullId);
    if (!cmd) continue;
    try {
      const mdView = appInstance.workspace.getActiveViewOfType(MarkdownView);
      if (typeof cmd.editorCallback === "function") {
        cmd.editorCallback(mdView.editor, mdView);
      } else if (typeof cmd.editorCheckCallback === "function") {
        if (cmd.editorCheckCallback(true, mdView.editor, mdView) !== false) {
          cmd.editorCheckCallback(false, mdView.editor, mdView);
        }
      } else if (typeof cmd.checkCallback === "function") {
        if (cmd.checkCallback(true) !== false) cmd.checkCallback(false);
      } else if (typeof cmd.callback === "function") {
        cmd.callback();
      }
      return { ok: true };
    } catch (err) {
      new Notice(`插件命令执行失败：${err?.message || err}`);
      return { ok: false, error: err?.message || String(err) };
    }
  }
  return { ok: false, error: `找不到命令 ${fullId}` };
}

function triggerRibbon(ribbonId) {
  for (const rec of loadedPlugins.values()) {
    const r = rec.instance?._ribbons?.find((x) => x.id === ribbonId);
    if (!r) continue;
    try {
      r.callback?.(new MouseEvent("click"));
      return { ok: true };
    } catch (err) {
      new Notice(`插件动作执行失败：${err?.message || err}`);
      return { ok: false, error: err?.message || String(err) };
    }
  }
  return { ok: false, error: "找不到插件图标" };
}

function openPluginSettings(pluginId) {
  const rec = loadedPlugins.get(pluginId);
  const tab = rec?.instance?._settingTab;
  if (!tab) {
    new Notice("该插件未提供设置面板");
    return { ok: false };
  }
  class SettingsHostModal extends Modal {
    onOpen() {
      this.setTitle(`${rec.manifest.name} · 插件设置`);
      tab.containerEl.empty();
      try { tab.display(); } catch (err) {
        tab.containerEl.createDiv({ text: `渲染设置面板失败：${err?.message || err}` });
      }
      this.contentEl.empty();
      this.contentEl.appendChild(tab.containerEl);
    }
    onClose() {
      try { tab.hide?.(); } catch {}
    }
  }
  new SettingsHostModal(appInstance).open();
  return { ok: true };
}

// ---------- Parent Message Dispatcher ----------
window.addEventListener("message", async (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.kind === "obs-rpc-reply") {
    const pending = pendingRpcs.get(msg.id);
    if (!pending) return;
    pendingRpcs.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || "RPC 调用失败"));
    return;
  }

  if (msg.kind === "obs-cmd") {
    const reply = (ok, result, error) => {
      if (msg.callId) PARENT.postMessage({ kind: "obs-cmd-reply", callId: msg.callId, ok, result, error }, "*");
    };
    try {
      switch (msg.action) {
        case "init": {
          if (msg.payload?.env) {
            hostEnv = { ...hostEnv, ...msg.payload.env };
            for (const p of Object.values(hostEnv.knownExecutables || {})) knownExistingPaths.add(normFsKey(p));
          }
          if (msg.payload?.theme) document.documentElement.dataset.theme = msg.payload.theme;
          if (msg.payload?.vault) appInstance.vault._syncFromList(msg.payload.vault);
          if (msg.payload?.doc) {
            activeDoc = { ...activeDoc, ...msg.payload.doc };
            appInstance.metadataCache._updateActive(activeDoc.path, activeDoc.content);
          }
          reply(true, { ready: true });
          break;
        }
        case "sync-theme": {
          document.documentElement.dataset.theme = msg.payload?.theme || "light";
          reply(true, {});
          break;
        }
        case "sync-vault": {
          if (msg.payload) appInstance.vault._syncFromList(msg.payload);
          reply(true, {});
          break;
        }
        case "sync-doc": {
          const prevPath = activeDoc.path;
          activeDoc = { ...activeDoc, ...(msg.payload || {}) };
          appInstance.metadataCache._updateActive(activeDoc.path, activeDoc.content);
          const f = appInstance.workspace.getActiveFile();
          if (prevPath !== activeDoc.path) {
            appInstance.workspace.trigger("file-open", f);
            appInstance.workspace.trigger("active-leaf-change", appInstance.workspace._mdLeaf);
          } else if (f) {
            appInstance.vault.trigger("modify", f);
          }
          reply(true, {});
          break;
        }
        case "load-plugin": {
          const res = await loadPluginBundle(msg.payload);
          reply(res.ok, res, res.error);
          break;
        }
        case "unload-plugin": {
          await unloadPlugin(msg.payload?.id);
          reply(true, {});
          break;
        }
        case "exec-command": {
          const res = executePluginCommand(msg.payload?.fullId);
          reply(res.ok, res, res.error);
          break;
        }
        case "trigger-ribbon": {
          const res = triggerRibbon(msg.payload?.ribbonId);
          reply(res.ok, res, res.error);
          break;
        }
        case "open-settings": {
          const res = openPluginSettings(msg.payload?.pluginId);
          reply(res.ok, res);
          break;
        }
        default:
          reply(false, null, `Unknown action: ${msg.action}`);
      }
    } catch (err) {
      reply(false, null, err?.message || String(err));
    }
  }
});

// Close modal on backdrop click or Escape
document.getElementById("obs-modal-overlay")?.addEventListener("mousedown", (ev) => {
  if (ev.target === ev.currentTarget && openModals.length > 0) {
    openModals[openModals.length - 1].close();
  }
});
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && openModals.length > 0) {
    openModals[openModals.length - 1].close();
  }
});

notifyParent("host-ready", {});
