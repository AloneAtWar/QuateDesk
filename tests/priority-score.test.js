import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampRemainingWeight, remainingPct, priorityScore, comparePriority, WINDOW_HOURS,
} from '../src/priority-score.js';

const NOW = Date.parse('2026-09-19T12:00:00+08:00');
const hoursFrom = (hours) => new Date(NOW + hours * 3_600_000).toISOString();
const meter = (key, remaining, hours, extra = {}) => ({
  key, remaining, resetAt: hours == null ? null : hoursFrom(hours), available: true, ...extra,
});
const row = (name, item) => ({ account: { name }, meter: item });
const order = (rows, weights) => [...rows].sort((a, b) => comparePriority(a, b, weights, NOW)).map((item) => item.account.name);

test('clampRemainingWeight 缺省与越界都收到 0–100', () => {
  assert.equal(clampRemainingWeight(undefined), 0);
  assert.equal(clampRemainingWeight(-8), 0);
  assert.equal(clampRemainingWeight(140), 100);
  assert.equal(clampRemainingWeight(70.4), 70);
});

test('remainingPct 把 remaining 收成 0–100', () => {
  assert.equal(remainingPct({ remaining: 83 }), 83);
  assert.equal(remainingPct({ remaining: 140 }), 100);
  assert.equal(remainingPct({ remaining: -2 }), 0);
  assert.equal(remainingPct({}), 0);
});

test('默认剩余 0%：同周期只按距重置从近到远，剩余再高也压不过更近的', () => {
  const names = order([
    row('full-later', meter('five_hour', 100, 4)),
    row('empty-soon', meter('five_hour', 10, 0.2)),
    row('mid', meter('five_hour', 50, 2)),
  ], { fiveHourRemaining: 0, otherRemaining: 0 });
  assert.deepEqual(names, ['empty-soon', 'mid', 'full-later']);
});

test('默认权重下超过一个周期的重置排在周期末之后', () => {
  const onTime = priorityScore(meter('five_hour', 100, WINDOW_HOURS.five_hour), { fiveHourRemaining: 0 }, NOW);
  const overtime = priorityScore(meter('five_hour', 100, 6), { fiveHourRemaining: 0 }, NOW);
  assert.ok(onTime > overtime);
});

test('5h 剩余 70%：满额还剩 1 小时压过 90% 还剩 30 分钟', () => {
  const weights = { fiveHourRemaining: 70, otherRemaining: 0 };
  const full = priorityScore(meter('five_hour', 100, 1), weights, NOW);
  const highSoon = priorityScore(meter('five_hour', 90, 0.5), weights, NOW);
  assert.ok(full > highSoon);
});

test('非 5h 剩余 40%：快到期即使剩余少也压过刚开周期的满额', () => {
  const weights = { fiveHourRemaining: 0, otherRemaining: 40 };
  const soon = priorityScore(meter('weekly', 20, 2), weights, NOW);
  const fresh = priorityScore(meter('weekly', 100, WINDOW_HOURS.weekly), weights, NOW);
  assert.ok(soon > fresh);
});

test('5h 与非 5h 使用各自的剩余占比', () => {
  const weights = { fiveHourRemaining: 70, otherRemaining: 0 };
  const fiveHourSoonLow = priorityScore(meter('five_hour', 10, 0.2), weights, NOW);
  const fiveHourFullLate = priorityScore(meter('five_hour', 100, 4), weights, NOW);
  const weeklySoonLow = priorityScore(meter('weekly', 10, 0.2), weights, NOW);
  const weeklyFullLate = priorityScore(meter('weekly', 100, 4), weights, NOW);
  assert.ok(fiveHourFullLate > fiveHourSoonLow);
  assert.ok(weeklySoonLow > weeklyFullLate);
});

test('不可用窗口排到最后', () => {
  const names = order([
    row('ok', meter('five_hour', 40, 3)),
    row('down', meter('five_hour', 100, 0.1, { available: false })),
  ], { fiveHourRemaining: 0 });
  assert.deepEqual(names, ['ok', 'down']);
});
