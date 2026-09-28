// cli-usage.sqlite:增量索引与聚合。独立于 history.json,只存数值与哈希标识。
// 全部整数按安全整数校验;schema 演进通过 meta.schema_version。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  canonicalModelKey, modelKeyForGrouping, modelDisplayName, hmacHex,
  buildDayBoundaries, localDateString, computeStreaks, createModelRuleMatcher,
} = require('./normalize.cjs');

const SCHEMA_VERSION = '1';

const AGENT_ORDER = ['zcode', 'kimi', 'claude', 'codex'];

const UPSERT_EVENT_SQL = `
INSERT INTO usage_events (
  event_key, agent, occurred_at_ms, session_key, project_key, model, canonical_model_key,
  input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
  reasoning_tokens, extra_tokens, total_tokens, request_count,
  source_version, exact, is_sidechain
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)
ON CONFLICT(event_key) DO UPDATE SET
  -- 同一会话内的流式最终快照取更晚时间;跨会话回放(同 message.id、不同 session)
  -- 保持最初发生时间,避免把事件挪到回放那天
  occurred_at_ms = CASE WHEN excluded.session_key = session_key
    THEN MAX(occurred_at_ms, excluded.occurred_at_ms)
    ELSE MIN(occurred_at_ms, excluded.occurred_at_ms) END,
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
`);
    this.ensureMeta();
    this.upsertEventStatement = this.db.prepare(UPSERT_EVENT_SQL);
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
          event.eventKey, event.agent, event.occurredAtMs, event.sessionKey,
          event.projectKey, event.model, event.canonicalModelKey,
          event.inputTokens, event.cacheReadTokens, event.cacheWriteTokens, event.outputTokens,
          event.reasoningTokens, event.extraTokens, event.totalTokens, event.requestCount,
          event.sourceVersion, event.exact ? 1 : 0, event.isSidechain ? 1 : 0,
        );
        written += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return written;
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

  countEvents(agent) {
    const row = this.db.prepare('SELECT COUNT(*) AS records FROM usage_events WHERE agent = ?').get(agent);
    return Number(row?.records || 0);
  }

  hasAnyEvents() {
    return this.countEventsAll() > 0;
  }

  countEventsAll() {
    const row = this.db.prepare('SELECT COUNT(*) AS records FROM usage_events').get();
    return Number(row?.records || 0);
  }

  earliestEventMs(agentFilter, modelRules = null) {
    if (modelRules === null || modelRules === undefined) {
      const row = agentFilter && agentFilter !== 'all'
        ? this.db.prepare('SELECT MIN(occurred_at_ms) AS earliest FROM usage_events WHERE agent = ?').get(agentFilter)
        : this.db.prepare('SELECT MIN(occurred_at_ms) AS earliest FROM usage_events').get();
      return row?.earliest ? Number(row.earliest) : null;
    }
    const matchesModel = createModelRuleMatcher(modelRules);
    const filterByAgent = agentFilter && agentFilter !== 'all';
    const iterator = filterByAgent
      ? this.db.prepare('SELECT occurred_at_ms, model, canonical_model_key FROM usage_events WHERE agent = ? ORDER BY occurred_at_ms').iterate(agentFilter)
      : this.db.prepare('SELECT occurred_at_ms, model, canonical_model_key FROM usage_events ORDER BY occurred_at_ms').iterate();
    for (const row of iterator) {
      if (matchesModel(row.canonical_model_key, row.model)) return Number(row.occurred_at_ms);
    }
    return null;
  }

  totalTokensAll(agentFilter, modelRules = null) {
    if (modelRules === null || modelRules === undefined) {
      const row = agentFilter && agentFilter !== 'all'
        ? this.db.prepare('SELECT SUM(total_tokens) AS total FROM usage_events WHERE agent = ?').get(agentFilter)
        : this.db.prepare('SELECT SUM(total_tokens) AS total FROM usage_events').get();
      return Number(row?.total || 0);
    }
    const matchesModel = createModelRuleMatcher(modelRules);
    const filterByAgent = agentFilter && agentFilter !== 'all';
    const iterator = filterByAgent
      ? this.db.prepare('SELECT model, canonical_model_key, total_tokens FROM usage_events WHERE agent = ?').iterate(agentFilter)
      : this.db.prepare('SELECT model, canonical_model_key, total_tokens FROM usage_events').iterate();
    let total = 0;
    for (const row of iterator) {
      if (matchesModel(row.canonical_model_key, row.model)) total += Number(row.total_tokens) || 0;
    }
    return total;
  }

  matchingModels(agentFilter, modelRules) {
    if (modelRules === null || modelRules === undefined) return [];
    const matchesModel = createModelRuleMatcher(modelRules);
    const filterByAgent = agentFilter && agentFilter !== 'all';
    const iterator = filterByAgent
      ? this.db.prepare('SELECT canonical_model_key, MIN(model) AS model FROM usage_events WHERE agent = ? GROUP BY canonical_model_key').iterate(agentFilter)
      : this.db.prepare('SELECT canonical_model_key, MIN(model) AS model FROM usage_events GROUP BY canonical_model_key').iterate();
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

  matchingRecordsByAgent(modelRules) {
    if (modelRules === null || modelRules === undefined) return null;
    const matchesModel = createModelRuleMatcher(modelRules);
    const counts = Object.fromEntries(AGENT_ORDER.map((agent) => [agent, 0]));
    const iterator = this.db.prepare('SELECT agent, model, canonical_model_key, COUNT(*) AS records FROM usage_events GROUP BY agent, canonical_model_key, model').iterate();
    for (const row of iterator) {
      if (!matchesModel(row.canonical_model_key, row.model)) continue;
      counts[row.agent] = (counts[row.agent] || 0) + Number(row.records || 0);
    }
    return counts;
  }

  // ---- 聚合:近一年摘要 ---------------------------------------------------

  summary({ agent, timezone, endDate, days = 365, modelRules = null }) {
    // endDate 缺省为该时区今天(双保险:facade 的 IPC 层也会先规整)
    const effectiveEndDate = endDate || localDateString(timezone);
    const boundaries = buildDayBoundaries(timezone, effectiveEndDate, days);
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

    const filterByAgent = agent && agent !== 'all';
    const iterate = filterByAgent
      ? this.db.prepare('SELECT agent, occurred_at_ms, session_key, model, canonical_model_key, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, total_tokens FROM usage_events WHERE agent = ? AND occurred_at_ms >= ? AND occurred_at_ms < ? ORDER BY occurred_at_ms')
      : this.db.prepare('SELECT agent, occurred_at_ms, session_key, model, canonical_model_key, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, total_tokens FROM usage_events WHERE occurred_at_ms >= ? AND occurred_at_ms < ? ORDER BY occurred_at_ms');
    const params = filterByAgent ? [agent, startMs, endMs] : [startMs, endMs];

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
    // 累计口径:全部已索引历史;若最早事件早于窗口起点,说明只覆盖部分区间
    const allHistoryTokens = this.totalTokensAll(agent, modelRules);
    const earliest = this.earliestEventMs(agent, modelRules);

    return {
      range: { start: boundaries[0].date, end: boundaries[boundaries.length - 1].date, timezone },
      filter: { agent, timezone, endDate, modelRules },
      matchedModels: this.matchingModels(agent, modelRules),
      recordsByAgent: this.matchingRecordsByAgent(modelRules),
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

  models({ agent, mergeSameModels, scope, timezone, modelRules = null }) {
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
    } else {
      endDate = localDateString(timezone);
      startDate = null;
      const boundaries = buildDayBoundaries(timezone, endDate, scope.days);
      startDate = boundaries[0].date;
      startMs = boundaries[0].startMs;
      endMs = boundaries[boundaries.length - 1].endMs;
    }

    const groups = new Map();
    const matchesModel = createModelRuleMatcher(modelRules);
    const select = filterByAgent
      ? 'SELECT agent, session_key, model, canonical_model_key, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, extra_tokens, total_tokens FROM usage_events WHERE agent = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?'
      : 'SELECT agent, session_key, model, canonical_model_key, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, extra_tokens, total_tokens FROM usage_events WHERE occurred_at_ms >= ? AND occurred_at_ms < ?';
    const params = filterByAgent ? [agent, startMs, endMs] : [startMs, endMs];

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
      filter: { agent, mergeSameModels, effectiveMergeSameModels: effectiveMerge, scope, modelRules },
      models: rows,
    };
  }
}

module.exports = { CliUsageStore, AGENT_ORDER };
