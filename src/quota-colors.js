import { windowCatalog } from './data.js';

// Cycle identity, independent of ring position or the other cycles on an account.
export const QUOTA_COLORS = Object.fromEntries(Object.entries(windowCatalog).map(([key, window]) => [
  key, `var(--${window.color === 'mint' ? 'green-deep' : window.color})`,
]));
const fallbackColors = ['cyan', 'violet', 'coral', 'green', 'sky'];

export const quotaColor = (key) => {
  if (Object.hasOwn(QUOTA_COLORS, key)) return QUOTA_COLORS[key];
  const hash = [...String(key)].reduce((value, char) => value + char.charCodeAt(0), 0);
  return `var(--${fallbackColors[hash % fallbackColors.length]})`;
};
