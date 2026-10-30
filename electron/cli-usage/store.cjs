// cli-usage.sqlite:增量索引与聚合。独立于 history.json,只存数值与哈希标识。
// 全部整数按安全整数校验;schema 演进通过 meta.schema_version。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { UsageArchives } = require('./archives.cjs');
const {
  canonicalModelKey, modelKeyForGrouping, modelDisplayName, hmacHex, projectLabelFromPath,
  buildDayBoundaries, localDateString, zoneOffsetMs, shiftDateString, computeStreaks, createModelRuleMatcher,
} = require('./normalize.cjs');

const SCHEMA_VERSION = '4';

const AGENT_ORDER = ['zcode', 'kimi', 'claude', 'codex', 'copilot', 'gemini', 'grok', 'opencode', 'openclaw', 'hermes', 'dsh'];

const HOUR_BUCKET_FORMATTER_CACHE = new Map();

// 显式日期区间的天数(含两端): startDate/endDate 都是 YYYY-MM-DD,解析按 UTC 零点只求差值
const periodDayCount = (startDate, endDate) => {
  const diff = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
  if (!Number.isFinite(diff)) return null;
  return Math.max(1, Math.min(800, diff));
};
// 小时桶标签:目标时区的本地墙钟 YYYY-MM-DDTHH:00(DST 切换日按平移处理,仅展示用途)
const hourBucketLabel = (timeZone, atMs) => {
  let formatter = HOUR_BUCKET_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
    HOUR_BUCKET_FORMATTER_CACHE.set(timeZone, formatter);
  }
  const map = {};
  for (const part of formatter.formatToParts(new Date(atMs))) map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}T${map.hour === '24' ? '00' : map.hour}:00`;
};

// v1 时间桶:day 用本地日边界(DST 精确);hour 为等宽 3600s、起点对齐本地整点
const buildV1Boundaries = (startMs, endMs, granularity, timeZone) => {
  if (granularity === 'hour') {
    const offset = zoneOffsetMs(timeZone, startMs);
    const alignedLocal = Math.floor((startMs + offset) / 3_600_000) * 3_600_000;
    const list = [];
    for (let start = alignedLocal - offset; start < endMs; start += 3_600_000) {
      list.push({ startMs: start, endMs: start + 3_600_000, label: hourBucketLabel(timeZone, start) });
    }
    return list;
  }
  const firstDate = localDateString(timeZone, startMs);
  const lastDate = localDateString(timeZone, Math.max(startMs, endMs - 1));
  const dates = [];
  let cursor = firstDate;
  while (dates.length < 800 && cursor <= lastDate) { dates.push(cursor); cursor = shiftDateString(cursor, 1); }
  return buildDayBoundaries(timeZone, dates[dates.length - 1], dates.length).map((boundary) => ({ ...boundary, label: boundary.date }));
};

const UPSERT_EVENT_SQL = `
INSERT INTO usage_events (
  event_key, agent, root_id, occurred_at_ms, session_key, project_key, model, canonical_model_key,
  input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
  reasoning_tokens, extra_tokens, total_tokens, request_count,
  source_version, exact, is_sidechain
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)
ON CONFLICT(event_key) DO UPDATE SET
  -- 同一会话内的流式最终快照取更晚时间;跨会话回放(同 message.id、不同 session)
  -- 保持最初发生时间,避免把事件挪到回放那天
  occurred_at_ms = CASE WHEN excluded.session_key = session_key
    THEN MAX(occurred_at_ms, excluded.occurred_at_ms)
    ELSE MIN(occurred_at_ms, excluded.occurred_at_ms) END,
  root_id = COALESCE(excluded.root_id, root_id),
  session_key = excluded.session_key,
  project_key = excluded.project_key,
  model = COALESCE(excluded.model, model),
  canonical_model_key = COALESCE(excluded.canonical_model_key, canonical_model_key),
  input_tokens = MAX(input_tokens, excluded.input_tokens),
  cache_read_tokens = MAX(cache_read_tokens, excluded.cache_read_tokens),
  cache_write_tokens = MAX(cache_write_tokens, excluded.cache_write_tokens),
  output_tokens = MAX(output_tokens, excluded.output_tokens),
  reasoning_tokens = MAX(reasoning_tokens, excluded.reasoning_tokens),
  extra_tokens = MAX(extra_tokens, excluded.extra_tokens),
  total_tokens = MAX(total_tokens, excluded.total_tokens),
  source_version = COALESCE(excluded.source_version, source_version)
