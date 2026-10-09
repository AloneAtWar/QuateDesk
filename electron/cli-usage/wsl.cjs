// WSL 数据根目录发现:仅 Windows 生效。通过 wsl.exe 枚举发行版,
// 再经 \\wsl$\<distro>(9P 服务,只对运行中的发行版可用)定位各用户 home。
// 全部 IO 失败静默降级为空列表,绝不影响本机目录扫描。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CACHE_TTL_MS = 60_000;

// WSL 内部基础设施发行版,不含用户数据,永远跳过
const EXCLUDED_DISTROS = new Set(['docker-desktop', 'docker-desktop-data', 'rancher-desktop', 'rancher-desktop-data']);

let wslEnabled = true;
let cache = null; // { at, homes }

const setWslEnabled = (flag) => { wslEnabled = flag !== false; };
const isWslEnabled = () => wslEnabled;

// wsl.exe -l -q 在多数系统输出 UTF-16LE,部分新构建输出 UTF-8;按 NUL 字节判断
const parseDistroList = (buffer) => {
  if (!buffer) return [];
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
  const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').replace(/\s*[（(]默认[)）]\s*$/, '').trim())
    .filter(Boolean);
};

const defaultDeps = {
  platform: process.platform,
  execFileSync,
  statSync: fs.statSync,
  readdirSync: fs.readdirSync,
};

const isDirectoryWith = (statSync, target) => {
  try { return statSync(target).isDirectory(); } catch { return false; }
};

// home 候选必须“能列出内容”才算数:\\wsl$\<distro>\root 对普通用户 stat 可见
// 但 readdir 会 EPERM,扫不进去的目录不应成为根目录
const isReadableDirWith = (readdirSync, target) => {
  try { readdirSync(target); return true; } catch { return false; }
};

// 返回 [{ distro, homePath }];deps 注入用于测试,缺省时走模块级缓存
// (同一次扫描内 11 个 adapter 只调一次 wsl.exe)
const listWslHomes = (deps) => {
  if (!wslEnabled) return [];
  const injected = deps !== undefined && deps !== null;
  if (!injected && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.homes;
  const d = injected ? deps : defaultDeps;
  if (d.platform !== 'win32') return [];
  let output;
  try {
    output = d.execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 5000, windowsHide: true });
  } catch { return []; }
  const distros = parseDistroList(output).filter((distro) => !EXCLUDED_DISTROS.has(distro.toLowerCase()));
  const homes = [];
  for (const distro of distros) {
    // \\wsl$ 不可达时回退 \\wsl.localhost;发行版未运行时两者都会失败,跳过
    let base = `\\\\wsl$\\${distro}`;
    if (!isDirectoryWith(d.statSync, base)) {
      base = `\\\\wsl.localhost\\${distro}`;
      if (!isDirectoryWith(d.statSync, base)) continue;
    }
    let users = [];
    try { users = d.readdirSync(path.join(base, 'home'), { withFileTypes: true }); } catch { users = []; }
    for (const entry of users) {
      if (!entry.isDirectory()) continue;
      const homePath = path.join(base, 'home', entry.name);
      if (isReadableDirWith(d.readdirSync, homePath)) homes.push({ distro, user: entry.name, homePath });
    }
    // 默认用户为 root 的发行版
    const rootHome = path.join(base, 'root');
    if (isReadableDirWith(d.readdirSync, rootHome)) homes.push({ distro, user: 'root', homePath: rootHome });
  }
  if (!injected) cache = { at: Date.now(), homes };
  return homes;
};

module.exports = { setWslEnabled, isWslEnabled, parseDistroList, listWslHomes };
