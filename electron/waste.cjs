// 周期浪费档案：检测周期型窗口（周/月额度）的周期结束事件，把周期末状态归档。
// 归档永久保留、不受历史保留时长影响，供「浪费统计」视图使用。
// 这里是纯逻辑（不依赖 electron），方便单元测试；文件读写由 storage.cjs 负责。

const RESET_JITTER_MS = 5 * 60_000; // resetAt 抖动容差：差值 5 分钟内视为同一周期
const RELIABLE_FACTOR = 2;          // 最后观测距重置 ≤ 2×轮询中位间隔 → 记录可信
const FALLBACK_POLL_MS = 5 * 60_000;

// 兼容数值/纯数字字符串的 epoch 时间戳（如 Z.ai 直接返回毫秒数）：≥1e12 按毫秒，否则按秒
const ts = (value) => {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/.test(value.trim()))) {
    const n = Number(value);
    return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null;
  }
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
// 判据只看 resetAt 的改期，以及旧 resetAt 是否落在两次轮询之间：
// - natural：旧 resetAt 已被两次轮询跨过（含电脑关机断档期间跨过的）→ 旧周期自然到期，end = 旧 resetAt
// - early：旧 resetAt 还没到期就被改期（无论改早还是改晚）→ 厂商提前重置；
//   真实清零时刻发生在两次轮询之间、观测不到，end ≈ 最后观测时间
// - resetAt 没变（抖动容差内）、或随轮询同步后移（滑动窗口，步长≈轮询间隔）→ 同一周期
// - resetAt 缺失 → 单点无法判定；由 extractCycles 记住最后一个带 resetAt 的快照，恢复后再比对
const detectCycleClose = (prev, curr, prevAt, currAt) => {
  if (!prev || !curr) return null;
  const prevReset = ts(prev.resetAt);
  const currReset = ts(curr.resetAt);
  if (!prevReset || !currReset) return null;
  const delta = currReset - prevReset;
  if (Math.abs(delta) <= RESET_JITTER_MS) return null;
  if (prevReset <= currAt + RESET_JITTER_MS) return { kind: 'natural', end: prevReset };
  if (delta > 0 && delta <= (currAt - prevAt) + RESET_JITTER_MS) return null;
  return { kind: 'early', end: prevAt };
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
// resetAt 暂时缺失的处理：记住最后一个带 resetAt 的快照，等恢复后拿新值与它比较（相同=同周期）；
// 若直到历史末尾都没恢复，则把「消失」本身认定为一次周期结束——旧 resetAt 已被跨过算自然到期，否则算提前重置
const extractCycles = (points, windowKeys) => {
  const median = medianGapMs(points);
  const records = [];
  for (const key of windowKeys || []) {
    let prev = null;         // 最后一个带 resetAt 的快照
    let lastSeenAtMs = null; // 该窗口最后一个有数据的快照时间（含 resetAt 缺失的）
    let sawMissing = false;  // prev 之后是否出现过 resetAt 缺失的点
    let cycleFromMs = null;
    for (const point of points || []) {
      const sample = point.windows?.[key];
      const atMs = ts(point.at);
      if (!sample || !atMs) continue;
      lastSeenAtMs = atMs;
      if (!ts(sample.resetAt)) { if (prev) sawMissing = true; continue; }
      if (!prev) { prev = { sample, atMs }; cycleFromMs = atMs; continue; }
      const close = detectCycleClose(prev.sample, sample, prev.atMs, atMs);
      if (close) {
        records.push(buildCycleRecord(key, prev, cycleFromMs ?? prev.atMs, close, median));
        // 新周期的起点：自然到期 = 旧周期结束时刻；提前重置 ≈ 当前观测时间
        cycleFromMs = close.kind === 'natural' ? close.end : atMs;
      }
      sawMissing = false;
      prev = { sample, atMs };
    }
    // resetAt 消失后一直没恢复：归档一次周期结束。end 的取法与恢复后桥接判定一致，日后恢复不会重复归档
    if (prev && sawMissing) {
      const prevReset = ts(prev.sample.resetAt);
      const close = prevReset <= lastSeenAtMs + RESET_JITTER_MS
        ? { kind: 'natural', end: prevReset }
        : { kind: 'early', end: prev.atMs };
      records.push(buildCycleRecord(key, prev, cycleFromMs ?? prev.atMs, close, median));
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

module.exports = { medianGapMs, detectCycleClose, extractCycles, mergeCycles, computeWasteStats, resolveWasteWindows, RESET_JITTER_MS, RELIABLE_FACTOR };
