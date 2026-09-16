// CLI 凭据类厂商的专属额度适配：优先复用账号自己的登录快照（支持多账号、不受 cc-switch
// 切换影响），没有快照时回落本机 CLI 登录态。实现参考 cc-switch 的 subscription.rs：
// - Claude: .credentials.json / 快照 → api.anthropic.com/api/oauth/usage（5小时/7天窗口）
// - Codex:  ~/.codex/auth.json (ChatGPT OAuth tokens) → chatgpt.com/backend-api/wham/usage
// - Gemini: ~/.gemini/oauth_creds.json → cloudcode-pa.googleapis.com 两步查询（按模型分桶）
// - Kimi:   扫码登录的网页会话快照 → www.kimi.com GetSubscriptionStats（5小时/7天/月度，含月额度）
// token 过期时用账号快照里的 refresh_token 自动续期（见 cli-auth.cjs），无需 CLI 在场。
const { resolveCliAuth, refreshTokenOf, accessTokenExpiryMs, fetchWithCliAuth } = require('./cli-auth.cjs');

const DEFAULT_TIMEOUT_MS = 15_000;
const reauthRequiredError = (message) => Object.assign(new Error(message), { authStatus: 'reauth_required' });

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
  if (!credential) throw reauthRequiredError('未检测到 Claude CLI 登录信息。请先安装 Claude Code 并登录，或在「设置 → 账号与凭据」导入本机登录保存为独立账号快照');
  // 令牌过期且没有 refresh_token 时提前给出可行动提示（能续期的交给 fetchWithCliAuth）
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() < Date.now() && !refreshTokenOf('claude', resolved.auth)) {
    throw reauthRequiredError('Claude 访问令牌已过期且无法自动续期，请运行一次 Claude CLI 或重新登录');
  }
  const response = await fetchWithCliAuth('claude', {
    auth: resolved.auth,
    source: resolved.source,
    fetcher,
    timeoutMs,
    buildRequest: (auth) => ({ url: 'https://api.anthropic.com/api/oauth/usage', init: { headers: { Authorization: `Bearer ${claudeTokenOf(auth)?.token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' } } }),
    onAuthUpdate: ctx.onAuthUpdate,
  });
  if (response.status === 401 || response.status === 403) throw reauthRequiredError('Claude 凭据被拒绝（自动续期后仍无效），请重新登录该账号并更新快照');
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
  if (!resolved) throw reauthRequiredError('未检测到 Codex 的 ChatGPT 登录（~/.codex/auth.json 无 OAuth tokens），API Key / 中转模式没有订阅额度。可把官方登录「导入本机 CLI 登录」保存为独立账号快照');
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
  if (response.status === 401 || response.status === 403) throw reauthRequiredError('Codex 凭据被拒绝（自动续期后仍无效），请重新登录该账号并更新快照');
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
  if (!resolved) throw reauthRequiredError('未检测到 Gemini CLI 登录信息。请先安装 Gemini CLI 并登录，或在「设置 → 账号与凭据」导入本机登录保存为独立账号快照');
  const expiry = accessTokenExpiryMs('gemini', resolved.auth);
  if (expiry && expiry < Date.now() && !refreshTokenOf('gemini', resolved.auth)) {
    throw reauthRequiredError('Gemini 访问令牌已过期且无法自动续期，请运行一次 Gemini CLI 或重新登录');
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
  if (loadResponse.status === 401 || loadResponse.status === 403) throw reauthRequiredError('Gemini 凭据被拒绝（自动续期后仍无效），请重新登录该账号并更新快照');
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
  if (quotaResponse.status === 401 || quotaResponse.status === 403) throw reauthRequiredError('Gemini 凭据被拒绝（retrieveUserQuota 鉴权失败），请重新登录该账号并更新快照');
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

// Kimi 凭据形态（扫码登录快照）：{ accessToken, refreshToken, userId, authHost }，没有本机 live 文件。
// 月额度只在网页会员服务里（coding 域的 /coding/v1/usages 对订阅用户 totalQuota 恒为空），
// GetSubscriptionStats 一个接口同时返回 5 小时 / 7 天 / 月订阅三个窗口（协议为 connect-rpc + JSON）。
const KIMI_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const kimiStatsUrl = (auth) => {
  const host = String(auth?.authHost || 'https://auth.kimi.com');
  return `${host.includes('.kimi.ai') ? 'https://www.kimi.ai' : 'https://www.kimi.com'}/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats`;
};

// ratio 字段是 0–1 的「已用比例」，换算成剩余百分比。
// proto3 零值省略：用量为 0（剩余 100%）时 ratio 字段不返回，窗口对象仍在（enabled/resetTime），
// 因此 ratio 缺失按 0 处理，只有窗口对象整体缺失或 enabled=false 才跳过
const kimiRatioRow = (key, item) => {
  if (!item || item.enabled === false) return null;
  const used = item.ratio === undefined ? 0 : Number(item.ratio);
  if (!Number.isFinite(used)) return null;
  return { key, remaining: Math.max(0, Math.min(100, 100 - used * 100)), resetAt: item.resetTime || null };
};

async function queryKimiWebQuota(fetcher, meter, timeoutMs = DEFAULT_TIMEOUT_MS, ctx = {}) {
  const resolved = resolveCliAuth('kimi', ctx.variables);
  if (!resolved) throw reauthRequiredError('未检测到 Kimi 订阅登录。请在「导入订阅登录」中用手机扫码登录');
  const response = await fetchWithCliAuth('kimi', {
    auth: resolved.auth,
    source: resolved.source,
    fetcher,
    timeoutMs,
    buildRequest: (auth) => ({
      url: kimiStatsUrl(auth),
      init: { method: 'POST', headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': KIMI_BROWSER_UA }, body: '{}' },
    }),
    onAuthUpdate: ctx.onAuthUpdate,
  });
  if (response.status === 401 || response.status === 403) throw reauthRequiredError('Kimi 订阅凭据被拒绝（自动续期后仍无效），请重新扫码「导入订阅登录」');
  if (!response.ok) throw new Error(`Kimi 订阅用量接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  const rows = [
    kimiRatioRow('five_hour', payload?.ratelimitCode5h),
    kimiRatioRow('weekly', payload?.ratelimitCode7d),
  ];
  // 月度窗口取整个会员池的 amountUsedRatio（订阅额度的真实用量），缺失时退到 coding 专属口径 kimiCodeUsedRatio
  const balance = payload?.subscriptionBalance;
  const monthlyUsed = Number(balance?.amountUsedRatio ?? balance?.kimiCodeUsedRatio);
  if (Number.isFinite(monthlyUsed)) rows.push({ key: 'monthly', remaining: Math.max(0, Math.min(100, 100 - monthlyUsed * 100)), resetAt: balance.expireTime || null });
  const windows = rows.filter(Boolean).map((row) => meter(row.key, row.remaining, 100, '%', row.resetAt));
  if (!windows.length) throw new Error('Kimi 订阅响应中没有可识别的额度窗口');
  return windows;
}

// GitHub Copilot 凭据形态（设备码登录快照）：{ oauth_token, login?, userId? }。OAuth user
// token 长期有效且没有 refresh_token，无需续期；失效时 copilot:device-* 重新设备码授权。
// 额度查询参考 CodexBar / copilot-api：用 GitHub OAuth 令牌直读 VS Code 同款内部接口
// copilot_internal/user。premium_interactions 是付费计划的「补充请求」月度池；部分账户
// 缺 entitlement/remaining/quota_reset_date（CodexBar 只依赖 percent_remaining），
// 解析按 percent → remaining/entitlement 两层降级；旧版计划的 chat/completions 池兜底。
// 字段 snake_case 为主，个别网关回 camelCase，两种都认。
const COPILOT_USER_ENDPOINT = 'https://api.github.com/copilot_internal/user';
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

const copilotSnapshotOf = (payload) => {
  const snapshots = plainObject(payload?.quota_snapshots) || plainObject(payload?.quotaSnapshots);
  if (!snapshots) return null;
  return plainObject(snapshots.premium_interactions) || plainObject(snapshots.premiumInteractions)
    || plainObject(snapshots.chat) || plainObject(snapshots.completions) || null;
};

const copilotResetAt = (payload) => {
  const raw = payload?.quota_reset_date ?? payload?.quotaResetDate ?? payload?.quota_reset_date_utc ?? null;
  if (raw === null || raw === undefined) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const parseCopilotQuota = (payload) => {
  const pool = copilotSnapshotOf(payload);
  if (!pool) throw new Error('GitHub Copilot 响应中没有可识别的额度池');
  if (pool.unlimited === true) {
    return { remaining: 100, amount: null, limitAmount: null, resetAt: copilotResetAt(payload) };
  }
  const percentRemaining = Number(pool.percent_remaining ?? pool.percentRemaining);
  const entitlement = Number(pool.entitlement);
  const remaining = Number(pool.remaining);
  const remainingPct = Number.isFinite(percentRemaining)
    ? percentRemaining
    : Number.isFinite(entitlement) && entitlement > 0 && Number.isFinite(remaining)
      ? (remaining / entitlement) * 100
      : NaN;
  if (!Number.isFinite(remainingPct)) throw new Error('GitHub Copilot 额度响应缺少剩余百分比');
  return {
    remaining: Math.max(0, Math.min(100, remainingPct)),
    amount: Number.isFinite(remaining) && remaining >= 0 ? remaining : null,
    limitAmount: Number.isFinite(entitlement) && entitlement > 0 ? entitlement : null,
    resetAt: copilotResetAt(payload),
  };
};

async function queryCopilotQuota(fetcher, meter, timeoutMs = DEFAULT_TIMEOUT_MS, ctx = {}) {
  const resolved = resolveCliAuth('copilot', ctx.variables);
  if (!resolved) throw reauthRequiredError('未检测到 GitHub Copilot 登录。请在「导入订阅登录」中完成 GitHub 设备码授权');
  const response = await fetchWithCliAuth('copilot', {
    auth: resolved.auth,
    source: resolved.source,
    fetcher,
    timeoutMs,
    // 该内部接口按 VS Code 客户端识别请求，缺编辑器伪装头会被拒绝；令牌用 GitHub OAuth
    // 原始值（ghu_，PAT 会被 400 拒绝）
    buildRequest: (auth) => ({
      url: COPILOT_USER_ENDPOINT,
      init: {
        headers: {
          Authorization: `token ${auth?.oauth_token || ''}`,
          Accept: 'application/json',
          'User-Agent': 'GitHubCopilotChat/0.26.7',
          'Editor-Version': 'vscode/1.96.2',
          'Editor-Plugin-Version': 'copilot-chat/0.26.7',
          'X-GitHub-Api-Version': '2025-04-01',
        },
      },
    }),
    onAuthUpdate: ctx.onAuthUpdate,
  });
  if (response.status === 401 || response.status === 403) throw reauthRequiredError('GitHub 授权已失效，请重新进行 Copilot 设备码登录');
  if (!response.ok) throw new Error(`GitHub Copilot 额度接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  const quota = parseCopilotQuota(payload);
  return [meter('monthly', quota.remaining, 100, '%', quota.resetAt, { amount: quota.amount, limitAmount: quota.limitAmount })];
}

module.exports = { queryClaudeQuota, queryCodexQuota, queryGeminiQuota, queryKimiWebQuota, queryCopilotQuota, __copilot: { parseCopilotQuota, COPILOT_USER_ENDPOINT } };
