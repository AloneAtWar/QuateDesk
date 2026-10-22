'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CliUsageStore } = require('../electron/cli-usage/store.cjs');
const { UsageSyncService, UPLOAD_INTERVAL, PULL_INTERVAL, RETRY_INTERVAL } = require('../electron/usage-sync/index.cjs');
const { encrypt, decrypt } = require('../electron/usage-sync/crypto.cjs');
const { normalizeConfig, parseListing, parseDirectory, WebDavClient } = require('../electron/usage-sync/webdav.cjs');
const { mockWebDav } = require('./helpers/mock-webdav.cjs');

const PASSPHRASE = 'sixkey';
const settings = (endpoint, extra) => ({ enabled: true, endpoint, username: 'sync-user', password: 'app-password-for-tests', passphrase: PASSPHRASE, folder: 'QuotaDesk', ...extra });
function device(t, endpoint, clock = { value: Date.now() }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-sync-test-'));
  const db = new CliUsageStore(path.join(dir, 'usage.sqlite'));
  const values = { config: {}, state: null };
  const storage = {
    loadUsageSyncConfig: () => structuredClone(values.config), saveUsageSyncConfig: (v) => { values.config = structuredClone(v); },
    loadUsageSyncState: () => structuredClone(values.state), saveUsageSyncState: (v) => { values.state = structuredClone(v); },
  };
  const archives = {
    getArchiveInfo: async () => db.archives.info(), exportArchives: async (scope) => db.archives.exportPackage(scope),
    previewArchiveImport: async (p) => db.archives.preview(p), importArchives: async (p, name) => db.archives.importPackage(p, name),
  };
  const makeService = (options = {}) => new UsageSyncService({ storage, archives, now: () => clock.value, ...options });
  const service = makeService();
  service.saveConfig(settings(endpoint));
  const add = (key, tokens) => db.upsertEvents([{ eventKey: key, agent: 'claude', rootId: 'r', occurredAtMs: clock.value, sessionKey: 'same-session', projectKey: 'project', model: 'claude-sonnet-4-5', canonicalModelKey: 'claude-sonnet-4-5', inputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, extraTokens: 0, totalTokens: tokens, requestCount: 1, sourceVersion: null, exact: true, isSidechain: false }]);
  t.after(() => {
    service.dispose(); db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, service, clock, add, makeService, values, total: () => db.totalTokensAll('all'), id: db.archives.sourceId };
}
const headPath = (id) => `/dav/QuotaDesk/${id}.json`;
const snapshotPuts = (dav) => dav.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('.snapshot.json'));
const commitFiles = (dav, id) => [...dav.files.keys()].filter((name) => name.startsWith(`/dav/QuotaDesk/v2/${id}/`) && name.endsWith('.commit.json'));
async function heads(dav, id) {
  const paths = commitFiles(dav, id);
  if (dav.files.has(headPath(id))) paths.push(headPath(id));
  return Promise.all(paths.map(async (name) => ({ ...await decrypt(dav.files.get(name).body, PASSPHRASE), path: name })));
}
async function head(dav, id) { return (await heads(dav, id)).sort((a, b) => b.revision - a.revision || b.path.localeCompare(a.path))[0]; }
const snapshotGets = (dav) => dav.requests.filter((r) => r.method === 'GET' && r.path.endsWith('.snapshot.json'));
function copySourceId(from, to) {
  to.db.db.prepare("UPDATE meta SET value = ? WHERE key = 'archive_source_id'").run(from.id);
  to.db.archives.sourceId = from.id;
}
async function copyCommit(dav, original, { publishId = crypto.randomUUID(), blobBody, commitBody } = {}) {
  const folder = original.blob.slice(0, original.blob.lastIndexOf('/'));
  const prefix = `${folder}/r${original.revision}.${publishId}`;
  const blob = `${prefix}.snapshot.json`;
  const wire = blobBody ?? dav.files.get(`/dav/QuotaDesk/${original.blob}`).body;
  dav.files.set(`/dav/QuotaDesk/${blob}`, { body: wire, etag: '"copied-snapshot"' });
  const commit = { kind: 'head', version: 2, vaultId: original.vaultId, sourceId: original.sourceId, revision: original.revision, dataHash: original.dataHash, blob };
  const pathname = `/dav/QuotaDesk/${prefix}.commit.json`;
  dav.files.set(pathname, { body: commitBody ?? await encrypt(commit, PASSPHRASE), etag: '"copied-commit"' });
  return { ...commit, path: pathname };
}

