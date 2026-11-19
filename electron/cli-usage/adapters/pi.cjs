// Pi 适配器:~/.pi/agent/sessions/<编码 cwd>/<时间戳>_<uuid>.jsonl 的
// assistant message.usage。totalTokens = input + cacheRead + cacheWrite + output
// (已验证),reasoning 是 output 的子集只展示;每行 usage 自带 model/provider,
// model_change 行只作展示序列,增量扫描无需跨行状态。
const fs = require('node:fs');
const path = require('node:path');
const { detectPiRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { walkJsonlLines, parseJsonLine } = require('./jsonl-walk.cjs');
const { lenientUint, parseIsoTimestampMs, collectFilesByExtension } = require('./parse-utils.cjs');

const toUint = (value) => lenientUint(value) ?? 0;

// 会话身份行永远在文件头;增量扫描游标跳过它,所以每次都单独重读首行取 cwd/id。
// 首行损坏时退回文件名里的 uuid(只作标识,不含路径)
const readSessionMeta = (filePath) => {
  const fallbackId = (path.basename(filePath, '.jsonl').split('_').pop() || '').trim();
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0A);
    const line = parseJsonLine(buffer.subarray(0, newline > 0 ? newline : bytesRead).toString('utf8'));
    if (line?.type === 'session') {
      return {
        sessionId: typeof line.id === 'string' && line.id ? line.id : fallbackId,
        cwd: typeof line.cwd === 'string' && line.cwd ? line.cwd : null,
      };
    }
  } catch { /* 首行读取失败时只用文件名兜底 */ } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
  return { sessionId: fallbackId || path.basename(filePath), cwd: null };
};

const adapter = {
  id: 'pi',
  displayName: 'Pi',
  iconKey: 'pi',
  colorToken: 'mint',
  defaultRootLabels: ['~/.pi'],

  detect: detectPiRoots,

  async *collect(root, ctx) {
    const sessionsRoot = path.join(root.rootPath, 'agent', 'sessions');
    if (!fs.existsSync(sessionsRoot)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    const files = await collectFilesByExtension(sessionsRoot, 'jsonl');
    for (const filePath of files) {
      const fileKey = path.relative(sessionsRoot, filePath).replace(/[\\/]+/g, '/');
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      const state = ctx.getFileState(root.rootId, fileKey);
      if (state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      // 追加只读新增字节;文件变小(重写/轮转)则从头重扫,事件键幂等去重
      const startCursor = state && Number(state.size) <= stat.size ? Number(state.byteCursor) || 0 : 0;
      const meta = readSessionMeta(filePath);
      const generator = walkJsonlLines(filePath, startCursor);
      let nextCursor = startCursor;
      while (true) {
        const step = await generator.next();
        // 生成器返回值是字节级游标(末尾半行不消费),比按字符累加更准
        if (step.done) { nextCursor = step.value ?? nextCursor; break; }
        const { line } = step.value;
        const record = parseJsonLine(line);
        if (record?.type !== 'message') continue;
        const message = record.message;
        if (!message || message.role !== 'assistant' || !message.usage) continue;
        const usage = message.usage;
        const timestampMs = parseIsoTimestampMs(record.timestamp) || toUint(message.timestamp);
        if (!timestampMs) continue;
        const inputTokens = toUint(usage.input);
        const cacheReadTokens = toUint(usage.cacheRead);
        const cacheWriteTokens = toUint(usage.cacheWrite);
        const outputTokens = toUint(usage.output);
        const reasoningTokens = toUint(usage.reasoning);
        if (!inputTokens && !cacheReadTokens && !cacheWriteTokens && !outputTokens && !reasoningTokens) continue;
        const totalTokens = toUint(usage.totalTokens);
        const model = typeof message.model === 'string' && message.model.trim() ? message.model.trim() : null;
        const event = buildUsageEvent({
          eventKey: `pi:${root.rootId}:${meta.sessionId}:${record.id ?? timestampMs}`,
          agent: 'pi',
          occurredAtMs: timestampMs,
          sessionKey: ctx.hmac(`pi:${meta.sessionId}`),
          projectKey: meta.cwd ? ctx.hmac(`pi:${meta.cwd}`) : null,
          projectDir: meta.cwd,
          model,
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          outputTokens,
          reasoningTokens,
          providerTotalTokens: totalTokens > 0 ? totalTokens : null,
          sourceVersion: typeof message.provider === 'string' && message.provider.trim() ? message.provider.trim() : null,
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
