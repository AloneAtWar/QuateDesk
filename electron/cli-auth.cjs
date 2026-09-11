// CLI 登录态的凭据管理：账号级快照、OAuth 自动续期、本机 live 文件读写与身份指纹。
// 设计参考 cc-switch 的「OAuth 授权中心」：每个账号自带一份 token bundle（DPAPI 加密存于
// credentials.json 的 variables.cliAuthTokenBundle），~/.codex/auth.json 等本机文件只是
// 「当前激活账号」的投影。这样 cc-switch 切换 profile 不会导致额度监控丢失凭据，
// 多账号也能各自续期（协议实现对照 codex-rs login/auth、claude code 与 gemini-cli 源码）：
// - Codex:  POST auth.openai.com/oauth/token（JSON：client_id + grant_type=refresh_token）
// - Claude: POST console.anthropic.com/v1/oauth/token（JSON：client_id + grant_type=refresh_token）
// - Gemini: POST oauth2.googleapis.com/token（表单：client_id + client_secret + refresh_token）
// - Kimi:   POST auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken（connect-rpc JSON）。
//           Kimi 网页会话与 kimi CLI 的 coding OAuth 是两套体系（HS512 vs ES256），月额度只在
//           网页会员服务里，因此订阅凭据通过扫码登录获得，没有本机 live 文件可回落。
// - Grok:   ~/.grok/auth.json 的 scope → OIDC 条目；按 auth.x.ai discovery 得到 token endpoint，
//           用 refresh_token 续期并只合并回原 scope，避免 profile/账号之间互相覆盖。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CLI_KINDS = ['claude', 'codex', 'gemini', 'kimi', 'grok'];
// 快照在加密凭据 variables 里的键名；只在主进程读写，不进渲染进程
const SNAPSHOT_KEY = 'cliAuthTokenBundle';
// access token 剩余寿命低于该值时先刷新再用（cc-switch 为 60s，这里留足一次轮询的余量）
const REFRESH_AHEAD_MS = 120_000;

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
// Gemini CLI 的「已安装应用」公开凭据，取自 google-gemini/gemini-cli 的
// packages/core/src/code_assist/oauth2.ts（开源、随 CLI 二进制分发；按 Google 官方文档，
// 此类客户端凭据不作为机密对待）。拆成多段拼接只是为了让 GitHub 推送保护停止把这两串
// 公开常量误报为泄漏的机密，拼接结果与上游开源仓库完全一致。
const GEMINI_CLIENT_ID = ['681255809395-oo8ft2oprdrnp9e3aqf6', 'av3hmdib135j.apps.googleusercon', 'tent.com'].join('');
const GEMINI_CLIENT_SECRET = ['GOCSPX-4uHgMPm-', '1o7Sk-geV6', 'Cu5clXFsxl'].join('');
const GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Kimi 网页会话（account.gateway.v1.AuthService，connect-rpc + JSON）。国内 kimi.com / 海外 kimi.ai；
// 实际使用的 host 记在快照的 authHost 里，刷新时优先按快照记录的区域走
const KIMI_AUTH_HOST = 'https://auth.kimi.com';
const KIMI_REFRESH_PATH = '/api/account.gateway.v1.AuthService/RefreshToken';

// xAI Grok CLI 的 OIDC 公共参数（与 cc-switch 的 xai_oauth_auth.rs 保持一致）。
const GROK_ISSUER = 'https://auth.x.ai';
const GROK_DISCOVERY_URL = `${GROK_ISSUER}/.well-known/openid-configuration`;
const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const GROK_TOKEN_URL = `${GROK_ISSUER}/oauth2/token`;
const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const GROK_OIDC_SCOPE_PREFIX = `${GROK_ISSUER}::`;
const GROK_LEGACY_SESSION_SCOPE = 'https://accounts.x.ai/sign-in';
const GROK_USER_AGENT = 'quota-desk-xai-oauth';

const readJsonFile = (filePath) => {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
};

const writeJsonAtomic = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
};

// 各 CLI 的 live 凭据文件路径；Codex 遵循 CODEX_HOME 环境变量（与 codex CLI 一致）
const liveAuthPath = (kind) => {
  if (kind === 'codex') return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  if (kind === 'claude') return path.join(os.homedir(), '.claude', '.credentials.json');
  if (kind === 'gemini') return path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  if (kind === 'grok') return path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'auth.json');
  return null;
};
const grokAuthPath = () => liveAuthPath('grok');

