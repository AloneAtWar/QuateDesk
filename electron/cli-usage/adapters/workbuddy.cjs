// WorkBuddy 适配器:~/.workbuddy/traces/<pid>/trace_<id>.json,每个文件是一次
// Agent 工作流的聚合用量(trace.totalTokens + modelInfo 逐项)。
// totalInputTokens 已含 totalCachedTokens(已验证 total = in + out),cached 按
// input 的子集扣除;sessionId 关联 workbuddy.db sessions.cwd 补项目目录,
// 库缺失/加锁时静默降级为无项目。WorkBuddy 与 WorkBuddy AI 共用同一数据目录。
const fs = require('node:fs');
const path = require('node:path');
const { detectWorkbuddyRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { lenientUint, parseIsoTimestampMs, collectFilesByExtension } = require('./parse-utils.cjs');
const { openSqlite } = require('./sqlite-open.cjs');

const toUint = (value) => lenientUint(value) ?? 0;

// workbuddy.db sessions 表:id → cwd。应用正在运行时 WAL 加锁属正常,读不到就空表
const loadSessionCwds = (rootPath) => {
  const map = new Map();
  const dbPath = path.join(rootPath, 'workbuddy.db');
  if (!fs.existsSync(dbPath)) return map;
  let opened;
  try {
    opened = openSqlite(dbPath);
    const rows = opened.db.prepare('SELECT id, cwd FROM sessions').all();
    for (const row of rows) {
      if (row?.id && typeof row.cwd === 'string' && row.cwd.trim()) map.set(String(row.id), row.cwd);
    }
  } catch { /* 数据库不可读时降级 */ } finally {
    try { opened?.db?.close(); } catch { /* 忽略 */ }
    try { opened?.cleanup?.(); } catch { /* 忽略 */ }
  }
  return map;
};

// 多模型 trace 只有聚合值,无逐模型拆分;保留完整清单避免归到单一模型失真
const modelNameOf = (models) => {
  if (!Array.isArray(models)) return null;
  const names = models.filter((item) => typeof item === 'string' && item.trim());
  if (!names.length) return null;
  return names.join('+');
};

const adapter = {
  id: 'workbuddy',
  displayName: 'WorkBuddy',
  iconKey: 'workbuddy',
  colorToken: 'sky',
  defaultRootLabels: ['~/.workbuddy'],

  detect: detectWorkbuddyRoots,

  async *collect(root, ctx) {
    const tracesRoot = path.join(root.rootPath, 'traces');
    if (!fs.existsSync(tracesRoot)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    const sessionCwds = loadSessionCwds(root.rootPath);
    const files = await collectFilesByExtension(tracesRoot, 'json', { nameFilter: (name) => name.startsWith('trace_') });
    for (const filePath of files) {
      const fileKey = path.relative(tracesRoot, filePath).replace(/[\\/]+/g, '/');
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      const state = ctx.getFileState(root.rootId, fileKey);
      if (state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      // trace 文件随工作流推进整体重写:变了就整文件重读,事件键幂等覆盖
      let trace = null;
      try { trace = JSON.parse(await fs.promises.readFile(filePath, 'utf8')).trace; } catch { trace = null; }
      if (trace) {
        const info = trace.modelInfo && typeof trace.modelInfo === 'object' ? trace.modelInfo : {};
        const inputTotal = toUint(info.totalInputTokens);
        const outputTokens = toUint(info.totalOutputTokens);
        const cached = toUint(info.totalCachedTokens);
        const cacheReadTokens = Math.min(inputTotal, cached);
        const inputTokens = inputTotal - cacheReadTokens;
        const occurredAtMs = parseIsoTimestampMs(trace.startedAt);
        if (occurredAtMs && (inputTokens || outputTokens || cacheReadTokens)) {
          const sessionId = typeof trace.sessionId === 'string' && trace.sessionId ? trace.sessionId : null;
          const cwd = sessionId ? sessionCwds.get(sessionId) || null : null;
          const totalTokens = toUint(trace.totalTokens);
          const event = buildUsageEvent({
            eventKey: `workbuddy:${root.rootId}:${trace.traceId || fileKey}`,
            agent: 'workbuddy',
            occurredAtMs,
            sessionKey: ctx.hmac(`workbuddy:${sessionId || trace.traceId}`),
            projectKey: cwd ? ctx.hmac(`workbuddy:${cwd}`) : null,
            projectDir: cwd,
            model: modelNameOf(info.models),
            inputTokens,
            cacheReadTokens,
            cacheWriteTokens: 0,
            outputTokens,
            reasoningTokens: 0,
            providerTotalTokens: totalTokens > 0 ? totalTokens : null,
            sourceVersion: typeof trace.agentName === 'string' && trace.agentName.trim() ? trace.agentName.trim() : null,
            exact: true,
          });
          if (event) yield event;
        }
      }
      ctx.saveFileState(root.rootId, fileKey, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: stat.size, formatVersion: 1 });
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
