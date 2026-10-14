// CLI 端到端测试:起一个打桩的远程查看服务器,再以子进程跑 cli/quate-desk.mjs,
// 验证自动配对、参数透传、JSON 输出与错误路径。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const Module = require('node:module');

const electronStub = {
  app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'quota-desk-cli-test-')) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`stub:${text}`),
    decryptString: (buffer) => String(buffer).replace(/^stub:/, ''),
  },
};
const stubModule = new Module('electron-stub', null);
stubModule.exports = electronStub;
stubModule.loaded = true;
require.cache[require.resolve('electron')] = stubModule;

const { createRemoteViewServer } = require('../electron/remote-view.cjs');
const { DesktopStore } = require('../electron/storage.cjs');

const CLI = path.join(__dirname, '..', 'cli', 'quate-desk.mjs');
const DAY = 86_400_000;

const runCli = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* 非 JSON 输出按空处理 */ }
    resolve({ code: error ? error.code : 0, stdout, stderr, parsed });
  });
});

async function bootServer() {
  const store = new DesktopStore();
  store.saveState({
    lastSync: '2026-10-14T08:00:00.000Z',
    settings: { pollMinutes: 5 },
    providers: [{ id: 'zai', name: 'Z.ai', requestConfig: { windows: ['five_hour', 'weekly'], wasteWindows: ['weekly'] } }],
    accounts: [{ id: 'a1', providerId: 'zai', name: '主号', windowKeys: ['weekly'], windows: [{ key: 'weekly', unit: '%', remaining: 62, used: 38, total: 100 }], usageConnection: { status: 'connected' } }],
  });
  store.saveRemoteAccess({ enabled: true, pairingKey: 'k'.repeat(43), devices: [], port: 43187 });
  const server = await createRemoteViewServer({
    store,
    distDir: path.join(__dirname, 'fixtures'),
    authorizeToken: (token, options) => store.isRemoteTokenAuthorized(token, options),
    pairDevice: (body) => store.pairRemoteDevice(body),
    pairLocalPreview: () => store.pairLocalPreview(),
    getHistory: (accountId) => (accountId === 'a1' ? [{ at: '2026-10-14T02:30:00.000Z', windows: { weekly: { remaining: 55, unit: '%' } } }] : []),
    getCycles: () => [],
    appVersion: '0.0.0-test',
    cliUsage: {
      getSources: async () => [{ agent: 'zcode', displayName: 'ZCode', status: 'ready', records: 3, files: 2, warning: null, lastScannedAt: '2026-10-14T07:59:00.000Z' }],
      getV1Aggregate: async () => ({ granularity: 'day', timezone: 'UTC', buckets: [], totals: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, extraTokens: 0, totalTokens: 0, requests: 0, sessions: 0, activeBuckets: 0, peak: null, currentStreakDays: null, longestStreakDays: null, cacheReuseRatio: null }, groups: null, allTimeTotalTokens: 0, earliestEventMs: null }),
      scan: async () => ({}),
    },
    port: 0,
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { store, url, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('CLI:meta 自动配对并输出 JSON 信封', async () => {
  const session = await bootServer();
  try {
    const result = await runCli(['meta'], { QUATEDESK_URL: session.url });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.parsed.version, '0.0.0-test');
    assert.ok(result.parsed.query && result.parsed.generatedAt && result.parsed.now);
    assert.ok(result.parsed.endpoints.length === 9);
  } finally {
    await session.close();
  }
});

test('CLI:参数透传到查询串;snapshot 与 history 正常', async () => {
  const session = await bootServer();
  try {
    const snapshot = await runCli(['snapshot', '--account', 'a1'], { QUATEDESK_URL: session.url });
    assert.equal(snapshot.code, 0);
    assert.equal(snapshot.parsed.accounts[0].windows[0].remaining, 62);

    const history = await runCli(['history', 'a1', '--window', 'weekly', '--date', '2026-10-14', '--tz', 'UTC'], { QUATEDESK_URL: session.url });
    assert.equal(history.parsed.query.window, 'weekly');
    assert.equal(history.parsed.points.length, 1);

    const missingAccount = await runCli(['history'], { QUATEDESK_URL: session.url });
    assert.notEqual(missingAccount.code, 0);
    assert.match(missingAccount.stderr, /位置参数/);
  } finally {
    await session.close();
  }
});

test('CLI:非法参数给出允许清单并退出非零;raw 逃生口直通任意路径', async () => {
  const session = await bootServer();
  try {
    const bad = await runCli(['series', '--granularity', 'week', '--tz', 'UTC'], { QUATEDESK_URL: session.url });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /granularity/);

    const unknownFlag = await runCli(['meta', '--nope'], { QUATEDESK_URL: session.url });
    assert.notEqual(unknownFlag.code, 0);
    assert.match(unknownFlag.stderr, /--nope/);

    const raw = await runCli(['raw', '/api/v1/agents'], { QUATEDESK_URL: session.url });
    assert.equal(raw.code, 0);
    assert.equal(raw.parsed.agents[0].key, 'zcode');
    assert.equal(raw.parsed.agents[0].displayName, 'ZCode');
    assert.equal(raw.parsed.agents[0].typicalProvider, 'zai');
  } finally {
    await session.close();
  }
});

test('CLI:服务不可达时给出开启远程查看的指引', async () => {
  const result = await runCli(['meta'], { QUATEDESK_URL: 'http://127.0.0.1:1' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /远程查看/);
});
