import { api, clear, el, toast } from "./api.js";
import { openLayoutEditorModal, openStyleEditorModal } from "./views/resource-editor.js";
import { openExtensionSubmitModal } from "./views/plugins-channels.js";

let cachedStyles = null;
let cachedLayouts = null;

window.addEventListener("handraw:custom-resource-saved", () => {
  cachedStyles = null;
  cachedLayouts = null;
});

async function ensureCatalog() {
  if (!cachedStyles) {
    const r = await api("GET", "/api/resources/styles").catch(() => ({ items: [] }));
    cachedStyles = r.items || [];
  }
  if (!cachedLayouts) {
    const r = await api("GET", "/api/resources/layouts").catch(() => ({ items: [] }));
    cachedLayouts = r.items || [];
  }
}

export function initPalette(ctx) {
  const dlg = document.getElementById("cmd-dialog");
  const input = document.getElementById("cmd-input");
  const results = document.getElementById("cmd-results");
  let selected = 0;
  let rows = [];

  const open = async () => {
    dlg.returnValue = "";
    dlg.showModal();
    input.value = "";
    input.focus();
    await ensureCatalog();
    render("");
  };

  document.getElementById("btn-cmd")?.addEventListener("click", open);
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (dlg.open) dlg.close("");
      else open();
    }
  });

  const baseActions = () => [
    {
      label: "＋ 新建我的画风",
      hint: "新建 · 画风",
      run: () => openStyleEditorModal({}, () => {
        cachedStyles = null;
        if (location.hash === "#atlas") ctx.go("atlas", { tab: "styles", group: "__mine" });
      }),
    },
    {
      label: "＋ 新建我的图型",
      hint: "新建 · 图型",
      run: () => openLayoutEditorModal({}, () => {
        cachedLayouts = null;
        if (location.hash === "#atlas") ctx.go("atlas", { tab: "layouts", group: "mine" });
      }),
    },
    { label: "管理我的画风", hint: "画廊 · 我的", run: () => ctx.go("atlas", { tab: "styles", group: "__mine" }) },
    { label: "管理我的图型", hint: "画廊 · 我的", run: () => ctx.go("atlas", { tab: "layouts", group: "mine" }) },
    { label: "去首页", hint: "视图", run: () => ctx.go("home") },
    { label: "打开生图工作台", hint: "生图", run: () => ctx.go("create") },
    { label: "管理生图配方", hint: "生图", run: () => ctx.go("create", { openRecipes: true }) },
    { label: "打开灵感库", hint: "灵感", run: () => ctx.go("inspirations") },
    { label: "打开 AI 聊天工作台", hint: "聊天", run: () => ctx.go("chat") },
    { label: "打开文章到图文", hint: "创作", run: () => ctx.go("article") },
    { label: "打开自由画布", hint: "创作", run: () => ctx.go("canvas") },
    { label: "浏览风格画廊", hint: "画廊", run: () => ctx.go("atlas") },
    { label: "画风骰子", hint: "灵感", run: () => ctx.go("atlas", { tab: "dice" }) },
    { label: "本地作品库", hint: "作品", run: () => ctx.go("works") },
    {
      label: "🧩 推荐或提交插件",
      hint: "插件 · 自研/推荐",
      run: () => openExtensionSubmitModal(ctx, { channel: "plugin", role: "recommend" }),
    },
    { label: "插件与官方市场", hint: "插件", run: () => ctx.go("plugins") },
    { label: "检查版本更新", hint: "操作", run: () => api("POST", "/api/update/check").then(() => toast("已检查更新")) },
    {
      label: "复制最后一张图",
      hint: "操作",
      run: async () => {
        const w = await api("GET", "/api/works?limit=1");
        const im = w.items?.[0]?.images?.[0];
        if (!im) return toast("暂无已生成的图片");
        await api("POST", `/api/images/${encodeURIComponent(im.id)}/copy`);
        toast("已复制到剪贴板");
      },
    },
  ];

  async function render(q) {
    q = (q || "").trim();
    rows = [];

    if (q.startsWith("/") && q.includes(" ")) {
      const sp = q.indexOf(" ");
      const rName = q.slice(1, sp).trim();
      const theme = q.slice(sp + 1).trim();
      rows.push({
        label: `用「${rName}」快速生成：${theme}`,
        hint: "回车立即生成",
        run: async () => {
          const recRes = await api("GET", "/api/mine/recipes").catch(() => ({ items: [] }));
          const rec = (recRes.items || []).find((x) => x.name.includes(rName) || x.id === rName);
          const inputObj = rec ? { style: rec.styleIds?.[0] || "", style2: rec.styleIds?.[1] || "", layout: rec.layoutId || "", color: (rec.colors || []).join(","), ratio: rec.ratio || "3:4", mode: rec.mode || "graphic-text", theme } : { style: "FA-013", theme };
          await api("POST", "/api/generate", { mode: "quick", title: theme, input: inputObj });
          toast("已加入后台生成队列");
          ctx.go("works");
        },
      });
    }

    const ql = q.toLowerCase();
    for (const a of baseActions()) {
      if (!ql || a.label.toLowerCase().includes(ql) || a.hint.toLowerCase().includes(ql)) rows.push(a);
    }

    const obsRt = window.__handrawObsidianRuntime;
    if (obsRt && typeof obsRt.getCommands === "function") {
      for (const c of obsRt.getCommands() || []) {
        const label = `${c.pluginName}: ${c.name}`;
        if (!ql || label.toLowerCase().includes(ql) || (c.fullId || "").toLowerCase().includes(ql) || "obsidian".includes(ql)) {
          rows.push({
            label,
            hint: "Obsidian 插件",
            run: () => obsRt.execCommand(c.fullId),
          });
        }
      }
    }

    if (cachedStyles) {
      const hits = cachedStyles.filter((s) =>
        !ql || s.number.toLowerCase().includes(ql) || (s.generation_name || "").toLowerCase().includes(ql) || (s.reference || "").toLowerCase().includes(ql) || (s.traits || "").toLowerCase().includes(ql)
      ).slice(0, 8);
      for (const s of hits) {
        rows.push({
          label: `${s.number} · ${s.nameZh || s.generation_name}`,
          hint: "画风",
          run: () => ctx.go("atlas", { openStyle: s.number }),
        });
      }
    }

    if (cachedLayouts && ql) {
      const hits = cachedLayouts.filter((l) => l.id.toLowerCase().includes(ql) || (l.name || "").toLowerCase().includes(ql)).slice(0, 5);
      for (const l of hits) {
        rows.push({
          label: `${l.id} · ${l.name}`,
          hint: "图型",
          run: () => ctx.go("atlas", { tab: "layouts", q: l.id }),
        });
      }
    }

    selected = 0;
    drawRows();
  }

  function drawRows() {
    clear(results);
    if (rows.length === 0) {
      results.appendChild(el("div", { class: "muted", style: { padding: "12px" } }, "没有匹配项"));
      return;
    }
    rows.forEach((row, idx) => {
      const btn = el(
        "button",
        {
          type: "button",
          class: "cmd-row" + (idx === selected ? " selected" : ""),
          onClick: () => {
            dlg.close("");
            row.run();
          },
        },
        el("span", null, row.label),
        el("span", { class: "badge" }, row.hint)
      );
      results.appendChild(btn);
    });
  }

  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(rows.length - 1, selected + 1);
      drawRows();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(0, selected - 1);
      drawRows();
    } else if (e.key === "Enter" && rows[selected]) {
      e.preventDefault();
      const fn = rows[selected].run;
      dlg.close("");
      fn();
    }
  });
}
