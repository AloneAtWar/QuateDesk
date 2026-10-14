// /api/v1 契约测试:时间参数解析与优先级、粒度协商、聚合正确性、
// 服务级信封/鉴权/错误码、浪费口径与项目标签可见面。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// storage.cjs 依赖 electron 的 app/safeStorage,测试注入内存替身
const electronStub = {
  app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'quota-desk-api-v1-')) },
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

const { parseTimeRange, negotiateGranularity, applyTop, ApiError } = require('../electron/api-v1.cjs');
const { CliUsageStore } = require('../electron/cli-usage/store.cjs');
const { buildUsageEvent } = require('../electron/cli-usage/normalize.cjs');
const { createRemoteViewServer } = require('../electron/remote-view.cjs');
const { DesktopStore } = require('../electron/storage.cjs');

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-14T08:30:00Z');
const params = (query) => new URLSearchParams(query);
const expectApiError = (fn, code) => assert.throws(fn, (error) => error instanceof ApiError && error.code === code);

// ---- 时间参数 ------------------------------------------------------------

test('时间参数优先级:date > from/to > last;同时传只取 date', () => {
  const result = parseTimeRange(params('date=2026-10-14&from=2026-09-01T00:00:00Z&last=3d&tz=UTC'), { now: NOW });
  assert.equal(result.resolved.kind, 'date');
  assert.equal(result.fromMs, Date.UTC(2026, 9, 14));
  assert.equal(result.toMs, Date.UTC(2026, 9, 15));
});

test('from+to:ISO 带偏移直接解析;缺 to 视为 now', () => {
  const withTo = parseTimeRange(params('from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z&tz=UTC'), { now: NOW });
  assert.equal(withTo.resolved.kind, 'range');
  assert.equal(withTo.toMs - withTo.fromMs, 7 * DAY);
  const noTo = parseTimeRange(params('from=2026-10-14T00:00:00Z&tz=UTC'), { now: NOW });
  assert.equal(noTo.toMs, NOW);
});

test('纯日期的 from/to:各按本地日解释,to 含当天(次日零点)', () => {
  const result = parseTimeRange(params('from=2026-10-01&to=2026-10-01&tz=UTC'), { now: NOW });
  assert.equal(result.fromMs, Date.UTC(2026, 10 - 1, 1));
  assert.equal(result.toMs, Date.UTC(2026, 10 - 1, 2));
});

test('墙钟时间按目标时区解释:上海 00:00 = 前一日 UTC 16:00', () => {
  const result = parseTimeRange(params('from=2026-10-14T00:00:00&tz=Asia/Shanghai&to=2026-10-15T00:00:00'), { now: NOW });
  assert.equal(result.fromMs, Date.UTC(2026, 9, 13, 16));
  assert.equal(result.toMs, Date.UTC(2026, 9, 14, 16));
});

test('last=12h / 30d 相对区间;非法取值报 invalid_param', () => {
  assert.equal(parseTimeRange(params('last=12h&tz=UTC'), { now: NOW }).toMs - parseTimeRange(params('last=12h&tz=UTC'), { now: NOW }).fromMs, 12 * HOUR);
  assert.equal(parseTimeRange(params('last=30d&tz=UTC'), { now: NOW }).toMs - parseTimeRange(params('last=30d&tz=UTC'), { now: NOW }).fromMs, 30 * DAY);
  expectApiError(() => parseTimeRange(params('last=3w&tz=UTC'), { now: NOW }), 'invalid_param');
  expectApiError(() => parseTimeRange(params('last=0d&tz=UTC'), { now: NOW }), 'invalid_param');
});

test('错误输入:只有 to、起点不早于终点、区间超 400 天、坏时区', () => {
  expectApiError(() => parseTimeRange(params('to=2026-10-14&tz=UTC'), { now: NOW }), 'invalid_param');
  expectApiError(() => parseTimeRange(params('from=2026-10-14T09:00:00Z&to=2026-10-14T08:00:00Z&tz=UTC'), { now: NOW }), 'invalid_param');
  expectApiError(() => parseTimeRange(params('from=2024-01-01&to=2026-10-14&tz=UTC'), { now: NOW }), 'invalid_param');
  expectApiError(() => parseTimeRange(params('tz=Mars/Olympus'), { now: NOW }), 'invalid_param');
});

