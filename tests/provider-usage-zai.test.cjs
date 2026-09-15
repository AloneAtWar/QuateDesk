// Z.ai（智谱开放平台）逐日模型用量适配的单元测试。
// 接口语义参考 CodexBar 的 zai 插件：按月分块查询 model-usage，
// x_time 标签与 modelDataList[].tokensUsage 对齐。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchZaiUsage,
  fetchZaiPlanSummary,
  ProviderUsageError,
  normalizeZaiApiKey,
  normalizeZaiOrigin,
  __test,
} = require('../electron/provider-usage.cjs');

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const usagePayload = (labels, models) => ({
  code: 200,
  success: true,
  data: { x_time: labels, modelDataList: models },
});

const quotaPayload = () => ({
  code: 200,
  success: true,
  data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 12 }], level: 'pro' },
});

test('normalizeZaiApiKey trims and strips Bearer prefix, rejects blanks', () => {
  assert.equal(normalizeZaiApiKey('  abc.def  '), 'abc.def');
  assert.equal(normalizeZaiApiKey('Bearer abc.def'), 'abc.def');
  assert.equal(normalizeZaiApiKey(''), '');
  assert.equal(normalizeZaiApiKey('has space inside'), '');
  assert.equal(normalizeZaiApiKey(null), '');
});

test('normalizeZaiOrigin only trusts bigmodel.cn / z.ai hosts', () => {
  assert.equal(normalizeZaiOrigin('https://open.bigmodel.cn/api/monitor/usage/quota/limit'), 'https://open.bigmodel.cn');
  assert.equal(normalizeZaiOrigin('https://api.z.ai/api/monitor/usage/quota/limit'), 'https://api.z.ai');
  assert.equal(normalizeZaiOrigin('https://evil.example.com/api'), 'https://open.bigmodel.cn');
  assert.equal(normalizeZaiOrigin('http://open.bigmodel.cn'), 'https://open.bigmodel.cn');
  assert.equal(normalizeZaiOrigin('not a url'), 'https://open.bigmodel.cn');
});

test('fetchZaiUsage chunks by month and aggregates per-model daily tokens', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes('/api/monitor/usage/quota/limit')) return jsonResponse(quotaPayload());
    if (url.includes('startTime=2026-08-30')) return jsonResponse(usagePayload(['2026-08-30', '2026-08-31'], [
      { modelName: 'glm-4.6', tokensUsage: [100, 200] },
      { modelName: 'glm-4.5-air', tokensUsage: [50, 0] },
    ]));
    if (url.includes('startTime=2026-09-01')) return jsonResponse(usagePayload(['2026-09-01'], [
      { modelName: 'glm-4.6', tokensUsage: [300] },
    ]));
    throw new Error(`unexpected url ${url}`);
  };
  const result = await fetchZaiUsage('test-key', fetcher, { startDate: '2026-08-30', endDate: '2026-09-01' });
  assert.equal(result.provider, 'zai');
  assert.equal(result.metric, 'tokens');
  assert.equal(result.currency, null);
  assert.equal(result.days.length, 3);
  const aug30 = result.days.find((day) => day.date === '2026-08-30');
  assert.equal(aug30.tokens, 150);
  assert.deepEqual(aug30.models.map((model) => [model.model, model.tokens]), [['glm-4.6', 100], ['glm-4.5-air', 50]]);
  assert.equal(aug30.cost, null);
  const sep1 = result.days.find((day) => day.date === '2026-09-01');
  assert.equal(sep1.tokens, 300);
  assert.equal(result.summary.rangeTokens, 650);
  assert.equal(result.summary.knownRangeTokens, 650);
  assert.equal(result.summary.activeDays, 3);
  assert.equal(result.summary.peakDailyTokens, 300);
  assert.equal(result.summary.planName, 'pro');
  assert.equal(result.coverage.tokens.complete, true);
  assert.equal(result.coverage.partial, false);
  // 按月分块：两个月各一次 model-usage + 一次 quota/limit 套餐查询
  assert.equal(calls.filter((url) => url.includes('model-usage')).length, 2);
  assert.equal(calls.filter((url) => url.includes('quota/limit')).length, 1);
  assert.ok(calls[0].startsWith('https://open.bigmodel.cn/api/monitor/usage/model-usage'));
});