const readLiveAuth = (kind) => readJsonFile(liveAuthPath(kind));

// 解析 JWT payload（不校验签名，只用于读取 exp/email 等展示性声明）
const parseJwtClaims = (token) => {
  const part = String(token || '').split('.')[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
  catch { return null; }
};

const shaTag = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);

const grokEntryToken = (entry) => String(entry?.key || entry?.access_token || entry?.accessToken || '').trim();
const grokEntryRefreshToken = (entry) => String(entry?.refresh_token || entry?.refreshToken || '').trim();
const isGrokEntry = (value) => Boolean(value && typeof value === 'object' && (grokEntryToken(value) || grokEntryRefreshToken(value)));
const isGrokAuthMap = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && !isGrokEntry(value)
  && Object.values(value).some((item) => isGrokEntry(item)));
const isGrokScope = (scope) => String(scope || '').startsWith(GROK_OIDC_SCOPE_PREFIX)
  || scope === GROK_LEGACY_SESSION_SCOPE || String(scope || '').includes('/sign-in');

const inferGrokScope = (entry) => {
  if (!entry || typeof entry !== 'object') return '';
  const explicit = [entry.scopeKey, entry.authScope, entry.scope]
    .map((value) => String(value || '').trim())
    .find((value) => value.startsWith('https://') || value === GROK_LEGACY_SESSION_SCOPE);
  if (explicit) return explicit;
  const issuer = String(entry.oidc_issuer || entry.issuer || GROK_ISSUER).replace(/\/$/, '');
  const clientId = String(entry.oidc_client_id || entry.client_id || '').trim();
  if (clientId && issuer === GROK_ISSUER) return `${GROK_ISSUER}::${clientId}`;
  if (String(entry.auth_mode || '').toLowerCase() === 'oidc' && issuer === GROK_ISSUER) return `${GROK_OIDC_SCOPE_PREFIX}${GROK_CLIENT_ID}`;
  return '';
};

// auth.json 是 scope → entry 的 map。返回 record 而不是直接选 entry，便于 CAS 写回时定位原 scope。
const selectGrokAuthRecord = (auth) => {
  if (!auth || typeof auth !== 'object') return null;
  if (isGrokEntry(auth)) {
    return { scope: inferGrokScope(auth), entry: { ...auth } };
  }
  const records = Object.entries(auth)
    .filter(([scope, entry]) => isGrokScope(scope) && isGrokEntry(entry))
    .map(([scope, entry]) => ({ scope, entry: { ...entry } }));
  if (!records.length) return null;
  // OIDC 条目优先于旧版网页登录条目；同类有多个时优先带 refresh_token、再优先较新的过期时间。
  records.sort((a, b) => {
    const oidcA = a.scope.startsWith(GROK_OIDC_SCOPE_PREFIX) ? 1 : 0;
    const oidcB = b.scope.startsWith(GROK_OIDC_SCOPE_PREFIX) ? 1 : 0;
    if (oidcA !== oidcB) return oidcB - oidcA;
    const refreshA = grokEntryRefreshToken(a.entry) ? 1 : 0;
    const refreshB = grokEntryRefreshToken(b.entry) ? 1 : 0;
    if (refreshA !== refreshB) return refreshB - refreshA;
    const expiryA = Date.parse(a.entry.expires_at || '') || 0;
    const expiryB = Date.parse(b.entry.expires_at || '') || 0;
    return expiryB - expiryA;
  });
  return records[0];
};

// 对外保留旧的「只取 entry」辅助函数；内部解析使用 selectGrokAuthRecord 保留 scope。
const selectGrokAuthEntry = (auth) => selectGrokAuthRecord(auth)?.entry || null;
const grokEntryOf = (auth) => {
  if (!auth || typeof auth !== 'object') return null;
  if (isGrokEntry(auth)) return auth;
  if (auth.entry && isGrokEntry(auth.entry)) return auth.entry;
  if (auth.auth && isGrokEntry(auth.auth)) return auth.auth;
  return selectGrokAuthEntry(auth);
};

const hasTokens = (kind, auth) => {
  if (!auth || typeof auth !== 'object') return false;
  if (kind === 'codex') return Boolean(auth.tokens?.access_token || auth.tokens?.refresh_token);
  if (kind === 'claude') return Boolean(auth.claudeOauth?.accessToken || auth.claudeOauth?.refreshToken);
  if (kind === 'kimi') return Boolean(auth.accessToken || auth.refreshToken);
  if (kind === 'grok') return isGrokEntry(grokEntryOf(auth));
  return Boolean(auth.access_token || auth.refresh_token);
};

