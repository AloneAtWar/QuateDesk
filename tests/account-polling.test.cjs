const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the main-process polling flow without starting Electron or accessing real accounts.
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const mergeSource = source.slice(source.indexOf('const mergePolledAccounts ='), source.indexOf('// MiMo 额度轮询'));
const pollSource = source.slice(source.indexOf('async function pollState('), source.indexOf('\nfunction schedulePolling('));

function harness(accounts, query) {
  let state = { accounts, providers: [{ id: 'provider' }], settings: {} };
  const history = [];
  const broadcasts = [];
  const context = vm.createContext({
    store: {
      loadState: () => state,
      saveState: (next) => { state = next; },
      getSecrets: () => ({}),
      appendHistory: (id) => history.push(id),
      archiveCycles: () => {},
    },
    migrateState: (value) => value,
    cleanState: (value) => value,
    sendState: (value) => broadcasts.push(value),
    queryAccountWithSilentRenewal: query,
    cliIdentityPatch: () => null,
    historyRetentionDays: () => 30,
    resolveWasteWindows: () => [],
    notifyWaste: () => {},
    authStatusForPollError: () => 'reauth_required',
    refreshLiveIdentities: () => {},
    pollInProgress: false,
    // 重置对齐调度在此沙盒中不演练（有 reset-aligned.test.cjs 覆盖纯逻辑）
    nextResetAlignedAt: () => null,
    dueResetAlignedAccounts: () => [],
  });
  vm.runInContext(`${mergeSource}\n${pollSource}`, context);
  return { poll: context.pollState, history, broadcasts, setState: (next) => { state = next; } };
}

const account = (id, extra = {}) => ({ id, providerId: 'provider', ...extra });

test('starts all accounts before any finishes and preserves the latest saved order', async () => {
  const started = [];
  const pending = new Map();
  const accounts = [account('slow'), account('fast')];
  const h = harness(accounts, (item) => {
    started.push(item.id);
    return new Promise((resolve) => pending.set(item.id, resolve));
  });
  const result = h.poll();
  h.setState({ accounts: [accounts[1], { ...accounts[0], name: 'Renamed' }], providers: [{ id: 'provider' }] });
  try {
    assert.deepEqual(started, ['slow', 'fast']);
  } finally {
    // Release pending requests even if a sequential-refresh regression fails the assertion.
    pending.get('fast')?.([{ key: 'weekly', remaining: 80 }]);
    await new Promise((resolve) => setImmediate(resolve));
    pending.get('slow')?.([{ key: 'weekly', remaining: 20 }]);
  }
  const next = await result;
  assert.deepEqual(Array.from(next.accounts, (item) => item.id), ['fast', 'slow']);
  assert.equal(next.accounts[1].name, 'Renamed');
  assert.equal(next.accounts[0].windows[0].remaining, 80);
  assert.equal(next.accounts[1].windows[0].remaining, 20);
  assert.equal(h.broadcasts.length, 2);
  assert.deepEqual(h.history, ['fast', 'slow']);
});

test('a failed account or missing provider does not prevent successful results', async () => {
  const h = harness([account('bad'), account('good'), account('missing', { providerId: 'absent' })], async (item) => {
    if (item.id === 'bad') throw new Error('Credentials expired');
    return [{ key: 'weekly', remaining: 60 }];
  });
  const next = await h.poll();
  assert.equal(next.accounts[0].status, 'warning');
  assert.equal(next.accounts[0].lastError, 'Credentials expired');
  assert.equal(next.accounts[0].authStatus, 'reauth_required');
  assert.equal(next.accounts[1].status, 'active');
  assert.equal(next.accounts[2].lastError, '找不到厂商配置');
  assert.deepEqual(h.history, ['good']);
});

test('full refresh skips disabled accounts while targeted refresh includes them', async () => {
  const queried = [];
  const h = harness([account('enabled'), account('disabled', { disabled: true })], async (item) => {
    queried.push(item.id);
    return [];
  });
  await h.poll();
  assert.deepEqual(queried, ['enabled']);
  queried.length = 0;
  await h.poll(['disabled']);
  assert.deepEqual(queried, ['disabled']);
});
