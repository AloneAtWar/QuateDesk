import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertCircle, Bell, Check, ChevronDown, CircleGauge, Clock3, Eye, LayoutGrid,
  KeyRound, Monitor, Plus, RefreshCw, Rows3, Settings2, ShieldCheck, SlidersHorizontal,
  Pencil, Sparkles, Tag, Trash2, UploadCloud, X, Zap,
} from 'lucide-react';
import { initialAccounts, providerCatalog, windowCatalog } from './data';
import { adapterDefinitions } from './adapters';
import './styles.css';

const formatReset = (resetAt) => {
  if (!resetAt) return '不刷新';
  const diff = Math.max(0, new Date(resetAt).getTime() - Date.now());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后`;
  return `${Math.floor(minutes / (24 * 60))} 天 ${Math.floor((minutes % (24 * 60)) / 60)} 小时后`;
};

const formatResetCompact = (resetAt) => {
  if (!resetAt) return '—';
  const diff = Math.max(0, new Date(resetAt).getTime() - Date.now());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${Math.floor(minutes / (24 * 60))}d${Math.floor((minutes % (24 * 60)) / 60)}h`;
};

const formatChecked = (date) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  if (minutes < 1) return '刚刚更新';
  if (minutes < 60) return `${minutes} 分钟前更新`;
  return `${Math.floor(minutes / 60)} 小时前更新`;
};

const formatAmount = (meter) => meter.key === 'balance' || meter.unit !== '%' ? `${meter.unit === 'CNY' ? '¥' : meter.unit}${Number(meter.amount ?? meter.remaining).toFixed(2)}` : `${Math.round(meter.remaining)}%`;
const formatQuotaDetail = (meter) => meter.unit === '%' && meter.limitAmount != null ? `已用 ${Number(meter.limitAmount - (meter.amount ?? meter.remaining)).toFixed(2)} / ${Number(meter.limitAmount).toFixed(2)}` : '';

const defaultEndpoint = (provider) => {
  const endpoint = provider?.requestConfig?.endpoint || adapterDefinitions[provider?.adapter]?.endpoint || '';
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const base = provider?.baseUrl || '';
  return `${base.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
};
// Kept for the legacy component definitions below; all rendered forms use full endpoints.
const defaultBaseUrl = (provider) => {
  if (provider?.baseUrl) return provider.baseUrl;
  try { return new URL(defaultEndpoint(provider)).origin; } catch { return ''; }
};
const providerWindowKeys = (provider) => {
  if (provider?.requestConfig?.windows?.length) return provider.requestConfig.windows;
  const rules = Array.isArray(provider?.requestConfig?.responseRules) ? provider.requestConfig.responseRules : [];
  const mapped = [...new Set(rules.flatMap((rule) => [rule.defaultWindow, ...Object.values(rule.windowMap || {})]).filter(Boolean))];
  return mapped.length ? mapped : adapterDefinitions[provider?.adapter]?.windows || ['five_hour', 'weekly', 'monthly', 'balance'];
};
const providerVariableDefinitions = (provider) => {
  const config = provider?.requestConfig || {};
  const custom = Array.isArray(config.variables) ? config.variables : [];
  if (config.adapterMode !== 'script') return custom;
  const system = [
    { key: 'endpoint', label: '额度接口路径', defaultValue: config.endpoint || '', required: true, secret: false, system: true },
    { key: 'apiKey', label: 'API Key', defaultValue: '', required: false, secret: true, system: true },
  ];
  const merged = [...system, ...custom];
  return merged.filter((item, index, list) => list.findIndex((candidate) => candidate.key === item.key) === index);
};
const defaultVariableValues = (provider, existing = {}) => Object.fromEntries(providerVariableDefinitions(provider).map((item) => [item.key, existing[item.key] ?? item.defaultValue ?? '']).filter(([key]) => key));
const splitVariableValues = (provider, values) => {
  const publicVariables = {};
  const secretVariables = {};
  providerVariableDefinitions(provider).forEach((item) => {
    const value = values[item.key] ?? '';
    if (item.secret) { if (String(value).length > 0) secretVariables[item.key] = value; }
    else publicVariables[item.key] = value;
  });
  return { publicVariables, secretVariables };
};

const ruleMatches = (meter, rule) => {
  const resetMs = meter.resetAt ? new Date(meter.resetAt).getTime() - Date.now() : Infinity;
  return Number(meter.remaining) >= Number(rule.minRemaining || 0) && resetMs <= Number(rule.beforeMinutes || 0) * 60_000;
};
const defaultReminderRules = [{ id: 'soon', label: '即将刷新且额度充足', beforeMinutes: 120, minRemaining: 50 }];
const normalizeSettings = (value = {}) => ({ alerts: true, pollMinutes: '15', widgetTagLimit: '2', reminderRules: defaultReminderRules, widget: true, widgetPreview: false, ...value, reminderRules: Array.isArray(value.reminderRules) ? value.reminderRules : defaultReminderRules });

function Logo({ provider, size = 'md' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [provider?.logo]);
  return <span className={`provider-logo ${provider?.tone || 'slate'} ${size}`} aria-label={provider?.name}>{provider?.logo && !failed ? <img src={provider.logo} alt="" onError={() => setFailed(true)} /> : provider?.monogram || '?'}</span>;
}

function MeterBar({ meter, compact = false }) {
  const label = windowCatalog[meter.key]?.label || meter.key;
  return <div className={`meter-line ${compact ? 'compact' : ''} ${meter.available === false ? 'unavailable' : ''}`}>
    <div className="meter-line-head">
      <span className="meter-name">{label}</span>
      <span className="meter-reading">{formatAmount(meter)}{formatQuotaDetail(meter) && <small>{formatQuotaDetail(meter)}</small>}</span>
    </div>
    <div className="meter-track" role="progressbar" aria-valuenow={meter.remaining} aria-valuemin="0" aria-valuemax={meter.total}>
      <span className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, meter.remaining))}%` }} />
    </div>
    <div className="meter-line-foot">
      <span className="meter-state">{meter.available === false ? <><AlertCircle size={12} /> {meter.error || '不可用'}</> : meter.key === 'balance' ? '可用余额' : '剩余额度'}</span>
      <span className="reset-meta"><Clock3 size={12} /> {formatReset(meter.resetAt)}</span>
    </div>
  </div>;
}

function TagPill({ children, tone = '' }) { return <span className={`tag-pill ${tone}`}>{children}</span>; }

function AccountIdentity({ account, provider }) {
  return <div className="account-identity">
    <Logo provider={provider} />
    <div className="account-copy">
      <div className="account-title-line"><strong>{account.name}</strong>{account.tags?.slice(0, 2).map((tag) => <TagPill key={tag}>{tag}</TagPill>)}</div>
      <span>{provider?.name} · {account.identity}</span>
    </div>
  </div>;
}

function RuleMarks({ meter, rules = [] }) {
  const matched = rules.filter((rule) => ruleMatches(meter, rule));
  return matched.length ? <span className="rule-marks">{matched.map((rule) => <TagPill key={rule.id} tone="warm">{rule.label || `${rule.beforeMinutes} 分钟 / ${rule.minRemaining}%`}</TagPill>)}</span> : null;
}

function ConcentricRings({ account }) {
  const durationOrder = { five_hour: 1, weekly: 2, monthly: 3, balance: 4 };
  const meters = [...(account.windows || [])].sort((a, b) => (durationOrder[b.key] || 9) - (durationOrder[a.key] || 9)).slice(0, 4);
  const smallest = meters.reduce((current, meter) => !current || Number(meter.remaining) < Number(current.remaining) ? meter : current, null);
  const [hoveredKey, setHoveredKey] = useState(null);
  const unavailable = meters.find((meter) => meter.available === false);
  const active = unavailable || meters.find((meter) => meter.key === hoveredKey) || smallest;
  return <div className="concentric-rings" aria-label={`${meters.length} 个额度窗口`}>
    {meters.map((meter, index) => <div className={`quota-ring ring-${index} ${active?.key === meter.key ? 'is-active' : ''}`} key={meter.key} style={{ '--progress': `${Math.max(0, Math.min(100, Number(meter.remaining || 0))) * 3.6}deg` }} onMouseEnter={() => setHoveredKey(meter.key)} onMouseLeave={() => setHoveredKey(null)}><span /></div>)}
    <div className={`ring-core ${unavailable ? 'unavailable' : ''}`}><strong>{unavailable ? '不可用' : active ? formatAmount(active) : '—'}</strong><small>{active ? windowCatalog[active.key]?.label || active.key : '暂无窗口'}</small>{!unavailable && active?.resetAt && <em>{formatReset(active.resetAt)}</em>}</div>
  </div>;
}