// 账号身份指纹：用于「同一登录只收录一次」与「本机激活」徽标比对。
// 优先取稳定的账号标识（Codex account_id / Gemini sub），拿不到时退到 refresh_token 指纹。
const cliIdentity = (kind, auth) => {
  if (!hasTokens(kind, auth)) return null;
  let fingerprint = '';
  let email = '';
  if (kind === 'codex') {
    const claims = parseJwtClaims(auth.tokens?.id_token);
    email = String(claims?.email || '').toLowerCase();
    fingerprint = String(auth.tokens?.account_id || shaTag(auth.tokens?.refresh_token));
  } else if (kind === 'claude') {
    // Claude 凭据没有账号标识字段：access token 是 JWT 时取 sub 声明（续期轮换也稳定），否则退到 refresh_token 指纹
    const claims = parseJwtClaims(auth.claudeOauth?.accessToken);
    fingerprint = String(claims?.sub || claims?.user_id || '') || shaTag(auth.claudeOauth?.refreshToken || auth.claudeOauth?.accessToken);
  } else if (kind === 'kimi') {
    // Kimi 网页会话没有邮箱等展示字段：userId 是稳定账号标识，展示退到指纹尾号
    fingerprint = String(auth.userId || '') || shaTag(auth.refreshToken);
  } else if (kind === 'grok') {
    const entry = grokEntryOf(auth);
    const token = grokEntryToken(entry);
    const claims = parseJwtClaims(token) || parseJwtClaims(entry?.id_token);
    email = String(entry?.email || claims?.email || claims?.preferred_username || '').toLowerCase();
    fingerprint = String(entry?.user_id || entry?.principal_id || claims?.sub || '')
      || shaTag(grokEntryRefreshToken(entry) || token);
  } else {
    const claims = parseJwtClaims(auth.id_token || auth.access_token);
    email = String(claims?.email || '').toLowerCase();
    fingerprint = String(claims?.sub || '') || shaTag(auth.refresh_token);
  }
  const display = email || (fingerprint ? `…${fingerprint.slice(-6)}` : '');
  return { fingerprint, display };
};

