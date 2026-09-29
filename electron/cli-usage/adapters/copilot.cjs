// GitHub Copilot CLI 适配器:OTel 导出(otel/**/*.jsonl + COPILOT_OTEL_FILE_EXPORTER_PATH)
// 与 session-state(session-state/*/events.jsonl 的 session.shutdown 快照)。
// 对齐 ccusage copilot adapter:
// - OTel 四类来源按 chat span > inference log > agent turn log > agent summary span
//   的优先级,按 traceId/responseId 抑制低优先级重复记录;
// - session-state 是 (session, model) 维度的累计快照,续开会再次 shutdown:
//   首个快照原样保留,后续快照减去前一个,按区间归属日期;
// - 有 shutdown 的 (session, model),OTel 中时间 <= 最后 shutdown 的行被撤回,
//   只保留续会之后新产生的行。整文件重算 + 定向删除保证跨扫描语义一致。
const fs = require('node:fs');
const path = require('node:path');
const { detectCopilotRoots, envValue } = require('../paths.cjs');
const { buildUsageEvent, canonicalModelKey } = require('../normalize.cjs');
const { lenientUint, parseIsoTimestampMs, applyTotalTokenFallback, collectFilesByExtension } = require('./parse-utils.cjs');

const toUint = (value) => lenientUint(value) ?? 0;

// 字符串值:去空白后非空才算
const stringValue = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

// Copilot 内部 1M 上下文模型的内部后缀,计价与去重前剥掉
const normalizeCopilotModel = (model) => {
  const trimmed = String(model).trim();
  const stripped = trimmed.endsWith('-1m-internal') ? trimmed.slice(0, -'-1m-internal'.length)
    : trimmed.endsWith('-1m') ? trimmed.slice(0, -'-1m'.length)
      : trimmed;
  return stripped || trimmed;
};

const MODEL_ATTRS = ['gen_ai.response.model', 'gen_ai.request.model'];
const SESSION_ATTRS = [
  ['gen_ai.conversation.id', 3],
  ['copilot_chat.session_id', 3],
  ['copilot_chat.chat_session_id', 3],
  ['session.id', 3],
  ['github.copilot.interaction_id', 2],
  ['gen_ai.response.id', 1],
];

const attrString = (attributes, key) => stringValue(attributes[key]);
const attrNumber = (attributes, key) => toUint(attributes[key]);
const attrNumberFirst = (attributes, keys) => {
  for (const key of keys) {
    const value = attrNumber(attributes, key);
    if (value > 0) return value;
  }
  return 0;
};

const firstNonEmptyAttr = (attributes, keys) => {
  for (const key of keys) {
    const value = attrString(attributes, key);
    if (value) return value;
  }
  return null;
};

const bestSessionAttr = (attributes) => {
  let best = null;
  for (const [key, priority] of SESSION_ATTRS) {
    const value = attrString(attributes, key);
    if (value && (!best || priority >= best.priority)) best = { value, priority };
  }
  return best;
};

// OTel 时间字段:数组 [秒, 纳秒] 或标量(按数量级判单位)或数字字符串
const timestampFromParts = (value) => {
  if (!Array.isArray(value)) return null;
  const seconds = toUint(value[0]);
  const nanos = toUint(value[1]);
  if (!seconds && !nanos) return null;
  return seconds * 1000 + Math.floor(nanos / 1e6);
};

const timestampFromScalar = (value) => {
  const raw = toUint(value);
  if (!raw) return null;
  let millis;
  if (raw >= 1e17) millis = Math.floor(raw / 1e6); // 纳秒
  else if (raw >= 1e14) millis = Math.floor(raw / 1e3); // 微秒
  else if (raw >= 1e11) millis = raw; // 毫秒
  else millis = raw * 1e3; // 秒
  return millis;
};

