const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRatios, computeRatioPair, WINDOW_SECONDS } = require('../electron/ratio.cjs');

const T0 = Date.parse('2026-09-01T00:00:00Z');
const MIN = 60_000;

// 构造一个 5h/7d 双窗口快照：已用百分点各取一值
const point = (atMs, usedShort, usedLong, extraWindows = {}) => ({
  at: new Date(atMs).toISOString(),
  windows: {
    five_hour: { remaining: 100 - usedShort, unit: '%' },
    weekly: { remaining: 100 - usedLong, unit: '%' },
    ...extraWindows,
  },
});

// 生成一段「每个 5h 周期短窗口爬 shortPerCycle、长窗口同步爬 shortPerCycle/trueRatio」的历史：
// 周期内短窗口阶梯上升、长窗口同步小步上升；周期末短窗口归零（重置）、长窗口保持
const cyclesOf = (cycles, shortPerCycle, trueRatio, steps = 8, pollMs = 5 * MIN, startMs = T0) => {
  const points = [];
  let at = startMs;
  let usedLong = 0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (let step = 0; step < steps; step++) {
      const usedShort = (shortPerCycle * (step + 1)) / steps;
      points.push(point(at, usedShort, usedLong + usedShort / trueRatio));
      at += pollMs;
    }
    usedLong += shortPerCycle / trueRatio;
    at += pollMs;
    points.push(point(at, 0, usedLong)); // 周期结束：短窗口重置
    at += pollMs;
  }
  return points;
};

test('恒定真实倍数能被精确还原：Σ短爬升/Σ长爬升 = 长总量/短总量', () => {
  const pairs = computeRatios(cyclesOf(3, 40, 20));
  assert.equal(pairs.length, 1);
  const pair = pairs[0];
  assert.equal(pair.key, 'weekly>five_hour');
  assert.equal(pair.shortKey, 'five_hour');
  assert.equal(pair.longKey, 'weekly');
  assert.ok(Math.abs(pair.average - 20) < 0.01, `average ${pair.average}`);
  assert.equal(pair.cycleCount, 3);
  // 序列值是「截至该时刻的累计估计」：恒定倍数下每一步都等于 20
  assert.ok(pair.series.length > 10);
  assert.ok(pair.series.every((item) => Math.abs(item.value - 20) < 0.01));
});

test('序列按检验间隔出点：累计估计随配对更新，没消耗的间隔沿用上一个值（直线）', () => {
  const points = [
    point(T0, 0, 0),
    point(T0 + 5 * MIN, 10, 0.5),  // 配对：估计 10/0.5 = 20
    point(T0 + 10 * MIN, 10, 0.5), // 没消耗 → 直线延伸
    point(T0 + 15 * MIN, 10, 0.5), // 没消耗 → 直线延伸
    point(T0 + 20 * MIN, 30, 2.5), // 配对（局部倍数 10）：累计 30/2.5 = 12
    point(T0 + 25 * MIN, 30, 2.5), // 没消耗 → 直线延伸
  ];
  const pair = computeRatioPair(points, 'five_hour', 'weekly', WINDOW_SECONDS.five_hour);
  assert.deepEqual(pair.series.map((item) => item.value), [20, 20, 20, 12, 12]);
  assert.deepEqual(pair.series.map((item) => item.at), [1, 2, 3, 4, 5].map((n) => new Date(T0 + n * 5 * MIN).toISOString()));
  assert.equal(pair.pairCount, 2);
  assert.equal(pair.average, 12);
});

test('断档不画直线：超过断线阈值的间隔不生成点，折线断开', () => {
  const points = [
    point(T0, 0, 0),
    point(T0 + 5 * MIN, 10, 0.5),  // 配对：估计 20
    point(T0 + 10 * MIN, 10, 0.5), // 没消耗 → 直线
    // 断档 2 小时（> 2×5min 且 > 10min）：期间无数据，不画点
    point(T0 + 130 * MIN, 10, 0.5), // 断档间隔：无配对且是断档 → 不生成点
    point(T0 + 135 * MIN, 10, 0.5), // 恢复正常采样：没消耗 → 直线延伸恢复
  ];
  const pair = computeRatioPair(points, 'five_hour', 'weekly', WINDOW_SECONDS.five_hour);
  // 只有断档前的两个点和恢复后的一个点，断档本身不画
  assert.deepEqual(pair.series.map((item) => item.at), [
    new Date(T0 + 5 * MIN).toISOString(),
    new Date(T0 + 10 * MIN).toISOString(),
    new Date(T0 + 135 * MIN).toISOString(),
  ]);
  assert.ok(pair.series.every((item) => item.value === 20));
});

test('断档期间发生的消耗依然能正确配对（比值不依赖连续观测），且有配对的点照常生成', () => {
  const points = [
    point(T0, 0, 0),
    point(T0 + 5 * MIN, 5, 0.25),
    // 断档 2 小时：期间消耗了 30 短 / 1.5 长，没有发生重置——配对有效，点照常生成
    point(T0 + 125 * MIN, 35, 1.75),
    point(T0 + 130 * MIN, 75, 3.75),
  ];
  const pair = computeRatioPair(points, 'five_hour', 'weekly', WINDOW_SECONDS.five_hour);
  assert.equal(pair.pairCount, 3);
  assert.ok(Math.abs(pair.average - 20) < 0.01, `average ${pair.average}`);
  // 断档间隔上有配对 → 该点存在（折线断开由趋势图按时间距离处理）
  assert.equal(pair.series.length, 3);
});

