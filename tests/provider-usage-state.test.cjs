const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeMainOwnedUsageConnections } = require('../electron/provider-usage-state.cjs');

test('renderer state saves preserve the latest main-owned usage connection', () => {
  const connected = { provider: 'deepseek', status: 'connected', revision: 3 };
  const current = {
    accounts: [{ id: 'deepseek-1', name: 'Before', usageConnection: connected }],
    settings: { theme: 'dark' },
  };
  const incoming = {
    accounts: [{ id: 'deepseek-1', name: 'After', usageConnection: { status: 'reauth_required' } }],
    settings: { theme: 'light' },
  };

  assert.deepEqual(mergeMainOwnedUsageConnections(incoming, current), {
    accounts: [{ id: 'deepseek-1', name: 'After', usageConnection: connected }],
    settings: { theme: 'light' },
  });
});

test('renderer state saves cannot resurrect or invent a usage connection', () => {
  const incoming = {
    accounts: [
      { id: 'disconnected', name: 'Existing', usageConnection: { status: 'connected' } },
      { id: 'new-account', name: 'New', usageConnection: { status: 'connected' } },
    ],
  };
  const current = { accounts: [{ id: 'disconnected', name: 'Existing' }] };

  assert.deepEqual(mergeMainOwnedUsageConnections(incoming, current).accounts, [
    { id: 'disconnected', name: 'Existing' },
    { id: 'new-account', name: 'New' },
  ]);
});

test('renderer account deletion remains a deletion while other state is retained', () => {
  const incoming = { accounts: [], settings: { pollMinutes: 10 } };
  const current = { accounts: [{ id: 'removed', usageConnection: { status: 'connected' } }] };

  assert.deepEqual(mergeMainOwnedUsageConnections(incoming, current), incoming);
});
