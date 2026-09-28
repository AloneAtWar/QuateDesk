// Claude Code 适配器:projects/<project>/<session>.jsonl 的 assistant message。
// 流式响应会对同一 message.id 重复写多行(中间快照),恢复会话后可能再次出现;
// eventKey 用全局 message.id,UPSERT 按字段取最大值,自动收敛到最终快照,
// 绝不能"第一条胜出"。requestId 仅作辅助,缺失时也必须统计。
const fs = require('node:fs');
const path = require('node:path');
const { detectClaudeRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { walkJsonlLines, parseJsonLine } = require('./jsonl-walk.cjs');

const parseTimestamp = (value) => {
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? stamp : 0;
};

async function listProjectFiles(rootPath) {
  const projectsRoot = path.join(rootPath, 'projects');
  const files = [];
  let entries;
  try { entries = await fs.promises.readdir(projectsRoot, { withFileTypes: true }); }
  catch { return files; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsRoot, entry.name);
    let sessionEntries;
    try { sessionEntries = await fs.promises.readdir(projectDir, { withFileTypes: true }); }
    catch { continue; }
    for (const file of sessionEntries) {
      if (file.isFile() && file.name.endsWith('.jsonl')) files.push(path.join(projectDir, file.name));
    }
  }
  return files;
}

const adapter = {
  id: 'claude',
  displayName: 'Claude Code',
  iconKey: 'claude',
  colorToken: 'sky',
  defaultRootLabels: ['~/.claude'],

  detect: detectClaudeRoots,

  async *collect(root, ctx) {
    const projectsRoot = path.join(root.rootPath, 'projects');
    if (!fs.existsSync(projectsRoot)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    const files = await listProjectFiles(root.rootPath);
    for (const filePath of files) {
      const relative = path.relative(projectsRoot, filePath).replace(/[\\/]+/g, '/');
      const fileKey = relative;
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      const state = ctx.getFileState(root.rootId, fileKey);
      if (state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      const startCursor = state && Number(state.size) === stat.size ? Number(state.byteCursor) || 0 : 0;
      const generator = walkJsonlLines(filePath, startCursor);
      let nextCursor = startCursor;
      while (true) {
        const step = await generator.next();
        if (step.done) { nextCursor = step.value ?? nextCursor; break; }
        const { offset, line } = step.value;
        nextCursor = offset + line.length + 1;
        const record = parseJsonLine(line);
        const message = record?.message;
        if (record?.type !== 'assistant' || !message?.usage) continue;
        const usage = message.usage;
        // cache_creation 细分字段可选;1 小时/5 分钟桶都计入缓存写入
        const ephemeral = usage.cache_creation;
        const cacheWrite = Number(usage.cache_creation_input_tokens || 0)
          + (ephemeral ? Number(ephemeral.ephemeral_5m_input_tokens || 0) + Number(ephemeral.ephemeral_1h_input_tokens || 0) : 0);
        const occurredAtMs = parseTimestamp(record.timestamp) || Math.floor(stat.mtimeMs);
        const event = buildUsageEvent({
          eventKey: message.id
            ? `claude:${root.rootId}:${message.id}`
            : `claude:${root.rootId}:${relative}:${offset}`,
          agent: 'claude',
          occurredAtMs,
          sessionKey: ctx.hmac(`claude:${record.sessionId || relative}`),
          projectKey: record.cwd ? ctx.hmac(record.cwd) : null,
          model: message.model,
          inputTokens: usage.input_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheWriteTokens: cacheWrite,
          outputTokens: usage.output_tokens,
          reasoningTokens: null,
          providerTotalTokens: null,
          sourceVersion: record.version,
          exact: Boolean(message.id),
          isSidechain: record.isSidechain === true,
        });
        if (event) yield event;
      }
      ctx.saveFileState(root.rootId, fileKey, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: nextCursor, formatVersion: 1 });
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