test('加密先压缩，随机盐与 nonce；口令错误、标签或密文篡改均拒绝', async () => {
  const input = { label: '公司电脑', project: '私有项目', values: Array(10_000).fill(12345) };
  const a = await encrypt(input, PASSPHRASE), b = await encrypt(input, PASSPHRASE);
  assert.ok(a.length < 2000);
  assert.ok(!a.equals(b));
  assert.equal(a.includes(Buffer.from('私有项目')), false);
  assert.deepEqual(await decrypt(a, PASSPHRASE), input);
  await assert.rejects(decrypt(a, 'different-passphrase-long-enough'), /无法解密/);
  const modified = JSON.parse(a); modified.tag = crypto.randomBytes(16).toString('base64');
  await assert.rejects(decrypt(Buffer.from(JSON.stringify(modified)), PASSPHRASE), /无法解密/);
  modified.kdf = 'scrypt-999999999';
  await assert.rejects(decrypt(JSON.stringify(modified), PASSPHRASE), /不支持/);
  await assert.rejects(decrypt(JSON.stringify(input), PASSPHRASE), /不支持/);
  await assert.rejects(encrypt(input, 'short'), /6/);
  assert.equal(normalizeConfig({ passphrase: PASSPHRASE }).passphrase, PASSPHRASE);
  assert.throws(() => normalizeConfig({ passphrase: 'short' }), /6/);
  assert.throws(() => normalizeConfig({ passphrase: 'x'.repeat(1025) }), /1024/);
});

test('两设备全量更新：本机不回流、导入来源不上云、重复与旧版不增量累加', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), b = device(t, dav.endpoint);
  a.add('same-event', 100); b.add('same-event', 200);
  a.db.archives.updateSource({ sourceId: a.id, label: '公司电脑' });
  await a.service.run({ manual: true });
  const wednesday = new Map(dav.files);
  await b.service.run({ manual: true });
  await a.service.run({ manual: true });
  assert.equal(a.total(), 300); assert.equal(b.total(), 300);
  assert.equal(a.db.archives.info().imported.length, 1);
  const bHead = await head(dav, b.id);
  const bSnapshot = await decrypt(dav.files.get(`/dav/QuotaDesk/${bHead.blob}`).body, PASSPHRASE);
  assert.equal(bSnapshot.payload.archives.length, 1);
  assert.equal(bSnapshot.payload.archives[0].sourceId, b.id);
  const historyBefore = a.db.archives.info().history.length;
  const uploadsBefore = snapshotPuts(dav).length;
  await a.service.run({ manual: true });
  assert.equal(a.db.archives.info().history.length, historyBefore);
  assert.equal(snapshotPuts(dav).length, uploadsBefore);
  assert.equal(dav.requests.some((r) => r.method === 'PUT' && r.condition), false);
  a.add('friday', 50);
  await a.service.run({ manual: true });
  await b.service.run({ manual: true });
  assert.equal(b.total(), 350);
  assert.equal(b.db.archives.info().imported.length, 1);
  const friday = await head(dav, a.id);
  const oldCommitPath = [...wednesday.keys()].find((file) => file.includes(`/v2/${a.id}/`) && file.endsWith('.commit.json'));
  const oldHead = await decrypt(wednesday.get(oldCommitPath).body, PASSPHRASE);
  assert.equal(dav.files.has(`/dav/QuotaDesk/${oldHead.blob}`), true);
  // Simulate an old server backup. A newer imported revision must survive it.
  for (const file of commitFiles(dav, a.id)) dav.files.delete(file);
  for (const [file, value] of wednesday) dav.files.set(file, value);
  await b.service.run({ manual: true });
  assert.equal(b.total(), 350);
  assert.equal(b.db.archives.info().imported[0].revision, friday.revision);
  for (const file of dav.files.values()) {
    assert.equal(file.body.includes(Buffer.from('same-event')), false);
    assert.equal(file.body.includes(Buffer.from('公司电脑')), false);
    assert.equal(file.body.includes(Buffer.from(PASSPHRASE)), false);
  }
});

