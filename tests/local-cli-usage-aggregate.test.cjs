// 聚合契约与不变量:总数守恒、合并开关不改变总量、未知模型按渠道隔离、
// 单渠道强制不合并、时区分桶、扫描幂等与来源隔离。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliUsageStore, AGENT_ORDER } = require('../electron/cli-usage/store.cjs');
const { buildUsageEvent } = require('../electron/cli-usage/normalize.cjs');
const { CliUsageService } = require('../electron/cli-usage/index.cjs');

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-cli-agg-'));
  const store = new CliUsageStore(path.join(dir, 'cli-usage.sqlite'));
  return { store, dir };
};

const DAY = 86_400_000;
// 相对区间测试必须跟随运行日，避免固定夹具在数日后滑出“近 7 天”。
const now = Date.now();

const event = (overrides) => buildUsageEvent({
  eventKey: `k:${overrides.agent}:${overrides.session || 'sess-1'}:${overrides.model || 'm'}:${overrides.at}`,
  occurredAtMs: overrides.at, sessionKey: overrides.session || 'sess-1', model: overrides.model || 'glm-4.7',
  inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10, outputTokens: 40,
  providerTotalTokens: null, ...overrides,
});

const seedBase = (store) => {
  store.upsertEvents([
    event({ agent: 'zcode', at: now - 2 * DAY, model: 'GLM-4.7', session: 'sz1' }),
    event({ agent: 'zcode', at: now - DAY, model: 'glm-4.7', session: 'sz1' }),
    // 同一模型在两个 CLI 中出现:开启合并后应跨渠道合为一行
    event({ agent: 'zcode', at: now - DAY, model: 'claude-sonnet-4-5', session: 'sz1' }),
    event({ agent: 'claude', at: now - DAY, model: 'claude-sonnet-4-5', session: 'sc1' }),
    event({ agent: 'claude', at: now - DAY, model: 'claude-sonnet-4-5', session: 'sc2' }),
    event({ agent: 'codex', at: now, model: null, session: 'sx1' }),
    event({ agent: 'codex', at: now, model: '', session: 'sx2' }),
  ].filter(Boolean));
};

const totalOf = (report) => report.models.reduce((sum, row) => sum + row.totalTokens, 0);

test('聚合总数 = 各渠道同区间之和;total >= classified,差额进 extra', () => {
  const { store } = createStore();
  seedBase(store);
  store.upsertEvents([
    buildUsageEvent({
      eventKey: 'x:extra:1', agent: 'zcode', occurredAtMs: now, sessionKey: 's', model: 'glm-4.7',
      inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, providerTotalTokens: 20,
    }),
  ]);
  const all = store.models({ agent: 'all', mergeSameModels: true, scope: { kind: 'range', days: 7 }, timezone: 'UTC' });
  const byAgent = AGENT_ORDER.map((agent) => totalOf(store.models({ agent, mergeSameModels: false, scope: { kind: 'range', days: 7 }, timezone: 'UTC' })));
  assert.equal(totalOf(all), byAgent.reduce((sum, value) => sum + value, 0));
  const glm = all.models.find((row) => row.modelKey === 'glm-4.7');
  assert.ok(glm.extraTokens >= 5); // 20 - 15 的差额进入 extra
  for (const row of all.models) {
    assert.ok(row.totalTokens >= row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens);
  }
  store.close();
});

test('合并开关只改变分组,不改变区间总 Token', () => {
  const { store } = createStore();
  seedBase(store);
  const scope = { kind: 'range', days: 7 };
  const merged = store.models({ agent: 'all', mergeSameModels: true, scope, timezone: 'UTC' });
  const split = store.models({ agent: 'all', mergeSameModels: false, scope, timezone: 'UTC' });
  assert.equal(totalOf(merged), totalOf(split));
  // GLM 大小写变体在 zcode 内归一;claude-sonnet-4-5 跨渠道合并成一行
  const sonnetMerged = merged.models.filter((row) => row.modelKey === 'claude-sonnet-4-5');
  assert.equal(sonnetMerged.length, 1);
  assert.deepEqual(sonnetMerged[0].agents.sort(), ['claude', 'zcode']);
  // 关闭后按渠道拆开
  const sonnetSplit = split.models.filter((row) => row.modelKey === 'claude-sonnet-4-5');
  assert.equal(sonnetSplit.length, 2);
  store.close();
});

