import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaColor } from '../src/quota-colors.js';
import { formatLocalPercent } from '../src/local-cli-usage/local-cli-usage-format.js';

test('cycle identity keeps the same color across account combinations and sorting', () => {
  for (const cycles of [['monthly', 'weekly', 'five_hour'], ['weekly', 'five_hour'], ['five_hour']]) {
    assert.equal(quotaColor(cycles.find((key) => key === 'five_hour')), 'var(--cyan)');
  }
  assert.equal(quotaColor('weekly'), 'var(--violet)');
  assert.equal(quotaColor('monthly'), 'var(--coral)');
  assert.equal(quotaColor('yearly'), 'var(--amber)');
});

test('unknown cycle keys get a stable CSS color, including object property names', () => {
  const custom = quotaColor('custom-window');
  quotaColor('unrelated-window');
  assert.equal(quotaColor('custom-window'), custom);
  assert.match(quotaColor('constructor'), /^var\(--[a-z-]+\)$/);
});

test('tiny positive shares are distinct from actual zero and missing values', () => {
  assert.equal(formatLocalPercent(0), '0.0%');
  assert.equal(formatLocalPercent(0.000001), '<0.1%');
  assert.equal(formatLocalPercent(0.00099), '<0.1%');
  assert.equal(formatLocalPercent(0.001), '0.1%');
  assert.equal(formatLocalPercent(.957), '95.7%');
  assert.equal(formatLocalPercent(1), '100.0%');
  for (const missing of [null, undefined, NaN, 'invalid']) assert.equal(formatLocalPercent(missing), '—');
});