test('fetchZaiUsage resolves MM-DD labels and index-aligned fallbacks', async () => {
  const fetcher = async (url) => {
    if (url.includes('quota/limit')) return jsonResponse(quotaPayload());
    if (url.includes('startTime=2026-09-01')) return jsonResponse(usagePayload(['09-01', '09-02', 'bogus-label'], [
      { modelName: 'glm-4.6', tokensUsage: [10, 20, 30] },
    ]));
    throw new Error(`unexpected url ${url}`);
  };
  const result = await fetchZaiUsage('k', fetcher, { startDate: '2026-09-01', endDate: '2026-09-03' });
  assert.equal(result.days[0].tokens, 10);
  assert.equal(result.days[1].tokens, 20);
  // 无法解析的标签按块内序号对齐到第三天
  assert.equal(result.days[2].tokens, 30);
});

test('fetchZaiUsage marks uncovered days as null when a chunk fails', async () => {
  const fetcher = async (url) => {
    if (url.includes('quota/limit')) return jsonResponse(quotaPayload());
    if (url.includes('startTime=2026-08-31')) throw new Error('boom');
    return jsonResponse(usagePayload(['2026-09-01'], [{ modelName: 'glm-4.6', tokensUsage: [7] }]));
  };
  const result = await fetchZaiUsage('k', fetcher, { startDate: '2026-08-31', endDate: '2026-09-01' });
  const aug = result.days.find((day) => day.date === '2026-08-31');
  const sep = result.days.find((day) => day.date === '2026-09-01');
  assert.equal(aug.tokens, null);
  assert.equal(sep.tokens, 7);
  assert.equal(result.summary.rangeTokens, null);
  assert.equal(result.summary.knownRangeTokens, 7);
  assert.equal(result.coverage.tokens.complete, false);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.issues.length, 1);
});

test('fetchZaiUsage throws AUTH_EXPIRED on business auth failure', async () => {
  const fetcher = async () => jsonResponse({ code: 1001, success: false, msg: 'Header中未收到Authorization参数，无法进行身份验证。' });
  await assert.rejects(
    () => fetchZaiUsage('bad-key', fetcher, { startDate: '2026-09-01', endDate: '2026-09-02' }),
    (error) => error instanceof ProviderUsageError && error.code === 'AUTH_EXPIRED',
  );
});

test('fetchZaiUsage rejects missing credentials and invalid ranges', async () => {
  await assert.rejects(() => fetchZaiUsage('', async () => jsonResponse({})), /缺少 Z\.ai API Key/);
  await assert.rejects(() => fetchZaiUsage('k'), /缺少网络请求实现/);
  await assert.rejects(
    () => fetchZaiUsage('k', async () => jsonResponse({}), { startDate: '2026-09-02', endDate: '2026-09-01' }),
    /startDate 不能晚于 endDate/,
  );
});

test('fetchZaiPlanSummary extracts the plan name defensively', async () => {
  const plan = await fetchZaiPlanSummary('k', async () => jsonResponse(quotaPayload()));
  assert.equal(plan.planName, 'pro');
  assert.equal(plan.limits, 1);
  const empty = await fetchZaiPlanSummary('k', async () => jsonResponse({ code: 200, success: true, data: {} }));
  assert.equal(empty.planName, null);
});

test('zaiLabelDate handles epoch labels within the chunk timezone', () => {
  const chunk = { startDate: '2026-09-01', endDate: '2026-09-30' };
  // 2026-09-10 00:00:00 UTC+8 = 2026-09-09T16:00:00Z
  const epochSec = Math.floor(Date.UTC(2026, 8, 9, 16, 0, 0) / 1000);
  assert.equal(__test.zaiLabelDate(String(epochSec), chunk, 0, __test.ZAI_TIMEZONE_OFFSET_SEC), '2026-09-10');
  assert.equal(__test.zaiLabelDate('2026-09-05', chunk, 0, __test.ZAI_TIMEZONE_OFFSET_SEC), '2026-09-05');
});

test('zaiModelUsageData treats missing data as empty and rejects bad shapes', () => {
  assert.deepEqual(__test.zaiModelUsageData({ code: 200, success: true, data: {} }), { x_time: [], modelDataList: [] });
  assert.deepEqual(__test.zaiModelUsageData({ code: 200, success: true }), { x_time: [], modelDataList: [] });
  assert.equal(__test.zaiModelUsageData({ code: 200, success: true, data: { x_time: 'nope' } }), null);
  assert.equal(__test.zaiModelUsageData({ code: 200, success: true, data: { x_time: [], modelDataList: [{ tokensUsage: 'bad' }] } }), null);
});

