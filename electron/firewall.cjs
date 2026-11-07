const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Windows 防火墙入站放行自检/自修复。
// 背景：应用首次监听端口时 Windows 弹的「允许访问」授权框，只会按用户勾选的网络档建规则
// （常见只勾了「公用网络」，甚至指向安装器的临时目录）；家庭 Wi-Fi 多为「专用」档时，
// 防火墙会静默丢弃手机端局域网发现的 UDP 43188 广播与远程查看的 TCP 连接，App 侧毫无感知。
// 远程查看启动后在这里核对放行规则是否覆盖全部网络档，缺失时自动补全（需 UAC 确认一次）。
const RULE_NAME = 'Quota Desk';
const QUERY_TIMEOUT_MS = 20_000;
// UAC 弹窗要等用户注意到并点击，超时必须给足
const ELEVATE_TIMEOUT_MS = 180_000;

// 会话内已确认放行后不再复查（开关远程查看会重新进入 startRemoteView）
let ensured = false;

const run = (file, args, timeout) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout }, (error, stdout) => {
    resolve({ error, stdout: String(stdout || '') });
  });
});

// 规则查询：字段全部取枚举名（True/Allow/Any），与系统显示语言无关，输出 JSON 供 Node 解析。
// 注意 PowerShell 管道符必须在行尾，这里整段写成单行。
const listRules = () => run('powershell.exe', ['-NoProfile', '-Command',
  `Get-NetFirewallRule -DisplayName '${RULE_NAME.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Enabled = "$($_.Enabled)"; Action = "$($_.Action)"; Profile = "$($_.Profile)"; Program = "$($_ | Get-NetFirewallApplicationFilter | Select-Object -ExpandProperty Program)"; Protocol = "$($_ | Get-NetFirewallPortFilter | Select-Object -ExpandProperty Protocol)" } } | ConvertTo-Json -Compress`], QUERY_TIMEOUT_MS);

// 放行档位是否覆盖 Domain/Private/Public 全部（Any 或三档齐全才算，只放「公用」不够）
const profileCovers = (profile) => {
  const parts = String(profile || '').toLowerCase().split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.includes('any') || parts.includes('all')) return true;
  return ['domain', 'private', 'public'].every((needed) => parts.includes(needed));
};

const isEnabled = (rule) => ['true', '1'].includes(String(rule.Enabled).toLowerCase());

// 规则集里是否已有「本程序路径 + 全档」的 TCP 与 UDP 放行各一条
const rulesCoverExe = (rules, exePath) => {
  const target = String(exePath || '').toLowerCase();
  const list = Array.isArray(rules) ? rules : rules ? [rules] : [];
  const usable = list.filter((rule) => rule
    && isEnabled(rule)
    && String(rule.Action).toLowerCase() === 'allow'
    && String(rule.Program || '').toLowerCase() === target
    && profileCovers(rule.Profile));
  return usable.some((rule) => String(rule.Protocol).toLowerCase() === 'udp')
    && usable.some((rule) => String(rule.Protocol).toLowerCase() === 'tcp');
};

// 提权补全规则：写临时脚本由 UAC 确认后执行。删除带 program= 过滤，
// 正式版/测试版/便携版并存的同名规则互不影响。
const applyElevated = async (exePath) => {
  let scriptPath;
  try {
    const script = [
      `netsh advfirewall firewall delete rule name="${RULE_NAME}" program="${exePath}"`,
      `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow program="${exePath}" protocol=UDP profile=any`,
      `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow program="${exePath}" protocol=TCP profile=any`,
    ].join('\r\n');
    scriptPath = path.join(os.tmpdir(), 'quota-desk-firewall-fix.cmd');
    fs.writeFileSync(scriptPath, script, 'utf8');
  } catch (error) {
    return { error };
  }
  const quoted = scriptPath.replace(/'/g, "''");
  // exit 2 = 用户在 UAC 弹窗点了「否」
  const { error } = await run('powershell.exe', ['-NoProfile', '-Command',
    `try { Start-Process -FilePath '${quoted}' -Verb RunAs -Wait -WindowStyle Hidden; exit 0 } catch { exit 2 }`], ELEVATE_TIMEOUT_MS);
  return { declined: error && error.code === 2, error };
};

const check = async (exePath) => {
  const { error, stdout } = await listRules();
  if (error) return { result: 'unknown', detail: error.message };
  if (!stdout.trim()) return { result: 'missing' };
  try {
    return rulesCoverExe(JSON.parse(stdout), exePath) ? { result: 'ok' } : { result: 'missing' };
  } catch (parseError) {
    return { result: 'unknown', detail: parseError.message };
  }
};

// 远程查看启动后调用：规则齐全直接返回；缺失则弹一次 UAC 补全并复核。任何失败只记日志，绝不抛出。
async function ensureRemoteFirewall({ log = () => {}, exePath = process.execPath, packaged = true, force = false } = {}) {
  if (process.platform !== 'win32') return 'skipped';
  // dev 模式跑的是 node_modules 里的 electron.exe，不为其写规则
  if (!packaged) return 'skipped-dev';
  if (ensured && !force) return 'already';
  try {
    const first = await check(exePath);
    if (first.result === 'ok') {
      ensured = true;
      return 'ok';
    }
    // 查询本身失败时不盲目提权，避免每次启动都弹 UAC
    if (first.result !== 'missing') {
      log(`firewall: 放行规则状态无法确认（${first.detail || first.result}），跳过自动修复`);
      return first.result;
    }
    log('firewall: 入站放行规则缺失或网络档不全，请求管理员权限补全 TCP/UDP 全档放行');
    const applied = await applyElevated(exePath);
    if (applied.declined) {
      log('firewall: 用户取消了提权，本次不修复（下次启动仍会提示）');
      return 'declined';
    }
    if (applied.error) {
      log(`firewall: 提权执行失败：${applied.error.message}`);
      return 'failed';
    }
    const second = await check(exePath);
    if (second.result === 'ok') {
      ensured = true;
      log('firewall: 放行规则已补全（TCP/UDP 全网络档）');
      return 'fixed';
    }
    log(`firewall: 修复后复核未通过（${second.detail || second.result}）`);
    return 'failed';
  } catch (error) {
    log(`firewall: 自检异常：${error?.message || error}`);
    return 'error';
  }
}

module.exports = { RULE_NAME, ensureRemoteFirewall, profileCovers, rulesCoverExe };
