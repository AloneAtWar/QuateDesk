// ZCode 适配器:只读查询 ~/.zcode/cli/db/db.sqlite 的 model_usage。
// ZCode 使用 WAL,直接以 readOnly 打开原库(能读到 WAL 中未 checkpoint 的最新行),
// 绝不复制单文件、绝不用 immutable 模式。input_tokens 含缓存读写,需扣除。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { detectZcodeRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');

const QUERY_SQL = `
SELECT
  mu.id, mu.session_id, mu.model_id, mu.provider_id,
  mu.started_at, mu.completed_at,
  mu.input_tokens, mu.output_tokens, mu.reasoning_tokens,
  mu.cache_creation_input_tokens, mu.cache_read_input_tokens,
  mu.provider_total_tokens, mu.computed_total_tokens,
  s.directory, s.version
FROM model_usage mu
LEFT JOIN session s ON s.id = mu.session_id
WHERE MAX(mu.started_at, COALESCE(mu.completed_at, 0)) >= ?
ORDER BY mu.started_at, mu.id
`;

const ZCODE_LOOKBACK_DAYS = 7;

const adapter = {
  id: 'zcode',
  displayName: 'ZCode',
  iconKey: 'zcode',
  colorToken: 'cyan',
  defaultRootLabels: ['~/.zcode'],

  detect: detectZcodeRoots,

  // SQLite 来源没有字节游标:每次回看最近 7 天并按 model_usage.id UPSERT,
  // 覆盖先创建、后补齐 completed_at 与 Token 的请求
  async *collect(root, ctx) {
    const dbPath = path.join(root.rootPath, 'cli', 'db', 'db.sqlite');
    if (!fs.existsSync(dbPath)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    let db;
    let rows;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout = 2000'); } catch { /* 只读连接忽略 */ }
      const state = ctx.getFileState(root.rootId, 'db.sqlite');
      const now = Date.now();
      const lastScan = Number(state?.lastScanMs) || 0;
      const lookbackFloor = lastScan > 0 ? now - ZCODE_LOOKBACK_DAYS * 86_400_000 : 0;
      rows = db.prepare(QUERY_SQL).all(lookbackFloor);
    } catch (error) {
      ctx.markRoot(root.rootId, 'incompatible', `ZCode 数据库无法读取(${error.code || 'SCHEMA'})`);
      return;
    } finally {
      try { db?.close(); } catch { /* 关闭失败忽略 */ }
    }
    ctx.saveFileState(root.rootId, 'db.sqlite', { lastScanMs: Date.now(), formatVersion: 1 });
    for (const row of rows) {
      const event = buildUsageEvent({
        eventKey: `zcode:${root.rootId}:${row.id}`,
        agent: 'zcode',
        occurredAtMs: Number(row.completed_at) > 0 ? Number(row.completed_at) : Number(row.started_at),
        sessionKey: ctx.hmac(`zcode:${row.session_id || ''}`),
        projectKey: row.directory ? ctx.hmac(row.directory) : null,
        model: row.model_id,
        inputTokens: Math.max(0, Number(row.input_tokens || 0) - Number(row.cache_read_input_tokens || 0) - Number(row.cache_creation_input_tokens || 0)),
        cacheReadTokens: row.cache_read_input_tokens,
        cacheWriteTokens: row.cache_creation_input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
        providerTotalTokens: row.provider_total_tokens ?? row.computed_total_tokens,
        sourceVersion: row.version,
        exact: true,
      });
      if (event) yield event;
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
