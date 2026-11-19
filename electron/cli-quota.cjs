// CLI 凭据类厂商的专属额度适配：优先复用账号自己的登录快照（支持多账号、不受 cc-switch
// 切换影响），没有快照时回落本机 CLI 登录态。实现参考 cc-switch 的 subscription.rs：
// - Claude: .credentials.json / 快照 → api.anthropic.com/api/oauth/usage（5小时/7天窗口）
// - Codex:  ~/.codex/auth.json (ChatGPT OAuth tokens) → chatgpt.com/backend-api/wham/usage
// - Gemini: ~/.gemini/oauth_creds.json → cloudcode-pa.googleapis.com 两步查询（按模型分桶）
// - Kimi:   扫码登录的网页会话快照 → www.kimi.com GetSubscriptionStats（5小时/7天/月度，含月额度）
// token 过期时用账号快照里的 refresh_token 自动续期（见 cli-auth.cjs），无需 CLI 在场。
const { resolveCliAuth, refreshTokenOf, accessTokenExpiryMs, fetchWithCliAuth, claudeOauthOf } = require('./cli-auth.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 15_000;
const reauthRequiredError = (message) => Object.assign(new Error(message), { authStatus: 'reauth_required' });

// Claude 凭据形态（live 文件或快照同构）：{ claudeAiOauth: { accessToken, refreshToken, expiresAt } }
// （旧版键名 "claude.ai_oauth" / claudeOauth，见 cli-auth.cjs 的 claudeOauthOf）；
// 防御式：条目里没有 token 时再扫一遍其它对象值兜底
const claudeTokenOf = (auth) => {
  if (!auth || typeof auth !== 'object') return null;
  const candidates = [claudeOauthOf(auth), ...Object.values(auth)];
  for (const value of candidates) {
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

// ── Antigravity（Google 的 agentic IDE，Gemini CLI 的官方继任者）──────────────
// 额度是「池 × 周期」两层结构（对照 magpie internal/provider/google.go 与实测定稿）：
// - retrieveUserQuotaSummary 返回分组池（"Claude and GPT models" 等），每池 5h + weekly 双桶；
//   带版本号的「单模型组」（如 Gemini 4 Argon）只有周桶、独立于家族池 → 动态窗口 key；
// - fetchAvailableModels 的 quotaInfo 是逐模型的 5 小时读数，同池内所有模型相同；
//   free-tier 账号的 summary 里没有 Gemini 组，Gemini 池从逐模型读数聚类推导。
// remainingFraction 缺失 = 已耗尽（Google 用完即省略字段，proto3 零值省略）。
// 请求 host：loadCodeAssist 走生产 cloudcode-pa；模型与池化额度走 daily-cloudcode-pa。
const AGY_HOST_PROD = 'https://cloudcode-pa.googleapis.com';
const AGY_HOST_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const AGY_USER_AGENT = `antigravity/hub/1.4.0 ${process.platform}/${process.arch}`;

const AGY_POOL_KEYS = { gemini: 'agy_gemini', claudegpt: 'agy_claudegpt' };
const AGY_POOL_LABELS = { gemini: 'Gemini 池', claudegpt: 'Claude/GPT 池' };

const agyFamilyOf = (modelId) => {
  const id = String(modelId || '');
  if (id.startsWith('gemini-4-argon')) return 'argon';
  if (id.startsWith('gemini')) return 'gemini';
  if (id.startsWith('claude') || id.startsWith('gpt-')) return 'claudegpt';
  return 'other';
};

// summary 组名 → 池 key：家族组（Gemini Models / Claude and GPT models）映射到静态
// 窗口目录；组名带版本号（"Gemini 4 Argon"）是单模型独占池，绝不归入家族池
//（对照 magpie：a group that says a version is its model's alone），落动态 key
const agyPoolKeyOf = (displayName) => {
  const name = String(displayName || '');
  const versioned = /\d/.test(name);
  if (!versioned && /claude|gpt/i.test(name)) return AGY_POOL_KEYS.claudegpt;
  if (!versioned && /gemini/i.test(name)) return AGY_POOL_KEYS.gemini;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pool';
  return `agy_pool_${slug}`;
};

const agyWindowOf = (bucket) => {
  const window = String(bucket?.window || '').toLowerCase();
  if (window === '5h') return { suffix: '_5h', label: '5 小时', order: 0 };
  if (window === 'weekly') return { suffix: '_7d', label: '7 天', order: 1 };
  return null;
};

// 逐模型条目：跳过内部模型（chat_/tab_ 前缀）与被 Google 置为 disabled 的模型
const agyModelEntries = (modelsPayload) => {
  const entries = [];
  for (const [id, model] of Object.entries(modelsPayload?.models || {})) {
    if (!id || id.startsWith('chat_') || id.startsWith('tab_')) continue;
    if (model?.disabled) continue;
    const quota = model?.quotaInfo;
    entries.push({
      id,
      name: String(model?.displayName || id),
      family: agyFamilyOf(id),
      remaining: quota && quota.remainingFraction !== undefined && Number.isFinite(Number(quota.remainingFraction))
        ? Math.max(0, Math.min(100, Number(quota.remainingFraction) * 100)) : null,
      resetAt: quota?.resetTime || null,
    });
  }
  return entries;
};

// 同池模型的 5h 读数相同：按 (剩余, 重置时间) 聚类，取最大簇代表该池
const agyClusterReading = (entries) => {
  const clusters = new Map();
  for (const entry of entries) {
    if (entry.remaining === null) continue;
    const key = `${entry.remaining}|${entry.resetAt || ''}`;
    const cluster = clusters.get(key) || { remaining: entry.remaining, resetAt: entry.resetAt, members: [] };
    cluster.members.push(entry.name);
    clusters.set(key, cluster);
  }
  let best = null;
  for (const cluster of clusters.values()) {
    if (!best || cluster.members.length > best.members.length) best = cluster;
  }
  return best;
};

// 纯解析：models + summary 两个响应 → 池窗口 meters（成员模型名单挂在 meter.models）
function buildAntigravityWindows(modelsPayload, summaryPayload, meter) {
  const models = agyModelEntries(modelsPayload);
  const membersOf = (family) => {
    const names = models.filter((entry) => entry.family === family && entry.name).map((entry) => entry.name);
    return names.length ? [...new Set(names)] : [];
  };
  const meters = [];
  for (const group of summaryPayload?.groups || []) {
    const poolKey = agyPoolKeyOf(group?.displayName);
    // 成员归属：静态家族池按 family；动态特例池（如 Gemini 4 Argon）按组名判 family
    const family = poolKey === AGY_POOL_KEYS.gemini ? 'gemini'
      : poolKey === AGY_POOL_KEYS.claudegpt ? 'claudegpt'
        : /argon/i.test(String(group?.displayName || '')) ? 'argon' : null;
    // 同一池的桶按 5h → weekly 排（Google 实测常把 weekly 排在前面）
    const poolMeters = [];
    for (const bucket of group?.buckets || []) {
      if (bucket?.disabled) continue;
      const window = agyWindowOf(bucket);
      if (!window) continue;
      const remaining = bucket.remainingFraction === undefined ? 0 : Number(bucket.remainingFraction);
      if (!Number.isFinite(remaining)) continue;
      const members = family ? membersOf(family) : [];
      poolMeters.push({
        order: window.order,
        meter: meter(`${poolKey}${window.suffix}`, Math.max(0, Math.min(100, remaining * 100)), 100, '%', bucket.resetTime || null, {
          // 静态家族池的 label 由 windowCatalog 提供；动态池（如 Gemini 4 Argon）把 label 随 meter 下发
          ...(Object.values(AGY_POOL_KEYS).includes(poolKey) ? {} : { label: `${String(group?.displayName || poolKey)} · ${window.label}` }),
          ...(members.length ? { models: members } : {}),
        }),
      });
    }
    meters.push(...poolMeters.sort((a, b) => a.order - b.order).map((item) => item.meter));
  }
  // summary 缺失的池（free-tier 没有 Gemini 组 / summary 整体失败）：从逐模型读数聚类推导 5h 池。
  // Argon 只有周池、不参与推导
  for (const family of ['gemini', 'claudegpt']) {
    const key = `${AGY_POOL_KEYS[family]}_5h`;
    if (meters.some((item) => item.key === key)) continue;
    const reading = agyClusterReading(models.filter((entry) => entry.family === family));
    if (reading) meters.push(meter(key, reading.remaining, 100, '%', reading.resetAt, { models: [...new Set(reading.members)] }));
  }
  if (!meters.length) throw new Error('Antigravity 配额响应中没有可识别的额度池');
  return meters;
}

// Antigravity 凭据形态（live 凭据管理器或快照同构）：{ access_token, refresh_token, email? }。
// 凭据由 cli-auth.cjs 的 antigravity kind 提供（Windows 凭据管理器 gemini:antigravity）。
//
// 额度视图挂的项目：consumer 额度挂在 CLI 的默认项目下（实测 default-cli-project，
// 记录在 ~/.gemini/antigravity-cli/cache/default_project_id.txt）；loadCodeAssist 返回的
// cloudaicompanionProject（aicode-consumers）只回空读数（一切恒 100%）。entitlement
// 对导入的 consumer 凭据一律 INVALID_ARGUMENT（magpie 的 tier 协商同被拒后回落），不发。
const AGY_DEFAULT_PROJECT = 'default-cli-project';
const agyProjectFilePath = () => path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cache', 'default_project_id.txt');
const agyQuotaProject = () => {
  try {
    const stored = fs.readFileSync(agyProjectFilePath(), 'utf8').trim();
    if (stored) return stored;
  } catch { /* 文件缺失用常量兜底 */ }
  return AGY_DEFAULT_PROJECT;
};

// Antigravity 桌面版运行时会在 ~/.gemini/antigravity/daemon/hub_*.json 落一个本地
// connect-RPC 服务（httpPort + csrfToken，头 x-codeium-csrf-token）。它的
// RetrieveUserQuotaSummary / GetAvailableModels 走 Hub 自己的会话，能看到付费档视图
//（Gemini 池 5h+周、Claude/GPT 池、Gemini 4 Argon 独立周池）；cloudcode 直查用的
// consumer 凭据只有免费视图。桌面版没开时 daemon 不存在，额度查询回落直查。
const AGY_DAEMON_DIR = () => path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
const AGY_LS_SERVICE = '/exa.language_server_pb.LanguageServerService/';
const AGY_DAEMON_TIMEOUT_MS = 5_000;

const agyDaemonFiles = () => {
  let names;
  try { names = fs.readdirSync(AGY_DAEMON_DIR()); } catch { return []; }
  return names
    .filter((name) => /^hub_.+\.json$/.test(name))
    .map((name) => {
      try {
        const filePath = path.join(AGY_DAEMON_DIR(), name);
        const info = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const port = Number(info?.httpPort);
        if (!Number.isFinite(port) || port <= 0) return null;
        return { port, csrf: String(info?.csrfToken || ''), mtimeMs: fs.statSync(filePath).mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    // 多个桌面版实例各写一个 hub_*.json：最新启动的实例排前面
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
};

const agyDaemonCall = async (daemon, endpoint, fetcher) => {
  const response = await fetcher(`http://127.0.0.1:${daemon.port}${AGY_LS_SERVICE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'connect-protocol-version': '1', 'x-codeium-csrf-token': daemon.csrf },
    body: JSON.stringify(endpoint === 'RetrieveUserQuotaSummary' ? { request: {} } : {}),
    signal: AbortSignal.timeout(AGY_DAEMON_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`daemon ${endpoint} 返回 HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.response && typeof payload.response === 'object' ? payload.response : payload;
};

// 优先走本地守护进程（付费档全量视图）；成员模型名单顺带取模型目录，失败不阻断
async function queryAntigravityDaemonQuota(fetcher, meter) {
  let lastError = null;
  for (const daemon of agyDaemonFiles()) {
    try {
      const summary = await agyDaemonCall(daemon, 'RetrieveUserQuotaSummary', fetcher);
      let modelsPayload = null;
      try { modelsPayload = await agyDaemonCall(daemon, 'GetAvailableModels', fetcher); } catch { /* 成员名单可缺 */ }
      return buildAntigravityWindows(modelsPayload, summary, meter);
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('没有运行中的 Antigravity 桌面版守护进程');
}

async function queryAntigravityQuota(fetcher, meter, timeoutMs = DEFAULT_TIMEOUT_MS, ctx = {}) {
  // 优先本地守护进程：桌面版运行时直接给付费档全量视图（含 Gemini 周池与 Argon
  // 独立池），不需要 Google 凭据；桌面版没开（或接口异常）回落 cloudcode 直查
  try {
    return await queryAntigravityDaemonQuota(fetcher, meter);
  } catch { /* 回落直查 */ }
  const resolved = resolveCliAuth('antigravity', ctx.variables);
  if (!resolved) throw reauthRequiredError('未检测到 Antigravity 登录。请先在 Antigravity 桌面版或 CLI 登录 Google 账号，再到「设置 → 账号与凭据」导入本机登录保存为独立账号快照');
  const expiry = accessTokenExpiryMs('antigravity', resolved.auth);
  if (expiry && expiry < Date.now() && !refreshTokenOf('antigravity', resolved.auth)) {
    throw reauthRequiredError('Antigravity 访问令牌已过期且无法自动续期，请重新登录后再次导入');
  }
  // 各步共用同一份会随续期更新的凭据；只有第一步带 401 续期重试，避免一次轮询刷新两次
  let effective = resolved.auth;
  const trackAuth = async (...args) => {
    effective = args[1];
    if (ctx.onAuthUpdate) await ctx.onAuthUpdate(...args);
  };
  const authHeaders = (auth) => ({ Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json', 'User-Agent': AGY_USER_AGENT });
  const loadResponse = await fetchWithCliAuth('antigravity', {
    auth: resolved.auth,
    source: resolved.source,
    fetcher,
    timeoutMs,
    buildRequest: (auth) => ({
      url: `${AGY_HOST_PROD}/v1internal:loadCodeAssist`,
      init: { method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }) },
    }),
    onAuthUpdate: trackAuth,
  });
  if (loadResponse.status === 401 || loadResponse.status === 403) throw reauthRequiredError('Antigravity 凭据被拒绝（自动续期后仍无效），请重新登录该账号并更新快照');
  if (!loadResponse.ok) throw new Error(`Antigravity loadCodeAssist 返回 HTTP ${loadResponse.status}`);
  const loadPayload = await loadResponse.json();
  const loadProject = loadPayload?.cloudaicompanionProject;
  const loadProjectId = typeof loadProject === 'string' ? loadProject : (loadProject?.id || loadProject?.projectId || null);

  const callDaily = (method, body) => fetcher(`${AGY_HOST_DAILY}/v1internal:${method}`, {
    method: 'POST',
    headers: authHeaders(effective),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 逐模型 5h 读数：优先 CLI 默认项目（真实用量）；被 4xx 拒绝时回落 loadCodeAssist
  // 的项目、再回落不带项目（跨版本兜底）
  const projectCandidates = [...new Set([agyQuotaProject(), loadProjectId].filter(Boolean))];
  let modelsResponse = null;
  let modelsProject = null;
  for (const candidate of projectCandidates) {
    modelsResponse = await callDaily('fetchAvailableModels', { project: candidate });
    if (modelsResponse.ok || modelsResponse.status === 401 || modelsResponse.status === 403) { modelsProject = candidate; break; }
    modelsResponse = null;
  }
  if (!modelsResponse) modelsResponse = await callDaily('fetchAvailableModels', {});
  if (modelsResponse.status === 401 || modelsResponse.status === 403) throw reauthRequiredError('Antigravity 凭据被拒绝（fetchAvailableModels 鉴权失败），请重新登录该账号并更新快照');
  if (!modelsResponse.ok) throw new Error(`Antigravity fetchAvailableModels 返回 HTTP ${modelsResponse.status}`);
  const modelsPayload = await modelsResponse.json();
  // 池化视图：失败可容忍（Gemini 池可从逐模型读数推导，只是拿不到周窗口）
  let summaryPayload = null;
  try {
    const summaryResponse = await callDaily('retrieveUserQuotaSummary', modelsProject ? { project: modelsProject } : {});
    if (summaryResponse.ok) summaryPayload = await summaryResponse.json();
  } catch { /* summary 失败不阻断逐模型读数 */ }
  return buildAntigravityWindows(modelsPayload, summaryPayload, meter);
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

// Grok Bot 凭据形态（导入快照或本机客户端登录）：{ machine_id, access_token, refresh_token, sub?, email? }。
// Grok Bot 是 Cursor 技术栈的 fork，用量存于 Cursor 后端：connect-rpc JSON 调
// DashboardService.GetSandUsageStatus（grok.com / SuperGrok 渠道的 Bot 周额度，与 Grok 聊天额度独立）。
// 请求需带客户端的 x-cursor-checksum（混淆时间戳 + machineId），算法移植自 Grok Bot 客户端。
const GROKBOT_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus';

const grokBotChecksum = (machineId, nowMs = Date.now()) => {
  const kiloSeconds = Math.floor(nowMs / 1_000_000);
  // 与客户端 TS 原版同款：JS 位运算的移位量按 mod-32 处理（1 >> 32 === 1），
  // 千秒时间戳在该语义下的"错位"组装即服务端校验所期望的格式
  const bytes = Buffer.from([
    (kiloSeconds >> 40) & 255, (kiloSeconds >> 32) & 255, (kiloSeconds >> 24) & 255,
    (kiloSeconds >> 16) & 255, (kiloSeconds >> 8) & 255, kiloSeconds & 255,
  ]);
  let lastByte = 165;
  for (let index = 0; index < bytes.length; index += 1) {
    const current = bytes[index] ?? 0;
    bytes[index] = ((current ^ lastByte) + index % 256) & 255;
    lastByte = bytes[index] ?? 0;
  }
  return `${bytes.toString('base64url')}${machineId || ''}`;
};

async function queryGrokBotUsage(fetcher, meter, timeoutMs = DEFAULT_TIMEOUT_MS, ctx = {}) {
  const resolved = resolveCliAuth('grokbot', ctx.variables);
  if (!resolved) throw reauthRequiredError('未检测到 Grok Bot 登录。请先在 Grok Bot 桌面客户端登录，再到「导入订阅登录」收录本机登录');
  const response = await fetchWithCliAuth('grokbot', {
    auth: resolved.auth,
    source: resolved.source,
    fetcher,
    timeoutMs,
    buildRequest: (auth) => ({
      url: GROKBOT_USAGE_URL,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'connect-protocol-version': '1',
          'x-cursor-checksum': grokBotChecksum(auth.machine_id),
          'x-cursor-client-type': 'sand',
          'x-cursor-client-version': '0.18.0',
          'x-sand-box-namespace': 'prod',
          'x-ghost-mode': 'true',
        },
        body: '{}',
      },
    }),
    onAuthUpdate: ctx.onAuthUpdate,
  });
  if (response.status === 401 || response.status === 403) throw reauthRequiredError('Grok Bot 凭据被拒绝（自动续期后仍无效），请重新登录该账号并再次「导入订阅登录」');
  if (!response.ok) throw new Error(`Grok Bot 用量接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.usesPooledEnterpriseAllowance === true) throw new Error('该账号走团队池化额度，暂无个人百分比可展示');
  const used = Number(payload?.usagePercent);
  if (!Number.isFinite(used)) throw new Error('Grok Bot 用量响应中没有 usagePercent');
  const resetAt = payload?.nextResetTimestampUtc || null;
  const startAt = Date.parse(payload?.currentPeriodStart || '');
  // 周期起止都可用时按真实时长判窗口：客户端实测为 7 天周期，统一计划迁移等会让
  // currentPeriodStart 中途重置而 resetAt 不变（起止相距不足 7 天），仍按周窗口展示；
  // 只有相距达到月周期量级（≥20 天）才归为月额度。
  const days = resetAt && Number.isFinite(startAt) ? (Date.parse(resetAt) - startAt) / 86_400_000 : 7;
  const key = days >= 20 ? 'monthly' : 'weekly';
  const remaining = Math.max(0, Math.min(100, 100 - used));
  return [meter(key, remaining, 100, '%', resetAt, { amount: remaining, limitAmount: 100 })];
}

module.exports = { queryClaudeQuota, queryCodexQuota, queryGeminiQuota, queryAntigravityQuota, queryKimiWebQuota, queryCopilotQuota, queryGrokBotUsage, __copilot: { parseCopilotQuota, COPILOT_USER_ENDPOINT }, __grokbot: { GROKBOT_USAGE_URL, grokBotChecksum }, __antigravity: { buildAntigravityWindows, AGY_HOST_PROD, AGY_HOST_DAILY } };
