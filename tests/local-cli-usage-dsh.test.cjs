// dsh (DeepSeek Harness) adapter:zstd 拼接帧解码、chunk/message 同键收敛、
// reasoning 从 output 扣减、未压缩与版本化文件变体、尾部半帧容错、增长重扫幂等。
// fixture 在运行时由 zlib 生成,与真实 ~/.dsh/sessions 的三层目录一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { CliUsageStore } = require('../electron/cli-usage/store.cjs');
const dshAdapter = require('../electron/cli-usage/adapters/dsh.cjs');

const withEnv = async (overrides, run) => {
  const backup = {};
  for (const [key, value] of Object.entries(overrides)) {
    backup[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await run(); }
  finally {
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-cli-usage-'));
  const store = new CliUsageStore(path.join(dir, 'cli-usage.sqlite'));
  return { store, dir };
};

const scanAgent = async (adapter, store, { upsert = false, statuses = new Map() } = {}) => {
  const roots = await adapter.detect();
  const events = [];
  for (const root of roots) {
    statuses.set(root.rootId, root.exists ? 'ready' : 'missing');
    const ctx = {
      hmac: (value) => store.hmac(value),
      getFileState: (rootId, fileKey) => store.getFileState(adapter.id, rootId, fileKey),
      saveFileState: (rootId, fileKey, state) => store.saveFileState(adapter.id, rootId, fileKey, state),
      markRoot: (rootId, status, warning) => statuses.set(rootId, { status, warning }),
    };
    if (!root.exists) continue;
    let batch = [];
    for await (const event of adapter.collect(root, ctx)) {
      events.push(event);
      if (upsert) { batch.push(event); if (batch.length >= 100) { store.upsertEvents(batch); batch = []; } }
    }
    if (upsert && batch.length) store.upsertEvents(batch);
  }
  return events;
};

// ~/.dsh/sessions/<路径编码项目目录>/<sessionId>/ 三层结构
const sessionDir = (home, project, sessionId) => {
  const dir = path.join(home, 'sessions', project, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// 每段文本压成独立 zstd 帧后拼接(模拟 DSH 的 header 帧 + 追加帧)
const zstdFrames = (...texts) => Buffer.concat(texts.map((text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'))));

const sessionLine = JSON.stringify({ type: 'session', id: 'sess-a1', createdAt: 1782200000000, cwd: 'D:\\proj\\alpha' }) + '\n';
const headerLine = JSON.stringify({ type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-pro' } } } }) + '\n';

test('dsh zstd 拼接帧:chunk 与 message 同键,message 覆盖流式值', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-dsh-'));
  // 参考真机样本:usage {input 230, output 405, cacheRead 7808, reasoning 159}
  // → output 246, total 8284
  const chunk = JSON.stringify({ type: 'assistant/chunk', timestamp: 1782200001000, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 230, outputTokens: 300, cacheReadTokens: 7808, reasoningTokens: 100 } } } }) + '\n';
  const message = JSON.stringify({ type: 'assistant/message', timestamp: 1782200002000, data: { turn: 1, step: 1, usage: { inputTokens: 230, outputTokens: 405, cacheReadTokens: 7808, reasoningTokens: 159 } } }) + '\n';
  const step2 = JSON.stringify({ type: 'assistant/message', timestamp: 1782200003000, data: { turn: 1, step: 2, usage: { inputTokens: 10, outputTokens: 20 } } }) + '\n';
  fs.writeFileSync(path.join(sessionDir(home, '--D-proj-alpha--', 'session-5dc02928-a1b2'), 'session.jsonl.zstd'),
    zstdFrames(sessionLine + headerLine, chunk, message + step2));
  const { store } = createStore();
  const events = await withEnv({ DSH_HOME: home }, () => scanAgent(dshAdapter, store, { upsert: true }));
  assert.equal(events.length, 3); // chunk + 两条 message 各 yield 一条
  assert.equal(store.countEvents('dsh'), 2); // 同 (turn,step) 键合并
  const final = events.find((event) => event.eventKey.endsWith(':1:1') && event.outputTokens === 246);
  assert.ok(final, 'message 最终值应存在');
  assert.equal(final.model, 'deepseek-v4-pro');
  assert.equal(final.sourceVersion, 'deepseek');
  assert.equal(final.inputTokens, 230);
  assert.equal(final.cacheReadTokens, 7808);
  assert.equal(final.reasoningTokens, 159);
  assert.equal(final.totalTokens, 8284); // 230 + 246 + 7808,reasoning 不重复计入
  const report = store.models({ agent: 'dsh', mergeSameModels: false, scope: { kind: 'range', days: 365 }, timezone: 'UTC' });
  const row = report.models.find((item) => item.displayName === 'deepseek-v4-pro');
  assert.equal(row.totalTokens, 8284 + 30); // step1 取最终值,不与 chunk 双计
  store.close();
});

test('dsh 未压缩 session.jsonl 与版本化 session.v2.jsonl 变体同样解析', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-dsh-plain-'));
  const msg = JSON.stringify({ type: 'assistant/message', timestamp: 1782200100000, data: { turn: 2, step: 1, usage: { inputTokens: 5, outputTokens: 7 } } }) + '\n';
  fs.writeFileSync(path.join(sessionDir(home, '--tmp-beta--', 'session-plain'), 'session.jsonl'), sessionLine + headerLine + msg);
  const msg2 = JSON.stringify({ type: 'assistant/message', timestamp: 1782200200000, data: { turn: 1, step: 1, usage: { inputTokens: 3, outputTokens: 4, cacheWriteTokens: 2 } } }) + '\n';
  fs.writeFileSync(path.join(sessionDir(home, '--tmp-beta--', 'session-ver'), 'session.v2.jsonl.zstd'),
    zstdFrames(sessionLine + headerLine + msg2));
  const { store } = createStore();
  const events = await withEnv({ DSH_HOME: home }, () => scanAgent(dshAdapter, store));
  assert.equal(events.length, 2);
  const plain = events.find((event) => event.occurredAtMs === 1782200100000);
  assert.equal(plain.totalTokens, 12);
  const versioned = events.find((event) => event.occurredAtMs === 1782200200000);
  assert.equal(versioned.totalTokens, 9);
  assert.equal(versioned.cacheWriteTokens, 2);
  store.close();
});

test('dsh 尾部半帧不报错,完整帧照常产出', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-dsh-tail-'));
  const message = JSON.stringify({ type: 'assistant/message', timestamp: 1782200002000, data: { turn: 1, step: 1, usage: { inputTokens: 230, outputTokens: 405, cacheReadTokens: 7808, reasoningTokens: 159 } } }) + '\n';
  const full = zlib.zstdCompressSync(Buffer.from(sessionLine + headerLine + message, 'utf8'));
  // 追加一段"写到一半"的帧:合法帧头 + 截断的帧体
  const partial = zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'assistant/message', timestamp: 1782200009000, data: { turn: 1, step: 2, usage: { inputTokens: 99, outputTokens: 99 } } }) + '\n', 'utf8'));
  const truncatedTail = partial.subarray(0, Math.ceil(partial.length / 2));
  fs.writeFileSync(path.join(sessionDir(home, '--D-proj-alpha--', 'session-tail'), 'session.jsonl.zstd'),
    Buffer.concat([full, truncatedTail]));
  const { store } = createStore();
  const statuses = new Map();
  const events = await withEnv({ DSH_HOME: home }, () => scanAgent(dshAdapter, store, { statuses }));
  assert.equal(events.length, 1); // 完整帧里的 message
  assert.equal(events[0].totalTokens, 8284);
  assert.ok(![...statuses.values()].some((entry) => entry?.status === 'error'), '半帧不应导致 error');
  store.close();
});

