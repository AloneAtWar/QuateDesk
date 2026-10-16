import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDemoBridge } from '../src/demo/bridge.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { captureBrowserDemo } = require('../scripts/capture-browser-demo.cjs');
const snapshot = JSON.parse(fs.readFileSync(new URL('../src/demo/snapshot.json', import.meta.url), 'utf8'));
const now = Date.parse(snapshot.capturedAt);
const sum = (rows, key = 'totalTokens') => rows.reduce((total, row) => total + row[key], 0);
const query = { agent: 'all', timezone: 'Asia/Shanghai' };

test('capture uses explicit safe fields and never reads credentials or exports identities', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-demo-test-'));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const sourceState = { accounts: [{ id: 'private-account-id', providerId: 'private-provider', name: 'private-name', identity: 'private@mail.invalid', endpoint: 'https://private.example/key=private-secret', variables: { token: 'private-secret' }, windows: [{ key: 'weekly', remaining: 41, resetAt: Date.parse('2026-10-20T00:00:00Z'), unit: '%' }, { key: 'five_hour', remaining: 75, resetAt: String(Date.parse('2026-10-20T00:00:00Z') / 1000), unit: '%' }] }], providers: [{ id: 'private-provider', name: 'private-brand', requestConfig: { headers: { Authorization: 'private-secret' }, script: 'private-secret' } }] };
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(sourceState));
  fs.writeFileSync(path.join(directory, 'credentials.json'), 'deliberately invalid JSON: private-secret');
  const db = new DatabaseSync(path.join(directory, 'cli-usage.sqlite'));
  db.exec(`CREATE TABLE source_files(agent TEXT);
    CREATE TABLE usage_events(occurred_at_ms INTEGER, agent TEXT, model TEXT, input_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, output_tokens INTEGER, extra_tokens INTEGER,
      total_tokens INTEGER, session_key TEXT);
    INSERT INTO usage_events VALUES(1792108800000, 'codex', 'gpt-5.4', 10, 20, 0, 5, 0, 35, 'private-session');`);
  db.close();
  const outputPath = path.join(directory, 'output', 'snapshot.json');
  await captureBrowserDemo({ dataDir: directory, outputPath, now: Date.parse('2026-10-17T00:00:00Z') });
  const output = fs.readFileSync(outputPath, 'utf8');
  assert.doesNotMatch(output, /private-|private@|Authorization|credential|script|[A-Z]:\\|\/Users\//i);
  const result = JSON.parse(output);
  assert.equal(result.accounts[0].windows[0].remaining, 41);
  assert.ok(result.accounts[0].windows.every((meter) => meter.resetAt === '2026-10-20T00:00:00.000Z'));
  assert.equal(result.localUsage.rows[0].totalTokens, 35);
  assert.deepEqual(result.localUsage.rows[0].sessions, [1]);
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), JSON.stringify(sourceState));
});

test('saved snapshot contains complete data screens and only anonymous account identities', () => {
  assert.ok(snapshot.accounts.length > 0);
  assert.ok(Object.values(snapshot.history).some((rows) => rows.length > 1));
  assert.ok(Object.values(snapshot.cycles).some((rows) => rows.length > 0));
  assert.ok(snapshot.localUsage.rows.length > 0);
  assert.ok(snapshot.accounts.every((account) => /^demo-account-\d+$/.test(account.id) && /@example\.test$/.test(account.identity)));
  assert.equal(snapshot.provenance.providerUsage, 'deterministic-synthetic');
});

test('local totals and session counts agree across heatmap and model breakdown', async () => {
  const bridge = createDemoBridge(snapshot, { now });
  const report = await bridge.getLocalCliUsageSummary(query);
  const models = await bridge.getLocalCliUsageModels({ ...query, scope: { kind: 'range', days: 0 } });
  assert.equal(report.days.length, 365);
  assert.equal(report.summary.totalTokens, sum(snapshot.localUsage.rows));
  assert.equal(sum(models.models), report.summary.totalTokens);
  const sessions = new Set(snapshot.localUsage.rows.flatMap((row) => row.sessions));
  assert.equal(report.summary.sessions, sessions.size);
  assert.ok(Math.abs(sum(models.models, 'share') - 1) < 1e-10);
  const activeDay = report.days.find((day) => day.totalTokens > 0);
  const dayModels = await bridge.getLocalCliUsageModels({ ...query, scope: { kind: 'day', date: activeDay.date } });
  assert.equal(sum(dayModels.models), activeDay.totalTokens);
});

