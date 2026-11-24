import { api, clear, closeModal, el, showModal, toast } from "../api.js";

function exportRecipeFile(rec) {
  const clean = { ...rec };
  delete clean.remote;
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${rec.name || rec.id}.handraw-recipe.json`;
  a.click();
}

export async function openRecipeManagerModal({ activeRecipeId = "", onApply = null, onChanged = null } = {}) {
  let recipes = [];
  let query = "";

  const searchIn = el("input", {
    class: "input",
    type: "search",
    placeholder: "搜索配方名称、画风编号或说明…",
    style: { flex: "1", minWidth: "180px" },
  });

  const fileIn = el("input", { type: "file", accept: ".json", class: "hidden" });
  const listHost = el("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
      gap: "10px",
      maxHeight: "56vh",
      overflowY: "auto",
      padding: "2px 1px",
    },
  });

  const reopenSelf = () => openRecipeManagerModal({ activeRecipeId, onApply, onChanged });

  const renderCards = () => {
    clear(listHost);
    const q = query.trim().toLowerCase();
    const filtered = recipes.filter((rec) => {
      if (!q) return true;
      const hay = [
        rec.name,
        ...(rec.styleIds || []),
        rec.layoutId,
        ...(rec.colors || []),
        rec.ratio,
        rec.notes,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });

    if (!filtered.length) {
      listHost.appendChild(el("div", {
        class: "card muted",
        style: { gridColumn: "1 / -1", textAlign: "center", padding: "24px 12px" },
      }, recipes.length ? "没有匹配的配方" : "暂无配方，可点击右上角「+ 新建配方」或在生图页点「存为配方」。"));
      return;
    }

    filtered.forEach((rec) => {
      const isCurrent = Boolean(activeRecipeId && rec.id === activeRecipeId);
      const meta = [
        rec.styleIds?.length ? "画风 " + rec.styleIds.join("+") : null,
        rec.layoutId ? "图型 " + rec.layoutId : null,
        rec.colors?.length ? "色板 " + rec.colors.join(",") : null,
        rec.ratio || "3:4",
      ].filter(Boolean).join(" · ");

      listHost.appendChild(el("div", {
        class: "card col",
        style: {
          padding: "12px",
          gap: "6px",
          borderColor: isCurrent ? "var(--accent)" : undefined,
          background: isCurrent ? "var(--accent-soft)" : undefined,
        },
      },
        el("div", { class: "row", style: { justifyContent: "space-between", gap: "6px" } },
          el("strong", { style: { fontSize: "13.5px" } }, rec.name || "未命名配方"),
          el("div", { class: "row", style: { gap: "4px" } },
            isCurrent ? el("span", { class: "badge badge-ok" }, "当前") : null,
            el("span", { class: "badge" + (rec.builtin ? " badge-accent" : "") }, rec.builtin ? "官方" : "个人")
          )
        ),
        el("div", { class: "muted", style: { fontSize: "12px" } }, meta),
        rec.notes ? el("div", { class: "style-traits", style: { fontSize: "12px" } }, rec.notes) : null,
        el("div", { class: "row", style: { marginTop: "auto", paddingTop: "6px", gap: "6px", flexWrap: "wrap" } },
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            onClick: () => {
              closeModal();
              onApply?.(rec);
            },
          }, "套用"),
          !rec.builtin ? el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => openRecipeEditor(rec, async () => {
              await onChanged?.();
              reopenSelf();
            }, reopenSelf),
          }, "编辑") : null,
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => exportRecipeFile(rec),
          }, "导出"),
          !rec.builtin ? el("button", {
            type: "button",
            class: "btn btn-sm btn-danger",
            onClick: async () => {
              try {
                await api("DELETE", `/api/mine/recipes/${encodeURIComponent(rec.id)}`);
                toast("已删除配方");
                await reload();
                await onChanged?.();
              } catch (e) { toast(e.message); }
            },
          }, "删除") : null
        )
      ));
    });
  };

  const reload = async () => {
    const res = await api("GET", "/api/mine/recipes").catch(() => ({ items: [] }));
    recipes = res.items || [];
    renderCards();
  };

  searchIn.addEventListener("input", () => {
    query = searchIn.value;
    renderCards();
  });

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
      await reload();
      await onChanged?.();
    } catch (e) { toast("导入失败：" + e.message); }
    fileIn.value = "";
  });

  const body = el("div", { class: "col", style: { gap: "12px" } },
    el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
      searchIn,
      fileIn,
      el("button", { type: "button", class: "btn btn-sm", onClick: () => fileIn.click() }, "导入 .json"),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => openRecipeEditor({}, async () => {
          await onChanged?.();
          reopenSelf();
        }, reopenSelf),
      }, "+ 新建配方")
    ),
    listHost
  );

  showModal("配方管理", body, [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
  ]);

  await reload();
}

export function openRecipeEditor(initial = {}, onSaved, onCancel) {
  const isEdit = Boolean(initial.id);
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

  showModal(isEdit ? "编辑配方" : "保存为配方", el("div", null,
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
      class: "btn",
      onClick: () => {
        if (onCancel) onCancel();
        else closeModal();
      },
    }, "取消"),
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
          toast(isEdit ? "配方已更新" : "配方已保存");
          if (onSaved) await onSaved();
        } catch (e) { toast(e.message); }
      },
    }, "保存"),
  ]);
}