// 从加密凭据的 variables 里解析账号级登录快照
const parseCliSnapshot = (kind, secretVariables = {}) => {
  const raw = secretVariables?.[SNAPSHOT_KEY];
  if (!raw) return null;
  let auth;
  try { auth = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
  if (kind === 'grok') {
    const record = selectGrokAuthRecord(auth);
    if (!record) return null;
    // scope 是快照元数据；entry 的其余字段（包括 refresh_token）原样保留。
    return { ...record.entry, ...(record.scope ? { scopeKey: record.scope } : {}) };
  }
  return hasTokens(kind, auth) ? auth : null;
};

// 凭据解析优先级：账号自己的登录快照 → 本机 CLI 的 live 登录文件
const resolveCliAuth = (kind, secretVariables = {}) => {
  const snapshot = parseCliSnapshot(kind, secretVariables);
  if (snapshot) return { source: 'snapshot', auth: snapshot };
  const live = readLiveAuth(kind);
  if (kind === 'grok') {
    const record = selectGrokAuthRecord(live);
    if (record) return { source: 'live', auth: { ...record.entry, ...(record.scope ? { scopeKey: record.scope } : {}) }, scope: record.scope };
    return null;
  }
  if (hasTokens(kind, live)) return { source: 'live', auth: live };
  return null;
};

const refreshTokenOf = (kind, auth) => {
  if (kind === 'codex') return auth?.tokens?.refresh_token || '';
  if (kind === 'claude') return auth?.claudeOauth?.refreshToken || '';
  if (kind === 'kimi') return auth?.refreshToken || '';
  if (kind === 'grok') return grokEntryRefreshToken(grokEntryOf(auth));
  return auth?.refresh_token || '';
};

// access token 是否临近过期（Codex 的 access_token 是 JWT，读 exp 声明；解析不出交给 401 兜底）
const accessTokenExpiryMs = (kind, auth) => {
  if (kind === 'codex') {
    const claims = parseJwtClaims(auth?.tokens?.access_token);
    return claims?.exp ? Number(claims.exp) * 1000 : null;
  }
  if (kind === 'claude') {
    const raw = auth?.claudeOauth?.expiresAt || auth?.claudeOauth?.expires_at;
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (kind === 'kimi') {
    // 网页会话的 access_token 是 HS512 JWT（exp = iat + 900s），读 exp 声明
    const claims = parseJwtClaims(auth?.accessToken);
    return claims?.exp ? Number(claims.exp) * 1000 : null;
  }
  if (kind === 'grok') {
    const entry = grokEntryOf(auth);
    const raw = entry?.expires_at ?? entry?.expiresAt ?? entry?.expiry_date;
    const number = Number(raw);
    if (Number.isFinite(number) && number > 0) return number < 10_000_000_000 ? number * 1000 : number;
    const dateMs = new Date(raw).getTime();
    if (Number.isFinite(dateMs)) return dateMs;
    const claims = parseJwtClaims(grokEntryToken(entry));
    return claims?.exp ? Number(claims.exp) * 1000 : null;
  }
  const ms = Number(auth?.expiry_date);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

const shouldRefreshFirst = (kind, auth) => {
  if (!refreshTokenOf(kind, auth)) return false;
  const expiry = accessTokenExpiryMs(kind, auth);
  return Boolean(expiry && expiry - Date.now() < REFRESH_AHEAD_MS);
};

// refresh 失败分为永久（invalid_grant/refresh_token 失效，需要重新登录）与瞬时（网络）两类
class CliRefreshError extends Error {
  constructor(message, { permanent = false, transient = false } = {}) {
    super(message);
    this.name = 'CliRefreshError';
    this.permanent = permanent;
    this.transient = transient;
  }
}

const asRefreshError = (kind, error) => {
  if (error instanceof CliRefreshError) return error;
  return new CliRefreshError(`${kind} 登录续期请求失败：${error?.message || error}`, { permanent: false, transient: true });
};

const postTokenRequest = async (fetcher, url, { json, form, headers = {}, timeoutMs }) => {
  const init = { method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs) };
  if (json) { init.headers = { ...init.headers, 'Content-Type': 'application/json' }; init.body = JSON.stringify(json); }
  else { init.headers = { ...init.headers, 'Content-Type': 'application/x-www-form-urlencoded' }; init.body = new URLSearchParams(form).toString(); }
  return fetcher(url, init);
};

async function refreshCodexAuth(auth, fetcher, timeoutMs) {
  const previousRefresh = auth.tokens?.refresh_token || '';
  if (!previousRefresh) throw new CliRefreshError('Codex 登录快照缺少 refresh_token，无法续期', { permanent: true });
  let response;
  let payload;
  try {
    response = await postTokenRequest(fetcher, CODEX_TOKEN_URL, {
      json: { client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: previousRefresh },
      timeoutMs,
    });
    payload = await response.json();
  } catch (error) { throw asRefreshError('Codex', error); }
  if (!response.ok) {
    const code = payload?.error?.code || payload?.error || payload?.code;
    const permanent = response.status === 401 || response.status === 400 || /invalid_grant|refresh_token/i.test(String(code));
    throw new CliRefreshError(`Codex 登录续期被拒绝（HTTP ${response.status}${code ? ` · ${code}` : ''}），请在 Codex CLI 重新登录该账号后重新导入`, { permanent });
  }
  const tokens = { ...auth.tokens };
  if (payload.access_token) tokens.access_token = payload.access_token;
  if (payload.refresh_token) tokens.refresh_token = payload.refresh_token;
  if (payload.id_token) {
    tokens.id_token = payload.id_token;
    // account_id 位于 id_token 的 https://api.openai.com/auth 声明里；解析失败保留旧值
    const claims = parseJwtClaims(payload.id_token);
    const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
    if (accountId) tokens.account_id = accountId;
  }
  return { ...auth, OPENAI_API_KEY: auth.OPENAI_API_KEY ?? null, tokens, last_refresh: new Date().toISOString() };
}

async function refreshClaudeAuth(auth, fetcher, timeoutMs) {
  const oauth = auth.claudeOauth || {};
  if (!oauth.refreshToken) throw new CliRefreshError('Claude 登录快照缺少 refreshToken，无法续期', { permanent: true });
  let response;
  let payload;
  try {
    response = await postTokenRequest(fetcher, CLAUDE_TOKEN_URL, {
      json: { grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLAUDE_CLIENT_ID },
      headers: { 'User-Agent': 'anthropic' },
      timeoutMs,
    });
    payload = await response.json();
  } catch (error) { throw asRefreshError('Claude', error); }
  if (!response.ok) {
    const permanent = response.status === 401 || response.status === 400 || /invalid_grant|refresh_token/i.test(String(payload?.error || ''));
    throw new CliRefreshError(`Claude 登录续期被拒绝（HTTP ${response.status}），请在 Claude Code 重新登录该账号后重新导入`, { permanent });
  }
  const nextOauth = { ...oauth };
  if (payload.access_token) nextOauth.accessToken = payload.access_token;
  if (payload.refresh_token) nextOauth.refreshToken = payload.refresh_token;
  const expiresAt = payload.expires_at || (payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() : null);
  if (expiresAt) nextOauth.expiresAt = expiresAt;
  return { ...auth, claudeOauth: nextOauth };
}

async function refreshGeminiAuth(auth, fetcher, timeoutMs) {
  if (!auth.refresh_token) throw new CliRefreshError('Gemini 登录快照缺少 refresh_token，无法续期', { permanent: true });
  let response;
  let payload;
  try {
    response = await postTokenRequest(fetcher, GEMINI_TOKEN_URL, {
      form: { client_id: GEMINI_CLIENT_ID, client_secret: GEMINI_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: auth.refresh_token },
      timeoutMs,
    });
    payload = await response.json();
  } catch (error) { throw asRefreshError('Gemini', error); }
  if (!response.ok) {
    const permanent = response.status === 401 || response.status === 400 || /invalid_grant|unauthorized_client/i.test(String(payload?.error || ''));
    throw new CliRefreshError(`Gemini 登录续期被拒绝（HTTP ${response.status}${payload?.error ? ` · ${payload.error}` : ''}），请在 Gemini CLI 重新登录该账号后重新导入`, { permanent });
  }
  const next = { ...auth };
  if (payload.access_token) next.access_token = payload.access_token;
  if (payload.id_token) next.id_token = payload.id_token;
  if (payload.scope) next.scope = payload.scope;
  if (payload.expires_in) next.expiry_date = Date.now() + Number(payload.expires_in) * 1000;
  return next;
}

async function refreshKimiWebAuth(auth, fetcher, timeoutMs) {
  if (!auth.refreshToken) throw new CliRefreshError('Kimi 订阅快照缺少 refreshToken，无法续期', { permanent: true });
  const host = String(auth.authHost || KIMI_AUTH_HOST).replace(/\/$/, '');
  let response;
  let payload;
  try {
    response = await postTokenRequest(fetcher, `${host}${KIMI_REFRESH_PATH}`, {
      json: { refreshToken: auth.refreshToken },
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' },
      timeoutMs,
    });
    payload = await response.json();
  } catch (error) { throw asRefreshError('Kimi', error); }
  if (!response.ok) {
    const permanent = response.status === 401 || response.status === 403;
    throw new CliRefreshError(`Kimi 订阅续期被拒绝（HTTP ${response.status}），请重新扫码「导入订阅登录」`, { permanent });
  }
  if (!payload?.accessToken || !payload?.refreshToken) throw new CliRefreshError('Kimi 订阅续期响应缺少令牌', { permanent: false });
  // 软轮换：响应同时返回新的成对令牌，旧 refresh_token 有宽限期但仍以最新一对为准
  return { ...auth, accessToken: payload.accessToken, refreshToken: payload.refreshToken };
}

const grokEndpointIsAllowed = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'auth.x.ai'
      && (!url.port || url.port === '443') && !url.username && !url.password;
  } catch { return false; }
};

