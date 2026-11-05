const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const Module = require('node:module');

// storage.cjs 依赖 electron 的 app/safeStorage,测试注入内存替身:每个 DesktopStore 拿到独立的临时目录
const electronStub = {
  app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'quota-desk-pair-test-')) },
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
const { startDiscoveryResponder } = require('../electron/discovery-responder.cjs');
const { DesktopStore } = require('../electron/storage.cjs');

const PAIRING_KEY = 'k'.repeat(43);
const SERVER_INFO = { id: 'instance-abc123', name: 'DESKTOP-TEST', port: 43187, addrs: ['192.168.1.5', '10.0.0.3'], version: '0.9.0-test' };

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
  store.saveRemoteAccess({ enabled: true, pairingKey: PAIRING_KEY, instanceId: SERVER_INFO.id, devices: [], port: 43187 });
  const server = await createRemoteViewServer({
    store,
    distDir: path.join(__dirname, 'fixtures'),
    authorizeToken: (token, context) => store.isRemoteTokenAuthorized(token, context),
    pairDevice: (body) => store.pairRemoteDevice(body),
    pairLocalPreview: () => store.pairLocalPreview(),
    pairConfirmedDevice: (body) => store.issueRemoteDeviceToken(body),
    discoveryInfo: () => SERVER_INFO,
    appVersion: SERVER_INFO.version,
    port: 0,
    allowedHosts: ['192.168.1.5'],
    ...options,
  });
  const port = server.address().port;
  const call = (pathname, requestOptions) => requestJson(port, pathname, requestOptions);
  return { store, server, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('配对码：手机发起 → 电脑输码确认 → 手机领取令牌，全程免配对密钥', async () => {
  const session = await bootServer();
  try {
    const initiate = await session.call('/api/pair/initiate', { method: 'POST', body: { id: 'phone-android-01', name: '我的手机' } });
    assert.equal(initiate.status, 200);
    assert.match(initiate.body.code, /^\d{4}$/);
    assert.ok(initiate.body.sessionId);
    assert.equal(initiate.body.expiresIn, 300);

    // 未确认前领取 → pending
    const pending = await session.call('/api/pair/claim', { method: 'POST', body: { sessionId: initiate.body.sessionId } });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, 'pending');

    // 电脑端输错码不生效，输对后设备进入配对列表
    const wrongCode = initiate.body.code === '0000' ? '0001' : '0000';
    assert.throws(() => session.server.confirmPairingCode(wrongCode), /配对码无效或已过期/);
    const confirmed = session.server.confirmPairingCode(initiate.body.code);
    assert.equal(confirmed.deviceName, '我的手机');
    assert.deepEqual(session.store.listRemoteDevices().map((device) => device.id), ['phone-android-01']);
    assert.equal(session.server.pendingPairings().length, 0);

    // 手机领取：拿到令牌 + 电脑身份信息；令牌可通过鉴权
    const claim = await session.call('/api/pair/claim', { method: 'POST', body: { sessionId: initiate.body.sessionId } });
    assert.equal(claim.status, 200);
    assert.equal(claim.body.status, 'ok');
    assert.ok(claim.body.token);
    assert.deepEqual(claim.body.server, SERVER_INFO);
    assert.equal(session.store.isRemoteTokenAuthorized(claim.body.token), true);

    // 一次性：领完即焚
    const again = await session.call('/api/pair/claim', { method: 'POST', body: { sessionId: initiate.body.sessionId } });
    assert.equal(again.status, 404);
  } finally { await session.close(); }
});

test('配对码：同一手机重复发起沿用会话，不同手机配对码不重复', async () => {
  const session = await bootServer();
  try {
    const first = await session.call('/api/pair/initiate', { method: 'POST', body: { id: 'phone-android-01', name: '我的手机' } });
    const repeat = await session.call('/api/pair/initiate', { method: 'POST', body: { id: 'phone-android-01', name: '我的手机' } });
    assert.equal(repeat.body.sessionId, first.body.sessionId);
    assert.equal(repeat.body.code, first.body.code);

    const other = await session.call('/api/pair/initiate', { method: 'POST', body: { id: 'phone-android-02', name: '另一台' } });
    assert.notEqual(other.body.code, first.body.code);
    assert.deepEqual(session.server.pendingPairings().map((item) => item.deviceName), ['我的手机', '另一台']);
  } finally { await session.close(); }
});

