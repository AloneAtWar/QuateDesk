// OpenCode 适配器:~/.local/share/opencode/opencode.db(SQLite)。
// 对齐 ccusage opencode adapter 的三层来源——message 表(逐消息,带 model/provider)、
// session_message 事件表(新版 v2,跳过 fork 继承父历史的拷贝行)、
// session/session_v2 聚合(仅兜底"没有任何消息行"的会话)。
// 聚合是会话累计值,一旦会话出现消息行即撤回聚合事件,避免双计。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { detectOpencodeRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { lenientUint, applyTotalTokenFallback } = require('./parse-utils.cjs');

const OPENCODE_LOOKBACK_DAYS = 7;

const toUint = (value) => lenientUint(value) ?? 0;

const tableExists = (db, table) => Boolean(
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
);

const tableColumns = (db, table) => new Set(
  db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
);

// 消息级 usage → 事件:modelID/providerID 缺一不可(对齐 ccusage 的硬性要求);
// total 缺口优先补 output,reasoning 进 extra
const messageEvent = ({ eventKey, sessionKey, projectKey, model, provider, occurredAtMs, tokens }) => {
  const cache = tokens.cache && typeof tokens.cache === 'object' && !Array.isArray(tokens.cache) ? tokens.cache : {};
  const classified = {
    inputTokens: toUint(tokens.input),
    outputTokens: toUint(tokens.output),
    cacheReadTokens: toUint(cache.read),
    cacheWriteTokens: toUint(cache.write),
  };
  const { outputTokens, extraTokens } = applyTotalTokenFallback(classified, toUint(tokens.reasoning), toUint(tokens.total));
  if (!classified.inputTokens && !outputTokens && !classified.cacheReadTokens && !classified.cacheWriteTokens && !extraTokens) return null;
  return buildUsageEvent({
    eventKey,
    agent: 'opencode',
    occurredAtMs,
    sessionKey,
    projectKey,
    model,
    inputTokens: classified.inputTokens,
    cacheReadTokens: classified.cacheReadTokens,
    cacheWriteTokens: classified.cacheWriteTokens,
    outputTokens,
    reasoningTokens: toUint(tokens.reasoning),
    providerTotalTokens: classified.inputTokens + outputTokens + classified.cacheReadTokens + classified.cacheWriteTokens + extraTokens,
    sourceVersion: provider,
    exact: true,
  });
};

// session 表 model 列可能是裸模型名或 JSON 字符串/对象(对齐 parse_session_model)
const parseSessionModel = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string' && parsed.trim()) return { model: parsed.trim(), provider: 'unknown' };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const model = (typeof parsed.id === 'string' && parsed.id.trim()) || (typeof parsed.modelID === 'string' && parsed.modelID.trim()) || null;
      if (!model) return null;
      const provider = (typeof parsed.providerID === 'string' && parsed.providerID.trim())
        || (typeof parsed.provider === 'string' && parsed.provider.trim())
        || 'unknown';
      return { model, provider };
    }
  } catch { /* 裸模型名 */ }
  return { model: raw, provider: 'unknown' };
};

// session_v2 fork 元数据 → 每个 fork 会话"仍是父历史拷贝"的最大 seq
const forkCopyCutoffs = (db) => {
  const cutoffs = new Map();
  if (!tableExists(db, 'session_v2') || !tableExists(db, 'session_message')) return cutoffs;
  const v2Columns = tableColumns(db, 'session_v2');
  for (const column of ['id', 'fork_session_id', 'fork_boundary']) {
    if (!v2Columns.has(column)) return cutoffs;
  }
  const messageColumns = tableColumns(db, 'session_message');
  if (!messageColumns.has('seq')) return cutoffs;
  let forks = [];
  try {
    forks = db.prepare('SELECT id, fork_session_id, fork_boundary FROM session_v2 WHERE fork_session_id IS NOT NULL AND fork_boundary IS NOT NULL').all();
  } catch { return cutoffs; }
  for (const fork of forks) {
    if (!fork.id || !fork.fork_session_id) continue;
    let boundary;
    try { boundary = JSON.parse(fork.fork_boundary); } catch { continue; }
    const parentMessageId = boundary?.messageID;
    if (!parentMessageId || typeof parentMessageId !== 'string') continue;
    const boundaryRow = db.prepare('SELECT seq FROM session_message WHERE session_id = ? AND id = ? LIMIT 1').get(fork.fork_session_id, parentMessageId);
    if (!boundaryRow) continue;
    if (boundary?.type === 'through') {
      cutoffs.set(fork.id, Number(boundaryRow.seq));
    } else if (boundary?.type === 'before') {
      const row = db.prepare('SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ? AND seq < ?').get(fork.fork_session_id, Number(boundaryRow.seq));
      if (row && row.seq !== null && row.seq !== undefined) cutoffs.set(fork.id, Number(row.seq));
    }
  }
  return cutoffs;
};

const adapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  iconKey: 'opencode',
  colorToken: 'coral',
  defaultRootLabels: ['~/.local/share/opencode'],

  detect: detectOpencodeRoots,

  async *collect(root, ctx) {
    const dbPath = path.join(root.rootPath, 'opencode.db');
    if (!fs.existsSync(dbPath)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      try { db.exec('PRAGMA busy_timeout = 2000'); } catch { /* 只读连接忽略 */ }
    } catch (error) {
      ctx.markRoot(root.rootId, 'incompatible', `OpenCode 数据库无法读取(${error.code || 'SCHEMA'})`);
      return;
    }
    try {
      const state = ctx.getFileState(root.rootId, 'opencode.db');
      const now = Date.now();
      const lastScan = Number(state?.lastScanMs) || 0;
      const floor = lastScan > 0 ? now - OPENCODE_LOOKBACK_DAYS * 86_400_000 : 0;
      const coveredSessions = new Set(); // 有消息行的会话:聚合不再兜底

      // 第一层:message 表(逐消息,project 取 session.directory)
      if (tableExists(db, 'message')) {
        const rows = db.prepare(`
          SELECT m.id, m.session_id, m.data, s.directory
          FROM message m LEFT JOIN session s ON s.id = m.session_id
          WHERE m.time_created >= ?
        `).all(floor);
        for (const row of rows) {
          if (!row.id || !row.session_id) continue;
          coveredSessions.add(row.session_id);
          let value;
          try { value = JSON.parse(row.data); } catch { continue; }
          if (!value || typeof value !== 'object') continue;
          const model = typeof value.modelID === 'string' && value.modelID.trim() ? value.modelID : null;
          const provider = typeof value.providerID === 'string' && value.providerID.trim() ? value.providerID : null;
          if (!model || !provider) continue;
          const occurredAtMs = toUint(value?.time?.created);
          if (!occurredAtMs) continue; // 无时间戳无法落日桶
          const event = messageEvent({
            eventKey: `opencode:${root.rootId}:msg:${row.id}`,
            sessionKey: ctx.hmac(`opencode:${row.session_id}`),
            projectKey: row.directory ? ctx.hmac(row.directory) : null,
            model,
            provider,
            occurredAtMs,
            tokens: value.tokens,
          });
          if (event) yield event;
        }
      }

      // 第二层:session_message(v2 事件表)。fork 拷贝行不计数也不算覆盖
      let v2HasSeq = false;
      let cutoffs = new Map();
      if (tableExists(db, 'session_message')) {
        const columns = tableColumns(db, 'session_message');
        if (['id', 'session_id', 'type', 'data'].every((column) => columns.has(column))) {
          v2HasSeq = columns.has('seq');
          cutoffs = v2HasSeq ? forkCopyCutoffs(db) : cutoffs;
          const rows = db.prepare(`
            SELECT id, session_id, type, data, time_created${v2HasSeq ? ', seq' : ''}
            FROM session_message WHERE time_created >= ?
          `).all(floor);
          for (const row of rows) {
            if (row.type !== 'assistant' || !row.id || !row.session_id) continue;
            if (v2HasSeq) {
              const cutoff = cutoffs.get(row.session_id);
              if (cutoff !== undefined && Number(row.seq) <= cutoff) continue;
            }
            let value;
            try { value = JSON.parse(row.data); } catch { continue; }
            if (!value || typeof value !== 'object') continue;
            const modelRef = value.model && typeof value.model === 'object' && !Array.isArray(value.model) ? value.model : {};
            const model = (typeof modelRef.id === 'string' && modelRef.id.trim())
              || (typeof modelRef.modelID === 'string' && modelRef.modelID.trim())
              || (typeof value.modelID === 'string' && value.modelID.trim())
              || null;
            const provider = (typeof modelRef.providerID === 'string' && modelRef.providerID.trim())
              || (typeof value.providerID === 'string' && value.providerID.trim())
              || null;
            if (!model || !provider) continue;
            const occurredAtMs = toUint(value?.time?.created) || toUint(row.time_created);
            if (!occurredAtMs) continue;
            coveredSessions.add(row.session_id);
            const event = messageEvent({
              eventKey: `opencode:${root.rootId}:msg:${row.id}`,
              sessionKey: ctx.hmac(`opencode:${row.session_id}`),
              projectKey: null, // v2 事件表不含目录,靠 session 聚合层补不了(已覆盖)
              model,
              provider,
              occurredAtMs,
              tokens: value.tokens,
            });
            if (event) yield event;
          }
        }
      }

      // 第三层:session(以及 session_v2)聚合兜底——只补没有任何消息行的会话;
      // 全历史 DISTINCT 覆盖集合判定,消息行与聚合同事务写入,竞态下靠撤回兜底
      const aggregateTables = [];
      if (tableExists(db, 'session_v2')) aggregateTables.push('session_v2');
      if (tableExists(db, 'session')) aggregateTables.push('session');
      const allCovered = new Set(coveredSessions);
      for (const table of ['message', 'session_message']) {
        if (!tableExists(db, table)) continue;
        try {
          const rows = table === 'message'
            ? db.prepare('SELECT DISTINCT session_id FROM message').all()
            : db.prepare("SELECT DISTINCT session_id FROM session_message WHERE type = 'assistant'").all();
          for (const row of rows) if (row.session_id) allCovered.add(row.session_id);
        } catch { /* 列缺失时忽略该来源 */ }
      }
      if (allCovered.size) {
        // 会话一旦出现消息行,撤回早前兜底写入的聚合事件;分块防止超出
        // SQLite 绑定变量上限
        const coveredKeys = [...allCovered].map((sessionId) => ctx.hmac(`opencode:${sessionId}`));
        for (let index = 0; index < coveredKeys.length; index += 500) {
          ctx.deleteEvents({ eventKeyPrefix: `opencode:${root.rootId}:agg:`, sessionKeys: coveredKeys.slice(index, index + 500) });
        }
      }
      for (const table of aggregateTables) {
        const columns = tableColumns(db, table);
        const required = ['id', 'time_created', 'tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_write'];
        if (required.some((column) => !columns.has(column))) continue;
        const rows = db.prepare(`
          SELECT id, time_created, cost, tokens_input, tokens_output,
                 tokens_cache_read, tokens_cache_write${columns.has('tokens_reasoning') ? ', tokens_reasoning' : ', 0 AS tokens_reasoning'}${columns.has('model') ? ', model' : ', NULL AS model'}${columns.has('directory') ? ', directory' : ', NULL AS directory'}
          FROM ${table}
        `).all();
        for (const row of rows) {
          if (!row.id || allCovered.has(row.id)) continue;
          const occurredAtMs = toUint(row.time_created);
          if (!occurredAtMs) continue;
          const parsed = parseSessionModel(row.model);
          const model = parsed?.model || 'unknown';
          const provider = parsed?.provider || 'unknown';
          const event = messageEvent({
            eventKey: `opencode:${root.rootId}:agg:${row.id}`,
            sessionKey: ctx.hmac(`opencode:${row.id}`),
            projectKey: row.directory ? ctx.hmac(row.directory) : null,
            model,
            provider,
            occurredAtMs,
            tokens: {
              input: row.tokens_input,
              output: row.tokens_output,
              reasoning: row.tokens_reasoning,
              cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
            },
          });
          if (event) yield event;
        }
      }

      ctx.saveFileState(root.rootId, 'opencode.db', { lastScanMs: Date.now(), formatVersion: 1 });
      ctx.markRoot(root.rootId, 'ready', null);
    } finally {
      try { db.close(); } catch { /* 关闭失败忽略 */ }
    }
  },
};

module.exports = adapter;
