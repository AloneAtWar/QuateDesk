const { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, screen, session, shell, Tray } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DesktopStore } = require('./storage.cjs');
const { queryAccount, authStatusForPollError } = require('./poller.cjs');
const { clampRetentionDays } = require('./history.cjs');
const { resolveWasteWindows } = require('./waste.cjs');
const { builtinConfigs } = require('./builtin-configs.cjs');
const { scanCcswitch } = require('./ccswitch.cjs');
const { mergeMainOwnedUsageConnections } = require('./provider-usage-state.cjs');
const { CLI_KINDS, SNAPSHOT_KEY, readLiveAuth, cliIdentity, resolveCliAuth, authVersionMatches, writeLiveIfCurrent, fetchWithCliAuth } = require('./cli-auth.cjs');
const {
  fetchDeepSeekUsage,
  fetchDeepSeekSummary,
  fetchZaiUsage,
  fetchZaiPlanSummary,
  isAllowedDeepSeekLoginUrl,
  normalizeDeepSeekUserToken,
  normalizeZaiApiKey,
  normalizeZaiOrigin,
  buildCodexUsageRequest,
  normalizeCodexTokenUsage,
  fetchMinimaxUsage,
  probeMinimaxSession,
  isAllowedMinimaxLoginUrl,
  isMinimaxCookieDomain,
  ProviderUsageError,
  shouldUseCachedUsage,
} = require('./provider-usage.cjs');

app.setName('Quota Desk');
app.setAppUserModelId('com.quotadesk.app');
app.setPath('userData', path.join(app.getPath('appData'), 'Quota Desk'));

let mainWindow;
let widgetWindow;
let tray;
let store;
let pollTimer;
let quitting = false;
let nextPollAt = null;
let pollStartedAt = null;
let pollInProgress = false;
const sentReminders = new Set();
const providerUsageLoginFlows = new Map();
const providerUsageRecoveryFlows = new Map();
const providerUsageCache = new Map();
const providerUsageWindows = new Map();
const providerUsageSessions = new Map();
const providerUsageRequests = new Map();
const providerUsageEpochs = new Map();
const PROVIDER_USAGE_AUTH_KEY = 'providerUsageAuth';
const PROVIDER_USAGE_CACHE_MS = 2 * 60 * 1000;
const DEEPSEEK_USAGE_URL = 'https://platform.deepseek.com/usage';
const DEEPSEEK_PLATFORM_ORIGIN = new URL(DEEPSEEK_USAGE_URL).origin;
const DEEPSEEK_TIMEZONE_OFFSET_SEC = 8 * 60 * 60;
const ZAI_USAGE_TIMEZONE_OFFSET_SEC = 8 * 60 * 60;
// 小控件整体等比缩放：一个比例因子同时决定窗口像素尺寸和内容缩放（渲染端 transform）。
// Windows 显示缩放非 100% 时，反复 setPosition 会因 DIP/物理像素换算误差把窗口
// 越拖越大，所以拖动时也必须用固定宽高走 setBounds。
const WIDGET_BASE_SIZE = { width: 350, height: 52 };
const clampWidgetScale = (value) => {
  const scale = Math.round(Number(value) * 20) / 20;
  return Number.isFinite(scale) ? Math.min(3, Math.max(0.8, scale)) : 1;
};
// 浮窗长度：在等比缩放之外单独调整横向长度（高度不变），最短也要保证额度芯片完整显示
const WIDGET_MIN_LENGTH = 0.6;
const WIDGET_MAX_LENGTH = 1.5;
const clampWidgetLength = (value) => {
  const length = Math.round(Number(value) * 20) / 20;
  return Number.isFinite(length) ? Math.min(WIDGET_MAX_LENGTH, Math.max(WIDGET_MIN_LENGTH, length)) : 1;
};
const widgetWindowSize = (scale, length = 0.9) => ({ width: Math.round(WIDGET_BASE_SIZE.width * scale * clampWidgetLength(length)), height: Math.round(WIDGET_BASE_SIZE.height * scale) });
// 兼容旧设置：小/中/大档位与像素宽高都折算成比例；新装默认 90%
const savedWidgetScale = () => {
  const settings = store?.loadState()?.settings || {};
  const legacyWidth = { small: 240, medium: 280, large: 336 }[settings.widgetSize];
  const byWidth = Number(settings.widgetWidth) ? Number(settings.widgetWidth) / WIDGET_BASE_SIZE.width : undefined;
  return clampWidgetScale(settings.widgetScale ?? byWidth ?? (legacyWidth ? legacyWidth / WIDGET_BASE_SIZE.width : 0.9));
};
let widgetScale = 1;
const savedWidgetLength = () => clampWidgetLength(store?.loadState()?.settings?.widgetLength ?? 0.9);
let widgetLength = 1;
// 额度历史保留天数：默认 7 天，最长 3 个月（90 天）
const historyRetentionDays = () => clampRetentionDays(store?.loadState()?.settings?.historyDays);
// 界面主题：默认暗色，主窗口与浮窗的底色保持一致避免闪白/闪黑
const themeColors = (theme) => (theme === 'light'
  ? { main: '#f3f5f1', widget: '#eef1ec' }
  : { main: '#141d1f', widget: '#202c2e' });
const savedTheme = () => (store?.loadState()?.settings?.theme === 'light' ? 'light' : 'dark');
const RELEASES_URL = 'https://github.com/AloneAtWar/QuateDesk/releases';
const distPath = path.join(__dirname, '..', 'dist', 'index.html');
const preloadPath = path.join(__dirname, 'preload.cjs');
const appIconPngPath = path.join(__dirname, '..', 'dist', 'logo.png');
const appIconSvgPath = path.join(__dirname, '..', 'dist', 'quota-desk.svg');

// 开机自启由操作系统的登录项管理,作为唯一事实来源,不写入应用状态
const getAutoLaunch = () => app.getLoginItemSettings().openAtLogin;
const setAutoLaunch = (enabled) => {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return getAutoLaunch();
};

// 自动更新:仅在打包后的应用里加载 electron-updater;开发模式没有 app-update.yml,检查必失败
let autoUpdater = null;
let updateStatus = { status: 'idle' };
if (app.isPackaged) {
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = false; // 由用户看过更新说明后手动触发下载
    autoUpdater.autoInstallOnAppQuit = true;
  } catch (error) {
    console.error('[Quota Desk] updater unavailable', error.message);
  }
}

// electron-updater 的 GitHub 更新说明来自 releases.atom，内容是 HTML；转成纯文本并去掉自动生成说明末尾的 Full Changelog 对比链接
const htmlToText = (html) => html
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|h[1-6])>/gi, '\n\n')
  .replace(/<\/(li|ul|ol)>/gi, '\n')
  .replace(/<li[^>]*>/gi, '* ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#0?39;/g, '\'')
  .split('\n')
  .map((line) => line.replace(/\s+/g, ' ').trim())
  .filter((line) => line && !/^\**\s*Full Changelog\b/i.test(line))
  .join('\n');

const normalizeReleaseNotes = (notes) => Array.isArray(notes)
  ? notes.map((item) => htmlToText(String(item?.note || ''))).filter(Boolean).join('\n\n')
  : htmlToText(typeof notes === 'string' ? notes : '');

const sendUpdateStatus = (patch) => {
  updateStatus = { ...updateStatus, ...patch };
  for (const window of [mainWindow, widgetWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('update:status', updateStatus);
  }
};

// 网络连接异常（DNS、断网、超时等）导致的检查失败不算“更新失败”
const UPDATE_NETWORK_ERROR = /net::|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ERR_ADDRESS|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ECONNABORTED|getaddrinfo|time(?:d)?\s*out|network|socket hang up|unable to connect|网络|无法连接/i;
// 手动检查（设置页/托盘点击“检查更新”）需要明确反馈；自动检查遇到网络异常时静默处理
let manualUpdateCheck = false;
// electron-updater 出错时同一个 Error 会先后走 'error' 事件和 promise rejection 两条路，按实例去重避免重复上报
let lastReportedUpdateError = null;
// 检查进行中标记：期间再次触发不叠加请求，手动请求则把进行中的检查升级为手动以便给出反馈
let updateCheckInFlight = false;
// 应用常驻托盘，只在启动时查一次会让长期不重启的用户错过新版本，改为每小时自动检查
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let updateCheckTimer = null;
// macOS 未签名、Windows 便携版都无法在应用内完成升级，只能引导到发布页手动下载（便携版由 electron-builder 注入 PORTABLE_EXECUTABLE_DIR 环境变量标识）
const MANUAL_DOWNLOAD_ONLY = process.platform === 'darwin' || Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

function reportUpdateError(error) {
  if (error === lastReportedUpdateError) return;
  lastReportedUpdateError = error;
  const raw = error?.message || '';
  const networkError = UPDATE_NETWORK_ERROR.test(raw);
  // 下载一定由用户主动触发，失败必须可见，不走自动检查遇到网络异常时的静默分支
  if (updateStatus.status === 'downloading') {
    sendUpdateStatus({ status: 'error', errorKind: 'download', version: updateStatus.version, manual: true, message: networkError ? '网络连接异常，下载失败，请稍后重试' : (raw || '下载失败') });
    return;
  }
  // 已上报的下载失败不被去重漏网的重复报错覆盖成“检查失败”
  if (updateStatus.status === 'error' && updateStatus.errorKind === 'download') return;
  if (networkError && !manualUpdateCheck) {
    // 后台自动检查遇到网络异常：回到空闲状态，不展示“更新失败”
    sendUpdateStatus({ status: 'idle', message: '', manual: false });
    return;
  }
  sendUpdateStatus({ status: 'error', errorKind: 'check', manual: manualUpdateCheck, message: networkError ? '网络连接异常，无法检查更新，请稍后重试' : (raw || '检查更新失败') });
}

function setupAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ status: 'checking', manual: manualUpdateCheck }));
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ status: 'available', version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes), percent: 0, message: '', manualDownload: MANUAL_DOWNLOAD_ONLY, manual: manualUpdateCheck }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ status: 'none', manual: manualUpdateCheck }));
  autoUpdater.on('download-progress', (progress) => sendUpdateStatus({ status: 'downloading', percent: Math.round(progress.percent || 0), manual: manualUpdateCheck }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ status: 'downloaded', version: info.version || updateStatus.version, percent: 100, manual: manualUpdateCheck }));
  autoUpdater.on('error', (error) => reportUpdateError(error));
}

// 后台自动检查只在这些状态下发起：已有可用版本、下载中或已下载待安装时不重复打扰
function backgroundUpdateCheckAllowed() {
  return ['idle', 'none', 'error'].includes(updateStatus.status);
}

function checkForUpdates(manual = false) {
  if (!autoUpdater) return false;
  if (updateCheckInFlight) {
    // 检查进行中：手动请求把这次检查升级为手动，让进行中的结果直接反馈给用户
    if (manual) manualUpdateCheck = true;
    return true;
  }
  updateCheckInFlight = true;
  manualUpdateCheck = manual;
  lastReportedUpdateError = null;
  const done = () => { updateCheckInFlight = false; };
  autoUpdater.checkForUpdates().then(done, done);
  return true;
}

function scheduleUpdateChecks() {
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  updateCheckTimer = setInterval(() => {
    if (store?.loadState()?.settings?.autoUpdate === false) return;
    if (!backgroundUpdateCheckAllowed()) return;
    checkForUpdates();
  }, UPDATE_CHECK_INTERVAL_MS);
}

function setAutoUpdateEnabled(enabled) {
  const state = store.loadState() || {};
  const saved = store.saveState(cleanState({ ...state, settings: { ...(state.settings || {}), autoUpdate: Boolean(enabled) } }));
  sendState(saved);
  refreshTray();
  if (enabled && backgroundUpdateCheckAllowed()) checkForUpdates();
}

const runtimeStatus = () => ({
  running: Boolean(pollTimer),
  checking: pollInProgress,
  startedAt: pollStartedAt,
  nextPollAt,
  // 各本机 CLI 登录的当前指纹：UI 用来给「本机激活」的账号打徽标（profile 切换后指纹即变）
  cliLive: { ...cliLiveIdentities },
});

