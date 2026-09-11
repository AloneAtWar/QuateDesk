const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cliAuth = require('../electron/cli-auth.cjs');
const { queryAccount } = require('../electron/poller.cjs');
const { builtinConfigs } = require('../electron/builtin-configs.cjs');
const { extractCodexOauth } = require('../electron/ccswitch.cjs');

const { SNAPSHOT_KEY, cliIdentity, parseCliSnapshot, resolveCliAuth, refreshCliAuth, writeLiveIfCurrent, fetchWithCliAuth, CliRefreshError, __constants } = cliAuth;

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeJwt = (claims) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`;

const codexSnapshot = (overrides = {}) => ({
  OPENAI_API_KEY: null,
  ...overrides,
  tokens: {
    id_token: fakeJwt({ email: 'user@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } }),
    access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: 'rt-old',
    account_id: 'acc-1',
    ...(overrides.tokens || {}),
  },
  last_refresh: null,
});

test('登录快照解析：合法快照可用，损坏 / 缺 token 的快照回退', () => {
  const snapshot = codexSnapshot();
  assert.equal(parseCliSnapshot('codex', { [SNAPSHOT_KEY]: JSON.stringify(snapshot) }).tokens.account_id, 'acc-1');
  assert.equal(parseCliSnapshot('codex', { [SNAPSHOT_KEY]: snapshot }).tokens.account_id, 'acc-1');
  assert.equal(parseCliSnapshot('codex', { [SNAPSHOT_KEY]: '{broken json' }), null);
  assert.equal(parseCliSnapshot('codex', { [SNAPSHOT_KEY]: JSON.stringify({ tokens: {} }) }), null);
  assert.equal(parseCliSnapshot('codex', {}), null);
});

test('凭据解析优先级：账号快照优先于本机 live 文件（cc-switch 切换 profile 不影响快照账号）', () => {
  const previousHome = process.env.CODEX_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-auth-'));
  try {
    // 本机 live 登录是另一个账号（模拟 cc-switch 已切换）
    fs.mkdirSync(path.join(tempHome), { recursive: true });
    fs.writeFileSync(path.join(tempHome, 'auth.json'), JSON.stringify(codexSnapshot({ tokens: { account_id: 'acc-live', refresh_token: 'rt-live', access_token: 'live-token' } })));
    process.env.CODEX_HOME = tempHome;
    const live = resolveCliAuth('codex', {});
    assert.equal(live.source, 'live');
    assert.equal(live.auth.tokens.account_id, 'acc-live');
    // 有快照时永远用快照，不读 live
    const snapshotted = resolveCliAuth('codex', { [SNAPSHOT_KEY]: JSON.stringify(codexSnapshot()) });
    assert.equal(snapshotted.source, 'snapshot');
    assert.equal(snapshotted.auth.tokens.account_id, 'acc-1');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('身份指纹：Codex 取 account_id + email，Claude 取 JWT sub，Gemini 取 sub/email', () => {
  assert.deepEqual(cliIdentity('codex', codexSnapshot()), { fingerprint: 'acc-1', display: 'user@example.com' });
  // 没有 account_id / email 时退到 refresh_token 指纹与尾号展示
  const bare = cliIdentity('codex', codexSnapshot({ tokens: { account_id: undefined, id_token: undefined, access_token: 'opaque' } }));
  assert.equal(bare.display, `…${bare.fingerprint.slice(-6)}`);
  const claude = cliIdentity('claude', { claudeOauth: { accessToken: fakeJwt({ sub: 'user_am_9x' }), refreshToken: 'cr-1', expiresAt: '2099-01-01T00:00:00Z' } });
  assert.equal(claude.fingerprint, 'user_am_9x');
  const gemini = cliIdentity('gemini', { access_token: 'g', refresh_token: 'gr', id_token: fakeJwt({ sub: 'g-sub-1', email: 'g@gmail.com' }) });
  assert.deepEqual(gemini, { fingerprint: 'g-sub-1', display: 'g@gmail.com' });
});

test('Codex 续期：JSON 请求形态正确，token 轮换并从新 id_token 更新 account_id', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        id_token: fakeJwt({ email: 'user@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-2' } }),
      }),
    };
  };
  const next = await refreshCliAuth('codex', codexSnapshot(), fetcher);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, __constants.CODEX_TOKEN_URL);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { client_id: __constants.CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'rt-old' });
  assert.equal(next.tokens.access_token, 'at-new');
  assert.equal(next.tokens.refresh_token, 'rt-new');
  assert.equal(next.tokens.account_id, 'acc-2');
  assert.ok(next.last_refresh);
});

test('Codex 续期被拒绝（invalid_grant）标记为永久失败并提示重新登录', async () => {
  const fetcher = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  await assert.rejects(
    () => refreshCliAuth('codex', codexSnapshot(), fetcher),
    (error) => error instanceof CliRefreshError && error.permanent === true && /重新登录/.test(error.message),
  );
});

test('Claude / Gemini 续期：各自的端点、client 与请求格式', async () => {
  const seen = [];
  const recorder = () => async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }) };
  };
  const claudeNext = await refreshCliAuth('claude', { claudeOauth: { accessToken: 'a1', refreshToken: 'r1', expiresAt: '2000-01-01T00:00:00Z' } }, recorder(), 1000);
  assert.equal(seen[0].url, __constants.CLAUDE_TOKEN_URL);
  assert.deepEqual(JSON.parse(seen[0].init.body), { grant_type: 'refresh_token', refresh_token: 'r1', client_id: __constants.CLAUDE_CLIENT_ID });
  assert.equal(seen[0].init.headers['User-Agent'], 'anthropic');
  assert.equal(claudeNext.claudeOauth.accessToken, 'a2');
  assert.equal(claudeNext.claudeOauth.refreshToken, 'r2');
  assert.ok(claudeNext.claudeOauth.expiresAt > new Date().toISOString());

  const geminiNext = await refreshCliAuth('gemini', { access_token: 'g1', refresh_token: 'gr1', expiry_date: Date.now() - 1000 }, recorder(), 1000);
  assert.equal(seen[1].url, __constants.GEMINI_TOKEN_URL);
  const form = new URLSearchParams(seen[1].init.body);
  assert.equal(form.get('client_id'), __constants.GEMINI_CLIENT_ID);
  assert.equal(form.get('client_secret'), __constants.GEMINI_CLIENT_SECRET);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'gr1');
  assert.equal(geminiNext.access_token, 'a2');
  assert.ok(geminiNext.expiry_date > Date.now());
});

test('写回本机 live 文件：同账号才写（原子），cc-switch 已切换到别的 profile 时绝不覆盖', () => {
  const previousHome = process.env.CODEX_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-auth-'));
  const livePath = path.join(tempHome, 'auth.json');
  try {
    process.env.CODEX_HOME = tempHome;
    const before = codexSnapshot();
    const next = codexSnapshot({ tokens: { access_token: 'at-new', refresh_token: 'rt-new' } });
    // live 仍是刷新前的账号 → 写回成功
    fs.writeFileSync(livePath, JSON.stringify(before));
    assert.equal(writeLiveIfCurrent('codex', before, next), true);
    assert.equal(JSON.parse(fs.readFileSync(livePath, 'utf8')).tokens.access_token, 'at-new');
    assert.equal(fs.existsSync(`${livePath}.tmp`), false);
    // live 已被 cc-switch 换成别的 profile（refresh_token 不同）→ 不写
    fs.writeFileSync(livePath, JSON.stringify(codexSnapshot({ tokens: { refresh_token: 'rt-other', account_id: 'acc-other' } })));
    const again = codexSnapshot({ tokens: { access_token: 'at-newer' } });
    assert.equal(writeLiveIfCurrent('codex', before, again), false);
    assert.equal(JSON.parse(fs.readFileSync(livePath, 'utf8')).tokens.account_id, 'acc-other');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('fetchWithCliAuth：临期先续期再用新 token 请求，并把新旧凭据交给回调', async () => {
  const expiring = codexSnapshot({ tokens: { access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) - 30 }) } });
  const usageCalls = [];
  const updates = [];
  const fetcher = async (url, init) => {
    if (url === __constants.CODEX_TOKEN_URL) return { ok: true, status: 200, json: async () => ({ access_token: 'at-new', refresh_token: 'rt-new' }) };
    usageCalls.push(init.headers.Authorization);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const response = await fetchWithCliAuth('codex', {
    auth: expiring,
    source: 'snapshot',
    fetcher,
    timeoutMs: 1000,
    buildRequest: (auth) => ({ url: 'https://chatgpt.com/backend-api/wham/usage', init: { headers: { Authorization: `Bearer ${auth.tokens.access_token}` } } }),
    onAuthUpdate: (kind, next, previous, source) => updates.push({ kind, next, previous, source }),
  });
  assert.equal(response.status, 200);
  assert.equal(usageCalls.length, 1);
  assert.equal(usageCalls[0], 'Bearer at-new');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].kind, 'codex');
  assert.equal(updates[0].source, 'snapshot');
  assert.equal(updates[0].previous.tokens.refresh_token, 'rt-old');
  assert.equal(updates[0].next.tokens.refresh_token, 'rt-new');
});

test('fetchWithCliAuth：401 时续期一次并换新 token 重试，重试仍 401 则原样返回', async () => {
  const fresh = codexSnapshot();
  const usageAuths = [];
  let refreshCount = 0;
  const fetcher = async (url, init) => {
    if (url === __constants.CODEX_TOKEN_URL) { refreshCount += 1; return { ok: true, status: 200, json: async () => ({ access_token: 'at-new' }) }; }
    usageAuths.push(init.headers.Authorization);
    return { ok: false, status: 401, json: async () => ({}) };
  };
  const response = await fetchWithCliAuth('codex', {
    auth: fresh,
    source: 'snapshot',
    fetcher,
    timeoutMs: 1000,
    buildRequest: (auth) => ({ url: 'https://chatgpt.com/backend-api/wham/usage', init: { headers: { Authorization: `Bearer ${auth.tokens.access_token}` } } }),
  });
  assert.equal(response.status, 401);
  assert.equal(refreshCount, 1);
  assert.deepEqual(usageAuths, [`Bearer ${fresh.tokens.access_token}`, 'Bearer at-new']);
});

// ── poller 集成：CLI 适配器使用账号快照并把续期结果回调给主进程 ───────────────
const codexProvider = { id: 'codex', name: 'Codex', requestConfig: builtinConfigs.codex };
const codexUsagePayload = { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1789000000 }, secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: 1789500000 } } };

test('Codex 账号用快照 token 查询额度，且不受本机 live 文件影响', async () => {
  const previousHome = process.env.CODEX_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-auth-'));
  try {
    // 本机 live 是别的账号（cc-switch 已切换），账号只依赖自己的快照
    fs.writeFileSync(path.join(tempHome, 'auth.json'), JSON.stringify(codexSnapshot({ tokens: { account_id: 'acc-other', refresh_token: 'rt-live', access_token: 'live-token' } })));
    process.env.CODEX_HOME = tempHome;
    const snapshot = codexSnapshot();
    const seen = [];
    const fetcher = async (url, init) => {
      seen.push({ url, authorization: init.headers.Authorization, accountHeader: init.headers['ChatGPT-Account-Id'] });
      return { ok: true, status: 200, json: async () => codexUsagePayload };
    };
    const windows = await queryAccount({ id: 'a1' }, codexProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, `Bearer ${snapshot.tokens.access_token}`);
    assert.equal(seen[0].accountHeader, 'acc-1');
    assert.deepEqual(windows.map((item) => item.key), ['five_hour', 'weekly']);
    assert.equal(windows[0].remaining, 75);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('poller 把续期回调带给 CLI 适配器（临期快照自动续期并回传新凭据）', async () => {
  const expiring = codexSnapshot({ tokens: { access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) - 30 }) } });
  const events = [];
  const fetcher = async (url) => {
    if (url === __constants.CODEX_TOKEN_URL) return { ok: true, status: 200, json: async () => ({ access_token: 'at-new', refresh_token: 'rt-new' }) };
    return { ok: true, status: 200, json: async () => codexUsagePayload };
  };
  const windows = await queryAccount({ id: 'a1' }, codexProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(expiring) }, {
    onCliAuth: (event) => events.push(event),
  });
  assert.equal(windows.length, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].account.id, 'a1');
  assert.equal(events[0].kind, 'codex');
  assert.equal(events[0].source, 'snapshot');
  assert.equal(events[0].next.tokens.access_token, 'at-new');
});

test('网络重试时重取凭据：第二次续期用第一次轮换后的 refresh_token，不会拿旧值被判复用', async () => {
  // 模拟主进程：每次续期成功后把新 bundle 写回“存储”，getter 反映最新值
  let stored = codexSnapshot({ tokens: { access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) - 30 }) } });
  const refreshTokensUsed = [];
  let usageAttempts = 0;
  const fetcher = async (url, init) => {
    if (url === __constants.CODEX_TOKEN_URL) {
      const body = JSON.parse(init.body);
      refreshTokensUsed.push(body.refresh_token);
      // 返回的新 access token 也造成临期 JWT，模拟真实环境（第二次尝试仍需先续期）
      return { ok: true, status: 200, json: async () => ({ access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) - 30 }), refresh_token: `rt-${refreshTokensUsed.length}` }) };
    }
    usageAttempts += 1;
    if (usageAttempts === 1) throw new Error('net::ERR_CONNECTION_CLOSED at https://chatgpt.com');
    return { ok: true, status: 200, json: async () => codexUsagePayload };
  };
  const windows = await queryAccount({ id: 'a1' }, codexProvider, '', fetcher, {}, {
    retryDelaysMs: [0, 0],
    onCliAuth: ({ next }) => { stored = next; },
    getSecretVariables: () => ({ [SNAPSHOT_KEY]: JSON.stringify(stored) }),
  });
  assert.equal(windows.length, 2);
  assert.deepEqual(refreshTokensUsed, ['rt-old', 'rt-1']);
});

test('cc-switch 官方 OAuth 条目识别：还原为 auth.json 形态，非 codex / 中转条目不识别', () => {
  const bundle = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'at', refresh_token: 'rt', account_id: 'acc-1', id_token: 'x.y.z' } };
  const extracted = extractCodexOauth('codex', JSON.stringify({ auth: bundle, config: '' }));
  assert.equal(extracted.tokens.account_id, 'acc-1');
  assert.equal(extracted.tokens.refresh_token, 'rt');
  assert.equal(extractCodexOauth('claude', JSON.stringify({ auth: bundle })), null);
  assert.equal(extractCodexOauth('codex', JSON.stringify({ auth: { OPENAI_API_KEY: 'sk-x' } })), null);
});

// ── Kimi 订阅（网页会话快照）：解析 / 身份 / 续期 / 额度查询 ───────────────────
const kimiSnapshot = (overrides = {}) => ({
  accessToken: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 600 }),
  refreshToken: 'krt-old',
  userId: 'd71ngibacc4d5ga9klk0',
  authHost: 'https://auth.kimi.com',
  ...overrides,
});
const kimiStatsPayload = {
  ratelimitCode5h: { ratio: 0.4534, enabled: true, resetTime: '2026-09-10T12:58:06.442945Z' },
  ratelimitCode7d: { ratio: 0.3768, enabled: true, resetTime: '2026-09-14T01:58:06.442945Z' },
  subscriptionBalance: { feature: 'FEATURE_OMNI', amountUsedRatio: 0.0884, kimiCodeUsedRatio: 0.0752, expireTime: '2026-10-10T00:00:00Z' },
};
const kimiProvider = { id: 'kimi-subscription', name: 'Kimi 订阅', requestConfig: builtinConfigs['kimi-subscription'] };

test('Kimi 快照解析与身份：userId 是稳定指纹，展示退到尾号，exp 读自 JWT', () => {
  const snapshot = kimiSnapshot();
  assert.equal(parseCliSnapshot('kimi', { [SNAPSHOT_KEY]: JSON.stringify(snapshot) }).userId, 'd71ngibacc4d5ga9klk0');
  assert.equal(parseCliSnapshot('kimi', { [SNAPSHOT_KEY]: JSON.stringify({ userId: 'u1' }) }), null);
  const identity = cliIdentity('kimi', snapshot);
  assert.equal(identity.fingerprint, 'd71ngibacc4d5ga9klk0');
  assert.equal(identity.display, '…a9klk0');
  assert.ok(Math.abs(cliAuth.accessTokenExpiryMs('kimi', snapshot) - (Math.floor(Date.now() / 1000) + 600) * 1000) < 5000);
  // 没有本机 live 文件可回落
  assert.equal(resolveCliAuth('kimi', {}), null);
});

test('Kimi 续期：connect-rpc 端点与 JSON 形态正确，软轮换成对更新', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ accessToken: 'at-new', refreshToken: 'krt-new' }) };
  };
  const next = await refreshCliAuth('kimi', kimiSnapshot(), fetcher, 5000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${__constants.KIMI_AUTH_HOST}${__constants.KIMI_REFRESH_PATH}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { refreshToken: 'krt-old' });
  assert.equal(next.accessToken, 'at-new');
  assert.equal(next.refreshToken, 'krt-new');
  assert.equal(next.userId, 'd71ngibacc4d5ga9klk0');
  assert.equal(next.authHost, 'https://auth.kimi.com');
  // 海外区快照按记录的 authHost 续期
  const oversea = await refreshCliAuth('kimi', kimiSnapshot({ authHost: 'https://auth.kimi.ai' }), fetcher, 5000);
  assert.equal(calls[1].url, `https://auth.kimi.ai${__constants.KIMI_REFRESH_PATH}`);
  assert.ok(oversea);
});

