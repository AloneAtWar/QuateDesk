// 周期换算：估算同一账号两个百分比窗口的额度倍数（如 7d 额度 ≈ 多少个 5h 额度）。
// 原理：同一笔消耗会让两个窗口的「已用百分比」同时爬升，而爬升比恰好是总量比的反比——
//   Δ已用(短)/Δ已用(长) = 总量(长)/总量(短)。全程不需要绝对 token 数，也不需要流量代理；
//   采样断档（关机/软件关闭）期间发生的消耗会在下一个采样点的两个窗口上同时体现，比值依然成立，
//   因此缺失数据只会让观测点变少，不会让观测值变错。
// 序列按检验间隔出点（连续折线）：有配对就更新「截至该时刻的累计估计 Σ短/Σ长」，正常采样但没消耗的间隔
//   沿用上一个值画直线，断档（关机/软件关闭等无数据时段）则断线不画；平均取全量 Σ/Σ（按长窗口爬升加权），
//   即曲线的收敛值。
// 这里是纯逻辑（不依赖 electron），方便单元测试；输入与 history.json 的快照结构一致。

// 参与换算的窗口时长（秒）：只有有固定时长的百分比窗口才能两两配对（余额 / Gemini 模型桶等不参与）
const WINDOW_SECONDS = { five_hour: 18000, daily: 86400, weekly: 604800, monthly: 2592000 };

const MIN_DELTA = 0.05;     // 单次配对的最小已用爬升（百分点）：低于视为量化噪声，不参与配对
const RESET_DROP = 0.5;     // 已用回落超过该值（百分点）视为窗口发生了重置，跨重置的配对作废
const MIN_CYCLE_LONG = 0.2; // 长窗口总爬升（百分点）低于该值时不给出平均：数据量还不足以定倍数

// 兼容数值/纯数字字符串的 epoch 时间戳：≥1e12 按毫秒，否则按秒
const ts = (value) => {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/.test(value.trim()))) {
    const n = Number(value);
    return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
};

// 百分比窗口的已用百分点；非百分比窗口（余额等）返回 null 不参与换算
const usedOf = (sample) => {
  if (!sample || (sample.unit || '%') !== '%') return null;
  const remaining = Number(sample.remaining);
  if (!Number.isFinite(remaining)) return null;
  return Math.max(0, Math.min(100, 100 - remaining));
};

// 检验间隔中位数与断线阈值（与趋势图的断线判断一致：2 倍中位间隔且至少 10 分钟）。
// 超过它视为断档（关机 / 软件关闭等）：换算折线在这里断开而不是画直线，但断档间隔的配对有效性照常判定
const FALLBACK_POLL_MS = 5 * 60_000;
const detectPollBreakMs = (points) => {
  const times = (points || []).map((point) => ts(point.at)).filter(Boolean);
  const gaps = times.slice(1).map((at, index) => at - times[index]).filter((gap) => gap > 0).sort((a, b) => a - b);
  const median = gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)] : FALLBACK_POLL_MS;
  return Math.max(median * 2, 10 * 60_000);
};

