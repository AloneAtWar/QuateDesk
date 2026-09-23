// Codex 适配器:sessions/YYYY/MM/DD/rollout-*.jsonl 与 archived_sessions/*.jsonl。
// token_count 事件优先用 last_token_usage 增量;只有累计值时做差分。
// 相同 info、累计不前进(重复事件/分支回放/子 Agent 继承前缀)一律跳过;
// 活动与归档目录出现同名 rollout 时只取活动文件。
const fs = require('node:fs');
const path = require('node:path');
const { detectCodexRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { walkJsonlLines, parseJsonLine } = require('./jsonl-walk.cjs');

const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

const emptyUsage = () => ({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 });

const usageSignature = (usage) => USAGE_FIELDS.map((field) => Number(usage?.[field]) || 0).join(',');

// token_count 的 usage 新版嵌在 payload.info,旧版直接挂在 payload 上。
// 同时返回累计值:subagent rollout 会原样回放父历史的 token_count,
// 用"累计 Token 指纹"做跨文件事件键,回放与正本命中同一键,天然去重。
const readTokenCountUsage = (payload) => {
  const info = payload?.info && typeof payload.info === 'object' ? payload.info : payload;
  const last = info?.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : null;
  const total = info?.total_token_usage && typeof info.total_token_usage === 'object' ? info.total_token_usage : null;
  return last ? { kind: 'last', usage: last, total } : total ? { kind: 'total', usage: total, total } : null;
};

const parseTimestamp = (value) => {
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? stamp : 0;
};

async function listRolloutFiles(rootPath) {
  const activeRoot = path.join(rootPath, 'sessions');
  const archiveRoot = path.join(rootPath, 'archived_sessions');
  const active = [];
  const archived = [];
  const walk = async (dir, out, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, out, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  await walk(activeRoot, active, 0);
  await walk(archiveRoot, archived, 0);
  const activeNames = new Set(active.map((file) => path.basename(file)));
  // 同名 rollout 在活动目录存在时丢弃归档副本,防止重复计数
  return [...active, ...archived.filter((file) => !activeNames.has(path.basename(file)))];
}

const adapter = {
  id: 'codex',
  displayName: 'Codex',
  iconKey: 'codex',
  colorToken: 'green',
  defaultRootLabels: ['~/.codex'],

  detect: detectCodexRoots,

  async *collect(root, ctx) {
    const sessionsRoot = path.join(root.rootPath, 'sessions');
    const archiveRoot = path.join(root.rootPath, 'archived_sessions');
    if (!fs.existsSync(sessionsRoot) && !fs.existsSync(archiveRoot)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    const files = await listRolloutFiles(root.rootPath);
    for (const filePath of files) {
      const relative = path.relative(root.rootPath, filePath).replace(/[\\/]+/g, '/');
      const fileKey = relative;
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      const state = ctx.getFileState(root.rootId, fileKey);
      if (state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      const startCursor = state && Number(state.size) === stat.size ? Number(state.byteCursor) || 0 : 0;
      const generator = walkJsonlLines(filePath, startCursor);
      let nextCursor = startCursor;
      let currentModel = null;
      let threadId = '';
      let cwd = null;
      let cliVersion = null;
      let previousSignature = '';
      let previousTotal = emptyUsage();
      while (true) {
        const step = await generator.next();
        if (step.done) { nextCursor = step.value ?? nextCursor; break; }
        const { offset, line } = step.value;
        nextCursor = offset + line.length + 1;
        const record = parseJsonLine(line);
        if (!record) continue;
        if (record.type === 'session_meta') {
          threadId = String(record.payload?.id || record.payload?.session_id || '');
          cwd = record.payload?.cwd || cwd;
          cliVersion = record.payload?.cli_version || cliVersion;
          previousTotal = emptyUsage();
          previousSignature = '';
          continue;
        }
        if (record.type === 'turn_context') {
          // 更新后续 token 事件对应的模型;缺模型元数据时保持 null,归为"未知"
          currentModel = record.payload?.model || currentModel;
          cwd = record.payload?.cwd || cwd;
          continue;
        }
        if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') continue;
        const parsed = readTokenCountUsage(record.payload);
        if (!parsed) continue;
        const signature = usageSignature(parsed.usage);
        // 相邻 info 完全相同则跳过(重复事件)
        if (signature === previousSignature) continue;
        previousSignature = signature;
        let usage = parsed.usage;
        if (parsed.kind === 'total') {
          // 只有累计值:差分;累计没有前进则跳过(重复事件/分支与子 Agent 回放前缀)
          const delta = emptyUsage();
          let advanced = false;
          for (const field of USAGE_FIELDS) {
            const diff = (Number(usage[field]) || 0) - (Number(previousTotal[field]) || 0);
            delta[field] = diff;
            if (diff > 0) advanced = true;
          }
          previousTotal = { ...usage };
          if (!advanced || Number(delta.total_tokens) <= 0) continue;
          usage = delta;
        }
        const input = Number(usage.input_tokens) || 0;
        const cached = Number(usage.cached_input_tokens) || 0;
        const cacheWrite = Number(usage.cache_write_input_tokens) || 0;
        const cumulative = parsed.total && Number(parsed.total.total_tokens) > 0 ? parsed.total : null;
        const event = buildUsageEvent({
          eventKey: cumulative
            ? `codex:${root.rootId}:cum:${usageSignature(cumulative)}`
            : `codex:${root.rootId}:${relative}:${offset}`,
          agent: 'codex',
          occurredAtMs: parseTimestamp(record.timestamp) || Math.floor(stat.mtimeMs),
          sessionKey: ctx.hmac(`codex:${threadId || path.basename(filePath, '.jsonl')}`),
          projectKey: cwd ? ctx.hmac(cwd) : null,
          model: currentModel,
          inputTokens: Math.max(0, input - cached - cacheWrite),
          cacheReadTokens: cached,
          cacheWriteTokens: cacheWrite,
          outputTokens: usage.output_tokens,
          reasoningTokens: usage.reasoning_output_tokens,
          providerTotalTokens: Number(usage.total_tokens) || null,
          sourceVersion: cliVersion,
          exact: true,
        });
        if (event) yield event;
      }
      ctx.saveFileState(root.rootId, fileKey, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: nextCursor, formatVersion: 1 });
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
