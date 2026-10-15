import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { clampWidgetInterval, clampWidgetScale, commitWidgetLayout } from '../electron/widget-layout.mjs';
import { shortcutFromEvent } from '../electron/widget-shortcut.mjs';

export function WidgetShortcutSetting({ settings, setSettings }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const bridge = window.quotaDesk;
  useEffect(() => {
    let active = true;
    bridge?.getWidgetShortcutStatus?.().then((status) => { if (active) setError(status.error || ''); }).catch(() => {});
    return () => { active = false; bridge?.setWidgetShortcutRecording?.(false).catch(() => {}); };
  }, []);
  const change = async (shortcut) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = bridge?.setWidgetShortcut ? await bridge.setWidgetShortcut(shortcut) : { ok: true, shortcut };
      if (result.ok) setSettings((old) => ({ ...old, widgetShortcut: result.shortcut }));
      else setError(result.error || '快捷键设置失败，请重试');
    } catch { setError('快捷键设置失败，请重试'); }
    finally { setBusy(false); setRecording(false); input.current?.blur(); }
  };
  return <div className="widget-shortcut-setting">
    <div className="setting-select"><span><b>唤出快捷键</b><small>点击输入框后按 Ctrl 或 Alt＋字母、数字或 F 键</small></span>
      <div className="widget-shortcut-controls"><input ref={input} aria-label="浮窗唤出快捷键" readOnly disabled={busy}
        value={recording ? '请按组合键…' : (settings.widgetShortcut || '未设置').replace('+', ' + ')}
        onFocus={async () => {
          setRecording(true); setError('');
          try { await bridge?.setWidgetShortcutRecording?.(true); } catch { setError('暂时无法录入快捷键'); }
        }}
        onBlur={() => { setRecording(false); bridge?.setWidgetShortcutRecording?.(false).catch(() => {}); }}
        onKeyDown={(event) => {
          if (event.key === 'Tab') return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Escape') { event.currentTarget.blur(); return; }
          if (event.repeat || ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
          const shortcut = shortcutFromEvent(event);
          if (shortcut) change(shortcut);
          else setError('只支持 Ctrl 或 Alt 加一个字母、数字或 F 键');
        }} />
        <button type="button" className="outline-button" disabled={busy || !settings.widgetShortcut} onClick={() => change('')}>清除</button></div>
    </div>
    <p className="widget-shortcut-help">临时移到鼠标附近，点击外部恢复原状态；拖动后固定在新位置。</p>
    {error && <p className="widget-shortcut-error" role="alert">{error}</p>}
  </div>;
}

export function DigitsInput({ value, onChange, ...props }) {
  return <input {...props} type="text" inputMode="numeric" autoComplete="off" value={value}
    onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ''))} />;
}

