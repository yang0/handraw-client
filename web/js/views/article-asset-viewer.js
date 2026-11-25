import { el, clear, toast } from "../api.js";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "avif", "ico"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv", "mkv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
const TEXT_EXTS = new Set([
  "txt", "json", "yaml", "yml", "toml", "csv", "tsv",
  "html", "htm", "css", "js", "ts", "jsx", "tsx",
  "py", "go", "sh", "sql", "xml", "ini", "conf", "log",
]);

export const VAULT_ASSET_KINDS = new Set(["image", "video", "audio", "pdf", "text"]);

export function getFileExt(pathOrName) {
  const leaf = String(pathOrName || "").split("/").pop() || "";
  const idx = leaf.lastIndexOf(".");
  if (idx <= 0 || idx === leaf.length - 1) return "";
  return leaf.slice(idx + 1).toLowerCase();
}

export function inferVaultFileKind(pathOrName) {
  const ext = getFileExt(pathOrName);
  if (!ext || ext === "md" || ext === "markdown") return "file";
  if (ext === "canvas") return "canvas";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTS.has(ext)) return "text";
  return "file";
}

export function isVaultAssetKind(kind) {
  return VAULT_ASSET_KINDS.has(kind);
}

export function isVaultAssetPath(relPath) {
  return isVaultAssetKind(inferVaultFileKind(relPath));
}

export function vaultFileKindIcon(kind) {
  switch (kind) {
    case "canvas": return "🎨";
    case "image": return "🖼";
    case "video": return "🎬";
    case "audio": return "🎵";
    case "pdf": return "📕";
    case "text": return "📃";
    default: return "📄";
  }
}

export function vaultFileKindLabel(kind) {
  switch (kind) {
    case "canvas": return "白板";
    case "image": return "图片";
    case "video": return "视频";
    case "audio": return "音频";
    case "pdf": return "PDF 文档";
    case "text": return "文本";
    default: return "Markdown";
  }
}

export function formatAssetBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatMediaDuration(sec) {
  const total = Math.floor(Number(sec) || 0);
  if (!Number.isFinite(total) || total <= 0) return "";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function parseDelimitedRows(text, delim, maxRows = 400) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= maxRows) break;
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if ((cell !== "" || row.length > 0) && rows.length < maxRows) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function copyTextSilently(text, okMsg) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = el("textarea", { value: text, style: { position: "fixed", opacity: "0" } });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(okMsg);
  } catch {
    toast("复制失败");
  }
}

/**
 * Renders the dedicated warm-paper read-only viewer for non-Markdown vault files (#140).
 */