function PriorityView({ accounts, providers, reminderRules }) {
  const grouped = useMemo(() => {
    const byWindow = new Map();
    accounts.flatMap((account) => account.windows.map((meter) => ({ account, meter }))).forEach((row) => {
      if (!byWindow.has(row.meter.key)) byWindow.set(row.meter.key, []);
      byWindow.get(row.meter.key).push(row);
    });
    return [...byWindow.entries()].map(([key, rows]) => [key, rows.sort((a, b) => new Date(a.meter.resetAt || '9999').getTime() - new Date(b.meter.resetAt || '9999').getTime())]);
  }, [accounts]);
  return <div className="view-stack">
    {grouped.map(([key, rows]) => <section className="surface-section" key={key}>
      <div className="section-heading"><div><span className="eyebrow">{windowCatalog[key]?.group || '额度'}</span><h2>{windowCatalog[key]?.label || key}</h2></div><span className="section-count">{rows.length} 个账号</span></div>
      <div className="priority-list">{rows.map(({ account, meter }) => {
        const provider = providers.find((item) => item.id === account.providerId);
        return <div className="priority-row" key={`${account.id}-${meter.key}`}>
          <AccountIdentity account={account} provider={provider} />
          <div className="priority-meter"><div className="meter-track"><span className="meter-fill" style={{ width: `${meter.remaining}%` }} /></div><b>{formatAmount(meter)}</b></div>
          <div className="priority-reset"><Clock3 size={13} /><span>{formatReset(meter.resetAt)}</span><RuleMarks meter={meter} rules={reminderRules} /></div>
          <button className="icon-button faint" aria-label="查看账号"><ChevronDown size={16} /></button>
        </div>;
      })}</div>
    </section>)}
  </div>;
}

function WindowsView({ accounts, providers, reminderRules, embedded = false }) {
  const sorted = useMemo(() => [...accounts].sort((a, b) => {
    const aReset = Math.min(...a.windows.map((m) => m.resetAt ? new Date(m.resetAt).getTime() : Infinity));
    const bReset = Math.min(...b.windows.map((m) => m.resetAt ? new Date(m.resetAt).getTime() : Infinity));
    return aReset - bReset;
  }), [accounts]);
  return <div className="view-stack">
    {!embedded && <section className="view-intro"><div><span className="eyebrow">账号聚合</span><h1>所有额度窗口</h1><p>每个账号只占一行，窗口和刷新时间始终放在一起。</p></div><span className="sort-note"><SlidersHorizontal size={15} /> 按最近刷新排序</span></section>}
    <section className="surface-section windows-section">
      <div className="windows-column-head"><span>账号</span><span>剩余进度</span><span>状态</span></div>
      <div className="windows-list">{sorted.map((account) => {
        const provider = providers.find((item) => item.id === account.providerId);
        return <div className="account-window-row" key={account.id}>
          <AccountIdentity account={account} provider={provider} />
          <div className="account-meters">{account.windows.map((meter) => <div key={meter.key}><MeterBar meter={meter} /><RuleMarks meter={meter} rules={reminderRules} /></div>)}</div>
          <div className={`account-status ${account.status}`}><span className="status-dot" />{account.status === 'warning' ? '需处理' : '正常'}<small>{formatChecked(account.lastChecked)}</small></div>
        </div>;
      })}</div>
    </section>
  </div>;
}

function StatusView({ accounts, providers, runtime, onTestAccount, testingAccountId, testResults, reminderRules, mode = 'rings', onModeChange }) {
  const groups = { active: accounts.filter((a) => a.status === 'active'), warning: accounts.filter((a) => a.status === 'warning') };
  const viewControls = <div className="overview-controls" aria-label="账号总览展示方式"><button className={mode === 'rings' ? 'active' : ''} onClick={() => onModeChange('rings')} title="同心圆总览" aria-label="同心圆总览"><CircleGauge size={16} /></button><button className={mode === 'rows' ? 'active' : ''} onClick={() => onModeChange('rows')} title="按账号行展示" aria-label="按账号行展示"><Rows3 size={16} /></button><button className={mode === 'periods' ? 'active' : ''} onClick={() => onModeChange('periods')} title="按时间周期展示" aria-label="按时间周期展示"><Clock3 size={16} /></button></div>;
  if (mode === 'rows') return <div className="view-stack"><section className="view-intro overview-title"><div><span className="eyebrow">额度与连接总览</span><h1>账号总览</h1></div>{viewControls}</section><WindowsView accounts={accounts} providers={providers} reminderRules={reminderRules} embedded /></div>;
  if (mode === 'periods') return <div className="view-stack"><section className="view-intro overview-title"><div><span className="eyebrow">额度与连接总览</span><h1>账号总览</h1></div>{viewControls}</section><PriorityView accounts={accounts} providers={providers} reminderRules={reminderRules} /></div>;
  return <div className="view-stack">
    <section className="view-intro overview-title"><div><span className="eyebrow">额度与连接总览</span><h1>账号总览</h1><p>每个环对应一个额度窗口，中心默认显示剩余最少的窗口。</p></div><div className="overview-title-right"><div className="health-summary"><ShieldCheck size={17} /><strong>{groups.active.length}</strong><span>个账号正常</span></div>{viewControls}</div></section>
    <section className={`runtime-band ${runtime?.running ? 'running' : 'stopped'}`}><span className="runtime-indicator" /><div><b>{runtime?.running ? '后台轮询正在运行' : '后台轮询未启动'}</b><small>{runtime?.checking ? '正在读取额度' : runtime?.nextPollAt ? `下次检查 ${formatReset(runtime.nextPollAt)}` : '可用下方按钮立即测试'}</small></div></section>
    <section className="overview-grid">{[...groups.active, ...groups.warning].map((account) => {
      const provider = providers.find((item) => item.id === account.providerId);
      const feedback = testResults[account.id];
      const testing = testingAccountId === account.id;
      return <div className={`overview-card ${account.status}`} key={account.id}><div className="overview-head"><AccountIdentity account={account} provider={provider} /><button className="test-button" disabled={testing} onClick={() => onTestAccount(account)}><RefreshCw size={13} className={testing ? 'spinning' : ''} />{testing ? '测试中' : '测试连接'}</button></div><div className="overview-body"><ConcentricRings account={account} /><div className="overview-meters">{account.windows.map((meter, index) => <div className="overview-meter" key={meter.key}><span><i className={`ring-dot ring-dot-${index}`} />{windowCatalog[meter.key]?.label || meter.key}</span><b>{formatAmount(meter)}</b><small>{formatReset(meter.resetAt)}{formatQuotaDetail(meter) ? ` · ${formatQuotaDetail(meter)}` : ''}</small></div>)}</div></div><div className={`status-copy ${account.status}`}>{account.status === 'warning' ? <><AlertCircle size={16} />{account.lastError || '连接检查失败'}</> : <><ShieldCheck size={16} />{feedback?.ok ? feedback.message : `连接正常 · ${account.windows.length} 个额度窗口`}</>}</div></div>;
    })}</section>
  </div>;
}

function Toggle({ checked, onChange, label, description }) {
  return <label className="setting-toggle"><span><b>{label}</b><small>{description}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
}

