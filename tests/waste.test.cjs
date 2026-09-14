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
  // 每次轮询 resetAt 都是「现在 + 7 天」，后移 5 分钟在抖动容差内，且旧 resetAt 还没到
  const prev = { remaining: 60, resetAt: new Date(T0 + 7 * D).toISOString() };
  const curr = { remaining: 55, resetAt: new Date(T0 + 7 * D + 5 * 60_000).toISOString() };
  assert.equal(detectCycleClose(prev, curr, T0 - 5 * 60_000, T0), null);
  // 轮询间隔 10 分钟时后移步长也约 10 分钟（超出抖动容差），同样是滑动窗口而非提前重置
  const prev2 = { remaining: 60, resetAt: new Date(T0 + 7 * D).toISOString() };
  const curr2 = { remaining: 55, resetAt: new Date(T0 + 7 * D + 10 * 60_000).toISOString() };
  assert.equal(detectCycleClose(prev2, curr2, T0 - 10 * 60_000, T0), null);
});

test('detectCycleClose：resetAt 变早 → 厂商提前重置', () => {
  const prev = { remaining: 22, resetAt: '2026-09-08T02:00:00Z' };
  const curr = { remaining: 96, resetAt: '2026-09-05T02:00:00Z' };
  const prevAt = T0 - 5 * 60_000;
  const close = detectCycleClose(prev, curr, prevAt, T0);
  assert.deepEqual(close, { kind: 'early', end: prevAt });
});

test('detectCycleClose：resetAt 为数值型毫秒时间戳（Z.ai 场景）→ 照常判定', () => {
  // 9/9 17:57 剩 5%、resetAt=18:00:07；18:02 剩 99%、resetAt 变为下周：旧重置时刻已被跨过 → 自然到期
  const prevAt = Date.parse('2026-09-09T09:57:25Z');
  const currAt = Date.parse('2026-09-09T10:02:25Z');
  const prev = { remaining: 5, resetAt: Date.parse('2026-09-09T10:00:07Z') };
  const curr = { remaining: 99, resetAt: Date.parse('2026-09-16T10:00:07Z') };
  assert.deepEqual(detectCycleClose(prev, curr, prevAt, currAt), { kind: 'natural', end: prev.resetAt });
  // 秒级时间戳同样兼容
  const prevSec = { remaining: 5, resetAt: Math.floor(prev.resetAt / 1000) };
  const currSec = { remaining: 99, resetAt: Math.floor(curr.resetAt / 1000) };
  assert.deepEqual(detectCycleClose(prevSec, currSec, prevAt, currAt).kind, 'natural');
});

test('detectCycleClose：resetAt 没变 → 同一周期，即使剩余率回升也不算重置', () => {
  const reset = '2026-09-08T02:00:00Z';
  const prevAt = T0 - 5 * 60_000;
  assert.equal(detectCycleClose({ remaining: 40, resetAt: reset }, { remaining: 100, resetAt: reset }, prevAt, T0), null);
  assert.equal(detectCycleClose({ remaining: 40, resetAt: reset }, { remaining: 50, resetAt: reset }, prevAt, T0), null);
});

test('detectCycleClose：resetAt 变晚但旧重置时刻还没到 → 提前重置（wlbclub 场景）', () => {
  // 9/13 10:05 检测时说 9/14 重置，9/13 10:10 检测时变成 9/20 重置：两次轮询之间没有跨越 9/14
  const prevAt = Date.parse('2026-09-13T02:05:00Z');
  const currAt = Date.parse('2026-09-13T02:10:00Z');
  const prev = { remaining: 51.6, resetAt: '2026-09-14T02:00:00Z' };
  const curr = { remaining: 100, resetAt: '2026-09-20T02:00:00Z' };
  assert.deepEqual(detectCycleClose(prev, curr, prevAt, currAt), { kind: 'early', end: prevAt });
});

