import { closeModal, el, openURL, showModal } from "./api.js";

/**
 * Formats micro-yuan (1 CNY = 1,000,000 micros) consistently with handraw-web.
 */
export function formatYuanMicros(micros, minDecimals = 2, maxDecimals = 4) {
  const n = Number(micros || 0);
  if (!Number.isFinite(n)) return "¥0.00";
  const neg = n < 0 ? "-" : "";
  const fixed = (Math.abs(n) / 1000000).toFixed(maxDecimals).replace(/0+$/, "");
  const [w, f = ""] = fixed.split(".");
  return `${neg}¥${w}.${f.padEnd(minDecimals, "0")}`;
}

/**
 * Normalizes /api/account/balance payloads into a uniform view model,
 * supporting both handraw-web's /api/economy schema and legacy flat fields.
 * Cash recharge balance and bonus credit are combined into one unified balance (#158).
 */
export function parseEconomy(balRes) {
  const rawEco = balRes?.economy && typeof balRes.economy === "object" ? balRes.economy : null;
  const hasData = Boolean(rawEco && Object.keys(rawEco).length > 0);
  const cashObj = rawEco?.cash && typeof rawEco.cash === "object" ? rawEco.cash : {};

  const rawBal = cashObj.balanceCents ?? rawEco?.balanceCents ?? rawEco?.walletBalanceCents ?? rawEco?.balance ?? null;
  const cashBalanceCents = rawBal !== null && rawBal !== undefined && rawBal !== "" && Number.isFinite(Number(rawBal))
    ? Number(rawBal)
    : null;
  const rawCashTotalMicros = cashObj.totalMicros !== null && cashObj.totalMicros !== undefined && cashObj.totalMicros !== "" && Number.isFinite(Number(cashObj.totalMicros))
    ? Number(cashObj.totalMicros)
    : (cashBalanceCents !== null ? cashBalanceCents * 10000 : null);
  const cashHeldCentsMicros = (Number(cashObj.heldCents ?? rawEco?.heldCents ?? 0) || 0) * 10000;
  const cashHeldAiMicros = Number(cashObj.heldAiMicros ?? 0) || 0;

  const aiBonusObj = rawEco?.aiBonus && typeof rawEco.aiBonus === "object" ? rawEco.aiBonus : null;
  const bonusHeldMicros = Number(aiBonusObj?.heldMicros ?? 0) || 0;
  const bonusAvailMicros = aiBonusObj?.availableMicros !== null && aiBonusObj?.availableMicros !== undefined && aiBonusObj?.availableMicros !== ""
    ? (Number(aiBonusObj.availableMicros) || 0)
    : Math.max(0, (Number(aiBonusObj?.balanceMicros ?? 0) || 0) - bonusHeldMicros);
  const bonusTotalMicros = aiBonusObj?.balanceMicros !== null && aiBonusObj?.balanceMicros !== undefined && aiBonusObj?.balanceMicros !== ""
    ? (Number(aiBonusObj.balanceMicros) || 0)
    : (bonusAvailMicros + bonusHeldMicros);

  const hasBalance = rawCashTotalMicros !== null || aiBonusObj !== null;
  const balanceMicros = hasBalance ? (rawCashTotalMicros ?? 0) + bonusTotalMicros : null;
  const heldMicros = hasBalance ? cashHeldCentsMicros + cashHeldAiMicros + bonusHeldMicros : 0;
  const availableMicros = hasBalance ? Math.max(0, (rawCashTotalMicros ?? 0) - cashHeldAiMicros) + bonusAvailMicros : null;
  const balanceCents = balanceMicros !== null ? Math.round(balanceMicros / 10000) : null;
  const heldCents = Math.round(heldMicros / 10000);

  const rawPts = rawEco?.points ?? rawEco?.credits ?? rawEco?.communityPoints ?? null;
  const points = rawPts !== null && rawPts !== undefined && rawPts !== "" && Number.isFinite(Number(rawPts))
    ? Math.trunc(Number(rawPts))
    : null;
  const pendingPoints = Number(rawEco?.earnings?.pending ?? 0) || 0;
  const settledPoints = Number(rawEco?.earnings?.settled ?? 0) || 0;

  const quotaTiers = [];
  if (Array.isArray(rawEco?.freeQuota)) {
    for (const q of rawEco.freeQuota) {
      if (!q || !q.resolution) continue;
      quotaTiers.push({
        resolution: String(q.resolution).toUpperCase(),
        remaining: Number(q.remaining ?? 0) || 0,
        total: Number(q.total ?? 0) || 0,
        held: Number(q.held ?? 0) || 0,
        policyUnits: Number(q.policyUnits ?? q.total ?? 0) || 0,
        claimableUnits: Number(q.claimableUnits ?? 0) || 0,
        eligibility: q.eligibility || "",
      });
    }
  } else {
    const legacyFree = rawEco?.freeRemaining ?? rawEco?.dailyFreeRemaining ?? rawEco?.freeQuotaRemaining;
    if (legacyFree !== undefined && legacyFree !== null && Number.isFinite(Number(legacyFree))) {
      const n = Number(legacyFree);
      quotaTiers.push({ resolution: "1K", remaining: n, total: n, held: 0, policyUnits: n, claimableUnits: 0, eligibility: "" });
    }
  }

  const tier1k = quotaTiers.find((q) => q.resolution === "1K") || quotaTiers[0] || null;
  const totalFreeRemaining = quotaTiers.reduce((sum, q) => sum + q.remaining, 0);
  const specs = Array.isArray(rawEco?.specs) ? rawEco.specs : [];

  return {
    loggedIn: Boolean(balRes?.loggedIn),
    hasData,
    offline: Boolean(balRes?.offline),
    unavailable: Boolean(balRes?.unavailable),
    scopeDenied: Boolean(balRes?.scopeDenied || balRes?.code === "token_scope_denied"),
    error: balRes?.error || "",
    balanceMicros,
    availableMicros,
    heldMicros,
    balanceCents,
    cashBalanceCents,
    heldCents,
    points,
    pendingPoints,
    settledPoints,
    quotaTiers,
    tier1k,
    totalFreeRemaining,
    specs,
  };
}

