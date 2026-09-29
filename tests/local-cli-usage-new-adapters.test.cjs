// 新一代 adapter(grok/gemini/openclaw/hermes/opencode/copilot)的解析与对账:
// 覆盖缓存拆分、total 缺口回填、累计快照差分、OTel 优先级抑制、
// session-state ↔ OTel 对账撤回、聚合兜底撤回、归档文件与迁移去重。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { CliUsageStore } = require('../electron/cli-usage/store.cjs');
const grokAdapter = require('../electron/cli-usage/adapters/grok.cjs');
const geminiAdapter = require('../electron/cli-usage/adapters/gemini.cjs');
const openclawAdapter = require('../electron/cli-usage/adapters/openclaw.cjs');
const hermesAdapter = require('../electron/cli-usage/adapters/hermes.cjs');
const opencodeAdapter = require('../electron/cli-usage/adapters/opencode.cjs');
const copilotAdapter = require('../electron/cli-usage/adapters/copilot.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'cli-usage');

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

// 与 worker.cjs 一致的扫描上下文:含 deleteEvents/deferDeleteEvents;
// upsert 在迭代中分批落库,延迟撤回在最终落库之后执行(与 worker 顺序一致)
const scanAgent = async (adapter, store, { upsert = false, statuses = new Map() } = {}) => {
  const roots = await adapter.detect();
  const events = [];
  for (const root of roots) {
    statuses.set(root.rootId, root.exists ? 'ready' : 'missing');
    const deferredDeletes = [];
    const ctx = {
      hmac: (value) => store.hmac(value),
      getFileState: (rootId, fileKey) => store.getFileState(adapter.id, rootId, fileKey),
      saveFileState: (rootId, fileKey, state) => store.saveFileState(adapter.id, rootId, fileKey, state),
      markRoot: (rootId, status, warning) => statuses.set(rootId, { status, warning }),
      deleteEvents: (predicate) => store.deleteEvents(adapter.id, predicate),
      deferDeleteEvents: (predicate) => deferredDeletes.push(predicate),
    };
    if (!root.exists) continue;
    let batch = [];
    for await (const event of adapter.collect(root, ctx)) {
      events.push(event);
      if (upsert) { batch.push(event); if (batch.length >= 100) { store.upsertEvents(batch); batch = []; } }
    }
    if (upsert && batch.length) store.upsertEvents(batch);
    for (const predicate of deferredDeletes) store.deleteEvents(adapter.id, predicate);
  }
  return events;
};

const byModel = (events, model) => events.filter((event) => event.model === model);

// ---- Grok ----------------------------------------------------------------

test('grok turn_completed:cachedRead 从 input 扣除,reasoning 只展示', async () => {
  const { store } = createStore();
  const events = await withEnv({ GROK_HOME: path.join(FIXTURES, 'grok') }, () => scanAgent(grokAdapter, store));
  const row = byModel(events, 'grok-4.6-build')[0];
  assert.ok(row, '应有 grok-4.6-build 事件');
  assert.equal(row.inputTokens, 3254887 - 2798848);
  assert.equal(row.cacheReadTokens, 2798848);
  assert.equal(row.cacheWriteTokens, 0);
  assert.equal(row.outputTokens, 79606);
  assert.equal(row.reasoningTokens, 70707);
  assert.equal(row.totalTokens, 3334493);
  assert.equal(row.occurredAtMs, 1789808430000); // agentTimestampMs 优先于外层秒
  store.close();
});

test('grok 多模型 turn 拆成多条,重复行按 eventId 去重', async () => {
  const { store } = createStore();
  const events = await withEnv({ GROK_HOME: path.join(FIXTURES, 'grok') },
    () => scanAgent(grokAdapter, store, { upsert: true }));
  assert.equal(byModel(events, 'model-a').length, 2); // 原始 yield 两条(重复行)
  assert.equal(byModel(events, 'model-b').length, 2);
  // 入库后同键合并:evt-g1 + evt-g2 的 model-a/model-b 各一行
  assert.equal(store.countEvents('grok'), 3);
  const report = store.models({ agent: 'grok', mergeSameModels: false, scope: { kind: 'range', days: 365 }, timezone: 'UTC' });
  const modelA = report.models.find((row) => row.displayName === 'model-a');
  const modelB = report.models.find((row) => row.displayName === 'model-b');
  assert.equal(modelA.inputTokens, 10);
  assert.equal(modelB.inputTokens, 15); // 20 - 5 cached
  assert.equal(modelB.cacheReadTokens, 5);
  store.close();
});

test('grok summary 提供项目路径与默认模型', async () => {
  const { store } = createStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-grok-nmu-'));
  // 无 modelUsage 时回退 summary.current_model_id
  fs.mkdirSync(path.join(dir, 'sessions', 'proj-x', 'sess-n'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', 'proj-x', 'sess-n', 'updates.jsonl'),
    '{"timestamp":1789808430,"params":{"update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":50,"outputTokens":5,"cachedReadTokens":0}}}}\n');
  fs.writeFileSync(path.join(dir, 'sessions', 'proj-x', 'sess-n', 'summary.json'),
    '{"info":{"id":"sess-n","cwd":"/tmp/proj-x"},"current_model_id":"grok-4.5"}');
  const events = await withEnv({ GROK_HOME: dir }, () => scanAgent(grokAdapter, store));
  assert.equal(events.length, 1);
  assert.equal(events[0].model, 'grok-4.5');
  assert.equal(events[0].inputTokens, 50);
  store.close();
});

// ---- Gemini --------------------------------------------------------------

test('gemini direct 事件:total 缺口进 extra,流式同 id 收敛到最终快照', async () => {
  const { store } = createStore();
  const events = await withEnv({ GEMINI_DATA_DIR: path.join(FIXTURES, 'gemini', 'chats') },
    () => scanAgent(geminiAdapter, store));
  const final = events.filter((event) => event.model === 'gemini-3.5-flash');
  assert.equal(final.length, 1); // m-1 出现两次,后者覆盖前者
  assert.equal(final[0].inputTokens, 200);
  assert.equal(final[0].outputTokens, 30);
  assert.equal(final[0].reasoningTokens, 5);
  assert.equal(final[0].totalTokens, 235);
  assert.equal(final[0].extraTokens, 5); // 235 - (200+30+0)
  store.close();
});

test('gemini stats.models:cached 按 input 子集扣除', async () => {
  const { store } = createStore();
  const events = await withEnv({ GEMINI_DATA_DIR: path.join(FIXTURES, 'gemini', 'chats') },
    () => scanAgent(geminiAdapter, store));
  const statsMs = Date.parse('2026-09-02T08:00:00.000Z');
  const flash = events.find((event) => event.model === 'gemini-2.5-flash' && event.occurredAtMs === statsMs);
  assert.ok(flash, 'flash stats 事件应存在');
  assert.equal(flash.inputTokens, 60); // 100 - 40 重叠
  assert.equal(flash.cacheReadTokens, 40);
  assert.equal(flash.outputTokens, 20);
  assert.equal(flash.totalTokens, 170);
  assert.equal(flash.extraTokens, 50); // thoughts 50
  const pro = events.find((event) => event.model === 'gemini-2.5-pro' && event.occurredAtMs === statsMs);
  assert.ok(pro, 'pro stats 事件应存在');
  assert.equal(pro.inputTokens, 80);
  assert.equal(pro.totalTokens, 90);
  assert.equal(pro.extraTokens, 0);
  store.close();
});

test('gemini 整档 .json:messages 里的 direct 事件,total 未含 cached 时按重叠扣除', async () => {
  const { store } = createStore();
  const events = await withEnv({ GEMINI_DATA_DIR: path.join(FIXTURES, 'gemini', 'chats') },
    () => scanAgent(geminiAdapter, store));
  const row = events.find((event) => event.occurredAtMs === Date.parse('2026-09-01T00:01:00.000Z'));
  assert.ok(row, 'session-b.json 的事件应存在');
  // total 130 == 100+20+10(不含 cached)→ cached 视为 input 子集
  assert.equal(row.inputTokens, 60);
  assert.equal(row.cacheReadTokens, 40);
  assert.equal(row.outputTokens, 20);
  assert.equal(row.totalTokens, 130);
  assert.equal(row.extraTokens, 10);
  store.close();
});

// ---- OpenClaw ------------------------------------------------------------

test('openclaw model_change 维护模型状态,坏 message 不丢状态,total 缺口补 output', async () => {
  const { store } = createStore();
  const events = await withEnv({ OPENCLAW_DIR: path.join(FIXTURES, 'openclaw') },
    () => scanAgent(openclawAdapter, store));
  const e1 = events.find((event) => event.eventKey.includes(':e1:') || event.occurredAtMs === Date.parse('2026-03-22T04:40:26.348Z'));
  assert.ok(e1, 'e1 应存在');
  assert.equal(e1.model, 'gpt-5.2');
  assert.equal(e1.sourceVersion, 'openai');
  assert.equal(e1.inputTokens, 10);
  assert.equal(e1.outputTokens, 20);
  const e2 = events.find((event) => event.occurredAtMs === 1774000000000);
  assert.ok(e2, 'e2 应存在');
  assert.equal(e2.model, 'gpt-5.2'); // 状态延续
  assert.equal(e2.outputTokens, 222); // 只有 totalTokens 时补进 output
  assert.equal(e2.totalTokens, 222);
  store.close();
});

test('openclaw 归档 .jsonl.deleted.* 照常统计,缓存桶独立', async () => {
  const { store } = createStore();
  const events = await withEnv({ OPENCLAW_DIR: path.join(FIXTURES, 'openclaw') },
    () => scanAgent(openclawAdapter, store));
  const e3 = events.find((event) => event.occurredAtMs === 1774000100000);
  assert.ok(e3, '归档会话事件应存在');
  assert.equal(e3.model, 'claude-opus-4.6');
  assert.equal(e3.inputTokens, 100);
  assert.equal(e3.cacheReadTokens, 30);
  assert.equal(e3.cacheWriteTokens, 10);
  assert.equal(e3.outputTokens, 50);
  assert.equal(e3.totalTokens, 190);
  store.close();
});

test('openclaw SQLite 迁移副本与 JSONL 同内容共用事件键,不双计', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-openclaw-mig-'));
  fs.mkdirSync(path.join(dir, 'agents', 'main', 'sessions'), { recursive: true });
  const line = '{"type":"message","id":"e9","timestamp":1774000200000,"message":{"role":"assistant","usage":{"input":7,"output":8}}}';
  fs.writeFileSync(path.join(dir, 'agents', 'main', 'sessions', 'legacy.jsonl'), `${line}\n`);
  const dbDir = path.join(dir, 'agents', 'main', 'agent');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, 'openclaw-agent.sqlite'));
  db.exec('CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq))');
  db.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)')
    .run('legacy', 0, line, 1774000200000);
  db.close();
  const { store } = createStore();
  const events = await withEnv({ OPENCLAW_DIR: dir }, () => scanAgent(openclawAdapter, store, { upsert: true }));
  assert.equal(events.length, 2); // 两源各发一条
  assert.equal(store.countEvents('openclaw'), 1); // 同内容键,入库合并为一行
  assert.equal(store.totalTokensAll('openclaw'), 15);
  store.close();
});

