// DeepSeek Harness 适配器:~/.dsh/sessions/<路径编码项目目录>/<sessionId>/session.jsonl[.zstd]
// (另有 session.v<N>.jsonl[.zstd] 版本化拼写;项目目录三层嵌套,需递归收集)。
// zstd 文件是独立帧拼接(header 帧 + 每次追加一帧):Node 的 zstdDecompressSync
// 只解首帧,必须按魔数 0xFD2FB528 逐帧切分解码。
// 口径对齐 DSH tokenUsageProjection:
// - 同一 (turn, step) 的 assistant/message.usage 覆盖之前的 assistant/chunk usage,
//   两者共用事件键,入库 MAX 合并等价于"最终值覆盖流式值";
// - outputTokens 已含 reasoningTokens:output 扣减后入账,reasoning 只展示,
//   total = input + output + cacheRead + cacheWrite(reasoning 不重复计入)。
// 模型/供应商随 request/header 行变化,文件有变更即全量重扫(事件键幂等),
// 不做字节游标续扫——中途恢复会丢失 header 帧之前的模型状态,全量反而更简单可靠。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { detectDshRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { lenientUint, parseIsoTimestampMs, collectFilesByExtension } = require('./parse-utils.cjs');

const toUint = (value) => lenientUint(value) ?? 0;

const ZSTD_MAGIC_LE = 0xfd2fb528;
const SESSION_FILE_NAME = /^session(?:\.v\d+)?\.jsonl$/;
const SESSION_FILE_NAME_ZSTD = /^session(?:\.v\d+)?\.jsonl\.zstd$/;

// 拼接帧解码:魔数给出候选帧边界,逐段贪心解压;边界落在帧内(魔数出现在压缩
// 数据里)时解压会失败,并入下一个候选边界重试;耗尽仍失败视作尾部半帧,
// 截断在上一个成功帧的末尾(该帧写全后文件 size 变化,下次扫描自然补齐)
const decodeZstdFrames = (buffer) => {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC_LE) return null;
  const starts = [0];
  for (let index = 4; index + 4 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(index) === ZSTD_MAGIC_LE) starts.push(index);
  }
  const chunks = [];
  let index = 0;
  while (index < starts.length) {
    const start = starts[index];
    let decoded = null;
    let next = starts.length;
    for (let probe = index + 1; probe <= starts.length; probe += 1) {
      const candidateEnd = probe < starts.length ? starts[probe] : buffer.length;
      try {
        decoded = zlib.zstdDecompressSync(buffer.subarray(start, candidateEnd));
        next = probe;
        break;
      } catch { /* 候选边界不对,并入后续帧再试 */ }
    }
    if (decoded === null) break;
    chunks.push(decoded);
    index = next;
  }
  return Buffer.concat(chunks).toString('utf8');
};

// epoch 毫秒(>1e12)与秒自适应;字符串走严格 ISO
const timestampMs = (value) => {
  if (typeof value === 'string') return parseIsoTimestampMs(value);
  const num = lenientUint(value);
  if (num === null || num <= 0) return null;
  return num > 1e12 ? num : num * 1000;
};

const usageAt = (record) => {
  if (record.type === 'assistant/chunk' && record.data?.chunk?.type === 'usage') {
    return { usage: record.data.chunk.usage, turn: record.data.turn, step: record.data.step };
  }
  if (record.type === 'assistant/message' && record.data?.usage) {
    return { usage: record.data.usage, turn: record.data.turn, step: record.data.step };
  }
  return null;
};

const adapter = {
  id: 'dsh',
  displayName: 'DeepSeek Harness',
  iconKey: 'dsh',
  colorToken: 'sky',
  defaultRootLabels: ['~/.dsh'],

  detect: detectDshRoots,

  async *collect(root, ctx) {
    const sessionsRoot = path.join(root.rootPath, 'sessions');
    if (!fs.existsSync(sessionsRoot)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    const files = [
      ...await collectFilesByExtension(sessionsRoot, 'jsonl', { nameFilter: (name) => SESSION_FILE_NAME.test(name) }),
      ...await collectFilesByExtension(sessionsRoot, 'zstd', { nameFilter: (name) => SESSION_FILE_NAME_ZSTD.test(name) }),
    ].sort();
    for (const filePath of files) {
      const fileKey = path.relative(sessionsRoot, filePath).replace(/[\\/]+/g, '/');
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      const state = ctx.getFileState(root.rootId, fileKey);
      if (state && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      const raw = await fs.promises.readFile(filePath).catch(() => null);
      if (!raw) continue;
      const text = filePath.endsWith('.zstd') ? decodeZstdFrames(raw) : raw.toString('utf8');
      if (!text) continue;
      // 每个文件内的会话状态:session 行给身份/项目/起始时间,
      // request/header 行维护当前模型与供应商(会话中可能切换)
      let sessionId = path.basename(path.dirname(filePath));
      let sessionCreatedMs = null;
      let projectPath = null;
      let currentModel = null;
      let currentProvider = null;
      for (const line of text.split('\n')) {
        // 正文 chunk 占绝大部分行,先用子串粗筛掉,避免全量 JSON.parse
        if (!line.includes('"usage"') && !line.includes('"session"') && !line.includes('"request/header"')) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (!record || typeof record !== 'object') continue;
        if (record.type === 'session') {
          if (typeof record.id === 'string' && record.id.trim()) sessionId = record.id.trim();
          const created = timestampMs(record.createdAt);
          if (created) sessionCreatedMs = created;
          if (typeof record.cwd === 'string' && record.cwd.trim()) projectPath = record.cwd;
          continue;
        }
        if (record.type === 'request/header') {
          const config = record.data?.header?.config;
          if (typeof config?.model === 'string' && config.model.trim()) currentModel = config.model.trim();
          if (typeof config?.provider === 'string' && config.provider.trim()) currentProvider = config.provider.trim();
          continue;
        }
        const found = usageAt(record);
        if (!found) continue;
        const turn = lenientUint(found.turn);
        const step = lenientUint(found.step);
        if (turn === null || step === null) continue;
        const inputTokens = toUint(found.usage.inputTokens);
        const cacheReadTokens = toUint(found.usage.cacheReadTokens);
        const cacheWriteTokens = toUint(found.usage.cacheWriteTokens);
        const reasoningTokens = toUint(found.usage.reasoningTokens);
        const outputTokens = Math.max(0, toUint(found.usage.outputTokens) - reasoningTokens);
        if (!inputTokens && !cacheReadTokens && !cacheWriteTokens && !outputTokens && !reasoningTokens) continue;
        const occurredAtMs = timestampMs(record.timestamp)
          ?? timestampMs(record.data?.timestamp)
          ?? sessionCreatedMs
          ?? Math.floor(stat.mtimeMs);
        const event = buildUsageEvent({
          eventKey: `dsh:${root.rootId}:${sessionId}:${turn}:${step}`,
          agent: 'dsh',
          occurredAtMs,
          sessionKey: ctx.hmac(`dsh:${sessionId}`),
          projectKey: projectPath ? ctx.hmac(`dsh:${projectPath}`) : null,
          model: currentModel,
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          outputTokens,
          reasoningTokens,
          providerTotalTokens: null,
          sourceVersion: currentProvider,
          exact: true,
        });
        if (event) yield event;
      }
      ctx.saveFileState(root.rootId, fileKey, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: stat.size, formatVersion: 1 });
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
