#!/usr/bin/env node
// Quota Desk 数据查询 CLI:零依赖单文件(Node 18+),底层是对桌面应用 /api/v1/* 的 HTTP 调用。
// 用法见 --help;契约细节见 docs/api-v1.md。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 43187;

// 每个命令:HTTP 路径、位置参数、允许的 flag(映射为同名查询参数)
const COMMANDS = {
  meta: { path: '/api/v1/meta', flags: [] },
  accounts: { path: '/api/v1/accounts', flags: [] },
  agents: { path: '/api/v1/agents', flags: [] },
  snapshot: { path: '/api/v1/quota/snapshot', flags: ['account'] },
  history: { path: '/api/v1/quota/history', positional: 'account', flags: ['window', 'points', 'date', 'from', 'to', 'last', 'tz'] },
  series: { path: '/api/v1/usage/series', flags: ['source', 'account', 'granularity', 'agent', 'model', 'project', 'date', 'from', 'to', 'last', 'tz', 'refresh'] },
  summary: { path: '/api/v1/usage/summary', flags: ['source', 'account', 'agent', 'model', 'project', 'date', 'from', 'to', 'last', 'tz', 'refresh'] },
  breakdown: { path: '/api/v1/usage/breakdown', flags: ['by', 'top', 'source', 'account', 'agent', 'model', 'project', 'date', 'from', 'to', 'last', 'tz', 'refresh'] },
  waste: { path: '/api/v1/waste', flags: ['window', 'account', 'date', 'from', 'to', 'last', 'tz'] },
  raw: { path: null, positional: 'path', flags: [] },
};

const USAGE = `Quota Desk 数据查询 CLI(底层调用应用的 /api/v1/* 接口,输出 JSON)

用法: node cli/quate-desk.mjs <命令> [参数]

命令:
  meta                    版本、时区、服务器当前时间、数据采集新鲜度(建议每次会话先调)
  accounts                账号字典(--account 过滤参数的合法取值)
  agents                  本机 CLI 字典(agent 过滤参数的合法取值,含典型厂商映射)
  snapshot                当前额度:账号 × 窗口的剩余/已用/重置时间 [--account]
  history <account>       额度趋势序列 [--window --points --date|--from --to|--last --tz]
  series                  用量时间序列 [--source local|provider --account --granularity hour|day
                          --agent --model --project --date|--from --to|--last --tz --refresh]
  summary                 区间汇总(range 与 allTime 分开命名,过滤参数同 series)
  breakdown               维度分组 [--by model|agent|project --top N,过滤参数同 series]
  waste                   周期浪费 [--window weekly|monthly --account]
  raw <path>              逃生口:带令牌直接请求任意 v1 路径(含查询串),如
                          raw '/api/v1/usage/series?last=7d&tz=UTC'

时间参数(优先级 date > from/to > last > 各端点默认):
  --date 2026-10-14       单个自然日(按 --tz 时区,默认宿主机时区)
  --from .. --to ..       ISO 时间或 YYYY-MM-DD[THH:mm];to 缺省为现在;纯日期的 to 含当天
  --last 12h|30d          相对当前

通用:
  --url http://127.0.0.1:43187   服务地址(或环境变量 QUATEDESK_URL)
  --token <t>                    显式令牌,跳过自动配对(或环境变量 QUATEDESK_TOKEN)
  --help                         本帮助

前置条件:Quota Desk 桌面应用正在运行,且已在「设置 → 远程查看」启用访问服务。
本机运行会自动经回环地址免配对换取只读令牌;令牌只在本次进程内使用,不落盘。`;

// 退出哨兵:fail 需要中止当前异步链。不用 process.exit——在 Windows 上它会在
// fetch 句柄拆除途中触发 libuv 断言;实测 undici 响应完成后不会挂住事件循环,
// 设置 exitCode 后自然退出即可
const EXIT = Symbol('cli-exit');
let exiting = false;
const fail = (message, code = 1) => {
  if (exiting) throw EXIT;
  exiting = true;
  process.exitCode = code;
  process.stderr.write(`error: ${message}\n`);
  throw EXIT;
};

const parseArgs = (argv) => {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (token.startsWith('--') && token.length > 2) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[name] = next; index += 1; }
      else flags[name] = 'true';
    } else positionals.push(token);
  }
  return { positionals, flags };
};