test('detectCycleClose：resetAt 缺失 → 无法判定周期边界，不算结束', () => {
  const prevAt = T0 - 5 * 60_000;
  assert.equal(detectCycleClose({ remaining: 40, resetAt: '2026-09-08T02:00:00Z' }, { remaining: 100, resetAt: null }, prevAt, T0), null);
  assert.equal(detectCycleClose({ remaining: 100, resetAt: null }, { remaining: 99, resetAt: '2026-09-08T02:00:00Z' }, prevAt, T0), null);
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

test('extractCycles：resetAt 在重置瞬间短暂消失 → 桥接后仍能识别自然到期', () => {
  // wlbclub 场景：01:57 时 resetAt=02:00（3 分钟后到期），02:02 resetAt 消失、剩余率回满，02:07 resetAt 变为下周
  const t = (m) => new Date(T0 + m * 60_000).toISOString();
  const point = (m, remaining, resetAt) => ({ at: t(m), windows: { weekly: { remaining, amount: remaining, limit: 100, unit: '%', resetAt } } });
  const points = [
    point(-10, 90, t(0)),
    point(-5, 84.09, t(0)),
    point(0, 100, null),          // 重置瞬间 resetAt 消失
    point(5, 99.8, t(7 * 24 * 60)), // 恢复后 resetAt 指向下一周期
  ];
  const cycles = extractCycles(points, ['weekly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].kind, 'natural');
  assert.equal(cycles[0].end, t(0));
  assert.equal(cycles[0].remaining, 84.09);
});

test('extractCycles：resetAt 消失后直到历史末尾都没恢复 → 消失本身视为周期结束', () => {
  const t = (m) => new Date(T0 + m * 60_000).toISOString();
  const point = (m, remaining, resetAt) => ({ at: t(m), windows: { weekly: { remaining, amount: remaining, limit: 100, unit: '%', resetAt } } });
  // 旧重置时刻（T0）在消失前已被跨过 → 自然到期
  const natural = extractCycles([point(-10, 90, t(0)), point(-5, 80, t(0)), point(5, 100, null), point(10, 100, null)], ['weekly']);
  assert.equal(natural.length, 1);
  assert.equal(natural[0].kind, 'natural');
  assert.equal(natural[0].end, t(0));
  assert.equal(natural[0].remaining, 80);
  // 旧重置时刻还没到就消失了 → 提前重置，end ≈ 最后一次带 resetAt 的观测
  const early = extractCycles([point(-10, 90, t(7 * 24 * 60)), point(-5, 80, t(7 * 24 * 60)), point(0, 100, null)], ['weekly']);
  assert.equal(early.length, 1);
  assert.equal(early[0].kind, 'early');
  assert.equal(early[0].end, t(-5));
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

test('extractCycles：0/0 与 limit=100 的百分比占位不写入档案', () => {
  const t = (m) => new Date(T0 + m * 60_000).toISOString();
  const after = { at: t(10), windows: { weekly: { remaining: 99, amount: 0, limit: 0, unit: '%', resetAt: t(7 * 24 * 60) } } };
  const zero = extractCycles([
    { at: t(-10), windows: { weekly: { remaining: 5, amount: 0, limit: 0, unit: '%', resetAt: t(0) } } },
    { at: t(-5), windows: { weekly: { remaining: 5, amount: 0, limit: 0, unit: '%', resetAt: t(0) } } },
    after,
  ], ['weekly']);
  assert.equal(zero.length, 1);
  assert.equal(zero[0].amount, null);
  assert.equal(zero[0].limit, null);
  const pct = extractCycles([
    { at: t(-10), windows: { weekly: { remaining: 66, amount: 66, limit: 100, unit: '%', resetAt: t(0) } } },
    { at: t(-5), windows: { weekly: { remaining: 66, amount: 66, limit: 100, unit: '%', resetAt: t(0) } } },
    after,
  ], ['weekly']);
  assert.equal(pct[0].amount, null);
  assert.equal(pct[0].limit, null);
});

test('resolveWasteWindows：预设优先，缺省取周期类型窗口', () => {
  assert.deepEqual(resolveWasteWindows({ windows: ['five_hour', 'weekly'], wasteWindows: ['weekly'] }), ['weekly']);
  assert.deepEqual(resolveWasteWindows({ windows: ['five_hour', 'weekly'], wasteWindows: [] }), []);
  assert.deepEqual(resolveWasteWindows({ windows: ['five_hour', 'weekly', 'monthly'] }), ['weekly', 'monthly']);
  assert.deepEqual(resolveWasteWindows({ windows: ['balance'] }), []);
  assert.deepEqual(resolveWasteWindows(undefined), []);
});
