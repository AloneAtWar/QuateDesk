const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cliAuth = require('../electron/cli-auth.cjs');
const { queryAccount, authStatusForPollError } = require('../electron/poller.cjs');
const { builtinConfigs } = require('../electron/builtin-configs.cjs');
const { extractCodexOauth } = require('../electron/ccswitch.cjs');

const { SNAPSHOT_KEY, cliIdentity, parseCliSnapshot, resolveCliAuth, refreshCliAuth, writeLiveIfCurrent, fetchWithCliAuth, CliRefreshError, __constants } = cliAuth;

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeJwt = (claims) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`;

// single-flight 的刷新结果会在进程内保留一段时间（同 refresh token 的迟到请求共享，
// 防轮换判复用）：测试之间互不共享飞行表，每个用例独立发刷新请求
beforeEach(() => cliAuth.__test.clearRefreshFlights());

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
  // expiresAt 归一化为 epoch 毫秒（新版 Claude Code 的形态；秒级 expires_at 也归一）
  assert.equal(typeof claudeNext.claudeOauth.expiresAt, 'number');
  assert.ok(claudeNext.claudeOauth.expiresAt > Date.now() + 3000_000);
  const secondsFetcher = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'a3', refresh_token: 'r3', expires_at: Math.floor(Date.now() / 1000) + 3600 }) });
  const fromSeconds = await refreshCliAuth('claude', { claudeAiOauth: { accessToken: 'a1', refreshToken: 'r1' } }, secondsFetcher, 1000);
  assert.ok(fromSeconds.claudeAiOauth.expiresAt > Date.now() + 3000_000, 'epoch 秒归一为毫秒');
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

test('Claude 凭据键名兼容：新版 claudeAiOauth / 旧版 "claude.ai_oauth" / 本应用旧快照 claudeOauth 均可识别', () => {
  const token = fakeJwt({ sub: 'user_am_9x' });
  for (const key of ['claudeAiOauth', 'claude.ai_oauth', 'claudeOauth']) {
    const auth = { [key]: { accessToken: token, refreshToken: 'cr-1', expiresAt: Date.now() + 3600_000 } };
    assert.equal(cliIdentity('claude', auth).fingerprint, 'user_am_9x', key);
    assert.equal(cliAuth.refreshTokenOf('claude', auth), 'cr-1', key);
    assert.ok(cliAuth.accessTokenExpiryMs('claude', auth) > Date.now(), key);
    assert.equal(parseCliSnapshot('claude', { [SNAPSHOT_KEY]: JSON.stringify(auth) })[key].accessToken, token);
  }
  // epoch 毫秒数字的 expiresAt 也能解析（新版 Claude Code 的写法）
  assert.ok(Math.abs(cliAuth.accessTokenExpiryMs('claude', { claudeAiOauth: { accessToken: token, refreshToken: 'cr-1', expiresAt: 1792548716835 } }) - 1792548716835) < 1);
  // 空 / 无 token 的条目不识别
  assert.equal(cliIdentity('claude', { claudeAiOauth: { scopes: [] } }), null);
  assert.equal(cliIdentity('claude', {}), null);
});

// Claude 身份与跟随：oauthAccount（~/.claude.json）是唯一稳定账号标识——凭据 token 是
// 不透明字符串且 refresh token 每次续期轮换；快照保存 Profile（qdOAuthProfile 元数据），
// 本机 Claude Code 登录同一账号时 resolve 跟随 live（Claude Code 随时会轮换凭据）。
// async 感知的临时 home 包装：await 回调结束后才还原环境、删除目录（否则异步用例体
// 会读到还原后的真实 home）
const withClaudeHome = async (run) => {
  const previousProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-'));
  try {
    fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
    process.env.USERPROFILE = tempHome;
    process.env.HOME = tempHome;
    delete process.env.CLAUDE_CONFIG_DIR;
    cliAuth.__claude.resetClaudeProfileCache();
    return await run(tempHome);
  } finally {
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    cliAuth.__claude.resetClaudeProfileCache();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
};
const writeClaudeLive = (home, { refreshToken = 'live-rt', accessToken = 'live-at', uuid = 'uuid-1', email = 'User@Example.com' } = {}) => {
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + 3600_000 } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid, ...(email ? { emailAddress: email } : {}) } }));
  cliAuth.__claude.resetClaudeProfileCache();
};

test('Claude 身份：oauthAccount 的 accountUuid/email 优先，随续期轮换保持稳定', () => {
  withClaudeHome((home) => {
    writeClaudeLive(home);
    const live = cliAuth.readLiveAuth('claude');
    assert.ok(live, 'live 登录可读');
    assert.deepEqual(cliIdentity('claude', live), { fingerprint: 'uuid-1', display: 'user@example.com' });
    // 轮换 refresh token 后指纹不变（旧实现退到 refresh_token 指纹会漂移）
    const rotated = { ...live, claudeAiOauth: { ...live.claudeAiOauth, refreshToken: 'rotated-rt' } };
    assert.equal(cliIdentity('claude', rotated).fingerprint, 'uuid-1');
  });
});

test('Claude 凭据解析：同账号跟随 live，异账号 / 无 Profile / 凭据被清空时回退快照', () => {
  withClaudeHome((home) => {
    writeClaudeLive(home);
    const snapshot = (uuid = 'uuid-1') => ({ claudeAiOauth: { accessToken: 'snap-at', refreshToken: 'snap-rt', expiresAt: Date.now() + 3600_000 }, qdOAuthProfile: { accountUuid: uuid, emailAddress: 'user@example.com' } });
    const followed = resolveCliAuth('claude', { [SNAPSHOT_KEY]: JSON.stringify(snapshot()) });
    assert.equal(followed.source, 'live', 'oauthAccount 一致 → 跟随 live');
    assert.equal(followed.auth.claudeAiOauth.refreshToken, 'live-rt');
    assert.ok(followed.auth.qdOAuthProfile, 'live 凭据附着 Profile');
    assert.equal(resolveCliAuth('claude', { [SNAPSHOT_KEY]: JSON.stringify(snapshot('uuid-2')) }).source, 'snapshot', '本机登录是另一账号 → 用快照');
    assert.equal(resolveCliAuth('claude', { [SNAPSHOT_KEY]: JSON.stringify({ claudeAiOauth: snapshot().claudeAiOauth }) }).source, 'snapshot', '旧快照无 Profile → 维持快照优先');
    writeClaudeLive(home, { refreshToken: '', accessToken: '' });
    assert.equal(resolveCliAuth('claude', { [SNAPSHOT_KEY]: JSON.stringify(snapshot()) }).source, 'snapshot', '本机凭据被 Claude Code 清空 → 视为未登录');
  });
});

test('Claude 续期回写 live：剥离 qdOAuthProfile 元数据，保持 Claude Code 原生形态', () => {
  withClaudeHome((home) => {
    writeClaudeLive(home, { refreshToken: 'rt-old', accessToken: 'a1' });
    const refreshed = { claudeAiOauth: { accessToken: 'a2', refreshToken: 'rt-new', expiresAt: Date.now() + 3600_000 }, qdOAuthProfile: { accountUuid: 'uuid-1' } };
    assert.equal(writeLiveIfCurrent('claude', { claudeAiOauth: { accessToken: 'a1', refreshToken: 'rt-old' } }, refreshed), true);
    const written = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'));
    assert.equal(written.qdOAuthProfile, undefined, '元数据不落 live 文件');
    assert.equal(written.claudeAiOauth.refreshToken, 'rt-new');
    // live 已被 Claude Code 轮换（refresh token 不再是刷新前那把）→ CAS 拒绝写入
    assert.equal(writeLiveIfCurrent('claude', { claudeAiOauth: { accessToken: 'a1', refreshToken: 'rt-old' } }, refreshed), false);
  });
});

test('Claude 续期失效分诊：本机凭据未动 → 提示其它设备轮换；本机已变化 → 提示重新导入', async () => {
  const fetcher = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  await withClaudeHome(async (home) => {
    writeClaudeLive(home, { refreshToken: 'rt-snap', uuid: 'uuid-1' });
    const unchanged = await refreshCliAuth('claude', { claudeAiOauth: { accessToken: 'a1', refreshToken: 'rt-snap' } }, fetcher, 1000).catch((error) => error);
    assert.ok(unchanged instanceof CliRefreshError && unchanged.permanent === true);
    assert.match(unchanged.message, /其它设备/);
    writeClaudeLive(home, { refreshToken: 'rt-moved' });
    const moved = await refreshCliAuth('claude', { claudeAiOauth: { accessToken: 'a1', refreshToken: 'rt-snap' } }, fetcher, 1000).catch((error) => error);
    assert.match(moved.message, /本机 Claude Code 的登录已变化/);
  });
});

// 429 限流退避：IP 级限流（无效 token 同样 429）时进入冷却，冷却期内不发刷新请求、
// 不提示重新登录；冷却清除后恢复正常续期
test('Claude 429 限流：提示稍后重试而非重新登录，冷却期内不再撞 token 端点', async () => {
  await withClaudeHome(async () => {
    const tokenCalls = [];
    let refreshShouldFail = true;
    const fetcher = async (url, init) => {
      if (url === __constants.CLAUDE_TOKEN_URL) {
        tokenCalls.push(JSON.parse(init.body).refresh_token);
        if (refreshShouldFail) return { ok: false, status: 429, headers: new Map(), json: async () => ({ error: { type: 'rate_limit_error' } }) };
        return { ok: true, status: 200, json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const expiredAuth = { claudeAiOauth: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() - 1000 } };
    const first = await fetchWithCliAuth('claude', { auth: expiredAuth, source: 'snapshot', fetcher, timeoutMs: 1000, buildRequest: () => ({ url: 'https://example.test/usage' }) }).catch((error) => error);
    assert.ok(first instanceof CliRefreshError, '429 抛出 CliRefreshError');
    assert.equal(first.permanent, false, '429 不是永久失败');
    assert.ok(first.transient, '429 是瞬时失败');
    assert.doesNotMatch(first.message, /请.*重新登录|请.*重新导入/, '429 文案不要求重新登录');
    assert.match(first.message, /限流/);
    assert.ok(first.retryAfterMs >= 30_000, '无 Retry-After 时用默认冷却');
    assert.equal(tokenCalls.length, 1);
    // 冷却期内（含 poller 立即重试、后续轮询）：不再发刷新请求，快速失败
    const second = await fetchWithCliAuth('claude', { auth: expiredAuth, source: 'snapshot', fetcher, timeoutMs: 1000, buildRequest: () => ({ url: 'https://example.test/usage' }) }).catch((error) => error);
    assert.ok(second instanceof CliRefreshError);
    assert.match(second.message, /限流退避/);
    assert.equal(tokenCalls.length, 1, '冷却期内没有新的刷新请求');
    // 冷却清除后：恢复续期并成功
    cliAuth.__test.clearRefreshCooldowns();
    cliAuth.__test.clearRefreshFlights();
    refreshShouldFail = false;
    const response = await fetchWithCliAuth('claude', { auth: expiredAuth, source: 'snapshot', fetcher, timeoutMs: 1000, buildRequest: (auth) => ({ url: 'https://example.test/usage', init: { headers: { Authorization: `Bearer ${auth.claudeAiOauth.accessToken}` } } }) });
    assert.equal(response.status, 200);
    assert.equal(tokenCalls.length, 2, '冷却结束后恢复刷新');
  });
});

test('Retry-After 响应头被解析为冷却时长（秒数与 HTTP 日期）', () => {
  const { retryAfterMsOf } = cliAuth.__test;
  assert.equal(retryAfterMsOf({ headers: new Map([['retry-after', '120']]) }), 120_000);
  const date = new Date(Date.now() + 60_000).toUTCString();
  const parsed = retryAfterMsOf({ headers: new Map([['retry-after', date]]) });
  assert.ok(parsed > 50_000 && parsed <= 60_000, `HTTP 日期解析：${parsed}`);
  assert.equal(retryAfterMsOf({ headers: new Map() }), null);
  assert.equal(retryAfterMsOf({}), null);
});

test('Claude 续期写回原键名：claudeAiOauth 进则 claudeAiOauth 出，live 文件形态不被破坏', async () => {
  const fetcher = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }) });
  const next = await refreshCliAuth('claude', { claudeAiOauth: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() - 1000, subscriptionType: 'pro' } }, fetcher, 1000);
  assert.equal(next.claudeAiOauth.accessToken, 'a2');
  assert.equal(next.claudeAiOauth.refreshToken, 'r2');
  assert.equal(next.claudeAiOauth.subscriptionType, 'pro', 'entry 的未知字段保留');
  assert.equal(next.claudeOauth, undefined, '不落到旧键名');
  const legacy = await refreshCliAuth('claude', { 'claude.ai_oauth': { accessToken: 'a1', refreshToken: 'r1' } }, fetcher, 1000);
  assert.equal(legacy['claude.ai_oauth'].accessToken, 'a2');
  assert.equal(legacy.claudeAiOauth, undefined);
});

// ── Gemini live 登录：新版 gemini-cli 的密钥库 / 加密文件回落 ─────────────────
// 与 gemini-cli fileKeychain.ts 同算法加密（scrypt + AES-256-GCM，hex 三段式）
const encryptGeminiFileKeychain = (map) => {
  const iv = crypto.randomBytes(12);
  const salt = `${os.hostname()}-${os.userInfo().username}-gemini-cli`;
  const key = crypto.scryptSync('gemini-cli-oauth', salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(map), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
};
const geminiKeytarJson = JSON.stringify({
  serverName: 'main-account',
  token: { accessToken: 'ya29.live-access', refreshToken: '1//live-refresh', tokenType: 'Bearer', expiresAt: 1893456000000 },
  updatedAt: 1699999999999,
});

test('Gemini keytar 形态归一化：token 条目转扁平 google-auth-library 格式，无 token 不识别', () => {
  assert.deepEqual(
    cliAuth.__gemini.geminiAuthFromKeytarShape({ token: { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresAt: 123 } }),
    { access_token: 'a', refresh_token: 'r', expiry_date: 123, token_type: 'Bearer' },
  );
  assert.equal(cliAuth.__gemini.geminiAuthFromKeytarShape({ token: { tokenType: 'Bearer' } }), null);
  assert.equal(cliAuth.__gemini.geminiAuthFromKeytarShape({}), null);
  assert.equal(cliAuth.__gemini.geminiAuthFromKeytarShape('junk'), null);
});

test('Gemini live 回落：旧扁平文件优先；文件缺失时读 FileKeychain 加密文件（GEMINI_CLI_HOME 生效）', () => {
  const previousHome = process.env.GEMINI_CLI_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-auth-'));
  cliAuth.__gemini.resetGeminiSecureCache();
  try {
    process.env.GEMINI_CLI_HOME = tempHome;
    // 都没有 → null
    assert.equal(cliAuth.readLiveAuth('gemini'), null);
    cliAuth.__gemini.resetGeminiSecureCache();
    // 只有加密文件（新版 gemini-cli 的 FileKeychain 形态）
    fs.writeFileSync(path.join(tempHome, 'gemini-credentials.json'), encryptGeminiFileKeychain({ 'gemini-cli-oauth': { 'main-account': geminiKeytarJson } }));
    const fromKeychain = cliAuth.readLiveAuth('gemini');
    assert.equal(fromKeychain.access_token, 'ya29.live-access');
    assert.equal(fromKeychain.refresh_token, '1//live-refresh');
    assert.equal(fromKeychain.expiry_date, 1893456000000);
    const identity = cliIdentity('gemini', fromKeychain);
    // Google 的 access_token 不是 JWT：指纹退到 refresh_token 的 shaTag（refresh 不轮换，稳定）
    assert.equal(identity.fingerprint, crypto.createHash('sha256').update('1//live-refresh').digest('hex').slice(0, 16));
    assert.equal(identity.display, `…${identity.fingerprint.slice(-6)}`);
    // 旧扁平文件出现后优先于加密文件
    fs.writeFileSync(path.join(tempHome, 'oauth_creds.json'), JSON.stringify({ access_token: 'legacy-access', refresh_token: 'legacy-refresh', expiry_date: 1893456000001 }));
    assert.equal(cliAuth.readLiveAuth('gemini').access_token, 'legacy-access');
    // 损坏的加密文件按未登录处理（不会被旧扁平文件分支之外的路径抛错）
    fs.rmSync(path.join(tempHome, 'oauth_creds.json'));
    fs.writeFileSync(path.join(tempHome, 'gemini-credentials.json'), 'not:encrypted:at-all');
    cliAuth.__gemini.resetGeminiSecureCache();
    assert.equal(cliAuth.readLiveAuth('gemini'), null);
  } finally {
    if (previousHome === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = previousHome;
    cliAuth.__gemini.resetGeminiSecureCache();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
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

test('Kimi 续期失败分类：登录失效要求重扫，限流 / 服务端 / 网络错误保持瞬时', async () => {
  // 即使鉴权失败响应不是 JSON，也必须保留 HTTP 401，不能误判成网络抖动。
  const refused = async () => ({ ok: false, status: 401, json: async () => { throw new SyntaxError('not json'); } });
  await assert.rejects(
    () => refreshCliAuth('kimi', kimiSnapshot(), refused, 5000),
    (error) => error instanceof CliRefreshError
      && error.permanent === true
      && error.transient === false
      && error.authStatus === 'reauth_required'
      && /登录已失效.*HTTP 401.*重新扫码/.test(error.message),
  );
  const wrappedRefusal = async () => ({ ok: true, status: 200, json: async () => ({ code: 'unauthenticated' }) });
  await assert.rejects(
    () => refreshCliAuth('kimi', kimiSnapshot(), wrappedRefusal, 5000),
    (error) => error instanceof CliRefreshError
      && error.permanent === true
      && error.transient === false
      && /登录已失效.*unauthenticated.*重新扫码/.test(error.message),
  );
  const limited = async () => ({ ok: false, status: 429, json: async () => ({ code: 'resource_exhausted' }) });
  await assert.rejects(
    () => refreshCliAuth('kimi', kimiSnapshot(), limited, 5000),
    (error) => error instanceof CliRefreshError
      && error.permanent === false
      && error.transient === true
      && /暂时失败.*HTTP 429.*resource_exhausted.*稍后重试/.test(error.message),
  );
  const unavailable = async () => ({ ok: false, status: 503, json: async () => ({ code: 'unavailable' }) });
  await assert.rejects(
    () => refreshCliAuth('kimi', kimiSnapshot(), unavailable, 5000),
    (error) => error instanceof CliRefreshError
      && error.permanent === false
      && error.transient === true
      && /暂时失败.*HTTP 503.*unavailable.*稍后重试/.test(error.message),
  );
  const unreachable = async () => { throw new Error('fetch failed'); };
  await assert.rejects(
    () => refreshCliAuth('kimi', kimiSnapshot(), unreachable, 5000),
    (error) => error instanceof CliRefreshError && error.permanent === false && error.transient === true,
  );
  const incomplete = async () => ({ ok: true, status: 200, json: async () => ({ accessToken: 'only-half' }) });
  await assert.rejects(
    () => refreshCliAuth('kimi', kimiSnapshot(), incomplete, 5000),
    (error) => error instanceof CliRefreshError
      && error.permanent === false
      && error.transient === true
      && /响应缺少令牌.*稍后重试/.test(error.message),
  );
});

test('Kimi 并发续期去重：同一把旧 refreshToken 的并发请求共享一次刷新', async () => {
  const snapshot = kimiSnapshot({
    accessToken: fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
    refreshToken: 'krt-concurrent',
  });
  let refreshCalls = 0;
  const requestTokens = [];
  const updates = [];
  const fetcher = async (url, init) => {
    if (url === `${__constants.KIMI_AUTH_HOST}${__constants.KIMI_REFRESH_PATH}`) {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, status: 200, json: async () => ({ accessToken: 'at-concurrent-new', refreshToken: 'krt-concurrent-new' }) };
    }
    requestTokens.push(init.headers.Authorization);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const args = {
    auth: snapshot,
    source: 'snapshot',
    fetcher,
    timeoutMs: 1000,
    buildRequest: (auth) => ({ url: 'https://www.kimi.com/usage', init: { headers: { Authorization: `Bearer ${auth.accessToken}` } } }),
    onAuthUpdate: (kind, next, previous, source) => updates.push({ kind, next, previous, source }),
  };

  await Promise.all([fetchWithCliAuth('kimi', args), fetchWithCliAuth('kimi', args), fetchWithCliAuth('kimi', args)]);

  assert.equal(refreshCalls, 1);
  assert.deepEqual(requestTokens, ['Bearer at-concurrent-new', 'Bearer at-concurrent-new', 'Bearer at-concurrent-new']);
  assert.equal(updates.length, 3);
  assert.ok(updates.every((item) => item.kind === 'kimi'
    && item.source === 'snapshot'
    && item.previous.refreshToken === 'krt-concurrent'
    && item.next.refreshToken === 'krt-concurrent-new'));
});

test('Kimi 错峰 401 复用刚完成的续期结果，不会再次使用旧 refreshToken', async () => {
  const snapshot = kimiSnapshot({
    accessToken: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    refreshToken: 'krt-staggered-old',
  });
  let refreshCalls = 0;
  let oldRequests = 0;
  let releaseLate401;
  const late401 = new Promise((resolve) => { releaseLate401 = resolve; });
  const fetcher = async (url, init) => {
    if (url === `${__constants.KIMI_AUTH_HOST}${__constants.KIMI_REFRESH_PATH}`) {
      refreshCalls += 1;
      return { ok: true, status: 200, json: async () => ({ accessToken: 'at-staggered-new', refreshToken: 'krt-staggered-new' }) };
    }
    if (init.headers.Authorization !== 'Bearer at-staggered-new') {
      oldRequests += 1;
      if (oldRequests === 2) await late401;
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const args = {
    auth: snapshot,
    source: 'snapshot',
    fetcher,
    timeoutMs: 1000,
    buildRequest: (auth) => ({ url: 'https://www.kimi.com/usage', init: { headers: { Authorization: `Bearer ${auth.accessToken}` } } }),
  };

  const first = fetchWithCliAuth('kimi', args);
  const delayed = fetchWithCliAuth('kimi', args);
  await first;
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseLate401();
  await delayed;

  assert.equal(oldRequests, 2);
  assert.equal(refreshCalls, 1);
});

test('Kimi 限流重试耗尽后保留厂商提示，且不要求重新扫码', async () => {
  const snapshot = kimiSnapshot({
    accessToken: fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
    refreshToken: 'krt-rate-limited',
  });
  let refreshCalls = 0;
  const fetcher = async () => {
    refreshCalls += 1;
    return { ok: false, status: 429, json: async () => ({ code: 'resource_exhausted' }) };
  };
  await assert.rejects(
    () => queryAccount({ id: 'k-rate' }, kimiProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) }, { retryDelaysMs: [0, 0] }),
    (error) => error.transient === true
      && authStatusForPollError(error) === 'temporary_error'
      && /Kimi 订阅续期暂时失败.*HTTP 429.*稍后重试/.test(error.message)
      && !/网络代理/.test(error.message),
  );
  assert.equal(refreshCalls, 3);
});

test('只有显式认证错误要求重新登录，永久的安全校验失败不会误导为重登', () => {
  assert.equal(authStatusForPollError(Object.assign(new Error('revoked'), { authStatus: 'reauth_required', permanent: true })), 'reauth_required');
  assert.equal(authStatusForPollError(Object.assign(new Error('issuer mismatch'), { permanent: true })), 'temporary_error');
});

test('Kimi 并发续期失败也只请求一次，并向所有调用返回一致的失效状态', async () => {
  const snapshot = kimiSnapshot({
    accessToken: fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
    refreshToken: 'krt-revoked-concurrent',
  });
  let refreshCalls = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const fetcher = async (url) => {
    assert.equal(url, `${__constants.KIMI_AUTH_HOST}${__constants.KIMI_REFRESH_PATH}`);
    refreshCalls += 1;
    await refreshGate;
    return { ok: false, status: 401, json: async () => ({ code: 'unauthenticated' }) };
  };
  const args = {
    auth: snapshot,
    source: 'snapshot',
    fetcher,
    timeoutMs: 1000,
    buildRequest: () => { throw new Error('失效续期后不应发出业务请求'); },
  };

  const requests = [
    fetchWithCliAuth('kimi', args),
    fetchWithCliAuth('kimi', args),
    fetchWithCliAuth('kimi', args),
  ];
  releaseRefresh();
  const results = await Promise.allSettled(requests);

  assert.equal(refreshCalls, 1);
  assert.ok(results.every((result) => result.status === 'rejected'
    && result.reason instanceof CliRefreshError
    && result.reason.permanent === true
    && result.reason.transient === false
    && /登录已失效.*unauthenticated.*重新扫码/.test(result.reason.message)));
});

test('Kimi 订阅额度查询：一个接口出三个窗口，ratio 换算为剩余百分比，月度取会员池口径 amountUsedRatio', async () => {
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
  assert.equal(windows[2].remaining, 91.16);
  assert.equal(windows[2].resetAt, '2026-10-10T00:00:00Z');
});

test('Kimi 订阅额度查询：缺 amountUsedRatio 时月度退回 coding 口径 kimiCodeUsedRatio', async () => {
  const payload = { ...kimiStatsPayload, subscriptionBalance: { ...kimiStatsPayload.subscriptionBalance, amountUsedRatio: undefined } };
  const fetcher = async () => ({ ok: true, status: 200, json: async () => payload });
  const windows = await queryAccount({ id: 'k1' }, kimiProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(kimiSnapshot()) });
  assert.equal(windows[2].remaining, 92.48);
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
  // 没有快照也没有 API Key 时提示完成登录（Kimi 双登录：API Key 模式的前置检查）
  await assert.rejects(
    () => queryAccount({ id: 'k1' }, kimiProvider, '', async () => { throw new Error('should not call'); }, {}),
    (error) => /没有 API Key，也没有扫码登录/.test(error.message),
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

// ── Grok（xAI）：与 cc-switch 同一 OIDC 路径的续期 ──────────────────────────
const GROK = cliAuth.__constants;
const grokAuthFile = (overrides = {}) => ({
  [`${GROK.GROK_ISSUER}::${GROK.GROK_CLIENT_ID}`]: {
    key: 'grok-access-old',
    refresh_token: 'grok-rt-old',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    email: 'grok@example.com',
    user_id: 'xai-user-1',
    ...(overrides.oidc || {}),
  },
  'https://accounts.x.ai/sign-in': { key: 'legacy-session', ...(overrides.legacy || {}) },
});
const grokSnapshot = (overrides = {}) => {
  const file = grokAuthFile(overrides);
  return { [SNAPSHOT_KEY]: JSON.stringify(file) };
};
const grokDiscoveryPayload = { issuer: GROK.GROK_ISSUER, token_endpoint: GROK.GROK_TOKEN_URL };
const grokTokenPayload = (overrides = {}) => ({
  access_token: 'grok-access-new',
  refresh_token: 'grok-rt-new',
  expires_in: 3600,
  ...overrides,
});
const grokRefreshFetcher = (calls, tokenPayload = grokTokenPayload()) => async (url, init) => {
  calls.push({ url, init });
  if (url === GROK.GROK_DISCOVERY_URL) return { ok: true, status: 200, json: async () => grokDiscoveryPayload };
  return { ok: true, status: 200, json: async () => tokenPayload };
};

test('Grok 快照解析：OIDC 条目优先于 legacy session，scope 作为元数据保留', () => {
  const snapshot = parseCliSnapshot('grok', grokSnapshot());
  assert.equal(snapshot.key, 'grok-access-old');
  assert.equal(snapshot.scopeKey, `${GROK.GROK_ISSUER}::${GROK.GROK_CLIENT_ID}`);
  // 只有 legacy session 时也能用
  const legacyOnly = parseCliSnapshot('grok', { [SNAPSHOT_KEY]: JSON.stringify({ 'https://accounts.x.ai/sign-in': { key: 'legacy-session' } }) });
  assert.equal(legacyOnly.key, 'legacy-session');
  // 损坏 / 无凭据 → null
  assert.equal(parseCliSnapshot('grok', { [SNAPSHOT_KEY]: '{broken' }), null);
  assert.equal(parseCliSnapshot('grok', { [SNAPSHOT_KEY]: JSON.stringify({ foo: { noKey: true } }) }), null);
  assert.equal(parseCliSnapshot('grok', {}), null);
});

test('Grok 凭据解析：快照优先，live 回落走 GROK_HOME 且保留 scope', () => {
  const previousHome = process.env.GROK_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-'));
  try {
    process.env.GROK_HOME = tempHome;
    fs.writeFileSync(path.join(tempHome, 'auth.json'), JSON.stringify(grokAuthFile({ oidc: { key: 'live-access', refresh_token: 'live-rt' } })));
    const live = resolveCliAuth('grok', {});
    assert.equal(live.source, 'live');
    assert.equal(live.auth.key, 'live-access');
    assert.equal(live.scope, `${GROK.GROK_ISSUER}::${GROK.GROK_CLIENT_ID}`);
    const snapshotted = resolveCliAuth('grok', grokSnapshot());
    assert.equal(snapshotted.source, 'snapshot');
    assert.equal(snapshotted.auth.key, 'grok-access-old');
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('Grok 身份指纹：user_id 稳定，email 展示；缺省时退到 JWT sub 与 refresh 指纹', () => {
  const identity = cliIdentity('grok', grokAuthFile());
  assert.deepEqual(identity, { fingerprint: 'xai-user-1', display: 'grok@example.com' });
  const jwtOnly = cliIdentity('grok', { [`${GROK.GROK_ISSUER}::${GROK.GROK_CLIENT_ID}`]: { key: fakeJwt({ sub: 'xai-sub-9', email: 'jwt@example.com' }), refresh_token: 'rt-x' } });
  assert.deepEqual(jwtOnly, { fingerprint: 'xai-sub-9', display: 'jwt@example.com' });
  const bare = cliIdentity('grok', { 'https://accounts.x.ai/sign-in': { key: 'opaque', refresh_token: 'rt-y' } });
  assert.equal(bare.display, `…${bare.fingerprint.slice(-6)}`);
});

test('Grok 续期：discovery 定位 token endpoint，表单形态正确，轮换 refresh_token 并保留 scope', async () => {
  const calls = [];
  const snapshot = parseCliSnapshot('grok', grokSnapshot());
  const next = await refreshCliAuth('grok', snapshot, grokRefreshFetcher(calls), 1000);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, GROK.GROK_DISCOVERY_URL);
  assert.equal(calls[1].url, GROK.GROK_TOKEN_URL);
  assert.equal(calls[1].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(calls[1].init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), GROK.GROK_CLIENT_ID);
  assert.equal(form.get('refresh_token'), 'grok-rt-old');
  assert.equal(form.get('scope'), GROK.GROK_SCOPE);
  assert.equal(next.key, 'grok-access-new');
  assert.equal(next.refresh_token, 'grok-rt-new');
  assert.equal(next.scopeKey, `${GROK.GROK_ISSUER}::${GROK.GROK_CLIENT_ID}`);
  assert.ok(Date.parse(next.expires_at) > Date.now());
  assert.ok(next.last_refresh);
  // 响应不轮换时保留旧 refresh_token
  const kept = await refreshCliAuth('grok', snapshot, grokRefreshFetcher([], grokTokenPayload({ refresh_token: undefined })), 1000);
  assert.equal(kept.refresh_token, 'grok-rt-old');
});

test('Grok 续期失败分类：invalid_grant 永久、429 瞬时、discovery 被篡改永久拒绝', async () => {
  const snapshot = parseCliSnapshot('grok', grokSnapshot());
  const okDiscovery = async (url) => url === GROK.GROK_DISCOVERY_URL
    ? { ok: true, status: 200, json: async () => grokDiscoveryPayload }
    : { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
  await assert.rejects(() => refreshCliAuth('grok', snapshot, okDiscovery, 1000),
    (error) => error instanceof CliRefreshError && error.permanent === true && error.transient !== true);
  const limited = async (url) => url === GROK.GROK_DISCOVERY_URL
    ? { ok: true, status: 200, json: async () => grokDiscoveryPayload }
    : { ok: false, status: 429, json: async () => ({}) };
  await assert.rejects(() => refreshCliAuth('grok', snapshot, limited, 1000),
    (error) => error instanceof CliRefreshError && error.transient === true && error.permanent !== true);
  const blockedDiscovery = async () => ({ ok: false, status: 403, json: async () => ({ error: 'access_denied' }) });
  await assert.rejects(() => refreshCliAuth('grok', snapshot, blockedDiscovery, 1000),
    (error) => error instanceof CliRefreshError
      && error.permanent === true
      && error.authStatus === undefined
      && authStatusForPollError(error) === 'temporary_error');
  // issuer 不匹配 / token endpoint 指向第三方：永久拒绝，refresh_token 不外发
  const evilIssuer = async () => ({ ok: true, status: 200, json: async () => ({ issuer: 'https://evil.example', token_endpoint: GROK.GROK_TOKEN_URL }) });
  await assert.rejects(() => refreshCliAuth('grok', snapshot, evilIssuer, 1000),
    (error) => error.permanent === true && /issuer/.test(error.message));
  let leaked = false;
  const evilEndpoint = async (url) => {
    if (url !== GROK.GROK_DISCOVERY_URL) leaked = true;
    return { ok: true, status: 200, json: async () => ({ issuer: GROK.GROK_ISSUER, token_endpoint: 'https://evil.example/oauth2/token' }) };
  };
  await assert.rejects(() => refreshCliAuth('grok', snapshot, evilEndpoint, 1000), (error) => error.permanent === true);
  assert.equal(leaked, false);
  // 快照缺 refresh_token：永久失败
  const noRefresh = parseCliSnapshot('grok', { [SNAPSHOT_KEY]: JSON.stringify({ 'https://accounts.x.ai/sign-in': { key: 'k' } }) });
  await assert.rejects(() => refreshCliAuth('grok', noRefresh, async () => { throw new Error('不应发出请求'); }, 1000),
    (error) => error.permanent === true && /refresh_token/.test(error.message));
});

test('Grok 鉴权失败（gRPC 200 + 鉴权错误）触发续期重试，isAuthFailure 检查 clone 不消费原响应', async () => {
  const snapshot = parseCliSnapshot('grok', grokSnapshot({ oidc: { expires_at: new Date(Date.now() + 3600_000).toISOString() } }));
  const auths = [];
  let cloned = 0;
  const fetcher = async (url, init) => {
    if (url === GROK.GROK_DISCOVERY_URL) return { ok: true, status: 200, json: async () => grokDiscoveryPayload };
    if (url === GROK.GROK_TOKEN_URL) return { ok: true, status: 200, json: async () => grokTokenPayload() };
    auths.push(init.headers.Authorization);
    const make = (auth) => ({ ok: true, status: 200, auth, clone() { cloned += 1; return make(this.auth); }, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) });
    return make(init.headers.Authorization);
  };
  let failureChecks = 0;
  const response = await fetchWithCliAuth('grok', {
    auth: snapshot,
    source: 'snapshot',
    fetcher,
    timeoutMs: 1000,
    buildRequest: (auth) => ({ url: 'https://grok.com/billing', init: { headers: { Authorization: `Bearer ${auth.key}` } } }),
    isAuthFailure: async (res) => { failureChecks += 1; return res.auth === 'Bearer grok-access-old'; },
  });
  assert.equal(failureChecks, 1);
  assert.equal(cloned, 1);
  assert.deepEqual(auths, ['Bearer grok-access-old', 'Bearer grok-access-new']);
  assert.equal(response.status, 200);
});

test('Grok 并发续期去重：同一把旧 refresh_token 的并发请求共享一次刷新', async () => {
  const snapshot = parseCliSnapshot('grok', grokSnapshot({ oidc: { refresh_token: 'grok-rt-concurrent', expires_at: new Date(Date.now() - 1000).toISOString() } }));
  let tokenCalls = 0;
  const updates = [];
  const fetcher = async (url, init) => {
    if (url === GROK.GROK_DISCOVERY_URL) return { ok: true, status: 200, json: async () => grokDiscoveryPayload };
    if (url === GROK.GROK_TOKEN_URL) {
      tokenCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, status: 200, json: async () => grokTokenPayload({ refresh_token: 'grok-rt-concurrent-new' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const args = {
    auth: snapshot,
    source: 'snapshot',
    fetcher,
    timeoutMs: 1000,
    buildRequest: (auth) => ({ url: 'https://grok.com/billing', init: { headers: { Authorization: `Bearer ${auth.key}` } } }),
    onAuthUpdate: (kind, next, previous, source) => updates.push({ next, previous }),
  };
  await Promise.all([fetchWithCliAuth('grok', args), fetchWithCliAuth('grok', args), fetchWithCliAuth('grok', args)]);
  assert.equal(tokenCalls, 1);
  assert.ok(updates.every((item) => item.previous.refresh_token === 'grok-rt-concurrent' && item.next.refresh_token === 'grok-rt-concurrent-new'));
});

test('Grok live 写回：只合并原 scope 的条目，其它 profile 原样保留；scope 已换账号时不写', () => {
  const previousHome = process.env.GROK_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-live-'));
  const livePath = path.join(tempHome, 'auth.json');
  const oidcScope = `${GROK.GROK_ISSUER}::${GROK.GROK_CLIENT_ID}`;
  try {
    process.env.GROK_HOME = tempHome;
    const before = parseCliSnapshot('grok', grokSnapshot());
    const next = { ...before, key: 'grok-access-new', refresh_token: 'grok-rt-new' };
    fs.writeFileSync(livePath, JSON.stringify({ ...grokAuthFile(), 'https://auth.x.ai::other-client': { key: 'other-access', refresh_token: 'other-rt' } }));
    assert.equal(writeLiveIfCurrent('grok', before, next), true);
    const written = JSON.parse(fs.readFileSync(livePath, 'utf8'));
    assert.equal(written[oidcScope].key, 'grok-access-new');
    assert.equal(written[oidcScope].refresh_token, 'grok-rt-new');
    assert.equal(written[oidcScope].scopeKey, undefined, 'Quota Desk 元数据不写入 CLI entry');
    assert.equal(written['https://auth.x.ai::other-client'].key, 'other-access');
    assert.equal(written['https://accounts.x.ai/sign-in'].key, 'legacy-session');
    // live 原 scope 已换成别的账号（refresh_token 不同）→ 不写
    fs.writeFileSync(livePath, JSON.stringify(grokAuthFile({ oidc: { key: 'switched', refresh_token: 'rt-switched' } })));
    assert.equal(writeLiveIfCurrent('grok', before, next), false);
    assert.equal(JSON.parse(fs.readFileSync(livePath, 'utf8'))[oidcScope].key, 'switched');
  } finally {
    if (previousHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('Grok authVersionMatches：同 refresh_token 视为同一版本，轮换后不匹配', () => {
  const { authVersionMatches } = cliAuth;
  const before = parseCliSnapshot('grok', grokSnapshot());
  const rotated = { ...before, key: 'k2', refresh_token: 'grok-rt-new' };
  assert.equal(authVersionMatches('grok', before, before), true);
  assert.equal(authVersionMatches('grok', { ...before, key: 'k-changed' }, before), true);
  assert.equal(authVersionMatches('grok', rotated, before), false);
  assert.equal(authVersionMatches('grok', { ...rotated, scopeKey: 'https://accounts.x.ai/sign-in' }, before), false);
});
