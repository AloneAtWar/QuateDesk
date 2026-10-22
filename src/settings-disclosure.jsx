import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

/** Related settings expand in place; their components only mount while open. */
export function SettingsDisclosure({ id, title, icon: Icon, summary, help, actions, children }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="settings-disclosure" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary className="settings-entry" id={`settings-entry-${id}`} aria-describedby={`settings-summary-${id}`} tabIndex={0}>
      <Icon size={18} /><span className="settings-entry-copy"><b>{title}</b><small id={`settings-summary-${id}`}>{summary}</small></span><ChevronRight size={15} />
    </summary>
    {expanded && <div className="settings-disclosure-content">
      {(help || actions) && <div className="settings-disclosure-tools">{help && <span>设置说明{help}</span>}{actions}</div>}
      {children}
    </div>}
  </details>;
}
