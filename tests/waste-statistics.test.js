import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accountWasteWindows, buildWasteReport, createWasteRange, loadWasteArchives, wasteWindowLabel } from '../src/waste-statistics.js';

const now = new Date(2026, 9, 8, 12, 40);
const range = createWasteRange(1, now);
const providers = [{ id: 'claude', requestConfig: { windows: ['five_hour', 'weekly', 'monthly'], wasteWindows: ['weekly', 'monthly'] } }];
const accounts = [{ id: 'main', providerId: 'claude', windowKeys: ['weekly', 'monthly'] }, { id: 'disabled', providerId: 'claude', status: 'disabled', windowKeys: ['weekly'] }];
const cycle = (date, remaining, extra = {}) => ({ window: 'weekly', end: new Date(2026, 8, date, 12).toISOString(), from: new Date(2026, 8, date - 7, 12).toISOString(), remaining, reliable: true, kind: 'natural', ...extra });
const reportFor = (archives, extra = {}) => buildWasteReport({ accounts, providers, archives, windowKey: 'weekly', range, ...extra });

test('one month covers every date exactly once in four consecutive segments', () => {
  assert.deepEqual(range.buckets.map((bucket) => bucket.dateLabel), ['09/08–09/15', '09/16–09/23', '09/24–10/01', '10/02–10/08']);
  assert.equal(range.buckets[0].start, range.start);
  assert.equal(range.buckets.at(-1).endExclusive, now.getTime() + 1);
  range.buckets.slice(1).forEach((bucket, index) => assert.equal(bucket.start, range.buckets[index].endExclusive));
  for (let date = new Date(range.start); date <= now; date.setDate(date.getDate() + 1)) {
    assert.equal(range.buckets.filter((bucket) => date >= bucket.start && date < bucket.endExclusive).length, 1);
  }
});

test('longer ranges have exactly one bar per rolling month', () => {
  for (const months of [3, 6, 12]) {
    const result = createWasteRange(months, now);
    assert.equal(result.buckets.length, months);
    assert.equal(new Date(result.start).getDate(), 8);
    assert.equal(result.buckets.at(-1).endExclusive, now.getTime() + 1);
    result.buckets.slice(1).forEach((bucket, index) => assert.equal(bucket.start, result.buckets[index].endExclusive));
  }
});

test('month-end clamps and leap years do not skip days or drift', () => {
  const march = createWasteRange(1, new Date(2024, 2, 31, 12));
  assert.equal(new Date(march.start).getMonth(), 1);
  assert.equal(new Date(march.start).getDate(), 29);
  const three = createWasteRange(3, new Date(2026, 4, 31, 12));
  assert.deepEqual(three.buckets.map((bucket) => new Date(bucket.start).getDate()), [28, 31, 30]);
  assert.equal(three.buckets.at(-1).dateLabel, '04/30–05/31');
  assert.match(createWasteRange(12, now).dateLabel, /2025\/10\/08–2026\/10\/08/);
});

