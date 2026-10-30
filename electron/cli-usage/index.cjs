// CLI Usage facade:主进程单例。负责 Worker 生命周期、扫描合并、
// IPC 参数校验与错误脱敏;handler 不解析任何文件。
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const {
  isValidTimeZone, isValidDateString, localDateString, normalizeModelRules,
} = require('./normalize.cjs');

const AGENT_IDS = ['zcode', 'kimi', 'claude', 'codex', 'copilot', 'gemini', 'grok', 'opencode', 'openclaw', 'hermes', 'dsh'];
const RANGE_DAYS = [1, 7, 30, 90, 365];
// days = 0 表示"全部",不按周期截断
const QUERY_TIMEOUT_MS = 30_000;
const SCAN_TIMEOUT_MS = 300_000;
const BACKGROUND_SCAN_MINUTES = 5;

class CliUsageError extends Error {
  constructor(message) { super(message); this.name = 'CliUsageError'; }
}

class CliUsageService {
  constructor({ dbPath }) {
    this.dbPath = dbPath;
    this.worker = null;
    this.workerReady = null;
    this.pending = new Map();
    this.messageId = 0;
    this.scanPromise = null;
    this.backgroundTimer = null;
    this.enabled = false;
    this.scanWsl = true;
  }

  ensureWorker() {
    if (this.worker && this.workerReady) return this.workerReady;
    this.worker = new Worker(path.join(__dirname, 'worker.cjs'), { workerData: { dbPath: this.dbPath, scanWsl: this.scanWsl } });
    this.workerReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CliUsageError('本机用量服务启动超时')), 15_000);
      this.worker.once('message', (message) => {
        if (message?.type === 'ready') { clearTimeout(timer); resolve(); }
      });
      this.worker.once('error', (error) => { clearTimeout(timer); reject(error); });
      this.worker.once('exit', () => {
        this.worker = null;
        this.workerReady = null;
        for (const entry of this.pending.values()) entry.reject(new CliUsageError('本机用量服务已停止'));
        this.pending.clear();
      });
    });
    this.worker.on('message', (message) => {
      if (!message?.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new CliUsageError(message.error?.message || '本机用量服务出错'));
    });
    return this.workerReady;
  }

  async request(type, payload, timeoutMs) {
    await this.ensureWorker();
    const id = `q${this.messageId += 1}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliUsageError(`本机用量请求超时:${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.worker.postMessage({ id, type, payload });
    return promise;
  }

  // 同一时间只有一个扫描任务:并发请求复用同一个 Promise
  scan() {
    if (!this.scanPromise) {
      this.scanPromise = this.request('scan', null, SCAN_TIMEOUT_MS)
        .catch((error) => { this.scanPromise = null; throw error; })
        .finally(() => { this.scanPromise = null; });
    }
    return this.scanPromise;
  }

  getSummary(query) {
    return this.request('summary', query, QUERY_TIMEOUT_MS);
  }

  getModels(query) {
    return this.request('models', query, QUERY_TIMEOUT_MS);
  }

  getSources(query) {
    return this.request('sources', query, QUERY_TIMEOUT_MS);
  }

  getArchiveInfo() { return this.request('archiveInfo', null, SCAN_TIMEOUT_MS); }
  exportArchives(scope) { return this.request('archiveExport', { scope }, SCAN_TIMEOUT_MS); }
  previewArchiveImport(payload) { return this.request('archivePreview', payload, SCAN_TIMEOUT_MS); }
  importArchives(payload, fileName) { return this.request('archiveImport', { payload, fileName }, SCAN_TIMEOUT_MS); }
  updateArchiveSource(query) { return this.request('archiveUpdate', query, QUERY_TIMEOUT_MS); }
  deleteArchiveSource(sourceId) { return this.request('archiveDelete', { sourceId }, SCAN_TIMEOUT_MS); }

  // v1 API 专用聚合:参数由 api-v1 层校验,这里只透传
  getV1Aggregate(query) {
    return this.request('v1Aggregate', query, QUERY_TIMEOUT_MS);
  }

  // ---- 参数校验:非法输入直接拒绝,不进 Worker ------------------------------

  static validateAgent(agent) {
    if (agent !== 'all' && !AGENT_IDS.includes(agent)) throw new CliUsageError('未知的本机用量渠道');
    return agent;
  }

  static validateTimezone(timezone) {
    if (!isValidTimeZone(timezone)) throw new CliUsageError('无效的时区');
    return timezone;
  }

  // 档案来源 ID:本机与导入来源都是 UUID;缺省(null/undefined/空串)表示不过滤
  static normalizeSourceId(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'string' || !/^[0-9a-fA-F-]{10,64}$/.test(raw)) throw new CliUsageError('无效的档案来源');
    return raw;
  }

  static normalizeSummaryQuery(raw) {
    const query = raw && typeof raw === 'object' ? raw : {};
    const timezone = CliUsageService.validateTimezone(query.timezone);
    const agent = CliUsageService.validateAgent(query.agent);
    let endDate = localDateString(timezone);
    if (query.endDate !== undefined && query.endDate !== null) {
      if (!isValidDateString(query.endDate)) throw new CliUsageError('无效的日期');
      endDate = query.endDate;
    }
    // 显式日期区间(浪费周期 → 本机用量):起始日不能晚于结束日
    let startDate = null;
    if (query.startDate !== undefined && query.startDate !== null) {
      if (!isValidDateString(query.startDate)) throw new CliUsageError('无效的日期');
      if (query.startDate > endDate) throw new CliUsageError('无效的日期区间');
      startDate = query.startDate;
    }
    let modelRules;
    try { modelRules = normalizeModelRules(query.modelRules); }
    catch (error) { throw new CliUsageError(error.message); }
    return { agent, timezone, endDate, startDate, modelRules, sourceId: CliUsageService.normalizeSourceId(query.sourceId) };
  }

  static normalizeModelsQuery(raw) {
    const query = raw && typeof raw === 'object' ? raw : {};
    const timezone = CliUsageService.validateTimezone(query.timezone);
    const agent = CliUsageService.validateAgent(query.agent);
    const mergeSameModels = query.mergeSameModels !== false;
    const scope = query.scope && typeof query.scope === 'object' ? query.scope : null;
    if (!scope) throw new CliUsageError('缺少模型查询范围');
    let normalizedScope;
    if (scope.kind === 'day') {
      if (!isValidDateString(scope.date)) throw new CliUsageError('无效的日期');
      normalizedScope = { kind: 'day', date: scope.date };
    } else if (scope.kind === 'between') {
      // 显式时间区间(浪费周期 → 本机用量):含头不含尾,上界不允许伸到未来
      const fromMs = Number(scope.fromMs);
      const toMs = Number(scope.toMs);
      if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs)
        || fromMs <= 0 || fromMs >= toMs || toMs > Date.now() + 86_400_000) throw new CliUsageError('无效的时间区间');
      normalizedScope = { kind: 'between', fromMs, toMs };
    } else if (scope.kind === 'range') {
      const days = Number(scope.days);
      if (days !== 0 && !RANGE_DAYS.includes(days)) throw new CliUsageError('无效的统计周期');
      normalizedScope = { kind: 'range', days };
    } else throw new CliUsageError('无效的模型查询范围');
    let modelRules;
    try { modelRules = normalizeModelRules(query.modelRules); }
    catch (error) { throw new CliUsageError(error.message); }
    return { agent, timezone, mergeSameModels, scope: normalizedScope, modelRules, sourceId: CliUsageService.normalizeSourceId(query.sourceId) };
  }

  static normalizeSourcesQuery(raw) {
    const query = raw && typeof raw === 'object' ? raw : {};
    return { sourceId: CliUsageService.normalizeSourceId(query.sourceId) };
  }

  // ---- 后台增量 ----------------------------------------------------------

  applySettings(settings) {
    // WSL 扫描开关:worker 已启动则即时推送,未启动则随 workerData 带上
    this.scanWsl = settings?.localCliUsage?.scanWsl !== false;
    if (this.worker) this.worker.postMessage({ type: 'config', scanWsl: this.scanWsl });
    const enabled = settings?.localCliUsage?.enabled === true;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (this.backgroundTimer) { clearInterval(this.backgroundTimer); this.backgroundTimer = null; }
    if (!enabled) return;
    // 启动后延迟 20 秒做首次增量,之后每 5 分钟轻量增量
    setTimeout(() => { if (this.enabled) this.scan().catch(() => {}); }, 20_000).unref?.();
    this.backgroundTimer = setInterval(() => {
      if (!this.enabled) return;
      this.scan().catch(() => {});
    }, BACKGROUND_SCAN_MINUTES * 60_000);
    if (this.backgroundTimer.unref) this.backgroundTimer.unref();
  }

  registerIpc(ipcMain) {
    ipcMain.handle('cliUsage:get-summary', async (_event, raw) => this.getSummary(CliUsageService.normalizeSummaryQuery(raw)));
    ipcMain.handle('cliUsage:get-models', async (_event, raw) => this.getModels(CliUsageService.normalizeModelsQuery(raw)));
    ipcMain.handle('cliUsage:get-sources', (_event, raw) => this.getSources(CliUsageService.normalizeSourcesQuery(raw)));
    ipcMain.handle('cliUsage:scan', () => this.scan().then(() => this.getSources()));
  }

  dispose() {
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    this.backgroundTimer = null;
    this.enabled = false;
    try { this.worker?.terminate(); } catch { /* 忽略 */ }
    this.worker = null;
    this.workerReady = null;
  }
}

const createCliUsageService = ({ dbPath }) => new CliUsageService({ dbPath });

module.exports = { createCliUsageService, CliUsageService, CliUsageError, AGENT_IDS };
