import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, ArrowLeft, ArrowUpRight, ChevronDown, ChevronRight, CircleGauge, Clock3, KeyRound, LockKeyhole, Moon, RefreshCw, Rows3, ShieldCheck, Sun, WifiOff } from 'lucide-react';
import { initialAccounts, providerCatalog, windowCatalog } from './data';
import { ConcentricRings, durationOrder } from './quota-rings';
import './styles.css';
import './remote.css';

const TOKEN_KEY = 'quota-desk-remote-token-v1';
const THEME_KEY = 'quota-desk-remote-theme-v1';
const providerMap = new Map(providerCatalog.map((provider) => [provider.id, provider]));
const validDate = (value) => value && Number.isFinite(Date.parse(value));
const timeLabel = (value) => validDate(value) ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未检查';
const minutesSince = (value) => validDate(value) ? Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000)) : Infinity;
const relativeChecked = (value) => {
  const minutes = minutesSince(value);
  if (!Number.isFinite(minutes)) return '尚未检查';
  if (minutes < 1) return '刚刚检查';
  if (minutes < 60) return `${minutes} 分钟前检查`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前检查`;
  return `${Math.floor(minutes / 1440)} 天前检查`;
};
const resetLabel = (value) => {
  if (!validDate(value)) return '无固定重置';
  const minutes = Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 60_000));
  if (minutes === 0) return '即将重置';
  if (minutes < 60) return `${minutes} 分钟后重置`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后重置`;
  return `${Math.floor(minutes / 1440)} 天后重置`;
};
const clamp = (number, min, max) => Math.min(max, Math.max(min, Number(number) || 0));
const amountLabel = (meter) => {
  if (meter.key === 'balance' || meter.unit !== '%') {
    const value = Number(meter.amount ?? meter.remaining);
    const unit = meter.unit === 'CNY' || meter.unit === '¥' ? '¥' : (meter.unit || '');
    return `${unit}${Number.isFinite(value) ? value.toFixed(2) : '—'}`;
  }
  return `${Math.round(Number(meter.remaining) || 0)}%`;
};
const detailLabel = (meter) => {
  const amount = Number(meter.amount);
  const limit = Number(meter.limitAmount);
  if (meter.unit !== '%' || !Number.isFinite(amount) || !Number.isFinite(limit) || limit <= 0 || limit === 100) return '';
  return `剩余 ${amount.toLocaleString()} / ${limit.toLocaleString()}`;
};
const trendLabel = (meter) => windowCatalog[meter.key]?.label || meter.key;

function initialToken() {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('access');
  if (fromLink) {
    localStorage.setItem(TOKEN_KEY, fromLink);
    history.replaceState(null, '', location.pathname + location.search);
    return fromLink;
  }
  return localStorage.getItem(TOKEN_KEY) || (import.meta.env.DEV ? 'demo' : '');
}

async function requestJson(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (response.status === 401) throw Object.assign(new Error('配对密钥已失效，请从电脑重新配对'), { unauthorized: true });
  if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
  return response.json();
}

const demoSnapshot = {
  lastSync: new Date().toISOString(),
  pollMinutes: 5,
  providers: providerCatalog,
  accounts: initialAccounts.map((account) => ({ ...account, provider: providerMap.get(account.providerId)?.name || account.providerId })),
};
const demoHistory = (account, days) => {
  const count = days === 1 ? 36 : 76;
  return { points: Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1);
    return {
      at: new Date(Date.now() - (1 - progress) * (days || 30) * 86_400_000).toISOString(),
      windows: Object.fromEntries(account.windows.map((meter) => [meter.key, {
        remaining: clamp((Number(meter.remaining) || 50) + Math.sin(index * .28) * 13 + Math.cos(index * .11) * 8 + (1 - progress) * 14, 3, 100),
        amount: meter.amount ?? null, unit: meter.unit,
      }])),
    };
  }) };
};

function ProviderMark({ id, name, providerInfo }) {
  const provider = providerInfo || providerMap.get(id);
  const [failed, setFailed] = useState(false);
  return <span className={`provider-logo ${provider?.tone || 'slate'} md`} aria-label={name}>
    {provider?.logo && !failed ? <img src={provider.logo} alt="" onError={() => setFailed(true)} /> : provider?.monogram || String(name || '?').slice(0, 1).toUpperCase()}
  </span>;
}

