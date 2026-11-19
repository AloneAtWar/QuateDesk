const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { queryAccount } = require('../electron/poller.cjs');
const { __antigravity } = require('../electron/cli-quota.cjs');
const { builtinConfigs } = require('../electron/builtin-configs.cjs');
const cliAuth = require('../electron/cli-auth.cjs');

const { SNAPSHOT_KEY, cliIdentity, refreshCliAuth, __antigravity: agyAuthHelpers, __constants } = cliAuth;
const { buildAntigravityWindows, AGY_HOST_PROD, AGY_HOST_DAILY } = __antigravity;
const { antigravityAuthFromBlob } = agyAuthHelpers;

const antigravityProvider = { id: 'antigravity', name: 'Antigravity', requestConfig: builtinConfigs.antigravity };
const meter = (key, remaining, total = 100, unit = '%', resetAt = null, extra = {}) => ({ key, remaining, used: total - remaining, total, unit, resetAt, available: extra.available ?? true, ...extra });

// 形态对齐 2026-11 实测响应：fetchAvailableModels 的 quotaInfo 是逐模型 5h 读数
//（同池相同），retrieveUserQuotaSummary 是分组池（5h + weekly 双桶）
const modelsPayload = {
  models: {
    'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 0.55835575, resetTime: '2026-11-19T07:39:27Z' } },
    'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', quotaInfo: { remainingFraction: 0.55835575, resetTime: '2026-11-19T07:39:27Z' } },
    'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-19T11:51:37Z' } },
    'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-19T11:51:37Z' } },
    // 内部补全模型（chat_/tab_ 前缀）不进池成员
    tab_jump_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
  },
};
const summaryPayload = {
  groups: [
    {
      displayName: 'Claude and GPT models',
      description: 'Models within this group: Claude Opus 5.5, GPT-OSS 120B',
      buckets: [
        { bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-11-26T06:51:39Z', remainingFraction: 1, displayName: 'Weekly Limit Remaining' },
        { bucketId: '3p-5h', window: '5h', resetTime: '2026-11-19T11:51:39Z', remainingFraction: 1, displayName: 'Five Hour Limit Remaining' },
      ],
    },
  ],
};

test('内置渠道配置：antigravity 走专属适配，池窗口不参与浪费统计', () => {
  assert.equal(builtinConfigs.antigravity.adapterMode, 'antigravity');
  assert.deepEqual(builtinConfigs.antigravity.windows, ['agy_gemini_5h', 'agy_gemini_7d', 'agy_claudegpt_5h', 'agy_claudegpt_7d']);
  assert.deepEqual(builtinConfigs.antigravity.wasteWindows, []);
  assert.equal(builtinConfigs.antigravity.credentialRequired, false);
});

test('池化解析：summary 组出 5h+7d 双桶，free-tier 缺的 Gemini 组从逐模型读数推导', () => {
  const windows = buildAntigravityWindows(modelsPayload, summaryPayload, meter);
  assert.deepEqual(windows.map((item) => item.key), ['agy_claudegpt_5h', 'agy_claudegpt_7d', 'agy_gemini_5h']);
  // remainingFraction 0-1 → 剩余百分比；resetTime 原样透传
  const claude5h = windows.find((item) => item.key === 'agy_claudegpt_5h');
  assert.equal(claude5h.remaining, 100);
  assert.equal(claude5h.resetAt, '2026-11-19T11:51:39Z');
  const gemini5h = windows.find((item) => item.key === 'agy_gemini_5h');
  assert.ok(Math.abs(gemini5h.remaining - 55.835575) < 0.001);
  assert.equal(gemini5h.resetAt, '2026-11-19T07:39:27Z');
  // 成员模型名单挂在 meter.models（同读数的模型聚成一簇），内部模型不进名单
  assert.deepEqual(gemini5h.models, ['Gemini 3 Flash', 'Gemini 2.5 Pro']);
  assert.deepEqual(claude5h.models, ['Claude Opus 5.5 (High)', 'GPT-OSS 120B (Medium)']);
});

// 本地守护进程（桌面版运行时）的付费档全量视图：与 2026-11 实测的 daemon 响应同构
const daemonSummary = {
  groups: [
    { displayName: 'Gemini Models', description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen', buckets: [
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.6718359, resetTime: '2026-11-25T17:26:56Z' },
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.43152887, resetTime: '2026-11-19T12:39:27Z' },
    ] },
    { displayName: 'Claude and GPT models', description: 'Models within this group: Claude Opus 5.5, GPT-OSS 120B', buckets: [
      { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-26T10:18:46Z' },
      { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-19T15:18:46Z' },
    ] },
    { displayName: 'Gemini 4 Argon', description: 'For paid Pro plans, Argon quota is separate.', buckets: [
      { bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 0.6503605, resetTime: '2026-11-25T16:11:16Z' },
    ] },
  ],
};
const daemonModels = {
  models: {
    'gemini-4-neon-low': { displayName: 'Gemini 4 Neon (Low)', quotaInfo: { remainingFraction: 0.43152887, resetTime: '2026-11-19T12:39:27Z' } },
    'gemini-4-argon-low': { displayName: 'Gemini 4 Argon (Low)', quotaInfo: { remainingFraction: 0.6503605, resetTime: '2026-11-25T16:11:16Z' } },
    'claude-opus-5-5-low': { displayName: 'Claude Opus 5.5 (Low)', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-19T15:18:46Z' } },
  },
};

test('本地守护进程：付费档全量 5 窗口（含 Gemini 周池与 Argon 独立周池），Argon 成员不混入 Gemini 池', async () => {
  const previousHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-daemon-'));
  try {
    os.homedir = () => tempHome;
    const daemonDir = path.join(tempHome, '.gemini', 'antigravity', 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'hub_2726.json'), JSON.stringify({ pid: 1, httpPort: 2726, httpsPort: 2725, csrfToken: 'csrf-test' }));
    const seen = [];
    const fetcher = async (url, init = {}) => {
      seen.push({ url, init });
      if (url.startsWith('http://127.0.0.1:2726/')) {
        if (!url.includes('x-codeium')) assert.equal(init.headers['x-codeium-csrf-token'], 'csrf-test');
        assert.equal(init.headers['connect-protocol-version'], '1');
        if (url.endsWith('RetrieveUserQuotaSummary')) return { ok: true, status: 200, json: async () => ({ response: daemonSummary }) };
        if (url.endsWith('GetAvailableModels')) return { ok: true, status: 200, json: async () => ({ response: daemonModels }) };
      }
      throw new Error(`不应有其它请求：${url}`);
    };
    const snapshot = { access_token: 'ya.test', refresh_token: '1//test' };
    const windows = await queryAccount({ id: 'a1' }, antigravityProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });

    // 全部走本地 daemon，没有 cloudcode 请求
    assert.equal(seen.length, 2);
    assert.ok(seen.every((item) => item.url.startsWith('http://127.0.0.1:2726/')));
    // 5 个窗口：Gemini 5h+7d、Claude/GPT 5h+7d、Argon 独立周池
    assert.deepEqual(windows.map((item) => item.key), ['agy_gemini_5h', 'agy_gemini_7d', 'agy_claudegpt_5h', 'agy_claudegpt_7d', 'agy_pool_gemini-4-argon_7d']);
    // 读数与重置时间对齐 daemon 响应
    const gemini5h = windows.find((item) => item.key === 'agy_gemini_5h');
    assert.ok(Math.abs(gemini5h.remaining - 43.152887) < 0.001);
    assert.equal(gemini5h.resetAt, '2026-11-19T12:39:27Z');
    // Argon 独立周池：动态 key + label 随 meter 下发，成员是 Argon 模型
    const argon = windows.find((item) => item.key === 'agy_pool_gemini-4-argon_7d');
    assert.ok(Math.abs(argon.remaining - 65.03605) < 0.001);
    assert.equal(argon.label, 'Gemini 4 Argon · 7 天');
    assert.deepEqual(argon.models, ['Gemini 4 Argon (Low)']);
    // Argon 模型不进 Gemini 家族池成员
    assert.deepEqual(gemini5h.models, ['Gemini 4 Neon (Low)']);
  } finally {
    os.homedir = previousHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('本地守护进程不可用时回落 cloudcode 直查', async () => {
  const previousHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-daemon-dead-'));
  try {
    os.homedir = () => tempHome;
    // daemon 端口拒绝连接（模拟桌面版未运行 / 端口失效）
    const daemonDir = path.join(tempHome, '.gemini', 'antigravity', 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'hub_9.json'), JSON.stringify({ httpPort: 9, csrfToken: 'x' }));
    fs.mkdirSync(path.join(tempHome, '.gemini', 'antigravity-cli', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt'), 'default-cli-project\n');
    const fetcher = async (url, init = {}) => {
      if (url.startsWith('http://127.0.0.1:9/')) throw new Error('fetch failed');
      if (url.includes('loadCodeAssist')) return { ok: true, status: 200, json: async () => ({ cloudaicompanionProject: 'aicode-consumers' }) };
      if (url.includes('fetchAvailableModels')) return { ok: true, status: 200, json: async () => modelsPayload };
      if (url.includes('retrieveUserQuotaSummary')) return { ok: true, status: 200, json: async () => summaryPayload };
      throw new Error(`意外的请求：${url}`);
    };
    const snapshot = { access_token: 'ya.test', refresh_token: '1//test' };
    const windows = await queryAccount({ id: 'a1' }, antigravityProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });
    assert.deepEqual(windows.map((item) => item.key), ['agy_claudegpt_5h', 'agy_claudegpt_7d', 'agy_gemini_5h']);
  } finally {
    os.homedir = previousHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('池化解析：耗尽的桶 remainingFraction 缺省按 0、disabled 桶跳过、未知组走动态 key', () => {
  const exhausted = buildAntigravityWindows({}, {
    groups: [{ displayName: 'Gemini Models', buckets: [
      { window: '5h', remainingFraction: undefined, resetTime: '2026-11-19T07:39:27Z' },
      { window: 'weekly', remainingFraction: 0.4, resetTime: '2026-11-26T06:51:39Z' },
      { window: '5h', disabled: true, remainingFraction: 0.9 },
    ] }],
  }, meter);
  assert.equal(exhausted.find((item) => item.key === 'agy_gemini_5h').remaining, 0);
  assert.equal(exhausted.find((item) => item.key === 'agy_gemini_7d').remaining, 40);
  assert.equal(exhausted.length, 2);

  // 单模型特例组（如 Gemini 4 Argon，独立周桶）：动态 key + label 随 meter 下发
  const versioned = buildAntigravityWindows({}, {
    groups: [{ displayName: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingFraction: 0.25, resetTime: '2026-11-26T06:51:39Z' }] }],
  }, meter);
  assert.equal(versioned.length, 1);
  assert.equal(versioned[0].key, 'agy_pool_gemini-4-argon_7d');
  assert.equal(versioned[0].label, 'Gemini 4 Argon · 7 天');

  // summary 整体失败：两池都从逐模型读数聚类推导
  const derived = buildAntigravityWindows(modelsPayload, null, meter);
  assert.deepEqual(derived.map((item) => item.key), ['agy_gemini_5h', 'agy_claudegpt_5h']);
  // 没有任何可用读数时显式报错
  assert.throws(() => buildAntigravityWindows({}, {}, meter), /额度池/);
});

test('账号查询：额度视图挂 CLI 默认项目（default-cli-project），不用 loadCodeAssist 的项目', async () => {
  const previousHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-project-'));
  try {
    os.homedir = () => tempHome;
    fs.mkdirSync(path.join(tempHome, '.gemini', 'antigravity-cli', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt'), 'default-cli-project\n');
    const seen = [];
    const fetcher = async (url, init = {}) => {
      seen.push({ url, init });
      if (url.includes('loadCodeAssist')) {
        return { ok: true, status: 200, json: async () => ({ cloudaicompanionProject: 'aicode-consumers', currentTier: { id: 'free-tier', name: 'Antigravity' }, paidTier: { id: 'g1-pro-tier' } }) };
      }
      if (url.includes('fetchAvailableModels')) {
        // loadCodeAssist 的项目只回空读数；默认项目回真实读数（94.5%）
        const body = JSON.parse(init.body || '{}');
        if (body.project === 'default-cli-project') {
          return { ok: true, status: 200, json: async () => modelsPayload };
        }
        return { ok: true, status: 200, json: async () => ({ models: { 'gemini-3-flash': { displayName: 'Gemini 3 Flash', quotaInfo: { remainingFraction: 1, resetTime: '2026-11-19T12:39:27Z' } } } }) };
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return { ok: true, status: 200, json: async () => summaryPayload };
      }
      throw new Error(`意外的请求：${url}`);
    };
    const snapshot = { access_token: 'ya.test', refresh_token: '1//test', email: 'alone@example.com' };
    const windows = await queryAccount({ id: 'a1' }, antigravityProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });

    // loadCodeAssist 走生产 host，额度两步走 daily host 且都挂默认项目
    assert.equal(seen.length, 3);
    assert.equal(seen[0].url, `${AGY_HOST_PROD}/v1internal:loadCodeAssist`);
    assert.equal(JSON.parse(seen[0].init.body).metadata.ideType, 'ANTIGRAVITY');
    assert.equal(seen[1].url, `${AGY_HOST_DAILY}/v1internal:fetchAvailableModels`);
    assert.equal(JSON.parse(seen[1].init.body).project, 'default-cli-project');
    // 不发 entitlement：对导入的 consumer 凭据一律 INVALID_ARGUMENT
    assert.equal(JSON.parse(seen[1].init.body).entitlement, undefined);
    assert.equal(seen[2].url, `${AGY_HOST_DAILY}/v1internal:retrieveUserQuotaSummary`);
    assert.equal(JSON.parse(seen[2].init.body).project, 'default-cli-project');
    // UA 按 Antigravity 客户端伪装
    assert.match(seen[1].init.headers['User-Agent'], /^antigravity\/hub\//);
    // 读数来自默认项目的真实响应（Gemini 55.8%，而非 aicode-consumers 的 100%）
    assert.deepEqual(windows.map((item) => item.key), ['agy_claudegpt_5h', 'agy_claudegpt_7d', 'agy_gemini_5h']);
    assert.ok(Math.abs(windows.find((item) => item.key === 'agy_gemini_5h').remaining - 55.835575) < 0.001);
  } finally {
    os.homedir = previousHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('账号查询：默认项目文件缺失用常量兜底，被 4xx 拒绝时回落 loadCodeAssist 项目', async () => {
  const previousHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fallback-'));
  try {
    os.homedir = () => tempHome; // 无 default_project_id.txt → 常量 default-cli-project
    const seen = [];
    const fetcher = async (url, init = {}) => {
      seen.push({ url, body: JSON.parse(init.body || '{}') });
      if (url.includes('loadCodeAssist')) return { ok: true, status: 200, json: async () => ({ cloudaicompanionProject: 'fallback-project' }) };
      if (url.includes('fetchAvailableModels')) {
        // 默认项目被拒（如项目形态变更），回落 loadCodeAssist 项目成功
        if (JSON.parse(init.body || '{}').project === 'default-cli-project') return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => modelsPayload };
      }
      if (url.includes('retrieveUserQuotaSummary')) return { ok: true, status: 200, json: async () => summaryPayload };
      throw new Error(`意外的请求：${url}`);
    };
    const snapshot = { access_token: 'ya.test', refresh_token: '1//test' };
    const windows = await queryAccount({ id: 'a1' }, antigravityProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });
    const famCalls = seen.filter((item) => item.url.includes('fetchAvailableModels'));
    assert.equal(famCalls.length, 2);
    assert.equal(famCalls[0].body.project, 'default-cli-project');
    assert.equal(famCalls[1].body.project, 'fallback-project');
    // summary 跟随最终成功的项目
    assert.equal(seen[seen.length - 1].body.project, 'fallback-project');
    assert.equal(windows.length, 3);
  } finally {
    os.homedir = previousHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('账号查询：summary 失败可容忍（逐模型读数兜底），401 报重新授权', async () => {
  const snapshot = { access_token: 'ya.test', refresh_token: '1//test' };
  const fetcher = async (url, init = {}) => {
    if (url.includes('loadCodeAssist')) return { ok: true, status: 200, json: async () => ({ cloudaicompanionProject: 'p1' }) };
    if (url.includes('retrieveUserQuotaSummary')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => modelsPayload };
  };
  const windows = await queryAccount({ id: 'a1' }, antigravityProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });
  assert.deepEqual(windows.map((item) => item.key), ['agy_gemini_5h', 'agy_claudegpt_5h']);

  // 无 refresh_token 的快照：401 不会触发续期，直接判凭据被拒
  await assert.rejects(
    () => queryAccount({ id: 'a1' }, antigravityProvider, '', async () => ({ ok: false, status: 401, json: async () => ({}) }), { [SNAPSHOT_KEY]: JSON.stringify({ access_token: 'ya.expired' }) }),
    (error) => error.authStatus === 'reauth_required' && /Antigravity 凭据被拒绝/.test(error.message),
  );
});

test('凭据 blob 归一化：token + id_token_email → 扁平形态，空 token 视为未登录', () => {
  assert.deepEqual(
    antigravityAuthFromBlob({ token: { access_token: 'ya.a', refresh_token: '1//r', token_type: 'Bearer' }, auth_method: 'consumer', id_token_email: 'Alone@Example.com' }),
    { access_token: 'ya.a', refresh_token: '1//r', email: 'alone@example.com' },
  );
  assert.equal(antigravityAuthFromBlob({ token: {} }), null);
  assert.equal(antigravityAuthFromBlob(null), null);
});

test('身份指纹：凭据 blob 的 Google 账号邮箱即稳定身份', () => {
  assert.deepEqual(cliIdentity('antigravity', { email: 'Alone@Example.com', refresh_token: '1//r' }), { fingerprint: 'alone@example.com', display: 'alone@example.com' });
  // 没有邮箱时退到 refresh_token 指纹（Google 的 refresh_token 不轮换，指纹稳定）
  const fallback = cliIdentity('antigravity', { refresh_token: '1//r' });
  assert.match(fallback.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(fallback.display, `…${fallback.fingerprint.slice(-6)}`);
});

test('续期：走 Antigravity 专属 OAuth client，invalid_grant 判永久失效', async () => {
  const success = await refreshCliAuth('antigravity', { access_token: 'ya.old', refresh_token: '1//r', email: 'a@b.c' }, async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('client_id'), __constants.ANTIGRAVITY_CLIENT_ID);
    assert.equal(body.get('client_secret'), __constants.ANTIGRAVITY_CLIENT_SECRET);
    assert.equal(body.get('grant_type'), 'refresh_token');
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya.new', expires_in: 3599, scope: 'https://www.googleapis.com/auth/cloud-platform' }) };
  });
  assert.equal(success.access_token, 'ya.new');
  assert.equal(success.email, 'a@b.c');
  assert.ok(success.expiry_date > Date.now());

  await assert.rejects(
    () => refreshCliAuth('antigravity', { refresh_token: '1//revoked' }, async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) })),
    (error) => error.permanent === true && error.authStatus === 'reauth_required' && /Antigravity 登录续期被拒绝/.test(error.message),
  );
});

test('刷新队列：Antigravity 池窗口按后缀归入 5 小时 / 7 天队列', async () => {
  const { buildRefreshQueues } = await import('../src/upcoming-refresh.js');
  const account = {
    id: 'a1',
    windows: [
      { key: 'agy_gemini_5h', remaining: 55, resetAt: new Date(Date.now() + 3600e3).toISOString() },
      { key: 'agy_claudegpt_7d', remaining: 90, resetAt: new Date(Date.now() + 86400e3).toISOString() },
      { key: 'agy_pool_gemini-4-argon_7d', remaining: 25, resetAt: new Date(Date.now() + 2 * 86400e3).toISOString() },
      // Gemini CLI 的模型池不进队列（现状保持）
      { key: 'gemini_pro', remaining: 80, resetAt: new Date(Date.now() + 5 * 3600e3).toISOString() },
    ],
  };
  const queues = buildRefreshQueues([account]);
  assert.equal(queues.find((queue) => queue.key === 'five_hour').items.length, 1);
  assert.equal(queues.find((queue) => queue.key === 'weekly').items.length, 2);
});
