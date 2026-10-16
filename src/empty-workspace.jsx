import { Download, Plus, Settings2, ShieldCheck } from 'lucide-react';

function QuotaPreview() {
  return <div className="empty-workspace-art" aria-hidden="true">
    <svg viewBox="0 0 250 142" fill="none" focusable="false">
      <rect x="30" y="11" width="198" height="115" rx="14" transform="rotate(7 129 68)" fill="var(--green-bg)" stroke="var(--green-line)" opacity=".65" />
      <g transform="rotate(-5 125 72)" className="empty-workspace-art-card">
        <rect x="18" y="13" width="210" height="123" rx="14" fill="var(--surface)" stroke="var(--line-strong)" />
        <circle cx="35" cy="32" r="2.5" fill="var(--green)" />
        <text x="43" y="35" fill="var(--muted)" fontSize="7" letterSpacing=".6">QUOTA OVERVIEW</text>
        <text x="194" y="35" fill="var(--faint)" fontSize="8">示意</text>
        {[
          { x: 61, label: '5h', color: 'var(--green)', arc: 100 },
          { x: 123, label: '7d', color: 'var(--sky)', arc: 77 },
          { x: 185, label: '1M', color: 'var(--coral)', arc: 49 },
        ].map(({ x, label, color, arc }) => <g key={label}>
          <circle cx={x} cy="78" r="21" stroke="var(--ring-track)" strokeWidth="4" />
          <circle cx={x} cy="78" r="21" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${arc} 132`} transform={`rotate(-90 ${x} 78)`} />
          <text x={x} y="81.5" textAnchor="middle" fill="var(--ink-soft)" fontSize="10">{label}</text>
          <path d={`M ${x - 12} 113 h 24`} stroke="var(--line)" strokeWidth="3" strokeLinecap="round" />
        </g>)}
      </g>
      <circle cx="225" cy="124" r="16" fill="var(--primary-bg)" stroke="var(--bg)" strokeWidth="4" />
      <path d="M 219 124 h 12 M 225 118 v 12" stroke="var(--primary-text)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  </div>;
}

export function EmptyWorkspace({ onAddAccount, onOpenSettings, onImport }) {
  return <section className="empty-workspace" aria-label="账号总览">
    <div className="empty-workspace-content">
      <QuotaPreview />
      <button type="button" className="primary-button empty-workspace-add" onClick={onAddAccount}><Plus size={16} /> 添加第一个账号</button>
      <div className="empty-workspace-links">
        {onImport && <><button type="button" onClick={onImport}><Download size={13} /> 从 cc-switch 导入</button><span className="empty-workspace-divider" aria-hidden="true" /></>}
        <button type="button" onClick={onOpenSettings}><Settings2 size={13} /> 设置</button>
      </div>
      <p className="empty-workspace-privacy"><ShieldCheck size={12} /><span>凭据本机加密<span className="empty-workspace-dot">·</span>请求直连厂商</span></p>
    </div>
  </section>;
}