// 单个窗口对：遍历相邻快照，把「两窗口同时爬升且都未重置」的间隔配成对。
// 序列按检验间隔出点（连续折线）：有配对就更新「截至该时刻的累计估计 Σ短/Σ长」；正常采样但没消耗的间隔
// 沿用上一个值画直线；断档（超过断线阈值）不画点、折线断开，但断档间隔若没跨重置仍参与配对。
const computeRatioPair = (points, shortKey, longKey, shortSeconds) => {
  const series = [];
  const gapBreakMs = detectPollBreakMs(points);
  let totalShort = 0;
  let totalLong = 0;
  let pairCount = 0;
  let cycleCount = 0;
  let cyclePairs = 0;  // 当前短周期内的配对数（周期统计用）
  let fromMs = null;
  let toMs = null;
  let longOnly = 0;  // 只有长窗口爬升（短窗口打满 100% 或两窗口计数口径不同），数据质量信号
  let shortOnly = 0; // 只有短窗口爬升（长窗口量化粒度不够），数据质量信号
  let estimate = null;
  const pushPoint = (atMs) => series.push({ at: new Date(atMs).toISOString(), value: estimate });
  for (let index = 1; index < (points || []).length; index++) {
    const prev = points[index - 1];
    const curr = points[index];
    const atPrev = ts(prev.at);
    const atCurr = ts(curr.at);
    if (!atPrev || !atCurr) continue;
    const isGap = atCurr - atPrev > gapBreakMs; // 断档：不画直线，折线在这里断开
    const shortPrev = prev.windows?.[shortKey];
    const shortCurr = curr.windows?.[shortKey];
    const longPrev = prev.windows?.[longKey];
    const longCurr = curr.windows?.[longKey];
    const usable = shortPrev && shortCurr && longPrev && longCurr
      && usedOf(shortPrev) != null && usedOf(shortCurr) != null && usedOf(longPrev) != null && usedOf(longCurr) != null;
    if (!usable) { if (estimate != null && !isGap) pushPoint(atCurr); continue; } // 窗口缺席 / 非百分比：直线延伸
    const dShort = usedOf(shortCurr) - usedOf(shortPrev);
    const dLong = usedOf(longCurr) - usedOf(longPrev);
    // 短窗口重置（已用回落）：结束当前周期计数，跨重置的配对作废
    if (dShort < -RESET_DROP) {
      if (cyclePairs > 0) { cycleCount += 1; cyclePairs = 0; }
      if (estimate != null && !isGap) pushPoint(atCurr);
      continue;
    }
    // 采样断档覆盖了几乎整个短窗口时长：期间可能发生过看不见的重置，放弃这一对（保守）
    // 长窗口重置：只作废这一对
    const hiddenShortReset = atCurr - atPrev > shortSeconds * 900;
    const longReset = dLong < -RESET_DROP;
    if (dShort >= MIN_DELTA && dLong >= MIN_DELTA && !hiddenShortReset && !longReset) {
      totalShort += dShort;
      totalLong += dLong;
      pairCount += 1;
      cyclePairs += 1;
      estimate = totalShort / totalLong;
      if (fromMs == null) fromMs = atPrev;
      toMs = atCurr;
      pushPoint(atCurr);
    } else {
      // 单边爬升计入质量信号；作废间隔（隐藏重置 / 长窗口重置）没有新信息
      if (!longReset && !hiddenShortReset && dLong >= MIN_DELTA) longOnly += 1;
      else if (!longReset && !hiddenShortReset && dShort >= MIN_DELTA) shortOnly += 1;
      if (estimate != null && !isGap) pushPoint(atCurr); // 没有新配对且非断档 → 沿用上一个值，直线延伸
    }
  }
  if (cyclePairs > 0) cycleCount += 1; // 收尾的进行中周期
  return { shortKey, longKey, series, average: totalLong >= MIN_CYCLE_LONG ? totalShort / totalLong : null, cycleCount, pairCount, fromMs, toMs, longOnly, shortOnly };
};

// 找出历史里「有固定时长且以百分比记录」的窗口，按时长升序两两配对（短在前）
const computeRatios = (points) => {
  const list = points || [];
  const keys = [...new Set(list.flatMap((point) => Object.keys(point.windows || {})))]
    .filter((key) => WINDOW_SECONDS[key] && list.some((point) => (point.windows[key]?.unit || '%') === '%'))
    .sort((a, b) => WINDOW_SECONDS[a] - WINDOW_SECONDS[b]);
  const pairs = [];
  // 生成顺序 = 展示顺序：先相邻档（5h×7d、7d×1M…），再跨档（5h×1M）——相邻档是默认展示的主力，排在前面
  for (let span = 1; span < keys.length; span++) {
    for (let i = 0; i + span < keys.length; i++) {
      const pair = computeRatioPair(list, keys[i], keys[i + span], WINDOW_SECONDS[keys[i]]);
      pairs.push({ key: `${keys[i + span]}>${keys[i]}`, wallClock: WINDOW_SECONDS[keys[i + span]] / WINDOW_SECONDS[keys[i]], ...pair });
    }
  }
  return pairs;
};

module.exports = { computeRatios, computeRatioPair, WINDOW_SECONDS, MIN_DELTA, RESET_DROP, MIN_CYCLE_LONG };
