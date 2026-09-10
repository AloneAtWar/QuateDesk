// CLI 凭据类厂商的专属额度适配：优先复用账号自己的登录快照（支持多账号、不受 cc-switch
// 切换影响），没有快照时回落本机 CLI 登录态。实现参考 cc-switch 的 subscription.rs：
// - Claude: .credentials.json / 快照 → api.anthropic.com/api/oauth/usage（5小时/7天窗口）
// - Codex:  ~/.codex/auth.json (ChatGPT OAuth tokens) → chatgpt.com/backend-api/wham/usage
// - Gemini: ~/.gemini/oauth_creds.json → cloudcode-pa.googleapis.com 两步查询（按模型分桶）
// token 过期时用账号快照里的 refresh_token 自动续期（见 cli-auth.cjs），无需 CLI 在场。
const { resolveCliAuth, refreshTokenOf, accessTokenExpiryMs, fetchWithCliAuth } = require('./cli-auth.cjs');

const DEFAULT_TIMEOUT_MS = 15_000;

// Claude 凭据形态（live 文件或快照同构）：{ claudeOauth: { accessToken, refreshToken, expiresAt } }；
// 防御式：找第一个带 accessToken 的对象
const claudeTokenOf = (auth) => {
  if (!auth || typeof auth !== 'object') return null;
  for (const value of [auth.claudeOauth, ...Object.values(auth)]) {
    if (value && typeof value === 'object') {
      const token = value.accessToken || value.access_token;
      if (token) return { token, expiresAt: value.expiresAt || value.expires_at || null };
    }
  }
  return null;
};

const CLAUDE_WINDOW_KEYS = { five_hour: 'five_hour', seven_day: 'weekly', seven_day_opus: 'weekly', seven_day_sonnet: 'weekly' };