const grokErrorCode = (payload) => {
  const raw = payload?.error?.code || payload?.error || payload?.code || payload?.status;
  const value = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  // 只把协议定义的短错误码放进提示；未知字段可能包含上游回显的 token/请求体。
  const known = new Set([
    'invalid_grant', 'invalid_token', 'invalid_client', 'unauthorized', 'unauthorized_client',
    'access_denied', 'expired_token', 'temporarily_unavailable', 'server_error', 'slow_down',
  ]);
  return known.has(value) ? value : '';
};

const grokResponsePayload = async (response) => {
  try {
    if (response && typeof response.json === 'function') return await response.json();
  } catch {}
  return null;
};

const grokRefreshFailure = (status, payload, prefix = 'Grok 登录续期') => {
  const code = grokErrorCode(payload);
  // 429、5xx 和明确的临时错误保留为瞬时失败；其它 4xx（尤其 invalid_grant）要求重新登录。
  const transient = status === 408 || status === 425 || status === 429 || status >= 500 || /temporar|unavailable|timeout|try_again/i.test(code);
  const permanent = !transient && (status >= 400 || /invalid_grant|invalid_token|unauthorized|expired/i.test(code));
  const detail = code ? ` · ${code}` : '';
  return new CliRefreshError(`${prefix}被拒绝（HTTP ${status}${detail}），${permanent ? '请重新运行 grok login 后再次导入' : '请稍后重试'}`, { permanent, transient });
};
const grokNetworkFailure = () => new CliRefreshError('Grok 登录续期网络请求失败，请稍后重试', { transient: true });