test('自动上传 24 小时间隔持久化，30 分钟拉取，不变不上传，手动允许提前', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint);
  a.add('one', 10); await a.service.tick();
  const firstAt = a.service.status().lastUploadAt;
  a.add('two', 20);
  const count = snapshotPuts(dav).length;
  a.clock.value += PULL_INTERVAL;
  const resumed = a.makeService(); t.after(() => resumed.dispose());
  await resumed.tick();
  assert.equal(snapshotPuts(dav).length, count);
  assert.equal(resumed.status().lastUploadAt, firstAt);
  a.clock.value = firstAt + UPLOAD_INTERVAL;
  await resumed.tick();
  assert.equal(snapshotPuts(dav).length, count + 1);
  a.add('three', 30);
  await resumed.run({ manual: true });
  assert.equal(snapshotPuts(dav).length, count + 2);
  assert.equal(JSON.stringify(resumed.status()).includes(PASSPHRASE), false);
  assert.equal(JSON.stringify(resumed.status()).includes('app-password-for-tests'), false);
});

test('自动检查不变的来源跳过大快照，手动同步重新核验完整快照', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), b = device(t, dav.endpoint);
  a.add('a', 10); await a.service.run(); await b.service.run();
  const before = snapshotGets(dav).filter((r) => r.path.includes(`/v2/${a.id}/`)).length;
  b.clock.value += PULL_INTERVAL;
  const restarted = b.makeService(); t.after(() => restarted.dispose());
  await restarted.tick();
  assert.equal(snapshotGets(dav).filter((r) => r.path.includes(`/v2/${a.id}/`)).length, before);
  await restarted.run({ manual: true });
  assert.ok(snapshotGets(dav).filter((r) => r.path.includes(`/v2/${a.id}/`)).length > before);
  const remote = await head(dav, a.id);
  dav.files.set(`/dav/QuotaDesk/${remote.blob}`, { body: Buffer.from('{damaged'), etag: '"damaged"' });
  await assert.rejects(restarted.run({ manual: true }), /不是完整/);
  assert.equal(b.total(), 10);
});

test('跨月与设备时钟回退仍按最高来源版本选择，不按目录日期判断新旧', async (t) => {
  const dav = await mockWebDav(t);
  const a = device(t, dav.endpoint, { value: Date.parse('2026-11-01T00:30:00Z') });
  const b = device(t, dav.endpoint);
  a.add('november', 10); await a.service.run();
  const first = await head(dav, a.id);
  assert.match(first.blob, /\/2026-11\//);
  a.clock.value = Date.parse('2026-10-31T23:30:00Z');
  a.add('clock-rollback', 20); await a.service.run({ manual: true });
  const second = await head(dav, a.id);
  assert.match(second.blob, /\/2026-10\//);
  assert.ok(second.revision > first.revision);
  await b.service.run();
  assert.equal(b.total(), 30);
  assert.equal(b.db.archives.info().imported[0].revision, second.revision);
  assert.equal(commitFiles(dav, a.id).length, 2);
});

test('首次两设备并发初始化共用加密目录，设备来源互不覆盖', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), b = device(t, dav.endpoint);
  a.add('a', 100); b.add('b', 200);
  await Promise.all([a.service.run(), b.service.run()]);
  assert.equal((await head(dav, a.id)).vaultId, (await head(dav, b.id)).vaultId);
  await Promise.all([a.service.run({ manual: true }), b.service.run({ manual: true })]);
  assert.equal(a.total(), 300); assert.equal(b.total(), 300);
  assert.equal(dav.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/sync-key.json')).length, 1);
  assert.equal(dav.folders.has('/dav/QuotaDesk/key-init/'), true);
});

test('并发初始化使用不同口令时仅一个初始化者写入密钥，另一设备不能覆盖', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), b = device(t, dav.endpoint);
  dav.ignoreConditions = true; dav.noEtags = true;
  a.add('a', 10); b.add('b', 20);
  b.service.saveConfig({ passphrase: 'wrong6' });
  const outcomes = await Promise.allSettled([a.service.run(), b.service.run()]);
  assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
  assert.match(outcomes.find((value) => value.status === 'rejected').reason.message, /无法解密/);
  const key = dav.files.get('/dav/QuotaDesk/sync-key.json');
  assert.equal(dav.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/sync-key.json')).length, 1);
  const loser = outcomes[0].status === 'rejected' ? a : b;
  await assert.rejects(loser.service.run({ manual: true }), /无法解密/);
  assert.equal(dav.files.get('/dav/QuotaDesk/sync-key.json'), key);
});

