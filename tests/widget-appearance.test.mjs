import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTheme, resolveTheme, normalizeWidgetText, widgetTextStyles, outlineColor } from '../electron/widget-appearance.mjs';
import { computeWidgetGeometry } from '../electron/widget-layout.mjs';

test('system mode resolves current system appearance without changing fixed modes', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(normalizeTheme(undefined), 'dark');
});
test('partial legacy settings gain complete defaults without losing custom colors', () => {
  const settings = normalizeWidgetText({ widgetText: { quota: { size: 24, weight: 800 } }, widgetTextColors: { light: { quota: '#ABCDEF' } } });
  assert.equal(settings.widgetText.quota.size, 24);
  assert.equal(settings.widgetText.quota.weight, 800);
  assert.equal(settings.widgetText.name.size, 11);
  assert.equal(settings.widgetTextColors.light.quota, '#abcdef');
  assert.equal(settings.widgetTextColors.dark.quota, null);
});
test('invalid values are bounded or return to theme defaults', () => {
  const settings = normalizeWidgetText({ widgetText: { quota: { size: 1000, weight: 99 }, reset: { size: 1, weight: 600 } }, widgetTextColors: { dark: { reset: 'red;opacity:0' } } });
  assert.equal(settings.widgetText.quota.size, 32);
  assert.equal(settings.widgetText.quota.weight, 700);
  assert.equal(settings.widgetText.reset.size, 8);
  assert.equal(settings.widgetTextColors.dark.reset, null);
});
test('separate theme palettes survive serialization and select the correct colors', () => {
  const settings = JSON.parse(JSON.stringify(normalizeWidgetText({ widgetTextColors: { light: { quota: '#112233', reset: '#445566' }, dark: { quota: '#aabbcc' } } })));
  assert.equal(widgetTextStyles(settings, 'light')['--widget-quota-color'], '#112233');
  assert.equal(widgetTextStyles(settings, 'dark')['--widget-quota-color'], '#aabbcc');
  assert.equal(widgetTextStyles(settings, 'light')['--widget-reset-color'], '#445566');
  settings.widgetTextColors.light.quota = null;
  assert.notEqual(widgetTextStyles(settings, 'light')['--widget-quota-color'], '#112233');
  assert.equal(widgetTextStyles(settings, 'dark')['--widget-quota-color'], '#aabbcc');
});
test('outlines choose the opposite brightness per text category and can be disabled', () => {
  assert.equal(outlineColor('#ffffff'), '#111111');
  assert.equal(outlineColor('#000000'), '#ffffff');
  const style = widgetTextStyles({ widgetTextOutline: true, widgetTextColors: { light: { quota: '#ffffff', reset: '#000000' } } }, 'light');
  assert.ok(style['--widget-quota-shadow'].includes('#111111'));
  assert.ok(style['--widget-reset-shadow'].includes('#ffffff'));
  assert.equal(widgetTextStyles({}, 'dark')['--widget-quota-shadow'], 'none');
});
test('large text can raise minimum height and reduce page capacity', () => {
  const geometry = computeWidgetGeometry(225, { widgetLayout: 'custom', widgetGridRows: 15, widgetGridColumns: 15, widgetScale: 0 }, { width: 800, height: 600 }, { width: 300, height: 66 });
  assert.equal(geometry.columns, 2);
  assert.equal(geometry.rows, 9);
  assert.equal(geometry.cellHeight, 66);
  assert.equal(geometry.cellWidth, 300);
});
