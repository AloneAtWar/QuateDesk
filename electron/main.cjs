const { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, screen, shell, Tray } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { DesktopStore } = require('./storage.cjs');
const { queryAccount } = require('./poller.cjs');
const { clampRetentionDays } = require('./history.cjs');
const { builtinConfigs } = require('./builtin-configs.cjs');
const { scanCcswitch } = require('./ccswitch.cjs');

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
});

const sendState = (state) => {
  for (const window of [mainWindow, widgetWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('state:updated', { ...state, runtime: runtimeStatus() });
  }
};

const builtinLogos = {
  kimi: './logos/kimi.png',
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
  if (provider.id === 'wlb') return { ...migrated, name: 'wlbclub', legalName: 'wlbclub', monogram: 'W' };
  return migrated;
};

const migrateAccount = (account) => {
  if (!account) return account;
  const { baseUrl, ...rest } = account;
  // wlbclub 上线 1 天限额：已显式选择过窗口的 wlb 账号自动补上 daily；没选过窗口的账号不做过滤，本来就会显示
  if (rest.providerId === 'wlb' && Array.isArray(rest.windowKeys) && rest.windowKeys.length && !rest.windowKeys.includes('daily')) {
    return { ...rest, windowKeys: [...rest.windowKeys, 'daily'] };
  }
  return rest;
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
    new Notification({ title: rule.label || '额度即将刷新', body: `${provider.name} · ${account.name} · ${Math.round(item.remaining)}% · ${Math.ceil(remainingMs / 60_000)} 分钟后刷新。` }).show();
  }
};

async function pollState(accountIds = null) {
  const current = migrateState(store.loadState());
  if (!current) throw new Error('桌面状态尚未初始化');
  pollInProgress = true;
  sendState(current);
  const ids = accountIds ? new Set(accountIds) : null;
  const nextAccounts = [];
  for (const account of current.accounts || []) {
    if (ids && !ids.has(account.id)) { nextAccounts.push(account); continue; }
    const provider = (current.providers || []).find((item) => item.id === account.providerId);
    if (!provider) {
      nextAccounts.push({ ...account, status: 'warning', lastError: '找不到厂商配置', lastChecked: new Date().toISOString() });
      continue;
    }
    try {
      const secrets = store.getSecrets(account.id);
      const windows = await queryAccount(account, provider, secrets.credential, net.fetch, secrets.variables);
      const checkedAt = new Date().toISOString();
      const updated = { ...account, windows, status: 'active', lastError: null, lastChecked: checkedAt, lastTestAt: checkedAt };
      nextAccounts.push(updated);
      store.appendHistory(account.id, windows, historyRetentionDays());
      notifyWaste(current, updated, provider);
    } catch (error) {
      const checkedAt = new Date().toISOString();
      nextAccounts.push({ ...account, status: 'warning', lastError: error.message, lastChecked: checkedAt, lastTestAt: checkedAt });
    }
  }
  const next = cleanState({ ...current, accounts: nextAccounts, lastSync: new Date().toISOString() });
  store.saveState(next);
  pollInProgress = false;
  sendState(next);
  return next;
}

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  const state = store.loadState();
  const minutes = Math.max(1, Number(state?.settings?.pollMinutes || 15));
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
  ipcMain.handle('state:save', (_event, state) => {
    // 记录保存前的开关状态：只在“自动检查更新”从关闭切换为开启时补一次立即检查，避免每次保存设置都请求 GitHub
    const autoUpdateWasDisabled = store.loadState()?.settings?.autoUpdate === false;
    const saved = store.saveState(cleanState(state));
    // 账号被删除时连同它的额度历史一起清掉
    store.pruneHistoryAccounts((saved.accounts || []).map((account) => account.id), historyRetentionDays());
    schedulePolling();
    sendState(saved);
    refreshTray();
    if (autoUpdateWasDisabled && saved?.settings?.autoUpdate && backgroundUpdateCheckAllowed()) checkForUpdates();
    return saved;
  });
  ipcMain.handle('credential:save', (_event, { accountId, credential = '', variables }) => {
    const hasVariables = variables && Object.values(variables).some((value) => String(value || '').trim());
    if (!accountId) throw new Error('缺少账号 ID');
    if (!String(credential).trim() && !hasVariables) return true;
    return store.saveCredential(accountId, String(credential).trim(), variables);
  });
  ipcMain.handle('credential:delete', (_event, accountId) => store.deleteCredential(accountId));
  ipcMain.handle('quota:poll-all', () => pollState());
  ipcMain.handle('quota:poll-account', (_event, accountId) => pollState([accountId]));
  ipcMain.handle('history:get', (_event, accountId) => store.getHistory(String(accountId || ''), historyRetentionDays()));
  ipcMain.handle('history:clear', () => store.clearHistory());
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
  // 从 cc-switch 导入：扫描结果不含 API key，应用时主进程重新提取并写凭据
  ipcMain.handle('import:scan-ccswitch', () => {
    const state = migrateState(store.loadState());
    const providers = state?.providers || [];
    const result = scanCcswitch(providers);
    if (result.error) return result;
    for (const candidate of result.candidates) {
      candidate.providerName = providers.find((item) => item.id === candidate.providerId)?.name || candidate.providerId;
    }
    // 已有账号凭据去重：同一把 key 已存在于任一账号时标记「已存在」
    const existingKeys = new Set();
    for (const account of state.accounts || []) {
      const credential = store.getCredential(account.id);
      if (credential) existingKeys.add(credential);
    }
    for (const candidate of result.candidates) {
      candidate.duplicateOfExisting = existingKeys.has(candidate.apiKey);
      delete candidate.apiKey;
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
    for (const account of state.accounts || []) {
      const credential = store.getCredential(account.id);
      if (credential) usedKeys.add(credential);
    }
    const nextAccounts = [...(state.accounts || [])];
    const importedIds = [];
    for (const candidate of scan.candidates) {
      if (!selected.has(candidate.key) || usedKeys.has(candidate.apiKey)) continue;
      usedKeys.add(candidate.apiKey);
      const provider = providers.find((item) => item.id === candidate.providerId);
      const windows = provider?.requestConfig?.windows?.length ? provider.requestConfig.windows : ['five_hour', 'weekly', 'monthly', 'balance'];
      const id = `ccs-${Date.now().toString(36)}-${importedIds.length}-${Math.random().toString(36).slice(2, 7)}`;
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
  app.whenReady().then(() => {
    store = new DesktopStore();
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

app.on('before-quit', () => { quitting = true; if (pollTimer) clearInterval(pollTimer); if (updateCheckTimer) clearInterval(updateCheckTimer); });
app.on('window-all-closed', () => {});
