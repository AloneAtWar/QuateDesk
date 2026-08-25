import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertCircle, ArrowLeft, Bell, Check, ChevronDown, ChevronRight, CircleGauge, Clock3, Download, Eye, History, LayoutGrid,
  KeyRound, Monitor, Plus, Power, RefreshCw, Rows3, Settings2, ShieldCheck, SlidersHorizontal,
  Pencil, Pin, Sparkles, SunMoon, Tag, Trash2, UploadCloud, X, Zap,
} from 'lucide-react';
import { initialAccounts, providerCatalog, windowCatalog } from './data';
import { adapterDefinitions } from './adapters';
import { newApiTemplateScript } from './newapi-template';
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
// 浮窗整体等比缩放：窗口尺寸和内容（字体/图标/间距）按同一个比例放大缩小
// 基准宽度保证默认大小下名称 + 标签 + 全部额度窗口（含 1M）都能完整放下，不做任何隐藏
const WIDGET_BASE_SIZE = { width: 350, height: 52 };
const clampWidgetScale = (value) => {
  const scale = Math.round(Number(value) * 20) / 20;
  return Number.isFinite(scale) ? Math.min(3, Math.max(0.8, scale)) : 1;
};
// 浮窗长度：只拉伸/压缩横向长度，高度跟随“大小”不变；最短保证额度芯片完整显示
const WIDGET_MIN_LENGTH = 0.6;
const WIDGET_MAX_LENGTH = 1.5;
const clampWidgetLength = (value) => {
  const length = Math.round(Number(value) * 20) / 20;
  return Number.isFinite(length) ? Math.min(WIDGET_MAX_LENGTH, Math.max(WIDGET_MIN_LENGTH, length)) : 1;
};
const normalizeSettings = (value = {}) => {
  const legacySize = { small: 240, medium: 280, large: 336 }[value.widgetSize];
  const byWidth = Number(value.widgetWidth) ? Number(value.widgetWidth) / WIDGET_BASE_SIZE.width : undefined;
  return {
    alerts: true, pollMinutes: '15', widgetTagLimit: '2', reminderRules: defaultReminderRules,
    widget: true, widgetPreview: false, theme: 'dark', widgetScale: 0.9, widgetLength: 0.9, historyDays: 7,
    ...value,
    reminderRules: Array.isArray(value.reminderRules) ? value.reminderRules : defaultReminderRules,
    theme: value.theme === 'light' ? 'light' : 'dark',
    historyDays: [3, 7, 15, 30, 60, 90].includes(Number(value.historyDays)) ? Number(value.historyDays) : 7,
    widgetScale: clampWidgetScale(value.widgetScale ?? byWidth ?? (legacySize ? legacySize / WIDGET_BASE_SIZE.width : 0.9)),
    widgetLength: clampWidgetLength(value.widgetLength ?? 0.9),
    widgetSize: undefined,
    widgetWidth: undefined,
    widgetHeight: undefined,
  };
};

const providerWebsite = (provider) => {
  const url = String(provider?.website || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
};
const openProviderWebsite = (provider) => {
  const url = providerWebsite(provider);
  if (!url) return;
  if (window.quotaDesk?.openExternal) window.quotaDesk.openExternal(url).catch(() => {});
  else window.open(url, '_blank', 'noopener,noreferrer');
};

function Logo({ provider, size = 'md', interactive = true }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [provider?.logo]);
  const site = interactive ? providerWebsite(provider) : '';
  return <span
    className={`provider-logo ${provider?.tone || 'slate'} ${size}${site ? ' linked' : ''}`}
    aria-label={provider?.name}
    title={site ? '进入官网' : undefined}
    role={site ? 'link' : undefined}
    onClick={site ? () => openProviderWebsite(provider) : undefined}
    onKeyDown={site ? (event) => { if (event.key === 'Enter') openProviderWebsite(provider); } : undefined}
  >{provider?.logo && !failed ? <img src={provider.logo} alt="" onError={() => setFailed(true)} /> : provider?.monogram || '?'}</span>;
}

function MeterBar({ meter, compact = false }) {
  const label = windowCatalog[meter.key]?.label || meter.key;
  return <div className={`meter-line ${compact ? 'compact' : ''} ${meter.available === false ? 'unavailable' : ''}`}>
    <div className="meter-line-head">
      <span className="meter-name">{label}</span>
      <span className="meter-reading">{formatAmount(meter)}{formatQuotaDetail(meter) && <small title={formatQuotaDetail(meter)}>{formatQuotaDetail(meter)}</small>}</span>
    </div>
    <div className="meter-track" role="progressbar" aria-valuenow={meter.remaining} aria-valuemin="0" aria-valuemax={meter.total}>
      <span className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, meter.remaining))}%` }} />
    </div>
    <div className="meter-line-foot">
      <span className="meter-state">{meter.available === false ? <><AlertCircle size={12} /> {meter.error || '不可用'}</> : meter.key === 'balance' ? '可用余额' : '剩余额度'}</span>
      <span className="reset-meta" title={formatReset(meter.resetAt)}><Clock3 size={12} /> {formatReset(meter.resetAt)}</span>
    </div>
  </div>;
}

function TagPill({ children, tone = '', title }) { return <span className={`tag-pill ${tone}`} title={title}>{children}</span>; }

function AccountIdentity({ account, provider }) {
  return <div className="account-identity">
    <Logo provider={provider} />
    <div className="account-copy">
      <div className="account-title-line"><strong title={account.name}>{account.name}</strong>{account.tags?.slice(0, 2).map((tag) => <TagPill key={tag}>{tag}</TagPill>)}</div>
      <span title={account.identity ? `${provider?.name} · ${account.identity}` : (provider?.name || '')}>{account.identity ? `${provider?.name} · ${account.identity}` : provider?.name}</span>
    </div>
  </div>;
}

function AccountRuleMarks({ account, rules = [] }) {
  const texts = [...new Set((account.windows || []).flatMap((meter) => rules.filter((rule) => ruleMatches(meter, rule)).map((rule) => rule.label || `${rule.beforeMinutes} 分钟内刷新 · ≥${rule.minRemaining}%`)))];
  return texts.length ? <span className="rule-marks account-rule-marks">{texts.map((text) => <TagPill key={text} tone="warm" title={text}>{text}</TagPill>)}</span> : null;
}

function RuleMarks({ meter, rules = [] }) {
  const matched = rules.filter((rule) => ruleMatches(meter, rule));
  return matched.length ? <span className="rule-marks">{matched.map((rule) => { const text = rule.label || `${rule.beforeMinutes} 分钟内刷新 · ≥${rule.minRemaining}%`; return <TagPill key={rule.id} tone="warm" title={text}>{text}</TagPill>; })}</span> : null;
}

const durationOrder = { five_hour: 1, weekly: 2, monthly: 3, balance: 4 };
function ConcentricRings({ account }) {
  const meters = [...(account.windows || [])].sort((a, b) => (durationOrder[b.key] || 9) - (durationOrder[a.key] || 9)).slice(0, 4);
  const smallest = meters.reduce((current, meter) => !current || (durationOrder[meter.key] || 9) < (durationOrder[current.key] || 9) ? meter : current, null);
  const [hoveredKey, setHoveredKey] = useState(null);
  const unavailable = meters.find((meter) => meter.available === false);
  const active = unavailable || meters.find((meter) => meter.key === hoveredKey) || smallest;
  return <div className="concentric-rings" aria-label={`${meters.length} 个额度窗口`}>
    {meters.map((meter, index) => <div className={`quota-ring ring-${index} ${active?.key === meter.key ? 'is-active' : ''}`} key={meter.key} style={{ '--progress': `${Math.max(0, Math.min(100, Number(meter.remaining || 0))) * 3.6}deg` }} onMouseEnter={() => setHoveredKey(meter.key)} onMouseLeave={() => setHoveredKey(null)}><span /></div>)}
    <div className={`ring-core ${unavailable ? 'unavailable' : ''}`}><strong>{unavailable ? '不可用' : active ? formatAmount(active) : '—'}</strong><small>{active ? windowCatalog[active.key]?.label || active.key : '暂无窗口'}</small>{!unavailable && active?.resetAt && <em>{formatReset(active.resetAt)}</em>}</div>
  </div>;
}

function ResetTimeline({ accounts, providers }) {
  const scrollRef = useRef(null);
  const dragRef = useRef(null);
  const [active, setActive] = useState(null);
  const points = useMemo(() => accounts.flatMap((account) => (account.windows || [])
    .filter((meter) => meter.key !== 'balance' && meter.resetAt)
    .map((meter) => ({ account, meter, at: new Date(meter.resetAt).getTime() }))
    .filter((point) => !Number.isNaN(point.at))), [accounts]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (event) => {
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      el.scrollLeft += delta;
      event.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [points.length]);
  if (!points.length) return null;
  const now = Date.now();
  const NEAR_HOURS = 24;
  const NEAR_PX = 30;
  const FAR_PX = 4;
  const NEAR_WIDTH = NEAR_HOURS * NEAR_PX;
  const toX = (at) => {
    const hours = Math.max(0, (at - now) / 3600e3);
    return hours <= NEAR_HOURS ? hours * NEAR_PX : NEAR_WIDTH + (hours - NEAR_HOURS) * FAR_PX;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const maxAt = Math.max(...points.map((point) => point.at), now + 6 * 3600e3);
  const width = Math.max(460, Math.round(toX(maxAt)) + 70);
  const hourStart = new Date(now);
  hourStart.setMinutes(0, 0, 0);
  const nearTicks = [];
  for (let t = hourStart.getTime() + 3600e3; t <= now + NEAR_HOURS * 3600e3; t += 4 * 3600e3) {
    const d = new Date(t);
    nearTicks.push({ at: t, label: pad(d.getHours()) + ':' + pad(d.getMinutes()) });
  }
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const dayTicks = [];
  for (let t = midnight.getTime() + 2 * 864e5; t <= maxAt + 3600e3; t += 864e5) {
    const d = new Date(t);
    dayTicks.push({ at: t, label: (d.getMonth() + 1) + '/' + d.getDate() });
  }
  let lastLabelX = -50;
  const startDrag = (event) => {
    dragRef.current = { x: event.clientX, left: scrollRef.current ? scrollRef.current.scrollLeft : 0 };
    if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event) => {
    if (dragRef.current && scrollRef.current) scrollRef.current.scrollLeft = dragRef.current.left - (event.clientX - dragRef.current.x);
  };
  const endDrag = () => { dragRef.current = null; };
  return <section className="surface-section timeline-section">
    <div className="section-heading"><div><h2>重置时间轴</h2></div><span className="section-count">{points.length} 个重置点 · 滚轮或拖动查看</span></div>
    <div className="timeline-detail">{active
      ? <><b>{active.name}</b><em>{active.providerName} · {active.label}</em><strong>{active.amount}</strong><small>{active.absolute} · {active.relative}</small></>
      : <span className="timeline-detail-hint">悬停圆点查看账号详情</span>}</div>
    <div className="reset-timeline" ref={scrollRef} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerLeave={endDrag} onPointerCancel={endDrag}>
      <div className="timeline-track" style={{ width }}>
        <div className="timeline-axis" />
        <div className="timeline-now"><span>现在</span></div>
        {nearTicks.map((tick) => Math.round(toX(tick.at)) < 34 ? null : <div className="timeline-tick near" key={tick.at} style={{ left: Math.round(toX(tick.at)) }}><span>{tick.label}</span></div>)}
        {dayTicks.map((tick) => <div className="timeline-tick" key={tick.at} style={{ left: Math.round(toX(tick.at)) }}><span>{tick.label}</span></div>)}
        {[...points].sort((a, b) => a.at - b.at).map((point) => {
          const provider = providers.find((item) => item.id === point.account.providerId);
          const x = Math.max(10, Math.round(toX(point.at)));
          const showLabel = x - lastLabelX >= 72;
          if (showLabel) lastLabelX = x;
          const label = windowCatalog[point.meter.key]?.label || point.meter.key;
          const d = new Date(point.at);
          const near = point.at - now <= NEAR_HOURS * 3600e3;
          const timeLabel = near ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + '时';
          const detail = {
            name: point.account.name,
            providerName: provider?.name || '',
            label,
            amount: formatAmount(point.meter),
            absolute: (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()),
            relative: formatReset(point.meter.resetAt),
          };
          return <div key={point.account.id + '-' + point.meter.key} className="timeline-point" style={{ left: x }} onMouseEnter={() => setActive(detail)} onMouseLeave={() => setActive(null)}>
            <i className={provider?.tone || 'slate'} />{showLabel && <span><b>{point.account.name}</b><em>{label + ' · ' + timeLabel}</em></span>}
          </div>;
        })}
      </div>
    </div>
  </section>;
}

function PriorityView({ accounts, providers, reminderRules, onOpenHistory }) {
  const [collapsed, setCollapsed] = useState({});
  const grouped = useMemo(() => {
    const byWindow = new Map();
    accounts.flatMap((account) => account.windows.map((meter) => ({ account, meter }))).forEach((row) => {
      if (!byWindow.has(row.meter.key)) byWindow.set(row.meter.key, []);
      byWindow.get(row.meter.key).push(row);
    });
    return [...byWindow.entries()].map(([key, rows]) => [key, rows.sort((a, b) => new Date(a.meter.resetAt || '9999').getTime() - new Date(b.meter.resetAt || '9999').getTime())]);
  }, [accounts]);
  return <div className="view-stack">
    <ResetTimeline accounts={accounts} providers={providers} />
    {grouped.map(([key, rows]) => <section className="surface-section" key={key}>
      <div className="section-heading"><div><h2>{windowCatalog[key]?.label || key}</h2></div><span className="section-count">{rows.length} 个账号</span><button type="button" className="icon-button faint section-toggle" title={collapsed[key] ? '展开' : '收起'} onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}>{collapsed[key] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button></div>
      {!collapsed[key] && <div className="priority-list">{rows.map(({ account, meter }) => {
        const provider = providers.find((item) => item.id === account.providerId);
        return <div className="priority-row clickable" key={`${account.id}-${meter.key}`} role="button" tabIndex={0} title="点击查看额度趋势" onClick={() => onOpenHistory?.(account)} onKeyDown={(event) => { if (event.key === 'Enter') onOpenHistory?.(account); }}>
          <AccountIdentity account={account} provider={provider} />
          <div className="priority-meter"><div className="meter-track"><span className="meter-fill" style={{ width: `${meter.remaining}%` }} /></div><b>{formatAmount(meter)}</b></div>
          <div className="priority-reset"><Clock3 size={13} /><span>{formatReset(meter.resetAt)}</span><RuleMarks meter={meter} rules={reminderRules} /></div>
        </div>;
      })}</div>}
    </section>)}
  </div>;
}

function WindowsView({ accounts, providers, reminderRules, embedded = false, onOpenHistory }) {
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
        return <div className="account-window-row clickable" key={account.id} role="button" tabIndex={0} title="点击查看额度趋势" onClick={() => onOpenHistory?.(account)} onKeyDown={(event) => { if (event.key === 'Enter') onOpenHistory?.(account); }}>
          <div className="account-side"><AccountIdentity account={account} provider={provider} /><div className={`account-status ${account.status}`}><span className="status-dot" />{account.status === 'warning' ? '需处理' : '正常'}<small>{formatChecked(account.lastChecked)}</small></div><AccountRuleMarks account={account} rules={reminderRules} /></div>
          <div className="account-meters">{account.windows.map((meter) => <MeterBar key={meter.key} meter={meter} />)}</div>
        </div>;
      })}</div>
    </section>
  </div>;
}

// 额度历史折线图：横轴时间、纵轴剩余额度（百分比窗口取 remaining，余额窗口取 amount），每个窗口维度一条线
const CHART_COLORS = { five_hour: 'var(--cyan)', weekly: 'var(--violet)', monthly: 'var(--coral)', balance: 'var(--green)', gemini_pro: 'var(--sky)', gemini_flash: 'var(--cyan)', gemini_flash_lite: 'var(--green-deep)' };
const CHART_FALLBACK_COLORS = ['var(--cyan)', 'var(--violet)', 'var(--coral)', 'var(--green)', 'var(--sky)'];
const chartColor = (key, index) => CHART_COLORS[key] || CHART_FALLBACK_COLORS[index % CHART_FALLBACK_COLORS.length];
const chartValue = (sample) => sample.unit === '%' ? sample.remaining : Number(sample.amount ?? sample.remaining);
const formatChartValue = (sample, value) => sample.unit === '%' ? `${Math.round(value)}%` : `${sample.unit === 'CNY' ? '¥' : sample.unit}${Number(value).toFixed(2)}`;
const formatChartNumber = (value) => Number.isInteger(value) ? String(value) : Number(value).toFixed(2);
// 悬停详情：百分比之外带上具体数值（剩余 / 总量）；总量就是 100 的纯百分比窗口没有额外数值，不显示
const formatChartDetail = (sample) => {
  const base = formatChartValue(sample, chartValue(sample));
  if (sample.unit !== '%' || sample.amount == null || sample.limit == null || Number(sample.limit) === 100) return base;
  return `${base} · 剩 ${formatChartNumber(Number(sample.amount))} / ${formatChartNumber(Number(sample.limit))}`;
};
// 该快照点的刷新周期：重置的绝对时间 + 相对该点的倒计时
const formatPointReset = (resetAt, pointAt) => {
  if (!resetAt) return '';
  const d = new Date(resetAt);
  const absolute = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const minutes = Math.round((d.getTime() - new Date(pointAt).getTime()) / 60000);
  if (minutes <= 0) return `重置 ${absolute}`;
  if (minutes < 60) return `重置 ${absolute}（${minutes} 分钟后）`;
  if (minutes < 24 * 60) return `重置 ${absolute}（${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后）`;
  return `重置 ${absolute}（${Math.floor(minutes / (24 * 60))} 天后）`;
};
// 详情条用的简短版：只要倒计时，保证一行放得下
const formatPointResetShort = (resetAt, pointAt) => {
  if (!resetAt) return '';
  const minutes = Math.round((new Date(resetAt).getTime() - new Date(pointAt).getTime()) / 60000);
  if (minutes <= 0) return '';
  if (minutes < 60) return `${minutes} 分钟后重置`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后重置`;
  return `${Math.floor(minutes / (24 * 60))} 天后重置`;
};