function SettingsDrawer({ accounts, providers, settings, setSettings, onClose, openModal, onDeleteAccount, onTestAccount, testingAccountId, onEditProvider }) {
  return <aside className="settings-drawer" aria-label="设置">
    <div className="drawer-header"><div><span className="eyebrow">工作区设置</span><h2>把 Quota Desk 调成你的节奏</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭设置"><X size={18} /></button></div>
    <div className="drawer-scroll">
      <section className="drawer-section"><div className="drawer-section-title"><Bell size={16} /><span>刷新提醒规则</span><button className="mini-add" onClick={() => setSettings((old) => ({ ...old, reminderRules: [...(old.reminderRules || []), { id: `rule-${Date.now()}`, label: '新规则', beforeMinutes: 120, minRemaining: 50 }] }))}><Plus size={14} /> 新增规则</button></div><Toggle checked={settings.alerts !== false} onChange={(value) => setSettings((old) => ({ ...old, alerts: value }))} label="启用提醒" description="关闭后不发送桌面通知，也不标记命中规则" />{(settings.reminderRules || []).length === 0 ? <div className="settings-empty">当前没有运行规则</div> : (settings.reminderRules || []).map((rule, index) => <div className="rule-editor" key={rule.id}><label><span>规则名称</span><input value={rule.label} onChange={(event) => setSettings((old) => ({ ...old, reminderRules: old.reminderRules.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) }))} placeholder="例如：即将刷新" /></label><label><span>刷新前多久（分钟）</span><input type="number" min="1" value={rule.beforeMinutes} onChange={(event) => setSettings((old) => ({ ...old, reminderRules: old.reminderRules.map((item, itemIndex) => itemIndex === index ? { ...item, beforeMinutes: event.target.value } : item) }))} /></label><label><span>剩余至少（百分比）</span><input type="number" min="0" max="100" value={rule.minRemaining} onChange={(event) => setSettings((old) => ({ ...old, reminderRules: old.reminderRules.map((item, itemIndex) => itemIndex === index ? { ...item, minRemaining: event.target.value } : item) }))} /></label><button className="row-icon-button danger" title="删除规则" aria-label={`删除 ${rule.label || '规则'}`} onClick={() => setSettings((old) => ({ ...old, reminderRules: old.reminderRules.filter((item) => item.id !== rule.id) }))}><Trash2 size={13} /></button></div>)}<small className="drawer-help">满足“刷新前多久”且“剩余至少”时，额度窗口会标记该规则。</small><div className="setting-select"><span><b>轮询间隔</b><small>所有账号统一检查频率</small></span><select value={settings.pollMinutes} onChange={(event) => setSettings((old) => ({ ...old, pollMinutes: event.target.value }))}><option value="5">5 分钟</option><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="60">1 小时</option></select></div></section>
      <section className="drawer-section"><div className="drawer-section-title"><Monitor size={16} /><span>桌面小空间</span></div><Toggle checked={settings.widget} onChange={(value) => setSettings((old) => ({ ...old, widget: value }))} label="显示单行小空间" description="固定在桌面顶层，双击展开主窗口" /><div className="setting-select"><span><b>最多显示标签</b><small>一个账号可以有 0 个或多个标签</small></span><select value={settings.widgetTagLimit ?? '2'} onChange={(event) => setSettings((old) => ({ ...old, widgetTagLimit: event.target.value }))}><option value="0">不显示</option><option value="1">1 个</option><option value="2">2 个</option><option value="3">3 个</option></select></div><div className="widget-setting-preview"><WidgetRow account={accounts[0]} provider={providers.find((item) => item.id === accounts[0]?.providerId)} compact tagLimit={Number(settings.widgetTagLimit ?? 2)} /></div><button className="outline-button full" onClick={() => setSettings((old) => ({ ...old, widgetPreview: true }))}><Eye size={15} /> 预览并调整</button></section>
      <section className="drawer-section"><div className="drawer-section-title"><ShieldCheck size={16} /><span>账号与凭据</span><button className="mini-add" onClick={() => openModal('account')}><Plus size={14} /> 添加账号</button></div><div className="settings-list">{accounts.length === 0 && <div className="settings-empty">还没有账号</div>}{accounts.map((account) => { const provider = providers.find((item) => item.id === account.providerId); const testing = testingAccountId === account.id; return <div className="settings-account" key={account.id}><Logo provider={provider} size="sm" /><div><b>{account.name}</b><small className={account.status === 'warning' ? 'warning-copy' : ''}>{account.status === 'warning' ? account.lastError : `${provider?.name} · ${account.windows.length} 个额度窗口`}</small></div><button className="row-icon-button" title="编辑账号" aria-label={`编辑 ${account.name}`} onClick={() => openModal({ type: 'account-edit', account })}><Pencil size={13} /></button><button className="row-icon-button" disabled={testing} title="测试连接" aria-label={`测试 ${account.name} 连接`} onClick={() => onTestAccount(account)}><RefreshCw size={13} className={testing ? 'spinning' : ''} /></button><button className="row-icon-button" title="更新凭据" aria-label={`更新 ${account.name} 凭据`} onClick={() => openModal({ type: 'credential', account })}><KeyRound size={13} /></button><button className="row-icon-button danger" title="删除账号" aria-label={`删除 ${account.name}`} onClick={() => onDeleteAccount(account)}><Trash2 size={13} /></button><span className={`status-dot ${account.status}`} /></div>; })}</div></section>
      <section className="drawer-section"><div className="drawer-section-title"><LayoutGrid size={16} /><span>厂商适配器</span><button className="mini-add" onClick={() => openModal('provider')}><Plus size={14} /> 新增厂商</button></div><div className="settings-list providers-list">{providers.map((provider) => <div className="settings-account" key={provider.id}><Logo provider={provider} size="sm" /><div><b>{provider.name}</b><small>{provider.requestConfig?.endpoint || '未设置额度接口'} · {provider.requestConfig?.adapterMode === 'script' ? '脚本适配' : '标准映射'}</small></div><button className="row-icon-button" title="编辑厂商" aria-label={`编辑 ${provider.name}`} onClick={() => onEditProvider(provider)}><Pencil size={13} /></button><span className="adapter-state"><Check size={13} /></span></div>)}</div></section>
    </div>
  </aside>;
}

function WidgetRow({ account, provider, compact = false, tagLimit = 2, onDoubleClick }) {
  if (!account) return null;
  const visibleMeters = (account.windows || []).slice(0, 2);
  return <div className={`widget-row ${compact ? 'compact' : ''}`} title={account.lastError || account.name} onDoubleClick={onDoubleClick}><Logo provider={provider} size="sm" /><div className="widget-account-block"><strong className="widget-account">{account.name}</strong>{tagLimit > 0 && <span className="widget-tags">{(account.tags || []).slice(0, tagLimit).map((tag) => <em key={tag}>{tag}</em>)}</span>}</div><div className="widget-meters">{visibleMeters.length ? visibleMeters.map((meter) => <span className={`widget-meter ${meter.available === false ? 'off' : ''}`} key={meter.key}><b>{windowCatalog[meter.key]?.short}</b><em>{formatAmount(meter)}</em><small>{formatResetCompact(meter.resetAt)}</small></span>) : <span className="widget-empty">等待同步</span>}</div><span className={`widget-live ${account.status === 'warning' ? 'warning' : ''}`}><i /></span></div>;
}

function WidgetPreview({ account, provider, onClose, tagLimit = 2 }) {
  return <div className="widget-preview-layer"><div className="widget-preview-head"><span><Monitor size={14} /> 小空间预览</span><button className="icon-button" onClick={onClose} aria-label="关闭预览"><X size={15} /></button></div><WidgetRow account={account} provider={provider} compact tagLimit={tagLimit} /></div>;
}

function AccountModal({ providers, onClose, onSave }) {
  const [providerId, setProviderId] = useState(providers[0]?.id || '');
  const [name, setName] = useState('');
  const [identity, setIdentity] = useState('');
  const [tags, setTags] = useState('日常');
  const [credential, setCredential] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [endpoint, setEndpoint] = useState(() => defaultEndpoint(providers[0]));
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(() => providers[0] ? providerWindowKeys(providers[0]) : []);
  const provider = providers.find((item) => item.id === providerId);
  const availableWindows = providerWindowKeys(provider);
  const credentialRequired = provider?.requestConfig?.auth !== 'none';
  const toggle = (key) => setSelected((old) => old.includes(key) ? old.filter((item) => item !== key) : [...old, key]);
const needsBaseUrl = provider?.adapter === 'wlb' || provider?.adapter === 'zai' || provider?.adapter === 'generic';
  const credentialLabel = provider?.adapter === 'mimo' ? 'Cookie' : 'API Token';
  const submit = async (event) => {
    event.preventDefault();
    if (!credential.trim() || !selected.length) return;
    setSaving(true);
    try {
      await onSave({ providerId, name: name || provider?.name || '新账号', identity: identity || '未命名凭据', tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), windowKeys: selected, credential, baseUrl: baseUrl.trim(), endpoint: endpoint.trim() });
    } finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">新账号</span><h2>连接一个账号</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={17} /></button></div><label className="field"><span>厂商</span><select value={providerId} onChange={(event) => { setProviderId(event.target.value); const next = providers.find((item) => item.id === event.target.value); setSelected(providerWindowKeys(next)); setBaseUrl(next?.baseUrl || ''); setEndpoint(defaultEndpoint(next)); }}>{providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><div className="form-grid"><label className="field"><span>账号名</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={provider?.name || '账号名称'} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="邮箱、用户名或币种" /></label></div><label className="field"><span>标签 <small>用逗号分隔，可多选</small></span><div className="input-with-icon"><Tag size={15} /><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="日常, 主力" /></div></label><label className="field"><span>额度接口默认路径 <small>可按账号覆盖</small></span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label><div className="field"><span>额度窗口 <small>同一账号可一次选择多个</small></span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div>{needsBaseUrl && <label className="field"><span>接口 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider?.baseUrl || 'https://api.example.com'} /></label>}<label className="field"><span>{credentialLabel} <small>使用 Windows DPAPI 加密，仅保存在本机</small></span><div className="input-with-icon"><ShieldCheck size={15} /><input type="password" required value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={provider?.adapter === 'mimo' ? '粘贴完整 Cookie' : '粘贴 Token，不要添加 Bearer'} /></div></label><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={saving || !credential.trim() || !selected.length}><RefreshCw size={15} className={saving ? 'spinning' : ''} /> {saving ? '正在测试' : '保存并测试'}</button></div></form></div>;
}

