import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeWidgetShortcut, shortcutFromEvent, createWidgetShortcutManager } from '../electron/widget-shortcut.mjs';
import { createWidgetSummoner } from '../electron/widget-summon.mjs';
import { normalizeWidgetSettings } from '../electron/widget-layout.mjs';

test('two-key shortcuts normalize, default, disable and reject extra modifiers', () => {
  assert.equal(normalizeWidgetSettings().widgetShortcut, 'Alt+Q');
  assert.equal(normalizeWidgetSettings({ widgetShortcut: '' }).widgetShortcut, '');
  assert.equal(normalizeWidgetShortcut('ctrl+f24'), 'Ctrl+F24');
  assert.equal(shortcutFromEvent({ ctrlKey: true, code: 'KeyR' }), 'Ctrl+R');
  assert.equal(shortcutFromEvent({ altKey: true, code: 'Digit2' }), 'Alt+2');
  for (const value of ['Q', 'Ctrl+Alt+Q', 'Shift+Q', 'Alt+F25']) assert.equal(normalizeWidgetShortcut(value), null);
  assert.equal(shortcutFromEvent({ ctrlKey: true, altKey: true, code: 'KeyQ' }), null);
  assert.equal(shortcutFromEvent({ altKey: true, shiftKey: true, code: 'KeyQ' }), null);
});

function registration() {
  const bindings = new Map();
  const occupied = new Set();
  const calls = [];
  const api = {
    register(key, callback) { calls.push(['register', key]); if (occupied.has(key)) return false; bindings.set(key, callback); return true; },
    unregister(key) { calls.push(['unregister', key]); bindings.delete(key); },
  };
  let invocations = 0;
  return { manager: createWidgetShortcutManager(api, () => invocations++), bindings, occupied, calls, count: () => invocations };
}

test('recording suspends a binding, cancellation restores it, replacement and clearing release it', () => {
  const { manager, bindings, count } = registration();
  assert.equal(manager.set('Alt+Q').ok, true);
  bindings.get('Alt+Q')(); assert.equal(count(), 1);
  manager.setRecording(true); assert.equal(bindings.size, 0);
  manager.setRecording(false); assert.equal(bindings.has('Alt+Q'), true);
  manager.setRecording(true);
  manager.set('Ctrl+F2'); assert.deepEqual([...bindings.keys()], ['Ctrl+F2']);
  manager.set(''); assert.equal(bindings.size, 0);
  manager.set('Alt+Q'); manager.dispose(); assert.equal(bindings.size, 0);
});

test('a conflicting replacement preserves the previous shortcut and reports failure', () => {
  const { manager, bindings, occupied } = registration();
  manager.set('Alt+Q'); occupied.add('Ctrl+R');
  manager.setRecording(true);
  assert.equal(manager.set('Ctrl+R').ok, false);
  assert.deepEqual([...bindings.keys()], ['Alt+Q']);
  assert.equal(manager.status().shortcut, 'Alt+Q');
  assert.match(manager.status().error, /占用/);
  assert.equal(manager.set('Shift+Q').ok, false);
  assert.equal(bindings.has('Alt+Q'), true);
});

function harness(visible = true, ready) {
  let permanent = visible, shown = visible, fixed = { x: 300, y: 400 };
  let bounds = { ...fixed, width: 350, height: 104 };
  let cursor = { x: 700, y: 300 };
  let focused = true;
  const placements = [], saved = [];
  const window = {
    isDestroyed: () => false, getBounds: () => ({ ...bounds }), isFocused: () => focused,
    show() { shown = true; }, showInactive() { shown = true; }, hide() { shown = false; },
    moveTop() {}, focus() { focused = true; },
  };
  const controller = createWidgetSummoner({
    readyWindow: ready || (async () => window), getWindow: () => window, getCursor: () => cursor,
    getFixedPosition: () => fixed,
    place(position, centered) {
      placements.push({ position: { ...position }, centered });
      bounds = { ...bounds, x: position.x - (centered ? bounds.width / 2 : 0), y: position.y - (centered ? bounds.height / 2 : 0) };
    },
    rememberPosition(position) { fixed = { x: position.x, y: position.y }; saved.push(fixed); },
    isPermanentVisible: () => permanent, setPermanentVisible(value) { permanent = value; },
    applyPin() {}, notifyArea() {},
  });
  return { controller, window, placements, saved, visible: () => shown, permanent: () => permanent,
    move(position) { bounds = { ...bounds, ...position }; }, setCursor(point) { cursor = point; }, blur() { focused = false; controller.blur(); } };
}