function UsageChart({ points, hiddenKeys = [] }) {
  const [hover, setHover] = useState(null);
  // 时间轴缩放：null 表示显示全程；滚轮以光标位置为中心缩放，放大后可拖动平移
  const [view, setView] = useState(null);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const W = 470; const H = 184;
  const PAD = { l: 36, r: 12, t: 14, b: 24 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const { allKeys, samples, allPercent, fullStart, fullEnd } = useMemo(() => {
    const keys = [...new Set(points.flatMap((point) => Object.keys(point.windows || {})))]
      .sort((a, b) => (durationOrder[a] || 9) - (durationOrder[b] || 9));
    // 抽样上限放宽到 2000，滚轮放大后仍能看清细节
    const stride = Math.max(1, Math.ceil(points.length / 2000));
    const sampled = points.filter((_point, index) => index % stride === 0 || index === points.length - 1);
    const percentOnly = keys.every((key) => sampled.every((point) => !point.windows?.[key] || point.windows[key].unit === '%'));
    return {
      allKeys: keys, samples: sampled, allPercent: percentOnly,
      fullStart: sampled.length ? new Date(sampled[0].at).getTime() : 0,
      fullEnd: sampled.length ? new Date(sampled[sampled.length - 1].at).getTime() : 0,
    };
  }, [points]);
  // React 根节点上的 wheel 监听是 passive 的，必须自己绑非 passive 监听才能 preventDefault
  useEffect(() => {
    const el = svgRef.current;
    if (!el || samples.length < 2) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (((event.clientX - rect.left) / rect.width) * W - PAD.l) / innerW));
      setView((prev) => {
        const fullSpan = Math.max(1, fullEnd - fullStart);
        const cur = prev || { start: fullStart, end: fullEnd };
        const curSpan = cur.end - cur.start;
        const factor = event.deltaY > 0 ? 1.3 : 1 / 1.3;
        const minSpan = Math.min(fullSpan, Math.max(10 * 60_000, fullSpan / 50));
        const nextSpan = Math.min(fullSpan, Math.max(minSpan, curSpan * factor));
        if (Math.abs(nextSpan - curSpan) < 1000) return prev;
        const anchor = cur.start + curSpan * ratio;
        const nextStart = Math.min(Math.max(fullStart, anchor - nextSpan * ratio), fullEnd - nextSpan);
        return nextSpan >= fullSpan ? null : { start: nextStart, end: nextStart + nextSpan };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fullStart, fullEnd, samples.length]);
  // 图例开关：隐藏的线不参与绘制；兜底不允许全部隐藏
  const seriesKeys = allKeys.filter((key) => !hiddenKeys.includes(key));
  const visibleKeys = seriesKeys.length ? seriesKeys : allKeys;
  if (!allKeys.length || !samples.length) return <div className="settings-empty chart-empty">历史记录里没有可绘制的额度窗口</div>;
  const start = view?.start ?? fullStart;
  const end = view?.end ?? fullEnd;
  const span = Math.max(1, end - start);
  const ranged = samples.filter((point) => { const at = new Date(point.at).getTime(); return at >= start && at <= end; });
  const drawn = ranged.length ? ranged : samples;
  const single = samples.length === 1;
  const toX = (at) => PAD.l + (single ? innerW / 2 : ((at - start) / span) * innerW);
  const values = drawn.flatMap((point) => visibleKeys.map((key) => point.windows?.[key]).filter(Boolean).map(chartValue));
  const yMin = allPercent ? 0 : Math.min(...values);
  const yMax = allPercent ? 100 : Math.max(...values);
  const yPad = allPercent ? 0 : Math.max((yMax - yMin) * 0.15, yMax * 0.02, 1);
  const yLo = yMin - yPad; const yHi = yMax + yPad;
  const toY = (value) => PAD.t + (1 - (value - yLo) / Math.max(1e-9, yHi - yLo)) * innerH;
  const paths = visibleKeys.map((key) => {
    const segments = [];
    let current = '';
    for (const point of drawn) {
      const sample = point.windows?.[key];
      if (!sample) { if (current) { segments.push(current); current = ''; } continue; }
      const command = `${current ? 'L' : 'M'}${toX(new Date(point.at).getTime()).toFixed(1)},${toY(chartValue(sample)).toFixed(1)}`;
      current += command;
    }
    if (current) segments.push(current);
    return { key, segments };
  });
  const rangeDays = span / 86_400_000;
  const formatTick = (at) => {
    const d = new Date(at);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return rangeDays <= 1.5 ? hm : rangeDays <= 10 ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const xTicks = single ? [start] : [0, 1, 2, 3, 4].map((index) => start + (span * index) / 4);
  const yTicks = [0, 1, 2, 3].map((index) => yLo + ((yHi - yLo) * index) / 3);
  const formatYTick = (value) => allPercent ? `${Math.round(value)}%` : value >= 100 ? String(Math.round(value)) : value.toFixed(1);
  const pickPoint = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !drawn.length) return null;
    const x = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDistance = Infinity;
    drawn.forEach((point, index) => {
      const distance = Math.abs(toX(new Date(point.at).getTime()) - x);
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    });
    return best;
  };
  const startPan = (event) => {
    if (!view) return;
    dragRef.current = { x: event.clientX, start: view.start, end: view.end };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const movePan = (event) => {
    const drag = dragRef.current;
    if (!drag) { const picked = pickPoint(event.clientX); if (picked != null) setHover(picked); return; }
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewSpan = drag.end - drag.start;
    const shift = ((event.clientX - drag.x) / rect.width) * (W / innerW) * viewSpan;
    const nextStart = Math.min(Math.max(fullStart, drag.start - shift), fullEnd - viewSpan);
    setView({ start: nextStart, end: nextStart + viewSpan });
    setHover(null);
  };
  const endPan = () => { dragRef.current = null; };
  const hoverPoint = hover == null ? null : drawn[hover];
  const hoverX = hoverPoint ? toX(new Date(hoverPoint.at).getTime()) : 0;
  const hoverDate = hoverPoint ? new Date(hoverPoint.at) : null;
  return <div className={`usage-chart ${view ? 'zoomed' : ''}`}>
    <div className="chart-detail">{hoverPoint ? <>
      <b>{`${hoverDate.getMonth() + 1}/${hoverDate.getDate()} ${String(hoverDate.getHours()).padStart(2, '0')}:${String(hoverDate.getMinutes()).padStart(2, '0')}`}</b>
      {visibleKeys.map((key, index) => {
        const sample = hoverPoint.windows?.[key];
        if (!sample) return null;
        const reset = formatPointResetShort(sample.resetAt, hoverPoint.at);
        return <span className="chart-detail-item" key={key}><i style={{ background: chartColor(key, index) }} />{windowCatalog[key]?.label || key}<b>{formatChartDetail(sample)}</b>{reset && <small>{reset}</small>}</span>;
      })}
    </> : <span className="chart-detail-hint">悬停查看该点的数值与重置时间</span>}</div>
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onMouseLeave={() => { setHover(null); endPan(); }}>
      {yTicks.map((value) => <g key={value}><line x1={PAD.l} x2={W - PAD.r} y1={toY(value)} y2={toY(value)} className="chart-grid" /><text x={PAD.l - 6} y={toY(value) + 3} className="chart-y-label">{formatYTick(value)}</text></g>)}
      {xTicks.map((at) => <text key={Math.round(at)} x={Math.min(Math.max(toX(at), PAD.l + 16), W - PAD.r - 16)} y={H - 7} className="chart-x-label">{formatTick(at)}</text>)}
      {paths.map((path, index) => path.segments.map((d) => <path key={`${path.key}-${d.slice(0, 12)}`} d={d} fill="none" stroke={chartColor(path.key, index)} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />))}
      {/* 点稀疏（放大看细节）时标出每个数据点；缩小看全程时不标，悬停照样有详情 */}
      {drawn.length <= 40 && paths.map((path, index) => drawn.map((point) => {
        const sample = point.windows?.[path.key];
        return sample ? <circle key={`${path.key}-${point.at}`} cx={toX(new Date(point.at).getTime())} cy={toY(chartValue(sample))} r={drawn.length === 1 ? 3 : 2} fill={chartColor(path.key, index)} /> : null;
      }))}
      {hoverPoint && <g>
        <line x1={hoverX} x2={hoverX} y1={PAD.t} y2={H - PAD.b} className="chart-cursor" />
        {visibleKeys.map((key, index) => {
          const sample = hoverPoint.windows?.[key];
          return sample ? <circle key={key} cx={hoverX} cy={toY(chartValue(sample))} r="3" fill={chartColor(key, index)} stroke="var(--surface)" strokeWidth="1.4" /> : null;
        })}
      </g>}
    </svg>
    {samples.length > 1 && <div className="chart-tools"><span className="chart-hint">滚轮缩放 · 放大后拖动平移</span>{view && <button type="button" className="chart-reset" onClick={() => setView(null)}>重置缩放</button>}</div>}
  </div>;
}

function HistoryView({ account, provider, onBack }) {
  const [points, setPoints] = useState(null);
  const [hiddenKeys, setHiddenKeys] = useState([]);
  useEffect(() => {
    let active = true;
    if (!window.quotaDesk?.getHistory) { setPoints([]); return undefined; }
    window.quotaDesk.getHistory(account.id).then((rows) => { if (active) setPoints(rows || []); }).catch(() => { if (active) setPoints([]); });
    return () => { active = false; };
  }, [account.id, account.lastChecked]);
  const legendKeys = useMemo(() => [...new Set((points || []).flatMap((point) => Object.keys(point.windows || {})))]
    .sort((a, b) => (durationOrder[a] || 9) - (durationOrder[b] || 9)), [points]);
  // 图例读数：每条线取它最近一次出现的值
  const latestSamples = useMemo(() => {
    const found = {};
    for (const point of [...(points || [])].reverse()) {
      for (const key of legendKeys) if (!found[key] && point.windows?.[key]) found[key] = point.windows[key];
    }
    return found;
  }, [points, legendKeys]);
  // 点击图例开关对应折线，至少保留一条
  const toggleKey = (key) => setHiddenKeys((old) => {
    if (old.includes(key)) return old.filter((item) => item !== key);
    return legendKeys.length - old.length <= 1 ? old : [...old, key];
  });
  return <div className="view-stack history-view">
    <section className="surface-section">
      <div className="history-head">
        <AccountIdentity account={account} provider={provider} />
        <span className="section-count">{points ? `${points.length} 条记录` : '读取中…'}</span>
      </div>
      {points === null ? <div className="settings-empty chart-empty">正在读取历史记录…</div>
        : points.length === 0 ? <div className="settings-empty chart-empty">暂无历史数据，每次成功刷新额度后都会记录一条</div>
          : <UsageChart points={points} hiddenKeys={hiddenKeys} />}
      {legendKeys.length > 0 && <div className="chart-legend">{legendKeys.map((key, index) => {
        const sample = latestSamples[key];
        const hidden = hiddenKeys.includes(key);
        return <button type="button" key={key} className={hidden ? 'off' : ''} title={hidden ? '点击显示该折线' : '点击隐藏该折线'} onClick={() => toggleKey(key)}><i style={{ background: chartColor(key, index) }} />{windowCatalog[key]?.label || key}{sample && <em>{formatChartValue(sample, chartValue(sample))}</em>}</button>;
      })}</div>}
    </section>
    <div className="history-foot"><button type="button" className="outline-button" onClick={onBack}><ArrowLeft size={14} /> 返回</button></div>
  </div>;
}

function StatusView({ accounts, providers, runtime, onTestAccount, testingAccountId, testResults, reminderRules, mode = 'rings', onModeChange, onOpenSettings, lastSync, onRefresh, refreshing, onOpenHistory }) {
  const groups = { active: accounts.filter((a) => a.status === 'active'), warning: accounts.filter((a) => a.status === 'warning') };
  if (mode === 'rows') return <div className="view-stack"><WindowsView accounts={accounts} providers={providers} reminderRules={reminderRules} embedded onOpenHistory={onOpenHistory} /></div>;
  if (mode === 'periods') return <div className="view-stack"><PriorityView accounts={accounts} providers={providers} reminderRules={reminderRules} onOpenHistory={onOpenHistory} /></div>;
  return <div className="view-stack">
    <section className="overview-grid">{[...groups.active, ...groups.warning].map((account) => {
      const provider = providers.find((item) => item.id === account.providerId);
      const feedback = testResults[account.id];
      const testing = testingAccountId === account.id;
      return <div className={`overview-card ${account.status} clickable`} key={account.id} role="button" tabIndex={0} title="点击查看额度趋势" onClick={() => onOpenHistory?.(account)} onKeyDown={(event) => { if (event.key === 'Enter') onOpenHistory?.(account); }}><div className="overview-head"><AccountIdentity account={account} provider={provider} /><div className="card-actions"><span className={`card-status-icon ${account.status}`} title={account.status === 'warning' ? (account.lastError || '连接检查失败') : (feedback?.message || `连接正常 · ${account.windows.length} 个额度窗口`)}>{account.status === 'warning' ? <AlertCircle size={14} /> : <ShieldCheck size={14} />}</span></div></div><div className="overview-body"><ConcentricRings account={account} /><div className="overview-meters">{(() => { const desc = [...account.windows].sort((a, b) => (durationOrder[b.key] || 9) - (durationOrder[a.key] || 9)).slice(0, 4); return [...desc].reverse().map((meter) => { const detail = `${formatReset(meter.resetAt)}${formatQuotaDetail(meter) ? ` · ${formatQuotaDetail(meter)}` : ''}`; return <div className="overview-meter" key={meter.key}><span><i className={`ring-dot ring-dot-${desc.indexOf(meter)}`} />{windowCatalog[meter.key]?.label || meter.key}</span><b>{formatAmount(meter)}</b><small title={detail}>{detail}</small></div>; }); })()}</div></div></div>;
    })}</section>
  </div>;
}

function Toggle({ checked, onChange, label, description }) {
  return <label className="setting-toggle"><span><b>{label}</b><small>{description}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
}

function SettingsDrawer({ accounts, providers, settings, setSettings, onClose, openModal, onDeleteAccount, onTestAccount, testingAccountId, onEditProvider, autoLaunch, onToggleAutoLaunch, appVersion, update, onOpenUpdate, onCheckUpdate, onClearHistory }) {
  return <><div className="drawer-shade" onClick={onClose} /><aside className="settings-drawer" aria-label="设置">
    <div className="drawer-scroll">
      <section className="drawer-section"><div className="drawer-section-title"><Bell size={16} /><span>刷新提醒规则</span><button className="mini-add" onClick={() => setSettings((old) => ({ ...old, reminderRules: [...(old.reminderRules || []), { id: `rule-${Date.now()}`, beforeMinutes: 120, minRemaining: 50 }] }))}><Plus size={14} /> 新增规则</button></div><Toggle checked={settings.alerts !== false} onChange={(value) => setSettings((old) => ({ ...old, alerts: value }))} label="启用提醒" description="关闭后不发送桌面通知，也不标记命中规则" />{(settings.reminderRules || []).length === 0 ? <div className="settings-empty">当前没有运行规则</div> : (settings.reminderRules || []).map((rule, index) => <div className="rule-editor" key={rule.id}><label><span>刷新前多久（分钟）<small>窗口重置倒计时小于该值才提醒</small></span><input type="number" min="1" value={rule.beforeMinutes} onChange={(event) => setSettings((old) => ({ ...old, reminderRules: old.reminderRules.map((item, itemIndex) => itemIndex === index ? { ...item, beforeMinutes: event.target.value } : item) }))} /></label><label><span>剩余至少（百分比）<small>剩余额度不低于该值才提醒</small></span><input type="number" min="0" max="100" value={rule.minRemaining} onChange={(event) => setSettings((old) => ({ ...old, reminderRules: old.reminderRules.map((item, itemIndex) => itemIndex === index ? { ...item, minRemaining: event.target.value } : item) }))} /></label><button className="icon-button danger rule-delete" title="删除规则" aria-label={`删除 ${rule.label || '规则'}`} onClick={() => setSettings((old) => ({ ...old, reminderRules: old.reminderRules.filter((item) => item.id !== rule.id) }))}><Trash2 size={13} /></button></div>)}<small className="drawer-help">满足“刷新前多久”且“剩余至少”时，额度窗口会标记该规则。可以一条规则都没有。</small><div className="setting-select"><span><b>轮询间隔</b><small>所有账号统一检查频率</small></span><select value={settings.pollMinutes} onChange={(event) => setSettings((old) => ({ ...old, pollMinutes: event.target.value }))}><option value="5">5 分钟</option><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="60">1 小时</option></select></div></section>
      <section className="drawer-section"><div className="drawer-section-title"><SunMoon size={16} /><span>主题</span></div><div className="setting-select"><span><b>界面主题</b><small>主窗口与桌面浮窗同步应用</small></span><select value={settings.theme === 'light' ? 'light' : 'dark'} onChange={(event) => setSettings((old) => ({ ...old, theme: event.target.value }))}><option value="dark">暗色</option><option value="light">亮色</option></select></div></section>
      <section className="drawer-section"><div className="drawer-section-title"><Monitor size={16} /><span>桌面浮窗</span></div><Toggle checked={settings.widget} onChange={(value) => setSettings((old) => ({ ...old, widget: value }))} label="显示桌面浮窗" description="固定在桌面顶层，双击展开主窗口" /><label className="size-slider"><span>大小</span><input type="range" min={80} max={300} step={5} value={Math.round(clampWidgetScale(settings.widgetScale) * 100)} onChange={(event) => setSettings((old) => ({ ...old, widgetScale: Number(event.target.value) / 100 }))} /><b>{Math.round(clampWidgetScale(settings.widgetScale) * 100)}%</b></label><label className="size-slider"><span>长度</span><input type="range" min={Math.round(WIDGET_MIN_LENGTH * 100)} max={Math.round(WIDGET_MAX_LENGTH * 100)} step={5} value={Math.round(clampWidgetLength(settings.widgetLength) * 100)} onChange={(event) => setSettings((old) => ({ ...old, widgetLength: Number(event.target.value) / 100 }))} /><b>{Math.round(clampWidgetLength(settings.widgetLength) * 100)}%</b></label><small className="drawer-help">长度只调整横向宽度（60%–150%）。浮窗会展示账号的全部额度窗口（含 1M）；空间不足时逐级收起：标签先缩成小圆点再隐藏，倒计时按周期从长到短逐个隐藏，最后才收起最长周期的额度——只有一个额度窗口的账号通常不用收起任何内容。名称放不下时显示省略号，悬停可查看完整内容。</small><button type="button" className="outline-button full" onClick={() => setSettings((old) => ({ ...old, widgetScale: 0.9, widgetLength: 0.9 }))}>恢复默认大小与长度</button><div className="widget-setting-preview"><div style={{ width: Math.round(WIDGET_BASE_SIZE.width * clampWidgetLength(settings.widgetLength)), maxWidth: '100%', margin: '0 auto' }}><WidgetRow account={accounts[0]} provider={providers.find((item) => item.id === accounts[0]?.providerId)} compact tagLimit={Number(settings.widgetTagLimit ?? 2)} length={clampWidgetLength(settings.widgetLength)} /></div></div><button className="outline-button full" onClick={() => setSettings((old) => ({ ...old, widgetPreview: true }))}><Eye size={15} /> 预览并调整</button></section>
      <section className="drawer-section"><div className="drawer-section-title"><History size={16} /><span>额度历史</span></div><div className="setting-select"><span><b>保留时长</b><small>每次成功刷新都会记录一条，用于账号卡片的趋势图</small></span><select value={settings.historyDays} onChange={(event) => setSettings((old) => ({ ...old, historyDays: Number(event.target.value) }))}><option value={3}>3 天</option><option value={7}>7 天（默认）</option><option value={15}>15 天</option><option value={30}>30 天</option><option value={60}>60 天</option><option value={90}>3 个月（最长）</option></select></div><button className="outline-button full" onClick={onClearHistory}><Trash2 size={14} /> 清除全部历史记录</button><small className="drawer-help">删除账号时会一并删除该账号的额度历史；超过保留时长的记录会自动清理。</small></section>
      <section className="drawer-section"><div className="drawer-section-title"><ShieldCheck size={16} /><span>账号与凭据</span><button className="mini-add" onClick={() => openModal('account')}><Plus size={14} /> 添加账号</button></div><div className="settings-list">{accounts.length === 0 && <div className="settings-empty">还没有账号</div>}{accounts.map((account) => { const provider = providers.find((item) => item.id === account.providerId); const testing = testingAccountId === account.id; return <div className="settings-account" key={account.id}><Logo provider={provider} size="sm" /><div><b title={account.name}>{account.name}</b><small className={account.status === 'warning' ? 'warning-copy' : ''} title={account.status === 'warning' ? (account.lastError || '') : ''}>{account.status === 'warning' ? account.lastError : `${provider?.name} · ${account.windows.length} 个额度窗口`}</small></div><button className="row-icon-button" title="编辑账号" aria-label={`编辑 ${account.name}`} onClick={() => openModal({ type: 'account-edit', account })}><Pencil size={13} /></button><button className="row-icon-button" disabled={testing} title="刷新" aria-label={`刷新 ${account.name} 额度`} onClick={() => onTestAccount(account)}><RefreshCw size={13} className={testing ? 'spinning' : ''} /></button><button className="row-icon-button danger" title="删除账号" aria-label={`删除 ${account.name}`} onClick={() => onDeleteAccount(account)}><Trash2 size={13} /></button><span className={`status-dot ${account.status}`} /></div>; })}</div>{window.quotaDesk?.scanCcswitchImport && <button className="outline-button full drawer-import-button" onClick={() => openModal('import-ccswitch')}><Download size={14} /> 从 cc-switch 导入账号</button>}</section>
      <section className="drawer-section"><div className="drawer-section-title"><LayoutGrid size={16} /><span>厂商适配器</span><button className="mini-add" onClick={() => openModal('provider')}><Plus size={14} /> 新增厂商</button></div><div className="settings-list providers-list">{providers.map((provider) => <div className="settings-account" key={provider.id}><Logo provider={provider} size="sm" /><div><b title={provider.name}>{provider.name}</b><small>{provider.requestConfig?.adapterMode === 'script' ? '脚本适配' : provider.requestConfig?.adapterMode === 'grok' ? '专属适配' : '标准映射'}</small></div><button className="row-icon-button" title="编辑厂商" aria-label={`编辑 ${provider.name}`} onClick={() => onEditProvider(provider)}><Pencil size={13} /></button><span className="adapter-state"><Check size={13} /></span></div>)}</div></section>
      <section className="drawer-section"><div className="drawer-section-title"><Power size={16} /><span>系统与更新</span></div><Toggle checked={autoLaunch} onChange={onToggleAutoLaunch} label="开机自启" description="登录 Windows 后自动启动 Quota Desk" /><Toggle checked={settings.autoUpdate !== false} onChange={(value) => setSettings((old) => ({ ...old, autoUpdate: value }))} label="自动检查更新" description="启动时检查 GitHub 上是否有新版本" /><div className="setting-select"><span><b>版本更新</b><small>当前版本 v{appVersion || '-'}</small></span>{update && ['available', 'downloading', 'downloaded'].includes(update.status) ? <button className="outline-button" onClick={onOpenUpdate}>v{update.version} 可用</button> : <button className="outline-button" disabled={update?.status === 'checking'} onClick={onCheckUpdate}>{update?.status === 'checking' ? '正在检查…' : '检查更新'}</button>}</div></section>
    </div>
  </aside></>;
}

// 浮窗等比缩放容器：布局尺寸按比例反向缩小，再用 transform 放大，视觉上正好铺满窗口；长度只影响横向布局宽度
function WidgetScaledRow({ scale = 1, length = 1, children }) {
  return <div className="widget-scale-layer"><div className="widget-scale-frame" style={{ width: WIDGET_BASE_SIZE.width * clampWidgetLength(length) - 8 / scale, height: WIDGET_BASE_SIZE.height - 8 / scale, transform: `scale(${scale})` }}>{children}</div></div>;
}

// 浮窗内容自适应：账号的全部额度窗口（含 1M）都参与展示，按实际渲染宽度判断是否排得下；
// 排不下时按 标签缩圆点 → 隐藏标签 → 逐个隐藏倒计时（最长周期先收）→ 收起草长周期额度 → 压缩名称宽度 逐级收起。
// 只有一个额度窗口的账号通常无需收起任何内容；名称放不下时用省略号截断（悬停显示完整名称）。
function WidgetRow({ account, provider, compact = false, tagLimit = 2, length = 1, onDoubleClick }) {
  const allMeters = account?.windows || [];
  const hasTag = tagLimit > 0 && (account?.tags || []).length > 0;
  const fullFit = useMemo(() => ({ tagMode: hasTag ? 2 : 0, smallHidden: 0, drop: 0, squeeze: false }), [hasTag]);
  const [fit, setFit] = useState(fullFit);
  // 名称区域宽度下限：名称最多 64px（≈8 个字符），标签单独占位，二者分开计算
  const [blockFloor, setBlockFloor] = useState({ name: 64, tag: 0 });
  const rowRef = useRef(null);
  const metersRef = useRef(null);
  const marqueeRef = useRef(null);
  const nameRef = useRef(null);
  const tagsRef = useRef(null);
  // 长度 / 账号 / 子项数量变化时恢复完整展示，再按实际宽度重新逐级收起
  const fitKey = `${length}|${account?.id}|${account?.lastChecked}|${allMeters.length}|${hasTag}`;
  const fitKeyRef = useRef(fitKey);
  useLayoutEffect(() => {
    const measure = () => {
      // 下限变化后先应用再判断溢出，避免幻影占位误触发收起
      const nameLimit = Math.min(64, Math.ceil(marqueeRef.current ? marqueeRef.current.scrollWidth : 0));
      const tagWidth = fit.tagMode > 0 && tagsRef.current ? Math.ceil(tagsRef.current.offsetWidth) + 4 : 0;
      if (nameLimit !== blockFloor.name || tagWidth !== blockFloor.tag) { setBlockFloor({ name: nameLimit, tag: tagWidth }); return; }
      if (fitKeyRef.current !== fitKey) { fitKeyRef.current = fitKey; setFit(fullFit); return; }
      const row = rowRef.current;
      if (!row) return;
      // 芯片容器会被 flex 压缩而自身不撑开 row，所以 row 和芯片容器都要检查是否溢出
      const meters = metersRef.current;
      const overflowing = row.scrollWidth > row.clientWidth + 1 || Boolean(meters && meters.scrollWidth > meters.clientWidth + 1);
      // 省略号模式下名称被标签挤到截断也算排不下，但只用于收标签；长名称本身允许省略号截断
      const marqueeOn = fit.smallHidden === 0 && fit.drop === 0 && fit.tagMode === fullFit.tagMode && length >= 0.98;
      const nameEl = nameRef.current;
      const nameCramped = !marqueeOn && Boolean(nameEl && nameEl.scrollWidth > nameEl.clientWidth + 1);
      if (!overflowing && !nameCramped) return;
      setFit((prev) => {
        if (hasTag && prev.tagMode > 0) return { ...prev, tagMode: prev.tagMode - 1 };
        if (!overflowing) return prev;
        if (prev.smallHidden < allMeters.length) return { ...prev, smallHidden: prev.smallHidden + 1 };
        if (prev.drop < allMeters.length - 1) return { ...prev, drop: prev.drop + 1 };
        if (!prev.squeeze) return { ...prev, squeeze: true };
        return prev;
      });
    };
    measure();
    // 窗口被主进程 setBounds 改变尺寸时不经过 React 渲染，靠 ResizeObserver 补一次测量
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  });
  if (!account) return null;
  // 周期越长越先收起（1M → 7d → 5h），倒计时逐个隐藏，额度窗口至少保留一个
  const dropPriority = [...allMeters].sort((a, b) => (durationOrder[b.key] || 9) - (durationOrder[a.key] || 9));
  const smallHiddenKeys = new Set(dropPriority.slice(0, fit.smallHidden).map((meter) => meter.key));
  const droppedKeys = new Set(dropPriority.slice(0, fit.drop).map((meter) => meter.key));
  const visibleMeters = allMeters.filter((meter) => !droppedKeys.has(meter.key));
  // 完整展示且有富余空间时名称保留跑马灯滚动；有任何收起或长度变短时切换为省略号截断
  const pristine = fit.smallHidden === 0 && fit.drop === 0 && fit.tagMode === fullFit.tagMode;
  const marquee = pristine && length >= 0.98;
  const classes = ['widget-row', compact && 'compact', fit.tagMode === 1 && 'tag-dot', fit.squeeze && 'squeeze', !marquee && 'ellipsis'].filter(Boolean).join(' ');
  return <div className={classes} ref={rowRef} title={account.lastError || account.name} onDoubleClick={onDoubleClick}><Logo provider={provider} size="sm" interactive={false} /><div className="widget-account-block" style={{ minWidth: fit.squeeze ? 0 : blockFloor.name + blockFloor.tag }}><span className="widget-account-marquee" ref={marqueeRef}><span className="widget-account" ref={nameRef}>{account.name}</span></span>{fit.tagMode > 0 && <span className="widget-tags" ref={tagsRef}>{(account.tags || []).slice(0, 1).map((tag) => <em key={tag} title={tag}>{tag}</em>)}</span>}</div><div className="widget-meters" ref={metersRef}>{visibleMeters.length ? visibleMeters.map((meter) => <span className={`widget-meter ${meter.available === false ? 'off' : ''} ${smallHiddenKeys.has(meter.key) ? 'hide-reset' : ''}`} key={meter.key}><b>{windowCatalog[meter.key]?.short}</b><em>{formatAmount(meter)}</em><small>{formatResetCompact(meter.resetAt)}</small></span>) : <span className="widget-empty">等待同步</span>}</div><span className={`widget-live ${account.status === 'warning' ? 'warning' : ''}`}><i /></span></div>;
}

function WidgetPreview({ account, provider, onClose, tagLimit = 2, scale = 1, length = 1 }) {
  const clamped = clampWidgetScale(scale);
  const clampedLength = clampWidgetLength(length);
  return <div className="widget-preview-layer"><div className="widget-preview-head"><span><Monitor size={14} /> 浮窗预览</span><button className="icon-button" onClick={onClose} aria-label="关闭预览"><X size={15} /></button></div><div className="widget-preview-window" style={{ width: Math.round(WIDGET_BASE_SIZE.width * clamped * clampedLength), height: Math.round(WIDGET_BASE_SIZE.height * clamped) }}><WidgetScaledRow scale={clamped} length={clampedLength}><WidgetRow account={account} provider={provider} compact tagLimit={tagLimit} length={clampedLength} /></WidgetScaledRow></div></div>;
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
  const submit = async (event) => {
    event.preventDefault();
    if (!credential.trim() || !selected.length) return;
    setSaving(true);
    try {
      await onSave({ providerId, name: name || provider?.name || '新账号', identity: identity || '未命名凭据', tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), windowKeys: selected, credential, baseUrl: baseUrl.trim(), endpoint: endpoint.trim() });
    } finally { setSaving(false); }
  };
  return <div className="modal-backdrop" onClick={onClose}><form className="modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">新账号</span><h2>连接一个账号</h2></div></div><label className="field"><span>厂商</span><select value={providerId} onChange={(event) => { setProviderId(event.target.value); const next = providers.find((item) => item.id === event.target.value); setSelected(providerWindowKeys(next)); setBaseUrl(next?.baseUrl || ''); setEndpoint(defaultEndpoint(next)); }}>{providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><div className="form-grid"><label className="field"><span>账号名</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={provider?.name || '账号名称'} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="邮箱、用户名或币种" /></label></div><label className="field"><span>标签 <small>用逗号分隔，可多选</small></span><div className="input-with-icon"><Tag size={15} /><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="日常, 主力" /></div></label><label className="field"><span>额度接口默认路径 <small>可按账号覆盖</small></span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label><div className="field"><span>额度窗口 <small>同一账号可一次选择多个</small></span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div>{needsBaseUrl && <label className="field"><span>接口 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider?.baseUrl || 'https://api.example.com'} /></label>}<label className="field"><span>API Token <small>使用 Windows DPAPI 加密，仅保存在本机</small></span><div className="input-with-icon"><ShieldCheck size={15} /><input type="password" required value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="粘贴 Token，不要添加 Bearer" /></div></label><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={saving || !credential.trim() || !selected.length}><RefreshCw size={15} className={saving ? 'spinning' : ''} /> {saving ? '正在测试' : '保存并测试'}</button></div></form></div>;
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
  return <div className="modal-backdrop" onClick={onClose}><form className="modal compact-modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Windows 安全凭据</span><h2>更新 {account.name}</h2></div></div>{(provider?.adapter === 'wlb' || provider?.adapter === 'zai' || provider?.adapter === 'generic') && <label className="field"><span>接口 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>}<label className="field"><span>{'新 API Token'} <small>原凭据不会被读取或显示</small></span><div className="input-with-icon"><KeyRound size={15} /><input autoFocus type="password" required value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="输入后覆盖旧凭据" /></div></label><div className="adapter-note"><ShieldCheck size={15} /><span>保存后由 Windows DPAPI 加密，并立即检查一次该账号的额度。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !credential.trim()}>{saving ? '正在验证' : '保存并检查'}</button></div></form></div>;
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
      await onSave({ account, name: name.trim(), identity: identity.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), endpoint: endpoint.trim(), windowKeys: selected, credential: credential.trim() });
    } finally { setSaving(false); }
  };
  return <div className="modal-backdrop" onClick={onClose}><form className="modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">账号配置</span><h2>编辑 {account.name}</h2></div></div><div className="form-grid"><label className="field"><span>账号名</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="邮箱、用户名或币种" /></label></div><label className="field"><span>标签 <small>用逗号分隔</small></span><div className="input-with-icon"><Tag size={15} /><input value={tags} onChange={(event) => setTags(event.target.value)} /></div></label><div className="form-grid"><label className="field"><span>接口 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label><label className="field"><span>额度接口路径</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label></div><div className="field"><span>额度窗口 <small>取消选择后不会在该账号显示</small></span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div><label className="field"><span>{'新 API Token'} <small>留空则保留原凭据</small></span><div className="input-with-icon"><KeyRound size={15} /><input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="需要更换时再输入" /></div></label><div className="adapter-note"><ShieldCheck size={15} /><span>保存后会立即重新测试该账号，原凭据不会被读取或显示。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !selected.length}><Pencil size={15} /> {saving ? '正在保存并测试' : '保存并测试'}</button></div></form></div>;
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
  return <div className="modal-backdrop" onClick={onClose}><form className="modal provider-modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">{isGeneric ? '通用 JSON 适配器' : '内置厂商配置'}</span><h2>{provider ? '编辑厂商' : '新增厂商'}</h2></div></div><div className="logo-upload">{logo ? <span className="upload-preview"><img src={logo} alt="Logo 预览" /></span> : <span className="upload-mark"><UploadCloud size={19} /></span>}<div><b>{logo ? 'Logo 已准备好' : '上传厂商 Logo'}</b><small>PNG / SVG / WebP，建议 64 × 64</small></div><label className="outline-button file-button"><UploadCloud size={13} /> {logo ? '更换' : '选择文件'}<input type="file" accept="image/png,image/svg+xml,image/webp" onChange={readLogo} /></label></div><div className="form-grid"><label className="field"><span>厂商名称</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Acme Coding" /></label><label className="field"><span>接口 Base URL</span><input required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com" /></label></div><div className="form-grid"><label className="field"><span>默认额度接口</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="/v1/usage 或完整 URL" /></label><label className="field"><span>认证方式</span><select value={auth} onChange={(event) => setAuth(event.target.value)}><option value="bearer">Bearer Token</option><option value="token">原始 Token</option><option value="cookie">Cookie</option></select></label></div><label className="field"><span>高级适配脚本 <small>可覆盖内置请求和响应解析，返回 request + extractor</small></span><textarea value={script} onChange={(event) => setScript(event.target.value)} placeholder="({ request: { url: '{{baseUrl}}/v1/usage', method: 'GET', headers: { Authorization: 'Bearer {{apiKey}}' } }, extractor(response) { return { key: 'weekly', remaining: 50, total: 100, reset_at: response?.rate_limits?.[0]?.reset_at, unit: '%' }; } })" /></label>{isGeneric && <div className="adapter-config"><span className="eyebrow">响应字段映射</span><div className="form-grid"><label className="field"><span>数据路径</span><input value={listPath} onChange={(event) => setListPath(event.target.value)} placeholder="data.limits 或 data.quota" /></label><label className="field"><span>数据形态</span><select value={collectionMode} onChange={(event) => setCollectionMode(event.target.value)}><option value="auto">自动判断</option><option value="single">单个对象</option><option value="array">数组</option><option value="object-entries">对象键作为窗口</option></select></label></div><div className="form-grid"><label className="field"><span>窗口字段</span><input value={windowField} onChange={(event) => setWindowField(event.target.value)} placeholder="window / name / type" /></label><label className="field"><span>默认窗口</span><select value={defaultWindow} onChange={(event) => setDefaultWindow(event.target.value)}><option value="five_hour">5 小时</option><option value="weekly">7 天</option><option value="monthly">1个月</option><option value="balance">余额</option></select></label></div><label className="field"><span>窗口值映射</span><textarea value={windowMapText} onChange={(event) => setWindowMapText(event.target.value)} /></label><div className="form-grid mapping-grid"><label className="field"><span>总量路径</span><input value={totalPath} onChange={(event) => setTotalPath(event.target.value)} /></label><label className="field"><span>剩余路径</span><input value={remainingPath} onChange={(event) => setRemainingPath(event.target.value)} /></label><label className="field"><span>已用路径</span><input value={usedPath} onChange={(event) => setUsedPath(event.target.value)} /></label><label className="field"><span>百分比路径</span><input value={percentagePath} onChange={(event) => setPercentagePath(event.target.value)} /></label></div><label className="field"><span>刷新时间路径</span><input value={resetPath} onChange={(event) => setResetPath(event.target.value)} /></label></div>}<div className="adapter-note"><Sparkles size={15} /><span>脚本适配器支持复杂认证、请求方法、请求头、请求体和任意响应提取逻辑。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" type="submit"><Pencil size={15} /> {provider ? '保存厂商' : '新增厂商'}</button></div></form></div>;
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
    try { await onSave({ providerId, name: name.trim() || provider?.name || '新账号', identity: identity.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), windowKeys: selected, credential: credential.trim(), endpoint: accountEndpoint, variables: publicVariables, secretVariables }); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop" onClick={onClose}><form className="modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">新账号</span><h2>连接一个账号</h2></div></div><label className="field"><span>厂商</span><select value={providerId} onChange={(event) => { const next = providers.find((item) => item.id === event.target.value); setProviderId(event.target.value); setEndpoint(defaultEndpoint(next)); setSelected(providerWindowKeys(next)); setVariableValues(defaultVariableValues(next)); }}>{providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><div className="form-grid"><label className="field"><span>账号名</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={provider?.name || '账号名称'} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="邮箱、用户名或币种" /></label></div><label className="field"><span>标签 <small>用逗号分隔，可留空</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="日常, 主力" /></label>{!['script', 'grok'].includes(provider?.requestConfig?.adapterMode) && <label className="field"><span>详细额度接口路径</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com/v1/usage" /></label>}<div className="field"><span>额度窗口</span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div>{variableDefinitions.length > 0 && <div className="adapter-config account-variables"><span className="eyebrow">厂商变量</span><div className="form-grid">{variableDefinitions.map((item) => <label className="field" key={item.key}><span>{item.label || item.key}{item.required && <small> 必填</small>}</span><input type={item.secret ? 'password' : 'text'} required={item.required} value={variableValues[item.key] ?? ''} onChange={(event) => setVariableValues((old) => ({ ...old, [item.key]: event.target.value }))} placeholder={item.defaultValue || item.key} /></label>)}</div></div>}{!['script', 'grok'].includes(provider?.requestConfig?.adapterMode) && <label className="field"><span>{credentialRequired ? 'API Token' : '凭据（可选）'}</span><input type="password" required={credentialRequired} value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={credentialRequired ? '凭据只会加密保存在本机' : '此接口无需凭据'} /></label>}<div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={saving || (credentialRequired && !credential.trim()) || missingRequiredVariables || !selected.length}>{saving ? '正在测试' : '保存并测试'}</button></div></form></div>;
}