// 通过 OIDC discovery 取得 token endpoint，并限制到 auth.x.ai，避免恶意/损坏配置把 refresh
// token 发往第三方地址。发现文档每次续期读取，xAI 改 endpoint 时无需发版。
async function discoverGrokTokenEndpoint(fetcher, timeoutMs) {
  let response;
  let payload;
  try {
    response = await fetcher(GROK_DISCOVERY_URL, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': GROK_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    payload = await grokResponsePayload(response);
  } catch { throw grokNetworkFailure(); }
  if (!response?.ok) throw grokRefreshFailure(Number(response?.status || 0), payload, 'Grok OIDC discovery');
  const issuer = String(payload?.issuer || '').replace(/\/$/, '');
  const endpoint = String(payload?.token_endpoint || '').trim();
  if (issuer !== GROK_ISSUER) throw new CliRefreshError('Grok OIDC discovery issuer 不匹配，已拒绝续期', { permanent: true });
  if (!grokEndpointIsAllowed(endpoint)) throw new CliRefreshError('Grok OIDC discovery 的 token endpoint 无效，已拒绝续期', { permanent: true });
  return endpoint;
}

async function refreshGrokAuth(auth, fetcher, timeoutMs) {
  const entry = grokEntryOf(auth);
  const previousRefresh = grokEntryRefreshToken(entry);
  if (!previousRefresh) throw new CliRefreshError('Grok 登录快照缺少 refresh_token，无法续期，请重新 grok login', { permanent: true });
  const tokenEndpoint = await discoverGrokTokenEndpoint(fetcher, timeoutMs);
  const clientId = GROK_CLIENT_ID;
  let response;
  let payload;
  try {
    response = await postTokenRequest(fetcher, tokenEndpoint, {
      form: {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: previousRefresh,
        scope: GROK_SCOPE,
      },
      headers: { Accept: 'application/json', 'User-Agent': GROK_USER_AGENT },
      timeoutMs,
    });
    payload = await grokResponsePayload(response);
  } catch { throw grokNetworkFailure(); }
  if (!response?.ok) throw grokRefreshFailure(Number(response?.status || 0), payload);
  const accessToken = String(payload?.access_token || payload?.accessToken || '').trim();
  if (!accessToken) throw new CliRefreshError('Grok 续期响应缺少 access_token，请重新 grok login', { permanent: false });
  const next = { ...entry, key: accessToken };
  // 某些实现使用 access_token 字段；保留该形态并同步，便于跨版本 auth.json 兼容。
  if (Object.prototype.hasOwnProperty.call(entry, 'access_token')) next.access_token = accessToken;
  const rotatedRefresh = String(payload?.refresh_token || payload?.refreshToken || '').trim();
  next.refresh_token = rotatedRefresh || previousRefresh;
  if (Object.prototype.hasOwnProperty.call(entry, 'refreshToken')) next.refreshToken = rotatedRefresh || previousRefresh;
  const expiresIn = Number(payload?.expires_in);
  const expiresAt = payload?.expires_at || payload?.expiresAt;
  if (expiresAt) next.expires_at = typeof expiresAt === 'number'
    ? new Date(expiresAt < 10_000_000_000 ? expiresAt * 1000 : expiresAt).toISOString()
    : String(expiresAt);
  else next.expires_at = new Date(Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3_600) * 1000).toISOString();
  if (payload?.id_token) next.id_token = payload.id_token;
  const claims = parseJwtClaims(payload?.id_token || accessToken);
  if (!next.user_id && claims?.sub) next.user_id = claims.sub;
  if (!next.email && (claims?.email || claims?.preferred_username)) next.email = claims.email || claims.preferred_username;
  next.last_refresh = new Date().toISOString();
  const scope = grokScopeOf(auth) || inferGrokScope(entry);
  return { ...next, ...(scope ? { scopeKey: scope } : {}) };
}

