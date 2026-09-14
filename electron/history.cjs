// 额度历史：每次轮询成功时记录一条快照，供主窗口折线图使用。
// 这里是纯逻辑（不依赖 electron），方便单元测试；文件读写由 storage.cjs 负责。

const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 90; // 最长 3 个月
const PERMANENT_RETENTION = 0; // retentionDays = 0 表示永久保存
const MAX_POINTS_PER_ACCOUNT = 5000;
const MAX_POINTS_PERMANENT = 200_000; // 永久保存时的点数上限（降采样后约 10 年数据量）
// 永久保存时，超过该天数的旧点降采样为每小时一点：长期趋势不需要 5 分钟粒度，体积降到 1/12
const FULL_RESOLUTION_DAYS = 30;
// 距上一条记录不足 1 分钟时直接覆盖，避免手动连点“刷新”刷出大量重复点
const MIN_INTERVAL_MS = 60_000;

// retentionDays：正数 = 保留天数（上限 90），0 = 永久保存，其他非法值回退默认 7 天
const clampRetentionDays = (value) => {
  const days = Number(value);
  if (days === 0) return PERMANENT_RETENTION;
  return Number.isFinite(days) && days > 0 ? Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.round(days))) : DEFAULT_RETENTION_DAYS;
};

// 百分比窗口只有带真实总量时才保留 amount/limit。
// 总量缺失、为 0，或就是 100 的纯百分比占位（Grok/CLI 把剩余率写成 amount、limit=100）都不是真实额度数字。
const realQuotaPair = (amount, limit, unit) => {
  const a = amount == null ? null : Number(amount);
  const l = limit == null ? null : Number(limit);
  const amountOk = a != null && Number.isFinite(a);
  const limitOk = l != null && Number.isFinite(l);
  if (limitOk && (l <= 0 || ((unit || '%') === '%' && l === 100))) return { amount: null, limit: null };
  return { amount: amountOk ? a : null, limit: limitOk ? l : null };
};

// 只保留画折线图需要的字段：百分比窗口看 remaining，余额窗口看 amount；limit 为窗口总量（悬停详情用）
const snapshotWindows = (windows) => Object.fromEntries((windows || []).map((meter) => {
  const unit = meter.unit || '%';
  const pair = realQuotaPair(meter.amount, meter.limitAmount, unit);
  return [meter.key, {
    remaining: Number(meter.remaining) || 0,
    amount: pair.amount,
    limit: pair.limit,
    unit,
    resetAt: meter.resetAt || null,
  }];
}));

// 追加一条快照并按保留天数裁剪；返回新的 history 对象（{ accountId: [{ at, windows }] }）
const appendHistoryPoint = (history, accountId, windows, now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS) => {
  if (!accountId || !Array.isArray(windows) || !windows.length) return history;
  const next = { ...(history || {}) };
  const points = [...(next[accountId] || [])];
  const last = points[points.length - 1];
  const point = { at: new Date(now).toISOString(), windows: snapshotWindows(windows) };
  if (last && now - new Date(last.at).getTime() < MIN_INTERVAL_MS) points[points.length - 1] = point;
  else points.push(point);
  const maxPoints = clampRetentionDays(retentionDays) === PERMANENT_RETENTION ? MAX_POINTS_PERMANENT : MAX_POINTS_PER_ACCOUNT;
  next[accountId] = points.slice(-maxPoints);
  return pruneHistory(next, retentionDays, now);
};

// 永久保存：超过 FULL_RESOLUTION_DAYS 的旧点按小时降采样（每小时保留第一个点），近期点保持原粒度
const downsampleHistory = (points, now) => {
  const cutoff = now - FULL_RESOLUTION_DAYS * 86_400_000;
  const kept = [];
  let lastBucket = -1;
  for (const point of points || []) {
    const at = new Date(point.at).getTime();
    if (at >= cutoff) { kept.push(point); continue; }
    const bucket = Math.floor(at / 3_600_000);
    if (bucket !== lastBucket) { kept.push(point); lastBucket = bucket; }
  }
  return kept;
};

// 按保留天数裁剪所有账号；retentionDays 为 0 时永久保存，改为降采样旧数据；传入 validAccountIds 时顺便清掉已删除账号的历史
const pruneHistory = (history, retentionDays = DEFAULT_RETENTION_DAYS, now = Date.now(), validAccountIds = null) => {
  const days = clampRetentionDays(retentionDays);
  const cutoff = days === PERMANENT_RETENTION ? null : now - days * 86_400_000;
  const next = {};
  for (const [accountId, points] of Object.entries(history || {})) {
    if (validAccountIds && !validAccountIds.has(accountId)) continue;
    const kept = cutoff === null
      ? downsampleHistory(points, now)
      : (points || []).filter((point) => new Date(point.at).getTime() >= cutoff);
    if (kept.length) next[accountId] = kept;
  }
  return next;
};

module.exports = { appendHistoryPoint, pruneHistory, clampRetentionDays, snapshotWindows, realQuotaPair, downsampleHistory, MAX_RETENTION_DAYS, PERMANENT_RETENTION };
