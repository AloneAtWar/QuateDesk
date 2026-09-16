const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { queryAccount } = require('../electron/poller.cjs');
const { __copilot } = require('../electron/cli-quota.cjs');
const { builtinConfigs } = require('../electron/builtin-configs.cjs');
const cliAuth = require('../electron/cli-auth.cjs');

const { SNAPSHOT_KEY, cliIdentity, resolveCliAuth, refreshCliAuth, COPILOT_CLIENT_ID, __copilot: copilotAuthHelpers } = cliAuth;
const { parseCopilotQuota } = __copilot;
const { copilotEntryOf } = copilotAuthHelpers;

const copilotProvider = { id: 'copilot', name: 'GitHub Copilot', requestConfig: builtinConfigs.copilot };
const usagePayload = {
  copilot_plan: 'individual',
  quota_reset_date: '2026-10-01T00:00:00Z',
  quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 187, percent_remaining: 62.3, unlimited: false },
    chat: { entitlement: 0, remaining: 0, percent_remaining: 0 },
  },
};

test('内置渠道配置：copilot 走专属适配，月度窗口参与浪费统计', () => {
  assert.equal(builtinConfigs.copilot.adapterMode, 'copilot');
  assert.deepEqual(builtinConfigs.copilot.windows, ['monthly']);
  assert.deepEqual(builtinConfigs.copilot.wasteWindows, ['monthly']);
  assert.equal(builtinConfigs.copilot.credentialRequired, false);
});

test('Copilot 额度解析：percent_remaining 优先，绝对值与重置时间按层降级', () => {
  const quota = parseCopilotQuota(usagePayload);
  assert.equal(quota.remaining, 62.3);
  assert.equal(quota.amount, 187);
  assert.equal(quota.limitAmount, 300);
  assert.equal(quota.resetAt, '2026-10-01T00:00:00.000Z');
  // percent 缺失时用 remaining/entitlement 换算；重置时间缺失按 null 处理
  const computed = parseCopilotQuota({ quota_snapshots: { premium_interactions: { entitlement: 200, remaining: 50 } } });
  assert.equal(computed.remaining, 25);
  assert.equal(computed.amount, 50);
  assert.equal(computed.resetAt, null);
  // 个别网关回 camelCase；只有百分比时绝对值置 null
  const camel = parseCopilotQuota({ quotaSnapshots: { premiumInteractions: { percentRemaining: 75.5 } } });
  assert.equal(camel.remaining, 75.5);
  assert.equal(camel.amount, null);
  assert.equal(camel.limitAmount, null);
  // unlimited 池按 100% 处理
  const unlimited = parseCopilotQuota({ quota_snapshots: { premium_interactions: { unlimited: true } } });
  assert.equal(unlimited.remaining, 100);
  assert.equal(unlimited.amount, null);
  // premium_interactions 缺失时退回旧版计划的 chat / completions 池
  const chatPool = parseCopilotQuota({ quota_snapshots: { chat: { entitlement: 100, remaining: 90, percent_remaining: 90 } } });
  assert.equal(chatPool.remaining, 90);
  // 没有额度池、或池里一个数字都没有时显式报错
  assert.throws(() => parseCopilotQuota({}), /额度池/);
  assert.throws(() => parseCopilotQuota({ quota_snapshots: {} }), /额度池/);
  assert.throws(() => parseCopilotQuota({ quota_snapshots: { premium_interactions: { unlimited: false } } }), /剩余百分比/);
});

