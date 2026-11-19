// 第三批本机用量适配器:Pi / WorkBuddy / MiniMax Code / Cherry Studio。
// fixture 全部在临时目录运行时构造:Pi 为会话 JSONL,其余三个为 SQLite 场景库,
// 与真实 ~/.pi、~/.workbuddy、~/.minimax、%APPDATA%/CherryStudio 的布局一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { CliUsageStore } = require('../electron/cli-usage/store.cjs');
const piAdapter = require('../electron/cli-usage/adapters/pi.cjs');
const workbuddyAdapter = require('../electron/cli-usage/adapters/workbuddy.cjs');
const minimaxAdapter = require('../electron/cli-usage/adapters/minimax.cjs');
const cherrystudioAdapter = require('../electron/cli-usage/adapters/cherrystudio.cjs');
const antigravityAdapter = require('../electron/cli-usage/adapters/antigravity.cjs');

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

// ---------------- Pi ----------------

const piSessionLine = JSON.stringify({ type: 'session', version: 3, id: '019fb37b-1223-73ac-83ff-351791f949bb', timestamp: '2026-07-30T14:43:35.075Z', cwd: 'D:\\proj\\alpha' }) + '\n';
const piModelChange = JSON.stringify({ type: 'model_change', id: 'm1', timestamp: '2026-07-30T14:43:36.336Z', provider: 'xiaomi-token-plan-cn', modelId: 'mimo-v2.5-pro' }) + '\n';
const piUserMessage = JSON.stringify({ type: 'message', id: 'u1', timestamp: '2026-07-30T14:44:34.340Z', message: { role: 'user', content: [] } }) + '\n';
const piAssistant = (id, iso, usage) => JSON.stringify({
  type: 'message', id, timestamp: iso,
  message: {
    role: 'assistant', content: [],
    model: 'mimo-v2.5-pro', provider: 'xiaomi-token-plan-cn',
    usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 1785422674554,
  },
}) + '\n';

const writePiSession = (home, fileName, content) => {
  const dir = path.join(home, 'agent', 'sessions', '--D-proj-alpha--');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
};

test('pi assistant usage 解析:user/无 usage 行跳过,字段一一对应', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-pi-'));
  const assistant = piAssistant('a1', '2026-07-30T14:44:38.349Z', { input: 2833, output: 110, cacheRead: 1024, cacheWrite: 0, reasoning: 87, totalTokens: 3967 });
  writePiSession(home, '2026-07-30T14-43-35-075Z_019fb37b.jsonl', piSessionLine + piModelChange + piUserMessage + assistant);
  const { store } = createStore();
  const events = await withEnv({ PI_HOME: home }, () => scanAgent(piAdapter, store));
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.agent, 'pi');
  assert.equal(event.inputTokens, 2833);
  assert.equal(event.cacheReadTokens, 1024);
  assert.equal(event.outputTokens, 110);
  assert.equal(event.reasoningTokens, 87);
  assert.equal(event.totalTokens, 3967); // 2833 + 1024 + 110,reasoning 不重复计入
  assert.equal(event.model, 'mimo-v2.5-pro');
  assert.equal(event.sourceVersion, 'xiaomi-token-plan-cn');
  assert.equal(event.projectLabel, 'alpha');
  assert.ok(event.eventKey.includes(':a1'));
  assert.ok(!event.eventKey.includes('proj'), '事件键不应含项目路径');
  store.close();
});

test('pi 追加行增量入库,重扫不翻倍', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-pi-grow-'));
  const file = path.join(home, 'agent', 'sessions', '--D-proj-alpha--', '2026-07-30T14-43-35-075Z_019fb37b.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, piSessionLine + piAssistant('a1', '2026-07-30T14:44:38.349Z', { input: 2833, output: 110, cacheRead: 1024, cacheWrite: 0, reasoning: 87, totalTokens: 3967 }));
  const { store } = createStore();
  await withEnv({ PI_HOME: home }, () => scanAgent(piAdapter, store, { upsert: true }));
  assert.equal(store.totalTokensAll('pi'), 3967);
  fs.appendFileSync(file, piAssistant('a2', '2026-07-30T14:45:01.000Z', { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 120 }));
  const second = await withEnv({ PI_HOME: home }, () => scanAgent(piAdapter, store, { upsert: true }));
  assert.equal(second.length, 1); // 只读新增行
  assert.equal(second[0].inputTokens, 100);
  assert.equal(store.totalTokensAll('pi'), 3967 + 120);
  const again = await withEnv({ PI_HOME: home }, () => scanAgent(piAdapter, store, { upsert: true }));
  assert.equal(again.length, 0);
  store.close();
});