function CredentialModal({ account, provider, onClose, onSave }) {
  const [credential, setCredential] = useState('');
  const [baseUrl, setBaseUrl] = useState(account.baseUrl || provider?.baseUrl || '');
  const [saving, setSaving] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (!credential.trim()) return;
    setSaving(true);
    try { await onSave({ account, credential, baseUrl: baseUrl.trim() }); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="modal compact-modal" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">Windows 安全凭据</span><h2>更新 {account.name}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={17} /></button></div>{(provider?.adapter === 'wlb' || provider?.adapter === 'zai' || provider?.adapter === 'generic') && <label className="field"><span>接口 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>}<label className="field"><span>{provider?.adapter === 'mimo' ? '新 Cookie' : '新 API Token'} <small>原凭据不会被读取或显示</small></span><div className="input-with-icon"><KeyRound size={15} /><input autoFocus type="password" required value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="输入后覆盖旧凭据" /></div></label><div className="adapter-note"><ShieldCheck size={15} /><span>保存后由 Windows DPAPI 加密，并立即检查一次该账号的额度。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !credential.trim()}>{saving ? '正在验证' : '保存并检查'}</button></div></form></div>;
}

function AccountEditModal({ account, provider, onClose, onSave }) {
  const [name, setName] = useState(account.name || '');
  const [identity, setIdentity] = useState(account.identity || '');
  const [tags, setTags] = useState((account.tags || []).join(', '));
  const [endpoint, setEndpoint] = useState(account.endpoint || defaultEndpoint(provider));
  const [credential, setCredential] = useState('');
  const [selected, setSelected] = useState(account.windowKeys?.length ? account.windowKeys : (account.windows || []).map((item) => item.key));
  const [saving, setSaving] = useState(false);
  const availableWindows = providerWindowKeys(provider);
  const toggle = (key) => setSelected((old) => old.includes(key) ? old.filter((item) => item !== key) : [...old, key]);
  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim() || !selected.length) return;
    setSaving(true);
    try {
      await onSave({ account, name: name.trim(), identity: identity.trim() || '未命名凭据', tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), endpoint: endpoint.trim(), windowKeys: selected, credential: credential.trim() });
    } finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">账号配置</span><h2>编辑 {account.name}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={17} /></button></div><div className="form-grid"><label className="field"><span>账号名</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="邮箱、用户名或币种" /></label></div><label className="field"><span>标签 <small>用逗号分隔</small></span><div className="input-with-icon"><Tag size={15} /><input value={tags} onChange={(event) => setTags(event.target.value)} /></div></label><div className="form-grid"><label className="field"><span>接口 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label><label className="field"><span>额度接口路径</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label></div><div className="field"><span>额度窗口 <small>取消选择后不会在该账号显示</small></span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div><label className="field"><span>{provider?.adapter === 'mimo' ? '新 Cookie' : '新 API Token'} <small>留空则保留原凭据</small></span><div className="input-with-icon"><KeyRound size={15} /><input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="需要更换时再输入" /></div></label><div className="adapter-note"><ShieldCheck size={15} /><span>保存后会立即重新测试该账号，原凭据不会被读取或显示。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !selected.length}><Pencil size={15} /> {saving ? '正在保存并测试' : '保存并测试'}</button></div></form></div>;
}

function ProviderModal({ provider, onClose, onSave }) {
  const existing = provider || {};
  const config = existing.requestConfig || {};
  const [name, setName] = useState(existing.name || '');
  const [domain, setDomain] = useState(existing.domain || '');
  const [baseUrl, setBaseUrl] = useState(existing.baseUrl || defaultBaseUrl(provider));
  const [logo, setLogo] = useState(existing.logo || '');
  const [endpoint, setEndpoint] = useState(config.endpoint || adapterDefinitions[existing.adapter]?.endpoint || '/v1/usage');
  const [auth, setAuth] = useState(config.auth || adapterDefinitions[existing.adapter]?.auth || 'bearer');
  const [script, setScript] = useState(config.script || '');
  const [collectionMode, setCollectionMode] = useState(config.collectionMode || 'auto');
  const [listPath, setListPath] = useState(config.listPath || '');
  const [windowField, setWindowField] = useState(config.windowField || 'window');
  const [defaultWindow, setDefaultWindow] = useState(config.defaultWindow || 'weekly');
  const [windowMapText, setWindowMapText] = useState(Object.entries(config.windowMap || { '5h': 'five_hour', '7d': 'weekly', month: 'monthly' }).map(([key, value]) => `${key}=${value}`).join('\n'));
  const [totalPath, setTotalPath] = useState(config.totalPath || 'limit');
  const [remainingPath, setRemainingPath] = useState(config.remainingPath || 'remaining');
  const [usedPath, setUsedPath] = useState(config.usedPath || 'used');
  const [percentagePath, setPercentagePath] = useState(config.percentagePath || 'percentage');
  const [percentageMode, setPercentageMode] = useState(config.percentageMode || 'used');
  const [availablePath, setAvailablePath] = useState(config.availablePath || '');
  const [unit, setUnit] = useState(config.unit || '%');
  const [resetPath, setResetPath] = useState(config.resetPath || 'resetAt|resetTime|nextResetTime');
  const isGeneric = existing.adapter === 'generic' || !provider;
  const readLogo = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  };
  const submit = (event) => {
    event.preventDefault();
    const windowMap = Object.fromEntries(windowMapText.split('\n').map((line) => line.trim()).filter((line) => line.includes('=')).map((line) => { const [source, target] = line.split('=').map((item) => item.trim()); return [source.toLowerCase(), target]; }));
    onSave({ id: provider?.id, name: name || '新厂商', domain: domain || existing.domain || '', adapter: provider?.adapter || 'generic', logo, baseUrl: baseUrl || (domain ? `https://${domain}` : ''), requestConfig: { ...config, endpoint, auth, script, collectionMode, listPath, windowField, defaultWindow, windowMap, totalPath, remainingPath, usedPath, percentagePath, resetPath } });
  };
  return <div className="modal-backdrop"><form className="modal provider-modal" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">{isGeneric ? '通用 JSON 适配器' : '内置厂商配置'}</span><h2>{provider ? '编辑厂商' : '新增厂商'}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={17} /></button></div><div className="logo-upload">{logo ? <span className="upload-preview"><img src={logo} alt="Logo 预览" /></span> : <span className="upload-mark"><UploadCloud size={19} /></span>}<div><b>{logo ? 'Logo 已准备好' : '上传厂商 Logo'}</b><small>PNG / SVG / WebP，建议 64 × 64</small></div><label className="outline-button file-button"><UploadCloud size={13} /> {logo ? '更换' : '选择文件'}<input type="file" accept="image/png,image/svg+xml,image/webp" onChange={readLogo} /></label></div><div className="form-grid"><label className="field"><span>厂商名称</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Acme Coding" /></label><label className="field"><span>接口 Base URL</span><input required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com" /></label></div><div className="form-grid"><label className="field"><span>默认额度接口</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="/v1/usage 或完整 URL" /></label><label className="field"><span>认证方式</span><select value={auth} onChange={(event) => setAuth(event.target.value)}><option value="bearer">Bearer Token</option><option value="token">原始 Token</option><option value="cookie">Cookie</option></select></label></div><label className="field"><span>高级适配脚本 <small>可覆盖内置请求和响应解析，返回 request + extractor</small></span><textarea value={script} onChange={(event) => setScript(event.target.value)} placeholder="({ request: { url: '{{baseUrl}}/v1/usage', method: 'GET', headers: { Authorization: 'Bearer {{apiKey}}' } }, extractor(response) { return { key: 'weekly', remaining: 50, total: 100, reset_at: response?.rate_limits?.[0]?.reset_at, unit: '%' }; } })" /></label>{isGeneric && <div className="adapter-config"><span className="eyebrow">响应字段映射</span><div className="form-grid"><label className="field"><span>数据路径</span><input value={listPath} onChange={(event) => setListPath(event.target.value)} placeholder="data.limits 或 data.quota" /></label><label className="field"><span>数据形态</span><select value={collectionMode} onChange={(event) => setCollectionMode(event.target.value)}><option value="auto">自动判断</option><option value="single">单个对象</option><option value="array">数组</option><option value="object-entries">对象键作为窗口</option></select></label></div><div className="form-grid"><label className="field"><span>窗口字段</span><input value={windowField} onChange={(event) => setWindowField(event.target.value)} placeholder="window / name / type" /></label><label className="field"><span>默认窗口</span><select value={defaultWindow} onChange={(event) => setDefaultWindow(event.target.value)}><option value="five_hour">5 小时</option><option value="weekly">7 天</option><option value="monthly">月度</option><option value="balance">余额</option></select></label></div><label className="field"><span>窗口值映射</span><textarea value={windowMapText} onChange={(event) => setWindowMapText(event.target.value)} /></label><div className="form-grid mapping-grid"><label className="field"><span>总量路径</span><input value={totalPath} onChange={(event) => setTotalPath(event.target.value)} /></label><label className="field"><span>剩余路径</span><input value={remainingPath} onChange={(event) => setRemainingPath(event.target.value)} /></label><label className="field"><span>已用路径</span><input value={usedPath} onChange={(event) => setUsedPath(event.target.value)} /></label><label className="field"><span>百分比路径</span><input value={percentagePath} onChange={(event) => setPercentagePath(event.target.value)} /></label></div><label className="field"><span>刷新时间路径</span><input value={resetPath} onChange={(event) => setResetPath(event.target.value)} /></label></div>}<div className="adapter-note"><Sparkles size={15} /><span>脚本适配器支持复杂认证、请求方法、请求头、请求体和任意响应提取逻辑。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" type="submit"><Pencil size={15} /> {provider ? '保存厂商' : '新增厂商'}</button></div></form></div>;
}

