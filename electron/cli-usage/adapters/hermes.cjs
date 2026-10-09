// Hermes Agent 适配器:~/.hermes/state.db 的 sessions 表——每会话一行累计值。
// 对齐 ccusage hermes adapter:started_at 秒/毫秒自适应,reasoning 计入 total
// 缺口(extra),provider 归一化;跨库同 session 幂等(键含 rootId,重扫 UPSERT)。
const fs = require('node:fs');
const path = require('node:path');
const { detectHermesRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { lenientUint } = require('./parse-utils.cjs');
const { openSqlite } = require('./sqlite-open.cjs');

const QUERY_SQL = `
SELECT
  id, model, billing_provider, started_at, message_count,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, estimated_cost_usd, actual_cost_usd
FROM sessions
WHERE model IS NOT NULL AND TRIM(model) != ''
`;

const toUint = (value) => lenientUint(value) ?? 0;

// started_at 容忍秒级(>1e12 视为毫秒)
const timestampFromNumber = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const millis = num > 1e12 ? num : num * 1000;
  const floored = Math.floor(millis);
  return floored > 0 ? floored : null;
};

const PROVIDER_ALIASES = [
  [/^(anthropic|claude)$/i, 'anthropic'],
  [/^(openai|openai[_-]?codex)$/i, 'openai'],
  [/^(google|google[_-]?ai|gemini|vertex|vertex[_-]?ai)$/i, 'google'],
];

const normalizeProvider = (value, model) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return inferProviderFromModel(model);
  const normalized = raw.toLowerCase().replace(/-/g, '_');
  for (const [pattern, canonical] of PROVIDER_ALIASES) {
    if (pattern.test(normalized)) return canonical;
  }
  return normalized;
};

const inferProviderFromModel = (model) => {
  const lower = String(model).toLowerCase();
  if (lower.startsWith('claude-') || lower.startsWith('claude/')) return 'anthropic';
  if (lower.startsWith('gpt') || lower.startsWith('chatgpt') || (/^o\d/.test(lower))) return 'openai';
  if (lower.startsWith('gemini-') || lower.startsWith('gemini/')) return 'google';
  return 'hermes';
};

const adapter = {
  id: 'hermes',
  displayName: 'Hermes Agent',
  iconKey: 'hermes',
  colorToken: 'amber',
  defaultRootLabels: ['~/.hermes'],

  detect: detectHermesRoots,

  // SQLite 来源:整表重读 + 按 sessions.id UPSERT,幂等覆盖会话累计值的增长
  async *collect(root, ctx) {
    const dbPath = path.join(root.rootPath, 'state.db');
    if (!fs.existsSync(dbPath)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    let rows = [];
    let opened;
    let db;
    try {
      opened = openSqlite(dbPath);
      db = opened.db;
      rows = db.prepare(QUERY_SQL).all();
    } catch (error) {
      ctx.markRoot(root.rootId, 'incompatible', `Hermes 数据库无法读取(${error.code || 'SCHEMA'})`);
      return;
    } finally {
      try { db?.close(); } catch { /* 关闭失败忽略 */ }
      try { opened?.cleanup?.(); } catch { /* 清理失败忽略 */ }
    }
    ctx.saveFileState(root.rootId, 'state.db', { lastScanMs: Date.now(), formatVersion: 1 });
    for (const row of rows) {
      const model = typeof row.model === 'string' ? row.model.trim() : '';
      if (!model || !row.id) continue;
      const occurredAtMs = timestampFromNumber(row.started_at);
      if (!occurredAtMs) continue;
      const inputTokens = toUint(row.input_tokens);
      const outputTokens = toUint(row.output_tokens);
      const cacheReadTokens = toUint(row.cache_read_tokens);
      const cacheWriteTokens = toUint(row.cache_write_tokens);
      const reasoningTokens = toUint(row.reasoning_tokens);
      if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens && !reasoningTokens) continue;
      const event = buildUsageEvent({
        eventKey: `hermes:${root.rootId}:${row.id}`,
        agent: 'hermes',
        occurredAtMs,
        sessionKey: ctx.hmac(`hermes:${row.id}`),
        projectKey: null, // sessions 表不含项目路径
        model,
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
        reasoningTokens,
        providerTotalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
        sourceVersion: normalizeProvider(row.billing_provider, model),
        exact: true,
      });
      if (event) yield event;
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