test('pi 缺 agent/sessions 标记 missing,detect 支持 PI_HOME 覆盖', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-pi-empty-'));
  const { store } = createStore();
  const statuses = new Map();
  const events = await withEnv({ PI_HOME: home }, () => scanAgent(piAdapter, store, { statuses }));
  assert.equal(events.length, 0);
  assert.ok([...statuses.values()].some((entry) => (entry?.status ?? entry) === 'missing'));
  const roots = await withEnv({ PI_HOME: home }, () => piAdapter.detect());
  assert.equal(roots.length, 1);
  assert.equal(roots[0].rootLabel, '$PI_HOME');
  store.close();
});

// ---------------- WorkBuddy ----------------

const writeWorkbuddyTrace = (home, pid, fileName, trace) => {
  const dir = path.join(home, 'traces', pid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify({ trace, spans: [] }));
};

const writeWorkbuddyDb = (home, rows) => {
  const db = new DatabaseSync(path.join(home, 'workbuddy.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO sessions (id, cwd) VALUES (?, ?)');
  for (const [id, cwd] of rows) insert.run(id, cwd);
  db.close();
};

test('workbuddy trace 聚合解析:cached 从 input 拆出,sessionId 关联项目', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-wb-'));
  writeWorkbuddyDb(home, [['sess-1', 'C:\\Users\\alone\\WorkBuddy\\Claw']]);
  writeWorkbuddyTrace(home, '11012', 'trace_abc.json', {
    traceId: 'trace_abc', sessionId: 'sess-1', agentName: 'cli',
    startedAt: '2026-05-12T04:10:32.450Z', endedAt: '2026-05-12T04:12:55.727Z',
    totalTokens: 1050,
    modelInfo: { models: ['auto-pro'], totalInputTokens: 1000, totalOutputTokens: 50, totalCachedTokens: 700, callCount: 3 },
  });
  // 全零 trace 跳过;多模型 trace 拼接展示
  writeWorkbuddyTrace(home, '11012', 'trace_zero.json', {
    traceId: 'trace_zero', startedAt: '2026-05-12T05:00:00.000Z', totalTokens: 0, modelInfo: null,
  });
  writeWorkbuddyTrace(home, '11196', 'trace_multi.json', {
    traceId: 'trace_multi', sessionId: 'sess-x',
    startedAt: '2026-05-13T05:00:00.000Z', totalTokens: 200,
    modelInfo: { models: ['auto-pro', 'auto'], totalInputTokens: 180, totalOutputTokens: 20, totalCachedTokens: 80, callCount: 2 },
  });
  const { store } = createStore();
  const events = await withEnv({ WORKBUDDY_HOME: home }, () => scanAgent(workbuddyAdapter, store, { upsert: true }));
  assert.equal(events.length, 2);
  const main = events.find((event) => event.eventKey.endsWith('trace_abc'));
  assert.equal(main.inputTokens, 300); // 1000 - 700
  assert.equal(main.cacheReadTokens, 700);
  assert.equal(main.outputTokens, 50);
  assert.equal(main.totalTokens, 1050);
  assert.equal(main.model, 'auto-pro');
  assert.equal(main.projectLabel, 'Claw');
  assert.equal(main.sourceVersion, 'cli');
  const multi = events.find((event) => event.eventKey.endsWith('trace_multi'));
  assert.equal(multi.model, 'auto-pro+auto');
  assert.equal(multi.projectKey, null); // sess-x 不在 sessions 表
  // 重扫:文件未变,游标跳过
  const again = await withEnv({ WORKBUDDY_HOME: home }, () => scanAgent(workbuddyAdapter, store, { upsert: true }));
  assert.equal(again.length, 0);
  assert.equal(store.totalTokensAll('workbuddy'), 1050 + 200);
  store.close();
});