// ---- Hermes --------------------------------------------------------------

const buildHermesDb = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, billing_provider TEXT,
    started_at REAL, message_count INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
    cache_write_tokens INTEGER, reasoning_tokens INTEGER,
    estimated_cost_usd REAL, actual_cost_usd REAL);`);
  const insert = db.prepare(`INSERT INTO sessions (
    id, source, model, billing_provider, started_at, message_count,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, estimated_cost_usd, actual_cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('h1', 'cli', 'gpt-5.5', 'OpenAI', 1774000000, 12, 1000, 100, 300, 50, 40, 0.01, 0.02);
  insert.run('h2', 'cli', 'claude-opus-4.6', null, 1774000005000, 3, 10, 1, 0, 0, 0, null, null); // started_at 已是毫秒
  insert.run('h3', 'cli', '  ', 'xai', 1774000000, 1, 5, 5, 0, 0, 0, null, null); // 空 model 跳过
  insert.run('h4', 'cli', 'gemini-3-pro', 'Google', 1774000006, 0, 0, 0, 0, 0, 0, null, null); // 全零跳过
  db.close();
};

test('hermes sessions 表:秒/毫秒自适应,reasoning 进 extra,provider 归一', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-hermes-'));
  buildHermesDb(dir);
  const { store } = createStore();
  const events = await withEnv({ HERMES_HOME: dir }, () => scanAgent(hermesAdapter, store));
  assert.equal(events.length, 2);
  const h1 = byModel(events, 'gpt-5.5')[0];
  assert.equal(h1.occurredAtMs, 1774000000000); // 秒 → 毫秒
  assert.equal(h1.inputTokens, 1000);
  assert.equal(h1.cacheReadTokens, 300);
  assert.equal(h1.cacheWriteTokens, 50);
  assert.equal(h1.outputTokens, 100);
  assert.equal(h1.reasoningTokens, 40);
  assert.equal(h1.totalTokens, 1490); // classified 1450 + reasoning 40
  assert.equal(h1.sourceVersion, 'openai');
  const h2 = byModel(events, 'claude-opus-4.6')[0];
  assert.equal(h2.occurredAtMs, 1774000005000); // 毫秒原样
  assert.equal(h2.sourceVersion, 'anthropic'); // 从模型名推断
  store.close();
});