// ---- 粒度协商与 top-N ----------------------------------------------------

test('granularity 协商:provider 强制 day;本机超 7 天降级并写 issue', () => {
  const issues = [];
  assert.equal(negotiateGranularity('hour', 2 * DAY, 'provider', issues), 'day');
  assert.match(issues[0], /官方渠道/);
  issues.length = 0;
  assert.equal(negotiateGranularity('hour', 8 * DAY, 'local', issues), 'day');
  assert.match(issues[0], /7 天/);
  assert.equal(negotiateGranularity('hour', 2 * DAY, 'local', issues), 'hour');
  assert.equal(negotiateGranularity('day', 30 * DAY, 'local', issues), 'day');
});

test('applyTop:超出 top 的行合并为 other,share 按总量计算(输入按总量降序)', () => {
  const rows = [4, 3, 2, 1].map((value) => ({
    key: `k${value}`, tokens: { total: value, input: value, output: 0, cacheRead: 0, cacheWrite: 0, extra: 0 }, requests: value, sessions: value,
  }));
  const kept = applyTop(rows, 2);
  assert.deepEqual(kept.rows.map((row) => row.key), ['k4', 'k3']);
  assert.equal(kept.other.tokens.total, 3);
  assert.equal(kept.other.requests, 3);
  assert.equal(kept.rows[0].share, 0.4);
  assert.equal(applyTop(rows, 10).other, null);
});

// ---- store.v1Aggregate ---------------------------------------------------

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-api-v1-agg-'));
  return { store: new CliUsageStore(path.join(dir, 'cli-usage.sqlite')), dir };
};

const seedEvent = (store, overrides) => {
  const event = buildUsageEvent({
    eventKey: `k:${overrides.agent}:${overrides.model || 'm'}:${overrides.projectKey || '-'}:${overrides.at}:${overrides.session || 's1'}`,
    occurredAtMs: overrides.at,
    sessionKey: overrides.session || 's1',
    model: overrides.model === undefined ? 'glm-4.7' : overrides.model,
    projectKey: overrides.projectKey || null,
    projectDir: overrides.projectDir || null,
    inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10, outputTokens: 40,
    providerTotalTokens: null,
    ...overrides,
  });
  if (event) store.upsertEvents([event]);
  return event;
};

test('v1Aggregate:hour 分桶按本地墙钟打标,数值与请求/会话计数正确', () => {
  const { store } = createStore();
  const base = Date.UTC(2026, 9, 14, 2, 10); // UTC 02:10 与 04:20 两个钟点
  seedEvent(store, { agent: 'zcode', at: base, session: 's1' });
  seedEvent(store, { agent: 'zcode', at: base + 10, session: 's1' });
  seedEvent(store, { agent: 'claude', at: base + 2 * HOUR + 10 * 60, session: 's2' });
  const result = store.v1Aggregate({ startMs: base - HOUR, endMs: base + 6 * HOUR, granularity: 'hour', timezone: 'UTC' });
  assert.equal(result.buckets.length, 8); // 01:00 起对齐,末桶 08:00 含 endMs 前 10 分钟
  const used = result.buckets.filter((bucket) => bucket.totalTokens > 0);
  assert.deepEqual(used.map((bucket) => bucket.label), ['2026-10-14T02:00', '2026-10-14T04:00']);
  assert.equal(used[0].requests, 2);
  assert.equal(used[0].sessions, 1);
  assert.equal(used[0].inputTokens, 200);
  assert.equal(result.totals.requests, 3);
  assert.equal(result.totals.sessions, 2);
});