test('channel, model, range and merge filters preserve totals', async () => {
  const bridge = createDemoBridge(snapshot, { now });
  const first = snapshot.localUsage.rows[0];
  const rules = [{ mode: 'exact', value: first.canonical }];
  const report = await bridge.getLocalCliUsageSummary({ ...query, agent: first.agent, modelRules: rules });
  assert.equal(report.summary.totalTokens, sum(snapshot.localUsage.rows.filter((row) => row.agent === first.agent && row.canonical === first.canonical)));
  assert.equal(report.matchedModels.length, 1);
  const all = await bridge.getLocalCliUsageModels({ ...query, scope: { kind: 'range', days: 0 }, mergeSameModels: false });
  assert.equal(sum(all.models), sum(snapshot.localUsage.rows));
  assert.ok(all.models.every((model) => model.agents.length === 1));
  const recent = await bridge.getLocalCliUsageModels({ ...query, scope: { kind: 'range', days: 7 } });
  const full = await bridge.getLocalCliUsageSummary(query);
  assert.equal(sum(recent.models), sum(full.days.slice(-7)));
  const regex = await bridge.getLocalCliUsageSummary({ ...query, modelRules: [{ mode: 'regex', value: '^gpt-' }] });
  assert.ok(regex.matchedModels.every((model) => model.key.startsWith('gpt-')));
});

test('future preview dates keep the same values and relative reset times without changing Date', async () => {
  const originalNow = Date.now;
  const before = createDemoBridge(snapshot, { now });
  const future = createDemoBridge(snapshot, { now: now + 50 * 86_400_000 });
  const left = await before.getLocalCliUsageSummary(query);
  const right = await future.getLocalCliUsageSummary(query);
  assert.deepEqual(left.summary, right.summary);
  assert.deepEqual(left.days.map((day) => day.totalTokens), right.days.map((day) => day.totalTokens));
  const stateA = await before.loadState(); const stateB = await future.loadState();
  const meterA = stateA.accounts.flatMap((account) => account.windows).find((meter) => meter.resetAt);
  const meterB = stateB.accounts.flatMap((account) => account.windows).find((meter) => meter.resetAt);
  assert.equal(Date.parse(meterB.resetAt) - Date.parse(meterA.resetAt), 50 * 86_400_000);
  assert.equal(Date.now, originalNow);
});

test('edits and clears stay in one page session; a fresh page restores the snapshot', async () => {
  const bridge = createDemoBridge(snapshot, { now });
  const state = await bridge.loadState();
  const id = state.accounts[0].id;
  state.accounts[0].name = '临时编辑';
  await bridge.saveState(state);
  assert.equal((await bridge.loadState()).accounts[0].name, '临时编辑');
  await bridge.clearHistory();
  assert.deepEqual(await bridge.getHistory(id), []);
  await assert.rejects(bridge.saveCredential(id, 'do-not-store'), /不保存凭据/);
  const fresh = createDemoBridge(snapshot, { now });
  assert.equal((await fresh.loadState()).accounts[0].name, snapshot.accounts[0].name);
  assert.ok((await fresh.getHistory(id)).length > 0);
  const sources = await fresh.scanLocalCliUsage();
  sources[0].records = -1;
  assert.notEqual((await fresh.getLocalCliUsageSources())[0].records, -1);
});

test('official examples are deterministic and keep their totals separate from local CLI records', async () => {
  const bridge = createDemoBridge(snapshot, { now });
  const state = await bridge.loadState();
  const account = state.accounts.find((account) => account.usageConnection.supported);
  assert.ok(account);
  const report = await bridge.getProviderUsage(account.id);
  assert.deepEqual(report, await bridge.getProviderUsage(account.id));
  assert.equal(report.days.length, 365);
  assert.equal(report.summary.totalTokens, sum(report.days, 'tokens'));
  assert.equal(report.provider, account.providerId);
  await bridge.disconnectProviderUsage(account.id);
  assert.equal((await bridge.loadState()).accounts.find((row) => row.id === account.id).usageConnection.status, 'disconnected');
  await bridge.connectProviderUsage(account.id);
  assert.equal((await bridge.loadState()).accounts.find((row) => row.id === account.id).usageConnection.status, 'connected');
});