test('Copilot 账号用快照令牌直查 copilot_internal/user，带 VS Code 伪装头', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => usagePayload };
  };
  const snapshot = { oauth_token: 'ghu_snapshot_token', login: 'mona', userId: '12345' };
  const windows = await queryAccount({ id: 'c1' }, copilotProvider, '', fetcher, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.github.com/copilot_internal/user');
  const headers = seen[0].init.headers;
  // 额度端点要 GitHub OAuth 原始令牌（token 前缀，不是 Bearer），并按 VS Code 客户端伪装
  assert.equal(headers.Authorization, 'token ghu_snapshot_token');
  assert.match(headers['User-Agent'], /^GitHubCopilotChat\//);
  assert.equal(headers['Editor-Version'], 'vscode/1.96.2');
  assert.match(headers['Editor-Plugin-Version'], /^copilot-chat\//);
  assert.equal(headers['X-GitHub-Api-Version'], '2025-04-01');
  assert.deepEqual(windows.map((item) => item.key), ['monthly']);
  assert.equal(windows[0].remaining, 62.3);
  assert.equal(windows[0].amount, 187);
  assert.equal(windows[0].limitAmount, 300);
});

test('Copilot 令牌被拒绝时报重新授权，缺登录时引导设备码登录', async () => {
  const previousHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-auth-'));
  try {
    os.homedir = () => tempHome;
    const snapshot = { oauth_token: 'ghu_revoked', userId: '1' };
    await assert.rejects(
      () => queryAccount({ id: 'c1' }, copilotProvider, '', async () => ({ ok: false, status: 401 }), { [SNAPSHOT_KEY]: JSON.stringify(snapshot) }),
      (error) => error.authStatus === 'reauth_required' && /重新进行 Copilot 设备码登录/.test(error.message),
    );
    await assert.rejects(
      () => queryAccount({ id: 'c1' }, copilotProvider, '', async () => ({ ok: true, status: 200, json: async () => usagePayload }), {}),
      (error) => error.authStatus === 'reauth_required' && /设备码授权/.test(error.message),
    );
  } finally {
    os.homedir = previousHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('Copilot 身份指纹：userId 优先（重新授权换 token 不换指纹），hosts.json 形态可读', () => {
  assert.deepEqual(cliIdentity('copilot', { oauth_token: 'ghu_a', login: 'mona', userId: '99' }), { fingerprint: '99', display: 'mona' });
  // hosts.json 的 host → entry map：user 字段作展示，token 指纹兜底
  const hostsEntry = cliIdentity('copilot', { 'github.com': { oauth_token: 'ghu_b', user: 'octocat' } });
  assert.equal(hostsEntry.display, 'octocat');
  assert.equal(hostsEntry.fingerprint, cliIdentity('copilot', { oauth_token: 'ghu_b' }).fingerprint);
  assert.equal(copilotEntryOf(null), null);
  assert.equal(copilotEntryOf({ 'gist.github.com': { oauth_token: '' } }), null);
});

test('Copilot 凭据解析：快照优先，本机 hosts.json 兜底，续期直接要求重新授权', async () => {
  const previousHomedir = os.homedir;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-live-'));
  try {
    os.homedir = () => tempHome;
    const hostsPath = path.join(tempHome, '.config', 'github-copilot', 'hosts.json');
    fs.mkdirSync(path.dirname(hostsPath), { recursive: true });
    fs.writeFileSync(hostsPath, JSON.stringify({ 'github.com': { oauth_token: 'ghu_live', user: 'octo-live' } }));
    const live = resolveCliAuth('copilot', {});
    assert.equal(live.source, 'live');
    assert.equal(live.auth.oauth_token, 'ghu_live');
    // 有快照时永远用快照，不读 hosts.json
    const snapshotted = resolveCliAuth('copilot', { [SNAPSHOT_KEY]: JSON.stringify({ oauth_token: 'ghu_snap', userId: '7' }) });
    assert.equal(snapshotted.source, 'snapshot');
    assert.equal(snapshotted.auth.oauth_token, 'ghu_snap');
    // ghu_ 无 refresh_token：任何续期尝试都明确失败，由 UI 引导重新设备码登录
    await assert.rejects(
      () => refreshCliAuth('copilot', { oauth_token: 'ghu_a' }, async () => ({ ok: true, status: 200, json: async () => ({}) })),
      (error) => error.permanent === true && error.authStatus === 'reauth_required',
    );
  } finally {
    os.homedir = previousHomedir;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('设备码授权常量与公开实现一致（VS Code Copilot GitHub App）', () => {
  assert.equal(COPILOT_CLIENT_ID, 'Iv1.b507a08c87ecfe98');
});
