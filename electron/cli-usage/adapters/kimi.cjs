// Kimi Code 适配器:sessions/**/agents/*/wire.jsonl 的新版 usage.record,
// 兼容旧版 wire.jsonl 的 StatusUpdate。只统计 usageScope === "turn",
// session 是累计值,加入会造成重复。
const fs = require('node:fs');
const path = require('node:path');
const { detectKimiRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { walkJsonlLines, parseJsonLine } = require('./jsonl-walk.cjs');

async function listWireFiles(sessionsRoot) {
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name === 'wire.jsonl') files.push(full);
    }
  };
  await walk(sessionsRoot, 0);
  return files;
}

// 事件没有稳定 ID:用"根目录 ID + 相对文件 + 行起始字节偏移"做物理事件键,
// 文件截断/替换时重扫并 UPSERT
const adapter = {
  id: 'kimi',
  displayName: 'Kimi Code',
  iconKey: 'kimi',
  colorToken: 'violet',
  defaultRootLabels: ['~/.kimi-code', '~/.kimi'],

  detect: detectKimiRoots,

  async *collect(root, ctx) {
    const sessionsRoot = path.join(root.rootPath, 'sessions');
    if (!fs.existsSync(sessionsRoot)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    const files = await listWireFiles(sessionsRoot);
    for (const filePath of files) {
      const relative = path.relative(sessionsRoot, filePath).replace(/[\\/]+/g, '/');
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
        if (!record) continue;
        // 目录布局 sessions/<workDirKey>/<sessionId>/agents/<agentId>/wire.jsonl;
        // 旧版少一层 agents。会话取 session_ 段,项目取首段 workDirKey
        const parts = relative.split('/');
        const sessionPart = parts.find((part) => part.startsWith('session_')) || parts[0] || relative;
        const projectPart = parts[0] || relative;
        const usage = record.type === 'usage.record'
          ? (record.usageScope === 'turn' ? record.usage : null)
          : (record.type === 'StatusUpdate' && record.token_usage ? record.token_usage : null);
        if (!usage) continue;
        const numberOrZero = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
        const event = buildUsageEvent({
          eventKey: `kimi:${root.rootId}:${relative}:${offset}`,
          agent: 'kimi',
          occurredAtMs: record.time || record.timestamp || Math.floor(stat.mtimeMs),
          sessionKey: ctx.hmac(`kimi:${sessionPart}`),
          projectKey: ctx.hmac(`kimi:${projectPart}`),
          model: record.model,
          inputTokens: numberOrZero(usage.inputOther ?? usage.input_other),
          cacheReadTokens: numberOrZero(usage.inputCacheRead ?? usage.input_cache_read),
          cacheWriteTokens: numberOrZero(usage.inputCacheCreation ?? usage.input_cache_creation),
          outputTokens: numberOrZero(usage.output),
          reasoningTokens: 0,
          providerTotalTokens: null,
          sourceVersion: null,
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
