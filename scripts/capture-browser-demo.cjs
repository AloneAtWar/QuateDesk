// Explicit, offline capture. Reads existing app data without opening credentials,
// scanning CLI folders, contacting providers, or writing to the source database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { canonicalModelKey } = require('../electron/cli-usage/normalize.cjs');

const AGENTS = ['zcode', 'kimi', 'claude', 'codex', 'copilot', 'gemini', 'grok', 'opencode', 'openclaw', 'hermes', 'dsh'];
const iso = (value) => {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' || /^\d{10,13}$/.test(String(value));
  const stamp = numeric ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
};
const number = (value) => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const read = (directory, name, fallback) => {
  const file = path.join(directory, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
};
const modelName = (value) => /^[\w][\w.:-]{0,100}(?:\/[\w.:-]{1,70})?$/.test(String(value || '')) ? String(value) : 'custom-model';

async function captureBrowserDemo({ dataDir, outputPath, now = Date.now() }) {
  const { providerCatalog, windowCatalog } = await import(pathToFileURL(path.join(__dirname, '../src/data.js')));
  const source = read(dataDir, 'state.json', null);
  if (!source?.accounts?.length) throw new Error('The selected data directory has no accounts.');
  const history = read(dataDir, 'history.json', {});
  const cycles = read(dataDir, 'cycles.json', {});
  const keys = new Set(Object.keys(windowCatalog));
  const unit = (value) => ['%', 'CNY', 'USD', '¥', '$', 'Credits', 'credits', 'requests', 'Token', 'tokens'].includes(value) ? value : '%';
  const snapshot = {
    version: 1,
    capturedAt: new Date(now).toISOString(),
    timezone: 'Asia/Shanghai',
    provenance: { accounts: 'anonymized-local-snapshot', history: 'anonymized-local-snapshot', cycles: 'anonymized-local-snapshot', localUsage: 'anonymized-local-aggregates', providerUsage: 'deterministic-synthetic' },
    accounts: [], providers: [], history: {}, cycles: {}, localUsage: { sources: [], rows: [] },
  };
  const meter = (row) => ({
    remaining: number(row.remaining), amount: number(row.amount), limit: number(row.limit ?? row.limitAmount),
    unit: unit(row.unit), resetAt: iso(row.resetAt),
  });
  const customProviders = new Map();
  for (const [index, account] of source.accounts.entries()) {
    const id = `demo-account-${String(index + 1).padStart(2, '0')}`;
    const originalProvider = (source.providers || []).find((provider) => provider.id === account.providerId);
    let provider = providerCatalog.find((candidate) => candidate.id === account.providerId);
    if (!provider) {
      if (!customProviders.has(account.providerId)) {
        const customIndex = customProviders.size + 1;
        customProviders.set(account.providerId, { id: `demo-provider-${customIndex}`, name: `自定义渠道 ${customIndex}`, legalName: `自定义渠道 ${customIndex}`, monogram: 'Q', tone: 'green', adapter: 'custom' });
      }
      provider = customProviders.get(account.providerId);
    }
    const windowKeys = [...new Set([...(account.windowKeys || []), ...(account.windows || []).map((row) => row.key)])].filter((key) => keys.has(key));
    const wasteWindows = (account.wasteWindows || originalProvider?.requestConfig?.wasteWindows || windowKeys.filter((key) => ['weekly', 'monthly'].includes(key))).filter((key) => keys.has(key));
    if (!snapshot.providers.some((candidate) => candidate.id === provider.id)) {
      snapshot.providers.push({ ...provider, requestConfig: { windows: windowKeys, wasteWindows } });
    }
    const official = ['deepseek', 'zai', 'codex', 'minimax'].includes(provider.id);
    snapshot.accounts.push({
      id, providerId: provider.id, name: `${provider.name} ${index + 1}`, identity: `account-${index + 1}@example.test`,
      tags: index === 0 ? ['主力'] : [], endpoint: 'https://example.invalid/quota', variables: {},
      windowKeys, wasteWindows, status: account.status === 'warning' ? 'warning' : 'active',
      lastError: account.status === 'warning' ? '本次额度读取失败，请稍后重试' : '',
      lastChecked: iso(account.lastChecked) || snapshot.capturedAt,
      disabled: account.disabled === true, disabledAt: iso(account.disabledAt),
      usageConnection: { supported: official, status: official ? 'connected' : 'disconnected' },
      windows: (account.windows || []).filter((row) => keys.has(row.key)).map((row) => ({ key: row.key, ...meter(row), limitAmount: number(row.limitAmount), used: number(row.used), total: number(row.total), available: row.available !== false })),
    });
    const points = (history[account.id] || []).filter((row) => iso(row.at));
    // Bound the fixture size while retaining the latest point and long view.
    const stride = Math.max(1, Math.ceil(points.length / 1200));
    snapshot.history[id] = points.filter((_, position) => position % stride === 0 || position === points.length - 1).map((point) => ({
      at: iso(point.at), windows: Object.fromEntries(Object.entries(point.windows || {}).filter(([key]) => keys.has(key)).map(([key, row]) => [key, meter(row)])),
    }));
    snapshot.cycles[id] = (cycles[account.id] || []).filter((row) => keys.has(row.window) && iso(row.end)).map((row) => ({
      window: row.window, kind: row.kind === 'natural' ? 'natural' : 'early', end: iso(row.end), from: iso(row.from),
      observedAt: iso(row.observedAt), remaining: number(row.remaining), amount: number(row.amount), limit: number(row.limit),
      unit: unit(row.unit), gapMs: number(row.gapMs), reliable: row.reliable === true,
    }));
  }
  const dbPath = path.join(dataDir, 'cli-usage.sqlite');
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec('BEGIN');
      const sessions = new Map();
      const rows = db.prepare(`SELECT date(occurred_at_ms / 1000, 'unixepoch', '+8 hours') AS date,
        agent, model, SUM(input_tokens) AS inputTokens, SUM(cache_read_tokens) AS cacheReadTokens,
        SUM(cache_write_tokens) AS cacheWriteTokens, SUM(output_tokens) AS outputTokens,
        SUM(extra_tokens) AS extraTokens, SUM(total_tokens) AS totalTokens,
        COUNT(*) AS requests, GROUP_CONCAT(DISTINCT session_key) AS sessionKeys
        FROM usage_events WHERE occurred_at_ms <= ? GROUP BY date, agent, model ORDER BY date, agent, model`).all(now);
      snapshot.localUsage.rows = rows.filter((row) => AGENTS.includes(row.agent)).map((row) => {
        const safeModel = modelName(row.model);
        return {
          date: row.date, agent: row.agent, model: safeModel, canonical: canonicalModelKey(safeModel),
          inputTokens: row.inputTokens, cacheReadTokens: row.cacheReadTokens, cacheWriteTokens: row.cacheWriteTokens,
          outputTokens: row.outputTokens, extraTokens: row.extraTokens, totalTokens: row.totalTokens, requests: row.requests,
          sessions: row.sessionKeys.split(',').map((key) => {
            const identity = `${row.agent}:${key}`;
            if (!sessions.has(identity)) sessions.set(identity, sessions.size + 1);
            return sessions.get(identity);
          }),
        };
      });
      snapshot.localUsage.sources = AGENTS.map((agent) => {
        const adapter = require(`../electron/cli-usage/adapters/${agent}.cjs`);
        const records = snapshot.localUsage.rows.filter((row) => row.agent === agent).reduce((sum, row) => sum + row.requests, 0);
        return { agent, displayName: adapter.displayName, iconKey: adapter.iconKey, colorToken: adapter.colorToken, rootLabels: ['本机记录'], status: records ? 'ready' : 'missing', records, files: db.prepare('SELECT COUNT(*) AS count FROM source_files WHERE agent = ?').get(agent).count, lastScannedAt: snapshot.capturedAt, warning: null };
      });
      db.exec('ROLLBACK');
    } finally { db.close(); }
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(snapshot)}\n`);
  return { accounts: snapshot.accounts.length, historyPoints: Object.values(snapshot.history).reduce((sum, rows) => sum + rows.length, 0), cycles: Object.values(snapshot.cycles).reduce((sum, rows) => sum + rows.length, 0), localDailyModelRows: snapshot.localUsage.rows.length, bytes: fs.statSync(outputPath).size };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : path.join(os.homedir(), '.config'));
  captureBrowserDemo({ dataDir: option('--data-dir') || path.join(appData, 'Quota Desk'), outputPath: option('--out') || path.join(__dirname, '../src/demo/snapshot.json') })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(`Demo capture failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { captureBrowserDemo };