test('Kimi 续期被拒绝标记为永久失败，网络错误保持瞬时', async () => {
  const refused = async () => ({ ok: false, status: 401, json: async () => ({ code: 'unauthenticated' }) });
  await assert.rejects(
    () => refreshCliAuth('kimi', kimiSnapshot(), refused, 5000),
    (error) => error instanceof CliRefreshError && error.permanent === true && /重新扫码/.test(error.message),
  );
  const unreachable = async () => { throw new Error('fetch failed'); };
  await assert.rejects(
    () => refreshCliAuth('kimi', kimiSnapshot(), unreachable, 5000),
    (error) => error instanceof CliRefreshError && error.permanent === false,
  );
});

test('Kimi 订阅额度查询：一个接口出三个窗口，ratio 换算为剩余百分比，月度取 coding 口径', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, method: init.method, authorization: init.headers.Authorization });
    return { ok: true, status: 200, json: async () => kimiStatsPayload };
  };
  const snapshot = kimiSnapshot();
  const windows = await queryAccount({ id: 'k1' }, kimiProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].authorization, `Bearer ${snapshot.accessToken}`);
  assert.deepEqual(windows.map((item) => item.key), ['five_hour', 'weekly', 'monthly']);
  assert.equal(windows[0].remaining, 54.66);
  assert.equal(windows[1].remaining, 62.32);
  assert.equal(windows[2].remaining, 92.48);
  assert.equal(windows[2].resetAt, '2026-10-10T00:00:00Z');
});

