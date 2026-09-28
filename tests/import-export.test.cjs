const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExportPackage,
  validateExportPackage,
  mergeImportPackage,
} = require('../electron/import-export.cjs');

const builtinProviderIds = new Set(['zai', 'codex']);

test('导出只保留公开 state 与自定义厂商，凭据按选项导出', () => {
  const state = {
    accounts: [
      { id: 'builtin-account', providerId: 'zai', credential: 'never-export-this' },
      { id: 'custom-account', providerId: 'acme', identity: 'user@example.test' },
    ],
    providers: [
      { id: 'zai', name: 'Z.ai' },
      { id: 'acme', name: 'Acme' },
    ],
    settings: { historyDays: 30 },
    lastSync: '2026-09-24T00:00:00.000Z',
    runtime: { pollInProgress: true },
  };
  const pkg = buildExportPackage(
    state,
    { 'custom-account': [{ at: '2026-09-23T00:00:00.000Z', windows: {} }] },
    {},
    { 'custom-account': { credential: 'secret' } },
    { builtinProviderIds, includeCredentials: true, exportedAt: '2026-09-24T01:00:00.000Z' },
  );

  assert.deepEqual(pkg.state.providers, [{ id: 'acme', name: 'Acme' }]);
  assert.equal(pkg.state.accounts[0].credential, undefined);
  assert.equal(pkg.state.runtime, undefined);
  assert.deepEqual(pkg.credentials, { 'custom-account': { credential: 'secret' } });
  assert.equal(validateExportPackage(pkg, { builtinProviderIds }).ok, true);
});

test('导入保留现有数据优先，并按厂商/账号映射历史与周期', () => {
  const pkg = buildExportPackage(
    {
      accounts: [
        { id: 'incoming-same', providerId: 'acme', identity: 'same', name: 'incoming', cliFingerprint: 'login-same' },
        { id: 'incoming-new', providerId: 'newco', identity: 'new', name: 'new' },
      ],
      providers: [
        { id: 'acme', name: 'Existing Acme' },
        { id: 'newco', name: 'NewCo' },
      ],
      settings: { incoming: true },
    },
    {
      'incoming-same': [
        { at: '2026-09-24T02:00:00.000Z', windows: { weekly: { remaining: 50 } } },
        { at: '2026-09-24T01:00:00.000Z', windows: { weekly: { remaining: 60 } } },
      ],
      'incoming-new': [{ at: '2026-09-24T03:00:00.000Z', windows: {} }],
    },
    {
      'incoming-same': [
        { window: 'weekly', kind: 'natural', end: '2026-09-24T02:00:00.000Z' },
        { window: 'weekly', kind: 'natural', end: '2026-09-24T01:00:00.000Z' },
      ],
    },
    {},
    { builtinProviderIds, includeCredentials: false },
  );

  const result = mergeImportPackage(
    {
      accounts: [{ id: 'existing-same', providerId: 'acme-local', identity: 'same', name: 'existing', cliFingerprint: 'login-same' }],
      providers: [{ id: 'acme-local', name: 'Existing Acme' }],
      settings: { existing: true },
      lastSync: 'existing',
    },
    {
      'existing-same': [{ at: '2026-09-24T01:00:00.000Z', windows: { weekly: { remaining: 99 } } }],
    },
    {},
    pkg,
    { existing: { credential: 'old' } },
    { builtinProviderIds },
  );

  // The custom provider with the same shape is not overwritten, and the
  // identity match maps the incoming account to the existing account.
  assert.equal(result.providerIdMap.acme, 'acme-local');
  assert.equal(result.accountIdMap['incoming-same'], 'existing-same');
  assert.equal(result.state.accounts.length, 2);
  assert.equal(result.state.settings.existing, true);
  assert.deepEqual(result.history['existing-same'].map((point) => point.at), [
    '2026-09-24T01:00:00.000Z',
    '2026-09-24T02:00:00.000Z',
  ]);
  assert.deepEqual(result.cycles['existing-same'].map((cycle) => cycle.end), [
    '2026-09-24T01:00:00.000Z',
    '2026-09-24T02:00:00.000Z',
  ]);
});

