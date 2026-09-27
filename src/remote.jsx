import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, ArrowLeft, ArrowUpRight, Bot, ChevronDown, ChevronRight, CircleGauge, Clock3, Flame, History, KeyRound, LockKeyhole, Moon, RefreshCw, Rows3, ShieldCheck, Sun, TrendingUp, Trophy, WifiOff, Zap } from 'lucide-react';
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
  accounts: initialAccounts.map((account) => ({
    ...account,
    provider: providerMap.get(account.providerId)?.name || account.providerId,
    usageSupported: ['deepseek', 'zai', 'codex', 'minimax'].includes(account.providerId),
    usageStatus: account.providerId === 'zai' ? 'connected' : 'disconnected',
    wasteWindows: (account.windows || []).map((window) => window.key).filter((key) => ['weekly', 'monthly'].includes(key)),
  })),
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
const demoUsage = (account) => {
  const today = new Date();
  const days = Array.from({ length: 365 }, (_, index) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (364 - index))).toISOString().slice(0, 10);
    const tokens = Math.round((8 + (Math.sin(index * .17) + 1) * 13 + (Math.cos(index * .037) + 1) * 10) * 1_000_000);
    return { date, cost: Number((tokens / 1_000_000 * .72).toFixed(2)), tokens, requests: Math.round(tokens / 7200), currency: '¥' };
  });
  return {
    provider: account.providerId, metric: 'cost', currency: '¥',
    summary: { totalCost: days.reduce((sum, day) => sum + day.cost, 0), totalTokens: days.reduce((sum, day) => sum + day.tokens, 0), peakDailyCost: Math.max(...days.map((day) => day.cost)), peakDailyTokens: Math.max(...days.map((day) => day.tokens)), currentStreakDays: 4, longestStreakDays: 27 },
    coverage: { timezoneOffsetSec: 8 * 60 * 60, cost: { complete: true }, tokens: { complete: true } }, days,
  };
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
const shortNumber = (value) => value != null && Number.isFinite(Number(value)) ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value)) : '—';
const wasteDay = (value) => { const date = new Date(value); return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`; };
const wasteStart = (end, key) => { const date = new Date(end); if (key === 'monthly') date.setMonth(date.getMonth() - 1); else date.setDate(date.getDate() - 7); return date.toISOString(); };

function RemoteWasteView({ account, token }) {
  const windows = account.wasteWindows || [];
  const [curWindow, setCurWindow] = useState(windows[0] || 'weekly');
  const [cycles, setCycles] = useState(null);
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    let active = true;
    requestJson(`/api/cycles?accountId=${encodeURIComponent(account.id)}`, token)
      .then((result) => { if (active) setCycles(result.cycles || []); })
      .catch(() => { if (active) setCycles([]); });
    return () => { active = false; };
  }, [account.id, token]);
  useEffect(() => { if (!windows.includes(curWindow) && windows.length) setCurWindow(windows[0]); }, [windows, curWindow]);
  const windowCycles = (cycles || []).filter((cycle) => cycle.window === curWindow).sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
  const meter = account.windows?.find((item) => item.key === curWindow);
  const nowCycle = meter?.resetAt && Date.parse(meter.resetAt) > Date.now() && !account.disabled
    ? { now: true, remaining: clamp(meter.remaining, 0, 100), from: wasteStart(meter.resetAt, curWindow), end: meter.resetAt }
    : null;
  const shown = [...windowCycles, ...(nowCycle ? [nowCycle] : [])];
  const reliable = windowCycles.filter((cycle) => cycle.reliable && cycle.kind === 'natural');
  const average = reliable.length ? reliable.reduce((sum, cycle) => sum + Number(cycle.remaining || 0), 0) / reliable.length : null;
  const total = reliable.reduce((sum, cycle) => sum + Number(cycle.remaining || 0), 0) / 100;
  const detail = selected && (selected.now
    ? `${wasteDay(selected.from)} → ${wasteDay(selected.end)}（进行中） · 剩余 ${Math.round(selected.remaining)}% · ${resetLabel(selected.end)} 后重置`
    : `${wasteDay(selected.from)} → ${wasteDay(selected.end)} · ${selected.kind === 'early' ? '提前重置' : selected.reliable ? `浪费 ${Math.round(selected.remaining)}%` : `浪费 ≤${Math.round(selected.remaining)}%（可能失真）`} · 记录于 ${timeLabel(selected.observedAt)}`);
  const softColor = curWindow === 'monthly' ? 'var(--coral)' : 'var(--violet)';
  return <div className="waste-view remote-waste-view">
    <div className="waste-row">{windows.length >= 2 ? <div className="seg-control">{windows.map((key) => <button type="button" key={key} className={key === curWindow ? 'active' : ''} onClick={() => { setCurWindow(key); setSelected(null); }}>{trendLabel({ key })} 额度</button>)}</div> : <span className="waste-label">{trendLabel({ key: curWindow })} 额度 · 浪费统计</span>}<span className="waste-stats"><span>{windowCycles.length} 个周期</span><span>平均浪费 <b>{average == null ? '—' : `${average.toFixed(0)}%`}</b>（{reliable.length} 可靠）</span><span>累计 <b>{reliable.length ? `${Math.round(total * 100) / 100}` : '—'}</b> 倍额度</span></span></div>
    <div className="chart-detail waste-detail">{detail || <span className="chart-detail-hint">选择柱状图查看周期详情</span>}</div>
    <div className="waste-scroll"><div className={`waste-plot ${curWindow === 'monthly' ? 'mo' : 'wk'}`}>
      {[25, 50, 75].map((value) => <div key={value} className="waste-gridline" style={{ bottom: `${value}%` }} />)}
      {average != null && <div className="waste-avg" style={{ bottom: `${Math.min(100, average)}%` }}><em>平均 {average.toFixed(0)}%</em></div>}
      {!shown.length && <div className="waste-empty-hint"><span>{cycles === null ? '正在读取周期历史…' : '还没有已完成的周期'}</span><span>第一个周期重置后自动生成统计</span></div>}
      {shown.map((cycle, index) => <button type="button" key={cycle.now ? 'now' : `${cycle.end}-${index}`} className={`waste-col ${cycle.now ? 'now' : cycle.kind === 'early' ? 'early' : !cycle.reliable ? 'bad' : ''} ${selected === cycle ? 'hot' : ''}`} title={`${wasteDay(cycle.from || wasteStart(cycle.end, curWindow))} → ${wasteDay(cycle.end)}`} onClick={() => setSelected(cycle)}><span className="waste-bar" style={{ height: `${Math.max(2, clamp(cycle.remaining, 0, 100))}%` }} /></button>)}
    </div><div className={`waste-x-labels ${curWindow === 'monthly' ? 'mo' : 'wk'}`}>{shown.map((cycle, index) => <span key={cycle.now ? 'now' : `${cycle.end}-${index}`} className="waste-x-cell">{shown.length <= 6 || index % Math.ceil(shown.length / 12) === 0 ? `${wasteDay(cycle.from || wasteStart(cycle.end, curWindow))}→${wasteDay(cycle.end)}` : ''}</span>)}</div></div>
    <div className="chart-legend waste-legend"><span><i style={{ background: softColor }} />浪费率</span><span><i style={{ background: `repeating-linear-gradient(-45deg, color-mix(in srgb, ${softColor} 30%, transparent) 0 3px, transparent 3px 6px)` }} />可能失真</span><span><i className="swatch-early" />提前重置</span><span><i className="swatch-now" />进行中</span><span className="legend-right">{windowCycles.length - reliable.length} 个周期不计入平均</span></div>
  </div>;
}

function RemoteUsageView({ account, token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(account.usageStatus === 'connected');
  const [selectedDate, setSelectedDate] = useState('');
  const heatmapRef = useRef(null);
  const [cellPx, setCellPx] = useState(8);
  useEffect(() => {
    if (account.usageStatus !== 'connected') { setLoading(false); return undefined; }
    let active = true;
    setLoading(true); setError('');
    (import.meta.env.DEV && token === 'demo' ? Promise.resolve(demoUsage(account)) : requestJson(`/api/usage?accountId=${encodeURIComponent(account.id)}`, token))
      .then((result) => { if (active) { setData(result); setSelectedDate((old) => result.days?.some((day) => day.date === old) ? old : result.days?.at(-1)?.date || ''); } })
      .catch((reason) => { if (active) setError(reason.message === '读取失败（HTTP 409）' ? '请先在桌面端连接该厂商的官方用量' : reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account.id, account.usageStatus, token]);
  const days = [...(data?.days || [])].filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date)).sort((a, b) => a.date.localeCompare(b.date));
  const first = days[0]?.date?.split('-').map(Number) || [];
  const leading = first.length === 3 ? (new Date(Date.UTC(first[0], first[1] - 1, first[2])).getUTCDay() + 6) % 7 : 0;
  const cells = [...Array(leading).fill(null), ...days];
  const weekCount = Math.max(1, Math.ceil(cells.length / 7));
  const monthMarkers = [];
  let previousMonth = '';
  cells.forEach((day, index) => { if (!day) return; const month = day.date.slice(0, 7); if (month === previousMonth) return; previousMonth = month; monthMarkers.push({ key: month, label: `${Number(month.slice(5))}月`, column: Math.floor(index / 7) + 1 }); });
  const shownMonthMarkers = cellPx < 6 ? monthMarkers.filter((_item, index) => index % 2 === 0 || index === monthMarkers.length - 1) : monthMarkers;
  useEffect(() => {
    const el = heatmapRef.current; if (!el || !weekCount) return undefined;
    const measure = () => setCellPx(Math.min(12, Math.max(4, Math.floor((el.clientWidth - 30) / weekCount))));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure); observer.observe(el); return () => observer.disconnect();
  }, [weekCount]);
  const hasCost = days.some((day) => day.cost != null); const metric = hasCost ? 'cost' : 'tokens';
  const value = (day, key) => key === 'cost' ? (day?.cost == null ? '—' : `${day?.currency || data?.currency || ''}${Number(day.cost).toFixed(2)}`) : `${shortNumber(day?.tokens)} Token`;
  const level = (day) => { if (day?.[metric] == null) return 'missing'; const number = Number(day[metric]); if (!Number.isFinite(number)) return 'missing'; if (number <= 0) return '0'; if (metric === 'tokens') return number < 10_000_000 ? '1' : number < 30_000_000 ? '2' : number < 80_000_000 ? '3' : '4'; return number < 30 ? '1' : number < 100 ? '2' : number < 250 ? '3' : '4'; };
  const selected = days.find((day) => day.date === selectedDate);
  const selectedIndex = selected ? days.indexOf(selected) : -1;
  const stepTo = (index) => {
    const next = days[Math.max(0, Math.min(days.length - 1, index))];
    if (!next) return;
    setSelectedDate(next.date);
    requestAnimationFrame(() => heatmapRef.current?.querySelector(`[data-usage-date="${next.date}"]`)?.focus());
  };
  const handleHeatmapKey = (event) => {
    if (!days.length) return;
    const base = selectedIndex >= 0 ? selectedIndex : days.length - 1;
    if (event.key === 'Home') { event.preventDefault(); stepTo(0); return; }
    if (event.key === 'End') { event.preventDefault(); stepTo(days.length - 1); return; }
    const delta = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    if (delta === undefined) return;
    event.preventDefault(); stepTo(base + delta);
  };
  const dayAriaLabel = (day) => [day.date, day.cost != null ? `花费 ${value(day, 'cost')}` : '花费未覆盖', day.tokens != null ? `Token ${value(day, 'tokens')}` : 'Token 未覆盖', day.requests != null ? `请求 ${shortNumber(day.requests)}` : null].filter(Boolean).join('，');
  if (!account.usageSupported) return <div className="provider-usage-state"><span className="provider-usage-state-icon"><History size={18} /></span><div><b>此厂商没有官方用量历史</b><small>可查看额度趋势与周期浪费记录</small></div></div>;
  if (account.usageStatus !== 'connected') return <div className="provider-usage-state connect-guide"><span className="provider-usage-state-icon"><History size={18} /></span><div><b>{account.usageStatus === 'reauth_required' ? '官方用量连接已失效' : '官方用量尚未连接'}</b><small>请在桌面端设置中连接账号；连接凭据不会传到浏览器。</small></div></div>;
  if (loading) return <div className="provider-usage-state"><RefreshCw size={17} className="spinning" /><div><b>正在读取厂商服务端用量</b><small>只读取已连接账号返回的逐日统计</small></div></div>;
  if (error || !data) return <div className="provider-usage-state"><span className="provider-usage-state-icon"><AlertCircle size={18} /></span><div><b>服务端用量暂时不可用</b><small>{error || '暂无用量数据'}</small></div></div>;
  if (!days.some((day) => day.cost != null || day.tokens != null)) return <div className="provider-usage-state"><span className="provider-usage-state-icon"><History size={18} /></span><div><b>这个区间没有厂商历史数据</b><small>额度趋势与周期浪费记录仍可在其他页签查看。</small></div></div>;
  const hasTokens = days.some((day) => day.tokens != null);
  const hasRequests = days.some((day) => day.requests != null);
  const usageNumber = (value) => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
  const accountTotalCost = usageNumber(data.summary?.totalCost);
  const rangeCost = usageNumber(data.summary?.rangeCost);
  const knownRangeCost = usageNumber(data.summary?.knownRangeCost);
  const costTotal = accountTotalCost ?? (data.coverage?.cost?.complete && rangeCost != null ? rangeCost : knownRangeCost);
  const costLabel = accountTotalCost != null ? '累计花费' : '区间花费';
  const accountTotalTokens = usageNumber(data.summary?.totalTokens);
  const rangeTokens = usageNumber(data.summary?.rangeTokens);
  const knownRangeTokens = usageNumber(data.summary?.knownRangeTokens);
  const tokensTotal = accountTotalTokens ?? (data.coverage?.tokens?.complete && rangeTokens != null ? rangeTokens : knownRangeTokens);
  const tokensLabel = accountTotalTokens != null || (data.coverage?.tokens?.complete && rangeTokens != null) ? '累计消耗 Token' : '已覆盖区间 Token';
  const peakCost = usageNumber(data.summary?.peakDailyCost);
  const peakTokens = usageNumber(data.summary?.peakDailyTokens);
  const peakIsCost = metric === 'cost' && peakCost != null;
  const hasPeak = peakIsCost || peakTokens != null;
  const currentStreak = usageNumber(data.summary?.currentStreakDays);
  const longestStreak = usageNumber(data.summary?.longestStreakDays);
  const countLabel = (value) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Number(value));
  const costLabelValue = (value) => `${data.currency || ''}${Number(value).toFixed(2)}`;
  const summaryCards = [
    hasCost && <div key="cost" className="provider-stat cost" title={costTotal == null ? '' : costLabelValue(costTotal)}><span className="stat-icon"><Zap size={13} /></span><div className="stat-copy"><span>{costLabel}</span><strong>{costTotal == null ? '—' : costLabelValue(costTotal)}</strong></div></div>,
    hasTokens && <div key="tokens" className="provider-stat tokens" title={tokensTotal == null ? '' : `${countLabel(tokensTotal)} Token`}><span className="stat-icon"><Bot size={13} /></span><div className="stat-copy"><span>{tokensLabel}</span><strong>{shortNumber(tokensTotal)}</strong></div></div>,
    hasPeak && <div key="peak" className="provider-stat peak" title={data.summary?.peakDailyTokensDate ? `峰值日期 ${data.summary.peakDailyTokensDate}` : '区间内单日最高消耗'}><span className="stat-icon"><TrendingUp size={13} /></span><div className="stat-copy"><span>{peakIsCost ? '峰值花费' : '峰值 Token'}</span><strong>{peakIsCost ? costLabelValue(peakCost) : shortNumber(peakTokens)}</strong></div></div>,
    currentStreak != null && account.providerId !== 'codex' && <div key="streak" className="provider-stat streak"><span className="stat-icon"><Flame size={13} /></span><div className="stat-copy"><span>当前连续</span><strong>{countLabel(currentStreak)} 天</strong></div></div>,
    longestStreak != null && <div key="longest" className="provider-stat longest"><span className="stat-icon"><Trophy size={13} /></span><div className="stat-copy"><span>最长连续</span><strong>{countLabel(longestStreak)} 天</strong></div></div>,
  ].filter(Boolean);
  const selectedLabel = selected && selected.date === new Date(Date.now() + Number(data.coverage?.timezoneOffsetSec || 0) * 1000).toISOString().slice(0, 10) ? '当日' : `${selected?.date || ''} `;
  return <div className="provider-usage-view remote-provider-usage">
    <div className="provider-usage-summary">{summaryCards}</div>
    <div className="provider-heatmap-head"><span className="provider-heatmap-title">近 1 年使用热力图</span><div className="provider-heatmap-legend"><span>较少</span>{[0, 1, 2, 3, 4].map((item) => <i key={item} className={`provider-heatmap-cell level-${item}`} />)}<span>较多</span></div></div>
    <div className="provider-heatmap-scroll" role="grid" tabIndex={0} aria-label="近 1 年每日用量热力图，方向键选择日期" ref={heatmapRef} onKeyDown={handleHeatmapKey}><div className="provider-heatmap-board" style={{ '--hm-cell': `${cellPx}px`, '--hm-cell-h': `${cellPx}px` }}><span className="provider-heatmap-corner" aria-hidden="true" /><div className="provider-heatmap-months" aria-hidden="true" style={{ width: `${weekCount * cellPx}px` }}>{shownMonthMarkers.map((item) => <span key={item.key} style={{ left: `${(item.column - 1) * cellPx}px` }}>{item.label}</span>)}</div><div className="provider-heatmap-weekdays" aria-hidden="true"><span>一</span><span /><span>三</span><span /><span>五</span><span /><span>日</span></div><div className="provider-heatmap-grid" role="rowgroup" aria-label={`每日${metric === 'cost' ? '花费' : 'Token'}热力图`}>{cells.map((day, index) => day ? <button type="button" role="gridcell" key={day.date} data-usage-date={day.date} tabIndex={selectedDate === day.date ? 0 : -1} aria-selected={selectedDate === day.date} aria-label={dayAriaLabel(day)} className={`provider-heatmap-cell level-${level(day)}${day.date === selectedDate ? ' selected' : ''}`} title={dayAriaLabel(day)} onFocus={() => setSelectedDate(day.date)} onClick={() => setSelectedDate(day.date)} /> : <span key={`blank-${index}`} className="provider-heatmap-cell blank" aria-hidden="true" />)}</div></div></div>
    <div className="provider-day-card">{selected ? <>{hasCost && <div className="day-cell"><div><span>{selectedLabel}花费</span><b>{selected.cost == null ? '—' : value(selected, 'cost')}</b></div></div>}{hasTokens && <div className="day-cell"><div><span>{selectedLabel}Token</span><b>{selected.tokens == null ? '—' : shortNumber(selected.tokens)}</b></div></div>}{hasRequests && <div className="day-cell"><div><span>{selectedLabel}请求</span><b>{selected.requests == null ? '—' : shortNumber(selected.requests)}</b></div></div>}</> : <span className="chart-detail-hint">点击热力图方格查看当日用量</span>}</div>
  </div>;
}

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
  const [view, setView] = useState('trend');
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
  const tabs = [
    { key: 'trend', label: '趋势' },
    ...(account.usageSupported ? [{ key: 'usage', label: '用量' }] : []),
    ...(account.wasteWindows?.length ? [{ key: 'waste', label: '浪费' }] : []),
  ];
  useEffect(() => { if (!tabs.some((tab) => tab.key === view)) setView('trend'); }, [account.usageSupported, account.wasteWindows, view]);
  const panelId = `remote-history-${String(account.id).replace(/[^a-zA-Z0-9_-]/g, '-')}-panel`;
  const handleTabKey = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = Math.max(0, tabs.findIndex((tab) => tab.key === view));
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    setView(next.key);
    requestAnimationFrame(() => document.getElementById(`${panelId}-tab-${next.key}`)?.focus());
  };
  const changeDays = (value) => { setHiddenKeys([]); setDays(value); };
  return <div className="view-stack history-view remote-history-view">
    <section className="surface-section">
      <div className="history-head">
        <RemoteIdentity account={account} providerInfo={providerInfo} />
        <div className="remote-history-tools">
          {tabs.length > 1 && <div className="seg-control history-view-switch" role="tablist" aria-label="账号历史视图" onKeyDown={handleTabKey}>
            {tabs.map((tab) => <button type="button" role="tab" id={`${panelId}-tab-${tab.key}`} key={tab.key} data-history-tab={tab.key} tabIndex={view === tab.key ? 0 : -1} aria-controls={panelId} aria-selected={view === tab.key} className={view === tab.key ? 'active' : ''} onClick={() => setView(tab.key)}>{tab.label}</button>)}
          </div>}
          <button type="button" className="back-button" onClick={onClose} title="返回" aria-label="返回"><ArrowLeft size={15} /></button>
        </div>
      </div>
      <div className="remote-history-tabpanel" {...(tabs.length > 1 ? { role: 'tabpanel', id: panelId, 'aria-labelledby': `${panelId}-tab-${view}` } : {})}>
        {view === 'waste' ? <RemoteWasteView account={account} token={token} />
          : view === 'usage' ? <RemoteUsageView account={account} token={token} />
            : <div className="trend-view">
              {loading ? <div className="settings-empty chart-empty">正在读取历史记录…</div> : error ? <div className="settings-empty chart-empty">{error}</div> : <TrendChart points={points} keys={keys} hiddenKeys={hiddenKeys} days={days} onDaysChange={changeDays} />}
              {keys.length > 0 && <div className="chart-legend">{keys.map((key, index) => { const latest = [...points].reverse().find((point) => point.windows?.[key])?.windows[key]; return <button type="button" key={key} className={hiddenKeys.includes(key) ? 'off' : ''} onClick={() => toggleKey(key)} title={hiddenKeys.includes(key) ? '点击显示该折线' : '点击隐藏该折线'}><i style={{ background: trendColor(key, index) }} />{trendLabel({ key })}{latest && <em>{latest.unit === '%' ? `${Math.round(sampleValue(latest))}%` : `${sampleValue(latest).toFixed(2)} ${latest.unit || ''}`}</em>}</button>; })}<span className="legend-right">{points.length} 条记录</span></div>}
            </div>}
      </div>
    </section>
    <div className="history-foot"><button type="button" className="outline-button" onClick={onClose}><ArrowLeft size={14} />返回</button></div>
  </div>;
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
