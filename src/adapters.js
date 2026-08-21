import { adapterRegistry } from './data';

const numeric = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const percentage = (remaining, total) => total > 0 ? Number(((remaining / total) * 100).toFixed(2)) : 0;
const windowResult = (key, remaining, total, unit = '%', resetAt = null, extra = {}) => ({
  key,
  remaining: numeric(remaining),
  used: Math.max(0, numeric(total) - numeric(remaining)),
  total: numeric(total),
  unit,
  resetAt,
  available: extra.available ?? true,
  ...extra,
});

export const adapterDefinitions = {
  kimi: {
    ...adapterRegistry.kimi,
    normalize(payload) {
      const windows = (payload?.limits || []).map((item) => {
        const detail = item.detail || item;
        return windowResult('five_hour', numeric(detail.remaining), numeric(detail.limit), '%', detail.resetTime);
      });
      const weekly = payload?.usage;
      if (weekly) windows.push(windowResult('weekly', numeric(weekly.remaining), numeric(weekly.limit), '%', weekly.resetTime));
      return windows;
    },
  },
  zai: {
    ...adapterRegistry.zai,
    normalize(payload) {
      const source = payload?.data || payload?.quota || payload || {};
      const candidates = [source.five_hour, source.fiveHour, source.weekly, source.seven_day, source.sevenDay].filter(Boolean);
      return candidates.map((item, index) => {
        const total = numeric(item.limit ?? item.total);
        const remaining = numeric(item.remaining ?? (total - numeric(item.used)));
        return windowResult(index === 0 ? 'five_hour' : 'weekly', remaining, total, '%', item.resetTime ?? item.resetAt);
      });
    },
  },
  deepseek: {
    ...adapterRegistry.deepseek,
    normalize(payload) {
      const rows = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
      return rows.map((item) => windowResult('balance', 100, 100, item.currency || 'CNY', null, {
        amount: numeric(item.total_balance),
        limitAmount: numeric(item.total_balance),
        available: payload?.is_available !== false,
        error: payload?.is_available === false ? '余额不可用' : undefined,
      }));
    },
  },
  wlb: {
    ...adapterRegistry.wlb,
    normalize(payload) {
      const quota = payload?.rate_limits?.find((item) => item.window === '7d') || {};
      const total = numeric(quota.limit);
      const used = numeric(quota.used);
      const remaining = numeric(quota.remaining, Math.max(0, total - used));
      return [windowResult('weekly', percentage(remaining, total), 100, '%', quota.resetAt, { available: payload?.isValid ?? payload?.status === 'active' })];
    },
  },
  mimo: {
    ...adapterRegistry.mimo,
    normalize(payload) {
      const item = payload?.data?.monthUsage?.items?.find((row) => row.name === 'month_total_token');
      if (!item) return [];
      const total = numeric(item.limit);
      const used = numeric(item.used);
      return [windowResult('monthly', percentage(Math.max(0, total - used), total), 100, '%', item.resetTime, {
        amount: Math.max(0, total - used),
        limitAmount: total,
      })];
    },
  },
};

export const normalizeUsage = (adapterId, payload) => adapterDefinitions[adapterId]?.normalize(payload) || [];

export const buildRequest = (adapterId, baseUrl, credential) => {
  const definition = adapterDefinitions[adapterId];
  if (!definition) throw new Error(`Unknown adapter: ${adapterId}`);
  const headers = { Accept: 'application/json' };
  if (definition.auth === 'bearer') headers.Authorization = `Bearer ${credential}`;
  if (definition.auth === 'token') headers.Authorization = credential;
  if (definition.auth === 'cookie') headers.Cookie = credential;
  return { url: definition.endpoint.startsWith('/') ? `${baseUrl.replace(/\/$/, '')}${definition.endpoint}` : definition.endpoint, headers, timeoutMs: 15_000 };
};
