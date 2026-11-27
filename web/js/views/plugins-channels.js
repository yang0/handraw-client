import { api, clear, closeModal, el, openURL, showModal, toast } from "../api.js";
import { formatSkillSourceLabel, openHarnessSkillImportModal } from "../skills-ui.js";

export function mirrorTag(m) {
  if (m === "gitee") return "Gitee";
  if (m === "github") return "GitHub";
  return "";
}

export function pricingBadge(pricing) {
  const model = pricing?.model || "free";
  if (!pricing || model === "free") return null;
  if (model === "pro") return el("span", { class: "pm-chip pm-price-pro" }, "Pro 会员");
  if (model === "credits" && pricing.credits > 0) {
    return el("span", { class: "pm-chip pm-price-paid" }, `${pricing.credits} 积分`);
  }
  if (model === "paid" && pricing.priceCents > 0) {
    return el("span", { class: "pm-chip pm-price-paid" }, `¥${(pricing.priceCents / 100).toFixed(2)}`);
  }
  return null;
}

function formatBytes(n) {
  const b = Number(n || 0);
  if (b <= 0) return "0 KB";
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDownloads(n) {
  const num = Number(n || 0);
  if (!num) return "";
  if (num >= 10000) return `${(num / 10000).toFixed(1)} 万下载`;
  return `${num.toLocaleString()} 下载`;
}

function formatDateShort(raw) {
  if (!raw) return "";
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw);
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

export function renderSourceChips(sources, busy, onRemove) {
  const wrap = el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", alignItems: "center" } });
  (sources || []).forEach((s) => {
    const mTag = mirrorTag(s.activeMirror);
    wrap.appendChild(el("span", {
      class: "badge" + (s.official ? " badge-accent" : ""),
      title: s.error
        ? `${s.url}\n加载失败：${s.error}${s.fallback ? "（已使用内置回退索引）" : ""}`
        : (s.activeUrl || s.url),
      style: { display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 9px" },
    },
      s.name || s.id,
      s.fallback ? "（离线索引）" : (s.error ? "（连接失败）" : `${mTag ? " · " + mTag : ""} · ${s.count || 0}`),
      !s.official && onRemove
        ? el("button", {
            type: "button",
            class: "gal-chip-x",
            "aria-label": `移除市场源 ${s.name || s.id}`,
            disabled: Boolean(busy),
            onClick: () => onRemove(s),
          }, "×")
        : null
    ));
  });
  return wrap;
}

// =========================================================================
// Shared: Extension Market Inclusion Submission Modal (integrated with handraw-web #523)
// =========================================================================

const CHANNEL_OPTIONS = [
  {
    value: "plugin",
    ico: "🧩",
    label: "工作台插件",
    desc: "扩展手绘风功能与新视图",
    repoPlaceholder: "https://github.com/owner/repo 或 npm:@scope/pkg",
  },
  {
    value: "gallery",
    ico: "🖼",
    label: "图库插件",
    desc: "参考图、姿势、道具素材包",
    repoPlaceholder: "https://github.com/owner/gallery-repo 或 index.json / .zip 地址",
  },
  {
    value: "skill",
    ico: "✨",
    label: "AI Skills",
    desc: "SKILL.md 写作或生图工作流",
    repoPlaceholder: "https://github.com/owner/skill-repo 或 SKILL.md 仓库地址",
  },
  {
    value: "obsidian",
    ico: "📝",
    label: "写作插件",
    desc: "Obsidian 兼容 Markdown 扩展",
    repoPlaceholder: "GitHub 仓库（owner/repo 或 https://github.com/owner/repo）",
  },
];

const ROLE_OPTIONS = [
  {
    value: "recommend",
    ico: "🌟",
    title: "发现好物，顺手推荐",
    desc: "看到别人做的好用插件或 Skill，推荐收录",
  },
  {
    value: "author",
    ico: "🛠",
    title: "我自己开发的",
    desc: "原创插件申请上架官方市场，展示给更多创作者",
  },
];

const SUBMISSION_STATUS_MAP = {
  pending: { label: "审核中", cls: "badge badge-warn" },
  approved: { label: "已收录", cls: "badge badge-ok" },
  rejected: { label: "未通过", cls: "badge badge-err" },
};

function inferAuthorFromRepoUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const gh = s.match(/^https?:\/\/(?:www\.)?(?:github\.com|gitee\.com)\/([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+/i);
  if (gh) return gh[1];
  const shortRepo = s.match(/^([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+$/);
  if (shortRepo) return shortRepo[1];
  return "";
}

function buildSubmissionNotes(role, rawNote) {
  const tag = role === "author" ? "[作者自荐]" : "[好物推荐]";
  const clean = String(rawNote || "").trim();
  return clean ? `${tag} ${clean}` : tag;
}

export function openExtensionSubmitModal(ctx, { channel = "plugin", prefill = null, role = "" } = {}) {
  let mode = "form"; // "form" | "mine"
  // 2-step flow (#157, #189): "url" (paste repo URL) -> "confirm" (AI parsed basic info, confirm & submit)
  let step = (prefill?.repoUrl && prefill?.name) ? "confirm" : "url";
  let submitRole = (role === "author" || role === "recommend")
    ? role
    : ((prefill?.repoUrl && prefill?.name) ? "author" : "recommend");
  let selectedChannel = CHANNEL_OPTIONS.some((c) => c.value === channel) ? channel : "plugin";
  let inspecting = false;
  let submitting = false;
  let mineData = null;
  let mineLoading = false;
  let parsedMeta = {
    parsedBy: prefill?.name ? "prefill" : "",
    detectedFiles: [],
    slug: prefill?.slug || "",
    homepageUrl: prefill?.homepageUrl || "",
    authorName: prefill?.authorName || "",
    version: prefill?.version || "",
    tags: Array.isArray(prefill?.tags) ? prefill.tags : [],
  };

  const currentMeta = () => CHANNEL_OPTIONS.find((c) => c.value === selectedChannel) || CHANNEL_OPTIONS[0];
  const formId = "ext-submit-form";

  const repoIn = el("input", {
    id: "ext-sub-repo",
    name: "repoUrl",
    class: "input mono ext-sub-repo-input",
    type: "text",
    value: prefill?.repoUrl || "",
    placeholder: currentMeta().repoPlaceholder,
    autocorrect: "off",
    autocapitalize: "none",
    spellcheck: "false",
    enterkeyhint: "next",
    "aria-describedby": "ext-sub-repo-help",
  });
  const nameIn = el("input", {
    id: "ext-sub-name",
    name: "name",
    class: "input",
    type: "text",
    value: prefill?.name || "",
    placeholder: "例如：公众号一键排版助手",
    required: true,
    minlength: "2",
    maxlength: "80",
    enterkeyhint: "next",
  });
  const descIn = el("textarea", {
    id: "ext-sub-desc",
    name: "description",
    class: "textarea",
    rows: "2",
    required: true,
    minlength: "4",
    maxlength: "600",
    placeholder: "一句话说清它能做什么、最打动你的亮点是什么",
  });
  descIn.value = prefill?.description || "";

  const noteIn = el("textarea", {
    id: "ext-sub-notes",
    name: "notes",
    class: "textarea",
    rows: "2",
    maxlength: "800",
    placeholder: "",
  });
  noteIn.value = prefill?.notes || "";

  const syncPlaceholders = () => {
    repoIn.placeholder = currentMeta().repoPlaceholder;
    noteIn.placeholder = submitRole === "author"
      ? "选填：适用场景、配置提示或作者联系方式，方便审核与后续对接"
      : "选填：为什么推荐它？比如「写长文时特别顺手」「开箱即用」，帮助审核更快了解亮点";
  };
  syncPlaceholders();

  const errBox = el("div", {
    id: "ext-sub-error",
    class: "ext-sub-error",
    role: "alert",
    "aria-live": "polite",
    hidden: true,
  });
  const bodyHost = el("div", { class: "col ext-sub-body" });
  const tabHost = el("div", { class: "row ext-sub-headbar" });
  const actionBtn = el("button", { type: "submit", form: formId, class: "btn btn-primary" }, "✨ AI 自动识别");

  const clearFieldInvalids = () => {
    repoIn.removeAttribute("aria-invalid");
    nameIn.removeAttribute("aria-invalid");
    descIn.removeAttribute("aria-invalid");
  };

  const setErr = (msg, { showLoginLink = false, field = null } = {}) => {
    clear(errBox);
    clearFieldInvalids();
    if (!msg) {
      errBox.hidden = true;
      return;
    }
    if (field) field.setAttribute("aria-invalid", "true");
    errBox.append(el("span", { class: "ext-sub-error-ico", "aria-hidden": "true" }, "!"), el("span", null, msg));
    if (showLoginLink) {
      errBox.append(" ", el("a", {
        href: "#settings",
        class: "ext-sub-login-link",
        onClick: (ev) => { ev.preventDefault(); closeModal(); ctx.go("settings", { anchor: "settings-account" }); },
      }, "前往登录 →"));
    }
    errBox.hidden = false;
  };

  [repoIn, nameIn, descIn].forEach((inp) => {
    inp.addEventListener("input", () => {
      if (inp.getAttribute("aria-invalid") === "true") {
        inp.removeAttribute("aria-invalid");
      }
      if (!errBox.hidden) setErr("");
    });
  });

  const loadMine = async () => {
    mineLoading = true;
    paintBody();
    try {
      mineData = await api("GET", "/api/extensions/submissions/mine?limit=50");
    } catch (e) {
      mineData = { loggedIn: false, items: [], error: e.message };
    } finally {
      mineLoading = false;
      if (bodyHost.isConnected) {
        paintTabs();
        paintBody();
      }
    }
  };

  const syncActionBtn = () => {
    if (mode !== "form") {
      actionBtn.hidden = true;
      actionBtn.style.display = "none";
      return;
    }
    actionBtn.hidden = false;
    actionBtn.style.display = "";
    if (step === "url") {
      actionBtn.disabled = inspecting;
      actionBtn.textContent = inspecting ? "⏳ AI 正在识别仓库…" : "✨ AI 自动识别";
    } else {
      actionBtn.disabled = submitting || inspecting;
      actionBtn.textContent = submitting
        ? "提交中…"
        : (submitRole === "author" ? "确认提交上架" : "确认推荐收录");
    }
  };

  const runInspect = async () => {
    if (inspecting) return;
    setErr("");
    const rawUrl = repoIn.value.trim();
    if (!rawUrl) {
      setErr("请先粘贴仓库地址（支持 GitHub / Gitee 链接、owner/repo 或 npm 包名）", { field: repoIn });
      repoIn.focus();
      return;
    }
    inspecting = true;
    syncActionBtn();
    paintBody();
    try {
      const res = await api("POST", "/api/extensions/submissions/inspect", {
        repoUrl: rawUrl,
        channel: selectedChannel,
      });
      const info = res?.info || {};
      if (info.channel && CHANNEL_OPTIONS.some((c) => c.value === info.channel)) {
        selectedChannel = info.channel;
      }
      if (info.repoUrl) repoIn.value = info.repoUrl;
      nameIn.value = info.name || nameIn.value || "";
      descIn.value = info.description || descIn.value || "";
      parsedMeta = {
        parsedBy: res?.parsedBy || "manifest",
        detectedFiles: Array.isArray(res?.detectedFiles) ? res.detectedFiles : [],
        slug: info.slug || "",
        homepageUrl: info.homepageUrl || info.repoUrl || "",
        authorName: info.authorName || inferAuthorFromRepoUrl(info.repoUrl || rawUrl),
        version: info.version || "",
        tags: Array.isArray(info.tags) ? info.tags : [],
      };
      syncPlaceholders();
      step = "confirm";
      toast(parsedMeta.parsedBy === "ai" ? "AI 已自动整理仓库信息，核对无误即可提交" : "已读取仓库基础信息，核对后即可提交");
      requestAnimationFrame(() => nameIn.focus());
    } catch (e) {
      setErr(e?.message || "仓库解析失败，可检查链接或点击下方「直接手动填写」", { field: repoIn });
    } finally {
      inspecting = false;
      syncActionBtn();
      if (bodyHost.isConnected) paintBody();
    }
  };

  const runSubmit = async () => {
    if (submitting) return;
    setErr("");
    const name = nameIn.value.trim();
    const repoUrl = repoIn.value.trim();
    const description = descIn.value.trim();
    if (!repoUrl) {
      setErr("请填写仓库或资源地址", { field: repoIn });
      repoIn.focus();
      return;
    }
    if (name.length < 2) {
      setErr("请填写插件名称（至少 2 个字符）", { field: nameIn });
      nameIn.focus();
      return;
    }
    if (description.length < 4) {
      setErr("请填写一句话亮点或用途（至少 4 个字符）", { field: descIn });
      descIn.focus();
      return;
    }
    submitting = true;
    syncActionBtn();
    try {
      const inferredAuthor = parsedMeta.authorName || (submitRole === "recommend" ? inferAuthorFromRepoUrl(repoUrl) : "");
      await api("POST", "/api/extensions/submissions", {
        channel: selectedChannel,
        name,
        slug: parsedMeta.slug || prefill?.slug || "",
        repoUrl,
        homepageUrl: parsedMeta.homepageUrl || repoUrl,
        description,
        authorName: inferredAuthor,
        version: parsedMeta.version || "",
        tags: parsedMeta.tags || [],
        notes: buildSubmissionNotes(submitRole, noteIn.value),
      });
      toast(submitRole === "author"
        ? "提交成功！审核通过后将上架官方市场 🎉"
        : "感谢推荐！已加入收录队列，审核通过后将分享给更多用户 🎉");
      mode = "mine";
      mineData = null;
      paintTabs();
      await loadMine();
    } catch (e) {
      const msg = e?.message || "提交失败，请稍后重试";
      setErr(msg, { showLoginLink: e?.status === 401 || msg.includes("登录") });
    } finally {
      submitting = false;
      if (actionBtn.isConnected) syncActionBtn();
    }
  };

  const handlePasteRepo = async () => {
    try {
      if (!navigator.clipboard?.readText) {
        toast("请直接按 Ctrl/⌘+V 粘贴链接");
        repoIn.focus();
        return;
      }
      const txt = (await navigator.clipboard.readText() || "").trim();
      if (!txt) {
        toast("剪贴板里还没有链接");
        repoIn.focus();
        return;
      }
      repoIn.value = txt;
      setErr("");
      repoIn.focus();
    } catch {
      toast("请按 Ctrl/⌘+V 粘贴仓库链接");
      repoIn.focus();
    }
  };

  repoIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && mode === "form" && step === "url") {
      e.preventDefault();
      runInspect();
    }
  });

  const buildRoleFieldset = () => {
    return el("fieldset", { class: "ext-sub-fieldset" },
      el("legend", { class: "ext-sub-legend" }, "你是推荐好物，还是提交自研作品？"),
      el("div", { class: "ext-sub-role-grid" },
        ...ROLE_OPTIONS.map((opt) => {
          const rid = `ext-sub-role-${opt.value}`;
          const radio = el("input", {
            type: "radio",
            id: rid,
            name: "submitRole",
            value: opt.value,
            class: "visually-hidden",
            checked: submitRole === opt.value,
            onChange: () => {
              if (!radio.checked) return;
              submitRole = opt.value;
              syncPlaceholders();
              syncActionBtn();
              paintBody();
            },
          });
          return el("label", {
            for: rid,
            class: "ext-sub-role-card" + (submitRole === opt.value ? " is-selected" : ""),
          },
            radio,
            el("span", { class: "ext-sub-role-ico", "aria-hidden": "true" }, opt.ico),
            el("span", { class: "ext-sub-role-copy" },
              el("strong", null, opt.title),
              el("small", null, opt.desc)
            )
          );
        })
      )
    );
  };

  const buildChannelFieldset = (compact = false) => {
    return el("fieldset", { class: "ext-sub-fieldset" },
      el("legend", { class: "ext-sub-legend" }, compact ? "所属插件类目" : "选择插件类目（AI 识别时也会自动校正）"),
      el("div", { class: "ext-sub-ch-grid" + (compact ? " is-compact" : "") },
        ...CHANNEL_OPTIONS.map((opt) => {
          const cid = `ext-sub-ch-${compact ? "c-" : ""}${opt.value}`;
          const radio = el("input", {
            type: "radio",
            id: cid,
            name: "channel",
            value: opt.value,
            class: "visually-hidden",
            checked: selectedChannel === opt.value,
            onChange: () => {
              if (!radio.checked) return;
              selectedChannel = opt.value;
              syncPlaceholders();
              paintBody();
            },
          });
          return el("label", {
            for: cid,
            class: "ext-sub-ch-card" + (selectedChannel === opt.value ? " is-selected" : ""),
          },
            radio,
            el("span", { class: "ext-sub-ch-ico", "aria-hidden": "true" }, opt.ico),
            el("span", { class: "ext-sub-ch-copy" },
              el("strong", null, opt.label),
              !compact ? el("small", null, opt.desc) : null
            )
          );
        })
      )
    );
  };

  const buildStepProgress = () => {
    return el("nav", { class: "ext-sub-steps", "aria-label": "提交步骤" },
      el("ol", { class: "ext-sub-step-list" },
        el("li", {
          class: "ext-sub-step" + (step === "url" ? " is-active" : " is-done"),
          "aria-current": step === "url" ? "step" : null,
        },
          el("span", { class: "ext-sub-step-num", "aria-hidden": "true" }, step === "url" ? "1" : "✓"),
          el("span", null, "贴链接识别")
        ),
        el("li", { class: "ext-sub-step-sep", "aria-hidden": "true" }),
        el("li", {
          class: "ext-sub-step" + (step === "confirm" ? " is-active" : ""),
          "aria-current": step === "confirm" ? "step" : null,
        },
          el("span", { class: "ext-sub-step-num", "aria-hidden": "true" }, "2"),
          el("span", null, "核对并提交")
        )
      )
    );
  };

  const paintTabs = () => {
    clear(tabHost);
    tabHost.appendChild(el("div", { class: "pm-seg-group", role: "tablist", "aria-label": "插件提交与记录切换" },
      el("button", {
        type: "button",
        role: "tab",
        "aria-selected": String(mode === "form"),
        class: "pm-seg-btn" + (mode === "form" ? " is-active" : ""),
        onClick: () => { mode = "form"; paintTabs(); paintBody(); },
      }, "推荐 / 提交"),
      el("button", {
        type: "button",
        role: "tab",
        "aria-selected": String(mode === "mine"),
        class: "pm-seg-btn" + (mode === "mine" ? " is-active" : ""),
        onClick: () => {
          mode = "mine";
          paintTabs();
          if (!mineData) loadMine();
          else paintBody();
        },
      }, `我的记录${mineData?.items?.length ? ` (${mineData.items.length})` : ""}`)
    ));
    if (mode === "form") {
      tabHost.appendChild(buildStepProgress());
    } else {
      tabHost.appendChild(el("button", {
        type: "button",
        class: "btn btn-sm",
        onClick: loadMine,
      }, "↻ 刷新"));
    }
    syncActionBtn();
  };

  const paintBody = () => {
    clear(bodyHost);
    if (mode === "form") {
      const form = el("form", {
        id: formId,
        class: "col ext-sub-form",
        novalidate: true,
        onSubmit: (ev) => {
          ev.preventDefault();
          if (step === "url") runInspect();
          else runSubmit();
        },
      });

      if (step === "url") {
        form.append(
          el("div", { class: "ext-sub-hero" },
            el("div", { class: "ext-sub-hero-copy" },
              el("strong", null, "好用的扩展，让更多人一起用上"),
              el("p", null, "不管是你自己开发的，还是看到别人做得超顺手的宝藏插件，贴个链接就能推荐——AI 自动帮你填表，审核通过后上架官方市场。")
            )
          ),
          buildRoleFieldset(),
          buildChannelFieldset(false),
          el("div", { class: "field ext-sub-field" },
            el("div", { class: "ext-sub-label-row" },
              el("label", { for: "ext-sub-repo" }, "仓库或资源链接 ", el("span", { class: "ext-sub-req", "aria-hidden": "true" }, "*")),
              el("button", {
                type: "button",
                class: "ext-sub-paste-btn",
                onClick: handlePasteRepo,
              }, "📋 从剪贴板粘贴")
            ),
            repoIn,
            el("span", { id: "ext-sub-repo-help", class: "ext-sub-help" },
              "支持 GitHub / Gitee 链接、owner/repo、npm:@scope/pkg、SKILL.md 或 index.json 地址"
            )
          ),
          inspecting
            ? el("div", { class: "ext-sub-loading", role: "status", "aria-live": "polite" },
                el("span", { class: "ext-sub-spinner", "aria-hidden": "true" }),
                el("span", null, "AI 正在读取仓库清单与 README，自动提取名称、类目与亮点简介…")
              )
            : el("div", { class: "ext-sub-skip-row" },
                el("button", {
                  type: "button",
                  class: "ext-sub-link-btn",
                  onClick: () => {
                    setErr("");
                    step = "confirm";
                    parsedMeta.parsedBy = "manual";
                    if (submitRole === "recommend" && !parsedMeta.authorName) {
                      parsedMeta.authorName = inferAuthorFromRepoUrl(repoIn.value);
                    }
                    paintTabs();
                    paintBody();
                    requestAnimationFrame(() => (repoIn.value.trim() ? nameIn : repoIn).focus());
                  },
                }, "不想等解析？直接手动填写基础信息 →")
              ),
          errBox
        );
        bodyHost.appendChild(form);
        return;
      }

      // Step 2: Compact Confirmation Card + optional recommendation reason
      const statusText = parsedMeta.parsedBy === "ai"
        ? `✨ AI 已自动识别${parsedMeta.detectedFiles.length ? `（${parsedMeta.detectedFiles.slice(0, 3).join("、")}）` : ""}`
        : parsedMeta.parsedBy === "manifest"
        ? `✓ 已提取仓库清单${parsedMeta.detectedFiles.length ? `（${parsedMeta.detectedFiles.slice(0, 3).join("、")}）` : ""}`
        : parsedMeta.parsedBy === "prefill"
        ? "已带入当前扩展信息，核对后即可提交"
        : "填写以下几项基础信息即可提交";

      const metaBits = [
        submitRole === "author" ? "🛠 作者自荐" : "🌟 好物推荐",
        parsedMeta.authorName ? `作者：${parsedMeta.authorName}` : "",
        parsedMeta.version ? `v${parsedMeta.version.replace(/^v/i, "")}` : "",
      ].filter(Boolean);

      const summaryCard = el("div", { class: "ext-sub-summary" },
        el("div", { class: "ext-sub-summary-top" },
          el("span", { class: "badge badge-accent" }, statusText),
          el("div", { class: "row", style: { gap: "6px" } },
            el("button", {
              type: "button",
              class: "btn btn-sm",
              disabled: inspecting,
              onClick: runInspect,
            }, inspecting ? "识别中…" : "↻ 重新识别"),
            el("button", {
              type: "button",
              class: "btn btn-sm",
              onClick: () => {
                setErr("");
                step = "url";
                paintTabs();
                paintBody();
                requestAnimationFrame(() => repoIn.focus());
              },
            }, "← 换个链接")
          )
        ),
        el("div", { class: "mono ext-sub-summary-url" }, repoIn.value.trim() || "（尚未填写仓库链接）"),
        el("div", { class: "ext-sub-summary-meta" },
          ...metaBits.map((b) => el("span", { class: "ext-sub-meta-chip" }, b)),
          ...(parsedMeta.tags || []).slice(0, 4).map((t) => el("span", { class: "ext-sub-meta-chip is-tag" }, `#${t}`))
        )
      );

      form.append(...[
        summaryCard,
        !repoIn.value.trim()
          ? el("div", { class: "field ext-sub-field" },
              el("label", { for: "ext-sub-repo" }, "仓库或资源链接 ", el("span", { class: "ext-sub-req", "aria-hidden": "true" }, "*")),
              repoIn
            )
          : null,
        buildChannelFieldset(true),
        el("div", { class: "field ext-sub-field" },
          el("label", { for: "ext-sub-name" }, "插件名称 ", el("span", { class: "ext-sub-req", "aria-hidden": "true" }, "*")),
          nameIn
        ),
        el("div", { class: "field ext-sub-field" },
          el("label", { for: "ext-sub-desc" }, "一句话亮点 / 用途 ", el("span", { class: "ext-sub-req", "aria-hidden": "true" }, "*")),
          descIn
        ),
        el("div", { class: "field ext-sub-field" },
          el("label", { for: "ext-sub-notes" }, submitRole === "author" ? "补充说明 / 联系方式（选填）" : "推荐理由（选填）"),
          noteIn
        ),
        errBox,
      ].filter(Boolean));
      bodyHost.appendChild(form);
      return;
    }

    if (mineLoading) {
      bodyHost.appendChild(el("div", { class: "ext-sub-empty muted", role: "status" }, "正在加载你的推荐与提交记录…"));
      return;
    }
    if (mineData && mineData.loggedIn === false) {
      bodyHost.appendChild(el("div", { class: "ext-sub-empty col" },
        el("strong", null, "登录后同步你的推荐记录"),
        el("span", { class: "muted" }, "登录手绘风账号即可提交插件收录，并实时查看审核进度。"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => { closeModal(); ctx.go("settings", { anchor: "settings-account" }); },
        }, "前往登录")
      ));
      return;
    }
    const items = Array.isArray(mineData?.items) ? mineData.items : [];
    if (!items.length) {
      bodyHost.appendChild(el("div", { class: "ext-sub-empty col" },
        el("strong", null, "还没有推荐或提交过插件"),
        el("span", { class: "muted" }, "发现好用的工作台插件、图库、Skill 或写作插件？点左上角切回「推荐 / 提交」，贴个链接 30 秒就能分享给大家。"),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          onClick: () => { mode = "form"; step = "url"; paintTabs(); paintBody(); requestAnimationFrame(() => repoIn.focus()); },
        }, "🧩 立即推荐一个")
      ));
      return;
    }
    const listWrap = el("div", { class: "col ext-sub-mine-list" });
    items.forEach((it) => {
      const sb = SUBMISSION_STATUS_MAP[it.status] || { label: it.status || "审核中", cls: "badge" };
      listWrap.appendChild(el("div", { class: "ext-sub-mine-card" },
        el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          el("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap" } },
            el("strong", null, it.name),
            el("span", { class: "badge" }, it.channelLabel || it.channel),
            el("span", { class: sb.cls }, sb.label)
          ),
          el("span", { class: "muted", style: { fontSize: "11.5px" } }, formatDateShort(it.createdAt))
        ),
        el("div", { class: "mono muted", style: { fontSize: "11.5px", wordBreak: "break-all" } }, it.repoUrl),
        it.adminNote
          ? el("div", { class: "ext-sub-admin-note" }, `审核反馈：${it.adminNote}`)
          : null
      ));
    });
    bodyHost.appendChild(listWrap);
  };

  paintTabs();
  paintBody();

  showModal("推荐 / 提交好用的插件", el("div", { class: "col", style: { gap: "12px" } }, tabHost, bodyHost), [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
    actionBtn,
  ], { className: "modal-ext-submit" });
  if (step === "url") requestAnimationFrame(() => repoIn.focus());
}