test('初始化在取得目录后中断时重试不会争抢或覆盖密钥，已有密钥恢复后可继续', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint);
  dav.folders.add('/dav/QuotaDesk/');
  dav.folders.add('/dav/QuotaDesk/key-init/');
  await assert.rejects(a.service.run(), /初始化尚未完成/);
  assert.equal(dav.requests.some((r) => r.method === 'PUT' && r.path.endsWith('/sync-key.json')), false);
  assert.equal(dav.folders.has('/dav/QuotaDesk/key-init/'), true);
  const key = { body: await encrypt({ kind: 'key', version: 1, vaultId: crypto.randomUUID() }, PASSPHRASE), etag: '"restored"' };
  dav.files.set('/dav/QuotaDesk/sync-key.json', key);
  await a.service.run({ manual: true });
  assert.equal(dav.files.get('/dav/QuotaDesk/sync-key.json'), key);
});

test('相同来源同版本的并发发布保留两个文件，接收端检测不同内容冲突', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), clone = device(t, dav.endpoint), receiver = device(t, dav.endpoint);
  copySourceId(a, clone);
  a.add('a', 100); clone.add('different', 200);
  await a.service.testConnection();
  let release;
  const bothArrived = new Promise((resolve) => { release = resolve; });
  let arrivals = 0;
  dav.fault = async ({ method, path: name }) => {
    if (method === 'PUT' && name.includes(`/v2/${a.id}/`) && name.endsWith('.commit.json')) {
      if (++arrivals === 2) release();
      await bothArrived;
    }
    return null;
  };
  await Promise.allSettled([a.service.run(), clone.service.run()]);
  dav.fault = null;
  assert.equal(commitFiles(dav, a.id).length, 2);
  assert.equal(new Set((await heads(dav, a.id)).map((value) => value.dataHash)).size, 2);
  await assert.rejects(receiver.service.run(), /相同版本存在内容冲突/);
  assert.equal(receiver.db.archives.info().imported.length, 0);
});

test('复制数据库导致相同来源 ID、相同版本内容冲突时禁止覆盖云端', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), clone = device(t, dav.endpoint);
  copySourceId(a, clone);
  a.add('a', 100); clone.add('other-content', 200);
  await a.service.run();
  const before = commitFiles(dav, a.id);
  await assert.rejects(clone.service.run(), /云端版本较新或存在冲突/);
  assert.deepEqual(commitFiles(dav, a.id), before);
});