function AccountModalV2({ providers, onClose, onSave }) {
  const [providerId, setProviderId] = useState(providers[0]?.id || '');
  const [name, setName] = useState('');
  const [identity, setIdentity] = useState('');
  const [tags, setTags] = useState('');
  const [credential, setCredential] = useState('');
  const [endpoint, setEndpoint] = useState(() => defaultEndpoint(providers[0]));
  const [selected, setSelected] = useState(() => providers[0] ? providerWindowKeys(providers[0]) : []);
  const [variableValues, setVariableValues] = useState(() => defaultVariableValues(providers[0]));
  const [saving, setSaving] = useState(false);
  const provider = providers.find((item) => item.id === providerId);
  const availableWindows = providerWindowKeys(provider);
  const variableDefinitions = providerVariableDefinitions(provider);
  const credentialRequired = provider?.requestConfig?.adapterMode === 'script' ? false : provider?.requestConfig?.auth !== 'none';
  const missingRequiredVariables = variableDefinitions.some((item) => item.required && !String(variableValues[item.key] ?? '').trim());
  const toggle = (key) => setSelected((old) => old.includes(key) ? old.filter((item) => item !== key) : [...old, key]);
  const submit = async (event) => {
    event.preventDefault();
    const accountEndpoint = provider?.requestConfig?.adapterMode === 'script' ? String(variableValues.endpoint || provider.requestConfig.endpoint || '') : endpoint.trim();
    if ((credentialRequired && !credential.trim()) || missingRequiredVariables || !selected.length || !accountEndpoint) return;
    setSaving(true);
    const { publicVariables, secretVariables } = splitVariableValues(provider, variableValues);
    try { await onSave({ providerId, name: name.trim() || provider?.name || '新账号', identity: identity.trim() || '未命名凭据', tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), windowKeys: selected, credential: credential.trim(), endpoint: accountEndpoint, variables: publicVariables, secretVariables }); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">新账号</span><h2>连接一个账号</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></div><label className="field"><span>厂商</span><select value={providerId} onChange={(event) => { const next = providers.find((item) => item.id === event.target.value); setProviderId(event.target.value); setEndpoint(defaultEndpoint(next)); setSelected(providerWindowKeys(next)); setVariableValues(defaultVariableValues(next)); }}>{providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><div className="form-grid"><label className="field"><span>账号名</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={provider?.name || '账号名称'} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="邮箱、用户名或币种" /></label></div><label className="field"><span>标签 <small>用逗号分隔，可留空</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="日常, 主力" /></label>{provider?.requestConfig?.adapterMode !== 'script' && <label className="field"><span>详细额度接口路径</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com/v1/usage" /></label>}<div className="field"><span>额度窗口</span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div>{variableDefinitions.length > 0 && <div className="adapter-config account-variables"><span className="eyebrow">厂商变量</span><div className="form-grid">{variableDefinitions.map((item) => <label className="field" key={item.key}><span>{item.label || item.key}{item.required && <small> 必填</small>}</span><input type={item.secret ? 'password' : 'text'} required={item.required} value={variableValues[item.key] ?? ''} onChange={(event) => setVariableValues((old) => ({ ...old, [item.key]: event.target.value }))} placeholder={item.defaultValue || item.key} /></label>)}</div></div>}{provider?.requestConfig?.adapterMode !== 'script' && <label className="field"><span>{credentialRequired ? (provider?.adapter === 'mimo' ? 'Cookie' : 'API Token') : '凭据（可选）'}</span><input type="password" required={credentialRequired} value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={credentialRequired ? '凭据只会加密保存在本机' : '此接口无需凭据'} /></label>}<div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={saving || (credentialRequired && !credential.trim()) || missingRequiredVariables || !selected.length}>{saving ? '正在测试' : '保存并测试'}</button></div></form></div>;
}

function CredentialModalV2({ account, provider, onClose, onSave }) {
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (event) => { event.preventDefault(); if (!credential.trim()) return; setSaving(true); try { await onSave({ account, credential: credential.trim() }); } finally { setSaving(false); } };
  return <div className="modal-backdrop"><form className="modal compact-modal" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">Windows 安全凭据</span><h2>更新 {account.name}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={17} /></button></div><label className="field"><span>{provider?.adapter === 'mimo' ? '新 Cookie' : '新 API Token'} <small>原凭据不会被读取或显示</small></span><input autoFocus type="password" required value={credential} onChange={(event) => setCredential(event.target.value)} /></label><div className="adapter-note"><ShieldCheck size={15} /><span>保存后由 Windows DPAPI 加密，并立即检查一次该账号。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !credential.trim()}>{saving ? '正在验证' : '保存并检查'}</button></div></form></div>;
}

function AccountEditModalV2({ account, provider, onClose, onSave }) {
  const [name, setName] = useState(account.name || '');
  const [identity, setIdentity] = useState(account.identity || '');
  const [tags, setTags] = useState((account.tags || []).join(', '));
  const [endpoint, setEndpoint] = useState(account.endpoint || defaultEndpoint(provider));
  const [credential, setCredential] = useState('');
  const variableDefinitions = providerVariableDefinitions(provider);
  const [variableValues, setVariableValues] = useState(() => Object.fromEntries(variableDefinitions.map((item) => [item.key, item.secret ? '' : (account.variables?.[item.key] ?? item.defaultValue ?? '')])));
  const [selected, setSelected] = useState(account.windowKeys?.length ? account.windowKeys : (account.windows || []).map((item) => item.key));
  const [saving, setSaving] = useState(false);
  const availableWindows = providerWindowKeys(provider);
  const toggle = (key) => setSelected((old) => old.includes(key) ? old.filter((item) => item !== key) : [...old, key]);
  const submit = async (event) => { event.preventDefault(); const accountEndpoint = provider?.requestConfig?.adapterMode === 'script' ? String(variableValues.endpoint || provider.requestConfig.endpoint || '') : endpoint.trim(); if (!name.trim() || !accountEndpoint || !selected.length) return; const { publicVariables, secretVariables } = splitVariableValues(provider, variableValues); setSaving(true); try { await onSave({ account, name: name.trim(), identity: identity.trim() || '未命名凭据', tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), endpoint: accountEndpoint, windowKeys: selected, credential: credential.trim(), variables: publicVariables, secretVariables }); } finally { setSaving(false); } };
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">账号配置</span><h2>编辑 {account.name}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={17} /></button></div><div className="form-grid"><label className="field"><span>账号名</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} /></label></div><label className="field"><span>标签 <small>用逗号分隔，可留空</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>{provider?.requestConfig?.adapterMode !== 'script' && <label className="field"><span>详细额度接口路径</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>}<div className="field"><span>额度窗口</span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div>{variableDefinitions.length > 0 && <div className="adapter-config account-variables"><span className="eyebrow">厂商变量</span><div className="form-grid">{variableDefinitions.map((item) => <label className="field" key={item.key}><span>{item.label || item.key}{item.secret && <small> 留空保留原值</small>}</span><input type={item.secret ? 'password' : 'text'} required={item.required && !item.secret} value={variableValues[item.key] ?? ''} onChange={(event) => setVariableValues((old) => ({ ...old, [item.key]: event.target.value }))} placeholder={item.secret ? '未修改' : (item.defaultValue || item.key)} /></label>)}</div></div>}{provider?.requestConfig?.adapterMode !== 'script' && <label className="field"><span>{provider?.adapter === 'mimo' ? '新 Cookie' : '新 API Token'} <small>留空保留原凭据</small></span><input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} /></label>}<div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !selected.length}>{saving ? '正在保存并测试' : '保存并测试'}</button></div></form></div>;
}