test('visible panel moves temporarily to the cursor and returns to the fixed position on blur', async () => {
  const h = harness(); await h.controller.toggle();
  assert.equal(h.controller.active, true);
  assert.deepEqual(h.placements[0], { position: { x: 700, y: 300 }, centered: true });
  h.blur(); assert.equal(h.controller.active, false); assert.equal(h.visible(), true);
  assert.deepEqual(h.placements.at(-1), { position: { x: 300, y: 400 }, centered: false });
  assert.deepEqual(h.saved, []);
});

test('hidden panel is only shown temporarily, including a second shortcut press', async () => {
  const h = harness(false); await h.controller.toggle();
  assert.equal(h.visible(), true); assert.equal(h.permanent(), false);
  h.blur(); assert.equal(h.visible(), false);
  await h.controller.toggle(); await h.controller.toggle();
  assert.equal(h.visible(), false); assert.equal(h.permanent(), false);
});

test('dragging promotes a temporary hidden panel to permanent and remembers its new position', async () => {
  const h = harness(false); await h.controller.toggle();
  h.move({ x: 120, y: 180 }); h.controller.dragged();
  h.blur(); assert.equal(h.controller.active, false); assert.equal(h.visible(), true); assert.equal(h.permanent(), true);
  assert.deepEqual(h.saved, [{ x: 120, y: 180 }]);
  await h.controller.toggle(); h.blur();
  assert.deepEqual(h.placements.at(-1).position, { x: 120, y: 180 });
});

test('native menus defer blur restoration until the menu closes outside the widget', async () => {
  const h = harness(false); await h.controller.toggle();
  h.controller.menu(true); h.blur(); assert.equal(h.controller.active, true);
  h.controller.menu(false); assert.equal(h.visible(), false);
});

test('temporary resize stays centered and explicit panel changes cancel pending summons', async () => {
  const h = harness(); await h.controller.toggle();
  h.controller.reflow(); assert.equal(h.placements.at(-1).centered, true);
  let resolve;
  const pending = harness(false, () => new Promise((done) => { resolve = done; }));
  const task = pending.controller.toggle(); pending.controller.cancel(); resolve(pending.window);
  assert.equal(await task, false); assert.equal(pending.visible(), false);
});

test('native placement clamps all edges and supports a negative-coordinate monitor', () => {
  const source = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  let bounds = { x: 0, y: 0, width: 1, height: 1 };
  let area = { x: -800, y: 100, width: 800, height: 600 };
  const context = { widgetWindow: { isDestroyed: () => false, getBounds: () => bounds, setBounds: (value) => { bounds = value; } },
    screen: { getDisplayNearestPoint: () => ({ workArea: area }) }, widgetScale: 1, widgetLength: 1,
    widgetWindowSize: () => ({ width: 350, height: 104 }) };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function placeWidget('), source.indexOf('function persistWidgetPosition(')), context);
  context.placeWidget({ x: -799, y: 101 }, true);
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { x: -800, y: 100, width: 350, height: 104 });
  context.placeWidget({ x: -1, y: 699 }, true);
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { x: -350, y: 596, width: 350, height: 104 });
  area = { x: 0, y: 0, width: 250, height: 80 }; context.placeWidget({ x: 10, y: 10 }, true);
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { x: 0, y: 0, width: 250, height: 80 });
});

test('widget context menu contains exactly the three requested actions', () => {
  const source = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const context = { Menu: { buildFromTemplate: (items) => items } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function buildWidgetMenu('), source.indexOf('function createTrayIcon(')), context);
  assert.deepEqual(Array.from(context.buildWidgetMenu(), (item) => item.label), ['打开 Quota Desk', '立即刷新额度', '显示 / 隐藏浮窗']);
});