async function queryClaudeQuota(fetcher, meter, timeoutMs = DEFAULT_TIMEOUT_MS, ctx = {}) {
  const resolved = resolveCliAuth('claude', ctx.variables);
  const credential = resolved && claudeTokenOf(resolved.auth);
  if (!credential) throw new Error('未检测到 Claude CLI 登录信息。请先安装 Claude Code 并登录，或在「设置 → 账号与凭据」导入本机登录保存为独立账号快照');
  // 令牌过期且没有 refresh_token 时提前给出可行动提示（能续期的交给 fetchWithCliAuth）
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() < Date.now() && !refreshTokenOf('claude', resolved.auth)) {
    throw new Error('Claude 访问令牌已过期且无法自动续期，请运行一次 Claude CLI 或重新登录');
  }
  const response = await fetchWithCliAuth('claude', {
    auth: resolved.auth,
    source: resolved.source,
    fetcher,
    timeoutMs,
    buildRequest: (auth) => ({ url: 'https://api.anthropic.com/api/oauth/usage', init: { headers: { Authorization: `Bearer ${claudeTokenOf(auth)?.token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' } } }),
    onAuthUpdate: ctx.onAuthUpdate,
  });
  if (response.status === 401 || response.status === 403) throw new Error('Claude 凭据被拒绝（自动续期后仍无效），请重新登录该账号并更新快照');
  if (!response.ok) throw new Error(`Claude 用量接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  const windows = [];
  const seen = new Set();
  for (const [name, value] of Object.entries(payload || {})) {
    const key = CLAUDE_WINDOW_KEYS[name];
    if (!key || !value || typeof value !== 'object' || !Number.isFinite(Number(value.utilization)) || seen.has(key)) continue;
    seen.add(key);
    windows.push(meter(key, Math.max(0, 100 - Number(value.utilization)), 100, '%', value.resets_at || null));
  }
  if (!windows.length) throw new Error('Claude 用量响应中没有可识别的额度窗口');
  return windows;
}

// Codex 凭据形态：{ tokens: { access_token, refresh_token, account_id, id_token }, OPENAI_API_KEY }；订阅额度只走 ChatGPT OAuth
async function queryCodexQuota(fetcher, meter, timeoutMs = DEFAULT_TIMEOUT_MS, ctx = {}) {
  const resolved = resolveCliAuth('codex', ctx.variables);
  if (!resolved) throw new Error('未检测到 Codex 的 ChatGPT 登录（~/.codex/auth.json 无 OAuth tokens），API Key / 中转模式没有订阅额度。可把官方登录「导入本机 CLI 登录」保存为独立账号快照');
  const response = await fetchWithCliAuth('codex', {
    auth: resolved.auth,
    source: resolved.source,
    fetcher,
    timeoutMs,
    buildRequest: (auth) => {
      const headers = { Authorization: `Bearer ${auth.tokens?.access_token}`, 'User-Agent': 'codex-cli', Accept: 'application/json' };
      if (auth.tokens?.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
      return { url: 'https://chatgpt.com/backend-api/wham/usage', init: { headers } };
    },
    onAuthUpdate: ctx.onAuthUpdate,
  });
  if (response.status === 401 || response.status === 403) throw new Error('Codex 凭据被拒绝（自动续期后仍无效），请重新登录该账号并更新快照');
  if (!response.ok) throw new Error(`Codex 用量接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  const secondsToKey = { 18000: 'five_hour', 604800: 'weekly', 2592000: 'monthly' };
  const windows = [];
  for (const window of [payload?.rate_limit?.primary_window, payload?.rate_limit?.secondary_window]) {
    if (!window || !Number.isFinite(Number(window.used_percent))) continue;
    const key = secondsToKey[Number(window.limit_window_seconds)] || 'monthly';
    if (windows.some((item) => item.key === key)) continue;
    const resetAt = window.reset_at ? new Date(Number(window.reset_at) * 1000).toISOString() : null;
    windows.push(meter(key, Math.max(0, 100 - Number(window.used_percent)), 100, '%', resetAt));
  }
  if (!windows.length) throw new Error('Codex 用量响应中没有可识别的额度窗口');
  return windows;
}

// Gemini 凭据形态（live 文件或快照同构）：{ access_token, refresh_token, expiry_date(毫秒), id_token }
async function queryGeminiQuota(fetcher, meter, timeoutMs = DEFAULT_TIMEOUT_MS, ctx = {}) {
  const resolved = resolveCliAuth('gemini', ctx.variables);
  if (!resolved) throw new Error('未检测到 Gemini CLI 登录信息。请先安装 Gemini CLI 并登录，或在「设置 → 账号与凭据」导入本机登录保存为独立账号快照');
  const expiry = accessTokenExpiryMs('gemini', resolved.auth);
  if (expiry && expiry < Date.now() && !refreshTokenOf('gemini', resolved.auth)) {
    throw new Error('Gemini 访问令牌已过期且无法自动续期，请运行一次 Gemini CLI 或重新登录');
  }
  // 两步查询共用同一份会随续期更新的凭据；只有第一步带 401 续期重试，避免一次轮询刷新两次
  let effective = resolved.auth;
  const trackAuth = async (...args) => {
    effective = args[1];
    if (ctx.onAuthUpdate) await ctx.onAuthUpdate(...args);
  };
  const authHeaders = (auth) => ({ Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' });
  const loadResponse = await fetchWithCliAuth('gemini', {
    auth: resolved.auth,
    source: resolved.source,
    fetcher,
    timeoutMs,
    buildRequest: (auth) => ({
      url: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      init: { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }) },
    }),
    onAuthUpdate: trackAuth,
  });
  if (loadResponse.status === 401 || loadResponse.status === 403) throw new Error('Gemini 凭据被拒绝（自动续期后仍无效），请重新登录该账号并更新快照');
  if (!loadResponse.ok) throw new Error(`Gemini loadCodeAssist 返回 HTTP ${loadResponse.status}`);
  const loadPayload = await loadResponse.json();
  const project = loadPayload?.cloudaicompanionProject;
  const projectId = typeof project === 'string' ? project : (project?.id || project?.projectId || null);
  const quotaResponse = await fetcher('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
    method: 'POST',
    headers: authHeaders(effective),
    body: JSON.stringify(projectId ? { project: projectId } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!quotaResponse.ok) throw new Error(`Gemini retrieveUserQuota 返回 HTTP ${quotaResponse.status}`);
  const quotaPayload = await quotaResponse.json();
  // buckets 按模型分桶：remainingFraction 0-1 → 剩余百分比
  const windows = [];
  for (const bucket of quotaPayload?.buckets || []) {
    const modelId = String(bucket.modelId || '');
    if (!modelId) continue;
    const key = modelId.includes('flash-lite') ? 'gemini_flash_lite' : modelId.includes('flash') ? 'gemini_flash' : modelId.includes('pro') ? 'gemini_pro' : null;
    if (!key || windows.some((item) => item.key === key)) continue;
    const remaining = Number(bucket.remainingFraction);
    if (!Number.isFinite(remaining)) continue;
    windows.push(meter(key, Math.max(0, Math.min(100, remaining * 100)), 100, '%', bucket.resetTime || null));
  }
  if (!windows.length) throw new Error('Gemini 配额响应中没有可识别的额度桶');
  return windows;
}

module.exports = { queryClaudeQuota, queryCodexQuota, queryGeminiQuota };
