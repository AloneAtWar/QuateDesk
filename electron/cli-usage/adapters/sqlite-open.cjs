// SQLite 打开助手:UNC 路径(\\wsl$\...)走 9P 协议不支持文件锁,
// 直接打开报 "database is locked";UNC 路径一律把主库与 WAL/SHM 副文件
// 复制到本地临时目录,以可写方式打开副本(允许 WAL 恢复),cleanup 负责清理。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const isUncPath = (target) => path.resolve(target).startsWith('\\\\');

// 返回 { db, cleanup };cleanup 在 db.close() 之后调用,删除临时副本(非 UNC 时为 null)
const openSqlite = (dbPath) => {
  if (!isUncPath(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 2000'); } catch { /* 只读连接忽略 */ }
    return { db, cleanup: null };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-unc-sqlite-'));
  try {
    const copyPath = path.join(dir, path.basename(dbPath));
    fs.copyFileSync(dbPath, copyPath);
    for (const suffix of ['-wal', '-shm']) {
      try { fs.copyFileSync(dbPath + suffix, copyPath + suffix); } catch { /* 无副文件 */ }
    }
    const db = new DatabaseSync(copyPath);
    try { db.exec('PRAGMA busy_timeout = 2000'); } catch { /* 忽略 */ }
    return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
};

module.exports = { openSqlite, isUncPath };
