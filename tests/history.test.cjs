const test = require('node:test');
const assert = require('node:assert/strict');
const { appendHistoryPoint, pruneHistory, clampRetentionDays, realQuotaPair, snapshotWindows } = require('../electron/history.cjs');

const windows = [
  { key: 'five_hour', remaining: 68, unit: '%', amount: 680, resetAt: null },
  { key: 'weekly', remaining: 42, unit: '%', amount: 4200 },
];

test('realQuotaPair 丢弃 0/0 与纯百分比 100 占位，保留真实总量', () => {
  assert.deepEqual(realQuotaPair(0, 0, '%'), { amount: null, limit: null });
  assert.deepEqual(realQuotaPair(66, 100, '%'), { amount: null, limit: null });
  assert.deepEqual(realQuotaPair(61.9, 120, '%'), { amount: 61.9, limit: 120 });
  assert.deepEqual(realQuotaPair(680, null, '%'), { amount: 680, limit: null });
  assert.deepEqual(realQuotaPair(26.94, 26.94, 'CNY'), { amount: 26.94, limit: 26.94 });
});

test('snapshotWindows 不把 0/0 写进历史', () => {
  const snapped = snapshotWindows([
    { key: 'five_hour', remaining: 49, unit: '%', amount: 0, limitAmount: 0, resetAt: null },
    { key: 'weekly', remaining: 66, unit: '%', amount: 66, limitAmount: 100, resetAt: null },
    { key: 'monthly', remaining: 51.6, unit: '%', amount: 61.9, limitAmount: 120, resetAt: null },
  ]);
  assert.equal(snapped.five_hour.amount, null);
  assert.equal(snapped.five_hour.limit, null);
  assert.equal(snapped.weekly.amount, null);
  assert.equal(snapped.weekly.limit, null);
  assert.deepEqual(snapped.monthly, { remaining: 51.6, amount: 61.9, limit: 120, unit: '%', resetAt: null });
});

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

test('clampRetentionDays 默认 7 天，上限 90 天，0 表示永久', () => {
  assert.equal(clampRetentionDays(undefined), 7);
  assert.equal(clampRetentionDays('abc'), 7);
  assert.equal(clampRetentionDays(0), 0);
  assert.equal(clampRetentionDays(30), 30);
  assert.equal(clampRetentionDays(365), 90);
});

test('pruneHistory 永久保存（0 天）不按时间裁剪，旧数据降采样为每小时一点', () => {
  const now = Date.parse('2026-08-20T08:00:00Z');
  const windowsLocal = [{ key: 'weekly', remaining: 50, unit: '%' }];
  // 60 天前同一小时内 3 个点 + 下一小时 1 个点 + 最近 1 个点
  const old1 = new Date(now - 60 * 86_400_000).toISOString();
  const old2 = new Date(now - 60 * 86_400_000 + 20 * 60_000).toISOString();
  const old3 = new Date(now - 60 * 86_400_000 + 40 * 60_000).toISOString();
  const old4 = new Date(now - 60 * 86_400_000 + 70 * 60_000).toISOString();
  let history = {};
  for (const at of [old1, old2, old3, old4]) history = appendHistoryPoint(history, 'acc-1', windowsLocal, new Date(at).getTime(), 0);
  history = appendHistoryPoint(history, 'acc-1', windowsLocal, now, 0);
  const points = history['acc-1'];
  assert.equal(points.length, 3); // 同小时 3 点降为 1 点 + 下一小时 1 点 + 最近 1 点
  assert.equal(points[0].at, old1);
  assert.equal(points[1].at, old4);
  assert.equal(points[2].at, new Date(now).toISOString());
});

test('appendHistoryPoint 永久保存使用更大的点数上限', () => {
  // 5001 条点：有限保留会裁到 5000，永久保留不裁
  const now = Date.parse('2026-08-20T08:00:00Z');
  const windowsLocal = [{ key: 'weekly', remaining: 50, unit: '%' }];
  let history = {};
  for (let i = 0; i < 5001; i++) history = appendHistoryPoint(history, 'acc-1', windowsLocal, now - (5001 - i) * 61_000, 0);
  assert.ok(history['acc-1'].length > 5000);
});
