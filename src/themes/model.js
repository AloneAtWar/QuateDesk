import designs from './catalog.json' with { type: 'json' };
import baseTokens from './base-tokens.json' with { type: 'json' };

export const DEFAULT_DARK = 'default-dark';
export const DEFAULT_LIGHT = 'default-light';
export const builtinThemes = [
  {id:DEFAULT_DARK,name:'默认暗色',description:'现有的克制暗色，专注额度与读数。',mode:'dark',group:'restrained',palette:['#141d1f','#1c282a','#dfeae5','#71ba91'],tokens:baseTokens.dark},
  {id:DEFAULT_LIGHT,name:'默认亮色',description:'现有的克制亮色，清晰自然。',mode:'light',group:'restrained',palette:['#f3f5f1','#fbfcf9','#1e282d','#277a59'],tokens:baseTokens.light},
  ...designs,
];
const builtins = new Map(builtinThemes.map(t => [t.id,t]));
export const COLOR_TOKENS = ['bg','bg-grad','surface','surface-2','surface-3','control','control-2','ink','ink-soft','muted','faint','line','line-strong','line-inner','green','green-deep','green-bg','coral','coral-deep','coral-bg','warn-border','titlebar-bg','drawer-bg','focus-border','ring-track','widget-bg','widget-row','widget-row-border','widget-text','widget-chip','widget-chip-label','widget-chip-value','widget-chip-sub','widget-tag-bg','widget-tag-text','widget-live','widget-live-label','ring-0','ring-1','ring-2','ring-3'];
const colorSet = new Set(COLOR_TOKENS);
const colorPattern = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;
const fontPattern = /^[\p{L}\p{N}\s,'"-]{1,160}$/u;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateCustomTheme(input) {
  if (!isObject(input) || ![1,2].includes(input.schemaVersion)) throw Error('主题格式无效，需要 schemaVersion 1 或 2');
  if (JSON.stringify(input).length > 512_000) throw Error('主题文件不能超过 500 KB');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 40) throw Error('主题名称应为 1–40 个字符');
  const parentId = String(input.extends || (input.mode==='light'?DEFAULT_LIGHT:DEFAULT_DARK)).replace(/^builtin\./,'');
  const parent = builtins.get(parentId);
  if (!parent) throw Error('继承的内置主题不存在');
  const mode = input.mode || parent.mode;
  if (!['light','dark'].includes(mode) || mode !== parent.mode) throw Error('明暗模式须与继承主题一致，请选择对应的亮色或暗色基础主题');
  if (input.css || input.scripts || (input.assets && Object.keys(input.assets).length)) throw Error('当前版本支持自包含参数主题；请移除 CSS、脚本及外部素材');
  const tokens = {};
  if (input.tokens !== undefined && !isObject(input.tokens)) throw Error('tokens 必须为对象');
  for (const [rawKey,value] of Object.entries(input.tokens || {})) {
    const key = rawKey.replace(/^--/,'');
    if (!colorSet.has(key)) throw Error(`不支持的主题参数：${key}`);
    if (typeof value !== 'string' || !colorPattern.test(value)) throw Error(`${key} 需要十六进制颜色`);
    tokens[key] = value;
  }
  // Read the earlier design proposal without silently dropping its main fields.
  for (const [old,key] of Object.entries({window:'bg',surface:'surface',text:'ink',accent:'green'})) {
    if (input.colors?.[old]) {
      if (!colorPattern.test(input.colors[old])) throw Error(`colors.${old} 需要十六进制颜色`);
      tokens[key] = input.colors[old];
    }
  }
  for (const [old,key] of Object.entries({background:'widget-bg',text:'widget-text'})) {
    if (input.widget?.[old]) {
      if (!colorPattern.test(input.widget[old])) throw Error(`widget.${old} 需要十六进制颜色`);
      tokens[key] = input.widget[old];
    }
  }
  if (input.charts?.rings) {
    if (!Array.isArray(input.charts.rings) || input.charts.rings.length > 4 || input.charts.rings.some(c => !colorPattern.test(c))) throw Error('圆环颜色应为最多四个十六进制颜色');
    input.charts.rings.forEach((c,i) => { tokens[`ring-${i}`] = c; });
  }
  const shape = {};
  for (const key of ['cardRadius','controlRadius','tagRadius','borderWidth']) if (input.shape?.[key] !== undefined) {
    const n = Number(input.shape[key]);
    if (!Number.isFinite(n) || n < 0 || n > (key === 'borderWidth' ? 3 : 32)) throw Error(`无效的形状参数：${key}`);
    shape[key] = n;
  }
  const typography = {};
  for (const key of ['body','heading','numeric']) if (input.typography?.[key]) {
    const value = Array.isArray(input.typography[key]) ? input.typography[key].join(',') : input.typography[key];
    if (typeof value !== 'string' || !fontPattern.test(value)) throw Error(`无效的字体：${key}`);
    typography[key] = value;
  }
  const material={preset:input.material?.preset || 'inherit'};
  if(!['inherit','paper','grid','glass','scanline','solid'].includes(material.preset)) throw Error('不支持的材质类型');
  for(const [key,max] of [['textureOpacity',.2],['surfaceOpacity',1],['blur',20]]) if(input.material?.[key]!==undefined){
    const value=Number(input.material[key]);
    if(!Number.isFinite(value)||value<0||value>max) throw Error(`无效的材质参数：${key}`);
    material[key]=value;
  }
  if(input.material?.shadowPreset){
    if(!['none','soft','offset-paper'].includes(input.material.shadowPreset)) throw Error('不支持的阴影类型');
    material.shadowPreset=input.material.shadowPreset;
  }
  const safeId = String(input.id || '').replace(/^custom[.-]/,'');
  if (safeId && !/^[a-z0-9][a-z0-9-]{0,60}$/.test(safeId)) throw Error('主题 ID 只能包含小写字母、数字和短横线');
  return {schemaVersion:2,id:`custom-${safeId || Date.now().toString(36)}`,name:input.name.trim(),version:String(input.version || '1.0.0').slice(0,30),author:String(input.author || '').slice(0,60),description:String(input.description || '自定义主题').slice(0,240),extends:parentId,mode,tokens,shape,typography,material};
}