test('错误口令、错误账号、损坏密文：不覆盖云端或已有本地档案，失败退避重试', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), b = device(t, dav.endpoint);
  a.add('a', 10); b.add('b', 20);
  await a.service.run({ manual: true }); await b.service.run({ manual: true });
  const before = snapshotPuts(dav).length, aHead = await head(dav, a.id);
  const original = dav.files.get(aHead.path);
  b.service.saveConfig({ passphrase: 'incorrect-secret-over-16' });
  await assert.rejects(b.service.run({ manual: true }), /无法解密/);
  assert.equal(snapshotPuts(dav).length, before);
  assert.equal(b.total(), 30);
  assert.equal(b.service.status().nextCheckAt, b.clock.value + RETRY_INTERVAL);
  const requests = dav.requests.length; await b.service.tick(); assert.equal(dav.requests.length, requests);
  b.service.saveConfig({ passphrase: PASSPHRASE, password: 'incorrect-app-password' });
  await assert.rejects(b.service.run(), /认证失败/);
  b.service.saveConfig({ password: 'app-password-for-tests' });
  dav.files.set(aHead.path, { body: Buffer.from('{broken'), etag: '"broken"' });
  await assert.rejects(b.service.run(), /不是完整/);
  assert.equal(b.total(), 30);
  dav.files.set(aHead.path, original);
  await b.service.run();
  assert.equal(b.service.status().lastError, '');
});

test('发布索引失败与响应丢失：旧快照保留，重试不损坏已发布快照', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), b = device(t, dav.endpoint);
  a.add('wednesday', 10); await a.service.run();
  const old = await head(dav, a.id);
  a.add('friday', 50);
  dav.fault = ({ method, path: name }) => method === 'PUT' && name.includes(`/v2/${a.id}/`) && name.endsWith('.commit.json') ? { status: 503 } : null;
  await assert.rejects(a.service.run({ manual: true }), /503/);
  assert.equal((await head(dav, a.id)).blob, old.blob);
  assert.equal(dav.files.has(`/dav/QuotaDesk/${old.blob}`), true);
  await b.service.run(); assert.equal(b.total(), 10);
  dav.fault = ({ method, path: name }) => method === 'PUT' && name.includes(`/v2/${a.id}/`) && name.endsWith('.commit.json') ? { disconnectAfterCommit: true } : null;
  await assert.rejects(a.service.run({ manual: true }), /无法连接/);
  const committed = await head(dav, a.id);
  assert.notEqual(committed.blob, old.blob);
  assert.equal(dav.files.has(`/dav/QuotaDesk/${committed.blob}`), true);
  dav.fault = null;
  await a.service.run({ manual: true }); await b.service.run({ manual: true });
  assert.equal(b.total(), 60);
});

test('写入后回读字节不一致时不发布完成标记，先前完整版本继续可读', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), b = device(t, dav.endpoint);
  a.add('first', 10); await a.service.run();
  const old = await head(dav, a.id);
  a.add('second', 20);
  dav.fault = ({ method, path: name, body }) => {
    if (method === 'PUT' && name.includes(`/v2/${a.id}/`) && name.endsWith('.snapshot.json')) body[0] ^= 1;
    return null;
  };
  await assert.rejects(a.service.run({ manual: true }), /写入校验失败/);
  assert.equal(commitFiles(dav, a.id).length, 1);
  assert.equal((await head(dav, a.id)).blob, old.blob);
  assert.ok(snapshotPuts(dav).length > 1);
  dav.fault = null;
  await b.service.run();
  assert.equal(b.total(), 10);
});

