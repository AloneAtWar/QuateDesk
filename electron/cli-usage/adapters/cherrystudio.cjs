// Cherry Studio 适配器:%APPDATA%/CherryStudio/Data/cherrystudio.sqlite 的
// ai_usage_record 表(请求级用量)。record_kind=invocation 是逐请求精确值;
// legacy-aggregate 是旧版本迁移来的按消息聚合值(exact=false)。
// 输入拆分:no_cache_tokens 是未命中缓存的输入,缺失时按 input - cacheR - cacheW
// 兜底(真机样本为空表,语义按列名与 OpenAI 口径保守推断并留兜底)。
// 会话维度用 source_id(assistant/agent 容器),聊天客户端无项目目录概念。
const fs = require('node:fs');
const path = require('node:path');
const { detectCherrystudioRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { lenientUint } = require('./parse-utils.cjs');
const { openSqlite } = require('./sqlite-open.cjs');

const CHERRY_LOOKBACK_DAYS = 7;

const toUint = (value) => lenientUint(value) ?? 0;

const tableExists = (db, table) => Boolean(
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
);

// created_at 为毫秒(Cherry Studio 全库统一 Date.now());容忍秒级以防万一
const timestampFromNumber = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const millis = num > 1e12 ? num : num * 1000;
  const floored = Math.floor(millis);
  return floored > 0 ? floored : null;
};

const adapter = {
  id: 'cherrystudio',
  displayName: 'Cherry Studio',
  iconKey: 'cherrystudio',
  colorToken: 'violet',
  defaultRootLabels: ['%APPDATA%/CherryStudio/Data'],

  detect: detectCherrystudioRoots,

  async *collect(root, ctx) {
    const dbPath = path.join(root.rootPath, 'cherrystudio.sqlite');
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
      ctx.markRoot(root.rootId, 'incompatible', `Cherry Studio 数据库无法读取(${error.code || 'SCHEMA'})`);
      return;
    }
    try {
      if (!tableExists(db, 'ai_usage_record')) {
        ctx.markRoot(root.rootId, 'incompatible', 'Cherry Studio 数据库缺少 ai_usage_record 表');
        return;
      }
      const state = ctx.getFileState(root.rootId, 'cherrystudio.sqlite');
      const now = Date.now();
      const lastScan = Number(state?.lastScanMs) || 0;
      const floor = lastScan > 0 ? now - CHERRY_LOOKBACK_DAYS * 86_400_000 : 0;
      const rows = db.prepare('SELECT id, request_id, record_kind, provider_id, model_id, model_name, source_id, message_id, modality, input_tokens, output_tokens, total_tokens, reasoning_tokens, no_cache_tokens, cache_read_tokens, cache_write_tokens, created_at FROM ai_usage_record WHERE created_at >= ? ORDER BY created_at').all(floor);
      for (const row of rows) {
        const occurredAtMs = timestampFromNumber(row.created_at);
        if (!occurredAtMs || !row.id) continue;
        const cacheReadTokens = toUint(row.cache_read_tokens);
        const cacheWriteTokens = toUint(row.cache_write_tokens);
        const outputTokens = toUint(row.output_tokens);
        // no_cache 缺失时从 input 里扣除缓存部分;负值截断
        const inputTokens = row.no_cache_tokens !== null && row.no_cache_tokens !== undefined
          ? toUint(row.no_cache_tokens)
          : Math.max(0, toUint(row.input_tokens) - cacheReadTokens - cacheWriteTokens);
        const reasoningTokens = toUint(row.reasoning_tokens);
        if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens && !reasoningTokens) continue;
        const rawModel = (typeof row.model_name === 'string' && row.model_name.trim()) || (typeof row.model_id === 'string' && row.model_id.trim()) || '';
        const sessionSeed = row.source_id || row.message_id || row.request_id || row.id;
        const totalTokens = toUint(row.total_tokens);
        const event = buildUsageEvent({
          eventKey: `cherrystudio:${root.rootId}:${row.record_kind === 'invocation' ? 'inv' : 'agg'}:${row.id}`,
          agent: 'cherrystudio',
          occurredAtMs,
          sessionKey: ctx.hmac(`cherrystudio:${sessionSeed}`),
          projectKey: null,
          model: rawModel || null,
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          outputTokens,
          reasoningTokens,
          providerTotalTokens: totalTokens > 0 ? totalTokens : null,
          sourceVersion: typeof row.provider_id === 'string' && row.provider_id.trim() ? row.provider_id.trim() : null,
          exact: row.record_kind === 'invocation',
        });
        if (event) yield event;
      }
      ctx.saveFileState(root.rootId, 'cherrystudio.sqlite', { lastScanMs: Date.now(), formatVersion: 1 });
      ctx.markRoot(root.rootId, 'ready', null);
    } finally {
      try { db.close(); } catch { /* 关闭失败忽略 */ }
      try { opened?.cleanup?.(); } catch { /* 清理失败忽略 */ }
    }
  },
};

module.exports = adapter;