function CredentialModalV2({ account, provider, onClose, onSave }) {
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (event) => { event.preventDefault(); setSaving(true); try { await onSave({ account, credential: credential.trim() }); } finally { setSaving(false); } };
  return <div className="modal-backdrop" onClick={onClose}><form className="modal compact-modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">Windows 安全凭据</span><h2>更新 {account.name}</h2></div></div><label className="field"><span>{'新 API Token'} <small>原凭据不会被读取或显示</small></span><input autoFocus type="password" value={credential} onChange={(event) => setCredential(event.target.value)} /></label><div className="adapter-note"><ShieldCheck size={15} /><span>保存后由 Windows DPAPI 加密，并立即检查一次该账号。留空则保留原凭据，仅重新检查。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? '正在验证' : '保存并检查'}</button></div></form></div>;
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
  const submit = async (event) => { event.preventDefault(); const accountEndpoint = provider?.requestConfig?.adapterMode === 'script' ? String(variableValues.endpoint || provider.requestConfig.endpoint || '') : endpoint.trim(); if (!name.trim() || !accountEndpoint || !selected.length) return; const { publicVariables, secretVariables } = splitVariableValues(provider, variableValues); setSaving(true); try { await onSave({ account, name: name.trim(), identity: identity.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), endpoint: accountEndpoint, windowKeys: selected, credential: credential.trim(), variables: publicVariables, secretVariables }); } finally { setSaving(false); } };
  return <div className="modal-backdrop" onClick={onClose}><form className="modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">账号配置</span><h2>编辑 {account.name}</h2></div></div><div className="form-grid"><label className="field"><span>账号名</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} /></label></div><label className="field"><span>标签 <small>用逗号分隔，可留空</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>{!['script', 'grok'].includes(provider?.requestConfig?.adapterMode) && <label className="field"><span>详细额度接口路径</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>}<div className="field"><span>额度窗口</span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div>{variableDefinitions.length > 0 && <div className="adapter-config account-variables"><span className="eyebrow">厂商变量</span><div className="form-grid">{variableDefinitions.map((item) => <label className="field" key={item.key}><span>{item.label || item.key}{item.secret && <small> 留空保留原值</small>}</span><input type={item.secret ? 'password' : 'text'} required={item.required && !item.secret} value={variableValues[item.key] ?? ''} onChange={(event) => setVariableValues((old) => ({ ...old, [item.key]: event.target.value }))} placeholder={item.secret ? '未修改' : (item.defaultValue || item.key)} /></label>)}</div></div>}{!['script', 'grok'].includes(provider?.requestConfig?.adapterMode) && <label className="field"><span>{'新 API Token'} <small>留空保留原凭据</small></span><input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} /></label>}<div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !selected.length}>{saving ? '正在保存并测试' : '保存并测试'}</button></div></form></div>;
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
  const [website, setWebsite] = useState(existing.website || '');
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
    onSave({ id: provider?.id, name: name || '新厂商', adapter: provider?.adapter || 'generic', logo, website: String(website || '').trim(), requestConfig: { ...config, adapterMode: config.adapterMode === 'grok' ? 'grok' : advancedEnabled ? 'script' : 'standard', endpoint: advancedEnabled ? (endpointVariable?.defaultValue || endpoint) : endpoint, method, auth, authHeader, authPrefix, authQuery, headers, body, credentialRequired: advancedEnabled ? false : credentialRequired, variables: advancedEnabled ? cleanVariables : [], script: advancedEnabled ? script.trim() : '', responseRules: advancedEnabled ? undefined : responseRules, collectionMode, listPath, windowField, defaultWindow, windowMap, totalPath, remainingPath, usedPath, percentagePath, percentageMode, availablePath, unit, resetPath } });
  };
  return <div className="modal-backdrop" onClick={onClose}><form className={`modal provider-modal ${advancedEnabled ? 'script-mode' : ''}`} onSubmit={submit} onClick={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><span className="eyebrow">{advancedEnabled ? '脚本适配器' : '通用厂商配置'}</span><h2>{provider ? '编辑厂商' : '新增厂商'}</h2></div></div>
    <div className="logo-upload">{logo ? <span className="upload-preview"><img src={logo} alt="Logo 预览" /></span> : <span className="upload-mark"><UploadCloud size={19} /></span>}<div><b>{logo ? 'Logo 已准备好' : '上传厂商 Logo'}</b><small>PNG / SVG / WebP，建议 64 × 64</small></div><label className="outline-button file-button"><UploadCloud size={13} /> {logo ? '更换' : '选择文件'}<input type="file" accept="image/png,image/svg+xml,image/webp" onChange={readLogo} /></label></div>
    <label className="field"><span>厂商名称</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="field"><span>官网地址 <small>悬停厂商图标可进入官网，留空则不提供入口</small></span><input value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://www.example.com" /></label>
    <Toggle checked={advancedEnabled} onChange={setAdvancedEnabled} label="高级适配脚本" description="开启后脚本独立负责请求与响应解析" />
    <div className="form-grid preset-grid"><button type="button" className="outline-button" onClick={() => { setAdvancedEnabled(true); setScript(newApiTemplateScript); setVariables([{ key: 'endpoint', label: '站点地址', defaultValue: 'https://your-newapi-site.com', required: true, secret: false, system: false }, { key: 'accessToken', label: '面板 accessToken', defaultValue: '', required: true, secret: true, system: false }, { key: 'userId', label: '面板用户 ID', defaultValue: '', required: true, secret: false, system: false }]); }}><Sparkles size={14} /> New API 站点模板</button><small className="preset-hint">一键填入 New API 系中转站的余额查询脚本</small></div>
    {advancedEnabled ? <><div className="adapter-config variable-editor"><div className="variable-editor-head"><span className="eyebrow">账号变量</span><button type="button" className="mini-add" onClick={() => setVariables((old) => [...old, { key: '', label: '', defaultValue: '', required: false, secret: false }])}><Plus size={13} /> 新增变量</button></div>{variables.length > 0 && <div className="variable-row variable-row-head"><span>变量名<small>脚本里用 {'{{变量名}}'} 引用</small></span><span>显示名称<small>账号表单上的标签</small></span><span>默认值<small>账号没填时使用</small></span><span>必填</span><span>敏感</span><span /></div>}{variables.length === 0 ? <div className="settings-empty">没有额外变量</div> : variables.map((item, index) => <div className="variable-row" key={`${item.key}-${index}`}><input value={item.key || ''} readOnly={item.system} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, key: event.target.value } : entry))} placeholder="变量名" /><input value={item.label || ''} readOnly={item.system} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, label: event.target.value } : entry))} placeholder="显示名称" /><input value={item.defaultValue ?? ''} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, defaultValue: event.target.value } : entry))} placeholder="默认值" /><label title="账号必须填写"><input type="checkbox" checked={Boolean(item.required)} disabled={item.key === 'apiKey'} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, required: event.target.checked } : entry))} />必填</label><label title="使用 Windows DPAPI 加密"><input type="checkbox" checked={Boolean(item.secret)} disabled={item.system} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, secret: event.target.checked } : entry))} />敏感</label><span className="variable-row-tail">{item.system && <span className="variable-system-badge" title="厂商内置变量，用法和自定义变量一样，也可以删除">内置</span>}<button type="button" className="row-icon-button danger" onClick={() => setVariables((old) => old.filter((_entry, entryIndex) => entryIndex !== index))} title="删除变量" aria-label="删除变量"><Trash2 size={13} /></button></span></div>)}</div><label className="field"><span>适配脚本</span><textarea className="script-editor" required value={script} onChange={(event) => setScript(event.target.value)} placeholder="({ request: { url: '{{endpoint}}?region={{region}}', method: 'GET' }, extractor(response, variables) { return { key: 'weekly', remaining: 50, total: 100, unit: '%' }; } })" /></label></> : <>
      <div className="form-grid"><label className="field"><span>默认额度接口 <small>必须是完整 URL</small></span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com/v1/usage" /></label><label className="field"><span>请求方法</span><select value={method} onChange={(event) => setMethod(event.target.value)}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option></select></label></div>
      <div className="adapter-config"><span className="eyebrow">认证与请求</span><div className="form-grid"><label className="field"><span>认证方式</span><select value={auth} onChange={(event) => setAuth(event.target.value)}><option value="bearer">Bearer Token</option><option value="token">自定义 Header</option><option value="cookie">Cookie</option><option value="query">Query 参数</option><option value="none">无需认证</option></select></label>{auth === 'query' ? <label className="field"><span>Query 参数名</span><input value={authQuery} onChange={(event) => setAuthQuery(event.target.value)} /></label> : auth !== 'none' && <label className="field"><span>认证 Header</span><input value={authHeader} onChange={(event) => setAuthHeader(event.target.value)} /></label>}</div>{(auth === 'bearer' || auth === 'token') && <label className="field"><span>凭据前缀 <small>例如 Bearer，末尾空格会保留</small></span><input value={authPrefix} onChange={(event) => setAuthPrefix(event.target.value)} /></label>}<div className="form-grid"><label className="field"><span>额外请求头 JSON</span><textarea value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder={'{"X-Client": "QuotaDesk"}'} /></label><label className="field"><span>请求体 JSON <small>GET 时忽略</small></span><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={'{"account": "{{accountId}}"}'} /></label></div></div>
      <div className="adapter-config"><span className="eyebrow">响应字段映射</span><div className="form-grid"><label className="field"><span>数据路径</span><input value={listPath} onChange={(event) => setListPath(event.target.value)} placeholder="data.quota，可留空" /></label><label className="field"><span>数据形态</span><select value={collectionMode} onChange={(event) => setCollectionMode(event.target.value)}><option value="auto">自动判断</option><option value="single">单个对象</option><option value="array">数组</option><option value="object-entries">对象键作为窗口</option></select></label></div><div className="form-grid"><label className="field"><span>窗口字段</span><input value={windowField} onChange={(event) => setWindowField(event.target.value)} /></label><label className="field"><span>默认窗口</span><select value={defaultWindow} onChange={(event) => setDefaultWindow(event.target.value)}><option value="five_hour">5 小时</option><option value="weekly">7 天</option><option value="monthly">1个月</option><option value="balance">余额</option></select></label></div><label className="field"><span>窗口值映射 <small>每行：接口值=内部窗口</small></span><textarea value={windowMapText} onChange={(event) => setWindowMapText(event.target.value)} /></label><div className="form-grid mapping-grid"><label className="field"><span>总量路径</span><input value={totalPath} onChange={(event) => setTotalPath(event.target.value)} /></label><label className="field"><span>剩余路径</span><input value={remainingPath} onChange={(event) => setRemainingPath(event.target.value)} /></label><label className="field"><span>已用路径</span><input value={usedPath} onChange={(event) => setUsedPath(event.target.value)} /></label><label className="field"><span>百分比路径</span><input value={percentagePath} onChange={(event) => setPercentagePath(event.target.value)} /></label></div><div className="form-grid"><label className="field"><span>百分比含义</span><select value={percentageMode} onChange={(event) => setPercentageMode(event.target.value)}><option value="used">已用百分比</option><option value="remaining">剩余百分比</option></select></label><label className="field"><span>可用状态路径</span><input value={availablePath} onChange={(event) => setAvailablePath(event.target.value)} placeholder="isValid / status" /></label></div><div className="form-grid"><label className="field"><span>单位</span><input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="% / CNY / USD" /></label><label className="field"><span>刷新时间路径</span><input value={resetPath} onChange={(event) => setResetPath(event.target.value)} /></label></div></div>
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
  useEffect(() => { document.documentElement.dataset.theme = settings.theme === 'light' ? 'light' : 'dark'; }, [settings.theme]);
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
  const lastWheelAt = useRef(0);
  useEffect(() => { const timer = setInterval(() => { if (Date.now() - lastWheelAt.current < 10000) return; setIndex((value) => (value + 1) % Math.max(accounts.length, 1)); }, 6000); return () => clearInterval(timer); }, [accounts.length]);
  const cycleAccount = (direction) => { lastWheelAt.current = Date.now(); setIndex((value) => (value + direction + Math.max(accounts.length, 1)) % Math.max(accounts.length, 1)); };
  const account = accounts[index % Math.max(accounts.length, 1)];
  const provider = providers.find((item) => item.id === account?.providerId);
  const startDrag = (event) => { if (event.button !== 0) return; dragRef.current = { active: true, moved: false, x: event.screenX, y: event.screenY }; event.currentTarget.setPointerCapture?.(event.pointerId); };
  const moveDrag = (event) => { const drag = dragRef.current; if (!drag.active) return; const deltaX = event.screenX - drag.x; const deltaY = event.screenY - drag.y; if (!deltaX && !deltaY) return; drag.moved ||= Math.abs(deltaX) + Math.abs(deltaY) > 2; drag.x = event.screenX; drag.y = event.screenY; window.quotaDesk?.moveWidget(deltaX, deltaY); };
  const stopDrag = () => { dragRef.current.active = false; };
  return <div className="widget-window-shell" title="拖动移动，双击展开，滚轮切换账号，右键打开菜单" onWheel={(event) => cycleAccount(event.deltaY > 0 ? 1 : -1)} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onDoubleClick={() => { if (!dragRef.current.moved) window.quotaDesk?.openMainWindow(); }}><WidgetScaledRow scale={clampWidgetScale(settings.widgetScale)} length={clampWidgetLength(settings.widgetLength)}><WidgetRow account={account} provider={provider} compact tagLimit={Number(settings.widgetTagLimit ?? 2)} length={clampWidgetLength(settings.widgetLength)} /></WidgetScaledRow></div>;
}

