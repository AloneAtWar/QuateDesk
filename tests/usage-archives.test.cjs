const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CliUsageStore } = require('../electron/cli-usage/store.cjs');

const today = Date.now() - 60_000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-usage-archives-'));
  const dbPath = path.join(dir, 'usage.sqlite');
  const store = new CliUsageStore(dbPath);
  t.after(() => {
    store.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, archives: store.archives, dbPath };
}
function event(key, total = 100, extra = {}) {
  return { eventKey: key, agent: 'claude', rootId: 'root-shared', occurredAtMs: today, sessionKey: 'session-shared', projectKey: 'project-shared',
    model: 'claude-sonnet-4-5', canonicalModelKey: 'claude-sonnet-4-5', inputTokens: total, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, reasoningTokens: 0, extraTokens: 0, totalTokens: total, requestCount: 1, sourceVersion: null, exact: true, isSidechain: false, ...extra };
}
const total = (store) => store.totalTokensAll('all');

test('旧库档案身份持久化，重复扫描与导出不改变版本，本机回流始终跳过', (t) => {
  const { store, archives, dbPath } = fixture(t);
  store.upsertEvents([event('e1')]);
  const first = archives.exportPackage();
  store.upsertEvents([event('e1')]);
  assert.deepEqual(archives.exportPackage().archives, first.archives);
  assert.equal(archives.importPackage(first).results[0].status, 'self');
  assert.equal(total(store), 100);
  assert.equal(archives.info().imported.length, 0);
  const other = new CliUsageStore(dbPath);
  try { assert.equal(other.archives.sourceId, archives.sourceId); } finally { other.close(); }
  const oldId = archives.sourceId;
  archives.updateSource({ sourceId: oldId, label: '公司电脑' });
  assert.equal(archives.sourceId, oldId);
  assert.ok(archives.info().local.revision > first.archives[0].revision);
  assert.throws(() => archives.deleteSource(oldId), /本机档案/);
});

test('周三全量、周五全量、重复文件和旧文件：每来源仅保留一份，更新后正确汇总', (t) => {
  const company = fixture(t);
  const home = fixture(t);
  company.store.upsertEvents([event('wednesday', 100)]);
  home.store.upsertEvents([event('home', 200)]);
  const wednesday = company.archives.exportPackage();
  assert.equal(home.archives.importPackage(wednesday, '周三.json').results[0].status, 'added');
  assert.equal(total(home.store), 300);
  assert.equal(home.archives.importPackage(wednesday, '改名后的同一文件.json').results[0].status, 'duplicate');
  assert.equal(total(home.store), 300);
  company.store.upsertEvents([event('friday', 60)]);
  const friday = company.archives.exportPackage();
  assert.equal(home.archives.importPackage(friday, '周五.json').results[0].status, 'updated');
  assert.equal(total(home.store), 360);
  assert.equal(home.archives.info().imported.length, 1);
  assert.equal(home.archives.importPackage(wednesday).results[0].status, 'older');
  assert.equal(total(home.store), 360);
  assert.equal(home.archives.info().history.length, 4);
  assert.equal(home.store.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get().n, 1);
});

test('全量快照能反映删除和向下修正，空快照也可以更新来源', (t) => {
  const a = fixture(t), b = fixture(t);
  a.store.upsertEvents([event('remove-me', 100), event('keep', 50)]);
  b.archives.importPackage(a.archives.exportPackage());
  assert.equal(total(b.store), 150);
  a.store.deleteEvents('claude', { eventKeyPrefix: 'remove-me' });
  b.archives.importPackage(a.archives.exportPackage());
  assert.equal(total(b.store), 50);
  a.store.deleteEvents('claude');
  b.archives.importPackage(a.archives.exportPackage());
  assert.equal(total(b.store), 0);
  assert.equal(b.archives.info().imported.length, 1);
});

test('多来源转存保留来源身份和版本，本机和旧版本跳过，默认只导出本机', (t) => {
  const a = fixture(t), b = fixture(t), c = fixture(t);
  a.store.upsertEvents([event('a', 100)]);
  b.store.upsertEvents([event('b', 200)]);
  b.archives.importPackage(a.archives.exportPackage());
  assert.equal(b.archives.exportPackage().archives.length, 1);
  const bundle = b.archives.exportPackage('all');
  assert.equal(bundle.archives.length, 2);
  assert.deepEqual(bundle.archives.find((s) => s.sourceId === a.archives.sourceId), a.archives.exportPackage().archives[0]);
  assert.deepEqual(a.archives.importPackage(bundle).results.map((r) => r.status).sort(), ['added', 'self']);
  assert.equal(total(a.store), 300);
  c.archives.importPackage(bundle);
  a.store.upsertEvents([event('newer', 60)]);
  c.archives.importPackage(a.archives.exportPackage());
  assert.equal(c.archives.importPackage(bundle).results.find((r) => r.sourceId === a.archives.sourceId).status, 'older');
  assert.equal(total(c.store), 360);
});