test('v1Aggregate:day 分桶跨时区日界(上海 01:00 落在 UTC 前一天)', () => {
  const { store } = createStore();
  const stamp = Date.UTC(2026, 9, 14, 17); // 上海 10-15 01:00
  seedEvent(store, { agent: 'zcode', at: stamp });
  const result = store.v1Aggregate({ startMs: Date.UTC(2026, 9, 13), endMs: Date.UTC(2026, 9, 16), granularity: 'day', timezone: 'Asia/Shanghai' });
  // 末日 2026-10-16 是只含区间终点的部分日桶(上海 10-16 08:00 前),空桶保留
  assert.deepEqual(result.buckets.map((bucket) => bucket.label), ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  assert.equal(result.buckets[2].totalTokens, 200);
  assert.equal(result.totals.currentStreakDays, 1);
});

test('v1Aggregate:by=model 跨渠道合并 canonical;未知模型按渠道隔离并带 agents', () => {
  const { store } = createStore();
  const at = Date.now();
  seedEvent(store, { agent: 'zcode', at, model: 'GLM-4.7' });
  seedEvent(store, { agent: 'claude', at, model: 'glm-4.7' });
  seedEvent(store, { agent: 'codex', at, model: null });
  const result = store.v1Aggregate({ startMs: at - HOUR, endMs: at + HOUR, granularity: 'day', timezone: 'UTC', groupBy: 'model' });
  const keys = result.groups.map((group) => group.key);
  assert.ok(keys.includes('glm-4.7'));
  assert.ok(keys.includes('unknown@codex'));
  const glm = result.groups.find((group) => group.key === 'glm-4.7');
  assert.deepEqual(glm.agents, ['zcode', 'claude']);
  assert.equal(glm.displayName, 'GLM-4.7');
});

test('v1Aggregate:by=project 命中 project_labels;by=agent 键为渠道', () => {
  const { store } = createStore();
  const at = Date.now();
  const alphaKey = store.hmac('D:/work/alpha');
  seedEvent(store, { agent: 'zcode', at, projectKey: alphaKey, projectDir: 'D:/work/alpha' });
  seedEvent(store, { agent: 'claude', at, projectKey: null, projectDir: null });
  assert.equal(store.getProjectLabels()[alphaKey], 'alpha');
  const byProject = store.v1Aggregate({ startMs: at - HOUR, endMs: at + HOUR, granularity: 'day', timezone: 'UTC', groupBy: 'project' });
  const alpha = byProject.groups.find((group) => group.key === alphaKey);
  const unknown = byProject.groups.find((group) => group.key === 'unknown');
  assert.equal(alpha.label, 'alpha');
  assert.ok(unknown);
  const byAgent = store.v1Aggregate({ startMs: at - HOUR, endMs: at + HOUR, granularity: 'day', timezone: 'UTC', groupBy: 'agent' });
  assert.deepEqual(byAgent.groups.map((group) => group.key).sort(), ['claude', 'zcode']);
});

test('v1Aggregate:agent/model/project 过滤与全量累计不受区间影响', () => {
  const { store } = createStore();
  const now = Date.now();
  const alphaKey = store.hmac('/home/u/alpha');
  seedEvent(store, { agent: 'zcode', at: now - HOUR, projectKey: alphaKey, projectDir: '/home/u/alpha' });
  seedEvent(store, { agent: 'zcode', at: now - 2 * HOUR, model: 'kimi-k2' });
  seedEvent(store, { agent: 'claude', at: now - 3 * HOUR });
  const range = { startMs: now - 4 * HOUR, endMs: now };
  const onlyZcode = store.v1Aggregate({ ...range, granularity: 'day', timezone: 'UTC', agents: ['zcode'] });
  assert.equal(onlyZcode.totals.requests, 2);
  assert.equal(onlyZcode.allTimeTotalTokens, 400); // 3 条事件不受区间/过滤外影响?——agents 过滤内全量
  const onlyGlm = store.v1Aggregate({ ...range, granularity: 'day', timezone: 'UTC', canonicalModels: ['glm-4.7'] });
  assert.equal(onlyGlm.totals.requests, 2); // zcode glm + claude glm
  const unknownModels = store.v1Aggregate({ ...range, granularity: 'day', timezone: 'UTC', modelsIncludeUnknown: true, canonicalModels: [] });
  assert.equal(unknownModels.totals.requests, 0);
  const onlyAlpha = store.v1Aggregate({ ...range, granularity: 'day', timezone: 'UTC', projectKeys: [alphaKey] });
  assert.equal(onlyAlpha.totals.requests, 1);
  const unknownProject = store.v1Aggregate({ ...range, granularity: 'day', timezone: 'UTC', projectIncludeUnknown: true, projectKeys: [] });
  assert.equal(unknownProject.totals.requests, 2);
  const shortRange = store.v1Aggregate({ startMs: now - 30 * 60_000, endMs: now, granularity: 'day', timezone: 'UTC' });
  assert.equal(shortRange.totals.requests, 0);
  assert.equal(shortRange.allTimeTotalTokens, 600);
});

// ---- 服务级:信封、鉴权、错误码、浪费与项目标签可见面 ----------------------

const PAIRING_KEY = 'k'.repeat(43);

const requestJson = (port, pathname, { method = 'GET', body, token } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const request = http.request({
    host: '127.0.0.1', port, path: pathname, method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
    },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 非 JSON 按空对象处理 */ }
      resolve({ status: response.statusCode, body: parsed });
    });
  });
  request.on('error', reject);
  if (payload !== null) request.write(payload);
  request.end();
});