function ProviderModalV2({ provider, onClose, onSave }) {
  const existing = provider || {};
  const config = existing.requestConfig || {};
  const [name, setName] = useState(existing.name || '');
  const [endpoint, setEndpoint] = useState(config.endpoint || adapterDefinitions[existing.adapter]?.endpoint || '/v1/usage');
  const [auth, setAuth] = useState(config.auth || adapterDefinitions[existing.adapter]?.auth || 'bearer');
  const [script, setScript] = useState(config.script || '');
  const [advancedEnabled, setAdvancedEnabled] = useState(config.adapterMode === 'script');
  const [credentialRequired, setCredentialRequired] = useState(config.adapterMode === 'script' ? false : config.credentialRequired !== false);
  const [variables, setVariables] = useState(() => providerVariableDefinitions(provider));
  const [method, setMethod] = useState(config.method || 'GET');
  const [authHeader, setAuthHeader] = useState(config.authHeader || 'Authorization');
  const [authPrefix, setAuthPrefix] = useState(config.authPrefix ?? (auth === 'bearer' ? 'Bearer ' : ''));
  const [authQuery, setAuthQuery] = useState(config.authQuery || 'api_key');
  const [headers, setHeaders] = useState(typeof config.headers === 'string' ? config.headers : JSON.stringify(config.headers || {}, null, 2));
  const [body, setBody] = useState(typeof config.body === 'string' ? config.body : JSON.stringify(config.body || {}, null, 2));
  const [listPath, setListPath] = useState(config.listPath || '');
  const [collectionMode, setCollectionMode] = useState(config.collectionMode || 'auto');
  const [windowField, setWindowField] = useState(config.windowField || 'window');
  const [defaultWindow, setDefaultWindow] = useState(config.defaultWindow || 'weekly');
  const [windowMapText, setWindowMapText] = useState(Object.entries(config.windowMap || { '5h': 'five_hour', '7d': 'weekly', month: 'monthly' }).map(([key, value]) => `${key}=${value}`).join('\n'));
  const [totalPath, setTotalPath] = useState(config.totalPath || 'limit');
  const [remainingPath, setRemainingPath] = useState(config.remainingPath || 'remaining');
  const [usedPath, setUsedPath] = useState(config.usedPath || 'used');
  const [percentagePath, setPercentagePath] = useState(config.percentagePath || 'percentage');
  const [percentageMode, setPercentageMode] = useState(config.percentageMode || 'used');
  const [availablePath, setAvailablePath] = useState(config.availablePath || '');
  const [unit, setUnit] = useState(config.unit || '%');
  const [resetPath, setResetPath] = useState(config.resetPath || 'resetAt|reset_at|resetTime|nextResetTime');
  const [responseRulesText, setResponseRulesText] = useState(Array.isArray(config.responseRules) ? JSON.stringify(config.responseRules, null, 2) : '');
  const [configError, setConfigError] = useState('');
  const [logo, setLogo] = useState(existing.logo || '');
  useEffect(() => {
    if (!advancedEnabled) return;
    setVariables((old) => {
      if (old.some((item) => item.key === 'endpoint')) return old;
      return [{ key: 'endpoint', label: '额度接口路径', defaultValue: endpoint, required: true, secret: false, system: true },
        { key: 'apiKey', label: 'API Key', defaultValue: '', required: false, secret: true, system: true }, ...old];
    });
  }, [advancedEnabled]);
  const readLogo = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  };
  const submit = (event) => {
    event.preventDefault();
    setConfigError('');
    const windowMap = Object.fromEntries(windowMapText.split('\n').map((line) => line.trim()).filter((line) => line.includes('=')).map((line) => { const [source, target] = line.split('=').map((item) => item.trim()); return [source.toLowerCase(), target]; }));
    let responseRules;
    try { responseRules = responseRulesText.trim() ? JSON.parse(responseRulesText) : undefined; }
    catch (error) { setConfigError(`响应规则 JSON 无效：${error.message}`); return; }
    if (responseRules && !Array.isArray(responseRules)) { setConfigError('响应规则必须是 JSON 数组'); return; }
    const cleanVariables = variables.map((item) => ({ key: String(item.key || '').trim(), label: String(item.label || '').trim(), defaultValue: item.defaultValue ?? '', required: Boolean(item.required), secret: Boolean(item.secret) })).filter((item) => item.key);
    if (cleanVariables.some((item) => !/^[A-Za-z_][\w.-]*$/.test(item.key))) { setConfigError('变量名只能使用字母、数字、下划线、点和连字符，且不能以数字开头'); return; }
    const endpointVariable = cleanVariables.find((item) => item.key === 'endpoint');
    onSave({ id: provider?.id, name: name || '新厂商', adapter: provider?.adapter || 'generic', logo, requestConfig: { ...config, adapterMode: advancedEnabled ? 'script' : 'standard', endpoint: advancedEnabled ? (endpointVariable?.defaultValue || endpoint) : endpoint, method, auth, authHeader, authPrefix, authQuery, headers, body, credentialRequired: advancedEnabled ? false : credentialRequired, variables: advancedEnabled ? cleanVariables : [], script: advancedEnabled ? script.trim() : '', responseRules: advancedEnabled ? undefined : responseRules, collectionMode, listPath, windowField, defaultWindow, windowMap, totalPath, remainingPath, usedPath, percentagePath, percentageMode, availablePath, unit, resetPath } });
  };
  return <div className="modal-backdrop"><form className={`modal provider-modal ${advancedEnabled ? 'script-mode' : ''}`} onSubmit={submit}>
    <div className="modal-head"><div><span className="eyebrow">{advancedEnabled ? '脚本适配器' : '通用厂商配置'}</span><h2>{provider ? '编辑厂商' : '新增厂商'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></div>
    <div className="logo-upload">{logo ? <span className="upload-preview"><img src={logo} alt="Logo 预览" /></span> : <span className="upload-mark"><UploadCloud size={19} /></span>}<div><b>{logo ? 'Logo 已准备好' : '上传厂商 Logo'}</b><small>PNG / SVG / WebP，建议 64 × 64</small></div><label className="outline-button file-button"><UploadCloud size={13} /> {logo ? '更换' : '选择文件'}<input type="file" accept="image/png,image/svg+xml,image/webp" onChange={readLogo} /></label></div>
    <label className="field"><span>厂商名称</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
    <Toggle checked={advancedEnabled} onChange={setAdvancedEnabled} label="高级适配脚本" description="开启后脚本独立负责请求与响应解析" />
    {advancedEnabled ? <><div className="adapter-config variable-editor"><div className="variable-editor-head"><span className="eyebrow">账号变量</span><button type="button" className="mini-add" onClick={() => setVariables((old) => [...old, { key: '', label: '', defaultValue: '', required: false, secret: false }])}><Plus size={13} /> 新增变量</button></div>{variables.length === 0 ? <div className="settings-empty">没有额外变量</div> : variables.map((item, index) => <div className="variable-row" key={`${item.key}-${index}`}><input value={item.key || ''} readOnly={item.system} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, key: event.target.value } : entry))} placeholder="变量名" /><input value={item.label || ''} readOnly={item.system} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, label: event.target.value } : entry))} placeholder="显示名称" /><input value={item.defaultValue ?? ''} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, defaultValue: event.target.value } : entry))} placeholder="默认值" /><label title="账号必须填写"><input type="checkbox" checked={Boolean(item.required)} disabled={item.key === 'apiKey'} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, required: event.target.checked } : entry))} />必填</label><label title="使用 Windows DPAPI 加密"><input type="checkbox" checked={Boolean(item.secret)} disabled={item.system} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, secret: event.target.checked } : entry))} />敏感</label>{item.system ? <span className="variable-system-badge">系统</span> : <button type="button" className="row-icon-button danger" onClick={() => setVariables((old) => old.filter((_entry, entryIndex) => entryIndex !== index))} aria-label="删除变量"><Trash2 size={13} /></button>}</div>)}</div><label className="field"><span>适配脚本</span><textarea className="script-editor" required value={script} onChange={(event) => setScript(event.target.value)} placeholder="({ request: { url: '{{endpoint}}?region={{region}}', method: 'GET' }, extractor(response, variables) { return { key: 'weekly', remaining: 50, total: 100, unit: '%' }; } })" /></label></> : <>
      <div className="form-grid"><label className="field"><span>默认额度接口 <small>必须是完整 URL</small></span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com/v1/usage" /></label><label className="field"><span>请求方法</span><select value={method} onChange={(event) => setMethod(event.target.value)}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option></select></label></div>
      <div className="adapter-config"><span className="eyebrow">认证与请求</span><div className="form-grid"><label className="field"><span>认证方式</span><select value={auth} onChange={(event) => setAuth(event.target.value)}><option value="bearer">Bearer Token</option><option value="token">自定义 Header</option><option value="cookie">Cookie</option><option value="query">Query 参数</option><option value="none">无需认证</option></select></label>{auth === 'query' ? <label className="field"><span>Query 参数名</span><input value={authQuery} onChange={(event) => setAuthQuery(event.target.value)} /></label> : auth !== 'none' && <label className="field"><span>认证 Header</span><input value={authHeader} onChange={(event) => setAuthHeader(event.target.value)} /></label>}</div>{(auth === 'bearer' || auth === 'token') && <label className="field"><span>凭据前缀 <small>例如 Bearer，末尾空格会保留</small></span><input value={authPrefix} onChange={(event) => setAuthPrefix(event.target.value)} /></label>}<div className="form-grid"><label className="field"><span>额外请求头 JSON</span><textarea value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder={'{"X-Client": "QuotaDesk"}'} /></label><label className="field"><span>请求体 JSON <small>GET 时忽略</small></span><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={'{"account": "{{accountId}}"}'} /></label></div></div>
      <div className="adapter-config"><span className="eyebrow">响应字段映射</span><div className="form-grid"><label className="field"><span>数据路径</span><input value={listPath} onChange={(event) => setListPath(event.target.value)} placeholder="data.quota，可留空" /></label><label className="field"><span>数据形态</span><select value={collectionMode} onChange={(event) => setCollectionMode(event.target.value)}><option value="auto">自动判断</option><option value="single">单个对象</option><option value="array">数组</option><option value="object-entries">对象键作为窗口</option></select></label></div><div className="form-grid"><label className="field"><span>窗口字段</span><input value={windowField} onChange={(event) => setWindowField(event.target.value)} /></label><label className="field"><span>默认窗口</span><select value={defaultWindow} onChange={(event) => setDefaultWindow(event.target.value)}><option value="five_hour">5 小时</option><option value="weekly">7 天</option><option value="monthly">月度</option><option value="balance">余额</option></select></label></div><label className="field"><span>窗口值映射 <small>每行：接口值=内部窗口</small></span><textarea value={windowMapText} onChange={(event) => setWindowMapText(event.target.value)} /></label><div className="form-grid mapping-grid"><label className="field"><span>总量路径</span><input value={totalPath} onChange={(event) => setTotalPath(event.target.value)} /></label><label className="field"><span>剩余路径</span><input value={remainingPath} onChange={(event) => setRemainingPath(event.target.value)} /></label><label className="field"><span>已用路径</span><input value={usedPath} onChange={(event) => setUsedPath(event.target.value)} /></label><label className="field"><span>百分比路径</span><input value={percentagePath} onChange={(event) => setPercentagePath(event.target.value)} /></label></div><div className="form-grid"><label className="field"><span>百分比含义</span><select value={percentageMode} onChange={(event) => setPercentageMode(event.target.value)}><option value="used">已用百分比</option><option value="remaining">剩余百分比</option></select></label><label className="field"><span>可用状态路径</span><input value={availablePath} onChange={(event) => setAvailablePath(event.target.value)} placeholder="isValid / status" /></label></div><div className="form-grid"><label className="field"><span>单位</span><input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="% / CNY / USD" /></label><label className="field"><span>刷新时间路径</span><input value={resetPath} onChange={(event) => setResetPath(event.target.value)} /></label></div></div>
      <label className="field"><span>多规则响应映射 JSON <small>填写后优先于上方单规则映射</small></span><textarea className="rules-editor" value={responseRulesText} onChange={(event) => setResponseRulesText(event.target.value)} placeholder={'[{"listPath":"rate_limits","collectionMode":"array","filterPath":"window","filterValue":"7d","defaultWindow":"weekly","totalPath":"limit","remainingPath":"remaining","resetPath":"reset_at"}]'} /></label>
    </>}
    {configError && <div className="desktop-error"><AlertCircle size={14} /><span>{configError}</span></div>}
    <div className="adapter-note"><Sparkles size={15} /><span>{advancedEnabled ? '脚本模式仅使用脚本中的 request 和 extractor。' : '标准模式支持完整 URL、方法、Header/Query/Cookie 认证、请求头/请求体 JSON 与多形态响应。'}</span></div>
    <div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" type="submit"><Pencil size={15} /> {provider ? '保存厂商' : '新增厂商'}</button></div>
  </form></div>;
}

