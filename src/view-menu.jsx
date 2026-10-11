import { useState } from 'react';
import { Check, Ellipsis } from 'lucide-react';

// 桌面端与远程页共用的主视图入口，两端必须保持一致；新增/调整视图只改这里
export const MAIN_VIEW_ITEMS = [['rings', '看板'], ['waste', '额度浪费'], ['local-usage', '本机用量']];

export function ViewMenu({ current, onChange, open, onOpenChange }) {
  const [innerOpen, setInnerOpen] = useState(false);
  const isOpen = open ?? innerOpen;
  const setOpen = (value) => { setInnerOpen(value); onOpenChange?.(value); };
  const close = () => setOpen(false);
  const onKeyDown = (event) => { if (event.key === 'Escape') close(); };
  return <>
    {isOpen && <div className="main-view-menu-dismiss" aria-hidden="true" onClick={close} onKeyDown={onKeyDown} />}
    <div className={`main-view-anchor${isOpen ? ' open' : ''}`} onKeyDown={onKeyDown}>
      <button className="control-solo" onClick={() => setOpen(!isOpen)} title="切换界面" aria-label="切换界面" aria-expanded={isOpen} aria-controls="main-view-menu"><Ellipsis size={13} /></button>
      {isOpen && <div className="main-view-menu" id="main-view-menu" aria-label="界面切换">{MAIN_VIEW_ITEMS.map(([key, label]) => <button key={key} className={current === key ? 'active' : ''} onClick={() => { onChange(key); close(); }}>{label}<span>{current === key && <Check size={12} />}</span></button>)}</div>}
    </div>
  </>;
}

export default ViewMenu;
