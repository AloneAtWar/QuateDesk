// 周期浪费档案：检测周期型窗口（周/月额度）的周期结束事件，把周期末状态归档。
// 归档永久保留、不受历史保留时长影响，供「浪费统计」视图使用。
// 这里是纯逻辑（不依赖 electron），方便单元测试；文件读写由 storage.cjs 负责。

const RESET_JITTER_MS = 5 * 60_000; // resetAt 抖动容差：差值 5 分钟内视为同一周期
const SURGE_POINTS = 15;            // resetAt 未变但剩余率突升 ≥15pp：厂商清零但没改重置时间
const RELIABLE_FACTOR = 2;          // 最后观测距重置 ≤ 2×轮询中位间隔 → 记录可信
const FALLBACK_POLL_MS = 5 * 60_000;

const ts = (value) => {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
};

// 轮询中位间隔：判断记录可信度的基准；点太少时回退 5 分钟
const medianGapMs = (points) => {
  const times = (points || []).map((point) => ts(point.at)).filter(Boolean);
  const gaps = times.slice(1).map((at, index) => at - times[index]).filter((gap) => gap > 0).sort((a, b) => a - b);
  return gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)] : FALLBACK_POLL_MS;
};

// 相邻两个快照间该窗口是否结束了旧周期；返回 null（同周期）或 { kind, end }
// - natural：resetAt 变晚且旧 resetAt 已经过去（旧周期自然到期，end = 旧 resetAt）
// - early：resetAt 变早，或 resetAt 没变但剩余率突升（厂商主动清零，真实清零时刻观测不到，end ≈ 最后观测时间）
// 滑动窗口的 resetAt 永远在将来、持续后移，不会满足 natural 的「旧 resetAt 已过去」条件，天然被排除
const detectCycleClose = (prev, curr, prevAt, currAt) => {
  if (!prev || !curr) return null;
  const prevReset = ts(prev.resetAt);
  const currReset = ts(curr.resetAt);
  if (prevReset && currReset) {
    const delta = currReset - prevReset;
    if (Math.abs(delta) <= RESET_JITTER_MS) {
      return curr.remaining - prev.remaining >= SURGE_POINTS ? { kind: 'early', end: prevAt } : null;
    }
    if (delta > 0) return prevReset <= currAt + RESET_JITTER_MS ? { kind: 'natural', end: prevReset } : null;
    return { kind: 'early', end: prevAt };
  }
  // resetAt 缺失时只剩突升兜底
  return curr.remaining - prev.remaining >= SURGE_POINTS ? { kind: 'early', end: prevAt } : null;
};

// 归档一条周期记录：end/observedAt 的间隔即失真程度，reliable 在归档时按当时轮询节奏算好
const buildCycleRecord = (windowKey, prev, fromMs, close, medianMs) => ({
  window: windowKey,
  from: new Date(fromMs).toISOString(),
  end: new Date(close.end).toISOString(),
  kind: close.kind,
  observedAt: new Date(prev.atMs).toISOString(),
  remaining: Number(prev.sample.remaining) || 0,
  amount: Number.isFinite(Number(prev.sample.amount)) ? Number(prev.sample.amount) : null,
  limit: Number.isFinite(Number(prev.sample.limit)) ? Number(prev.sample.limit) : null,
  gapMs: Math.max(0, close.end - prev.atMs),
  reliable: close.kind === 'natural' && (close.end - prev.atMs) <= RELIABLE_FACTOR * medianMs,
});

const cycleKey = (record) => `${record.window}:${record.kind}:${record.end}`;

// 从历史快照提取某账号的周期档案（回填与增量共用：每次全量扫描，靠 mergeCycles 去重）
const extractCycles = (points, windowKeys) => {
  const median = medianGapMs(points);
  const records = [];
  for (const key of windowKeys || []) {
    let prev = null;
    let cycleFromMs = null;
    for (const point of points || []) {
      const sample = point.windows?.[key];
      const atMs = ts(point.at);
      if (!sample || !atMs) continue;
      if (!prev) { prev = { sample, atMs }; cycleFromMs = atMs; continue; }
      const close = detectCycleClose(prev.sample, sample, prev.atMs, atMs);
      if (close) {
        records.push(buildCycleRecord(key, prev, cycleFromMs ?? prev.atMs, close, median));
        // 新周期的起点：自然到期 = 旧周期结束时刻；提前重置 ≈ 当前观测时间
        cycleFromMs = close.kind === 'natural' ? close.end : atMs;
      }
      prev = { sample, atMs };
    }
  }
  return records.sort((a, b) => a.end.localeCompare(b.end));
};

// 合并已有档案与新提取的记录（按 窗口:类型:结束时间 去重），按结束时间排序
const mergeCycles = (existing, extracted) => {
  const seen = new Set((existing || []).map(cycleKey));
  const added = (extracted || []).filter((record) => !seen.has(cycleKey(record)));
  if (!added.length) return existing || [];
  return [...(existing || []), ...added].sort((a, b) => a.end.localeCompare(b.end));
};

// 浪费统计聚合：只有「可靠 + 自然到期」的周期计入平均与累计；失真/提前重置只展示不统计
const computeWasteStats = (cycles, windowKey) => {
  const list = (cycles || []).filter((record) => record.window === windowKey);
  const good = list.filter((record) => record.reliable && record.kind === 'natural');
  const sum = good.reduce((total, record) => total + record.remaining, 0);
  return {
    cycles: list.length,
    reliable: good.length,
    excluded: list.length - good.length,
    avgWaste: good.length ? sum / good.length : null,
    totalWaste: sum / 100, // 折算成「几倍单周期总额度」
  };
};

// 厂商可统计窗口：预设了 wasteWindows 用预设；否则默认取周期类型的 weekly/monthly
const resolveWasteWindows = (requestConfig) => {
  if (Array.isArray(requestConfig?.wasteWindows)) return requestConfig.wasteWindows;
  return (requestConfig?.windows || []).filter((key) => ['weekly', 'monthly'].includes(key));
};

module.exports = { medianGapMs, detectCycleClose, extractCycles, mergeCycles, computeWasteStats, resolveWasteWindows, RESET_JITTER_MS, SURGE_POINTS, RELIABLE_FACTOR };
