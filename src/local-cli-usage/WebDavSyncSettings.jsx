import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Cloud, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react';
import { formatLocalDateTime } from './local-cli-usage-format';

const fieldsFrom = (config) => ({ enabled: config.enabled, endpoint: config.endpoint, username: config.username, folder: config.folder, password: '', passphrase: '' });
const when = (value) => value ? formatLocalDateTime(value) : '尚无记录';

export default function WebDavSyncSettings() {
  const bridge = window.quotaDesk;
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [buildVersion, setBuildVersion] = useState('');
  const feedback = useRef(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!bridge?.getUsageSyncStatus) return undefined;
    bridge.getUsageSyncStatus().then((next) => {
      if (alive.current) { setStatus(next); setDraft(fieldsFrom(next.config)); }
    }).catch(() => { if (alive.current) setNotice({ ok: false, text: '云同步配置读取失败，请重新打开设置' }); });
    bridge.getVersion?.().then((version) => { if (alive.current) setBuildVersion(version); }).catch(() => {});
    const unsubscribe = bridge.onUsageSyncChanged?.((next) => { if (alive.current) setStatus(next); });
    return () => { alive.current = false; unsubscribe?.(); };
  }, [bridge]);
  useEffect(() => { if (notice) feedback.current?.scrollIntoView({ block: 'nearest' }); }, [notice]);
  if (!bridge?.getUsageSyncStatus) return null;
  const locked = Boolean(busy || status?.running);
  const dirty = draft && status && (draft.password || draft.passphrase || ['enabled', 'endpoint', 'username', 'folder'].some((key) => draft[key] !== status.config[key]));
  const change = (key, value) => { setDraft((before) => ({ ...before, [key]: value })); setNotice(null); };
  const run = async (key, action, message) => {
    setBusy(key); setNotice({ pending: true, text: key === 'test' ? '正在测试连接，验证账号、目录读写与加密口令，最多等待 30 秒…' : key === 'sync' ? '正在同步用量档案…' : '正在处理…' });
    try {
      const result = await action();
      if (!alive.current) return;
      const next = result?.config ? result : await bridge.getUsageSyncStatus();
      setStatus(next);
      if (key === 'save') setDraft(fieldsFrom(next.config));
      setNotice({ ok: true, text: typeof message === 'function' ? message(next) : message });
    } catch (error) {
      if (alive.current) {
        const reason = (error.message || '操作失败').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
        setNotice({ ok: false, text: `${key === 'test' ? '连接失败：' : key === 'sync' ? '同步失败：' : ''}${reason}` });
      }
    } finally { if (alive.current) setBusy(''); }
  };
  return <section className="drawer-section usage-sync-settings" aria-label="WebDAV 云同步">
    <div className="drawer-section-title"><Cloud size={16} /><span>WebDAV 云同步</span><span className="usage-archive-badge">客户端加密</span></div>
    {buildVersion && <p className="usage-sync-build">当前版本 v{buildVersion}</p>}
    <p className="usage-archive-help">连接你自己的网盘或 NAS，每台设备只上传本机档案，其他来源按版本更新到导入档案中。</p>
    {draft && <form onSubmit={(event) => { event.preventDefault(); run('save', () => bridge.saveUsageSyncConfig(draft), '同步配置已保存'); }}>
      <label className="setting-toggle"><span><b>启用自动同步</b><small>每 24 小时上传一次，应用关闭时下次启动补同步</small></span><input type="checkbox" checked={draft.enabled} disabled={locked} onChange={(event) => change('enabled', event.target.checked)} /><i /></label>
      <div className="usage-sync-fields">
        <label>WebDAV 服务地址<input aria-label="WebDAV 服务地址" type="url" maxLength={2048} placeholder="https://dav.jianguoyun.com/dav/" value={draft.endpoint} disabled={locked} onChange={(event) => change('endpoint', event.target.value)} /></label>
        <label>用户名<input aria-label="WebDAV 用户名" autoComplete="off" maxLength={1024} value={draft.username} disabled={locked} onChange={(event) => change('username', event.target.value)} /></label>
        <label>应用密码<input aria-label="WebDAV 应用密码" type="password" autoComplete="new-password" maxLength={4096} placeholder={status.config.hasPassword ? '已保存，留空保留原密码' : '在网盘中创建的应用密码'} value={draft.password} disabled={locked} onChange={(event) => change('password', event.target.value)} /></label>
        <label>同步目录<input aria-label="WebDAV 同步目录" maxLength={300} placeholder="QuotaDesk" value={draft.folder} disabled={locked} onChange={(event) => change('folder', event.target.value)} /></label>
        <label><span><LockKeyhole size={12} />同步加密口令</span><input aria-label="同步加密口令" type="password" autoComplete="new-password" maxLength={1024} placeholder={status.config.hasPassphrase ? '已保存，留空保留原口令' : '至少 6 个字符，各设备填写相同口令'} value={draft.passphrase} disabled={locked} onChange={(event) => change('passphrase', event.target.value)} /></label>
        <small className="usage-sync-hint">至少 6 个字符，不要求复杂字符组合；各设备填写相同口令。</small>
      </div>
      <p className="usage-archive-help">各设备使用同一目录和加密口令。用量记录与项目标签先压缩再加密，不包含账号凭据或对话正文。口令不会上传，请自行保存；已有云端档案时不能直接更换口令。</p>
      <div className="usage-sync-actions">
        <button type="submit" className="outline-button" disabled={locked || !dirty}>{busy === 'save' ? '正在保存…' : '保存配置'}</button>
        <button type="button" className="outline-button" disabled={locked} onClick={() => run('test', () => bridge.testUsageSyncConnection(draft), `连接成功：账号认证、目录读写和加密校验均已通过。${dirty ? '当前配置尚未保存，点击“保存配置”后可用于同步。' : ''}`)}>{busy === 'test' || status.mode === 'test' ? '正在测试…' : '测试连接'}</button>
        <button type="button" className="outline-button" disabled={locked || Boolean(dirty) || !status.config.enabled} onClick={() => run('sync', () => bridge.syncUsageArchives(), (next) => { const result = next.lastResult; return `同步完成：${result?.uploaded ? '已上传本机新版' : '本机无需重复上传'}，新增 ${result?.added || 0} 个来源，更新 ${result?.updated || 0} 个来源`; })}><RefreshCw size={13} />{busy === 'sync' || status.mode === 'sync' ? '正在同步…' : '立即同步'}</button>
      </div>
      {notice && <div ref={feedback} className={`usage-sync-feedback${notice.pending ? ' is-pending' : notice.ok ? ' is-success' : ' is-error'}`} role={notice.ok === false ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">{notice.pending ? <LoaderCircle size={15} /> : notice.ok ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}<span>{notice.text}</span></div>}
      {dirty && <p className="usage-archive-help">配置有修改，可直接测试连接；保存后才能用于自动同步。</p>}
    </form>}
    {status && <>
      <dl className="usage-sync-status" aria-label="云同步状态">
        <dt>自动同步</dt><dd>{status.running ? status.mode === 'test' ? '正在测试连接…' : '正在同步…' : status.config.enabled ? '已开启' : '未开启'}</dd>
        <dt>最近检查成功</dt><dd>{when(status.lastSuccessAt)}</dd>
        <dt>本机上传检查</dt><dd>{when(status.lastUploadAt)}</dd>
        {status.config.enabled && <><dt>下次自动上传</dt><dd>{status.lastUploadAt ? when(status.nextUploadAt) : '首次同步时上传'}</dd><dt>{status.lastError ? '下次重试' : '下次检查'}</dt><dd>{when(status.nextCheckAt)}</dd></>}
      </dl>
      <p className="usage-archive-help">每 30 分钟检查其他设备更新；失败后 15 分钟重试。立即同步可提前上传，新版完整替换对应来源，重复档案自动跳过。云端文件缺失不会删除本地档案。</p>
      {status.lastError && !notice && <div className="usage-archive-notice is-error" role="alert">{status.lastError}</div>}
      {status.ignored.length > 0 && <details className="usage-sync-ignored"><summary>已暂停接收的来源（{status.ignored.length}）</summary>{status.ignored.map((source) => <div key={source.sourceId}><span title={source.sourceId}>{source.label}</span><button type="button" className="outline-button" disabled={locked} onClick={() => run('restore', () => bridge.restoreUsageSyncSource(source.sourceId), '已恢复接收，下次同步时重新读取该来源')}>恢复接收</button></div>)}</details>}
    </>}
    {!draft && notice && <div ref={feedback} className="usage-archive-notice is-error" role="alert">{notice.text}</div>}
  </section>;
}
