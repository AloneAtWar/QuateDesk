const test = require('node:test');
const assert = require('node:assert/strict');
const { medianGapMs, detectCycleClose, extractCycles, mergeCycles, computeWasteStats, resolveWasteWindows } = require('../electron/waste.cjs');

const T0 = Date.parse('2026-09-01T02:00:00Z'); // 周期重置时刻（周二 10:00 +08）
const H = 3_600_000;
const D = 86_400_000;

// 构造一串 5 分钟间隔的周窗口快照：resetAt 固定，剩余率按给定序列变化
const weeklyPoints = (resetAt, remainings, startMs = T0 - 7 * D) =>
  remainings.map((remaining, index) => ({
    at: new Date(startMs + index * 5 * 60_000).toISOString(),
    windows: { weekly: { remaining, amount: remaining * 35, limit: 3500, unit: '%', resetAt } },
  }));

test('medianGapMs 取间隔中位数，点太少回退 5 分钟', () => {
  assert.equal(medianGapMs([]), 5 * 60_000);
  assert.equal(medianGapMs(weeklyPoints('2026-09-01T02:00:00Z', [50, 40, 30, 20])), 5 * 60_000);
  const sparse = [0, 5, 10, 30, 35].map((m) => ({ at: new Date(T0 + m * 60_000).toISOString() }));
  assert.equal(medianGapMs(sparse), 5 * 60_000);
});

test('detectCycleClose：resetAt 变晚且旧重置时刻已过 → 自然到期', () => {
  const prev = { remaining: 34, resetAt: '2026-09-01T02:00:00Z' };
  const curr = { remaining: 98, resetAt: '2026-09-08T02:00:00Z' };
  const close = detectCycleClose(prev, curr, T0 - 5 * 60_000, T0 + 5 * 60_000);
  assert.deepEqual(close, { kind: 'natural', end: T0 });
});

test('detectCycleClose：滑动窗口 resetAt 持续后移但永远在将来 → 不算周期结束', () => {
  // 每次轮询 resetAt 都是「现在 + 7 天」，delta 很大但旧 resetAt 还没到
  const prev = { remaining: 60, resetAt: new Date(T0 + 7 * D).toISOString() };
  const curr = { remaining: 55, resetAt: new Date(T0 + 7 * D + 5 * 60_000).toISOString() };
  assert.equal(detectCycleClose(prev, curr, T0 - 5 * 60_000, T0), null);
});

test('detectCycleClose：resetAt 变早 → 厂商提前重置', () => {
  const prev = { remaining: 22, resetAt: '2026-09-08T02:00:00Z' };
  const curr = { remaining: 96, resetAt: '2026-09-05T02:00:00Z' };
  const prevAt = T0 - 5 * 60_000;
  const close = detectCycleClose(prev, curr, prevAt, T0);
  assert.deepEqual(close, { kind: 'early', end: prevAt });
});

test('detectCycleClose：resetAt 没变但剩余率突升 ≥15pp → 清零兜底', () => {
  const reset = '2026-09-08T02:00:00Z';
  const prevAt = T0 - 5 * 60_000;
  assert.deepEqual(detectCycleClose({ remaining: 40, resetAt: reset }, { remaining: 100, resetAt: reset }, prevAt, T0), { kind: 'early', end: prevAt });
  // 小幅回升（缓慢回血/统计抖动）不算
  assert.equal(detectCycleClose({ remaining: 40, resetAt: reset }, { remaining: 50, resetAt: reset }, prevAt, T0), null);
});

test('detectCycleClose：resetAt 抖动在容差内 → 同一周期', () => {
  const prev = { remaining: 40, resetAt: '2026-09-01T02:00:00Z' };
  const curr = { remaining: 38, resetAt: '2026-09-01T02:03:00Z' };
  assert.equal(detectCycleClose(prev, curr, T0 - 5 * 60_000, T0), null);
});