test('同版本等价标记依次尝试完整快照，损坏的同版本标记不阻止读取且不能缓存', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), b = device(t, dav.endpoint);
  a.add('a', 10); await a.service.run();
  const original = await head(dav, a.id);
  const duplicate = await copyCommit(dav, original, { publishId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', blobBody: Buffer.from('{damaged') });
  await copyCommit(dav, original, { publishId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', commitBody: Buffer.from('{damaged') });
  await b.service.run();
  assert.equal(b.total(), 10);
  assert.ok(snapshotGets(dav).some((r) => r.path === `/dav/QuotaDesk/${duplicate.blob}`));
  assert.ok(snapshotGets(dav).some((r) => r.path === `/dav/QuotaDesk/${original.blob}`));
  assert.equal(b.values.state.received[a.id], undefined);
  const count = snapshotGets(dav).filter((r) => r.path.includes(`/v2/${a.id}/`)).length;
  b.clock.value += PULL_INTERVAL;
  await b.service.tick();
  assert.ok(snapshotGets(dav).filter((r) => r.path.includes(`/v2/${a.id}/`)).length > count);
});

test('继续读取旧版根索引与快照，更新后写入 v2 且保留原始旧版文件', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), b = device(t, dav.endpoint);
  a.add('legacy', 10); await a.service.testConnection();
  const key = await decrypt(dav.files.get('/dav/QuotaDesk/sync-key.json').body, PASSPHRASE);
  const payload = a.db.archives.exportPackage('local'), local = payload.archives[0];
  const blob = `${a.id}.${crypto.randomUUID()}.snapshot.json`;
  const legacy = { body: await encrypt({ kind: 'head', version: 1, vaultId: key.vaultId, sourceId: a.id, revision: local.revision, dataHash: local.dataHash, blob }, PASSPHRASE), etag: '"legacy-head"' };
  dav.files.set(headPath(a.id), legacy);
  dav.files.set(`/dav/QuotaDesk/${blob}`, { body: await encrypt({ kind: 'snapshot', vaultId: key.vaultId, payload }, PASSPHRASE), etag: '"legacy-snapshot"' });
  await b.service.run(); assert.equal(b.total(), 10);
  a.add('v2-update', 20); await a.service.run({ manual: true });
  await b.service.run({ manual: true });
  assert.equal(b.total(), 30);
  assert.equal((await head(dav, a.id)).version, 2);
  assert.equal(dav.files.get(headPath(a.id)), legacy);
  assert.equal(dav.files.has(`/dav/QuotaDesk/${blob}`), true);
});

test('升级 v1 同步日志保留历史与暂停来源，立即检查并发布尚未上传的 v2 数据', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint);
  a.add('old-version', 10); await a.service.testConnection();
  const key = await decrypt(dav.files.get('/dav/QuotaDesk/sync-key.json').body, PASSPHRASE);
  const payload = a.db.archives.exportPackage('local'), local = payload.archives[0];
  const blob = `${a.id}.${crypto.randomUUID()}.snapshot.json`;
  const legacy = { body: await encrypt({ kind: 'head', version: 1, vaultId: key.vaultId, sourceId: a.id, revision: local.revision, dataHash: local.dataHash, blob }, PASSPHRASE), etag: '"legacy-head"' };
  dav.files.set(headPath(a.id), legacy);
  dav.files.set(`/dav/QuotaDesk/${blob}`, { body: await encrypt({ kind: 'snapshot', vaultId: key.vaultId, payload }, PASSPHRASE), etag: '"legacy-snapshot"' });
  const ignored = [{ sourceId: crypto.randomUUID(), label: '已暂停的公司电脑' }];
  const lastSuccessAt = a.clock.value - 2000;
  const lastResult = { uploaded: true, added: 1, updated: 2, skipped: 3 };
  a.values.state = {
    ...a.values.state, lastUploadAt: a.clock.value - 1000, lastSuccessAt,
    nextAttemptAt: a.clock.value + PULL_INTERVAL, lastError: '上次网络错误', vaultId: key.vaultId,
    received: { [ignored[0].sourceId]: { etag: '"old-etag"', revision: 7 } }, ignored, lastResult,
  };
  delete a.values.state.transportVersion;
  a.add('new-local-event', 20);
  const upgraded = a.makeService(); t.after(() => upgraded.dispose());
  const before = upgraded.status();
  assert.equal(before.lastSuccessAt, lastSuccessAt);
  assert.equal(before.lastError, '上次网络错误');
  assert.deepEqual(before.lastResult, lastResult);
  assert.deepEqual(before.ignored, ignored);
  assert.equal(before.nextCheckAt, a.clock.value);
  assert.equal(before.nextUploadAt, a.clock.value);
  assert.deepEqual(upgraded.state.received, {});
  await upgraded.tick();
  assert.equal(a.values.state.transportVersion, 2);
  assert.deepEqual(a.values.state.ignored, ignored);
  assert.equal(upgraded.status().lastError, '');
  assert.equal(upgraded.status().lastUploadAt, a.clock.value);
  assert.equal(upgraded.status().lastResult.uploaded, true);
  assert.equal(commitFiles(dav, a.id).length, 1);
  const current = await head(dav, a.id);
  assert.equal(current.version, 2);
  assert.ok(current.revision > local.revision);
  assert.equal(dav.files.get(headPath(a.id)), legacy);
});

