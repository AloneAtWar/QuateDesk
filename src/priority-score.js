// 周期明细排序：剩余% 与距重置时间都映射到 0–100 同一根轴，再加权。
// 时间进度：距重置 0 分钟 = 0%，一个完整周期 = 100%；超过周期长则 >100%，自然靠后。
// 紧迫度 = 100 − 时间进度（越近越高）。分数 = w×剩余% + (1−w)×紧迫度%。
// 默认 w=0，等价于只按距重置时间从近到远，与旧行为一致。5h 与非 5h 的 w 分开设置。
export const WINDOW_HOURS = {
  five_hour: 5,
  daily: 24,
  weekly: 7 * 24,
  monthly: 30 * 24,
};

export const clampRemainingWeight = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
};

export const remainingPct = (meter) => {
  const n = Number(meter?.remaining);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
};

export const windowHours = (key) => WINDOW_HOURS[key] || 24;

export const remainingWeightFor = (key, weights = {}) => (
  key === 'five_hour'
    ? clampRemainingWeight(weights.fiveHourRemaining)
    : clampRemainingWeight(weights.otherRemaining)
);

export const priorityScore = (meter, weights = {}, now = Date.now()) => {
  if (meter?.available === false) return Number.NEGATIVE_INFINITY;
  const rem = remainingPct(meter);
  const period = windowHours(meter?.key);
  const resetAt = meter?.resetAt ? new Date(meter.resetAt).getTime() : NaN;
  // 没有重置时间：当作刚开完整周期（紧迫度 0），只靠剩余拉开差距
  const hours = Number.isFinite(resetAt) ? Math.max(0, (resetAt - now) / 3_600_000) : period;
  const urgencyPct = 100 - (100 * hours / period);
  const remainingWeight = remainingWeightFor(meter?.key, weights) / 100;
  return remainingWeight * rem + (1 - remainingWeight) * urgencyPct;
};

export const comparePriority = (a, b, weights = {}, now = Date.now()) => {
  const delta = priorityScore(b.meter, weights, now) - priorityScore(a.meter, weights, now);
  if (Math.abs(delta) > 1e-9) return delta;
  const aReset = a.meter.resetAt ? new Date(a.meter.resetAt).getTime() : Infinity;
  const bReset = b.meter.resetAt ? new Date(b.meter.resetAt).getTime() : Infinity;
  if (aReset !== bReset) return aReset - bReset;
  return remainingPct(b.meter) - remainingPct(a.meter);
};