function WidgetLayoutPicker({ settings, setSettings }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const anchor = useRef(null);
  const draftRef = useRef(null);
  const id = useId();
  const begin = () => {
    const next = { mode: settings.widgetLayout, rows: settings.widgetGridRemembered ? String(settings.widgetGridRows) : '', columns: settings.widgetGridRemembered ? String(settings.widgetGridColumns) : '' };
    draftRef.current = next;
    setDraft(next);
    setOpen(true);
  };
  const change = (patch) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
  };
  const finish = (save = true) => {
    const next = draftRef.current;
    draftRef.current = null;
    if (save && next) setSettings((old) => ({ ...old, ...commitWidgetLayout(old, next) }));
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => { if (!anchor.current?.contains(event.target)) finish(); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  return <div className="widget-layout-picker" ref={anchor}
    onBlur={(event) => { if (open && !event.currentTarget.contains(event.relatedTarget)) finish(); }}
    onKeyDown={(event) => {
      if (!open || !['Escape', 'Enter'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); finish(event.key === 'Enter');
      anchor.current?.querySelector('button')?.focus();
    }}>
    <button type="button" className="widget-layout-trigger" aria-label="浮窗排列规则" aria-expanded={open} aria-controls={id} onClick={() => open ? finish() : begin()}>
      <span>{settings.widgetLayout === 'auto' ? '自动' : `${settings.widgetGridRows} × ${settings.widgetGridColumns}`}</span><ChevronDown size={13} />
    </button>
    {open && <div className="widget-layout-popover" id={id} role="group" aria-label="浮窗排列选项">
      <label className="widget-layout-choice"><input type="radio" name={id} checked={draft.mode === 'auto'} onChange={() => change({ mode: 'auto' })} />自动</label>
      <div className="widget-layout-custom">
        <label className="widget-layout-choice"><input type="radio" name={id} checked={draft.mode === 'custom'} onChange={() => change({ mode: 'custom' })} />自定义</label>
        <div className="widget-grid-inputs">
          <DigitsInput aria-label="自定义行数" placeholder="行" value={draft.rows} onFocus={() => change({ mode: 'custom' })} onChange={(rows) => change({ rows, mode: 'custom' })} />
          <span aria-hidden="true">×</span>
          <DigitsInput aria-label="自定义列数" placeholder="列" value={draft.columns} onFocus={() => change({ mode: 'custom' })} onChange={(columns) => change({ columns, mode: 'custom' })} />
        </div>
      </div>
    </div>}
  </div>;
}

export function NumberSetting({ value, label, onCommit, suffix, adjustable = false, min = -Infinity, max = Infinity, step = 1 }) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  const cancelBlur = useRef(false);
  const anchor = useRef(null);
  const latest = useRef(null);
  latest.current = { draft, value, onCommit };
  const adjust = (direction) => {
    const current = latest.current;
    const base = editing.current && current.draft !== '' ? Number(current.draft) : Number(current.value);
    const next = Math.min(max, Math.max(min, (Number.isFinite(base) ? base : Number(current.value)) + direction * step));
    const result = current.onCommit(next);
    latest.current = { ...current, value: result, draft: String(result) };
    setDraft(String(result));
  };
  useEffect(() => {
    if (!adjustable || !anchor.current) return undefined;
    const element = anchor.current;
    const wheel = (event) => {
      if (!event.deltaY) return;
      event.preventDefault(); event.stopPropagation(); adjust(event.deltaY < 0 ? 1 : -1);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [adjustable, min, max, step]);
  useEffect(() => { if (!editing.current) setDraft(String(value)); }, [value]);
  const commit = () => {
    editing.current = false;
    if (cancelBlur.current) { cancelBlur.current = false; return; }
    const result = onCommit(draft === '' ? value : draft);
    setDraft(String(result));
  };
  return <span ref={anchor} className={`widget-number-setting ${adjustable ? 'widget-number-adjustable' : ''}`}><DigitsInput aria-label={label} value={draft} onFocus={() => { editing.current = true; }} onChange={setDraft} onBlur={commit}
    onKeyDown={(event) => {
      if (adjustable && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); adjust(event.key === 'ArrowUp' ? 1 : -1); }
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelBlur.current = true; setDraft(String(value)); event.currentTarget.blur(); }
    }} />{adjustable && <span className="widget-number-arrows">
      <button type="button" aria-label={`增加${label}`} disabled={Number(draft) >= max} onPointerDown={(event) => event.preventDefault()} onClick={() => adjust(1)}><ChevronUp size={10} /></button>
      <button type="button" aria-label={`减少${label}`} disabled={Number(draft) <= min} onPointerDown={(event) => event.preventDefault()} onClick={() => adjust(-1)}><ChevronDown size={10} /></button>
    </span>}{suffix && <span>{suffix}</span>}</span>;
}

export function WidgetLayoutSetting({ settings, setSettings }) {
  return <div className="setting-select widget-layout-setting"><span><b>排列规则</b></span><WidgetLayoutPicker settings={settings} setSettings={setSettings} /></div>;
}

export function WidgetScaleSetting({ settings, setSettings }) {
  const percent = Math.round(clampWidgetScale(settings.widgetScale) * 100);
  return <div className="widget-scale-setting"><label htmlFor="widget-scale-slider">单元格大小</label>
    <input id="widget-scale-slider" type="range" aria-label="单元格大小滑条" min="0" max="300" step="5" value={percent}
      onChange={(event) => setSettings((old) => ({ ...old, widgetScale: Number(event.target.value) / 100 }))} />
    <NumberSetting value={percent} label="单元格大小百分比" suffix="%" onCommit={(value) => {
      const next = clampWidgetScale(Number(value) / 100); setSettings((old) => ({ ...old, widgetScale: next })); return Math.round(next * 100);
    }} />
  </div>;
}

export function WidgetIntervalSetting({ settings, setSettings }) {
  return <div className="setting-select"><span><b>轮播间隔</b></span>
    <NumberSetting value={settings.widgetCarouselSeconds} label="轮播间隔秒数" suffix="秒" onCommit={(value) => {
      const next = clampWidgetInterval(value); setSettings((old) => ({ ...old, widgetCarouselSeconds: next })); return next;
    }} />
  </div>;
}
