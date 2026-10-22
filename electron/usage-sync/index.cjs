'use strict';

const crypto = require('node:crypto');
const { encrypt, decrypt, SyncError } = require('./crypto.cjs');
const { WebDavClient, normalizeConfig, HEAD_NAME } = require('./webdav.cjs');
const { discover, ensureKey, readPublished, loadSnapshot, publish, SnapshotError } = require('./protocol.cjs');

const UPLOAD_INTERVAL = 24 * 60 * 60 * 1000;
const PULL_INTERVAL = 30 * 60 * 1000;
const RETRY_INTERVAL = 15 * 60 * 1000;
const isId = (id) => typeof id === 'string' && HEAD_NAME.test(`${id}.json`);
const stamp = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;
const contextFor = (c) => crypto.createHash('sha256').update(JSON.stringify([c.endpoint, c.username, c.folder])).digest('hex');
const freshState = (context) => ({ version: 1, transportVersion: 2, context, lastUploadAt: 0, lastSuccessAt: 0, nextAttemptAt: 0, received: {}, ignored: [] });

function loadState(raw, context) {
  const clean = freshState(context);
  if (!raw || raw.version !== 1 || raw.context !== context) return clean;
  for (const field of ['lastUploadAt', 'lastSuccessAt', 'nextAttemptAt']) clean[field] = stamp(raw[field]);
  if (raw.transportVersion !== 2) { clean.lastUploadAt = 0; clean.nextAttemptAt = 0; }
  clean.lastError = typeof raw.lastError === 'string' ? raw.lastError.slice(0, 500) : '';
  clean.vaultId = isId(raw.vaultId) ? raw.vaultId : '';
  clean.lastResult = raw.lastResult && typeof raw.lastResult === 'object' ? {
    uploaded: Boolean(raw.lastResult.uploaded), added: stamp(raw.lastResult.added), updated: stamp(raw.lastResult.updated), skipped: stamp(raw.lastResult.skipped),
  } : null;
  if (raw.transportVersion === 2 && raw.received && typeof raw.received === 'object') {
    for (const [id, value] of Object.entries(raw.received).slice(0, 256)) {
      if (isId(id) && /^[a-f0-9]{64}$/.test(value?.fingerprint || '')) clean.received[id] = { fingerprint: value.fingerprint, revision: stamp(value.revision) };
    }
  }
  clean.ignored = (Array.isArray(raw.ignored) ? raw.ignored : []).filter((s) => isId(s?.sourceId)).slice(0, 256).map((s) => ({ sourceId: s.sourceId, label: String(s.label || '已移除来源').slice(0, 100) }));
  return clean;
}

class UsageSyncService {
  constructor({ storage, archives, fetcher, now = Date.now, onStatus = () => {}, onArchivesChanged = () => {}, connectionTestTimeoutMs = 30_000 }) {
    this.storage = storage;
    this.archives = archives;
    this.fetcher = fetcher;
    this.now = now;
    this.onStatus = onStatus;
    this.onArchivesChanged = onArchivesChanged;
    this.connectionTestTimeoutMs = connectionTestTimeoutMs;
    this.mode = '';
    this.promise = null;
    this.disposed = false;
    try { this.config = normalizeConfig(storage.loadUsageSyncConfig()); }
    catch { this.config = normalizeConfig(); this.loadError = '同步配置或系统凭据无法读取，请重新填写并保存配置'; }
    this.state = loadState(storage.loadUsageSyncState(), contextFor(this.config));
  }

  status() {
    const { enabled, endpoint, username, folder, password, passphrase } = this.config;
    return {
      config: { enabled, endpoint, username, folder, hasPassword: Boolean(password), hasPassphrase: Boolean(passphrase) },
      running: Boolean(this.promise), mode: this.mode, lastUploadAt: this.state.lastUploadAt || null,
      lastSuccessAt: this.state.lastSuccessAt || null, nextUploadAt: enabled ? (this.state.lastUploadAt ? this.state.lastUploadAt + UPLOAD_INTERVAL : this.now()) : null,
      nextCheckAt: enabled ? (this.state.nextAttemptAt || this.now()) : null,
      lastError: this.loadError || this.state.lastError || '', lastResult: this.state.lastResult || null,
      ignored: this.state.ignored.map((s) => ({ ...s })),
    };
  }