// ── CLI 登录态：账号快照 + 自动续期 + 本机 live 指纹 ─────────────────────────
// 多账号参考 cc-switch 的「OAuth 授权中心」：每个账号把 token bundle 存进自己的加密凭据，
// 额度查询用快照里的 token 并在临期/失效时自动用 refresh_token 续期，不依赖本机 CLI
// 当前激活的是哪个 profile；本机 live 文件只在「确属同一账号」时才写回续期结果。
let cliLiveIdentities = Object.fromEntries(CLI_KINDS.map((kind) => [kind, null]));

const refreshLiveIdentities = () => {
  for (const kind of CLI_KINDS) {
    const auth = readLiveAuth(kind);
    const identity = auth && cliIdentity(kind, auth);
    cliLiveIdentities[kind] = identity ? identity.fingerprint : null;
  }
};

// CLI 登录续期成功后的统一落盘：账号快照写回加密存储；本机 live 文件仍是同一账号时同步更新
const persistCliAuthUpdate = (accountId, { kind, next, previous, source }) => {
  try {
    const state = store.loadState();
    if (!state?.accounts?.some((account) => account.id === accountId)) return;
    if (source === 'snapshot') {
      // 轮询可能并发触发同一账号续期；refresh token 轮换后，迟到的旧结果不能覆盖新快照。
      const stored = store.getSecrets(accountId);
      const raw = stored.variables?.[SNAPSHOT_KEY];
      let current = null;
      try { current = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
      if (!current || authVersionMatches(kind, current, previous)) {
        store.saveCredential(accountId, '', { [SNAPSHOT_KEY]: JSON.stringify(next) });
      } else if (!authVersionMatches(kind, current, next)) {
        return;
      }
    }
    writeLiveIfCurrent(kind, previous, next);
    refreshLiveIdentities();
  } catch (error) {
    console.error('[Quota Desk] CLI 登录态续期落盘失败', error.message);
  }
};

// CLI 专属适配账号的身份维护：镜像账号（无快照）的标识跟随本机当前登录；
// 快照账号只在标识为空时自动填一次，用户手填的标识不被覆盖
const cliIdentityPatch = (account, kind, secrets) => {
  if (!CLI_KINDS.includes(kind)) return null;
  const resolved = resolveCliAuth(kind, secrets.variables);
  const identity = resolved && cliIdentity(kind, resolved.auth);
  if (!identity) return null;
  return {
    cliAuthSource: resolved.source,
    cliFingerprint: identity.fingerprint,
    identity: (resolved.source === 'snapshot' && account.identity) ? account.identity : (identity.display || account.identity || ''),
  };
};

// ── 网络代理设置 ────────────────────────────────────────────────────────────
// 额度轮询走 net.fetch（默认会话的 Chromium 网络栈），setProxy 即对所有账号的请求生效。
// 三种模式：direct=直连、system=跟随系统代理（默认）、manual=手动指定代理规则。
const normalizeProxyRules = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  // 允许 host:port 简写（补 http:// 前缀）；http(s)/socks5 标准写法与 Chromium 的
  // "scheme=host:port;..." 分协议规则原样透传
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.includes('=')) return trimmed;
  return `http://${trimmed}`;
};

function currentProxyConfig() {
  const settings = store?.loadState()?.settings || {};
  const mode = ['direct', 'system', 'manual'].includes(settings.proxyMode) ? settings.proxyMode : 'system';
  let config = { mode };
  if (mode === 'manual') {
    const proxyRules = normalizeProxyRules(settings.proxyUrl);
    config = proxyRules ? { proxyRules } : { mode: 'system' };
  }
  return config;
}

function applyProxySetting() {
  return session.defaultSession.setProxy(currentProxyConfig())
    .catch((error) => console.error('[Quota Desk] 应用代理设置失败', error.message));
}

