// cc-switch 数据导入：迁移 API key 与官方 OAuth 登录（Codex）。
// 数据源 ~/.cc-switch/cc-switch.db（SQLite providers 表）。
// 凭据不经过渲染进程：扫描结果只下发脱敏预览，应用时主进程重新提取。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliIdentity } = require('./cli-auth.cjs');

const ccswitchDbPath = () => path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

// 从 codex 官方登录条目的 settings_config.auth 提取完整 OAuth token bundle
// （形态：{ auth: { auth_mode: "chatgpt", tokens: { id_token, access_token, refresh_token, account_id } }, config }），
// 还原为 ~/.codex/auth.json 的结构供快照存储
const extractCodexOauth = (appType, settingsConfig) => {
  if (appType !== 'codex') return null;
  let cfg;
  try { cfg = JSON.parse(settingsConfig || '{}'); }
  catch { return null; }
  const auth = cfg?.auth;
  const tokens = auth?.tokens;
  if (!tokens || typeof tokens !== 'object' || !tokens.access_token) return null;
  return { OPENAI_API_KEY: auth.OPENAI_API_KEY ?? null, tokens, last_refresh: auth.last_refresh ?? null };
};

// 从 settings_config 提取 (baseUrl, apiKey)，覆盖 cc-switch 各 app_type 的存储形态：
// claude/openclaw: { env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN } } 或顶层 { baseUrl, apiKey }
// codex: { auth: { OPENAI_API_KEY }, config: "TOML 内含 base_url" }
// opencode 等其他形态：递归找 apiKey 类字段兜底
const extractCredential = (settingsConfig) => {
  let cfg;
  try { cfg = JSON.parse(settingsConfig || '{}'); }
  catch { return null; }
  if (!cfg || typeof cfg !== 'object') return null;
  let baseUrl = '';
  let apiKey = '';
  const env = cfg.env || {};
  if (typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL) baseUrl = env.ANTHROPIC_BASE_URL;
  if (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN) apiKey = env.ANTHROPIC_AUTH_TOKEN;
  if (!baseUrl && typeof cfg.baseUrl === 'string' && cfg.baseUrl) baseUrl = cfg.baseUrl;
  if (!apiKey && typeof cfg.apiKey === 'string' && cfg.apiKey) apiKey = cfg.apiKey;
  if (!apiKey && cfg.auth && typeof cfg.auth.OPENAI_API_KEY === 'string' && cfg.auth.OPENAI_API_KEY) apiKey = cfg.auth.OPENAI_API_KEY;
  if (!baseUrl && typeof cfg.config === 'string') {
    const matched = /base_url\s*=\s*"([^"]+)"/.exec(cfg.config);
    if (matched) baseUrl = matched[1];
  }
  if (!apiKey) {
    const walk = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 3) return '';
      for (const [key, value] of Object.entries(obj)) {
        if (/^(apiKey|api_key|authToken)$/i.test(key) && typeof value === 'string' && value) return value;
        const found = walk(value, depth + 1);
        if (found) return found;
      }
      return '';
    };
    apiKey = walk(cfg, 0);
  }
  if (!apiKey) return null;
  return { baseUrl, apiKey };
};

const hostOf = (url) => {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return raw.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, ''); }
};

// 内置厂商域名别名：cc-switch 里配的 baseUrl 域名与额度接口域名不一定相同
const BUILTIN_HOST_ALIASES = {
  zai: ['bigmodel.cn', 'api.z.ai', 'z.ai'],
  deepseek: ['deepseek.com'],
  wlb: ['wlbclub.com'],
  minimax: ['minimaxi.com', 'minimax.io'],
};

// 厂商匹配：先按当前厂商列表（含自定义厂商）的接口域名匹配，再叠加内置别名；
// 域名按后缀匹配（codex.wlbclub.com 命中 wlbclub.com）。返回 providerId 或 null。
const matchProviderId = (baseUrl, providers) => {
  const host = hostOf(baseUrl);
  if (!host) return null;
  for (const provider of providers || []) {
    const hosts = new Set(BUILTIN_HOST_ALIASES[provider.id] || []);
    const config = provider.requestConfig || {};
    if (config.endpoint) hosts.add(hostOf(config.endpoint));
    for (const variable of config.variables || []) {
      const defaultValue = String(variable.defaultValue || '');
      if (/^https?:\/\//i.test(defaultValue)) hosts.add(hostOf(defaultValue));
    }
    for (const candidate of hosts) {
      if (!candidate) continue;
      if (host === candidate || host.endsWith('.' + candidate) || candidate.endsWith('.' + host)) return provider.id;
    }
  }
  return null;
};

// 扫描可导入候选。返回 { candidates, unsupported }，apiKey 只保留在主进程内存中。
const scanCcswitch = (providers) => {
  const dbPath = ccswitchDbPath();
  if (!fs.existsSync(dbPath)) return { error: '未找到 cc-switch 数据（~/.cc-switch/cc-switch.db 不存在）' };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch { return { error: '当前环境不支持读取 SQLite 数据库' }; }
  let db;
  let rows;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    rows = db.prepare('SELECT id, app_type, name, settings_config FROM providers').all();
    db.close();
  } catch (error) {
    try { db?.close(); } catch {}
    return { error: `读取 cc-switch 数据库失败：${error.message}` };
  }
  const candidates = [];
  const unsupported = [];
  const seenKeys = new Set();
  const seenFingerprints = new Set();
  for (const row of rows) {
    // 官方 OAuth 登录（目前只有 Codex 条目保存完整 token bundle）：收录为可自动续期的独立账号
    const bundle = extractCodexOauth(row.app_type, row.settings_config);
    if (bundle) {
      const identity = cliIdentity('codex', bundle);
      if (!identity) continue;
      const duplicateInBatch = seenFingerprints.has(identity.fingerprint);
      seenFingerprints.add(identity.fingerprint);
      candidates.push({
        key: String(row.id),
        kind: 'oauth',
        name: row.name || 'Codex 官方登录',
        providerId: 'codex',
        keyTail: identity.display || `…${identity.fingerprint.slice(-6)}`,
        oauthDisplay: identity.display,
        fingerprint: identity.fingerprint,
        duplicateInBatch,
        bundle,
      });
      continue;
    }
    const credential = extractCredential(row.settings_config);
    if (!credential) continue; // 既没有 API key 也没有官方 OAuth 登录的条目不迁移
    const providerId = matchProviderId(credential.baseUrl, providers);
    if (!providerId) {
      unsupported.push({ name: row.name || '(未命名)', baseUrl: credential.baseUrl || '未知域名' });
      continue;
    }
    const duplicateInBatch = seenKeys.has(credential.apiKey);
    seenKeys.add(credential.apiKey);
    candidates.push({
      key: String(row.id),
      name: row.name || providerId,
      providerId,
      keyTail: credential.apiKey.length > 10 ? `${credential.apiKey.slice(0, 4)}…${credential.apiKey.slice(-4)}` : '****',
      duplicateInBatch,
      apiKey: credential.apiKey,
    });
  }
  return { candidates, unsupported };
};

module.exports = { ccswitchDbPath, extractCredential, extractCodexOauth, hostOf, matchProviderId, scanCcswitch };
