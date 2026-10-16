import { Download, Plus, Settings2, ShieldCheck } from 'lucide-react';

/** An illustrative preview, kept separate from real account readings. */
export function EmptyWorkspace({ onAddAccount, onOpenSettings, onImport }) {
  return <section className="empty-workspace" aria-labelledby="empty-workspace-title">
    <div className="empty-workspace-content">
      <div className="empty-preview" aria-hidden="true">
        <div className="empty-preview-halo" />
        <div className="empty-preview-back" />
        <div className="empty-preview-card">
          <div className="empty-preview-heading"><span><i /> QUOTA OVERVIEW</span><small>示意</small></div>
          <div className="empty-preview-meters">
            {[['5h', 'mint'], ['7d', 'blue'], ['1M', 'peach']].map(([label, tone]) => <div className={`empty-preview-meter ${tone}`} key={label}>
              <svg viewBox="0 0 52 52"><circle className="empty-preview-track" cx="26" cy="26" r="21" /><circle className="empty-preview-fill" cx="26" cy="26" r="21" /></svg>
              <b>{label}</b>
            </div>)}
          </div>
          <div className="empty-preview-lines"><i /><i /><i /></div>
        </div>
        <span className="empty-preview-plus"><Plus size={19} strokeWidth={2} /></span>
      </div>
      <div className="empty-workspace-copy">
        <h2 id="empty-workspace-title">每一份额度，都心中有数</h2>
        <p>连接你的 Coding Plan，<br />剩余额度与重置时间，一眼掌握。</p>
      </div>
      <button className="primary-button empty-workspace-add" onClick={onAddAccount}><Plus size={16} /> 添加第一个账号</button>
      <div className="empty-workspace-links">
        {onImport && <><button onClick={onImport}><Download size={13} /> 从 cc-switch 导入</button><span className="empty-workspace-divider" /></>}
        <button onClick={onOpenSettings}><Settings2 size={13} /> 设置</button>
      </div>
      <p className="empty-workspace-privacy"><ShieldCheck size={12} /><span>凭据本机加密<span className="empty-workspace-dot">·</span>请求直连厂商</span></p>
    </div>
  </section>;
}
