import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resolveTheme } from './model.js';
import './builtins.css';
import './themes.css';

const ThemeContext = createContext(null);
export function ThemeProvider({children}) {
  const [preferences,setPreferences] = useState({});
  const [preview,setPreview] = useState(null);
  const commitRef=useRef(null);
  const [systemDark,setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change',update);
    return () => media.removeEventListener('change',update);
  },[]);
  const theme = useMemo(() => resolveTheme(preview || preferences,systemDark),[preferences,preview,systemDark]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme.mode;
    root.dataset.themeId = theme.baseId;
    root.dataset.themeSelection = theme.id;
    root.toggleAttribute('data-custom-theme',Boolean(theme.custom));
    root.dataset.themeMaterial=theme.custom ? theme.material.preset : 'inherit';
    for(const key of ['body','heading','numeric'])root.toggleAttribute(`data-theme-font-${key}`,Boolean(theme.custom&&theme.typography[key]));
    for(const [key,attribute] of [['cardRadius','card-radius'],['controlRadius','control-radius'],['tagRadius','tag-radius'],['borderWidth','border-width']])root.toggleAttribute(`data-theme-shape-${attribute}`,Boolean(theme.custom&&theme.shape[key]!==undefined));
    const applied = [];
    if (theme.custom) {
      for (const [key,value] of Object.entries(theme.tokens)) { root.style.setProperty(key,value); applied.push(key); }
      for (const [key,value] of Object.entries(theme.shape)) { const token=`--theme-${key}`;root.style.setProperty(token,`${value}px`);applied.push(token); }
      for (const [key,value] of Object.entries(theme.typography)) { const token=`--theme-font-${key}`;root.style.setProperty(token,value);applied.push(token); }
      for(const [key,value] of Object.entries(theme.material)) if(typeof value==='number'){const token=`--theme-${key}`;root.style.setProperty(token,key==='blur'?`${value}px`:String(value));applied.push(token);}
      if(theme.material.shadowPreset){root.dataset.themeShadow=theme.material.shadowPreset;}else{delete root.dataset.themeShadow;}
    }
    root.style.colorScheme = theme.mode;
    // Native WebViews only need the resolved mode for their system-bar icons.
    window.dispatchEvent(new CustomEvent('qd-theme-changed',{detail:{id:theme.id,mode:theme.mode,background:theme.background}}));
    return () => { for (const key of applied) root.style.removeProperty(key); };
  },[theme]);
  const value = useMemo(() => ({theme,preferences,setPreferences,preview,setPreview,systemDark,commitRef}),[theme,preferences,preview,systemDark]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);
export function useThemeSource(preferences, commit) {
  const context = useTheme();
  useLayoutEffect(() => { context?.setPreferences(preferences); },[preferences,context?.setPreferences]);
  useLayoutEffect(()=>{if(context)context.commitRef.current=commit;},[commit,context?.commitRef]);
  return context?.theme || resolveTheme(preferences);
}