function ImportCcswitchModal({ onClose, onApplied }) {
  const bridge = window.quotaDesk;
  const [scan, setScan] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState({});
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    let active = true;
    bridge?.scanCcswitchImport?.().then((result) => {
      if (!active) return;
      if (result?.error) { setError(result.error); return; }
      setScan(result);
      const defaults = {};
      for (const candidate of result.candidates || []) defaults[candidate.key] = !candidate.duplicateOfExisting && !candidate.duplicateInBatch;
      setSelected(defaults);
    }).catch((scanError) => { if (active) setError(scanError.message); });
    return () => { active = false; };
  }, []);
  const candidates = scan?.candidates || [];
  const importable = candidates.filter((item) => !item.duplicateOfExisting && !item.duplicateInBatch);
  const duplicates = candidates.filter((item) => item.duplicateOfExisting || item.duplicateInBatch);
  const selectedCount = importable.filter((item) => selected[item.key]).length;
  const apply = async () => {
    setApplying(true);
    setError('');
    try {
      const result = await bridge.applyCcswitchImport(importable.filter((item) => selected[item.key]).map((item) => item.key));
      onApplied(result);
    } catch (applyError) { setError(applyError.message); setApplying(false); }
  };
  return <div className="modal-backdrop" onClick={onClose}><div className="modal compact-modal import-modal" onClick={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><span className="eyebrow">数据导入</span><h2>从 cc-switch 导入账号</h2></div></div>
    <div className="adapter-note"><ShieldCheck size={15} /><span>只迁移 API Key，凭据仍由 Windows DPAPI 加密保存；重复的 Key 不会重复导入。</span></div>
    {error && <div className="adapter-note update-error"><AlertCircle size={15} /><span>{error}</span></div>}
    {!scan && !error && <div className="settings-empty">正在读取 cc-switch 数据…</div>}
    {scan && <>
      {importable.length === 0 && <div className="settings-empty">没有可导入的账号（厂商不支持或 Key 已存在）</div>}
      {importable.length > 0 && <div className="settings-list import-list">{importable.map((item) => <label className="settings-account import-row" key={item.key}><input type="checkbox" checked={Boolean(selected[item.key])} onChange={(event) => setSelected((old) => ({ ...old, [item.key]: event.target.checked }))} /><div><b title={item.name}>{item.name}</b><small>{item.providerName} · {item.keyTail}</small></div></label>)}</div>}
      {duplicates.length > 0 && <div className="adapter-note"><Check size={15} /><span>已跳过重复 Key：{duplicates.map((item) => item.name).join('、')}</span></div>}
      {(scan.unsupported || []).length > 0 && <div className="adapter-note"><AlertCircle size={15} /><span>暂不支持：{(scan.unsupported || []).map((item) => item.name).join('、')}</span></div>}
      <div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={applying || selectedCount === 0} onClick={apply}>{applying ? '正在导入…' : `导入所选（${selectedCount}）`}</button></div>
    </>}
  </div></div>;
}


