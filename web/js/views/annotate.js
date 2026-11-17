import { api, clear, el, localImg, money, toast } from "../api.js";

export async function renderAnnotate(root, ctx, params = {}) {
  clear(root);
  let runId = params.runId || "";
  if (!runId) {
    const recent = await api("GET", "/api/works?limit=12").catch(() => ({ items: [] }));
    const list = recent.items || [];
    root.appendChild(el("div", { class: "page-head" }, el("h1", { class: "page-title" }, "批注改图")));
    if (list.length === 0) {
      root.appendChild(el("div", { class: "card muted" }, "暂无本地图片可批注。请先在单图工作区生成一张图片，再点击「批注改图」。"));
      return;
    }
    const grid = el("div", { class: "grid-cards" });
    list.forEach((run) => {
      const im = run.images?.[0];
      if (!im?.path) return;
      grid.appendChild(el("div", { class: "style-card", onClick: () => renderAnnotate(root, ctx, { runId: run.id }) },
        el("img", { class: "style-thumb", src: localImg(im.thumb || im.path), alt: run.title }),
        el("div", { class: "style-body" }, el("div", { class: "style-name" }, run.title))
      ));
    });
    root.appendChild(grid);
    return;
  }

  const data = await api("GET", `/api/works/${encodeURIComponent(runId)}`);
  const run = data.run;
  const versions = data.versions || [run];
  const img = (run.images || []).find((i) => i.path) || run.images?.[0];
  if (!img?.path) {
    root.appendChild(el("div", { class: "card muted" }, "该任务尚无已完成的图片"));
    return;
  }

  const annotations = [];
  const pinsLayer = el("div");
  const listBox = el("div", { class: "col" });
  const modRes = await api("GET", "/api/models").catch(() => ({ providers: [], site: [], defaultModel: "" }));
  const modelSel = el("select", { class: "select" });
  const siteList = Array.isArray(modRes.site)
    ? modRes.site
    : (modRes.site?.specifications || modRes.site?.models || modRes.site?.items || []);
  const seenSite = new Set();
  siteList.forEach((s) => {
    const id = s?.model || s?.id;
    if (id && !seenSite.has(id)) {
      seenSite.add(id);
      modelSel.appendChild(el("option", { value: "site:" + id, selected: modRes.defaultModel === "site:" + id }, `网站 · ${s.label || s.name || id}`));
    }
  });
  (modRes.providers || []).forEach((p) => (p.models || []).forEach((m) => {
    const ref = `${p.id}:${m.id}`;
    modelSel.appendChild(el("option", { value: ref, selected: modRes.defaultModel === ref }, `${p.name} · ${m.label || m.id}${m.canEdit ? " (支持局部重绘)" : " (整图指令编辑)"}`));
  }));

  const drawPins = () => {
    clear(pinsLayer);
    clear(listBox);
    annotations.forEach((a, idx) => {
      pinsLayer.appendChild(el("div", { class: "annotate-pin", style: { left: (a.x * 100) + "%", top: (a.y * 100) + "%" } }, String(idx + 1)));
      listBox.appendChild(el("div", { class: "card row", style: { justifyContent: "space-between", padding: "8px 10px" } },
        el("div", null, el("strong", null, `#${idx + 1} `), el("span", null, a.text)),
        el("button", { type: "button", class: "btn btn-sm btn-danger", onClick: () => { annotations.splice(idx, 1); drawPins(); } }, "删除")
      ));
    });
    if (annotations.length === 0) {
      listBox.appendChild(el("div", { class: "muted" }, "点击左侧图片上的任意位置添加批注，例如「这里加一只小黑猫」「背景换成黄昏暖光」"));
    }
  };

  const mainImg = el("img", {
    src: localImg(img.path),
    style: { maxWidth: "100%", maxHeight: "66vh", borderRadius: "10px", display: "block" },
    onClick: (e) => {
      const r = mainImg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const text = prompt("输入此处修改批注：");
      if (text && text.trim()) {
        annotations.push({ x, y, text: text.trim() });
        drawPins();
      }
    },
  });

  const timeline = el("div", { class: "row", style: { marginBottom: "12px" } }, el("span", { class: "muted" }, "版本时间线："));
  versions.forEach((v, idx) => {
    timeline.appendChild(el("button", {
      type: "button",
      class: "pill-btn" + (v.id === run.id ? " pill-accent" : ""),
      onClick: () => renderAnnotate(root, ctx, { runId: v.id }),
    }, `v${idx + 1} · ${v.title?.slice(0, 12) || v.id.slice(-6)}`));
  });

  const execBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    onClick: async () => {
      if (annotations.length === 0) return toast("请至少添加 1 条批注");
      const mRef = modelSel.value || modRes.defaultModel;
      if (!mRef) return toast("请先配置或选择生图模型");
      const payload = {
        mode: "edit",
        title: (run.title || "批注改图") + " (修订)",
        parentId: run.id,
        modelRef: mRef,
        refs: [img.path],
        annotations,
        input: { theme: run.originalRequest || run.title, mode: "pure-image" },
      };
      try {
        const res = await api("POST", "/api/generate", payload);
        if (res.needConfirm) {
          if (!confirm(`预计花费 ${money(res.totalCents)}，确认执行？`)) return;
          payload.confirmed = true;
          const res2 = await api("POST", "/api/generate", payload);
          toast("已生成新版本");
          ctx.go("works", { openRun: res2.run.id });
          return;
        }
        toast("已提交新版本生成，原图完整保留");
        ctx.go("works", { openRun: res.run.id });
      } catch (e) { toast(e.message); }
    },
  }, "全部执行，生成新版本");

  drawPins();
  root.appendChild(el("div", { class: "page-head" },
    el("h1", { class: "page-title" }, "批注改图"),
    el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("works", { openRun: run.id }) }, "← 返回作品详情")
  ));
  root.appendChild(timeline);
  root.appendChild(el("div", { class: "split" },
    el("div", { class: "card", style: { textAlign: "center" } }, el("div", { class: "annotate-wrap" }, mainImg, pinsLayer)),
    el("div", { class: "card col" },
      el("div", { class: "field" }, el("label", null, "改图模型（支持重绘用编辑接口，否则合并为整图指令）"), modelSel),
      listBox,
      el("div", { style: { marginTop: "auto" } }, execBtn)
    )
  ));
}
