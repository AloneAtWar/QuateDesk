const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveWasteWindows } = require('./waste.cjs');
const { CliUsageService } = require('./cli-usage/index.cjs');
const { handleApiV1 } = require('./api-v1.cjs');

const REMOTE_PORT = 43187;
// 手机 App 4 位配对码会话：内存保存、5 分钟有效、最多 8 个并存；批准后 60 秒内可领取
const PAIRING_SESSION_TTL_MS = 5 * 60_000;
const PAIRING_SESSION_LIMIT = 8;
const PAIRING_CLAIM_GRACE_MS = 60_000;
const WINDOW_FIELDS = ['key', 'remaining', 'used', 'total', 'unit', 'resetAt', 'available', 'amount', 'limitAmount'];
const HISTORY_FIELDS = ['remaining', 'amount', 'limit', 'unit', 'resetAt'];
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
// 本机预览：仅当请求来自电脑本机回环地址时允许免配对码换只读令牌
const isLoopbackRequest = (request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(request.socket?.remoteAddress || ''));
// Host 白名单:DNS rebinding 会把外部域名解析到本机,浏览器视其为同源,仅靠 socket 地址拦不住。
// Host 不是本机地址的 API 请求必须携带有效令牌(经内网穿透/自定义域名访问的已配对设备靠令牌放行)
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const normalizeHost = (host) => {
  const value = String(host || '').trim().toLowerCase();
  const bracket = /^\[(.+)\](?::\d+)?$/.exec(value);
  return bracket ? `[${bracket[1]}]` : value.replace(/:\d+$/, '');
};

const pick = (source, fields) => Object.fromEntries(fields.filter((field) => source?.[field] !== undefined).map((field) => [field, source[field]]));
const safeText = (value, max = 120) => String(value ?? '').slice(0, max);
const safeNumber = (value) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
const safeInteger = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const publicRemoteSettings = (settings = {}) => ({
  alerts: settings.alerts !== false,
  showUpcomingRefresh: settings.showUpcomingRefresh !== false,
  pollMinutes: [5, 10, 15, 30].includes(Number(settings.pollMinutes)) ? Number(settings.pollMinutes) : 5,
  reminderRules: (Array.isArray(settings.reminderRules) ? settings.reminderRules : []).slice(0, 20).map((rule, index) => ({
    id: safeText(rule?.id || `rule-${index + 1}`, 80),
    label: safeText(rule?.label, 80),
    beforeMinutes: safeInteger(rule?.beforeMinutes, 1, 10080, 120),
    minRemaining: safeInteger(rule?.minRemaining, 0, 100, 50),
  })),
});

const readJsonBody = (request, limit = 16 * 1024) => new Promise((resolve, reject) => {
  let size = 0;
  let tooLarge = false;
  const chunks = [];
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) { tooLarge = true; chunks.length = 0; }
    else if (!tooLarge) chunks.push(chunk);
  });
  request.on('error', reject);
  request.on('end', () => {
    if (tooLarge) return reject(new Error('body_too_large'));
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { reject(new Error('invalid_json')); }
  });
});

const publicWindow = (meter) => ({
  ...pick(meter, WINDOW_FIELDS.filter((field) => ['key', 'unit', 'resetAt', 'available'].includes(field))),
  key: safeText(meter?.key, 60),
  remaining: safeNumber(meter?.remaining),
  used: safeNumber(meter?.used),
  total: safeNumber(meter?.total),
  amount: safeNumber(meter?.amount),
  limitAmount: safeNumber(meter?.limitAmount),
});

