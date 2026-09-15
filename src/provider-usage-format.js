const hasFiniteNumber = (value) => value !== null
  && value !== undefined
  && Number.isFinite(Number(value));

const compactUnitGap = (value) => String(value).replace(/(万亿|亿|万)$/u, ' $1');

export const formatProviderUsageCost = (value, currency = 'CNY') => {
  if (!hasFiniteNumber(value)) return '—';
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency', currency: currency || 'CNY', currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2, maximumFractionDigits: Math.abs(Number(value)) < 1 ? 4 : 2,
    }).format(Number(value));
  } catch { return `${currency || 'CNY'} ${Number(value).toFixed(2)}`; }
};

// Only the compact summary uses Chinese large-number units. Daily details and the
// accessible full value continue to use the exact currency formatter above.
export const formatProviderUsageSummaryCost = (value, currency = 'CNY') => {
  if (!hasFiniteNumber(value)) return '—';
  if (Math.abs(Number(value)) < 10_000) return formatProviderUsageCost(value, currency);
  try {
    return compactUnitGap(new Intl.NumberFormat('zh-CN', {
      style: 'currency', currency: currency || 'CNY', currencyDisplay: 'narrowSymbol',
      notation: 'compact', maximumSignificantDigits: 3,
    }).format(Number(value)));
  } catch {
    const compactNumber = new Intl.NumberFormat('zh-CN', {
      notation: 'compact', maximumSignificantDigits: 3,
    }).format(Number(value));
    return `${currency || 'CNY'} ${compactUnitGap(compactNumber)}`;
  }
};

// 连续天数兜底：厂商接口不提供时从逐日数据本地计算。
// 活跃 = 当天 Token 或花费 > 0；当前连续从最后一天往前数，当天还没用量时从昨天起算。
export const computeUsageStreaks = (days) => {
  if (!Array.isArray(days) || days.length === 0) return { current: null, longest: null };
  const active = days.map((day) => (Number(day?.tokens) || 0) > 0 || (Number(day?.cost) || 0) > 0);
  let cursor = active.length - 1;
  if (!active[cursor]) cursor -= 1;
  let current = 0;
  while (cursor >= 0 && active[cursor]) { current += 1; cursor -= 1; }
  let longest = 0;
  let run = 0;
  for (const flag of active) {
    run = flag ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return { current, longest };
};

// 汇总卡片的 Token 数用中文大数单位（万/亿），最多保留两位小数；当日明细仍用完整数字
export const formatProviderUsageSummaryTokens = (value) => {
  if (!hasFiniteNumber(value)) return '—';
  try {
    return compactUnitGap(new Intl.NumberFormat('zh-CN', {
      notation: 'compact', maximumFractionDigits: 2,
    }).format(Number(value)));
  } catch {
    return String(Number(value));
  }
};