test('Kimi 订阅额度查询：401 自动续期后重试，并把新凭据回传主进程', async () => {
  const events = [];
  const fetcher = async (url, init) => {
    if (url === `${__constants.KIMI_AUTH_HOST}${__constants.KIMI_REFRESH_PATH}`) {
      return { ok: true, status: 200, json: async () => ({ accessToken: 'at-new', refreshToken: 'krt-new' }) };
    }
    const first = events.length === 0;
    return first
      ? { ok: false, status: 401, json: async () => ({ code: 'unauthenticated' }) }
      : { ok: true, status: 200, json: async () => kimiStatsPayload };
  };
  const windows = await queryAccount({ id: 'k1' }, kimiProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(kimiSnapshot()) }, {
    onCliAuth: (event) => events.push(event),
  });
  assert.equal(windows.length, 3);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'kimi');
  assert.equal(events[0].source, 'snapshot');
  assert.equal(events[0].next.refreshToken, 'krt-new');
  // 续期被拒后仍 401 → 提示重新扫码
  const always401 = async () => ({ ok: false, status: 401, json: async () => ({ code: 'unauthenticated' }) });
  await assert.rejects(
    () => queryAccount({ id: 'k1' }, kimiProvider, '', always401, { [SNAPSHOT_KEY]: JSON.stringify(kimiSnapshot()) }),
    (error) => /重新扫码/.test(error.message),
  );
});