function WidgetApp() {
  const [accounts, setAccounts] = useState(window.quotaDesk ? [] : initialAccounts);
  const [providers, setProviders] = useState(providerCatalog);
  const [settings, setSettings] = useState({ widgetTagLimit: '2' });
  const [index, setIndex] = useState(0);
  const dragRef = useRef({ active: false, moved: false, x: 0, y: 0 });
  useEffect(() => {
    let unsubscribe;
    window.quotaDesk?.loadState().then((state) => {
      if (state?.accounts?.length) setAccounts(state.accounts);
      if (state?.providers?.length) setProviders(state.providers);
      if (state?.settings) setSettings(state.settings);
    });
    if (window.quotaDesk) unsubscribe = window.quotaDesk.onStateUpdated((state) => { setAccounts(state.accounts || []); setProviders(state.providers || []); setSettings(state.settings || {}); });
    return () => unsubscribe?.();
  }, []);
  useEffect(() => { const timer = setInterval(() => setIndex((value) => (value + 1) % Math.max(accounts.length, 1)), 6000); return () => clearInterval(timer); }, [accounts.length]);
  const account = accounts[index % Math.max(accounts.length, 1)];
  const provider = providers.find((item) => item.id === account?.providerId);
  const startDrag = (event) => { dragRef.current = { active: true, moved: false, x: event.screenX, y: event.screenY }; event.currentTarget.setPointerCapture?.(event.pointerId); };
  const moveDrag = (event) => { const drag = dragRef.current; if (!drag.active) return; const deltaX = event.screenX - drag.x; const deltaY = event.screenY - drag.y; if (!deltaX && !deltaY) return; drag.moved ||= Math.abs(deltaX) + Math.abs(deltaY) > 2; drag.x = event.screenX; drag.y = event.screenY; window.quotaDesk?.moveWidget(deltaX, deltaY); };
  const stopDrag = () => { dragRef.current.active = false; };
  return <div className="widget-window-shell" title="拖动移动，双击展开" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onDoubleClick={() => { if (!dragRef.current.moved) window.quotaDesk?.openMainWindow(); }}><WidgetRow account={account} provider={provider} compact tagLimit={Number(settings.widgetTagLimit ?? 2)} /></div>;
}

