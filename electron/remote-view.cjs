const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveWasteWindows } = require('./waste.cjs');

const REMOTE_PORT = 43187;
const WINDOW_FIELDS = ['key', 'remaining', 'used', 'total', 'unit', 'resetAt', 'available', 'amount', 'limitAmount'];
const HISTORY_FIELDS = ['remaining', 'amount', 'limit', 'unit', 'resetAt'];
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

const pick = (source, fields) => Object.fromEntries(fields.filter((field) => source?.[field] !== undefined).map((field) => [field, source[field]]));
const safeText = (value, max = 120) => String(value ?? '').slice(0, max);
const safeNumber = (value) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);

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

const isAuthorized = (header, token) => {
  const provided = /^Bearer (\S+)$/.exec(String(header || ''))?.[1] || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(String(token || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
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

function createRemoteViewServer({ store, distDir, getToken, getHistory, getCycles, getUsage, port = REMOTE_PORT }) {
  const server = http.createServer((request, response) => {
    setHeaders(response);
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'method_not_allowed' });
    let pathname;
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch { return json(response, 400, { error: 'bad_request' }); }

    if (pathname.startsWith('/api/')) {
      if (!isAuthorized(request.headers.authorization, getToken())) return json(response, 401, { error: 'unauthorized' });
      if (pathname === '/api/snapshot') return json(response, 200, publicSnapshot(store.loadState()));
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
      return json(response, 404, { error: 'not_found' });
    }

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
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { REMOTE_PORT, createRemoteViewServer, publicSnapshot, publicHistory };