// =========================================================================
// 1. Galleries Channel (图库插件：页内独立管理 市场 / 已安装)
// =========================================================================

export function renderGalleriesMarketTab(stage, ctx, helpers) {
  const { getMirror, makeSkeletonGrid, refreshHub } = helpers;
  let subMode = "market"; // "market" | "installed"
  let data = null;
  let activeCat = "";
  let query = "";
  let busyId = "";
  let panelMode = ""; // "" | "add-source" | "direct-url"

  const topHost = el("div", { class: "col", style: { gap: "10px" } });
  const gridHost = el("div", { class: "col", style: { gap: "10px" } });

  const searchIn = el("input", {
    type: "search",
    class: "input pm-search-input",
    placeholder: "搜索图库插件…",
    "aria-label": "搜索图库插件",
  });
  searchIn.addEventListener("input", () => { query = searchIn.value; paint(); });

  stage.append(topHost, gridHost);

  const load = async (refresh = false) => {
    data = null;
    paint();
    try {
      const m = getMirror();
      data = await api("GET", `/api/galleries/market?mirror=${encodeURIComponent(m)}${refresh ? "&refresh=1" : ""}`);
    } catch (e) {
      data = { sources: [], categories: [], packs: [], error: e.message };
    }
    if (stage.isConnected) paint();
  };

  const paint = () => {
    clear(topHost);
    clear(gridHost);
    if (!data) {
      gridHost.appendChild(makeSkeletonGrid(6));
      return;
    }

    const packs = data.packs || [];
    const installedPacks = packs.filter((p) => p.installed);
    const cats = data.categories || [];
    const srcChips = renderSourceChips(data.sources, busyId, async (s) => {
      busyId = "__rm__";
      paint();
      try {
        data = await api("DELETE", `/api/galleries/market/sources/${encodeURIComponent(s.id)}`);
        toast(`已移除图库源「${s.name || s.id}」`);
      } catch (e) { toast(e.message || "移除失败"); }
      finally { busyId = ""; if (stage.isConnected) paint(); }
    });

    const subToggle = el("div", { class: "pm-seg-group", role: "tablist" },
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "market" ? " is-active" : ""), onClick: () => { subMode = "market"; paint(); } }, `市场 (${packs.length})`),
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "installed" ? " is-active" : ""), onClick: () => { subMode = "installed"; paint(); } }, `已安装 (${installedPacks.length})`)
    );

    const catBar = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", alignItems: "center" } }, subToggle);
    if (subMode === "market") {
      catBar.appendChild(el("button", { type: "button", class: "btn btn-sm" + (activeCat === "" ? " btn-primary" : ""), onClick: () => { activeCat = ""; paint(); } }, "全部分类"));
      cats.forEach((c) => {
        catBar.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm" + (activeCat === c.id ? " btn-primary" : ""),
          onClick: () => { activeCat = c.id; paint(); },
        }, `${c.name} (${c.count})`));
      });
    }

    topHost.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
        srcChips,
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openExtensionSubmitModal(ctx, { channel: "gallery" }) }, "＋ 申请收录"),
          el("button", { type: "button", class: "btn btn-sm" + (panelMode === "add-source" ? " btn-primary" : ""), onClick: () => { panelMode = panelMode === "add-source" ? "" : "add-source"; paint(); } }, "+ 添加源"),
          el("button", { type: "button", class: "btn btn-sm" + (panelMode === "direct-url" ? " btn-primary" : ""), onClick: () => { panelMode = panelMode === "direct-url" ? "" : "direct-url"; paint(); } }, "🔗 链接直装"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => load(true) }, "↻ 刷新")
        )
      ),
      el("div", { class: "pm-filter-bar" }, catBar, searchIn)
    ));

    if (panelMode === "add-source") {
      const urlIn = el("input", { class: "input", type: "url", placeholder: "https://.../index.json（Format 1 图库市场）", style: { flex: "1", minWidth: "240px" } });
      const nameIn = el("input", { class: "input", type: "text", placeholder: "市场名称（可选）", style: { maxWidth: "200px" } });
      topHost.appendChild(el("div", { class: "card row", style: { gap: "8px", flexWrap: "wrap", borderColor: "var(--accent)" } },
        urlIn, nameIn,
        el("button", {
          type: "button", class: "btn btn-sm btn-primary", disabled: Boolean(busyId),
          onClick: async () => {
            if (!urlIn.value.trim()) return toast("请填写 index.json 地址");
            busyId = "__add__"; paint();
            try {
              data = await api("POST", "/api/galleries/market/sources", { url: urlIn.value.trim(), name: nameIn.value.trim() });
              panelMode = ""; toast("已订阅图库市场源");
            } catch (e) { toast(e.message || "添加失败"); }
            finally { busyId = ""; if (stage.isConnected) paint(); }
          },
        }, "确认订阅")
      ));
    } else if (panelMode === "direct-url") {
      const urlIn = el("input", { class: "input", type: "url", placeholder: "单个图库插件 .json 或 .zip 链接（https://...）", style: { flex: "1", minWidth: "240px" } });
      const idIn = el("input", { class: "input mono", type: "text", placeholder: "自定义 ID（可选）", style: { maxWidth: "160px" } });
      topHost.appendChild(el("div", { class: "card row", style: { gap: "8px", flexWrap: "wrap", borderColor: "var(--accent)" } },
        urlIn, idIn,
        el("button", {
          type: "button", class: "btn btn-sm btn-primary", disabled: Boolean(busyId),
          onClick: async () => {
            if (!urlIn.value.trim()) return toast("请填写图库链接");
            busyId = "__direct__"; paint();
            try {
              data = await api("POST", "/api/galleries/market/install", { url: urlIn.value.trim(), id: idIn.value.trim(), mirror: getMirror() });
              panelMode = ""; toast("已安装扩展图库"); refreshHub?.();
            } catch (e) { toast(e.message || "安装失败"); }
            finally { busyId = ""; if (stage.isConnected) paint(); }
          },
        }, "立即安装")
      ));
    }

    const q = query.trim().toLowerCase();

    if (subMode === "installed") {
      const list = installedPacks.filter((p) =>
        !q || `${p.id} ${p.name} ${p.nameEn || ""} ${p.description || ""} ${p.author || ""}`.toLowerCase().includes(q)
      );
      if (!list.length) {
        gridHost.appendChild(el("div", { class: "card col", style: { alignItems: "center", gap: "10px", padding: "28px 16px" } },
          el("span", { class: "muted" }, "暂无已安装的图库插件"),
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => { subMode = "market"; paint(); } }, "浏览图库市场")
        ));
        return;
      }
      const listEl = el("div", { class: "pm-installed-list" });
      list.forEach((p) => {
        const isBusy = busyId === p.id;
        listEl.appendChild(el("div", { class: "pm-inst-row" },
          el("div", { class: "row", style: { gap: "11px", minWidth: 0, flex: "1", alignItems: "center" } },
            el("div", { class: "pm-logo", style: { fontSize: "18px" } }, p.multiVariant ? "🧍" : "🖼️"),
            el("div", { class: "col", style: { gap: "3px", minWidth: 0, flex: "1" } },
              el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
                el("strong", { style: { fontSize: "13.5px" } }, p.name),
                p.installedVersion || p.version ? el("span", { class: "pm-ver mono" }, `v${p.installedVersion || p.version}`) : null,
                el("span", { class: "pm-chip soft" }, `${p.itemCount || 0} 条 · ${formatBytes(p.cachedBytes)}`)
              ),
              el("span", { class: "muted", style: { fontSize: "12px" } }, p.description || p.id)
            )
          ),
          el("div", { class: "row", style: { gap: "6px", flexShrink: 0 } },
            el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("atlas", { tab: p.id }) }, "去画廊"),
            !p.customInstall
              ? el("button", {
                  type: "button", class: "btn btn-sm", disabled: Boolean(busyId),
                  onClick: async () => {
                    busyId = p.id; paint();
                    try {
                      data = await api("POST", "/api/galleries/market/install", { id: p.id, mirror: getMirror() });
                      toast(`已更新「${p.name}」`);
                    } catch (e) { toast(e.message || "更新失败"); }
                    finally { busyId = ""; if (stage.isConnected) paint(); }
                  },
                }, isBusy ? "更新中…" : "更新")
              : null,
            p.customInstall
              ? el("button", {
                  type: "button", class: "btn btn-sm",
                  onClick: () => openExtensionSubmitModal(ctx, {
                    channel: "gallery",
                    prefill: { name: p.name, slug: p.id, repoUrl: p.sourceUrl || p.homepage || "", description: p.description || "", authorName: p.author || "", version: p.version || "" },
                  }),
                }, "申请收录")
              : null,
            el("button", {
              type: "button", class: "btn btn-sm btn-danger", disabled: Boolean(busyId),
              onClick: async () => {
                if (!window.confirm(`卸载「${p.name}」并清理本地缓存（${formatBytes(p.cachedBytes)}）？`)) return;
                busyId = p.id; paint();
                try {
                  data = await api("POST", `/api/galleries/market/${encodeURIComponent(p.id)}/uninstall`, { purgeCache: true });
                  toast(`已卸载「${p.name}」`); refreshHub?.();
                } catch (e) { toast(e.message || "卸载失败"); }
                finally { busyId = ""; if (stage.isConnected) paint(); }
              },
            }, "卸载")
          )
        ));
      });
      gridHost.appendChild(listEl);
      return;
    }

    const list = packs.filter((p) => {
      if (activeCat && !(p.categories || []).includes(activeCat)) return false;
      if (!q) return true;
      return `${p.id} ${p.name} ${p.nameEn || ""} ${p.description || ""} ${p.author || ""}`.toLowerCase().includes(q);
    });

    if (!list.length) {
      gridHost.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "28px 16px" } }, "暂无匹配的图库插件。"));
      return;
    }

    const grid = el("div", { class: "pm-grid" });
    list.forEach((p) => {
      const isBusy = busyId === p.id;
      const actBtn = p.installed
        ? el("button", {
            type: "button", class: "pm-act done",
            onClick: () => ctx.go("atlas", { tab: p.id }),
          }, "去画廊")
        : el("button", {
            type: "button", class: "pm-act " + (isBusy ? "busy" : "get"), disabled: Boolean(busyId),
            onClick: async () => {
              busyId = p.id; paint();
              try {
                data = await api("POST", "/api/galleries/market/install", { id: p.id, mirror: getMirror() });
                toast(`已安装「${p.name}」`);
                refreshHub?.();
              } catch (e) { toast(e.message || "安装失败"); }
              finally { busyId = ""; if (stage.isConnected) paint(); }
            },
          }, isBusy ? "安装中" : "安装");

      const footerBtns = p.installed
        ? el("div", { class: "row", style: { gap: "6px" } },
            !p.customInstall
              ? el("button", {
                  type: "button", class: "btn btn-sm", disabled: Boolean(busyId),
                  onClick: async () => {
                    busyId = p.id; paint();
                    try {
                      data = await api("POST", "/api/galleries/market/install", { id: p.id, mirror: getMirror() });
                      toast(`已更新「${p.name}」`);
                    } catch (e) { toast(e.message || "更新失败"); }
                    finally { busyId = ""; if (stage.isConnected) paint(); }
                  },
                }, "更新")
              : null,
            el("button", {
              type: "button", class: "btn btn-sm btn-danger", disabled: Boolean(busyId),
              onClick: async () => {
                if (!window.confirm(`卸载「${p.name}」并清理本地缓存（${formatBytes(p.cachedBytes)}）？`)) return;
                busyId = p.id; paint();
                try {
                  data = await api("POST", `/api/galleries/market/${encodeURIComponent(p.id)}/uninstall`, { purgeCache: true });
                  toast(`已卸载「${p.name}」`); refreshHub?.();
                } catch (e) { toast(e.message || "卸载失败"); }
                finally { busyId = ""; if (stage.isConnected) paint(); }
              },
            }, "卸载")
          )
        : (p.homepage
            ? el("a", { href: p.homepage, class: "muted", style: { fontSize: "11.5px" }, onClick: (e) => { e.preventDefault(); openURL(p.homepage); } }, "主页 ↗")
            : null);

      grid.appendChild(el("article", { class: "pm-card" },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, p.multiVariant ? "🧍" : "🖼️"),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, p.name)),
            el("div", { class: "pm-card-by" },
              p.badge ? el("span", { class: "pm-verified-tag" }, p.badge) : null,
              el("span", { class: "pm-author-text" }, `${p.author || p.id}${p.license ? " · " + p.license : ""}`)
            )
          ),
          actBtn
        ),
        el("p", { class: "pm-card-desc", title: p.description || "" }, p.description || p.id),
        el("div", { class: "pm-card-meta", style: { justifyContent: "space-between" } },
          el("div", { class: "row", style: { gap: "5px", flexWrap: "wrap" } },
            p.version ? el("span", { class: "pm-ver mono" }, `v${p.version}`) : null,
            el("span", { class: "pm-chip soft" }, p.sourceType === "zip" ? "离线 ZIP" : "标准 JSON"),
            p.installed ? el("span", { class: "pm-chip" }, `${p.itemCount || 0} 条 · ${formatBytes(p.cachedBytes)}`) : null
          ),
          footerBtns
        )
      ));
    });
    gridHost.appendChild(grid);
  };

  load(false);
}

