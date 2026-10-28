const test = require('node:test');
const assert = require('node:assert/strict');
const { RESET_ALIGNED_BUFFER_MS, nextResetAlignedAt, dueResetAlignedAccounts } = require('../electron/reset-aligned.cjs');

const account = (id, resetAtList, extra = {}) => ({ id, windows: resetAtList.map((resetAt) => ({ key: 'five_hour', resetAt })), ...extra });

test('nextResetAlignedAt：取所有未停用账号最近的未来重置点并加缓冲', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  const state = {
    accounts: [
      account('a', ['2026-10-28T11:00:00Z', '2026-10-28T15:00:00Z']),
      account('b', ['2026-10-28T12:00:00Z']),
      account('disabled-one', ['2026-10-28T10:30:00Z'], { disabled: true }),
      account('c', [null, 'invalid-date', '2026-10-28T09:59:00Z']), // 缺失 / 无法解析 / 已过期
    ],
  };
  const next = nextResetAlignedAt(state, now);
  assert.ok(next, '存在未来重置点');
  assert.equal(next.at - Date.parse('2026-10-28T11:00:00Z'), RESET_ALIGNED_BUFFER_MS, '最早的未来重置 + 45 秒缓冲');
  assert.equal(nextResetAlignedAt({ accounts: [account('a', ['2026-10-28T09:00:00Z'])] }, now), null, '全部已过期 → 不调度');
  assert.equal(nextResetAlignedAt({ accounts: [] }, now), null, '无账号 → 不调度');
  assert.equal(nextResetAlignedAt({}, now), null, '空状态 → 不调度');
});

test('dueResetAlignedAccounts：点名「刚重置」的账号，跳过未重置 / 远古 / 停用', () => {
  const now = Date.parse('2026-10-28T10:00:30Z');
  const state = {
    accounts: [
      account('just-reset', ['2026-10-28T10:00:00Z']), // 30 秒前刚重置
      account('not-yet', ['2026-10-28T10:05:00Z']), // 还没到点
      account('ancient', ['2026-10-28T06:00:00Z']), // 4 小时前，超出视野
      account('disabled-one', ['2026-10-28T10:00:00Z'], { disabled: true }),
    ],
  };
  assert.deepEqual(dueResetAlignedAccounts(state, now), ['just-reset']);
  assert.deepEqual(dueResetAlignedAccounts({ accounts: [] }, now), []);
});

test('点名后新数据指向下一周期：resetAt 翻到未来后不再点名（不形成循环）', () => {
  const resetAt = '2026-10-28T10:00:00Z';
  const afterReset = Date.parse('2026-10-28T10:00:45Z');
  // 点名前：resetAt 刚过 → 在点名名单里，且会被调度
  assert.deepEqual(dueResetAlignedAccounts({ accounts: [account('a', [resetAt])] }, afterReset), ['a']);
  assert.ok(nextResetAlignedAt({ accounts: [account('a', [resetAt])] }, afterReset) === null, '已过期的重置点不再触发新调度');
  // 点名拉取成功后：新窗口的 resetAt 指向未来 → 不再点名，转而调度下一个重置点
  const refreshed = account('a', ['2026-10-28T15:00:00Z']);
  assert.deepEqual(dueResetAlignedAccounts({ accounts: [refreshed] }, afterReset), []);
  assert.ok(nextResetAlignedAt({ accounts: [refreshed] }, afterReset), '下一个重置点照常调度');
});