const timestampFromRecord = (record) => timestampFromParts(record.endTime)
  ?? timestampFromParts(record.startTime)
  ?? timestampFromParts(record.hrTime)
  ?? timestampFromParts(record._hrTime)
  ?? timestampFromParts(record.time)
  ?? timestampFromScalar(record.timestamp)
  ?? timestampFromScalar(record.observedTimestamp)
  ?? (() => { const raw = toUint(record.timeUnixNano); return raw > 0 ? Math.floor(raw / 1e6) : null; })();

const traceIdOf = (record) => stringValue(record.traceId)
  || (record.spanContext && typeof record.spanContext === 'object' ? stringValue(record.spanContext.traceId) : null);
const spanIdOf = (record) => stringValue(record.spanId)
  || (record.spanContext && typeof record.spanContext === 'object' ? stringValue(record.spanContext.spanId) : null);
const bodyOf = (record) => stringValue(record.body) ?? stringValue(record._body);

const isSpanRecord = (record) => {
  if (stringValue(record.type) === 'span') return true;
  return Boolean(stringValue(record.name))
    && (spanIdOf(record) || traceIdOf(record) || record.startTime !== undefined
      || record.endTime !== undefined || record.duration !== undefined || record.kind !== undefined);
};

const recordSource = (record, attributes) => {
  if (isSpanRecord(record)) {
    if (attrString(attributes, 'gen_ai.operation.name') === 'chat'
      || stringValue(record.name)?.startsWith('chat ')) return 'chat-span';
    if (attrString(attributes, 'gen_ai.operation.name') === 'invoke_agent'
      || stringValue(record.name)?.startsWith('invoke_agent ')) return 'agent-summary-span';
    return null;
  }
  if (attrString(attributes, 'event.name') === 'gen_ai.client.inference.operation.details'
    || bodyOf(record)?.startsWith('GenAI inference:')) return 'inference-log';
  if (attrString(attributes, 'event.name') === 'copilot_chat.agent.turn'
    || bodyOf(record)?.startsWith('copilot_chat.agent.turn')) return 'agent-turn-log';
  return null;
};

const otelDedupKey = (source, record, attributes, traceId, sessionId, timestampMs, index) => {
  const spanId = spanIdOf(record);
  if (source === 'chat-span' || source === 'agent-summary-span') {
    if (traceId && spanId) return `${traceId}:${spanId}`;
    return `span:${sessionId}:${timestampMs}:${index}`;
  }
  if (source === 'inference-log') {
    if (traceId && spanId) return `log:${traceId}:${spanId}`;
    return `log:${sessionId}:${timestampMs}:${index}`;
  }
  const turnIndex = toUint(attributes['turn.index']) || toUint(attributes['copilot_chat.turn.index']);
  const turnKey = turnIndex > 0 ? String(turnIndex) : `idx-${index}`;
  return traceId ? `agent-turn:${traceId}:${turnKey}` : `agent-turn:${sessionId}:${turnKey}:${index}`;
};

const SOURCE_PRIORITY = {
  'chat-span': 0,
  'inference-log': 1,
  'agent-turn-log': 2,
  'agent-summary-span': 3,
};