  notify() { this.onStatus(this.status()); }
  persist() { this.storage.saveUsageSyncState(this.state); }

  saveConfig(input) {
    if (this.promise) throw new SyncError('正在同步或测试连接，请结束后再修改配置');
    const next = normalizeConfig(input, this.config);
    const context = contextFor(next);
    const changed = ['endpoint', 'username', 'folder', 'password', 'passphrase'].some((key) => this.config[key] !== next[key]);
    this.storage.saveUsageSyncConfig(next);
    if (changed) {
      const ignored = context === this.state.context ? this.state.ignored : [];
      this.state = { ...freshState(context), ignored };
    }
    this.config = next;
    this.loadError = '';
    this.persist();
    this.notify();
    return this.status();
  }

  ignoreSource(sourceId, label) {
    if (this.promise) throw new SyncError('正在同步，请结束后再删除导入来源');
    if (!isId(sourceId)) throw new SyncError('来源标识无效');
    if (!this.state.ignored.some((s) => s.sourceId === sourceId)) this.state.ignored.push({ sourceId, label: String(label || '已移除来源').slice(0, 100) });
    delete this.state.received[sourceId];
    this.persist(); this.notify();
  }

  restoreSource(sourceId) {
    if (this.promise) throw new SyncError('正在同步，请结束后再恢复来源');
    this.state.ignored = this.state.ignored.filter((s) => s.sourceId !== sourceId);
    delete this.state.received[sourceId];
    this.state.nextAttemptAt = 0;
    this.persist(); this.notify();
    return this.status();
  }

