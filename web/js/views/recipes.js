import { api, clear, closeModal, el, showModal, toast } from "../api.js";

export async function renderRecipes(root, ctx) {
  clear(root);
  const res = await api("GET", "/api/mine/recipes").catch(() => ({ items: [] }));
  const recipes = res.items || [];

  const fileIn = el("input", { type: "file", accept: ".json", class: "hidden" });
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      delete obj.remote;
      obj.id = "";
      obj.builtin = false;
      await api("POST", "/api/mine/recipes", obj);
      toast("已导入配方：" + (obj.name || "新配方"));
      renderRecipes(root, ctx);
    } catch (e) { toast("导入失败：" + e.message); }
  });

  root.appendChild(el("div", { class: "page-head" },
    el("h1", { class: "page-title" }, "配方库"),
    el("div", { class: "row" },
      fileIn,
      el("button", { type: "button", class: "btn", onClick: () => fileIn.click() }, "导入配方 (.handraw-recipe.json)"),
      el("button", { type: "button", class: "btn btn-primary", onClick: () => openRecipeEditor({}, () => renderRecipes(root, ctx)) }, "+ 新建配方")
    )
  ));

  const grid = el("div", { class: "grid-cards" });
  recipes.forEach((rec) => {
    const exportRecipe = () => {
      const clean = { ...rec };
      delete clean.remote;
      const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${rec.name || rec.id}.handraw-recipe.json`;
      a.click();
    };
    grid.appendChild(el("div", { class: "card col" },
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("strong", null, rec.name),
        el("span", { class: "badge" + (rec.builtin ? " badge-accent" : "") }, rec.builtin ? "官方配方" : "我的配方")
      ),
      el("div", { class: "muted" }, [
        rec.styleIds?.length ? "画风 " + rec.styleIds.join("+") : null,
        rec.layoutId ? "图型 " + rec.layoutId : null,
        rec.colors?.length ? "色板 " + rec.colors.join(",") : null,
        rec.ratio || "3:4",
      ].filter(Boolean).join(" · ")),
      rec.notes ? el("div", { class: "style-traits" }, rec.notes) : null,
      el("div", { class: "row", style: { marginTop: "auto", paddingTop: "8px" } },
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => ctx.go("create", { recipe: rec }) }, "用于创作"),
        el("button", { type: "button", class: "btn btn-sm", onClick: exportRecipe }, "导出"),
        !rec.builtin ? el("button", {
          type: "button",
          class: "btn btn-sm btn-danger",
          onClick: async () => { await api("DELETE", `/api/mine/recipes/${encodeURIComponent(rec.id)}`); toast("已删除"); renderRecipes(root, ctx); },
        }, "删除") : null
      )
    ));
  });
  root.appendChild(grid);
}

export function openRecipeEditor(initial = {}, onSaved) {
  const nameIn = el("input", { class: "input", value: initial.name || "", placeholder: "例如：我的公众号封面" });
  const styleIn = el("input", { class: "input", value: (initial.styleIds || []).join(","), placeholder: "FA-013（融合用逗号分隔，如 FA-013,FI-001）" });
  const layoutIn = el("input", { class: "input", value: initial.layoutId || "", placeholder: "可选，如 SC-001" });
  const colorIn = el("input", { class: "input", value: (initial.colors || []).join(","), placeholder: "可选，如 C-15" });
  const toneIn = el("input", { class: "input", value: (initial.tones || []).join(","), placeholder: "可选，如 T-01" });
  const ratioIn = el("input", { class: "input", value: initial.ratio || "3:4" });
  const modeSel = el("select", { class: "select" },
    el("option", { value: "graphic-text", selected: initial.mode !== "pure-image" }, "图文模式"),
    el("option", { value: "pure-image", selected: initial.mode === "pure-image" }, "纯图模式")
  );
  const notesIn = el("input", { class: "input", value: initial.notes || "", placeholder: "备注用途" });

  showModal("保存为配方", el("div", null,
    el("div", { class: "field" }, el("label", null, "配方名称"), nameIn),
    el("div", { class: "split" },
      el("div", { class: "field" }, el("label", null, "画风编号"), styleIn),
      el("div", { class: "field" }, el("label", null, "图型编号"), layoutIn),
      el("div", { class: "field" }, el("label", null, "主题色"), colorIn),
      el("div", { class: "field" }, el("label", null, "影调"), toneIn),
      el("div", { class: "field" }, el("label", null, "比例"), ratioIn),
      el("div", { class: "field" }, el("label", null, "模式"), modeSel)
    ),
    el("div", { class: "field" }, el("label", null, "说明"), notesIn)
  ), [
    el("button", {
      type: "button",
      class: "btn btn-primary",
      onClick: async () => {
        try {
          await api("POST", "/api/mine/recipes", {
            id: initial.id || "",
            name: nameIn.value,
            styleIds: styleIn.value.split(",").map((x) => x.trim()).filter(Boolean),
            layoutId: layoutIn.value.trim(),
            colors: colorIn.value.split(",").map((x) => x.trim()).filter(Boolean),
            tones: toneIn.value.split(",").map((x) => x.trim()).filter(Boolean),
            ratio: ratioIn.value.trim() || "3:4",
            mode: modeSel.value,
            notes: notesIn.value,
          });
          closeModal();
          toast("配方已保存");
          if (onSaved) onSaved();
        } catch (e) { toast(e.message); }
      },
    }, "保存"),
  ]);
}
