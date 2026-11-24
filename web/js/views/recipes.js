import { api, clear, closeModal, el, localImg, packImg, showModal, toast } from "../api.js";

function exportRecipeFile(rec) {
  const clean = { ...rec };
  delete clean.remote;
  delete clean.syncStatus;
  delete clean.builtin;
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${rec.name || rec.id}.handraw-recipe.json`;
  a.click();
}

let catalogCache = null;
let catalogPromise = null;

async function ensureRecipeCatalog(provided = null) {
  if (provided && (provided.styles?.length || provided.layouts?.length || provided.colors?.length || provided.tones?.length)) {
    return buildCatalogIndex(provided);
  }
  if (catalogCache) return catalogCache;
  if (catalogPromise) return catalogPromise;
  catalogPromise = Promise.all([
    api("GET", "/api/resources/styles").catch(() => ({ items: [] })),
    api("GET", "/api/mine/styles").catch(() => ({ items: [] })),
    api("GET", "/api/resources/layouts").catch(() => ({ items: [] })),
    api("GET", "/api/mine/layouts").catch(() => ({ items: [] })),
    api("GET", "/api/resources/colors").catch(() => ({ items: [] })),
    api("GET", "/api/resources/tones").catch(() => ({ items: [] })),
  ])
    .then(([stRes, mStRes, layRes, mLayRes, colRes, toneRes]) => {
      const idx = buildCatalogIndex({
        styles: [...(mStRes.items || []), ...(stRes.items || [])],
        layouts: [...(mLayRes.items || []), ...(layRes.items || [])],
        colors: colRes.items || [],
        tones: toneRes.items || [],
      });
      if (idx.styles.size || idx.layouts.size || idx.colors.size || idx.tones.size) {
        catalogCache = idx;
      }
      return idx;
    })
    .finally(() => {
      catalogPromise = null;
    });
  return catalogPromise;
}

function buildCatalogIndex({ styles = [], layouts = [], colors = [], tones = [] } = {}) {
  const idx = {
    styles: new Map(),
    layouts: new Map(),
    colors: new Map(),
    tones: new Map(),
  };
  for (const s of styles) {
    const code = String(s?.number || s?.id || "").trim();
    if (!code) continue;
    const key = code.toUpperCase();
    if (!idx.styles.has(key)) {
      idx.styles.set(key, {
        code,
        name: s.nameZh || s.name_zh || s.generationName || s.generation_name || s.name || code,
        image: s.image || "",
      });
    }
  }
  for (const l of layouts) {
    const code = String(l?.id || l?.number || "").trim();
    if (!code) continue;
    const key = code.toUpperCase();
    if (!idx.layouts.has(key)) {
      idx.layouts.set(key, {
        code,
        name: l.name || l.nameZh || l.name_zh || l.nameEn || l.name_en || code,
        image: l.image || "",
      });
    }
  }
  for (const c of colors) {
    const code = String(c?.id || "").trim();
    if (!code) continue;
    const key = code.toUpperCase();
    if (!idx.colors.has(key)) {
      idx.colors.set(key, {
        code,
        name: c.nameZh || c.name_zh || c.name || c.nameEn || c.name_en || code,
        image: c.image || "",
        hex: c.hex || c.color || "",
      });
    }
  }
  for (const t of tones) {
    const code = String(t?.id || "").trim();
    if (!code) continue;
    const key = code.toUpperCase();
    if (!idx.tones.has(key)) {
      idx.tones.set(key, {
        code,
        name: t.nameZh || t.name_zh || t.name || t.nameEn || t.name_en || code,
        image: t.image || "",
      });
    }
  }
  return idx;
}

function resolveImgSrc(rel) {
  if (!rel) return "";
  if (rel.startsWith("http://") || rel.startsWith("https://") || rel.startsWith("/") || rel.startsWith("data:")) return rel;
  if (rel.startsWith("images/")) return packImg(rel);
  return localImg(rel);
}

function renderAttrCard(badge, entry, fallbackCode) {
  const code = entry?.code || fallbackCode || "";
  const name = entry?.name || code || "未选择";
  const imgSrc = resolveImgSrc(entry?.image || "");
  const hex = entry?.hex || "";

  let thumbContent;
  if (imgSrc) {
    thumbContent = el("img", { src: imgSrc, alt: name, loading: "lazy", decoding: "async" });
  } else if (hex) {
    thumbContent = el("span", { class: "rcp-attr-swatch", style: { background: hex } });
  } else {
    thumbContent = el("span", { class: "rcp-attr-code-fallback mono" }, code || "—");
  }

  return el("div", { class: "rcp-attr-card" },
    el("div", { class: "rcp-attr-thumb" }, thumbContent),
    el("div", { class: "rcp-attr-info" },
      el("span", { class: "rcp-attr-badge" }, badge),
      el("strong", { class: "rcp-attr-name", title: name }, name),
      code && code !== name ? el("span", { class: "rcp-attr-code mono" }, code) : null
    )
  );
}

function buildVisualPreviewSection(stateObj, catalogIdx) {
  const wrap = el("div", { class: "rcp-attr-grid", dataset: { role: "recipe-attr-preview" } });
  const styleIds = (stateObj.styleIds || []).filter(Boolean);
  styleIds.forEach((sid, i) => {
    const info = catalogIdx?.styles.get(sid.toUpperCase()) || null;
    const label = styleIds.length > 1 ? (i === 0 ? "角色画风" : "场景画风") : "画风";
    wrap.appendChild(renderAttrCard(label, info, sid));
  });
  if (stateObj.layoutId) {
    const info = catalogIdx?.layouts.get(stateObj.layoutId.toUpperCase()) || null;
    wrap.appendChild(renderAttrCard("图型", info, stateObj.layoutId));
  }
  (stateObj.colors || []).filter(Boolean).forEach((cid) => {
    const info = catalogIdx?.colors.get(cid.toUpperCase()) || null;
    wrap.appendChild(renderAttrCard("主题色", info, cid));
  });
  (stateObj.tones || []).filter(Boolean).forEach((tid) => {
    const info = catalogIdx?.tones.get(tid.toUpperCase()) || null;
    wrap.appendChild(renderAttrCard("影调", info, tid));
  });
  if (!wrap.childNodes.length) {
    return el("div", { class: "rcp-attr-empty muted" }, "当前未选定画风、图型或配色，将仅保存画幅、模式等基础参数。");
  }
  return wrap;
}

function syncBadgeNode(rec) {
  const st = rec.syncStatus || (rec.remote?.id ? "synced" : "local");
  if (st === "synced") return el("span", { class: "badge badge-ok", title: "已与网页端双向同步" }, "☁ 已同步");
  if (st === "pending") return el("span", { class: "badge badge-accent", title: "待同步至网页端" }, "⏳ 待同步");
  return el("span", { class: "badge", title: "登录后自动同步至网页端" }, "仅本地");
}

export async function openRecipeManagerModal({ activeRecipeId = "", catalog = null, onApply = null, onChanged = null } = {}) {
  let recipes = [];
  let query = "";
  let catalogIdx = await ensureRecipeCatalog(catalog);

  const searchIn = el("input", {
    class: "input",
    type: "search",
    placeholder: "搜索配方名称、画风编号或说明…",
    style: { flex: "1", minWidth: "180px" },
  });

  const fileIn = el("input", { type: "file", accept: ".json", class: "hidden" });
  const listHost = el("div", { class: "rcp-mgr-grid" });

  const reopenSelf = () => openRecipeManagerModal({ activeRecipeId, catalog, onApply, onChanged });

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
        style: { gridColumn: "1 / -1", textAlign: "center", padding: "28px 14px", lineHeight: "1.6" },
      }, recipes.length
        ? "没有匹配的个人配方"
        : "还没有个人配方。在生图台调好画风、图型与参数后点击「💾 存为配方」，登录后会自动与网页端双向同步。"));
      return;
    }

    filtered.forEach((rec) => {
      const isCurrent = Boolean(activeRecipeId && rec.id === activeRecipeId);
      const thumbs = [];
      (rec.styleIds || []).forEach((sid) => {
        const info = catalogIdx?.styles.get(sid.toUpperCase());
        const src = resolveImgSrc(info?.image || "");
        if (src) {
          thumbs.push(el("img", { class: "rcp-card-thumb", src, alt: info?.name || sid, title: `画风：${info?.name || sid} (${sid})`, loading: "lazy" }));
        }
      });
      if (rec.layoutId) {
        const info = catalogIdx?.layouts.get(rec.layoutId.toUpperCase());
        const src = resolveImgSrc(info?.image || "");
        if (src) {
          thumbs.push(el("img", { class: "rcp-card-thumb", src, alt: info?.name || rec.layoutId, title: `图型：${info?.name || rec.layoutId} (${rec.layoutId})`, loading: "lazy" }));
        }
      }
      (rec.colors || []).forEach((cid) => {
        const info = catalogIdx?.colors.get(cid.toUpperCase());
        const src = resolveImgSrc(info?.image || "");
        if (src) {
          thumbs.push(el("img", { class: "rcp-card-thumb", src, alt: info?.name || cid, title: `主题色：${info?.name || cid}`, loading: "lazy" }));
        } else if (info?.hex) {
          thumbs.push(el("span", { class: "rcp-card-thumb rcp-card-swatch", style: { background: info.hex }, title: `主题色：${info.name}` }));
        }
      });

      const meta = [
        rec.styleIds?.length ? "画风 " + rec.styleIds.join("+") : null,
        rec.layoutId ? "图型 " + rec.layoutId : null,
        rec.colors?.length ? "主题色 " + rec.colors.join(",") : null,
        rec.ratio || "3:4",
        rec.mode === "pure-image" ? "纯图" : "图文",
      ].filter(Boolean).join(" · ");

      listHost.appendChild(el("div", {
        class: "card col rcp-mgr-card" + (isCurrent ? " is-current" : ""),
      },
        thumbs.length ? el("div", { class: "rcp-card-thumbs" }, ...thumbs) : null,
        el("div", { class: "row", style: { justifyContent: "space-between", gap: "6px", alignItems: "center" } },
          el("strong", { style: { fontSize: "13.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: rec.name }, rec.name),
          el("div", { class: "row", style: { gap: "4px", flexShrink: "0" } },
            isCurrent ? el("span", { class: "badge badge-ok" }, "当前") : null,
            syncBadgeNode(rec)
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
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => openRecipeEditor(rec, async () => {
              await onChanged?.();
              reopenSelf();
            }, reopenSelf, { catalog }),
          }, "编辑"),
          el("button", {
            type: "button",
            class: "btn btn-sm",
            onClick: () => exportRecipeFile(rec),
          }, "导出"),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-danger",
            onClick: async () => {
              if (!window.confirm(`确定删除配方「${rec.name}」？删除也会同步到网页端。`)) return;
              try {
                await api("DELETE", `/api/mine/recipes/${encodeURIComponent(rec.id)}`);
                toast("已删除配方");
                await reload();
                await onChanged?.();
              } catch (e) { toast(e.message); }
            },
          }, "删除")
        )
      ));
    });
  };

  const reload = async () => {
    const res = await api("GET", "/api/mine/recipes").catch(() => ({ items: [] }));
    recipes = res.items || [];
    renderCards();
  };

  const syncBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    dataset: { role: "recipe-sync-btn" },
    onClick: async () => {
      syncBtn.disabled = true;
      const orig = syncBtn.textContent;
      syncBtn.textContent = "同步中…";
      try {
        const res = await api("POST", "/api/mine/recipes/sync");
        const parts = [];
        if (res.pushed) parts.push(`上传 ${res.pushed} 条`);
        if (res.pulled) parts.push(`拉取 ${res.pulled} 条`);
        if (res.conflictForks) parts.push(`保留 ${res.conflictForks} 条冲突副本`);
        toast(parts.length ? `配方同步完成：${parts.join("，")}` : "配方已是最新状态");
        await reload();
        await onChanged?.();
      } catch (e) {
        toast(e?.message || "请先登录手绘风账号后再同步");
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = orig;
      }
    },
  }, "🔄 同步云端");

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
      if (!String(obj.name || "").trim()) {
        toast("导入失败：配方 JSON 缺少名称");
        fileIn.value = "";
        return;
      }
      await api("POST", "/api/mine/recipes", obj);
      toast("已导入配方：" + obj.name);
      await reload();
      await onChanged?.();
    } catch (e) { toast("导入失败：" + e.message); }
    fileIn.value = "";
  });

  const body = el("div", { class: "col", style: { gap: "12px" } },
    el("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
      searchIn,
      fileIn,
      syncBtn,
      el("button", { type: "button", class: "btn btn-sm", onClick: () => fileIn.click() }, "导入 .json"),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-primary",
        onClick: () => openRecipeEditor({}, async () => {
          await onChanged?.();
          reopenSelf();
        }, reopenSelf, { catalog }),
      }, "+ 新建配方")
    ),
    listHost
  );

  showModal("我的配方管理", body, [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
  ], { className: "modal-recipe-mgr" });

  await reload();
  // Silently pull latest cloud recipes when opening manager
  api("POST", "/api/mine/recipes/sync")
    .then(async (res) => {
      if (res && (res.pushed || res.pulled || res.conflictForks)) {
        await reload();
        await onChanged?.();
      }
    })
    .catch(() => {});
}

export async function openRecipeEditor(initial = {}, onSaved, onCancel, opts = {}) {
  const isEdit = Boolean(initial.id);
  const catalogIdx = await ensureRecipeCatalog(opts.catalog || null);

  // Recipe name has NO default value when creating — user must enter it explicitly.
  const nameIn = el("input", {
    id: "rcp-edit-name",
    class: "input",
    value: isEdit ? (initial.name || "") : "",
    maxlength: "60",
    required: true,
    autocomplete: "off",
    placeholder: "请填写配方名称（必填），例如：我的小红书固定画风",
  });
  const nameErr = el("span", { class: "rcp-field-err hidden", role: "alert" }, "请填写配方名称");

  const styleIn = el("input", { class: "input", value: (initial.styleIds || []).join(","), placeholder: "FA-013（双画风用逗号分隔，如 FA-013,FI-001）" });
  const layoutIn = el("input", { class: "input", value: initial.layoutId || "", placeholder: "可选，如 SC-001" });
  const colorIn = el("input", { class: "input", value: (initial.colors || []).join(","), placeholder: "可选，如 C-15" });
  const toneIn = el("input", { class: "input", value: (initial.tones || []).join(","), placeholder: "可选，如 T-01" });
  const ratioIn = el("input", { class: "input", value: initial.ratio || "3:4" });
  const modeSel = el("select", { class: "select" },
    el("option", { value: "graphic-text", selected: initial.mode !== "pure-image" }, "图文模式"),
    el("option", { value: "pure-image", selected: initial.mode === "pure-image" }, "纯图模式")
  );
  const notesIn = el("input", { class: "input", value: initial.notes || "", maxlength: "500", placeholder: "选填，记录适用场景或使用习惯" });

  const moodsList = Array.isArray(initial.moods)
    ? initial.moods.filter(Boolean)
    : (initial.mood ? [initial.mood] : []);
  const whitespaceVal = String(initial.whitespace || "").trim();

  const previewHost = el("div", { class: "col", style: { gap: "8px" } });
  const pillsHost = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } });

  const readCurrentState = () => ({
    styleIds: styleIn.value.split(/[,，]+/).map((x) => x.trim()).filter(Boolean),
    layoutId: layoutIn.value.trim(),
    colors: colorIn.value.split(/[,，]+/).map((x) => x.trim()).filter(Boolean),
    tones: toneIn.value.split(/[,，]+/).map((x) => x.trim()).filter(Boolean),
    moods: moodsList,
    whitespace: whitespaceVal,
    ratio: ratioIn.value.trim() || "3:4",
    mode: modeSel.value,
  });

  const refreshPreview = () => {
    const cur = readCurrentState();
    clear(previewHost);
    previewHost.appendChild(buildVisualPreviewSection(cur, catalogIdx));
    clear(pillsHost);
    const pills = [
      el("span", { class: "badge" }, cur.mode === "pure-image" ? "纯图模式" : "图文模式"),
      el("span", { class: "badge" }, `画幅 ${cur.ratio}`),
    ];
    if (cur.whitespace) pills.push(el("span", { class: "badge" }, `留白 ${cur.whitespace}`));
    if (cur.moods.length) pills.push(el("span", { class: "badge" }, `情绪 ${cur.moods.join("、")}`));
    pillsHost.append(...pills);
  };

  [styleIn, layoutIn, colorIn, toneIn, ratioIn, modeSel].forEach((inp) => {
    inp.addEventListener("input", refreshPreview);
    inp.addEventListener("change", refreshPreview);
  });
  nameIn.addEventListener("input", () => {
    if (nameIn.value.trim()) {
      nameErr.classList.add("hidden");
      nameIn.classList.remove("is-invalid");
    }
  });
  refreshPreview();

  const hasAnyVisualAttr = Boolean(
    (initial.styleIds && initial.styleIds.length) ||
    initial.layoutId ||
    (initial.colors && initial.colors.length) ||
    (initial.tones && initial.tones.length)
  );
  const advancedDetails = el("details", { class: "rcp-advanced-details", open: !hasAnyVisualAttr },
    el("summary", null, "调整画风 / 图型 / 配色 / 影调编号与比例"),
    el("div", { class: "split", style: { marginTop: "10px" } },
      el("div", { class: "field" }, el("label", null, "画风编号"), styleIn),
      el("div", { class: "field" }, el("label", null, "图型编号"), layoutIn),
      el("div", { class: "field" }, el("label", null, "主题色"), colorIn),
      el("div", { class: "field" }, el("label", null, "影调"), toneIn),
      el("div", { class: "field" }, el("label", null, "比例"), ratioIn),
      el("div", { class: "field" }, el("label", null, "模式"), modeSel)
    )
  );

  const saveBtn = el("button", {
    type: "button",
    class: "btn btn-primary",
    dataset: { role: "recipe-save-submit" },
    onClick: async () => {
      const cleanName = nameIn.value.trim();
      if (!cleanName) {
        nameErr.classList.remove("hidden");
        nameIn.classList.add("is-invalid");
        nameIn.focus();
        toast("请填写配方名称");
        return;
      }
      const cur = readCurrentState();
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      try {
        await api("POST", "/api/mine/recipes", {
          id: initial.id || "",
          name: cleanName,
          styleIds: cur.styleIds,
          layoutId: cur.layoutId,
          colors: cur.colors,
          tones: cur.tones,
          moods: cur.moods,
          whitespace: cur.whitespace,
          ratio: cur.ratio,
          mode: cur.mode,
          notes: notesIn.value.trim(),
        });
        closeModal();
        toast(isEdit ? "配方已更新" : "配方已保存");
        if (onSaved) await onSaved();
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = "保存";
        toast(e.message);
      }
    },
  }, "保存");

  nameIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      saveBtn.click();
    }
  });

  showModal(isEdit ? "编辑配方" : "保存为个人配方", el("div", { class: "col", style: { gap: "12px" } },
    el("div", { class: "field", style: { marginBottom: 0 } },
      el("label", { for: "rcp-edit-name" }, "配方名称 ", el("span", { class: "rcp-req" }, "*")),
      nameIn,
      nameErr
    ),
    el("div", { class: "col", style: { gap: "6px" } },
      el("label", { style: { fontSize: "12.5px", fontWeight: "650", color: "var(--ink)" } }, "已选视觉属性回显"),
      previewHost,
      pillsHost
    ),
    advancedDetails,
    el("div", { class: "field", style: { marginBottom: 0 } }, el("label", null, "说明备注（选填）"), notesIn),
    el("span", { class: "muted", style: { fontSize: "12px" } }, "登录手绘风账号后将自动与网页端创作台双向同步（不同步本地参考图）。")
  ), [
    el("button", {
      type: "button",
      class: "btn",
      onClick: () => {
        if (onCancel) onCancel();
        else closeModal();
      },
    }, "取消"),
    saveBtn,
  ], { className: "modal-recipe-editor" });

  setTimeout(() => nameIn.focus(), 40);
}
