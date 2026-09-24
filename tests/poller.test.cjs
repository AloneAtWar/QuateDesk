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
  // 1d 行映射为 daily 窗口（wlbclub 上线的 1 天限额）；接口没给 reset_at 时刷新时间留空
  assert.equal(windows.length, 2);
  assert.equal(windows[0].key, 'daily');
  assert.equal(windows[0].remaining, 33.33);
  assert.equal(windows[0].amount, 10);
  assert.equal(windows[0].limitAmount, 30);
  assert.equal(windows[1].key, 'weekly');
  assert.equal(windows[1].remaining, 7.74);
  assert.equal(windows[1].limitAmount, 216.98);
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
    { id: 'zai', requestConfig: { endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit' } },
    { id: 'wlb', requestConfig: { endpoint: 'https://codex.wlbclub.com/v1/usage' } },
    { id: 'custom', requestConfig: { adapterMode: 'script', variables: [{ key: 'endpoint', defaultValue: 'https://api.example.io/v1/usage' }] } },
    { id: 'kimi-subscription', requestConfig: {} },
  ];
  assert.equal(matchProviderId('https://open.bigmodel.cn/api/', providers), 'zai');
  assert.equal(matchProviderId('https://api.z.ai/v1', providers), 'zai');
  assert.equal(matchProviderId('http://codex.wlbclub.com', providers), 'wlb');
  assert.equal(matchProviderId('https://api.example.io/v1', providers), 'custom');
  assert.equal(matchProviderId('https://api.unknown.com', providers), null);
  // kimi 的 API Key 条目并入 kimi-subscription 渠道（域名别名匹配，无独立渠道）
  assert.equal(matchProviderId('https://api.kimi.com/coding/', providers), 'kimi-subscription');
  assert.equal(matchProviderId('https://kimi.com/coding/', providers), 'kimi-subscription');
});

// Kimi 渠道双登录：无扫码快照的账号是 API Key 模式，走 usages 端点（仅 5 小时 / 7 天，无月额度）
const kimiProvider = { id: 'kimi-subscription', name: 'Kimi 订阅', requestConfig: builtinConfigs['kimi-subscription'] };

test('queries the Kimi usage endpoint with the API key when no scan snapshot exists', async () => {
  const payload = {
    limits: [{ detail: { limit: 500, remaining: 420, resetTime: '2026-09-24T12:00:00Z' } }],
    usage: { limit: 6000, remaining: 5100, resetTime: '2026-09-30T00:00:00Z' },
  };
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => payload }; };
  const windows = await queryAccount({ id: 'kimi-key' }, kimiProvider, 'sk-kimi-test', fetcher);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.kimi.com/coding/v1/usages');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-kimi-test');
  assert.deepEqual(windows.map((item) => item.key), ['five_hour', 'weekly']);
  assert.equal(windows[0].remaining, 84); // 420 / 500
  assert.equal(windows[0].amount, 420);
  assert.equal(windows[1].remaining, 85); // 5100 / 6000
  assert.equal(windows[1].limitAmount, 6000);
});

test('reports Kimi API Key rejection as reauth required', async () => {
  const fetcher = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => queryAccount({ id: 'kimi-key' }, kimiProvider, 'expired-key', fetcher), /Kimi API Key 已失效/);
});

test('requires a Kimi API key when the account has neither snapshot nor credential', async () => {
  await assert.rejects(
    () => queryAccount({ id: 'kimi-key' }, kimiProvider, '', async () => ({ ok: true, status: 200, json: async () => ({}) })),
    /没有 API Key/);
});

test('routes a Kimi account with a scan snapshot to the subscription endpoint instead', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({
    ratelimitCode5h: { enabled: true, ratio: 0.25 },
    ratelimitCode7d: { enabled: true, ratio: 0.5 },
    subscriptionBalance: { amountUsedRatio: 0.1 },
  }) }; };
  const variables = { cliAuthTokenBundle: JSON.stringify({ accessToken: 'snapshot-atk', refreshToken: 'snapshot-rtk', userId: 'u1', authHost: 'https://auth.kimi.com' }) };
  // 有快照时即使凭据里还留着 API Key（扫码升级账号），也优先走订阅接口
  const windows = await queryAccount({ id: 'kimi-scan' }, kimiProvider, 'sk-kimi-kept', fetcher, variables);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats'));
  assert.deepEqual(windows.map((item) => item.key), ['five_hour', 'weekly', 'monthly']);
  assert.deepEqual(windows.map((item) => item.remaining), [75, 50, 90]);
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

