// CLI Usage Worker:拥有 cli-usage.sqlite 与全部适配器,主进程只通过消息交互。
// 单一扫描任务:新扫描请求在当前任务完成后立即排队执行一次。
const os = require('node:os');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { CliUsageStore, AGENT_ORDER } = require('./store.cjs');
const wsl = require('./wsl.cjs');
const adapters = {
  zcode: require('./adapters/zcode.cjs'),
  kimi: require('./adapters/kimi.cjs'),
  claude: require('./adapters/claude.cjs'),
  codex: require('./adapters/codex.cjs'),
  copilot: require('./adapters/copilot.cjs'),
  gemini: require('./adapters/gemini.cjs'),
  grok: require('./adapters/grok.cjs'),
  opencode: require('./adapters/opencode.cjs'),
  openclaw: require('./adapters/openclaw.cjs'),
  hermes: require('./adapters/hermes.cjs'),
  dsh: require('./adapters/dsh.cjs'),
};

const BATCH_SIZE = 500;

// 错误脱敏:去掉绝对路径与换行,只保留类型和短消息
const sanitizeError = (error) => {
  const home = os.homedir();
  let message = error?.message || String(error || 'unknown error');
  message = message.split(home).join('~');
  message = message.replace(/[A-Za-z]:\\[^\s'"]+/g, (match) => match.replace(/\\/g, '/')).split('\n').join(' ');
  return message.slice(0, 300);
};

class CliUsageWorker {
  constructor(dbPath) {
    this.store = new CliUsageStore(dbPath);
    this.scanState = new Map(); // agentId -> { status, warning, files }
    this.lastScanAt = null;
    this.scanning = false;
    this.rescanQueued = false;
  }

  combineRootStatuses(statuses) {
    if (!statuses.length) return 'missing';
    if (statuses.every((status) => status === 'missing')) return 'missing';
    const hasReady = statuses.includes('ready');
    const hasBad = statuses.some((status) => status === 'error' || status === 'incompatible');
    if (hasReady && hasBad) return 'partial';
    if (hasBad && !hasReady) return statuses.includes('incompatible') ? 'incompatible' : 'error';
    return 'ready';
  }

  async detectOnlyStatus() {
    const result = {};
    for (const id of AGENT_ORDER) {
      const adapter = adapters[id];
      let roots = [];
      try { roots = await adapter.detect(); } catch { roots = []; }
      result[id] = roots.some((root) => root.exists) ? 'ready' : 'missing';
    }
    return result;
  }

  async runScan() {
    // WSL 开关关闭时:扫描前先清除已入库的 WSL 事件/游标/登记,统计不再含 WSL
    if (!wsl.isWslEnabled()) this.store.purgeWslRoots();
    const runId = this.store.beginScanRun();
    let upserted = 0;
    let ok = true;
    let lastError = null;
    for (const id of AGENT_ORDER) {
      const adapter = adapters[id];
      const rootResults = new Map();
      try {
        const roots = await adapter.detect();
        this.store.registerRoots(id, roots);
        for (const root of roots) {
          rootResults.set(root.rootId, { status: root.exists ? 'ready' : 'missing', warning: null, files: 0 });
          if (!root.exists) continue;
          // 延迟撤回:适配器在生成器尾部登记,全部事件落库(含最后一批)后执行,
          // 避免"先删后补写"把已撤回的行复活
          const deferredDeletes = [];
          const ctx = {
            hmac: (value) => this.store.hmac(value),
            getFileState: (rootId, fileKey) => this.store.getFileState(id, rootId, fileKey),
            saveFileState: (rootId, fileKey, state) => this.store.saveFileState(id, rootId, fileKey, state),
            markRoot: (rootId, status, warning) => { rootResults.set(rootId, { status, warning, files: rootResults.get(rootId)?.files || 0 }); },
            deleteEvents: (predicate) => this.store.deleteEvents(id, predicate),
            deferDeleteEvents: (predicate) => deferredDeletes.push(predicate),
          };
          try {
            let batch = [];
            for await (const event of adapter.collect(root, ctx)) {
              event.rootId = root.rootId;
              batch.push(event);
              if (batch.length >= BATCH_SIZE) { upserted += this.store.upsertEvents(batch); batch = []; }
            }
            if (batch.length) upserted += this.store.upsertEvents(batch);
            for (const predicate of deferredDeletes) this.store.deleteEvents(id, predicate);
          } catch (error) {
            lastError = sanitizeError(error);
            ok = false;
            rootResults.set(root.rootId, { status: 'error', warning: `${adapter.displayName} 扫描失败:${lastError}` });
          }
        }
      } catch (error) {
        lastError = sanitizeError(error);
        ok = false;
        rootResults.set(adapter.id, { status: 'error', warning: `${adapter.displayName} 无法发现数据目录:${lastError}` });
      }
      this.scanState.set(id, {
        status: this.combineRootStatuses([...rootResults.values()].map((entry) => entry.status)),
        warning: [...rootResults.values()].find((entry) => entry.warning)?.warning || null,
        files: this.store.countSourceFiles(id),
      });
    }
    this.lastScanAt = new Date().toISOString();
    this.store.finishScanRun(runId, ok, upserted, lastError);
    return { ok, upserted, scannedAt: this.lastScanAt };
  }

  async scan() {
    if (this.scanning) {
      this.rescanQueued = true;
      return { ok: true, queued: true, scannedAt: this.lastScanAt };
    }
    this.scanning = true;
    try {
      let result = await this.runScan();
      while (this.rescanQueued) {
        this.rescanQueued = false;
        result = await this.runScan();
      }
      return result;
    } finally {
      this.scanning = false;
    }
  }

  async sources() {
    const detected = this.scanState.size ? null : await this.detectOnlyStatus();
    return AGENT_ORDER.map((id) => {
      const adapter = adapters[id];
      const scanned = this.scanState.get(id);
      const status = scanned?.status || detected?.[id] || 'missing';
      return {
        agent: id,
        displayName: adapter.displayName,
        iconKey: adapter.iconKey,
        colorToken: adapter.colorToken,
        rootLabels: adapter.defaultRootLabels,
        status,
        lastScannedAt: this.lastScanAt,
        records: this.store.countEvents(id),
        files: scanned?.files ?? this.store.countSourceFiles(id),
        warning: scanned?.warning || null,
      };
    });
  }
}

const worker = new CliUsageWorker(workerData.dbPath);
wsl.setWslEnabled(workerData.scanWsl !== false);
// 启动即处于关闭状态:立即清除历史 WSL 数据(幂等,无数据时是空操作)
if (!wsl.isWslEnabled()) worker.store.purgeWslRoots();

const handlers = {
  scan: () => worker.scan(),
  summary: (query) => worker.store.summary(query),
  models: (query) => worker.store.models(query),
  sources: () => worker.sources(),
};

parentPort.on('message', async (message) => {
  // 无 id 的 config 消息:只更新开关,不回复;关闭 WSL 时同步清除已入库的 WSL 数据
  if (message?.type === 'config') {
    wsl.setWslEnabled(message.scanWsl !== false);
    if (!wsl.isWslEnabled()) worker.store.purgeWslRoots();
    return;
  }
  const handler = handlers[message?.type];
  if (!handler || !message.id) return;
  try {
    const result = await handler(message.payload);
    parentPort.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: { message: sanitizeError(error) } });
  }
});

parentPort.on('close', () => worker.store.close());
parentPort.postMessage({ type: 'ready' });
