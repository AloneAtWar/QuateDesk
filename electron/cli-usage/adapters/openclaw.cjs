// OpenClaw 适配器:会话 JSONL(含 .deleted/.reset 归档名)+ 新版 per-agent
// SQLite(agents/*/agent/openclaw-agent.sqlite 的 transcript_events)。
// 对齐 ccusage openclaw adapter:model_change/model-snapshot 行维护当前模型,
// assistant 消息携带 usage;JSONL 与 SQLite 迁移期共存时按内容身份共用事件键,
// SQLite 行(带修正后计费)通过 UPSERT 自然覆盖 JSONL 旧值。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { detectOpenclawRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { walkJsonlLines, parseJsonLine } = require('./jsonl-walk.cjs');
const { lenientUint, parseIsoTimestampMs, applyTotalTokenFallback } = require('./parse-utils.cjs');

const toUint = (value) => lenientUint(value) ?? 0;

// 会话文件名:<sessionId>.jsonl 或归档变体 <sessionId>.jsonl.deleted.<ts>
const isOpenclawSessionFile = (name) => {
  const index = name.indexOf('.jsonl');
  if (index < 0) return false;
  const suffix = name.slice(index);
  return suffix === '.jsonl' || suffix.startsWith('.jsonl.deleted.') || suffix.startsWith('.jsonl.reset.');
};

const sessionStemOf = (fileName) => {
  const index = fileName.indexOf('.jsonl');
  return index > 0 ? fileName.slice(0, index) : fileName;
};

const isModelChange = (record) => record.type === 'model_change'
  || (record.type === 'custom' && record.customType === 'model-snapshot');

const modelChangeSource = (record) => {
  const source = record.data && typeof record.data === 'object' ? record.data : record;
  const model = (typeof source.modelId === 'string' && source.modelId) || (typeof source.model === 'string' && source.model) || null;
  const provider = typeof source.provider === 'string' && source.provider ? source.provider : null;
  return { model, provider };
};

const timestampFromValue = (value, fallbackMs) => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = parseIsoTimestampMs(value);
    if (parsed !== null) return parsed;
  }
  return fallbackMs;
};

// 单条 assistant 消息 → 事件;内容身份 = 会话+时间+模型+各 token 桶,
// JSONL 与 SQLite 迁移副本共用,保证跨源替换而非双计
const transcriptEvent = ({ record, sessionKey, currentModel, currentProvider, fallbackMs, eventKeyOf }) => {
  if (record.type !== 'message') return null;
  const message = record.message;
  if (!message || typeof message !== 'object' || message.role !== 'assistant') return null;
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return null;
  const classified = {
    inputTokens: toUint(usage.input),
    outputTokens: toUint(usage.output),
    cacheReadTokens: toUint(usage.cacheRead),
    cacheWriteTokens: toUint(usage.cacheWrite),
  };
  const { outputTokens, extraTokens } = applyTotalTokenFallback(classified, 0, toUint(usage.totalTokens));
  if (!classified.inputTokens && !outputTokens && !classified.cacheReadTokens && !classified.cacheWriteTokens && !extraTokens) return null;
  const model = (typeof message.modelId === 'string' && message.modelId)
    || (typeof message.model === 'string' && message.model)
    || currentModel
    || 'unknown';
  const provider = (typeof message.provider === 'string' && message.provider) || currentProvider || null;
  const occurredAtMs = timestampFromValue(message.timestamp ?? record.timestamp, fallbackMs);
  return buildUsageEvent({
    eventKey: eventKeyOf(occurredAtMs, model, classified.inputTokens, outputTokens, classified.cacheReadTokens, classified.cacheWriteTokens, extraTokens),
    agent: 'openclaw',
    occurredAtMs,
    sessionKey,
    projectKey: null, // 会话文件名不含项目路径
    model,
    inputTokens: classified.inputTokens,
    cacheReadTokens: classified.cacheReadTokens,
    cacheWriteTokens: classified.cacheWriteTokens,
    outputTokens,
    reasoningTokens: 0,
    providerTotalTokens: classified.inputTokens + outputTokens + classified.cacheReadTokens + classified.cacheWriteTokens + extraTokens,
    sourceVersion: provider,
    exact: true,
  });
};