// =========================================================================
// 2. Skills Channel (Skills：页内独立管理 市场 / 已安装)
// =========================================================================

export function renderSkillsHubTab(stage, root, ctx, initialInstalledSkills, helpers) {
  const { getMirror, makeSkeletonGrid, refreshHub } = helpers;
  let subMode = "market"; // "market" | "installed"
  let marketData = null;
  let installedSkills = Array.isArray(initialInstalledSkills) ? initialInstalledSkills : [];
  let activeCat = "";
  let query = "";
  let busyId = "";

  const topHost = el("div", { class: "col", style: { gap: "10px" } });
  const bodyHost = el("div", { class: "col", style: { gap: "10px" } });

  const searchIn = el("input", {
    type: "search",
    class: "input pm-search-input",
    placeholder: "搜索 Skill…",
    "aria-label": "搜索 Skill",
  });
  searchIn.addEventListener("input", () => { query = searchIn.value; paint(); });

  stage.append(topHost, bodyHost);

  const loadMarket = async (refresh = false) => {
    marketData = null;
    paint();
    try {
      const m = getMirror();
      const [mkt, inst] = await Promise.all([
        api("GET", `/api/skills/market?mirror=${encodeURIComponent(m)}${refresh ? "&refresh=1" : ""}`),
        api("GET", "/api/skills").catch(() => ({ items: installedSkills })),
      ]);
      marketData = mkt;
      if (Array.isArray(inst?.items)) installedSkills = inst.items;
    } catch (e) {
      marketData = { sources: [], categories: [], skills: [], error: e.message };
    }
    if (stage.isConnected) paint();
  };

  const openAddSkillSourceModal = () => {
    const urlIn = el("input", { class: "input", type: "url", placeholder: "https://.../index.json（Format 1 Skill 市场）" });
    const nameIn = el("input", { class: "input", type: "text", placeholder: "市场名称（可选）" });
    showModal("添加 Skill 市场源", el("div", { class: "col", style: { gap: "8px" } }, urlIn, nameIn), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button", class: "btn btn-primary",
        onClick: async () => {
          if (!urlIn.value.trim()) return toast("请填写市场源地址");
          try {
            marketData = await api("POST", "/api/skills/market/sources", { url: urlIn.value.trim(), name: nameIn.value.trim() });
            closeModal(); toast("已订阅 Skill 市场源"); paint();
          } catch (e) { toast(e.message || "添加失败"); }
        },
      }, "添加"),
    ]);
  };

  const openManualInstallSkillModal = () => {
    const srcIn = el("input", { class: "input", placeholder: "本地文件夹、SKILL.md 文件路径或 GitHub/HTTP 链接…" });
    showModal("手动安装 Skill", el("div", { class: "col", style: { gap: "8px" } },
      el("div", { class: "row", style: { gap: "6px" } },
        srcIn,
        el("button", {
          type: "button", class: "btn btn-sm",
          onClick: async () => {
            try { const r = await api("POST", "/api/host/pick-directory", {}); if (r?.path) srcIn.value = r.path; }
            catch (e) { toast(e.message); }
          },
        }, "选择目录")
      )
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button", class: "btn btn-primary",
        onClick: async () => {
          if (!srcIn.value.trim()) return toast("请输入 Skill 路径或链接");
          try {
            const res = await api("POST", "/api/skills/install", { source: srcIn.value.trim() });
            closeModal(); toast(`已安装 Skill「${res.skill?.name || res.skill?.id}」`);
            await loadMarket(false); refreshHub?.();
          } catch (e) { toast(e.message); }
        },
      }, "安装"),
    ]);
  };

  const openSkillDetailModal = (sk) => {
    const editor = el("textarea", { class: "textarea mono", rows: "14", style: { fontSize: "12px", lineHeight: "1.55" } });
    editor.value = sk.content || "";
    showModal(`Skill 详情 · ${sk.name || sk.id}`, el("div", { class: "col", style: { gap: "10px" } },
      el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        el("span", { class: "badge badge-accent" }, `/${sk.id}`),
        el("span", { class: "badge" }, formatSkillSourceLabel(sk)),
        sk.version ? el("span", { class: "badge" }, `v${sk.version}`) : null
      ),
      editor
    ), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "关闭"),
      el("button", {
        type: "button", class: "btn btn-primary",
        onClick: async () => {
          try {
            await api("PATCH", `/api/skills/${encodeURIComponent(sk.id)}`, { content: editor.value });
            closeModal(); toast("已保存 Skill 内容"); await loadMarket(false);
          } catch (e) { toast(e.message); }
        },
      }, "保存修改"),
    ]);
  };

  const paint = () => {
    clear(topHost);
    clear(bodyHost);

    const subToggle = el("div", { class: "pm-seg-group", role: "tablist" },
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "market" ? " is-active" : ""), onClick: () => { subMode = "market"; paint(); } }, `市场 (${(marketData?.skills || []).length})`),
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "installed" ? " is-active" : ""), onClick: () => { subMode = "installed"; paint(); } }, `已安装 (${installedSkills.length})`)
    );

    const srcChips = marketData
      ? renderSourceChips(marketData.sources, busyId, async (s) => {
          busyId = "__rm__"; paint();
          try {
            marketData = await api("DELETE", `/api/skills/market/sources/${encodeURIComponent(s.id)}`);
            toast(`已移除 Skill 源「${s.name || s.id}」`);
          } catch (e) { toast(e.message || "移除失败"); }
          finally { busyId = ""; if (stage.isConnected) paint(); }
        })
      : el("div", { class: "row" });

    const catBar = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", alignItems: "center" } }, subToggle);
    if (subMode === "market" && marketData) {
      catBar.appendChild(el("button", { type: "button", class: "btn btn-sm" + (activeCat === "" ? " btn-primary" : ""), onClick: () => { activeCat = ""; paint(); } }, "全部分类"));
      (marketData.categories || []).forEach((c) => {
        catBar.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm" + (activeCat === c.id ? " btn-primary" : ""),
          onClick: () => { activeCat = c.id; paint(); },
        }, `${c.name} (${c.count})`));
      });
    }

    topHost.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
        srcChips,
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openExtensionSubmitModal(ctx, { channel: "skill" }) }, "＋ 申请收录"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => openHarnessSkillImportModal({ onImported: () => { loadMarket(false); refreshHub?.(); } }) }, "📥 本机导入"),
          el("button", { type: "button", class: "btn btn-sm", onClick: openAddSkillSourceModal }, "+ 添加源"),
          el("button", { type: "button", class: "btn btn-sm", onClick: openManualInstallSkillModal }, "＋ 手动安装"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => loadMarket(true) }, "↻ 刷新")
        )
      ),
      el("div", { class: "pm-filter-bar" }, catBar, searchIn)
    ));

    const q = query.trim().toLowerCase();

    if (subMode === "market") {
      if (!marketData) {
        bodyHost.appendChild(makeSkeletonGrid(6));
        return;
      }
      const list = (marketData.skills || []).filter((sk) => {
        if (activeCat && !(sk.categories || []).includes(activeCat)) return false;
        if (!q) return true;
        return `${sk.id} ${sk.name} ${sk.nameEn || ""} ${sk.description || ""} ${(sk.tags || []).join(" ")}`.toLowerCase().includes(q);
      });
      if (!list.length) {
        bodyHost.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "28px 16px" } }, "暂无匹配的 Skill。"));
        return;
      }
      const grid = el("div", { class: "pm-grid" });
      list.forEach((sk) => {
        const isBusy = busyId === sk.id;
        const instObj = installedSkills.find((x) => x.id === sk.id);
        const actBtn = sk.installed && !sk.hasUpdate
          ? el("button", {
              type: "button", class: "pm-act done",
              onClick: () => { if (instObj) openSkillDetailModal(instObj); else { subMode = "installed"; paint(); } },
            }, "已安装")
          : el("button", {
              type: "button", class: "pm-act " + (isBusy ? "busy" : (sk.hasUpdate ? "pm-up" : "get")),
              disabled: Boolean(busyId),
              onClick: async () => {
                busyId = sk.id; paint();
                try {
                  const res = await api("POST", "/api/skills/market/install", { id: sk.id, mirror: getMirror() });
                  marketData = res;
                  const refreshed = await api("GET", "/api/skills").catch(() => null);
                  if (Array.isArray(refreshed?.items)) installedSkills = refreshed.items;
                  toast(`已安装 Skill「${sk.name}」`);
                  refreshHub?.();
                } catch (e) { toast(e.message || "安装失败"); }
                finally { busyId = ""; if (stage.isConnected) paint(); }
              },
            }, isBusy ? "安装中" : (sk.hasUpdate ? "更新" : "安装"));

        grid.appendChild(el("article", { class: "pm-card" },
          el("div", { class: "pm-card-top" },
            el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "⚡"),
            el("div", { class: "pm-card-who" },
              el("div", { class: "pm-card-name" }, el("strong", null, sk.name)),
              el("div", { class: "pm-card-by" },
                el("span", { class: "mono" }, `/${sk.id}`),
                sk.badge ? el("span", { class: "pm-verified-tag" }, sk.badge) : null
              )
            ),
            actBtn
          ),
          el("p", { class: "pm-card-desc", title: sk.description || "" }, sk.description || sk.id),
          el("div", { class: "pm-card-meta" },
            sk.version ? el("span", { class: "pm-ver mono" }, `v${sk.version}`) : null,
            sk.license ? el("span", { class: "pm-chip soft" }, sk.license) : null,
            pricingBadge(sk.pricing),
            ...(sk.tags || []).slice(0, 2).map((t) => el("span", { class: "pm-chip" }, t))
          )
        ));
      });
      bodyHost.appendChild(grid);
      return;
    }

    // Installed Skills view
    const list = installedSkills.filter((sk) =>
      !q || `${sk.name} ${sk.id} ${sk.description || ""} ${sk.source || ""}`.toLowerCase().includes(q)
    );
    if (!list.length) {
      bodyHost.appendChild(el("div", { class: "card col", style: { alignItems: "center", gap: "10px", padding: "28px 16px" } },
        el("span", { class: "muted" }, "暂无已安装的 Skill"),
        el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => { subMode = "market"; paint(); } }, "浏览 Skill 市场")
      ));
      return;
    }
    const grid = el("div", { class: "pm-grid" });
    list.forEach((sk) => {
      const srcLabel = formatSkillSourceLabel(sk);
      const chkId = `hub-skill-en-${sk.id}`;
      const chk = el("input", { id: chkId, type: "checkbox", checked: sk.enabled !== false });
      chk.addEventListener("change", async () => {
        try {
          await api("PATCH", `/api/skills/${encodeURIComponent(sk.id)}`, { enabled: chk.checked });
          sk.enabled = chk.checked;
          toast(chk.checked ? `已启用「${sk.name}」` : `已停用「${sk.name}」`);
        } catch (e) { chk.checked = !chk.checked; toast(e.message); }
      });

      grid.appendChild(el("article", { class: "pm-card" },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "⚡"),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, sk.name || sk.id)),
            el("div", { class: "pm-card-by" }, el("span", { class: "mono" }, `/${sk.id}`), srcLabel ? el("span", { class: "pm-chip soft" }, srcLabel) : null)
          ),
          el("label", { for: chkId, class: "pm-toggle-inline" }, chk, "启用")
        ),
        el("p", { class: "pm-card-desc" }, sk.description || "暂无简介"),
        el("div", { class: "pm-card-meta", style: { justifyContent: "space-between" } },
          el("div", { class: "row", style: { gap: "6px" } },
            sk.version ? el("span", { class: "pm-ver mono" }, `v${sk.version}`) : null
          ),
          el("div", { class: "row", style: { gap: "6px" } },
            el("button", { type: "button", class: "btn btn-sm", onClick: () => openSkillDetailModal(sk) }, "查看"),
            !sk.builtin
              ? el("button", {
                  type: "button", class: "btn btn-sm",
                  onClick: () => openExtensionSubmitModal(ctx, {
                    channel: "skill",
                    prefill: {
                      name: sk.name || sk.id,
                      slug: sk.id,
                      repoUrl: /^https?:\/\//i.test(sk.source || "") ? sk.source : "",
                      description: sk.description || "",
                      version: sk.version || "",
                    },
                  }),
                }, "申请收录")
              : null,
            !sk.builtin
              ? el("button", {
                  type: "button", class: "btn btn-sm btn-danger",
                  onClick: async () => {
                    try {
                      await api("DELETE", `/api/skills/${encodeURIComponent(sk.id)}`);
                      toast(`已删除 Skill「${sk.name}」`);
                      await loadMarket(false); refreshHub?.();
                    } catch (e) { toast(e.message); }
                  },
                }, "删除")
              : null
          )
        )
      ));
    });
    bodyHost.appendChild(grid);
  };

  loadMarket(false);
}