function App() {
  const bridge = window.quotaDesk;
  const [overviewMode, setOverviewMode] = useState('rings');
  const [accounts, setAccounts] = useState(bridge ? [] : initialAccounts);
  const [providers, setProviders] = useState(providerCatalog);
  const [settings, setSettings] = useState({ alerts: true, pollMinutes: '15', widgetTagLimit: '2', reminderRules: [{ id: 'soon', label: '即将刷新且额度充足', beforeMinutes: 120, minRemaining: 50 }], widget: true, widgetPreview: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modal, setModal] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [widgetIndex, setWidgetIndex] = useState(0);
  const [lastSync, setLastSync] = useState(new Date().toISOString());
  const [desktopError, setDesktopError] = useState('');
  const [runtime, setRuntime] = useState({ running: Boolean(bridge), checking: false, nextPollAt: null });
  const [testingAccountId, setTestingAccountId] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [tick, setTick] = useState(0);
  const hydrated = useRef(!bridge);
  const lastSaved = useRef('');

  const serializableState = (next = {}) => ({
    accounts: next.accounts || accounts,
    providers: next.providers || providers,
    settings: { ...(next.settings || settings), widgetPreview: false },
    lastSync: next.lastSync || lastSync,
  });

  useEffect(() => {
    if (!bridge) return undefined;
    let active = true;
    let unsubscribe;
    const applyState = (state) => {
      if (!active || !state) return;
      const normalized = { accounts: state.accounts || [], providers: state.providers || [], settings: normalizeSettings({ ...state.settings, widgetPreview: false }), lastSync: state.lastSync || new Date().toISOString() };
      lastSaved.current = JSON.stringify(normalized);
      setAccounts(normalized.accounts);
      setProviders(normalized.providers);
      setSettings(normalized.settings);
      setLastSync(normalized.lastSync);
      if (state.runtime) setRuntime(state.runtime);
    };
    bridge.loadState().then(async (state) => {
      if (state) applyState(state);
      else {
        const initial = serializableState();
        lastSaved.current = JSON.stringify(initial);
        await bridge.saveState(initial);
      }
      hydrated.current = true;
    }).catch((error) => setDesktopError(error.message));
    unsubscribe = bridge.onStateUpdated(applyState);
    return () => { active = false; unsubscribe?.(); };
  }, []);

  useEffect(() => {
    if (!bridge || !hydrated.current) return undefined;
    const state = serializableState();
    const serialized = JSON.stringify(state);
    if (serialized === lastSaved.current) return undefined;
    const timer = setTimeout(() => {
      lastSaved.current = serialized;
      bridge.saveState(state).catch((error) => setDesktopError(error.message));
    }, 250);
    return () => clearTimeout(timer);
  }, [accounts, providers, settings, lastSync]);

  useEffect(() => { const timer = setInterval(() => setWidgetIndex((index) => (index + 1) % Math.max(accounts.length, 1)), 6000); return () => clearInterval(timer); }, [accounts.length]);
  useEffect(() => { const timer = setInterval(() => setTick((value) => value + 1), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (bridge && hydrated.current) bridge.setWidgetVisible(Boolean(settings.widget)).catch((error) => setDesktopError(error.message)); }, [settings.widget]);

  const currentWidgetAccount = accounts[widgetIndex % Math.max(accounts.length, 1)];
  const currentWidgetProvider = providers.find((item) => item.id === currentWidgetAccount?.providerId);
  const refreshAll = async () => {
    setRefreshing(true);
    setDesktopError('');
    try {
      if (bridge) {
        const state = await bridge.pollAll();
        setAccounts(state.accounts); setLastSync(state.lastSync);
        const failed = state.accounts.filter((account) => account.status === 'warning');
        if (failed.length) setDesktopError(`${failed.length} 个账号检查失败，请到“账号总览”查看原因`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500));
        setAccounts((old) => old.map((account) => ({ ...account, lastChecked: new Date().toISOString() })));
        setLastSync(new Date().toISOString());
      }
    } catch (error) { setDesktopError(error.message); }
    finally { setRefreshing(false); }
  };
  const testAccount = async (account) => {
    setTestingAccountId(account.id);
    setDesktopError('');
    try {
      if (bridge) {
        const result = await bridge.testAccount(account.id);
        setAccounts(result.state.accounts);
        setLastSync(result.state.lastSync);
        if (result.state.runtime) setRuntime(result.state.runtime);
        setTestResults((old) => ({ ...old, [account.id]: result }));
        if (!result.ok) setDesktopError(`${account.name}：${result.message}`);
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 450));
      const result = { ok: true, message: `成功读取 ${account.windows.length} 个额度窗口` };
      setTestResults((old) => ({ ...old, [account.id]: result }));
      return result;
    } catch (error) {
      setDesktopError(error.message);
      return { ok: false, message: error.message };
    } finally { setTestingAccountId(null); }
  };
  const saveAccount = async (draft) => {
    const id = `${draft.providerId}-${Date.now()}`;
    const account = { id, providerId: draft.providerId, name: draft.name, identity: draft.identity, tags: draft.tags, endpoint: draft.endpoint, variables: draft.variables || {}, windowKeys: draft.windowKeys, status: 'warning', lastChecked: new Date().toISOString(), lastError: '等待首次连接测试', windows: [] };
    const nextAccounts = [...accounts, account];
    if (bridge) {
      if (draft.credential || Object.keys(draft.secretVariables || {}).length) await bridge.saveCredential(id, draft.credential, draft.secretVariables || {});
      const state = serializableState({ accounts: nextAccounts });
      lastSaved.current = JSON.stringify(state);
      await bridge.saveState(state);
      setAccounts(nextAccounts);
      try {
        const result = await bridge.testAccount(id);
        setAccounts(result.state.accounts); setLastSync(result.state.lastSync);
        setTestResults((old) => ({ ...old, [id]: result }));
        if (!result.ok) setDesktopError(`${account.name}：${result.message}`);
      } catch (error) { setDesktopError(error.message); }
    } else setAccounts(nextAccounts);
    setModal(null);
  };
  const updateCredential = async ({ account, credential }) => {
    const nextAccounts = accounts;
    if (bridge) {
      await bridge.saveCredential(account.id, credential);
      const state = serializableState({ accounts: nextAccounts });
      lastSaved.current = JSON.stringify(state);
      await bridge.saveState(state);
      const result = await bridge.testAccount(account.id);
      setAccounts(result.state.accounts); setLastSync(result.state.lastSync);
      setTestResults((old) => ({ ...old, [account.id]: result }));
      if (!result.ok) setDesktopError(`${account.name}：${result.message}`);
    } else setAccounts(nextAccounts);
    setModal(null);
  };
  const updateAccount = async ({ account, name, identity, tags, endpoint, windowKeys, credential, variables, secretVariables }) => {
    const nextAccounts = accounts.map((item) => item.id === account.id ? { ...item, name, identity, tags, endpoint, variables: variables || {}, windowKeys } : item);
    if (bridge) {
      if (credential || Object.keys(secretVariables || {}).length) await bridge.saveCredential(account.id, credential, secretVariables || {});
      const state = serializableState({ accounts: nextAccounts });
      lastSaved.current = JSON.stringify(state);
      await bridge.saveState(state);
      const result = await bridge.testAccount(account.id);
      setAccounts(result.state.accounts); setLastSync(result.state.lastSync);
      setTestResults((old) => ({ ...old, [account.id]: result }));
      if (!result.ok) setDesktopError(`${name}：${result.message}`);
    } else setAccounts(nextAccounts);
    setModal(null);
  };
  const deleteAccount = async (account) => {
    if (!window.confirm(`删除账号“${account.name}”及其本地凭据？`)) return;
    const nextAccounts = accounts.filter((item) => item.id !== account.id);
    if (bridge) {
      await bridge.deleteCredential(account.id);
      const state = serializableState({ accounts: nextAccounts });
      lastSaved.current = JSON.stringify(state);
      await bridge.saveState(state);
    }
    setAccounts(nextAccounts);
  };
  const saveProvider = async (draft) => {
    const id = draft.id || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `provider-${Date.now()}`;
    const old = providers.find((item) => item.id === id);
    const provider = { ...old, id, name: draft.name, legalName: draft.name, monogram: draft.name.slice(0, 1).toUpperCase(), tone: old?.tone || 'slate', adapter: draft.adapter, logo: draft.logo, requestConfig: draft.requestConfig };
    delete provider.baseUrl;
    delete provider.domain;
    const nextProviders = old ? providers.map((item) => item.id === id ? provider : item) : [...providers, provider];
    setProviders(nextProviders);
    if (bridge) { const state = serializableState({ providers: nextProviders }); lastSaved.current = JSON.stringify(state); await bridge.saveState(state); }
    setModal(null);
  };
  const editProvider = (provider) => setModal({ type: 'provider-edit', provider });

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><img src="./quota-desk.svg" alt="" /></div><div><strong>Quota Desk</strong><small>coding plan monitor</small></div></div><div className="topbar-actions"><span className="sync-state"><i className={refreshing ? 'spinning' : ''} /><span>{refreshing ? '正在同步' : `已同步 ${formatChecked(lastSync)}`}</span></span><button aria-label="刷新额度" className={`toolbar-button ${refreshing ? 'loading' : ''}`} onClick={refreshAll} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'spinning' : ''} /> <span>刷新</span></button><button aria-label="打开设置" className="toolbar-button" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /><span>设置</span></button></div></header>
    <main className="main-shell"><div className="page-heading"><div><span className="eyebrow">今天，额度分配得刚刚好</span><h1>看清每一份额度<br /><em>再决定下一次调用</em></h1></div><div className="heading-note"><span className="tiny-badge">{accounts.length} 个账号</span><span>每 {settings.pollMinutes} 分钟自动检查</span></div></div>
      <div className="content-area">{desktopError && <div className="desktop-error"><AlertCircle size={15} /><span>{desktopError}</span><button onClick={() => setDesktopError('')} aria-label="关闭错误"><X size={14} /></button></div>}{accounts.length === 0 ? <section className="empty-workspace"><div className="empty-mark"><CircleGauge size={22} /></div><div><span className="eyebrow">从一个账号开始</span><h2>把第一份 Coding Plan 接进来</h2><p>凭据将由 Windows 加密保存，额度请求只在本机发出。</p></div><button className="primary-button" onClick={() => setModal('account')}><Plus size={15} /> 添加账号</button></section> : <StatusView accounts={accounts} providers={providers} reminderRules={settings.alerts === false ? [] : settings.reminderRules} mode={overviewMode} onModeChange={setOverviewMode} runtime={runtime} onTestAccount={testAccount} testingAccountId={testingAccountId} testResults={testResults} />}</div>
    </main>
    <footer className="footer-bar"><span><i className={`online-dot ${runtime?.running ? '' : 'offline'}`} /> {bridge ? (runtime?.running ? '后台轮询运行中' : '后台轮询未启动') : '界面预览模式'}</span><span>最后检查：{formatChecked(lastSync)}{tick < 0 ? '' : ''}</span><button className="footer-link" onClick={refreshAll}><RefreshCw size={12} />立即测试</button></footer>
    {settingsOpen && <SettingsDrawer accounts={accounts} providers={providers} settings={settings} setSettings={setSettings} onClose={() => setSettingsOpen(false)} openModal={setModal} onDeleteAccount={deleteAccount} onTestAccount={testAccount} testingAccountId={testingAccountId} onEditProvider={editProvider} />}
    {settings.widgetPreview && <WidgetPreview account={currentWidgetAccount} provider={currentWidgetProvider} tagLimit={Number(settings.widgetTagLimit ?? 2)} onClose={() => setSettings((old) => ({ ...old, widgetPreview: false }))} />}
    {modal === 'account' && <AccountModalV2 providers={providers} onClose={() => setModal(null)} onSave={saveAccount} />}
    {modal?.type === 'account-edit' && <AccountEditModalV2 account={modal.account} provider={providers.find((item) => item.id === modal.account.providerId)} onClose={() => setModal(null)} onSave={updateAccount} />}
    {modal?.type === 'credential' && <CredentialModalV2 account={modal.account} provider={providers.find((item) => item.id === modal.account.providerId)} onClose={() => setModal(null)} onSave={updateCredential} />}
    {modal === 'provider' && <ProviderModalV2 onClose={() => setModal(null)} onSave={saveProvider} />}
    {modal?.type === 'provider-edit' && <ProviderModalV2 provider={modal.provider} onClose={() => setModal(null)} onSave={saveProvider} />}
  </div>;
}

export default App;

const widgetMode = new URLSearchParams(window.location.search).get('widget') === '1';
createRoot(document.getElementById('root')).render(widgetMode ? <WidgetApp /> : <App />);
