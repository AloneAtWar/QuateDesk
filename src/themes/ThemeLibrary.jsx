import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, Palette, Trash2, Upload } from 'lucide-react';
import { builtinThemes, copyTheme, getThemes, normalizeAppearance, resolveTheme, validateCustomTheme } from './model.js';
import { useTheme } from './runtime.jsx';

const colorFields = [['bg','窗口背景'],['surface','卡片底色'],['ink','主要文字'],['green','强调色'],['widget-bg','浮窗底色'],['widget-chip-value','浮窗读数'],['ring-0','第一层圆环'],['ring-1','第二层圆环']];
export default function ThemeLibrary({preferences={},onChange,compact=false}) {
  const runtime = useTheme();
  const themes = useMemo(() => getThemes(preferences),[preferences]);
  const normalized = useMemo(() => normalizeAppearance(preferences),[preferences]);
  const [query,setQuery] = useState('');
  const [draft,setDraft] = useState(null);
  const [error,setError] = useState('');
  const [saving,setSaving] = useState(false);
  const fileRef = useRef(null);
  const preferencesRef = useRef(preferences);
  const writes = useRef(Promise.resolve());
  useEffect(() => {preferencesRef.current=preferences;},[preferences]);
  const commit = patch => {
    setSaving(true);setError('');
    // Serialize live editor changes so an earlier disk write cannot replace a later edit.
    const task=writes.current.then(async()=>{
      const current=normalizeAppearance(preferencesRef.current);
      const next=normalizeAppearance({...current,...(typeof patch==='function'?patch(current):patch)});
      const appearance={...next,theme:resolveTheme(next,runtime?.systemDark).mode};
      await runtime?.commitRef.current?.(appearance);
      await onChange(old=>({...old,...appearance}));
      preferencesRef.current={...preferencesRef.current,...appearance};
      return true;
    }).catch(err=>{setError(err.message||'主题保存失败，请重试');return false;});
    writes.current=task;
    void task.then(()=>{if(writes.current===task)setSaving(false);});
    return task;
  };
  const select = theme => {
    setDraft(null);
    return commit({appearancePolicy:'fixed',themeId:theme.id});
  };
  const saveCustom = draft => {
    let theme;
    try {theme=validateCustomTheme(draft);}
    catch(err){setError(err.message);return Promise.resolve(false);}
    return commit(current=>{
      if(current.customThemes.length>=50&&!current.customThemes.some(t=>t.id===theme.id))throw Error('最多保存 50 个自定义主题');
      return {appearancePolicy:'fixed',themeId:theme.id,customThemes:[...current.customThemes.filter(t=>t.id!==theme.id),theme]};
    });
  };
  const edit = async theme => {
    const next = theme.custom ? validateCustomTheme(theme) : copyTheme(theme);
    if(theme.custom || await saveCustom(next)){setDraft(next);setError('');}
  };
  const revise = patch => {
    const next={...draft,...patch};setDraft(next);void saveCustom(next);
  };
  const importFile = async event => {
    const file=event.target.files?.[0];event.target.value='';if(!file)return;
    try {
      if (file.size>512_000) throw Error('主题文件不能超过 500 KB');
      const theme=validateCustomTheme(JSON.parse(await file.text()));
      if(await saveCustom(theme))setDraft(null);
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
    void commit(current=>({...normalizeAppearance({...current,theme:active.mode,customThemes:current.customThemes.filter(t=>t.id!==id)}),appearancePolicy:'fixed'}));
  };
  const currentId=normalized.appearancePolicy==='system'?runtime?.theme.id:normalized.themeId;
  const active = themes.find(t=>t.id === currentId) || builtinThemes[0];
  const visible=themes.filter(t=>`${t.name} ${t.description}`.toLowerCase().includes(query.toLowerCase()));
  return <section className={`theme-library${compact?' compact':''}`} aria-label="主题库">
    <div className="theme-library-heading"><span><Palette size={15}/><b>主题</b></span><small>{runtime?.theme.name || active.name}</small></div>
    <div className="theme-library-tools"><input aria-label="搜索主题" placeholder="搜索主题" value={query} onChange={e=>setQuery(e.target.value)}/></div>
    <div className="theme-library-grid" role="radiogroup" aria-label="主题选择">{visible.map(theme=>{
      const selected=currentId===theme.id;
      return <button type="button" disabled={saving} role="radio" aria-label={theme.name} data-theme-choice={theme.id} aria-checked={selected} className={`theme-choice${selected?' selected':''}`} key={theme.id} onClick={()=>select(theme)} title={theme.description}>
        <span className="theme-choice-art" style={{'--preview-bg':theme.palette[0]||'#eee','--preview-surface':theme.palette[1]||'#fff','--preview-ink':theme.palette[2]||'#273a30','--preview-accent':theme.palette[3]||theme.palette[2]||'#629a72'}}><i/><i/><i/><span className="theme-choice-widget"><b/><b/><b/></span></span>
        <span className="theme-choice-label"><b>{theme.name}</b>{selected?<Check size={13}/>:<small>{theme.mode==='light'?'亮':'暗'}</small>}</span>
      </button>;
    })}{!visible.length&&<p className="theme-empty">没有找到主题</p>}</div>
    <div className="theme-current-actions">{!draft?<button type="button" disabled={saving} onClick={()=>edit(active)}><Copy size={12}/>{active.custom?'编辑主题':'复制并自定义'}</button>:<button type="button" disabled={saving||!draft.name.trim()} onClick={()=>setDraft(null)}><Check size={12}/>完成编辑</button>}<button type="button" disabled={Boolean(draft&&!draft.name.trim())} onClick={exportTheme}><Download size={12}/>导出</button><button type="button" disabled={saving} onClick={()=>fileRef.current?.click()}><Upload size={12}/>导入</button><input hidden type="file" accept=".json,.qdtheme,application/json" ref={fileRef} onChange={importFile}/>{active.custom&&!draft&&<button type="button" disabled={saving} aria-label="删除当前自定义主题" onClick={()=>remove(active.id)}><Trash2 size={12}/></button>}</div>
    {draft&&<div className="theme-editor"><label>主题名称<input aria-label="自定义主题名称" value={draft.name} maxLength={40} onChange={e=>revise({name:e.target.value})}/></label><p>继承「{builtinThemes.find(t=>t.id===draft.extends)?.name}」的完整材质与组件形态，修改自动保存</p><label>材质<select aria-label="自定义材质" value={draft.material.preset} onChange={e=>revise({material:{...draft.material,preset:e.target.value}})}>{[['inherit','沿用原主题'],['solid','纯色'],['paper','纸张'],['grid','网格'],['glass','磨砂玻璃'],['scanline','扫描线']].map(([v,n])=><option value={v} key={v}>{n}</option>)}</select></label><label>数字字体<select aria-label="自定义数字字体" value={draft.typography.numeric||''} onChange={e=>revise({typography:{...draft.typography,numeric:e.target.value}})}><option value="">沿用原主题</option><option value="Consolas,monospace">等宽数字</option><option value="Georgia,serif">衬线数字</option><option value="Bahnschrift,sans-serif">窄体数字</option></select></label><div className="theme-editor-colors">{colorFields.map(([token,label])=><label key={token}><span>{label}</span><input type="color" aria-label={label} value={draft.tokens[token] || builtinThemes.find(t=>t.id===draft.extends)?.tokens[`--${token}`] || (draft.mode==='light'?'#ffffff':'#20302a')} onChange={e=>revise({tokens:{...draft.tokens,[token]:e.target.value}})}/></label>)}</div><label>卡片圆角 <input type="range" aria-label="卡片圆角" min="0" max="32" value={draft.shape.cardRadius??8} onChange={e=>revise({shape:{...draft.shape,cardRadius:Number(e.target.value)}})}/><b>{draft.shape.cardRadius??8}px</b></label></div>}
    {error&&<p className="theme-error" role="alert">{error}</p>}
  </section>;
}
