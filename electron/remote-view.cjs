const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
      tags: (Array.isArray(account.tags) ? account.tags : []).slice(0, 4).map((tag) => safeText(tag, 40)),
      disabled: Boolean(account.disabled),
      status: account.status === 'warning' ? 'warning' : 'active',
      lastChecked: account.lastChecked || null,
      windows: (Array.isArray(account.windows) ? account.windows : []).map(publicWindow),
    })),
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

function createRemoteViewServer({ store, distDir, getToken, getHistory, port = REMOTE_PORT }) {
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
