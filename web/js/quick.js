import { api, clear, connectEvents, el, localImg, onEvent, setColorScheme, setToken, toast } from "./api.js";
import { buildGroupedModelSelect } from "./views/create.js";

async function startQuick() {
  const boot = await api("GET", "/api/boot").catch(() => ({}));
  if (boot.token) setToken(boot.token);

  const [settRes, recRes, modRes] = await Promise.all([
    api("GET", "/api/settings").catch(() => ({ settings: {} })),
    api("GET", "/api/mine/recipes").catch(() => ({ items: [] })),
    api("GET", "/api/models").catch(() => ({ site: [], providers: [] })),
  ]);

  if (settRes.settings?.theme) setColorScheme(settRes.settings.theme);

  const recipes = recRes.items || [{ id: "default", name: "水彩手绘插画", styleIds: ["FA-013"], ratio: "3:4", mode: "graphic-text" }];
  let recipeIdx = 0;
  let activeRunId = "";

  const themeIn = document.getElementById("q-theme");
  const goBtn = document.getElementById("q-go");
  const hideBtn = document.getElementById("q-hide");
  const recBtn = document.getElementById("q-recipe");
  const modelSelEl = document.getElementById("q-model");
  const priceSpan = document.getElementById("q-price");
  const stage = document.getElementById("q-stage");

  const initTheme = new URLSearchParams(location.search).get("theme");
  if (initTheme && themeIn) themeIn.value = initTheme;

  const builtSel = buildGroupedModelSelect(modRes, settRes.settings?.defaultModel || modRes.defaultModel || "site:seedream-4.5");
  if (modelSelEl) {
    const initialModel = builtSel.value;
    clear(modelSelEl);
    Array.from(builtSel.children).forEach((child) => modelSelEl.appendChild(child));
    modelSelEl.value = initialModel;
  }

  function updateRecipeBtn() {
    const r = recipes[recipeIdx % recipes.length];
    if (recBtn) recBtn.textContent = `配方：${r.name} (${(r.styleIds || ["FA-013"]).join("+")})`;
  }
  updateRecipeBtn();

  async function refreshQuote() {
    if (!priceSpan || !modelSelEl) return;
    try {
      const q = await api("POST", "/api/quote", { modelRef: modelSelEl.value, resolution: "2k", count: 1 });
      priceSpan.textContent = q.source === "provider" ? "自带接口直出" : (q.freeCount > 0 && q.totalCents === 0 ? "免额" : `¥${((q.totalCents || 0) / 100).toFixed(2)}`);
    } catch {
      priceSpan.textContent = "";
    }
  }
  modelSelEl?.addEventListener("change", refreshQuote);
  refreshQuote();

  const cycleRecipe = () => {
    recipeIdx = (recipeIdx + 1) % recipes.length;
    updateRecipeBtn();
  };
  recBtn?.addEventListener("click", cycleRecipe);

  const hideWindow = () => api("POST", "/api/quick/hide").catch(() => {});
  hideBtn?.addEventListener("click", hideWindow);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      hideWindow();
    } else if (e.key === "Tab") {
      e.preventDefault();
      cycleRecipe();
    }
  });

  async function submit(confirmed = false) {
    const theme = (themeIn?.value || "").trim();
    if (!theme) {
      themeIn?.focus();
      return;
    }
    const r = recipes[recipeIdx % recipes.length];
    goBtn.disabled = true;
    try {
      const res = await api("POST", "/api/generate", {
        mode: "quick",
        title: theme.slice(0, 28),
        modelRef: modelSelEl?.value || "",
        resolution: "2k",
        count: 1,
        confirmed,
        input: {
          style: r.styleIds?.[0] || "FA-013",
          style2: r.styleIds?.[1] || "",
          layout: r.layoutId || "",
          color: r.colors?.[0] || "",
          tone: r.tones?.[0] || "",
          ratio: r.ratio || "3:4",
          mode: r.mode || "graphic-text",
          theme,
        },
        recipe: r,
      });
      if (res.needConfirm) {
        stage.classList.remove("hidden");
        clear(stage);
        stage.appendChild(el("span", { class: "muted" }, `预计费用 ¥${((res.totalCents || 0) / 100).toFixed(2)}，确认生图？`));
        stage.appendChild(el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => submit(true) }, "确认生成"));
        return;
      }
      activeRunId = res.run?.id || "";
      renderStage(res.run, res.images || []);
    } catch (e) {
      stage.classList.remove("hidden");
      clear(stage);
      stage.appendChild(el("span", { class: "badge badge-err" }, e.message));
    } finally {
      goBtn.disabled = false;
    }
  }

  function renderStage(run, images) {
    if (!stage) return;
    stage.classList.remove("hidden");
    clear(stage);
    const im = images[0];
    if (!im || im.status === "queued" || im.status === "running") {
      stage.appendChild(el("span", { class: "dot-pulse" }));
      stage.appendChild(el("span", null, "正在快速绘制，请稍候…"));
      stage.appendChild(el("button", { type: "button", class: "btn btn-sm", style: { marginLeft: "auto" }, onClick: () => api("POST", "/api/window/main") }, "切到主窗口"));
      return;
    }
    if (im.status !== "done") {
      stage.appendChild(el("span", { class: "badge badge-err" }, im.error || "生成失败"));
      return;
    }
    stage.appendChild(el("img", { src: localImg(im.thumb || im.path), alt: run?.title || "", style: { width: "76px", height: "76px", objectFit: "cover", borderRadius: "8px" } }));
    stage.appendChild(el("div", { class: "col", style: { flex: "1" } },
      el("strong", null, run?.title || "已完成"),
      el("div", { class: "row" },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => api("POST", `/api/images/${encodeURIComponent(im.id)}/copy`).then(() => toast("已复制到剪贴板")) }, "📋 复制图片"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => api("POST", `/api/works/${encodeURIComponent(run.id)}/reveal`) }, "📂 目录"),
        el("button", { type: "button", class: "btn btn-sm", onClick: () => api("POST", "/api/window/main") }, "在主窗口打开")
      )
    ));
  }

  themeIn?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(false);
    }
  });
  goBtn?.addEventListener("click", () => submit(false));

  onEvent(async (msg) => {
    const rid = msg.data?.runId || msg.data?.id;
    if ((msg.type === "job" || msg.type === "run") && activeRunId && rid === activeRunId) {
      const d = await api("GET", `/api/works/${encodeURIComponent(activeRunId)}`).catch(() => null);
      if (d?.run) renderStage(d.run, d.run.images || []);
    }
  });
  connectEvents();
}

startQuick();
