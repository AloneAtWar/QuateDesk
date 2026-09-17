const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cliAuth = require('../electron/cli-auth.cjs');
const { queryGrokBotUsage, __grokbot } = require('../electron/cli-quota.cjs');
const { builtinConfigs } = require('../electron/builtin-configs.cjs');

const { SNAPSHOT_KEY, cliIdentity, parseCliSnapshot, refreshCliAuth, writeLiveIfCurrent, accessTokenExpiryMs, __grokbot: { oscryptDecrypt } } = cliAuth;
const { grokBotChecksum } = __grokbot;

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fakeJwt = (claims) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`;

const grokBotSnapshot = (overrides = {}) => ({
  machine_id: 'machine-1',
  access_token: fakeJwt({ sub: 'google-oauth2|user_1', email: 'bot@example.com', exp: Math.floor(Date.now() / 1000) + 3600 }),
  refresh_token: 'rt-grokbot',
  ...overrides,
});

const jsonResponse = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

// 按请求特征分发：/oauth/token 续期，其余视为用量查询
const grokBotFetcher = ({ tokenPayload, usagePayload, usageStatus = 200, calls = [] } = {}) => async (url, init = {}) => {
  calls.push({ url, init });
  if (String(url).endsWith('/oauth/token')) return jsonResponse(tokenPayload ? 200 : 400, tokenPayload || { error: 'invalid_grant' });
  return jsonResponse(usageStatus, usagePayload);
};

const recordMeter = () => {
  const rows = [];
  const meter = (key, remaining, total, unit, resetAt, extra = {}) => {
    const entry = { key, remaining, total, unit, resetAt, ...extra };
    rows.push(entry);
    return entry;
  };
  return { rows, meter };
};

const usagePayload = (overrides = {}) => ({
  currentPeriodStart: '2026-09-16T14:32:26.781Z',
  nextResetTimestampUtc: '2026-09-23T14:32:26.781Z',
  usagePercent: 20.5,
  hasAvailableUsage: true,
  hasNonZeroIncludedLimit: true,
  grokPlanLabel: 'SuperGrok',
  ...overrides,
});

test('checksum：算法移植向量（6 字节大端千秒做混淆后 base64url 拼 machineId）', () => {
  // kiloSeconds=1 时初始字节是 [0,1,0,0,0,1]（JS 移位量按 mod-32 处理：1 >> 32 === 1，
  // 与 Grok Bot 客户端 TS 原版同款行为）。混淆链（lastByte 初始 165）：
  // i0 (0^165)+0=165 → i1 (1^165)+1=165 → i2 (0^165)+2=167 → i3 (0^167)+3=170
  // → i4 (0^170)+4=174 → i5 (1^174)+5=180 → [165,165,167,170,174,180] → base64url "paWnqq60"
  assert.equal(grokBotChecksum('MACHINE', 1_000_000), 'paWnqq60MACHINE');
  // 同一毫秒内结果确定；缺 machineId 时只输出混淆段
  assert.equal(grokBotChecksum('X', 1_000_000).slice(0, 8), 'paWnqq60');
  assert.equal(grokBotChecksum('', 1_000_000), 'paWnqq60');
});

test('os_crypt v10 解密：AES-256-GCM（nonce+tag）格式往返', () => {
  const key = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
  const nonce = Buffer.from('nonce1234567');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update('secret-token', 'utf8'), cipher.final()]);
  const payload = Buffer.concat([Buffer.from('v10'), nonce, body, cipher.getAuthTag()]).toString('base64');
  assert.equal(oscryptDecrypt(key, payload), 'secret-token');
  // 非 v10 前缀 / 损坏数据返回空串而不是抛错
  assert.equal(oscryptDecrypt(key, Buffer.from('v11xxxxxxxx').toString('base64')), '');
  assert.equal(oscryptDecrypt(key, ''), '');
});

test('身份指纹：Grok Bot 取 JWT sub + email，缺 sub 退到 refresh_token 指纹', () => {
  assert.deepEqual(cliIdentity('grokbot', grokBotSnapshot()), { fingerprint: 'google-oauth2|user_1', display: 'bot@example.com' });
  const fallback = cliIdentity('grokbot', grokBotSnapshot({ access_token: 'opaque', sub: undefined }));
  assert.match(fallback.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(fallback.display, `…${fallback.fingerprint.slice(-6)}`);
});

test('快照解析与 access 过期判断：JWT exp 驱动', () => {
  const snapshot = grokBotSnapshot();
  assert.equal(parseCliSnapshot('grokbot', { [SNAPSHOT_KEY]: JSON.stringify(snapshot) }).refresh_token, 'rt-grokbot');
  // 没有 access/refresh 任一令牌的快照不可用；损坏 JSON 同样回退
  assert.equal(parseCliSnapshot('grokbot', { [SNAPSHOT_KEY]: JSON.stringify({ machine_id: 'm' }) }), null);
  assert.equal(parseCliSnapshot('grokbot', { [SNAPSHOT_KEY]: '{broken json' }), null);
  const expired = grokBotSnapshot({ access_token: fakeJwt({ sub: 's', exp: Math.floor(Date.now() / 1000) - 10 }) });
  assert.ok(accessTokenExpiryMs('grokbot', expired) < Date.now());
});

test('用量查询：usagePercent → weekly 剩余百分比，请求带 checksum / Bearer 头', async () => {
  const calls = [];
  const fetcher = grokBotFetcher({ usagePayload: usagePayload(), calls });
  const { rows, meter } = recordMeter();
  const windows = await queryGrokBotUsage(fetcher, meter, 15_000, { variables: { [SNAPSHOT_KEY]: JSON.stringify(grokBotSnapshot()) } });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].key, 'weekly');
  assert.equal(windows[0].remaining, 79.5);
  assert.equal(windows[0].resetAt, '2026-09-23T14:32:26.781Z');
  const usageCall = calls.find((call) => !String(call.url).endsWith('/oauth/token'));
  assert.match(usageCall.url, /aiserver\.v1\.DashboardService\/GetSandUsageStatus$/);
  assert.equal(usageCall.init.headers.Authorization, `Bearer ${grokBotSnapshot().access_token}`);
  assert.ok(usageCall.init.headers['x-cursor-checksum'].endsWith('machine-1'));
  assert.equal(usageCall.init.headers['x-cursor-client-type'], 'sand');
});

test('用量查询：access 临期自动先续期再查询（refresh_token 不轮换）', async () => {
  const calls = [];
  const expired = grokBotSnapshot({ access_token: fakeJwt({ sub: 'google-oauth2|user_1', exp: Math.floor(Date.now() / 1000) + 10 }) });
  const fetcher = grokBotFetcher({
    tokenPayload: { access_token: fakeJwt({ sub: 'google-oauth2|user_1', exp: Math.floor(Date.now() / 1000) + 3600 }) },
    usagePayload: usagePayload(),
    calls,
  });
  const { meter } = recordMeter();
  const windows = await queryGrokBotUsage(fetcher, meter, 15_000, { variables: { [SNAPSHOT_KEY]: JSON.stringify(expired) } });
  assert.equal(windows[0].key, 'weekly');
  const tokenCall = calls.find((call) => String(call.url).endsWith('/oauth/token'));
  const body = JSON.parse(tokenCall.init.body);
  assert.deepEqual(
    { client_id: body.client_id, grant_type: body.grant_type, refresh_token: body.refresh_token },
    { client_id: 'KbZUR41cY7W6zRSdpSUJOCmB', grant_type: 'refresh_token', refresh_token: 'rt-grokbot' },
  );
  // 查询用的是续期后的新 access
  const usageCall = calls.find((call) => !String(call.url).endsWith('/oauth/token'));
  assert.notEqual(usageCall.init.headers.Authorization, `Bearer ${expired.access_token}`);
});

test('续期失败语义：invalid_grant 永久失效并要求重新导入，shouldLogout 同样永久', async () => {
  const expired = grokBotSnapshot({ access_token: fakeJwt({ sub: 's', exp: Math.floor(Date.now() / 1000) - 10 }) });
  await assert.rejects(
    refreshCliAuth('grokbot', expired, grokBotFetcher({})),
    (error) => /重新登录/.test(error.message) && error.permanent === true && error.authStatus === 'reauth_required',
  );
  await assert.rejects(
    refreshCliAuth('grokbot', expired, grokBotFetcher({ tokenPayload: { access_token: fakeJwt({ sub: 's', exp: 1 }), shouldLogout: true } })),
    (error) => error.permanent === true && error.authStatus === 'reauth_required',
  );
});

test('用量查询错误：401 映射为需重新导入，企业池化与缺 usagePercent 给出明确提示', async () => {
  const variables = { [SNAPSHOT_KEY]: JSON.stringify(grokBotSnapshot()) };
  await assert.rejects(
    queryGrokBotUsage(grokBotFetcher({ usageStatus: 401, usagePayload: {} }), recordMeter().meter, 15_000, { variables }),
    (error) => error.authStatus === 'reauth_required' && /重新登录该账号/.test(error.message),
  );
  await assert.rejects(
    queryGrokBotUsage(grokBotFetcher({ usagePayload: usagePayload({ usesPooledEnterpriseAllowance: true }) }), recordMeter().meter, 15_000, { variables }),
    /团队池化/,
  );
  await assert.rejects(
    queryGrokBotUsage(grokBotFetcher({ usagePayload: { nextResetTimestampUtc: '2026-09-23T14:32:26.781Z' } }), recordMeter().meter, 15_000, { variables }),
    /usagePercent/,
  );
});

test('live 文件只读：Grok Bot 续期结果不写回客户端存储', () => {
  assert.equal(writeLiveIfCurrent('grokbot', grokBotSnapshot(), grokBotSnapshot({ access_token: 'next' })), false);
});

test('内置配置：grokbot 走专属适配、周窗口', () => {
  const config = builtinConfigs.grokbot;
  assert.equal(config.adapterMode, 'grokbot');
  assert.equal(config.auth, 'none');
  assert.deepEqual(config.windows, ['weekly']);
  assert.deepEqual(config.wasteWindows, ['weekly']);
});
