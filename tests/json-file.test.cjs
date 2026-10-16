const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonSafe, writeJsonDurable, listDailySnapshots, DAILY_SNAPSHOT_LIMIT } = require('../electron/json-file.cjs');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'json-file-test-'));

test('writeJsonDurable 写入可解析的 JSON，覆盖写时把上一版本备份为 .bak', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  writeJsonDurable(file, { v: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 });
  assert.equal(fs.existsSync(`${file}.bak`), false);
  writeJsonDurable(file, { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { v: 1 });
});

test('writeJsonDurable 覆盖已损坏文件时不拿坏内容更新 .bak', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  const t0 = Date.now();
  writeJsonDurable(file, { v: 1 }, t0);
  writeJsonDurable(file, { v: 2 }, t0 + 2 * 60 * 60 * 1000); // 生成 .bak(v1)
  // 模拟异常断电留下的全零文件
  fs.writeFileSync(file, '\0'.repeat(64));
  writeJsonDurable(file, { v: 3 }, t0 + 4 * 60 * 60 * 1000);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { v: 1 });
});

test('readJsonSafe 在主文件损坏时隔离现场并从 .bak 恢复', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  writeJsonDurable(file, { v: 1 });
  writeJsonDurable(file, { v: 2 });
  fs.writeFileSync(file, '\0'.repeat(128));
  const result = readJsonSafe(file, null);
  assert.deepEqual(result.value, { v: 1 });
  assert.equal(result.recoveredFrom, `${file}.bak`);
  assert.ok(result.quarantined);
  // 现场被保留，内容仍是坏数据
  assert.equal(fs.readFileSync(result.quarantined, 'utf8'), '\0'.repeat(128));
  // 主文件已被挪走，下次写入从干净状态开始
  assert.equal(fs.existsSync(file), false);
});

test('readJsonSafe 在没有任何备份时返回 fallback', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, 'not-json{{{');
  const result = readJsonSafe(file, { default: true });
  assert.deepEqual(result.value, { default: true });
  assert.equal(result.recoveredFrom, null);
  assert.ok(result.quarantined);
});

test('readJsonSafe 对不存在的文件直接返回 fallback，不当作损坏', () => {
  const result = readJsonSafe(path.join(tempDir(), 'missing.json'), {});
  assert.deepEqual(result.value, {});
  assert.equal(result.quarantined, null);
  assert.equal(result.recoveredFrom, null);
});

test('每日快照按天生成且最多保留限定份数', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  const t0 = Date.now();
  writeJsonDurable(file, { v: 1 }, t0);
  writeJsonDurable(file, { v: 2 }, t0 + 2 * 60 * 60 * 1000);
  const backupsDir = path.join(dir, 'backups');
  const today = new Date(t0 + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backupsDir, `state.json.${today}.json`), 'utf8')), { v: 1 });
  // 塞入超出上限的旧快照后再次触发备份，应裁剪到上限
  for (let i = 1; i <= DAILY_SNAPSHOT_LIMIT + 3; i += 1) {
    fs.writeFileSync(path.join(backupsDir, `state.json.2020-01-${String(i).padStart(2, '0')}.json`), '{}');
  }
  writeJsonDurable(file, { v: 3 }, t0 + 4 * 60 * 60 * 1000);
  assert.ok(listDailySnapshots(file).length <= DAILY_SNAPSHOT_LIMIT);
  // 最旧的被裁掉，今天的保留
  assert.equal(fs.existsSync(path.join(backupsDir, 'state.json.2020-01-01.json')), false);
  assert.equal(fs.existsSync(path.join(backupsDir, `state.json.${today}.json`)), true);
});

test('readJsonSafe 在 .bak 也损坏时回滚到每日快照', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  writeJsonDurable(file, { v: 1 });
  writeJsonDurable(file, { v: 2 }); // 生成 .bak(v1) 与今日快照(v1)
  fs.writeFileSync(`${file}.bak`, 'garbage');
  fs.writeFileSync(file, '\0'.repeat(32));
  const result = readJsonSafe(file, null);
  assert.deepEqual(result.value, { v: 1 });
  assert.ok(result.recoveredFrom.includes('backups'));
});
