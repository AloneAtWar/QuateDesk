import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, Download, Pencil, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import { formatLocalDateTime, formatLocalTokensCompact } from './local-cli-usage-format';

const date = (value) => value ? formatLocalDateTime(value).slice(0, 10) : '—';
const number = (value) => Number(value || 0).toLocaleString('zh-CN');

function SourceCard({ source, local = false, busy, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(source.label);
  const save = async (event) => {
    event.preventDefault();
    if (await onUpdate({ sourceId: source.sourceId, label: name.trim() })) setEditing(false);
  };
  return <article className={`usage-archive-card${local ? ' is-local' : ''}${source.enabled === false ? ' is-disabled' : ''}`}>
    <div className="usage-archive-heading">
      <b title={source.label}>{source.label}</b><span className="usage-archive-badge">{local ? '本机采集' : '导入档案'}</span>
      <button type="button" className="row-icon-button" disabled={busy} title="修改显示名称" aria-label={`重命名 ${source.label}`} onClick={() => { setName(source.label); setEditing(true); }}><Pencil size={13} /></button>
    </div>
    {editing && <form className="usage-archive-rename" onSubmit={save}>
      <input autoFocus aria-label="档案来源名称" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); } }} />
      <button className="outline-button" disabled={busy || !name.trim()}>保存</button><button type="button" className="outline-button" disabled={busy} onClick={() => setEditing(false)}>取消</button>
    </form>}
    <div className="usage-archive-stats"><span><strong>{formatLocalTokensCompact(source.totalTokens)}</strong> Token</span><span>{number(source.records)} 条记录</span><span>v{source.revision}</span></div>
    <p className="usage-archive-range">{source.records ? `${date(source.firstAt)} 至 ${date(source.lastAt)}` : '尚无用量记录，可开启本机扫描后采集'}</p>
    <details className="usage-archive-detail"><summary>来源信息</summary><dl><dt>来源 ID</dt><dd>{source.sourceId}</dd>{!local && <><dt>最近导入</dt><dd>{formatLocalDateTime(source.importedAt)}</dd><dt>原始名称</dt><dd>{source.originLabel}</dd></>}</dl></details>
    {!local && <div className="usage-archive-controls">
      <label><input type="checkbox" checked={source.enabled} disabled={busy} onChange={(event) => onUpdate({ sourceId: source.sourceId, enabled: event.target.checked })} />计入用量汇总</label>
      <button type="button" className="row-icon-button danger" disabled={busy} title="删除该来源的导入档案" aria-label={`删除导入来源 ${source.label}`} onClick={() => onDelete(source.sourceId)}><Trash2 size={14} /></button>
    </div>}
  </article>;
}