function matchEconomySpec(specs, modelRef, resolution, quality) {
  const allowed = (Array.isArray(specs) ? specs : []).filter((s) => s && s.enabled !== false && s.verified !== false);
  if (!allowed.length) return null;
  const rawModel = String(modelRef || "").startsWith("site:")
    ? String(modelRef).slice(5).trim().toLowerCase()
    : String(modelRef || "").trim().toLowerCase();
  const wantRes = String(resolution || "1k").trim().toLowerCase();
  const wantQual = String(quality || "").trim().toLowerCase();
  if (!rawModel) return null;

  const byId = allowed.find((s) => String(s.id || "").trim().toLowerCase() === rawModel);
  if (byId) return byId;

  const sameModel = allowed.filter((s) => String(s.model || "").trim().toLowerCase() === rawModel);
  if (!sameModel.length) return null;
  if (wantRes && wantQual) {
    const exact = sameModel.find(
      (s) => String(s.resolution || "").trim().toLowerCase() === wantRes
        && String(s.quality || "").trim().toLowerCase() === wantQual
    );
    if (exact) return exact;
  }
  if (wantRes) {
    const byRes = sameModel.find((s) => String(s.resolution || "").trim().toLowerCase() === wantRes);
    if (byRes) return byRes;
  }
  return sameModel[0] || null;
}

/**
 * Computes the per-resolution inline hint shown after the 1K/2K/4K pills,
 * aligned with handraw-web (#592):
 *  - Shows "免费剩 N 张" when the active resolution has available free quota.
 *  - Shows "验证邮箱领免费额度，去验证" when unpaid-only spec requires email verification.
 *  - Shows "余额不足，去充值" when no free quota remains and cash balance is below the spec price.
 *  - Returns null when balance is sufficient, user is logged out, or using a third-party provider.
 */
export function computeResolutionHint({
  loggedIn = false,
  modelRef = "",
  resolution = "1k",
  quality = "",
  economy = null,
  siteBase = "https://handraw-style.com",
} = {}) {
  if (!loggedIn || !String(modelRef || "").startsWith("site:")) return null;
  if (!economy || !economy.hasData) return null;

  const spec = matchEconomySpec(economy.specs, modelRef, resolution, quality);
  const resKey = String(spec?.resolution || resolution || "1k").trim().toLowerCase();
  const row = (Array.isArray(economy.quotaTiers) ? economy.quotaTiers : []).find(
    (q) => String(q?.resolution || "").trim().toLowerCase() === resKey
  );
  const remaining = Number(row?.remaining || 0);
  const claimableUnits = Number(row?.claimableUnits || 0);
  const policyUnits = Number(row?.policyUnits ?? row?.total ?? 0);
  const eligibility = String(row?.eligibility || "");
  const freeAvail = remaining + (eligibility === "claim_required" ? claimableUnits : 0);

  if (freeAvail > 0) {
    return {
      kind: "free",
      text: `免费剩 ${freeAvail} 张`,
    };
  }

  const walletUrl = `${String(siteBase || "https://handraw-style.com").replace(/\/+$/, "")}/?view=wallet`;
  if (!spec || spec.priceCents === null || spec.priceCents === undefined) {
    if (eligibility === "verification_required" && policyUnits > 0) {
      return {
        kind: "verify",
        text: "验证邮箱领免费额度，",
        actionText: "去验证",
        actionTitle: "前往钱包验证邮箱（不丢当前内容）",
        actionUrl: walletUrl,
      };
    }
    return null;
  }

  const bal = economy.cashBalanceCents;
  if (!economy.unavailable && typeof bal === "number" && Number.isFinite(bal) && bal < Number(spec.priceCents || 0)) {
    return {
      kind: "insufficient",
      text: "余额不足，",
      actionText: "去充值",
      actionTitle: "前往钱包充值（不丢当前内容）",
      actionUrl: walletUrl,
    };
  }

  return null;
}

