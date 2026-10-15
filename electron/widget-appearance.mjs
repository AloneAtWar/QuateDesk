export const TEXT_KINDS = ['name', 'quota', 'period', 'reset'];
export const TEXT_LABELS = { name: '账号名称', quota: '额度数字', period: '周期标记', reset: '倒计时' };
export const TEXT_DEFAULTS = {
  name: { size: 11, weight: 500 }, quota: { size: 11, weight: 700 },
  period: { size: 8, weight: 500 }, reset: { size: 8, weight: 400 },
};
export const TEXT_COLORS = {
  light: { name: '#263236', quota: '#1e5c3d', period: '#52675c', reset: '#596a61' },
  dark: { name: '#edf5f0', quota: '#dcf5e2', period: '#bbcfc4', reset: '#c0cec7' },
};
export const normalizeTheme = (theme) => ['light', 'dark', 'system'].includes(theme) ? theme : 'dark';
export const resolveTheme = (theme, systemDark = false) => normalizeTheme(theme) === 'system' ? (systemDark ? 'dark' : 'light') : normalizeTheme(theme);
const colorValue = (value) => /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : null;
export function normalizeWidgetText(settings = {}) {
  const source = settings.widgetText || {};
  return {
    widgetText: Object.fromEntries(TEXT_KINDS.map((key) => {
      const size = Number(source[key]?.size);
      const weight = Number(source[key]?.weight);
      return [key, {
        size: Number.isFinite(size) && size > 0 ? Math.min(32, Math.max(8, Math.round(size))) : TEXT_DEFAULTS[key].size,
        weight: [400, 500, 600, 700, 800].includes(weight) ? weight : TEXT_DEFAULTS[key].weight,
      }];
    })),
    widgetTextColors: Object.fromEntries(['light', 'dark'].map((theme) => [theme,
      Object.fromEntries(TEXT_KINDS.map((key) => [key, colorValue(settings.widgetTextColors?.[theme]?.[key])]))])),
    widgetTextOutline: settings.widgetTextOutline === true,
  };
}
export function outlineColor(color) {
  const rgb = color.slice(1).match(/../g).map((hex) => parseInt(hex, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 0.179 ? '#111111' : '#ffffff';
}
export function widgetTextStyles(settings, theme) {
  const normalized = normalizeWidgetText(settings);
  const bank = theme === 'light' ? 'light' : 'dark';
  const style = {};
  for (const key of TEXT_KINDS) {
    const color = normalized.widgetTextColors[bank][key] || TEXT_COLORS[bank][key];
    const edge = outlineColor(color);
    style[`--widget-${key}-size`] = `${normalized.widgetText[key].size}px`;
    style[`--widget-${key}-weight`] = normalized.widgetText[key].weight;
    style[`--widget-${key}-color`] = color;
    style[`--widget-${key}-shadow`] = normalized.widgetTextOutline
      ? `-1px -1px 0 ${edge}, 0 -1px 0 ${edge}, 1px -1px 0 ${edge}, -1px 0 0 ${edge}, 1px 0 0 ${edge}, -1px 1px 0 ${edge}, 0 1px 0 ${edge}, 1px 1px 0 ${edge}` : 'none';
  }
  return style;
}