function RemoteIdentity({ account, providerInfo }) {
  return <div className="account-identity"><ProviderMark id={account.providerId} name={account.provider} providerInfo={providerInfo} /><div className="account-copy"><div className="account-title-line"><strong title={account.name}>{account.name}</strong>{account.tags?.slice(0, 2).map((tag) => <span className="tag-pill" key={tag}>{tag}</span>)}</div><span title={account.identity ? `${account.provider} · ${account.identity}` : account.provider}>{account.identity ? `${account.provider} · ${account.identity}` : account.provider}</span></div></div>;
}

function Pairing({ onConnect, message }) {
  const [input, setInput] = useState('');
  return <main className="remote-pair-page">
    <div className="remote-pair-card">
      <div className="remote-pair-icon"><LockKeyhole size={28} strokeWidth={1.7} /></div>
      <div className="remote-eyebrow">QUOTA DESK · 只读连接</div>
      <h1>在这里查看你的额度</h1>
      <p>在电脑端开启「远程查看」，用手机扫描配对二维码；另一台电脑可复制配对链接打开。</p>
      <form onSubmit={(event) => { event.preventDefault(); if (input.trim()) onConnect(input.trim()); }}>
        <label htmlFor="pair-token">已有配对密钥</label>
        <div className="remote-pair-input"><KeyRound size={18} /><input id="pair-token" value={input} onChange={(event) => setInput(event.target.value)} placeholder="粘贴电脑端显示的密钥" autoComplete="off" spellCheck="false" /></div>
        {message && <div className="remote-inline-error" role="alert"><AlertCircle size={16} />{message}</div>}
        <button type="submit" className="remote-primary-button" disabled={!input.trim()}>连接电脑 <ArrowUpRight size={17} /></button>
      </form>
      <div className="remote-pair-foot"><ShieldCheck size={16} />额度由电脑采集；此页面只能查看数据</div>
    </div>
  </main>;
}

function AccountCard({ account, providerInfo, stale, onHistory }) {
  const status = account.disabled ? '已停用' : account.status === 'warning' ? '检查失败' : stale ? '数据较旧' : '正常';
  const desc = [...(account.windows || [])].sort((a, b) => (durationOrder[b.key] || 9) - (durationOrder[a.key] || 9)).slice(0, 4);
  return <article className={`overview-card remote-account-card clickable ${account.status || ''} ${account.disabled ? 'disabled' : ''}`} role="button" tabIndex={0} title="点击查看额度趋势" onClick={() => onHistory(account)} onKeyDown={(event) => { if (event.key === 'Enter') onHistory(account); }}>
    <div className="overview-head">
      <RemoteIdentity account={account} providerInfo={providerInfo} />
      <span className={`card-status-icon ${account.status === 'warning' || stale ? 'warning' : ''}`} title={status}>{account.status === 'warning' || stale ? <AlertCircle size={14} /> : <ShieldCheck size={14} />}</span>
    </div>
    <div className="overview-body">
      <ConcentricRings account={account} formatAmount={amountLabel} formatReset={resetLabel} />
      <div className="overview-meters">{[...desc].reverse().map((meter) => {
        const detail = `${resetLabel(meter.resetAt)}${detailLabel(meter) ? ` · ${detailLabel(meter)}` : ''}`;
        return <div className="overview-meter" key={meter.key}><span><i className={`ring-dot ring-dot-${desc.indexOf(meter)}`} />{trendLabel(meter)}</span><b>{meter.available === false ? '不可用' : amountLabel(meter)}</b><small title={detail}>{detail}</small></div>;
      })}</div>
    </div>
    <div className="remote-card-foot"><span><Clock3 size={13} />{relativeChecked(account.lastChecked)}</span><button type="button" onClick={(event) => { event.stopPropagation(); onHistory(account); }} aria-label={`查看 ${account.name} 的额度历史`}>查看历史 <ChevronRight size={15} /></button></div>
  </article>;
}

function RemoteMeterBar({ meter }) {
  const detail = detailLabel(meter);
  return <div className={`meter-line ${meter.available === false ? 'unavailable' : ''}`}>
    <div className="meter-line-head"><span className="meter-name">{trendLabel(meter)}</span><span className="meter-reading">{meter.available === false ? '不可用' : amountLabel(meter)}{detail && <small title={detail}>{detail}</small>}</span></div>
    <div className="meter-track" role="progressbar" aria-valuenow={clamp(meter.remaining, 0, 100)} aria-valuemin="0" aria-valuemax="100"><span className="meter-fill" style={{ width: `${clamp(meter.remaining, 0, 100)}%` }} /></div>
    <div className="meter-line-foot"><span className="meter-state">{meter.available === false ? '不可用' : meter.key === 'balance' ? '可用余额' : '剩余额度'}</span><span className="reset-meta"><Clock3 size={12} />{resetLabel(meter.resetAt)}</span></div>
  </div>;
}

