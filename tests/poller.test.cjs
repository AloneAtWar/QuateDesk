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

// ── Grok 订阅专属适配 ───────────────────────────────────────────
const { __grok } = require('../electron/poller.cjs');

test('解析 Grok 计费 gRPC-web 响应为用量百分比与重置时间', () => {
  // 真实响应样本：gRPC-web data 帧（protobuf）+ grpc-status:0 trailer
  // 真实响应样本（134 字节）：gRPC-web data 帧 + grpc-status:0 trailer
  const hex = '000000006d0a6b0d0000a24212001a00220b08d0b286d40610a081ec092a0b08d0a7abd40610a081ec093a07080515000084423a07080215000030413a07080415000040403a070807150000803f421c0802120b08d0b286d40610a081ec091a0b08d0a7abd40610a081ec09580162006801800000000f677270632d7374617474733a300d0a';
  const now = Math.floor(Date.UTC(2026, 7, 18) / 1000);
  const snapshot = __grok.parseGrokBilling(Buffer.from(hex, 'hex'), now);
  assert.equal(snapshot.usedPercent, 81);
  assert.ok(new Date(snapshot.resetsAt * 1000).toISOString().startsWith('2026-08-23T11:04'));
  assert.ok(new Date(snapshot.startsAt * 1000).toISOString().startsWith('2026-08-16T11:04'));
  // 窗口时长 = 7 天 → 周窗口；周期尾声（仅剩 1-2 天）也不再误判为月窗口
  assert.equal(__grok.grokWindowKey(snapshot.startsAt, snapshot.resetsAt, now), 'weekly');
  // 兜底（无开始时间）：周期尾声剩 1-2 天时旧启发式判为月窗口
  assert.equal(__grok.grokWindowKey(null, snapshot.resetsAt, Math.floor(Date.UTC(2026, 7, 22) / 1000)), 'monthly');
});

test('Grok 凭据选择：SuperGrok OIDC 条目优先于 legacy session', () => {
  const entry = __grok.selectGrokAuthEntry({
    'https://accounts.x.ai/sign-in': { key: 'legacy-token' },
    'https://auth.x.ai::some-client-id': { key: 'oidc-token' },
    'https://auth.x.ai::broken': { expires_at: '2000-01-01T00:00:00Z' },
  });
  assert.equal(entry.key, 'oidc-token');
  assert.equal(__grok.selectGrokAuthEntry({ foo: { noKey: true } }), null);
});

// ── cc-switch 导入 ─────────────────────────────────────────────
const { extractCredential, matchProviderId } = require('../electron/ccswitch.cjs');

test('从 cc-switch 各形态 settings_config 提取 baseUrl 与 apiKey', () => {
  // claude：env 形态
  const claude = extractCredential(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/', ANTHROPIC_AUTH_TOKEN: 'sk-kimi-token' } }));
  assert.equal(claude.baseUrl, 'https://api.kimi.com/coding/');
  assert.equal(claude.apiKey, 'sk-kimi-token');
  // codex：auth + TOML base_url
  const codex = extractCredential(JSON.stringify({ auth: { OPENAI_API_KEY: 'sk-wlb' }, config: 'model = "x"\nbase_url = "http://codex.wlbclub.com"' }));
  assert.equal(codex.apiKey, 'sk-wlb');
  assert.equal(codex.baseUrl, 'http://codex.wlbclub.com');
  // openclaw：顶层 baseUrl/apiKey
  const openclaw = extractCredential(JSON.stringify({ baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 'sk-mini' }));
  assert.equal(openclaw.apiKey, 'sk-mini');
  // 无 key 不迁移
  assert.equal(extractCredential(JSON.stringify({ env: {} })), null);
});

test('按域名后缀匹配厂商（内置别名 + 自定义厂商 endpoint）', () => {
  const providers = [
    { id: 'kimi', requestConfig: { endpoint: 'https://api.kimi.com/coding/v1/usages' } },
    { id: 'wlb', requestConfig: { endpoint: 'https://codex.wlbclub.com/v1/usage' } },
    { id: 'custom', requestConfig: { adapterMode: 'script', variables: [{ key: 'endpoint', defaultValue: 'https://api.example.io/v1/usage' }] } },
  ];
  assert.equal(matchProviderId('https://api.kimi.com/coding/', providers), 'kimi');
  assert.equal(matchProviderId('http://codex.wlbclub.com', providers), 'wlb');
  assert.equal(matchProviderId('https://api.example.io/v1', providers), 'custom');
  assert.equal(matchProviderId('https://api.unknown.com', providers), null);
});

// ── MiniMax Coding Plan 内置适配 ────────────────────────────────
test('MiniMax coding_plan/remains 脚本解析 5 小时与周窗口', async () => {
  const { builtinConfigs } = require('../electron/builtin-configs.cjs');
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      base_resp: { status_code: 0 },
      model_remains: [
        { model_name: 'video', current_interval_remaining_percent: 99 },
        {
          model_name: 'general',
          current_interval_remaining_percent: 62.5,
          end_time: 1777000000000,
          current_weekly_status: 1,
          current_weekly_remaining_percent: 81,
        },
      ],
    }),
  });
  const windows = await queryAccount(
    { id: 't', name: 'MiniMax', windowKeys: ['five_hour', 'weekly'] },
    { id: 'minimax', name: 'MiniMax', requestConfig: builtinConfigs.minimax },
    'sk-test',
    fetcher,
  );
  assert.equal(windows.length, 2);
  assert.equal(windows[0].key, 'five_hour');
  assert.equal(windows[0].remaining, 62.5);
  assert.equal(windows[0].resetAt, new Date(1777000000000).toISOString());
  assert.equal(windows[1].key, 'weekly');
  assert.equal(windows[1].remaining, 81);
});

test('MiniMax 套餐无周限额时只返回 5 小时窗口', async () => {
  const { builtinConfigs } = require('../electron/builtin-configs.cjs');
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: 40, current_weekly_status: 3 }] }),
  });
  const windows = await queryAccount({ id: 't', name: 'MiniMax' }, { id: 'minimax', name: 'MiniMax', requestConfig: builtinConfigs.minimax }, 'sk-test', fetcher);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].key, 'five_hour');
});