export function formatEconomyPillText(eco) {
  if (!eco?.loggedIn) return "";
  if (!eco.hasData) {
    return eco.scopeDenied ? "资产待授权" : "资产未同步";
  }
  const parts = [];
  if (eco.balanceMicros !== null && eco.balanceMicros !== undefined) {
    parts.push(formatYuanMicros(eco.balanceMicros, 2, 2));
  } else if (eco.balanceCents !== null && eco.balanceCents !== undefined) {
    parts.push(formatYuanMicros(Number(eco.balanceCents) * 10000, 2, 2));
  }
  if (eco.points !== null) parts.push(`${eco.points} 积分`);
  if (eco.tier1k) parts.push(`${eco.tier1k.resolution}剩${eco.tier1k.remaining}`);
  if (!parts.length) return "查看资产";
  if (eco.offline) parts.push("离线");
  return parts.join(" · ");
}

export function formatQuotaSummary(eco) {
  if (!eco?.quotaTiers?.length) return "暂无记录";
  return eco.quotaTiers
    .map((q) => `${q.resolution} 剩 ${q.remaining}${q.held > 0 ? `（冻结 ${q.held}）` : ""}`)
    .join(" · ");
}

export function economySyncHint(eco) {
  if (!eco?.loggedIn) return "";
  if (eco.scopeDenied) {
    return "当前登录令牌暂未获得余额与社区积分接口权限（需网站开放 studio 权限后重新登录授权，或先在账号控制台查看）。";
  }
  if (eco.error && !eco.hasData) {
    return `余额与社区积分同步失败：${eco.error}`;
  }
  if (eco.offline && eco.error) {
    return `当前展示离线缓存数据（${eco.error}）`;
  }
  if (!eco.hasData) {
    return "暂未获取到余额与积分数据，请点击「刷新额度」重试。";
  }
  return "";
}

/**
 * Shows a clear, actionable dialog when site generation fails with insufficient
 * cash balance — highlighting when 2K/4K was chosen and offering a one-click
 * switch back to 1K free quota (#190).
 */
export function maybeHandleInsufficientCashError(err, { resolution = "", onSwitchTo1k = null } = {}) {
  const code = String(err?.code || "").toLowerCase();
  const msg = String(err?.message || "");
  if (code !== "insufficient_cash" && !msg.includes("生图现金余额不足") && !msg.includes("通用人民币余额不足")) {
    return false;
  }
  const data = err?.data && typeof err.data === "object" ? err.data : {};
  const effRes = String(data.resolution || resolution || "").toLowerCase();
  const resUpper = effRes ? effRes.toUpperCase() : "";
  const free1k = Number(data.free1kRemaining || 0);
  const free1kKnown = Boolean(data.free1kKnown);
  const canSwitch1k = Boolean(typeof onSwitchTo1k === "function" && effRes && effRes !== "1k");
  const siteBase = String(data.siteBase || "https://handraw-style.com").replace(/\/+$/, "");

  const title = effRes && effRes !== "1k"
    ? `现金余额不足（当前选择了 ${resUpper}）`
    : "生图现金余额不足";

  const body = el("div", { class: "col", style: { gap: "10px" } },
    el("p", { style: { margin: 0, lineHeight: "1.6" } }, msg || "生图现金余额不足，请先充值后再试。"),
    canSwitch1k
      ? el("div", { class: "card", style: { padding: "10px 12px", background: "var(--paper)", fontSize: "12.5px", lineHeight: "1.55" } },
          free1kKnown && free1k > 0
            ? `💡 你的账号还有 ${free1k} 张 1K 免费生图额度，点击下方「切回 1K 免费生成」即可立即免费出图。`
            : "💡 1K 清晰度支持使用 1K 免费生图额度，点击下方「切回 1K 生成」即可改用 1K 清晰度。"
        )
      : null
  );

  const actions = [
    el("button", { type: "button", class: "btn", onClick: closeModal }, "取消"),
    el("button", {
      type: "button",
      class: canSwitch1k ? "btn" : "btn btn-primary",
      onClick: () => {
        closeModal();
        openURL(`${siteBase}/?view=wallet`);
      },
    }, "前往充值 ↗"),
  ];
  if (canSwitch1k) {
    actions.push(el("button", {
      type: "button",
      class: "btn btn-primary",
      onClick: () => {
        closeModal();
        onSwitchTo1k();
      },
    }, free1kKnown && free1k > 0 ? "切回 1K 免费生成" : "切回 1K 生成"));
  }
  showModal(title, body, actions);
  return true;
}