async function bootServer() {
  const deskStore = new DesktopStore();
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-api-v1-srv-'));
  const cliStore = new CliUsageStore(path.join(cliDir, 'cli-usage.sqlite'));
  const now = Date.now();
  // 本机用量种子用固定 UTC 时刻,查询用 date= 固定日期,避免相对时间的毫秒漂移
  const at12 = Date.UTC(2026, 9, 12, 6);
  const at1402 = Date.UTC(2026, 9, 14, 2);
  const at1404 = Date.UTC(2026, 9, 14, 4);
  const at1406 = Date.UTC(2026, 9, 14, 6);
  const alphaKey = cliStore.hmac('D:/work/alpha');
  const betaKey = cliStore.hmac('D:/work/beta');
  seedEvent(cliStore, { agent: 'zcode', at: at12, model: 'GLM-4.7', projectKey: alphaKey, projectDir: 'D:/work/alpha', session: 'sz0' });
  seedEvent(cliStore, { agent: 'zcode', at: at1402, model: 'GLM-4.7', projectKey: alphaKey, projectDir: 'D:/work/alpha', session: 'sz' });
  seedEvent(cliStore, { agent: 'claude', at: at1404, model: 'glm-4.7', projectKey: alphaKey, projectDir: 'D:/work/alpha', session: 'sc' });
  seedEvent(cliStore, { agent: 'codex', at: at1406, model: 'gpt-5.2-codex', projectKey: betaKey, projectDir: 'D:/work/beta', session: 'sx' });

  deskStore.saveState({
    lastSync: new Date(now - 60_000).toISOString(),
    settings: { pollMinutes: 5 },
    providers: [
      { id: 'zai', name: 'Z.ai', requestConfig: { windows: ['five_hour', 'weekly'], wasteWindows: ['weekly'] } },
      { id: 'deepseek', name: 'DeepSeek', requestConfig: { windows: ['balance'], wasteWindows: [] } },
    ],
    accounts: [
      { id: 'a1', providerId: 'zai', name: '主号', windowKeys: ['weekly'], windows: [{ key: 'weekly', unit: '%', remaining: 62, used: 38, total: 100, resetAt: new Date(now + DAY).toISOString(), available: true }, { key: 'five_hour', unit: '%', remaining: 87, used: 13, total: 100, resetAt: 1791959656432, available: true }], usageConnection: { status: 'connected' } },
      { id: 'a2', providerId: 'deepseek', name: '备号', windowKeys: ['balance'], windows: [], status: 'warning' },
    ],
  });
  deskStore.saveCycles({ a1: [
    { window: 'weekly', kind: 'natural', end: new Date(now - DAY).toISOString(), from: new Date(now - 8 * DAY).toISOString(), observedAt: new Date(now - DAY - 1000).toISOString(), remaining: 40, reliable: true },
    { window: 'weekly', kind: 'early', end: new Date(now - 2 * DAY).toISOString(), from: new Date(now - 9 * DAY).toISOString(), observedAt: new Date(now - 2 * DAY - 1000).toISOString(), remaining: 90, reliable: true },
    { window: 'weekly', kind: 'natural', end: new Date(now - 40 * DAY).toISOString(), from: new Date(now - 47 * DAY).toISOString(), observedAt: new Date(now - 40 * DAY - 1000).toISOString(), remaining: 60, reliable: true },
  ] });
  deskStore.saveRemoteAccess({ enabled: true, pairingKey: PAIRING_KEY, devices: [], port: 43187 });

  const providerUsage = {
    provider: 'zai', metric: 'tokens', currency: null,
    summary: { totalTokens: 9999, planName: 'Max' },
    coverage: { timezoneOffsetSec: 0, partial: false },
    days: [
      { date: '2026-10-13', tokens: 100, requests: 10, models: [{ model: 'glm-4.7', tokens: 80 }] },
      { date: '2026-10-14', tokens: 50, requests: 5, models: [{ model: 'glm-4.7', tokens: 30 }] },
    ],
  };

  const server = await createRemoteViewServer({
    store: deskStore,
    distDir: path.join(__dirname, 'fixtures'),
    authorizeToken: (token, options) => deskStore.isRemoteTokenAuthorized(token, options),
    pairDevice: (body) => deskStore.pairRemoteDevice(body),
    pairLocalPreview: () => deskStore.pairLocalPreview(),
    getHistory: (accountId) => (accountId === 'a1' ? [{ at: '2026-10-14T02:30:00.000Z', windows: { weekly: { remaining: 55, amount: null, limit: null, unit: '%', resetAt: '2026-10-25T07:59:14+08:00' } } }] : []),
    getCycles: (accountId) => deskStore.getCycles(accountId),
    getUsage: async () => providerUsage,
    queryUsage: async () => providerUsage,
    appVersion: '0.0.0-test',
    cliUsage: {
      getSources: async () => [{ agent: 'zcode', displayName: 'ZCode', status: 'ready', records: 1, files: 1, warning: null, lastScannedAt: new Date(now - 60_000).toISOString() }],
      getV1Aggregate: async (query) => cliStore.v1Aggregate(query),
      scan: async () => ({}),
    },
    port: 0,
  });
  const port = server.address().port;
  const call = (pathname, options) => requestJson(port, pathname, options);
  return { deskStore, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('服务级:v1 需要令牌;信封带 query/generatedAt;未知端点与方法有明确错误码', async () => {
  const session = await bootServer();
  try {
    assert.equal((await session.call('/api/v1/meta')).status, 401);
    const pair = await session.call('/api/pair', { method: 'POST', body: { localPreview: true } });
    const token = pair.body.token;

    const meta = await session.call('/api/v1/meta', { token });
    assert.equal(meta.status, 200);
    assert.equal(meta.body.version, '0.0.0-test');
    assert.ok(Array.isArray(meta.body.endpoints) && meta.body.endpoints.length === 9);
    assert.ok(meta.body.query && meta.body.generatedAt && meta.body.now);
    assert.equal(meta.body.freshness.quota.lastSync, session.deskStore.loadState().lastSync);

    assert.equal((await session.call('/api/v1/unknown', { token })).body.error, 'not_found');
    assert.equal((await session.call('/api/v1/meta', { method: 'POST', body: {}, token })).status, 405);
  } finally {
    await session.close();
  }
});

test('服务级:quota/snapshot 与 history(必填 account、window 过滤、点位采样)', async () => {
  const session = await bootServer();
  try {
    const pair = await session.call('/api/pair', { method: 'POST', body: { localPreview: true } });
    const token = pair.body.token;
    const snapshot = await session.call('/api/v1/quota/snapshot', { token });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.accounts.length, 2);
    const a1 = snapshot.body.accounts.find((account) => account.id === 'a1');
    assert.equal(a1.providerName, 'Z.ai');
    assert.equal(a1.windows[0].remaining, 62);
    assert.equal(a1.windows[0].resetAt, session.deskStore.loadState().accounts[0].windows[0].resetAt);
    // v1 层 resetAt 统一为 ISO 8601:毫秒时间戳(如 Z.ai 落库格式)也要转换
    assert.equal(a1.windows[1].resetAt, new Date(1791959656432).toISOString());

    const missing = await session.call('/api/v1/quota/history?tz=UTC', { token });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.param, 'account');
    const notFound = await session.call('/api/v1/quota/history?account=nope&tz=UTC', { token });
    assert.equal(notFound.status, 404);
    const daily = await session.call('/api/v1/quota/history?account=a1&window=daily&tz=UTC', { token });
    assert.equal(daily.status, 200);
    assert.deepEqual(daily.body.points, []);
    const weekly = await session.call('/api/v1/quota/history?account=a1&tz=UTC&date=2026-10-14', { token });
    assert.equal(weekly.body.points.length, 1);
    assert.equal(weekly.body.points[0].windows.weekly.remaining, 55);
    assert.deepEqual(Object.keys(weekly.body.points[0].windows), ['weekly']);
    // history 的 resetAt 同样统一为 ISO 8601 UTC:带时区偏移的字符串被归一
    assert.equal(weekly.body.points[0].windows.weekly.resetAt, '2026-10-24T23:59:14.000Z');
  } finally {
    await session.close();
  }
});

