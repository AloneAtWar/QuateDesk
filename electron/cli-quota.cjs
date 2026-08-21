// CLI 凭据类厂商的专属额度适配（与 Grok 同模式）：复用本机 CLI 登录态，用户无需填凭据。
// 实现参考 cc-switch 的 subscription.rs：
// - Claude: ~/.claude/.credentials.json → api.anthropic.com/api/oauth/usage（5小时/7天窗口）
// - Codex:  ~/.codex/auth.json (ChatGPT OAuth tokens) → chatgpt.com/backend-api/wham/usage
// - Gemini: ~/.gemini/oauth_creds.json → cloudcode-pa.googleapis.com 两步查询（按模型分桶）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TIMEOUT = 15_000;
const homeFile = (...parts) => path.join(os.homedir(), ...parts);

const readJsonFile = (filePath) => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
};

// Claude CLI 凭据：{ claudeOauth: { accessToken, expiresAt } }（防御式：找第一个带 accessToken 的对象）
const readClaudeToken = () => {
  const data = readJsonFile(homeFile('.claude', '.credentials.json'));
  if (!data || typeof data !== 'object') return null;
  for (const value of [data.claudeOauth, ...Object.values(data)]) {
    if (value && typeof value === 'object') {
      const token = value.accessToken || value.access_token;
      if (token) return { token, expiresAt: value.expiresAt || value.expires_at || null };
    }
  }
  return null;
};

const CLAUDE_WINDOW_KEYS = { five_hour: 'five_hour', seven_day: 'weekly', seven_day_opus: 'weekly', seven_day_sonnet: 'weekly' };

async function queryClaudeQuota(fetcher, meter) {
  const credential = readClaudeToken();
  if (!credential) throw new Error('未检测到 Claude CLI 登录信息，请先安装 Claude Code 并登录');
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() < Date.now()) {
    throw new Error('Claude 访问令牌已过期，运行一次 Claude CLI 让其自动刷新，或重新登录');
  }
  const response = await fetcher('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${credential.token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Claude 凭据被拒绝，请重新登录 Claude CLI');
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

// Codex CLI 凭据：{ tokens: { access_token, account_id }, OPENAI_API_KEY }；订阅额度只走 ChatGPT OAuth
async function queryCodexQuota(fetcher, meter) {
  const auth = readJsonFile(homeFile('.codex', 'auth.json'));
  const token = auth?.tokens?.access_token;
  if (!token) throw new Error('未检测到 Codex 的 ChatGPT 登录（~/.codex/auth.json 无 OAuth tokens），API Key 模式无法查询订阅额度');
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'codex-cli', Accept: 'application/json' };
  if (auth.tokens.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
  const response = await fetcher('https://chatgpt.com/backend-api/wham/usage', { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (response.status === 401 || response.status === 403) throw new Error('Codex 凭据被拒绝，请重新登录 Codex CLI');
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

// Gemini CLI 凭据：{ access_token, refresh_token, expiry_date(毫秒) }
async function queryGeminiQuota(fetcher, meter) {
  const auth = readJsonFile(homeFile('.gemini', 'oauth_creds.json'));
  const token = auth?.access_token;
  if (!token) throw new Error('未检测到 Gemini CLI 登录信息，请先安装 Gemini CLI 并登录');
  if (auth.expiry_date && Number(auth.expiry_date) < Date.now()) {
    throw new Error('Gemini 访问令牌已过期，运行一次 Gemini CLI 让其自动刷新，或重新登录');
  }
  const loadResponse = await fetcher('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (loadResponse.status === 401 || loadResponse.status === 403) throw new Error('Gemini 凭据被拒绝，请重新登录 Gemini CLI');
  if (!loadResponse.ok) throw new Error(`Gemini loadCodeAssist 返回 HTTP ${loadResponse.status}`);
  const loadPayload = await loadResponse.json();
  const project = loadPayload?.cloudaicompanionProject;
  const projectId = typeof project === 'string' ? project : (project?.id || project?.projectId || null);
  const quotaResponse = await fetcher('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
    signal: AbortSignal.timeout(TIMEOUT),
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