// 端口发现:优先读应用数据目录的 remote-access.json(用户可能改过端口)
const discoverPort = () => {
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'Quota Desk', 'remote-access.json'),
    process.platform === 'darwin' && path.join(os.homedir(), 'Library', 'Application Support', 'Quota Desk', 'remote-access.json'),
    path.join(os.homedir(), '.config', 'Quota Desk', 'remote-access.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const port = Number(config.port);
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
    } catch { /* 尝试下一个候选 */ }
  }
  return DEFAULT_PORT;
};

const baseUrl = (flags) => {
  const explicit = flags.url || process.env.QUATEDESK_URL;
  if (explicit) return String(explicit).replace(/\/+$/, '');
  return `http://127.0.0.1:${discoverPort()}`;
};

// 本机预览配对:回环地址免配对码换只读令牌,仅本次进程内有效
const pairToken = async (base) => {
  try {
    const response = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localPreview: true }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.token) return body.token;
    if (response.status === 403) fail(`无法换取本机令牌(${body.error || response.status}):请确认 CLI 与 Quota Desk 在同一台机器上运行`);
    fail(`换取令牌失败(${response.status}):${`${body.error || ''} ${body.message || ''}`.trim()}`);
  } catch (error) {
    fail(`无法连接 Quota Desk(${base}):${error.cause?.code || error.message}\n请确认应用正在运行,且已在「设置 → 远程查看」启用访问服务。`);
  }
};

const requestOnce = async (base, pathname, token) => {
  const response = await fetch(`${base}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON 响应按原文处理 */ }
  return { status: response.status, ok: response.ok, body, text };
};

const request = async (base, pathname, { token, allowRetry = true }) => {
  let result;
  try {
    result = await requestOnce(base, pathname, token);
  } catch (error) {
    fail(`无法连接 Quota Desk(${base}):${error.cause?.code || error.message}\n请确认应用正在运行,且已在「设置 → 远程查看」启用访问服务。`);
  }
  // 本机预览令牌有并发上限,被顶掉时(401)重换一次
  if (result.status === 401 && allowRetry) {
    const fresh = await pairToken(base);
    return request(base, pathname, { token: fresh, allowRetry: false });
  }
  if (!result.ok) {
    const detail = result.body ? `${result.body.error || ''} ${result.body.message || ''}`.trim() : (result.text || '').slice(0, 200);
    fail(`请求失败(${result.status}):${detail || '未知错误'}`);
  }
  return result.body;
};

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const command = argv[0];
  const spec = COMMANDS[command];
  if (!spec) fail(`未知命令:${command}(用 --help 查看可用命令)`);

  const { positionals, flags } = parseArgs(argv.slice(1));
  const allowed = new Set([...spec.flags, 'url', 'token']);
  const unknown = Object.keys(flags).filter((name) => !allowed.has(name));
  if (unknown.length) fail(`命令 ${command} 不支持参数:${unknown.map((name) => `--${name}`).join(' ')}(允许:${[...spec.flags].map((name) => `--${name}`).join(' ') || '无'})`);
  for (const [name, value] of Object.entries(flags)) {
    if (value === 'true' && !['refresh'].includes(name)) fail(`--${name} 需要一个值`);
  }

  let pathname;
  if (command === 'raw') {
    const target = positionals[0];
    if (!target) fail('raw 需要一个路径参数,例如 raw \'/api/v1/usage/series?last=7d\'');
    pathname = target.startsWith('/') ? target : `/${target}`;
  } else {
    if (spec.positional) {
      const value = positionals[0];
      if (!value) fail(`命令 ${command} 需要位置参数 <${spec.positional}>`);
      flags[spec.positional] = value;
    } else if (positionals.length) {
      fail(`命令 ${command} 不接受位置参数:${positionals.join(' ')}`);
    }
    const queryKeys = [...spec.flags, ...(spec.positional ? [spec.positional] : [])];
    const query = Object.entries(flags)
      .filter(([name]) => queryKeys.includes(name))
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join('&');
    pathname = spec.path + (query ? `?${query}` : '');
  }

  const base = baseUrl(flags);
  const token = flags.token || process.env.QUATEDESK_TOKEN || await pairToken(base);
  const body = await request(base, pathname, { token });
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
};

main().catch((error) => { if (error !== EXIT) fail(error?.stack || String(error)); });