const publicSnapshot = (state) => {
  const providers = new Map((state?.providers || []).map((provider) => [provider.id, provider]));
  return {
    lastSync: state?.lastSync || null,
    pollMinutes: Math.min(30, Math.max(1, Number(state?.settings?.pollMinutes) || 5)),
    settings: publicRemoteSettings(state?.settings),
    providers: (state?.providers || []).map((provider) => ({
      id: safeText(provider.id, 80),
      name: safeText(provider.name),
      monogram: safeText(provider.monogram, 4),
      tone: safeText(provider.tone, 24),
      logo: typeof provider.logo === 'string' && (provider.logo.startsWith('./logos/') || /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/.test(provider.logo)) ? provider.logo : null,
    })),
    accounts: (state?.accounts || []).map((account) => ({
      id: safeText(account.id, 120),
      name: safeText(account.name),
      identity: safeText(account.identity),
      provider: safeText(providers.get(account.providerId)?.name || account.providerId),
      providerId: safeText(account.providerId, 80),
      usageSupported: ['deepseek', 'zai', 'codex', 'minimax'].includes(account.providerId) && account.usageConnection?.supported !== false,
      usageStatus: ['connected', 'reauth_required'].includes(account.usageConnection?.status)
        ? account.usageConnection.status
        : account.usageConnection?.connected === true ? 'connected' : 'disconnected',
      wasteWindows: (() => {
        const available = resolveWasteWindows(providers.get(account.providerId)?.requestConfig);
        const tracked = Array.isArray(account.windowKeys) && account.windowKeys.length
          ? account.windowKeys
          : (Array.isArray(account.windows) && account.windows.length ? account.windows.map((meter) => meter.key) : null);
        return tracked ? available.filter((key) => tracked.includes(key)) : available;
      })(),
      tags: (Array.isArray(account.tags) ? account.tags : []).slice(0, 4).map((tag) => safeText(tag, 40)),
      disabled: Boolean(account.disabled),
      status: account.status === 'warning' ? 'warning' : 'active',
      lastChecked: account.lastChecked || null,
      windows: (Array.isArray(account.windows) ? account.windows : []).map(publicWindow),
    })),
  };
};

const publicUsage = (data) => {
  const summary = data?.summary || {};
  const numericSummary = ['totalCost', 'rangeCost', 'knownRangeCost', 'totalTokens', 'rangeTokens', 'knownRangeTokens', 'peakDailyTokens', 'peakDailyCost', 'currentStreakDays', 'longestStreakDays'];
  const days = (Array.isArray(data?.days) ? data.days : []).map((day) => ({
    date: safeText(day?.date, 10), cost: safeNumber(day?.cost), tokens: safeNumber(day?.tokens),
    requests: safeNumber(day?.requests), currency: safeText(day?.currency, 16),
  })).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date)).sort((a, b) => a.date.localeCompare(b.date)).slice(-370);
  return {
    provider: safeText(data?.provider, 80),
    metric: safeText(data?.metric, 24),
    currency: safeText(data?.currency, 16),
    summary: {
      ...Object.fromEntries(numericSummary.map((key) => [key, safeNumber(summary[key])]).filter(([, value]) => value !== null)),
      ...(typeof summary.peakDailyTokensDate === 'string' ? { peakDailyTokensDate: safeText(summary.peakDailyTokensDate, 10) } : {}),
      ...(typeof summary.planName === 'string' ? { planName: safeText(summary.planName, 80) } : {}),
    },
    coverage: {
      timezoneOffsetSec: safeNumber(data?.coverage?.timezoneOffsetSec),
      cost: { complete: Boolean(data?.coverage?.cost?.complete) },
      tokens: { complete: Boolean(data?.coverage?.tokens?.complete) },
    },
    days,
  };
};

const publicHistory = (points, days) => {
  const cutoff = days === 0 ? 0 : Date.now() - days * 86_400_000;
  const filtered = (Array.isArray(points) ? points : []).filter((point) => Date.parse(point?.at) >= cutoff);
  // One view never needs tens of thousands of JSON rows. Keep the first and latest points.
  const stride = Math.max(1, Math.ceil((filtered.length - 1) / 799));
  const sampled = filtered.filter((_point, index) => index % stride === 0 || index === filtered.length - 1);
  return sampled.map((point) => ({
    at: point.at,
    windows: Object.fromEntries(Object.entries(point.windows || {}).map(([key, meter]) => [safeText(key, 60), pick(meter, HISTORY_FIELDS)])),
  }));
};

const setHeaders = (response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
};

const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

