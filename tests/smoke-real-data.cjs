// 本机真实数据 smoke:直接用 worker 扫描全部渠道并输出摘要(不进 git 产物)
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');

const dbPath = path.join(os.tmpdir(), `qd-smoke-${Date.now()}`, 'cli-usage.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const worker = new Worker(path.join(__dirname, '..', 'electron', 'cli-usage', 'worker.cjs'), { workerData: { dbPath } });
let nextId = 1;
const pending = new Map();
const call = (type, payload) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, type, payload });
});
worker.on('message', (message) => {
  if (message.type === 'ready') return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error?.message || 'worker error'));
});

(async () => {
  const scan = await call('scan', {});
  console.log('scan:', JSON.stringify(scan));
  const sources = await call('sources', {});
  for (const source of sources) {
    console.log(`${source.agent.padEnd(9)} ${String(source.status).padEnd(6)} records=${String(source.records).padStart(6)} files=${String(source.files).padStart(4)} ${source.warning || ''}`);
  }
  for (const agent of ['grok', 'gemini', 'openclaw', 'opencode', 'copilot', 'hermes', 'dsh']) {
    const summary = await call('summary', { agent, timezone: 'Asia/Shanghai', days: 365 });
    const models = await call('models', { agent, mergeSameModels: false, scope: { kind: 'range', days: 365 }, timezone: 'Asia/Shanghai' });
    console.log(`\n== ${agent}: total=${summary.summary.totalTokens} sessions=${summary.summary.sessions} days(active)=${summary.summary.activeDays} in=${summary.summary.inputTokens} cr=${summary.summary.cacheReadTokens} cw=${summary.summary.cacheWriteTokens} out=${summary.summary.outputTokens}`);
    for (const row of models.models.slice(0, 6)) {
      console.log(`   ${row.displayName.padEnd(36)} total=${String(row.totalTokens).padStart(12)} sessions=${String(row.sessions).padStart(4)}`);
    }
  }
  await worker.terminate();
})().catch((error) => { console.error('SMOKE FAILED:', error); process.exitCode = 1; return worker.terminate(); });