function RowsView({ accounts, providerInfo, onHistory }) {
  const sorted = [...accounts].sort((a, b) => Math.min(...a.windows.map((meter) => meter.resetAt ? Date.parse(meter.resetAt) : Infinity)) - Math.min(...b.windows.map((meter) => meter.resetAt ? Date.parse(meter.resetAt) : Infinity)));
  return <section className="surface-section windows-section remote-rows"><div className="windows-column-head"><span>账号</span><span>剩余进度</span><span>状态</span></div><div className="windows-list">{sorted.map((account) => <div className="account-window-row clickable" key={account.id} role="button" tabIndex={0} title="点击查看额度趋势" onClick={() => onHistory(account)} onKeyDown={(event) => { if (event.key === 'Enter') onHistory(account); }}><div className="account-side"><RemoteIdentity account={account} providerInfo={providerInfo[account.providerId]} /><div className={`account-status ${account.status}`}><span className="status-dot" />{account.status === 'warning' ? '需处理' : '正常'}<small>{relativeChecked(account.lastChecked)}</small></div></div><div className="account-meters">{account.windows?.map((meter) => <RemoteMeterBar key={meter.key} meter={meter} />)}</div></div>)}</div></section>;
}

function PeriodsView({ accounts, providerInfo, onHistory }) {
  const [collapsed, setCollapsed] = useState({});
  const grouped = new Map();
  for (const account of accounts) for (const meter of account.windows || []) {
    if (!grouped.has(meter.key)) grouped.set(meter.key, []);
    grouped.get(meter.key).push({ account, meter });
  }
  const nextResets = [...grouped.values()].flat().filter(({ meter }) => meter.resetAt && Date.parse(meter.resetAt) > Date.now()).sort((a, b) => Date.parse(a.meter.resetAt) - Date.parse(b.meter.resetAt)).slice(0, 8);
  return <div className="view-stack remote-periods">
    <section className="surface-section timeline-section"><div className="section-heading"><div><h2>重置时间轴</h2></div><span className="section-count">{nextResets.length} 个近期重置点</span></div><div className="remote-reset-strip">{nextResets.length ? nextResets.map(({ account, meter }) => <button key={`${account.id}-${meter.key}`} onClick={() => onHistory(account)}><i className={providerInfo[account.providerId]?.tone || 'slate'} /><span><b>{account.name}</b><small>{trendLabel(meter)} · {resetLabel(meter.resetAt)}</small></span></button>) : <span>暂无重置时间</span>}</div></section>
    {[...grouped.entries()].sort(([a], [b]) => (durationOrder[a] || 9) - (durationOrder[b] || 9)).map(([key, rows]) => <section className="surface-section" key={key}><div className="section-heading"><div><h2>{trendLabel({ key })}</h2></div><span className="section-count">{rows.length} 个账号</span><button type="button" className="icon-button faint section-toggle" title={collapsed[key] ? '展开' : '收起'} onClick={() => setCollapsed((old) => ({ ...old, [key]: !old[key] }))}>{collapsed[key] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button></div>{!collapsed[key] && <div className="priority-list">{rows.sort((a, b) => Date.parse(a.meter.resetAt || 8640000000000000) - Date.parse(b.meter.resetAt || 8640000000000000)).map(({ account, meter }) => <div className="priority-row clickable" key={`${account.id}-${key}`} role="button" tabIndex={0} onClick={() => onHistory(account)} onKeyDown={(event) => { if (event.key === 'Enter') onHistory(account); }}><RemoteIdentity account={account} providerInfo={providerInfo[account.providerId]} /><div className="priority-meter"><div className="meter-track"><span className="meter-fill" style={{ width: `${clamp(meter.remaining, 0, 100)}%` }} /></div><b>{amountLabel(meter)}</b></div><div className="priority-reset"><Clock3 size={13} /><span>{resetLabel(meter.resetAt)}</span></div></div>)}</div>}</section>)}
  </div>;
}

const trendColors = { five_hour: 'var(--cyan)', daily: 'var(--sky)', weekly: 'var(--violet)', monthly: 'var(--coral)', balance: 'var(--green)', gemini_pro: 'var(--sky)', gemini_flash: 'var(--cyan)', gemini_flash_lite: 'var(--green-deep)' };
const trendColor = (key, index) => trendColors[key] || ['var(--cyan)', 'var(--violet)', 'var(--coral)', 'var(--green)'][index % 4];
const sampleValue = (sample) => sample?.unit === '%' ? Number(sample.remaining) : Number(sample?.amount ?? sample?.remaining);

function TrendChart({ points, keys, hiddenKeys, days, onDaysChange }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const filteredKeys = keys.filter((key) => !hiddenKeys.includes(key));
  const shownKeys = filteredKeys.length ? filteredKeys : keys;
  const values = points.flatMap((point) => shownKeys.map((key) => point.windows?.[key]).filter(Boolean).map(sampleValue)).filter(Number.isFinite);
  if (!points.length || !values.length) return <div className="settings-empty chart-empty">暂无历史数据，每次成功刷新额度后都会记录一条</div>;
  const percentOnly = shownKeys.every((key) => points.every((point) => !point.windows?.[key] || point.windows[key].unit === '%'));
  const width = 470; const height = 184; const left = 36; const right = 12; const top = 14; const bottom = 24;
  const firstAt = Date.parse(points[0].at); const lastAt = Date.parse(points.at(-1).at);
  const start = Number.isFinite(firstAt) ? firstAt : 0; const span = Math.max(1, lastAt - start);
  const gaps = points.slice(1).map((point, index) => Date.parse(point.at) - Date.parse(points[index].at)).filter((gap) => gap > 0).sort((a, b) => a - b);
  const breakGap = Math.max(10 * 60_000, (gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)] : 5 * 60_000) * 2);
  const low = Math.min(...values); const high = Math.max(...values);
  const pad = Math.max((high - low) * .15, percentOnly ? 5 : 1);
  const yMin = percentOnly ? Math.max(0, low - pad) : low - pad;
  const yMax = percentOnly ? Math.min(100, high + pad) : high + pad;
  const x = (at) => left + ((Date.parse(at) - start) / span) * (width - left - right);
  const y = (value) => top + (1 - (value - yMin) / Math.max(1, yMax - yMin)) * (height - top - bottom);
  const hover = hoverIndex == null ? null : points[hoverIndex];
  const moveHover = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    let nearest = 0; let distance = Infinity;
    points.forEach((point, index) => { const delta = Math.abs(x(point.at) - px); if (delta < distance) { distance = delta; nearest = index; } });
    setHoverIndex(nearest);
  };
  return <div className="usage-chart remote-usage-chart">
    <div className="chart-detail"><div className="chart-detail-main">{hover ? <><b>{timeLabel(hover.at)}</b>{shownKeys.map((key, index) => { const sample = hover.windows?.[key]; return sample ? <span className="chart-detail-item" key={key}><i style={{ background: trendColor(key, index) }} />{windowCatalog[key]?.short || trendLabel({ key })}<b>{sample.unit === '%' ? `${Math.round(sampleValue(sample))}%` : `${sampleValue(sample).toFixed(2)} ${sample.unit || ''}`}</b></span> : null; })}</> : <span className="chart-detail-hint">悬停或触摸查看该点的数值</span>}</div><div className="range-control" role="group" aria-label="趋势时间范围">{[[0, '全部'], [1, '1天'], [7, '7天'], [30, '1个月']].map(([value, label]) => <button type="button" key={value} className={days === value ? 'active' : ''} onClick={() => onDaysChange(value)}>{label}</button>)}</div></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="各额度窗口历史趋势" onPointerMove={moveHover} onPointerLeave={() => setHoverIndex(null)}>
      {[0, 1, 2, 3].map((index) => { const value = yMin + (yMax - yMin) * index / 3; return <g key={index}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="chart-grid" /><text x={left - 6} y={y(value) + 3} className="chart-y-label">{percentOnly ? `${Math.round(value)}%` : value.toFixed(1)}</text></g>; })}
      {[0, 1, 2, 3, 4].map((index) => { const at = start + span * index / 4; const date = new Date(at); return <text key={index} x={left + (width - left - right) * index / 4} y={height - 7} className="chart-x-label">{days <= 1 && days !== 0 ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : `${date.getMonth() + 1}/${date.getDate()}`}</text>; })}
      {shownKeys.map((key, index) => {
        const segments = []; let line = '';
        for (let pointIndex = 0; pointIndex < points.length; pointIndex++) { const point = points[pointIndex]; const sample = point.windows?.[key]; const value = sample && sampleValue(sample); const gap = pointIndex > 0 ? Date.parse(point.at) - Date.parse(points[pointIndex - 1].at) : 0; if (!Number.isFinite(value) || gap > breakGap) { if (line) segments.push(line); line = ''; if (!Number.isFinite(value)) continue; } line += `${line ? ' L' : ' M'}${x(point.at).toFixed(1)},${y(value).toFixed(1)}`; }
        if (line) segments.push(line);
        return segments.map((segment, segmentIndex) => <path key={`${key}-${segmentIndex}`} d={segment} fill="none" stroke={trendColor(key, index)} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />);
      })}
      {points.length <= 40 && shownKeys.map((key, index) => points.map((point) => { const sample = point.windows?.[key]; const value = sample && sampleValue(sample); return Number.isFinite(value) ? <circle key={`${key}-${point.at}`} cx={x(point.at)} cy={y(value)} r={points.length === 1 ? 3 : 2} fill={trendColor(key, index)} /> : null; }))}
      {hover && <line x1={x(hover.at)} x2={x(hover.at)} y1={top} y2={height - bottom} className="chart-cursor" />}
    </svg>
  </div>;
}

