// MiniMax Code 适配器:~/.minimax/sqlite.db 的 token_usage 表——每个 (session,
// turn) 一行,字段与统一公式一一对应(total = input + output + cacheRead,已验证,
// 不再重复给 providerTotal)。sessions.workspace_dir 补项目目录;model 形如
// "minimax/MiniMax-M2.7",适配层剥掉平台前缀,canonical 层无需新增规则。
const fs = require('node:fs');
const path = require('node:path');
const { detectMinimaxRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { lenientUint } = require('./parse-utils.cjs');
const { openSqlite } = require('./sqlite-open.cjs');

const MINIMAX_LOOKBACK_DAYS = 7;

const toUint = (value) => lenientUint(value) ?? 0;

const tableExists = (db, table) => Boolean(
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
);

const tableColumns = (db, table) => new Set(
  db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
);

// ts 为毫秒时间戳(真机样本 1.78e12);容忍秒级以防万一
const timestampFromNumber = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const millis = num > 1e12 ? num : num * 1000;
  const floored = Math.floor(millis);
  return floored > 0 ? floored : null;
};

const adapter = {
  id: 'minimax',
  displayName: 'MiniMax Code',
  iconKey: 'minimax',
  colorToken: 'cyan',
  defaultRootLabels: ['~/.minimax'],

  detect: detectMinimaxRoots,

  async *collect(root, ctx) {
    const dbPath = path.join(root.rootPath, 'sqlite.db');
    if (!fs.existsSync(dbPath)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    let opened;
    let db;
    try {
      opened = openSqlite(dbPath);
      db = opened.db;
    } catch (error) {
      ctx.markRoot(root.rootId, 'incompatible', `MiniMax 数据库无法读取(${error.code || 'SCHEMA'})`);
      return;
    }
    try {
      if (!tableExists(db, 'token_usage')) {
        ctx.markRoot(root.rootId, 'incompatible', 'MiniMax 数据库缺少 token_usage 表');
        return;
      }
      // sessions 表带 workspace_dir 时关联项目目录;老版本没有该列就静默跳过
      const workspaces = new Map();
      if (tableExists(db, 'sessions') && tableColumns(db, 'sessions').has('workspace_dir')) {
        try {
          for (const row of db.prepare('SELECT session_id, workspace_dir FROM sessions').all()) {
            if (row?.session_id && typeof row.workspace_dir === 'string' && row.workspace_dir.trim()) {
              workspaces.set(String(row.session_id), row.workspace_dir);
            }
          }
        } catch { /* 列语义变化时忽略项目关联 */ }
      }

      const state = ctx.getFileState(root.rootId, 'sqlite.db');
      const now = Date.now();
      const lastScan = Number(state?.lastScanMs) || 0;
      const floor = lastScan > 0 ? now - MINIMAX_LOOKBACK_DAYS * 86_400_000 : 0;
      const rows = db.prepare('SELECT id, session_id, turn_id, model, framework_type, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens FROM token_usage WHERE ts >= ? ORDER BY ts').all(floor);
      for (const row of rows) {
        const occurredAtMs = timestampFromNumber(row.ts);
        if (!occurredAtMs || !row.session_id || row.id === null || row.id === undefined) continue;
        const inputTokens = toUint(row.input_tokens);
        const outputTokens = toUint(row.output_tokens);
        const cacheReadTokens = toUint(row.cache_read_tokens);
        const cacheWriteTokens = toUint(row.cache_write_tokens);
        const reasoningTokens = toUint(row.reasoning_tokens);
        if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens && !reasoningTokens) continue;
        const rawModel = typeof row.model === 'string' ? row.model.trim() : '';
        const model = rawModel.replace(/^minimax\//i, '');
        const cwd = workspaces.get(String(row.session_id)) || null;
        const event = buildUsageEvent({
          eventKey: `minimax:${root.rootId}:${row.session_id}:${row.id}`,
          agent: 'minimax',
          occurredAtMs,
          sessionKey: ctx.hmac(`minimax:${row.session_id}`),
          projectKey: cwd ? ctx.hmac(`minimax:${cwd}`) : null,
          projectDir: cwd,
          model: model || null,
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          outputTokens,
          reasoningTokens,
          providerTotalTokens: null,
          sourceVersion: typeof row.framework_type === 'string' && row.framework_type.trim() ? row.framework_type.trim() : null,
          exact: true,
        });
        if (event) yield event;
      }
      ctx.saveFileState(root.rootId, 'sqlite.db', { lastScanMs: Date.now(), formatVersion: 1 });
      ctx.markRoot(root.rootId, 'ready', null);
    } finally {
      try { db.close(); } catch { /* 关闭失败忽略 */ }
      try { opened?.cleanup?.(); } catch { /* 清理失败忽略 */ }
    }
  },
};

module.exports = adapter;
