import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRefreshQueues, getUpcomingRefreshItems } from '../src/upcoming-refresh.js';

const meter = (key, resetAt) => ({ key, resetAt, remaining: 50, unit: '%' });

test('omits every cycle when there are no upcoming accounts', () => {
  assert.deepEqual(buildRefreshQueues(), []);
});

test('only returns populated cycles in cycle order', () => {
  const accounts = [{ id: 'a', windows: [meter('monthly', '2026-11-01T00:00:00Z'), meter('five_hour', '2026-10-18T13:00:00Z')] }];
  assert.deepEqual(buildRefreshQueues(accounts).map(({ key }) => key), ['five_hour', 'monthly']);
  accounts[0].windows = [meter('monthly', '2026-11-01T00:00:00Z')];
  assert.deepEqual(buildRefreshQueues(accounts).map(({ key }) => key), ['monthly']);
});

test('groups by cycle and sorts each queue by reset time without changing account data', () => {
  const accounts = [
    { id: 'a', windows: [meter('five_hour', '2026-10-18T12:00:00Z'), meter('weekly', '2026-10-20T00:00:00Z'), meter('monthly', '2026-10-18T11:00:00Z')] },
    { id: 'b', windows: [meter('five_hour', '2026-10-18T11:00:00Z'), meter('weekly', '2026-10-19T00:00:00Z')] },
    { id: 'c', windows: [meter('monthly', '2026-11-01T00:00:00Z')] },
  ];
  const before = structuredClone(accounts);
  const queues = buildRefreshQueues(accounts);
  assert.deepEqual(queues.map(({ items }) => items.map(({ account }) => account.id)), [['b', 'a'], ['b', 'a'], ['a', 'c']]);
  assert.deepEqual(accounts, before);
  assert.equal(queues[0].items[0].account, accounts[1]);
  assert.equal(queues[2].items[0].meter, accounts[0].windows[2]);
});

test('ignores disabled accounts, unsupported cycles and missing or invalid reset times', () => {
  const queues = buildRefreshQueues([
    { id: 'disabled', disabled: true, windows: [meter('five_hour', '2026-10-18T12:00:00Z')] },
    { id: 'empty' },
    { id: 'active', windows: [meter('five_hour', null), meter('weekly', 'invalid'), meter('monthly', ''), meter('daily', '2026-10-18T12:00:00Z'), meter('balance', '2026-10-18T12:00:00Z')] },
  ]);
  assert.deepEqual(queues, []);
});

test('retains exhausted and elapsed windows until the next account update', () => {
  const exhausted = { ...meter('weekly', '2026-10-17T12:00:00Z'), remaining: 0 };
  const queues = buildRefreshQueues([{ id: 'a', windows: [exhausted] }]);
  assert.equal(queues[0].key, 'weekly');
  assert.equal(queues[0].items[0].meter, exhausted);
});

test('collapsed queue retains all original cycles in one timeline', () => {
  const accounts = [
    { id: 'a', windows: [meter('monthly', '2026-11-01T00:00:00Z'), meter('five_hour', '2026-10-18T13:00:00Z')] },
    { id: 'b', windows: [meter('daily', '2026-10-19T00:00:00Z'), meter('yearly', '2027-01-01T00:00:00Z'), meter('weekly', '2026-10-20T00:00:00Z')] },
    { id: 'disabled', disabled: true, windows: [meter('five_hour', '2026-10-18T12:00:00Z')] },
  ];
  assert.deepEqual(getUpcomingRefreshItems(accounts).map(({ meter }) => meter.key), ['five_hour', 'daily', 'weekly', 'monthly', 'yearly']);
  assert.deepEqual(buildRefreshQueues(accounts).flatMap(({ items }) => items).map(({ meter }) => meter.key), ['five_hour', 'weekly', 'monthly']);
});