test('workbuddy 缺 workbuddy.db 时照常产出(无项目),缺 traces 标记 missing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-wb-nodb-'));
  writeWorkbuddyTrace(home, '11012', 'trace_nodb.json', {
    traceId: 'trace_nodb', sessionId: 'sess-9',
    startedAt: '2026-05-12T04:10:32.450Z', totalTokens: 90,
    modelInfo: { models: ['glm-5-turbo'], totalInputTokens: 80, totalOutputTokens: 10, totalCachedTokens: 0, callCount: 1 },
  });
  const { store } = createStore();
  const events = await withEnv({ WORKBUDDY_HOME: home }, () => scanAgent(workbuddyAdapter, store));
  assert.equal(events.length, 1);
  assert.equal(events[0].projectKey, null);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-wb-empty-'));
  const statuses = new Map();
  const none = await withEnv({ WORKBUDDY_HOME: empty }, () => scanAgent(workbuddyAdapter, store, { statuses }));
  assert.equal(none.length, 0);
  assert.ok([...statuses.values()].some((entry) => (entry?.status ?? entry) === 'missing'));
  store.close();
});

// ---------------- MiniMax Code ----------------

const writeMinimaxDb = (home, usageRows, sessionRows) => {
  const db = new DatabaseSync(path.join(home, 'sqlite.db'));
  db.exec(`CREATE TABLE token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_name TEXT NOT NULL,
    framework_type TEXT NOT NULL, turn_id TEXT, model TEXT, ts INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL, raw TEXT)`);
  db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, agent_name TEXT, workspace_dir TEXT)');
  const insertUsage = db.prepare('INSERT INTO token_usage (session_id, agent_name, framework_type, turn_id, model, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of usageRows) insertUsage.run(...row);
  const insertSession = db.prepare('INSERT INTO sessions (session_id, agent_name, workspace_dir) VALUES (?, ?, ?)');
  for (const row of sessionRows) insertSession.run(...row);
  db.close();
};

test('minimax token_usage 解析:剥平台前缀,sessions 关联项目,重扫不翻倍', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mm-'));
  writeMinimaxDb(home, [
    ['mvs_e2bba593', 'mavis', 'opencode', 'msg_e889f', 'minimax/MiniMax-M2.7', 1780408603188, 21023, 248, 0, 4576, 0],
    ['mvs_e2bba593', 'coder', 'opencode', 'msg_e889g', 'minimax/MiniMax-M3', 1780408626919, 22288, 360, 0, 107, 0],
    ['mvs_e2bba593', 'coder', 'opencode', 'msg_zero', 'minimax/MiniMax-M3', 1780408630000, 0, 0, 0, 0, 0],
  ], [
    ['mvs_e2bba593', 'mavis', 'D:\\proj\\pocket'],
  ]);
  const { store } = createStore();
  const events = await withEnv({ MINIMAX_HOME: home }, () => scanAgent(minimaxAdapter, store, { upsert: true }));
  assert.equal(events.length, 2); // 全零行跳过
  const first = events.find((event) => event.inputTokens === 21023);
  assert.equal(first.model, 'MiniMax-M2.7'); // minimax/ 前缀剥离
  assert.equal(first.cacheReadTokens, 4576);
  assert.equal(first.outputTokens, 248);
  assert.equal(first.totalTokens, 21023 + 4576 + 248);
  assert.equal(first.projectLabel, 'pocket');
  assert.equal(first.sourceVersion, 'opencode');
  assert.ok(first.eventKey.endsWith(':1')); // 行 id 入键,重扫 UPSERT 收敛
  // 重扫:行龄超过 7 天回看窗,不再产出;库内计数不翻倍
  const again = await withEnv({ MINIMAX_HOME: home }, () => scanAgent(minimaxAdapter, store, { upsert: true }));
  assert.equal(again.length, 0);
  assert.equal(store.countEvents('minimax'), 2);
  store.close();
});

