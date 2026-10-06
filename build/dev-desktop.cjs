#!/usr/bin/env node
// dev:desktop 编排脚本：起 Vite 开发服务器 → 从日志解析出本机地址 → 以 QD_DEV_URL
// 启动 Electron。渲染代码改动走 Vite HMR；electron/** 下的主进程代码改动由本脚本
// 监听并整体重启。关闭应用窗口或 Ctrl+C 即退出，Vite 一并收掉。
// 额外参数透传给应用（如 npm run dev:desktop -- --onboard）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
// electron 包在 Node 上下文里 require 的返回值就是可执行文件路径
const electronBin = require('electron');
const electronDir = path.join(root, 'electron');

let devUrl = '';
let electronChild = null;
let electronStarted = false;
let restarting = false;
let shuttingDown = false;

const vite = spawn(process.execPath, [viteBin], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

// 从 vite 输出里解析「Local:   http://localhost:5173/」；端口被占用时 vite 会自动
// 换端口（5174…），所以不能写死，必须以它自己打印的为准
const ansiPattern = /\x1b\[[0-9;]*[A-Za-z]/g;
const collectViteOutput = (stream) => (chunk) => {
  process.stdout.write(chunk);
  if (devUrl) return;
  const match = chunk.toString().replace(ansiPattern, '').match(/Local:\s+(https?:\/\/\S+)/);
  if (!match) return;
  devUrl = match[1];
  startElectron();
};
vite.stdout.on('data', collectViteOutput());
vite.stderr.on('data', collectViteOutput());
vite.on('exit', () => {
  if (!shuttingDown) {
    console.error('[dev] Vite 意外退出，结束本次开发会话');
    shutdown(1);
  }
});

function startElectron() {
  if (electronStarted) return;
  electronStarted = true;
  console.log(`\n[dev] 启动 Electron：渲染页 ${devUrl}\n`);
  spawnElectron();
}

function spawnElectron() {
  const startedAt = Date.now();
  electronChild = spawn(electronBin, ['.', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, QD_DEV_URL: devUrl },
  });
  electronChild.on('exit', (code) => {
    electronChild = null;
    if (restarting && !shuttingDown) {
      restarting = false;
      spawnElectron();
    } else {
      // 秒退多半是被单实例锁挡住（如 --qd-share-data 共享数据目录时正式版正在运行），
      // 详见 %APPDATA%\Quota Desk\startup-debug.log；开发实例默认用独立数据目录，不受影响
      if (Date.now() - startedAt < 5000 && !shuttingDown) {
        console.error('\n[dev] Electron 启动后几秒内就退出了。若加了 --qd-share-data 且正式版 Quota Desk 正在运行，请先退出它再试。');
      }
      shutdown(code ?? 0);
    }
  });
}

// 主进程没有热替换：electron/ 下代码一变就重启应用（窗口会闪一下，属正常）
let restartTimer = null;
fs.watch(electronDir, { recursive: true }, (_event, filename) => {
  if (!/\.c?js$/.test(String(filename || ''))) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!electronChild) return;
    console.log(`\n[dev] electron/${filename} 有改动，重启主进程…\n`);
    restarting = true;
    electronChild.kill();
  }, 300);
});

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  restarting = false;
  clearTimeout(restartTimer);
  try { vite.kill(); } catch { /* 已退出 */ }
  if (electronChild) { try { electronChild.kill(); } catch { /* 已退出 */ } }
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Vite 迟迟没打印本地地址（异常 / 卡死）时兜底退出，避免脚本挂着没反馈
setTimeout(() => {
  if (!electronStarted && !shuttingDown) {
    console.error('[dev] 20 秒内没能从 Vite 日志解析出开发服务器地址，退出');
    shutdown(1);
  }
}, 20000).unref();
