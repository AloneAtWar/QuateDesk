// 周期浪费档案：检测周期型窗口（周/月额度）的周期结束事件，把周期末状态归档。
// 归档永久保留、不受历史保留时长影响，供「浪费统计」视图使用。
// 这里是纯逻辑（不依赖 electron），方便单元测试；文件读写由 storage.cjs 负责。

const { realQuotaPair } = require('./history.cjs');

const RESET_JITTER_MS = 5 * 60_000; // resetAt 抖动容差：差值 5 分钟内视为同一周期
const RELIABLE_FACTOR = 2;          // 最后观测距重置 ≤ 2×轮询中位间隔 → 记录可信
const FALLBACK_POLL_MS = 5 * 60_000;
const REFILL_EPS = 5;               // 剩余率回升 ≥5 个百分点视为额度回补（重置的必要证据）
const MERGE_TOL_MS = 6 * 60 * 60_000; // 归档合并时「同一周期」的结束时间容差：不同批次扫描的锚点会差几分钟
const REFILL_CYCLE_KEYS = ['weekly', 'monthly']; // 回补判定仅限周期型窗口：滑动窗口剩余率回升是正常滚动

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
// 判据看 resetAt 的改期 + 剩余率是否回补（重置必然伴随回补）：
// - natural：旧 resetAt 已被两次轮询跨过（含电脑关机断档期间跨过的）且剩余率有回补（或旧值已接近满格，回补不可见）→ 旧周期自然到期，end = 旧 resetAt
// - early：旧 resetAt 还没到期就被改期且剩余率明显回升 → 厂商提前重置；
//   真实清零时刻发生在两次轮询之间、观测不到，end ≈ 最后观测时间
// - resetAt 没变（抖动容差内）、或随轮询同步后移（滑动窗口，步长≈轮询间隔）→ 同一周期；
//   例外是「剩余率回补但 resetAt 没变」（Kimi 提前回满额度）——配对层面无法判定，
//   由 extractCycles 挂起候选并向后看一个观测点确认后才归档
// - 改期但剩余率没有回升：旧时刻已过 → 厂商推迟了重置；旧时刻未到 → 滑动窗口重新锚定。
//   两种情况都没有发生重置，同一周期（如整周没用、resetAt=now+7d 一直滑动的窗口）
// - resetAt 缺失 → 单点无法判定；由 extractCycles 记住最后一个带 resetAt 的快照，恢复后再比对
const detectCycleClose = (prev, curr, prevAt, currAt) => {
  if (!prev || !curr) return null;
  const prevReset = ts(prev.resetAt);
  const currReset = ts(curr.resetAt);
  if (!prevReset || !currReset) return null;
  const delta = currReset - prevReset;
  if (Math.abs(delta) <= RESET_JITTER_MS) return null;
  const prevRemaining = Number(prev.remaining);
  const currRemaining = Number(curr.remaining);
  // 剩余率不可得时无法判回补，退回只看 resetAt 的旧行为
  const refilled = Number.isFinite(prevRemaining) && Number.isFinite(currRemaining)
    ? currRemaining - prevRemaining >= REFILL_EPS : null;
  if (prevReset <= currAt + RESET_JITTER_MS) {
    if (refilled === false && prevRemaining < 100 - REFILL_EPS) return null;
    return { kind: 'natural', end: prevReset };
  }
  if (delta > 0 && delta <= (currAt - prevAt) + RESET_JITTER_MS) return null;
  if (refilled === false) return null;
  return { kind: 'early', end: prevAt };
};

// 归档一条周期记录：end/observedAt 的间隔即失真程度，reliable 在归档时按当时轮询节奏算好
const buildCycleRecord = (windowKey, prev, fromMs, close, medianMs) => {
  const pair = realQuotaPair(prev.sample.amount, prev.sample.limit, prev.sample.unit);
  return {
    window: windowKey,
    from: new Date(fromMs).toISOString(),
    end: new Date(close.end).toISOString(),
    kind: close.kind,
    observedAt: new Date(prev.atMs).toISOString(),
    remaining: Number(prev.sample.remaining) || 0,
    amount: pair.amount,
    limit: pair.limit,
    gapMs: Math.max(0, close.end - prev.atMs),
    reliable: close.kind === 'natural' && (close.end - prev.atMs) <= RELIABLE_FACTOR * medianMs,
  };
};

