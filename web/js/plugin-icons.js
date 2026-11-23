// 125 built-in hand-drawn transparent WebP icons across 5 thematic categories
// (25 icons per category) for plugins without a custom icon.
const ICON_TOTAL = 125;

const CATEGORY_RANGES = {
  art: [1, 25],       // 绘画与手绘创作
  media: [26, 50],    // 影音、自媒体与内容
  tech: [51, 75],     // AI、接口、工具与开发
  lifestyle: [76, 100], // 自然、萌宠与书桌日常
  fashion: [101, 125],  // 人像、服饰、发型与生活好物
};

function hashString(str) {
  let h = 2166136261;
  const s = String(str || "plugin");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function detectCategory(plugin) {
  const cats = (plugin?.categories || []).map((c) => String(c).toLowerCase());
  const text = [
    plugin?.id,
    plugin?.name,
    plugin?.title,
    plugin?.dsh?.packageName,
    plugin?.description,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/(pose|portrait|hair|cloth|fashion|outfit|dress|人像|姿势|发型|服装|穿搭|写真)/.test(text)) {
    return "fashion";
  }
  if (cats.includes("media") || /(media|video|audio|script|article|social|desk|自媒体|口播|视频|封面|文章|脚本)/.test(text)) {
    return "media";
  }
  if (cats.includes("provider") || /(api|pool|chatgpt|openai|llm|mcp|agent|model|bot|workbench|号池|接口|模型|工具)/.test(text)) {
    return "tech";
  }
  if (cats.includes("creation") || cats.includes("gallery") || /(draw|paint|handraw|style|sketch|canvas|gallery|画风|手绘|画廊|创作|图型)/.test(text)) {
    return "art";
  }
  if (/(cat|dog|pet|tea|coffee|plant|flower|nature|cozy|生活|萌宠|日常)/.test(text)) {
    return "lifestyle";
  }
  return "";
}

/**
 * Returns a deterministic transparent hand-drawn icon URL from the 125-icon
 * built-in pool for any plugin that does not supply its own icon.
 */
export function fallbackPluginIcon(plugin) {
  const seed = plugin?.id || plugin?.dsh?.packageName || plugin?.name || plugin?.title || "plugin";
  const h = hashString(seed);
  const cat = detectCategory(plugin);
  let num;
  if (cat && CATEGORY_RANGES[cat]) {
    const [lo, hi] = CATEGORY_RANGES[cat];
    num = lo + (h % (hi - lo + 1));
  } else {
    num = 1 + (h % ICON_TOTAL);
  }
  return `/img/plugin-icons/${String(num).padStart(3, "0")}.webp`;
}
