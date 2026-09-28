// JSONL 流式增量读取:按"最后一个完整换行后的字节偏移"推进游标,
// 末尾半行留到下次处理;单行超限时跳过该行,不让一个损坏文件拖垮整个来源。
const fs = require('node:fs');

const DEFAULT_CHUNK_BYTES = 128 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

// yields { offset, line };返回值是新的游标(调用方负责持久化)
async function* walkJsonlLines(filePath, startCursor = 0) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    let cursor = startCursor <= size ? startCursor : 0; // 文件被截断则从头重扫
    if (cursor >= size) return cursor;
    let buffer = Buffer.alloc(0);
    let lineStart = cursor;
    const chunk = Buffer.allocUnsafe(Math.min(DEFAULT_CHUNK_BYTES, Math.max(4096, size - cursor)));
    while (cursor < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - cursor), cursor);
      if (bytesRead <= 0) break;
      cursor += bytesRead;
      buffer = buffer.length ? Buffer.concat([buffer, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let newlineIndex = buffer.indexOf(0x0A);
      while (newlineIndex >= 0) {
        const lineBytes = buffer.subarray(0, newlineIndex);
        if (lineBytes.length > MAX_LINE_BYTES) { /* 超限行直接丢弃 */ }
        else if (lineBytes.length > 0) {
          yield { offset: lineStart, line: lineBytes.toString('utf8') };
        }
        lineStart += newlineIndex + 1;
        buffer = buffer.subarray(newlineIndex + 1);
        newlineIndex = buffer.indexOf(0x0A);
      }
      if (buffer.length > MAX_LINE_BYTES) {
        // 无换行的超长残留:丢弃并跳过剩余(容错,正常日志不会出现)
        lineStart = cursor;
        buffer = Buffer.alloc(0);
      }
    }
    return lineStart; // 末尾半行不消费,游标停在最后一个完整换行后
  } finally {
    await handle.close();
  }
}

const parseJsonLine = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

module.exports = { walkJsonlLines, parseJsonLine, MAX_LINE_BYTES };
