import { windowCatalog } from './data.js';

export const WASTE_RANGES = [
  { months: 1, label: '最近 1 个月' },
  { months: 3, label: '最近 3 个月' },
  { months: 6, label: '最近半年' },
  { months: 12, label: '最近一年' },
];

// 参与浪费统计的周期型窗口键：周 / 月 + Antigravity 的 7 天池（含单模型特例池的
// 动态 key agy_pool_*_7d）。池的 7d 额度本质是周期额度；与主进程 electron/waste.cjs
// 的 isCycleWindowKey 保持一致
export const AGY_POOL_7D_RE = /^agy_.+_7d$/;
export const isCycleWindowKey = (key) => key === 'weekly' || key === 'monthly' || AGY_POOL_7D_RE.test(key);

// 统计口径匹配：weekly 过滤档把所有 7 天池周期一并计入（它们本质是周额度），
// monthly 精确匹配
export const matchesWasteWindowKey = (cycleWindow, filterKey) => (filterKey === 'weekly'
  ? cycleWindow === 'weekly' || AGY_POOL_7D_RE.test(cycleWindow)
  : cycleWindow === filterKey);

// 周期窗口名：目录条目优先；Antigravity 的动态特例池从 key 还原（agy_pool_gemini-4-argon_7d
// → Gemini 4 Argon 7d）
const prettifyAgyPoolName = (key) => key.replace(/^agy_pool_/, '').replace(/_7d$/, '')
  .split('-').map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part)).join(' ');
export const wasteWindowLabel = (key) => windowCatalog[key]?.label
  ?? (AGY_POOL_7D_RE.test(key) ? `${prettifyAgyPoolName(key)} 7d` : key);

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