// 自然到期周期的起点：按窗口标称周期从结束时刻倒推（周=7天，月=一个日历月）。
// 不用链式推算（上个周期的 end / 首次观测时间）：首条记录、观测跨过整个周期的跳跃
// 都会让链式起点偏早，出现「21 天的周周期」这类错误区间
const naturalCycleStartMs = (windowKey, endMs) => {
  if (windowKey === 'weekly') return endMs - 7 * 86_400_000;
  if (windowKey === 'monthly') {
    const date = new Date(endMs);
    date.setUTCMonth(date.getUTCMonth() - 1);
    return date.getTime();
  }
  return null;
};

// 从历史快照提取某账号的周期档案（回填与增量共用：每次全量扫描，靠 mergeCycles 去重）
// resetAt 暂时缺失的处理：记住最后一个带 resetAt 的快照，等恢复后拿新值与它比较（相同=同周期）；
// 若直到历史末尾都没恢复，则把「消失」本身认定为一次周期结束——旧 resetAt 已被跨过算自然到期，否则算提前重置
// 剩余率回补但 resetAt 没变（Kimi 提前回满额度）：厂商不把回补和改期一起下发，resetAt 判据看不到。
// 此时挂起候选、向后看一个观测点：仍比回补前高 ≥REFILL_EPS → 真回补；弹回原值附近 → 单点毛刺（Copilot 假数据），候选作废。
// 真回补不结束周期：原定重置照常到来，见 refilledCycleRecords

// 回补周期归档。回补后到原定重置之间只剩几个小时，这段附赠额度到期时几乎满格，
// 单独成档会被记成「整周浪费 100%」。原定重置自然到来时把回补前后合成一个周期：
// 浪费取回补那一刻的剩余（本周期额度真正没用掉的部分，回补前一个轮询间隔内观测到，精度与自然到期相当），
// 回补后的附赠额度只记在 refill 附注里、不计入统计。
// 回补后又被厂商提前改期结束的周期不完整，退回两条 early 记录（均不计入）
const refilledCycleRecords = (windowKey, refill, last, close, medianMs) => {
  const { base, rise } = refill;
  if (close.kind !== 'natural') return [
    buildCycleRecord(windowKey, base, refill.fromMs, { kind: 'early', end: base.atMs }, medianMs),
    buildCycleRecord(windowKey, last, rise.atMs, close, medianMs),
  ];
  const startMs = refill.fromEarly ? refill.fromMs : (naturalCycleStartMs(windowKey, close.end) ?? refill.fromMs);
  const gapMs = Math.max(0, rise.atMs - base.atMs); // 真实回补时刻落在 base 与 rise 两次观测之间
  return [{
    ...buildCycleRecord(windowKey, base, startMs, close, medianMs),
    gapMs,
    reliable: gapMs <= RELIABLE_FACTOR * medianMs,
    refill: {
      at: new Date(rise.atMs).toISOString(),
      count: refill.count,
      remaining: Number(last.sample.remaining) || 0,
      observedAt: new Date(last.atMs).toISOString(),
    },
  }];
};

