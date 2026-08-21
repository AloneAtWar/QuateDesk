const { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, screen, Tray } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { DesktopStore } = require('./storage.cjs');
const { queryAccount } = require('./poller.cjs');
const { builtinConfigs } = require('./builtin-configs.cjs');

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
const distPath = path.join(__dirname, '..', 'dist', 'index.html');
const preloadPath = path.join(__dirname, 'preload.cjs');
const appIconPngPath = path.join(__dirname, '..', 'dist', 'logo.png');
const appIconSvgPath = path.join(__dirname, '..', 'dist', 'quota-desk.svg');

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
  mimo: './logos/xiaomi.svg',
};
const migrateProvider = (provider) => {
  if (!provider) return provider;
  const legacyLogo = !provider.logo || /^https?:\/\//i.test(provider.logo) || /\.\/logos\/(kimi|deepseek)\.svg$/i.test(provider.logo);
  const logo = legacyLogo && builtinLogos[provider.id] ? builtinLogos[provider.id] : provider.logo;
  const builtinConfig = builtinConfigs[provider.id];
  const needsWlbMigration = provider.id === 'wlb' && builtinConfig?.builtinMigration && provider.requestConfig?.builtinMigration !== builtinConfig.builtinMigration;
  const builtin = !provider.requestConfig?.adapterMode || needsWlbMigration ? builtinConfig : null;
  const seededVariables = !builtin && builtinConfig?.adapterMode === 'script' && !provider.requestConfig?.variables?.some((item) => item.key === 'endpoint')
    ? { ...provider, requestConfig: { ...provider.requestConfig, variables: builtinConfig.variables } }
    : provider;
  const migrated = builtin ? { ...provider, baseUrl: undefined, domain: undefined, requestConfig: builtin, logo } : { ...seededVariables, baseUrl: undefined, domain: undefined, logo };
  if (provider.id === 'mimo') return { ...migrated, name: 'XiaoMi MiMo', legalName: 'XiaoMi MiMo', monogram: 'M' };
  if (provider.id === 'wlb') return { ...migrated, name: 'wlbclub', legalName: 'wlbclub', monogram: 'W' };
  return migrated;
};

const migrateState = (state) => state ? {
  ...state,
  accounts: (state.accounts || []).map(({ baseUrl, ...account }) => account),
  providers: (state.providers || []).map(migrateProvider),
} : state;

const cleanState = (state) => ({
  accounts: (state?.accounts || []).map(({ credential, baseUrl, ...account }) => account),
  providers: (state?.providers || []).map(({ baseUrl, domain, ...provider }) => migrateProvider(provider)),
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
    pollState().catch(() => {}).finally(() => { nextPollAt = new Date(Date.now() + minutes * 60_000).toISOString(); });
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
    backgroundColor: '#f3f5f1', title: 'Quota Desk', icon: loadAppIcon(), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: preloadPath },
  });
  mainWindow.loadFile(distPath);
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => console.error('[Quota Desk] load failed', code, description, url));
  mainWindow.webContents.on('render-process-gone', (_event, details) => console.error('[Quota Desk] renderer gone', details.reason));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createWidgetWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  widgetWindow = new BrowserWindow({
    width: 280, height: 52, x: Math.max(0, width - 296), y: Math.max(0, height - 66),
    minWidth: 220, maxWidth: 400, minHeight: 52, maxHeight: 52,
    frame: false, resizable: false, movable: true, skipTaskbar: true, alwaysOnTop: true, show: false,
    backgroundColor: '#202c2e', title: 'Quota Desk 小空间',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: preloadPath },
  });
  widgetWindow.loadFile(distPath, { query: { widget: '1' } });
  widgetWindow.once('ready-to-show', () => widgetWindow.showInactive());
  widgetWindow.on('closed', () => { widgetWindow = null; });
}

function setWidgetVisible(visible) {
  if (!widgetWindow || widgetWindow.isDestroyed()) { if (visible) createWidgetWindow(); return visible; }
  if (visible) widgetWindow.showInactive(); else widgetWindow.hide();
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

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Quota Desk');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Quota Desk', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '立即刷新额度', click: () => pollState().catch(() => {}) },
    { label: '显示 / 隐藏小空间', click: () => setWidgetVisible(!widgetWindow?.isVisible()) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

const windowSummaryLabels = { five_hour: '5小时', weekly: '7天', monthly: '1个月', balance: '余额' };
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
    const saved = store.saveState(cleanState(state));
    schedulePolling();
    sendState(saved);
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
  ipcMain.handle('window:toggle-pin', () => { if (!mainWindow) return false; const next = !mainWindow.isAlwaysOnTop(); mainWindow.setAlwaysOnTop(next); return next; });
  ipcMain.handle('window:get-pin', () => Boolean(mainWindow?.isAlwaysOnTop()));
  ipcMain.handle('window:close-main', () => { mainWindow?.hide(); return true; });
  ipcMain.on('widget:move', (_event, { deltaX, deltaY }) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const dx = Math.round(Number(deltaX) || 0);
    const dy = Math.round(Number(deltaY) || 0);
    if (!dx && !dy) return;
    const bounds = widgetWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const x = Math.max(area.x, Math.min(area.x + area.width - bounds.width, bounds.x + dx));
    const y = Math.max(area.y, Math.min(area.y + area.height - bounds.height, bounds.y + dy));
    widgetWindow.setPosition(x, y, false);
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
    pollState().catch((error) => console.error('[Quota Desk] initial poll failed', error.message));
    app.on('activate', () => mainWindow?.show());
  });
}

app.on('before-quit', () => { quitting = true; if (pollTimer) clearInterval(pollTimer); });
app.on('window-all-closed', () => {});