// Anchor every month to the same date, clamping month ends without accumulating drift.
const monthsBefore = (date, months) => {
  const target = new Date(date.getFullYear(), date.getMonth() - months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
};

export const formatWasteDate = (value, withYear = false) => {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const day = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  return withYear ? `${date.getFullYear()}/${day}` : day;
};

export const formatWasteAmount = (value) => value == null ? '—' : Number(value.toFixed(2)).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
export const formatWastePercent = (value) => value == null ? '—' : `${Number(value.toFixed(1))}%`;

/** Calendar buckets in local time, with exclusive boundaries and no omitted days. */
export function createWasteRange(months = 1, now = new Date()) {
  if (!WASTE_RANGES.some((range) => range.months === months)) throw new RangeError('Unsupported waste range');
  const end = new Date(now);
  if (!Number.isFinite(end.getTime())) throw new RangeError('Invalid range date');
  const start = monthsBefore(end, months);
  const endExclusive = end.getTime() + 1;
  const boundaries = [start.getTime()];
  if (months === 1) {
    // Enumerate calendar days instead of dividing milliseconds: DST days are not all 24h.
    const days = [];
    for (let day = start; day <= startOfDay(end); day = addDays(day, 1)) days.push(day);
    const base = Math.floor(days.length / 4);
    const extra = days.length % 4;
    let offset = 0;
    for (let index = 0; index < 3; index += 1) {
      offset += base + (index < extra ? 1 : 0);
      boundaries.push(days[offset].getTime());
    }
  } else {
    for (let index = 1; index < months; index += 1) boundaries.push(monthsBefore(end, months - index).getTime());
  }
  boundaries.push(endExclusive);
  const buckets = boundaries.slice(0, -1).map((from, index) => {
    const to = boundaries[index + 1];
    return {
      id: `${months}:${from}`,
      start: from,
      endExclusive: to,
      label: months === 1 ? `第 ${index + 1} 段` : `${new Date(from).getMonth() + 1} 月`,
      dateLabel: `${formatWasteDate(from)}–${formatWasteDate(to - 1)}`,
    };
  });
  return {
    months, start: start.getTime(), end: end.getTime(), endExclusive, buckets,
    dateLabel: `${formatWasteDate(start, start.getFullYear() !== end.getFullYear())}–${formatWasteDate(end, start.getFullYear() !== end.getFullYear())}`,
  };
}

export function accountWasteWindows(account, provider) {
  const configured = Array.isArray(account.wasteWindows) ? account.wasteWindows
    : Array.isArray(provider?.requestConfig?.wasteWindows) ? provider.requestConfig.wasteWindows
      : null;
  // 账号实际追踪的键：用户选过窗口用 windowKeys，并上接口实时返回的窗口——CLI 专属
  // 适配不受 windowKeys 过滤，Antigravity 的动态特例池只出现在实时窗口里
  const tracked = new Set([
    ...(Array.isArray(account.windowKeys) ? account.windowKeys : []),
    ...(Array.isArray(account.windows) ? account.windows.map((meter) => meter.key) : []),
  ]);
  if (configured) return configured.filter((key) => isCycleWindowKey(key) && (tracked.size === 0 || tracked.has(key)));
  // 自动判定：配置窗口 ∪ 实时窗口里的周期键（与主进程 resolveWasteWindows 口径一致）
  const configuredWindows = (provider?.requestConfig?.windows || []).filter(isCycleWindowKey);
  const live = [...tracked].filter(isCycleWindowKey);
  return [...new Set([...configuredWindows, ...live])];
}

const summarize = (records) => {
  const valid = records.filter((record) => record.counted);
  const total = valid.reduce((sum, record) => sum + record.remaining / 100, 0);
  return {
    records,
    count: valid.length,
    total: valid.length ? total : null,
    average: valid.length ? total * 100 / valid.length : null,
    excluded: records.filter((record) => !record.counted),
    accounts: [...new Set(valid.map((record) => record.accountId))].map((accountId) => {
      const cycles = records.filter((record) => record.accountId === accountId);
      const counted = cycles.filter((record) => record.counted);
      const amount = counted.reduce((sum, record) => sum + record.remaining / 100, 0);
      return { accountId, total: amount, share: total > 0 ? amount / total * 100 : 0, count: counted.length, cycles };
    }).filter((account) => account.total > 0).sort((a, b) => b.total - a.total || a.accountId.localeCompare(b.accountId)),
  };
};

/** Each account's quota cycle is one normalized share; this is not money or tokens. */
export function buildWasteReport({ accounts, providers, archives, windowKey, range }) {
  const records = [];
  for (const account of accounts) {
    const provider = providers.find((item) => item.id === account.providerId);
    // weekly 口径把 7 天池周期一并计入（每个池的周期各记 1 份）
    if (!accountWasteWindows(account, provider).some((key) => matchesWasteWindowKey(key, windowKey))) continue;
    const seen = new Set();
    for (const cycle of archives[account.id] || []) {
      if (!matchesWasteWindowKey(cycle.window, windowKey)) continue;
      const end = Date.parse(cycle.end);
      if (!Number.isFinite(end) || end < range.start || end >= range.endExclusive) continue;
      const identity = `${cycle.window}:${cycle.kind}:${end}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const percentage = typeof cycle.remaining === 'number' || (typeof cycle.remaining === 'string' && cycle.remaining.trim() !== '')
        ? Number(cycle.remaining) : NaN;
      const remaining = Number.isFinite(percentage) && percentage >= 0 && percentage <= 100 ? percentage : null;
      records.push({
        ...cycle, accountId: account.id, remaining, end,
        counted: cycle.reliable === true && cycle.kind === 'natural' && remaining != null,
      });
    }
  }
  records.sort((a, b) => b.end - a.end || a.accountId.localeCompare(b.accountId));
  return {
    ...summarize(records),
    buckets: range.buckets.map((bucket) => ({ ...bucket, ...summarize(records.filter((record) => record.end >= bucket.start && record.end < bucket.endExclusive)) })),
  };
}

/** Read complete archives before exposing totals, so a failed account never looks like zero. */
export async function loadWasteArchives(api, accountIds) {
  if (!api?.getCycles) throw new Error('当前环境无法读取周期档案，请通过桌面应用或远程查看读取额度浪费。');
  const entries = await Promise.all(accountIds.map(async (id) => {
    const cycles = await api.getCycles(id);
    if (!Array.isArray(cycles)) throw new Error('周期档案格式不正确，请重试。');
    return [id, cycles];
  }));
  return Object.fromEntries(entries);
}