export default function UsageArchivesSettings({ showHeading = true }) {
  const bridge = window.quotaDesk;
  const [info, setInfo] = useState(null);
  const [scope, setScope] = useState('local');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [loadError, setLoadError] = useState('');
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const next = await bridge.getUsageArchives();
      if (alive.current) { setInfo(next); setLoadError(''); }
    } catch (error) { if (alive.current) setLoadError(error.message || '读取档案失败'); }
  }, [bridge]);
  useEffect(() => {
    alive.current = true;
    if (!bridge?.getUsageArchives) return undefined;
    load();
    const timer = setInterval(load, 15_000);
    const unsubscribe = bridge.onUsageArchivesChanged?.(load);
    return () => { alive.current = false; clearInterval(timer); unsubscribe?.(); };
  }, [bridge, load]);

  const run = async (key, action, success) => {
    setBusy(key); setNotice(null);
    try {
      const result = await action();
      if (result?.canceled) return false;
      if (alive.current) {
        if (result?.info) setInfo(result.info);
        else await load();
        setNotice({ ok: true, message: typeof success === 'function' ? success(result) : success });
      }
      return true;
    } catch (error) { if (alive.current) setNotice({ ok: false, message: error.message || '操作失败' }); return false; }
    finally { if (alive.current) setBusy(''); }
  };

  return <section className="drawer-section usage-archives-settings" aria-label="用量档案管理">
    {(showHeading || bridge?.getUsageArchives) && <div className="drawer-section-title">{showHeading && <><Database size={16} /><span>用量档案</span></>}{bridge?.getUsageArchives && <button type="button" className="row-icon-button" style={{ marginLeft: 'auto' }} disabled={Boolean(busy)} aria-label="刷新档案信息" onClick={load}><RefreshCw size={13} /></button>}</div>}
    <p className="usage-archive-help">本机采集与导入来源分别保存，已启用的来源共同计入用量。重复导入会检查来源和版本，新版更新对应来源，本机来源自动跳过。</p>
    {!bridge?.getUsageArchives ? <p className="usage-archive-help">档案管理需要桌面版应用。</p> : <>
      {loadError && <div className="usage-archive-notice is-error" role="alert">{loadError}<button className="outline-button" onClick={load}>重试</button></div>}
      {!info && !loadError && <p className="usage-archive-help" role="status">正在读取档案信息…</p>}
      {info && <>
        <SourceCard source={info.local} local busy={Boolean(busy)} onUpdate={(query) => run('update', () => bridge.updateUsageArchive(query), '来源名称已更新')} />
        <div className="usage-archive-subtitle">导入来源 <span>{info.imported.length}</span></div>
        {info.imported.length === 0 ? <p className="usage-archive-empty">还没有导入来源。可在另一台电脑导出档案，再到这里导入。</p>
          : info.imported.map((source) => <SourceCard key={source.sourceId} source={source} busy={Boolean(busy)}
            onUpdate={(query) => run('update', () => bridge.updateUsageArchive(query), query.label ? '显示名称已更新' : query.enabled ? '该来源已计入汇总' : '该来源已暂停计入汇总')}
            onDelete={(sourceId) => run('delete', () => bridge.deleteUsageArchive(sourceId), '导入档案已删除，本机记录保留')} />)}
        <label className="setting-select"><span><b>导出范围</b><small>保留每个来源的身份和数据版本</small></span><select aria-label="用量档案导出范围" value={scope} disabled={Boolean(busy)} onChange={(event) => setScope(event.target.value)}><option value="local">仅本机档案</option><option value="all">全部来源档案</option></select></label>
        <div className="data-transfer-actions">
          <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => run('export', () => bridge.exportUsageArchives({ scope }), (result) => `已导出 ${result.sources} 个来源、${number(result.records)} 条记录`)}><Download size={14} />{busy === 'export' ? '正在导出…' : '导出用量档案'}</button>
          <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={() => run('import', () => bridge.importUsageArchives(), (result) => { const added = result.results.filter((s) => s.status === 'added').length; const updated = result.results.filter((s) => s.status === 'updated').length; return `新增 ${added} 个来源，更新 ${updated} 个来源，跳过 ${result.results.length - added - updated} 个来源`; })}><UploadCloud size={14} />{busy === 'import' ? '正在导入…' : '导入用量档案'}</button>
        </div>
        <p className="usage-archive-help">导出完整用量记录和项目标签，不包含账号凭据或对话正文。清理 CLI 原始日志通常不会删除已采集的记录；请另存档案文件作为备份。</p>
        <details className="usage-archive-history"><summary>导入历史{info.history.length ? `（最近 ${info.history.length} 次）` : ''}</summary>
          {info.history.length ? <ol>{info.history.map((item) => <li key={item.importId}><b title={item.fileName}>{item.fileName}</b><small>{formatLocalDateTime(item.importedAt)}</small>{item.results.map((result) => <p key={result.sourceId}>{result.label} · v{result.revision} · {result.message}</p>)}</li>)}</ol> : <p className="usage-archive-empty">暂无导入记录。</p>}
        </details>
      </>}
      {notice && <div className={`usage-archive-notice${notice.ok ? '' : ' is-error'}`} role={notice.ok ? 'status' : 'alert'}>{notice.message}</div>}
    </>}
  </section>;
}