test('calendar segmentation remains contiguous across daylight-saving changes', () => {
  const moduleUrl = new URL('../src/waste-statistics.js', import.meta.url).href;
  const source = `import { createWasteRange } from ${JSON.stringify(moduleUrl)};
    const range = createWasteRange(1, new Date(2026, 2, 20, 12));
    console.log(JSON.stringify(range.buckets.map(b => [new Date(b.start).getHours(), b.dateLabel, b.start, b.endExclusive])));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  const buckets = JSON.parse(output);
  assert.equal(buckets.length, 4);
  buckets.forEach((bucket) => assert.equal(bucket[0], 0));
  buckets.slice(1).forEach((bucket, index) => assert.equal(bucket[2], buckets[index][3]));
});

test('different account cycles are grouped by actual end date; boundary records belong to one bucket', () => {
  const atBoundary = { ...cycle(16, 60), end: new Date(range.buckets[1].start).toISOString() };
  const report = reportFor({ main: [cycle(10, 40), atBoundary], disabled: [cycle(23, 20)] });
  assert.equal(report.count, 3);
  assert.deepEqual(report.buckets.map((bucket) => bucket.count), [1, 2, 0, 0]);
  assert.equal(report.buckets.reduce((sum, bucket) => sum + (bucket.total || 0), 0), report.total);
  assert.equal(report.buckets[1].accounts.find((account) => account.accountId === 'disabled').total, .2);
});

test('only reliable natural cycles count, including valid zero-waste cycles in the average', () => {
  const report = reportFor({ main: [cycle(10, 80), cycle(12, 0), cycle(15, 90, { reliable: false }), cycle(20, 50, { kind: 'early' }), cycle(22, null), cycle(23, 'bad')] });
  assert.equal(report.total, .8);
  assert.equal(report.average, 40);
  assert.equal(report.count, 2);
  assert.equal(report.excluded.length, 4);
  assert.equal(report.accounts[0].cycles.length, 6);
});

test('no reliable records is unknown, while a confirmed zero cycle is zero', () => {
  const unknown = reportFor({ main: [cycle(12, 60, { reliable: false })] });
  assert.equal(unknown.total, null);
  assert.equal(unknown.average, null);
  assert.equal(unknown.count, 0);
  const zero = reportFor({ main: [cycle(12, 0)] });
  assert.equal(zero.total, 0);
  assert.equal(zero.average, 0);
  assert.equal(zero.count, 1);
  assert.deepEqual(zero.accounts, []);
});

test('account contribution shares match normalized totals rather than nominal account limits', () => {
  const report = reportFor({ main: [cycle(10, 50, { limit: 100 }), cycle(17, 50, { limit: 100 })], disabled: [cycle(19, 50, { limit: 1000000 })] });
  assert.equal(report.total, 1.5);
  assert.equal(report.average, 50);
  assert.equal(report.accounts[0].accountId, 'main');
  assert.ok(Math.abs(report.accounts[0].share - 100 * 2 / 3) < 1e-10);
  assert.ok(Math.abs(report.accounts.reduce((sum, account) => sum + account.share, 0) - 100) < 1e-10);
});

test('weekly and monthly dimensions stay separate and honor tracked/configured windows', () => {
  const archives = { main: [cycle(10, 40), cycle(12, 90, { window: 'monthly' })], disabled: [cycle(15, 70, { window: 'monthly' })] };
  assert.equal(reportFor(archives).total, .4);
  assert.equal(reportFor(archives, { windowKey: 'monthly' }).total, .9);
  assert.deepEqual(accountWasteWindows({ ...accounts[0], wasteWindows: [] }, providers[0]), []);
  assert.deepEqual(accountWasteWindows({ ...accounts[0], windowKeys: ['weekly'], wasteWindows: ['weekly', 'monthly'] }, providers[0]), ['weekly']);
  assert.equal(reportFor(archives, { providers: [{ ...providers[0], requestConfig: { wasteWindows: [] } }] }).total, null);
});

test('Antigravity pool windows join the weekly dimension automatically, one share per pool cycle', () => {
  const agyProvider = { id: 'antigravity', requestConfig: { windows: ['agy_gemini_5h', 'agy_gemini_7d', 'agy_claudegpt_5h', 'agy_claudegpt_7d'] } };
  // CLI 专属适配不受 windowKeys 过滤：动态特例池只出现在实时窗口里，也要自动纳入
  const agyAccount = {
    id: 'agy', providerId: 'antigravity',
    windowKeys: ['agy_gemini_5h', 'agy_gemini_7d', 'agy_claudegpt_5h', 'agy_claudegpt_7d'],
    windows: [
      { key: 'agy_gemini_5h' }, { key: 'agy_gemini_7d' }, { key: 'agy_claudegpt_5h' },
      { key: 'agy_claudegpt_7d' }, { key: 'agy_pool_gemini-4-argon_7d' },
    ],
  };
  // 自动判定 = 配置窗口 ∪ 实时窗口里的周期键；5h 池不参与
  assert.deepEqual(accountWasteWindows(agyAccount, agyProvider), ['agy_gemini_7d', 'agy_claudegpt_7d', 'agy_pool_gemini-4-argon_7d']);
  // 免费档没有 Gemini 周池：静态配置键仍在候选（升级出池后无需改配置），
  // 动态特例池不会凭空出现；没有周期数据的候选不会产生任何统计
  const freeAccount = { ...agyAccount, windows: [{ key: 'agy_claudegpt_5h' }, { key: 'agy_claudegpt_7d' }, { key: 'agy_gemini_5h' }] };
  assert.deepEqual(accountWasteWindows(freeAccount, agyProvider), ['agy_gemini_7d', 'agy_claudegpt_7d']);
  // 显式预设只统计勾选的池
  assert.deepEqual(accountWasteWindows({ ...agyAccount, wasteWindows: ['agy_gemini_7d'] }, agyProvider), ['agy_gemini_7d']);

  const archives = { agy: [cycle(10, 40, { window: 'agy_gemini_7d' }), cycle(12, 30, { window: 'agy_pool_gemini-4-argon_7d' }), cycle(23, 20, { window: 'agy_claudegpt_7d' })] };
  // weekly 口径把池周期并入：每个池的周期各记 1 份
  const report = buildWasteReport({ accounts: [agyAccount], providers: [agyProvider], archives, windowKey: 'weekly', range });
  assert.equal(report.count, 3);
  assert.equal(report.total, .9);
  assert.equal(report.accounts[0].count, 3);
  // monthly 口径不含池周期
  assert.equal(buildWasteReport({ accounts: [agyAccount], providers: [agyProvider], archives, windowKey: 'monthly', range }).count, 0);
});

test('out-of-range, future, malformed and duplicate cycles never inflate totals', () => {
  const valid = cycle(10, 40);
  const report = reportFor({ main: [valid, { ...valid }, cycle(1, 100), cycle(10, 100, { end: new Date(now.getTime() + 1).toISOString() }), cycle(11, 100, { end: 'invalid' }), cycle(12, 1000)] });
  assert.equal(report.total, .4);
  assert.equal(report.count, 1);
  assert.equal(report.excluded.length, 1);
});

test('the selected bucket has account details without changing the global summary', () => {
  const report = reportFor({ main: [cycle(10, 80), cycle(24, 20)], disabled: [cycle(25, 60)] });
  const selected = report.buckets[2];
  assert.equal(selected.total, .8);
  assert.equal(selected.accounts[0].accountId, 'disabled');
  assert.ok(Math.abs(selected.accounts[0].share - 75) < 1e-10);
  assert.equal(report.total, 1.6);
  assert.equal(report.count, 3);
});

test('a refresh within the same day preserves bucket selection identifiers', () => {
  const later = createWasteRange(1, new Date(2026, 9, 8, 23, 59));
  assert.deepEqual(later.buckets.map((bucket) => bucket.id), range.buckets.map((bucket) => bucket.id));
});

test('wasteWindowLabel resolves catalog entries first and prettifies dynamic pool keys', () => {
  assert.equal(wasteWindowLabel('weekly'), '7 天');
  assert.equal(wasteWindowLabel('agy_gemini_7d'), 'Gemini 池 7d');
  assert.equal(wasteWindowLabel('agy_claudegpt_7d'), 'Claude/GPT 7d');
  // 动态特例池不在目录里：从 key 还原可读名
  assert.equal(wasteWindowLabel('agy_pool_gemini-4-argon_7d'), 'Gemini 4 Argon 7d');
  assert.equal(wasteWindowLabel('other'), 'other');
});

test('loading archives fails as a whole when one account cannot be read', async () => {
  await assert.rejects(loadWasteArchives({ getCycles: async (id) => id === 'disabled' ? Promise.reject(new Error('offline')) : [cycle(10, 40)] }, ['main', 'disabled']), /offline/);
  await assert.rejects(loadWasteArchives({ getCycles: async () => null }, ['main']), /格式/);
  await assert.rejects(loadWasteArchives(null, ['main']), /无法读取/);
  assert.deepEqual(await loadWasteArchives({ getCycles: async () => [] }, ['main', 'disabled']), { main: [], disabled: [] });
});