test('dsh 追加新帧后重扫增量入库,无变化重扫零事件', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-dsh-grow-'));
  const file = path.join(sessionDir(home, '--D-proj-alpha--', 'session-grow'), 'session.jsonl.zstd');
  const msg1 = JSON.stringify({ type: 'assistant/message', timestamp: 1782200002000, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 10 } } }) + '\n';
  fs.writeFileSync(file, zstdFrames(sessionLine + headerLine + msg1));
  const { store } = createStore();
  await withEnv({ DSH_HOME: home }, () => scanAgent(dshAdapter, store, { upsert: true }));
  assert.equal(store.totalTokensAll('dsh'), 140); // 100 + (50-10)
  // 追加第二帧
  const msg2 = JSON.stringify({ type: 'assistant/message', timestamp: 1782200005000, data: { turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 8 } } }) + '\n';
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(msg2, 'utf8')));
  await withEnv({ DSH_HOME: home }, () => scanAgent(dshAdapter, store, { upsert: true }));
  assert.equal(store.totalTokensAll('dsh'), 140 + 28); // 旧事件重放不翻倍
  // 无变化再扫:游标跳过
  const again = await withEnv({ DSH_HOME: home }, () => scanAgent(dshAdapter, store, { upsert: true }));
  assert.equal(again.length, 0);
  assert.equal(store.totalTokensAll('dsh'), 168);
  store.close();
});

