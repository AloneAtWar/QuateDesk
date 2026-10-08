import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accountWasteWindows, buildWasteReport, createWasteRange, loadWasteArchives } from '../src/waste-statistics.js';

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

test('loading archives fails as a whole when one account cannot be read', async () => {
  await assert.rejects(loadWasteArchives({ getCycles: async (id) => id === 'disabled' ? Promise.reject(new Error('offline')) : [cycle(10, 40)] }, ['main', 'disabled']), /offline/);
  await assert.rejects(loadWasteArchives({ getCycles: async () => null }, ['main']), /格式/);
  await assert.rejects(loadWasteArchives(null, ['main']), /无法读取/);
  assert.deepEqual(await loadWasteArchives({ getCycles: async () => [] }, ['main', 'disabled']), { main: [], disabled: [] });
});
