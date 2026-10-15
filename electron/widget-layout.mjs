import { normalizeWidgetText } from './widget-appearance.mjs';
import { normalizeWidgetShortcut } from './widget-shortcut.mjs';
export const WIDGET_BASE_SIZE = { width: 350, height: 52 };
export const WIDGET_MIN_LENGTH = 0.6;
export const WIDGET_MAX_LENGTH = 1.5;
export const WIDGET_MIN_CELL = { width: 130, height: 36 };

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && value !== '' && value != null ? Math.min(max, Math.max(min, number)) : fallback;
};
export const clampWidgetScale = (value) => Math.round(clamp(value, 0, 3, 0.9) * 100) / 100;
export const clampWidgetLength = (value) => Math.round(clamp(value, WIDGET_MIN_LENGTH, WIDGET_MAX_LENGTH, 0.9) * 100) / 100;
export const clampWidgetGridNumber = (value, fallback = 1) => Number(value) > 0 ? Math.round(clamp(value, 1, 15, fallback)) : fallback;
export const clampWidgetInterval = (value) => Math.round(clamp(value, 1, 600, 6));
export const clampWidgetOpacity = (value) => Math.round(clamp(value, 0, 100, 100));

export function normalizeWidgetSettings(value = {}) {
  const fixed = /^(\d+)x(\d+)$/.exec(value.widgetLayout || '');
  const oldRows = /^([1-5])xn$/.exec(value.widgetLayout || '');
  const oldColumns = /^nx([1-5])$/.exec(value.widgetLayout || '');
  const legacyColumns = !value.widgetLayout && Number(value.widgetColumns) === 2;
  const legacy = fixed || oldRows || oldColumns || legacyColumns;
  const remembered = value.widgetGridRemembered === true || value.widgetLayout === 'custom' || Boolean(legacy);
  return {
    widgetLayout: value.widgetLayout === 'custom' || legacy ? 'custom' : 'auto',
    widgetGridRows: clampWidgetGridNumber(fixed?.[1] ?? oldRows?.[1] ?? (oldColumns && (!value.widgetGridRows || Number(value.widgetGridRows) === 1) ? 2 : value.widgetGridRows), 1),
    widgetGridColumns: clampWidgetGridNumber(fixed?.[2] ?? oldColumns?.[1] ?? (legacyColumns || (oldRows && (!value.widgetGridColumns || Number(value.widgetGridColumns) === 1)) ? 2 : value.widgetGridColumns), 2),
    widgetGridRemembered: remembered,
    widgetCarousel: value.widgetCarousel === true,
    widgetCarouselSeconds: clampWidgetInterval(value.widgetCarouselSeconds),
    widgetOpacity: clampWidgetOpacity(value.widgetOpacity),
    widgetAlwaysOnTop: value.widgetAlwaysOnTop !== false,
    widgetShortcut: normalizeWidgetShortcut(value.widgetShortcut) ?? 'Alt+Q',
    ...normalizeWidgetText(value),
  };
}

export function commitWidgetLayout(settings, draft) {
  const previous = normalizeWidgetSettings(settings);
  const hasInput = Number(draft.rows) > 0 || Number(draft.columns) > 0;
  return {
    widgetLayout: draft.mode === 'auto' || (!hasInput && !previous.widgetGridRemembered) ? 'auto' : 'custom',
    widgetGridRows: clampWidgetGridNumber(draft.rows, previous.widgetGridRemembered ? previous.widgetGridRows : 1),
    widgetGridColumns: clampWidgetGridNumber(draft.columns, previous.widgetGridRemembered ? previous.widgetGridColumns : 2),
    widgetGridRemembered: previous.widgetGridRemembered || hasInput,
  };
}

export function resolveWidgetGrid(count, layout = 'auto', customRows = 1, customColumns = 2) {
  const total = Math.max(1, Math.floor(Number(count) || 0));
  const settings = normalizeWidgetSettings({ widgetLayout: layout, widgetGridRows: customRows, widgetGridColumns: customColumns });
  let rows;
  let columns;
  if (settings.widgetLayout === 'auto') {
    const cells = Math.min(total, 9);
    rows = Math.ceil(Math.sqrt(cells));
    columns = Math.ceil(cells / rows);
  } else {
    columns = Math.min(total, settings.widgetGridColumns);
    rows = Math.min(settings.widgetGridRows, Math.ceil(total / columns));
  }
  return { rows, columns, pageSize: rows * columns };
}

// The configured percentage is retained; only the rendered geometry is capped.
export function computeWidgetGeometry(count, settings = {}, workArea = { width: 1920, height: 1080 }, minimum = WIDGET_MIN_CELL) {
  const normalized = normalizeWidgetSettings(settings);
  const grid = resolveWidgetGrid(count, normalized.widgetLayout, normalized.widgetGridRows, normalized.widgetGridColumns);
  const availableWidth = Math.max(1, Number(workArea.width) || 1920);
  const availableHeight = Math.max(1, Number(workArea.height) || 1080);
  const minWidth = Math.min(availableWidth, Math.max(WIDGET_MIN_CELL.width, minimum.width || 0));
  const minHeight = Math.min(availableHeight, Math.max(WIDGET_MIN_CELL.height, minimum.height || 0));
  const columns = Math.min(grid.columns, Math.max(1, Math.floor(availableWidth / minWidth)));
  const rows = Math.min(grid.rows, Math.max(1, Math.floor(availableHeight / minHeight)));
  let scale = clampWidgetScale(settings.widgetScale);
  if (grid.rows > 5 && grid.columns > 5) scale *= 5 / Math.max(grid.rows, grid.columns);
  const length = clampWidgetLength(settings.widgetLength);
  // At the shortest length, use the measured icon + two quota values.
  // Keep the original 100% width and expanded range unchanged.
  const baseWidth = length < 1
    ? minWidth + (Math.max(minWidth, WIDGET_BASE_SIZE.width) - minWidth) * (length - WIDGET_MIN_LENGTH) / (1 - WIDGET_MIN_LENGTH)
    : Math.max(minWidth, WIDGET_BASE_SIZE.width * length);
  // Cap each window dimension independently: a width limit must not cancel
  // a size increase or make the row shorter when the length grows.
  const cellWidth = Math.min(Math.floor(availableWidth / columns), Math.max(Math.ceil(minWidth), Math.round(baseWidth * scale)));
  const cellHeight = Math.min(Math.floor(availableHeight / rows), Math.max(minHeight, Math.round(WIDGET_BASE_SIZE.height * scale)));
  // Long quota values also limit text/icon scaling when the length is shortened.
  const contentScale = Math.min(scale, cellWidth / minWidth, cellHeight / minHeight);
  return { rows, columns, pageSize: rows * columns, width: columns * cellWidth, height: rows * cellHeight, cellWidth, cellHeight, scale: contentScale,
    widthLimited: baseWidth * scale > availableWidth / columns, heightLimited: WIDGET_BASE_SIZE.height * scale > availableHeight / rows };
}

export function widgetWindowSize(scale, length = 0.9, accounts = [], layout = 'auto', customRows = 1, customColumns = 2, workArea, minimum) {
  const geometry = computeWidgetGeometry(accounts.filter((item) => !item.disabled).length,
    { widgetScale: scale, widgetLength: length, widgetLayout: layout, widgetGridRows: customRows, widgetGridColumns: customColumns }, workArea, minimum);
  return { width: geometry.width, height: geometry.height };
}
