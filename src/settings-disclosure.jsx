import { useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

/** Related settings expand in place with a smooth height animation; their components
    only mount while open (unmount after the collapse transition, so subscriptions close).
    行结构：主点击区（图标+标题+摘要）+ 可选的帮助 ? + 展开箭头；展开后整组成为一张卡片。 */
export function SettingsDisclosure({ id, title, icon: Icon, summary, help, actions, children }) {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const unmountTimer = useRef(null);
  const expand = () => {
    clearTimeout(unmountTimer.current);
    setRendered(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
  };
  const collapse = () => {
    setOpen(false);
    // transitionend 在减少动态效果偏好下不会触发，用计时器兜底卸载
    unmountTimer.current = setTimeout(() => setRendered(false), 320);
  };
  return <div className={`settings-disclosure${open ? ' open' : ''}`}>
    <div className="settings-entry">
      <button type="button" className="settings-entry-hit" id={`settings-entry-${id}`} aria-describedby={`settings-summary-${id}`} aria-expanded={open} aria-controls={`settings-panel-${id}`} onClick={() => (open ? collapse() : expand())}>
        <Icon size={18} /><span className="settings-entry-copy"><b>{title}</b><small id={`settings-summary-${id}`}>{summary}</small></span>
      </button>
      {help}
      <ChevronRight size={15} className="settings-entry-chevron" aria-hidden="true" />
    </div>
    {rendered && <div className="settings-disclosure-body" id={`settings-panel-${id}`} role="region" aria-labelledby={`settings-entry-${id}`} onTransitionEnd={(event) => { if (!open && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') { clearTimeout(unmountTimer.current); setRendered(false); } }}>
      <div className="settings-disclosure-content">
        {actions && <div className="settings-disclosure-tools">{actions}</div>}
        {children}
      </div>
    </div>}
  </div>;
}
