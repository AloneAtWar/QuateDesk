// 四个 adapter 的解析与去重:fixture 覆盖流式重复、累计差分、回放、
// 活动/归档副本、scope 过滤、尾部半行游标。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { CliUsageStore } = require('../electron/cli-usage/store.cjs');
const zcodeAdapter = require('../electron/cli-usage/adapters/zcode.cjs');
const kimiAdapter = require('../electron/cli-usage/adapters/kimi.cjs');
const claudeAdapter = require('../electron/cli-usage/adapters/claude.cjs');
const codexAdapter = require('../electron/cli-usage/adapters/codex.cjs');

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

const scanAgent = async (adapter, store, { statuses = new Map(), files = () => {} } = {}) => {
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
    for await (const event of adapter.collect(root, ctx)) events.push(event);
  }
  files();
  return events;
};

const sumBy = (events, field) => events.reduce((total, event) => total + event[field], 0);

// ---- Kimi ----------------------------------------------------------------

test('kimi 新版 usage.record:只统计 turn scope,子 Agent 一并统计', async () => {
  const { store } = createStore();
  const events = await withEnv({ KIMI_CODE_HOME: path.join(FIXTURES, 'kimi-new') },
    () => scanAgent(kimiAdapter, store));
  assert.equal(events.length, 3); // main 2 条 turn + child 1 条;session scope 被忽略
  const total = sumBy(events, 'totalTokens');
  // main: (3064+14848+0+76) + (100+10+5+24) = 18127; child: 11+33+4+22 = 70
  assert.equal(total, 18127 + 70);
  assert.ok(events.every((event) => event.agent === 'kimi'));
  assert.ok(events.every((event) => !event.eventKey.includes('\\')));
  store.close();
});

test('kimi 旧版 StatusUpdate snake_case 兼容', async () => {
  const { store } = createStore();
  const events = await withEnv({ KIMI_CODE_HOME: path.join(FIXTURES, 'kimi-legacy') },
    () => scanAgent(kimiAdapter, store));
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 50);
  assert.equal(events[0].cacheReadTokens, 12);
  assert.equal(events[0].cacheWriteTokens, 3);
  assert.equal(events[0].outputTokens, 25);
  store.close();
});

test('kimi 尾部半行不消费,追加完成后增量补上', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-kimi-grow-'));
  const rootDir = path.join(dir, 'sessions', 'wd_grow', 'session_g1', 'agents', 'main');
  fs.mkdirSync(rootDir, { recursive: true });
  const file = path.join(rootDir, 'wire.jsonl');
  const first = '{"type":"usage.record","model":"kimi-for-coding","usage":{"inputOther":10,"output":5,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1782200000000}\n';
  fs.writeFileSync(file, first + '{"type":"usage.record","model":"kimi-for-coding","usage":{"inputOther":7,"output":3,"inputCacheRead":0,"in'); // 尾部半行
  const { store } = createStore();
  let events = await withEnv({ KIMI_CODE_HOME: dir }, () => scanAgent(kimiAdapter, store));
  assert.equal(events.length, 1); // 半行留到下次
  // 补全半行并追加一条
  fs.appendFileSync(file, 'putCacheCreation":0},"usageScope":"turn","time":1782200001000}\n');
  events = await withEnv({ KIMI_CODE_HOME: dir }, () => scanAgent(kimiAdapter, store));
  assert.equal(events.length, 2);
  assert.equal(sumBy(events, 'inputTokens'), 17);
  // 再扫一次:无变化,全部跳过
  events = await withEnv({ KIMI_CODE_HOME: dir }, () => scanAgent(kimiAdapter, store));
  assert.equal(events.length, 0);
  store.close();
});

// ---- Claude --------------------------------------------------------------