function HistoryPanel({ account, token, onClose, providerInfo }) {
  const [days, setDays] = useState(7);
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hiddenKeys, setHiddenKeys] = useState([]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const load = import.meta.env.DEV && token === 'demo'
      ? Promise.resolve(demoHistory(account, days))
      : requestJson(`/api/history?accountId=${encodeURIComponent(account.id)}&days=${days}`, token);
    load.then((data) => { if (active) setPoints(data.points || []); })
      .catch((reason) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account.id, days, token]);
  const keys = [...new Set(points.flatMap((point) => Object.keys(point.windows || {})))].sort((a, b) => (durationOrder[a] || 9) - (durationOrder[b] || 9));
  const toggleKey = (key) => setHiddenKeys((old) => old.includes(key) ? old.filter((item) => item !== key) : keys.length - old.length > 1 ? [...old, key] : old);
  return <div className="view-stack history-view remote-history-view"><section className="surface-section"><div className="history-head"><RemoteIdentity account={account} providerInfo={providerInfo} /><span className="remote-history-label">额度历史 · 只读</span><button type="button" className="back-button" onClick={onClose} title="返回" aria-label="返回"><ArrowLeft size={15} /></button></div><div className="trend-view">{loading ? <div className="settings-empty chart-empty">正在读取历史记录…</div> : error ? <div className="settings-empty chart-empty">{error}</div> : <TrendChart points={points} keys={keys} hiddenKeys={hiddenKeys} days={days} onDaysChange={(value) => { setHiddenKeys([]); setDays(value); }} />}{keys.length > 0 && <div className="chart-legend">{keys.map((key, index) => { const latest = [...points].reverse().find((point) => point.windows?.[key])?.windows[key]; return <button type="button" key={key} className={hiddenKeys.includes(key) ? 'off' : ''} onClick={() => toggleKey(key)} title={hiddenKeys.includes(key) ? '点击显示该折线' : '点击隐藏该折线'}><i style={{ background: trendColor(key, index) }} />{trendLabel({ key })}{latest && <em>{latest.unit === '%' ? `${Math.round(sampleValue(latest))}%` : `${sampleValue(latest).toFixed(2)} ${latest.unit || ''}`}</em>}</button>; })}<span className="legend-right">{points.length} 条记录</span></div>}</div></section><div className="history-foot"><button type="button" className="outline-button" onClick={onClose}><ArrowLeft size={14} />返回</button></div></div>;
}

