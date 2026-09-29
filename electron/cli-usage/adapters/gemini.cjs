// Gemini CLI 适配器:~/.gemini/tmp 下的会话调试日志(.json 整档 + .jsonl 流式)。
// 对齐 ccusage gemini adapter:direct(type==="gemini")事件与 stats 事件两条路径,
// token 字段容忍多组别名;stats 的 cached 是 input 的子集要扣除,direct 按 total
// 是否含 cached 判定;thoughts/tool 计入 total 缺口。direct 事件按 id 去重(流式快照)。
const fs = require('node:fs');
const path = require('node:path');
const { detectGeminiRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { parseIsoTimestampMs, numberAt, applyTotalTokenFallback, collectFilesByExtension } = require('./parse-utils.cjs');

const INPUT_KEYS = ['input', 'prompt', 'input_tokens', 'prompt_tokens'];
const OUTPUT_KEYS = ['output', 'candidates', 'output_tokens', 'candidates_tokens'];
const CACHED_KEYS = ['cached', 'cached_tokens'];
const THOUGHTS_KEYS = ['thoughts', 'reasoning', 'thoughts_tokens', 'reasoning_tokens'];
const TOOL_KEYS = ['tool', 'tool_tokens'];

const parseTokens = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    input: numberAt(value, INPUT_KEYS),
    output: numberAt(value, OUTPUT_KEYS),
    cached: numberAt(value, CACHED_KEYS),
    thoughts: numberAt(value, THOUGHTS_KEYS),
    tool: numberAt(value, TOOL_KEYS),
    total: numberAt(value, ['total', 'total_tokens']),
  };
};

// ccusage subtract_cached_overlap_tokens:cached 始终按 input 的子集扣除
const subtractCachedOverlap = (tokens) => {
  const cachedPortion = Math.min(tokens.input, tokens.cached);
  return { inputTokens: tokens.input - cachedPortion, cacheReadTokens: tokens.cached };
};

// ccusage normalize_session_input:仅当 total 恰好等于不含 cached 的各部分之和
// (即 total 没把 cached 算进去)时,cached 才按重叠子集扣除;否则额外叠加
const normalizeSessionInput = (tokens) => {
  const inclusiveTotal = tokens.input + tokens.output + tokens.thoughts + tokens.tool;
  const exclusiveTotal = inclusiveTotal + tokens.cached;
  if (tokens.cached > 0 && tokens.total === inclusiveTotal && tokens.total !== exclusiveTotal) {
    return subtractCachedOverlap(tokens);
  }
  return { inputTokens: tokens.input, cacheReadTokens: tokens.cached };
};

// 组装单条事件:model 必填;total 缺口优先补 output(ccusage 语义),extra 兜底
const buildGeminiEvent = ({ eventKey, model, sessionKey, timestampMs, tokens, normalizeInput }) => {
  if (!model || !String(model).trim()) return null;
  const { inputTokens: uncached, cacheReadTokens } = normalizeInput(tokens);
  const inputTokens = uncached + tokens.tool;
  const classified = { inputTokens, outputTokens: tokens.output, cacheReadTokens, cacheWriteTokens: 0 };
  const totalTokens = tokens.total > 0 ? tokens.total : inputTokens + tokens.output + cacheReadTokens + tokens.thoughts;
  const { outputTokens, extraTokens } = applyTotalTokenFallback(classified, tokens.thoughts, totalTokens);
  if (!inputTokens && !outputTokens && !cacheReadTokens && !extraTokens) return null;
  return buildUsageEvent({
    eventKey,
    agent: 'gemini',
    occurredAtMs: timestampMs,
    sessionKey,
    projectKey: null, // gemini tmp 日志不含项目路径,不落项目维度
    model: String(model),
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    outputTokens,
    reasoningTokens: tokens.thoughts,
    providerTotalTokens: inputTokens + outputTokens + cacheReadTokens + extraTokens,
    sourceVersion: null,
    exact: true,
  });
};

const recordTimestampMs = (record) => parseIsoTimestampMs(record?.timestamp) || parseIsoTimestampMs(record?.created_at);

const directEventFromRecord = (record, modelHint, sessionKey, fallbackMs, eventKey) => {
  const tokens = parseTokens(record?.tokens);
  if (!tokens) return null;
  return buildGeminiEvent({
    eventKey,
    model: record?.model || modelHint,
    sessionKey,
    timestampMs: recordTimestampMs(record) || fallbackMs,
    tokens,
    normalizeInput: normalizeSessionInput,
  });
};