// 一个 OTel 文件的完整解析:先收集全量 trace 上下文,再按候选集合做优先级抑制
const parseOtelContent = (content, fallbackMs) => {
  const records = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('"attributes"')) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && typeof record === 'object') records.push(record);
    } catch { /* 坏行跳过 */ }
  }
  const traceContexts = new Map();
  for (const record of records) {
    const traceId = traceIdOf(record);
    const attributes = record.attributes;
    if (!traceId || !attributes || typeof attributes !== 'object') continue;
    let context = traceContexts.get(traceId);
    if (!context) { context = { model: null, sessionId: null, priority: 0 }; traceContexts.set(traceId, context); }
    if (!context.model) context.model = firstNonEmptyAttr(attributes, MODEL_ATTRS);
    const session = bestSessionAttr(attributes);
    if (session && session.priority > context.priority) {
      context.sessionId = session.value;
      context.priority = session.priority;
    }
  }
  const candidates = [];
  records.forEach((record, index) => {
    const attributes = record.attributes;
    if (!attributes || typeof attributes !== 'object') return;
    const source = recordSource(record, attributes);
    if (!source) return;
    const input = attrNumber(attributes, 'gen_ai.usage.input_tokens');
    const output = attrNumber(attributes, 'gen_ai.usage.output_tokens');
    const cacheRead = attrNumber(attributes, 'gen_ai.usage.cache_read.input_tokens');
    const cacheWrite = attrNumberFirst(attributes, ['gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.cache_creation.input_tokens']);
    const reasoning = attrNumberFirst(attributes, ['gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.reasoning_tokens']);
    const total = attrNumberFirst(attributes, ['gen_ai.usage.total_tokens', 'gen_ai.usage.total.token_count']);
    const classified = {
      inputTokens: input - Math.min(input, cacheRead),
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    };
    const { outputTokens, extraTokens } = applyTotalTokenFallback(classified, 0, total);
    if (!classified.inputTokens && !outputTokens && !cacheRead && !cacheWrite && !extraTokens) return;
    const traceId = traceIdOf(record);
    const context = traceId ? traceContexts.get(traceId) : null;
    const responseId = attrString(attributes, 'gen_ai.response.id');
    const modelAttr = firstNonEmptyAttr(attributes, MODEL_ATTRS);
    const model = modelAttr ? normalizeCopilotModel(modelAttr)
      : context?.model ? normalizeCopilotModel(context.model)
        : 'unknown';
    const sessionAttr = bestSessionAttr(attributes);
    const sessionId = sessionAttr?.value || context?.sessionId || traceId || 'unknown-session';
    const timestampMs = timestampFromRecord(record) ?? fallbackMs;
    candidates.push({
      source, traceId, responseId, model, sessionId, timestampMs,
      inputTokens: classified.inputTokens, outputTokens,
      cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning, extraTokens,
      dedupKey: otelDedupKey(source, record, attributes, traceId, sessionId, timestampMs, index),
    });
  });
  // 优先级抑制:高优先级来源出现过的 trace/response,低优先级候选整行丢弃
  const sets = new Map();
  for (const source of Object.keys(SOURCE_PRIORITY)) {
    sets.set(source, { traces: new Set(), responses: new Set() });
  }
  for (const candidate of candidates) {
    const set = sets.get(candidate.source);
    if (candidate.traceId) set.traces.add(candidate.traceId);
    if (candidate.responseId) set.responses.add(candidate.responseId);
  }
  return candidates.filter((candidate) => {
    const priority = SOURCE_PRIORITY[candidate.source];
    for (const [source, set] of sets) {
      if (SOURCE_PRIORITY[source] >= priority) continue;
      if (candidate.traceId && set.traces.has(candidate.traceId)) return false;
      if (candidate.responseId && set.responses.has(candidate.responseId)) return false;
    }
    return true;
  });
};

