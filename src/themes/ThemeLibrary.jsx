import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, Palette, Trash2, Upload, X } from 'lucide-react';
import { builtinThemes, copyTheme, getThemes, normalizeAppearance, resolveTheme, validateCustomTheme } from './model.js';
import { useTheme } from './runtime.jsx';

const colorFields = [['bg','窗口背景'],['surface','卡片底色'],['ink','主要文字'],['green','强调色'],['widget-bg','浮窗底色'],['widget-chip-value','浮窗读数'],['ring-0','第一层圆环'],['ring-1','第二层圆环']];
export default function ThemeLibrary({preferences={},onChange,compact=false}) {
  const runtime = useTheme();
  const themes = useMemo(() => getThemes(preferences),[preferences]);
  const normalized = useMemo(() => normalizeAppearance(preferences),[preferences]);
  const [filter,setFilter] = useState('all');
  const [query,setQuery] = useState('');
  const [draft,setDraft] = useState(null);
  const [pending,setPending] = useState(null);
  const [error,setError] = useState('');
  const [saving,setSaving] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => () => runtime?.setPreview(null),[runtime?.setPreview]);
  const cancel = () => {setPending(null);setDraft(null);setError('');runtime?.setPreview(null);};
  const commit = async patch => {
    setSaving(true);setError('');
    try {
      const next=normalizeAppearance({...preferences,...normalized,...patch});
      const appearance={...next,theme:resolveTheme(next,runtime?.systemDark).mode};
      await runtime?.commitRef.current?.(appearance);
      await onChange(old=>({...old,...appearance}));
      cancel();
    }catch(err){setError(err.message||'主题保存失败，请重试');}
    finally{setSaving(false);}
  };
  const update = patch => {cancel();return commit(patch);};
  const preview = (theme,custom = null) => {
    setPending(theme.id);setError('');
    if(custom){try{validateCustomTheme(custom);}catch{return;}}
    runtime?.setPreview({...preferences,...normalized,themeId:theme.id,appearancePolicy:'fixed',customThemes:custom ? [...normalized.customThemes.filter(t=>t.id!==custom.id),custom] : normalized.customThemes});
  };
  const apply = async () => {
    if (!pending) return;
    if(draft){
      try {validateCustomTheme(draft);if(normalized.customThemes.length>=50&&!normalized.customThemes.some(t=>t.id===draft.id))throw Error('最多保存 50 个自定义主题');}
      catch(err){setError(err.message);return;}
    }
    await commit({appearancePolicy:'fixed',themeId:pending,customThemes:draft ? [...normalized.customThemes.filter(t=>t.id!==draft.id),draft] : normalized.customThemes});
  };
  const edit = theme => {
    const next = theme.custom ? validateCustomTheme(theme) : copyTheme(theme);
    setDraft(next);preview(next,next);
  };
  const revise = patch => {
    const next={...draft,...patch};setDraft(next);preview(next,next);
  };
  const importFile = async event => {
    const file=event.target.files?.[0];event.target.value='';if(!file)return;
    try {
      if (file.size>512_000) throw Error('主题文件不能超过 500 KB');
      const theme=validateCustomTheme(JSON.parse(await file.text()));
      if (normalized.customThemes.length>=50 && !normalized.customThemes.some(t=>t.id===theme.id)) throw Error('最多保存 50 个自定义主题');
      setDraft(theme);preview(theme,theme);
    } catch (err) {setError(err instanceof SyntaxError ? '主题文件不是有效的 JSON' : err.message);}
  };
  const exportTheme = () => {
    const theme=draft || active;
    if(!theme)return;
    const output=theme.custom || theme.extends ? validateCustomTheme(theme) : copyTheme(theme);
    const blob=new Blob([JSON.stringify(output,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${output.id}.qdtheme`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const remove = id => {
    const next={...preferences,theme:active.mode,customThemes:normalized.customThemes.filter(t=>t.id!==id)};
    update({...normalizeAppearance(next),theme:active.mode});
  };
  const currentId=pending || (normalized.appearancePolicy==='system'?runtime?.theme.id:normalized.themeId);
  const active = themes.find(t=>t.id === currentId) || builtinThemes[0];
  const visible=themes.filter(t=>(filter==='all'||t.group===filter)&&`${t.name} ${t.description}`.toLowerCase().includes(query.toLowerCase()));
  return <section className={`theme-library${compact?' compact':''}`} aria-label="主题库">
    <div className="theme-library-heading"><span><Palette size={15}/><b>主题</b></span><small>{runtime?.theme.name || active.name}</small></div>
    <label className="theme-policy"><span>应用方式</span><select aria-label="主题应用方式" value={normalized.appearancePolicy} onChange={e=>update({appearancePolicy:e.target.value})}><option value="fixed">固定主题</option><option value="system">跟随系统</option></select></label>
    {normalized.appearancePolicy==='system' && <div className="theme-system-pair">{[['light','亮色时'],['dark','暗色时']].map(([mode,label])=><label key={mode}><span>{label}</span><select aria-label={`${label}使用的主题`} value={normalized[`${mode}ThemeId`]} onChange={e=>update({[`${mode}ThemeId`]:e.target.value})}>{themes.filter(t=>t.mode===mode).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>)}</div>}
    <div className="theme-library-tools"><input aria-label="搜索主题" placeholder="搜索主题" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="主题分类" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部主题</option><option value="restrained">克制</option><option value="designed">设计主题</option><option value="custom">自定义</option></select></div>
    <div className="theme-library-grid" role="radiogroup" aria-label="主题预览">{visible.map(theme=>{
      const selected=(pending || (normalized.appearancePolicy==='fixed'?normalized.themeId:runtime?.theme.id))===theme.id;
      return <button type="button" disabled={saving} role="radio" aria-label={theme.name} data-theme-choice={theme.id} aria-checked={selected} className={`theme-choice${selected?' selected':''}`} key={theme.id} onClick={()=>{setDraft(null);preview(theme);}} title={theme.description}>
        <span className="theme-choice-art" style={{'--preview-bg':theme.palette[0]||'#eee','--preview-surface':theme.palette[1]||'#fff','--preview-ink':theme.palette[2]||'#273a30','--preview-accent':theme.palette[3]||theme.palette[2]||'#629a72'}}><i/><i/><i/><span className="theme-choice-widget"><b/><b/><b/></span></span>
        <span className="theme-choice-label"><b>{theme.name}</b>{selected?<Check size={13}/>:<small>{theme.mode==='light'?'亮':'暗'}</small>}</span>
      </button>;
    })}{!visible.length&&<p className="theme-empty">没有找到主题</p>}</div>
    <div className="theme-current-actions">{!draft&&<button type="button" onClick={()=>edit(active)}><Copy size={12}/>{active.custom?'编辑主题':'复制并自定义'}</button>}<button type="button" disabled={Boolean(draft&&!draft.name.trim())} onClick={exportTheme}><Download size={12}/>导出</button><button type="button" onClick={()=>fileRef.current?.click()}><Upload size={12}/>导入</button><input hidden type="file" accept=".json,.qdtheme,application/json" ref={fileRef} onChange={importFile}/>{active.custom&&!draft&&<button type="button" aria-label="删除当前自定义主题" onClick={()=>remove(active.id)}><Trash2 size={12}/></button>}</div>
    {draft&&<div className="theme-editor"><label>主题名称<input aria-label="自定义主题名称" value={draft.name} maxLength={40} onChange={e=>revise({name:e.target.value})}/></label><p>继承「{builtinThemes.find(t=>t.id===draft.extends)?.name}」的完整材质与组件形态</p><label>材质<select aria-label="自定义材质" value={draft.material.preset} onChange={e=>revise({material:{...draft.material,preset:e.target.value}})}>{[['inherit','沿用原主题'],['solid','纯色'],['paper','纸张'],['grid','网格'],['glass','磨砂玻璃'],['scanline','扫描线']].map(([v,n])=><option value={v} key={v}>{n}</option>)}</select></label><label>数字字体<select aria-label="自定义数字字体" value={draft.typography.numeric||''} onChange={e=>revise({typography:{...draft.typography,numeric:e.target.value}})}><option value="">沿用原主题</option><option value="Consolas,monospace">等宽数字</option><option value="Georgia,serif">衬线数字</option><option value="Bahnschrift,sans-serif">窄体数字</option></select></label><div className="theme-editor-colors">{colorFields.map(([token,label])=><label key={token}><span>{label}</span><input type="color" aria-label={label} value={draft.tokens[token] || builtinThemes.find(t=>t.id===draft.extends)?.tokens[`--${token}`] || (draft.mode==='light'?'#ffffff':'#20302a')} onChange={e=>revise({tokens:{...draft.tokens,[token]:e.target.value}})}/></label>)}</div><label>卡片圆角 <input type="range" aria-label="卡片圆角" min="0" max="32" value={draft.shape.cardRadius??8} onChange={e=>revise({shape:{...draft.shape,cardRadius:Number(e.target.value)}})}/><b>{draft.shape.cardRadius??8}px</b></label></div>}
    {error&&<p className="theme-error" role="alert">{error}</p>}
    {pending&&<div className="theme-preview-actions" role="status"><span>{saving?'正在保存':'正在预览'} · {draft?.name||themes.find(t=>t.id===pending)?.name}</span><button type="button" disabled={saving} className="outline-button" onClick={cancel}><X size={12}/>取消</button><button type="button" className="primary-button" disabled={saving||Boolean(draft&&!draft.name.trim())} onClick={apply}>{saving?'保存中…':'应用主题'}</button></div>}
  </section>;
}
