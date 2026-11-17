import { api, el, getToken } from "./api.js";

const framePluginMap = new WeakMap();

let bridgeInstalled = false;
function installBridge() {
  if (bridgeInstalled) return;
  bridgeInstalled = true;
  window.addEventListener("message", async (e) => {
    const msg = e.data;
    if (!msg || msg.kind !== "handraw-plugin-call") return;
    // Match exact source window from our sandboxed iframe; sandbox iframes have opaque "null" origin.
    let pluginId = null;
    for (const iframe of document.querySelectorAll("iframe[data-plugin-id]")) {
      if (iframe.contentWindow === e.source) {
        pluginId = iframe.dataset.pluginId;
        break;
      }
    }
    if (!pluginId) return;
    try {
      const result = await api("POST", `/api/plugins/${encodeURIComponent(pluginId)}/call`, {
        action: msg.action,
        args: msg.args || {},
      });
      e.source.postMessage({ kind: "handraw-plugin-reply", callId: msg.callId, ok: true, result }, "*");
    } catch (err) {
      e.source.postMessage({ kind: "handraw-plugin-reply", callId: msg.callId, ok: false, error: err.message }, "*");
    }
  });
}

export function mountPluginFrame(pluginId, relFile, contextObj) {
  installBridge();
  const src = `/files/plugin/${encodeURIComponent(pluginId)}/${relFile.replace(/^\/+/, "")}?t=${encodeURIComponent(getToken())}`;
  const iframe = el("iframe", {
    src,
    sandbox: "allow-scripts",
    "data-plugin-id": pluginId,
    style: { width: "100%", height: "100%", minHeight: "260px", border: "1px solid var(--line)", borderRadius: "10px", background: "var(--surface)" },
  });
  framePluginMap.set(iframe, pluginId);
  iframe.addEventListener("load", () => {
    try {
      iframe.contentWindow?.postMessage({ kind: "handraw-context", context: contextObj || {} }, "*");
    } catch {}
  });
  return iframe;
}

export async function mountSlotPanels(container, slot, contextObj) {
  const res = await api("GET", "/api/plugins").catch(() => ({ community: [] }));
  for (const c of res.community || []) {
    if (!c.enabled) continue;
    for (const p of c.panels || []) {
      if (p.slot === slot) {
        const box = el("div", { class: "card", style: { marginTop: "12px" } },
          el("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "8px" } },
            el("strong", null, `${c.name} · ${p.title}`),
            el("span", { class: "badge" }, "插件面板")
          ),
          mountPluginFrame(c.id, p.file, contextObj)
        );
        container.appendChild(box);
      }
    }
  }
}
