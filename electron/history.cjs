// 额度历史：每次轮询成功时记录一条快照，供主窗口折线图使用。
// 这里是纯逻辑（不依赖 electron），方便单元测试；文件读写由 storage.cjs 负责。

const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 90; // 最长 3 个月
const MAX_POINTS_PER_ACCOUNT = 5000;
// 距上一条记录不足 1 分钟时直接覆盖，避免手动连点“刷新”刷出大量重复点
const MIN_INTERVAL_MS = 60_000;

const clampRetentionDays = (value) => {
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.round(days))) : DEFAULT_RETENTION_DAYS;
};

// 只保留画折线图需要的字段：百分比窗口看 remaining，余额窗口看 amount；limit 为窗口总量（悬停详情用）
const snapshotWindows = (windows) => Object.fromEntries((windows || []).map((meter) => [meter.key, {
  remaining: Number(meter.remaining) || 0,
  amount: meter.amount == null || !Number.isFinite(Number(meter.amount)) ? null : Number(meter.amount),
  limit: meter.limitAmount == null || !Number.isFinite(Number(meter.limitAmount)) ? null : Number(meter.limitAmount),
  unit: meter.unit || '%',
  resetAt: meter.resetAt || null,
}]));

// 追加一条快照并按保留天数裁剪；返回新的 history 对象（{ accountId: [{ at, windows }] }）
const appendHistoryPoint = (history, accountId, windows, now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS) => {
  if (!accountId || !Array.isArray(windows) || !windows.length) return history;
  const next = { ...(history || {}) };
  const points = [...(next[accountId] || [])];
  const last = points[points.length - 1];
  const point = { at: new Date(now).toISOString(), windows: snapshotWindows(windows) };
  if (last && now - new Date(last.at).getTime() < MIN_INTERVAL_MS) points[points.length - 1] = point;
  else points.push(point);
  next[accountId] = points.slice(-MAX_POINTS_PER_ACCOUNT);
  return pruneHistory(next, retentionDays, now);
};

// 按保留天数裁剪所有账号的历史；传入 validAccountIds 时顺便清掉已删除账号的历史
const pruneHistory = (history, retentionDays = DEFAULT_RETENTION_DAYS, now = Date.now(), validAccountIds = null) => {
  const cutoff = now - clampRetentionDays(retentionDays) * 86_400_000;
  const next = {};
  for (const [accountId, points] of Object.entries(history || {})) {
    if (validAccountIds && !validAccountIds.has(accountId)) continue;
    const kept = (points || []).filter((point) => new Date(point.at).getTime() >= cutoff);
    if (kept.length) next[accountId] = kept;
  }
  return next;
};

module.exports = { appendHistoryPoint, pruneHistory, clampRetentionDays, snapshotWindows, MAX_RETENTION_DAYS };
