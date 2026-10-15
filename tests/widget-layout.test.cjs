const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let widgetWindowSize, computeWidgetGeometry, normalizeWidgetSettings, commitWidgetLayout, clampWidgetScale, clampWidgetInterval;
before(async () => {
  ({ widgetWindowSize, computeWidgetGeometry, normalizeWidgetSettings, commitWidgetLayout, clampWidgetScale, clampWidgetInterval } = await import('../electron/widget-layout.mjs'));
});
const accounts = (count) => Array.from({ length: count }, (_, id) => ({ id }));
const custom = (rows, columns, extra = {}) => ({ widgetLayout: 'custom', widgetGridRows: rows, widgetGridColumns: columns, widgetScale: 1, widgetLength: 1, ...extra });

test('new installations use automatic layout and no carousel', () => {
  const settings = normalizeWidgetSettings();
  assert.equal(settings.widgetLayout, 'auto');
  assert.equal(settings.widgetCarousel, false);
  assert.equal(settings.widgetCarouselSeconds, 6);
  assert.equal(settings.widgetGridRemembered, false);
  assert.equal(settings.widgetAlwaysOnTop, true);
  assert.equal(normalizeWidgetSettings({ widgetAlwaysOnTop: false }).widgetAlwaysOnTop, false);
});

test('automatic layout favors rows, up to nine accounts on each page', () => {
  const expected = [[1,1], [2,1], [2,2], [2,2], [3,2], [3,2], [3,3], [3,3], [3,3], [3,3]];
  expected.forEach(([rows, columns], index) => {
    const geometry = computeWidgetGeometry(index + 1);
    assert.equal(geometry.rows, rows);
    assert.equal(geometry.columns, columns);
    assert.equal(geometry.pageSize, rows * columns);
  });
});

test('empty first custom edit remains auto, a missing dimension uses 1 by 2', () => {
  assert.equal(commitWidgetLayout({}, { mode: 'custom', rows: '', columns: '' }).widgetLayout, 'auto');
  assert.equal(commitWidgetLayout({}, { mode: 'custom', rows: '0', columns: '0' }).widgetLayout, 'auto');
  const missingColumn = commitWidgetLayout({}, { mode: 'custom', rows: '3', columns: '' });
  assert.equal(missingColumn.widgetGridRows, 3);
  assert.equal(missingColumn.widgetGridColumns, 2);
  const missingRow = commitWidgetLayout({}, { mode: 'custom', rows: '', columns: '4' });
  assert.equal(missingRow.widgetGridRows, 1);
  assert.equal(missingRow.widgetGridColumns, 4);
});

test('custom values survive auto, restart and empty or zero edits', () => {
  const first = commitWidgetLayout({}, { mode: 'custom', rows: '4', columns: '6' });
  const auto = commitWidgetLayout(first, { mode: 'auto', rows: '4', columns: '6' });
  const restart = normalizeWidgetSettings(JSON.parse(JSON.stringify(auto)));
  const restored = commitWidgetLayout(restart, { mode: 'custom', rows: '0', columns: '' });
  assert.equal(restored.widgetLayout, 'custom');
  assert.equal(restored.widgetGridRows, 4);
  assert.equal(restored.widgetGridColumns, 6);
});

test('custom dimensions are limited to fifteen and old layouts migrate', () => {
  const result = commitWidgetLayout({}, { mode: 'custom', rows: '99', columns: '15' });
  assert.equal(result.widgetGridRows, 15);
  assert.equal(result.widgetGridColumns, 15);
  assert.equal(normalizeWidgetSettings({ widgetLayout: '1x2' }).widgetGridColumns, 2);
  assert.equal(normalizeWidgetSettings({ widgetLayout: 'nx3', widgetGridRows: 2 }).widgetGridColumns, 3);
  assert.equal(normalizeWidgetSettings({ widgetColumns: 2 }).widgetLayout, 'custom');
  assert.equal(normalizeWidgetSettings({ widgetLayout: 'auto', widgetColumns: 2 }).widgetLayout, 'auto');
  assert.equal(normalizeWidgetSettings({ widgetLayout: 'custom', widgetGridColumns: 5, widgetColumns: 2 }).widgetGridColumns, 5);
  assert.equal(normalizeWidgetSettings({ widgetLayout: 'nx3', widgetGridRows: 1 }).widgetGridRows, 2);
});

test('unused whole rows and columns collapse based on total active accounts', () => {
  assert.deepEqual(widgetWindowSize(1, 1, accounts(1), 'custom', 2, 2), { width: 350, height: 52 });
  assert.deepEqual(widgetWindowSize(1, 1, accounts(3), 'custom', 2, 2), { width: 700, height: 104 });
  assert.deepEqual(widgetWindowSize(1, 1, [...accounts(1), { disabled: true }], 'custom', 15, 15), { width: 350, height: 52 });
});

