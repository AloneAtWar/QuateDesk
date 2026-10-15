const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { AUTO_START_ARG, isQuietLaunch, getAutoLaunch, setAutoLaunch, migrateAutoLaunch } = require('../electron/startup.cjs');

test('autostart is quiet while manual, updater and explicit onboarding launches show the main panel', () => {
  assert.equal(isQuietLaunch({ argv: [AUTO_START_ARG], platform: 'win32' }), true);
  assert.equal(isQuietLaunch({ argv: [], platform: 'win32' }), false);
  assert.equal(isQuietLaunch({ argv: ['--updated'], platform: 'win32' }), false);
  assert.equal(isQuietLaunch({ argv: [AUTO_START_ARG, '--onboard'] }), false);
  assert.equal(isQuietLaunch({ argv: [], platform: 'darwin', login: { wasOpenedAtLogin: true } }), true);
  assert.equal(isQuietLaunch({ argv: [], platform: 'win32', login: { wasOpenedAtLogin: true } }), false);
});

function loginHarness({ legacy = false, current = false, disabled = false } = {}) {
  const writes = [];
  const app = {
    getLoginItemSettings: ({ args = [] } = {}) => ({ openAtLogin: args.includes(AUTO_START_ARG) ? current : legacy, executableWillLaunchAtLogin: !disabled }),
    setLoginItemSettings: (value) => { writes.push(value); current = value.openAtLogin; legacy = false; },
  };
  return { app, writes };
}

test('Windows startup entries use a dedicated argument and disabling remains effective', () => {
  const { app, writes } = loginHarness();
  assert.equal(setAutoLaunch(app, true, 'win32'), true);
  assert.deepEqual(writes[0], { openAtLogin: true, args: [AUTO_START_ARG] });
  assert.equal(setAutoLaunch(app, false, 'win32'), false);
  assert.deepEqual(writes[1], { openAtLogin: false, args: [AUTO_START_ARG] });
});

test('enabled legacy startup entries migrate once without an off/on toggle', () => {
  const { app, writes } = loginHarness({ legacy: true });
  assert.equal(getAutoLaunch(app, 'win32'), true);
  assert.equal(migrateAutoLaunch(app, 'win32'), true);
  assert.equal(migrateAutoLaunch(app, 'win32'), false);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args, [AUTO_START_ARG]);
});

test('absent or OS-disabled startup entries are not reenabled during migration', () => {
  for (const state of [{}, { legacy: true, disabled: true }, { current: true }]) {
    const { app, writes } = loginHarness(state);
    assert.equal(migrateAutoLaunch(app, 'win32'), false);
    assert.equal(writes.length, 0);
  }
  const { app, writes } = loginHarness({ legacy: true });
  assert.equal(migrateAutoLaunch(app, 'darwin'), false);
  setAutoLaunch(app, true, 'darwin');
  assert.deepEqual(writes[0], { openAtLogin: true });
});

const main = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
function windowHarness(requested, maximized = false) {
  const events = new Map();
  const actions = [];
  const window = {
    on(name, listener) { events.set(name, listener); }, once(name, listener) { events.set(name, listener); },
    webContents: { on() {}, send() {} }, isDestroyed: () => false, isAlwaysOnTop: () => false,
    isMinimized: () => false, show() { actions.push('show'); }, hide() { actions.push('hide'); },
    focus() { actions.push('focus'); }, maximize() { actions.push('maximize'); },
  };
  const context = { mainWindow: null, mainWindowReady: false, mainWindowRequested: requested, mainWindowRestoreMaximized: false,
    BrowserWindow: function () { return window; }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    savedMainWindowState: () => maximized ? { maximized: true, bounds: { width: 520, height: 470, x: 0, y: 0 } } : null,
    MAIN_WINDOW_MIN: { width: 520, height: 470 }, savedTheme: () => 'dark', themeColors: () => ({ main: '#111111' }),
    loadAppIcon() {}, preloadPath: 'test', loadAppPage: async () => {}, enableDevToolsShortcut() {},
    process: { argv: [] }, startupLog() {}, app: { getGPUFeatureStatus: () => ({}) }, persistMainWindowBounds() {},
    widgetShortcuts: null, quitting: false,
  };
  vm.createContext(context);
  vm.runInContext(main.slice(main.indexOf('function showMainWindow('), main.indexOf('// F12 / Ctrl+Shift+I')), context);
  vm.runInContext(main.slice(main.indexOf('function createMainWindow('), main.indexOf('// Electron 43 回归')), context);
  context.createMainWindow();
  return { context, actions, events };
}

test('quiet startup stays hidden even when the previous main window was maximized', () => {
  const h = windowHarness(false, true);
  assert.deepEqual(h.actions, []);
  h.events.get('ready-to-show')();
  assert.deepEqual(h.actions, []);
  h.context.showMainWindow();
  assert.deepEqual(h.actions, ['maximize', 'show', 'focus']);
});

test('manual startup shows only after the page is ready and close-to-tray keeps it hidden', () => {
  const h = windowHarness(true);
  assert.deepEqual(h.actions, []);
  h.events.get('ready-to-show')();
  assert.deepEqual(h.actions, ['show', 'focus']);
  h.events.get('close')({ preventDefault() {} });
  assert.equal(h.context.mainWindowRequested, false);
  assert.equal(h.actions.at(-1), 'hide');
});

test('a user request before ready is remembered without showing an unfinished page', () => {
  const h = windowHarness(false);
  h.context.showMainWindow(); assert.deepEqual(h.actions, []);
  h.events.get('ready-to-show')();
  assert.deepEqual(h.actions, ['show', 'focus']);
});

test('hidden-window move events preserve deferred maximization in saved state', () => {
  let saved, callback;
  const context = { clearTimeout() {}, setTimeout(value) { callback = value; }, mainWindowRestoreMaximized: true,
    store: { saveMainWindowState(value) { saved = value; } },
    mainWindow: { isDestroyed: () => false, getNormalBounds: () => ({ x: 20, y: 20, width: 520, height: 470 }), isMaximized: () => false } };
  vm.createContext(context);
  vm.runInContext(main.slice(main.indexOf('let saveMainWindowBoundsTimer'), main.indexOf('// 从托盘/二次启动')), context);
  vm.runInContext('persistMainWindowBounds()', context); callback();
  assert.equal(saved.maximized, true);
});

test('a second autostart invocation does not open a running panel, while manual invocation does', async () => {
  let listener, calls = 0;
  const context = { app: { on(_event, callback) { listener = callback; } }, startup: { isQuietLaunch }, startupLog() {},
    mainWindow: null, showMainWindow() { calls++; } };
  vm.createContext(context);
  vm.runInContext(main.slice(main.indexOf("  app.on('second-instance'"), main.indexOf('  app.whenReady()')), context);
  await listener({}, [AUTO_START_ARG]); assert.equal(calls, 0);
  await listener({}, []); assert.equal(calls, 1);
});