test('配对码：非法入参与非法确认被拒绝', async () => {
  const session = await bootServer();
  try {
    assert.equal((await session.call('/api/pair/initiate', { method: 'POST', body: { id: 'x', name: '' } })).status, 400);
    assert.equal((await session.call('/api/pair/initiate', { method: 'POST' })).status, 415);
    assert.equal((await session.call('/api/pair/claim', { method: 'POST', body: { sessionId: 'missing' } })).status, 404);
    assert.throws(() => session.server.confirmPairingCode('12ab'), /4 位数字/);
    assert.throws(() => session.server.confirmPairingCode('1234'), /配对码无效或已过期/);
  } finally { await session.close(); }
});

test('发现自述：/api/hello 返回设备身份并受 Host 白名单约束', async () => {
  const session = await bootServer();
  try {
    const hello = await session.call('/api/hello');
    assert.equal(hello.status, 200);
    assert.equal(hello.body.app, 'quota-desk');
    assert.equal(hello.body.id, SERVER_INFO.id);
    assert.equal(hello.body.name, SERVER_INFO.name);
    assert.equal(hello.body.version, SERVER_INFO.version);
    assert.deepEqual(hello.body.addrs, SERVER_INFO.addrs);
    assert.equal((await session.call('/api/hello', { host: 'tunnel.example' })).status, 421);
    assert.equal((await session.call('/api/hello', { host: '192.168.1.5' })).status, 200);
  } finally { await session.close(); }
});

test('扫码配对：/api/pair 响应附带电脑身份信息供手机端建记录', async () => {
  const session = await bootServer();
  try {
    const pair = await session.call('/api/pair', { method: 'POST', body: { pairingKey: PAIRING_KEY, id: 'qr-phone-01', name: '扫码手机' } });
    assert.equal(pair.status, 200);
    assert.ok(pair.body.token);
    assert.deepEqual(pair.body.server, SERVER_INFO);
  } finally { await session.close(); }
});

test('UDP 发现应答：校验探测包、回显 nonce、忽略杂包', async () => {
  const responder = await startDiscoveryResponder({ port: 0, getPayload: () => SERVER_INFO });
  const socket = dgram.createSocket({ type: 'udp4' });
  try {
    const ask = (payload) => new Promise((resolve, reject) => {
      const nonce = `n${Math.random().toString(36).slice(2, 10)}`;
      const onMessage = (packet) => {
        socket.off('message', onMessage);
        try { resolve({ nonce, packet: JSON.parse(packet.toString('utf8')) }); }
        catch (error) { reject(error); }
      };
      socket.on('message', onMessage);
      socket.send(Buffer.from(JSON.stringify({ ...payload, n: nonce })), responder.port, '127.0.0.1', (error) => {
        if (error) { socket.off('message', onMessage); reject(error); }
      });
    });
    const probe = await ask({ m: 'QD-DISCOVER', v: 1 });
    assert.equal(probe.packet.m, 'QD-DISCOVER-R');
    assert.equal(probe.packet.n, probe.nonce);
    assert.equal(probe.packet.id, SERVER_INFO.id);
    assert.deepEqual(probe.packet.addrs, SERVER_INFO.addrs);
    assert.equal(probe.packet.port, SERVER_INFO.port);

    // 杂包（错 magic / 错版本）不回应答
    const garbage = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('silent'), 400);
      socket.once('message', (packet) => { clearTimeout(timer); resolve(packet.toString('utf8')); });
      socket.send(Buffer.from(JSON.stringify({ m: 'QD-OTHER', v: 1, n: 'n1234' })), responder.port, '127.0.0.1');
    });
    assert.equal(await garbage, 'silent');
  } finally {
    await new Promise((done) => socket.close(done));
    await responder.close();
  }
});

test('UDP 发现应答：payload 抛错不影响应答器存活', async () => {
  let failures = 0;
  const responder = await startDiscoveryResponder({ port: 0, getPayload: () => { throw new Error('boom'); }, onError: () => { failures += 1; } });
  const socket = dgram.createSocket({ type: 'udp4' });
  try {
    await new Promise((resolve, reject) => {
      socket.once('message', () => reject(new Error('不应有应答')));
      const timer = setTimeout(resolve, 300);
      socket.send(Buffer.from(JSON.stringify({ m: 'QD-DISCOVER', v: 1, n: 'probe-123' })), responder.port, '127.0.0.1', (error) => { if (error) { clearTimeout(timer); reject(error); } });
    });
    assert.equal(failures, 0);
  } finally {
    await new Promise((done) => socket.close(done));
    await responder.close();
  }
});