function App() {
  const [token, setToken] = useState(initialToken);
  const [pairError, setPairError] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [connectionError, setConnectionError] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [mode, setMode] = useState('rings');
  const [disabledOpen, setDisabledOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark');
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); }, [theme]);
  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    const load = async () => {
      try {
        const data = import.meta.env.DEV && token === 'demo' ? demoSnapshot : await requestJson('/api/snapshot', token);
        if (!active) return;
        setSnapshot(data); setConnectionError(''); setPairError(''); setNow(Date.now());
      } catch (error) {
        if (!active) return;
        if (error.unauthorized) { localStorage.removeItem(TOKEN_KEY); setToken(''); setSnapshot(null); setPairError(error.message); }
        else setConnectionError('无法连接电脑，请检查电脑是否开机、Quota Desk 与 Tailscale 是否运行');
      } finally { if (active) setLoading(false); }
    };
    load();
    const timer = setInterval(load, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [token]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const connect = (value) => { localStorage.setItem(TOKEN_KEY, value); setPairError(''); setLoading(true); setToken(value); };
  const accounts = snapshot?.accounts || [];
  const staleAfter = Math.max(15, (Number(snapshot?.pollMinutes) || 5) * 2 + 5);
  const providerInfo = useMemo(() => Object.fromEntries((snapshot?.providers || []).map((provider) => [provider.id, provider])), [snapshot?.providers]);
  const activeAccounts = accounts.filter((account) => !account.disabled);
  const disabledAccounts = accounts.filter((account) => account.disabled);
  const attentionCount = accounts.filter((account) => !account.disabled && (account.status === 'warning' || minutesSince(account.lastChecked) > staleAfter || account.windows?.some((meter) => meter.available === false || (meter.unit === '%' && Number(meter.remaining) <= 20)))).length;
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  if (!token) return <Pairing onConnect={connect} message={pairError} />;
  return <div className="remote-app remote-shell">
    <header className="titlebar remote-titlebar"><span className="titlebar-drag"><img src="/quota-desk.svg" alt="" /><b>Quota Desk</b></span><div className="titlebar-controls"><span className="last-checked" title="最后一次额度检查时间"><Clock3 size={11} />{timeLabel(snapshot?.lastSync)}</span><button type="button" className="control-solo" onClick={() => location.reload()} title="重新读取电脑数据" aria-label="重新读取电脑数据"><RefreshCw size={13} /></button><div className="overview-controls" aria-label="额度展示方式">{[['rings', '账号总览', CircleGauge], ['rows', '行式明细', Rows3], ['periods', '周期明细', Clock3]].map(([key, label, Icon]) => <button key={key} className={mode === key && !selectedAccountId ? 'active' : ''} onClick={() => { setSelectedAccountId(null); setMode(key); }} title={label} aria-label={label}><Icon size={13} /></button>)}</div><button type="button" className="remote-title-theme" onClick={() => setTheme((old) => old === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? '切换亮色主题' : '切换暗色主题'}>{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</button></div></header>
    <main className="remote-main">
      {connectionError && <div className="remote-banner offline" role="status"><WifiOff size={19} /><span>{connectionError}{snapshot ? '，下方保留本次打开期间的旧数据。' : '。'}</span></div>}
      {loading && !snapshot ? <div className="remote-loading"><RefreshCw size={24} className="spinning" /><span>正在读取电脑上的额度</span></div> : snapshot ? <>
        {selectedAccount ? <HistoryPanel key={selectedAccount.id} account={selectedAccount} token={token} providerInfo={providerInfo[selectedAccount.providerId]} onClose={() => setSelectedAccountId(null)} /> : <>
          <div className="view-intro overview-title remote-view-title"><h1>{mode === 'rings' ? '账号总览' : mode === 'rows' ? '行式明细' : '周期明细'}</h1><span className="health-summary">{attentionCount ? `${attentionCount} 个账号需关注` : `${activeAccounts.length} 个账号状态良好`} · 只读</span></div>
          {mode === 'rings' && <div className="view-stack"><section className="overview-grid remote-card-grid">{activeAccounts.map((account) => <AccountCard key={account.id} account={account} providerInfo={providerInfo[account.providerId]} stale={minutesSince(account.lastChecked) > staleAfter} onHistory={(item) => setSelectedAccountId(item.id)} />)}</section>{disabledAccounts.length > 0 && <><button type="button" className="disabled-fold" onClick={() => setDisabledOpen((old) => !old)}>{disabledAccounts.length} 个账号已停用，点击{disabledOpen ? '收起' : '展开查看'}{disabledOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>{disabledOpen && <div className="overview-grid remote-card-grid disabled-grid">{disabledAccounts.map((account) => <AccountCard key={account.id} account={account} providerInfo={providerInfo[account.providerId]} stale={false} onHistory={(item) => setSelectedAccountId(item.id)} />)}</div>}</>}</div>}
          {mode === 'rows' && <RowsView accounts={activeAccounts} providerInfo={providerInfo} onHistory={(item) => setSelectedAccountId(item.id)} />}
          {mode === 'periods' && <PeriodsView accounts={activeAccounts} providerInfo={providerInfo} onHistory={(item) => setSelectedAccountId(item.id)} />}
        </>}
      </> : !loading && <div className="remote-empty"><WifiOff size={24} /><strong>暂时无法读取额度</strong><span>请确认主设备正在运行 Quota Desk</span></div>}
    </main>
  </div>;
}

createRoot(document.getElementById('remote-root')).render(<App />);