const adapter = {
  id: 'openclaw',
  displayName: 'OpenClaw',
  iconKey: 'openclaw',
  colorToken: 'coral',
  defaultRootLabels: ['~/.openclaw', '~/.clawdbot', '~/.moltbot', '~/.moldbot'],

  detect: detectOpenclawRoots,

  async *collect(root, ctx) {
    // 文件变更即整文件重解析:当前模型/供应商是跨行状态,增量游标无法重建;
    // 事件键按内容身份稳定,重发靠 UPSERT 幂等
    const sessionFiles = await (async () => {
      const files = [];
      const walk = async (dir, depth) => {
        if (depth > 8) return;
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full, depth + 1);
          else if (entry.isFile() && isOpenclawSessionFile(entry.name)) files.push(full);
        }
      };
      await walk(root.rootPath, 0);
      return files.sort();
    })();

    const emitSessionFile = async function* (filePath, stat) {
      let currentModel = null;
      let currentProvider = null;
      const sessionId = sessionStemOf(path.basename(filePath));
      const fallbackMs = Math.floor(stat.mtimeMs);
      const sessionKey = ctx.hmac(`openclaw:${sessionId}`);
      const eventKeyOf = (ms, model, input, output, cacheRead, cacheWrite, extra) => `openclaw:${root.rootId}:${sessionId}:${ms}:${model}:${input}:${output}:${cacheRead}:${cacheWrite}:${extra}`;
      const generator = walkJsonlLines(filePath, 0);
      while (true) {
        const step = await generator.next();
        if (step.done) break;
        const { line } = step.value;
        const record = parseJsonLine(line);
        if (!record || typeof record !== 'object') continue;
        if (isModelChange(record)) {
          const { model, provider } = modelChangeSource(record);
          if (model) currentModel = model;
          if (provider) currentProvider = provider;
          continue;
        }
        const event = transcriptEvent({ record, sessionKey, currentModel, currentProvider, fallbackMs, eventKeyOf });
        if (event) yield event;
      }
    };

    for (const filePath of sessionFiles) {
      const relative = path.relative(root.rootPath, filePath).replace(/[\\/]+/g, '/');
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      const state = ctx.getFileState(root.rootId, relative);
      if (state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      yield* emitSessionFile(filePath, stat);
      ctx.saveFileState(root.rootId, relative, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: stat.size, formatVersion: 1 });
    }

    // 新版 per-agent SQLite:transcript_events 按 (session, seq) 顺序回放,
    // 同一套内容身份键,迁移副本自然覆盖 JSONL 行
    const agentsDir = path.join(root.rootPath, 'agents');
    let agentDirs = [];
    try { agentDirs = (await fs.promises.readdir(agentsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()); }
    catch { /* 无 agents 目录(旧版安装) */ }
    for (const agentDir of agentDirs) {
      const dbPath = path.join(agentsDir, agentDir.name, 'agent', 'openclaw-agent.sqlite');
      if (!fs.existsSync(dbPath)) continue;
      const fileKey = `agent/${agentDir.name}/openclaw-agent.sqlite`;
      const stat = await fs.promises.stat(dbPath).catch(() => null);
      if (!stat) continue;
      const state = ctx.getFileState(root.rootId, fileKey);
      if (state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      let rows = [];
      let db;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        try { db.exec('PRAGMA busy_timeout = 2000'); } catch { /* 只读连接忽略 */ }
        const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_events' LIMIT 1").get();
        if (hasTable) rows = db.prepare('SELECT session_id, seq, event_json, created_at FROM transcript_events ORDER BY session_id ASC, seq ASC').all();
      } catch (error) {
        ctx.markRoot(root.rootId, 'incompatible', `OpenClaw 数据库无法读取(${error.code || 'SCHEMA'})`);
        continue;
      } finally {
        try { db?.close(); } catch { /* 关闭失败忽略 */ }
      }
      // 同一 (session, seq) 流内维护模型状态;按 session 分组回放
      const bySession = new Map();
      for (const row of rows) {
        if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
        bySession.get(row.session_id).push(row);
      }
      for (const [sessionId, sessionRows] of bySession) {
        let currentModel = null;
        let currentProvider = null;
        const sessionKey = ctx.hmac(`openclaw:${sessionId}`);
        const eventKeyOf = (ms, model, input, output, cacheRead, cacheWrite, extra) => `openclaw:${root.rootId}:${sessionId}:${ms}:${model}:${input}:${output}:${cacheRead}:${cacheWrite}:${extra}`;
        for (const row of sessionRows) {
          const record = parseJsonLine(row.event_json);
          if (!record || typeof record !== 'object') continue;
          if (isModelChange(record)) {
            const { model, provider } = modelChangeSource(record);
            if (model) currentModel = model;
            if (provider) currentProvider = provider;
            continue;
          }
          const fallbackMs = toUint(row.created_at) || Math.floor(stat.mtimeMs);
          const event = transcriptEvent({ record, sessionKey, currentModel, currentProvider, fallbackMs, eventKeyOf });
          if (event) yield event;
        }
      }
      ctx.saveFileState(root.rootId, fileKey, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: stat.size, formatVersion: 1 });
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