// ── wlbclub 内置适配 ────────────────────────────────────────────
test('wlbclub rate_limits 解析 1 天与 7 天窗口', async () => {
  const { builtinConfigs } = require('../electron/builtin-configs.cjs');
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'active',
      rate_limits: [
        { window: '1d', limit: 100, remaining: 45, used: 55, reset_at: '2026-08-27T00:00:00Z' },
        { window: '7d', limit: 300, remaining: 240, used: 60, reset_at: '2026-08-31T00:00:00Z' },
      ],
    }),
  });
  const windows = await queryAccount(
    { id: 't', name: 'wlbclub', windowKeys: ['daily', 'weekly'] },
    { id: 'wlb', name: 'wlbclub', requestConfig: builtinConfigs.wlb },
    'sk-test',
    fetcher,
  );
  assert.equal(windows.length, 2);
  assert.equal(windows[0].key, 'daily');
  assert.equal(windows[0].remaining, 45);
  assert.equal(windows[0].amount, 45);
  assert.equal(windows[0].limitAmount, 100);
  assert.equal(windows[0].resetAt, '2026-08-27T00:00:00Z');
  assert.equal(windows[1].key, 'weekly');
  assert.equal(windows[1].remaining, 80);
  assert.equal(windows[1].amount, 240);
  assert.equal(windows[1].limitAmount, 300);
});

test('wlbclub 接口暂未返回 1d 行时仍只解析 7 天窗口', async () => {
  const { builtinConfigs } = require('../electron/builtin-configs.cjs');
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'active', rate_limits: [{ window: '7d', limit: 300, remaining: 150, used: 150, reset_at: '2026-08-31T00:00:00Z' }] }),
  });
  const windows = await queryAccount(
    { id: 't', name: 'wlbclub', windowKeys: ['daily', 'weekly'] },
    { id: 'wlb', name: 'wlbclub', requestConfig: builtinConfigs.wlb },
    'sk-test',
    fetcher,
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].key, 'weekly');
  assert.equal(windows[0].remaining, 50);
});

// ── 网络层兜底：瞬时错误自动重试 + 中文提示 + 账号级超时 ─────────────────────
const { __network } = require('../electron/poller.cjs');

test('连接被中断的瞬时错误会自动重试并最终成功', async () => {
  const payload = { code: 200, success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 57 }] } };
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls < 3) throw new Error('net::ERR_CONNECTION_CLOSED at https://open.bigmodel.cn');
    return { ok: true, status: 200, json: async () => payload };
  };
  const windows = await queryAccount(account, provider, 'test-token', fetcher, {}, { retryDelaysMs: [0, 0] });
  assert.equal(calls, 3);
  assert.equal(windows[0].key, 'weekly');
  assert.equal(windows[0].remaining, 43);
});

test('超时重试耗尽后翻译成可行动的中文提示', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error('The operation was aborted due to timeout'); };
  await assert.rejects(
    () => queryAccount(account, provider, 'test-token', fetcher, {}, { retryDelaysMs: [0, 0] }),
    /连接超时.*自动重试 3 次/,
  );
  assert.equal(calls, 3);
});

test('连接中断重试耗尽后提示配置代理', async () => {
  const fetcher = async () => { throw new Error('net::ERR_CONNECTION_CLOSED at https://grok.com'); };
  await assert.rejects(
    () => queryAccount(account, provider, 'test-token', fetcher, {}, { retryDelaysMs: [0, 0] }),
    /网络连接被中断.*网络代理/,
  );
});

test('凭据失效不属于瞬时错误，不重试', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return { ok: false, status: 401 }; };
  await assert.rejects(() => queryAccount(account, provider, 'expired', fetcher, {}, { retryDelaysMs: [0, 0] }), /凭据已失效/);
  assert.equal(calls, 1);
});

test('账号超时秒数收敛到 5–120，缺省 15 秒', () => {
  assert.equal(__network.accountTimeoutMs({}), 15_000);
  assert.equal(__network.accountTimeoutMs({ timeoutSeconds: 30 }), 30_000);
  assert.equal(__network.accountTimeoutMs({ timeoutSeconds: '20' }), 20_000);
  assert.equal(__network.accountTimeoutMs({ timeoutSeconds: 3 }), 5_000);
  assert.equal(__network.accountTimeoutMs({ timeoutSeconds: 999 }), 120_000);
  assert.equal(__network.isTransientNetworkError(new Error('net::ERR_CONNECTION_RESET')), true);
  assert.equal(__network.isTransientNetworkError(new Error('额度接口返回 HTTP 500')), false);
});
