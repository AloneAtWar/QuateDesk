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

// 累计使用时长：毫秒 → 「3 天 1 小时」式的紧凑中文时长，不足一分钟显示「<1 分钟」
export const formatProviderUsageDuration = (ms) => {
  if (!hasFiniteNumber(ms)) return '—';
  const totalMinutes = Math.floor(Number(ms) / 60000);
  if (totalMinutes < 1) return '<1 分钟';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  return `${minutes} 分钟`;
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