const extractCycles = (points, windowKeys) => {
  const median = medianGapMs(points);
  const records = [];
  for (const key of windowKeys || []) {
    let prev = null;         // 最后一个带 resetAt 的快照
    let lastSeenAtMs = null; // 该窗口最后一个有数据的快照时间（含 resetAt 缺失的）
    let sawMissing = false;  // prev 之后是否出现过 resetAt 缺失的点
    let cycleFromMs = null;
    let cycleFromEarly = false; // 当前周期是否由提前重置开启：自然到期时不再按标称周期倒推 from
    let pendingRefill = null;   // 回补候选 { base: 回补前最后稳定点, rise: 回补后的第一个点 }
    let refill = null;          // 本周期已确认的回补 { base, rise, fromMs, fromEarly, count }，原定重置到来时合并归档
    const closeCycle = (last, close) => {
      if (refill) { records.push(...refilledCycleRecords(key, refill, last, close, median)); return; }
      const fallbackFromMs = cycleFromMs ?? last.atMs;
      const startMs = close.kind === 'natural' && !cycleFromEarly
        ? (naturalCycleStartMs(key, close.end) ?? fallbackFromMs)
        : fallbackFromMs;
      records.push(buildCycleRecord(key, last, startMs, close, median));
    };
    for (const point of points || []) {
      const sample = point.windows?.[key];
      const atMs = ts(point.at);
      if (!sample || !atMs) continue;
      lastSeenAtMs = atMs;
      if (!ts(sample.resetAt)) { if (prev) sawMissing = true; continue; }
      if (!prev) { prev = { sample, atMs }; cycleFromMs = atMs; continue; }
      // 回补候选裁决：仍比回补前高 → 真回补，记住回补前状态（同周期多次回补只认第一次），基线切到回补后的档位
      if (pendingRefill) {
        const refillRem = Number(sample.remaining);
        const baseRem = Number(pendingRefill.base.sample.remaining);
        if (Number.isFinite(refillRem)) {
          if (refillRem - baseRem >= REFILL_EPS) {
            const { base, rise } = pendingRefill;
            if (refill) refill.count += 1;
            else refill = { base, rise, fromMs: cycleFromMs ?? base.atMs, fromEarly: cycleFromEarly, count: 1 };
            prev = rise; // 回补后的观测与当前点继续配对（可能与自然到期重合）
          }
          pendingRefill = null;
        }
        // 剩余率缺失：候选继续挂起，先按当前基线配对
      }
      const close = detectCycleClose(prev.sample, sample, prev.atMs, atMs);
      if (close) {
        closeCycle(prev, close);
        // 新周期的起点：自然到期 = 旧周期结束时刻；提前重置 ≈ 当前观测时间
        cycleFromMs = close.kind === 'natural' ? close.end : atMs;
        cycleFromEarly = close.kind !== 'natural';
        pendingRefill = null; // 周期已结束，未决的回补候选作废
        refill = null;
      }
      sawMissing = false;
      // 回补候选：resetAt 没变但剩余率突升 ≥REFILL_EPS；仅周期型窗口（滑动窗口的回升是正常滚动）
      if (!pendingRefill && REFILL_CYCLE_KEYS.includes(key)
        && Math.abs(ts(sample.resetAt) - ts(prev.sample.resetAt)) <= RESET_JITTER_MS
        && Number.isFinite(Number(prev.sample.remaining)) && Number.isFinite(Number(sample.remaining))
        && Number(sample.remaining) - Number(prev.sample.remaining) >= REFILL_EPS) {
        pendingRefill = { base: prev, rise: { sample, atMs } };
        continue; // 回补点先不接入配对链，基线保持在回补前
      }
      prev = { sample, atMs };
    }
    // resetAt 消失后一直没恢复：归档一次周期结束。end 的取法与恢复后桥接判定一致，日后恢复不会重复归档
    if (prev && sawMissing) {
      const prevReset = ts(prev.sample.resetAt);
      const close = prevReset <= lastSeenAtMs + RESET_JITTER_MS
        ? { kind: 'natural', end: prevReset }
        : { kind: 'early', end: prev.atMs };
      if (refill) closeCycle(prev, close);
      else records.push(buildCycleRecord(key, prev, cycleFromMs ?? prev.atMs, close, median));
    }
  }
  return records.sort((a, b) => a.end.localeCompare(b.end));
};

// 合并已有档案与新提取的记录（每次全量扫描调用）：
// - 旧记录按 窗口+类型+相近结束时间 匹配新记录，匹配到就用新记录覆盖——
//   全量历史算出的 from/reliable 更准，且不同批次扫描的 end 锚点会差几分钟，按精确值去重会留下重复
// - 例外：旧记录可靠而新提取失真时不覆盖。永久保留模式下超过 30 天的历史已降采样为
//   每小时一点，重提取的观测点只能落在整点附近，gap 被拉长到接近一小时，reliable 判据
//   （≤2×当前轮询中位间隔）必然不满足；可靠档案只应被同样可靠的重算更新，否则当时按
//   全分辨率归档的记录会在越过降采样线后被改写成失真记录
// - 落在本次历史覆盖范围内的旧记录若新链条里没有对应 → 旧算法的误报，丢弃；
//   覆盖范围之前的历史已裁剪或来自导入，无法重算，原样保留
const mergeCycles = (existing, extracted, coveredFromMs = null) => {
  const fresh = extracted || [];
  const nearMatch = (record) => {
    const end = Date.parse(record.end);
    if (!Number.isFinite(end)) return null;
    return fresh.find((item) => item.window === record.window && item.kind === record.kind
      && Math.abs(Date.parse(item.end) - end) <= MERGE_TOL_MS) || null;
  };
  const downgraded = new Set(); // 被旧可靠记录压制的新提取记录，不再进入档案
  const kept = (existing || []).filter((record) => {
    const match = nearMatch(record);
    if (match) {
      // 新记录合并了回补（旧档案是回补后的短周期）属于口径修正而非降级，一律覆盖
      const keepOld = record.reliable === true && match.reliable !== true && !(match.refill && !record.refill);
      if (keepOld) downgraded.add(match);
      return keepOld;
    }
    const observed = Date.parse(record.observedAt);
    return !(coveredFromMs != null && Number.isFinite(observed) && observed >= coveredFromMs);
  });
  return [...kept, ...fresh.filter((record) => !downgraded.has(record))]
    .sort((a, b) => a.end.localeCompare(b.end));
};