test('extractCycles：完整周期被归档，周期末剩余率即浪费率', () => {
  // 一个周期（每 5 分钟一点，最后观测距重置仅 5 分钟，剩余率从 100 降到 33.5），随后新周期从 98 开始
  const beforeReset = weeklyPoints('2026-09-01T02:00:00Z', Array.from({ length: 20 }, (_, i) => 100 - i * 3.5), T0 - 20 * 5 * 60_000);
  const afterReset = weeklyPoints('2026-09-08T02:00:00Z', [98, 97], T0 + 5 * 60_000);
  const cycles = extractCycles([...beforeReset, ...afterReset], ['weekly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].window, 'weekly');
  assert.equal(cycles[0].kind, 'natural');
  assert.equal(cycles[0].end, '2026-09-01T02:00:00.000Z');
  assert.equal(cycles[0].remaining, 100 - 19 * 3.5); // 33.5
  assert.equal(cycles[0].reliable, true); // 最后观测距重置仅 5 分钟
  assert.equal(cycles[0].limit, 3500);
});

test('extractCycles：关机断档导致最后观测过早 → 记录失真（reliable=false）', () => {
  // 最后一条记录距重置 12 小时（远超 2×5 分钟），随后 12 小时后才有新周期的点
  const beforeReset = weeklyPoints('2026-09-01T02:00:00Z', [80, 70, 60, 55], T0 - 12 * H - 15 * 60_000);
  const afterReset = weeklyPoints('2026-09-08T02:00:00Z', [99], T0 + 5 * 60_000);
  const cycles = extractCycles([...beforeReset, ...afterReset], ['weekly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].reliable, false);
  assert.equal(cycles[0].remaining, 55);
  assert.ok(cycles[0].gapMs > 11 * H);
});

test('extractCycles：提前重置的周期标记为 early，新周期从观测点重新起算', () => {
  const reset = '2026-09-08T02:00:00Z';
  const earlyReset = '2026-09-03T02:00:00Z';
  const points = [
    ...weeklyPoints(reset, [90, 80, 78], T0 - 15 * 60_000),
    // resetAt 突然变早 + 剩余率回升：厂商提前清零
    ...weeklyPoints(earlyReset, [97, 95], T0 + 5 * 60_000),
  ];
  const cycles = extractCycles(points, ['weekly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].kind, 'early');
  assert.equal(cycles[0].reliable, false); // early 一律不计入统计
  assert.equal(cycles[0].remaining, 78);
});

test('mergeCycles：按 窗口:类型:结束时间 去重，可安全重复扫描', () => {
  const points = [
    ...weeklyPoints('2026-09-01T02:00:00Z', [90, 60, 40], T0 - 15 * 60_000),
    ...weeklyPoints('2026-09-08T02:00:00Z', [99], T0 + 5 * 60_000),
  ];
  const first = extractCycles(points, ['weekly']);
  const merged = mergeCycles([], first);
  assert.equal(merged.length, 1);
  // 再次扫描同样的历史，不会产生重复档案
  const again = mergeCycles(merged, extractCycles(points, ['weekly']));
  assert.equal(again.length, 1);
});

test('computeWasteStats：失真与提前重置不计入平均和累计', () => {
  const cycles = [
    { window: 'weekly', kind: 'natural', reliable: true, remaining: 30, end: '2026-08-01T00:00:00Z' },
    { window: 'weekly', kind: 'natural', reliable: true, remaining: 10, end: '2026-08-08T00:00:00Z' },
    { window: 'weekly', kind: 'natural', reliable: false, remaining: 90, end: '2026-08-15T00:00:00Z' },
    { window: 'weekly', kind: 'early', reliable: false, remaining: 50, end: '2026-08-20T00:00:00Z' },
    { window: 'monthly', kind: 'natural', reliable: true, remaining: 12, end: '2026-09-01T00:00:00Z' },
  ];
  const stats = computeWasteStats(cycles, 'weekly');
  assert.equal(stats.cycles, 4);
  assert.equal(stats.reliable, 2);
  assert.equal(stats.excluded, 2);
  assert.equal(stats.avgWaste, 20);
  assert.ok(Math.abs(stats.totalWaste - 0.4) < 1e-9);
  assert.equal(computeWasteStats(cycles, 'monthly').avgWaste, 12);
  assert.equal(computeWasteStats([], 'weekly').avgWaste, null);
});

test('resolveWasteWindows：预设优先，缺省取周期类型窗口', () => {
  assert.deepEqual(resolveWasteWindows({ windows: ['five_hour', 'weekly'], wasteWindows: ['weekly'] }), ['weekly']);
  assert.deepEqual(resolveWasteWindows({ windows: ['five_hour', 'weekly'], wasteWindows: [] }), []);
  assert.deepEqual(resolveWasteWindows({ windows: ['five_hour', 'weekly', 'monthly'] }), ['weekly', 'monthly']);
  assert.deepEqual(resolveWasteWindows({ windows: ['balance'] }), []);
  assert.deepEqual(resolveWasteWindows(undefined), []);
});