// =========================================================================
// 3. Obsidian Writing Plugins Channel (写作插件：页内独立管理 市场 / 已安装)
// =========================================================================

export function renderObsidianMarketTab(stage, ctx, initialInstalledPlugins, helpers) {
  const { getMirror, makeSkeletonGrid, refreshHub } = helpers;
  let subMode = "market"; // "market" | "installed"
  let data = null;
  let installedPlugins = Array.isArray(initialInstalledPlugins) ? initialInstalledPlugins : [];
  let activeCat = "";
  let query = "";
  let includeCommunity = false;
  let busyId = "";

  const topHost = el("div", { class: "col", style: { gap: "10px" } });
  const gridHost = el("div", { class: "col", style: { gap: "10px" } });

  const searchIn = el("input", {
    type: "search",
    class: "input pm-search-input",
    placeholder: "搜索写作插件…",
    "aria-label": "搜索写作插件",
  });
  let searchTimer = null;
  searchIn.addEventListener("input", () => {
    query = searchIn.value;
    if (subMode === "market" && includeCommunity) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(false), 260);
    } else {
      paint();
    }
  });

  stage.append(topHost, gridHost);

  const load = async (refresh = false) => {
    data = null;
    paint();
    try {
      const qs = new URLSearchParams({ mirror: getMirror(), limit: "80" });
      if (refresh) qs.set("refresh", "1");
      if (includeCommunity) qs.set("community", "1");
      if (includeCommunity && query.trim()) qs.set("q", query.trim());
      const [mkt, inst] = await Promise.all([
        api("GET", `/api/article/obsidian/market?${qs.toString()}`),
        api("GET", "/api/article/obsidian/plugins").catch(() => ({ plugins: installedPlugins })),
      ]);
      data = mkt;
      if (Array.isArray(inst?.plugins)) installedPlugins = inst.plugins;
    } catch (e) {
      data = { sources: [], categories: [], items: [], warning: e.message };
    }
    if (stage.isConnected) paint();
  };

  const openAddObsSourceModal = () => {
    const urlIn = el("input", { class: "input", type: "url", placeholder: "https://.../index.json（Format 1 写作插件市场）" });
    const nameIn = el("input", { class: "input", type: "text", placeholder: "市场名称（可选）" });
    showModal("添加写作插件市场源", el("div", { class: "col", style: { gap: "8px" } }, urlIn, nameIn), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button", class: "btn btn-primary",
        onClick: async () => {
          if (!urlIn.value.trim()) return toast("请填写市场源 URL");
          try {
            data = await api("POST", "/api/article/obsidian/market/sources", { url: urlIn.value.trim(), name: nameIn.value.trim() });
            closeModal(); toast("已添加写作插件市场源"); paint();
          } catch (e) { toast(e.message || "添加失败"); }
        },
      }, "添加"),
    ]);
  };

  const openManualInstallObsModal = () => {
    const repoIn = el("input", { class: "input", placeholder: "GitHub 仓库（如 sunbooshi/note-to-mp）或本地插件目录" });
    showModal("手动安装写作插件", el("div", { class: "col", style: { gap: "8px" } }, repoIn), [
      el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
      el("button", {
        type: "button", class: "btn btn-primary",
        onClick: async () => {
          const v = repoIn.value.trim();
          if (!v) return toast("请输入仓库地址或本地路径");
          const isLocal = /^[a-zA-Z]:[\\/]|^\/|^~/.test(v);
          try {
            await api("POST", "/api/article/obsidian/install", isLocal ? { sourceType: "local", dir: v, enable: true } : { sourceType: "github", repo: v, enable: true });
            closeModal(); toast("已安装写作插件"); await load(false); refreshHub?.();
          } catch (e) { toast(e.message || "安装失败"); }
        },
      }, "安装并启用"),
    ]);
  };

  const paint = () => {
    clear(topHost);
    clear(gridHost);
    if (!data && subMode === "market") {
      gridHost.appendChild(makeSkeletonGrid(6));
      return;
    }

    const items = data?.items || [];
    const cats = data?.categories || [];
    const srcChips = data
      ? renderSourceChips(data.sources, busyId, async (s) => {
          busyId = "__rm__"; paint();
          try {
            data = await api("DELETE", `/api/article/obsidian/market/sources/${encodeURIComponent(s.id)}`);
            toast(`已移除市场源「${s.name || s.id}」`);
          } catch (e) { toast(e.message || "移除失败"); }
          finally { busyId = ""; if (stage.isConnected) paint(); }
        })
      : el("div", { class: "row" });

    const subToggle = el("div", { class: "pm-seg-group", role: "tablist" },
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "market" ? " is-active" : ""), onClick: () => { subMode = "market"; paint(); } }, `市场 (${items.length})`),
      el("button", { type: "button", class: "pm-seg-btn" + (subMode === "installed" ? " is-active" : ""), onClick: () => { subMode = "installed"; paint(); } }, `已安装 (${installedPlugins.length})`)
    );

    const commChk = el("input", { type: "checkbox", checked: includeCommunity });
    commChk.addEventListener("change", () => {
      includeCommunity = commChk.checked;
      load(false);
    });

    const catBar = el("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", alignItems: "center" } }, subToggle);
    if (subMode === "market") {
      catBar.appendChild(el("button", { type: "button", class: "btn btn-sm" + (activeCat === "" ? " btn-primary" : ""), onClick: () => { activeCat = ""; paint(); } }, "全部分类"));
      cats.forEach((c) => {
        catBar.appendChild(el("button", {
          type: "button",
          class: "btn btn-sm" + (activeCat === c.id ? " btn-primary" : ""),
          onClick: () => { activeCat = c.id; paint(); },
        }, `${c.name} (${c.count})`));
      });
    }

    topHost.appendChild(el("div", { class: "card col", style: { gap: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "8px", alignItems: "center" } },
        srcChips,
        el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => openExtensionSubmitModal(ctx, { channel: "obsidian" }) }, "＋ 申请收录"),
          el("button", { type: "button", class: "btn btn-sm", onClick: openAddObsSourceModal }, "+ 添加源"),
          el("button", { type: "button", class: "btn btn-sm", onClick: openManualInstallObsModal }, "＋ 手动安装"),
          el("button", { type: "button", class: "btn btn-sm", onClick: () => load(true) }, "↻ 刷新")
        )
      ),
      el("div", { class: "pm-filter-bar" },
        catBar,
        el("div", { class: "row", style: { gap: "10px", flexWrap: "wrap", alignItems: "center" } },
          subMode === "market"
            ? el("label", { class: "pm-toggle-inline" }, commChk, el("span", null, "包含全量 Obsidian 社区"))
            : null,
          searchIn
        )
      ),
      data?.warning ? el("span", { class: "muted", style: { fontSize: "11.5px" } }, `⚠️ ${data.warning}`) : null
    ));

    const q = query.trim().toLowerCase();

    if (subMode === "installed") {
      const list = installedPlugins.filter((op) =>
        !q || `${op.id} ${op.manifest?.name || ""} ${op.manifest?.description || ""} ${op.manifest?.author || ""}`.toLowerCase().includes(q)
      );
      if (!list.length) {
        gridHost.appendChild(el("div", { class: "card col", style: { alignItems: "center", gap: "10px", padding: "28px 16px" } },
          el("span", { class: "muted" }, "暂无已安装的写作插件"),
          el("button", { type: "button", class: "btn btn-sm btn-primary", onClick: () => { subMode = "market"; paint(); } }, "浏览写作插件市场")
        ));
        return;
      }
      const listEl = el("div", { class: "pm-installed-list" });
      list.forEach((op) => {
        const chkId = `obs-inst-en-${op.id}`;
        const chk = el("input", { id: chkId, type: "checkbox", checked: Boolean(op.enabled) });
        chk.addEventListener("change", async () => {
          try {
            await api("PATCH", `/api/article/obsidian/plugins/${encodeURIComponent(op.id)}`, { enabled: chk.checked });
            op.enabled = chk.checked;
            toast(chk.checked ? `已启用「${op.manifest?.name || op.id}」` : "已停用写作插件");
          } catch (e) { chk.checked = !chk.checked; toast(e.message); }
        });
        listEl.appendChild(el("div", { class: "pm-inst-row" + (!op.enabled ? " is-off" : "") },
          el("div", { class: "row", style: { gap: "11px", minWidth: 0, flex: "1", alignItems: "center" } },
            el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "📝"),
            el("div", { class: "col", style: { gap: "3px", minWidth: 0, flex: "1" } },
              el("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
                el("strong", { style: { fontSize: "13.5px" } }, op.manifest?.name || op.id),
                op.manifest?.version ? el("span", { class: "pm-ver mono" }, `v${op.manifest.version}`) : null
              ),
              el("span", { class: "muted", style: { fontSize: "12px" } }, op.manifest?.description || op.id)
            )
          ),
          el("div", { class: "row", style: { gap: "6px", flexShrink: 0 } },
            el("button", { type: "button", class: "btn btn-sm", onClick: () => ctx.go("article") }, "去文章"),
            el("button", {
              type: "button", class: "btn btn-sm",
              onClick: () => openExtensionSubmitModal(ctx, {
                channel: "obsidian",
                prefill: {
                  name: op.manifest?.name || op.id,
                  slug: op.id,
                  repoUrl: op.sourceRepo || "",
                  description: op.manifest?.description || "",
                  authorName: op.manifest?.author || "",
                  version: op.manifest?.version || "",
                },
              }),
            }, "申请收录"),
            el("label", { for: chkId, class: "row", style: { cursor: "pointer", fontSize: "12.5px" } }, chk, "启用"),
            el("button", {
              type: "button", class: "btn btn-sm btn-danger",
              onClick: async () => {
                if (!window.confirm(`卸载写作插件「${op.manifest?.name || op.id}」？`)) return;
                try {
                  await api("DELETE", `/api/article/obsidian/plugins/${encodeURIComponent(op.id)}`);
                  toast("已卸载写作插件"); await load(false); refreshHub?.();
                } catch (e) { toast(e.message); }
              },
            }, "卸载")
          )
        ));
      });
      gridHost.appendChild(listEl);
      return;
    }

    const list = items.filter((it) => {
      if (activeCat && !(it.categories || []).includes(activeCat)) return false;
      if (!q || includeCommunity) return true;
      return `${it.id} ${it.name} ${it.author || ""} ${it.description || ""} ${it.repo || ""} ${it.featuredTag || ""}`.toLowerCase().includes(q);
    });

    if (!list.length) {
      gridHost.appendChild(el("div", { class: "card muted", style: { textAlign: "center", padding: "28px 16px" } }, "暂无匹配的写作插件。"));
      return;
    }

    const grid = el("div", { class: "pm-grid" });
    list.forEach((it) => {
      const isBusy = busyId === it.id;
      const actBtn = it.installed
        ? el("button", { type: "button", class: "pm-act done", onClick: () => ctx.go("article") }, "去文章")
        : el("button", {
            type: "button", class: "pm-act " + (isBusy ? "busy" : "get"), disabled: Boolean(busyId),
            onClick: async () => {
              busyId = it.id; paint();
              try {
                await api("POST", "/api/article/obsidian/install", {
                  sourceType: "market",
                  id: it.id,
                  repo: it.repo,
                  downloadMirrors: it.downloadMirrors || undefined,
                  files: it.files || undefined,
                  mirror: getMirror(),
                  enable: true,
                });
                toast(`已安装并启用「${it.name}」`);
                await load(false); refreshHub?.();
              } catch (e) { toast(e.message || "安装失败"); }
              finally { busyId = ""; if (stage.isConnected) paint(); }
            },
          }, isBusy ? "安装中" : "安装");

      const compatEl = it.compatLevel === "partial"
        ? el("span", { class: "pm-chip warn" }, "🟡 部分兼容")
        : (it.compatLevel === "unsupported"
          ? el("span", { class: "pm-chip" }, "🔴 暂不兼容")
          : el("span", { class: "pm-chip soft" }, "🟢 实测兼容"));

      grid.appendChild(el("article", { class: "pm-card" },
        el("div", { class: "pm-card-top" },
          el("div", { class: "pm-logo", style: { fontSize: "18px" } }, "📝"),
          el("div", { class: "pm-card-who" },
            el("div", { class: "pm-card-name" }, el("strong", null, it.name || it.id)),
            el("div", { class: "pm-card-by" },
              it.featuredTag ? el("span", { class: "pm-verified-tag" }, it.featuredTag) : null,
              el("span", { class: "pm-author-text" }, `${it.author || ""}${it.downloads ? " · " + formatDownloads(it.downloads) : ""}`)
            )
          ),
          actBtn
        ),
        el("p", { class: "pm-card-desc", title: it.description || "" }, it.description || it.repo),
        el("div", { class: "pm-card-meta", style: { justifyContent: "space-between" } },
          el("div", { class: "row", style: { gap: "5px", flexWrap: "wrap" } },
            it.version && it.version !== "latest" ? el("span", { class: "pm-ver mono" }, `v${it.version}`) : null,
            compatEl,
            it.mirroredFast ? el("span", { class: "pm-chip up" }, "⚡ 国内加速") : null,
            pricingBadge(it.pricing)
          ),
          it.installed
            ? el("button", {
                type: "button", class: "btn btn-sm btn-danger", disabled: Boolean(busyId),
                onClick: async () => {
                  if (!window.confirm(`卸载写作插件「${it.name}」？`)) return;
                  busyId = it.id; paint();
                  try {
                    await api("DELETE", `/api/article/obsidian/plugins/${encodeURIComponent(it.id)}`);
                    toast(`已卸载「${it.name}」`); await load(false); refreshHub?.();
                  } catch (e) { toast(e.message || "卸载失败"); }
                  finally { busyId = ""; if (stage.isConnected) paint(); }
                },
              }, "卸载")
            : (it.repo
                ? el("a", { href: `https://github.com/${it.repo}`, class: "muted", style: { fontSize: "11.5px" }, onClick: (e) => { e.preventDefault(); openURL(`https://github.com/${it.repo}`); } }, "仓库 ↗")
                : null)
        )
      ));
    });
    gridHost.appendChild(grid);
  };

  load(false);
}