test('one by two stays fixed for every page including the last account', () => {
  const geometry = computeWidgetGeometry(5, custom(1, 2));
  assert.equal(geometry.pageSize, 2);
  assert.equal(geometry.width, 700);
  assert.equal(geometry.height, 52);
  assert.deepEqual(computeWidgetGeometry(5, custom(1, 2, { widgetCarousel: true })), geometry);
});

test('fractional percentages retain precision and respect size limits', () => {
  assert.equal(clampWidgetScale(1.27), 1.27);
  assert.equal(clampWidgetScale(9), 3);
  assert.equal(clampWidgetScale(0), 0);
  const geometry = computeWidgetGeometry(1, custom(1, 1, { widgetScale: 1.27 }));
  assert.equal(geometry.cellWidth, 445);
  assert.equal(geometry.cellHeight, 66);
});

test('both large dimensions shrink but a single large dimension does not', () => {
  assert.equal(computeWidgetGeometry(36, custom(6, 6), { width: 10000, height: 10000 }).scale, 5 / 6);
  assert.equal(computeWidgetGeometry(6, custom(6, 1), { width: 10000, height: 10000 }).scale, 1);
});

test('screen fitting preserves readable cells and paginates excess capacity', () => {
  const settings = custom(15, 15, { widgetScale: 3 });
  const geometry = computeWidgetGeometry(225, settings, { width: 800, height: 600 }, { width: 190, height: 36 });
  assert.ok(geometry.width <= 800 && geometry.height <= 600);
  assert.ok(geometry.cellWidth >= 190 && geometry.cellHeight >= 36);
  assert.equal(geometry.columns, 4);
  assert.ok(geometry.pageSize < 225);
  assert.equal(settings.widgetScale, 3);
});

test('one-quota and two-quota accounts use the same cell geometry', () => {
  const single = [{ windows: [{ key: 'daily' }] }];
  const double = [{ windows: [{ key: 'daily' }, { key: 'weekly' }] }];
  assert.deepEqual(widgetWindowSize(1, 1, single), widgetWindowSize(1, 1, double));
});

test('shortened large cells cap content scale to fit long quota values', () => {
  const geometry = computeWidgetGeometry(2, custom(1, 2, { widgetScale: 3, widgetLength: 0.6 }), { width: 1600, height: 1000 }, { width: 370, height: 36 });
  assert.ok(geometry.scale * 370 <= geometry.cellWidth);
  assert.equal(geometry.cellWidth, 800);
});

test('zero and small requested sizes stop at the readable minimum', () => {
  const minimum = { width: 143, height: 36 };
  for (const widgetScale of [0, 0.01, 0.1, 0.2]) {
    const geometry = computeWidgetGeometry(2, custom(2, 1, { widgetScale }), { width: 1920, height: 1080 }, minimum);
    assert.equal(geometry.cellWidth, 143);
    assert.equal(geometry.cellHeight, 36);
    assert.equal(geometry.height, 72);
  }
});

test('shortest length fits icon and values instead of reserving hidden name space', () => {
  const geometry = computeWidgetGeometry(1, custom(1, 1, { widgetLength: 0.6 }), undefined, { width: 130, height: 36 });
  assert.equal(geometry.cellWidth, 130);
});

test('unpinning remains effective when showing or focusing other windows', () => {
  const main = fs.readFileSync(require.resolve('../electron/main.cjs'), 'utf8');
  const source = main.slice(main.indexOf('function ensureWidgetOnTop('), main.indexOf('function createWidgetWindow('));
  const calls = [];
  let pinned = false;
  const context = {
    store: { loadState: () => ({ settings: { widgetAlwaysOnTop: pinned } }) },
    widgetWindow: { isDestroyed: () => false, isVisible: () => true, setAlwaysOnTop: (...args) => calls.push(args), moveTop: () => calls.push('moveTop') },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.ensureWidgetOnTop();
  assert.deepEqual(calls, [[false]]);
  pinned = true;
  context.ensureWidgetOnTop();
  assert.deepEqual(calls, [[false], [true, 'screen-saver'], 'moveTop']);
  pinned = false;
  context.ensureWidgetOnTop();
  assert.deepEqual(calls.at(-1), [false]);
});

test('carousel interval accepts one through six hundred seconds', () => {
  assert.equal(clampWidgetInterval(1), 1);
  assert.equal(clampWidgetInterval(600), 600);
  assert.equal(clampWidgetInterval(0), 1);
  assert.equal(clampWidgetInterval(601), 600);
  assert.equal(clampWidgetInterval(undefined), 6);
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