test('minimax 缺 sqlite.db 标记 missing,缺 token_usage 表标记 incompatible', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mm-empty-'));
  const { store } = createStore();
  const statuses = new Map();
  const none = await withEnv({ MINIMAX_HOME: empty }, () => scanAgent(minimaxAdapter, store, { statuses }));
  assert.equal(none.length, 0);
  assert.ok([...statuses.values()].some((entry) => (entry?.status ?? entry) === 'missing'));

  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-mm-bad-'));
  const db = new DatabaseSync(path.join(bad, 'sqlite.db'));
  db.exec('CREATE TABLE other (id INTEGER)');
  db.close();
  const statuses2 = new Map();
  await withEnv({ MINIMAX_HOME: bad }, () => scanAgent(minimaxAdapter, store, { statuses: statuses2 }));
  assert.ok([...statuses2.values()].some((entry) => entry?.status === 'incompatible'));
  store.close();
});

// ---------------- Cherry Studio ----------------

const writeCherryDb = (home, rows) => {
  fs.mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, 'cherrystudio.sqlite'));
  db.exec(`CREATE TABLE ai_usage_record (
    id text PRIMARY KEY NOT NULL, request_id text NOT NULL, record_kind text NOT NULL,
    request_count integer NOT NULL, message_kind text, message_id text,
    provider_id text, provider_name text, model_id text, model_name text,
    source_type text, source_id text, source_name text, source_icon text,
    modality text NOT NULL, api_key_id text, api_key_label text, api_key_masked text,
    api_key_attribution text NOT NULL, auth_method text,
    input_tokens integer, output_tokens integer, total_tokens integer,
    reasoning_tokens integer, no_cache_tokens integer,
    cache_read_tokens integer, cache_write_tokens integer,
    image_count integer, cost real, cost_currency text, cost_source text,
    cost_breakdown text, pricing_snapshot text,
    time_first_token_ms integer, time_completion_ms integer, time_thinking_ms integer,
    created_at integer NOT NULL)`);
  const insert = db.prepare('INSERT INTO ai_usage_record (id, request_id, record_kind, request_count, message_id, provider_id, model_id, model_name, source_id, modality, api_key_attribution, input_tokens, output_tokens, total_tokens, reasoning_tokens, no_cache_tokens, cache_read_tokens, cache_write_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(...row);
  db.close();
};

test('cherrystudio ai_usage_record 解析:invocation 精确,legacy 聚合兜底拆分', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-cherry-'));
  writeCherryDb(home, [
    // invocation:no_cache 明确给出
    ['r1', 'req1', 'invocation', 1, null, 'openai', 'gpt-5.2', 'GPT-5.2', 'assistant-a', 'language', 'unknown', 500, 30, 530, 5, 100, 400, 0, 1785900000000],
    // legacy-aggregate:无 no_cache,从 input 扣缓存
    ['r2', 'req2', 'legacy-aggregate', 3, 'msg-1', 'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', 'assistant-b', 'language', 'unknown', 600, 40, null, 0, null, 100, 0, 1785900300000],
    // 全零行跳过
    ['r3', 'req3', 'invocation', 1, null, 'openai', 'gpt-5.2', 'GPT-5.2', 'assistant-a', 'image', 'unknown', 0, 0, 0, 0, 0, 0, 0, 1785900600000],
  ]);
  const { store } = createStore();
  const events = await withEnv({ CHERRYSTUDIO_DATA_DIR: home }, () => scanAgent(cherrystudioAdapter, store, { upsert: true }));
  assert.equal(events.length, 2);
  const inv = events.find((event) => event.eventKey.includes(':inv:r1'));
  assert.equal(inv.inputTokens, 100);
  assert.equal(inv.cacheReadTokens, 400);
  assert.equal(inv.outputTokens, 30);
  assert.equal(inv.totalTokens, 530);
  assert.equal(inv.exact, true);
  assert.equal(inv.model, 'GPT-5.2');
  assert.equal(inv.sourceVersion, 'openai');
  const agg = events.find((event) => event.eventKey.includes(':agg:r2'));
  assert.equal(agg.inputTokens, 500); // 600 - 100 - 0
  assert.equal(agg.exact, false);
  assert.equal(agg.model, 'Claude Sonnet 5');
  assert.ok(agg.sessionKey !== inv.sessionKey, '不同 source 各自成会话');
  const again = await withEnv({ CHERRYSTUDIO_DATA_DIR: home }, () => scanAgent(cherrystudioAdapter, store, { upsert: true }));
  assert.equal(again.length, 0);
  assert.equal(store.countEvents('cherrystudio'), 2);
  store.close();
});

