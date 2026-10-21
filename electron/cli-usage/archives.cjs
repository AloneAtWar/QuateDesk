'use strict';

// Each imported origin owns one complete snapshot. Scanners only write usage_events;
// reports read a namespaced union, so imports can never be changed by a local rescan.
const crypto = require('node:crypto');
const os = require('node:os');

const FORMAT = 'quotadesk-usage-archives';
const VERSION = 1;
const COLUMNS = ['event_key', 'agent', 'root_id', 'occurred_at_ms', 'session_key', 'project_key', 'model', 'canonical_model_key', 'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens', 'extra_tokens', 'total_tokens', 'request_count', 'source_version', 'exact', 'is_sidechain'];
const COUNTERS = ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens', 'extra_tokens', 'total_tokens', 'request_count'];
const optionalStrings = ['root_id', 'project_key', 'model', 'canonical_model_key', 'source_version'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max;
const namespaceKey = (sourceId, key) => crypto.createHash('sha256').update(`${sourceId}:${key}`).digest('hex');
const ordered = (rows, key) => [...rows].sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
const digest = (snapshot) => crypto.createHash('sha256').update(JSON.stringify({ sourceId: snapshot.sourceId, revision: snapshot.revision, complete: snapshot.complete, label: snapshot.label, records: ordered(snapshot.records, 'event_key'), projectLabels: ordered(snapshot.projectLabels, 'key') })).digest('hex');
const statsSql = 'COUNT(*) AS records, COALESCE(SUM(total_tokens), 0) AS totalTokens, MIN(occurred_at_ms) AS firstAt, MAX(occurred_at_ms) AS lastAt';
const statusNames = { added: '新增', updated: '更新', self: '本机来源，已跳过', duplicate: '版本相同，已跳过', older: '版本较旧，已跳过', conflict: '同版本内容冲突，已跳过' };

function validatePackage(payload, agents) {
  if (!isObject(payload) || payload.format !== FORMAT || payload.version !== VERSION || !Array.isArray(payload.archives)
    || payload.archives.length < 1 || payload.archives.length > 256) throw new Error('不是受支持的用量档案文件（账号数据备份请使用原有的“导入数据”）');
  const sources = new Set();
  const archives = payload.archives.map((input) => {
    if (!isObject(input) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.sourceId || '') || sources.has(input.sourceId)
      || !text(input.label, 100) || !Number.isSafeInteger(input.revision) || input.revision < 1
      || input.complete !== true || !Array.isArray(input.records) || input.records.length > 2_000_000
      || !Array.isArray(input.projectLabels) || input.projectLabels.length > 2_000_000) throw new Error('档案来源、版本或完整快照标记无效，不能导入部分档案');
    sources.add(input.sourceId);
    const keys = new Set();
    const records = input.records.map((record) => {
      if (!isObject(record) || !text(record.event_key) || keys.has(record.event_key) || !agents.includes(record.agent)
        || !text(record.session_key) || !Number.isSafeInteger(record.occurred_at_ms) || record.occurred_at_ms < 0 || record.occurred_at_ms > 8.64e15
        || COUNTERS.some((key) => !Number.isSafeInteger(record[key]) || record[key] < 0)
        || optionalStrings.some((key) => record[key] !== null && (typeof record[key] !== 'string' || record[key].length > 4096))
        || ![0, 1].includes(record.exact) || ![0, 1].includes(record.is_sidechain)) throw new Error(`“${input.label}”包含无效或重复的用量记录`);
      keys.add(record.event_key);
      // Only the documented numeric/identifier fields survive import.
      return Object.fromEntries(COLUMNS.map((key) => [key, record[key]]));
    }).sort((a, b) => a.event_key < b.event_key ? -1 : a.event_key > b.event_key ? 1 : 0);
    const labelKeys = new Set();
    const projectLabels = input.projectLabels.map((label) => {
      if (!isObject(label) || !text(label.key) || !text(label.label, 300) || labelKeys.has(label.key)) throw new Error('档案项目标签无效或重复');
      labelKeys.add(label.key);
      return { key: label.key, label: label.label };
    }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const snapshot = { sourceId: input.sourceId, label: input.label, revision: input.revision, complete: true, records, projectLabels };
    snapshot.dataHash = digest(snapshot);
    if (snapshot.dataHash !== input.dataHash) throw new Error(`“${input.label}”档案校验失败，文件可能不完整或已被修改`);
    return snapshot;
  });
  return { format: FORMAT, version: VERSION, archives };
}

class UsageArchives {
  constructor(db, agents) {
    this.db = db;
    this.agents = agents;
    const defaults = { archive_source_id: crypto.randomUUID(), archive_label: os.hostname() || '本机', archive_revision: '1' };
    const insertMeta = db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(defaults)) insertMeta.run(key, value);
    this.sourceId = this.meta('archive_source_id');
    const numeric = new Set([...COUNTERS, 'occurred_at_ms', 'exact', 'is_sidechain']);
    db.exec(`
CREATE TABLE IF NOT EXISTS usage_archive_sources (
  source_id TEXT PRIMARY KEY, label TEXT NOT NULL, revision INTEGER NOT NULL,
  data_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, display_name TEXT, imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imported_usage_events (
  source_id TEXT NOT NULL, ${COLUMNS.map((column) => `${column} ${numeric.has(column) ? 'INTEGER' : 'TEXT'}`).join(', ')},
  PRIMARY KEY (source_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_imported_usage_time ON imported_usage_events(occurred_at_ms);
CREATE INDEX IF NOT EXISTS idx_imported_usage_agent_time ON imported_usage_events(agent, occurred_at_ms);
CREATE TABLE IF NOT EXISTS imported_project_labels (source_id TEXT NOT NULL, project_key TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (source_id, project_key));
CREATE TABLE IF NOT EXISTS usage_archive_imports (import_id TEXT PRIMARY KEY, imported_at TEXT NOT NULL, file_name TEXT NOT NULL, results_json TEXT NOT NULL);
`);
    // Revision changes only when source-owned data changes, never on export or forwarding.
    const changed = COLUMNS.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ');
    const bump = "UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'archive_revision';";
    db.exec(`
CREATE TRIGGER IF NOT EXISTS archive_event_insert AFTER INSERT ON usage_events BEGIN ${bump} END;
CREATE TRIGGER IF NOT EXISTS archive_event_update AFTER UPDATE ON usage_events WHEN ${changed} BEGIN ${bump} END;
CREATE TRIGGER IF NOT EXISTS archive_event_delete AFTER DELETE ON usage_events BEGIN ${bump} END;
CREATE TRIGGER IF NOT EXISTS archive_label_insert AFTER INSERT ON project_labels BEGIN ${bump} END;
CREATE TRIGGER IF NOT EXISTS archive_label_update AFTER UPDATE ON project_labels WHEN OLD.label IS NOT NEW.label BEGIN ${bump} END;
CREATE TRIGGER IF NOT EXISTS archive_label_delete AFTER DELETE ON project_labels BEGIN ${bump} END;
`);
    db.function('archive_namespace', { deterministic: true }, namespaceKey);
    const importedColumns = COLUMNS.map((column) => ['event_key', 'session_key', 'project_key'].includes(column)
      ? `CASE WHEN e.${column} IS NULL THEN NULL ELSE archive_namespace(e.source_id, e.${column}) END AS ${column}` : `e.${column}`);
    db.exec(`CREATE TEMP VIEW reported_usage_events AS
SELECT ${COLUMNS.join(', ')} FROM usage_events UNION ALL
SELECT ${importedColumns.join(', ')} FROM imported_usage_events e JOIN usage_archive_sources s ON s.source_id = e.source_id WHERE s.enabled = 1;`);
  }

  meta(key) { return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value; }

  info() {
    const local = this.db.prepare(`SELECT ${statsSql} FROM usage_events`).get();
    const sources = this.db.prepare(`SELECT s.*, ${statsSql.replaceAll('total_tokens', 'e.total_tokens').replaceAll('occurred_at_ms', 'e.occurred_at_ms').replace('COUNT(*)', 'COUNT(e.event_key)')}
FROM usage_archive_sources s LEFT JOIN imported_usage_events e ON e.source_id = s.source_id GROUP BY s.source_id ORDER BY s.imported_at DESC, s.source_id`).all();
    return {
      local: { sourceId: this.sourceId, label: this.meta('archive_label'), revision: Number(this.meta('archive_revision')), ...local },
      imported: sources.map((row) => ({ sourceId: row.source_id, label: row.display_name || row.label, originLabel: row.label, revision: row.revision, enabled: row.enabled === 1, importedAt: row.imported_at, records: row.records, totalTokens: row.totalTokens, firstAt: row.firstAt, lastAt: row.lastAt })),
      history: this.db.prepare('SELECT * FROM usage_archive_imports ORDER BY imported_at DESC, rowid DESC LIMIT 30').all().map((row) => ({ importId: row.import_id, importedAt: row.imported_at, fileName: row.file_name, results: JSON.parse(row.results_json) })),
    };
  }

  exportPackage(scope = 'local') {
    if (!['local', 'all'].includes(scope)) throw new Error('未知的档案导出范围');
    const snapshots = [{ sourceId: this.sourceId, label: this.meta('archive_label'), revision: Number(this.meta('archive_revision')), complete: true,
      records: this.db.prepare(`SELECT ${COLUMNS.join(', ')} FROM usage_events ORDER BY event_key`).all(),
      projectLabels: this.db.prepare('SELECT project_key AS key, label FROM project_labels ORDER BY project_key').all() }];
    if (scope === 'all') {
      for (const source of this.db.prepare('SELECT * FROM usage_archive_sources ORDER BY source_id').all()) snapshots.push({
        sourceId: source.source_id, label: source.label, revision: source.revision, complete: true,
        records: this.db.prepare(`SELECT ${COLUMNS.join(', ')} FROM imported_usage_events WHERE source_id = ? ORDER BY event_key`).all(source.source_id),
        projectLabels: this.db.prepare('SELECT project_key AS key, label FROM imported_project_labels WHERE source_id = ? ORDER BY project_key').all(source.source_id),
      });
    }
    for (const snapshot of snapshots) snapshot.dataHash = digest(snapshot);
    return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), scope, archives: snapshots };
  }

  planValidated(payload) {
    return payload.archives.map((snapshot) => {
      const existing = this.db.prepare('SELECT * FROM usage_archive_sources WHERE source_id = ?').get(snapshot.sourceId);
      const status = snapshot.sourceId === this.sourceId ? 'self' : !existing ? 'added'
        : snapshot.revision > existing.revision ? 'updated' : snapshot.revision < existing.revision ? 'older'
          : snapshot.dataHash === existing.data_hash ? 'duplicate' : 'conflict';
      return { sourceId: snapshot.sourceId, label: snapshot.label, revision: snapshot.revision, previousRevision: existing?.revision ?? null,
        records: snapshot.records.length, status, message: statusNames[status] };
    });
  }

  preview(payload) { return this.planValidated(validatePackage(payload, this.agents)); }

  importPackage(input, fileName = '用量档案.json') {
    const payload = validatePackage(input, this.agents);
    const importedAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Re-evaluate at commit, not against a possibly stale dialog preview.
      const results = this.planValidated(payload);
      const insert = this.db.prepare(`INSERT INTO imported_usage_events (source_id, ${COLUMNS.join(', ')}) VALUES (${Array(COLUMNS.length + 1).fill('?').join(', ')})`);
      const labelInsert = this.db.prepare('INSERT INTO imported_project_labels (source_id, project_key, label) VALUES (?, ?, ?)');
      for (let index = 0; index < payload.archives.length; index += 1) {
        if (!['added', 'updated'].includes(results[index].status)) continue;
        const snapshot = payload.archives[index];
        this.db.prepare(`INSERT INTO usage_archive_sources (source_id, label, revision, data_hash, imported_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(source_id) DO UPDATE SET label = excluded.label, revision = excluded.revision, data_hash = excluded.data_hash, imported_at = excluded.imported_at`)
          .run(snapshot.sourceId, snapshot.label, snapshot.revision, snapshot.dataHash, importedAt);
        this.db.prepare('DELETE FROM imported_usage_events WHERE source_id = ?').run(snapshot.sourceId);
        this.db.prepare('DELETE FROM imported_project_labels WHERE source_id = ?').run(snapshot.sourceId);
        for (const row of snapshot.records) insert.run(snapshot.sourceId, ...COLUMNS.map((column) => row[column]));
        for (const label of snapshot.projectLabels) labelInsert.run(snapshot.sourceId, label.key, label.label);
      }
      this.db.prepare('INSERT INTO usage_archive_imports (import_id, imported_at, file_name, results_json) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), importedAt, String(fileName).slice(0, 255), JSON.stringify(results));
      this.db.exec('COMMIT');
      return { results, info: this.info() };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  updateSource({ sourceId, label, enabled } = {}) {
    if (!text(sourceId, 100)) throw new Error('档案来源无效');
    if (label !== undefined && (!text(label, 100) || !label.trim())) throw new Error('来源名称应为 1–100 个字符');
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('档案启用状态无效');
    if (sourceId === this.sourceId) {
      if (enabled !== undefined) throw new Error('不能停用本机档案');
      if (label !== undefined && label.trim() !== this.meta('archive_label')) {
        this.db.exec('BEGIN');
        try {
          this.db.prepare("UPDATE meta SET value = ? WHERE key = 'archive_label'").run(label.trim());
          this.db.exec("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'archive_revision'; COMMIT;");
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
    } else {
      if (!this.db.prepare('SELECT 1 FROM usage_archive_sources WHERE source_id = ?').get(sourceId)) throw new Error('导入来源不存在');
      if (label !== undefined) this.db.prepare('UPDATE usage_archive_sources SET display_name = ? WHERE source_id = ?').run(label.trim(), sourceId);
      if (enabled !== undefined) this.db.prepare('UPDATE usage_archive_sources SET enabled = ? WHERE source_id = ?').run(enabled ? 1 : 0, sourceId);
    }
    return this.info();
  }

  deleteSource(sourceId) {
    if (sourceId === this.sourceId) throw new Error('不能通过导入管理删除本机档案');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM imported_usage_events WHERE source_id = ?').run(sourceId);
      this.db.prepare('DELETE FROM imported_project_labels WHERE source_id = ?').run(sourceId);
      this.db.prepare('DELETE FROM usage_archive_sources WHERE source_id = ?').run(sourceId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.info();
  }

  importedProjectLabels() {
    return this.db.prepare('SELECT p.* FROM imported_project_labels p JOIN usage_archive_sources s ON s.source_id = p.source_id WHERE s.enabled = 1').all()
      .map((row) => [namespaceKey(row.source_id, row.project_key), row.label]);
  }
}

module.exports = { UsageArchives, FORMAT, VERSION, COLUMNS, validatePackage };
