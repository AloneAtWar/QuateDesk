import { useEffect, useLayoutEffect, useState } from 'react';
import { resolveTheme } from '../electron/widget-appearance.mjs';

export function useAppTheme(preference) {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    let active = true;
    let changed = false;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = (event) => { changed = true; setSystemDark(event.matches); };
    media.addEventListener('change', change);
    const apply = (theme) => { changed = true; if (active) setSystemDark(theme === 'dark'); };
    window.quotaDesk?.getSystemTheme?.().then((theme) => { if (active && !changed) setSystemDark(theme === 'dark'); }).catch(() => {});
    const unsubscribe = window.quotaDesk?.onSystemThemeChanged?.(apply);
    return () => { active = false; media.removeEventListener('change', change); unsubscribe?.(); };
  }, []);
  const theme = resolveTheme(preference, systemDark);
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return theme;
}