`;

class CliUsageStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS source_files (
  agent TEXT NOT NULL,
  root_id TEXT NOT NULL,
  file_key TEXT NOT NULL,
  mtime_ms INTEGER,
  size INTEGER,
  byte_cursor INTEGER NOT NULL DEFAULT 0,
  format_version INTEGER NOT NULL DEFAULT 1,
  last_scan_ms INTEGER,
  PRIMARY KEY (agent, root_id, file_key)
);
CREATE TABLE IF NOT EXISTS usage_events (
  event_key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  root_id TEXT,
  occurred_at_ms INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  project_key TEXT,
  model TEXT,
  canonical_model_key TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  extra_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 1,
  source_version TEXT,
  exact INTEGER NOT NULL DEFAULT 1,
  is_sidechain INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_events_agent_time ON usage_events(agent, occurred_at_ms);
CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events(occurred_at_ms);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_key);
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER,
  duration_ms INTEGER,
  events_upserted INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS scan_roots (
  root_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  label TEXT,
  is_wsl INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_labels (
  project_key TEXT PRIMARY KEY,
  label TEXT NOT NULL
);
`);
    this.ensureMeta();
    this.migrate();
    this.upsertEventStatement = this.db.prepare(UPSERT_EVENT_SQL);
    this.upsertLabelStatement = this.db.prepare('INSERT INTO project_labels (project_key, label) VALUES (?, ?) ON CONFLICT(project_key) DO UPDATE SET label = excluded.label');
    this.archives = new UsageArchives(this.db, AGENT_ORDER);
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  }

  // 老库(schema v1)的 usage_events 没有 root_id,补列后 WSL 事件才能按根清除
  migrate() {
    const columns = this.db.prepare('PRAGMA table_info(usage_events)').all().map((col) => col.name);
    if (!columns.includes('root_id')) this.db.exec('ALTER TABLE usage_events ADD COLUMN root_id TEXT');
  }

  ensureMeta() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'hmac_salt'").get();
    if (row?.value) { this.salt = row.value; return; }
    this.salt = crypto.randomBytes(32).toString('hex');
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('hmac_salt', ?)").run(this.salt);
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  }

  hmac(value) { return hmacHex(value, this.salt); }

  close() { try { this.db.close(); } catch { /* 已关闭 */ } }

  // ---- 事件写入 ----------------------------------------------------------

  upsertEvents(events) {
    let written = 0;
    this.db.exec('BEGIN');
    try {
      for (const event of events) {
        if (!event || !event.eventKey || !event.agent) continue;
        this.upsertEventStatement.run(
          event.eventKey, event.agent, event.rootId ?? null, event.occurredAtMs, event.sessionKey,
          event.projectKey, event.model, event.canonicalModelKey,
          event.inputTokens, event.cacheReadTokens, event.cacheWriteTokens, event.outputTokens,
          event.reasoningTokens, event.extraTokens, event.totalTokens, event.requestCount,
          event.sourceVersion, event.exact ? 1 : 0, event.isSidechain ? 1 : 0,
        );
        if (event.projectKey && event.projectLabel) this.upsertLabelStatement.run(event.projectKey, event.projectLabel);
        written += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return written;
  }

  // ---- 项目标签 ----------------------------------------------------------

  // key = hmac(工作目录),label = 目录名。采集时顺带登记,API 的 project 分组用
  saveProjectLabel(projectKey, label) {
    const cleaned = projectLabelFromPath(label);
    if (!projectKey || !cleaned) return;
    this.upsertLabelStatement.run(String(projectKey), cleaned);
  }

  getProjectLabels() {
    return Object.fromEntries([
      ...this.db.prepare('SELECT project_key AS projectKey, label FROM project_labels').all().map((row) => [row.projectKey, row.label]),
      ...this.archives.importedProjectLabels(),
    ]);
  }

  // ---- 来源文件游标 ------------------------------------------------------

  getFileState(agent, rootId, fileKey) {
    return this.db.prepare('SELECT mtime_ms AS mtimeMs, size, byte_cursor AS byteCursor, format_version AS formatVersion, last_scan_ms AS lastScanMs FROM source_files WHERE agent = ? AND root_id = ? AND file_key = ?')
      .get(agent, rootId, fileKey) || null;
  }

  saveFileState(agent, rootId, fileKey, state) {
    this.db.prepare(`
INSERT INTO source_files (agent, root_id, file_key, mtime_ms, size, byte_cursor, format_version, last_scan_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(agent, root_id, file_key) DO UPDATE SET
  mtime_ms = excluded.mtime_ms, size = excluded.size, byte_cursor = excluded.byte_cursor,
  format_version = excluded.format_version, last_scan_ms = excluded.last_scan_ms
`).run(agent, rootId, fileKey, state.mtimeMs ?? null, state.size ?? null, state.byteCursor ?? 0, state.formatVersion ?? 1, state.lastScanMs ?? null);
  }

  countSourceFiles(agent) {
    const row = this.db.prepare('SELECT COUNT(*) AS files FROM source_files WHERE agent = ?').get(agent);
    return Number(row?.files || 0);
  }

  // ---- 定向删除 ----------------------------------------------------------
  // 仅供"整文件重算"型 adapter 使用(copilot 的 OTel/session-state 对账、
  // opencode/openclaw 的聚合与迁移覆盖):按 agent + 事件键前缀 + 可选的
  // 会话(单个或集合)/模型/时间上界删除历史行,配合重发实现撤回与替换。
  deleteEvents(agent, { eventKeyPrefix = null, sessionKey = null, sessionKeys = null, canonicalModelKey = null, beforeMs = null } = {}) {
    const clauses = ['agent = ?'];
    const params = [agent];
    if (eventKeyPrefix !== null) { clauses.push('event_key LIKE ? ESCAPE \'\\\''); params.push(`${eventKeyPrefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`); }
    if (sessionKey !== null) { clauses.push('session_key = ?'); params.push(sessionKey); }
    if (Array.isArray(sessionKeys) && sessionKeys.length) {
      clauses.push(`session_key IN (${sessionKeys.map(() => '?').join(',')})`);
      params.push(...sessionKeys);
    }
    if (canonicalModelKey !== null) { clauses.push('canonical_model_key = ?'); params.push(canonicalModelKey); }
    if (beforeMs !== null) { clauses.push('occurred_at_ms <= ?'); params.push(beforeMs); }
    const row = this.db.prepare(`DELETE FROM usage_events WHERE ${clauses.join(' AND ')}`).run(...params);
    return Number(row?.changes || 0);
  }

  // ---- 根目录登记与 WSL 清除 ----------------------------------------------

  // 每次扫描登记检测到的根目录;isWsl 标记用于关闭 WSL 开关后的精确清除
  registerRoots(agent, roots) {
    const statement = this.db.prepare(`
INSERT INTO scan_roots (root_id, agent, label, is_wsl) VALUES (?, ?, ?, ?)
ON CONFLICT(root_id) DO UPDATE SET agent = excluded.agent, label = excluded.label, is_wsl = excluded.is_wsl
`);
    for (const root of roots) {
      statement.run(root.rootId, agent, root.rootLabel ?? null, root.isWsl ? 1 : 0);
    }
  }

  // 关闭"统计 WSL 用量"时调用:删除 WSL 根目录的事件、游标与登记,
  // 重新扫描后统计即不含 WSL;本机根目录的数据不受影响
  purgeWslRoots() {
    const wslRoots = this.db.prepare('SELECT root_id AS rootId FROM scan_roots WHERE is_wsl = 1').all().map((row) => row.rootId);
    if (!wslRoots.length) return 0;
    const placeholders = wslRoots.map(() => '?').join(',');
    let deleted = 0;
    this.db.exec('BEGIN');
    try {
      deleted = Number(this.db.prepare(`DELETE FROM usage_events WHERE root_id IN (${placeholders})`).run(...wslRoots)?.changes || 0);
      this.db.prepare(`DELETE FROM source_files WHERE root_id IN (${placeholders})`).run(...wslRoots);
      this.db.prepare('DELETE FROM scan_roots WHERE is_wsl = 1').run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return deleted;
  }

  // ---- 扫描记录 ----------------------------------------------------------

  beginScanRun() {
    const row = this.db.prepare('INSERT INTO scan_runs (started_at) VALUES (?)').run(Date.now());
    return Number(row.lastInsertRowid);
  }

  finishScanRun(runId, ok, eventsUpserted, error) {
    const row = this.db.prepare('SELECT started_at FROM scan_runs WHERE id = ?').get(runId);
    const finished = Date.now();
    this.db.prepare('UPDATE scan_runs SET finished_at = ?, ok = ?, duration_ms = ?, events_upserted = ?, error = ? WHERE id = ?')
      .run(finished, ok ? 1 : 0, row ? finished - Number(row.started_at) : 0, eventsUpserted ?? 0, error ? String(error).slice(0, 500) : null, runId);
  }

  lastSuccessfulScan(agent) {
    // scan_run 不按渠道拆分;渠道级最后扫描时间取该渠道事件的最新写入时间
    const row = this.db.prepare('SELECT MAX(occurred_at_ms) AS latest FROM usage_events WHERE agent = ?').get(agent);
    return row?.latest ? new Date(Number(row.latest)).toISOString() : null;
  }

  countEvents(agent, sourceId = null) {
    const { table, params } = this.archiveTable(sourceId);
    const row = agent && agent !== 'all'
      ? this.db.prepare(`SELECT COUNT(*) AS records FROM ${table} WHERE agent = ?`).get(...params, agent)
      : this.db.prepare(`SELECT COUNT(*) AS records FROM ${table}`).get(...params);
    return Number(row?.records || 0);
  }

  // 档案来源过滤:缺省读「本机 + 已启用导入」合并视图;指定来源时本机读
  // usage_events,导入来源直接读 imported_usage_events——单独查看一个档案时
  // 即使它被暂停计入汇总,该档案自身的数据仍应完整可见
  archiveTable(sourceId) {
    if (sourceId === null || sourceId === undefined || sourceId === '') return { table: 'reported_usage_events', params: [] };
    if (sourceId === this.archives.sourceId) return { table: 'usage_events', params: [] };
    return { table: '(SELECT * FROM imported_usage_events WHERE source_id = ?)', params: [sourceId] };
  }

  hasAnyEvents() {
    return this.countEventsAll() > 0;
  }

  countEventsAll() {
    const row = this.db.prepare('SELECT COUNT(*) AS records FROM reported_usage_events').get();
    return Number(row?.records || 0);
  }

  // 可选过滤片段(渠道 + 时间边界,含头不含尾):clauses 与 values 保持同序
  scopedFilters(baseParams, agentFilter, fromMs, toMs) {
    const clauses = [];
    const values = [...baseParams];
    if (agentFilter && agentFilter !== 'all') { clauses.push('agent = ?'); values.push(agentFilter); }
    if (Number.isSafeInteger(fromMs) && fromMs > 0) { clauses.push('occurred_at_ms >= ?'); values.push(fromMs); }
    if (Number.isSafeInteger(toMs) && toMs > 0) { clauses.push('occurred_at_ms < ?'); values.push(toMs); }
    return { whereSql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
  }

  earliestEventMs(agentFilter, modelRules = null, sourceId = null, fromMs = null, toMs = null) {
    const { table, params } = this.archiveTable(sourceId);
    const { whereSql, values } = this.scopedFilters(params, agentFilter, fromMs, toMs);
    if (modelRules === null || modelRules === undefined) {
      const row = this.db.prepare(`SELECT MIN(occurred_at_ms) AS earliest FROM ${table}${whereSql}`).get(...values);
      return row?.earliest ? Number(row.earliest) : null;
    }
    const matchesModel = createModelRuleMatcher(modelRules);
    const iterator = this.db.prepare(`SELECT occurred_at_ms, model, canonical_model_key FROM ${table}${whereSql} ORDER BY occurred_at_ms`).iterate(...values);
    for (const row of iterator) {
      if (matchesModel(row.canonical_model_key, row.model)) return Number(row.occurred_at_ms);
    }
    return null;
  }

  totalTokensAll(agentFilter, modelRules = null, sourceId = null, fromMs = null, toMs = null) {
    const { table, params } = this.archiveTable(sourceId);
    const { whereSql, values } = this.scopedFilters(params, agentFilter, fromMs, toMs);
    if (modelRules === null || modelRules === undefined) {
      const row = this.db.prepare(`SELECT SUM(total_tokens) AS total FROM ${table}${whereSql}`).get(...values);
      return Number(row?.total || 0);
    }
    const matchesModel = createModelRuleMatcher(modelRules);
    const iterator = this.db.prepare(`SELECT model, canonical_model_key, total_tokens FROM ${table}${whereSql}`).iterate(...values);
    let total = 0;
    for (const row of iterator) {
      if (matchesModel(row.canonical_model_key, row.model)) total += Number(row.total_tokens) || 0;
    }
    return total;
  }

  matchingModels(agentFilter, modelRules, sourceId = null) {
    if (modelRules === null || modelRules === undefined) return [];
    const { table, params } = this.archiveTable(sourceId);
    const matchesModel = createModelRuleMatcher(modelRules);
    const filterByAgent = agentFilter && agentFilter !== 'all';
    const iterator = filterByAgent
      ? this.db.prepare(`SELECT canonical_model_key, MIN(model) AS model FROM ${table} WHERE agent = ? GROUP BY canonical_model_key`).iterate(...params, agentFilter)
      : this.db.prepare(`SELECT canonical_model_key, MIN(model) AS model FROM ${table} GROUP BY canonical_model_key`).iterate(...params);
    const models = [];
    for (const row of iterator) {
      if (!matchesModel(row.canonical_model_key, row.model)) continue;
      models.push({
        key: row.canonical_model_key || canonicalModelKey(row.model),
        displayName: modelDisplayName(row.model || row.canonical_model_key),
      });
    }
    return models
      .filter((model) => model.key)
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-Hans-CN'));
  }

  matchingRecordsByAgent(modelRules, sourceId = null) {
    if (modelRules === null || modelRules === undefined) return null;
    const { table, params } = this.archiveTable(sourceId);
    const matchesModel = createModelRuleMatcher(modelRules);
    const counts = Object.fromEntries(AGENT_ORDER.map((agent) => [agent, 0]));
    const iterator = this.db.prepare(`SELECT agent, model, canonical_model_key, COUNT(*) AS records FROM ${table} GROUP BY agent, canonical_model_key, model`).iterate(...params);
    for (const row of iterator) {
      if (!matchesModel(row.canonical_model_key, row.model)) continue;
      counts[row.agent] = (counts[row.agent] || 0) + Number(row.records || 0);
    }
    return counts;
  }

  // ---- 聚合:近一年摘要 ---------------------------------------------------

  summary({ agent, timezone, endDate, startDate = null, days = 365, modelRules = null, sourceId = null }) {
    // endDate 缺省为该时区今天(双保险:facade 的 IPC 层也会先规整);
    // 指定 startDate 时按显式日期区间取天数(浪费周期 → 本机用量视图)
    const effectiveEndDate = endDate || localDateString(timezone);
    let effectiveDays = days;
    if (startDate) {
      effectiveDays = periodDayCount(startDate, effectiveEndDate);
      if (effectiveDays === null) throw new Error('无效的日期区间');
    }
    const boundaries = buildDayBoundaries(timezone, effectiveEndDate, Math.max(1, effectiveDays));
    const startMs = boundaries[0].startMs;
    const endMs = boundaries[boundaries.length - 1].endMs;

    const buckets = boundaries.map((boundary) => ({
      date: boundary.date, startMs: boundary.startMs, endMs: boundary.endMs,
      totalTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
      sessions: new Set(), agents: new Map(),
    }));
    // 会话数(区间去重)
    const sessionsOverall = new Set();
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;
    const matchesModel = createModelRuleMatcher(modelRules);
    const { table, params: tableParams } = this.archiveTable(sourceId);

    const filterByAgent = agent && agent !== 'all';
    const iterate = filterByAgent
      ? this.db.prepare(`SELECT agent, occurred_at_ms, session_key, model, canonical_model_key, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, total_tokens FROM ${table} WHERE agent = ? AND occurred_at_ms >= ? AND occurred_at_ms < ? ORDER BY occurred_at_ms`)
      : this.db.prepare(`SELECT agent, occurred_at_ms, session_key, model, canonical_model_key, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, total_tokens FROM ${table} WHERE occurred_at_ms >= ? AND occurred_at_ms < ? ORDER BY occurred_at_ms`);
    const params = filterByAgent ? [...tableParams, agent, startMs, endMs] : [...tableParams, startMs, endMs];

    let index = 0;
    for (const row of iterate.iterate(...params)) {
      if (!matchesModel(row.canonical_model_key, row.model)) continue;
      const stamp = Number(row.occurred_at_ms);
      while (index < buckets.length - 1 && stamp >= buckets[index].endMs) index += 1;
      if (stamp < buckets[index].startMs) continue;
      const bucket = buckets[index];
      const total = Number(row.total_tokens) || 0;
      bucket.totalTokens += total;
      bucket.inputTokens += Number(row.input_tokens) || 0;
      bucket.cacheReadTokens += Number(row.cache_read_tokens) || 0;
      bucket.cacheWriteTokens += Number(row.cache_write_tokens) || 0;
      bucket.outputTokens += Number(row.output_tokens) || 0;
      bucket.sessions.add(row.session_key);
      bucket.agents.set(row.agent, (bucket.agents.get(row.agent) || 0) + total);
      sessionsOverall.add(row.session_key);
      inputTokens += Number(row.input_tokens) || 0;
      cacheReadTokens += Number(row.cache_read_tokens) || 0;
      cacheWriteTokens += Number(row.cache_write_tokens) || 0;
      outputTokens += Number(row.output_tokens) || 0;
    }

    const totals = buckets.map((bucket) => bucket.totalTokens);
    const peakTokens = totals.reduce((max, value) => Math.max(max, value), 0);
    const streaks = computeStreaks(totals);
    const activeDays = totals.filter((value) => value > 0).length;
    const cacheBase = inputTokens + cacheReadTokens + cacheWriteTokens;
    const cacheReuseRatio = cacheBase > 0 ? cacheReadTokens / cacheBase : null;
    // 累计口径:显式日期区间时随区间收敛,只统计该期间;默认近一年窗口则统计全部已索引历史,
    // 若最早事件早于窗口起点,说明只覆盖部分区间
    const totalsFromMs = startDate ? startMs : null;
    const totalsToMs = startDate ? endMs : null;
    const allHistoryTokens = this.totalTokensAll(agent, modelRules, sourceId, totalsFromMs, totalsToMs);
    const earliest = this.earliestEventMs(agent, modelRules, sourceId, totalsFromMs, totalsToMs);

    return {
      range: { start: boundaries[0].date, end: boundaries[boundaries.length - 1].date, timezone },
      filter: { agent, timezone, endDate, startDate, modelRules, sourceId: sourceId || null },
      archiveScope: { importedSources: Number(this.db.prepare('SELECT COUNT(*) AS count FROM usage_archive_sources WHERE enabled = 1').get().count) },
      matchedModels: this.matchingModels(agent, modelRules, sourceId),
      recordsByAgent: this.matchingRecordsByAgent(modelRules, sourceId),
      summary: {
        totalTokens: allHistoryTokens,
        coverageComplete: earliest === null || earliest >= startMs,
        peakTokens,
        currentStreakDays: streaks.current,
        longestStreakDays: streaks.longest,
        inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens,
        sessions: sessionsOverall.size,
        activeDays,
        cacheReuseRatio,
      },
      days: buckets.map((bucket) => ({
        date: bucket.date,
        totalTokens: bucket.totalTokens,
        inputTokens: bucket.inputTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
        outputTokens: bucket.outputTokens,
        sessions: bucket.sessions.size,
        agents: Object.fromEntries(bucket.agents),
      })),
    };
  }

  // ---- 聚合:模型拆分 -----------------------------------------------------

  models({ agent, mergeSameModels, scope, timezone, modelRules = null, sourceId = null }) {
    const filterByAgent = agent && agent !== 'all';
    const effectiveMerge = !filterByAgent && mergeSameModels !== false;
    let startMs;
    let endMs;
    let startDate;
    let endDate;
    if (scope.kind === 'day') {
      startDate = scope.date;
      endDate = scope.date;
      startMs = null;
      // buildDayBoundaries 会构造单日边界
      const boundaries = buildDayBoundaries(timezone, scope.date, 1);
      startMs = boundaries[0].startMs;
      endMs = boundaries[0].endMs;
    } else if (scope.kind === 'between') {
      // 显式时间区间(浪费周期 → 本机用量):两侧都是精确时刻,含头不含尾
      startDate = localDateString(timezone, scope.fromMs);
      endDate = localDateString(timezone, Math.max(scope.fromMs, scope.toMs - 1));
      startMs = scope.fromMs;
      endMs = scope.toMs;
    } else if (scope.days > 0) {
      endDate = localDateString(timezone);
      startDate = null;
      const boundaries = buildDayBoundaries(timezone, endDate, scope.days);
      startDate = boundaries[0].date;
      startMs = boundaries[0].startMs;
      endMs = boundaries[boundaries.length - 1].endMs;
    } else {
      // days = 0:全部记录,只按今天结束边界截断未来时间戳
      endDate = localDateString(timezone);
      startDate = null;
      startMs = 0;
      endMs = buildDayBoundaries(timezone, endDate, 1)[0].endMs;
    }

    const groups = new Map();
    const matchesModel = createModelRuleMatcher(modelRules);
    const { table, params: tableParams } = this.archiveTable(sourceId);
    const select = filterByAgent
      ? `SELECT agent, session_key, model, canonical_model_key, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, extra_tokens, total_tokens FROM ${table} WHERE agent = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?`
      : `SELECT agent, session_key, model, canonical_model_key, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, extra_tokens, total_tokens FROM ${table} WHERE occurred_at_ms >= ? AND occurred_at_ms < ?`;
    const params = filterByAgent ? [...tableParams, agent, startMs, endMs] : [...tableParams, startMs, endMs];

    for (const row of this.db.prepare(select).iterate(...params)) {
      if (!matchesModel(row.canonical_model_key, row.model)) continue;
      const canonical = modelKeyForGrouping(row.canonical_model_key || canonicalModelKey(row.model));
      // 未知模型永远按渠道隔离,避免把无法识别的记录合在一起
      const groupingKey = canonical === '' || filterByAgent || !effectiveMerge
        ? `${row.agent}\u0000${canonical}`
        : canonical;
      let group = groups.get(groupingKey);
      if (!group) {
        group = {
          agent: row.agent, canonical,
          displayName: null, rawModels: new Set(), agents: new Set(), sessions: new Set(),
          inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
          extraTokens: 0, reasoningTokens: 0, totalTokens: 0, requests: 0,
        };
        groups.set(groupingKey, group);
      }
      group.agents.add(row.agent);
      if (row.model) group.rawModels.add(row.model);
      group.sessions.add(row.session_key);
      group.inputTokens += Number(row.input_tokens) || 0;
      group.cacheReadTokens += Number(row.cache_read_tokens) || 0;
      group.cacheWriteTokens += Number(row.cache_write_tokens) || 0;
      group.outputTokens += Number(row.output_tokens) || 0;
      group.extraTokens += Number(row.extra_tokens) || 0;
      group.reasoningTokens += Number(row.reasoning_tokens) || 0;
      group.totalTokens += Number(row.total_tokens) || 0;
      group.requests += 1;
    }

    const allTotal = [...groups.values()].reduce((sum, group) => sum + group.totalTokens, 0);
    const rows = [...groups.values()].map((group) => {
      const displayModel = [...group.rawModels][0] || null;
      return {
        modelKey: group.canonical === '' ? `unknown@${group.agent}` : group.canonical,
        displayName: group.canonical === '' ? '未知模型' : modelDisplayName(displayModel),
        agents: [...group.agents].sort((left, right) => AGENT_ORDER.indexOf(left) - AGENT_ORDER.indexOf(right)),
        rawModels: [...group.rawModels],
        totalTokens: group.totalTokens,
        inputTokens: group.inputTokens,
        cacheReadTokens: group.cacheReadTokens,
        cacheWriteTokens: group.cacheWriteTokens,
        outputTokens: group.outputTokens,
        extraTokens: group.extraTokens,
        sessions: group.sessions.size,
        requests: group.requests,
        share: allTotal > 0 ? group.totalTokens / allTotal : 0,
      };
    });
    rows.sort((left, right) => (right.totalTokens - left.totalTokens)
      || String(left.displayName).localeCompare(String(right.displayName), 'zh-Hans-CN')
      || String(left.modelKey).localeCompare(String(right.modelKey), 'zh-Hans-CN'));

    return {
      range: { start: startDate, end: endDate, timezone },
      filter: { agent, mergeSameModels, effectiveMergeSameModels: effectiveMerge, scope, modelRules, sourceId: sourceId || null },
      models: rows,
    };
  }

  // ---- 聚合:v1 API 通用查询 ------------------------------------------------
  // 单次扫描同时产出时间桶(hour/day)、区间合计与可选维度分组(model/agent/project)。
  // 与 summary()/models()(界面口径)互不影响;过滤条件为 null/空数组表示不过滤。
  v1Aggregate({ startMs, endMs, granularity = 'day', timezone, agents = null, canonicalModels = null, modelsIncludeUnknown = false, projectKeys = null, projectIncludeUnknown = false, groupBy = null }) {
    const clauses = ['occurred_at_ms >= ?', 'occurred_at_ms < ?'];
    const params = [startMs, endMs];
    if ((Array.isArray(canonicalModels) && canonicalModels.length) || modelsIncludeUnknown) {
      const parts = [];
      if (Array.isArray(canonicalModels) && canonicalModels.length) {
        parts.push(`canonical_model_key IN (${canonicalModels.map(() => '?').join(',')})`);
        params.push(...canonicalModels);
      }
      if (modelsIncludeUnknown) parts.push('canonical_model_key IS NULL');
      clauses.push(`(${parts.join(' OR ')})`);
    }
    if ((Array.isArray(agents) && agents.length)) {
      clauses.push(`agent IN (${agents.map(() => '?').join(',')})`);
      params.push(...agents);
    }
    if ((Array.isArray(projectKeys) && projectKeys.length) || projectIncludeUnknown) {
      const parts = [];
      if (Array.isArray(projectKeys) && projectKeys.length) {
        parts.push(`project_key IN (${projectKeys.map(() => '?').join(',')})`);
        params.push(...projectKeys);
      }
      if (projectIncludeUnknown) parts.push("(project_key IS NULL OR project_key = '')");
      clauses.push(`(${parts.join(' OR ')})`);
    }

    const boundaries = buildV1Boundaries(startMs, endMs, granularity, timezone);
    const buckets = boundaries.map((boundary) => ({
      startMs: boundary.startMs, endMs: boundary.endMs, label: boundary.label,
      inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, extraTokens: 0, totalTokens: 0,
      requests: 0, sessions: new Set(),
    }));
    const totals = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, extraTokens: 0, totalTokens: 0, requests: 0 };
    const groups = new Map();
    const sessionsOverall = new Set();

    const select = `SELECT agent, occurred_at_ms, session_key, project_key, model, canonical_model_key, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, extra_tokens, total_tokens FROM reported_usage_events WHERE ${clauses.join(' AND ')} ORDER BY occurred_at_ms`;
    let index = 0;
    for (const row of this.db.prepare(select).iterate(...params)) {
      const stamp = Number(row.occurred_at_ms);
      while (index < buckets.length - 1 && stamp >= buckets[index].endMs) index += 1;
      if (stamp < buckets[index].startMs) continue;
      const bucket = buckets[index];
      const input = Number(row.input_tokens) || 0;
      const cacheRead = Number(row.cache_read_tokens) || 0;
      const cacheWrite = Number(row.cache_write_tokens) || 0;
      const output = Number(row.output_tokens) || 0;
      const extra = Number(row.extra_tokens) || 0;
      const total = Number(row.total_tokens) || 0;
      bucket.inputTokens += input;
      bucket.cacheReadTokens += cacheRead;
      bucket.cacheWriteTokens += cacheWrite;
      bucket.outputTokens += output;
      bucket.extraTokens += extra;
      bucket.totalTokens += total;
      bucket.requests += 1;
      bucket.sessions.add(row.session_key);
      sessionsOverall.add(row.session_key);
      totals.inputTokens += input;
      totals.cacheReadTokens += cacheRead;
      totals.cacheWriteTokens += cacheWrite;
      totals.outputTokens += output;
      totals.extraTokens += extra;
      totals.totalTokens += total;
      totals.requests += 1;
      if (groupBy) {
        const key = groupBy === 'agent' ? row.agent
          : groupBy === 'project' ? (row.project_key || 'unknown')
            : (row.canonical_model_key || `unknown@${row.agent}`);
        let group = groups.get(key);
        if (!group) {
          group = {
            key, agents: new Set(), displayNameSample: null, sessions: new Set(), firstAtMs: stamp, lastAtMs: stamp,
            inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, extraTokens: 0, totalTokens: 0, requests: 0,
          };
          groups.set(key, group);
        }
        group.agents.add(row.agent);
        if (!group.displayNameSample && row.model) group.displayNameSample = row.model;
        if (stamp < group.firstAtMs) group.firstAtMs = stamp;
        if (stamp > group.lastAtMs) group.lastAtMs = stamp;
        group.inputTokens += input;
        group.cacheReadTokens += cacheRead;
        group.cacheWriteTokens += cacheWrite;
        group.outputTokens += output;
        group.extraTokens += extra;
        group.totalTokens += total;
        group.requests += 1;
        group.sessions.add(row.session_key);
      }
    }

    // 区间外的全量累计与最早事件(判定 coverage):沿用同一组非时间过滤
    const sideClauses = clauses.slice(2);
    const sideParams = params.slice(2);
    const sideRow = sideClauses.length
      ? this.db.prepare(`SELECT SUM(total_tokens) AS total, MIN(occurred_at_ms) AS earliest FROM reported_usage_events WHERE ${sideClauses.join(' AND ')}`).get(...sideParams)
      : this.db.prepare('SELECT SUM(total_tokens) AS total, MIN(occurred_at_ms) AS earliest FROM reported_usage_events').get();

    const bucketTotals = buckets.map((bucket) => bucket.totalTokens);
    let peakIndex = -1;
    bucketTotals.forEach((value, position) => { if (peakIndex < 0 || value > bucketTotals[peakIndex]) peakIndex = position; });
    const streaks = granularity === 'day' ? computeStreaks(bucketTotals) : null;
    const cacheBase = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
    const projectLabels = groupBy === 'project' ? this.getProjectLabels() : null;

    return {
      granularity,
      timezone,
      buckets: buckets.map((bucket) => ({
        startMs: bucket.startMs, endMs: bucket.endMs, label: bucket.label,
        inputTokens: bucket.inputTokens, cacheReadTokens: bucket.cacheReadTokens, cacheWriteTokens: bucket.cacheWriteTokens,
        outputTokens: bucket.outputTokens, extraTokens: bucket.extraTokens, totalTokens: bucket.totalTokens,
        requests: bucket.requests, sessions: bucket.sessions.size,
      })),
      totals: {
        ...totals,
        sessions: sessionsOverall.size,
        activeBuckets: bucketTotals.filter((value) => value > 0).length,
        peak: peakIndex >= 0 && bucketTotals[peakIndex] > 0 ? { label: buckets[peakIndex].label, startMs: buckets[peakIndex].startMs, totalTokens: bucketTotals[peakIndex] } : null,
        currentStreakDays: streaks ? streaks.current : null,
        longestStreakDays: streaks ? streaks.longest : null,
        cacheReuseRatio: cacheBase > 0 ? totals.cacheReadTokens / cacheBase : null,
      },
      groups: groupBy ? [...groups.values()].map((group) => ({
        key: group.key,
        displayName: groupBy === 'model'
          ? (String(group.key).startsWith('unknown@') ? '未知模型' : modelDisplayName(group.displayNameSample || group.key))
          : group.key,
        label: groupBy === 'project' ? (projectLabels[group.key] || null) : undefined,
        agents: [...group.agents].sort((left, right) => AGENT_ORDER.indexOf(left) - AGENT_ORDER.indexOf(right)),
        sessions: group.sessions.size,
        firstAtMs: group.firstAtMs,
        lastAtMs: group.lastAtMs,
        inputTokens: group.inputTokens, cacheReadTokens: group.cacheReadTokens, cacheWriteTokens: group.cacheWriteTokens,
        outputTokens: group.outputTokens, extraTokens: group.extraTokens, totalTokens: group.totalTokens,
        requests: group.requests,
      })).sort((left, right) => right.totalTokens - left.totalTokens || String(left.key).localeCompare(String(right.key))) : null,
      allTimeTotalTokens: Number(sideRow?.total || 0),
      earliestEventMs: sideRow?.earliest ? Number(sideRow.earliest) : null,
    };
  }
}

module.exports = { CliUsageStore, AGENT_ORDER };
