// Antigravity 适配器:Hub(~/.gemini/antigravity)与 CLI(~/.gemini/antigravity-cli)
// 两个根目录下 brain/<会话uuid>/.system_generated/logs/ 的 PLANNER_RESPONSE 行——
// 扁平 input_tokens/cache_read_tokens/output_tokens,三者互斥(in 是未命中缓存的
// 新输入,cr 常远大于 in,已验证)。live transcript.jsonl 与 transcript_full.jsonl
// 内容一致,优先 _full、缺失退回 live;chunks/ 是分片副本一律跳过防双计。行内
// model 只有部分行携带(新版行为),缺失时向前继承,或从 USER_INPUT 的
// <USER_SETTINGS_CHANGE> 显示名推导;文件变更即整文件重读,内容键幂等。
// conversations/*.db 为二进制 protobuf,不解析。
const fs = require('node:fs');
const path = require('node:path');
const { detectAntigravityRoots } = require('../paths.cjs');
const { buildUsageEvent } = require('../normalize.cjs');
const { parseJsonLine } = require('./jsonl-walk.cjs');
const { lenientUint, parseIsoTimestampMs } = require('./parse-utils.cjs');

const parseLine = parseJsonLine;

const toUint = (value) => lenientUint(value) ?? 0;

// 适配器数据口径版本:v2 起从设置变更推导模型。旧状态(formatVersion<2)即使
// 文件未变也强制重扫一次,让已入库的空模型事件经 UPSERT 补上推导值
const AGY_FORMAT_VERSION = 2;

// 旧版本(约 2026-11-19 前)的 PLANNER_RESPONSE 行不落 model 字段,但用户在会话中
// 切模型时,USER_INPUT 行的 <USER_SETTINGS_CHANGE> 会记显示名(如 "Gemini 4
// Argon (High)")。显示名 → 模型 id 的映射已用新版双写期的会话验证:
// "Gemini 4 Neon (XHigh)"→gemini-4-neon-xhigh、"Gemini 4 Hydrogen
// (Medium)"→gemini-4-hydrogen-medium,规则为小写 + 连字符 + 档位做后缀。
const MODEL_EFFORT_ALIASES = { 'x-high': 'xhigh', 'xhigh': 'xhigh', high: 'high', medium: 'medium', low: 'low' };

const modelIdFromDisplayName = (label) => {
  const raw = String(label || '').trim();
  if (!raw) return null;
  const match = /^(.*?)\s*\(([^)]+)\)$/.exec(raw);
  const base = (match ? match[1] : raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) return null;
  if (!match) return base;
  const effortRaw = match[2].toLowerCase().replace(/[^a-z0-9-]+/g, '');
  const suffix = MODEL_EFFORT_ALIASES[effortRaw] || effortRaw;
  return suffix ? `${base}-${suffix}` : base;
};

// 从 USER_INPUT 的设置变更块里取当前模型:"...`Model Selection` from X to Y."
const modelFromSettingsChange = (content) => {
  const text = String(content || '');
  if (!text.includes('Model Selection')) return null;
  const block = /<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/.exec(text);
  if (!block) return null;
  const change = /`Model Selection`\s+from\s+[^.]*?\s+to\s+([^.]+)\./.exec(block[1]);
  if (!change) return null;
  return modelIdFromDisplayName(change[1]);
};

const adapter = {
  id: 'antigravity',
  displayName: 'Antigravity',
  iconKey: 'antigravity',
  colorToken: 'sky',
  defaultRootLabels: ['~/.gemini/antigravity', '~/.gemini/antigravity-cli'],

  detect: detectAntigravityRoots,

  async *collect(root, ctx) {
    const brainRoot = path.join(root.rootPath, 'brain');
    if (!fs.existsSync(brainRoot)) {
      ctx.markRoot(root.rootId, 'missing', null);
      return;
    }
    const entries = await fs.promises.readdir(brainRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const logsDir = path.join(brainRoot, entry.name, '.system_generated', 'logs');
      // live 与 full 内容一致;优先完整副本,缺失退回 live,chunks 分片不读
      const fileName = fs.existsSync(path.join(logsDir, 'transcript_full.jsonl'))
        ? 'transcript_full.jsonl'
        : fs.existsSync(path.join(logsDir, 'transcript.jsonl')) ? 'transcript.jsonl' : null;
      if (!fileName) continue;
      const filePath = path.join(logsDir, fileName);
      const fileKey = `${entry.name}/${fileName}`;
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      const state = ctx.getFileState(root.rootId, fileKey);
      if (state && Number(state.formatVersion) === AGY_FORMAT_VERSION
        && Number(state.size) === stat.size && Number(state.mtimeMs) === Math.floor(stat.mtimeMs)) continue;
      let lines = [];
      try { lines = (await fs.promises.readFile(filePath, 'utf8')).split('\n'); } catch { continue; }
      let currentModel = null;
      for (const line of lines) {
        const record = parseLine(line);
        if (!record || typeof record !== 'object') continue;
        // model 优先取行内字段;旧版行缺失时从 USER_INPUT 的设置变更块推导,
        // 两者都按行序更新当前值,供后续 token 行继承(同 dsh 的 header 切模型)
        if (typeof record.model === 'string' && record.model.trim()) currentModel = record.model.trim();
        else if (record.type === 'USER_INPUT') {
          const inferred = modelFromSettingsChange(record.content);
          if (inferred) currentModel = inferred;
        }
        if (record.type !== 'PLANNER_RESPONSE') continue;
        const inputTokens = toUint(record.input_tokens);
        const cacheReadTokens = toUint(record.cache_read_tokens);
        const outputTokens = toUint(record.output_tokens);
        if (!inputTokens && !cacheReadTokens && !outputTokens) continue;
        const timestampMs = parseIsoTimestampMs(record.created_at);
        if (!timestampMs) continue;
        const event = buildUsageEvent({
          eventKey: `antigravity:${root.rootId}:${entry.name}:${record.step_index}|${timestampMs}|${inputTokens}|${cacheReadTokens}|${outputTokens}`,
          agent: 'antigravity',
          occurredAtMs: timestampMs,
          sessionKey: ctx.hmac(`antigravity:${entry.name}`),
          projectKey: null, // 转录不含工作目录
          model: (typeof record.model === 'string' && record.model.trim()) || currentModel,
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens: 0,
          outputTokens,
          reasoningTokens: 0,
          providerTotalTokens: null,
          sourceVersion: null,
          exact: true,
        });
        if (event) yield event;
      }
      ctx.saveFileState(root.rootId, fileKey, { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs), byteCursor: stat.size, formatVersion: AGY_FORMAT_VERSION });
    }
    ctx.markRoot(root.rootId, 'ready', null);
  },
};

module.exports = adapter;
