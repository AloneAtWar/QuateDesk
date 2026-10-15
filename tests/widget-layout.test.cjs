const test = require('node:test');
const assert = require('node:assert/strict');
const { widgetWindowSize } = require('../electron/widget-layout.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const accounts = (count) => Array.from({ length: count }, (_, id) => ({ id }));

test('the default 1x1 layout keeps one account per page', () => {
  assert.deepEqual(widgetWindowSize(1, 1, accounts(1)), { width: 350, height: 52 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(2)), { width: 350, height: 52 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(3)), { width: 350, height: 52 });
});

test('a fixed 1x2 layout keeps two cells per page', () => {
  assert.deepEqual(widgetWindowSize(1, 1, accounts(1), '1x2'), { width: 700, height: 52 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(2), '1x2'), { width: 700, height: 52 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(3), '1x2'), { width: 700, height: 52 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(4), '1x2'), { width: 700, height: 52 });
});

test('two rows and two columns keep four cells per page', () => {
  assert.deepEqual(widgetWindowSize(1, 1, accounts(1), '2x2'), { width: 700, height: 104 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(4), '2x2'), { width: 700, height: 104 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(5), '2x2'), { width: 700, height: 104 });
});

test('legacy aliases use a fixed two-cell dimension by default', () => {
  assert.deepEqual(widgetWindowSize(1, 1, accounts(1), 'nx2'), { width: 700, height: 104 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(2), 'nx2'), { width: 700, height: 104 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(3), 'nx2'), { width: 700, height: 104 });
});

test('auto carousel does not change the selected page grid', () => {
  assert.deepEqual(widgetWindowSize(1, 1, accounts(1), '1x2'), { width: 700, height: 52 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(4), '2x2'), { width: 700, height: 104 });
});

test('row and column families, plus custom grids, resolve predictably', () => {
  assert.deepEqual(widgetWindowSize(1, 1, accounts(5), '2xn'), { width: 700, height: 104 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(5), 'nx3'), { width: 1050, height: 104 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(8), 'custom', 2, 3), { width: 1050, height: 104 });
});

test('disabled accounts do not consume space and empty states keep one row', () => {
  assert.deepEqual(widgetWindowSize(1, 1, [...accounts(2), { disabled: true }], 'nx2'), { width: 700, height: 104 });
  assert.deepEqual(widgetWindowSize(1, 1, [{ disabled: true }], 'nx2'), { width: 700, height: 104 });
  assert.deepEqual(widgetWindowSize(1, 1), { width: 350, height: 52 });
});

test('size and length retain their independent scaling behavior', () => {
  assert.deepEqual(widgetWindowSize(3, 0.6, accounts(3), 'nx2'), { width: 1260, height: 312 });
  assert.deepEqual(widgetWindowSize(0.9, 0.9, accounts(2)), { width: 284, height: 47 });
});

const createResizeHarness = ({ bounds, area, requested }) => {
  const main = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
  const source = main.slice(main.indexOf('function applyWidgetSize('), main.indexOf('function applyTheme('));
  const updates = [];
  const context = {
    widgetScale: 1, widgetLength: 1,
    clampWidgetScale: (value) => value, clampWidgetLength: (value) => value,
    widgetWindowSize: () => requested,
    widgetWindow: { isDestroyed: () => false, getBounds: () => bounds, setBounds: (value) => updates.push(value) },
    screen: { getDisplayMatching: () => ({ workArea: area }) },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { resize: () => context.applyWidgetSize(1, 1), updates };
};

test('resizing after an addition preserves the bottom right corner', () => {
  const harness = createResizeHarness({ bounds: { x: 500, y: 500, width: 350, height: 52 }, area: { x: 0, y: 0, width: 1920, height: 1080 }, requested: { width: 350, height: 104 } });
  harness.resize();
  assert.equal(JSON.stringify(harness.updates[0]), JSON.stringify({ x: 500, y: 448, width: 350, height: 104 }));
});

test('many accounts and large scale are constrained to the current monitor', () => {
  const harness = createResizeHarness({ bounds: { x: -700, y: 300, width: 350, height: 52 }, area: { x: -800, y: 100, width: 800, height: 600 }, requested: { width: 2100, height: 1560 } });
  harness.resize();
  assert.equal(JSON.stringify(harness.updates[0]), JSON.stringify({ x: -800, y: 100, width: 800, height: 600 }));
});

test('a quota refresh without layout changes does not reposition the window', () => {
  const harness = createResizeHarness({ bounds: { x: 500, y: 500, width: 350, height: 104 }, area: { x: 0, y: 0, width: 1920, height: 1080 }, requested: { width: 350, height: 104 } });
  harness.resize();
  assert.equal(harness.updates.length, 0);
});
