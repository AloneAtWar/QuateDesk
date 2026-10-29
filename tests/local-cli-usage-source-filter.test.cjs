// 档案来源过滤(sourceId)与 since 周期范围:从「用量档案」单独查看某个来源、
// 账号周 / 月额度周期自周期起点精确截断,两条路径的聚合口径。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliUsageStore } = require('../electron/cli-usage/store.cjs');
const { CliUsageService } = require('../electron/cli-usage/index.cjs');
const { buildUsageEvent, localDateString } = require('../electron/cli-usage/normalize.cjs');

const DAY = 86_400_000;
const now = Date.now();

const fixture = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new CliUsageStore(path.join(dir, 'usage.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
};

const event = (key, overrides = {}) => buildUsageEvent({
  eventKey: key, agent: 'claude', occurredAtMs: now - DAY, sessionKey: 's1',
  model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 20, ...overrides,
});
// totalTokens = 各 Token 分量之和(这里固定 新输入 + 输出 20)
const tokens = (input) => input + 20;

const modelsTotal = (store, query) => store.models({ agent: 'all', mergeSameModels: true, timezone: 'UTC', ...query })
  .models.reduce((sum, row) => sum + row.totalTokens, 0);

test('sourceId 过滤:本机 / 导入来源各自完整,合并视图只含启用来源', (t) => {
  const home = fixture(t, 'qd-src-home-');
  const laptop = fixture(t, 'qd-src-laptop-');
  home.upsertEvents([event('h1', { inputTokens: 100, occurredAtMs: now - 2 * DAY })]);
  laptop.upsertEvents([event('l1', { inputTokens: 500, occurredAtMs: now - 2 * DAY })]);
  laptop.upsertEvents([event('l2', { inputTokens: 50, occurredAtMs: now })]);

  const pkg = laptop.archives.exportPackage();
  home.archives.importPackage(pkg, '笔记本.json');
  const importedId = laptop.archives.sourceId;
  const localId = home.archives.sourceId;

  const scope = { kind: 'range', days: 7 };
  // 合并视图:本机 + 导入来源之和
  assert.equal(modelsTotal(home, { scope }), tokens(100) + tokens(500) + tokens(50));
  // 单看本机档案
  assert.equal(modelsTotal(home, { scope, sourceId: localId }), tokens(100));
  // 单看导入档案:即使之后暂停计入汇总,档案自身仍完整可见
  assert.equal(modelsTotal(home, { scope, sourceId: importedId }), tokens(500) + tokens(50));
  home.archives.updateSource({ sourceId: importedId, enabled: false });
  assert.equal(modelsTotal(home, { scope }), tokens(100));
  assert.equal(modelsTotal(home, { scope, sourceId: importedId }), tokens(500) + tokens(50));
  // summary 同口径:总 Token 与渠道记录数都按来源收敛
  const summary = home.summary({ agent: 'all', timezone: 'UTC', days: 7, sourceId: importedId });
  assert.equal(summary.summary.totalTokens, tokens(500) + tokens(50));
  assert.equal(home.countEvents('claude', importedId), 2);
  assert.equal(home.countEvents('claude', localId), 1);
  assert.equal(home.countEvents('claude', null), 1); // 停用后合并视图只剩本机
  // 未知来源:空结果而不是报错
  assert.equal(modelsTotal(home, { scope, sourceId: '0b74a3f0-0000-4000-8000-000000000000' }), 0);
});

test('since 范围:自周期起点精确截断,不是整天对齐', (t) => {
  const store = fixture(t, 'qd-src-since-');
  const sinceMs = now - 5 * DAY + 3 * 3_600_000; // 周期起点在当天 03:00 这类非零点时刻
  store.upsertEvents([
    event('before-day', { inputTokens: 10, occurredAtMs: sinceMs - 2 * 3_600_000, model: 'glm-4.7' }), // 同一天但早于起点
    event('at-start', { inputTokens: 100, occurredAtMs: sinceMs }),
    event('after', { inputTokens: 1000, occurredAtMs: sinceMs + DAY }),
  ]);
  const report = store.models({ agent: 'all', mergeSameModels: true, timezone: 'UTC', scope: { kind: 'since', sinceMs } });
  assert.equal(modelsTotal(store, { scope: { kind: 'since', sinceMs } }), tokens(100) + tokens(1000));
  assert.ok(!report.models.some((row) => row.modelKey === 'glm-4.7'));
  assert.equal(report.range.start, localDateString('UTC', sinceMs));
  assert.equal(report.range.end, localDateString('UTC'));
  // 与固定 7 天范围互补:7 天会把起点之前的事件也圈进来
  assert.equal(modelsTotal(store, { scope: { kind: 'range', days: 7 } }), tokens(10) + tokens(100) + tokens(1000));
});

test('facade 校验:since 起点与档案来源 ID 的合法输入', () => {
  const base = { agent: 'all', timezone: 'UTC' };
  const since = CliUsageService.normalizeModelsQuery({ ...base, scope: { kind: 'since', sinceMs: now - DAY } });
  assert.equal(since.scope.kind, 'since');
  assert.equal(since.scope.sinceMs, now - DAY);
  assert.throws(() => CliUsageService.normalizeModelsQuery({ ...base, scope: { kind: 'since', sinceMs: 'x' } }), /周期起点/);
  assert.throws(() => CliUsageService.normalizeModelsQuery({ ...base, scope: { kind: 'since', sinceMs: now + 10 * DAY } }), /周期起点/);
  const withSource = CliUsageService.normalizeModelsQuery({ ...base, scope: { kind: 'range', days: 7 }, sourceId: '0b74a3f0-1234-4abc-9def-0123456789ab' });
  assert.equal(withSource.sourceId, '0b74a3f0-1234-4abc-9def-0123456789ab');
  assert.equal(CliUsageService.normalizeModelsQuery({ ...base, scope: { kind: 'range', days: 7 } }).sourceId, null);
  assert.throws(() => CliUsageService.normalizeModelsQuery({ ...base, scope: { kind: 'range', days: 7 }, sourceId: '../meta' }), /档案来源/);
  assert.throws(() => CliUsageService.normalizeSummaryQuery({ agent: 'all', timezone: 'UTC', sourceId: 'x'.repeat(200) }), /档案来源/);
  const sources = CliUsageService.normalizeSourcesQuery({ sourceId: '0b74a3f0-1234-4abc-9def-0123456789ab' });
  assert.deepEqual(sources, { sourceId: '0b74a3f0-1234-4abc-9def-0123456789ab' });
  assert.deepEqual(CliUsageService.normalizeSourcesQuery(), { sourceId: null });
});
