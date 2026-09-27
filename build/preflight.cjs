// 打包前置检查：electron-builder 会整体重建 release/win-unpacked 并覆盖同名版本的
// 便携版 / 安装包。如果这些文件正被占用（最常见：上一版便携版或 win-unpacked 里的
// 程序还在运行），清理 / 覆盖阶段会一直重试等待，表现为打包卡死。
// 这里在打包前主动探测：以写方式打不开（Windows 对运行中的 exe / 已加载的 dll
// 拒绝写共享）即视为被占用，立即报错退出，让用户先关掉程序再打包。
const fs = require('fs');
const path = require('path');

const packageJson = require('../package.json');
const outputDir = path.resolve(__dirname, '..', packageJson.build?.directories?.output || 'release');
const version = packageJson.version;

// 这些错误码说明文件被进程占用（或无写权限），而不是「不存在」之类的正常情况
const LOCKED_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY']);

const walkFiles = (dir) => {
  const files = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
};

const isLocked = (file) => {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
    return false;
  } catch (error) {
    return LOCKED_ERROR_CODES.has(error.code);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 关闭失败不影响判定 */ } }
  }
};

// 只检查真正会被本次打包覆盖的文件：
// 1. win-unpacked 整个目录（无论什么版本都会被重建，任何被锁文件都会卡住打包）；
// 2. release 根目录下文件名带当前版本号的 exe（旧版本的产物不会被覆盖，运行中也不影响打包，避免误报）。
const rootExes = (() => {
  try { return fs.readdirSync(outputDir, { withFileTypes: true }); }
  catch { return []; }
})().filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name) && entry.name.includes(version))
  .map((entry) => path.join(outputDir, entry.name));

const targets = [
  ...walkFiles(path.join(outputDir, 'win-unpacked')).filter((file) => /\.(exe|dll|node)$/i.test(file)),
  ...rootExes,
];

const locked = targets.filter(isLocked);
if (locked.length) {
  console.error('打包中止：以下文件正被占用，请先退出正在运行的 Quota Desk / 安装程序，再重新打包：');
  for (const file of locked) console.error(`  - ${path.relative(process.cwd(), file)}`);
  process.exit(1);
}
console.log(`打包预检通过：${outputDir} 下没有被占用的输出文件`);