function UpdateModal({ update, version, onClose }) {
  const notes = update?.releaseNotes?.trim();
  const status = update?.status;
  return <div className="modal-backdrop" onClick={onClose}><div className="modal compact-modal update-modal" onClick={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><span className="eyebrow">版本更新</span><h2>发现新版本 v{update?.version}</h2></div></div>
    <div className="adapter-note"><Download size={15} /><span>当前版本 v{version}，可升级到 v{update?.version}。</span></div>
    {status === 'error' && <div className="adapter-note update-error"><AlertCircle size={15} /><span>{update?.message || '检查更新失败，请稍后重试。'}</span></div>}
    {notes ? <div className="release-notes">{notes}</div> : <div className="settings-empty">该版本没有提供更新说明</div>}
    {status === 'downloading' && <div className="update-progress" role="progressbar" aria-valuenow={update?.percent || 0}><i style={{ width: `${update?.percent || 0}%` }} /></div>}
    <div className="modal-actions">
      <button type="button" className="outline-button" onClick={onClose}>{status === 'downloaded' ? '稍后重启' : '暂不升级'}</button>
      {status === 'available' && <button type="button" className="primary-button" onClick={() => window.quotaDesk?.downloadUpdate()}><Download size={14} /> 立即升级</button>}
      {status === 'downloading' && <button type="button" className="primary-button" disabled>下载中 {update?.percent || 0}%</button>}
      {status === 'downloaded' && <button type="button" className="primary-button" onClick={() => window.quotaDesk?.installUpdate()}><Power size={14} /> 重启并安装</button>}
      {status === 'error' && <button type="button" className="primary-button" onClick={() => window.quotaDesk?.checkForUpdates()}><RefreshCw size={14} /> 重试</button>}
    </div>
  </div></div>;
}

function App() {
  const bridge = window.quotaDesk;
  const [pinned, setPinned] = useState(false);
  useEffect(() => { if (bridge?.getPin) bridge.getPin().then(setPinned).catch(() => {}); }, [bridge]);
  const [update, setUpdate] = useState(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    if (!bridge) return undefined;
    bridge.getUpdateStatus?.().then((status) => status && setUpdate(status)).catch(() => {});
    bridge.getVersion?.().then(setAppVersion).catch(() => {});
    bridge.getAutoLaunch?.().then(setAutoLaunch).catch(() => {});
    return bridge.onUpdateStatus?.((status) => {
      setUpdate(status);
      // 手动点击“检查更新”的反馈：有更新弹窗、无更新/失败弹 toast；自动检查不打扰
      if (!status?.manual) return;
      if (status.status === 'available') setUpdateOpen(true);
      else if (status.status === 'none') setToast({ id: Date.now(), ok: true, message: '当前已是最新版本' });
      else if (status.status === 'error') setToast({ id: Date.now(), ok: false, message: status.message || '检查更新失败，请检查网络后重试' });
    });
  }, [bridge]);
  const onCheckUpdate = async () => {
    if (!bridge?.checkForUpdates) return;
    const ok = await bridge.checkForUpdates();
    if (ok === false) setToast({ id: Date.now(), ok: false, message: '当前环境不支持检查更新（仅打包后的应用可用）' });
  };
  const toggleAutoLaunch = async (value) => { if (bridge?.setAutoLaunch) setAutoLaunch(await bridge.setAutoLaunch(value)); };
  const [overviewMode, setOverviewMode] = useState('rings');
  // 额度历史折线图视图：点账号卡片进入，返回按钮或右上角视图切换退出
  const [historyAccountId, setHistoryAccountId] = useState(null);
  const [accounts, setAccounts] = useState(bridge ? [] : initialAccounts);
  const [providers, setProviders] = useState(providerCatalog);
  const [settings, setSettings] = useState(() => normalizeSettings({}));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modal, setModal] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [widgetIndex, setWidgetIndex] = useState(0);
  const [lastSync, setLastSync] = useState(new Date().toISOString());
  const [desktopError, setDesktopError] = useState('');
  const [toast, setToast] = useState(null);
  useEffect(() => { if (!toast) return undefined; const timer = setTimeout(() => setToast(null), 4200); return () => clearTimeout(timer); }, [toast]);
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
  useEffect(() => { document.documentElement.dataset.theme = settings.theme === 'light' ? 'light' : 'dark'; }, [settings.theme]);
  useEffect(() => { if (bridge && hydrated.current) bridge.setTheme?.(settings.theme === 'light' ? 'light' : 'dark').catch(() => {}); }, [settings.theme]);
  useEffect(() => { if (bridge && hydrated.current) bridge.setWidgetSize?.({ scale: clampWidgetScale(settings.widgetScale), length: clampWidgetLength(settings.widgetLength) }).catch(() => {}); }, [settings.widgetScale, settings.widgetLength]);

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
        setToast({ id: Date.now(), ok: result.ok, message: `${account.name}：${result.message}` });
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 450));
      const result = { ok: true, message: `成功读取 ${account.windows.length} 个额度窗口` };
      setTestResults((old) => ({ ...old, [account.id]: result }));
      setToast({ id: Date.now(), ok: true, message: `${account.name}：${result.message}` });
      return result;
    } catch (error) {
      setToast({ id: Date.now(), ok: false, message: `${account.name}：${error.message}` });
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
      if (credential) await bridge.saveCredential(account.id, credential);
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
    if (!window.confirm(`删除账号“${account.name}”及其本地凭据与额度历史？`)) return;
    const nextAccounts = accounts.filter((item) => item.id !== account.id);
    if (bridge) {
      await bridge.deleteCredential(account.id);
      const state = serializableState({ accounts: nextAccounts });
      lastSaved.current = JSON.stringify(state);
      await bridge.saveState(state);
    }
    if (historyAccountId === account.id) setHistoryAccountId(null);
    setAccounts(nextAccounts);
  };
  const clearHistory = async () => {
    if (!window.confirm('清除所有账号已保存的额度历史记录？该操作不可恢复。')) return;
    if (bridge) await bridge.clearHistory?.().catch(() => {});
    setToast({ id: Date.now(), ok: true, message: '额度历史记录已清除' });
  };
  const saveProvider = async (draft) => {
    const id = draft.id || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `provider-${Date.now()}`;
    const old = providers.find((item) => item.id === id);
    const provider = { ...old, id, name: draft.name, legalName: draft.name, monogram: draft.name.slice(0, 1).toUpperCase(), tone: old?.tone || 'slate', adapter: draft.adapter, logo: draft.logo, website: String(draft.website || '').trim(), requestConfig: draft.requestConfig };
    delete provider.baseUrl;
    delete provider.domain;
    const nextProviders = old ? providers.map((item) => item.id === id ? provider : item) : [...providers, provider];
    setProviders(nextProviders);
    if (bridge) { const state = serializableState({ providers: nextProviders }); lastSaved.current = JSON.stringify(state); await bridge.saveState(state); }
    setModal(null);
  };
  const editProvider = (provider) => setModal({ type: 'provider-edit', provider });
  const historyAccount = historyAccountId ? accounts.find((item) => item.id === historyAccountId) : null;

  return <div className="app-shell">
    <header className="titlebar"><span className="titlebar-drag"><img src="./quota-desk.svg" alt="" /><b>Quota Desk</b></span><div className="titlebar-controls"><span className="last-checked" title="最后一次额度检查时间"><Clock3 size={11} />{formatChecked(lastSync)}</span>{update && ['available', 'downloading', 'downloaded', 'error'].includes(update.status) && <button className={`update-badge ${update.status}`} onClick={() => setUpdateOpen(true)} title="查看版本更新"><Download size={11} />{update.status === 'available' && `v${update.version} 可更新`}{update.status === 'downloading' && `下载中 ${update.percent || 0}%`}{update.status === 'downloaded' && '重启升级'}{update.status === 'error' && '更新失败'}</button>}<button className="control-solo" onClick={refreshAll} disabled={refreshing} title="立即刷新全部账号" aria-label="立即刷新全部账号"><RefreshCw size={13} className={refreshing ? 'spinning' : ''} /></button><div className="overview-controls" aria-label="账号总览展示方式"><button className={overviewMode === 'rings' && !historyAccountId ? 'active' : ''} onClick={() => { setHistoryAccountId(null); setOverviewMode('rings'); }} title="账号总览" aria-label="账号总览"><CircleGauge size={13} /></button><button className={overviewMode === 'rows' && !historyAccountId ? 'active' : ''} onClick={() => { setHistoryAccountId(null); setOverviewMode('rows'); }} title="行式明细" aria-label="行式明细"><Rows3 size={13} /></button><button className={overviewMode === 'periods' && !historyAccountId ? 'active' : ''} onClick={() => { setHistoryAccountId(null); setOverviewMode('periods'); }} title="周期明细" aria-label="周期明细"><Clock3 size={13} /></button></div></div><div className="titlebar-actions"><button title="设置" aria-label="打开设置" onClick={() => setSettingsOpen(true)}><Settings2 size={13} /></button>{bridge && <><button className={pinned ? 'active' : ''} title={pinned ? '取消固定' : '固定在桌面最前面'} aria-label="固定在桌面最前面" onClick={async () => setPinned(await bridge.togglePin())}><Pin size={13} /></button><button title="关闭到托盘" aria-label="关闭到托盘" onClick={() => bridge.closeMainWindow()}><X size={14} /></button></>}</div></header>
    {toast && <div className={`toast ${toast.ok ? 'ok' : 'fail'}`} role="status">{toast.ok ? <Check size={13} /> : <AlertCircle size={13} />}<span>{toast.message}</span></div>}
    <main className="main-shell">
      <div className="content-area">{desktopError && <div className="desktop-error"><AlertCircle size={15} /><span>{desktopError}</span><button onClick={() => setDesktopError('')} aria-label="关闭错误"><X size={14} /></button></div>}{accounts.length === 0 ? <section className="empty-workspace"><div className="empty-mark"><CircleGauge size={22} /></div><div><span className="eyebrow">从一个账号开始</span><h2>把第一份 Coding Plan 接进来</h2><p>凭据将由 Windows 加密保存，额度请求只在本机发出。</p></div><button className="primary-button" onClick={() => setModal('account')}><Plus size={15} /> 添加账号</button><button className="outline-button" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /> 设置</button>{window.quotaDesk?.scanCcswitchImport && <button className="outline-button" onClick={() => setModal('import-ccswitch')}><Download size={15} /> 从 cc-switch 导入</button>}</section> : historyAccount ? <HistoryView account={historyAccount} provider={providers.find((item) => item.id === historyAccount.providerId)} onBack={() => setHistoryAccountId(null)} /> : <StatusView accounts={accounts} providers={providers} reminderRules={settings.alerts === false ? [] : settings.reminderRules} mode={overviewMode} onModeChange={setOverviewMode} runtime={runtime} onTestAccount={testAccount} testingAccountId={testingAccountId} testResults={testResults} onOpenSettings={() => setSettingsOpen(true)} lastSync={lastSync} onRefresh={refreshAll} refreshing={refreshing} onOpenHistory={(account) => setHistoryAccountId(account.id)} />}</div>
    </main>
    {settingsOpen && <SettingsDrawer accounts={accounts} providers={providers} settings={settings} setSettings={setSettings} onClose={() => setSettingsOpen(false)} openModal={setModal} onDeleteAccount={deleteAccount} onTestAccount={testAccount} testingAccountId={testingAccountId} onEditProvider={editProvider} autoLaunch={autoLaunch} onToggleAutoLaunch={toggleAutoLaunch} appVersion={appVersion} update={update} onOpenUpdate={() => setUpdateOpen(true)} onCheckUpdate={onCheckUpdate} onClearHistory={clearHistory} />}
    {updateOpen && update && <UpdateModal update={update} version={appVersion} onClose={() => setUpdateOpen(false)} />}
    {settings.widgetPreview && <WidgetPreview account={currentWidgetAccount} provider={currentWidgetProvider} tagLimit={Number(settings.widgetTagLimit ?? 2)} scale={settings.widgetScale} length={settings.widgetLength} onClose={() => setSettings((old) => ({ ...old, widgetPreview: false }))} />}
    {modal === 'account' && <AccountModalV2 providers={providers} onClose={() => setModal(null)} onSave={saveAccount} />}
    {modal?.type === 'account-edit' && <AccountEditModalV2 account={modal.account} provider={providers.find((item) => item.id === modal.account.providerId)} onClose={() => setModal(null)} onSave={updateAccount} />}
    {modal?.type === 'credential' && <CredentialModalV2 account={modal.account} provider={providers.find((item) => item.id === modal.account.providerId)} onClose={() => setModal(null)} onSave={updateCredential} />}
    {modal === 'provider' && <ProviderModalV2 onClose={() => setModal(null)} onSave={saveProvider} />}
    {modal?.type === 'provider-edit' && <ProviderModalV2 provider={modal.provider} onClose={() => setModal(null)} onSave={saveProvider} />}
    {modal === 'import-ccswitch' && <ImportCcswitchModal onClose={() => setModal(null)} onApplied={(result) => {
      if (result?.state) { setAccounts(result.state.accounts || []); setProviders(result.state.providers || []); setLastSync(result.state.lastSync || new Date().toISOString()); if (result.state.runtime) setRuntime(result.state.runtime); }
      lastSaved.current = '';
      setModal(null);
      setToast({ id: Date.now(), ok: result?.imported > 0, message: result?.imported > 0 ? `已从 cc-switch 导入 ${result.imported} 个账号` : '没有导入新账号（Key 都已存在）' });
    }} />}
  </div>;
}

export default App;

const widgetMode = new URLSearchParams(window.location.search).get('widget') === '1';
createRoot(document.getElementById('root')).render(widgetMode ? <WidgetApp /> : <App />);