// session-state:session.shutdown 的 modelMetrics 快照
const parseSessionStateContent = (content, sessionId, fallbackMs) => {
  const entries = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('session.shutdown')) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event?.type !== 'session.shutdown') continue;
    const timestampMs = parseIsoTimestampMs(event.timestamp);
    if (timestampMs === null) continue;
    const modelMetrics = event?.data?.modelMetrics;
    if (!modelMetrics || typeof modelMetrics !== 'object') continue;
    for (const [rawModel, metrics] of Object.entries(modelMetrics)) {
      const model = normalizeCopilotModel(rawModel);
      const usage = metrics?.usage && typeof metrics.usage === 'object' ? metrics.usage : null;
      if (!usage) continue;
      const requestCount = toUint(metrics?.requests?.count);
      if (!model
        || (!toUint(usage.inputTokens) && !toUint(usage.outputTokens) && !toUint(usage.cacheReadTokens)
          && !toUint(usage.cacheWriteTokens) && !toUint(usage.reasoningTokens) && !requestCount)) continue;
      // session-state 的 inputTokens 含缓存读写,扣除得净输入
      const inputTokens = Math.max(0, toUint(usage.inputTokens) - toUint(usage.cacheReadTokens) - toUint(usage.cacheWriteTokens));
      const dedupKey = typeof event.id === 'string' && event.id
        ? `shutdown:${sessionId}:${event.id}:${model}`
        : `shutdown:${sessionId}:${event.timestamp}:${model}:${toUint(usage.inputTokens)}:${toUint(usage.outputTokens)}:${toUint(usage.cacheReadTokens)}:${toUint(usage.cacheWriteTokens)}:${toUint(usage.reasoningTokens)}:${requestCount}`;
      entries.push({
        sessionId, model, timestampMs, dedupKey,
        inputTokens, outputTokens: toUint(usage.outputTokens),
        cacheReadTokens: toUint(usage.cacheReadTokens), cacheWriteTokens: toUint(usage.cacheWriteTokens),
        reasoningTokens: toUint(usage.reasoningTokens),
      });
    }
  }
  // 同键保留更晚的快照,然后按 (session, model) 分组做累计差分
  const byKey = new Map();
  for (const entry of entries) {
    const existing = byKey.get(entry.dedupKey);
    if (!existing || existing.timestampMs <= entry.timestampMs) byKey.set(entry.dedupKey, entry);
  }
  const grouped = new Map();
  for (const entry of byKey.values()) {
    const key = JSON.stringify([entry.sessionId, entry.model]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }
  const intervals = [];
  const latestShutdown = [];
  for (const list of grouped.values()) {
    list.sort((left, right) => left.timestampMs - right.timestampMs);
    let previous = null;
    for (const current of list) {
      const interval = previous
        ? {
          ...current,
          inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
          outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
          cacheReadTokens: Math.max(0, current.cacheReadTokens - previous.cacheReadTokens),
          cacheWriteTokens: Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens),
          reasoningTokens: Math.max(0, current.reasoningTokens - previous.reasoningTokens),
        }
        : { ...current };
      previous = current;
      if (interval.inputTokens || interval.outputTokens || interval.cacheReadTokens || interval.cacheWriteTokens || interval.reasoningTokens) {
        intervals.push(interval);
      }
    }
    if (previous) latestShutdown.push(previous);
  }
  return { intervals, latestShutdown };
};