test('未知模型永远按渠道隔离,不跨渠道误合并', () => {
  const { store } = createStore();
  seedBase(store);
  const merged = store.models({ agent: 'all', mergeSameModels: true, scope: { kind: 'range', days: 7 }, timezone: 'UTC' });
  const unknown = merged.models.filter((row) => row.displayName === '未知模型');
  assert.equal(unknown.length, 1); // 只来自 codex(null 和空串同渠道内合并)
  assert.deepEqual(unknown[0].agents, ['codex']);
  assert.equal(unknown[0].sessions, 2);
  store.close();
});

test('单渠道即使传 mergeSameModels: true 也按 false 执行,filter 如实返回', () => {
  const { store } = createStore();
  seedBase(store);
  const report = store.models({ agent: 'zcode', mergeSameModels: true, scope: { kind: 'range', days: 7 }, timezone: 'UTC' });
  assert.equal(report.filter.effectiveMergeSameModels, false);
  assert.ok(report.models.every((row) => row.agents.length === 1 && row.agents[0] === 'zcode'));
  store.close();
});

test('模型行按 total 降序,share 相加为 1,排序稳定', () => {
  const { store } = createStore();
  seedBase(store);
  const report = store.models({ agent: 'all', mergeSameModels: true, scope: { kind: 'range', days: 7 }, timezone: 'UTC' });
  const totals = report.models.map((row) => row.totalTokens);
  const sorted = [...totals].sort((left, right) => right - left);
  assert.deepEqual(totals, sorted);
  const shareSum = report.models.reduce((sum, row) => sum + row.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
  const again = store.models({ agent: 'all', mergeSameModels: true, scope: { kind: 'range', days: 7 }, timezone: 'UTC' });
  assert.deepEqual(again.models.map((row) => row.modelKey), report.models.map((row) => row.modelKey));
  store.close();
});

test('summary:时区分桶、连续天数、峰值、活跃日、缓存复用率', () => {
  const { store } = createStore();
  // UTC 9/21 10:00 = 上海 9/21 18:00;UTC 9/22 17:00 = 上海 9/23 01:00
  store.upsertEvents([
    event({ agent: 'zcode', at: Date.UTC(2026, 8, 21, 10), model: 'glm-4.7', session: 'sz1' }),
    event({ agent: 'zcode', at: Date.UTC(2026, 8, 22, 17), model: 'glm-4.7', session: 'sz1' }),
    event({ agent: 'claude', at: Date.UTC(2026, 8, 22, 17), model: 'claude-sonnet-4-5', session: 'sc1' }),
  ]);
  const report = store.summary({ agent: 'all', timezone: 'Asia/Shanghai', endDate: '2026-09-23', days: 365 });
  const day21 = report.days.find((row) => row.date === '2026-09-21');
  const day23 = report.days.find((row) => row.date === '2026-09-23');
  assert.equal(day21.totalTokens, 200);
  assert.equal(day23.totalTokens, 400);
  assert.equal(report.summary.peakTokens, 400);
  assert.equal(report.summary.activeDays, 2);
  // 9/22(上海)无数据 → 当前连续 1(9/23),最长 1
  assert.equal(report.summary.currentStreakDays, 1);
  assert.equal(report.summary.longestStreakDays, 1);
  assert.equal(report.summary.inputTokens, 300);
  assert.equal(report.summary.cacheReadTokens, 150);
  assert.equal(report.summary.sessions, 2);
  // cacheReuse = cacheRead / (input + cacheRead + cacheWrite)
  assert.ok(Math.abs(report.summary.cacheReuseRatio - 150 / 480) < 1e-9);
  // 9/23 当天双渠道:agents 明细
  assert.equal(day23.agents.zcode, 200);
  assert.equal(day23.agents.claude, 200);
  assert.equal(day23.sessions, 2);
  store.close();
});

test('summary 累计口径:更早历史存在时 coverageComplete = false', () => {
  const { store } = createStore();
  store.upsertEvents([
    event({ agent: 'zcode', at: Date.UTC(2026, 0, 1), model: 'old-model' }),
    event({ agent: 'zcode', at: now, model: 'glm-4.7' }),
  ]);
  const report = store.summary({ agent: 'all', timezone: 'UTC', endDate: '2026-09-22', days: 30 });
  assert.equal(report.summary.coverageComplete, false);
  assert.equal(report.summary.totalTokens, 400); // 全部历史,不只是窗口内
  store.close();
});

test('重扫/重复写入后总数不变(幂等 UPSERT)', () => {
  const { store } = createStore();
  seedBase(store);
  const before = store.totalTokensAll('all');
  seedBase(store); // 同一批事件再写一次
  seedBase(store);
  assert.equal(store.totalTokensAll('all'), before);
  store.close();
});

test('day scope:单日模型查询与该日 summary 对齐', () => {
  const { store } = createStore();
  seedBase(store);
  const previousDate = new Date(now - DAY).toISOString().slice(0, 10);
  const report = store.models({ agent: 'all', mergeSameModels: true, scope: { kind: 'day', date: previousDate }, timezone: 'UTC' });
  assert.equal(report.range.start, previousDate);
  assert.equal(report.range.end, previousDate);
  // zcode glm + zcode sonnet + claude sonnet ×2 = 800
  assert.equal(totalOf(report), 800);
  store.close();
});

test('渠道筛选:单渠道 summary 只统计该渠道', () => {
  const { store } = createStore();
  seedBase(store);
  const report = store.summary({ agent: 'claude', timezone: 'UTC', endDate: '2026-09-23', days: 30 });
  assert.equal(report.summary.totalTokens, 400);
  assert.ok(report.days.every((day) => Object.keys(day.agents).every((agent) => agent === 'claude')));
  store.close();
});

test('厂商模型规则同时筛选 summary 累计/热力图与 models 明细', () => {
  const { store } = createStore();
  seedBase(store);
  const endDate = new Date(now).toISOString().slice(0, 10);
  const claudeRules = [{ mode: 'regex', value: '^claude(?:-|$)' }];
  const summary = store.summary({ agent: 'all', timezone: 'UTC', endDate, days: 7, modelRules: claudeRules });
  assert.equal(summary.summary.totalTokens, 600);
  assert.equal(summary.days.reduce((sum, day) => sum + day.totalTokens, 0), 600);
  assert.equal(summary.summary.activeDays, 1);
  assert.deepEqual(summary.matchedModels.map((model) => model.key), ['claude-sonnet-4-5']);
  assert.equal(summary.recordsByAgent.zcode, 1);
  assert.equal(summary.recordsByAgent.claude, 2);
  assert.equal(summary.recordsByAgent.kimi, 0);
  assert.equal(summary.recordsByAgent.codex, 0);

  const claudeOnly = store.summary({ agent: 'claude', timezone: 'UTC', endDate, days: 7, modelRules: claudeRules });
  assert.deepEqual(claudeOnly.matchedModels.map((model) => model.key), ['claude-sonnet-4-5']);
  // 渠道可用性始终覆盖全部 CLI，便于下拉框禁用当前厂商没有数据的渠道。
  assert.equal(claudeOnly.recordsByAgent.zcode, 1);
  assert.equal(claudeOnly.recordsByAgent.claude, 2);

  const models = store.models({ agent: 'all', mergeSameModels: true, scope: { kind: 'range', days: 7 }, timezone: 'UTC', modelRules: claudeRules });
  assert.equal(totalOf(models), 600);
  assert.deepEqual(models.models.map((row) => row.modelKey), ['claude-sonnet-4-5']);

  const exact = store.models({ agent: 'all', mergeSameModels: true, scope: { kind: 'range', days: 7 }, timezone: 'UTC', modelRules: [{ mode: 'exact', value: 'anthropic/claude-sonnet-4-5' }] });
  assert.equal(totalOf(exact), 600);
  store.close();
});

test('同一模型规则可用于多个厂商上下文，查询互不改变全局总量', () => {
  const { store } = createStore();
  seedBase(store);
  const scope = { kind: 'range', days: 7 };
  const global = store.models({ agent: 'all', mergeSameModels: true, scope, timezone: 'UTC' });
  const firstContext = store.models({ agent: 'all', mergeSameModels: true, scope, timezone: 'UTC', modelRules: [{ mode: 'regex', value: '^glm-' }] });
  const secondContext = store.models({ agent: 'all', mergeSameModels: true, scope, timezone: 'UTC', modelRules: [{ mode: 'exact', value: 'GLM-4.7' }] });
  assert.equal(totalOf(firstContext), 400);
  assert.equal(totalOf(secondContext), 400);
  assert.equal(totalOf(global), 1400);
  const globalSummary = store.summary({ agent: 'all', timezone: 'UTC', endDate: new Date(now).toISOString().slice(0, 10), days: 7 });
  assert.deepEqual(globalSummary.matchedModels, []);
  assert.equal(globalSummary.recordsByAgent, null);
  store.close();
});

test('facade 参数校验:非法 agent/timezone/scope/days 直接拒绝', () => {
  assert.throws(() => CliUsageService.normalizeSummaryQuery({ agent: 'nope', timezone: 'UTC' }));
  assert.throws(() => CliUsageService.normalizeSummaryQuery({ agent: 'all', timezone: 'Bad/Zone' }));
  assert.throws(() => CliUsageService.normalizeSummaryQuery({ agent: 'all', timezone: 'UTC', endDate: '2026-02-30' }));
  const okSummary = CliUsageService.normalizeSummaryQuery({ agent: 'zcode', timezone: 'UTC' });
  assert.match(okSummary.endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.throws(() => CliUsageService.normalizeModelsQuery({ agent: 'all', timezone: 'UTC', scope: { kind: 'range', days: 14 } }));
  assert.throws(() => CliUsageService.normalizeModelsQuery({ agent: 'all', timezone: 'UTC', scope: { kind: 'week' } }));
  assert.throws(() => CliUsageService.normalizeModelsQuery({ agent: 'all', timezone: 'UTC' }));
  assert.throws(() => CliUsageService.normalizeModelsQuery({ agent: 'all', timezone: 'UTC', scope: { kind: 'day', date: 'oops' } }));
  assert.throws(() => CliUsageService.normalizeSummaryQuery({ agent: 'all', timezone: 'UTC', modelRules: [{ mode: 'regex', value: '(' }] }));
  assert.throws(() => CliUsageService.normalizeModelsQuery({ agent: 'all', timezone: 'UTC', scope: { kind: 'range', days: 30 }, modelRules: [{ mode: 'prefix', value: 'glm-' }] }));
  const okModels = CliUsageService.normalizeModelsQuery({ agent: 'all', timezone: 'UTC', scope: { kind: 'range', days: 90 } });
  assert.deepEqual(okModels.scope, { kind: 'range', days: 90 });
  const scopedModels = CliUsageService.normalizeModelsQuery({ agent: 'all', timezone: 'UTC', scope: { kind: 'range', days: 30 }, modelRules: [{ mode: 'exact', value: 'OpenAI/GPT-5.6-Sol' }] });
  assert.deepEqual(scopedModels.modelRules, [{ mode: 'exact', value: 'gpt-5.6-sol' }]);
});
