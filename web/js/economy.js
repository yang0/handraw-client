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
  const rawCashTotalMicros = cashObj.totalMicros !== null && cashObj.totalMicros !== undefined && cashObj.totalMicros !== "" && Number.isFinite(Number(cashObj.totalMicros))
    ? Number(cashObj.totalMicros)
    : (rawBal !== null && rawBal !== undefined && rawBal !== "" && Number.isFinite(Number(rawBal))
      ? Number(rawBal) * 10000
      : null);
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
        claimableUnits: Number(q.claimableUnits ?? 0) || 0,
        eligibility: q.eligibility || "",
      });
    }
  } else {
    const legacyFree = rawEco?.freeRemaining ?? rawEco?.dailyFreeRemaining ?? rawEco?.freeQuotaRemaining;
    if (legacyFree !== undefined && legacyFree !== null && Number.isFinite(Number(legacyFree))) {
      const n = Number(legacyFree);
      quotaTiers.push({ resolution: "1K", remaining: n, total: n, held: 0, claimableUnits: 0, eligibility: "" });
    }
  }

  const tier1k = quotaTiers.find((q) => q.resolution === "1K") || quotaTiers[0] || null;
  const totalFreeRemaining = quotaTiers.reduce((sum, q) => sum + q.remaining, 0);

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
    heldCents,
    points,
    pendingPoints,
    settledPoints,
    quotaTiers,
    tier1k,
    totalFreeRemaining,
  };
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