export function renderAssetViewer(container, preview, callbacks = {}) {
  clear(container);
  if (!preview || !preview.path) return;

  const kind = preview.kind || inferVaultFileKind(preview.path);
  const ext = (preview.ext || getFileExt(preview.path) || "").toUpperCase();
  const assetUrl = preview.assetUrl || `/files/vault-asset?path=${encodeURIComponent(preview.path)}`;
  const metaExtraPill = el("span", { class: "ic-asset-pill hidden" });
  const extraControls = el("div", { class: "ic-asset-bar-group" });

  const headerBar = el("div", { class: "ic-asset-bar" },
    el("div", { class: "ic-asset-bar-meta" },
      el("span", { class: "ic-asset-kind-ico", "aria-hidden": "true" }, vaultFileKindIcon(kind)),
      el("strong", { class: "ic-asset-name", title: preview.path }, preview.name || preview.path.split("/").pop()),
      el("span", { class: "ic-asset-pill is-readonly" }, "只读预览"),
      ext ? el("span", { class: "ic-asset-pill mono" }, ext) : null,
      el("span", { class: "ic-asset-pill" }, formatAssetBytes(preview.size)),
      metaExtraPill
    ),
    el("div", { class: "ic-asset-bar-actions" },
      extraControls,
      el("button", {
        type: "button",
        class: "btn btn-sm",
        title: `复制 Obsidian 嵌入语法 ![[${preview.name}]]`,
        onClick: () => callbacks.onCopyEmbed?.(preview),
      }, "📌 复制嵌入"),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        title: "用系统默认程序打开此文件",
        onClick: () => callbacks.onOpenExternal?.(preview.path),
      }, "↗ 系统打开"),
      el("button", {
        type: "button",
        class: "btn btn-sm",
        title: "在系统文件管理器中定位",
        onClick: () => callbacks.onReveal?.(preview.path),
      }, "📂 目录")
    )
  );

  const stage = el("div", { class: `ic-asset-stage is-${kind}` });
  container.append(headerBar, stage);

  if (kind === "image") {
    let zoomMode = "fit"; // "fit" | "scale"
    let scale = 1;
    let natW = 0;
    let natH = 0;

    const zoomLabelBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      title: "在「适应窗口」与「100% 原始尺寸」间切换",
      onClick: () => {
        if (zoomMode === "fit") {
          zoomMode = "scale";
          scale = 1;
        } else {
          zoomMode = "fit";
          scale = 1;
        }
        applyZoom();
      },
    }, "适应");

    const imgEl = el("img", {
      class: "ic-asset-img is-fit",
      src: assetUrl,
      alt: preview.name || preview.path,
      draggable: "false",
    });

    const applyZoom = () => {
      if (zoomMode === "fit") {
        imgEl.classList.add("is-fit");
        imgEl.style.width = "";
        imgEl.style.height = "";
        zoomLabelBtn.textContent = "适应";
      } else {
        imgEl.classList.remove("is-fit");
        if (natW > 0) {
          imgEl.style.width = `${Math.round(natW * scale)}px`;
          imgEl.style.height = "auto";
        }
        zoomLabelBtn.textContent = `${Math.round(scale * 100)}%`;
      }
    };

    const stepZoom = (delta) => {
      if (zoomMode === "fit") {
        zoomMode = "scale";
        const curRatio = natW > 0 && imgEl.clientWidth > 0 ? imgEl.clientWidth / natW : 1;
        scale = Math.max(0.2, Math.min(4, Math.round((curRatio + delta) * 20) / 20));
      } else {
        scale = Math.max(0.2, Math.min(4, Math.round((scale + delta) * 20) / 20));
      }
      applyZoom();
    };

    extraControls.append(
      el("button", { type: "button", class: "btn btn-sm", title: "缩小图片", onClick: () => stepZoom(-0.2) }, "−"),
      zoomLabelBtn,
      el("button", { type: "button", class: "btn btn-sm", title: "放大图片", onClick: () => stepZoom(0.2) }, "+")
    );

    const frame = el("div", { class: "ic-asset-img-frame" }, imgEl);
    stage.appendChild(frame);

    imgEl.addEventListener("load", () => {
      natW = imgEl.naturalWidth || 0;
      natH = imgEl.naturalHeight || 0;
      if (natW && natH) {
        metaExtraPill.textContent = `${natW} × ${natH}`;
        metaExtraPill.classList.remove("hidden");
      }
    });
    imgEl.addEventListener("dblclick", () => zoomLabelBtn.click());
    imgEl.addEventListener("error", () => {
      clear(stage);
      stage.appendChild(el("div", { class: "ic-asset-fallback" },
        el("div", { class: "ic-asset-fallback-ico" }, "🖼"),
        el("p", { style: { margin: 0, fontWeight: "600" } }, "无法渲染此图片"),
        el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px" } }, "文件可能已损坏或格式不受当前浏览器内核支持。"),
        el("button", { type: "button", class: "btn btn-primary btn-sm", onClick: () => callbacks.onOpenExternal?.(preview.path) }, "↗ 用系统图片查看器打开")
      ));
    });
    stage.addEventListener("wheel", (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      stepZoom(ev.deltaY < 0 ? 0.15 : -0.15);
    }, { passive: false });
    return;
  }

  if (kind === "video") {
    const videoEl = el("video", {
      class: "ic-asset-video",
      src: assetUrl,
      controls: true,
      playsinline: true,
      preload: "metadata",
    });
    const fallbackNote = el("div", { class: "ic-asset-video-err hidden" },
      el("p", { style: { margin: 0, fontWeight: "600" } }, "当前内核无法直接解码此视频格式"),
      el("p", { class: "muted", style: { margin: 0, fontSize: "12.5px" } }, "常见于 HEVC/H.265 或特殊封装（如部分 MKV/MOV）。可使用本机播放器直接打开。"),
      el("button", { type: "button", class: "btn btn-primary btn-sm", onClick: () => callbacks.onOpenExternal?.(preview.path) }, "↗ 用系统播放器打开")
    );

    videoEl.addEventListener("loadedmetadata", () => {
      const parts = [];
      if (videoEl.videoWidth && videoEl.videoHeight) parts.push(`${videoEl.videoWidth} × ${videoEl.videoHeight}`);
      const dur = formatMediaDuration(videoEl.duration);
      if (dur) parts.push(dur);
      if (parts.length) {
        metaExtraPill.textContent = parts.join(" · ");
        metaExtraPill.classList.remove("hidden");
      }
    });
    videoEl.addEventListener("error", () => {
      fallbackNote.classList.remove("hidden");
    });

    stage.append(
      el("div", { class: "ic-asset-video-shell" }, videoEl, fallbackNote),
      el("div", { class: "ic-asset-video-caption muted mono" }, preview.path)
    );
    return;
  }

  if (kind === "audio") {
    const audioEl = el("audio", {
      class: "ic-asset-audio",
      src: assetUrl,
      controls: true,
      preload: "metadata",
    });
    audioEl.addEventListener("loadedmetadata", () => {
      const dur = formatMediaDuration(audioEl.duration);
      if (dur) {
        metaExtraPill.textContent = dur;
        metaExtraPill.classList.remove("hidden");
      }
    });
    stage.appendChild(el("div", { class: "ic-asset-audio-card" },
      el("div", { class: "ic-asset-audio-disc", "aria-hidden": "true" }, "🎵"),
      el("h3", { class: "ic-asset-audio-title" }, preview.name || preview.path),
      el("p", { class: "ic-asset-audio-path mono muted" }, preview.path),
      audioEl
    ));
    return;
  }

  if (kind === "pdf") {
    const frame = el("iframe", {
      class: "ic-asset-pdf-frame",
      src: assetUrl,
      title: preview.name || "PDF 预览",
    });
    stage.appendChild(frame);
    return;
  }

  // Read-only Text / JSON / CSV / Code viewer
  const rawText = String(preview.content ?? "");
  const lowExt = (preview.ext || getFileExt(preview.path) || "").toLowerCase();
  const isCsv = lowExt === "csv" || lowExt === "tsv";
  const isJson = lowExt === "json";
  let mode = isCsv ? "table" : (isJson ? "pretty" : "raw");
  let wrapLines = true;

  const textBody = el("div", { class: "ic-asset-text-body" });

  const renderTextBody = () => {
    clear(textBody);
    if (preview.truncated) {
      textBody.appendChild(el("div", { class: "ic-asset-trunc-banner" },
        `文件较大（${formatAssetBytes(preview.size)}），当前仅展示前 512 KB 只读内容；点击右上角「系统打开」可查看完整文件。`
      ));
    }
    if (isCsv && mode === "table") {
      const rows = parseDelimitedRows(rawText, lowExt === "tsv" ? "\t" : ",", 400);
      if (rows.length > 0) {
        const thead = el("thead", null, el("tr", null, ...rows[0].map((h) => el("th", null, h))));
        const tbody = el("tbody", null, ...rows.slice(1).map((r) => el("tr", null, ...r.map((c) => el("td", null, c)))));
        textBody.appendChild(el("div", { class: "ic-asset-csv-wrap" }, el("table", { class: "ic-asset-csv-table" }, thead, tbody)));
        return;
      }
    }
    let display = rawText;
    if (isJson && mode === "pretty") {
      try {
        display = JSON.stringify(JSON.parse(rawText), null, 2);
      } catch {
        display = rawText;
      }
    }
    const lineCount = display ? display.split("\n").length : 0;
    metaExtraPill.textContent = `${lineCount} 行`;
    metaExtraPill.classList.remove("hidden");
    textBody.appendChild(el("pre", {
      class: "ic-asset-code" + (wrapLines ? " is-wrap" : ""),
    }, display || "（空文件）"));
  };

  if (isCsv) {
    const toggleCsvBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: () => {
        mode = mode === "table" ? "raw" : "table";
        toggleCsvBtn.textContent = mode === "table" ? "查看源码" : "表格视图";
        renderTextBody();
      },
    }, "查看源码");
    extraControls.appendChild(toggleCsvBtn);
  } else if (isJson) {
    const toggleJsonBtn = el("button", {
      type: "button",
      class: "btn btn-sm",
      onClick: () => {
        mode = mode === "pretty" ? "raw" : "pretty";
        toggleJsonBtn.textContent = mode === "pretty" ? "原始文本" : "格式化";
        renderTextBody();
      },
    }, "原始文本");
    extraControls.appendChild(toggleJsonBtn);
  }

  const wrapBtn = el("button", {
    type: "button",
    class: "btn btn-sm is-active",
    onClick: () => {
      wrapLines = !wrapLines;
      wrapBtn.classList.toggle("is-active", wrapLines);
      renderTextBody();
    },
  }, "自动换行");
  const copyBtn = el("button", {
    type: "button",
    class: "btn btn-sm",
    onClick: () => copyTextSilently(rawText, "已复制文件文本内容"),
  }, "📋 复制内容");
  extraControls.append(wrapBtn, copyBtn);

  stage.appendChild(el("div", { class: "ic-asset-text-card" }, textBody));
  renderTextBody();
}