test('删除来源后暂停自动接收，重启仍有效，恢复接收后更新；远端缺失不删除本地', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint), b = device(t, dav.endpoint);
  a.add('a', 10); b.add('b', 20); await a.service.run(); await b.service.run();
  b.service.ignoreSource(a.id, '公司电脑'); b.db.archives.deleteSource(a.id);
  const restarted = b.makeService(); t.after(() => restarted.dispose());
  await restarted.run({ manual: true }); assert.equal(b.total(), 20);
  restarted.restoreSource(a.id);
  await restarted.run({ manual: true }); assert.equal(b.total(), 30);
  b.db.archives.updateSource({ sourceId: a.id, label: '自定义名', enabled: false });
  a.add('next', 5); await a.service.run({ manual: true }); await restarted.run({ manual: true });
  assert.equal(b.total(), 20);
  assert.equal(b.db.archives.info().imported[0].label, '自定义名');
  assert.equal(b.db.archives.info().imported[0].records, 2);
  for (const file of commitFiles(dav, a.id)) dav.files.delete(file);
  await restarted.run({ manual: true });
  assert.equal(b.db.archives.info().imported[0].records, 2);
});

test('无 ETag 且忽略条件写入的普通 WebDAV 可测试连接并完成双设备同步', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint);
  dav.noEtags = true;
  dav.ignoreConditions = true;
  a.service.saveConfig({ enabled: false });
  assert.deepEqual(await a.service.testConnection(), { ok: true });
  assert.equal(snapshotPuts(dav).length, 0);
  assert.equal([...dav.files.keys()].some((key) => key.includes('probe-')), false);
  a.service.saveConfig({ enabled: true });
  const b = device(t, dav.endpoint);
  a.add('a', 10); b.add('b', 20);
  await a.service.run(); await b.service.run(); await a.service.run({ manual: true });
  assert.equal(a.total(), 30); assert.equal(b.total(), 30);
  assert.equal(dav.requests.some((r) => r.method === 'PUT' && r.condition), false);
  assert.equal(dav.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/sync-key.json')).length, 1);
});

test('测试直接使用尚未保存的表单和六位口令，不修改已有配置或上传档案', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint);
  a.service.saveConfig({ enabled: false });
  const before = structuredClone(a.values);
  const draft = settings(dav.endpoint, { enabled: false, folder: 'UnsavedDraft', passphrase: 'draft6' });
  assert.deepEqual(await a.service.testConnection(draft), { ok: true });
  assert.deepEqual(a.values, before);
  assert.equal(a.service.status().config.folder, 'QuotaDesk');
  assert.equal(a.service.status().running, false);
  assert.equal(snapshotPuts(dav).length, 0);
  const wire = dav.files.get('/dav/UnsavedDraft/sync-key.json').body;
  assert.equal((await decrypt(wire, 'draft6')).kind, 'key');
  await assert.rejects(a.service.testConnection({ ...draft, password: 'incorrect' }), /认证失败/);
  await assert.rejects(a.service.testConnection({ ...draft, passphrase: 'wrong6' }), /无法解密/);
  await assert.rejects(a.service.testConnection({ ...draft, username: '' }), /请填写/);
  assert.deepEqual(a.values, before);
  assert.deepEqual(await a.service.testConnection({ password: '', passphrase: '' }), { ok: true });
});

test('连接测试的整体超时会取消网络请求并结束忙碌状态', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint);
  const service = a.makeService({ connectionTestTimeoutMs: 20, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  t.after(() => service.dispose());
  await assert.rejects(service.testConnection(), /连接测试超时/);
  assert.equal(service.status().running, false);
  assert.equal(service.status().mode, '');
});

