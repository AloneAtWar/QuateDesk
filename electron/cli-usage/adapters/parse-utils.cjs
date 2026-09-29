// 新一代 adapter 共用的宽松解析工具:对齐 ccusage 的通用语义——
// 数字字段容忍字符串/浮点/负数,total 缺口回填 output,ISO 时间戳必须带时区。
// 只处理数值与时间;任何正文都不会经过这里。
const fs = require('node:fs');
const path = require('node:path');


// ccusage parse_ts_timestamp:YYYY-MM-DDTHH:MM:SS[.mmm](Z|±HH:MM),毫秒段只认 3 位
const ISO_STRICT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)?(Z|[+-]\d{2}:\d{2})$/;

const parseIsoTimestampMs = (value) => {
  if (typeof value !== 'string') return null;
  const match = ISO_STRICT.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const millis = fraction ? Number(fraction.padEnd(3, '0')) : 0;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), millis);
  if (Number.isNaN(utc)) return null;
  if (zone === 'Z') return utc;
  const sign = zone[0] === '+' ? 1 : -1;
  const offsetMinutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6));
  return utc - sign * offsetMinutes * 60_000;
};

// 宽松非负整数:JSON number / 数字字符串 / 截断浮点;非法返回 null
const lenientUint = (value) => {
  if (value === null || value === undefined) return null;
  let num;
  if (typeof value === 'number') num = value;
  else if (typeof value === 'string') { const text = value.trim(); if (!/^-?\d+(\.\d+)?$/.test(text)) return null; num = Number(text); }
  else return null;
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.floor(num);
};

// 对象里按候选键取第一个能解析的非负整数(ccusage token_number 语义)
const numberAt = (record, keys) => {
  if (!record || typeof record !== 'object') return 0;
  for (const key of keys) {
    const value = lenientUint(record[key]);
    if (value !== null) return value;
  }
  return 0;
};

// ccusage apply_total_token_fallback:total 超过已知分类的缺口,
// output 为 0 时补进 output,否则累加到 extra;返回调整后的 { output, extra }
const applyTotalTokenFallback = ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, extraTokens, totalTokens) => {
  const classified = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const known = classified + extraTokens;
  const missing = Math.max(0, totalTokens - known);
  if (missing === 0) return { outputTokens, extraTokens };
  if (outputTokens === 0) return { outputTokens: missing, extraTokens };
  return { outputTokens, extraTokens: extraTokens + missing };
};

// Grok sessions/<url 编码 cwd>/<uuid>:百分号解码按字节重组,坏序列降级替换字符
const urlDecodeBytes = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  const out = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0x25 && index + 2 < bytes.length) {
      const hi = Number.parseInt(String.fromCharCode(bytes[index + 1]), 16);
      const lo = Number.parseInt(String.fromCharCode(bytes[index + 2]), 16);
      if (Number.isInteger(hi) && Number.isInteger(hi) && hi >= 0 && hi < 16 && lo >= 0 && lo < 16) {
        out.push(hi * 16 + lo);
        index += 2;
        continue;
      }
    }
    out.push(byte);
  }
  return Buffer.from(out).toString('utf8');
};

// 递归收集目录下指定扩展名的文件(深度受限,符号链接目录不进入)
const collectFilesByExtension = async (dir, extension, { maxDepth = 10, nameFilter = null } = {}) => {
  const files = [];
  const walk = async (target, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.promises.readdir(target, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(`.${extension}`) && (!nameFilter || nameFilter(entry.name))) files.push(full);
    }
  };
  await walk(dir, 0);
  return files.sort();
};

module.exports = {
  parseIsoTimestampMs,
  lenientUint,
  numberAt,
  applyTotalTokenFallback,
  urlDecodeBytes,
  collectFilesByExtension,
};
