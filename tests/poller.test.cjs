const test = require('node:test');
const assert = require('node:assert/strict');
const { queryAccount } = require('../electron/poller.cjs');
const { builtinConfigs } = require('../electron/builtin-configs.cjs');

const account = { endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit' };
const provider = { id: 'zai', name: 'Z.ai', adapter: 'zai', requestConfig: builtinConfigs.zai };

test('normalizes current Z.ai percentage and period fields', async () => {
  const payload = {
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 57, nextResetTime: 1787738407998 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 10, remaining: 990, percentage: 1, nextResetTime: 1789207207998 },
      ],
    },
  };
  const fetcher = async () => ({ ok: true, status: 200, json: async () => payload });

  const windows = await queryAccount(account, provider, 'test-token', fetcher);

  assert.deepEqual(windows.map((item) => item.key), ['five_hour', 'weekly', 'monthly']);
  assert.deepEqual(windows.map((item) => item.remaining), [100, 43, 99]);
  assert.equal(windows[1].resetAt, 1787738407998);
  assert.equal(windows[2].amount, 990);
  assert.equal(windows[2].limitAmount, 1000);
});

test('reports an authorization failure without attempting to parse quota data', async () => {
  const fetcher = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => queryAccount(account, provider, 'expired', fetcher), /凭据已失效/);
});

test('normalizes a single object response without an array path', async () => {
  const provider = {
    name: 'Object service',
    adapter: 'generic',
    requestConfig: {
      adapterMode: 'standard',
      endpoint: 'https://example.test/usage',
      collectionMode: 'single',
      defaultWindow: 'weekly',
      totalPath: 'quota.total',
      remainingPath: 'quota.left',
      resetPath: 'quota.resetAt',
    },
  };
  const fetcher = async () => ({ ok: true, status: 200, json: async () => ({ quota: { total: 1000, left: 420, resetAt: '2026-08-21T12:00:00Z' } }) });
  const windows = await queryAccount({}, provider, 'token', fetcher);
  assert.equal(windows[0].key, 'weekly');
  assert.equal(windows[0].remaining, 42);
  assert.equal(windows[0].amount, 420);
});

test('expands an object keyed by quota window', async () => {
  const provider = {
    name: 'Keyed service',
    adapter: 'generic',
    requestConfig: {
      adapterMode: 'standard',
      endpoint: 'https://example.test/usage',
      listPath: 'quota',
      collectionMode: 'object-entries',
      windowMap: { short: 'five_hour', long: 'weekly' },
      totalPath: 'limit',
      remainingPath: 'remaining',
    },
  };
  const fetcher = async () => ({ ok: true, status: 200, json: async () => ({ quota: { short: { limit: 100, remaining: 75 }, long: { limit: 1000, remaining: 250 } } }) });
  const windows = await queryAccount({}, provider, 'token', fetcher);
  assert.deepEqual(windows.map((item) => item.key), ['five_hour', 'weekly']);
  assert.deepEqual(windows.map((item) => item.remaining), [75, 25]);
});

test('runs WLB Club through the built-in standard response rules', async () => {
  const provider = { id: 'wlb', name: 'WLB Club', adapter: 'wlb', requestConfig: builtinConfigs.wlb };
  let request;
  const fetcher = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ status: 'active', rate_limits: [{ window: '1d', limit: 30, remaining: 10 }, { window: '7d', limit: 216.98, used: 200.18, remaining: 16.8, reset_at: '2026-08-25T07:59:14+08:00' }] }) };
  };
  const windows = await queryAccount({ id: 'wlb' }, provider, 'secret', fetcher);
  assert.equal(provider.requestConfig.adapterMode, 'standard');
  assert.equal(request.url, 'https://codex.wlbclub.com/v1/usage');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].key, 'weekly');
  assert.equal(windows[0].remaining, 7.74);
  assert.equal(windows[0].limitAmount, 216.98);
});

test('runs a scripted request and extractor for complex providers', async () => {
  const provider = {
    name: 'WLB Club', adapter: 'wlb',
    requestConfig: {
      adapterMode: 'script', endpoint: 'https://api.wlbclub.com/v1/usage',
      script: `({ request: { url: "{{endpoint}}", method: "GET", headers: { Authorization: "Bearer {{apiKey}}" } }, extractor: function(response) {
        const quota = response?.rate_limits?.find((item) => item.window === "7d");
        const total = Number(quota?.limit ?? 0); const used = Number(quota?.used ?? 0);
        const remaining = Number(quota?.remaining ?? Math.max(0, total - used));
        return { key: "weekly", isValid: response?.isValid ?? response?.status === "active", remaining: Number(((remaining / total) * 100).toFixed(2)), used: Number(((used / total) * 100).toFixed(2)), total: 100, unit: "%", reset_at: quota?.reset_at };
      } })`,
    },
  };
  let request;
  const fetcher = async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ status: 'active', rate_limits: [{ window: '7d', limit: 216.98, used: 200.18, remaining: 16.8, reset_at: '2026-08-25T07:59:14+08:00' }] }) }; };
  const windows = await queryAccount({ id: 'wlb' }, provider, 'secret', fetcher);
  assert.equal(request.url, 'https://api.wlbclub.com/v1/usage');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.equal(windows[0].key, 'weekly');
  assert.equal(windows[0].remaining, 7.74);
  assert.equal(windows[0].resetAt, '2026-08-25T07:59:14+08:00');
});

test('injects declared account variables into scripted requests and extractors', async () => {
  const provider = {
    name: 'Variable service', adapter: 'generic',
    requestConfig: {
      adapterMode: 'script', credentialRequired: false, endpoint: 'https://example.test/usage',
      variables: [{ key: 'region', label: 'Region', defaultValue: 'cn', required: true }, { key: 'planId', label: 'Plan', required: true, secret: true }],
      script: `({ request: { url: "{{endpoint}}?region={{region}}&plan={{planId}}", method: "GET" }, extractor: function(response, variables) { return { key: "weekly", remaining: response[variables.region], total: 100, unit: "%" }; } })`,
    },
  };
  let requestUrl;
  const fetcher = async (url) => { requestUrl = url; return { ok: true, status: 200, json: async () => ({ eu: 64 }) }; };
  const windows = await queryAccount({ id: 'variable', variables: { region: 'eu' } }, provider, '', fetcher, { planId: 'pro' });
  assert.equal(requestUrl, 'https://example.test/usage?region=eu&plan=pro');
  assert.equal(windows[0].remaining, 64);
});
