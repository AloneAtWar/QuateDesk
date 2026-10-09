// 本机 CLI 数据根目录发现:设置覆盖(env)> 内置默认。
// 根目录每次扫描重新解析;rootId 是规范化路径的稳定短哈希,持久层只存
// rootId + 相对文件键,不落任何绝对路径。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const wsl = require('./wsl.cjs');

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

// WSL 根目录:仅在默认路径分支追加;env 覆盖不涉及 WSL。
// 发行版未运行/未安装 WSL 时 listWslHomes 返回空,自然无追加
const wslRootsFor = (relPath, label) => {
  if (!wsl.isWslEnabled()) return [];
  return wsl.listWslHomes()
    .map((home) => ({ ...buildRoot(path.join(home.homePath, ...relPath.split('/')), `WSL:${home.distro}/${home.user} ${label}`), isWsl: true }));
};

const detectZcodeRoots = () => {
  const override = envValue('ZCODE_HOME');
  if (override) return [buildRoot(override, '$ZCODE_HOME')];
  return [buildRoot(path.join(homeDir(), '.zcode'), '~/.zcode'), ...wslRootsFor('.zcode', '~/.zcode')];
};

const detectKimiRoots = () => {
  const override = envValue('KIMI_CODE_HOME');
  const roots = override
    ? [buildRoot(override, '$KIMI_CODE_HOME')]
    : [buildRoot(path.join(homeDir(), '.kimi-code'), '~/.kimi-code')];
  // 旧版安装目录:独立根目录,与新版数据不重叠,可并存
  const legacy = buildRoot(path.join(homeDir(), '.kimi'), '~/.kimi');
  if (!override && legacy.exists && !roots.some((root) => root.rootPath === legacy.rootPath)) roots.push(legacy);
  if (!override) roots.push(...wslRootsFor('.kimi-code', '~/.kimi-code'), ...wslRootsFor('.kimi', '~/.kimi'));
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
  roots.push(...wslRootsFor('.claude', '~/.claude'), ...wslRootsFor('.config/claude', '~/.config/claude'));
  return roots;
};

const detectCodexRoots = () => {
  const override = envValue('CODEX_HOME');
  if (override) return [buildRoot(override, '$CODEX_HOME')];
  return [buildRoot(path.join(homeDir(), '.codex'), '~/.codex'), ...wslRootsFor('.codex', '~/.codex')];
};

// 逗号分隔的多根目录覆盖:逐段建根,不存在的段照常返回(exists=false),
// 与 ccusage 各 adapter 的 env 语义保持一致
const splitCommaDirs = (raw) => raw.split(',').map((item) => item.trim()).filter(Boolean);

const detectCopilotRoots = () => {
  const override = envValue('COPILOT_HOME');
  if (override) return splitCommaDirs(override).map((item) => buildRoot(item, '$COPILOT_HOME'));
  return [buildRoot(path.join(homeDir(), '.copilot'), '~/.copilot'), ...wslRootsFor('.copilot', '~/.copilot')];
};

// OpenCode:OPENCODE_DATA_DIR(可多根)> XDG_DATA_HOME > ~/.local/share;
// Windows 安装同样落在 ~/.local/share(opencode 自带 xdg 风格布局)
const detectOpencodeRoots = () => {
  const override = envValue('OPENCODE_DATA_DIR');
  if (override) return splitCommaDirs(override).map((item) => buildRoot(item, '$OPENCODE_DATA_DIR'));
  const xdg = envValue('XDG_DATA_HOME');
  const dataHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir(), '.local', 'share');
  const roots = [buildRoot(path.join(dataHome, 'opencode'), '~/.local/share/opencode')];
  if (!xdg) roots.push(...wslRootsFor('.local/share/opencode', '~/.local/share/opencode'));
  return roots;
};

const detectHermesRoots = () => {
  const override = envValue('HERMES_HOME');
  if (override) return splitCommaDirs(override).map((item) => buildRoot(item, '$HERMES_HOME'));
  return [buildRoot(path.join(homeDir(), '.hermes'), '~/.hermes'), ...wslRootsFor('.hermes', '~/.hermes')];
};

// OpenClaw:官方目录之外保留三个历史改名目录(clawdbot/moltbot/moldbot)
const detectOpenclawRoots = () => {
  const override = envValue('OPENCLAW_DIR');
  if (override) return splitCommaDirs(override).map((item) => buildRoot(item, '$OPENCLAW_DIR'));
  const labels = ['.openclaw', '.clawdbot', '.moltbot', '.moldbot'];
  const roots = labels.map((label) => buildRoot(path.join(homeDir(), label), `~/${label}`));
  for (const label of labels) roots.push(...wslRootsFor(label, `~/${label}`));
  return roots.filter((root) => root.exists);
};

const detectGeminiRoots = () => {
  const override = envValue('GEMINI_DATA_DIR');
  if (override) return splitCommaDirs(override).map((item) => buildRoot(item, '$GEMINI_DATA_DIR'));
  return [buildRoot(path.join(homeDir(), '.gemini', 'tmp'), '~/.gemini/tmp'), ...wslRootsFor('.gemini/tmp', '~/.gemini/tmp')];
};

const detectGrokRoots = () => {
  const override = envValue('GROK_HOME');
  if (override) return splitCommaDirs(override).map((item) => buildRoot(item, '$GROK_HOME'));
  return [buildRoot(path.join(homeDir(), '.grok'), '~/.grok'), ...wslRootsFor('.grok', '~/.grok')];
};

// DeepSeek Harness:DSH_HOME 覆盖 > ~/.dsh(会话日志在 sessions/ 子目录)
const detectDshRoots = () => {
  const override = envValue('DSH_HOME');
  if (override) return splitCommaDirs(override).map((item) => buildRoot(item, '$DSH_HOME'));
  return [buildRoot(path.join(homeDir(), '.dsh'), '~/.dsh'), ...wslRootsFor('.dsh', '~/.dsh')];
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
  detectCopilotRoots,
  detectOpencodeRoots,
  detectHermesRoots,
  detectOpenclawRoots,
  detectGeminiRoots,
  detectGrokRoots,
  detectDshRoots,
};