test('服务级:usage/series 小时序列与参数校验;summary 的区间/全量分离', async () => {
  const session = await bootServer();
  try {
    const pair = await session.call('/api/pair', { method: 'POST', body: { localPreview: true } });
    const token = pair.body.token;

    const badGranularity = await session.call('/api/v1/usage/series?granularity=week&tz=UTC', { token });
    assert.equal(badGranularity.status, 400);
    assert.equal(badGranularity.body.param, 'granularity');
    const badAgent = await session.call('/api/v1/usage/series?agent=unknown-cli&tz=UTC', { token });
    assert.equal(badAgent.status, 400);
    assert.equal(badAgent.body.param, 'agent');
    const localWithAccount = await session.call('/api/v1/usage/series?account=a1&tz=UTC', { token });
    assert.equal(localWithAccount.status, 400);

    const series = await session.call('/api/v1/usage/series?granularity=hour&date=2026-10-14&tz=UTC', { token });
    assert.equal(series.status, 200);
    assert.equal(series.body.source, 'local');
    assert.equal(series.body.buckets.length, 24);
    const used = series.body.buckets.filter((bucket) => bucket.tokens.total > 0);
    assert.equal(used.length, 3);
    assert.deepEqual(used.map((bucket) => bucket.t), ['2026-10-14T02:00', '2026-10-14T04:00', '2026-10-14T06:00']);
    const sum = used.reduce((total, bucket) => total + bucket.tokens.total, 0);
    assert.equal(sum, 600);

    const summary = await session.call('/api/v1/usage/summary?date=2026-10-14&tz=UTC', { token });
    assert.equal(summary.body.range.tokens.total, 600);
    assert.equal(summary.body.allTime.tokens.total, 800); // 含 10-12 的另一条,全量不受区间影响
    assert.equal(summary.body.range.activeDays, 1);
    assert.ok(summary.body.range.cacheReuseRatio > 0);
    assert.equal(summary.body.query.kind, 'date');
  } finally {
    await session.close();
  }
});