test('claude 流式快照按 message.id 收敛到最终值,回放不重复计数', async () => {
  const { store } = createStore();
  const events = await withEnv({ CLAUDE_CONFIG_DIR: path.join(FIXTURES, 'claude') },
    () => scanAgent(claudeAdapter, store));
  store.upsertEvents(events);
  const byKey = new Map(events.map((event) => [event.eventKey, event]));
  const streamKey = events.find((event) => event.eventKey.includes('msg_stream_1')).eventKey;
  // s1 两份流式快照 + s2 跨会话回放 = 3 条同键事件;入库后按 message.id 合并成一行
  assert.equal(events.filter((event) => event.eventKey === streamKey).length, 3);
  assert.ok(byKey.size >= 4);
  store.close();
});

test('claude 合并后流式快照取最终值:max 字段合并', async () => {
  const { store } = createStore();
  const events = await withEnv({ CLAUDE_CONFIG_DIR: path.join(FIXTURES, 'claude') },
    () => scanAgent(claudeAdapter, store));
  store.upsertEvents(events);
  const day = '2026-09-20';
  const report = store.models({ agent: 'claude', mergeSameModels: false, scope: { kind: 'day', date: day }, timezone: 'UTC' });
  const sonnet = report.models.find((row) => row.displayName.includes('sonnet'));
  assert.ok(sonnet, '应有 sonnet 行');
  // msg_stream_1 最终快照 100/50/5/20(回放不挪动日期,仍记在 09-20)+ ephemeral 10/5/7+3 + 无 id 行 4/2
  assert.equal(sonnet.inputTokens, 100 + 10 + 4);
  assert.equal(sonnet.outputTokens, 20 + 5 + 2);
  assert.equal(sonnet.cacheReadTokens, 50);
  assert.equal(sonnet.cacheWriteTokens, 5 + 10);
  assert.equal(sonnet.requests, 3);
  const haiku = report.models.find((row) => row.displayName.includes('haiku'));
  assert.ok(haiku, 'sidechain 也计入');
  assert.equal(haiku.inputTokens, 7);
  store.close();
});

test('claude 跨 session 回放后总数不变', async () => {
  const { store } = createStore();
  const events = await withEnv({ CLAUDE_CONFIG_DIR: path.join(FIXTURES, 'claude') },
    () => scanAgent(claudeAdapter, store));
  store.upsertEvents(events);
  const once = store.totalTokensAll('claude');
  store.upsertEvents(events); // 重复写入(模拟重扫)
  assert.equal(store.totalTokensAll('claude'), once);
  store.close();
});

// ---- Codex ---------------------------------------------------------------

test('codex last/total 增量、相邻重复跳过、模型切换', async () => {
  const { store } = createStore();
  const events = await withEnv({ CODEX_HOME: path.join(FIXTURES, 'codex') },
    () => scanAgent(codexAdapter, store));
  // rollout-a:2 个事件(重复 info 已跳过);rollout-b 没有 turn_context,模型为 null
  const sol = events.filter((event) => event.model === 'gpt-5.6-sol');
  assert.equal(sol.length, 1);
  assert.equal(sol[0].inputTokens, 30); // 120 - 80 cached - 10 cw
  assert.equal(sol[0].cacheReadTokens, 80);
  assert.equal(sol[0].cacheWriteTokens, 10);
  assert.equal(sol[0].outputTokens, 30);
  assert.equal(sol[0].totalTokens, 160);
  const mini = events.filter((event) => event.model === 'gpt-5-mini');
  assert.equal(mini.length, 1);
  assert.equal(mini[0].totalTokens, 60);
  assert.equal(mini[0].occurredAtMs, Date.parse('2026-09-23T01:00:15.000Z'));
  store.close();
});

