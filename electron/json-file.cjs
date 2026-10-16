// 带断电保护的 JSON 文件读写（纯逻辑，不依赖 electron，方便单元测试）。
// 背景：2026-10 一次异常断电后，temp+rename 写法留下了"大小正常、内容全零"的文件——
// NTFS 只保证元数据入库，不 fsync 数据块就还在内存缓存里。本模块的三层防御：
// 1. 写：临时文件 fsync 落盘后再 rename，断电最多丢最后一次写入，不会留下全零文件；
// 2. 备：覆盖前把当前完好版本滚动备份为 .bak，另按天保留若干份快照，防止备份也被冲掉；
// 3. 读：主文件解析失败时先隔离现场（改名 .corrupt-*，绝不覆盖），再按 .bak → 每日快照回滚。
const fs = require('node:fs');
const path = require('node:path');

// 同一文件滚动备份的最小间隔：history.json 这类大文件每次轮询都重写，
// 备份的价值在于"崩溃前最后一个好版本"，一小时一份足够，太密只会浪费磁盘 IO
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000;
const DAILY_SNAPSHOT_LIMIT = 7;
const lastBackupAt = new Map();

const parseable = (raw) => {
  try { JSON.parse(raw); return true; }
  catch { return false; }
};

const listDailySnapshots = (filePath) => {
  const dir = path.join(path.dirname(filePath), 'backups');
  const prefix = `${path.basename(filePath)}.`;
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch { return []; }
};

// 覆盖写入前备份当前完好版本；已损坏或不存在则不备份（不拿坏文件覆盖好备份）
const backupCurrent = (filePath, now = Date.now()) => {
  if (now - (lastBackupAt.get(filePath) || 0) < BACKUP_MIN_INTERVAL_MS) return;
  let raw;
  try {
    if (!fs.statSync(filePath).size) return;
    raw = fs.readFileSync(filePath, 'utf8');
  } catch { return; }
  if (!parseable(raw)) return;
  try { fs.copyFileSync(filePath, `${filePath}.bak`); } catch { return; }
  lastBackupAt.set(filePath, now);
  try {
    const dir = path.join(path.dirname(filePath), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const snapshot = path.join(dir, `${path.basename(filePath)}.${new Date(now).toISOString().slice(0, 10)}.json`);
    if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot, raw, 'utf8');
    const snapshots = listDailySnapshots(filePath);
    for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - DAILY_SNAPSHOT_LIMIT))) {
      try { fs.unlinkSync(stale); } catch {}
    }
  } catch {}
};

const writeJsonDurable = (filePath, value, now = Date.now()) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const fd = fs.openSync(tempPath, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  backupCurrent(filePath, now);
  fs.renameSync(tempPath, filePath);
};

// 读取并解析 JSON 文件。返回 { value, quarantined, recoveredFrom }：
// 文件不存在属于正常情况（首次运行），只有"存在但解析失败"才视为损坏
const readJsonSafe = (filePath, fallback) => {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { value: fallback, quarantined: null, recoveredFrom: null }; }
  try { return { value: JSON.parse(raw), quarantined: null, recoveredFrom: null }; }
  catch {}
  let quarantined = null;
  if (raw.trim()) {
    quarantined = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.renameSync(filePath, quarantined); } catch { quarantined = null; }
  }
  for (const candidate of [`${filePath}.bak`, ...listDailySnapshots(filePath).reverse()]) {
    try {
      return { value: JSON.parse(fs.readFileSync(candidate, 'utf8')), quarantined, recoveredFrom: candidate };
    } catch {}
  }
  return { value: fallback, quarantined, recoveredFrom: null };
};

module.exports = {
  readJsonSafe,
  writeJsonDurable,
  listDailySnapshots,
  BACKUP_MIN_INTERVAL_MS,
  DAILY_SNAPSHOT_LIMIT,
};