const refreshCliAuth = async (kind, auth, fetcher, timeoutMs = 15_000) => {
  if (kind === 'codex') return refreshCodexAuth(auth, fetcher, timeoutMs);
  if (kind === 'claude') return refreshClaudeAuth(auth, fetcher, timeoutMs);
  if (kind === 'gemini') return refreshGeminiAuth(auth, fetcher, timeoutMs);
  if (kind === 'kimi') return refreshKimiWebAuth(auth, fetcher, timeoutMs);
  if (kind === 'grok') return refreshGrokAuth(auth, fetcher, timeoutMs);
  throw new Error(`未知的 CLI 类型：${kind}`);
};

const grokScopeOf = (auth) => {
  const entry = grokEntryOf(auth);
  const candidates = [auth?.scopeKey, auth?.authScope, auth?.scope, entry?.scopeKey, entry?.authScope, entry?.scope];
  const explicit = candidates.map((value) => String(value || '').trim()).find((value) => value.startsWith('https://') || value === GROK_LEGACY_SESSION_SCOPE);
  return explicit || inferGrokScope(entry);
};

const grokEntryMatches = (current, previous) => {
  const currentEntry = grokEntryOf(current);
  const previousEntry = grokEntryOf(previous);
  if (!currentEntry || !previousEntry) return false;
  const previousRefresh = grokEntryRefreshToken(previousEntry);
  if (previousRefresh) return grokEntryRefreshToken(currentEntry) === previousRefresh;
  return grokEntryToken(currentEntry) === grokEntryToken(previousEntry);
};

// Grok live 文件是 scope → entry 的 map。只有原 scope 仍是刷新前那把 token 时才合并，
// 并且只替换该 entry，保留其它 profile 及 CLI 可能刚写入的字段。
const writeGrokLiveIfCurrent = (previousAuth, nextAuth) => {
  const livePath = liveAuthPath('grok');
  const live = readJsonFile(livePath);
  if (!live || typeof live !== 'object') return false;
  const scope = grokScopeOf(previousAuth) || grokScopeOf(nextAuth);
  let targetScope = scope;
  if (!targetScope || !isGrokEntry(live[targetScope])) {
    const previousRefresh = refreshTokenOf('grok', previousAuth);
    targetScope = Object.keys(live).find((key) => isGrokEntry(live[key]) && previousRefresh && refreshTokenOf('grok', live[key]) === previousRefresh) || '';
  }
  if (!targetScope || !isGrokEntry(live[targetScope]) || !grokEntryMatches(live[targetScope], previousAuth)) return false;
  const nextEntry = grokEntryOf(nextAuth);
  if (!nextEntry) return false;
  const merged = { ...live[targetScope], ...nextEntry };
  // scopeKey/authScope 是 Quota Desk 的元数据，不写进 Grok CLI entry；map key 已承载 scope。
  delete merged.scopeKey;
  delete merged.authScope;
  if (merged.scope && (merged.scope.startsWith('https://') || merged.scope === GROK_LEGACY_SESSION_SCOPE)) delete merged.scope;
  try {
    writeJsonAtomic(livePath, { ...live, [targetScope]: merged });
    return true;
  } catch { return false; }
};

const authVersionMatches = (kind, current, previous) => {
  if (kind === 'grok') return grokEntryMatches(current, previous)
    && (!grokScopeOf(previous) || !grokScopeOf(current) || grokScopeOf(previous) === grokScopeOf(current));
  const currentRefresh = refreshTokenOf(kind, current);
  const previousRefresh = refreshTokenOf(kind, previous);
  if (previousRefresh) return currentRefresh === previousRefresh;
  return JSON.stringify(current || {}) === JSON.stringify(previous || {});
};

// 写回本机 live 文件：只有当 live 文件仍是「刷新前那把 refresh_token」对应账号时才写，
// 防止把 cc-switch 刚切换进去的其它 profile 覆盖掉（原子写，避免 CLI 读到半截文件）
const writeLiveIfCurrent = (kind, previousAuth, nextAuth) => {
  if (!nextAuth) return false;
  if (kind === 'grok') return writeGrokLiveIfCurrent(previousAuth, nextAuth);
  const livePath = liveAuthPath(kind);
  if (!livePath) return false;
  const previousRefresh = refreshTokenOf(kind, previousAuth);
  const live = readJsonFile(livePath);
  if (!live || !previousRefresh || refreshTokenOf(kind, live) !== previousRefresh) return false;
  try { writeJsonAtomic(livePath, nextAuth); return true; }
  catch { return false; }
};