test('codex 只有累计值时做差分,累计不前进则跳过', async () => {
  const { store } = createStore();
  const events = await withEnv({ CODEX_HOME: path.join(FIXTURES, 'codex') },
    () => scanAgent(codexAdapter, store));
  // rollout-b 无模型元数据 → 模型为 null,但 Token 必须保留;按其 02:00 时间戳区分
  const threadB = events.filter((event) => event.model === null
    && event.occurredAtMs >= Date.parse('2026-09-23T02:00:00.000Z')
    && event.occurredAtMs < Date.parse('2026-09-23T03:00:00.000Z'));
  assert.equal(threadB.length, 2);
  const [first, second] = [...threadB].sort((left, right) => left.occurredAtMs - right.occurredAtMs);
  assert.equal(first.totalTokens, 150); // 从 0 到 150
  assert.equal(first.inputTokens, 80); // 100 - 20 cached
  assert.equal(second.totalTokens, 80); // 差分 230 - 150
  assert.equal(second.inputTokens, 30);
  assert.equal(second.cacheReadTokens, 20);
  store.close();
});

test('codex 活动与归档同名 rollout 只取活动文件', async () => {
  const { store } = createStore();
  const events = await withEnv({ CODEX_HOME: path.join(FIXTURES, 'codex') },
    () => scanAgent(codexAdapter, store));
  // 归档副本与活动文件内容相同;若被解析会产出相同事件键,数量翻倍
  const rolloutAKeys = events.filter((event) => event.eventKey.includes('rollout-a')).map((event) => event.eventKey);
  assert.equal(new Set(rolloutAKeys).size, rolloutAKeys.length);
  store.close();
});

test('codex subagent 回放父历史不重复计数,只统计随后增长', async () => {
  const { store } = createStore();
  const events = await withEnv({ CODEX_HOME: path.join(FIXTURES, 'codex') },
    () => scanAgent(codexAdapter, store));
  store.upsertEvents(events);
  const total = store.totalTokensAll('codex');
  // rollout-a: 160+60;rollout-b: 150+80;subagent 增长: 10;回放不计
  assert.equal(total, 160 + 60 + 150 + 80 + 10);
  // 回放事件与正本同键:重扫后总数不变
  const again = await withEnv({ CODEX_HOME: path.join(FIXTURES, 'codex') },
    () => scanAgent(codexAdapter, store));
  store.upsertEvents(again);
  assert.equal(store.totalTokensAll('codex'), total);
  store.close();
});

// ---- ZCode ---------------------------------------------------------------