const statsEventsFromRecord = (record, modelHint, sessionKey, timestampMs, keyFor) => {
  const stats = record?.stats || record?.result?.stats;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return [];
  const models = stats.models;
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    const events = [];
    for (const [model, data] of Object.entries(models)) {
      const tokens = parseTokens(data);
      if (!tokens) continue;
      const event = buildGeminiEvent({ eventKey: keyFor(model), model, sessionKey, timestampMs, tokens, normalizeInput: subtractCachedOverlap });
      if (event) events.push(event);
    }
    if (events.length) return events;
  }
  const tokens = parseTokens(stats);
  if (!tokens) return [];
  const event = buildGeminiEvent({ eventKey: keyFor(null), model: modelHint || 'unknown', sessionKey, timestampMs, tokens, normalizeInput: subtractCachedOverlap });
  return event ? [event] : [];
};

// .json 整档:messages 数组里的 gemini 事件,或顶层 direct 事件,或 stats
const parseWholeJsonFile = (content, relative, fallbackMs, makeKey, sessionKeyOf) => {
  let record;
  try { record = JSON.parse(content); } catch { return []; }
  if (!record || typeof record !== 'object') return [];
  const sessionKey = sessionKeyOf(record.sessionId || record.session_id || path.basename(relative).replace(/\.[^.]+$/, ''));
  const sessionMs = parseIsoTimestampMs(record.startTime) || parseIsoTimestampMs(record.lastUpdated) || fallbackMs;
  if (Array.isArray(record.messages)) {
    const events = [];
    record.messages.forEach((message, index) => {
      if (!message || message.type !== 'gemini') return;
      const event = directEventFromRecord(message, null, sessionKey, sessionMs, makeKey(`m${index}`));
      if (event) events.push(event);
    });
    return events;
  }
  if (record.type === 'gemini') {
    const event = directEventFromRecord(record, null, sessionKey, fallbackMs, makeKey('top'));
    return event ? [event] : [];
  }
  return statsEventsFromRecord(record, record.model || null, sessionKey, parseIsoTimestampMs(record.timestamp) || fallbackMs, (model) => makeKey(model || 'flat'));
};

// .jsonl 流式:逐行维护 sessionId/currentModel;direct 事件按 id 收敛(后者覆盖前者)
const parseJsonlFile = (content, relative, fallbackMs, makeKey, sessionKeyOf) => {
  let sessionId = path.basename(relative).replace(/\.[^.]+$/, '');
  let currentModel = null;
  const events = [];
  const byId = new Map();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try { record = JSON.parse(trimmed); } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    if (record.sessionId) sessionId = record.sessionId;
    else if (record.session_id) sessionId = record.session_id;
    if (record.model) currentModel = record.model;
    const sessionKey = sessionKeyOf(sessionId);
    if (record.type === 'gemini') {
      const id = typeof record.id === 'string' && record.id ? record.id : null;
      const event = directEventFromRecord(record, currentModel, sessionKey, fallbackMs, id ? makeKey(`id:${id}`) : makeKey(`o${events.length}`));
      if (!event) continue;
      if (id) {
        const existing = byId.get(id);
        if (existing !== undefined) events[existing] = event;
        else { byId.set(id, events.length); events.push(event); }
      } else events.push(event);
      continue;
    }
    if (record.stats || record.result?.stats) {
      events.push(...statsEventsFromRecord(record, currentModel, sessionKey, recordTimestampMs(record) || fallbackMs, (model) => makeKey(`s${events.length}:${model || 'flat'}`)));
    }
  }
  return events;
};

const adapter = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  iconKey: 'gemini',
  colorToken: 'mint',
  defaultRootLabels: ['~/.gemini/tmp'],

  detect: detectGeminiRoots,

  // tmp 目录文件整体重算:jsonl 内 sessionId/model 是跨行状态、direct 事件按 id
  // 后到覆盖,增量游标无法重建状态;文件体量小(会话调试日志),变更时全量重解析,
  // 事件键稳定所以 UPSERT 幂等
  async *collect(root, ctx) {
    const files = [
      ...(await collectFilesByExtension(root.rootPath, 'json')),
      ...(await collectFilesByExtension(root.rootPath, 'jsonl')),
    ];
    for (const filePath of files) {
      const relative = path.relative(root.rootPath, filePath).replace(/[\\/]+/g, '/');
      const fileKey = relative;
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      const state = ctx.getFileState(root.rootId, fileKey);
      if (state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      const fallbackMs = Math.floor(stat.mtimeMs);
      let content;
      try { content = await fs.promises.readFile(filePath, 'utf8'); }
      catch { continue; }
      const makeKey = (suffix) => `gemini:${root.rootId}:${relative}:${suffix}`;
      const sessionKeyOf = (sessionId) => ctx.hmac(`gemini:${sessionId}`);
      const events = fileKey.endsWith('.jsonl')
        ? parseJsonlFile(content, fileKey, fallbackMs, makeKey, sessionKeyOf)
        : parseWholeJsonFile(content, fileKey, fallbackMs, makeKey, sessionKeyOf);
      for (const event of events) yield event;
      ctx.saveFileState(root.rootId, fileKey, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: stat.size, formatVersion: 1 });
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