test('重复导入幂等：第二次不新增账号、历史、周期或凭据', () => {
  const pkg = buildExportPackage(
    { accounts: [{ id: 'a', providerId: 'custom', identity: 'a' }], providers: [{ id: 'custom', name: 'Custom' }] },
    { a: [{ at: '2026-01-01T00:00:00.000Z', windows: {} }] },
    { a: [{ window: 'weekly', kind: 'natural', end: '2026-01-01T00:00:00.000Z' }] },
    { a: { credential: 'secret' } },
    { includeCredentials: true },
  );
  const first = mergeImportPackage({ accounts: [], providers: [] }, {}, {}, pkg, {}, {});
  const second = mergeImportPackage(first.state, first.history, first.cycles, pkg, first.credentials, {});
  assert.equal(first.stats.accounts, 1);
  assert.equal(first.stats.history, 1);
  assert.equal(first.stats.cycles, 1);
  assert.equal(second.stats.accounts, 0);
  assert.equal(second.stats.history, 0);
  assert.equal(second.stats.cycles, 0);
  assert.equal(second.stats.credentials, 0);
  assert.deepEqual(second.credentials, first.credentials);
});

test('账号 ID 冲突时保留两个账号并重映射导入历史', () => {
  const pkg = buildExportPackage(
    { accounts: [{ id: 'same-id', providerId: 'p', identity: 'other-user' }], providers: [{ id: 'p', name: 'Provider' }] },
    { 'same-id': [{ at: '2026-09-24T00:00:00.000Z', windows: {} }] },
    {},
    { 'same-id': { credential: 'imported-secret' } },
    { includeCredentials: true },
  );
  const merged = mergeImportPackage(
    { accounts: [{ id: 'same-id', providerId: 'p', identity: 'current-user' }], providers: [{ id: 'p', name: 'Provider' }] },
    {}, {}, pkg, { 'same-id': { credential: 'current-secret' } }, {},
  );
  assert.equal(merged.state.accounts.length, 2);
  assert.equal(merged.accountIdMap['same-id'], 'same-id-imported-1');
  assert.equal(merged.history['same-id-imported-1'].length, 1);
  assert.equal(merged.credentials['same-id-imported-1'].credential, 'imported-secret');
  assert.equal(merged.credentials['same-id'].credential, 'current-secret');
});

test('损坏的备份格式与历史条目会被拒绝', () => {
  const pkg = buildExportPackage({ accounts: [{ id: 'a', providerId: 'p' }], providers: [] }, {}, {});
  assert.equal(validateExportPackage({ ...pkg, version: 99 }).ok, false);
  assert.equal(validateExportPackage({ ...pkg, history: { a: [{ at: 'bad-date', windows: {} }] } }).ok, false);
  assert.equal(validateExportPackage({ ...pkg, credentials: { a: { credential: 123 } } }).ok, false);
});

test('导入不改变现有账号的官方用量连接状态', () => {
  const usageConnection = { provider: 'deepseek', status: 'connected', revision: 3 };
  const pkg = buildExportPackage({ accounts: [], providers: [] }, {}, {});
  const result = mergeImportPackage(
    { accounts: [{ id: 'current', providerId: 'deepseek', usageConnection }], providers: [] },
    {}, {}, pkg, {}, {},
  );
  assert.deepEqual(result.state.accounts[0].usageConnection, usageConnection);
});

test('相同标识但不同 ID 的普通 API 账号保留为两条', () => {
  const pkg = buildExportPackage({ accounts: [{ id: 'incoming', providerId: 'p', identity: 'same@example.test' }], providers: [{ id: 'p', name: 'P' }] }, {}, {});
  const result = mergeImportPackage(
    { accounts: [{ id: 'current', providerId: 'p', identity: 'same@example.test' }], providers: [{ id: 'p', name: 'P' }] },
    {}, {}, pkg, {}, {},
  );
  assert.equal(result.state.accounts.length, 2);
  assert.equal(result.accountIdMap.incoming, 'incoming');
});