// ---- OpenCode -------------------------------------------------------------

const buildOpencodeDb = (dir, { withMessageRows = true } = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, directory TEXT, model TEXT, cost REAL,
    tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER,
    tokens_cache_write INTEGER, tokens_reasoning INTEGER, time_created INTEGER);`);
  db.exec(`CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);`);
  db.prepare("INSERT INTO session (id, directory, model, cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_reasoning, time_created) VALUES ('ses_a', 'D:\\\\proj\\\\a', NULL, 0, 0, 0, 0, 0, 0, 1774000000000)").run();
  db.prepare("INSERT INTO session (id, directory, model, cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_reasoning, time_created) VALUES ('ses_b', 'D:\\\\proj\\\\b', 'deepseek-v4-flash', 0, 500, 50, 200, 20, 10, 1774000100000)").run();
  if (withMessageRows) {
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_1', 'ses_a', 1774000001000, ?)")
      .run(JSON.stringify({ role: 'assistant', modelID: 'doubao-seed-2.0-pro', providerID: 'doubao', tokens: { total: 21897, input: 21706, output: 191, reasoning: 125, cache: { read: 0, write: 0 } }, time: { created: 1774000001000 }, cost: 0 }));
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_2', 'ses_a', 1774000002000, ?)")
      .run(JSON.stringify({ role: 'assistant', providerID: 'doubao', tokens: { input: 50, output: 5 }, time: { created: 1774000002000 } })); // 缺 modelID 跳过
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_3', 'ses_a', 1774000003000, ?)")
      .run(JSON.stringify({ role: 'assistant', modelID: 'solo-total', providerID: 'x', tokens: { total: 123 }, time: { created: 1774000003000 } })); // total 缺口补 output
  }
  db.close();
};

test('opencode message 表:cache 桶独立,total 缺口补 output,缺 model 跳过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-opencode-'));
  buildOpencodeDb(dir);
  const { store } = createStore();
  const events = await withEnv({ OPENCODE_DATA_DIR: dir }, () => scanAgent(opencodeAdapter, store));
  const msg1 = byModel(events, 'doubao-seed-2.0-pro')[0];
  assert.ok(msg1);
  assert.equal(msg1.inputTokens, 21706);
  assert.equal(msg1.outputTokens, 191);
  assert.equal(msg1.totalTokens, 22022); // classified 21897 + extra(reasoning) 125,与 ccusage 口径一致
  assert.equal(msg1.extraTokens, 125); // reasoning 经 total 缺口进 extra
  assert.equal(msg1.reasoningTokens, 125);
  assert.equal(byModel(events, undefined).length, 0); // msg_2 缺 modelID 被跳过
  const msg3 = byModel(events, 'solo-total')[0];
  assert.equal(msg3.outputTokens, 123); // total 123 全部补进 output
  assert.equal(msg3.totalTokens, 123);
  store.close();
});

test('opencode 聚合只兜底无消息行的会话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-opencode-agg-'));
  buildOpencodeDb(dir, { withMessageRows: false });
  const { store } = createStore();
  // 第一轮:ses_a 聚合全零不产出事件,ses_b 兜底聚合产出
  const events = await withEnv({ OPENCODE_DATA_DIR: dir }, () => scanAgent(opencodeAdapter, store, { upsert: true }));
  assert.equal(store.countEvents('opencode'), 1); // 仅 ses_b
  assert.equal(store.totalTokensAll('opencode'), 780); // 500+200+20+50+10
  // 第二轮:ses_a 补上消息行(近期,落在回看窗口)→ 消息事件取代聚合位
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_1', 'ses_a', ?, ?)")
    .run(Date.now(), JSON.stringify({ role: 'assistant', modelID: 'doubao-seed-2.0-pro', providerID: 'doubao', tokens: { input: 100, output: 10 }, time: { created: Date.now() } }));
  db.close();
  const again = await withEnv({ OPENCODE_DATA_DIR: dir }, () => scanAgent(opencodeAdapter, store, { upsert: true }));
  assert.equal(store.countEvents('opencode'), 2); // ses_a 消息 + ses_b 聚合
  const sesb = again.filter((event) => event.model === 'deepseek-v4-flash');
  assert.equal(sesb.length, 1);
  assert.equal(sesb[0].totalTokens, 780);
  store.close();
});

test('opencode 聚合撤回:聚合先行入库,消息行后到时总数不翻倍', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-opencode-ret-'));
  buildOpencodeDb(dir, { withMessageRows: false });
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.prepare("UPDATE session SET model = 'doubao-seed-2.0-pro', tokens_input = 400, tokens_output = 40 WHERE id = 'ses_a'").run();
  db.close();
  const { store } = createStore();
  await withEnv({ OPENCODE_DATA_DIR: dir }, () => scanAgent(opencodeAdapter, store, { upsert: true }));
  assert.equal(store.countEvents('opencode'), 2); // ses_a 聚合 440 + ses_b 聚合 780
  assert.equal(store.totalTokensAll('opencode'), 440 + 780);
  // ses_a 出现消息行,聚合事件应被撤回、由消息事件取代
  const db2 = new DatabaseSync(path.join(dir, 'opencode.db'));
  db2.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_9', 'ses_a', ?, ?)")
    .run(Date.now(), JSON.stringify({ role: 'assistant', modelID: 'doubao-seed-2.0-pro', providerID: 'doubao', tokens: { input: 400, output: 40 }, time: { created: Date.now() } }));
  db2.close();
  await withEnv({ OPENCODE_DATA_DIR: dir }, () => scanAgent(opencodeAdapter, store, { upsert: true }));
  assert.equal(store.countEvents('opencode'), 2); // ses_a 消息 + ses_b 聚合
  assert.equal(store.totalTokensAll('opencode'), 440 + 780); // 总量不变,不双计
  store.close();
});

// ---- Copilot --------------------------------------------------------------

test('copilot chat span:cache_read 从 input 扣除,endTime 数组转毫秒', async () => {
  const { store } = createStore();
  const events = await withEnv({ COPILOT_HOME: path.join(FIXTURES, 'copilot') },
    () => scanAgent(copilotAdapter, store));
  const span = byModel(events, 'claude-sonnet-4')[0];
  assert.ok(span);
  assert.equal(span.occurredAtMs, 1775934264967);
  assert.equal(span.inputTokens, 19452 - 123);
  assert.equal(span.outputTokens, 281);
  assert.equal(span.cacheReadTokens, 123);
  assert.equal(span.cacheWriteTokens, 25);
  assert.equal(span.reasoningTokens, 128);
  assert.equal(span.totalTokens, 19329 + 281 + 123 + 25);
  store.close();
});

test('copilot 同 trace/response 的低优先级记录被抑制,只留 chat span', async () => {
  const { store } = createStore();
  const events = await withEnv({ COPILOT_HOME: path.join(FIXTURES, 'copilot') },
    () => scanAgent(copilotAdapter, store));
  const dupes = byModel(events, 'gpt-5.4-mini');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].inputTokens, 60);
  assert.equal(dupes[0].outputTokens, 10);
  assert.ok(dupes[0].eventKey.includes('chat-1'), '幸存者应是 chat span');
  store.close();
});

test('copilot session-state 首个 shutdown 原样入库,input 扣缓存,-1m 后缀剥掉', async () => {
  const { store } = createStore();
  const events = await withEnv({ COPILOT_HOME: path.join(FIXTURES, 'copilot') },
    () => scanAgent(copilotAdapter, store, { upsert: true }));
  const shutdown = byModel(events, 'claude-sonnet-4').filter((event) => event.occurredAtMs === Date.parse('2026-04-15T09:52:27.352Z'))[0];
  assert.ok(shutdown, 'shutdown 快照应存在');
  assert.equal(shutdown.inputTokens, 70); // 100 - 10 - 20
  assert.equal(shutdown.outputTokens, 50);
  assert.equal(shutdown.cacheReadTokens, 10);
  assert.equal(shutdown.cacheWriteTokens, 20);
  store.close();
});

test('copilot 续会 shutdown 差分成区间,OTel 早于 shutdown 的行被撤回', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-copilot-recon-'));
  fs.mkdirSync(path.join(dir, 'session-state', 's9'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'otel'), { recursive: true });
  // OTel 行:2026-03-17T09:50:00Z,早于两个 shutdown → 应被撤回
  fs.writeFileSync(path.join(dir, 'otel', 'a.jsonl'), JSON.stringify({
    type: 'span', traceId: 't9', spanId: 'sp9', name: 'chat claude-sonnet-4', endTime: [1773741000, 0],
    attributes: {
      'gen_ai.operation.name': 'chat', 'gen_ai.response.model': 'claude-sonnet-4',
      'gen_ai.conversation.id': 's9', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 10,
    },
  }) + '\n');
  const eventsFile = path.join(dir, 'session-state', 's9', 'events.jsonl');
  fs.writeFileSync(eventsFile, JSON.stringify({
    type: 'session.shutdown', id: 'sd-a', timestamp: '2026-03-17T10:00:00.000Z',
    data: { modelMetrics: { 'claude-sonnet-4': { usage: { inputTokens: 100, outputTokens: 10 }, requests: { count: 2 } } } },
  }) + '\n');
  const { store } = createStore();
  await withEnv({ COPILOT_HOME: dir }, () => scanAgent(copilotAdapter, store, { upsert: true }));
  assert.equal(store.countEvents('copilot'), 1); // 只有 shutdown 区间,OTel 行被撤回
  assert.equal(store.totalTokensAll('copilot'), 110);
  // 续会:第二个 shutdown 是累计快照 → 差分出新区间
  fs.appendFileSync(eventsFile, JSON.stringify({
    type: 'session.shutdown', id: 'sd-b', timestamp: '2026-03-18T10:00:00.000Z',
    data: { modelMetrics: { 'claude-sonnet-4': { usage: { inputTokens: 160, outputTokens: 25 }, requests: { count: 3 } } } },
  }) + '\n');
  await withEnv({ COPILOT_HOME: dir }, () => scanAgent(copilotAdapter, store, { upsert: true }));
  assert.equal(store.countEvents('copilot'), 2); // 首快照 + 差分区间
  assert.equal(store.totalTokensAll('copilot'), 110 + 75); // (60+15)
  store.close();
});

test('copilot OTel 晚于 shutdown 的行保留(续会新产生的请求)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-copilot-after-'));
  fs.mkdirSync(path.join(dir, 'session-state', 's8'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'otel'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'session-state', 's8', 'events.jsonl'), JSON.stringify({
    type: 'session.shutdown', id: 'sd-8', timestamp: '2026-03-17T10:00:00.000Z',
    data: { modelMetrics: { 'claude-sonnet-4': { usage: { inputTokens: 100, outputTokens: 10 } } } },
  }) + '\n');
  fs.writeFileSync(path.join(dir, 'otel', 'late.jsonl'), JSON.stringify({
    type: 'span', traceId: 't8', spanId: 'sp8', name: 'chat claude-sonnet-4', endTime: [1774000000 + 86400, 0],
    attributes: {
      'gen_ai.operation.name': 'chat', 'gen_ai.response.model': 'claude-sonnet-4',
      'gen_ai.conversation.id': 's8', 'gen_ai.usage.input_tokens': 30, 'gen_ai.usage.output_tokens': 3,
    },
  }) + '\n');
  const { store } = createStore();
  await withEnv({ COPILOT_HOME: dir }, () => scanAgent(copilotAdapter, store, { upsert: true }));
  assert.equal(store.countEvents('copilot'), 2); // shutdown + 晚到的 OTel 行
  assert.equal(store.totalTokensAll('copilot'), 110 + 33);
  store.close();
});

// ---- 持久化安全 ------------------------------------------------------------

test('新适配器持久化与事件键中不含绝对路径和会话正文', async () => {
  const { store, dir: storeDir } = createStore();
  const all = [];
  const collect = async (adapter, env) => {
    const events = await withEnv(env, () => scanAgent(adapter, store));
    all.push(...events);
  };
  await collect(grokAdapter, { GROK_HOME: path.join(FIXTURES, 'grok') });
  await collect(geminiAdapter, { GEMINI_DATA_DIR: path.join(FIXTURES, 'gemini', 'chats') });
  await collect(openclawAdapter, { OPENCLAW_DIR: path.join(FIXTURES, 'openclaw') });
  await collect(copilotAdapter, { COPILOT_HOME: path.join(FIXTURES, 'copilot') });
  store.upsertEvents(all);
  const dbDump = fs.readFileSync(path.join(storeDir, 'cli-usage.sqlite'), 'utf8');
  assert.ok(!dbDump.includes(os.homedir()), '数据库不应包含用户主目录绝对路径');
  for (const event of all) {
    assert.ok(!event.eventKey.includes('fixtures'), `事件 ${event.eventKey} 不应包含路径`);
    assert.ok(!event.eventKey.includes('\\'), `事件 ${event.eventKey} 不应包含反斜杠`);
  }
  store.close();
});