test('服务级:breakdown 本机令牌可见项目目录名,配对设备令牌只见哈希键', async () => {
  const session = await bootServer();
  try {
    const localPair = await session.call('/api/pair', { method: 'POST', body: { localPreview: true } });
    const localBreakdown = await session.call('/api/v1/usage/breakdown?by=project&date=2026-10-14&tz=UTC', { token: localPair.body.token });
    assert.equal(localBreakdown.status, 200);
    const rows = localBreakdown.body.rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.displayName).sort(), ['alpha', 'beta']);
    const alphaRow = rows.find((row) => row.displayName === 'alpha');
    assert.deepEqual(alphaRow.agents.sort(), ['claude', 'zcode']);
    assert.equal(alphaRow.tokens.total, 400);

    const devicePair = await session.call('/api/pair', { method: 'POST', body: { pairingKey: PAIRING_KEY, id: 'agent-device-01', name: '外部 agent' } });
    const deviceBreakdown = await session.call('/api/v1/usage/breakdown?by=project&date=2026-10-14&tz=UTC', { token: devicePair.body.token });
    for (const row of deviceBreakdown.body.rows) assert.match(row.displayName, /^[a-f0-9]{24}$/);

    const byAgent = await session.call('/api/v1/usage/breakdown?by=agent&top=1&date=2026-10-14&tz=UTC', { token: localPair.body.token });
    assert.equal(byAgent.body.rows.length, 1);
    assert.equal(byAgent.body.other.key, 'other');
    assert.equal(byAgent.body.other.tokens.total, 400);
  } finally {
    await session.close();
  }
});