test('cherrystudio 秒级时间戳容忍入库,缺库/缺表分别标记', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-cherry-sec-'));
  writeCherryDb(home, [
    ['r4', 'req4', 'invocation', 1, null, 'siliconflow', 'qwen3-coder', 'Qwen3 Coder', 'assistant-c', 'language', 'unknown', 10, 5, 15, 0, 10, 0, 0, 1785900000],
  ]);
  const { store } = createStore();
  const events = await withEnv({ CHERRYSTUDIO_DATA_DIR: home }, () => scanAgent(cherrystudioAdapter, store));
  assert.equal(events.length, 1);
  assert.equal(events[0].occurredAtMs, 1785900000000); // 秒 → 毫秒

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-cherry-empty-'));
  const statuses = new Map();
  await withEnv({ CHERRYSTUDIO_DATA_DIR: empty }, () => scanAgent(cherrystudioAdapter, store, { statuses }));
  assert.ok([...statuses.values()].some((entry) => (entry?.status ?? entry) === 'missing'));

  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-cherry-bad-'));
  const db = new DatabaseSync(path.join(bad, 'cherrystudio.sqlite'));
  db.exec('CREATE TABLE message (id text)');
  db.close();
  const statuses2 = new Map();
  await withEnv({ CHERRYSTUDIO_DATA_DIR: bad }, () => scanAgent(cherrystudioAdapter, store, { statuses: statuses2 }));
  assert.ok([...statuses2.values()].some((entry) => entry?.status === 'incompatible'));
  store.close();
});

// ---------------- Antigravity ----------------

const writeAntigravityLogs = (home, uuid, { full, live, chunk }) => {
  const logs = path.join(home, 'brain', uuid, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  if (full !== undefined) fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), full);
  if (live !== undefined) fs.writeFileSync(path.join(logs, 'transcript.jsonl'), live);
  if (chunk !== undefined) {
    fs.mkdirSync(path.join(logs, 'chunks', 'transcript'), { recursive: true });
    fs.writeFileSync(path.join(logs, 'chunks', 'transcript', '00000000.jsonl'), chunk);
  }
};

const agLine = (row) => JSON.stringify(row) + '\n';