const sendState = (state) => {
  for (const window of [mainWindow, widgetWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('state:updated', { ...state, runtime: runtimeStatus() });
  }
};

const builtinLogos = {
  kimi: './logos/kimi.png',
  'kimi-subscription': './logos/kimi.png',
  zai: './logos/zai.svg',
  deepseek: './logos/deepseek.png',
  grok: './logos/grok.png',
  minimax: './logos/minimax.svg',
  claude: './logos/claude.jpg',
  codex: './logos/codex.svg',
  gemini: './logos/gemini.svg',
};
// 内置厂商的默认官网；仅在厂商从未设置过官网时补齐，用户清空后不再强制回填
const builtinWebsites = {
  kimi: 'https://www.kimi.com/',
  'kimi-subscription': 'https://www.kimi.com/',
  zai: 'https://bigmodel.cn/',
  deepseek: 'https://www.deepseek.com/',
  wlb: 'https://www.wlbclub.com/',
  grok: 'https://grok.com/',
  minimax: 'https://platform.minimaxi.com',
  claude: 'https://claude.com/claude-code',
  codex: 'https://developers.openai.com/codex/',
  gemini: 'https://gemini.google.com/',
};
// 专属适配类内置厂商（凭据来自本机 CLI / 官方接口），历史 state 里没有的加载/保存时补齐
const ensureCliProviders = (providers) => {
  const cliProviders = [
    { id: 'grok', name: 'Grok', legalName: 'xAI Grok', monogram: 'G', tone: 'slate', adapter: 'grok', logo: './logos/grok.png' },
    { id: 'minimax', name: 'MiniMax', legalName: 'MiniMax Coding Plan', monogram: 'M', tone: 'mint', adapter: 'minimax', logo: './logos/minimax.svg' },
    { id: 'claude', name: 'Claude', legalName: 'Claude Code', monogram: 'C', tone: 'coral', adapter: 'claude', logo: './logos/claude.jpg' },
    { id: 'codex', name: 'Codex', legalName: 'OpenAI Codex', monogram: 'O', tone: 'mint', adapter: 'codex', logo: './logos/codex.svg' },
    { id: 'gemini', name: 'Gemini', legalName: 'Gemini CLI', monogram: 'G', tone: 'sky', adapter: 'gemini', logo: './logos/gemini.svg' },
    { id: 'kimi-subscription', name: 'Kimi 订阅', legalName: 'Kimi for Coding 订阅', monogram: 'K', tone: 'sky', adapter: 'kimi', logo: './logos/kimi.png' },
  ];
  const existing = new Set(providers.map((item) => item.id));
  const additions = cliProviders
    .filter((item) => !existing.has(item.id))
    .map((item) => ({ ...item, website: builtinWebsites[item.id], requestConfig: builtinConfigs[item.id] }));
  return additions.length ? [...providers, ...additions] : providers;
};
const migrateProvider = (provider) => {
  if (!provider) return provider;
  // 旧版 logo 引用（含已删除的 png/旧文件名）视为 legacy，重新指向当前内置图标
  const legacyLogo = !provider.logo || /^https?:\/\//i.test(provider.logo) || /\.\/logos\/(kimi\.(png|svg)|zai\.svg|zhipu\.svg|deepseek\.(png|svg)|grok\.svg|anthropic\.svg|openai\.svg|claude\.(png|svg))$/i.test(provider.logo);
  const logo = legacyLogo && builtinLogos[provider.id] ? builtinLogos[provider.id] : provider.logo;
  const builtinConfig = builtinConfigs[provider.id];
  const needsWlbMigration = provider.id === 'wlb' && builtinConfig?.builtinMigration && provider.requestConfig?.builtinMigration !== builtinConfig.builtinMigration;
  const builtin = !provider.requestConfig?.adapterMode || needsWlbMigration ? builtinConfig : null;
  const seededVariables = !builtin && builtinConfig?.adapterMode === 'script' && !provider.requestConfig?.variables?.some((item) => item.key === 'endpoint')
    ? { ...provider, requestConfig: { ...provider.requestConfig, variables: builtinConfig.variables } }
    : provider;
  const website = provider.website === undefined ? (builtinWebsites[provider.id] ?? '') : provider.website;
  const migrated = builtin ? { ...provider, website, baseUrl: undefined, domain: undefined, requestConfig: builtin, logo } : { ...seededVariables, website, baseUrl: undefined, domain: undefined, logo };
  // 浪费统计预设补齐：存量 state 的 requestConfig 还没有 wasteWindows 字段时用内置预设；
  // 用户手动设置过（包括空数组 = 明确不做浪费统计）则保留不动
  const seededWaste = builtinConfig && migrated.requestConfig && !Array.isArray(migrated.requestConfig.wasteWindows)
    ? { ...migrated, requestConfig: { ...migrated.requestConfig, wasteWindows: builtinConfig.wasteWindows } }
    : migrated;
  // API 厂商的官方账号登录只是增强能力，不能替代基础 API Key。同步修正旧 state
  // 中曾被保存为 optional 的系统 apiKey 变量，避免绕过 renderer 时创建空凭据账号。
  const requiredApiKey = builtinConfig?.adapterMode === 'script' && Array.isArray(seededWaste.requestConfig?.variables)
    ? {
      ...seededWaste,
      requestConfig: {
        ...seededWaste.requestConfig,
        variables: seededWaste.requestConfig.variables.map((variable) => variable?.system && variable.key === 'apiKey'
          ? { ...variable, required: true }
          : variable),
      },
    }
    : seededWaste;
  if (provider.id === 'wlb') return { ...requiredApiKey, name: 'wlbclub', legalName: 'wlbclub', monogram: 'W' };
  return requiredApiKey;
};

const migrateAccount = (account) => {
  if (!account) return account;
  // 停用字段规范化：只有显式 disabled:true 才算停用（脏值一律视为启用中），停用时间缺失补 null
  const { baseUrl, disabled, disabledAt, ...rest } = account;
  const normalized = disabled === true ? { ...rest, disabled: true, disabledAt: disabledAt || null } : rest;
  // wlbclub 上线 1 天限额：已显式选择过窗口的 wlb 账号自动补上 daily；没选过窗口的账号不做过滤，本来就会显示
  if (normalized.providerId === 'wlb' && Array.isArray(normalized.windowKeys) && normalized.windowKeys.length && !normalized.windowKeys.includes('daily')) {
    return { ...normalized, windowKeys: [...normalized.windowKeys, 'daily'] };
  }
  return normalized;
};

// XiaoMi MiMo 从未推出适配接口，已从系统厂商中移除；历史 state 里残留的 mimo 厂商与账号在迁移时一并丢弃
const migrateState = (state) => state ? {
  ...state,
  accounts: (state.accounts || []).map(migrateAccount).filter((account) => account.providerId !== 'mimo'),
  providers: ensureCliProviders((state.providers || []).map(migrateProvider).filter((provider) => provider.id !== 'mimo')),
} : state;

const cleanState = (state) => ({
  accounts: (state?.accounts || []).map(({ credential, baseUrl, ...account }) => account).filter((account) => account.providerId !== 'mimo'),
  providers: ensureCliProviders((state?.providers || []).map(({ baseUrl, domain, ...provider }) => migrateProvider(provider)).filter((provider) => provider.id !== 'mimo')),
  settings: state?.settings || {},
  lastSync: state?.lastSync || new Date().toISOString(),
});

// ── 厂商官方账号用量 ──────────────────────────────────────────────────────
// API Key 仍负责日常余额轮询；官方用量只作为可选增强，用于读取厂商侧的
// 账号级历史用量。每家厂商一个 PROVIDER_USAGE_CONFIGS 配置：
// - browser-token（DeepSeek）：网页登录窗口捕获 userToken + Cookie，令牌持久化并支持失效恢复
// - browser-cookie（MiniMax）：网页登录窗口捕获控制台 Cookie，账单探针验证会话
// - api-key（Z.ai）：复用账号已保存的 API Key 直接查询，无需登录窗口
// - cli-oauth（Codex）：复用本机 CLI 的 ChatGPT 登录快照，过期自动续期
// 网页登录窗口使用非 persist 分区，凭据不会写进 Chromium 的磁盘目录；只把恢复
// 所需的 Cookie/token 写入 safeStorage，且永远不进入公开 state 或 renderer。
const providerUsagePartitionBase = (accountId) => `quota-desk-usage-${crypto.createHash('sha256').update(String(accountId)).digest('hex').slice(0, 20)}`;
// A flow-specific, memory-only partition prevents an older login flow's cleanup from
// erasing cookies/localStorage belonging to a replacement login or an active query.
const providerUsagePartition = (accountId) => `${providerUsagePartitionBase(accountId)}-${crypto.randomBytes(8).toString('hex')}`;
const legacyProviderUsagePartition = (accountId) => `persist:${providerUsagePartitionBase(accountId)}`;
const providerUsageEpoch = (accountId) => Number(providerUsageEpochs.get(accountId) || 0);
const bumpProviderUsageEpoch = (accountId) => {
  const next = providerUsageEpoch(accountId) + 1;
  providerUsageEpochs.set(accountId, next);
  return next;
};
const providerUsageCancelledError = () => Object.assign(new Error('官方账号用量操作已取消'), { code: 'USAGE_DISCONNECTED' });
const assertProviderUsageEpoch = (accountId, epoch) => {
  if (providerUsageEpoch(accountId) !== epoch) throw providerUsageCancelledError();
};

const rememberProviderUsageRequest = (accountId, controller) => {
  const controllers = providerUsageRequests.get(accountId) || new Set();
  controllers.add(controller);
  providerUsageRequests.set(accountId, controllers);
  return () => {
    controllers.delete(controller);
    if (controllers.size === 0) providerUsageRequests.delete(accountId);
  };
};

const abortProviderUsageRequests = (accountId) => {
  for (const controller of providerUsageRequests.get(accountId) || []) controller.abort();
  providerUsageRequests.delete(accountId);
};

const isDeepSeekCookieDomain = (value) => {
  const domain = String(value || '').toLowerCase().replace(/^\./, '');
  return domain === 'deepseek.com' || domain.endsWith('.deepseek.com');
};
const serializeUsageCookies = (cookies, isCookieDomain) => (Array.isArray(cookies) ? cookies : [])
  .filter((cookie) => isCookieDomain(cookie?.domain) && cookie?.name && typeof cookie?.value === 'string')
  .slice(0, 80)
  .map((cookie) => ({
    name: String(cookie.name).slice(0, 256),
    value: String(cookie.value).slice(0, 16 * 1024),
    domain: String(cookie.domain).slice(0, 256),
    path: String(cookie.path || '/').startsWith('/') ? String(cookie.path || '/').slice(0, 1024) : '/',
    secure: cookie.secure !== false,
    httpOnly: Boolean(cookie.httpOnly),
    hostOnly: Boolean(cookie.hostOnly),
    ...(Number.isFinite(Number(cookie.expirationDate)) ? { expirationDate: Number(cookie.expirationDate) } : {}),
    ...(['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite) ? { sameSite: cookie.sameSite } : {}),
  }));

const readUsageCookies = async (usageSession, isCookieDomain) => serializeUsageCookies(await usageSession.cookies.get({}), isCookieDomain);
const restoreUsageCookies = async (usageSession, cookies, isCookieDomain) => {
  for (const cookie of serializeUsageCookies(cookies, isCookieDomain)) {
    if (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000) continue;
    const hostname = cookie.domain.replace(/^\./, '');
    const details = {
      url: `https://${hostname}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
      ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
      ...(cookie.sameSite && cookie.sameSite !== 'unspecified' ? { sameSite: cookie.sameSite } : {}),
    };
    await usageSession.cookies.set(details);
  }
};

const readProviderUsageAuth = (accountId) => {
  const raw = store.getSecrets(accountId).variables?.[PROVIDER_USAGE_AUTH_KEY];
  try {
    const auth = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const flow = PROVIDER_USAGE_CONFIGS[auth?.provider]?.browser;
    if (!flow) return null;
    const token = flow.requiresToken ? normalizeDeepSeekUserToken(auth?.token) : null;
    if (flow.requiresToken && !token) return null;
    const cookies = serializeUsageCookies(auth.cookies, flow.isCookieDomain);
    if (!flow.requiresToken && !cookies.length) return null;
    return { ...auth, token, cookies };
  } catch { return null; }
};

const saveProviderUsageAuth = (accountId, config, token, connectedAt = new Date().toISOString(), cookies = []) => {
  const auth = { version: 2, provider: config.id, mode: 'official-account', token: token || null, cookies: serializeUsageCookies(cookies, config.browser.isCookieDomain), connectedAt, updatedAt: new Date().toISOString() };
  store.saveCredential(accountId, '', { [PROVIDER_USAGE_AUTH_KEY]: JSON.stringify(auth) });
  return auth;
};

const withAccountUsageConnection = (accountId, updater) => {
  const current = migrateState(store.loadState());
  if (!current) throw new Error('桌面状态尚未初始化');
  let found = false;
  const accounts = (current.accounts || []).map((account) => {
    if (account.id !== accountId) return account;
    found = true;
    return updater(account);
  });
  if (!found) throw new Error('找不到要连接的账号');
  const saved = store.saveState(cleanState({ ...current, accounts }));
  sendState(saved);
  return saved;
};

const markProviderUsageConnected = (accountId, config, connectedAt, incrementRevision = true) => withAccountUsageConnection(accountId, (account) => {
  const previous = account.usageConnection || {};
  return {
    ...account,
    usageConnection: {
      provider: config.id,
      mode: 'official-account',
      status: 'connected',
      connectedAt: connectedAt || previous.connectedAt || new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      lastError: null,
      revision: Number(previous.revision || 0) + (incrementRevision ? 1 : 0),
    },
  };
});

const markProviderUsageExpired = (accountId, config, message = '') => withAccountUsageConnection(accountId, (account) => {
  const previous = account.usageConnection || {};
  return {
    ...account,
    usageConnection: {
      provider: config.id,
      mode: 'official-account',
      status: 'reauth_required',
      connectedAt: previous.connectedAt || null,
      checkedAt: new Date().toISOString(),
      lastError: message || config.expiredMessage,
      revision: Number(previous.revision || 0),
    },
  };
});

const clearProviderUsageCache = (accountId) => {
  for (const key of providerUsageCache.keys()) if (key.startsWith(`${accountId}:`)) providerUsageCache.delete(key);
};

const rememberProviderUsageWindow = (accountId, window) => {
  const windows = providerUsageWindows.get(accountId) || new Set();
  windows.add(window);
  providerUsageWindows.set(accountId, windows);
  window.once('closed', () => {
    windows.delete(window);
    if (windows.size === 0) providerUsageWindows.delete(accountId);
  });
};

const rememberProviderUsageSession = (accountId, usageSession) => {
  const sessions = providerUsageSessions.get(accountId) || new Set();
  sessions.add(usageSession);
  providerUsageSessions.set(accountId, sessions);
  return () => {
    sessions.delete(usageSession);
    if (sessions.size === 0) providerUsageSessions.delete(accountId);
  };
};

const closeProviderUsageWindows = (accountId) => {
  for (const window of [...(providerUsageWindows.get(accountId) || [])]) {
    if (!window.isDestroyed()) window.destroy();
  }
  providerUsageWindows.delete(accountId);
};

const clearProviderUsageBrowserStorage = async (accountId, targetSession = null) => {
  const sessions = targetSession ? [targetSession] : [...(providerUsageSessions.get(accountId) || [])];
  const results = await Promise.all(sessions.map(async (usageSession) => {
    try {
      await Promise.all([usageSession.clearStorageData(), usageSession.clearCache()]);
      return true;
    } catch (error) {
      console.error('[Quota Desk] failed to clear in-memory provider login storage', error?.message || error);
      return false;
    }
  }));
  return results.every(Boolean);
};

const clearProviderUsageSession = async (accountId) => {
  closeProviderUsageWindows(accountId);
  clearProviderUsageCache(accountId);
  await clearProviderUsageBrowserStorage(accountId);
};

const scrubLegacyProviderUsagePartitions = async () => {
  const accountIds = (migrateState(store.loadState())?.accounts || []).map((account) => account.id);
  await Promise.all(accountIds.map(async (accountId) => {
    const legacySession = session.fromPartition(legacyProviderUsagePartition(accountId));
    try { await Promise.all([legacySession.clearStorageData(), legacySession.clearCache()]); }
    catch (error) { console.warn('[Quota Desk] failed to scrub legacy DeepSeek login storage', error?.message || error); }
  }));
};

const deleteAccountLocalData = async (accountId) => {
  bumpProviderUsageEpoch(accountId);
  abortProviderUsageRequests(accountId);
  closeProviderUsageWindows(accountId);
  clearProviderUsageCache(accountId);
  // The auxiliary session is memory-only. Always remove the encrypted credential even
  // if Chromium cannot eagerly release its in-process cache.
  await clearProviderUsageSession(accountId);
  store.deleteCredential(accountId);
  return true;
};

const providerUsageDateRange = (config, days) => {
  const count = Math.min(365, Math.max(7, Math.round(Number(days) || 180)));
  const offset = Number.isInteger(config.timezoneOffsetSec) ? config.timezoneOffsetSec : 8 * 60 * 60;
  const shiftedNow = new Date(Date.now() + offset * 1000);
  const endOrdinal = Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate());
  const startOrdinal = endOrdinal - (count - 1) * 24 * 60 * 60 * 1000;
  return {
    days: count,
    startDate: new Date(startOrdinal).toISOString().slice(0, 10),
    endDate: new Date(endOrdinal).toISOString().slice(0, 10),
  };
};

const readDeepSeekTokenFromWindow = async (window) => {
  if (!window || window.isDestroyed()) return '';
  try {
    const currentUrl = new URL(window.webContents.getURL());
    if (currentUrl.origin !== DEEPSEEK_PLATFORM_ORIGIN) return '';
    const raw = await window.webContents.executeJavaScript(`(() => {
      for (const storage of [window.localStorage, window.sessionStorage]) {
        const value = storage.getItem('userToken');
        if (value) return value;
      }
      return '';
    })()`, true);
    return normalizeDeepSeekUserToken(raw);
  } catch { return ''; }
};

// 各厂商官方用量能力配置。browser-token 走登录窗口；api-key 直接复用账号凭据。
const PROVIDER_USAGE_CONFIGS = {
  deepseek: {
    id: 'deepseek',
    mode: 'browser-token',
    timezoneOffsetSec: DEEPSEEK_TIMEZONE_OFFSET_SEC,
    missingAuthMessage: '尚未连接 DeepSeek 官方账号',
    expiredMessage: 'DeepSeek 官方账号登录已过期，请重新连接',
    browser: {
      loginUrl: DEEPSEEK_USAGE_URL,
      loginTitle: '连接 DeepSeek 官方账号',
      isAllowedLoginUrl: isAllowedDeepSeekLoginUrl,
      isCookieDomain: isDeepSeekCookieDomain,
      requiresToken: true,
      readCredential: readDeepSeekTokenFromWindow,
      validate: (auth, sessionFetch, signal) => fetchDeepSeekSummary(auth.token, sessionFetch, { timeoutMs: 15_000, signal }),
      fetchUsage: (auth, sessionFetch, options) => fetchDeepSeekUsage(auth.token, sessionFetch, options),
    },
  },
  zai: {
    id: 'zai',
    mode: 'api-key',
    timezoneOffsetSec: ZAI_USAGE_TIMEZONE_OFFSET_SEC,
    missingAuthMessage: '尚未连接 Z.ai 官方用量',
    expiredMessage: 'Z.ai API Key 无效或已过期，请更新凭据后重新连接',
    readApiKey: (accountId) => {
      const secrets = store.getSecrets(accountId);
      const apiKey = normalizeZaiApiKey(secrets.variables?.apiKey || secrets.credential);
      if (!apiKey) {
        const error = new Error('账号凭据中没有 Z.ai API Key，请先在账号设置中填写');
        error.code = 'AUTH_MISSING';
        throw error;
      }
      return apiKey;
    },
    buildUsageOptions: (account, provider) => ({
      origin: normalizeZaiOrigin(account?.variables?.endpoint || account?.endpoint || provider?.requestConfig?.endpoint || ''),
    }),
    validateApiKey: (apiKey, sessionFetch, usageOptions) => fetchZaiPlanSummary(apiKey, sessionFetch, { origin: usageOptions.origin, timeoutMs: 15_000 }),
    fetchUsage: (apiKey, sessionFetch, usageOptions) => fetchZaiUsage(apiKey, sessionFetch, usageOptions),
  },
  codex: {
    id: 'codex',
    mode: 'cli-oauth',
    // token-activity 的桶日期是服务端本地日历日（UTC 口径），不做时区平移
    timezoneOffsetSec: 0,
    missingAuthMessage: '尚未连接 Codex 官方用量',
    expiredMessage: 'Codex 本机登录已失效，请运行一次 Codex CLI 或重新导入登录快照',
  },
  minimax: {
    id: 'minimax',
    mode: 'browser-cookie',
    timezoneOffsetSec: 8 * 60 * 60,
    missingAuthMessage: '尚未连接 MiniMax 官方账号',
    expiredMessage: 'MiniMax 官方账号登录已过期，请重新连接',
    browser: {
      loginUrl: 'https://platform.minimaxi.com/user-center/payment/coding-plan?cycle_type=3',
      loginTitle: '连接 MiniMax 官方账号',
      isAllowedLoginUrl: isAllowedMinimaxLoginUrl,
      isCookieDomain: isMinimaxCookieDomain,
      requiresToken: false,
      readCredential: null,
      validate: (_auth, sessionFetch, signal) => probeMinimaxSession(sessionFetch, { timeoutMs: 15_000, signal }),
      fetchUsage: (_auth, sessionFetch, options) => fetchMinimaxUsage(sessionFetch, options),
    },
  },
};

const captureBrowserUsageLogin = async (config, { accountId, interactive, timeoutMs = 0, cookies = [] }) => {
  const flow = config.browser;
  const partition = providerUsagePartition(accountId);
  const usageSession = session.fromPartition(partition);
  const forgetSession = rememberProviderUsageSession(accountId, usageSession);
  const validationController = new AbortController();
  try {
    await clearProviderUsageBrowserStorage(accountId, usageSession);
    await usageSession.setProxy(currentProxyConfig());
    await restoreUsageCookies(usageSession, cookies, flow.isCookieDomain);
    usageSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    usageSession.setPermissionCheckHandler(() => false);
    return await new Promise((resolve) => {
      const loginWindow = new BrowserWindow({
        width: 460,
        height: 650,
        minWidth: 400,
        minHeight: 520,
        show: false,
        parent: interactive ? mainWindow : undefined,
        modal: Boolean(interactive && mainWindow),
        autoHideMenuBar: true,
        title: flow.loginTitle,
        backgroundColor: themeColors(savedTheme()).main,
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      rememberProviderUsageWindow(accountId, loginWindow);
      let settled = false;
      let validating = false;
      let lastRejectedCredential = '';
      let lastAttemptedCredential = '';
      let lastAttemptedAt = 0;
      let timer = null;
      let interval = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        validationController.abort();
        if (timer) clearTimeout(timer);
        if (interval) clearInterval(interval);
        if (!loginWindow.isDestroyed()) loginWindow.destroy();
        resolve(result);
      };
      const inspect = async () => {
        if (settled || validating || loginWindow.isDestroyed()) return;
        const credential = flow.requiresToken ? await flow.readCredential(loginWindow) : '';
        const now = Date.now();
        if (flow.requiresToken && (!credential || credential === lastRejectedCredential)) return;
        if (credential === lastAttemptedCredential && now - lastAttemptedAt < 3_000) return;
        // cookie 模式没有本地凭据可比对，按时间节流，避免登录过程中反复打验证接口
        if (!flow.requiresToken && now - lastAttemptedAt < 5_000) return;
        lastAttemptedCredential = credential;
        lastAttemptedAt = now;
        validating = true;
        try {
          // A successful validation proves the captured credential without making
          // history requests every time the inspection interval fires.
          await flow.validate({ token: credential }, (url, init) => usageSession.fetch(url, init), validationController.signal);
          let capturedCookies = [];
          try { capturedCookies = await readUsageCookies(usageSession, flow.isCookieDomain); } catch {}
          finish({ token: credential || null, cookies: capturedCookies, validatedAt: new Date().toISOString() });
        } catch (error) {
          if (error?.code === 'AUTH_EXPIRED' || error?.code === 'AUTH_MISSING') lastRejectedCredential = credential;
        } finally { validating = false; }
      };
      loginWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (flow.isAllowedLoginUrl(url)) loginWindow.loadURL(url).catch(() => {});
        return { action: 'deny' };
      });
      for (const eventName of ['will-navigate', 'will-redirect']) {
        loginWindow.webContents.on(eventName, (event, url) => {
          if (!flow.isAllowedLoginUrl(url)) event.preventDefault();
        });
      }
      loginWindow.webContents.on('did-finish-load', inspect);
      loginWindow.webContents.on('did-navigate-in-page', inspect);
      loginWindow.on('closed', () => finish(null));
      if (interactive) loginWindow.once('ready-to-show', () => { loginWindow.show(); loginWindow.focus(); });
      interval = setInterval(inspect, 900);
      if (timeoutMs > 0) timer = setTimeout(() => finish(null), timeoutMs);
      loginWindow.loadURL(flow.loginUrl).catch(() => {});
    });
  } finally {
    validationController.abort();
    // The browser partition is memory-only, but clear it immediately as well. Only the
    // cookies captured above survive, encrypted inside providerUsageAuth.
    await clearProviderUsageBrowserStorage(accountId, usageSession);
    forgetSession();
  }
};

const connectBrowserUsage = async (config, accountId) => {
  const existing = providerUsageLoginFlows.get(accountId);
  const currentEpoch = providerUsageEpoch(accountId);
  if (existing?.epoch === currentEpoch) return existing.flow;
  const epoch = bumpProviderUsageEpoch(accountId);
  abortProviderUsageRequests(accountId);
  closeProviderUsageWindows(accountId);
  const previous = readProviderUsageAuth(accountId);
  const flow = (async () => {
    const result = await captureBrowserUsageLogin(config, { accountId, interactive: true, cookies: previous?.cookies });
    if (!result) return { cancelled: true };
    assertProviderUsageEpoch(accountId, epoch);
    let auth = null;
    try {
      auth = saveProviderUsageAuth(accountId, config, result.token, previous?.connectedAt, result.cookies);
      clearProviderUsageCache(accountId);
      const state = markProviderUsageConnected(accountId, config, auth.connectedAt, true);
      return { cancelled: false, connection: state.accounts.find((item) => item.id === accountId)?.usageConnection, state: { ...state, runtime: runtimeStatus() } };
    } catch (error) {
      // The account may have been deleted while its modal login was completing.
      if (auth) {
        try { store.deleteSecretVariable(accountId, PROVIDER_USAGE_AUTH_KEY); } catch {}
        await clearProviderUsageSession(accountId).catch(() => {});
      }
      throw error;
    }
  })();
  const entry = { epoch, flow };
  providerUsageLoginFlows.set(accountId, entry);
  try { return await flow; }
  finally { if (providerUsageLoginFlows.get(accountId) === entry) providerUsageLoginFlows.delete(accountId); }
};

// api-key 模式（Z.ai）：不弹登录窗口，直接用账号已保存的凭据验证一次即连接
const connectApiKeyUsage = async (accountId, account, provider) => {
  const config = PROVIDER_USAGE_CONFIGS[account.providerId];
  const existing = providerUsageLoginFlows.get(accountId);
  const currentEpoch = providerUsageEpoch(accountId);
  if (existing?.epoch === currentEpoch) return existing.flow;
  const epoch = bumpProviderUsageEpoch(accountId);
  abortProviderUsageRequests(accountId);
  closeProviderUsageWindows(accountId);
  const flow = (async () => {
    assertProviderUsageEpoch(accountId, epoch);
    const credential = config.readApiKey(accountId);
    const usageOptions = config.buildUsageOptions ? config.buildUsageOptions(account, provider) : {};
    await withProviderUsageFetchSession(accountId, (sessionFetch) => config.validateApiKey(credential, sessionFetch, usageOptions));
    assertProviderUsageEpoch(accountId, epoch);
    clearProviderUsageCache(accountId);
    const state = markProviderUsageConnected(accountId, config, account.usageConnection?.connectedAt || new Date().toISOString(), true);
    return { cancelled: false, connection: state.accounts.find((item) => item.id === accountId)?.usageConnection, state: { ...state, runtime: runtimeStatus() } };
  })();
  const entry = { epoch, flow };
  providerUsageLoginFlows.set(accountId, entry);
  try { return await flow; }
  finally { if (providerUsageLoginFlows.get(accountId) === entry) providerUsageLoginFlows.delete(accountId); }
};

const connectProviderUsage = async (accountId) => {
  const state = migrateState(store.loadState());
  const account = (state?.accounts || []).find((item) => item.id === accountId);
  if (!account) throw new Error('找不到要连接的账号');
  const config = PROVIDER_USAGE_CONFIGS[account.providerId];
  if (!config) throw new Error('该厂商暂不支持官方账号登录');
  const provider = (state?.providers || []).find((item) => item.id === account.providerId);
  if (config.mode === 'api-key') return connectApiKeyUsage(accountId, account, provider);
  if (config.mode === 'cli-oauth') return connectCliUsage(accountId, account);
  return connectBrowserUsage(config, accountId);
};

const recoverBrowserUsageAuth = async (config, accountId, epoch) => {
  const existing = providerUsageRecoveryFlows.get(accountId);
  if (existing?.epoch === epoch) return existing.flow;
  const flow = (async () => {
    assertProviderUsageEpoch(accountId, epoch);
    const previous = readProviderUsageAuth(accountId);
    const result = await captureBrowserUsageLogin(config, { accountId, interactive: false, timeoutMs: 15_000, cookies: previous?.cookies });
    if (!result) return null;
    assertProviderUsageEpoch(accountId, epoch);
    let auth = null;
    try {
      auth = saveProviderUsageAuth(accountId, config, result.token, previous?.connectedAt, result.cookies);
      clearProviderUsageCache(accountId);
      markProviderUsageConnected(accountId, config, auth.connectedAt, true);
      return auth;
    } catch (error) {
      if (auth) {
        try { store.deleteSecretVariable(accountId, PROVIDER_USAGE_AUTH_KEY); } catch {}
        await clearProviderUsageSession(accountId).catch(() => {});
      }
      throw error;
    }
  })();
  const entry = { epoch, flow };
  providerUsageRecoveryFlows.set(accountId, entry);
  try { return await flow; }
  finally { if (providerUsageRecoveryFlows.get(accountId) === entry) providerUsageRecoveryFlows.delete(accountId); }
};

// 免登录模式（api-key 等）共用的内存会话请求通道：隔离浏览器存储、走系统代理
const withProviderUsageFetchSession = async (accountId, fn) => {
  const partition = providerUsagePartition(accountId);
  const usageSession = session.fromPartition(partition);
  const forgetSession = rememberProviderUsageSession(accountId, usageSession);
  try {
    await clearProviderUsageBrowserStorage(accountId, usageSession);
    await usageSession.setProxy(currentProxyConfig());
    return await fn((url, init) => usageSession.fetch(url, init));
  } finally {
    await clearProviderUsageBrowserStorage(accountId, usageSession);
    forgetSession();
  }
};

const queryBrowserUsageData = async (config, accountId, epoch, range, timeoutMs, signal) => {
  let auth = readProviderUsageAuth(accountId);
  if (!auth) {
    const currentAccount = migrateState(store.loadState())?.accounts?.find((item) => item.id === accountId);
    if (currentAccount?.usageConnection && providerUsageEpoch(accountId) === epoch) markProviderUsageExpired(accountId, config);
    const error = new Error(config.missingAuthMessage);
    error.code = 'AUTH_MISSING';
    throw error;
  }
  const assertCurrentAuth = () => {
    assertProviderUsageEpoch(accountId, epoch);
    const latest = readProviderUsageAuth(accountId);
    if (!latest || latest.token !== auth.token || JSON.stringify(latest.cookies) !== JSON.stringify(auth.cookies)) throw providerUsageCancelledError();
    if (!migrateState(store.loadState())?.accounts?.some((item) => item.id === accountId)) throw providerUsageCancelledError();
  };
  const request = async () => {
    const partition = providerUsagePartition(accountId);
    const usageSession = session.fromPartition(partition);
    const forgetSession = rememberProviderUsageSession(accountId, usageSession);
    try {
      await clearProviderUsageBrowserStorage(accountId, usageSession);
      await usageSession.setProxy(currentProxyConfig());
      await restoreUsageCookies(usageSession, auth.cookies, config.browser.isCookieDomain);
      return await config.browser.fetchUsage(auth, (url, init) => usageSession.fetch(url, init), {
        startDate: range.startDate,
        endDate: range.endDate,
        timezoneOffsetSec: config.timezoneOffsetSec,
        timeoutMs,
        signal,
      });
    } finally {
      await clearProviderUsageBrowserStorage(accountId, usageSession);
      forgetSession();
    }
  };
  let data;
  try { data = await request(); }
  catch (error) {
    if (error?.code !== 'AUTH_EXPIRED') throw error;
    assertCurrentAuth();
    auth = await recoverBrowserUsageAuth(config, accountId, epoch);
    if (!auth) {
      if (providerUsageEpoch(accountId) === epoch) markProviderUsageExpired(accountId, config);
      throw error;
    }
    try { data = await request(); }
    catch (retryError) {
      if (retryError?.code === 'AUTH_EXPIRED' && providerUsageEpoch(accountId) === epoch) markProviderUsageExpired(accountId, config);
      throw retryError;
    }
  }
  assertCurrentAuth();
  markProviderUsageConnected(accountId, config, auth.connectedAt, false);
  return data;
};

// api-key 模式查询：凭据来自账号本身，key 轮换后自动生效；鉴权失败只标记过期，不做静默恢复
const queryApiKeyUsageData = async (config, accountId, account, provider, epoch, range, timeoutMs, signal) => {
  let credential;
  try {
    credential = config.readApiKey(accountId);
  } catch (error) {
    if (account.usageConnection && providerUsageEpoch(accountId) === epoch) markProviderUsageExpired(accountId, config, error.message);
    throw error;
  }
  try {
    const usageOptions = {
      startDate: range.startDate,
      endDate: range.endDate,
      timezoneOffsetSec: config.timezoneOffsetSec,
      timeoutMs,
      signal,
      ...(config.buildUsageOptions ? config.buildUsageOptions(account, provider) : {}),
    };
    const data = await withProviderUsageFetchSession(accountId, (sessionFetch) => config.fetchUsage(credential, sessionFetch, usageOptions));
    assertProviderUsageEpoch(accountId, epoch);
    markProviderUsageConnected(accountId, config, account.usageConnection?.connectedAt || new Date().toISOString(), false);
    return data;
  } catch (error) {
    if ((error?.code === 'AUTH_EXPIRED' || error?.code === 'AUTH_MISSING') && providerUsageEpoch(accountId) === epoch) {
      markProviderUsageExpired(accountId, config, error.message);
    }
    throw error;
  }
};

// cli-oauth 模式查询（Codex）：复用本机 CLI 登录快照，token 过期时经 fetchWithCliAuth
// 自动续期并回写快照；续期后仍 401/403 才判定为登录失效，不做网页恢复
const queryCliUsageData = async (config, accountId, account, epoch, range, timeoutMs, signal) => {
  const resolved = resolveCliAuth('codex', store.getSecrets(accountId).variables);
  if (!resolved) {
    const message = '未检测到 Codex 的 ChatGPT 登录（~/.codex/auth.json 无 OAuth tokens），可先「导入本机 CLI 登录」保存为账号快照';
    if (account.usageConnection && providerUsageEpoch(accountId) === epoch) markProviderUsageExpired(accountId, config, message);
    const error = new Error(message);
    error.code = 'AUTH_MISSING';
    throw error;
  }
  try {
    const payload = await withProviderUsageFetchSession(accountId, async (sessionFetch) => {
      const response = await fetchWithCliAuth('codex', {
        auth: resolved.auth,
        source: resolved.source,
        fetcher: sessionFetch,
        timeoutMs,
        buildRequest: buildCodexUsageRequest,
        onAuthUpdate: (kind, next, previous, source) => persistCliAuthUpdate(accountId, { kind, next, previous, source }),
      });
      if (response.status === 401 || response.status === 403) {
        throw new ProviderUsageError(config.expiredMessage, 'AUTH_EXPIRED', response.status);
      }
      if (!response.ok) throw new ProviderUsageError(`ChatGPT 用量接口返回 HTTP ${response.status}`, 'HTTP_ERROR', response.status);
      return response.json();
    });
    if (signal?.aborted) throw providerUsageCancelledError();
    assertProviderUsageEpoch(accountId, epoch);
    const data = normalizeCodexTokenUsage(payload, {
      startDate: range.startDate,
      endDate: range.endDate,
      timezoneOffsetSec: config.timezoneOffsetSec,
    });
    markProviderUsageConnected(accountId, config, account.usageConnection?.connectedAt || new Date().toISOString(), false);
    return data;
  } catch (error) {
    if ((error?.code === 'AUTH_EXPIRED' || error?.code === 'AUTH_MISSING') && providerUsageEpoch(accountId) === epoch) {
      markProviderUsageExpired(accountId, config, error.message);
    }
    throw error;
  }
};

// cli-oauth 模式连接：不弹登录窗口，取一次用量档案验证本机登录态即连接
const connectCliUsage = async (accountId, account) => {
  const config = PROVIDER_USAGE_CONFIGS[account.providerId];
  const existing = providerUsageLoginFlows.get(accountId);
  const currentEpoch = providerUsageEpoch(accountId);
  if (existing?.epoch === currentEpoch) return existing.flow;
  const epoch = bumpProviderUsageEpoch(accountId);
  abortProviderUsageRequests(accountId);
  closeProviderUsageWindows(accountId);
  const flow = (async () => {
    assertProviderUsageEpoch(accountId, epoch);
    const probeRange = providerUsageDateRange(config, 7);
    await queryCliUsageData(config, accountId, account, epoch, probeRange, 15_000, null);
    assertProviderUsageEpoch(accountId, epoch);
    clearProviderUsageCache(accountId);
    const state = markProviderUsageConnected(accountId, config, account.usageConnection?.connectedAt || new Date().toISOString(), true);
    return { cancelled: false, connection: state.accounts.find((item) => item.id === accountId)?.usageConnection, state: { ...state, runtime: runtimeStatus() } };
  })();
  const entry = { epoch, flow };
  providerUsageLoginFlows.set(accountId, entry);
  try { return await flow; }
  finally { if (providerUsageLoginFlows.get(accountId) === entry) providerUsageLoginFlows.delete(accountId); }
};

const queryProviderUsage = async (accountId, options = {}) => {
  const state = migrateState(store.loadState());
  const account = (state?.accounts || []).find((item) => item.id === accountId);
  if (!account) throw new Error('找不到要查询的账号');
  const config = PROVIDER_USAGE_CONFIGS[account.providerId];
  if (!config) throw new Error('该厂商暂不支持官方账号用量');
  const provider = (state?.providers || []).find((item) => item.id === account.providerId);
  const epoch = providerUsageEpoch(accountId);
  const range = providerUsageDateRange(config, options.days);
  const cacheKey = `${accountId}:${range.startDate}:${range.endDate}`;
  const cached = providerUsageCache.get(cacheKey);
  if (cached?.epoch === epoch && shouldUseCachedUsage(cached, { force: options.force === true, maxAgeMs: PROVIDER_USAGE_CACHE_MS })) return cached.data;
  const timeoutMs = Math.min(120_000, Math.max(5_000, Number(options.timeoutMs) || 20_000));
  const requestController = new AbortController();
  const forgetRequest = rememberProviderUsageRequest(accountId, requestController);
  try {
    const data = config.mode === 'api-key'
      ? await queryApiKeyUsageData(config, accountId, account, provider, epoch, range, timeoutMs, requestController.signal)
      : config.mode === 'cli-oauth'
        ? await queryCliUsageData(config, accountId, account, epoch, range, timeoutMs, requestController.signal)
        : await queryBrowserUsageData(config, accountId, epoch, range, timeoutMs, requestController.signal);
    assertProviderUsageEpoch(accountId, epoch);
    providerUsageCache.set(cacheKey, { at: Date.now(), epoch, data });
    return data;
  } finally {
    forgetRequest();
  }
};

const disconnectProviderUsage = async (accountId) => {
  bumpProviderUsageEpoch(accountId);
  abortProviderUsageRequests(accountId);
  closeProviderUsageWindows(accountId);
  store.deleteSecretVariable(accountId, PROVIDER_USAGE_AUTH_KEY);
  await clearProviderUsageSession(accountId);
  const state = withAccountUsageConnection(accountId, (account) => {
    const { usageConnection, ...rest } = account;
    return rest;
  });
  return { state: { ...state, runtime: runtimeStatus() } };
};

const notifyWaste = (state, account, provider) => {
  if (!state.settings?.alerts || !Notification.isSupported()) return;
  const rules = Array.isArray(state.settings.reminderRules) ? state.settings.reminderRules : [];
  if (!rules.length) return;
  for (const item of account.windows || []) {
    if (!item.resetAt || item.available === false) continue;
    const remainingMs = new Date(item.resetAt).getTime() - Date.now();
    const rule = rules.find((candidate) => Number(item.remaining) >= Number(candidate.minRemaining || 0) && remainingMs > 0 && remainingMs <= Number(candidate.beforeMinutes || 0) * 60_000);
    if (!rule) continue;
    const reminderKey = `${account.id}:${item.key}:${item.resetAt}:${rule.id}`;
    if (sentReminders.has(reminderKey)) continue;
    sentReminders.add(reminderKey);
    // 点击通知呼起主窗口。Windows Toast 的点击激活依赖开始菜单快捷方式上登记的
    // AppUserModelID（NSIS 安装自带；便携版/开发模式没有该快捷方式，点击不响应属系统限制）
    const notification = new Notification({ title: rule.label || '额度即将刷新', body: `${provider.name} · ${account.name} · ${Math.round(item.remaining)}% · ${Math.ceil(remainingMs / 60_000)} 分钟后刷新。` });
    notification.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
    notification.show();
  }
};

async function pollState(accountIds = null) {
  const current = migrateState(store.loadState());
  if (!current) throw new Error('桌面状态尚未初始化');
  pollInProgress = true;
  sendState(current);
  const ids = accountIds ? new Set(accountIds) : null;
  const nextAccounts = [];
  const processedIds = new Set();
  const originalAccounts = new Map((current.accounts || []).map((account) => [account.id, account]));
  for (const account of current.accounts || []) {
    // 定时巡检跳过停用账号（数据冻结、不产生新历史点与提醒）；点名轮询不受限，
    // 「测试连接」与启用后的立即补拉都靠它验证停用中的账号
    if (account.disabled && !ids) { nextAccounts.push(account); continue; }
    if (ids && !ids.has(account.id)) { nextAccounts.push(account); continue; }
    processedIds.add(account.id);
    const provider = (current.providers || []).find((item) => item.id === account.providerId);
    if (!provider) {
      nextAccounts.push({ ...account, status: 'warning', lastError: '找不到厂商配置', lastChecked: new Date().toISOString() });
      continue;
    }
    try {
      const secrets = store.getSecrets(account.id);
      const windows = await queryAccount(account, provider, secrets.credential, net.fetch, secrets.variables, {
        onCliAuth: ({ kind, next, previous, source }) => persistCliAuthUpdate(account.id, { kind, next, previous, source }),
        // 网络重试时重新读凭据：上一次尝试可能已续期并轮换 refresh_token，继续用旧值会被判复用
        getSecretVariables: () => store.getSecrets(account.id).variables,
      });
      const checkedAt = new Date().toISOString();
      // 查询成功后刷新身份信息（续期后的最新凭据重新解析一次）
      const identityPatch = cliIdentityPatch(account, provider.requestConfig?.adapterMode, store.getSecrets(account.id));
      const updated = { ...account, ...(identityPatch || {}), windows, status: 'active', authStatus: null, lastError: null, lastChecked: checkedAt, lastTestAt: checkedAt };
      nextAccounts.push(updated);
      store.appendHistory(account.id, windows, historyRetentionDays());
      // 周期浪费归档：从该账号历史中提取已结束的周期（周/月等厂商预设窗口），永久保存
      store.archiveCycles(account.id, resolveWasteWindows(provider.requestConfig));
      notifyWaste(current, updated, provider);
    } catch (error) {
      const checkedAt = new Date().toISOString();
      nextAccounts.push({ ...account, status: 'warning', authStatus: authStatusForPollError(error), lastError: error.message, lastChecked: checkedAt, lastTestAt: checkedAt });
    }
  }
  // Network requests above yield to other IPC work. Merge only polling-owned fields
  // into the newest state so a concurrent settings edit, account deletion, or
  // DeepSeek usage connect/disconnect cannot be overwritten by this older snapshot.
  const latest = migrateState(store.loadState()) || current;
  const polledAccounts = new Map(nextAccounts.map((account) => [account.id, account]));
  const mergedAccounts = (latest.accounts || []).map((latestAccount) => {
    if (!processedIds.has(latestAccount.id)) return latestAccount;
    const polled = polledAccounts.get(latestAccount.id);
    const original = originalAccounts.get(latestAccount.id);
    if (!polled || !original) return latestAccount;
    const merged = { ...latestAccount };
    for (const key of ['windows', 'status', 'authStatus', 'lastError', 'lastChecked', 'lastTestAt']) {
      if (Object.prototype.hasOwnProperty.call(polled, key)) merged[key] = polled[key];
    }
    for (const key of ['identity', 'cliFingerprint', 'cliAuthSource']) {
      if (polled[key] !== original[key] && latestAccount[key] === original[key]) merged[key] = polled[key];
    }
    return merged;
  });
  const next = cleanState({ ...latest, accounts: mergedAccounts, lastSync: new Date().toISOString() });
  store.saveState(next);
  pollInProgress = false;
  refreshLiveIdentities();
  sendState(next);
  return next;
}

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  const state = store.loadState();
  const minutes = Math.min(30, Math.max(1, Number(state?.settings?.pollMinutes) || 5));
  pollStartedAt ||= new Date().toISOString();
  nextPollAt = new Date(Date.now() + minutes * 60_000).toISOString();
  pollTimer = setInterval(() => {
    pollState().catch(() => {}).finally(() => {
      nextPollAt = new Date(Date.now() + minutes * 60_000).toISOString();
      // 其他置顶程序后来激活可能压到浮窗，每次轮询后顺手补一次置顶
      ensureWidgetOnTop();
    });
  }, minutes * 60_000);
}

function createMainWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 520;
  const height = 470;
  mainWindow = new BrowserWindow({
    width, height, minWidth: width, minHeight: height, maxWidth: width, maxHeight: height,
    resizable: false, maximizable: false, minimizable: false, movable: true, show: false,
    frame: false,
    x: area.x + area.width - width,
    y: area.y + area.height - height,
    skipTaskbar: true,
    backgroundColor: themeColors(savedTheme()).main, title: 'Quota Desk', icon: loadAppIcon(), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: preloadPath },
  });
  mainWindow.loadFile(distPath);
  // Windows 上只有一个真正生效的置顶层，主窗口置顶后与浮窗同层、激活即会盖到浮窗上；
  // 主窗口显示/被激活时把浮窗压回自己上方，保证自家浮窗永不被主界面挡住
  mainWindow.on('show', () => {
    if (!mainWindow.isAlwaysOnTop()) return;
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.moveTop();
    ensureWidgetOnTop();
  });
  mainWindow.on('focus', () => { if (mainWindow.isAlwaysOnTop()) ensureWidgetOnTop(); });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => console.error('[Quota Desk] load failed', code, description, url));
  mainWindow.webContents.on('render-process-gone', (_event, details) => console.error('[Quota Desk] renderer gone', details.reason));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Electron 43 回归：alwaysOnTop 构造参数与默认 'floating' 级别的 setAlwaysOnTop(true)
// 均不再真正生效，必须显式给非默认级别（'screen-saver'，Windows 上同为 HWND_TOPMOST）。
// 另外浮窗经 hide() 后再显示、Win+D 显示桌面等场景也可能丢失置顶，展示后统一补一次。
function ensureWidgetOnTop() {
  if (!widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isVisible()) return;
  widgetWindow.setAlwaysOnTop(true, 'screen-saver');
  widgetWindow.moveTop();
}

function createWidgetWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  widgetScale = savedWidgetScale();
  widgetLength = savedWidgetLength();
  const size = widgetWindowSize(widgetScale, widgetLength);
  widgetWindow = new BrowserWindow({
    width: size.width, height: size.height, x: Math.max(0, width - size.width - 16), y: Math.max(0, height - size.height - 14),
    minWidth: widgetWindowSize(0.8, WIDGET_MIN_LENGTH).width, maxWidth: widgetWindowSize(3, WIDGET_MAX_LENGTH).width, minHeight: widgetWindowSize(0.8).height, maxHeight: widgetWindowSize(1.5).height,
    frame: false, resizable: false, movable: true, skipTaskbar: true, alwaysOnTop: true, show: false,
    backgroundColor: themeColors(savedTheme()).widget, title: 'Quota Desk 浮窗',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: preloadPath },
  });
  widgetWindow.loadFile(distPath, { query: { widget: '1' } });
  widgetWindow.once('ready-to-show', () => { widgetWindow.showInactive(); ensureWidgetOnTop(); });
  // 系统恢复可见（显示桌面还原等）时同样补一次置顶
  widgetWindow.on('show', ensureWidgetOnTop);
  widgetWindow.on('restore', ensureWidgetOnTop);
  // 浮窗右键弹出与托盘一致的菜单
  widgetWindow.webContents.on('context-menu', (event) => {
    event.preventDefault();
    buildTrayMenu().popup({ window: widgetWindow });
  });
  widgetWindow.on('closed', () => { widgetWindow = null; });
}

// 浮窗大小/长度调整：接收缩放比例与长度比例，窗口像素尺寸按基准尺寸换算，右下角保持不动
function applyWidgetSize(scale, length) {
  widgetScale = clampWidgetScale(scale);
  widgetLength = clampWidgetLength(length ?? widgetLength);
  const size = widgetWindowSize(widgetScale, widgetLength);
  if (!widgetWindow || widgetWindow.isDestroyed()) return widgetScale;
  const bounds = widgetWindow.getBounds();
  const area = screen.getPrimaryDisplay().workArea;
  const x = Math.max(area.x, Math.min(area.x + area.width - size.width, bounds.x + bounds.width - size.width));
  const y = Math.max(area.y, Math.min(area.y + area.height - size.height, bounds.y + bounds.height - size.height));
  widgetWindow.setBounds({ x, y, width: size.width, height: size.height });
  return widgetScale;
}

function applyTheme(theme) {
  const colors = themeColors(theme === 'light' ? 'light' : 'dark');
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(colors.main);
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.setBackgroundColor(colors.widget);
  return true;
}

function setWidgetVisible(visible) {
  if (!widgetWindow || widgetWindow.isDestroyed()) { if (visible) createWidgetWindow(); return visible; }
  if (visible) { widgetWindow.showInactive(); ensureWidgetOnTop(); } else widgetWindow.hide();
  return visible;
}

function createTrayIcon() {
  const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="16" fill="#202c2e"/><rect x="13" y="36" width="9" height="16" rx="4" fill="#91d4ad"/><rect x="28" y="24" width="9" height="28" rx="4" fill="#d8f2df"/><rect x="43" y="12" width="9" height="40" rx="4" fill="#ed8b73"/></svg>`;
  const svgImage = () => nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(fallbackSvg).toString('base64')}`).resize({ width: 16, height: 16 });
  if (fs.existsSync(appIconPngPath)) return nativeImage.createFromPath(appIconPngPath).resize({ width: 16, height: 16 });
  if (fs.existsSync(appIconSvgPath)) return nativeImage.createFromPath(appIconSvgPath).resize({ width: 16, height: 16 });
  return svgImage();
}

function loadAppIcon() {
  if (fs.existsSync(appIconPngPath)) return nativeImage.createFromPath(appIconPngPath);
  if (fs.existsSync(appIconSvgPath)) return nativeImage.createFromPath(appIconSvgPath);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#202c2e"/><circle cx="16" cy="16" r="10" fill="none" stroke="#d8f2df" stroke-width="2"/><path d="M11 20h3V14h3v6h3V9h3v11" fill="none" stroke="#ed8b73" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function buildTrayMenu() {
  const autoUpdate = store?.loadState()?.settings?.autoUpdate !== false;
  return Menu.buildFromTemplate([
    { label: '打开 Quota Desk', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '立即刷新额度', click: () => pollState().catch(() => {}) },
    { label: '显示 / 隐藏浮窗', click: () => setWidgetVisible(!widgetWindow?.isVisible()) },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: getAutoLaunch(), click: (item) => { setAutoLaunch(item.checked); refreshTray(); } },
    { label: '自动检查更新', type: 'checkbox', checked: autoUpdate, click: (item) => setAutoUpdateEnabled(item.checked) },
    { label: '检查更新', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Quota Desk');
  refreshTray();
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

const windowSummaryLabels = { five_hour: '5小时', daily: '1天', weekly: '7天', monthly: '1个月', balance: '余额' };
const formatWindowSummary = (windows) => (windows || [])
  .map((item) => `${windowSummaryLabels[item.key] || item.key} ${item.unit === '%' ? `${Math.round(Number(item.remaining) || 0)}%` : `${item.amount ?? item.remaining}${item.unit ? ` ${item.unit}` : ''}`}`)
  .join(' · ') || '没有可用额度窗口';

function registerIpc() {
  ipcMain.handle('state:load', () => {
    const state = migrateState(store.loadState());
    if (state) store.saveState(cleanState(state));
    return state ? { ...state, runtime: runtimeStatus() } : null;
  });
  ipcMain.handle('state:save', async (_event, state) => {
    // 记录保存前的开关状态：只在“自动检查更新”从关闭切换为开启时补一次立即检查，避免每次保存设置都请求 GitHub
    const previous = migrateState(store.loadState());
    const autoUpdateWasDisabled = previous?.settings?.autoUpdate === false;
    const saved = store.saveState(cleanState(mergeMainOwnedUsageConnections(state, previous)));
    const savedIds = new Set((saved.accounts || []).map((account) => account.id));
    const removedIds = (previous?.accounts || []).filter((account) => !savedIds.has(account.id)).map((account) => account.id);
    // 账号被删除时连同凭据、官方网页登录分区、额度历史与周期档案一起清掉。
    // 这也覆盖没有先调用 credential:delete 的调用方。
    const removalCleanup = Promise.all(removedIds.map((accountId) => deleteAccountLocalData(accountId)));
    store.pruneHistoryAccounts([...savedIds], historyRetentionDays());
    store.pruneCyclesAccounts([...savedIds]);
    applyProxySetting();
    schedulePolling();
    sendState(saved);
    refreshTray();
    if (autoUpdateWasDisabled && saved?.settings?.autoUpdate && backgroundUpdateCheckAllowed()) checkForUpdates();
    await removalCleanup;
    return saved;
  });
  ipcMain.handle('credential:save', (_event, { accountId, credential = '', variables }) => {
    const hasVariables = variables && Object.values(variables).some((value) => String(value || '').trim());
    if (!accountId) throw new Error('缺少账号 ID');
    if (!String(credential).trim() && !hasVariables) return true;
    return store.saveCredential(accountId, String(credential).trim(), variables);
  });
  ipcMain.handle('credential:delete', (_event, accountId) => deleteAccountLocalData(String(accountId || '')));
  ipcMain.handle('quota:poll-all', () => pollState());
  ipcMain.handle('quota:poll-account', (_event, accountId) => pollState([accountId]));
  ipcMain.handle('history:get', (_event, accountId) => store.getHistory(String(accountId || ''), historyRetentionDays()));
  ipcMain.handle('usage:get', async (_event, accountId, options = {}) => queryProviderUsage(String(accountId || ''), options));
  ipcMain.handle('usage:connect', async (_event, accountId) => connectProviderUsage(String(accountId || '')));
  ipcMain.handle('usage:disconnect', (_event, accountId) => {
    const id = String(accountId || '');
    const state = migrateState(store.loadState());
    const account = (state?.accounts || []).find((item) => item.id === id);
    if (!account) throw new Error('找不到要断开连接的账号');
    if (!PROVIDER_USAGE_CONFIGS[account.providerId]) throw new Error('该厂商没有可断开的官方账号登录');
    return disconnectProviderUsage(id);
  });
  ipcMain.handle('history:clear', () => { store.clearHistory(); return store.clearCycles(); });
  // 周期浪费档案：永久保留，不受历史保留时长影响
  ipcMain.handle('cycles:get', (_event, accountId) => store.getCycles(String(accountId || '')));
  ipcMain.handle('quota:test-account', async (_event, accountId) => {
    const state = await pollState([accountId]);
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error('找不到要测试的账号');
    return {
      ok: account.status === 'active',
      message: account.status === 'active' ? formatWindowSummary(account.windows) : account.lastError,
      checkedAt: account.lastChecked,
      state: { ...state, runtime: runtimeStatus() },
    };
  });
  // 表单草稿连通性测试：不保存账号/凭据，直接按草稿跑一次查询；留空的凭据/密钥回退到已存值
  ipcMain.handle('quota:test-draft', async (_event, { accountId, account, providerId, credential, secretVariables }) => {
    const state = migrateState(store.loadState());
    const provider = (state?.providers || []).find((item) => item.id === providerId);
    if (!provider) throw new Error('找不到厂商配置');
    let secret = String(credential || '').trim();
    const secrets = { ...(secretVariables || {}) };
    if (accountId) {
      const stored = store.getSecrets(accountId);
      if (!secret) secret = stored.credential || '';
      for (const [key, value] of Object.entries(stored.variables || {})) {
        if (!String(secrets[key] || '').trim()) secrets[key] = value;
      }
    }
    const checkedAt = new Date().toISOString();
    try {
      const windows = await queryAccount({ ...(account || {}), providerId }, provider, secret, net.fetch, secrets, {
        // 已保存的账号在草稿测试中续期成功也要落盘，避免白白消耗一次 refresh；
        // 重试时同样重取凭据，防止用已轮换的旧 refresh_token 二次续期
        onCliAuth: accountId ? ({ kind, next, previous, source }) => persistCliAuthUpdate(accountId, { kind, next, previous, source }) : undefined,
        getSecretVariables: accountId ? () => ({ ...store.getSecrets(accountId).variables, ...Object.fromEntries(Object.entries(secrets).filter(([, value]) => String(value || '').trim())) }) : undefined,
      });
      return { ok: true, message: formatWindowSummary(windows), checkedAt };
    } catch (error) {
      return { ok: false, message: error.message, checkedAt };
    }
  });
  ipcMain.handle('widget:set-visible', (_event, visible) => setWidgetVisible(Boolean(visible)));
  ipcMain.handle('widget:get-visible', () => Boolean(widgetWindow?.isVisible()));
  ipcMain.handle('window:open-main', () => { mainWindow?.show(); mainWindow?.focus(); return true; });
  // Electron 43 默认级别的 setAlwaysOnTop 不生效，置顶/取消固定都要显式传级别（见 ensureWidgetOnTop 注释）
  ipcMain.handle('window:toggle-pin', () => { if (!mainWindow) return false; const next = !mainWindow.isAlwaysOnTop(); mainWindow.setAlwaysOnTop(next, 'screen-saver'); if (next) ensureWidgetOnTop(); return next; });
  ipcMain.handle('window:get-pin', () => Boolean(mainWindow?.isAlwaysOnTop()));
  ipcMain.handle('window:close-main', () => { mainWindow?.hide(); return true; });
  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('app:get-auto-launch', () => getAutoLaunch());
  ipcMain.handle('app:set-auto-launch', (_event, enabled) => { const result = setAutoLaunch(enabled); refreshTray(); return result; });
  ipcMain.handle('app:set-auto-update', (_event, enabled) => { setAutoUpdateEnabled(Boolean(enabled)); return true; });
  // 从本机 CLI 登录导入：把当前 live 登录快照为独立账号（多账号监控的基础）。
  // 只下发指纹/展示名，token 全程留在主进程
  ipcMain.handle('cli:read-live', () => Object.fromEntries(CLI_KINDS.map((kind) => {
    const auth = readLiveAuth(kind);
    const identity = auth && cliIdentity(kind, auth);
    return [kind, identity ? { ok: true, display: identity.display, fingerprint: identity.fingerprint } : { ok: false }];
  })));
  ipcMain.handle('cli:import-live', async (_event, kind, options = {}) => {
    if (!CLI_KINDS.includes(kind)) throw new Error('不支持的 CLI 类型');
    const state = migrateState(store.loadState());
    if (!state) throw new Error('桌面状态尚未初始化');
    const provider = (state.providers || []).find((item) => item.id === kind);
    if (!provider) throw new Error(`找不到厂商配置：${kind}`);
    const auth = readLiveAuth(kind);
    const identity = auth && cliIdentity(kind, auth);
    if (!identity) {
      throw new Error(kind === 'codex'
        ? '本机没有可导入的 Codex ChatGPT 登录（当前可能切到了中转 profile，请先切回官方登录再导入）'
        : `本机没有可导入的 ${provider.name} 登录，请先在对应 CLI 登录`);
    }
    const reloginId = String(options?.accountId || '').trim();
    if (reloginId) {
      const target = (state.accounts || []).find((account) => account.id === reloginId && account.providerId === kind);
      if (!target) throw new Error(`找不到要重新导入的 ${provider.name} 账号`);
      const conflict = (state.accounts || []).find((account) => account.id !== reloginId
        && account.providerId === kind && account.cliAuthSource === 'snapshot' && account.cliFingerprint === identity.fingerprint);
      if (conflict) return { imported: 0, duplicate: true, name: conflict.name, state: migrateState(store.loadState()) };
      store.saveCredential(reloginId, '', { [SNAPSHOT_KEY]: JSON.stringify(auth) });
      const customName = String(options?.name || '').trim();
      const customTags = Array.isArray(options?.tags) ? options.tags.map((tag) => String(tag).trim()).filter(Boolean) : null;
      const nextIdentity = (!target.identity || target.identity.startsWith('…')) ? (identity.display || target.identity) : target.identity;
      const updatedAccounts = (state.accounts || []).map((account) => account.id === reloginId
        ? {
          ...account,
          identity: nextIdentity,
          ...(customName ? { name: customName } : {}),
          ...(customTags ? { tags: customTags } : {}),
          cliAuthSource: 'snapshot',
          cliFingerprint: identity.fingerprint,
          status: 'active',
          lastError: null,
        }
        : account);
      const saved = store.saveState(cleanState({ ...state, accounts: updatedAccounts }));
      sendState(saved);
      await pollState([reloginId]).catch(() => {});
      return { imported: 1, duplicate: false, relogin: true, name: customName || target.name, display: identity.display || '', state: migrateState(store.loadState()) };
    }
    // 指纹去重：同一登录已收录为独立账号时不重复导入
    const existing = (state.accounts || []).find((account) => account.providerId === kind && account.cliAuthSource === 'snapshot' && account.cliFingerprint === identity.fingerprint);
    if (existing) return { imported: 0, duplicate: true, name: existing.name, state: migrateState(store.loadState()) };
    const id = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    store.saveCredential(id, '', { [SNAPSHOT_KEY]: JSON.stringify(auth) });
    const windowKeys = provider.requestConfig?.windows?.length ? provider.requestConfig.windows : ['five_hour', 'weekly'];
    // 账号信息来自导入表单：账号名默认就是渠道名（如 Codex），标识固定为登录邮箱，标签用户可编辑
    const customName = String(options?.name || '').trim();
    const customTags = (Array.isArray(options?.tags) ? options.tags : []).map((tag) => String(tag).trim()).filter(Boolean);
    const account = {
      id,
      providerId: kind,
      name: customName || provider.name,
      identity: identity.display || '',
      tags: customTags,
      cliAuthSource: 'snapshot',
      cliFingerprint: identity.fingerprint,
      windowKeys,
      windows: [],
      status: 'active',
      lastError: null,
      lastChecked: null,
      lastTestAt: null,
    };
    const saved = store.saveState(cleanState({ ...state, accounts: [...(state.accounts || []), account] }));
    sendState(saved);
    await pollState([id]).catch(() => {});
    return { imported: 1, duplicate: false, name: account.name, display: identity.display || '', state: migrateState(store.loadState()) };
  });
  // ── Kimi 订阅扫码登录（auth.kimi.com account.gateway.v1.AuthService，connect-rpc + JSON）──
  // 二维码内容是 kimi.com 的网页链接（微信 / Kimi App 扫码确认），登录成功后网页会话的
  // token bundle 快照为独立账号；与 CLI 导入一致，token 全程只留在主进程，不进渲染层。
  const KIMI_QR_REGIONS = [
    { authHost: 'https://auth.kimi.com', site: 'https://www.kimi.com' },
    { authHost: 'https://auth.kimi.ai', site: 'https://www.kimi.ai' },
  ];
  const KIMI_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
  // code → { authHost, site, auth?, createdAt }；扫码会话只保留 10 分钟
  const kimiPendingQr = new Map();
  const kimiQrCleaner = setInterval(() => {
    for (const [code, entry] of kimiPendingQr) {
      if (Date.now() - entry.createdAt > 10 * 60_000) kimiPendingQr.delete(code);
    }
  }, 60_000);
  kimiQrCleaner.unref?.();

  const postKimiConnect = async (authHost, servicePath, body) => {
    const response = await net.fetch(`${authHost.replace(/\/$/, '')}${servicePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': KIMI_BROWSER_UA },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Kimi 登录接口返回 HTTP ${response.status}`);
    return payload;
  };
  const kimiDeviceId = () => Array.from(crypto.randomBytes(10)).map((byte) => byte % 10).join('');

  ipcMain.handle('kimi:qr-start', async () => {
    let lastError = null;
    for (const region of KIMI_QR_REGIONS) {
      try {
        const payload = await postKimiConnect(region.authHost, '/api/account.gateway.v1.AuthService/CreateLoginQRCode', {});
        const code = typeof payload?.code === 'string' ? payload.code : '';
        if (!code) throw new Error('二维码响应中没有 code');
        kimiPendingQr.set(code, { ...region, createdAt: Date.now() });
        return { code, qr: `${region.site}/wechat/mp/auth?id=${encodeURIComponent(code)}&device_id=${kimiDeviceId()}` };
      } catch (error) { lastError = error; }
    }
    throw new Error(`创建 Kimi 登录二维码失败：${lastError?.message || '网络错误'}`);
  });
  ipcMain.handle('kimi:qr-poll', async (_event, code) => {
    const entry = kimiPendingQr.get(String(code || ''));
    if (!entry) return { status: 'expired' };
    let payload;
    try { payload = await postKimiConnect(entry.authHost, '/api/account.gateway.v1.AuthService/GetLoginQRCodeStatus', { code }); }
    catch (error) { return { status: 'pending', error: error.message }; }
    const raw = String(payload?.status || '');
    if (raw === 'STATUS_SUCCESS' && payload?.accessToken && payload?.refreshToken) {
      // 登录成功：令牌暂存主进程内存，等渲染层带着账号名/标签来导入
      entry.auth = { accessToken: payload.accessToken, refreshToken: payload.refreshToken, userId: String(payload.userId || ''), authHost: entry.authHost };
      const identity = cliIdentity('kimi', entry.auth);
      return { status: 'success', display: identity?.display || '' };
    }
    if (raw === 'STATUS_EXPIRED') { kimiPendingQr.delete(String(code)); return { status: 'expired' }; }
    return { status: raw === 'STATUS_SCANNED' ? 'scanned' : 'pending' };
  });
  ipcMain.handle('kimi:qr-import', async (_event, code, options = {}) => {
    const entry = kimiPendingQr.get(String(code || ''));
    kimiPendingQr.delete(String(code || ''));
    if (!entry?.auth) throw new Error('登录会话已失效，请重新扫码');
    const state = migrateState(store.loadState());
    if (!state) throw new Error('桌面状态尚未初始化');
    const provider = (state.providers || []).find((item) => item.id === 'kimi-subscription');
    if (!provider) throw new Error('找不到厂商配置：kimi-subscription');
    const identity = cliIdentity('kimi', entry.auth);
    if (!identity) throw new Error('Kimi 登录信息不完整，请重新扫码');
    // 重新登录已有账号（token 失效后的「重新扫码」）：新快照写回原账号，配置全部保留；
    // 扫出来的登录属于另一个已收录账号时拒绝覆盖，避免两个账号共用同一份登录
    const reloginId = String(options?.accountId || '');
    if (reloginId) {
      const target = (state.accounts || []).find((account) => account.id === reloginId && account.providerId === 'kimi-subscription');
      if (!target) throw new Error('找不到要重新登录的 Kimi 订阅账号');
      const conflict = (state.accounts || []).find((account) => account.id !== reloginId && account.providerId === 'kimi-subscription' && account.cliAuthSource === 'snapshot' && account.cliFingerprint === identity.fingerprint);
      if (conflict) return { imported: 0, duplicate: true, name: conflict.name, state: migrateState(store.loadState()) };
      store.saveCredential(reloginId, '', { [SNAPSHOT_KEY]: JSON.stringify(entry.auth) });
      // 账号名 / 标签允许在重登弹窗里顺手改（留空 / 未传则保留原值）
      const customName = String(options?.name || '').trim();
      const customTags = Array.isArray(options?.tags) ? options.tags.map((tag) => String(tag).trim()).filter(Boolean) : null;
      // 自动生成的标识（… 尾号）跟随新登录更新，用户手填的标识不动
      const nextIdentity = (!target.identity || target.identity.startsWith('…')) ? (identity.display || target.identity) : target.identity;
      const updatedAccounts = (state.accounts || []).map((account) => account.id === reloginId
        ? { ...account, identity: nextIdentity, ...(customName ? { name: customName } : {}), ...(customTags ? { tags: customTags } : {}), cliAuthSource: 'snapshot', cliFingerprint: identity.fingerprint, status: 'active', lastError: null }
        : account);
      const saved = store.saveState(cleanState({ ...state, accounts: updatedAccounts }));
      sendState(saved);
      await pollState([reloginId]).catch(() => {});
      return { imported: 1, duplicate: false, relogin: true, name: customName || target.name, display: identity.display || '', state: migrateState(store.loadState()) };
    }
    // 指纹去重：同一登录已收录为独立账号时不重复导入
    const existing = (state.accounts || []).find((account) => account.providerId === 'kimi-subscription' && account.cliAuthSource === 'snapshot' && account.cliFingerprint === identity.fingerprint);
    if (existing) return { imported: 0, duplicate: true, name: existing.name, state: migrateState(store.loadState()) };
    const id = `kimi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    store.saveCredential(id, '', { [SNAPSHOT_KEY]: JSON.stringify(entry.auth) });
    const customName = String(options?.name || '').trim();
    const customTags = (Array.isArray(options?.tags) ? options.tags : []).map((tag) => String(tag).trim()).filter(Boolean);
    const account = {
      id,
      providerId: 'kimi-subscription',
      name: customName || provider.name,
      identity: identity.display || '',
      tags: customTags,
      cliAuthSource: 'snapshot',
      cliFingerprint: identity.fingerprint,
      windowKeys: provider.requestConfig?.windows?.length ? provider.requestConfig.windows : ['five_hour', 'weekly', 'monthly'],
      windows: [],
      status: 'active',
      lastError: null,
      lastChecked: null,
      lastTestAt: null,
    };
    const saved = store.saveState(cleanState({ ...state, accounts: [...(state.accounts || []), account] }));
    sendState(saved);
    await pollState([id]).catch(() => {});
    return { imported: 1, duplicate: false, name: account.name, state: migrateState(store.loadState()) };
  });
  // 从 cc-switch 导入：扫描结果不含 API key / OAuth token，应用时主进程重新提取并写凭据
  ipcMain.handle('import:scan-ccswitch', () => {
    const state = migrateState(store.loadState());
    const providers = state?.providers || [];
    const result = scanCcswitch(providers);
    if (result.error) return result;
    for (const candidate of result.candidates) {
      candidate.providerName = providers.find((item) => item.id === candidate.providerId)?.name || candidate.providerId;
    }
    // 已有账号凭据去重：同一把 key 或同一份 OAuth 登录（指纹）已存在于任一账号时标记「已存在」
    const existingKeys = new Set();
    const existingFingerprints = new Set();
    for (const account of state.accounts || []) {
      const credential = store.getCredential(account.id);
      if (credential) existingKeys.add(credential);
      if (account.cliFingerprint) existingFingerprints.add(account.cliFingerprint);
    }
    for (const candidate of result.candidates) {
      if (candidate.kind === 'oauth') {
        candidate.duplicateOfExisting = existingFingerprints.has(candidate.fingerprint);
        candidate.bundle = undefined;
      } else {
        candidate.duplicateOfExisting = existingKeys.has(candidate.apiKey);
        delete candidate.apiKey;
      }
    }
    return result;
  });
  ipcMain.handle('import:apply-ccswitch', async (_event, selectedIds) => {
    const state = migrateState(store.loadState());
    const providers = state?.providers || [];
    const scan = scanCcswitch(providers);
    if (scan.error) throw new Error(scan.error);
    const selected = new Set(selectedIds || []);
    const usedKeys = new Set();
    const usedFingerprints = new Set();
    for (const account of state.accounts || []) {
      const credential = store.getCredential(account.id);
      if (credential) usedKeys.add(credential);
      if (account.cliFingerprint) usedFingerprints.add(account.cliFingerprint);
    }
    const nextAccounts = [...(state.accounts || [])];
    const importedIds = [];
    for (const candidate of scan.candidates) {
      if (!selected.has(candidate.key)) continue;
      const provider = providers.find((item) => item.id === candidate.providerId);
      if (!provider) continue;
      const id = `ccs-${Date.now().toString(36)}-${importedIds.length}-${Math.random().toString(36).slice(2, 7)}`;
      if (candidate.kind === 'oauth') {
        // 官方 OAuth 条目：完整 token bundle 快照进加密凭据，之后由应用自动续期
        if (!candidate.bundle || usedFingerprints.has(candidate.fingerprint)) continue;
        usedFingerprints.add(candidate.fingerprint);
        store.saveCredential(id, '', { [SNAPSHOT_KEY]: JSON.stringify(candidate.bundle) });
        importedIds.push(id);
        nextAccounts.push({
          id,
          providerId: candidate.providerId,
          name: candidate.name,
          identity: candidate.oauthDisplay || '',
          tags: ['cc-switch'],
          cliAuthSource: 'snapshot',
          cliFingerprint: candidate.fingerprint,
          windowKeys: provider.requestConfig?.windows?.length ? provider.requestConfig.windows : ['five_hour', 'weekly', 'monthly', 'balance'],
          windows: [],
          status: 'active',
          lastError: null,
          lastChecked: null,
        });
        continue;
      }
      if (usedKeys.has(candidate.apiKey)) continue;
      usedKeys.add(candidate.apiKey);
      const windows = provider.requestConfig?.windows?.length ? provider.requestConfig.windows : ['five_hour', 'weekly', 'monthly', 'balance'];
      store.saveCredential(id, candidate.apiKey);
      importedIds.push(id);
      nextAccounts.push({
        id,
        providerId: candidate.providerId,
        name: candidate.name,
        identity: '',
        tags: ['cc-switch'],
        windowKeys: windows,
        windows: [],
        status: 'active',
        lastError: null,
        lastChecked: null,
      });
    }
    const saved = store.saveState(cleanState({ ...state, accounts: nextAccounts }));
    sendState(saved);
    if (importedIds.length) await pollState(importedIds).catch(() => {});
    return { imported: importedIds.length, state: migrateState(store.loadState()) };
  });
  ipcMain.handle('update:get-status', () => updateStatus);
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.handle('update:download', () => {
    if (MANUAL_DOWNLOAD_ONLY) {
      // macOS 未签名、Windows 便携版都无法在应用内完成升级，直接引导到 Release 页手动下载
      shell.openExternal(RELEASES_URL);
      return true;
    }
    if (!autoUpdater) return false;
    lastReportedUpdateError = null;
    // 先进入下载中状态，让按钮立即反馈，也让下载阶段的报错能按“下载失败”归类
    sendUpdateStatus({ status: 'downloading', percent: 0, message: '', manual: true });
    autoUpdater.downloadUpdate().catch(reportUpdateError);
    return true;
  });
  ipcMain.handle('update:install', () => { autoUpdater?.quitAndInstall(true, true); return true; });
  ipcMain.handle('widget:set-size', (_event, size) => (size && typeof size === 'object' ? applyWidgetSize(size.scale, size.length) : applyWidgetSize(size)));
  ipcMain.handle('app:set-theme', (_event, theme) => applyTheme(theme));
  // 厂商官网等外部链接一律走系统默认浏览器，不在应用窗口内导航
  ipcMain.handle('app:open-external', (_event, url) => {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) throw new Error('仅支持打开 http/https 链接');
    shell.openExternal(target);
    return true;
  });
  ipcMain.on('widget:move', (_event, { deltaX, deltaY }) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const dx = Math.round(Number(deltaX) || 0);
    const dy = Math.round(Number(deltaY) || 0);
    if (!dx && !dy) return;
    const size = widgetWindowSize(widgetScale, widgetLength);
    const bounds = widgetWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const x = Math.max(area.x, Math.min(area.x + area.width - size.width, bounds.x + dx));
    const y = Math.max(area.y, Math.min(area.y + area.height - size.height, bounds.y + dy));
    widgetWindow.setBounds({ x, y, width: size.width, height: size.height });
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    store = new DesktopStore();
    await scrubLegacyProviderUsagePartitions();
    applyProxySetting();
    refreshLiveIdentities();
    registerIpc();
    createMainWindow();
    const state = store.loadState();
    if (state?.settings?.widget !== false) createWidgetWindow();
    createTray();
    schedulePolling();
    setupAutoUpdater();
    if (state?.settings?.autoUpdate !== false) checkForUpdates();
    scheduleUpdateChecks();
    pollState().catch((error) => console.error('[Quota Desk] initial poll failed', error.message));
    app.on('activate', () => mainWindow?.show());
  });
}

app.on('before-quit', () => {
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  const usageAccountIds = new Set([
    ...providerUsageWindows.keys(),
    ...providerUsageSessions.keys(),
    ...providerUsageRequests.keys(),
  ]);
  for (const accountId of usageAccountIds) {
    bumpProviderUsageEpoch(accountId);
    abortProviderUsageRequests(accountId);
    closeProviderUsageWindows(accountId);
  }
});
app.on('window-all-closed', () => {});