  start() {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 60_000);
    this.timer.unref?.();
    this.startTimer = setTimeout(() => this.tick().catch(() => {}), 5_000);
    this.startTimer.unref?.();
  }

  tick() {
    if (this.disposed || !this.config.enabled || this.promise || this.now() < this.state.nextAttemptAt) return Promise.resolve(this.status());
    return this.run();
  }

  exclusive(mode, action) {
    if (this.disposed) return Promise.reject(new SyncError('同步服务已停止'));
    if (this.promise) return this.mode === mode ? this.promise : Promise.reject(new SyncError('正在同步或测试连接，请稍后再试'));
    this.mode = mode;
    this.controller = new AbortController();
    this.promise = Promise.resolve().then(action).finally(() => {
      this.promise = null; this.mode = ''; this.controller = null; this.notify();
    });
    this.notify();
    return this.promise;
  }

  client(config = this.config) { return new WebDavClient(config, { fetcher: this.fetcher, signal: this.controller.signal }); }

  testConnection(input) {
    return this.exclusive('test', async () => {
      const timer = setTimeout(() => this.controller?.abort('connection-test-timeout'), this.connectionTestTimeoutMs);
      try {
      const config = normalizeConfig(input ?? {}, this.config);
      normalizeConfig({ ...config, enabled: true });
      const dav = this.client(config);
      await dav.ensureFolder();
      const catalog = await discover(dav);
      const vaultId = await ensureKey(dav, catalog, config.passphrase);
      const probe = `probe-${crypto.randomUUID()}.json`;
      try {
        await dav.put(probe, await encrypt({ kind: 'probe', vaultId }, config.passphrase));
        const read = await dav.get(probe, null, 64 * 1024);
        const value = read.status === 200 ? await decrypt(read.body, config.passphrase) : null;
        if (value?.kind !== 'probe' || value.vaultId !== vaultId) throw new SyncError('WebDAV 读写或加密校验失败');
      } finally { await dav.remove(probe); }
      return { ok: true };
      } catch (error) {
        if (this.controller?.signal.reason === 'connection-test-timeout') throw new SyncError('连接测试超时，请检查网络、代理和 WebDAV 服务地址后重试');
        throw error;
      } finally { clearTimeout(timer); }
    });
  }

  run({ manual = false } = {}) {
    if (!this.config.enabled) return Promise.reject(new SyncError('请先保存并启用 WebDAV 同步'));
    return this.exclusive('sync', async () => {
      const result = { uploaded: false, added: 0, updated: 0, skipped: 0 };
      try {
        const dav = this.client();
        await dav.ensureFolder();
        const catalog = await discover(dav);
        const vaultId = await ensureKey(dav, catalog, this.config.passphrase);
        if (this.state.vaultId !== vaultId) {
          this.state.vaultId = vaultId;
          this.state.received = {};
          this.state.lastUploadAt = 0;
          this.persist();
        }
        const info = await this.archives.getArchiveInfo();
        const localId = info.local.sourceId;
        const existing = new Map(info.imported.map((s) => [s.sourceId, s]));
        for (const [sourceId, source] of catalog.sources) {
          if (sourceId === localId || this.state.ignored.some((s) => s.sourceId === sourceId)) { result.skipped++; continue; }
          const cached = this.state.received[sourceId];
          const published = await readPublished(dav, source, vaultId, this.config.passphrase);
          if (!published.heads.length) throw published.error;
          if (!manual && published.complete && cached?.fingerprint === published.fingerprint && cached.revision === existing.get(sourceId)?.revision) { result.skipped++; continue; }
          const { payload, plan } = await loadSnapshot(dav, published, vaultId, this.config.passphrase, (value) => this.archives.previewArchiveImport(value));
          const origin = payload.archives[0];
          if (plan[0].status === 'conflict') throw new SyncError('同一来源的相同版本存在内容冲突，已跳过更新；请检查是否复制了设备档案库');
          if (['added', 'updated'].includes(plan[0].status)) {
            const imported = await this.archives.importArchives(payload, `WebDAV · ${origin.label}`);
            for (const item of imported.results) {
              if (item.status === 'added') result.added++;
              else if (item.status === 'updated') result.updated++;
              else if (item.status === 'conflict') throw new SyncError('档案在同步期间出现同版本冲突，已保留原档案');
              else result.skipped++;
            }
            this.onArchivesChanged();
          } else result.skipped++;
          if (published.complete) this.state.received[sourceId] = { fingerprint: published.fingerprint, revision: Math.max(origin.revision, existing.get(sourceId)?.revision || 0) };
          else delete this.state.received[sourceId];
          this.persist();
        }
        if (manual || !this.state.lastUploadAt || this.now() >= this.state.lastUploadAt + UPLOAD_INTERVAL) {
          // Await an already running scan, but do not turn on scans the user disabled.
          if (this.archives.scanPromise) await this.archives.scanPromise;
          const payload = await this.archives.exportArchives('local');
          const local = payload.archives[0];
          const source = catalog.sources.get(localId);
          const previous = source ? await readPublished(dav, source, vaultId, this.config.passphrase) : null;
          if (previous && (previous.revision > local.revision || (previous.revision === local.revision && previous.heads.some((h) => h.dataHash !== local.dataHash)))) throw new SyncError('本机来源的云端版本较新或存在冲突，已停止上传，避免覆盖；请检查是否复制了设备档案库');
          let healthy = false;
          if (previous?.revision === local.revision) {
            try {
              await loadSnapshot(dav, previous, vaultId, this.config.passphrase, (value) => this.archives.previewArchiveImport(value));
              healthy = true;
            } catch (error) {
              // Only repair unavailable/corrupt content. Authentication and network
              // failures must not trigger extra publications or hide the real error.
              if (!(error instanceof SnapshotError)) throw error;
            }
          }
          if (!healthy) {
            await publish(dav, payload, vaultId, this.config.passphrase, this.now());
            result.uploaded = true;
          }
          this.state.lastUploadAt = this.now();
          this.persist();
        }
        this.state.lastSuccessAt = this.now();
        this.state.nextAttemptAt = this.now() + PULL_INTERVAL;
        this.state.lastError = '';
        this.state.lastResult = result;
        this.persist();
        return { ...this.status(), lastResult: result };
      } catch (error) {
        const message = error instanceof SyncError ? error.message : '用量同步失败，已保留本地档案；请检查本地存储空间后重试';
        this.state.lastError = message;
        this.state.nextAttemptAt = this.now() + RETRY_INTERVAL;
        try { this.persist(); } catch { /* Report the original failure even when local storage is unavailable. */ }
        throw new SyncError(message);
      }
    });
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer); clearTimeout(this.startTimer);
    this.controller?.abort();
  }
}

module.exports = { UsageSyncService, UPLOAD_INTERVAL, PULL_INTERVAL, RETRY_INTERVAL };