test('来源启停、显示名称和删除只作用于导入档案，更新保留本地管理选择', (t) => {
  const a = fixture(t), b = fixture(t);
  a.store.upsertEvents([event('same-key', 100)]);
  b.store.upsertEvents([event('same-key', 200)]);
  b.archives.importPackage(a.archives.exportPackage());
  const sourceId = a.archives.sourceId;
  b.archives.updateSource({ sourceId, enabled: false, label: '公司档案别名' });
  assert.equal(total(b.store), 200);
  assert.equal(b.archives.exportPackage('all').archives.find((s) => s.sourceId === sourceId).label, a.archives.info().local.label);
  a.store.upsertEvents([event('new', 20)]);
  b.archives.importPackage(a.archives.exportPackage());
  assert.equal(b.archives.info().imported[0].enabled, false);
  assert.equal(b.archives.info().imported[0].label, '公司档案别名');
  b.archives.updateSource({ sourceId, enabled: true });
  assert.equal(total(b.store), 320);
  const history = b.archives.info().history.length;
  b.archives.deleteSource(sourceId);
  assert.equal(total(b.store), 200);
  assert.equal(b.archives.info().history.length, history);
  assert.equal(b.archives.info().imported.length, 0);
});

test('导入会话与项目按来源隔离，summary/models/v1 口径一致，扫描删除不会影响导入', (t) => {
  const a = fixture(t), b = fixture(t);
  a.store.upsertEvents([event('same-key', 100)]);
  a.store.saveProjectLabel('project-shared', 'company-project');
  b.store.upsertEvents([event('same-key', 200)]);
  b.store.saveProjectLabel('project-shared', 'home-project');
  b.archives.importPackage(a.archives.exportPackage());
  const report = b.store.summary({ agent: 'all', timezone: 'UTC' });
  assert.equal(report.summary.totalTokens, 300);
  assert.equal(report.summary.sessions, 2);
  assert.equal(report.archiveScope.importedSources, 1);
  const models = b.store.models({ agent: 'all', timezone: 'UTC', scope: { kind: 'range', days: 0 } });
  assert.equal(models.models.reduce((sum, r) => sum + r.totalTokens, 0), 300);
  const api = b.store.v1Aggregate({ startMs: today - 1000, endMs: today + 1000, timezone: 'UTC', groupBy: 'project' });
  assert.equal(api.totals.totalTokens, 300);
  assert.equal(api.groups.length, 2);
  assert.deepEqual(api.groups.map((g) => g.label).sort(), ['company-project', 'home-project']);
  b.store.registerRoots('claude', [{ rootId: 'root-shared', isWsl: true }]);
  b.store.purgeWslRoots();
  assert.equal(total(b.store), 100);
  b.store.deleteEvents('claude');
  assert.equal(total(b.store), 100);
});

test('同版本不同内容拒绝覆盖，损坏文件、重复来源和缺失完整标记拒绝导入', (t) => {
  const a = fixture(t), b = fixture(t);
  a.store.upsertEvents([event('a', 100)]);
  const original = a.archives.exportPackage();
  b.archives.importPackage(original);
  a.store.upsertEvents([event('a2', 60)]);
  // Simulate an origin restored with conflicting contents at an already-used revision.
  a.store.db.prepare("UPDATE meta SET value = ? WHERE key = 'archive_revision'").run(String(original.archives[0].revision));
  const conflict = a.archives.exportPackage();
  assert.equal(b.archives.importPackage(conflict).results[0].status, 'conflict');
  assert.equal(total(b.store), 100);
  const broken = structuredClone(original);
  broken.archives[0].records[0].input_tokens += 1;
  assert.throws(() => b.archives.importPackage(broken), /校验失败/);
  const partial = structuredClone(original);
  partial.archives[0].complete = false;
  assert.throws(() => b.archives.importPackage(partial), /完整/);
  const repeated = structuredClone(original);
  repeated.archives.push(repeated.archives[0]);
  assert.throws(() => b.archives.importPackage(repeated), /来源/);
  assert.equal(total(b.store), 100);
});

test('多来源导入在中途写入失败时整体回滚，原档案和历史保持不变', (t) => {
  const a = fixture(t), b = fixture(t), c = fixture(t);
  a.store.upsertEvents([event('ok', 100)]);
  b.store.upsertEvents([event('fail', 200)]);
  const bundle = a.archives.exportPackage();
  bundle.archives.push(b.archives.exportPackage().archives[0]);
  c.store.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON imported_usage_events WHEN NEW.event_key = 'fail' BEGIN SELECT RAISE(ABORT, 'test disk write failure'); END;");
  assert.throws(() => c.archives.importPackage(bundle), /test disk write failure/);
  assert.equal(c.archives.info().imported.length, 0);
  assert.equal(c.archives.info().history.length, 0);
  assert.equal(total(c.store), 0);
});

test('未知模型和非 ASCII 标识可以完整往返，文件不导出扫描游标或凭据', (t) => {
  const a = fixture(t), b = fixture(t);
  a.store.upsertEvents([event('会话:😀', 100, { model: null, canonicalModelKey: '' })]);
  const pkg = a.archives.exportPackage();
  assert.equal(b.archives.importPackage(JSON.parse(JSON.stringify(pkg))).results[0].status, 'added');
  assert.equal(total(b.store), 100);
  assert.equal(pkg.credentials, undefined);
  assert.equal(pkg.archives[0].source_files, undefined);
});
