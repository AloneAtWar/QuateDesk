import { useState } from 'react';
import { TEXT_KINDS, TEXT_LABELS, TEXT_COLORS, normalizeWidgetText } from '../electron/widget-appearance.mjs';
import { NumberSetting } from './widget-settings';

export function WidgetTextSettings({ settings, setSettings }) {
  const [bank, setBank] = useState(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const normalized = normalizeWidgetText(settings);
  const setFont = (kind, patch) => setSettings((old) => ({ ...old, widgetText: { ...normalizeWidgetText(old).widgetText,
    [kind]: { ...normalizeWidgetText(old).widgetText[kind], ...patch } } }));
  const setColor = (kind, color) => setSettings((old) => ({ ...old, widgetTextColors: { ...normalizeWidgetText(old).widgetTextColors,
    [bank]: { ...normalizeWidgetText(old).widgetTextColors[bank], [kind]: color } } }));
  return <details className="widget-text-settings"><summary>文字与配色</summary>
    <div className="widget-color-bank"><label htmlFor="widget-color-bank">编辑配色</label><select id="widget-color-bank" aria-label="编辑配色主题" value={bank} onChange={(event) => setBank(event.target.value)}><option value="light">亮色主题</option><option value="dark">暗色主题</option></select></div>
    <small className="widget-text-hint">字号与粗细通用，颜色按主题分别保存。</small>
    {TEXT_KINDS.map((kind) => <div className="widget-text-control" key={kind}>
      <b>{TEXT_LABELS[kind]}</b><span className="widget-color-state">{normalized.widgetTextColors[bank][kind] ? '自定义颜色' : '跟随主题'}</span>
      <div className="widget-text-fields">
        <label><span>字号</span><NumberSetting label={`${TEXT_LABELS[kind]}字号`} value={normalized.widgetText[kind].size} onCommit={(value) => {
          const size = Math.min(32, Math.max(8, Number(value) || normalized.widgetText[kind].size)); setFont(kind, { size }); return size;
        }} /></label>
        <select aria-label={`${TEXT_LABELS[kind]}粗细`} value={normalized.widgetText[kind].weight} onChange={(event) => setFont(kind, { weight: Number(event.target.value) })}>
          <option value="400">正常</option><option value="500">中等</option><option value="600">半粗</option><option value="700">加粗</option><option value="800">特粗</option>
        </select>
        <input type="color" aria-label={`${TEXT_LABELS[kind]}颜色`} value={normalized.widgetTextColors[bank][kind] || TEXT_COLORS[bank][kind]} onChange={(event) => setColor(kind, event.target.value)} />
        <button type="button" className="widget-color-reset" aria-label={`恢复${TEXT_LABELS[kind]}主题颜色`} onClick={() => setColor(kind, null)}>重置</button>
      </div>
    </div>)}
    <label className="setting-toggle"><span><b>文字描边</b><small>根据文字颜色自动选择深色或浅色边缘</small></span><input type="checkbox" checked={normalized.widgetTextOutline} onChange={(event) => setSettings((old) => ({ ...old, widgetTextOutline: event.target.checked }))} /><i /></label>
    <button type="button" className="outline-button full" onClick={() => setSettings((old) => ({ ...old, ...normalizeWidgetText() }))}>恢复默认文字设置</button>
  </details>;
}