test('antigravity 转录解析:优先 full、model 向前继承、chunks 不双计', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-agy-'));
  const lines = [
    agLine({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-11T09:16:30Z', content: 'hi' }),
    agLine({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-11T09:16:32Z', input_tokens: 12418, cache_read_tokens: 0, output_tokens: 281, content: 'ok' }),
    agLine({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-11T09:16:40Z', model: 'gemini-4-neon-xhigh' }),
    agLine({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-11T09:16:42Z', input_tokens: 4607, cache_read_tokens: 14379, output_tokens: 312, content: 'ok2' }),
    agLine({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-11T09:16:44Z', input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, content: 'zero' }),
  ].join('');
  // full 与 live 同内容;chunks 放一份带 token 的副本诱导双计
  writeAntigravityLogs(home, '37e41468-c940-4556-9a0c-2b1e9549a5ea', { full: lines, live: lines, chunk: lines });
  // 只有 live 的会话走退回路径
  const liveOnly = [
    agLine({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-12T08:00:00Z', content: 'q' }),
    agLine({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-12T08:00:02Z', model: 'gemini-4-argon-high', input_tokens: 100, cache_read_tokens: 50, output_tokens: 20, content: 'a' }),
  ].join('');
  writeAntigravityLogs(home, '477e5732-74de-45a5-a610-4996e7496e64', { live: liveOnly });
  const { store } = createStore();
  const events = await withEnv({ ANTIGRAVITY_HOME: home }, () => scanAgent(antigravityAdapter, store, { upsert: true }));
  assert.equal(events.length, 3); // 全零行跳过、chunks/live 副本不读
  const first = events.find((event) => event.inputTokens === 12418);
  assert.equal(first.model, null); // model 行在其后,首条无继承
  assert.equal(first.totalTokens, 12418 + 0 + 281);
  assert.ok(first.eventKey.includes(':1|')); // step_index 入键
  assert.ok(first.eventKey.includes('37e41468'), '会话 uuid 入键,跨会话去重');
  const inherited = events.find((event) => event.inputTokens === 4607);
  assert.equal(inherited.model, 'gemini-4-neon-xhigh'); // 前面 GENERIC 行的 model 被继承
  assert.equal(inherited.cacheReadTokens, 14379);
  const liveEvent = events.find((event) => event.inputTokens === 100);
  assert.equal(liveEvent.model, 'gemini-4-argon-high');
  // 重扫:文件未变不重读;计数不因 chunks 存在而翻倍
  const again = await withEnv({ ANTIGRAVITY_HOME: home }, () => scanAgent(antigravityAdapter, store, { upsert: true }));
  assert.equal(again.length, 0);
  assert.equal(store.totalTokensAll('antigravity'), 12699 + 19298 + 170);
  store.close();
});

test('antigravity 缺 brain 标记 missing,空会话目录跳过', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-agy-empty-'));
  const { store } = createStore();
  const statuses = new Map();
  const events = await withEnv({ ANTIGRAVITY_HOME: home }, () => scanAgent(antigravityAdapter, store, { statuses }));
  assert.equal(events.length, 0);
  assert.ok([...statuses.values()].some((entry) => (entry?.status ?? entry) === 'missing'));
  const roots = await withEnv({ ANTIGRAVITY_HOME: home }, () => antigravityAdapter.detect());
  assert.equal(roots.length, 1);
  assert.equal(roots[0].rootLabel, '$ANTIGRAVITY_HOME');
  store.close();
});

test('antigravity 旧版无 model 行:从设置变更显示名推导并随切换更新', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-agy-model-'));
  const userChange = (step, iso, label) => agLine({
    step_index: step, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso,
    content: `<USER_REQUEST>q</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to ${label}. No need to comment.\n</USER_SETTINGS_CHANGE>`,
  });
  const planner = (step, iso, tokens) => agLine({
    step_index: step, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso, ...tokens, content: 'ok',
  });
  const lines = [
    userChange(0, '2026-11-18T08:00:00Z', 'Gemini 4 Argon (High)'),
    planner(1, '2026-11-18T08:00:05Z', { input_tokens: 1000, cache_read_tokens: 0, output_tokens: 50 }),
    // 会话中途切到 Hydrogen (XHigh),后续行继承新模型
    userChange(2, '2026-11-18T08:05:00Z', 'Gemini 4 Hydrogen (XHigh)'),
    planner(3, '2026-11-18T08:05:06Z', { input_tokens: 200, cache_read_tokens: 3000, output_tokens: 60 }),
    // 非 Gemini 模型同样映射
    userChange(4, '2026-11-18T08:10:00Z', 'Claude Opus 5'),
    planner(5, '2026-11-18T08:10:05Z', { input_tokens: 10, cache_read_tokens: 0, output_tokens: 5 }),
  ].join('');
  writeAntigravityLogs(home, 'a1b2c3d4-0000-0000-0000-000000000001', { full: lines });
  const { store } = createStore();
  const events = await withEnv({ ANTIGRAVITY_HOME: home }, () => scanAgent(antigravityAdapter, store));
  assert.equal(events.length, 3);
  assert.equal(events[0].model, 'gemini-4-argon-high'); // 显示名 → id,与新版真机双写样本同构
  assert.equal(events[1].model, 'gemini-4-hydrogen-xhigh');
  assert.equal(events[2].model, 'claude-opus-5');
  store.close();
});