export function getThemes(preferences = {}) {
  preferences = isObject(preferences) ? preferences : {};
  const custom = [];
  for (const item of (Array.isArray(preferences.customThemes) ? preferences.customThemes.slice(0,50) : [])) {
    try { const theme = validateCustomTheme(item); if (!custom.some(t => t.id === theme.id)) custom.push({...theme,group:'custom',palette:Object.values(theme.tokens).slice(0,4),custom:true}); } catch { /* Invalid backups fall back to builtins. */ }
  }
  return [...builtinThemes,...custom];
}

export function normalizeAppearance(preferences = {}) {
  preferences = isObject(preferences) ? preferences : {};
  const themes = getThemes(preferences);
  const has = id => themes.some(t => t.id === id);
  const legacy = preferences.theme === 'light' ? DEFAULT_LIGHT : DEFAULT_DARK;
  const validFor = (id,mode) => themes.some(t => t.id === id && t.mode === mode);
  return {
    themeId:has(preferences.themeId) ? preferences.themeId : legacy,
    appearancePolicy:preferences.appearancePolicy === 'system' ? 'system' : 'fixed',
    lightThemeId:validFor(preferences.lightThemeId,'light') ? preferences.lightThemeId : DEFAULT_LIGHT,
    darkThemeId:validFor(preferences.darkThemeId,'dark') ? preferences.darkThemeId : DEFAULT_DARK,
    customThemes:themes.filter(t => t.custom).map(({custom,group,palette,...theme}) => theme),
  };
}

export function resolveTheme(preferences = {}, systemDark = false) {
  const normalized = normalizeAppearance(preferences);
  const id = normalized.appearancePolicy === 'system' ? (systemDark ? normalized.darkThemeId : normalized.lightThemeId) : normalized.themeId;
  const theme = getThemes(normalized).find(t => t.id === id) || builtinThemes[0];
  const parent = theme.custom ? builtins.get(theme.extends) : theme;
  const tokens = {...parent.tokens,...Object.fromEntries(Object.entries(theme.custom ? theme.tokens : {}).map(([k,v])=>[`--${k}`,v]))};
  return {...theme,baseId:parent.id,tokens,background:tokens['--bg'] || (theme.mode === 'light' ? '#f3f5f1' : '#141d1f'),widgetBackground:tokens['--widget-bg'] || (theme.mode === 'light' ? '#eef1ec' : '#202c2e')};
}

export function copyTheme(theme, name = `${theme.name} · 自定义`) {
  return validateCustomTheme({schemaVersion:2,id:`copy-${Date.now().toString(36)}`,name:name.slice(0,40),extends:theme.custom ? theme.extends : theme.id,mode:theme.mode,tokens:theme.custom ? theme.tokens : {},shape:theme.shape || {},typography:theme.typography || {},material:theme.material || {}});
}