// 配对码会话仅在内存中存活；过期/已领取的顺手清掉
const prunePairingSessions = (sessions) => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (session.claimed
      || (session.approvedAt && now > session.approvedAt + PAIRING_CLAIM_GRACE_MS)
      || now > session.expiresAt) sessions.delete(sessionId);
  }
};

const sanitizeDeviceName = (value) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);

const pairingError = (message, status = 400) => Object.assign(new Error(message), { status });

// 手机端发起配对：签发 4 位配对码。同一台手机重复发起时沿用未确认的会话并续期，
// 避免电脑端同时挂出多条等待；并存会话的配对码互不重复，防止输码时配错对象
function initiatePairingSession(sessions, body) {
  prunePairingSessions(sessions);
  const deviceId = String(body?.id || '');
  const deviceName = sanitizeDeviceName(body?.name);
  if (!/^[\w-]{8,128}$/.test(deviceId)) throw pairingError('设备标识无效，请更新手机 App 后重试');
  if (!deviceName) throw pairingError('请填写设备名称');
  for (const session of sessions.values()) {
    if (session.deviceId === deviceId && !session.approvedAt) {
      session.expiresAt = Date.now() + PAIRING_SESSION_TTL_MS;
      return { sessionId: session.sessionId, code: session.code, expiresIn: Math.round(PAIRING_SESSION_TTL_MS / 1000) };
    }
  }
  while (sessions.size >= PAIRING_SESSION_LIMIT) {
    const oldest = [...sessions.entries()].sort(([, a], [, b]) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
  const liveCodes = new Set([...sessions.values()].map((session) => session.code));
  let code = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
  while (liveCodes.has(code)) code = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
  const session = {
    sessionId: crypto.randomBytes(24).toString('base64url'),
    code,
    deviceId,
    deviceName,
    createdAt: Date.now(),
    expiresAt: Date.now() + PAIRING_SESSION_TTL_MS,
    approvedAt: 0,
    claimed: false,
    token: '',
    server: null,
  };
  sessions.set(session.sessionId, session);
  return { sessionId: session.sessionId, code, expiresIn: Math.round(PAIRING_SESSION_TTL_MS / 1000) };
}

// 手机端领取：未确认返回 pending；已确认返回令牌与电脑身份信息（一次性，领完即焚）
function claimPairingSession(sessions, body) {
  prunePairingSessions(sessions);
  const session = sessions.get(String(body?.sessionId || ''));
  if (!session) throw pairingError('配对会话不存在或已过期，请重新发起配对', 404);
  if (!session.approvedAt) return { status: 'pending' };
  const payload = { status: 'ok', token: session.token, deviceId: session.deviceId, deviceName: session.deviceName, server: session.server };
  session.claimed = true;
  sessions.delete(session.sessionId);
  return payload;
}

// 本机用量查询参数 → CliUsageService 校验入参;modelRules 以 JSON 查询参数传入
const parseModelRulesParam = (url) => {
  const raw = url.searchParams.get('modelRules');
  if (raw == null || raw === '') return undefined;
  if (raw.length > 4096) throw new Error('模型规则过长');
  try { return JSON.parse(raw); } catch { throw new Error('模型规则格式无效'); }
};

// /api/cli-usage/*：只读镜像桌面端本机用量(聚合计数,不含对话内容)
function handleCliUsage({ pathname, url, request, response, cliUsage }) {
  const run = (promise) => Promise.resolve(promise).then((result) => json(response, 200, result)).catch((error) => {
    if (error?.name === 'CliUsageError') return json(response, 400, { error: 'cli_usage_invalid', message: error.message });
    json(response, 502, { error: 'cli_usage_unavailable' });
  });
  if (request.method === 'POST' && pathname === '/api/cli-usage/scan') {
    return run(cliUsage.scan().then(() => cliUsage.getSources()));
  }
  if (request.method !== 'GET') return json(response, 405, { error: 'method_not_supported' });
  if (pathname === '/api/cli-usage/sources') return run(cliUsage.getSources());
  if (pathname === '/api/cli-usage/summary') {
    let query;
    try {
      query = CliUsageService.normalizeSummaryQuery({
        agent: url.searchParams.get('agent') || 'all',
        timezone: url.searchParams.get('timezone') || '',
        endDate: url.searchParams.get('endDate'),
        modelRules: parseModelRulesParam(url),
      });
    } catch (error) { return json(response, 400, { error: 'cli_usage_invalid', message: error.message }); }
    return run(cliUsage.getSummary(query));
  }
  if (pathname === '/api/cli-usage/models') {
    const kind = url.searchParams.get('kind');
    let query;
    try {
      query = CliUsageService.normalizeModelsQuery({
        agent: url.searchParams.get('agent') || 'all',
        timezone: url.searchParams.get('timezone') || '',
        mergeSameModels: url.searchParams.get('merge') !== 'false',
        scope: kind === 'day' ? { kind, date: url.searchParams.get('date') } : kind === 'range' ? { kind, days: url.searchParams.get('days') } : null,
        modelRules: parseModelRulesParam(url),
      });
    } catch (error) { return json(response, 400, { error: 'cli_usage_invalid', message: error.message }); }
    return run(cliUsage.getModels(query));
  }
  return json(response, 404, { error: 'not_found' });
}

function createRemoteViewServer({ store, distDir, authorizeToken, pairDevice, pairLocalPreview, pairConfirmedDevice, discoveryInfo, getHistory, getCycles, getUsage, queryUsage, refreshAccounts, appVersion, cliUsage, port = REMOTE_PORT, allowedHosts = [] }) {
  let refreshInFlight = null;
  const hostAllowlist = new Set([...LOOPBACK_HOSTS, ...[].concat(allowedHosts)].map(normalizeHost));
  const pairingSessions = new Map();
  const serverInfo = () => (typeof discoveryInfo === 'function' ? discoveryInfo() : {});
  const withServerInfo = (result) => ({ ...result, server: serverInfo() });
  // 电脑版界面输入手机屏上的 4 位配对码：匹配会话后直接签发设备令牌，等手机来领取
  const confirmPairingCode = (code) => {
    prunePairingSessions(pairingSessions);
    const normalized = String(code || '').trim();
    if (!/^\d{4}$/.test(normalized)) throw pairingError('请输入 4 位数字配对码');
    const session = [...pairingSessions.values()].find((item) => item.code === normalized && !item.approvedAt);
    if (!session) throw pairingError('配对码无效或已过期，请在手机端重新发起配对');
    if (typeof pairConfirmedDevice !== 'function') throw pairingError('配对服务不可用', 503);
    const issued = pairConfirmedDevice({ id: session.deviceId, name: session.deviceName });
    session.approvedAt = Date.now();
    session.token = issued.token;
    session.server = serverInfo();
    return { deviceName: issued.deviceName || session.deviceName };
  };
  const pendingPairings = () => {
    prunePairingSessions(pairingSessions);
    return [...pairingSessions.values()].filter((session) => !session.approvedAt)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((session) => ({ deviceName: session.deviceName, createdAt: session.createdAt, expiresAt: session.expiresAt }));
  };
  const server = http.createServer((request, response) => {
    setHeaders(response);
    if (!['GET', 'HEAD', 'PATCH', 'POST'].includes(request.method)) return json(response, 405, { error: 'method_not_supported' });
    let pathname;
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch { return json(response, 400, { error: 'bad_request' }); }

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/pair' && request.method === 'POST') {
        if (typeof pairDevice !== 'function') return json(response, 503, { error: 'pairing_unavailable' });
        if (!/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] || ''))) return json(response, 415, { error: 'json_required' });
        readJsonBody(request, 4096).then((body) => {
          try {
            // 本机预览:电脑自己在 127.0.0.1 打开远程页,不需要配对码与设备信息;
            // Host 也必须是回环地址,防止外部域名经 DNS rebinding 冒充本机换取预览令牌
            if (body?.localPreview === true) {
              if (!isLoopbackRequest(request) || !LOOPBACK_HOSTS.has(normalizeHost(request.headers.host)) || typeof pairLocalPreview !== 'function') return json(response, 403, { error: 'local_preview_unavailable' });
              return json(response, 200, pairLocalPreview());
            }
            return json(response, 200, withServerInfo(pairDevice(body)));
          }
          catch (error) {
            const invalidPayload = /设备标识|设备名称/.test(error.message || '');
            return json(response, invalidPayload ? 400 : 403, { error: invalidPayload ? 'invalid_pairing_request' : 'pairing_key_invalid', message: error.message || '配对失败' });
          }
        }).catch((error) => json(response, error.message === 'body_too_large' ? 413 : error.message === 'invalid_json' ? 400 : 500, { error: error.message || 'pairing_failed' }));
        return;
      }
      // 手机 App 专用：局域网发现自述 / 4 位配对码会话。免 Bearer 令牌，但仍必须来自
      // 本机地址 Host（与数据接口同一条 DNS rebinding 防线），准入凭据是配对码/一次性 sessionId
      if (pathname === '/api/hello' || pathname === '/api/pair/initiate' || pathname === '/api/pair/claim') {
        if (!hostAllowlist.has(normalizeHost(request.headers.host))) return json(response, 421, { error: 'host_not_allowed' });
        if (pathname === '/api/hello') {
          if (request.method !== 'GET') return json(response, 405, { error: 'method_not_supported' });
          return json(response, 200, { app: 'quota-desk', version: safeText(appVersion, 40), ...serverInfo() });
        }
        if (request.method !== 'POST') return json(response, 405, { error: 'method_not_supported' });
        if (!/^application\/json(?:;|$)/i.test(String(request.headers['content-type'] || ''))) return json(response, 415, { error: 'json_required' });
        return readJsonBody(request, 4096).then((body) => {
          try {
            return json(response, 200, pathname === '/api/pair/initiate'
              ? initiatePairingSession(pairingSessions, body)
              : claimPairingSession(pairingSessions, body));
          }
          catch (error) {
            const status = Number(error?.status) || 400;
            return json(response, status, { error: status === 404 ? 'pairing_session_not_found' : 'pairing_request_invalid', message: error.message || '配对失败' });
          }
        }).catch((error) => json(response, error.message === 'body_too_large' ? 413 : error.message === 'invalid_json' ? 400 : 500, { error: error.message || 'pairing_failed' }));
      }
      const providedToken = /^Bearer (\S+)$/.exec(String(request.headers.authorization || ''))?.[1] || '';
      const tokenAuthorized = typeof authorizeToken === 'function' && authorizeToken(providedToken, { loopback: isLoopbackRequest(request) });
      if (!hostAllowlist.has(normalizeHost(request.headers.host)) && !tokenAuthorized) return json(response, 421, { error: 'host_not_allowed' });
      if (!tokenAuthorized) return json(response, 401, { error: 'unauthorized' });
      // v1 数据接口:与网页契约分离,自行处理方法与路由;项目目录名只对本机令牌展示
      if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
        const scope = typeof store.remoteTokenScope === 'function'
          ? store.remoteTokenScope(providedToken, { loopback: isLoopbackRequest(request) }) || 'device'
          : 'device';
        return handleApiV1({
          pathname, url, request, response, scope,
          deps: { store, cliUsage, getHistory, getCycles, getUsage, queryUsage, appVersion },
        });
      }
      if (pathname === '/api/refresh') {
        if (request.method !== 'POST') return json(response, 405, { error: 'method_not_supported' });
        if (typeof refreshAccounts !== 'function') return json(response, 503, { error: 'refresh_unavailable' });
        refreshInFlight ||= Promise.resolve().then(() => refreshAccounts()).finally(() => { refreshInFlight = null; });
        refreshInFlight.then(() => json(response, 200, { ...publicSnapshot(store.loadState()), readOnly: true }))
          .catch(() => json(response, 502, { error: 'refresh_failed' }));
        return;
      }
      if (request.method === 'POST' && pathname !== '/api/cli-usage/scan') return json(response, 405, { error: 'method_not_supported' });
      if (request.method === 'PATCH') {
        return pathname === '/api/settings'
          ? json(response, 403, { error: 'read_only' })
          : json(response, 405, { error: 'method_not_supported' });
      }
      if (pathname === '/api/snapshot') return json(response, 200, { ...publicSnapshot(store.loadState()), readOnly: true });
      if (pathname === '/api/history') {
        const accountId = url.searchParams.get('accountId') || '';
        const accounts = store.loadState()?.accounts || [];
        if (!accounts.some((account) => account.id === accountId)) return json(response, 404, { error: 'account_not_found' });
        const days = [1, 7, 30, 90, 0].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;
        return json(response, 200, { accountId, days, points: publicHistory(getHistory(accountId), days) });
      }
      if (pathname === '/api/cycles') {
        const accountId = url.searchParams.get('accountId') || '';
        if (!(store.loadState()?.accounts || []).some((account) => account.id === accountId)) return json(response, 404, { error: 'account_not_found' });
        const cycles = getCycles ? getCycles(accountId) : [];
        return json(response, 200, { accountId, cycles: (Array.isArray(cycles) ? cycles : []).map((cycle) => ({
          window: safeText(cycle?.window, 60), from: safeText(cycle?.from, 40), end: safeText(cycle?.end, 40),
          kind: ['natural', 'early'].includes(cycle?.kind) ? cycle.kind : 'unknown', observedAt: safeText(cycle?.observedAt, 40),
          remaining: safeNumber(cycle?.remaining), amount: safeNumber(cycle?.amount), limit: safeNumber(cycle?.limit),
          gapMs: safeNumber(cycle?.gapMs), reliable: Boolean(cycle?.reliable),
          refill: cycle?.refill ? {
            at: safeText(cycle.refill.at, 40), count: safeNumber(cycle.refill.count),
            remaining: safeNumber(cycle.refill.remaining), observedAt: safeText(cycle.refill.observedAt, 40),
          } : null,
        })) });
      }
      if (pathname === '/api/usage') {
        const accountId = url.searchParams.get('accountId') || '';
        const account = (store.loadState()?.accounts || []).find((item) => item.id === accountId);
        if (!account) return json(response, 404, { error: 'account_not_found' });
        if (!getUsage || !['deepseek', 'zai', 'codex', 'minimax'].includes(account.providerId) || account.usageConnection?.supported === false || (account.usageConnection?.status !== 'connected' && account.usageConnection?.connected !== true)) return json(response, 409, { error: 'usage_not_connected' });
        Promise.resolve(getUsage(accountId)).then((data) => {
          if (data?.provider !== account.providerId) return json(response, 502, { error: 'usage_unavailable' });
          return json(response, 200, publicUsage(data));
        }).catch(() => json(response, 502, { error: 'usage_unavailable' }));
        return;
      }
      if (pathname.startsWith('/api/cli-usage/')) {
        if (!cliUsage || typeof cliUsage.getSummary !== 'function') return json(response, 503, { error: 'cli_usage_unavailable' });
        return handleCliUsage({ pathname, url, request, response, cliUsage });
      }
      return json(response, 404, { error: 'not_found' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'method_not_supported' });

    const resource = pathname === '/' ? '/remote.html' : pathname;
    if (resource !== '/remote.html' && resource !== '/quota-desk.svg' && !/^\/(assets|logos)\/[\w.-]+$/.test(resource)) {
      return json(response, 404, { error: 'not_found' });
    }
    const filePath = path.join(distDir, resource.slice(1));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return json(response, 404, { error: 'not_found' });
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(filePath).pipe(response);
  });
  // 挂到 server 对象上：主进程 IPC（电脑版界面输码确认）与状态轮询直接调用，不改变 resolve 结构
  server.confirmPairingCode = confirmPairingCode;
  server.pendingPairings = pendingPairings;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Bind all interfaces so paired devices on the local network can reach the viewer.
    // External VPN/tunnel routing is intentionally configured outside Quota Desk.
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { REMOTE_PORT, createRemoteViewServer, publicSnapshot, publicHistory, publicRemoteSettings };