// 读取档案时清洗：同一 窗口+类型 结束时间相近的重复记录（早期只增不覆盖的合并留下的）
// 合并为一条，保留更可信的（reliable 优先，观测点更晚的 end 锚点更准），
// natural 记录的起点只把早于标称周期的链式漂移修正回来——紧跟提前重置的短周期
// from 晚于标称起点（= 回补时刻），保留不动
const dedupeCycles = (cycles) => {
  const list = (cycles || []).slice().sort((a, b) => a.end.localeCompare(b.end) || a.kind.localeCompare(b.kind));
  const out = [];
  for (const record of list) {
    const end = Date.parse(record.end);
    const last = out[out.length - 1];
    if (last && last.window === record.window && last.kind === record.kind && Number.isFinite(end)
      && Math.abs(end - Date.parse(last.end)) <= MERGE_TOL_MS) {
      if (preferCycle(record, last)) out[out.length - 1] = record;
      continue;
    }
    out.push(record);
  }
  return out.map((record) => {
    if (record.kind !== 'natural') return record;
    const end = Date.parse(record.end);
    const start = Number.isFinite(end) ? naturalCycleStartMs(record.window, end) : null;
    if (start == null) return record;
    const fromMs = Date.parse(record.from);
    return Number.isFinite(fromMs) && fromMs >= start ? record : { ...record, from: new Date(start).toISOString() };
  });
};

const preferCycle = (candidate, current) => {
  // 合并了回补的记录取代同一结束时刻的回补后短周期（旧口径留下的）
  if (Boolean(candidate.refill) !== Boolean(current.refill)) return Boolean(candidate.refill);
  if (candidate.reliable === true && current.reliable !== true) return true;
  if (current.reliable === true && candidate.reliable !== true) return false;
  return (Date.parse(candidate.observedAt || '') || 0) >= (Date.parse(current.observedAt || '') || 0);
};

// 幽灵档案清理：旧版算法的「剩余率突升兜底」给同一次重置重复归档 early+natural 两条记录，
// 二者共享同一个 observedAt（周期最后一次观测点）。这种 early 是误报，删除只留 natural；
// 真实的提前重置不会与 natural 共享观测点（改期后的旧 resetAt 永远不会被跨过），不受影响。
const purgeGhostCycles = (cycles) => {
  const list = cycles || [];
  const naturalObserved = new Set(list.filter((record) => record.kind === 'natural').map((record) => record.observedAt));
  if (!naturalObserved.size) return list;
  return list.filter((record) => !(record.kind === 'early' && naturalObserved.has(record.observedAt)));
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

// v0.6.18–0.7.0 的一次性修复（纯逻辑）：当时的 mergeCycles 把越过降采样线（30 天）的
// 可靠档案改写成了失真记录——历史降采样为每小时一点后重提取，观测点只能落在整点附近，
// gap 被拉长到约一小时。每个每日快照 / 滚动 .bak 都是改写前的完好档案：用其中
// 「同窗口 + 同类型 + 相近结束时间」的可靠记录替换当前失真的记录，恢复当时的观测点、
// 剩余率与 reliable。只升不降：当前可靠的记录不动；快照里没有可靠对照的失真记录
// （如重置前长期断档观测到的）本来就失真，保持原样。候选多条时取 gap 最小的一条。
const repairDowngradedCycles = (current, backups) => {
  const next = {};
  const repaired = [];
  for (const [accountId, records] of Object.entries(current || {})) {
    const candidates = [];
    for (const source of backups || []) candidates.push(...(source?.[accountId] || []));
    next[accountId] = (records || []).map((record) => {
      if (record.reliable === true) return record;
      const end = Date.parse(record.end);
      if (!Number.isFinite(end)) return record;
      const match = candidates
        .filter((item) => item.reliable === true && item.window === record.window && item.kind === record.kind
          && Number.isFinite(Date.parse(item.end)) && Math.abs(Date.parse(item.end) - end) <= MERGE_TOL_MS)
        .sort((a, b) => (Number(a.gapMs) || Infinity) - (Number(b.gapMs) || Infinity)
          || (Date.parse(b.observedAt) || 0) - (Date.parse(a.observedAt) || 0))[0];
      if (!match) return record;
      repaired.push({ accountId, window: record.window, kind: record.kind, end: record.end, observedAt: match.observedAt });
      return { ...match };
    });
  }
  return { cycles: next, repaired };
};

module.exports = { medianGapMs, detectCycleClose, extractCycles, mergeCycles, dedupeCycles, purgeGhostCycles, computeWasteStats, resolveWasteWindows, naturalCycleStartMs, repairDowngradedCycles, RESET_JITTER_MS, RELIABLE_FACTOR, REFILL_EPS, MERGE_TOL_MS };
