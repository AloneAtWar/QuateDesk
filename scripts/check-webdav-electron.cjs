// Electron integration smoke: real safeStorage + Chromium net.fetch + CLI DB workers.
// Uses only temporary synthetic data and a loopback WebDAV server, never user profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Chromium holds userData files until process exit. A Node parent owns cleanup.
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-webdav-electron-'));
  let status = 1;
  try {
    const result = spawnSync(require('electron'), [__filename, temporary], { stdio: 'inherit', windowsHide: true });
    status = result.status ?? 1;
    if (result.error) throw result.error;
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  process.exit(status);
}

const { app, net } = require('electron');
const { DesktopStore } = require('../electron/storage.cjs');
const { CliUsageStore } = require('../electron/cli-usage/store.cjs');
const { createCliUsageService } = require('../electron/cli-usage/index.cjs');
const { UsageSyncService } = require('../electron/usage-sync/index.cjs');
const { mockWebDav } = require('../tests/helpers/mock-webdav.cjs');

const root = path.resolve(process.argv[2]);
assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
assert.ok(path.basename(root).startsWith('qd-webdav-electron-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
const cleanup = [];
const workers = [];
const services = [];
app.whenReady().then(async () => {
  try {
    const dav = await mockWebDav({ after: (fn) => cleanup.push(fn) });
    dav.ignoreConditions = true;
    dav.noEtags = true;
    for (const [index, label] of ['Office', 'Home'].entries()) {
      const dir = path.join(root, label); fs.mkdirSync(dir);
      app.setPath('userData', dir);
      const storage = new DesktopStore();
      const dbPath = path.join(dir, 'usage.sqlite');
      const seed = new CliUsageStore(dbPath);
      seed.archives.updateSource({ sourceId: seed.archives.sourceId, label });
      seed.upsertEvents([{ eventKey: 'fixture', agent: 'claude', rootId: 'fixture', occurredAtMs: Date.now(), sessionKey: 'fixture', projectKey: null,
        model: 'claude-sonnet-4-5', canonicalModelKey: 'claude-sonnet-4-5', inputTokens: (index + 1) * 100, cacheReadTokens: 0,
        cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, extraTokens: 0, totalTokens: (index + 1) * 100, requestCount: 1, sourceVersion: null, exact: true, isSidechain: false }]);
      seed.close();
      const worker = createCliUsageService({ dbPath }); workers.push(worker);
      const sync = new UsageSyncService({ storage, archives: worker, fetcher: (...args) => net.fetch(...args) }); services.push(sync);
      sync.saveConfig({ enabled: true, endpoint: dav.endpoint, username: 'sync-user', password: 'app-password-for-tests', passphrase: 'shared-electron-test-encryption-key', folder: 'QuotaDesk' });
      assert.equal(fs.readFileSync(storage.usageSyncConfigPath, 'utf8').includes('shared-electron-test-encryption-key'), false);
      assert.deepEqual(await sync.testConnection(), { ok: true });
    }
    await services[0].run({ manual: true });
    await services[1].run({ manual: true });
    await services[0].run({ manual: true });
    for (const worker of workers) {
      const info = await worker.getArchiveInfo();
      assert.equal(info.imported.length, 1);
      assert.equal(info.local.totalTokens + info.imported[0].totalTokens, 300);
    }
    console.log('PASS: Electron net.fetch WebDAV, safeStorage, DB workers, encrypted two-device sync (300 tokens each)');
  } finally {
    services.forEach((s) => s.dispose());
    const workerExits = workers.map((worker) => worker.worker ? new Promise((resolve) => worker.worker.once('exit', resolve)) : Promise.resolve());
    workers.forEach((w) => w.dispose());
    await Promise.all(workerExits);
    for (const fn of cleanup.reverse()) await fn();
  }
}).then(() => {
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