test('服务级:source=provider 的 summary/breakdown;未连接账号返回 409', async () => {
  const session = await bootServer();
  try {
    const pair = await session.call('/api/pair', { method: 'POST', body: { localPreview: true } });
    const token = pair.body.token;

    const notConnected = await session.call('/api/v1/usage/summary?source=provider&account=a2&tz=UTC', { token });
    assert.equal(notConnected.status, 409);
    assert.equal(notConnected.body.error, 'usage_not_connected');

    const hourProvider = await session.call('/api/v1/usage/series?source=provider&account=a1&granularity=hour&date=2026-10-13&tz=UTC', { token });
    assert.equal(hourProvider.body.granularity, 'day');
    assert.ok(hourProvider.body.coverage.issues.some((issue) => issue.includes('官方渠道')));

    const summary = await session.call('/api/v1/usage/summary?source=provider&account=a1&date=2026-10-13&tz=UTC', { token });
    assert.equal(summary.body.range.tokens.total, 100);
    assert.equal(summary.body.range.peak.date, '2026-10-13');
    assert.equal(summary.body.allTime.tokens.total, 9999);
    assert.equal(summary.body.allTime.planName, 'Max');

    const breakdown = await session.call('/api/v1/usage/breakdown?source=provider&account=a1&by=model&date=2026-10-13&tz=UTC', { token });
    assert.equal(breakdown.body.rows[0].key, 'glm-4.7');
    assert.equal(breakdown.body.rows[0].tokens.total, 80);
    const badBy = await session.call('/api/v1/usage/breakdown?source=provider&account=a1&by=project&date=2026-10-13&tz=UTC', { token });
    assert.equal(badBy.status, 400);
  } finally {
    await session.close();
  }
});

test('服务级:waste 口径——reliable+natural 计入平均,份额=remaining/100,区间按 end 过滤', async () => {
  const session = await bootServer();
  try {
    const pair = await session.call('/api/pair', { method: 'POST', body: { localPreview: true } });
    const token = pair.body.token;

    const waste = await session.call('/api/v1/waste?tz=UTC', { token });
    assert.equal(waste.status, 200);
    assert.equal(waste.body.windows.length, 1);
    const weekly = waste.body.windows[0];
    assert.equal(weekly.window, 'weekly');
    assert.equal(weekly.cycles, 2); // 31 天默认区间:40 天前那条被排除
    assert.equal(weekly.countedCycles, 1); // early 结束的不计入
    assert.equal(weekly.averageRemaining, 40);
    assert.equal(weekly.totalWasteShares, 0.4);
    assert.equal(weekly.accounts[0].accountId, 'a1');
    assert.equal(weekly.accounts[0].share, 1);
    assert.equal(weekly.accounts[0].cycles, undefined); // 非明细模式不带周期行

    const detail = await session.call('/api/v1/waste?account=a1&window=weekly&tz=UTC&last=45d', { token });
    const detailWeekly = detail.body.windows[0];
    assert.equal(detailWeekly.cycles, 3);
    assert.equal(detailWeekly.accounts[0].cycles.length, 2); // counted 的两条带明细
    assert.equal(detailWeekly.accounts[0].cycles.every((cycle) => cycle.counted), true);
    const badWindow = await session.call('/api/v1/waste?window=daily&tz=UTC', { token });
    assert.equal(badWindow.status, 400);
  } finally {
    await session.close();
  }
});
