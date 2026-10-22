const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// storage.cjs 依赖 electron 的 app/safeStorage,测试注入内存替身:每个 DesktopStore 拿到独立的临时目录
const electronStub = {
  app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'quota-desk-remote-test-')) },
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

const PAIRING_KEY = 'k'.repeat(43);

// undici/fetch 不允许覆盖 Host 头,测试用 node:http 原生请求模拟任意来源
const requestJson = (port, pathname, { method = 'GET', body, token, host } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const request = http.request({
    host: '127.0.0.1',
    port,
    path: pathname,
    method,
    headers: {
      ...(host ? { Host: `${host}:${port}` } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
    },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 非 JSON 响应按空对象处理 */ }
      resolve({ status: response.statusCode, body: parsed });
    });
  });
  request.on('error', reject);
  if (payload !== null) request.write(payload);
  request.end();
});

async function bootServer(options = {}) {
  const store = new DesktopStore();
  store.saveRemoteAccess({ enabled: true, pairingKey: PAIRING_KEY, devices: [], port: 43187 });
  const server = await createRemoteViewServer({
    store,
    distDir: path.join(__dirname, 'fixtures'),
    authorizeToken: (token, options) => store.isRemoteTokenAuthorized(token, options),
    pairDevice: (body) => store.pairRemoteDevice(body),
    pairLocalPreview: () => store.pairLocalPreview(),
    port: 0,
    allowedHosts: ['192.168.1.5', '[fd00::1]'],
    ...options,
  });
  const port = server.address().port;
  const call = (pathname, options) => requestJson(port, pathname, options);
  return { store, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('手机刷新：认证后轮询账号并返回脱敏快照，保留设置只读限制', async () => {
  let calls = 0;
  const session = await bootServer({ refreshAccounts: () => {
    calls++;
    const state = session.store.loadState();
    session.store.saveState({ ...state, lastSync: '2026-10-18T08:00:00.000Z', accounts: [{ id: 'phone-test', name: '手机测试', providerId: 'test', variables: { apiKey: 'private-secret' }, windows: [] }] });
  } });
  try {
    assert.equal((await session.call('/api/refresh', { method: 'POST' })).status, 401);
    assert.equal(calls, 0);
    const pair = await session.call('/api/pair', { method: 'POST', body: { pairingKey: PAIRING_KEY, id: 'refresh-phone', name: '手机' } });
    const token = pair.body.token;
    assert.equal((await session.call('/api/refresh', { token })).status, 405);
    const refreshed = await session.call('/api/refresh', { token, method: 'POST' });
    assert.equal(refreshed.status, 200);
    assert.equal(calls, 1);
    assert.equal(refreshed.body.lastSync, '2026-10-18T08:00:00.000Z');
    assert.equal(refreshed.body.accounts[0].id, 'phone-test');
    assert.equal(refreshed.body.readOnly, true);
    assert.doesNotMatch(JSON.stringify(refreshed.body), /private-secret|apiKey/);
    assert.equal((await session.call('/api/settings', { token, method: 'PATCH', body: { pollMinutes: 10 } })).status, 403);
  } finally { await session.close(); }
});

test('手机刷新：多设备并发共用一次轮询，失败后可以重试', async () => {
  let calls = 0;
  let finish;
  let fail = true;
  const session = await bootServer({ refreshAccounts: () => {
    calls++;
    return new Promise((resolve, reject) => { finish = () => fail ? reject(new Error('private backend details')) : resolve(); });
  } });
  try {
    const pair = await session.call('/api/pair', { method: 'POST', body: { pairingKey: PAIRING_KEY, id: 'refresh-concurrent', name: '手机' } });
    const token = pair.body.token;
    const first = session.call('/api/refresh', { token, method: 'POST' });
    const second = session.call('/api/refresh', { token, method: 'POST' });
    // A snapshot requested after both POSTs ensures the server has accepted them.
    await session.call('/api/snapshot', { token });
    assert.equal(calls, 1);
    finish();
    for (const result of await Promise.all([first, second])) {
      assert.equal(result.status, 502);
      assert.deepEqual(result.body, { error: 'refresh_failed' });
    }
    fail = false;
    const retry = session.call('/api/refresh', { token, method: 'POST' });
    await session.call('/api/snapshot', { token });
    assert.equal(calls, 2);
    finish();
    assert.equal((await retry).status, 200);
  } finally { finish?.(); await session.close(); }
});

test('本机预览：回环换票免配对码，不写配对设备，令牌仅回环连接可用', async () => {
  const session = await bootServer();
  try {
    const pair = await session.call('/api/pair', { method: 'POST', body: { localPreview: true } });
    assert.equal(pair.status, 200);
    assert.ok(pair.body.token);
    assert.deepEqual(session.store.listRemoteDevices(), []);

    const snapshot = await session.call('/api/snapshot', { token: pair.body.token });
    assert.equal(snapshot.status, 200);
    assert.equal(session.store.isRemoteTokenAuthorized(pair.body.token), false);
    assert.equal(session.store.isRemoteTokenAuthorized(pair.body.token, { loopback: true }), true);
  } finally {
    await session.close();
  }
});

test('本机预览：多个预览标签页令牌并存，超出上限后最旧的先失效', async () => {
  const session = await bootServer();
  try {
    const tokens = [];
    for (let index = 0; index < 4; index += 1) {
      const pair = await session.call('/api/pair', { method: 'POST', body: { localPreview: true } });
      tokens.push(pair.body.token);
    }
    assert.equal(session.store.isRemoteTokenAuthorized(tokens[0], { loopback: true }), false);
    for (const token of tokens.slice(1)) {
      assert.equal(session.store.isRemoteTokenAuthorized(token, { loopback: true }), true);
    }
    assert.deepEqual(session.store.listRemoteDevices(), []);
  } finally {
    await session.close();
  }
});

test('Host 白名单：本机地址放行，非本机 Host 无有效令牌返回 421', async () => {
  const session = await bootServer();
  try {
    assert.equal((await session.call('/api/snapshot')).status, 401);
    assert.equal((await session.call('/api/snapshot', { host: '192.168.1.5' })).status, 401);
    assert.equal((await session.call('/api/snapshot', { host: 'tunnel.example' })).status, 421);
    assert.equal((await session.call('/api/snapshot', { host: 'tunnel.example', token: 'not-a-token' })).status, 421);
  } finally {
    await session.close();
  }
});

test('Host 白名单：经内网穿透域名的已配对设备靠令牌放行', async () => {
  const session = await bootServer();
  try {
    const pair = await session.call('/api/pair', { method: 'POST', body: { pairingKey: PAIRING_KEY, id: 'tunnel-device-01', name: '隧道设备' } });
    assert.equal(pair.status, 200);
    assert.equal((await session.call('/api/snapshot', { host: 'tunnel.example', token: pair.body.token })).status, 200);
    assert.deepEqual(session.store.listRemoteDevices().map((device) => device.id), ['tunnel-device-01']);
  } finally {
    await session.close();
  }
});

test('DNS rebinding 防护：回环连接但 Host 非本机时，预览换票被拒绝', async () => {
  const session = await bootServer();
  try {
    const pair = await session.call('/api/pair', { method: 'POST', body: { localPreview: true }, host: 'evil.example' });
    assert.equal(pair.status, 403);
    assert.equal(pair.body.error, 'local_preview_unavailable');
    assert.deepEqual(session.store.localPreviewTokenHashes, []);
  } finally {
    await session.close();
  }
});

test('旧版本遗留的本机预览设备记录，读入时被清出配对设备列表', async () => {
  const session = await bootServer();
  try {
    const config = session.store.loadRemoteAccess();
    session.store.saveRemoteAccess({
      ...config,
      devices: [
        { id: 'local-preview', name: '本机预览', tokenHash: 'b'.repeat(64), pairedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'phone-1', name: '我的手机', tokenHash: 'a'.repeat(64), pairedAt: '2026-01-02T00:00:00.000Z' },
      ],
    });
    assert.deepEqual(session.store.listRemoteDevices().map((device) => device.id), ['phone-1']);
    const reloaded = session.store.loadRemoteAccess();
    assert.deepEqual(reloaded.devices.map((device) => device.id), ['phone-1']);
  } finally {
    await session.close();
  }
});
