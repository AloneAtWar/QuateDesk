// 本机 CLI 数据根目录发现:设置覆盖(env)> 内置默认。
// 根目录每次扫描重新解析;rootId 是规范化路径的稳定短哈希,持久层只存
// rootId + 相对文件键,不落任何绝对路径。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const homeDir = () => os.homedir();

const envValue = (name) => {
  const raw = process.env[name];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || null;
};

// Windows 路径大小写不敏感;统一小写 + 正斜杠后哈希,保证同一目录跨扫描得到同一 rootId
const normalizeForId = (target) => path.resolve(target).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();

const rootIdOf = (target) => `r${crypto.createHash('sha256').update(normalizeForId(target)).digest('hex').slice(0, 10)}`;

const isDirectory = (target) => {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
};

const exists = (target) => {
  try { return fs.statSync(target).size >= 0; } catch { return false; }
};

// CLAUDE_CONFIG_DIRS 支持多根目录,分隔符按平台处理;Windows 盘符含冒号,
// 只把分号当分隔符,且逐段验证确实存在
const splitConfigDirs = (raw) => raw
  .split(path.delimiter === ';' ? ';' : /[:;]/)
  .map((item) => item.trim())
  .filter(Boolean);

const buildRoot = (rootPath, label) => ({ rootPath: path.resolve(rootPath), rootId: rootIdOf(rootPath), rootLabel: label, exists: isDirectory(rootPath) });

const detectZcodeRoots = () => {
  const override = envValue('ZCODE_HOME');
  if (override) return [buildRoot(override, '$ZCODE_HOME')];
  return [buildRoot(path.join(homeDir(), '.zcode'), '~/.zcode')];
};

const detectKimiRoots = () => {
  const override = envValue('KIMI_CODE_HOME');
  const roots = override
    ? [buildRoot(override, '$KIMI_CODE_HOME')]
    : [buildRoot(path.join(homeDir(), '.kimi-code'), '~/.kimi-code')];
  // 旧版安装目录:独立根目录,与新版数据不重叠,可并存
  const legacy = buildRoot(path.join(homeDir(), '.kimi'), '~/.kimi');
  if (!override && legacy.exists && !roots.some((root) => root.rootPath === legacy.rootPath)) roots.push(legacy);
  return roots;
};

const detectClaudeRoots = () => {
  const dirs = envValue('CLAUDE_CONFIG_DIRS');
  if (dirs) return splitConfigDirs(dirs).map((item) => buildRoot(item, '$CLAUDE_CONFIG_DIRS'));
  const single = envValue('CLAUDE_CONFIG_DIR');
  if (single) return [buildRoot(single, '$CLAUDE_CONFIG_DIR')];
  const roots = [buildRoot(path.join(homeDir(), '.claude'), '~/.claude')];
  const xdg = buildRoot(path.join(homeDir(), '.config', 'claude'), '~/.config/claude');
  if (xdg.exists && !roots.some((root) => root.rootPath === xdg.rootPath)) roots.push(xdg);
  return roots;
};

const detectCodexRoots = () => {
  const override = envValue('CODEX_HOME');
  if (override) return [buildRoot(override, '$CODEX_HOME')];
  return [buildRoot(path.join(homeDir(), '.codex'), '~/.codex')];
};

module.exports = {
  homeDir,
  envValue,
  exists,
  isDirectory,
  rootIdOf,
  detectZcodeRoots,
  detectKimiRoots,
  detectClaudeRoots,
  detectCodexRoots,
};
