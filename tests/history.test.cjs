const test = require('node:test');
const assert = require('node:assert/strict');
const { appendHistoryPoint, pruneHistory, clampRetentionDays } = require('../electron/history.cjs');

const windows = [
  { key: 'five_hour', remaining: 68, unit: '%', amount: 680, resetAt: null },
  { key: 'weekly', remaining: 42, unit: '%', amount: 4200 },
];

test('appendHistoryPoint 追加快照并只保留画图字段', () => {
  const history = appendHistoryPoint({}, 'acc-1', windows, Date.parse('2026-08-20T08:00:00Z'));
  assert.equal(history['acc-1'].length, 1);
  assert.equal(history['acc-1'][0].at, '2026-08-20T08:00:00.000Z');
  assert.deepEqual(history['acc-1'][0].windows.five_hour, { remaining: 68, amount: 680, limit: null, unit: '%', resetAt: null });
  assert.equal(history['acc-1'][0].windows.five_hour.resetAt, null);
});

test('appendHistoryPoint 一分钟内的重复记录会被覆盖而不是堆叠', () => {
  const t0 = Date.parse('2026-08-20T08:00:00Z');
  let history = appendHistoryPoint({}, 'acc-1', windows, t0);
  history = appendHistoryPoint(history, 'acc-1', [{ key: 'five_hour', remaining: 10, unit: '%' }], t0 + 30_000);
  assert.equal(history['acc-1'].length, 1);
  assert.equal(history['acc-1'][0].windows.five_hour.remaining, 10);
  history = appendHistoryPoint(history, 'acc-1', windows, t0 + 30_000 + 61_000);
  assert.equal(history['acc-1'].length, 2);
});

test('appendHistoryPoint 忽略空窗口或空账号', () => {
  assert.deepEqual(appendHistoryPoint({}, 'acc-1', [], Date.now()), {});
  assert.deepEqual(appendHistoryPoint({}, '', windows, Date.now()), {});
});

test('appendHistoryPoint 追加时按保留天数裁剪旧数据', () => {
  const now = Date.parse('2026-08-20T08:00:00Z');
  const old = appendHistoryPoint({}, 'acc-1', windows, now - 10 * 86_400_000);
  const history = appendHistoryPoint(old, 'acc-1', windows, now, 7);
  assert.equal(history['acc-1'].length, 1);
  assert.equal(history['acc-1'][0].at, new Date(now).toISOString());
});

test('pruneHistory 清理过期数据与已删除账号', () => {
  const now = Date.parse('2026-08-20T08:00:00Z');
  const history = {
    keep: [{ at: new Date(now - 2 * 86_400_000).toISOString(), windows: {} }],
    expired: [{ at: new Date(now - 30 * 86_400_000).toISOString(), windows: {} }],
    removed: [{ at: new Date(now).toISOString(), windows: {} }],
  };
  const pruned = pruneHistory(history, 7, now, new Set(['keep', 'expired']));
  assert.deepEqual(Object.keys(pruned), ['keep']);
});

test('clampRetentionDays 默认 7 天，上限 90 天', () => {
  assert.equal(clampRetentionDays(undefined), 7);
  assert.equal(clampRetentionDays('abc'), 7);
  assert.equal(clampRetentionDays(0), 7);
  assert.equal(clampRetentionDays(30), 30);
  assert.equal(clampRetentionDays(365), 90);
});