test('dsh request/header 切换模型后,后续 usage 归到新模型', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-dsh-switch-'));
  const header2 = JSON.stringify({ type: 'request/header', data: { header: { config: { provider: 'openai', model: 'gpt-5.5' } } } }) + '\n';
  const msg1 = JSON.stringify({ type: 'assistant/message', timestamp: 1782200002000, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 } } }) + '\n';
  const msg2 = JSON.stringify({ type: 'assistant/message', timestamp: 1782200004000, data: { turn: 2, step: 1, usage: { inputTokens: 30, outputTokens: 6 } } }) + '\n';
  fs.writeFileSync(path.join(sessionDir(home, '--D-proj-alpha--', 'session-sw'), 'session.jsonl.zstd'),
    zstdFrames(sessionLine + headerLine + msg1 + header2 + msg2));
  const { store } = createStore();
  const events = await withEnv({ DSH_HOME: home }, () => scanAgent(dshAdapter, store));
  assert.equal(events.length, 2);
  assert.equal(events.find((event) => event.eventKey.endsWith(':1:1')).model, 'deepseek-v4-pro');
  const switched = events.find((event) => event.eventKey.endsWith(':2:1'));
  assert.equal(switched.model, 'gpt-5.5');
  assert.equal(switched.sourceVersion, 'openai');
  store.close();
});

test('dsh 全零 usage 与缺 turn/step 的行跳过,事件键不含路径', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-dsh-skip-'));
  const lines = [
    JSON.stringify({ type: 'assistant/message', timestamp: 1782200002000, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 0 } } }),
    JSON.stringify({ type: 'assistant/message', timestamp: 1782200003000, data: { usage: { inputTokens: 9, outputTokens: 9 } } }),
    JSON.stringify({ type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text', text: '正文不应出现' } } }),
    JSON.stringify({ type: 'assistant/message', timestamp: 1782200004000, data: { turn: 1, step: 3, usage: { inputTokens: 1, outputTokens: 2 } } }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(sessionDir(home, '--D-proj-alpha--', 'session-skip'), 'session.jsonl.zstd'),
    zstdFrames(sessionLine + headerLine + lines));
  const { store } = createStore();
  const events = await withEnv({ DSH_HOME: home }, () => scanAgent(dshAdapter, store));
  assert.equal(events.length, 1);
  assert.equal(events[0].totalTokens, 3);
  assert.ok(!events[0].eventKey.includes('\\'), '事件键不应含反斜杠');
  assert.ok(!events[0].eventKey.includes('proj'), '事件键不应含项目路径');
  store.close();
});

test('dsh 缺 sessions 目录标记 missing,detect 支持 DSH_HOME 覆盖', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-dsh-empty-'));
  const { store } = createStore();
  const statuses = new Map();
  const events = await withEnv({ DSH_HOME: home }, () => scanAgent(dshAdapter, store, { statuses }));
  assert.equal(events.length, 0);
  assert.ok([...statuses.values()].some((entry) => (entry?.status ?? entry) === 'missing'));
  const roots = await withEnv({ DSH_HOME: home }, () => dshAdapter.detect());
  assert.equal(roots.length, 1);
  assert.equal(roots[0].rootLabel, '$DSH_HOME');
  store.close();
});
