// dist:test 专用 electron-builder 配置：在 package.json 的 build 配置基础上改成
//「便携版测试构建」——独立 appId / 产品名（可与正式版并排安装、互不抢任务栏与数据）、
// 只打 portable 单 exe、绝不发布。qdBuildFlavor 标记会被打进应用内的 package.json，
// 主进程据此启用测试版行为（独立数据目录、禁用应用内更新）。
const base = require('../package.json').build;
const path = require('node:path');

const config = {
  ...base,
  appId: 'com.quotadesk.app.test',
  productName: 'Quota Desk Test',
  artifactName: 'Quota-Desk-Test-${version}-${os}-${arch}.${ext}',
  // 输出到子目录而不是 release-test 根：根下早期手工实验留下的 win-unpacked 一旦被
  // 编辑器等程序占用句柄，electron-builder 重建同名目录就会 EBUSY 卡死；子目录每次全新
  directories: { ...base.directories, output: path.join('release-test', 'build') },
  win: { ...base.win, target: ['portable'] },
  extraMetadata: { ...(base.extraMetadata || {}), qdBuildFlavor: 'test' },
};
// 测试构建没有发布通道：去掉正式配置里的 GitHub publish，避免生成指向正式更新源的
// app-update.yml（脚本侧还有 --publish never 双保险）
delete config.publish;

module.exports = config;