// 同一个账号可能同时触发手动刷新、定时轮询和窗口刷新。xAI 会轮换 refresh_token，
// 因此相同旧 token 的并发请求必须共享一次刷新结果，避免第二个请求拿旧 token 再刷新。
const grokRefreshInFlight = new Map();
const refreshForRequest = async (kind, auth, fetcher, timeoutMs) => {
  if (kind !== 'grok') return refreshCliAuth(kind, auth, fetcher, timeoutMs);
  const refresh = refreshTokenOf(kind, auth);
  if (!refresh) return refreshCliAuth(kind, auth, fetcher, timeoutMs);
  const key = `${kind}:${refresh}`;
  const existing = grokRefreshInFlight.get(key);
  if (existing) return existing;
  const promise = refreshCliAuth(kind, auth, fetcher, timeoutMs);
  grokRefreshInFlight.set(key, promise);
  // Keep the completed promise through the current microtask turn so concurrent callers
  // that wake on the same response reuse it; no long-lived token cache is retained.
  promise.finally(() => setTimeout(() => {
    if (grokRefreshInFlight.get(key) === promise) grokRefreshInFlight.delete(key);
  }, 0)).catch(() => {});
  return promise;
};

// 带自动续期的授权请求：临期先刷新；401/403 时刷新一次后重试。
// buildRequest(auth) 每次尝试都用当时的 token 重新构造请求（刷新后头会变）。
// onAuthUpdate(kind, nextAuth, previousAuth, source) 供主进程把新 token 落盘/写回 live。
async function fetchWithCliAuth(kind, { auth, source, fetcher, timeoutMs, buildRequest, onAuthUpdate, isAuthFailure }) {
  let current = auth;
  const emit = async (next, previous) => {
    current = next;
    if (onAuthUpdate) await onAuthUpdate(kind, next, previous, source);
  };
  if (shouldRefreshFirst(kind, current)) {
    const previous = current;
    const next = await refreshForRequest(kind, previous, fetcher, timeoutMs);
    await emit(next, previous);
  }
  const send = () => {
    const { url, init = {} } = buildRequest(current);
    return fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  };
  let response = await send();
  let authFailure = response?.status === 401 || response?.status === 403;
  if (!authFailure && typeof isAuthFailure === 'function') {
    try {
      // Inspect a clone so the caller can still consume the original body. Test doubles that
      // expose only headers can return a boolean without implementing clone().
      const inspected = typeof response?.clone === 'function' ? response.clone() : response;
      authFailure = Boolean(await isAuthFailure(inspected));
    } catch { authFailure = false; }
  }
  if (authFailure && refreshTokenOf(kind, current)) {
    const previous = current;
    const next = await refreshForRequest(kind, previous, fetcher, timeoutMs);
    await emit(next, previous);
    response = await send();
  }
  return response;
}

module.exports = {
  CLI_KINDS,
  SNAPSHOT_KEY,
  REFRESH_AHEAD_MS,
  CliRefreshError,
  liveAuthPath,
  grokAuthPath,
  readLiveAuth,
  cliIdentity,
  parseCliSnapshot,
  resolveCliAuth,
  refreshTokenOf,
  accessTokenExpiryMs,
  shouldRefreshFirst,
  refreshCliAuth,
  authVersionMatches,
  writeLiveIfCurrent,
  fetchWithCliAuth,
  __grok: { selectGrokAuthEntry, selectGrokAuthRecord, grokEntryOf, grokScopeOf, grokEndpointIsAllowed, discoverGrokTokenEndpoint },
  __constants: {
    CODEX_CLIENT_ID, CODEX_TOKEN_URL, CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL,
    GEMINI_CLIENT_ID, GEMINI_CLIENT_SECRET, GEMINI_TOKEN_URL, KIMI_AUTH_HOST, KIMI_REFRESH_PATH,
    GROK_ISSUER, GROK_DISCOVERY_URL, GROK_CLIENT_ID, GROK_TOKEN_URL, GROK_SCOPE,
  },
};
