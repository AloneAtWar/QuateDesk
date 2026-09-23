// 规范化层:模型名归一、HMAC 标识、事件字段校验与时区日期边界。
// 只处理数值与必要元数据;正文、代码、命令输出永远不经过这里。
const crypto = require('node:crypto');

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// 各 adapter 明确声明的平台命名空间前缀,只做保守剥离
const MODEL_PREFIX_RULES = [
  /^kimi-code\//i,
  /^kimi\//i,
  /^anthropic\//i,
  /^openai\//i,
  /^zai\//i,
];

// canonicalModelKey:Unicode NFKC、去首尾空格、折叠连续空格、英文小写归一、
// 剥离已知平台前缀。不同版本号不会被归并;返回 null 表示未知模型。
const canonicalModelKey = (model) => {
  let value = typeof model === 'string' ? model : '';
  try { value = value.normalize('NFKC'); } catch { /* 保持原值 */ }
  value = value.trim().replace(/\s+/g, ' ');
  if (!value) return null;
  for (const rule of MODEL_PREFIX_RULES) {
    const stripped = value.replace(rule, '');
    if (stripped && stripped !== value) { value = stripped.trim(); break; }
  }
  value = value.trim();
  if (!value) return null;
  return value.toLowerCase();
};

const UNKNOWN_MODEL_KEY = '';

const modelKeyForGrouping = (canonicalKey) => (canonicalKey && canonicalKey !== UNKNOWN_MODEL_KEY ? canonicalKey : UNKNOWN_MODEL_KEY);

const modelDisplayName = (model) => {
  let value = typeof model === 'string' ? model : '';
  for (const rule of MODEL_PREFIX_RULES) {
    const stripped = value.replace(rule, '');
    if (stripped && stripped !== value) { value = stripped; break; }
  }
  return value.trim() || '未知模型';
};

const hmacHex = (value, salt) => crypto
  .createHmac('sha256', String(salt))
  .update(String(value))
  .digest('hex')
  .slice(0, 24);

const safeTokenCount = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  if (rounded < 0 || rounded > MAX_SAFE) return null;
  return rounded;
};

// 统一公式:classified = input + cacheRead + cacheWrite + output
//           extra = max(0, providerTotal - classified)
//           total = providerTotal 可用时取它,否则 classified
// 厂商的 providerTotal 通常就是权威总数(ZCode = input+output、含缓存);
// 绝不能取 max(providerTotal, classified),否则分类超额会抬高 total 造成重复
// reasoning 是 output 的子集,只展示,不参与求和
const buildUsageEvent = (input) => {
  const occurredAtMs = safeTokenCount(input.occurredAtMs);
  if (occurredAtMs === null || occurredAtMs <= 0) return null;
  const inputTokens = safeTokenCount(input.inputTokens) ?? 0;
  const cacheReadTokens = safeTokenCount(input.cacheReadTokens) ?? 0;
  const cacheWriteTokens = safeTokenCount(input.cacheWriteTokens) ?? 0;
  const outputTokens = safeTokenCount(input.outputTokens) ?? 0;
  const reasoningTokens = safeTokenCount(input.reasoningTokens) ?? 0;
  const providerTotal = safeTokenCount(input.providerTotalTokens);
  const classified = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
  const extraTokens = providerTotal !== null ? Math.max(0, providerTotal - classified) : 0;
  const totalTokens = providerTotal !== null ? providerTotal : classified;
  return {
    eventKey: String(input.eventKey || ''),
    agent: String(input.agent || ''),
    occurredAtMs,
    sessionKey: String(input.sessionKey || ''),
    projectKey: input.projectKey ? String(input.projectKey) : null,
    model: typeof input.model === 'string' && input.model.trim() ? input.model : null,
    canonicalModelKey: canonicalModelKey(input.model),
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    extraTokens,
    totalTokens,
    requestCount: 1,
    sourceVersion: typeof input.sourceVersion === 'string' && input.sourceVersion.trim() ? input.sourceVersion.slice(0, 64) : null,
    exact: input.exact !== false,
    isSidechain: input.isSidechain === true,
  };
};

const isValidTimeZone = (timeZone) => {
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch { return false; }
};

const isValidDateString = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
};

const DATE_ONLY_FORMATTER_CACHE = new Map();
const dateFormatter = (timeZone) => {
  let formatter = DATE_ONLY_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    DATE_ONLY_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
};

// 当前时刻(或指定毫秒)在目标时区的本地日期 YYYY-MM-DD
const localDateString = (timeZone, atMs = Date.now()) => dateFormatter(timeZone).format(new Date(atMs));

const zoneOffsetMs = (timeZone, atMs) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(atMs));
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  const asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour) === 24 ? 0 : Number(map.hour), Number(map.minute), Number(map.second));
  return asUtc - Math.floor(atMs / 1000) * 1000;
};

// 目标时区某本地日期 00:00 对应的 UTC 毫秒;两次逼近处理 DST
const zonedDayStartUtcMs = (dateString, timeZone) => {
  const [year, month, day] = dateString.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day);
  let offset = zoneOffsetMs(timeZone, guess);
  let stamp = guess - offset;
  offset = zoneOffsetMs(timeZone, stamp);
  stamp = guess - offset;
  return stamp;
};

const shiftDateString = (dateString, deltaDays) => {
  const [year, month, day] = dateString.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
};

// 生成 [endDate 向前 days 天, 含 endDate] 的本地日边界(UTC 毫秒),升序。
// 末日结束边界同样按次日 00:00 计算,兼容 DST 切换日的 23/25 小时
const buildDayBoundaries = (timeZone, endDate, days) => {
  const list = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = shiftDateString(endDate, -index);
    list.push({ date, startMs: zonedDayStartUtcMs(date, timeZone) });
  }
  for (let index = 0; index < list.length - 1; index += 1) list[index].endMs = list[index + 1].startMs;
  list[list.length - 1].endMs = zonedDayStartUtcMs(shiftDateString(endDate, 1), timeZone);
  return list;
};

// 连续天数:与 renderer 的 computeUsageStreaks 同口径 —— 当前连续从最后一天往前数,
// 最后一天(通常是今天)还没有用量时从前一天起算
const computeStreaks = (dailyTotals) => {
  const active = dailyTotals.map((total) => total > 0);
  let cursor = active.length - 1;
  if (!active[cursor]) cursor -= 1;
  let current = 0;
  while (cursor >= 0 && active[cursor]) { current += 1; cursor -= 1; }
  let longest = 0;
  let run = 0;
  for (const flag of active) {
    run = flag ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return { current, longest };
};

module.exports = {
  MAX_SAFE,
  canonicalModelKey,
  modelKeyForGrouping,
  modelDisplayName,
  hmacHex,
  safeTokenCount,
  buildUsageEvent,
  isValidTimeZone,
  isValidDateString,
  localDateString,
  zonedDayStartUtcMs,
  shiftDateString,
  buildDayBoundaries,
  computeStreaks,
};
