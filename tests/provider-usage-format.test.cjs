const test = require('node:test');
const assert = require('node:assert/strict');

test('provider usage summary compacts large CNY amounts without changing the exact formatter', async () => {
  const { formatProviderUsageCost, formatProviderUsageSummaryCost } = await import('../src/provider-usage-format.js');

  assert.equal(formatProviderUsageSummaryCost(4_030_000_000, 'CNY'), '¥40.3 亿');
  assert.equal(formatProviderUsageCost(4_030_000_000, 'CNY'), '¥4,030,000,000.00');
});

test('provider usage summary keeps ordinary and fractional costs exact', async () => {
  const { formatProviderUsageSummaryCost } = await import('../src/provider-usage-format.js');

  assert.equal(formatProviderUsageSummaryCost(4_030, 'CNY'), '¥4,030.00');
  assert.equal(formatProviderUsageSummaryCost(0.125, 'CNY'), '¥0.125');
  assert.equal(formatProviderUsageSummaryCost(null, 'CNY'), '—');
});

test('provider usage summary respects other currency symbols', async () => {
  const { formatProviderUsageSummaryCost } = await import('../src/provider-usage-format.js');

  assert.equal(formatProviderUsageSummaryCost(4_030_000_000, 'USD'), '$40.3 亿');
});

test('computeUsageStreaks counts current and longest streaks from daily activity', async () => {
  const { computeUsageStreaks } = await import('../src/provider-usage-format.js');
  const days = [
    { date: '2026-09-08', tokens: 100 },
    { date: '2026-09-09', tokens: 0 },
    { date: '2026-09-10', tokens: 5 },
    { date: '2026-09-11', tokens: 6 },
    { date: '2026-09-12', tokens: 0 },
    { date: '2026-09-13', tokens: 1 },
    { date: '2026-09-14', tokens: 2 },
    { date: '2026-09-15', tokens: 3 },
  ];
  assert.deepEqual(computeUsageStreaks(days), { current: 3, longest: 3 });
});

test('computeUsageStreaks starts from yesterday when today has no usage yet', async () => {
  const { computeUsageStreaks } = await import('../src/provider-usage-format.js');
  const days = [
    { date: '2026-09-12', tokens: 0 },
    { date: '2026-09-13', cost: 1.5 },
    { date: '2026-09-14', cost: 2 },
    { date: '2026-09-15', tokens: 0, cost: 0 },
  ];
  assert.deepEqual(computeUsageStreaks(days), { current: 2, longest: 2 });
});

test('computeUsageStreaks treats uncovered days as inactive and handles empty input', async () => {
  const { computeUsageStreaks } = await import('../src/provider-usage-format.js');
  assert.deepEqual(computeUsageStreaks([]), { current: null, longest: null });
  assert.deepEqual(computeUsageStreaks([
    { date: '2026-09-13', tokens: 1 },
    { date: '2026-09-14', tokens: null },
    { date: '2026-09-15', tokens: 5 },
  ]), { current: 1, longest: 1 });
});
