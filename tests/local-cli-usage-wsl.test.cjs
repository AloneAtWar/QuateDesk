// WSL 根目录发现:发行版列表解析(UTF-16LE/UTF-8)、home 枚举、
// 不可达发行版跳过、开关语义,以及 paths.detect 的集成行为。
// 后半部分覆盖"关闭开关即清除":scan_roots 登记、purgeWslRoots、老库 root_id 迁移。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const wsl = require('../electron/cli-usage/wsl.cjs');
const paths = require('../electron/cli-usage/paths.cjs');
const { CliUsageStore } = require('../electron/cli-usage/store.cjs');

const utf16le = (text) => Buffer.from(text, 'utf16le');

const dirEntry = (name) => ({ name, isDirectory: () => true });

// 构造注入依赖:distros 发行版列表,homes 为 /home 下用户,root 控制 /root 是否存在,
// unreachable 中的发行版 statSync 一律抛错(模拟未运行),unreadable 中的 home readdir 抛错(模拟 EPERM)
const fakeDeps = ({ distros = ['Ubuntu'], homes = ['alice'], root = true, unreachable = [], unreadable = [], wslError = false } = {}) => ({
  platform: 'win32',
  execFileSync: () => {
    if (wslError) throw new Error('wsl.exe not found');
    return utf16le(distros.join('\r\n'));
  },
  statSync: (target) => {
    const normalized = String(target).replace(/\//g, '\\');
    for (const distro of unreachable) {
      if (normalized.toLowerCase().includes(`\\${distro.toLowerCase()}`)) throw new Error('unreachable');
    }
    return { isDirectory: () => true };
  },
  readdirSync: (target) => {
    const normalized = String(target).replace(/\//g, '\\');
    if (!root && /\\root$/.test(normalized)) throw new Error('EPERM');
    for (const user of unreadable) {
      if (normalized.endsWith(`\\home\\${user}`)) throw new Error('EPERM');
    }
    if (/\\home$/.test(normalized)) return homes.map(dirEntry);
    return [];
  },
});

test('parseDistroList: UTF-16LE 输出按行解析并去空白', () => {
  assert.deepEqual(wsl.parseDistroList(utf16le('Ubuntu\r\ndocker-desktop\r\n')), ['Ubuntu', 'docker-desktop']);
});

test('parseDistroList: UTF-8 输出与空行/默认标记', () => {
  assert.deepEqual(wsl.parseDistroList(Buffer.from('Ubuntu (默认)\n\nDebian\n', 'utf8')), ['Ubuntu', 'Debian']);
  assert.deepEqual(wsl.parseDistroList(null), []);
});

test('listWslHomes: 枚举 /home 用户并附带 /root', () => {
  const homes = wsl.listWslHomes(fakeDeps());
  assert.deepEqual(homes, [
    { distro: 'Ubuntu', user: 'alice', homePath: path.join('\\\\wsl$\\Ubuntu', 'home', 'alice') },
    { distro: 'Ubuntu', user: 'root', homePath: path.join('\\\\wsl$\\Ubuntu', 'root') },
  ]);
});

test('listWslHomes: 基础设施发行版(docker-desktop 等)被排除', () => {
  const homes = wsl.listWslHomes(fakeDeps({ distros: ['Ubuntu', 'docker-desktop', 'rancher-desktop'] }));
  assert.deepEqual([...new Set(homes.map((h) => h.distro))], ['Ubuntu']);
});

test('listWslHomes: 读不进内容的 home(EPERM)被跳过', () => {
  const homes = wsl.listWslHomes(fakeDeps({ homes: ['alice', 'bob'], unreadable: ['bob'], root: false }));
  assert.deepEqual(homes.map((h) => h.user), ['alice']);
});

test('listWslHomes: \\wsl$ 不可达时回退 \\wsl.localhost', () => {
  const deps = fakeDeps();
  const baseStat = deps.statSync;
  let fellBack = false;
  deps.statSync = (target) => {
    if (String(target).startsWith('\\\\wsl$\\')) { fellBack = true; throw new Error('no 9p'); }
    return baseStat(target);
  };
  const homes = wsl.listWslHomes(deps);
  assert.equal(fellBack, true);
  assert.ok(homes[0].homePath.startsWith('\\\\wsl.localhost\\Ubuntu'));
});

test('listWslHomes: 未运行的发行版整体跳过,wsl.exe 失败返回空', () => {
  assert.deepEqual(wsl.listWslHomes(fakeDeps({ distros: ['Ubuntu', 'Debian'], unreachable: ['Debian'] })).map((h) => h.distro), ['Ubuntu', 'Ubuntu']);
  assert.deepEqual(wsl.listWslHomes(fakeDeps({ wslError: true })), []);
});

test('listWslHomes: 非 Windows 平台与开关关闭时返回空', () => {
  assert.deepEqual(wsl.listWslHomes({ ...fakeDeps(), platform: 'linux' }), []);
  wsl.setWslEnabled(false);
  try { assert.deepEqual(wsl.listWslHomes(fakeDeps()), []); }
  finally { wsl.setWslEnabled(true); }
});

// paths 集成:patch wsl.listWslHomes(paths 调用时按属性查找,补丁可生效)
const withWslHomes = async (homes, run) => {
  const original = wsl.listWslHomes;
  wsl.listWslHomes = () => homes;
  try { return await run(); }
  finally { wsl.listWslHomes = original; }
};

test('paths: 默认分支追加 WSL 根目录,标签带发行版与用户名', async () => {
  await withWslHomes([{ distro: 'Ubuntu', user: 'alice', homePath: '\\\\wsl$\\Ubuntu\\home\\alice' }], () => {
    const labels = paths.detectClaudeRoots().map((root) => root.rootLabel);
    assert.ok(labels.includes('WSL:Ubuntu/alice ~/.claude'));
    assert.ok(labels.includes('WSL:Ubuntu/alice ~/.config/claude'));
  });
});

test('paths: env 覆盖分支不追加 WSL 根目录', async () => {
  const backup = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = 'D:\\somewhere\\claude';
  try {
    await withWslHomes([{ distro: 'Ubuntu', user: 'alice', homePath: '\\\\wsl$\\Ubuntu\\home\\alice' }], () => {
      const roots = paths.detectClaudeRoots();
      assert.deepEqual(roots.map((root) => root.rootLabel), ['$CLAUDE_CONFIG_DIR']);
    });
  } finally {
    if (backup === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = backup;
  }
});

test('paths: 开关关闭后不再追加 WSL 根目录', async () => {
  wsl.setWslEnabled(false);
  try {
    await withWslHomes([{ distro: 'Ubuntu', user: 'alice', homePath: '\\\\wsl$\\Ubuntu\\home\\alice' }], () => {
      assert.ok(!paths.detectCodexRoots().some((root) => root.rootLabel.startsWith('WSL:')));
    });
  } finally {
    wsl.setWslEnabled(true);
  }
});

// ---- 关闭开关即清除 WSL 历史 ----------------------------------------------

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-wsl-store-'));
  return { store: new CliUsageStore(path.join(dir, 'cli-usage.sqlite')), dir };
};

const fakeEvent = (eventKey, rootId) => ({
  eventKey, agent: 'claude', rootId, occurredAtMs: Date.now(), sessionKey: 's1',
  projectKey: null, model: 'm', canonicalModelKey: 'm',
  inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1,
  reasoningTokens: 0, extraTokens: 0, totalTokens: 2, requestCount: 1,
  sourceVersion: null, exact: true, isSidechain: false,
});

test('purgeWslRoots: 只删除 WSL 根目录的事件与游标,可重复执行', () => {
  const { store } = createStore();
  try {
    store.registerRoots('claude', [
      { rootId: 'rwsl', rootLabel: 'WSL:Ubuntu/alice ~/.claude', isWsl: true },
      { rootId: 'rlocal', rootLabel: '~/.claude' },
    ]);
    store.upsertEvents([fakeEvent('e-wsl', 'rwsl'), fakeEvent('e-local', 'rlocal')]);
    store.saveFileState('claude', 'rwsl', 'a.jsonl', { size: 1 });
    store.saveFileState('claude', 'rlocal', 'b.jsonl', { size: 1 });

    assert.equal(store.purgeWslRoots(), 1);
    assert.equal(store.countEvents('claude'), 1);
    assert.equal(store.getFileState('claude', 'rwsl', 'a.jsonl'), null);
    assert.ok(store.getFileState('claude', 'rlocal', 'b.jsonl'));
    // 幂等:再执行无副作用
    assert.equal(store.purgeWslRoots(), 0);
    assert.equal(store.countEvents('claude'), 1);
  } finally {
    store.close();
  }
});

test('老库迁移:无 root_id 的 usage_events 自动补列,旧数据保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-wsl-migrate-'));
  const dbPath = path.join(dir, 'cli-usage.sqlite');
  // 复刻 schema v1 的 usage_events(无 root_id)并写入一条旧事件
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE usage_events (
  event_key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  project_key TEXT,
  model TEXT,
  canonical_model_key TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  extra_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 1,
  source_version TEXT,
  exact INTEGER NOT NULL DEFAULT 1,
  is_sidechain INTEGER NOT NULL DEFAULT 0
)`);
  raw.prepare("INSERT INTO usage_events (event_key, agent, occurred_at_ms, session_key, input_tokens) VALUES ('old-1', 'claude', 1, 's0', 5)").run();
  raw.close();

  const store = new CliUsageStore(dbPath);
  try {
    const columns = store.db.prepare('PRAGMA table_info(usage_events)').all().map((col) => col.name);
    assert.ok(columns.includes('root_id'));
    assert.equal(store.countEvents('claude'), 1);
    store.upsertEvents([fakeEvent('e-new', 'rwsl')]);
    assert.equal(store.countEvents('claude'), 2);
  } finally {
    store.close();
  }
});
