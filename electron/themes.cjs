const catalog = require('./theme-catalog.json');
const themes = [{id:'default-dark',mode:'dark',background:'#141d1f',widgetBackground:'#202c2e'},{id:'default-light',mode:'light',background:'#f3f5f1',widgetBackground:'#eef1ec'},...catalog];
const color = (value,fallback) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : typeof value === 'string' && /^#[\da-f]{3}$/i.test(value) ? '#'+[...value.slice(1)].map(c=>c+c).join('') : fallback;
function resolveWindowTheme(settings={},systemDark=false) {
  const system=settings.appearancePolicy==='system';
  const fallback=themes[system ? (systemDark?0:1) : settings.theme==='light'?1:0];
  const id=system ? (systemDark?settings.darkThemeId:settings.lightThemeId) : settings.themeId;
  const custom=(Array.isArray(settings.customThemes)?settings.customThemes:[]).find(t=>t?.id===id);
  const candidate=themes.find(t=>t.id === (custom?.extends || id));
  const theme=candidate && (!system || candidate.mode===fallback.mode) ? candidate : fallback;
  return {...theme,background:color(custom?.tokens?.bg,theme.background),widgetBackground:color(custom?.tokens?.['widget-bg'],theme.widgetBackground)};
}
function windowColors(input) {
  const fallback=themes[input==='light'||input?.mode==='light'?1:0];
  return {main:color(input?.background,fallback.background),widget:color(input?.widgetBackground,fallback.widgetBackground)};
}
module.exports={resolveWindowTheme,windowColors};