test('已有索引但缺少密钥校验文件时拒绝初始化，自己的快照丢失可重传修复', async (t) => {
  const dav = await mockWebDav(t), a = device(t, dav.endpoint);
  a.add('e', 1); await a.service.run();
  const old = await head(dav, a.id);
  dav.files.delete(`/dav/QuotaDesk/${old.blob}`);
  await a.service.run({ manual: true });
  assert.ok((await heads(dav, a.id)).some((value) => value.blob !== old.blob && dav.files.has(`/dav/QuotaDesk/${value.blob}`)));
  const key = dav.files.get('/dav/QuotaDesk/sync-key.json');
  dav.files.delete('/dav/QuotaDesk/sync-key.json');
  await assert.rejects(a.service.run({ manual: true }), /校验文件缺失/);
  assert.equal(dav.files.has('/dav/QuotaDesk/sync-key.json'), false);
  dav.files.set('/dav/QuotaDesk/sync-key.json', key);
});

test('地址与目录校验、WebDAV XML 命名空间和转义，忽略外部 URL 和深层文件', () => {
  for (const endpoint of ['http://example.com/dav/', 'https://user:secret@example.com/dav', 'https://example.com/dav/?key=secret', 'file:///C:/']) assert.throws(() => normalizeConfig({ endpoint }), /HTTPS/);
  for (const folder of ['../secret', 'a/./b', 'a\\b', 'a?b']) assert.throws(() => normalizeConfig({ folder }), /同步目录/);
  const id = crypto.randomUUID(), root = 'https://dav.example/dav/QuotaDesk/';
  const xml = `<multistatus xmlns="DAV:"><response><href>/dav/QuotaDesk/${id}.json</href></response><response><href>https://evil.example/${crypto.randomUUID()}.json</href></response><response><href>/dav/QuotaDesk/sub/${crypto.randomUUID()}.json</href></response></multistatus>`;
  assert.deepEqual(parseListing(xml, root), [id]);
  const nested = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/QuotaDesk/v2</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response><D:response><D:href>/dav/QuotaDesk/sync-key.json</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response></D:multistatus>`;
  assert.deepEqual(parseDirectory(nested, root), [{ name: 'sync-key.json', directory: false }, { name: 'v2', directory: true }]);
  assert.throws(() => parseListing('<!DOCTYPE x><multistatus/>', root), /完整/);
  assert.throws(() => parseListing(xml.slice(0, -5), root), /完整/);
  assert.equal(normalizeConfig({ endpoint: 'https://example.com/dav' }).endpoint, 'https://example.com/dav/');
});

test('目录接近服务端分页上限时，即使全是过滤掉的 Unicode 文件名也拒绝使用不完整清单', () => {
  const root = 'https://dav.example/dav/QuotaDesk/';
  const listing = (count) => `<D:multistatus xmlns:D="DAV:">${Array.from({ length: count }, (_, index) => {
    const name = index % 2 ? encodeURIComponent(`私有档案 ${index}.json`) : `公司电脑${index}.json`;
    return `<D:response><D:href>/dav/QuotaDesk/${name}</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response>`;
  }).join('')}</D:multistatus>`;
  assert.deepEqual(parseDirectory(listing(699), root), []);
  assert.throws(() => parseDirectory(listing(700), root), /子目录文件过多/);
});

test('拒绝重定向，不转发凭据；对流式响应也施加大小上限', async () => {
  const calls = [];
  const dav = new WebDavClient(settings('https://dav.example/dav/'), { fetcher: async (url, options) => { calls.push({ url, options }); return new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }); } });
  await assert.rejects(dav.get('sync-key.json'), /重定向/);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, 'manual'); assert.equal(calls[0].options.credentials, 'omit');
  const oversized = new WebDavClient(settings('https://dav.example/'), { fetcher: async () => new Response('1234567') });
  await assert.rejects(oversized.get('sync-key.json', null, 6), /过大/);
});
