// Grok Build CLI 适配器:sessions/<url编码cwd>/<sessionId>/updates.jsonl 的
// turn_completed 事件;会话/项目/默认模型优先取兄弟 summary.json。
// 对齐 ccusage grok adapter:cachedRead/cacheCreation 是 inputTokens 的子集,
// 需从输入中扣除;reasoning 是 output 的子集,只展示不另计。
const fs = require('node:fs');
const path = require('node:path');
const { detectGrokRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { walkJsonlLines, parseJsonLine } = require('./jsonl-walk.cjs');
const { lenientUint, urlDecodeBytes, collectFilesByExtension } = require('./parse-utils.cjs');

const toUint = (value) => lenientUint(value) ?? 0;

// ccusage split_input_tokens:uncached = input - cachedRead;cacheWrite 从剩余
// uncached 中扣除并截断,保证三部分之和回到原始 inputTokens
const splitInputTokens = (input, cachedRead, cacheCreation) => {
  const cacheRead = Math.min(input, cachedRead);
  const uncached = input - cacheRead;
  const cacheWrite = Math.min(cacheCreation, uncached);
  return { inputTokens: uncached - cacheWrite, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
};

const loadSummaryMeta = (updatesPath) => {
  const sessionDir = path.dirname(updatesPath);
  const sessionId = path.basename(sessionDir);
  const projectFromPath = urlDecodeBytes(path.basename(path.dirname(sessionDir)));
  const meta = { sessionId, projectPath: projectFromPath, defaultModel: null };
  try {
    const summary = JSON.parse(fs.readFileSync(path.join(sessionDir, 'summary.json'), 'utf8'));
    if (summary?.info?.id) meta.sessionId = summary.info.id;
    const cwd = summary?.info?.cwd || summary?.git_root_dir;
    if (cwd) meta.projectPath = cwd;
    if (summary?.current_model_id) meta.defaultModel = summary.current_model_id;
  } catch { /* summary 缺失或损坏时退回路径推导 */ }
  return meta;
};

const resolveTimestampMs = (record) => {
  const metaMs = toUint(record?.params?._meta?.agentTimestampMs);
  if (metaMs > 0) return metaMs;
  const seconds = toUint(record?.timestamp);
  if (seconds > 0) return seconds * 1000; // 外层 timestamp 是 Unix 秒
  return null;
};

const modelUsageRows = (usage, defaultModel) => {
  const map = usage?.modelUsage;
  if (map && typeof map === 'object' && Object.keys(map).length) {
    return Object.entries(map)
      .filter(([model]) => typeof model === 'string' && model.trim())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([model, row]) => [model, row || {}]);
  }
  return [[defaultModel && String(defaultModel).trim() ? defaultModel : 'unknown', usage]];
};

const adapter = {
  id: 'grok',
  displayName: 'Grok CLI',
  iconKey: 'grok',
  colorToken: 'amber',
  defaultRootLabels: ['~/.grok'],

  detect: detectGrokRoots,

  async *collect(root, ctx) {
    const sessionsRoot = path.join(root.rootPath, 'sessions');
    if (!fs.existsSync(sessionsRoot)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    const files = await collectFilesByExtension(sessionsRoot, 'jsonl', { nameFilter: (name) => name === 'updates.jsonl' });
    for (const filePath of files) {
      const relative = path.relative(sessionsRoot, filePath).replace(/[\\/]+/g, '/');
      const fileKey = relative;
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      const state = ctx.getFileState(root.rootId, fileKey);
      if (state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      const startCursor = state && Number(state.size) === stat.size ? Number(state.byteCursor) || 0 : 0;
      const meta = loadSummaryMeta(filePath);
      // summary.json 在会话进行中随时可能补写;每次扫描重读,已入库行的模型
      // 缺口靠 UPSERT 的 COALESCE(null→值)补齐
      const generator = walkJsonlLines(filePath, startCursor);
      let nextCursor = startCursor;
      while (true) {
        const step = await generator.next();
        if (step.done) { nextCursor = step.value ?? nextCursor; break; }
        const { offset, line } = step.value;
        nextCursor = offset + line.length + 1;
        const record = parseJsonLine(line);
        const update = record?.params?.update;
        if (update?.sessionUpdate !== 'turn_completed' || !update.usage) continue;
        const timestampMs = resolveTimestampMs(record);
        if (!timestampMs) continue;
        const sessionId = record.params.sessionId || meta.sessionId;
        const eventId = typeof record.params._meta?.eventId === 'string' ? record.params._meta.eventId : null;
        for (const [model, modelUsage] of modelUsageRows(update.usage, meta.defaultModel)) {
          const { inputTokens, cacheReadTokens, cacheWriteTokens } = splitInputTokens(
            toUint(modelUsage.inputTokens), toUint(modelUsage.cachedReadTokens), toUint(modelUsage.cacheCreationTokens),
          );
          const outputTokens = toUint(modelUsage.outputTokens);
          const reasoningTokens = toUint(modelUsage.reasoningTokens);
          if (!inputTokens && !cacheReadTokens && !cacheWriteTokens && !outputTokens && !reasoningTokens) continue;
          const totalTokens = toUint(modelUsage.totalTokens);
          // 有 eventId 用事件级键(全局稳定);否则按内容键去重重复行
          const eventKey = eventId
            ? `grok:${root.rootId}:${eventId}:${model}`
            : `grok:${root.rootId}:${sessionId}|${timestampMs}|${model}|${inputTokens}|${outputTokens}|${cacheReadTokens}|${cacheWriteTokens}|${reasoningTokens}`;
          const event = buildUsageEvent({
            eventKey,
            agent: 'grok',
            occurredAtMs: timestampMs,
            sessionKey: ctx.hmac(`grok:${sessionId}`),
            projectKey: ctx.hmac(`grok:${meta.projectPath}`),
            model,
            inputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            outputTokens,
            reasoningTokens,
            providerTotalTokens: totalTokens > 0 ? totalTokens : null,
            sourceVersion: null,
            exact: true,
          });
          if (event) yield event;
        }
      }
      ctx.saveFileState(root.rootId, fileKey, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: nextCursor, formatVersion: 1 });
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
