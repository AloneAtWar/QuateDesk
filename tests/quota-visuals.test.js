import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalPercent } from '../src/local-cli-usage/local-cli-usage-format.js';

test('tiny positive shares are distinct from actual zero and missing values', () => {
  assert.equal(formatLocalPercent(0), '0.0%');
  assert.equal(formatLocalPercent(0.000001), '<0.1%');
  assert.equal(formatLocalPercent(0.00099), '<0.1%');
  assert.equal(formatLocalPercent(0.001), '0.1%');
  assert.equal(formatLocalPercent(.957), '95.7%');
  assert.equal(formatLocalPercent(1), '100.0%');
  for (const missing of [null, undefined, NaN, 'invalid']) assert.equal(formatLocalPercent(missing), '—');
});