test('Kimi 订阅额度查询：无订阅时只剩 5 小时 / 7 天窗口也成立，enabled=false 的窗口跳过', async () => {
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ratelimitCode5h: { ratio: 0.2, enabled: false }, ratelimitCode7d: { ratio: 0.5, enabled: true, resetTime: '2026-09-14T01:58:06Z' } }),
  });
  const windows = await queryAccount({ id: 'k1' }, kimiProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(kimiSnapshot()) });
  assert.deepEqual(windows.map((item) => item.key), ['weekly']);
  assert.equal(windows[0].remaining, 50);
  // 没有任何可识别窗口时给出可行动提示
  const empty = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(
    () => queryAccount({ id: 'k1' }, kimiProvider, '', empty, { [SNAPSHOT_KEY]: JSON.stringify(kimiSnapshot()) }),
    (error) => /没有可识别的额度窗口/.test(error.message),
  );
  // 没有快照时提示扫码登录
  await assert.rejects(
    () => queryAccount({ id: 'k1' }, kimiProvider, '', async () => { throw new Error('should not call'); }, {}),
    (error) => /未检测到 Kimi 订阅登录/.test(error.message),
  );
});

test('Kimi 订阅额度查询：用量为 0 时 proto3 省略 ratio 字段，窗口仍按 100% 剩余展示', async () => {
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ratelimitCode5h: { enabled: true, resetTime: '2026-09-11T03:58:05Z' },
      ratelimitCode7d: { ratio: 0.5802, enabled: true, resetTime: '2026-09-14T01:58:06Z' },
      subscriptionBalance: { kimiCodeUsedRatio: 0.1153, expireTime: '2026-10-10T00:00:00Z' },
    }),
  });
  const windows = await queryAccount({ id: 'k1' }, kimiProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(kimiSnapshot()) });
  const fiveHour = windows.find((item) => item.key === 'five_hour');
  assert.ok(fiveHour, 'five_hour 窗口不应因 ratio 缺失被丢弃');
  assert.equal(fiveHour.remaining, 100);
  assert.equal(fiveHour.resetAt, '2026-09-11T03:58:05Z');
});