test('短窗口重置：跨重置的间隔作废，重置前后的用量各自配对', () => {
  const points = [
    point(T0, 0, 0),
    point(T0 + 5 * MIN, 30, 1.5), // 30/1.5 = 20
    // 断档期间重置：旧周期 30% 被清零，新周期已观测到 25
    point(T0 + 60 * MIN, 25, 3),  // 30→25 回落 5 > 0.5 → 判定重置，该间隔作废
    point(T0 + 65 * MIN, 65, 5),  // 40/2 = 20
  ];
  const pair = computeRatioPair(points, 'five_hour', 'weekly', WINDOW_SECONDS.five_hour);
  assert.equal(pair.pairCount, 2); // 只有 0→30 与 25→65 两对
  assert.equal(pair.cycleCount, 2);
  assert.ok(Math.abs(pair.average - 20) < 0.01, `average ${pair.average}`);
});

test('断档覆盖整个短窗口时长：无法排除隐藏重置，保守放弃该配对', () => {
  const points = [
    point(T0, 0, 0),
    point(T0 + 5 * MIN, 10, 0.5),
    // 断档 5 小时（> 0.9 × 5h）：期间可能重置过，作废
    point(T0 + 310 * MIN, 50, 4.5),
  ];
  const pair = computeRatioPair(points, 'five_hour', 'weekly', WINDOW_SECONDS.five_hour);
  assert.equal(pair.pairCount, 1); // 只有第一对
  assert.equal(pair.average, 20);
  assert.equal(pair.series.length, 1); // 断档间隔无配对且是断档 → 不画点
});

test('长窗口重置：只作废该间隔，其余照常', () => {
  const points = [
    point(T0, 0, 30), // 长窗口已有 30，随后重置到 0
    point(T0 + 5 * MIN, 10, 0),
    point(T0 + 10 * MIN, 30, 1), // 20/1 = 20
  ];
  const pair = computeRatioPair(points, 'five_hour', 'weekly', WINDOW_SECONDS.five_hour);
  // 0→10 配 30→0 作废（长窗口回落）；10→30 配 0→1 有效
  assert.equal(pair.pairCount, 1);
  assert.equal(pair.average, 20);
});

test('量化噪声与单边爬升：不产生观测，计入质量计数', () => {
  const points = [
    point(T0, 0, 0),
    point(T0 + 5 * MIN, 0.02, 0.001), // 双边都低于 MIN_DELTA：忽略
    point(T0 + 10 * MIN, 0.02, 3),    // 只有长窗口爬升：longOnly
    point(T0 + 15 * MIN, 5.02, 3),    // 只有短窗口爬升：shortOnly
  ];
  const pair = computeRatioPair(points, 'five_hour', 'weekly', WINDOW_SECONDS.five_hour);
  assert.equal(pair.pairCount, 0);
  assert.equal(pair.series.length, 0); // 从未有过有效配对 → 序列不起步
  assert.equal(pair.average, null);
  assert.equal(pair.longOnly, 1);
  assert.equal(pair.shortOnly, 1);
});

test('短窗口打满 100% 后长窗口继续爬升 → 计入 longOnly 不污染比值', () => {
  const points = [
    point(T0, 0, 0),
    point(T0 + 5 * MIN, 100, 5),  // 100/5 = 20
    point(T0 + 10 * MIN, 100, 8), // 短窗口已打满，长窗口还在涨
  ];
  const pair = computeRatioPair(points, 'five_hour', 'weekly', WINDOW_SECONDS.five_hour);
  assert.equal(pair.pairCount, 1);
  assert.equal(pair.average, 20);
  assert.equal(pair.longOnly, 1);
});

test('窗口对清单：只有带时长的百分比窗口参与，余额与 Gemini 模型桶不参与', () => {
  const list = [
    point(T0, 0, 0, { balance: { remaining: 50, amount: 25, limit: 50, unit: 'CNY' }, gemini_pro: { remaining: 80, unit: '%' } }),
    point(T0 + 5 * MIN, 10, 0.5, { balance: { remaining: 50, amount: 25, limit: 50, unit: 'CNY' }, gemini_pro: { remaining: 78, unit: '%' } }),
    point(T0 + 10 * MIN, 20, 1, { monthly: { remaining: 99, unit: '%' } }),
    point(T0 + 15 * MIN, 30, 1.5, { monthly: { remaining: 98.5, unit: '%' } }),
  ];
  const pairs = computeRatios(list);
  // 展示顺序：相邻档在前（5h×7d、7d×1M），跨档在后（5h×1M）
  assert.deepEqual(pairs.map((pair) => pair.key), ['weekly>five_hour', 'monthly>weekly', 'monthly>five_hour']);
  const monthly = pairs.find((pair) => pair.key === 'monthly>five_hour');
  assert.ok(Math.abs(monthly.wallClock - 144) < 0.01);
  const monthlyWeekly = pairs.find((pair) => pair.key === 'monthly>weekly');
  assert.ok(Math.abs(monthlyWeekly.wallClock - 2592000 / 604800) < 0.01);
  const weekly = pairs.find((pair) => pair.key === 'weekly>five_hour');
  assert.ok(Math.abs(weekly.wallClock - 33.6) < 0.01);
});

test('退化的输入：空历史 / 只有一个可配对窗口 → 没有窗口对', () => {
  assert.deepEqual(computeRatios([]), []);
  assert.deepEqual(computeRatios(null), []);
  const single = [0, 5].map((offset) => ({
    at: new Date(T0 + offset * MIN).toISOString(),
    windows: { five_hour: { remaining: 100 - offset * 2, unit: '%' } },
  }));
  assert.equal(computeRatios(single).length, 0);
});