const buildZcodeFixture = (dir, { withTable = true, rows = [] } = {}) => {
  const dbDir = path.join(dir, 'cli', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, 'db.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT, version TEXT);');
  if (withTable) {
    db.exec(`CREATE TABLE IF NOT EXISTS model_usage (
      id TEXT PRIMARY KEY, session_id TEXT, model_id TEXT, provider_id TEXT,
      started_at INTEGER, completed_at INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
      provider_total_tokens INTEGER, computed_total_tokens INTEGER);`);
    db.prepare("INSERT INTO session (id, directory, version) VALUES ('s1', '/private/fixtures/zc', '2.0.5');").run();
    for (const row of rows) {
      db.prepare(`INSERT INTO model_usage (
        id, session_id, model_id, provider_id, started_at, completed_at,
        input_tokens, output_tokens, reasoning_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        provider_total_tokens, computed_total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(row.id, row.session_id, row.model_id, row.provider_id, row.started_at, row.completed_at,
          row.input_tokens, row.output_tokens, row.reasoning_tokens,
          row.cache_creation, row.cache_read, row.provider_total, row.computed_total);
    }
  }
  db.close();
};

test('zcode input 含缓存,扣除后得到新输入;reasoning 只展示', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-zcode-'));
  const now = Date.now();
  buildZcodeFixture(dir, { rows: [{
    id: 'mu-1', session_id: 's1', model_id: 'glm-5.3', provider_id: 'zai',
    started_at: now - 1000, completed_at: now, input_tokens: 200, output_tokens: 40,
    reasoning_tokens: 12, cache_creation: 20, cache_read: 150,
    provider_total: 250, computed_total: 230,
  }] });
  const { store } = createStore();
  const events = await withEnv({ ZCODE_HOME: dir }, () => scanAgent(zcodeAdapter, store));
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 30); // 200 - 150 - 20
  assert.equal(events[0].cacheReadTokens, 150);
  assert.equal(events[0].cacheWriteTokens, 20);
  assert.equal(events[0].outputTokens, 40);
  assert.equal(events[0].reasoningTokens, 12);
  assert.equal(events[0].totalTokens, 250);
  assert.equal(events[0].extraTokens, 10); // 250 - classified 240
  assert.equal(events[0].sourceVersion, '2.0.5');
  store.close();
});

test('zcode pending 请求补齐后,重扫 UPSERT 覆盖旧值', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-zcode-pending-'));
  const now = Date.now();
  const row = {
    id: 'mu-2', session_id: 's1', model_id: 'glm-5.3', provider_id: 'zai',
    started_at: now - 1000, completed_at: now, input_tokens: 0, output_tokens: 0,
    reasoning_tokens: 0, cache_creation: 0, cache_read: 0, provider_total: null, computed_total: 0,
  };
  buildZcodeFixture(dir, { rows: [row] });
  const { store } = createStore();
  let events = await withEnv({ ZCODE_HOME: dir }, () => scanAgent(zcodeAdapter, store));
  store.upsertEvents(events);
  assert.equal(store.countEvents('zcode'), 1);
  // 请求完成后回填
  const dbPath = path.join(dir, 'cli', 'db', 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE model_usage SET input_tokens = 300, output_tokens = 60, cache_read_input_tokens = 250, provider_total_tokens = 380, completed_at = ? WHERE id = 'mu-2'").run(now + 1000);
  db.close();
  events = await withEnv({ ZCODE_HOME: dir }, () => scanAgent(zcodeAdapter, store));
  store.upsertEvents(events);
  const report = store.models({ agent: 'zcode', mergeSameModels: false, scope: { kind: 'range', days: 7 }, timezone: 'UTC' });
  assert.equal(report.models.length, 1);
  assert.equal(report.models[0].totalTokens, 380);
  assert.equal(report.models[0].inputTokens, 50); // 300 - 250
  store.close();
});

test('zcode 缺表标记 incompatible,不影响事件流', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-zcode-broken-'));
  buildZcodeFixture(dir, { withTable: false });
  const { store } = createStore();
  const statuses = new Map();
  const events = await withEnv({ ZCODE_HOME: dir }, () => scanAgent(zcodeAdapter, store, { statuses }));
  assert.equal(events.length, 0);
  const rootStatuses = [...statuses.values()];
  assert.ok(rootStatuses.some((entry) => (typeof entry === 'string' ? entry : entry.status) === 'incompatible'));
  store.close();
});

test('持久化与事件键中不含绝对路径和会话正文', async () => {
  const { store, dir } = createStore();
  const all = [];
  const collect = async (adapter, env) => {
    const events = await withEnv(env, () => scanAgent(adapter, store));
    all.push(...events);
  };
  await collect(kimiAdapter, { KIMI_CODE_HOME: path.join(FIXTURES, 'kimi-new') });
  await collect(claudeAdapter, { CLAUDE_CONFIG_DIR: path.join(FIXTURES, 'claude') });
  await collect(codexAdapter, { CODEX_HOME: path.join(FIXTURES, 'codex') });
  store.upsertEvents(all);
  const home = os.homedir();
  const dbDump = fs.readFileSync(path.join(dir, 'cli-usage.sqlite'), 'utf8');
  assert.ok(!dbDump.includes(home), '数据库不应包含用户主目录绝对路径');
  assert.ok(!dbDump.includes('partial') && !dbDump.includes('final text'), '数据库不应包含消息正文');
  for (const event of all) {
    assert.ok(!JSON.stringify(event).includes('/private/fixtures'), `事件 ${event.eventKey} 不应包含项目路径`);
  }
  store.close();
});
