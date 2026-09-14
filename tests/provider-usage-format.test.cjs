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