const adapter = {
  id: 'copilot',
  displayName: 'Copilot CLI',
  iconKey: 'copilot',
  colorToken: 'coral',
  defaultRootLabels: ['~/.copilot'],

  detect: detectCopilotRoots,

  async *collect(root, ctx) {
    const otelFiles = await collectFilesByExtension(path.join(root.rootPath, 'otel'), 'jsonl');
    // 显式导出文件 env:与根目录内文件按规范化路径去重
    const explicitPath = envValue('COPILOT_OTEL_FILE_EXPORTER_PATH');
    const seen = new Set(otelFiles.map((file) => path.resolve(file)));
    if (explicitPath) {
      try {
        const resolved = path.resolve(explicitPath);
        if ((await fs.promises.stat(resolved)).isFile() && !seen.has(resolved)) {
          seen.add(resolved);
          otelFiles.push(resolved);
        }
      } catch { /* 显式路径失效时忽略 */ }
    }
    const sessionStateDirs = [];
    try {
      for (const entry of await fs.promises.readdir(path.join(root.rootPath, 'session-state'), { withFileTypes: true })) {
        if (entry.isDirectory()) sessionStateDirs.push(entry.name);
      }
    } catch { /* 无 session-state 目录 */ }

    if (!otelFiles.length && !sessionStateDirs.length) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }

    // OTel:文件变更即删除该文件旧事件 + 全量重解析(候选抑制需要整文件视野)
    for (const filePath of otelFiles) {
      const relative = path.relative(root.rootPath, filePath).replace(/[\\/]+/g, '/');
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      const state = ctx.getFileState(root.rootId, relative);
      if (state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      let content;
      try { content = await fs.promises.readFile(filePath, 'utf8'); }
      catch { continue; }
      ctx.deleteEvents({ eventKeyPrefix: `copilot:otel:${root.rootId}:${relative}:` });
      const candidates = parseOtelContent(content, Math.floor(stat.mtimeMs));
      for (const candidate of candidates) {
        const event = buildUsageEvent({
          eventKey: `copilot:otel:${root.rootId}:${relative}:${candidate.dedupKey}`,
          agent: 'copilot',
          occurredAtMs: candidate.timestampMs,
          sessionKey: ctx.hmac(`copilot:${candidate.sessionId}`),
          projectKey: null, // OTel 属性不含稳定的工程目录
          model: candidate.model,
          inputTokens: candidate.inputTokens,
          cacheReadTokens: candidate.cacheReadTokens,
          cacheWriteTokens: candidate.cacheWriteTokens,
          outputTokens: candidate.outputTokens,
          reasoningTokens: candidate.reasoningTokens,
          providerTotalTokens: candidate.inputTokens + candidate.outputTokens + candidate.cacheReadTokens + candidate.cacheWriteTokens + candidate.extraTokens,
          sourceVersion: null,
          exact: true,
        });
        if (event) yield event;
      }
      ctx.saveFileState(root.rootId, relative, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: stat.size, formatVersion: 1 });
    }

    // session-state:所有会话目录的 shutdown 都要参与对账(便宜:只挑 shutdown 行);
    // 变更的文件先撤回旧区间事件再按差分重发
    const reconciliations = [];
    for (const sessionDir of sessionStateDirs.sort()) {
      const filePath = path.join(root.rootPath, 'session-state', sessionDir, 'events.jsonl');
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      const relative = `session-state/${sessionDir}/events.jsonl`;
      const state = ctx.getFileState(root.rootId, relative);
      const changed = !(state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs));
      // 未变更的文件也要重读参与对账:跨扫描新到的 OTel 行需要同样的抑制
      const content = await fs.promises.readFile(filePath, 'utf8').catch(() => null);
      if (content === null) continue;
      const { intervals, latestShutdown } = parseSessionStateContent(content, sessionDir, Math.floor(stat.mtimeMs));
      for (const shutdown of latestShutdown) {
        reconciliations.push({
          sessionKey: ctx.hmac(`copilot:${shutdown.sessionId}`),
          canonicalModelKey: canonicalModelKey(shutdown.model),
          beforeMs: shutdown.timestampMs,
        });
      }
      if (changed) {
        ctx.deleteEvents({ eventKeyPrefix: `copilot:session:${root.rootId}:${relative}:` });
        for (const interval of intervals) {
          const event = buildUsageEvent({
            eventKey: `copilot:session:${root.rootId}:${relative}:${interval.dedupKey}`,
            agent: 'copilot',
            occurredAtMs: interval.timestampMs,
            sessionKey: ctx.hmac(`copilot:${interval.sessionId}`),
            projectKey: null,
            model: interval.model,
            inputTokens: interval.inputTokens,
            cacheReadTokens: interval.cacheReadTokens,
            cacheWriteTokens: interval.cacheWriteTokens,
            outputTokens: interval.outputTokens,
            reasoningTokens: interval.reasoningTokens,
            providerTotalTokens: null, // 快照无 total 字段,classified 即总量
            sourceVersion: null,
            exact: true,
          });
          if (event) yield event;
        }
        ctx.saveFileState(root.rootId, relative, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: stat.size, formatVersion: 1 });
      }
    }

    // 对账:有 shutdown 的 (session, model),撤回时间 <= 最后 shutdown 的 OTel 行。
    // 必须延迟到本次扫描全部事件落库之后执行(worker 在最终 flush 后调用),
    // 否则缓冲中的 OTel 行会在撤回后被重新写入
    for (const item of reconciliations) {
      ctx.deferDeleteEvents({ eventKeyPrefix: `copilot:otel:${root.rootId}:`, sessionKey: item.sessionKey, canonicalModelKey: item.canonicalModelKey, beforeMs: item.beforeMs });
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