const activityPayload = () => ({
  code: 200,
  success: true,
  data: {
    summary: {
      totalTokens: 4166725838,
      peakDailyTokens: 148809007,
      peakDailyTokensDate: '2026-08-20',
      totalUsageDurationMs: 264753209,
      currentStreakDays: 3,
      longestStreakDays: 30,
    },
    series: [
      { date: '2026-08-30', totalTokens: 111, modelCallCount: 5, mcpCalls: 1 },
      { date: '2026-08-31', totalTokens: 222, modelCallCount: 6, mcpCalls: 0 },
      { date: '2026-09-01', totalTokens: 333, modelCallCount: 7, mcpCalls: 2 },
    ],
  },
});

test('fetchZaiUsage merges credit-usage/activity account totals and summary', async () => {
  const fetcher = async (url) => {
    if (url.includes('/api/monitor/credit-usage/activity')) return jsonResponse(activityPayload());
    if (url.includes('quota/limit')) return jsonResponse(quotaPayload());
    if (url.includes('startTime=')) return jsonResponse(usagePayload(['2026-09-01'], [
      { modelName: 'glm-4.6', tokensUsage: [300] },
    ]));
    throw new Error(`unexpected url ${url}`);
  };
  const result = await fetchZaiUsage('k', fetcher, { startDate: '2026-08-30', endDate: '2026-09-01' });
  // 逐日总量以 activity 为准（与 ZCode 统计页同口径），不再用逐模型加总
  assert.deepEqual(result.days.map((day) => day.tokens), [111, 222, 333]);
  assert.equal(result.summary.totalTokens, 4166725838);
  assert.equal(result.summary.peakDailyTokens, 148809007);
  assert.equal(result.summary.peakDailyTokensDate, '2026-08-20');
  assert.equal(result.summary.currentStreakDays, 3);
  assert.equal(result.summary.longestStreakDays, 30);
  assert.equal(result.summary.totalUsageDurationMs, 264753209);
  assert.equal(result.summary.activeDays, 3);
  assert.equal(result.coverage.source, 'credit-usage/activity + model-usage');
  assert.equal(result.coverage.tokens.complete, true);
});

test('fetchZaiUsage skips model-usage chunks beyond the retention window', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes('/api/monitor/credit-usage/activity')) return jsonResponse(activityPayload());
    if (url.includes('quota/limit')) return jsonResponse(quotaPayload());
    return jsonResponse(usagePayload([], []));
  };
  // 区间为 3 个月，但 model-usage 只应查询末尾 60 天内的块
  const result = await fetchZaiUsage('k', fetcher, { startDate: '2026-06-15', endDate: '2026-09-01' });
  const modelUsageCalls = calls.filter((url) => url.includes('model-usage'));
  assert.ok(modelUsageCalls.length >= 1);
  assert.ok(modelUsageCalls.every((url) => !url.includes('startTime=2026-06')));
  // activity 覆盖不到的日期保持未覆盖（null），不打全零
  assert.equal(result.days[0].tokens, null);
  assert.equal(result.coverage.tokens.complete, false);
  assert.equal(result.summary.totalTokens, 4166725838);
});

test('fetchZaiUsage falls back to model-usage totals when activity is unavailable', async () => {
  const fetcher = async (url) => {
    if (url.includes('/api/monitor/credit-usage/activity')) throw new Error('404');
    if (url.includes('quota/limit')) return jsonResponse(quotaPayload());
    if (url.includes('startTime=2026-09-01')) return jsonResponse(usagePayload(['2026-09-01'], [
      { modelName: 'glm-4.6', tokensUsage: [42] },
    ]));
    throw new Error(`unexpected url ${url}`);
  };
  const result = await fetchZaiUsage('k', fetcher, { startDate: '2026-09-01', endDate: '2026-09-01' });
  assert.equal(result.days[0].tokens, 42);
  assert.equal(result.summary.totalTokens, null);
  assert.equal(result.summary.currentStreakDays, null);
  assert.equal(result.summary.peakDailyTokens, 42);
});

test('zaiActivityData parses summary defensively and filters bad series entries', () => {
  const parsed = __test.zaiActivityData(activityPayload());
  assert.equal(parsed.summary.totalTokens, 4166725838);
  assert.equal(parsed.series.length, 3);
  const messy = __test.zaiActivityData({
    code: 200,
    data: {
      summary: { totalTokens: 'oops', currentStreakDays: -2 },
      series: [{ date: 'not-a-date', totalTokens: 5 }, { date: '2026-09-01', totalTokens: 7 }],
    },
  });
  assert.equal(messy.summary.totalTokens, null);
  assert.equal(messy.summary.currentStreakDays, null);
  assert.deepEqual(messy.series, [{ date: '2026-09-01', tokens: 7, modelCallCount: 0, mcpCalls: 0 }]);
  assert.deepEqual(__test.zaiActivityData({ code: 200, success: true }), { summary: null, series: [] });
});

