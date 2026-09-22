import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  AlertCircle, ArrowLeft, Bell, BellOff, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleGauge, CircleStop, Clock3, Download, Eye, ExternalLink, Globe, HelpCircle, History, LayoutGrid,
  Ellipsis, Flame, KeyRound, Monitor, Play, Plus, Power, RefreshCw, Rows3, Settings2, ShieldCheck, SlidersHorizontal, Square, Bot,
  Pencil, Pin, Sparkles, SunMoon, Tag, Trash2, TrendingUp, Trophy, UploadCloud, X, Zap,
} from 'lucide-react';
import { initialAccounts, providerCatalog, windowCatalog } from './data';
import { adapterDefinitions } from './adapters';
import { clampRemainingWeight, comparePriority } from './priority-score';
import { newApiTemplateScript } from './newapi-template';
import { computeUsageStreaks, formatProviderUsageCost, formatProviderUsageSummaryTokens } from './provider-usage-format';
import qrcode from 'qrcode-generator';
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

// ── 账号停用 ──
// 停用时间精确到分钟：停用往往发生在具体某个时刻，只到日期看不出“今天刚停”还是“早上停的”
const formatDisabledDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// 停用账号的档案行：绝对日期 + 相对时长（“凉了多久”一眼可见）；卡片较窄，两段分两行避免拆词换行
const formatDisabledDuration = (iso) => {
  if (!iso) return '一段时间';
  const elapsed = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const days = Math.floor(minutes / 1440);
  if (days >= 30) return `${Math.floor(days / 30)} 个月`;
  if (days >= 1) return `${days} 天`;
  return `${Math.floor(minutes / 60)} 小时`;
};

const formatAmount = (meter) => meter.key === 'balance' || meter.unit !== '%' ? `${meter.unit === 'CNY' ? '¥' : meter.unit}${Number(meter.amount ?? meter.remaining).toFixed(2)}` : `${Math.round(meter.remaining)}%`;
// 百分比窗口只有带真实总量时才展示“剩 X / Y”；总量缺失、为 0 或就是 100 的纯百分比占位不算
const hasRealQuotaNumbers = (amount, limit, unit = '%') => {
  const a = Number(amount);
  const l = Number(limit);
  if (!Number.isFinite(a) || !Number.isFinite(l) || l <= 0) return false;
  if ((unit || '%') === '%' && l === 100) return false;
  return true;
};
// “已用 / 总量”明细只在窗口真的带有具体数值时展示
const formatQuotaDetail = (meter) => {
  if (meter.unit !== '%' || !hasRealQuotaNumbers(meter.amount, meter.limitAmount, meter.unit)) return '';
  const amount = Number(meter.amount);
  const limit = Number(meter.limitAmount);
  return `已用 ${Math.max(0, limit - amount).toFixed(2)} / ${limit.toFixed(2)}`;
};
const reorderById = (list, fromId, toId) => {
  if (!fromId || !toId || fromId === toId) return list;
  const from = list.findIndex((item) => item.id === fromId);
  const to = list.findIndex((item) => item.id === toId);
  if (from < 0 || to < 0) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

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
// 厂商参与浪费统计的周期窗口：与主进程 electron/waste.cjs 的 resolveWasteWindows 保持一致
const resolveWasteWindows = (requestConfig) => {
  if (Array.isArray(requestConfig?.wasteWindows)) return requestConfig.wasteWindows;
  return (requestConfig?.windows || []).filter((key) => ['weekly', 'monthly'].includes(key));
};
// CLI 官方订阅（Claude / Codex / Gemini / Kimi / Grok 订阅 / GitHub Copilot / Grok Bot）：账号统一走「导入订阅登录」收录，不走普通添加表单
const CLI_ADAPTER_MODES = ['claude', 'codex', 'gemini', 'kimi', 'grok', 'copilot', 'grokbot'];
const isCliProvider = (provider) => CLI_ADAPTER_MODES.includes(provider?.requestConfig?.adapterMode || provider?.adapter);
const BUILTIN_API_KEY_PROVIDERS = new Set(['zai', 'deepseek', 'minimax']);

// 令牌失效后可一键重新登录的订阅渠道：返回重登弹窗类型与入口文案（Kimi 扫码 / Grok 导入 / Copilot 设备码）
const reloginChannel = (provider) => {
  const mode = provider?.requestConfig?.adapterMode || provider?.adapter;
  if (provider?.id === 'kimi-subscription' || mode === 'kimi') return { kind: 'kimi', action: '重新扫码', title: 'Kimi 订阅令牌已失效，点击重新扫码登录' };
  if (provider?.id === 'grok' || mode === 'grok') return { kind: 'grok', action: '重新导入', title: 'Grok 令牌已失效，点击重新导入本机 CLI 登录' };
  if (provider?.id === 'grokbot' || mode === 'grokbot') return { kind: 'grok', action: '重新导入', title: 'Grok Bot 登录已失效，点击重新导入本机客户端登录' };
  if (provider?.id === 'copilot' || mode === 'copilot') return { kind: 'copilot', action: '重新授权', title: 'GitHub 授权已失效，点击重新设备码登录' };
  return null;
};
const providerVariableRequired = (provider, variable) => Boolean(variable?.required
  || (variable?.key === 'apiKey' && BUILTIN_API_KEY_PROVIDERS.has(provider?.id)));
const providerVariableDefinitions = (provider) => {
  const config = provider?.requestConfig || {};
  const custom = Array.isArray(config.variables) ? config.variables : [];
  if (config.adapterMode !== 'script') return custom;
  const system = [
    { key: 'endpoint', label: '额度接口路径', defaultValue: config.endpoint || '', required: true, secret: false, system: true },
    { key: 'apiKey', label: 'API Key', defaultValue: '', required: false, secret: true, system: true },
  ];
  const merged = [...system, ...custom];
  return merged
    .filter((item, index, list) => list.findIndex((candidate) => candidate.key === item.key) === index)
    .map((item) => providerVariableRequired(provider, item) ? { ...item, required: true } : item);
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
// 账号请求超时（秒）：5–120 收敛，缺省 15（与主进程 poller 的 accountTimeoutMs 保持一致）
const clampAccountTimeout = (value) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(120, Math.max(5, Math.round(seconds))) : 15;
};
const normalizeSettings = (value = {}) => {
  const legacySize = { small: 240, medium: 280, large: 336 }[value.widgetSize];
  const byWidth = Number(value.widgetWidth) ? Number(value.widgetWidth) / WIDGET_BASE_SIZE.width : undefined;
  const pollNumber = Number(value.pollMinutes);
  return {
    alerts: true, pollMinutes: '5', widgetTagLimit: '2', reminderRules: defaultReminderRules,
    widget: true, widgetPreview: false, theme: 'dark', widgetScale: 0.9, widgetLength: 0.9, historyDays: 7,
    ...value,
    // 轮询间隔只提供 5–30 分钟；旧配置里更大的值收敛到 30，缺失或非法时回到默认 5
    pollMinutes: [5, 10, 15, 30].includes(pollNumber) ? String(pollNumber) : (pollNumber > 30 ? '30' : '5'),
    reminderRules: Array.isArray(value.reminderRules) ? value.reminderRules : defaultReminderRules,
    theme: value.theme === 'light' ? 'light' : 'dark',
    historyDays: [0, 3, 7, 15, 30, 60, 90].includes(Number(value.historyDays)) ? Number(value.historyDays) : 7,
    widgetScale: clampWidgetScale(value.widgetScale ?? byWidth ?? (legacySize ? legacySize / WIDGET_BASE_SIZE.width : 0.9)),
    widgetLength: clampWidgetLength(value.widgetLength ?? 0.9),
    proxyMode: ['direct', 'system', 'manual'].includes(value.proxyMode) ? value.proxyMode : 'system',
    proxyUrl: String(value.proxyUrl ?? ''),
    periodSort5hRemaining: clampRemainingWeight(value.periodSort5hRemaining),
    periodSortLongRemaining: clampRemainingWeight(value.periodSortLongRemaining),
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

// 厂商服务端历史与本地额度快照是两套独立数据源。每家厂商的接入方式不同：
// DeepSeek/MiniMax 走官方网页登录，Z.ai 复用账号 API Key，Codex 复用本机 CLI 登录；
// 布局保持一致，文案与指标按厂商实际能力有所取舍。这里同时检查 bridge 和后端公开
// 的连接状态，绝不拿本地 getHistory 数据拼装服务端用量。
const PROVIDER_USAGE_COPY = {
  // DeepSeek / MiniMax 需要网页登录（浏览器捕获 Cookie），有独立的连接卡片；
  // Z.ai / Codex 只用账号自身已有的凭据（API Key / CLI 快照），无额外操作——
  // 不显示开关，账号创建时自动连接，详情页直接出用量。
  deepseek: {
    display: 'DeepSeek',
    // 卡片较多，隐藏「当前连续」保持四卡布局
    hideCurrentStreak: true,
    loading: '查询最近 1 年的每日花费与 Token',
    connectHint: '登录 DeepSeek 官方账号后读取每日花费与 Token；登录凭据不会暴露给界面。',
    connectAction: '登录官方账号',
    connecting: '等待登录…',
    reauthLabel: '需要重新登录',
    reauthDetail: 'DeepSeek 官方登录已过期',
    reauthHint: '重新登录后即可继续读取 DeepSeek 服务端历史，不影响 API Key 余额巡检。',
    emptyHint: 'DeepSeek 已连接，但没有返回可绘制的每日金额或 Token。',
    editHint: '保存后打开 DeepSeek 官方登录，用于读取每日金额与 Token 历史',
    connectedToast: '已连接 DeepSeek 官方账号，可在历史详情查看每日用量',
    savedToast: '账号已保存，并已连接 DeepSeek 官方用量',
    saveAction: '保存并登录',
    connectedDetail: '可读取最近 1 年服务端历史',
    disconnectTitle: '断开 DeepSeek 官方账号',
  },
  zai: {
    display: 'Z.ai',
    loading: '查询最近 1 年的每日模型 Token 用量',
    reauthDetail: 'Z.ai API Key 无效或已过期',
    reauthHint: '在账号设置中更新 API Key 后即可继续读取 Z.ai 服务端历史。',
    emptyHint: 'Z.ai 已连接，但没有返回可绘制的每日 Token 用量。',
    savedToast: '账号已保存，并已连接 Z.ai 官方用量',
  },
  codex: {
    display: 'Codex',
    loading: '查询最近 1 年的每日 Token 用量',
    reauthDetail: 'Codex 本机登录已失效',
    reauthHint: '运行一次 Codex CLI 或重新导入登录快照后即可继续读取 Codex 服务端历史。',
    emptyHint: 'Codex 已连接，但暂时没有返回每日 Token 用量。',
    savedToast: '账号已保存，并已连接 Codex 官方用量',
  },
  minimax: {
    display: 'MiniMax',
    loading: '查询最近 1 年的每日账单与 Token',
    connectHint: '登录 MiniMax 开放平台后读取每日账单与 Token 用量；登录凭据不会暴露给界面。',
    connectAction: '登录官方账号',
    connecting: '等待登录…',
    reauthLabel: '需要重新登录',
    reauthDetail: 'MiniMax 官方登录已过期',
    reauthHint: '重新登录后即可继续读取 MiniMax 服务端历史，不影响 API Key 余额巡检。',
    emptyHint: 'MiniMax 已连接，但没有返回可绘制的每日账单或 Token。',
    editHint: '保存后打开 MiniMax 官方登录，用于读取每日账单与 Token 历史',
    connectedToast: '已连接 MiniMax 官方账号，可在历史详情查看每日用量',
    savedToast: '账号已保存，并已连接 MiniMax 官方用量',
    saveAction: '保存并登录',
    connectedDetail: '可读取最近 1 年服务端历史',
    disconnectTitle: '断开 MiniMax 官方账号',
  },
};
const providerUsageCopy = (provider) => PROVIDER_USAGE_COPY[provider?.id] || null;
const providerUsageSupported = (account, provider) => Boolean(providerUsageCopy(provider))
  && account?.usageConnection?.supported !== false
  && Boolean(window.quotaDesk?.getProviderUsage && window.quotaDesk?.connectProviderUsage && window.quotaDesk?.disconnectProviderUsage);
const providerUsageStatus = (account) => {
  const connection = account?.usageConnection || {};
  if (connection.status) return connection.status;
  if (connection.connected === true) return 'connected';
  return 'disconnected';
};
const providerUsageHasNumber = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const providerUsageHasMetric = (data, metric) => Array.isArray(data?.days)
  && data.days.some((day) => providerUsageHasNumber(day?.[metric]));
const formatProviderUsageCount = (value, compact = true) => {
  if (!providerUsageHasNumber(value)) return '—';
  return new Intl.NumberFormat('zh-CN', compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { maximumFractionDigits: 0 }).format(Number(value));
};
const formatProviderUsageDate = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[2]}/${match[3]}` : String(value || '—');
};
const providerUsageToday = (timezoneOffsetSec = 8 * 60 * 60) => {
  const shifted = new Date(Date.now() + Number(timezoneOffsetSec || 0) * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
};
// 服务端用量固定展示近 1 年（与主进程 deepSeekDateRange 的上限一致），不提供范围切换
const PROVIDER_USAGE_RANGE_DAYS = 365;

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

const durationOrder = { five_hour: 1, daily: 2, weekly: 3, monthly: 4, balance: 5 };
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
  const heading = <div className="section-heading"><div><h2>重置时间轴</h2></div><span className="section-count">{points.length ? `${points.length} 个重置点 · 滚轮或拖动查看` : '暂无重置点'}</span></div>;
  if (!points.length) return <section className="surface-section timeline-section">{heading}<div className="timeline-detail"><span className="timeline-detail-hint">暂无重置时间</span></div></section>;
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
    {heading}
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

function PriorityRow({ account, meter, provider, reminderRules, onOpenHistory }) {
  return <div className="priority-row clickable" role="button" tabIndex={0} title="点击查看额度趋势" onClick={() => onOpenHistory?.(account)} onKeyDown={(event) => { if (event.key === 'Enter') onOpenHistory?.(account); }}>
    <AccountIdentity account={account} provider={provider} />
    <div className="priority-meter"><div className="meter-track"><span className="meter-fill" style={{ width: `${meter.remaining}%` }} /></div><b>{formatAmount(meter)}</b></div>
    <div className="priority-reset"><Clock3 size={13} /><span>{formatReset(meter.resetAt)}</span><RuleMarks meter={meter} rules={reminderRules} /></div>
  </div>;
}

function PriorityView({ accounts, providers, reminderRules, onOpenHistory, sortWeights }) {
  const [collapsed, setCollapsed] = useState({});
  const grouped = useMemo(() => {
    const byWindow = new Map();
    accounts.flatMap((account) => (account.windows || []).map((meter) => ({ account, meter }))).forEach((row) => {
      if (!byWindow.has(row.meter.key)) byWindow.set(row.meter.key, []);
      byWindow.get(row.meter.key).push(row);
    });
    return [...byWindow.entries()]
      .sort(([a], [b]) => (durationOrder[a] || 9) - (durationOrder[b] || 9))
      .map(([key, rows]) => [key, rows.sort((a, b) => comparePriority(a, b, sortWeights))]);
  }, [accounts, sortWeights]);
  return <div className="view-stack">
    <ResetTimeline accounts={accounts} providers={providers} />
    {grouped.map(([key, rows]) => <section className="surface-section" key={key}>
      <div className="section-heading"><div><h2>{windowCatalog[key]?.label || key}</h2></div><span className="section-count">{rows.length} 个账号</span><button type="button" className="icon-button faint section-toggle" title={collapsed[key] ? '展开' : '收起'} onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}>{collapsed[key] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button></div>
      {!collapsed[key] && <div className="priority-list">{rows.map(({ account, meter }) => <PriorityRow key={`${account.id}-${meter.key}`} account={account} meter={meter} provider={providers.find((item) => item.id === account.providerId)} reminderRules={reminderRules} onOpenHistory={onOpenHistory} />)}</div>}
    </section>)}
  </div>;
}

function WindowsView({ accounts, providers, reminderRules, embedded = false, onOpenHistory, onRelogin }) {
  const sorted = useMemo(() => [...accounts].sort((a, b) => {
    const aReset = Math.min(...a.windows.map((m) => m.resetAt ? new Date(m.resetAt).getTime() : Infinity));
    const bReset = Math.min(...b.windows.map((m) => m.resetAt ? new Date(m.resetAt).getTime() : Infinity));
    return aReset - bReset;
  }), [accounts]);
  return <div className="view-stack">
    {!embedded && <section className="view-intro"><div><h1>所有额度窗口</h1><p>每个账号只占一行，窗口和刷新时间始终放在一起。</p></div><span className="sort-note"><SlidersHorizontal size={15} /> 按最近刷新排序</span></section>}
    <section className="surface-section windows-section">
      <div className="windows-column-head"><span>账号</span><span>剩余进度</span><span>状态</span></div>
      <div className="windows-list">{sorted.map((account) => {
        const provider = providers.find((item) => item.id === account.providerId);
        const relogin = account.authStatus === 'reauth_required' ? reloginChannel(provider) : null;
        return <div className="account-window-row clickable" key={account.id} role="button" tabIndex={0} title="点击查看额度趋势" onClick={() => onOpenHistory?.(account)} onKeyDown={(event) => { if (event.key === 'Enter') onOpenHistory?.(account); }}>
          <div className="account-side"><AccountIdentity account={account} provider={provider} /><div className={`account-status ${account.status}`}><span className="status-dot" />{account.status === 'warning' ? '需处理' : '正常'}<small>{formatChecked(account.lastChecked)}</small></div>{relogin && <button type="button" className="text-button relogin-link" title={relogin.title} onClick={(event) => { event.stopPropagation(); onRelogin?.(account); }}><RefreshCw size={11} />{relogin.action}</button>}<AccountRuleMarks account={account} rules={reminderRules} /></div>
          <div className="account-meters">{account.windows.map((meter) => <MeterBar key={meter.key} meter={meter} />)}</div>
        </div>;
      })}</div>
    </section>
  </div>;
}

// 额度历史折线图：横轴时间、纵轴剩余额度（百分比窗口取 remaining，余额窗口取 amount），每个窗口维度一条线
const CHART_COLORS = { five_hour: 'var(--cyan)', daily: 'var(--sky)', weekly: 'var(--violet)', monthly: 'var(--coral)', balance: 'var(--green)', gemini_pro: 'var(--sky)', gemini_flash: 'var(--cyan)', gemini_flash_lite: 'var(--green-deep)' };
const CHART_FALLBACK_COLORS = ['var(--cyan)', 'var(--violet)', 'var(--coral)', 'var(--green)', 'var(--sky)'];
const chartColor = (key, index) => CHART_COLORS[key] || CHART_FALLBACK_COLORS[index % CHART_FALLBACK_COLORS.length];
const chartValue = (sample) => sample.unit === '%' ? sample.remaining : Number(sample.amount ?? sample.remaining);
const formatChartValue = (sample, value) => sample.unit === '%' ? `${Math.round(value)}%` : `${sample.unit === 'CNY' ? '¥' : sample.unit}${Number(value).toFixed(2)}`;
const formatChartNumber = (value) => Number.isInteger(value) ? String(value) : Number(value).toFixed(2);
// 悬停详情：百分比之外带上具体数值（剩余 / 总量）；与卡片明细同规则，纯百分比窗口（总量缺失、为 0 或就是 100）没有额外数值，不显示
const formatChartDetail = (sample) => {
  const base = formatChartValue(sample, chartValue(sample));
  if (sample.unit !== '%' || !hasRealQuotaNumbers(sample.amount, sample.limit, sample.unit)) return base;
  return `${base} · 剩 ${formatChartNumber(sample.amount)} / ${formatChartNumber(sample.limit)}`;
};
const formatChartStamp = (at) => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
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
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins ? `${hours}h${mins}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const DAY_MS = 86_400_000;
const RANGE_PRESETS = [
  { id: 'all', label: '全部', ms: null },
  { id: '1d', label: '1天', ms: DAY_MS },
  { id: '7d', label: '7天', ms: 7 * DAY_MS },
  { id: '1m', label: '1个月', ms: 30 * DAY_MS },
];
const presetView = (rangeMs, fullStart, fullEnd) => {
  const fullSpan = Math.max(1, fullEnd - fullStart);
  if (!rangeMs || fullEnd <= fullStart) return null;
  const span = Math.min(rangeMs, fullSpan);
  if (span >= fullSpan - 1000) return null;
  return { start: fullEnd - span, end: fullEnd };
};
const rangeAvailable = (rangeMs, fullStart, fullEnd) => rangeMs == null || fullEnd - fullStart >= rangeMs - 60_000;
const matchRangeKey = (next, fullStart, fullEnd) => {
  const fullSpan = Math.max(1, fullEnd - fullStart);
  if (!next || next.end - next.start >= fullSpan - 60_000) return 'all';
  const span = next.end - next.start;
  for (const preset of RANGE_PRESETS) {
    if (preset.ms == null || !rangeAvailable(preset.ms, fullStart, fullEnd)) continue;
    if (Math.abs(span - preset.ms) <= Math.max(90_000, preset.ms * 0.03)) return preset.id;
  }
  return null;
};

function UsageChart({ points, hiddenKeys = [], rangeKey = '1d', onRangeKeyChange }) {
  const [hover, setHover] = useState(null);
  // 断线区间（无数据时段）的悬停提示：{ from, to } 为区间前后两个数据点的时间
  const [hoverGap, setHoverGap] = useState(null);
  // 自定义窗口：滚轮 / 平移后不再属于任一预设时使用；选中预设时忽略此值
  const [view, setView] = useState(null);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const W = 470; const H = 184;
  const PAD = { l: 36, r: 12, t: 14, b: 24 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const { allKeys, samples, allPercent, fullStart, fullEnd, breakGapMs } = useMemo(() => {
    const keys = [...new Set(points.flatMap((point) => Object.keys(point.windows || {})))]
      .sort((a, b) => (durationOrder[a] || 9) - (durationOrder[b] || 9));
    // 抽样上限放宽到 2000，滚轮放大后仍能看清细节
    const stride = Math.max(1, Math.ceil(points.length / 2000));
    const sampled = points.filter((_point, index) => index % stride === 0 || index === points.length - 1);
    const percentOnly = keys.every((key) => sampled.every((point) => !point.windows?.[key] || point.windows[key].unit === '%'));
    // 断线阈值 = 2 倍采样中位间隔且至少 10 分钟：默认 5 分钟轮询时正好 10 分钟，选了更长轮询间隔的账号按自身节奏放宽
    const times = sampled.map((point) => new Date(point.at).getTime());
    const gaps = times.slice(1).map((at, index) => at - times[index]).filter((gap) => gap > 0).sort((a, b) => a - b);
    const medianGap = gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)] : 5 * 60_000;
    return {
      allKeys: keys, samples: sampled, allPercent: percentOnly,
      fullStart: sampled.length ? new Date(sampled[0].at).getTime() : 0,
      fullEnd: sampled.length ? new Date(sampled[sampled.length - 1].at).getTime() : 0,
      breakGapMs: Math.max(medianGap * 2, 10 * 60_000),
    };
  }, [points]);
  const rangeMs = RANGE_PRESETS.find((item) => item.id === rangeKey)?.ms;
  // 有自定义窗口（滚轮 / 平移）时用它；否则按当前档位贴到最新一端
  const shown = view ?? presetView(rangeMs, fullStart, fullEnd);
  const applyView = (next) => {
    setView(next);
    onRangeKeyChange?.(matchRangeKey(next, fullStart, fullEnd));
  };
  useEffect(() => {
    if (rangeMs != null && !rangeAvailable(rangeMs, fullStart, fullEnd)) onRangeKeyChange?.('all');
  }, [rangeMs, fullStart, fullEnd]);
  // React 根节点上的 wheel 监听是 passive 的，必须自己绑非 passive 监听才能 preventDefault
  useEffect(() => {
    const el = svgRef.current;
    if (!el || samples.length < 2) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (((event.clientX - rect.left) / rect.width) * W - PAD.l) / innerW));
      const fullSpan = Math.max(1, fullEnd - fullStart);
      const cur = shown || { start: fullStart, end: fullEnd };
      const curSpan = cur.end - cur.start;
      const factor = event.deltaY > 0 ? 1.3 : 1 / 1.3;
      const minSpan = Math.min(fullSpan, Math.max(10 * 60_000, fullSpan / 50));
      const nextSpan = Math.min(fullSpan, Math.max(minSpan, curSpan * factor));
      if (Math.abs(nextSpan - curSpan) < 1000) return;
      const anchor = cur.start + curSpan * ratio;
      const nextStart = Math.min(Math.max(fullStart, anchor - nextSpan * ratio), fullEnd - nextSpan);
      applyView(nextSpan >= fullSpan ? null : { start: nextStart, end: nextStart + nextSpan });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fullStart, fullEnd, samples.length, shown?.start, shown?.end]);
  // 图例开关：隐藏的线不参与绘制；兜底不允许全部隐藏
  const seriesKeys = allKeys.filter((key) => !hiddenKeys.includes(key));
  const visibleKeys = seriesKeys.length ? seriesKeys : allKeys;
  if (!allKeys.length || !samples.length) return <div className="settings-empty chart-empty">历史记录里没有可绘制的额度窗口</div>;
  const start = shown?.start ?? fullStart;
  const end = shown?.end ?? fullEnd;
  const span = Math.max(1, end - start);
  const ranged = samples.filter((point) => { const at = new Date(point.at).getTime(); return at >= start && at <= end; });
  const drawn = ranged.length ? ranged : samples;
  const single = samples.length === 1;
  const toX = (at) => PAD.l + (single ? innerW / 2 : ((at - start) / span) * innerW);
  const values = drawn.flatMap((point) => visibleKeys.map((key) => point.windows?.[key]).filter(Boolean).map(chartValue));
  // 纵轴随可见折线的实际范围自适应（例如只剩 30% 附近的 5 小时线时不必再顶到 100%）；百分比窗口的上下限夹在 0–100 之间
  const yMin = values.length ? Math.min(...values) : 0;
  const yMax = values.length ? Math.max(...values) : (allPercent ? 100 : 1);
  const yPad = Math.max((yMax - yMin) * 0.15, allPercent ? 5 : Math.max(yMax * 0.02, 1));
  const yLo = allPercent ? Math.max(0, yMin - yPad) : yMin - yPad;
  const yHi = allPercent ? Math.min(100, yMax + yPad) : yMax + yPad;
  const toY = (value) => PAD.t + (1 - (value - yLo) / Math.max(1e-9, yHi - yLo)) * innerH;
  const paths = visibleKeys.map((key) => {
    const segments = [];
    let current = '';
    for (let index = 0; index < drawn.length; index++) {
      const point = drawn[index];
      const sample = point.windows?.[key];
      // 与上一点的间隔超过断线阈值（程序关闭等无数据时段）时断开，不强行连线
      const gapFromPrev = index > 0 ? new Date(point.at).getTime() - new Date(drawn[index - 1].at).getTime() : Infinity;
      if (!sample || gapFromPrev > breakGapMs) { if (current) { segments.push(current); current = ''; } if (!sample) continue; }
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
  // 悬停：8px 内吸附到最近数据点；落在断线区间（无数据时段）时给出“暂无数据”提示；其余情况沿用最近点
  const moveHover = (clientX) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !drawn.length) return;
    const x = ((clientX - rect.left) / rect.width) * W;
    const ats = drawn.map((point) => new Date(point.at).getTime());
    let best = 0;
    let bestDistance = Infinity;
    ats.forEach((at, index) => {
      const distance = Math.abs(toX(at) - x);
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    });
    if (bestDistance <= 8) { setHover(best); setHoverGap(null); return; }
    const t = start + ((x - PAD.l) / innerW) * span;
    const gapIndex = ats.findIndex((at, index) => index < ats.length - 1 && t > at && t < ats[index + 1] && ats[index + 1] - at > breakGapMs);
    if (gapIndex >= 0) { setHover(null); setHoverGap({ from: ats[gapIndex], to: ats[gapIndex + 1] }); return; }
    setHover(best); setHoverGap(null);
  };
  const startPan = (event) => {
    const cur = shown;
    if (!cur) return;
    dragRef.current = { x: event.clientX, start: cur.start, end: cur.end };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const movePan = (event) => {
    const drag = dragRef.current;
    if (!drag) { moveHover(event.clientX); return; }
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewSpan = drag.end - drag.start;
    const shift = ((event.clientX - drag.x) / rect.width) * (W / innerW) * viewSpan;
    const nextStart = Math.min(Math.max(fullStart, drag.start - shift), fullEnd - viewSpan);
    applyView({ start: nextStart, end: nextStart + viewSpan });
    setHover(null);
  };
  const endPan = () => { dragRef.current = null; };
  const hoverPoint = hover == null ? null : drawn[hover];
  const hoverX = hoverPoint ? toX(new Date(hoverPoint.at).getTime()) : 0;
  const pickRange = (preset) => {
    if (!rangeAvailable(preset.ms, fullStart, fullEnd)) return;
    setView(presetView(preset.ms, fullStart, fullEnd));
    onRangeKeyChange?.(preset.id);
  };
  return <div className={`usage-chart ${shown ? 'zoomed' : ''}`}>
    <div className="chart-detail">
      <div className="chart-detail-main">{hoverPoint ? <>
        <b>{formatChartStamp(hoverPoint.at)}</b>
        {visibleKeys.map((key, index) => {
          const sample = hoverPoint.windows?.[key];
          if (!sample) return null;
          const reset = formatPointResetShort(sample.resetAt, hoverPoint.at);
          return <span className="chart-detail-item" key={key} title={[windowCatalog[key]?.label || key, formatChartDetail(sample), reset].filter(Boolean).join(' ')}><i style={{ background: chartColor(key, index) }} />{windowCatalog[key]?.short || key}<b>{formatChartDetail(sample)}</b>{reset && <small>{reset}</small>}</span>;
        })}
      </> : hoverGap ? <span className="chart-detail-hint">{formatChartStamp(hoverGap.from)} – {formatChartStamp(hoverGap.to)} · 该时段暂无数据</span> : <span className="chart-detail-hint">悬停查看该点的数值与重置时间</span>}</div>
      <div className="range-control" role="group" aria-label="趋势时间范围" onPointerDown={(event) => event.stopPropagation()}>
        {RANGE_PRESETS.map((preset) => {
          const available = rangeAvailable(preset.ms, fullStart, fullEnd);
          return <button type="button" key={preset.id} className={rangeKey === preset.id ? 'active' : ''} disabled={!available} title={available ? preset.label : `历史不足 ${preset.label}`} onClick={() => pickRange(preset)}>{preset.label}</button>;
        })}
      </div>
    </div>
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onMouseLeave={() => { setHover(null); setHoverGap(null); endPan(); }}>
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
    {samples.length > 1 && <div className="chart-tools"><span className="chart-hint">滚轮缩放 · 放大后拖动平移</span></div>}
  </div>;
}

// ── 浪费统计视图 ──
// 周期档案的 from/end/observedAt 都是 ISO 字符串，展示时只取 MM/DD
const formatWasteDay = (iso) => { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`; };
// 由重置时间反推周期起点（仅用于展示区间）：周 = 前 7 天，月 = 前一个月
const wasteCycleStart = (endIso, windowKey) => {
  const date = new Date(endIso);
  if (windowKey === 'monthly') date.setMonth(date.getMonth() - 1);
  else date.setDate(date.getDate() - 7);
  return date.toISOString();
};
// 失真周期的时间缺口：距重置约 X
const formatWasteGap = (gapMs) => {
  const minutes = Math.round(Number(gapMs) / 60000);
  if (!Number.isFinite(minutes) || minutes < 60) return `${Math.max(1, minutes || 0)} 分钟`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.round(minutes / (24 * 60))} 天`;
};

// 浪费统计视图：每根柱子是一个周期区间（最新在右），柱高 = 周期末剩余百分比（即浪费率）
function WasteView({ account, wasteWindows }) {
  const [cycles, setCycles] = useState(null);
  const [curWindow, setCurWindow] = useState(wasteWindows[0]);
  const [hover, setHover] = useState(null);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef(null);
  const dragRef = useRef(null);
  useEffect(() => {
    let active = true;
    // 网页演示模式没有周期档案接口，直接降级为空状态
    if (!window.quotaDesk?.getCycles) { setCycles([]); return undefined; }
    window.quotaDesk.getCycles(account.id).then((rows) => { if (active) setCycles(rows || []); }).catch(() => { if (active) setCycles([]); });
    return () => { active = false; };
  }, [account.id, account.lastChecked]);
  // 厂商配置变化时收敛到第一个可统计窗口
  useEffect(() => { if (!wasteWindows.includes(curWindow)) setCurWindow(wasteWindows[0]); }, [wasteWindows, curWindow]);
  const windowCycles = useMemo(() => (cycles || []).filter((cycle) => cycle.window === curWindow)
    .sort((a, b) => new Date(a.end).getTime() - new Date(b.end).getTime()), [cycles, curWindow]);
  // 进行中的当前周期：来自实时额度数据，不在周期档案里；停用账号的实时数据冻结在停用时刻，
  // resetAt 已成过去时，不能当成“进行中”展示
  const meter = (account.windows || []).find((item) => item.key === curWindow);
  const nowCycle = useMemo(() => (meter?.resetAt && !account.disabled ? {
    now: true, remaining: Math.max(0, Math.min(100, Math.round(meter.remaining))),
    from: wasteCycleStart(meter.resetAt, curWindow), end: meter.resetAt,
  } : null), [meter, curWindow, account.disabled]);
  const shown = useMemo(() => [...windowCycles, ...(nowCycle ? [nowCycle] : [])], [windowCycles, nowCycle]);
  // 只有可靠的完整自然周期计入统计；失真周期的浪费值只是上界，提前重置的周期不完整
  const good = windowCycles.filter((cycle) => cycle.reliable && cycle.kind === 'natural');
  const avg = good.length ? good.reduce((sum, cycle) => sum + cycle.remaining, 0) / good.length : null;
  const total = good.reduce((sum, cycle) => sum + cycle.remaining, 0) / 100;
  const empty = cycles !== null && windowCycles.length === 0;
  // 周期过多出现横向滚动时，默认停在最右侧（最新周期）
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollLeft = el.scrollWidth; }, [shown.length, curWindow]);
  // 周期展示起点：归档的 from 是首次观测时间，应用中途开始记录时会晚于真实起点；
  // 自然到期的周期真实起点 = 结束时刻 − 周期长度，两者取较早者展示（提前重置的周期起点不可考，沿用观测值）
  const displayFrom = (cycle) => {
    if (cycle.kind !== 'natural') return cycle.from;
    const derived = wasteCycleStart(cycle.end, curWindow);
    return new Date(cycle.from).getTime() <= new Date(derived).getTime() ? cycle.from : derived;
  };
  // 单行详情条内容：按周期形态（进行中 / 提前重置 / 失真 / 可靠）组织
  const renderDetail = (cycle) => {
    const range = `${formatWasteDay(displayFrom(cycle))} → ${formatWasteDay(cycle.end)}`;
    if (cycle.now) return <>
      <span className="when">{range}（进行中）</span>
      <span>剩余 <b>{cycle.remaining}%</b> 未用</span>
      <span>{formatResetCompact(cycle.end)} 后重置 · 记录 {formatChartStamp(account.lastChecked)}</span>
    </>;
    const observed = <span>记录于 <b>{formatChartStamp(cycle.observedAt)}</b></span>;
    const amount = hasRealQuotaNumbers(cycle.amount, cycle.limit) ? <span>剩 <b>{formatChartNumber(cycle.amount)} / {formatChartNumber(cycle.limit)}</b></span> : null;
    if (cycle.kind === 'early') return <><span className="when">{range} 周期</span><span className="warn">⚡ 厂商提前重置：剩余 {Math.round(cycle.remaining)}% 被清零</span>{observed}</>;
    if (!cycle.reliable) return <><span className="when">{range} 周期</span><span>浪费 <b>≤{Math.round(cycle.remaining)}%</b></span>{amount}{observed}<span className="warn">可能失真：距重置约 {formatWasteGap(cycle.gapMs)}</span></>;
    return <><span className="when">{range} 周期</span><span>浪费 <b>{Math.round(cycle.remaining)}%</b></span>{amount}{observed}</>;
  };
  // 周期过多柱宽触底时横向拖动平移
  const startDrag = (event) => { const el = scrollRef.current; if (!el) return; dragRef.current = { x: event.clientX, left: el.scrollLeft }; el.setPointerCapture?.(event.pointerId); setDragging(true); };
  const moveDrag = (event) => { const drag = dragRef.current; if (!drag || !scrollRef.current) return; scrollRef.current.scrollLeft = drag.left - (event.clientX - drag.x); };
  const endDrag = () => { dragRef.current = null; setDragging(false); };
  const softColor = `color-mix(in srgb, ${CHART_COLORS[curWindow] || 'var(--violet)'} 30%, transparent)`;
  // 柱子少时每根都标完整区间；多了只标结束日期并按需抽稀，避免文字挤在一起
  const compactLabels = shown.length <= 6;
  const labelStep = Math.max(1, Math.ceil(shown.length / 12));
  return <div className="waste-view">
    <div className="waste-row">
      {wasteWindows.length >= 2
        ? <div className="seg-control">{wasteWindows.map((key) => <button type="button" key={key} className={curWindow === key ? 'active' : ''} onClick={() => setCurWindow(key)}>{windowCatalog[key]?.label || key} 额度</button>)}</div>
        : <span className="waste-label">{windowCatalog[curWindow]?.label || curWindow} 额度 · 浪费统计</span>}
      <span className="waste-stats">{windowCycles.length ? <>
        <span>{windowCycles.length} 个周期</span><span>平均浪费 <b>{avg != null ? `${avg.toFixed(0)}%` : '—'}</b>（{good.length} 可靠）</span>{good.length ? <span>累计 <b>{Math.round(total * 100) / 100}</b> 倍额度</span> : <span>累计 —</span>}
      </> : <><span>0 个周期</span><span>平均浪费 —</span><span>累计 —</span></>}</span>
    </div>
    <div className="chart-detail waste-detail">{hover ? renderDetail(hover) : <span className="chart-detail-hint">{empty ? '悬停查看当前周期详情' : '悬停查看周期详情 · 周期过多时可左右拖动'}</span>}</div>
    <div className={`waste-scroll${dragging ? ' dragging' : ''}`} ref={scrollRef} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onPointerLeave={endDrag}>
      <div className={`waste-plot ${curWindow === 'monthly' ? 'mo' : 'wk'}`}>
        {!empty && [25, 50, 75].map((value) => <div key={value} className="waste-gridline" style={{ bottom: `${value}%` }} />)}
        {!empty && avg != null && <div className="waste-avg" style={{ bottom: `${Math.min(100, avg)}%` }}><em>平均 {avg.toFixed(0)}%</em></div>}
        {empty && !nowCycle && <div className="waste-empty-hint"><span>还没有已完成的周期</span><span>第一个周期重置后自动生成统计</span></div>}
        {shown.map((cycle, index) => {
          const classes = ['waste-col', cycle.now ? 'now' : cycle.kind === 'early' ? 'early' : !cycle.reliable ? 'bad' : '', hover === cycle ? 'hot' : ''].filter(Boolean).join(' ');
          const tip = `${formatWasteDay(displayFrom(cycle))} → ${formatWasteDay(cycle.end)}${cycle.now ? '（进行中）' : ` · 浪费 ${Math.round(cycle.remaining)}%`}`;
          return <div key={cycle.now ? 'now' : `${cycle.end}-${index}`} className={classes} title={tip} onMouseEnter={() => setHover(cycle)} onMouseLeave={() => setHover(null)}>
            <div className="waste-bar" style={{ height: `${Math.max(2, Math.min(100, cycle.remaining))}%` }} />
          </div>;
        })}
      </div>
      <div className={`waste-x-labels ${curWindow === 'monthly' ? 'mo' : 'wk'}`}>
        {shown.map((cycle, index) => <span key={cycle.now ? 'now' : `${cycle.end}-${index}`} className="waste-x-cell">{index % labelStep === 0 ? (compactLabels ? `${formatWasteDay(displayFrom(cycle))}→${formatWasteDay(cycle.end)}` : formatWasteDay(cycle.end)) : ''}</span>)}
      </div>
    </div>
    <div className="chart-legend waste-legend">{empty
      ? <span><i className="swatch-now" />进行中</span>
      : <>
        <span><i style={{ background: CHART_COLORS[curWindow] }} />浪费率</span>
        <span><i style={{ background: `repeating-linear-gradient(-45deg, ${softColor} 0 3px, transparent 3px 6px)`, border: '1px solid var(--line-strong)' }} />可能失真</span>
        <span><i className="swatch-early" />提前重置</span>
        <span><i className="swatch-now" />进行中</span>
        <span className="legend-right">{windowCycles.length - good.length} 个周期不计入平均</span>
      </>}</div>
  </div>;
}

// 厂商控制台的逐日用量。默认按金额着色；只有服务端同时返回 Token 数据时才
// 开放切换。每一格都来自 usage:get 的 days，和本地轮询历史完全隔离。
function ProviderUsageView({ account, provider, onState }) {
  const bridge = window.quotaDesk;
  const reportedStatus = providerUsageStatus(account);
  const supported = providerUsageSupported(account, provider);
  const [status, setStatus] = useState(reportedStatus);
  const [data, setData] = useState(null);
  const [empty, setEmpty] = useState(false);
  const [selectedDate, setSelectedDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const heatmapRef = useRef(null);
  const forceNextRequest = useRef(false);

  useEffect(() => {
    setStatus(reportedStatus);
    setData(null);
    setEmpty(false);
    setSelectedDate('');
  }, [account.id, reportedStatus]);

  useEffect(() => {
    if (!supported || status !== 'connected') return undefined;
    let active = true;
    const force = forceNextRequest.current;
    forceNextRequest.current = false;
    setLoading(true);
    setError('');
    bridge.getProviderUsage(account.id, { days: PROVIDER_USAGE_RANGE_DAYS, force }).then((result) => {
      if (!active) return;
      // provider 字段是服务端适配器的来源声明；未来契约若提供显式
      // supported / connected，也一并尊重，绝不在后端拒绝时误展示。
      const responseSupported = result?.supported ?? result?.capability?.supported;
      const responseConnected = result?.connected ?? result?.connection?.connected;
      const fromExpectedProvider = result?.provider === provider?.id;
      const hasCost = providerUsageHasMetric(result, 'cost');
      const hasTokens = providerUsageHasMetric(result, 'tokens');
      if (!fromExpectedProvider || responseSupported === false || responseConnected === false || (!hasCost && !hasTokens)) {
        setData(null);
        setEmpty(true);
        return;
      }
      setData(result);
      setEmpty(false);
      const resultDays = [...(result.days || [])]
        .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day?.date || '')))
        .sort((left, right) => left.date.localeCompare(right.date));
      const today = providerUsageToday(result.coverage?.timezoneOffsetSec);
      setSelectedDate((old) => resultDays.some((day) => day.date === old)
        ? old
        : (resultDays.find((day) => day.date === today)?.date || resultDays[resultDays.length - 1]?.date || ''));
    }).catch((usageError) => {
      if (!active) return;
      const message = usageError?.message || '读取厂商用量失败';
      setError(message);
      if (/AUTH_|登录已失效|尚未连接|重新连接/.test(message)) setStatus('reauth_required');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account.id, bridge, provider?.id, reloadKey, status, supported]);

  // 服务端返回的逐日数据：只保留合法日期并按时间排序，后面所有展示都基于这一份
  const sortedDays = useMemo(() => [...(data?.days || [])]
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day?.date || '')))
    .sort((left, right) => left.date.localeCompare(right.date)), [data]);
  // 热力图列数（周数）：首行按第一天的星期补空位，与渲染时的铺格规则一致
  const weekCount = useMemo(() => {
    if (!sortedDays.length) return 1;
    const first = String(sortedDays[0].date).split('-').map(Number);
    const leading = (new Date(Date.UTC(first[0], first[1] - 1, first[2])).getUTCDay() + 6) % 7;
    return Math.ceil((leading + sortedDays.length) / 7);
  }, [sortedDays]);
  // 近 1 年热力图整幅铺满：列宽由容器宽度决定（无缝排列），行高吃满剩余纵向空间
  // （方格优先，富余时最多加高到列宽的 1.4 倍），整块热力图约占视图 40%，与参考图同比例
  const heatmapWrapRef = useRef(null);
  const [cellPx, setCellPx] = useState(8);
  const [cellH, setCellH] = useState(8);
  useEffect(() => {
    const el = heatmapWrapRef.current;
    if (!el) return undefined;
    const measure = () => {
      // 可用宽度 = 容器 clientWidth − 自身左右 padding(4×2) − 星期列(10) − 星期列与网格的列间距(7)
      const avail = el.clientWidth - 8 - 10 - 7;
      const w = Math.min(12, Math.max(5, Math.floor(avail / weekCount)));
      // 可用高度 = clientHeight − 上下 padding(5×2) − 边框(2) − 月份行(10) − 行距(3)
      const h = Math.min(Math.round(w * 1.75), Math.max(w, Math.floor((el.clientHeight - 10 - 2 - 10 - 3) / 7)));
      setCellPx(w);
      setCellH(h);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [weekCount]);

  const refreshUsage = () => {
    forceNextRequest.current = true;
    setReloadKey((value) => value + 1);
  };

  const connect = async () => {
    if (!bridge?.connectProviderUsage || connecting) return;
    setConnecting(true);
    setError('');
    try {
      const result = await bridge.connectProviderUsage(account.id);
      if (result?.cancelled) { setError('未完成官方账号登录，服务端用量仍未连接'); return; }
      if (result?.state) onState?.(result.state);
      setStatus(result?.connection?.status || 'connected');
      refreshUsage();
    } catch (connectError) { setError(connectError?.message || '连接官方账号失败'); }
    finally { setConnecting(false); }
  };

  if (!supported) return null;
  const copy = providerUsageCopy(provider) || PROVIDER_USAGE_COPY.deepseek;
  if (status === 'disconnected') return <div className="provider-usage-state connect-guide">
    <span className="provider-usage-state-icon"><Globe size={18} /></span>
    <div><b>连接 {copy.display} 官方用量</b><small>{copy.connectHint}</small>{error && <em>{error}</em>}</div>
    <button type="button" className="primary-button" disabled={connecting} onClick={connect}><Globe size={13} />{connecting ? copy.connecting : copy.connectAction}</button>
  </div>;
  if (status === 'reauth_required') return <div className="provider-usage-state auth-required">
    <span className="provider-usage-state-icon"><AlertCircle size={18} /></span>
    <div><b>官方用量连接已失效</b><small>{account.usageConnection?.lastError || copy.reauthHint}</small>{error && <em>{error}</em>}</div>
    <button type="button" className="primary-button" disabled={connecting} onClick={connect}><Globe size={13} />{connecting ? copy.connecting : '重新连接'}</button>
  </div>;
  if (loading && !data) return <div className="provider-usage-state"><RefreshCw size={17} className="spinning" /><div><b>正在读取 {copy.display} 服务端用量</b><small>{copy.loading}</small></div></div>;
  if ((error || empty) && !data) return <div className="provider-usage-state">
    <span className="provider-usage-state-icon"><History size={18} /></span>
    <div><b>{error ? '服务端用量暂时不可用' : '这个区间没有厂商历史数据'}</b><small>{error || copy.emptyHint}</small></div>
    <button type="button" className="outline-button" disabled={loading} onClick={refreshUsage}><RefreshCw size={13} /> 重试</button>
  </div>;
  if (!data) return null;

  const hasCost = providerUsageHasMetric(data, 'cost');
  const hasTokens = providerUsageHasMetric(data, 'tokens');
  // 参考图没有指标切换：热力图固定按金额着色，账号没有金额数据时才退回 Token
  const metric = hasCost ? 'cost' : 'tokens';
  // 花费卡片：DeepSeek 摘要的 totalCost 是账号累计花费；拿不到时退回区间累计
  const accountTotalCost = providerUsageHasNumber(data.summary?.totalCost) ? data.summary.totalCost : null;
  const rangeCostExact = providerUsageHasNumber(data.summary?.rangeCost) ? data.summary.rangeCost : null;
  const rangeCostKnown = providerUsageHasNumber(data.summary?.knownRangeCost) ? data.summary.knownRangeCost : null;
  const costTotal = accountTotalCost != null
    ? accountTotalCost
    : (data.coverage?.cost?.complete && rangeCostExact != null ? rangeCostExact : rangeCostKnown);
  const costLabel = accountTotalCost != null ? '累计花费' : '区间花费';
  // Token 口径：部分厂商摘要直接提供账号累计（totalTokens）；否则退回区间口径，
  // 覆盖不完整时如实标注
  const accountTotalTokens = providerUsageHasNumber(data.summary?.totalTokens) ? data.summary.totalTokens : null;
  const tokensExact = providerUsageHasNumber(data.summary?.rangeTokens) ? data.summary.rangeTokens : null;
  const tokensKnown = providerUsageHasNumber(data.summary?.knownRangeTokens) ? data.summary.knownRangeTokens : null;
  const tokensTotal = accountTotalTokens != null
    ? accountTotalTokens
    : (data.coverage?.tokens?.complete && tokensExact != null ? tokensExact : tokensKnown);
  const tokensLabel = accountTotalTokens != null || (data.coverage?.tokens?.complete && tokensExact != null) ? '累计消耗 Token' : '已覆盖区间 Token';
  const values = sortedDays.map((day) => day[metric]).filter(providerUsageHasNumber).map(Number);
  const maxValue = Math.max(0, ...values);
  const firstDate = sortedDays[0]?.date;
  const firstParts = String(firstDate || '').split('-').map(Number);
  const leading = firstParts.length === 3
    ? (new Date(Date.UTC(firstParts[0], firstParts[1] - 1, firstParts[2])).getUTCDay() + 6) % 7
    : 0;
  const heatmapCells = [...Array(leading).fill(null), ...sortedDays];
  const monthMarkers = [];
  let previousMonth = '';
  heatmapCells.forEach((day, index) => {
    if (!day) return;
    const month = day.date.slice(0, 7);
    if (month === previousMonth) return;
    previousMonth = month;
    monthMarkers.push({ key: month, label: `${Number(month.slice(5))}月`, column: Math.floor(index / 7) + 1 });
  });
  const selectedDay = sortedDays.find((day) => day.date === selectedDate) || null;
  const selectedIndex = selectedDay ? sortedDays.indexOf(selectedDay) : -1;
  // 详情标签：默认（今天）叫「当日」，切到其他日子显示具体日期 + 空格（当日花费 / 2026-05-14 花费）
  const today = providerUsageToday(data.coverage?.timezoneOffsetSec);
  const dayLabel = selectedDay && selectedDay.date === today ? '当日' : `${selectedDay?.date || ''} `;
  const valueLabel = (day, selectedMetric = metric) => selectedMetric === 'cost'
    ? formatProviderUsageCost(day?.cost, day?.currency || data.currency)
    : `${formatProviderUsageCount(day?.tokens, false)} Token`;
  // 热力图深度分级：基于重度 Coding Agent 用户的真实量级（日均 2000万-6000万 Token）
  // 固定阈值让颜色深度反映绝对使用量，不同天之间能看出明显波动
  const levelOf = (day) => {
    if (!providerUsageHasNumber(day?.[metric])) return 'missing';
    const value = Number(day[metric]);
    if (value <= 0) return '0';
    if (metric === 'tokens') {
      // Token 口径（日均）：< 1000万 轻度 | 1000-3000万 中度 | 3000-8000万 重度 | > 8000万 极重度
      if (value < 10_000_000) return '1';
      if (value < 30_000_000) return '2';
      if (value < 80_000_000) return '3';
      return '4';
    }
    // 金额口径（¥/天）：< ¥30 轻度 | ¥30-100 中度 | ¥100-250 重度 | > ¥250 极重度
    if (value < 30) return '1';
    if (value < 100) return '2';
    if (value < 250) return '3';
    return '4';
  };
  const dayAriaLabel = (day) => [
    day.date,
    providerUsageHasNumber(day.cost) ? `花费 ${valueLabel(day, 'cost')}` : '花费未覆盖',
    providerUsageHasNumber(day.tokens) ? `Token ${valueLabel(day, 'tokens')}` : 'Token 未覆盖',
    providerUsageHasNumber(day.requests) ? `请求 ${formatProviderUsageCount(day.requests, false)}` : null,
  ].filter(Boolean).join('，');
  // 方向键浏览热力图：上下 = 前后一天，左右 = 前后一周（列 = 周、行 = 星期一到日）
  const stepTo = (index) => {
    const next = sortedDays[Math.max(0, Math.min(sortedDays.length - 1, index))];
    if (!next) return;
    setSelectedDate(next.date);
    requestAnimationFrame(() => heatmapRef.current?.querySelector(`[data-usage-date="${next.date}"]`)?.focus());
  };
  const handleHeatmapKey = (event) => {
    if (!sortedDays.length) return;
    const base = selectedIndex >= 0 ? selectedIndex : sortedDays.length - 1;
    if (event.key === 'Home') { event.preventDefault(); stepTo(0); return; }
    if (event.key === 'End') { event.preventDefault(); stepTo(sortedDays.length - 1); return; }
    const delta = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    stepTo(base + delta);
  };

  // 统计卡片按厂商实际返回的指标组装：花费/Token/套餐/连续使用按需出现，活跃日固定收尾
  const planName = typeof data.summary?.planName === 'string' && data.summary.planName.trim() ? data.summary.planName.trim() : null;
  // 连续天数：优先用厂商接口的账号级口径（如 Z.ai）；接口不提供时按逐日数据本地计算
  const computedStreaks = computeUsageStreaks(sortedDays);
  const streakDays = providerUsageHasNumber(data.summary?.currentStreakDays) ? Number(data.summary.currentStreakDays) : computedStreaks.current;
  const longestStreak = providerUsageHasNumber(data.summary?.longestStreakDays) ? Number(data.summary.longestStreakDays) : computedStreaks.longest;
  const peakTokens = providerUsageHasNumber(data.summary?.peakDailyTokens) ? Number(data.summary.peakDailyTokens) : null;
  const peakCost = providerUsageHasNumber(data.summary?.peakDailyCost) ? Number(data.summary.peakDailyCost) : null;
  const peakIsCost = metric === 'cost' && peakCost !== null;
  const peakReady = peakIsCost || peakTokens !== null;
  const peakDate = typeof data.summary?.peakDailyTokensDate === 'string' && data.summary.peakDailyTokensDate ? data.summary.peakDailyTokensDate : null;
  const hasRequests = providerUsageHasMetric(data, 'requests');
  const summaryCards = [
    hasCost && <div key="cost" className="provider-stat cost" title={formatProviderUsageCost(costTotal, data.currency)}>
      <span className="stat-icon"><Zap size={13} /></span>
      <div className="stat-copy">
        <span>{costLabel}</span>
        <strong>{formatProviderUsageCost(costTotal, data.currency)}</strong>
      </div>
    </div>,
    hasTokens && <div key="tokens" className="provider-stat tokens" title={providerUsageHasNumber(tokensTotal) ? `${formatProviderUsageCount(tokensTotal, false)} Token` : ''}>
      <span className="stat-icon"><Bot size={13} /></span>
      <div className="stat-copy">
        <span>{tokensLabel}</span>
        <strong>{providerUsageHasNumber(tokensTotal) ? formatProviderUsageSummaryTokens(tokensTotal) : '—'}</strong>
      </div>
    </div>,
    peakReady && <div key="peak" className="provider-stat peak" title={peakDate && !peakIsCost ? `峰值日期 ${peakDate}` : '区间内单日最高消耗'}>
      <span className="stat-icon"><TrendingUp size={13} /></span>
      <div className="stat-copy">
        <span>{peakIsCost ? '峰值花费' : '峰值 Token'}</span>
        <strong>{peakIsCost ? formatProviderUsageCost(peakCost, data.currency) : formatProviderUsageSummaryTokens(peakTokens)}</strong>
      </div>
    </div>,
    streakDays !== null && !copy.hideCurrentStreak && <div key="streak" className="provider-stat streak" title="当前连续使用天数">
      <span className="stat-icon"><Flame size={13} /></span>
      <div className="stat-copy">
        <span>当前连续</span>
        <strong>{`${formatProviderUsageCount(streakDays, false)} 天`}</strong>
      </div>
    </div>,
    longestStreak !== null && <div key="longest" className="provider-stat longest" title="历史最长连续使用天数">
      <span className="stat-icon"><Trophy size={13} /></span>
      <div className="stat-copy">
        <span>最长连续</span>
        <strong>{`${formatProviderUsageCount(longestStreak, false)} 天`}</strong>
      </div>
    </div>,
  ].filter(Boolean);

  return <div className="provider-usage-view">
    <div className="provider-usage-summary">{summaryCards}</div>
    <div className="provider-heatmap-head">
      <span className="provider-heatmap-title">近 1 年使用热力图</span>
      <div className="provider-heatmap-legend" aria-hidden="true">
        <span>较少</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`provider-heatmap-cell level-${level}`} />)}<span>较多</span>
      </div>
    </div>
    <div className="provider-heatmap-scroll" role="grid" tabIndex={0} aria-label="近 1 年每日用量热力图，方向键选择日期" ref={heatmapWrapRef} onKeyDown={handleHeatmapKey}>
      <div className="provider-heatmap-board" ref={heatmapRef} style={{ '--hm-cell': `${cellPx}px`, '--hm-cell-h': `${cellH}px` }}>
        <span className="provider-heatmap-corner" aria-hidden="true" />
        <div className="provider-heatmap-months" aria-hidden="true" style={{ width: `${weekCount * cellPx}px` }}>{monthMarkers.map((item) => <span key={item.key} style={{ left: `${(item.column - 1) * cellPx}px` }}>{item.label}</span>)}</div>
        <div className="provider-heatmap-weekdays" aria-hidden="true"><span>一</span><span /><span>三</span><span /><span>五</span><span /><span>日</span></div>
        <div className="provider-heatmap-grid" role="rowgroup" aria-label={`${copy.display} 每日${metric === 'cost' ? '花费' : 'Token'}热力图`}>
          {heatmapCells.map((day, index) => day
            ? <button type="button" role="gridcell" key={day.date} data-usage-date={day.date} tabIndex={selectedDate === day.date ? 0 : -1} aria-selected={selectedDate === day.date} aria-label={dayAriaLabel(day)} className={`provider-heatmap-cell level-${levelOf(day)}${selectedDate === day.date ? ' selected' : ''}`} title={dayAriaLabel(day)} onFocus={() => setSelectedDate(day.date)} onClick={() => setSelectedDate(day.date)} />
            : <span key={`blank-${index}`} className="provider-heatmap-cell blank" aria-hidden="true" />)}
        </div>
      </div>
    </div>
    <div className="provider-day-card">
      {selectedDay ? <>
        {hasCost && <div className="day-cell"><div><span>{dayLabel}花费</span><b>{providerUsageHasNumber(selectedDay.cost) ? valueLabel(selectedDay, 'cost') : '—'}</b></div></div>}
        {hasTokens && <div className="day-cell"><div><span>{dayLabel}Token</span><b>{providerUsageHasNumber(selectedDay.tokens) ? formatProviderUsageSummaryTokens(selectedDay.tokens) : '—'}</b></div></div>}
        {hasRequests && <div className="day-cell"><div><span>{dayLabel}请求</span><b>{providerUsageHasNumber(selectedDay.requests) ? formatProviderUsageCount(selectedDay.requests, false) : '—'}</b></div></div>}
      </> : <span className="chart-detail-hint">点击热力图方格查看当日用量</span>}
    </div>
  </div>;
}

function HistoryView({ account, provider, onBack, onProviderUsageState }) {
  const [points, setPoints] = useState(null);
  const [hiddenKeys, setHiddenKeys] = useState([]);
  const [view, setView] = useState('trend');
  const [rangeKey, setRangeKey] = useState('1d');
  // 该厂商参与浪费统计的周期窗口；为空时不提供「浪费」入口
  // 再按账号实际追踪的窗口过滤：用户选过窗口用 windowKeys，否则用接口实时返回的窗口；
  // 账号还没有任何窗口数据时不过滤（避免轮询失败期间入口闪烁）
  const wasteWindows = useMemo(() => {
    const base = resolveWasteWindows(provider?.requestConfig);
    const tracked = Array.isArray(account.windowKeys) && account.windowKeys.length
      ? account.windowKeys
      : (account.windows?.length ? account.windows.map((item) => item.key) : null);
    return tracked ? base.filter((key) => tracked.includes(key)) : base;
  }, [provider, account]);
  // 用量统计入口常驻：未连接时页内直接引导登录，登录过期也能在原位置重新连接。
  const showProviderUsageEntry = providerUsageSupported(account, provider);
  const showWaste = view === 'waste' && wasteWindows.length > 0;
  const showProviderUsage = view === 'provider-usage' && showProviderUsageEntry;
  useEffect(() => {
    if (view === 'provider-usage' && !showProviderUsageEntry) setView('trend');
  }, [view, showProviderUsageEntry]);
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
  const historyTabs = [
    { key: 'trend', label: '趋势' },
    ...(showProviderUsageEntry ? [{ key: 'provider-usage', label: '用量' }] : []),
    ...(wasteWindows.length > 0 ? [{ key: 'waste', label: '浪费' }] : []),
  ];
  const historyDomId = `history-${String(account.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const historyPanelId = `${historyDomId}-panel`;
  const moveHistoryTab = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tablist = event.currentTarget;
    const currentIndex = Math.max(0, historyTabs.findIndex((tab) => tab.key === view));
    const targetIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? historyTabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + historyTabs.length) % historyTabs.length;
    const target = historyTabs[targetIndex];
    if (!target) return;
    setView(target.key);
    requestAnimationFrame(() => tablist.querySelector(`[data-history-tab="${target.key}"]`)?.focus());
  };
  const hasHistoryTabs = historyTabs.length > 1;
  return <div className="view-stack history-view">
    <section className="surface-section">
      <div className="history-head">
        <AccountIdentity account={account} provider={provider} />
        {account.disabled && <span className="history-disabled-tag"><CircleStop size={12} /> 已停用 · {formatDisabledDate(account.disabledAt)}</span>}
        {hasHistoryTabs && <div className="seg-control history-view-switch" role="tablist" aria-label="账号历史视图" onKeyDown={moveHistoryTab}>
          {historyTabs.map((tab) => <button type="button" role="tab" id={`${historyDomId}-tab-${tab.key}`} data-history-tab={tab.key} key={tab.key} tabIndex={view === tab.key ? 0 : -1} aria-controls={historyPanelId} aria-selected={view === tab.key} className={view === tab.key ? 'active' : ''} onClick={() => setView(tab.key)}>{tab.label}</button>)}
        </div>}
      </div>
      <div className="history-tabpanel" {...(hasHistoryTabs ? { role: 'tabpanel', id: historyPanelId, 'aria-labelledby': `${historyDomId}-tab-${view}` } : {})}>{showProviderUsage ? <ProviderUsageView account={account} provider={provider} onState={onProviderUsageState} /> : showWaste ? <WasteView account={account} wasteWindows={wasteWindows} /> : <div className="trend-view">
        {points === null ? <div className="settings-empty chart-empty">正在读取历史记录…</div>
          : points.length === 0 ? <div className="settings-empty chart-empty">暂无历史数据，每次成功刷新额度后都会记录一条</div>
            : <UsageChart points={points} hiddenKeys={hiddenKeys} rangeKey={rangeKey} onRangeKeyChange={setRangeKey} />}
        {legendKeys.length > 0 && <div className="chart-legend">{legendKeys.map((key, index) => {
          const sample = latestSamples[key];
          const hidden = hiddenKeys.includes(key);
          return <button type="button" key={key} className={hidden ? 'off' : ''} title={hidden ? '点击显示该折线' : '点击隐藏该折线'} onClick={() => toggleKey(key)}><i style={{ background: chartColor(key, index) }} />{windowCatalog[key]?.label || key}{sample && <em>{formatChartValue(sample, chartValue(sample))}</em>}</button>;
        })}<span className="legend-right">{points.length} 条记录</span></div>}
      </div>}</div>
    </section>
    <div className="history-foot"><button type="button" className="outline-button" onClick={onBack}><ArrowLeft size={14} /> 返回</button></div>
  </div>;
}

// 已停用账号卡片：档案式展示——不渲染实时进度环与重置倒计时（那些数字冻结在停用时刻，
// 以“现状”口吻展示会误导），只保留停用时间与停用时长两条静态信息；启用入口在设置的账号行
function DisabledAccountCard({ account, provider, onOpenHistory }) {
  return <div className="overview-card disabled clickable" role="button" tabIndex={0} title="点击查看停用前的历史数据" onClick={() => onOpenHistory?.(account)} onKeyDown={(event) => { if (event.key === 'Enter') onOpenHistory?.(account); }}>
    <div className="overview-head"><AccountIdentity account={account} provider={provider} /></div>
    <div className="overview-body disabled-card-body">
      <div className="disabled-copy">
        <b>停用于 {formatDisabledDate(account.disabledAt)}</b>
        <small>已停用 {formatDisabledDuration(account.disabledAt)}</small>
      </div>
    </div>
  </div>;
}

const CARD_DRAG_MOVE_PX = 6;
const isCardChrome = (target) => Boolean(target?.closest?.('button, a, [role="link"], input, select, textarea'));
// 账号名、额度数字、标签等可复制文字：落在这些上面时拖动走系统选中复制，不启动排序
const isSelectableText = (target) => {
  if (!target?.closest) return false;
  if (target.closest('.provider-logo, .quota-ring, .concentric-rings, .meter-track, .meter-fill, .ring-dot, .card-status-icon')) return false;
  const text = target.closest('strong, b, em, small, span, p');
  return Boolean(text && text.textContent?.trim());
};
const selectionIn = (root) => {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !String(sel).trim()) return false;
  return Boolean(root && (root.contains(sel.anchorNode) || root.contains(sel.focusNode)));
};

function OverviewCard({ account, provider, feedback, onOpenHistory, onRelogin, onReorder, sortable, dragId, overId, onDragId, onOverId, skipClickRef }) {
  const canDrag = sortable && onReorder;
  const cardRef = useRef(null);
  const pressRef = useRef(null);
  const liftingRef = useRef(false);
  const relogin = account.status === 'warning' ? reloginChannel(provider) : null;
  const lifting = dragId === account.id;
  const clearPress = () => { pressRef.current = null; };
  const beginDrag = (pointerId) => {
    if (liftingRef.current) return;
    liftingRef.current = true;
    window.getSelection?.()?.removeAllRanges?.();
    skipClickRef.current = true;
    onDragId?.(account.id);
    cardRef.current?.setPointerCapture?.(pointerId);
  };
  const cardIdAt = (clientX, clientY) => {
    const stack = document.elementsFromPoint?.(clientX, clientY) || [];
    for (const el of stack) {
      const card = el.closest?.('.overview-card');
      const id = card?.dataset.accountId;
      if (id && id !== account.id) return id;
    }
    return null;
  };
  const finishDrag = (clientX, clientY) => {
    const targetId = cardIdAt(clientX, clientY) || overId;
    if (targetId && targetId !== account.id) onReorder?.(account.id, targetId);
    onDragId?.(null);
    onOverId?.(null);
    skipClickRef.current = true;
    setTimeout(() => { skipClickRef.current = false; }, 0);
  };
  const open = () => {
    if (skipClickRef?.current) { skipClickRef.current = false; return; }
    if (selectionIn(cardRef.current)) return;
    onOpenHistory?.(account);
  };
  const desc = [...(account.windows || [])].sort((a, b) => (durationOrder[b.key] || 9) - (durationOrder[a.key] || 9)).slice(0, 4);
  return <div
    ref={cardRef}
    data-account-id={account.id}
    className={`overview-card ${account.status} clickable${lifting ? ' dragging' : ''}${overId === account.id && dragId && dragId !== account.id ? ' drag-over' : ''}`}
    role="button" tabIndex={0}
    title={canDrag ? '点击查看额度趋势 · 按住空白处拖动排序' : '点击查看额度趋势'}
    onClick={open} onKeyDown={(event) => { if (event.key === 'Enter') open(); }}
    onDragStart={(event) => { if (dragId) event.preventDefault(); }}
    onPointerDown={(event) => {
      if (!canDrag || event.button !== 0 || isCardChrome(event.target) || isSelectableText(event.target)) return;
      pressRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    }}
    onPointerMove={(event) => {
      const press = pressRef.current;
      if (press && !liftingRef.current && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CARD_DRAG_MOVE_PX) beginDrag(press.pointerId);
      if (liftingRef.current) onOverId?.(cardIdAt(event.clientX, event.clientY));
    }}
    onPointerUp={(event) => {
      const wasLifted = liftingRef.current;
      liftingRef.current = false;
      clearPress();
      if (wasLifted) finishDrag(event.clientX, event.clientY);
    }}
    onPointerCancel={() => {
      const wasLifted = liftingRef.current;
      liftingRef.current = false;
      clearPress();
      if (wasLifted) { onDragId?.(null); onOverId?.(null); }
    }}
  >
    <div className="overview-head">
      <AccountIdentity account={account} provider={provider} />
      <div className="card-actions">
        {relogin
          ? <button type="button" className={`card-status-icon ${account.status} relogin`} title={relogin.title} aria-label={`${relogin.action}登录 ${account.name}`} onClick={(event) => { event.stopPropagation(); onRelogin?.(account); }}><AlertCircle size={14} /></button>
          : <span className={`card-status-icon ${account.status}`} title={account.status === 'warning' ? (account.lastError || '连接检查失败') : (feedback?.message || `连接正常 · ${account.windows.length} 个额度窗口`)}>{account.status === 'warning' ? <AlertCircle size={14} /> : <ShieldCheck size={14} />}</span>}
      </div>
    </div>
    <div className="overview-body">
      <ConcentricRings account={account} />
      <div className="overview-meters">{[...desc].reverse().map((meter) => {
        const detail = `${formatReset(meter.resetAt)}${formatQuotaDetail(meter) ? ` · ${formatQuotaDetail(meter)}` : ''}`;
        return <div className="overview-meter" key={meter.key}><span><i className={`ring-dot ring-dot-${desc.indexOf(meter)}`} />{windowCatalog[meter.key]?.label || meter.key}</span><b>{formatAmount(meter)}</b><small title={detail}>{detail}</small></div>;
      })}</div>
    </div>
  </div>;
}

function StatusView({ accounts, providers, runtime, onTestAccount, testingAccountId, testResults, reminderRules, mode = 'rings', onModeChange, onOpenSettings, lastSync, onRefresh, refreshing, onOpenHistory, onRelogin, onReorderAccounts, sortWeights }) {
  // 停用账号从所有视图的常规列表里分离出来：rows/periods 直接不显示（resetAt 已过期会污染时间排序），
  // rings 视图单独收进置底的折叠分组；组内按停用时间倒序（最近停的排最前）
  const disabledAccounts = accounts.filter((a) => a.disabled)
    .sort((a, b) => new Date(b.disabledAt || 0).getTime() - new Date(a.disabledAt || 0).getTime());
  const activeAccounts = accounts.filter((a) => !a.disabled);
  const [disabledOpen, setDisabledOpen] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const skipClickRef = useRef(false);
  const allDisabledHint = disabledAccounts.length > 0 && activeAccounts.length === 0
    ? <div className="settings-empty all-disabled-empty">所有账号均已停用。切换到「账号总览」视图，或在设置的账号列表中可重新启用。</div>
    : null;
  if (mode === 'rows') return <div className="view-stack">{activeAccounts.length ? <WindowsView accounts={activeAccounts} providers={providers} reminderRules={reminderRules} embedded onOpenHistory={onOpenHistory} onRelogin={onRelogin} /> : allDisabledHint}</div>;
  if (mode === 'periods') return <div className="view-stack">{activeAccounts.length ? <PriorityView accounts={activeAccounts} providers={providers} reminderRules={reminderRules} onOpenHistory={onOpenHistory} sortWeights={sortWeights} /> : allDisabledHint}</div>;
  // 总览按账号列表顺序展示（不再按状态分组），以便拖拽排序；异常账号仍用警告样式标出
  return <div className="view-stack">
    <section className="overview-grid">{activeAccounts.map((account) => {
      const provider = providers.find((item) => item.id === account.providerId);
      return <OverviewCard key={account.id} account={account} provider={provider} feedback={testResults[account.id]} onOpenHistory={onOpenHistory} onRelogin={onRelogin} onReorder={onReorderAccounts} sortable={activeAccounts.length > 1} dragId={dragId} overId={overId} onDragId={setDragId} onOverId={setOverId} skipClickRef={skipClickRef} />;
    })}</section>
    {disabledAccounts.length > 0 && <>
      <button type="button" className="disabled-fold" onClick={() => setDisabledOpen((prev) => !prev)}>
        {disabledAccounts.length} 个账号已停用，点击{disabledOpen ? '收起' : '展开查看'}
        {disabledOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {disabledOpen && <div className="overview-grid disabled-grid">{disabledAccounts.map((account) => {
        const provider = providers.find((item) => item.id === account.providerId);
        return <DisabledAccountCard key={account.id} account={account} provider={provider} onOpenHistory={onOpenHistory} />;
      })}</div>}
    </>}
  </div>;
}

function Toggle({ checked, onChange, label, description }) {
  return <label className="setting-toggle"><span><b>{label}</b><small>{description}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
}

function SettingsDrawer({ accounts, providers, settings, setSettings, onClose, openModal, onDeleteAccount, onToggleAccountDisabled, onTestAccount, testingAccountId, onEditProvider, autoLaunch, onToggleAutoLaunch, appVersion, update, onOpenUpdate, onCheckUpdate, onClearHistory, runtime }) {
  const proxyMode = ['direct', 'system', 'manual'].includes(settings.proxyMode) ? settings.proxyMode : 'system';
  return <><div className="drawer-shade" onClick={onClose} /><aside className="settings-drawer" aria-label="设置">
    <div className="drawer-scroll">
      <section className="drawer-section"><div className="drawer-section-title"><Bell size={16} /><span>刷新提醒规则</span><button className="mini-add" onClick={() => setSettings((old) => ({ ...old, reminderRules: [...(old.reminderRules || []), { id: `rule-${Date.now()}`, beforeMinutes: 120, minRemaining: 50 }] }))}><Plus size={14} /> 新增规则</button></div><Toggle checked={settings.alerts !== false} onChange={(value) => setSettings((old) => ({ ...old, alerts: value }))} label="启用提醒" description="关闭后不发送桌面通知，也不标记命中规则" />{(settings.reminderRules || []).length === 0 ? <div className="settings-empty">当前没有运行规则</div> : (settings.reminderRules || []).map((rule, index) => <div className="rule-editor" key={rule.id}><label><span>刷新前多久（分钟）<small>窗口重置倒计时小于该值才提醒</small></span><input type="number" min="1" value={rule.beforeMinutes} onChange={(event) => setSettings((old) => ({ ...old, reminderRules: old.reminderRules.map((item, itemIndex) => itemIndex === index ? { ...item, beforeMinutes: event.target.value } : item) }))} /></label><label><span>剩余至少（百分比）<small>剩余额度不低于该值才提醒</small></span><input type="number" min="0" max="100" value={rule.minRemaining} onChange={(event) => setSettings((old) => ({ ...old, reminderRules: old.reminderRules.map((item, itemIndex) => itemIndex === index ? { ...item, minRemaining: event.target.value } : item) }))} /></label><button className="icon-button danger rule-delete" title="删除规则" aria-label={`删除 ${rule.label || '规则'}`} onClick={() => setSettings((old) => ({ ...old, reminderRules: old.reminderRules.filter((item) => item.id !== rule.id) }))}><Trash2 size={13} /></button></div>)}<small className="drawer-help">满足“刷新前多久”且“剩余至少”时，额度窗口会标记该规则。可以一条规则都没有。</small><div className="setting-select"><span><b>轮询间隔</b><small>所有账号统一检查频率</small></span><select value={settings.pollMinutes} onChange={(event) => setSettings((old) => ({ ...old, pollMinutes: event.target.value }))}><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="15">15 分钟</option><option value="30">30 分钟</option></select></div></section>
      <section className="drawer-section"><div className="drawer-section-title"><SlidersHorizontal size={16} /><span>周期明细排序</span></div>
        {[{ key: 'periodSort5hRemaining', label: '5 小时' }, { key: 'periodSortLongRemaining', label: '7 天 / 1 个月' }].map((item) => {
          const remaining = clampRemainingWeight(settings[item.key]);
          return <label className="period-sort-row" key={item.key}><span><b>{item.label}</b><small>剩余 {remaining}% · 重置 {100 - remaining}%</small></span><input type="range" min={0} max={100} step={5} value={remaining} onChange={(event) => setSettings((old) => ({ ...old, [item.key]: Number(event.target.value) }))} /></label>;
        })}
        <small className="drawer-help">默认剩余 0%、重置 100%，只按距重置时间从近到远排（与原来一致）。拉高剩余占比后，额度多的账号更靠前。「全部」视图里 5 小时与 7 天/1 个月仍各用各的比例。</small>
      </section>
      <section className="drawer-section"><div className="drawer-section-title"><SunMoon size={16} /><span>主题</span></div><div className="setting-select"><span><b>界面主题</b><small>主窗口与桌面浮窗同步应用</small></span><select value={settings.theme === 'light' ? 'light' : 'dark'} onChange={(event) => setSettings((old) => ({ ...old, theme: event.target.value }))}><option value="dark">暗色</option><option value="light">亮色</option></select></div></section>
      <section className="drawer-section"><div className="drawer-section-title"><Monitor size={16} /><span>桌面浮窗</span></div><Toggle checked={settings.widget} onChange={(value) => setSettings((old) => ({ ...old, widget: value }))} label="显示桌面浮窗" description="固定在桌面顶层，双击展开主窗口" /><label className="size-slider"><span>大小</span><input type="range" min={80} max={300} step={5} value={Math.round(clampWidgetScale(settings.widgetScale) * 100)} onChange={(event) => setSettings((old) => ({ ...old, widgetScale: Number(event.target.value) / 100 }))} /><b>{Math.round(clampWidgetScale(settings.widgetScale) * 100)}%</b></label><label className="size-slider"><span>长度</span><input type="range" min={Math.round(WIDGET_MIN_LENGTH * 100)} max={Math.round(WIDGET_MAX_LENGTH * 100)} step={5} value={Math.round(clampWidgetLength(settings.widgetLength) * 100)} onChange={(event) => setSettings((old) => ({ ...old, widgetLength: Number(event.target.value) / 100 }))} /><b>{Math.round(clampWidgetLength(settings.widgetLength) * 100)}%</b></label><small className="drawer-help">长度只调整横向宽度（60%–150%）。浮窗会展示账号的全部额度窗口（含 1M）；空间不足时逐级收起：标签先缩成小圆点再隐藏，倒计时按周期从长到短逐个隐藏，最后才收起最长周期的额度——只有一个额度窗口的账号通常不用收起任何内容。名称放不下时显示省略号，悬停可查看完整内容。</small><button type="button" className="outline-button full" onClick={() => setSettings((old) => ({ ...old, widgetScale: 0.9, widgetLength: 0.9 }))}>恢复默认大小与长度</button><div className="widget-setting-preview"><div style={{ width: Math.round(WIDGET_BASE_SIZE.width * clampWidgetLength(settings.widgetLength)), maxWidth: '100%', margin: '0 auto' }}>{(() => { const previewAccount = accounts.find((item) => !item.disabled) ?? accounts[0]; return <WidgetRow account={previewAccount} provider={providers.find((item) => item.id === previewAccount?.providerId)} compact tagLimit={Number(settings.widgetTagLimit ?? 2)} length={clampWidgetLength(settings.widgetLength)} />; })()}</div></div><button className="outline-button full" onClick={() => setSettings((old) => ({ ...old, widgetPreview: true }))}><Eye size={15} /> 预览并调整</button></section>
      <section className="drawer-section"><div className="drawer-section-title"><History size={16} /><span>额度历史</span></div><div className="setting-select"><span><b>保留时长</b><small>每次成功刷新都会记录一条，用于账号卡片的趋势图</small></span><select value={settings.historyDays} onChange={(event) => setSettings((old) => ({ ...old, historyDays: Number(event.target.value) }))}><option value={3}>3 天</option><option value={7}>7 天（默认）</option><option value={15}>15 天</option><option value={30}>30 天</option><option value={60}>60 天</option><option value={90}>3 个月（最长）</option><option value={0}>永久</option></select></div><button className="outline-button full" onClick={onClearHistory}><Trash2 size={14} /> 清除全部历史记录</button><small className="drawer-help">删除账号时会一并删除该账号的额度历史；超过保留时长的记录会自动清理；永久保存时超过 30 天的记录会自动降采样为每小时一条。</small></section>
      <section className="drawer-section"><div className="drawer-section-title"><ShieldCheck size={16} /><span>账号与凭据</span><button className="mini-add" onClick={() => openModal('account')}><Plus size={14} /> 添加账号</button></div><div className="settings-list">{accounts.length === 0 && <div className="settings-empty">还没有账号</div>}{accounts.map((account) => { const provider = providers.find((item) => item.id === account.providerId); const testing = testingAccountId === account.id; return <div className={`settings-account${account.disabled ? ' disabled' : ''}`} key={account.id}><Logo provider={provider} size="sm" /><div><b title={account.name}>{account.name}</b><small className={account.disabled ? '' : account.status === 'warning' ? 'warning-copy' : ''} title={account.disabled ? `停用于 ${formatDisabledDate(account.disabledAt)}，历史数据保留中` : account.status === 'warning' ? (account.lastError || '') : ''}>{account.disabled ? `已停用 · ${formatDisabledDate(account.disabledAt)}` : account.status === 'warning' ? account.lastError : `${provider?.name} · ${account.windows.length} 个额度窗口`}</small></div><button className="row-icon-button" title="编辑账号" aria-label={`编辑 ${account.name}`} onClick={() => openModal({ type: 'account-edit', account })}><Pencil size={13} /></button>{!account.disabled && <button className="row-icon-button" disabled={testing} title="刷新" aria-label={`刷新 ${account.name} 额度`} onClick={() => onTestAccount(account)}><RefreshCw size={13} className={testing ? 'spinning' : ''} /></button>}<button className={`row-icon-button ${account.disabled ? 'play' : 'stop'}`} title={account.disabled ? '启用账号：恢复巡检并接续历史' : '停用账号：停止巡检，历史保留，可随时启用'} aria-label={`${account.disabled ? '启用' : '停用'} ${account.name}`} onClick={() => onToggleAccountDisabled(account)}>{account.disabled ? <Play size={13} /> : <Square size={13} />}</button><button className="row-icon-button danger" title="删除账号" aria-label={`删除 ${account.name}`} onClick={() => onDeleteAccount(account)}><Trash2 size={13} /></button><span className={`status-dot ${account.disabled ? 'disabled' : account.status}`} /></div>; })}</div>{window.quotaDesk?.scanCcswitchImport && <button className="outline-button full drawer-import-button" onClick={() => openModal('import-ccswitch')}><Download size={14} /> 从 cc-switch 导入账号</button>}</section>
      <section className="drawer-section"><div className="drawer-section-title"><LayoutGrid size={16} /><span>厂商适配器</span><button className="mini-add" onClick={() => openModal('provider')}><Plus size={14} /> 新增厂商</button></div><div className="settings-list providers-list">{providers.map((provider) => <div className="settings-account" key={provider.id}><Logo provider={provider} size="sm" /><div><b title={provider.name}>{provider.name}</b><small>{provider.requestConfig?.adapterMode === 'script' ? '脚本适配' : ['grok', 'grokbot'].includes(provider.requestConfig?.adapterMode) ? '专属适配' : '标准映射'}</small></div><button className="row-icon-button" title="编辑厂商" aria-label={`编辑 ${provider.name}`} onClick={() => onEditProvider(provider)}><Pencil size={13} /></button><span className="adapter-state"><Check size={13} /></span></div>)}</div></section>
      <section className="drawer-section"><div className="drawer-section-title"><Globe size={16} /><span>网络代理</span></div><div className="setting-select"><span><b>代理模式</b><small>所有账号的额度请求共用，保存后立即生效</small></span><select value={proxyMode} onChange={(event) => setSettings((old) => ({ ...old, proxyMode: event.target.value }))}><option value="system">跟随系统（默认）</option><option value="manual">手动输入</option><option value="direct">不使用代理</option></select></div>{proxyMode === 'manual' && <label className="field drawer-proxy-field"><span>代理地址 <small>留空时退回跟随系统</small></span><input value={settings.proxyUrl ?? ''} onChange={(event) => setSettings((old) => ({ ...old, proxyUrl: event.target.value }))} placeholder="http://127.0.0.1:7897 或 socks5://127.0.0.1:7898" spellCheck="false" autoComplete="off" /></label>}<small className="drawer-help">访问 Claude、Codex、Gemini、Grok 等境外厂商直连常被中断，建议配置可用代理。地址以代理工具实际监听的端口为准（Clash Verge Rev 默认 mixed-port 7897）；只填 host:port 时按 http 代理处理。切换代理模式后建议点账号行的「刷新」验证效果。</small></section>
      <section className="drawer-section"><div className="drawer-section-title"><Power size={16} /><span>系统与更新</span></div><Toggle checked={autoLaunch} onChange={onToggleAutoLaunch} label="开机自启" description="登录 Windows 后自动启动 Quota Desk" /><Toggle checked={settings.autoUpdate !== false} onChange={(value) => setSettings((old) => ({ ...old, autoUpdate: value }))} label="自动检查更新" description="启动时及每小时自动检查 GitHub 上是否有新版本" /><div className="setting-select"><span><b>版本更新</b><small>当前版本 v{appVersion || '-'}</small></span>{update && ['available', 'downloading', 'downloaded'].includes(update.status) ? <button className="outline-button" onClick={onOpenUpdate}>v{update.version} 可用</button> : <button className="outline-button" disabled={update?.status === 'checking'} onClick={onCheckUpdate}>{update?.status === 'checking' ? '正在检查…' : '检查更新'}</button>}</div>{settings.ignoredUpdateVersion && <div className="setting-select"><span><b>已忽略 v{settings.ignoredUpdateVersion}</b><small>该版本的更新不再主动提醒，进入设置的检查更新仍可用</small></span><button className="outline-button" onClick={() => setSettings((old) => ({ ...old, ignoredUpdateVersion: null }))}>恢复提醒</button></div>}</section>
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
  const [tags, setTags] = useState('');
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
  return <div className="modal-backdrop" onClick={onClose}><form className="modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>连接一个账号</h2></div></div><label className="field"><span>厂商</span><select value={providerId} onChange={(event) => { setProviderId(event.target.value); const next = providers.find((item) => item.id === event.target.value); setSelected(providerWindowKeys(next)); setBaseUrl(next?.baseUrl || ''); setEndpoint(defaultEndpoint(next)); }}>{providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><div className="form-grid"><label className="field"><span>账号名</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={provider?.name || '账号名称'} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="邮箱、用户名或币种" /></label></div><label className="field"><span>标签 <small>用逗号分隔，可多选</small></span><div className="input-with-icon"><Tag size={15} /><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="可留空，多个用逗号分隔" /></div></label><label className="field"><span>额度接口默认路径 <small>可按账号覆盖</small></span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label><div className="field"><span>额度窗口 <small>同一账号可一次选择多个</small></span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div>{needsBaseUrl && <label className="field"><span>接口 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider?.baseUrl || 'https://api.example.com'} /></label>}<label className="field"><span>API Token <small>使用 Windows DPAPI 加密，仅保存在本机</small></span><div className="input-with-icon"><ShieldCheck size={15} /><input type="password" required value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="粘贴 Token，不要添加 Bearer" /></div></label><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={saving || !credential.trim() || !selected.length}><RefreshCw size={15} className={saving ? 'spinning' : ''} /> {saving ? '正在测试' : '保存并测试'}</button></div></form></div>;
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
  return <div className="modal-backdrop" onClick={onClose}><form className="modal compact-modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>更新 {account.name}</h2></div></div>{(provider?.adapter === 'wlb' || provider?.adapter === 'zai' || provider?.adapter === 'generic') && <label className="field"><span>接口 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>}<label className="field"><span>{'新 API Token'} <small>原凭据不会被读取或显示</small></span><div className="input-with-icon"><KeyRound size={15} /><input autoFocus type="password" required value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="输入后覆盖旧凭据" /></div></label><div className="adapter-note"><ShieldCheck size={15} /><span>保存后由 Windows DPAPI 加密，并立即检查一次该账号的额度。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !credential.trim()}>{saving ? '正在验证' : '保存并检查'}</button></div></form></div>;
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
  return <div className="modal-backdrop" onClick={onClose}><form className="modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>编辑 {account.name}</h2></div></div><div className="form-grid"><label className="field"><span>账号名</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="邮箱、用户名或币种" /></label></div><label className="field"><span>标签 <small>用逗号分隔</small></span><div className="input-with-icon"><Tag size={15} /><input value={tags} onChange={(event) => setTags(event.target.value)} /></div></label><div className="form-grid"><label className="field"><span>接口 Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label><label className="field"><span>额度接口路径</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label></div><div className="field"><span>额度窗口 <small>取消选择后不会在该账号显示</small></span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div><label className="field"><span>{'新 API Token'} <small>留空则保留原凭据</small></span><div className="input-with-icon"><KeyRound size={15} /><input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="需要更换时再输入" /></div></label><div className="adapter-note"><ShieldCheck size={15} /><span>保存后会立即重新测试该账号，原凭据不会被读取或显示。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !selected.length}><Pencil size={15} /> {saving ? '正在保存并测试' : '保存并测试'}</button></div></form></div>;
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
  return <div className="modal-backdrop" onClick={onClose}><form className="modal provider-modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>{provider ? '编辑厂商' : '新增厂商'}</h2></div></div><div className="logo-upload">{logo ? <span className="upload-preview"><img src={logo} alt="Logo 预览" /></span> : <span className="upload-mark"><UploadCloud size={19} /></span>}<div><b>{logo ? 'Logo 已准备好' : '上传厂商 Logo'}</b><small>PNG / SVG / WebP，建议 64 × 64</small></div><label className="outline-button file-button"><UploadCloud size={13} /> {logo ? '更换' : '选择文件'}<input type="file" accept="image/png,image/svg+xml,image/webp" onChange={readLogo} /></label></div><div className="form-grid"><label className="field"><span>厂商名称</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Acme Coding" /></label><label className="field"><span>接口 Base URL</span><input required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com" /></label></div><div className="form-grid"><label className="field"><span>默认额度接口</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="/v1/usage 或完整 URL" /></label><label className="field"><span>认证方式</span><select value={auth} onChange={(event) => setAuth(event.target.value)}><option value="bearer">Bearer Token</option><option value="token">原始 Token</option><option value="cookie">Cookie</option></select></label></div><label className="field"><span>高级适配脚本 <small>可覆盖内置请求和响应解析，返回 request + extractor</small></span><textarea value={script} onChange={(event) => setScript(event.target.value)} placeholder="({ request: { url: '{{baseUrl}}/v1/usage', method: 'GET', headers: { Authorization: 'Bearer {{apiKey}}' } }, extractor(response) { return { key: 'weekly', remaining: 50, total: 100, reset_at: response?.rate_limits?.[0]?.reset_at, unit: '%' }; } })" /></label>{isGeneric && <div className="adapter-config"><span className="eyebrow">响应字段映射</span><div className="form-grid"><label className="field"><span>数据路径</span><input value={listPath} onChange={(event) => setListPath(event.target.value)} placeholder="data.limits 或 data.quota" /></label><label className="field"><span>数据形态</span><select value={collectionMode} onChange={(event) => setCollectionMode(event.target.value)}><option value="auto">自动判断</option><option value="single">单个对象</option><option value="array">数组</option><option value="object-entries">对象键作为窗口</option></select></label></div><div className="form-grid"><label className="field"><span>窗口字段</span><input value={windowField} onChange={(event) => setWindowField(event.target.value)} placeholder="window / name / type" /></label><label className="field"><span>默认窗口</span><select value={defaultWindow} onChange={(event) => setDefaultWindow(event.target.value)}><option value="five_hour">5 小时</option><option value="daily">1 天</option><option value="weekly">7 天</option><option value="monthly">1个月</option><option value="balance">余额</option></select></label></div><label className="field"><span>窗口值映射</span><textarea value={windowMapText} onChange={(event) => setWindowMapText(event.target.value)} /></label><div className="form-grid mapping-grid"><label className="field"><span>总量路径</span><input value={totalPath} onChange={(event) => setTotalPath(event.target.value)} /></label><label className="field"><span>剩余路径</span><input value={remainingPath} onChange={(event) => setRemainingPath(event.target.value)} /></label><label className="field"><span>已用路径</span><input value={usedPath} onChange={(event) => setUsedPath(event.target.value)} /></label><label className="field"><span>百分比路径</span><input value={percentagePath} onChange={(event) => setPercentagePath(event.target.value)} /></label></div><label className="field"><span>刷新时间路径</span><input value={resetPath} onChange={(event) => setResetPath(event.target.value)} /></label></div>}<div className="adapter-note"><Sparkles size={15} /><span>脚本适配器支持复杂认证、请求方法、请求头、请求体和任意响应提取逻辑。</span></div><div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button className="primary-button" type="submit"><Pencil size={15} /> {provider ? '保存厂商' : '新增厂商'}</button></div></form></div>;
}

function AccountModalV2({ providers, onClose, onSave, onTestDraft, embedded = false, onBack, fixedProviderId = null }) {
  // CLI 官方订阅不走此表单（与「导入本机 CLI 登录」避免两套入口打架），只列 API / 中转类厂商；
  // 从磁贴列表进入时厂商已选定（fixedProviderId）：表单里不再提供厂商切换，标题就是厂商名
  const selectableProviders = providers.filter((item) => !isCliProvider(item));
  const fixedProvider = fixedProviderId ? selectableProviders.find((item) => item.id === fixedProviderId) : null;
  const [providerId, setProviderId] = useState(fixedProvider?.id || selectableProviders[0]?.id || '');
  const [name, setName] = useState('');
  const [identity, setIdentity] = useState('');
  const [tags, setTags] = useState('');
  const [credential, setCredential] = useState('');
  const [endpoint, setEndpoint] = useState(() => defaultEndpoint(fixedProvider || selectableProviders[0]));
  const [selected, setSelected] = useState(() => {
    const initial = fixedProvider || selectableProviders[0];
    return initial ? providerWindowKeys(initial) : [];
  });
  const [variableValues, setVariableValues] = useState(() => defaultVariableValues(fixedProvider || selectableProviders[0]));
  const [timeoutSeconds, setTimeoutSeconds] = useState('15');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [connectUsageAfterSave, setConnectUsageAfterSave] = useState(false);
  const provider = selectableProviders.find((item) => item.id === providerId);
  const availableWindows = providerWindowKeys(provider);
  const variableDefinitions = providerVariableDefinitions(provider);
  const credentialRequired = provider?.requestConfig?.adapterMode === 'script' ? false : provider?.requestConfig?.auth !== 'none';
  const missingRequiredVariables = variableDefinitions.some((item) => providerVariableRequired(provider, item) && !String(variableValues[item.key] ?? '').trim());
  // Z.ai / Codex 这类免额外操作的厂商：保存时自动连接官方用量，表单里不出开关
  const usageCopy = providerUsageCopy(provider);
  const usageConnectVisible = Boolean(usageCopy?.saveAction) && Boolean(window.quotaDesk?.connectProviderUsage);
  useEffect(() => { if (!PROVIDER_USAGE_COPY[providerId]?.saveAction) setConnectUsageAfterSave(false); }, [providerId]);
  const toggle = (key) => setSelected((old) => old.includes(key) ? old.filter((item) => item !== key) : [...old, key]);
  const accountEndpoint = provider?.requestConfig?.adapterMode === 'script' ? String(variableValues.endpoint || provider.requestConfig.endpoint || '') : endpoint.trim();
  // 草稿连通性测试：不保存账号与凭据，直接用当前表单值查一次
  const runTest = async () => {
    if ((credentialRequired && !credential.trim()) || missingRequiredVariables || !selected.length || !accountEndpoint) return;
    setTesting(true);
    setTestResult(null);
    try {
      const { publicVariables, secretVariables } = splitVariableValues(provider, variableValues);
      setTestResult(await onTestDraft({ account: { endpoint: accountEndpoint, variables: publicVariables, windowKeys: selected, timeoutSeconds: clampAccountTimeout(timeoutSeconds) }, providerId, credential: credential.trim(), secretVariables }));
    } finally { setTesting(false); }
  };
  const submit = async (event) => {
    event.preventDefault();
    if ((credentialRequired && !credential.trim()) || missingRequiredVariables || !selected.length || !accountEndpoint) return;
    setSaving(true);
    const { publicVariables, secretVariables } = splitVariableValues(provider, variableValues);
    // Z.ai / Codex 这类无额外操作的厂商保存时自动连接官方用量（不出开关、不设 saveAction）；
    // 有 saveAction 的（DeepSeek/MiniMax 需登录）仍按用户勾选
    const autoConnect = Boolean(usageCopy && !usageCopy.saveAction);
    try { await onSave({ providerId, name: name.trim() || provider?.name || '新账号', identity: identity.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), windowKeys: selected, credential: credential.trim(), endpoint: accountEndpoint, timeoutSeconds: clampAccountTimeout(timeoutSeconds), variables: publicVariables, secretVariables, connectUsageAfterSave: (autoConnect || (usageConnectVisible && connectUsageAfterSave)) }); }
    finally { setSaving(false); }
  };
  const formFields = <>{!fixedProvider && <label className="field"><span>厂商</span><select value={providerId} onChange={(event) => { const next = selectableProviders.find((item) => item.id === event.target.value); setProviderId(event.target.value); setEndpoint(defaultEndpoint(next)); setSelected(providerWindowKeys(next)); setVariableValues(defaultVariableValues(next)); }}>{selectableProviders.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}<div className="form-grid"><label className="field"><span>账号名</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={provider?.name || '账号名称'} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="邮箱、用户名或币种" /></label></div><label className="field"><span>标签 <small>用逗号分隔，可留空</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="可留空，多个用逗号分隔" /></label>{!['script', 'grok', 'grokbot'].includes(provider?.requestConfig?.adapterMode) && <label className="field"><span>详细额度接口路径</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com/v1/usage" /></label>}<div className="form-grid"><label className="field"><span>请求超时（秒）<small>5–120，默认 15；跨境或代理网络可调大</small></span><input type="number" min="5" max="120" value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} /></label></div><div className="field"><span>额度窗口</span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div>{variableDefinitions.length > 0 && <div className="adapter-config account-variables"><span className="eyebrow">厂商变量</span><div className="form-grid">{variableDefinitions.map((item) => <label className="field" key={item.key}><span>{item.label || item.key}{item.required && <small> 必填</small>}</span><input type={item.secret ? 'password' : 'text'} required={item.required} value={variableValues[item.key] ?? ''} onChange={(event) => setVariableValues((old) => ({ ...old, [item.key]: event.target.value }))} placeholder={item.defaultValue || item.key} /></label>)}</div></div>}{!['script', 'grok', 'grokbot'].includes(provider?.requestConfig?.adapterMode) && <label className="field"><span>{credentialRequired ? 'API Token' : '凭据（可选）'}</span><input type="password" required={credentialRequired} value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={credentialRequired ? '凭据只会加密保存在本机' : '此接口无需凭据'} /></label>}{testResult && <div className={`draft-test-result ${testResult.ok ? 'ok' : 'fail'}`}><span>{testResult.ok ? '测试通过' : '测试失败'} · {testResult.message}</span></div>}</>;
  const canRun = !((credentialRequired && !credential.trim()) || missingRequiredVariables || !selected.length || !accountEndpoint);
  const canSave = !(saving || (credentialRequired && !credential.trim()) || missingRequiredVariables || !selected.length || !accountEndpoint);
  const usageConnectOption = usageConnectVisible && usageCopy
    ? <label className="setting-toggle provider-login-option"><span><b>官方账号用量 <small>可选</small></b><small>{usageCopy.editHint}</small></span><input type="checkbox" checked={connectUsageAfterSave} onChange={(event) => setConnectUsageAfterSave(event.target.checked)} /><i /></label>
    : null;
  const actions = (onCancel) => <div className="modal-actions"><button type="button" className="outline-button" onClick={onCancel}>{embedded ? '返回' : '取消'}</button><button type="button" className="outline-button" disabled={testing || !canRun} onClick={runTest}>{testing ? '测试中…' : '测试'}</button><button className="primary-button" type="submit" form={embedded ? 'custom-account-form' : undefined} disabled={!canSave}>{saving ? '正在保存' : (usageCopy?.saveAction ? (connectUsageAfterSave ? usageCopy.saveAction : '保存') : usageCopy ? '保存并连接' : '保存')}</button></div>;
  // 嵌入模式（磁贴列表点进来的厂商表单）：表单区域滚动，标题与操作条固定，窗口尺寸与磁贴页一致；
  // 厂商已选定——标题直接显示厂商名，表单内不能再换厂商
  if (embedded) return <>
    <div className="modal-head"><div><h2>添加 {provider?.name || '账号'}<TitleHelp>{provider?.legalName || provider?.name || 'API / 中转接口'}：手动填写额度地址与凭据，凭据只加密保存在本机。如需换厂商，返回磁贴列表重选。</TitleHelp></h2></div></div>
    <form id="custom-account-form" className="custom-account-scroll" onSubmit={submit}>{formFields}{usageConnectOption}</form>
    {actions(onBack || onClose)}
  </>;
  return <div className="modal-backdrop" onClick={onClose}><form className="modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>{fixedProvider ? `添加 ${provider?.name || '账号'}` : '连接一个账号'}</h2></div></div>{formFields}{usageConnectOption}{actions(onClose)}</form></div>;
}

// DeepSeek 的 API Key 余额巡检与官方账号历史是可独立启停的两条连接。
// 官方登录令牌只在主进程中处理；renderer 只接收连接状态和聚合后的用量。
// Z.ai / Codex 这类免额外操作的厂商（API Key / CLI 快照即可读用量）不出连接卡片：
// 账号创建时已自动连接，详情页直接显示用量，编辑界面无需单独开关。
function ProviderUsageConnectionCard({ account, provider, onState }) {
  const bridge = window.quotaDesk;
  const [connection, setConnection] = useState(account.usageConnection || null);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  useEffect(() => setConnection(account.usageConnection || null), [account.id, account.usageConnection]);
  useEffect(() => {
    if (!confirmDisconnect) return undefined;
    const timer = setTimeout(() => setConfirmDisconnect(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDisconnect]);
  const copy = providerUsageCopy(provider);
  if (!copy || !copy.saveAction) return null;
  const supported = providerUsageSupported({ ...account, usageConnection: connection }, provider);
  const status = providerUsageStatus({ usageConnection: connection });
  const applyResultState = (state) => {
    if (!state) return;
    const updated = (state.accounts || []).find((item) => item.id === account.id);
    if (updated) setConnection(updated.usageConnection || null);
    onState?.(state);
  };
  const connect = async () => {
    setBusy('connect');
    setFeedback(null);
    try {
      const result = await bridge.connectProviderUsage(account.id);
      if (result?.cancelled) { setFeedback({ ok: false, message: '未完成登录，连接状态没有变化' }); return; }
      setConnection(result?.connection || { provider: provider.id, status: 'connected' });
      applyResultState(result?.state);
      setFeedback({ ok: true, message: copy.connectedToast });
    } catch (connectError) { setFeedback({ ok: false, message: connectError?.message || '连接失败' }); }
    finally { setBusy(''); }
  };
  const refresh = async () => {
    setBusy('refresh');
    setFeedback(null);
    try {
      const result = await bridge.getProviderUsage(account.id, { days: 180, force: true });
      const hasHistory = providerUsageHasMetric(result, 'cost') || providerUsageHasMetric(result, 'tokens');
      const rangeCost = result?.summary?.rangeCost ?? result?.summary?.knownRangeCost;
      const rangeTokens = result?.summary?.rangeTokens ?? result?.summary?.knownRangeTokens;
      const metricText = providerUsageHasNumber(rangeCost) ? ` · ${formatProviderUsageCost(rangeCost, result.currency)}` : (providerUsageHasNumber(rangeTokens) ? ` · ${formatProviderUsageSummaryTokens(rangeTokens)} Token` : '');
      setFeedback({ ok: true, message: hasHistory ? `已读取最近 ${result.days.length} 天${metricText}` : '已连接，厂商暂未返回历史用量' });
      setConnection((old) => ({ ...(old || {}), provider: provider.id, status: 'connected', checkedAt: new Date().toISOString() }));
    } catch (refreshError) {
      const message = refreshError?.message || '刷新失败';
      if (/AUTH_|登录已失效|尚未连接|重新连接|已过期/.test(message)) setConnection((old) => ({ ...(old || {}), provider: provider.id, status: 'reauth_required', lastError: message }));
      setFeedback({ ok: false, message });
    } finally { setBusy(''); }
  };
  const disconnect = async () => {
    setConfirmDisconnect(false);
    setBusy('disconnect');
    setFeedback(null);
    try {
      const result = await bridge.disconnectProviderUsage(account.id);
      setConnection(null);
      applyResultState(result?.state);
      setFeedback({ ok: true, message: '已断开官方账号；API Key 余额巡检不受影响' });
    } catch (disconnectError) { setFeedback({ ok: false, message: disconnectError?.message || '断开失败' }); }
    finally { setBusy(''); }
  };
  const requestDisconnect = () => {
    if (confirmDisconnect) disconnect();
    else setConfirmDisconnect(true);
  };
  const statusCopy = !supported
    ? { label: '当前版本不可用', detail: '桌面后端未提供官方账号用量能力', tone: 'muted' }
    : status === 'connected'
      ? { label: '已连接', detail: connection?.checkedAt ? formatChecked(connection.checkedAt) : copy.connectedDetail, tone: 'connected' }
      : status === 'reauth_required'
        ? { label: copy.reauthLabel, detail: connection?.lastError || copy.reauthDetail, tone: 'reauth' }
        : { label: '未连接', detail: '可选增强，不影响现有 API Key 余额巡检', tone: 'muted' };
  return <div className="provider-connection-card">
    <div className="provider-connection-copy"><span className="provider-connection-icon"><Globe size={15} /></span><div><b>服务端用量 <em>可选</em></b><small>{copy.connectHint}</small></div></div>
    <div className={`provider-connection-status ${statusCopy.tone}`}><i /><span><b>{statusCopy.label}</b><small>{statusCopy.detail}</small></span></div>
    {supported && <div className="provider-connection-actions">
      {status === 'connected' ? <>
        <button type="button" className="outline-button" disabled={Boolean(busy)} onClick={refresh}><RefreshCw size={12} className={busy === 'refresh' ? 'spinning' : ''} />{busy === 'refresh' ? '刷新中…' : '刷新'}</button>
        <button type="button" className={`text-button disconnect ${confirmDisconnect ? 'confirming' : ''}`} disabled={Boolean(busy)} title={confirmDisconnect ? '再次点击确认清除官方登录会话' : copy.disconnectTitle} onClick={requestDisconnect}><Power size={12} />{busy === 'disconnect' ? '断开中…' : (confirmDisconnect ? '确认断开' : '断开')}</button>
      </> : <>
        <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={connect}><Globe size={12} />{busy === 'connect' ? copy.connecting : (status === 'reauth_required' ? '重新连接' : copy.connectAction)}</button>
        {status === 'reauth_required' && <button type="button" className={`text-button disconnect ${confirmDisconnect ? 'confirming' : ''}`} disabled={Boolean(busy)} title={confirmDisconnect ? '再次点击确认清除官方登录会话' : copy.disconnectTitle} onClick={requestDisconnect}><Power size={12} />{confirmDisconnect ? '确认断开' : '断开'}</button>}
      </>}
    </div>}
    {feedback && <div className={`provider-connection-feedback ${feedback.ok ? 'ok' : 'fail'}`}>{feedback.ok ? <Check size={12} /> : <AlertCircle size={12} />}<span>{feedback.message}</span></div>}
  </div>;
}

function AccountEditModalV2({ account, provider, onClose, onSave, onTestDraft, onProviderUsageState }) {
  const [name, setName] = useState(account.name || '');
  const [identity, setIdentity] = useState(account.identity || '');
  const [tags, setTags] = useState((account.tags || []).join(', '));
  const [endpoint, setEndpoint] = useState(account.endpoint || defaultEndpoint(provider));
  const [timeoutSeconds, setTimeoutSeconds] = useState(account.timeoutSeconds ? String(account.timeoutSeconds) : '');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const variableDefinitions = providerVariableDefinitions(provider);
  const [variableValues, setVariableValues] = useState(() => Object.fromEntries(variableDefinitions.map((item) => [item.key, item.secret ? '' : (account.variables?.[item.key] ?? item.defaultValue ?? '')])));
  const [selected, setSelected] = useState(account.windowKeys?.length ? account.windowKeys : (account.windows || []).map((item) => item.key));
  const availableWindows = providerWindowKeys(provider);
  const toggle = (key) => setSelected((old) => old.includes(key) ? old.filter((item) => item !== key) : [...old, key]);
  // CLI 官方订阅的额度接口由专属适配器决定，账号上没有可编辑的接口路径与凭据
  const cliProvider = isCliProvider(provider);
  const accountEndpoint = cliProvider ? (account.endpoint || '') : provider?.requestConfig?.adapterMode === 'script' ? String(variableValues.endpoint || provider.requestConfig.endpoint || '') : endpoint.trim();
  // 表单草稿连通性测试：不保存任何修改；留空的凭据/密钥由主进程回退到已存值
  const runTest = async () => {
    if (!name.trim() || (!cliProvider && !accountEndpoint) || !selected.length) return;
    setTesting(true);
    setTestResult(null);
    try {
      const { publicVariables, secretVariables } = splitVariableValues(provider, variableValues);
      setTestResult(await onTestDraft({ accountId: account.id, account: { ...account, endpoint: accountEndpoint, variables: publicVariables, windowKeys: selected, timeoutSeconds: clampAccountTimeout(timeoutSeconds) }, providerId: provider?.id, credential: '', secretVariables }));
    } finally { setTesting(false); }
  };
  const submit = async (event) => { event.preventDefault(); if (!name.trim() || (!cliProvider && !accountEndpoint) || !selected.length) return; const { publicVariables, secretVariables } = splitVariableValues(provider, variableValues); setSaving(true); try { await onSave({ account, name: name.trim(), identity: identity.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), endpoint: accountEndpoint, windowKeys: selected, timeoutSeconds: clampAccountTimeout(timeoutSeconds), variables: publicVariables, secretVariables }); } finally { setSaving(false); } };
  return <div className="modal-backdrop" onClick={onClose}><form className="modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>编辑 {account.name}</h2></div></div><div className="form-grid"><label className="field"><span>账号名</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>标识</span><input value={identity} onChange={(event) => setIdentity(event.target.value)} /></label></div><label className="field"><span>标签 <small>用逗号分隔，可留空</small></span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>{!['script', 'grok', 'grokbot'].includes(provider?.requestConfig?.adapterMode) && !cliProvider && <label className="field"><span>详细额度接口路径</span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>}<div className="form-grid"><label className="field"><span>请求超时（秒）<small>5–120，默认 15；跨境或代理网络可调大</small></span><input type="number" min="5" max="120" value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} placeholder="15" /></label></div><div className="field"><span>额度窗口</span><div className="window-choice">{availableWindows.map((key) => <button type="button" key={key} className={`window-choice-item ${selected.includes(key) ? 'selected' : ''}`} onClick={() => toggle(key)}><span>{selected.includes(key) ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>)}</div></div>{account.cliAuthSource === 'snapshot' && <div className="adapter-note"><ShieldCheck size={15} /><span>{cliProvider && (provider?.requestConfig?.adapterMode === 'kimi' || provider?.adapter === 'kimi') ? '该账号使用扫码导入的 Kimi 订阅登录快照：令牌由本应用自动续期；若登录在官方侧失效，请重新扫码「导入订阅登录」。' : cliProvider && (provider?.requestConfig?.adapterMode === 'copilot' || provider?.adapter === 'copilot') ? '该账号使用设备码授权的 GitHub 登录快照：令牌长期有效、无需续期；若授权被吊销或已改密，请重新「导入订阅登录」完成设备码授权。' : '该账号使用独立的登录快照：令牌由本应用自动续期，不依赖本机 CLI 当前激活的 profile；若登录在官方侧失效，请重新登录后再次「导入订阅登录」。'}</span></div>}{variableDefinitions.length > 0 && <div className="adapter-config account-variables"><span className="eyebrow">厂商变量</span><div className="form-grid">{variableDefinitions.map((item) => { const lockedKey = item.system && item.key === 'apiKey'; return <label className="field" key={item.key}><span>{item.label || item.key}{lockedKey ? <small> 创建后不可修改</small> : item.secret && <small> 留空保留原值</small>}</span><input type={item.secret ? 'password' : 'text'} required={item.required && !item.secret} disabled={lockedKey} value={lockedKey ? '' : (variableValues[item.key] ?? '')} onChange={(event) => setVariableValues((old) => ({ ...old, [item.key]: event.target.value }))} placeholder={lockedKey ? '如需更换请删除账号后重新添加' : item.secret ? '未修改' : (item.defaultValue || item.key)} /></label>; })}</div></div>}{!['script', 'grok', 'grokbot'].includes(provider?.requestConfig?.adapterMode) && !cliProvider && <div className="adapter-note"><KeyRound size={15} /><span>凭据创建后不可修改；如需更换 API Token，请删除该账号后重新添加。</span></div>}<ProviderUsageConnectionCard account={account} provider={provider} onState={onProviderUsageState} />{testResult && <div className={`draft-test-result ${testResult.ok ? 'ok' : 'fail'}`}><span>{testResult.ok ? '测试通过' : '测试失败'} · {testResult.message}</span></div>}<div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button type="button" className="outline-button" disabled={testing || !name.trim() || (!cliProvider && !accountEndpoint) || !selected.length} onClick={runTest}>{testing ? '测试中…' : '测试'}</button><button className="primary-button" disabled={saving || !selected.length}>{saving ? '正在保存' : '保存'}</button></div></form></div>;
}

function ProviderModalV2({ provider, onClose, onSave }) {
  const existing = provider || {};
  const config = existing.requestConfig || {};
  // 专属适配厂商（Claude/Codex/Gemini/Kimi 订阅/Grok）：请求与解析内置，编辑时只保留名称/Logo/官网/浪费统计
  const cliAdapter = isCliProvider(existing);
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
  // 浪费统计窗口：null = 未手动设置，跟随额度窗口自动判定；勾选后写死为数组（与 waste.cjs 的 resolveWasteWindows 对应）
  const [wasteWindows, setWasteWindows] = useState(Array.isArray(config.wasteWindows) ? config.wasteWindows.filter((key) => ['weekly', 'monthly'].includes(key)) : null);
  // 候选只限周期窗口（weekly/monthly）；没有周期窗口的厂商不显示这项配置
  const wasteCandidates = providerWindowKeys({ adapter: existing.adapter, requestConfig: config }).filter((key) => ['weekly', 'monthly'].includes(key));
  const toggleWasteWindow = (key) => setWasteWindows((old) => {
    const current = old ?? wasteCandidates;
    return current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
  });
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
    // 专属适配厂商：不覆盖内置的请求/解析配置，只保存名称、Logo、官网与浪费统计窗口
    if (cliAdapter) {
      onSave({ id: provider?.id, name: name || existing.name || '厂商', adapter: provider?.adapter, logo, website: String(website || '').trim(), requestConfig: { ...config, ...(wasteWindows ? { wasteWindows } : {}) } });
      return;
    }
    const windowMap = Object.fromEntries(windowMapText.split('\n').map((line) => line.trim()).filter((line) => line.includes('=')).map((line) => { const [source, target] = line.split('=').map((item) => item.trim()); return [source.toLowerCase(), target]; }));
    let responseRules;
    try { responseRules = responseRulesText.trim() ? JSON.parse(responseRulesText) : undefined; }
    catch (error) { setConfigError(`响应规则 JSON 无效：${error.message}`); return; }
    if (responseRules && !Array.isArray(responseRules)) { setConfigError('响应规则必须是 JSON 数组'); return; }
    const cleanVariables = variables.map((item) => ({ key: String(item.key || '').trim(), label: String(item.label || '').trim(), defaultValue: item.defaultValue ?? '', required: Boolean(item.required), secret: Boolean(item.secret) })).filter((item) => item.key);
    if (cleanVariables.some((item) => !/^[A-Za-z_][\w.-]*$/.test(item.key))) { setConfigError('变量名只能使用字母、数字、下划线、点和连字符，且不能以数字开头'); return; }
    const endpointVariable = cleanVariables.find((item) => item.key === 'endpoint');
    onSave({ id: provider?.id, name: name || '新厂商', adapter: provider?.adapter || 'generic', logo, website: String(website || '').trim(), requestConfig: { ...config, adapterMode: ['grok', ...CLI_ADAPTER_MODES].includes(config.adapterMode) ? config.adapterMode : advancedEnabled ? 'script' : 'standard', endpoint: advancedEnabled ? (endpointVariable?.defaultValue || endpoint) : endpoint, method, auth, authHeader, authPrefix, authQuery, headers, body, credentialRequired: advancedEnabled ? false : credentialRequired, variables: advancedEnabled ? cleanVariables : [], script: advancedEnabled ? script.trim() : '', responseRules: advancedEnabled ? undefined : responseRules, collectionMode, listPath, windowField, defaultWindow, windowMap, totalPath, remainingPath, usedPath, percentagePath, percentageMode, availablePath, unit, resetPath, ...(wasteWindows ? { wasteWindows } : {}) } });
  };
  return <div className="modal-backdrop" onClick={onClose}><form className={`modal provider-modal ${advancedEnabled ? 'script-mode' : ''}`} onSubmit={submit} onClick={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><h2>{provider ? '编辑厂商' : '新增厂商'}</h2></div></div>
    <div className="logo-upload">{logo ? <span className="upload-preview"><img src={logo} alt="Logo 预览" /></span> : <span className="upload-mark"><UploadCloud size={19} /></span>}<div><b>{logo ? 'Logo 已准备好' : '上传厂商 Logo'}</b><small>PNG / SVG / WebP，建议 64 × 64</small></div><label className="outline-button file-button"><UploadCloud size={13} /> {logo ? '更换' : '选择文件'}<input type="file" accept="image/png,image/svg+xml,image/webp" onChange={readLogo} /></label></div>
    <label className="field"><span>厂商名称</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="field"><span>官网地址 <small>悬停厂商图标可进入官网，留空则不提供入口</small></span><input value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://www.example.com" /></label>
    {!cliAdapter && <Toggle checked={advancedEnabled} onChange={setAdvancedEnabled} label="高级适配脚本" description="开启后脚本独立负责请求与响应解析" />}
    {wasteCandidates.length > 0 && <div className="adapter-config"><span className="eyebrow">浪费统计</span>
      <div className="field"><span>统计窗口 <small>勾选参与周期末浪费归档的窗口，全部取消则该厂商不做浪费统计</small></span>
        <div className="window-choice">{wasteCandidates.map((key) => { const on = (wasteWindows ?? wasteCandidates).includes(key); return <button type="button" key={key} className={`window-choice-item ${on ? 'selected' : ''}`} onClick={() => toggleWasteWindow(key)}><span>{on ? <Check size={14} /> : <span className="empty-check" />}</span>{windowCatalog[key]?.label || key}</button>; })}</div>
      </div></div>}
    {!cliAdapter && <div className="form-grid preset-grid"><button type="button" className="outline-button" onClick={() => { setAdvancedEnabled(true); setScript(newApiTemplateScript); setVariables([{ key: 'endpoint', label: '站点地址', defaultValue: 'https://your-newapi-site.com', required: true, secret: false, system: false }, { key: 'accessToken', label: '面板 accessToken', defaultValue: '', required: true, secret: true, system: false }, { key: 'userId', label: '面板用户 ID', defaultValue: '', required: true, secret: false, system: false }]); }}><Sparkles size={14} /> New API 站点模板</button><small className="preset-hint">一键填入 New API 系中转站的余额查询脚本</small></div>}
    {!cliAdapter && (advancedEnabled ? <><div className="adapter-config variable-editor"><div className="variable-editor-head"><span className="eyebrow">账号变量</span><button type="button" className="mini-add" onClick={() => setVariables((old) => [...old, { key: '', label: '', defaultValue: '', required: false, secret: false }])}><Plus size={13} /> 新增变量</button></div>{variables.length > 0 && <div className="variable-row variable-row-head"><span>变量名<small>脚本里用 {'{{变量名}}'} 引用</small></span><span>显示名称<small>账号表单上的标签</small></span><span>默认值<small>账号没填时使用</small></span><span>必填</span><span>敏感</span><span /></div>}{variables.length === 0 ? <div className="settings-empty">没有额外变量</div> : variables.map((item, index) => <div className="variable-row" key={`${item.key}-${index}`}><input value={item.key || ''} readOnly={item.system} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, key: event.target.value } : entry))} placeholder="变量名" /><input value={item.label || ''} readOnly={item.system} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, label: event.target.value } : entry))} placeholder="显示名称" /><input value={item.defaultValue ?? ''} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, defaultValue: event.target.value } : entry))} placeholder="默认值" /><label title="账号必须填写"><input type="checkbox" checked={Boolean(item.required)} disabled={item.key === 'apiKey'} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, required: event.target.checked } : entry))} />必填</label><label title="使用 Windows DPAPI 加密"><input type="checkbox" checked={Boolean(item.secret)} disabled={item.system} onChange={(event) => setVariables((old) => old.map((entry, entryIndex) => entryIndex === index ? { ...entry, secret: event.target.checked } : entry))} />敏感</label><span className="variable-row-tail">{item.system && <span className="variable-system-badge" title="厂商内置变量，用法和自定义变量一样，也可以删除">内置</span>}<button type="button" className="row-icon-button danger" onClick={() => setVariables((old) => old.filter((_entry, entryIndex) => entryIndex !== index))} title="删除变量" aria-label="删除变量"><Trash2 size={13} /></button></span></div>)}</div><label className="field"><span>适配脚本</span><textarea className="script-editor" required value={script} onChange={(event) => setScript(event.target.value)} placeholder="({ request: { url: '{{endpoint}}?region={{region}}', method: 'GET' }, extractor(response, variables) { return { key: 'weekly', remaining: 50, total: 100, unit: '%' }; } })" /></label></> : <>
      <div className="form-grid"><label className="field"><span>默认额度接口 <small>必须是完整 URL</small></span><input required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com/v1/usage" /></label><label className="field"><span>请求方法</span><select value={method} onChange={(event) => setMethod(event.target.value)}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option></select></label></div>
      <div className="adapter-config"><span className="eyebrow">认证与请求</span><div className="form-grid"><label className="field"><span>认证方式</span><select value={auth} onChange={(event) => setAuth(event.target.value)}><option value="bearer">Bearer Token</option><option value="token">自定义 Header</option><option value="cookie">Cookie</option><option value="query">Query 参数</option><option value="none">无需认证</option></select></label>{auth === 'query' ? <label className="field"><span>Query 参数名</span><input value={authQuery} onChange={(event) => setAuthQuery(event.target.value)} /></label> : auth !== 'none' && <label className="field"><span>认证 Header</span><input value={authHeader} onChange={(event) => setAuthHeader(event.target.value)} /></label>}</div>{(auth === 'bearer' || auth === 'token') && <label className="field"><span>凭据前缀 <small>例如 Bearer，末尾空格会保留</small></span><input value={authPrefix} onChange={(event) => setAuthPrefix(event.target.value)} /></label>}<div className="form-grid"><label className="field"><span>额外请求头 JSON</span><textarea value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder={'{"X-Client": "QuotaDesk"}'} /></label><label className="field"><span>请求体 JSON <small>GET 时忽略</small></span><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={'{"account": "{{accountId}}"}'} /></label></div></div>
      <div className="adapter-config"><span className="eyebrow">响应字段映射</span><div className="form-grid"><label className="field"><span>数据路径</span><input value={listPath} onChange={(event) => setListPath(event.target.value)} placeholder="data.quota，可留空" /></label><label className="field"><span>数据形态</span><select value={collectionMode} onChange={(event) => setCollectionMode(event.target.value)}><option value="auto">自动判断</option><option value="single">单个对象</option><option value="array">数组</option><option value="object-entries">对象键作为窗口</option></select></label></div><div className="form-grid"><label className="field"><span>窗口字段</span><input value={windowField} onChange={(event) => setWindowField(event.target.value)} /></label><label className="field"><span>默认窗口</span><select value={defaultWindow} onChange={(event) => setDefaultWindow(event.target.value)}><option value="five_hour">5 小时</option><option value="daily">1 天</option><option value="weekly">7 天</option><option value="monthly">1个月</option><option value="balance">余额</option></select></label></div><label className="field"><span>窗口值映射 <small>每行：接口值=内部窗口</small></span><textarea value={windowMapText} onChange={(event) => setWindowMapText(event.target.value)} /></label><div className="form-grid mapping-grid"><label className="field"><span>总量路径</span><input value={totalPath} onChange={(event) => setTotalPath(event.target.value)} /></label><label className="field"><span>剩余路径</span><input value={remainingPath} onChange={(event) => setRemainingPath(event.target.value)} /></label><label className="field"><span>已用路径</span><input value={usedPath} onChange={(event) => setUsedPath(event.target.value)} /></label><label className="field"><span>百分比路径</span><input value={percentagePath} onChange={(event) => setPercentagePath(event.target.value)} /></label></div><div className="form-grid"><label className="field"><span>百分比含义</span><select value={percentageMode} onChange={(event) => setPercentageMode(event.target.value)}><option value="used">已用百分比</option><option value="remaining">剩余百分比</option></select></label><label className="field"><span>可用状态路径</span><input value={availablePath} onChange={(event) => setAvailablePath(event.target.value)} placeholder="isValid / status" /></label></div><div className="form-grid"><label className="field"><span>单位</span><input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="% / CNY / USD" /></label><label className="field"><span>刷新时间路径</span><input value={resetPath} onChange={(event) => setResetPath(event.target.value)} /></label></div></div>
      <label className="field"><span>多规则响应映射 JSON <small>填写后优先于上方单规则映射</small></span><textarea className="rules-editor" value={responseRulesText} onChange={(event) => setResponseRulesText(event.target.value)} placeholder={'[{"listPath":"rate_limits","collectionMode":"array","filterPath":"window","filterValue":"7d","defaultWindow":"weekly","totalPath":"limit","remainingPath":"remaining","resetPath":"reset_at"}]'} /></label>
    </>)}
    {configError && <div className="desktop-error"><AlertCircle size={14} /><span>{configError}</span></div>}
    <div className="adapter-note"><Sparkles size={15} /><span>{cliAdapter ? '专属适配厂商：请求与解析逻辑已内置（凭据来自本机 CLI 登录态 / 官方接口），只需维护名称、Logo、官网与浪费统计窗口。' : advancedEnabled ? '脚本模式仅使用脚本中的 request 和 extractor。' : '标准模式支持完整 URL、方法、Header/Query/Cookie 认证、请求头/请求体 JSON 与多形态响应。'}</span></div>
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
  // 停用账号不在浮窗轮播：只统计未停用的；全部停用时显示占位（和“还没有账号”的空白区分开）
  const activeAccounts = accounts.filter((item) => !item.disabled);
  const activeCount = activeAccounts.length;
  useEffect(() => { const timer = setInterval(() => { if (Date.now() - lastWheelAt.current < 10000) return; setIndex((value) => (value + 1) % Math.max(activeCount, 1)); }, 6000); return () => clearInterval(timer); }, [activeCount]);
  const cycleAccount = (direction) => { lastWheelAt.current = Date.now(); setIndex((value) => (value + direction + Math.max(activeCount, 1)) % Math.max(activeCount, 1)); };
  const account = activeAccounts[index % Math.max(activeCount, 1)];
  const provider = providers.find((item) => item.id === account?.providerId);
  const startDrag = (event) => { if (event.button !== 0) return; dragRef.current = { active: true, moved: false, x: event.screenX, y: event.screenY }; event.currentTarget.setPointerCapture?.(event.pointerId); };
  const moveDrag = (event) => { const drag = dragRef.current; if (!drag.active) return; const deltaX = event.screenX - drag.x; const deltaY = event.screenY - drag.y; if (!deltaX && !deltaY) return; drag.moved ||= Math.abs(deltaX) + Math.abs(deltaY) > 2; drag.x = event.screenX; drag.y = event.screenY; window.quotaDesk?.moveWidget(deltaX, deltaY); };
  const stopDrag = () => { dragRef.current.active = false; };
  return <div className="widget-window-shell" title="拖动移动，双击展开，滚轮切换账号，右键打开菜单" onWheel={(event) => cycleAccount(event.deltaY > 0 ? 1 : -1)} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag} onDoubleClick={() => { if (!dragRef.current.moved) window.quotaDesk?.openMainWindow(); }}><WidgetScaledRow scale={clampWidgetScale(settings.widgetScale)} length={clampWidgetLength(settings.widgetLength)}>{account || accounts.length === 0
        ? <WidgetRow account={account} provider={provider} compact tagLimit={Number(settings.widgetTagLimit ?? 2)} length={clampWidgetLength(settings.widgetLength)} />
        : <div className="widget-all-disabled"><CircleStop size={12} /><span>所有账号均已停用</span></div>}</WidgetScaledRow></div>;
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
    <div className="modal-head"><div><h2>从 cc-switch 导入账号</h2></div></div>
    <div className="adapter-note"><ShieldCheck size={15} /><span>迁移 API Key 与官方 OAuth 登录（Codex），凭据仍由 Windows DPAPI 加密保存；重复的 Key / 登录不会重复导入。官方登录导入后由本应用自动续期，不受 profile 切换影响。</span></div>
    {error && <div className="adapter-note update-error"><AlertCircle size={15} /><span>{error}</span></div>}
    {!scan && !error && <div className="settings-empty">正在读取 cc-switch 数据…</div>}
    {scan && <>
      {importable.length === 0 && <div className="settings-empty">没有可导入的账号（厂商不支持或 Key 已存在）</div>}
      {importable.length > 0 && <div className="settings-list import-list">{importable.map((item) => <label className="settings-account import-row" key={item.key}><input type="checkbox" checked={Boolean(selected[item.key])} onChange={(event) => setSelected((old) => ({ ...old, [item.key]: event.target.checked }))} /><div><b title={item.name}>{item.name}</b><small>{item.providerName} · {item.kind === 'oauth' ? `官方 OAuth 登录${item.oauthDisplay ? ` · ${item.oauthDisplay}` : ''}` : item.keyTail}</small></div></label>)}</div>}
      {duplicates.length > 0 && <div className="adapter-note"><Check size={15} /><span>已跳过重复 Key：{duplicates.map((item) => item.name).join('、')}</span></div>}
      {(scan.unsupported || []).length > 0 && <div className="adapter-note"><AlertCircle size={15} /><span>暂不支持：{(scan.unsupported || []).map((item) => item.name).join('、')}</span></div>}
      <div className="modal-actions"><button type="button" className="outline-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={applying || selectedCount === 0} onClick={apply}>{applying ? '正在导入…' : `导入所选（${selectedCount}）`}</button></div>
    </>}
  </div></div>;
}


// CLI 官方登录快照导入：把本机各 CLI 的当前登录收录为独立账号（多账号监控的入口）。
// token 全程留在主进程，弹窗里只显示检测到的账号标识（邮箱 / 指纹尾号）
const CLI_LOGIN_KINDS = [
  { kind: 'codex', name: 'Codex', providerId: 'codex', path: '~/.codex/auth.json', hint: 'ChatGPT 官方登录' },
  { kind: 'claude', name: 'Claude Code', providerId: 'claude', path: '~/.claude/.credentials.json', hint: '官方 OAuth 登录' },
  { kind: 'gemini', name: 'Gemini CLI', providerId: 'gemini', path: '~/.gemini/oauth_creds.json', hint: 'Google 账号登录' },
  { kind: 'grok', name: 'Grok CLI', providerId: 'grok', path: '~/.grok/auth.json', hint: 'xAI 官方登录' },
  { kind: 'grokbot', name: 'Grok Bot', providerId: 'grokbot', path: 'Grok Bot 桌面客户端', hint: 'Grok Bot 客户端登录' },
];

// 扫码二维码渲染成本地 data URL（qrcode-generator 纯前端生成，登录链接不出本机）
const buildQrDataUrl = (content) => {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(content);
    qr.make();
    return qr.createDataURL(5, 8);
  } catch { return ''; }
};

// 标题旁的问号帮助：说明文字默认隐藏，悬停 / 键盘聚焦才展开。
// 气泡用 portal 渲染到 body 顶层并 fixed 定位：不进弹窗的布局流（否则会撑出横向滚动条），
// 也不受弹窗 overflow 裁剪，永远浮在最高层。
function TitleHelp({ children }) {
  const [anchor, setAnchor] = useState(null); // { left, top } 视口坐标
  const iconRef = useRef(null);
  const show = () => {
    const box = iconRef.current?.getBoundingClientRect();
    if (box) setAnchor({ left: Math.max(8, Math.min(box.left, window.innerWidth - 260)), top: box.bottom + 7 });
  };
  const hide = () => setAnchor(null);
  return <>
    <span ref={iconRef} className="title-help" tabIndex={0} role="note" aria-label="说明" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}><HelpCircle size={14} /></span>
    {anchor && createPortal(<span className="title-help-pop" style={anchor}>{children}</span>, document.body)}
  </>;
}

// Kimi 订阅扫码登录面板（无弹窗壳，两种宿主共用）：分两步走——
// 第一步只扫码验证（二维码放大），第二步确认后才设置账号名 / 标签，点「完成」才真正导入
// （import 新建账号 / relogin 回写原账号）。导入动作由按钮触发（不在 effect 里），
// 避开导入期间 state:updated 广播重渲染把完成回调判过期丢掉的问题；令牌全程只留在主进程。
function KimiQrPanel({ mode = 'import', reloginAccount = null, onExit, onImported, onFinish, exitLabel = '退出' }) {
  const bridge = window.quotaDesk;
  const [session, setSession] = useState(null); // { code, dataUrl, step, status, message, display }
  const [draft, setDraft] = useState(() => mode === 'relogin'
    ? { name: reloginAccount?.name || 'Kimi 订阅', tags: (reloginAccount?.tags || []).join(', ') }
    : { name: 'Kimi 订阅', tags: '' });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // 一次性守卫：确认成功只认一次（轮询的相邻两拍都可能看到 success）；导入只允许点一次
  const settledRef = useRef(false);
  const importingRef = useRef(false);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const confirm = () => {
    if (importingRef.current || !settledRef.current || !session?.code) return;
    importingRef.current = true;
    setSession((old) => ({ ...old, status: 'importing', message: '' }));
    const options = {
      ...(mode === 'relogin' ? { accountId: reloginAccount?.id } : {}),
      name: String(draftRef.current?.name || '').trim(),
      tags: String(draftRef.current?.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean),
    };
    bridge?.importKimiQrLogin?.(session.code, options).then((imported) => {
      if (imported?.duplicate) {
        // 登录属于另一个已收录账号：code 已消费，只能换号重扫
        importingRef.current = false;
        setSession((old) => ({ ...old, status: 'error', message: `该登录已是账号「${imported.name}」的登录，请换一个账号重扫` }));
        return;
      }
      onImportedRef.current?.('kimi-subscription', imported);
      onFinishRef.current?.();
    }).catch((importError) => {
      importingRef.current = false;
      setSession((old) => ({ ...old, status: 'error', message: importError.message }));
    });
  };
  const start = async () => {
    settledRef.current = false;
    importingRef.current = false;
    setSession({ code: null, dataUrl: '', step: 'scan', status: 'pending', message: '', display: '' });
    try {
      const created = await bridge?.startKimiQrLogin?.();
      if (!created?.code) throw new Error('二维码创建失败');
      setSession({ code: created.code, dataUrl: buildQrDataUrl(created.qr), step: 'scan', status: 'pending', message: '', display: '' });
    } catch (startError) {
      setSession({ code: null, dataUrl: '', step: 'scan', status: 'error', message: startError.message, display: '' });
    }
  };
  useEffect(() => { start(); }, []);
  // 扫码状态轮询：第一步期间每 2 秒问一次主进程（令牌留在主进程，只回传状态）；
  // 确认成功即进入第二步（step: 'configure'）
  useEffect(() => {
    if (!session?.code || session.step !== 'scan' || !['pending', 'scanned'].includes(session.status)) return undefined;
    let active = true;
    const timer = setInterval(() => {
      bridge?.pollKimiQrLogin?.(session.code).then((polled) => {
        if (!active || !polled) return;
        if (polled.status === 'success') {
          if (settledRef.current) return;
          settledRef.current = true;
          setSession((old) => ({ ...old, step: 'configure', status: 'confirmed', display: polled.display || '' }));
        } else if (polled.status === 'expired') setSession((old) => ({ ...old, status: 'expired' }));
        else if (polled.status === 'scanned') setSession((old) => (old.status === 'scanned' ? old : { ...old, status: 'scanned' }));
      }).catch(() => {});
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [session?.code, session?.step, session?.status, bridge]);
  const status = session?.status || 'pending';
  const step = session?.step || 'scan';
  const importing = status === 'importing';
  const statusCopy = {
    pending: '打开手机上的 Kimi App / 微信扫码',
    scanned: '已扫码，请在手机上确认',
    expired: '二维码已过期，点击刷新',
    error: session?.message || '出错了，请重试',
  }[status] || '';
  return <>
    <div className="modal-head"><div><h2>{mode === 'relogin' ? '重新扫码登录' : '添加 Kimi 订阅'}<TitleHelp>{mode === 'relogin'
      ? 'Kimi 订阅令牌已失效：重新扫码即可恢复，账号名与标签在第二步可顺手修改。'
      : '扫码登录 Kimi 官方订阅：令牌加密保存在本机并自动续期，含 5 小时 / 7 天 / 月订阅额度。'}</TitleHelp></h2></div></div>
    {step === 'scan'
      ? <div className="kimi-qr-stage">
        <div className={`kimi-qr-frame ${status === 'expired' || status === 'error' ? 'stale' : ''}`}>
          {session?.dataUrl
            ? <img className="kimi-qr-image" src={session.dataUrl} alt="Kimi 登录二维码" />
            : <div className="kimi-qr-placeholder"><RefreshCw size={16} className={status === 'pending' && !session?.code ? 'spinning' : ''} /></div>}
          {(status === 'expired' || status === 'error') && (
            <button type="button" className="kimi-qr-refresh" title={status === 'expired' ? '刷新二维码' : '重试'} aria-label={status === 'expired' ? '刷新二维码' : '重试'} onClick={start}><RefreshCw size={22} /></button>
          )}
        </div>
        <small className={`kimi-qr-status ${status === 'error' || status === 'expired' ? 'fail' : status === 'scanned' ? 'ok' : ''}`}>{statusCopy}</small>
      </div>
      : <div className="kimi-qr-configure">
        <div className="kimi-qr-ok">
          <span className="kimi-qr-done-icon"><Check size={18} /></span>
          <div><b>扫码成功</b>{session?.display && <small>标识：{session.display}</small>}</div>
        </div>
        {status === 'error' && <div className="adapter-note update-error"><AlertCircle size={15} /><span>{statusCopy}</span></div>}
        {importing && <div className="adapter-note"><RefreshCw size={15} className="spinning" /><span>正在导入，请稍候…</span></div>}
        <div className="form-grid">
          <label className="field"><span>账号名 <small>留空则用渠道名</small></span><input value={draft.name} onChange={(event) => setDraft((old) => ({ ...old, name: event.target.value }))} placeholder="Kimi 订阅" disabled={importing} /></label>
          <label className="field"><span>标签 <small>逗号分隔，可留空</small></span><input value={draft.tags} onChange={(event) => setDraft((old) => ({ ...old, tags: event.target.value }))} placeholder="可留空，多个用逗号分隔" disabled={importing} /></label>
        </div>
      </div>}
    <div className="modal-actions">
      {step === 'scan'
        ? <button type="button" className="outline-button" onClick={onExit}>{exitLabel}</button>
        : <>
          <button type="button" className="outline-button" disabled={importing} onClick={start}><RefreshCw size={13} /> 重新扫码</button>
          <button type="button" className="primary-button" disabled={importing || status === 'error'} onClick={confirm}>{importing ? '正在导入…' : '完成'}</button>
        </>}
    </div>
  </>;
}

// GitHub 设备码轮询的基础间隔：GitHub 给该客户端的 interval 是 5 秒，加 300ms 余量
// 避免贴着边界发被限频（slow_down 后间隔自动 +5 秒，上限 30 秒）
const COPILOT_POLL_GAP_MS = 5_300;

// GitHub Copilot 设备码登录面板（无弹窗壳，两种宿主共用）：与 Kimi 扫码同一两步模式——
// 第一步展示设备码并拉起浏览器完成 GitHub 授权，第二步确认账号名 / 标签后导入
// （import 新建账号 / relogin 回写原账号）。轮询间隔用 GitHub 返回的 interval；
// 令牌全程只留在主进程，渲染层只拿设备码与 GitHub 登录名。
function CopilotDevicePanel({ mode = 'import', reloginAccount = null, onExit, onImported, onFinish, onToast = null, exitLabel = '退出' }) {
  const bridge = window.quotaDesk;
  const [session, setSession] = useState(null); // { key, userCode, verificationUri, interval, step, status, message, display }
  const [draft, setDraft] = useState(() => mode === 'relogin'
    ? { name: reloginAccount?.name || 'GitHub Copilot', tags: (reloginAccount?.tags || []).join(', ') }
    : { name: 'GitHub Copilot', tags: '' });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // 一次性守卫：授权成功只认一次（轮询的相邻两拍都可能看到 success）；导入只允许点一次
  const settledRef = useRef(false);
  const importingRef = useRef(false);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const confirm = () => {
    if (importingRef.current || !settledRef.current || !session?.key) return;
    importingRef.current = true;
    setSession((old) => ({ ...old, status: 'importing', message: '' }));
    const options = {
      ...(mode === 'relogin' ? { accountId: reloginAccount?.id } : {}),
      name: String(draftRef.current?.name || '').trim(),
      tags: String(draftRef.current?.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean),
    };
    bridge?.importCopilotDeviceLogin?.(session.key, options).then((imported) => {
      if (imported?.duplicate) {
        // 授权的 GitHub 账号属于另一个已收录账号：device_code 已消费，只能换号重新授权
        importingRef.current = false;
        setSession((old) => ({ ...old, status: 'error', message: `该 GitHub 账号已是账号「${imported.name}」的登录，请换一个账号重新授权` }));
        return;
      }
      onImportedRef.current?.('copilot', imported);
      onFinishRef.current?.();
    }).catch((importError) => {
      importingRef.current = false;
      setSession((old) => ({ ...old, status: 'error', message: importError.message }));
    });
  };
  const start = async () => {
    settledRef.current = false;
    importingRef.current = false;
    gapRef.current = COPILOT_POLL_GAP_MS;
    lastPollAtRef.current = 0;
    setSession({ key: null, userCode: '', verificationUri: '', step: 'authorize', status: 'pending', message: '', display: '' });
    try {
      const created = await bridge?.startCopilotDeviceLogin?.();
      if (!created?.key || !created?.userCode) throw new Error('设备码创建失败');
      setSession({ key: created.key, userCode: created.userCode, verificationUri: created.verificationUri || 'https://github.com/login/device', step: 'authorize', status: 'pending', message: '', display: '' });
      // 设备码下发即拉起浏览器授权页；没自动打开时也可手动重开
      bridge?.openExternal?.(created.verificationUri || 'https://github.com/login/device');
    } catch (startError) {
      setSession({ key: null, userCode: '', verificationUri: '', step: 'authorize', status: 'error', message: startError.message, display: '' });
    }
  };
  useEffect(() => { start(); }, []);
  // GitHub 设备码限频：两次查询必须间隔 ≥ interval 秒，发快了回 slow_down 且 interval +5s。
  // 轮询节奏用「自调度 setTimeout 链」管理，间隔变化（slow_down 加长）不会重置链；
  // 自动轮询全程静默，只有用户点「立即检测」才以轻提示给出这一次的结论。
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const lastPollAtRef = useRef(0); // 上次查询发出的时刻（手动/自动共用，限频判定）
  const gapRef = useRef(COPILOT_POLL_GAP_MS); // 当前查询间隔（slow_down 时静默加长，上限 30 秒）
  // 轮询结果统一处理（自动与手动共用）：只推进界面状态，不产生提示
  const handlePolled = (polled) => {
    if (!polled) return;
    if (polled.status === 'success') {
      if (settledRef.current) return;
      settledRef.current = true;
      setSession((old) => ({ ...old, step: 'configure', status: 'confirmed', display: polled.display || '' }));
    } else if (polled.status === 'expired') setSession((old) => ({ ...old, status: 'expired' }));
    else if (polled.status === 'denied') setSession((old) => ({ ...old, status: 'denied' }));
    else if (polled.status === 'pending') {
      if (polled.error === 'slow_down') {
        // GitHub 要求放慢：间隔 +5 秒（上限 30 秒）。只改 ref，不触碰轮询链，
        // 下一次自动查询自然用新间隔——绝不能因间隔变化重建定时器（否则节奏清零又会超频）
        gapRef.current = Math.min(30_000, gapRef.current + 5_000);
      } else if (polled.error) {
        // 其它轮询失败（网络/代理）不中断等待，错误写进状态行可见，恢复后自动继续
        setSession((old) => ({ ...old, message: String(polled.error) }));
      }
    }
  };
  const handlePolledRef = useRef(handlePolled);
  handlePolledRef.current = handlePolled;
  const sendPoll = async () => {
    const key = sessionRef.current?.key;
    if (!key) return null;
    lastPollAtRef.current = Date.now();
    try {
      const polled = await bridge?.pollCopilotDeviceLogin?.(key);
      handlePolledRef.current?.(polled);
      return polled;
    } catch (pollError) {
      const fallback = { status: 'pending', error: pollError?.message || '轮询请求失败' };
      handlePolledRef.current?.(fallback);
      return fallback;
    }
  };
  // 「我已授权」：无倒计时——限频间隔内静默等到允许时刻再发，期间只显示「检测中…」；
  // 结论以页面顶部的轻提示（toast）反馈，成功则直接进入第二步（界面切换即是反馈）
  const checkNow = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const waitMs = lastPollAtRef.current ? Math.max(0, gapRef.current - (Date.now() - lastPollAtRef.current)) : 0;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (settledRef.current || (sessionRef.current?.step || 'authorize') !== 'authorize') return;
      const polled = await sendPoll();
      if (polled?.status === 'pending') {
        onToast?.({
          id: Date.now(),
          ok: false,
          message: polled.error === 'slow_down'
            ? '查询太频繁（GitHub 限频），自动轮询稍后会继续'
            : polled.error
              ? `检测失败：${polled.error}`
              : 'GitHub 显示该设备码尚未被授权：请确认浏览器里输入的码与面板当前一致',
        });
      }
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };
  // 自动轮询：自调度链式 setTimeout，间隔取 gapRef 的实时值；首拍就按完整间隔发，
  // 不做提前查询（提前发会被 GitHub 判 slow_down，并连带加长间隔）
  useEffect(() => {
    if (!session?.key || session.step !== 'authorize' || session.status !== 'pending') return undefined;
    let active = true;
    let timer = null;
    const schedule = () => {
      if (!active) return;
      timer = setTimeout(async () => {
        if (!active) return;
        await sendPoll();
        schedule();
      }, gapRef.current + 300); // +300ms 余量：贴着 interval 边界发也可能被判超频
    };
    schedule();
    return () => { active = false; if (timer) clearTimeout(timer); };
    // 刻意不含 gap：间隔变化不得重置轮询链（见 handlePolled 的 slow_down 分支）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.key, session?.step, session?.status, bridge]);
  const status = session?.status || 'pending';
  const step = session?.step || 'authorize';
  const importing = status === 'importing';
  const stale = ['expired', 'denied', 'error'].includes(status);
  const statusCopy = {
    pending: session?.message
      ? `等待授权中…（轮询异常，正在重试：${session.message}；若持续失败请在「设置 → 网络代理」配置代理）`
      : '在打开的 GitHub 页面输入设备码并确认授权',
    denied: '已在 GitHub 拒绝授权，点击刷新重试',
    expired: '设备码已过期，点击刷新',
    error: session?.message || '出错了，请重试',
  }[status] || '';
  const copyUserCode = () => {
    if (!session?.userCode) return;
    navigator.clipboard?.writeText?.(session.userCode).catch(() => {});
  };
  return <>
    <div className="modal-head"><div><h2>{mode === 'relogin' ? '重新授权登录' : '添加 GitHub Copilot'}<TitleHelp>{mode === 'relogin'
      ? 'GitHub 授权已失效：重新走一次设备码授权即可恢复，账号名与标签在第二步可顺手修改。'
      : '设备码授权 GitHub 账号：令牌加密保存在本机，读取 Copilot「补充请求」月度额度（premium requests，每月 1 号重置）。'}</TitleHelp></h2></div></div>
    {step === 'authorize'
      ? <div className="copilot-device-stage">
        <div className={`copilot-code-frame ${stale ? 'stale' : ''}`} role="button" tabIndex={0} title="点击复制设备码" aria-label="复制设备码" onClick={copyUserCode} onKeyDown={(event) => { if (event.key === 'Enter') copyUserCode(); }}>
          <small>设备码（点击复制）</small>
          <b>{session?.userCode || '······-······'}</b>
        </div>
        {stale
          ? <button type="button" className="primary-button copilot-open-button" onClick={start}><RefreshCw size={13} /> 刷新设备码</button>
          : <div className="copilot-stage-actions">
            <button type="button" className="outline-button copilot-open-button" onClick={() => { if (session?.verificationUri) bridge?.openExternal?.(session.verificationUri); }}><ExternalLink size={13} /> 打开 GitHub 授权页</button>
            <button type="button" className="outline-button" disabled={checking} onClick={checkNow} title="已在浏览器完成授权？点击立即向 GitHub 查询该设备码的授权状态">{checking ? '检测中…' : '我已授权'}</button>
          </div>}
        <small className={`kimi-qr-status ${stale ? 'fail' : ''}`}>{statusCopy}</small>
      </div>
      : <div className="kimi-qr-configure">
        <div className="kimi-qr-ok">
          <span className="kimi-qr-done-icon"><Check size={18} /></span>
          <div><b>授权成功</b>{session?.display && <small>标识：{session.display}</small>}</div>
        </div>
        {status === 'error' && <div className="adapter-note update-error"><AlertCircle size={15} /><span>{statusCopy}</span></div>}
        {importing && <div className="adapter-note"><RefreshCw size={15} className="spinning" /><span>正在导入，请稍候…</span></div>}
        <div className="form-grid">
          <label className="field"><span>账号名 <small>留空则用渠道名</small></span><input value={draft.name} onChange={(event) => setDraft((old) => ({ ...old, name: event.target.value }))} placeholder="GitHub Copilot" disabled={importing} /></label>
          <label className="field"><span>标签 <small>逗号分隔，可留空</small></span><input value={draft.tags} onChange={(event) => setDraft((old) => ({ ...old, tags: event.target.value }))} placeholder="可留空，多个用逗号分隔" disabled={importing} /></label>
        </div>
      </div>}
    <div className="modal-actions">
      {step === 'authorize'
        ? <button type="button" className="outline-button" onClick={onExit}>{exitLabel}</button>
        : <>
          <button type="button" className="outline-button" disabled={importing} onClick={start}><RefreshCw size={13} /> 重新授权</button>
          <button type="button" className="primary-button" disabled={importing || status === 'error'} onClick={confirm}>{importing ? '正在导入…' : '完成'}</button>
        </>}
    </div>
  </>;
}

function ImportCliLoginModal({ accounts, providers, reloginAccount = null, onClose, onImported, onSaveAccount, onTestDraft, onToast = null, providerOrder = null, onReorderProviders = null }) {
  const bridge = window.quotaDesk;
  const [logins, setLogins] = useState(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(null);
  const [imported, setImported] = useState({});
  // Kimi 订阅扫码：同一个弹窗内切换视图（列表 ↔ 扫码），窗口尺寸恒定不变
  const [kimiQrOpen, setKimiQrOpen] = useState(false);
  // GitHub Copilot 设备码：与 Kimi 同一模式，列表只是入口，点击进入授权视图（同窗口）
  const [copilotOpen, setCopilotOpen] = useState(false);
  // CLI 渠道与 Kimi 同一模式：列表只是入口，点击进入渠道详情视图（同窗口）填写信息再导入
  const reloginKind = reloginAccount ? (CLI_LOGIN_KINDS.find((channel) => channel.providerId === reloginAccount.providerId)?.kind || null) : null;
  const [selectedKind, setSelectedKind] = useState(reloginKind);
  // API / 中转类厂商磁贴：点击进入固定厂商表单（厂商不可再切换，标题即厂商名）
  const [apiProviderId, setApiProviderId] = useState(null);
  // 每个渠道的导入草稿：账号名默认就是渠道名（如 Codex），标签默认留空；重新导入时保留原账号信息
  const [drafts, setDrafts] = useState({});
  // 磁贴拖拽排序：与总览卡片同一套 pointer 拖拽方案；拖动状态的项上浮，松手落位后持久化
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const dragMovedRef = useRef(false);
  const gridRef = useRef(null);
  useEffect(() => {
    let active = true;
    bridge?.readCliLogins?.().then((result) => { if (active) setLogins(result || {}); }).catch((scanError) => { if (active) setError(scanError.message); });
    return () => { active = false; };
  }, []);
  const collected = useMemo(() => new Set(accounts.filter((account) => account.cliAuthSource === 'snapshot' && account.cliFingerprint && account.id !== reloginAccount?.id).map((account) => `${account.providerId}|${account.cliFingerprint}`)), [accounts, reloginAccount]);
  const importOne = async (channel, draft) => {
    setImporting(channel.kind);
    setError('');
    try {
      const result = await bridge.importCliLogin(channel.kind, {
        ...(reloginAccount?.id ? { accountId: reloginAccount.id } : {}),
        name: String(draft?.name || '').trim(),
        tags: String(draft?.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean),
      });
      setImported((old) => ({ ...old, [channel.kind]: true }));
      onImported(channel.kind, result);
      setSelectedKind(null);
    } catch (importError) { setError(importError.message); }
    finally { setImporting(null); }
  };
  // 磁贴渠道清单：默认顺序 = CLI 订阅 → Copilot → DeepSeek → Z.ai → Kimi 订阅 → MiniMax → Grok Bot → wlbclub
  // → 其它 API / 中转厂商；用户拖过的自定义顺序（settings.providerOrder）叠在最前
  const tiles = useMemo(() => {
    const apiDefaults = new Map(['deepseek', 'zai', 'minimax', 'wlb'].map((id, index) => [id, index]));
    const apiProviders = (providers || [])
      .filter((provider) => !isCliProvider(provider))
      .sort((left, right) => (apiDefaults.get(left.id) ?? 99) - (apiDefaults.get(right.id) ?? 99));
    const all = [
      ...CLI_LOGIN_KINDS,
      ...(bridge?.startCopilotDeviceLogin ? [{ kind: 'copilot', name: 'GitHub Copilot', providerId: 'copilot', copilot: true }] : []),
      ...apiProviders.map((provider) => ({ kind: provider.id, name: provider.name, providerId: provider.id, api: true })),
    ];
    const kimiTile = bridge?.startKimiQrLogin ? [{ kind: 'kimi-subscription', name: 'Kimi 订阅', providerId: 'kimi-subscription', kimi: true }] : [];
    // Kimi 订阅排在 MiniMax 之前（用户指定：第八位）；API 列表里 MiniMax 默认第三位 → 插到它前面
    const minimaxIndex = all.findIndex((channel) => channel.kind === 'minimax');
    if (minimaxIndex >= 0) all.splice(minimaxIndex, 0, ...kimiTile);
    else all.push(...kimiTile);
    // Grok Bot 默认排在 wlbclub 前面（用户指定）：从 CLI 订阅段挪出，插到 wlb 磁贴之前；
    // wlb 不在列表时退回 CLI 段原位。已保存自定义顺序时，未记录项按稳定排序保持该相对位
    const grokBotIndex = all.findIndex((channel) => channel.kind === 'grokbot');
    if (grokBotIndex >= 0) {
      const [grokBotTile] = all.splice(grokBotIndex, 1);
      const wlbIndex = all.findIndex((channel) => channel.kind === 'wlb');
      if (wlbIndex >= 0) all.splice(wlbIndex, 0, grokBotTile);
      else all.splice(grokBotIndex, 0, grokBotTile);
    }
    if (!Array.isArray(providerOrder) || !providerOrder.length) return all;
    const orderIndex = new Map(providerOrder.map((id, index) => [id, index]));
    return [...all].sort((left, right) => {
      const leftIndex = orderIndex.has(left.kind) ? orderIndex.get(left.kind) : Number.MAX_SAFE_INTEGER;
      const rightIndex = orderIndex.has(right.kind) ? orderIndex.get(right.kind) : Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
  }, [providers, providerOrder, bridge]);
  const tileIdAt = (clientX, clientY) => {
    for (const el of document.elementsFromPoint?.(clientX, clientY) || []) {
      const id = el.closest?.('.import-tile')?.dataset?.providerId;
      if (id) return id;
    }
    return null;
  };
  const applyTileOrder = (fromId, toId) => {
    const order = tiles.map((channel) => channel.kind);
    const fromIndex = order.indexOf(fromId);
    const toIndex = order.indexOf(toId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    order.splice(toIndex, 0, ...order.splice(fromIndex, 1));
    onReorderProviders?.(order);
  };
  const onTilePointerDown = (event, channel) => {
    if (!onReorderProviders || event.button !== 0) return;
    const id = channel.kind;
    const startX = event.clientX;
    const startY = event.clientY;
    dragMovedRef.current = false;
    const move = (moveEvent) => {
      if (!dragMovedRef.current && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return;
      if (!dragMovedRef.current) { dragMovedRef.current = true; setDragId(id); }
      const targetId = tileIdAt(moveEvent.clientX, moveEvent.clientY);
      setOverId(targetId && targetId !== id ? targetId : null);
    };
    const up = (upEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      const targetId = tileIdAt(upEvent.clientX, upEvent.clientY);
      if (dragMovedRef.current && targetId && targetId !== id) applyTileOrder(id, targetId);
      setDragId(null);
      setOverId(null);
      // 拖拽结束的一拍内屏蔽磁贴的 click，避免松手被当成点击打开详情
      if (dragMovedRef.current) setTimeout(() => { dragMovedRef.current = false; }, 0);
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      setDragId(null);
      setOverId(null);
      dragMovedRef.current = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };
  const selected = tiles.find((channel) => channel.kind === selectedKind && !channel.kimi && !channel.copilot && !channel.api) || null;
  return <div className="modal-backdrop" onClick={onClose}><div className="modal compact-modal import-modal kimi-qr-modal import-window" onClick={(event) => event.stopPropagation()}>
    {kimiQrOpen
      ? <KimiQrPanel mode="import" exitLabel="返回" onExit={() => setKimiQrOpen(false)} onFinish={() => setKimiQrOpen(false)} onImported={(_kind, result) => {
        setImported((old) => ({ ...old, 'kimi-subscription': true }));
        onImported('kimi-subscription', result);
      }} />
      : copilotOpen
        ? <CopilotDevicePanel mode="import" exitLabel="返回" onExit={() => setCopilotOpen(false)} onFinish={onClose} onToast={onToast} onImported={(_kind, result) => {
          setImported((old) => ({ ...old, copilot: true }));
          onImported('copilot', result);
        }} />
        : apiProviderId
          ? <AccountModalV2 providers={providers} fixedProviderId={apiProviderId} embedded onBack={() => setApiProviderId(null)} onClose={onClose} onSave={onSaveAccount} onTestDraft={onTestDraft} />
          : selected
          ? (() => {
            const channel = selected;
            const info = (logins || {})[channel.kind] || { ok: false };
            const detecting = !logins && !error;
            const reloginChannel = reloginAccount && (reloginAccount.providerId === channel.providerId);
            const draft = drafts[channel.kind] || { name: reloginChannel ? reloginAccount.name : channel.name, tags: reloginChannel ? (reloginAccount.tags || []).join(', ') : '' };
            const updateDraft = (patch) => setDrafts((old) => ({ ...old, [channel.kind]: { ...draft, ...patch } }));
            const busy = importing === channel.kind;
            return <>
              <div className="modal-head"><div><h2>{reloginChannel ? `重新导入 ${channel.name}` : `添加 ${channel.name}`}<TitleHelp>{channel.hint}：把本机登录保存为独立账号快照，令牌自动续期，不受 cc-switch 切换影响。</TitleHelp></h2></div></div>
              <div className="cli-import-stage">
                {detecting
                  ? <div className="settings-empty">正在检测本机 CLI 登录…</div>
                  : <div className={`kimi-qr-ok ${info.ok ? '' : 'duplicate'}`}>
                    <span className={`kimi-qr-done-icon ${info.ok ? '' : 'duplicate'}`}>{info.ok ? <Check size={18} /> : <AlertCircle size={18} />}</span>
                    <div><b>{info.ok ? '已检测到本机登录' : '未检测到本机登录'}</b><small>{info.ok ? `标识：${info.display || '已登录'}` : `请先完成${channel.hint}（${channel.path}），再回来导入`}</small></div>
                  </div>}
                {error && <div className="adapter-note update-error"><AlertCircle size={15} /><span>{error}</span></div>}
                {busy && <div className="adapter-note"><RefreshCw size={15} className="spinning" /><span>正在导入，请稍候…</span></div>}
                <div className="form-grid">
                  <label className="field"><span>账号名 <small>留空则用渠道名</small></span><input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder={channel.name} disabled={busy} /></label>
                  <label className="field"><span>标签 <small>逗号分隔，可留空</small></span><input value={draft.tags} onChange={(event) => updateDraft({ tags: event.target.value })} placeholder="可留空，多个用逗号分隔" disabled={busy} /></label>
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="outline-button" disabled={busy} onClick={() => { setError(''); setSelectedKind(null); }}>返回</button>
                <button type="button" className="primary-button" disabled={detecting || !info.ok || busy} onClick={() => importOne(channel, draft)}>{busy ? '正在导入…' : (reloginChannel ? '重新导入' : '完成导入')}</button>
              </div>
            </>;
          })()
          : <>
            <div className="modal-head"><div><h2>{reloginAccount ? '重新导入订阅登录' : '添加账号'}<TitleHelp>官方订阅渠道自动连接本机登录（CLI 快照 / 扫码 / 设备码），令牌自动续期；API / 中转厂商填写地址与凭据。拖动磁贴可调整顺序。</TitleHelp></h2></div></div>
          {error && <div className="adapter-note update-error"><AlertCircle size={15} /><span>{error}</span></div>}
          {!logins && !error && <div className="settings-empty">正在检测本机 CLI 登录…</div>}
          {logins && <div className="import-grid" ref={gridRef}>{tiles.map((channel) => {
            const provider = providers?.find((item) => item.id === channel.providerId);
            const tileProps = {
              key: channel.kind,
              'data-provider-id': channel.kind,
              className: `import-tile ${dragId === channel.kind ? 'is-dragging' : ''} ${overId === channel.kind ? 'is-over' : ''}`,
              onPointerDown: (event) => onTilePointerDown(event, channel),
            };
            if (channel.kimi) {
              const done = imported['kimi-subscription'];
              const title = done ? 'Kimi 订阅 · 本次已导入' : 'Kimi 订阅 · 手机扫码登录，含月订阅额度，点击导入';
              return <button type="button" {...tileProps} className={`${tileProps.className} ${done ? 'is-disabled' : ''}`} title={title} aria-label={title} onClick={() => { if (!done && !dragMovedRef.current) setKimiQrOpen(true); }}>
                <Logo provider={provider} interactive={false} />
              </button>;
            }
            if (channel.copilot) {
              const done = imported.copilot;
              const title = done ? 'GitHub Copilot · 本次已导入' : 'GitHub Copilot · 设备码授权 GitHub 账号，读取「补充请求」月度额度，点击导入';
              return <button type="button" {...tileProps} className={`${tileProps.className} ${done ? 'is-disabled' : ''}`} title={title} aria-label={title} onClick={() => { if (!done && !dragMovedRef.current) setCopilotOpen(true); }}>
                <Logo provider={provider} interactive={false} />
              </button>;
            }
            if (channel.api) {
              const title = `${channel.name} · API / 中转接口，填写地址与凭据`;
              return <button type="button" {...tileProps} title={title} aria-label={title} onClick={() => { if (!dragMovedRef.current) { setError(''); setApiProviderId(channel.kind); } }}>
                <Logo provider={provider} interactive={false} />
              </button>;
            }
            const info = (logins || {})[channel.kind] || { ok: false };
            const already = collected.has(`${channel.kind}|${info.fingerprint}`);
            const done = imported[channel.kind] || already;
            const reloginChannel = reloginAccount && (reloginAccount.providerId === channel.providerId);
            const usable = info.ok && !done;
            const title = done
              ? (already ? `${channel.name} · 该登录已收录（标识：${info.display || '已保存'}），无需重复导入` : `${channel.name} · 本次已导入`)
              : info.ok
                ? `${channel.name} · ${channel.hint}（标识：${info.display || '已登录'}），点击${reloginChannel ? '重新导入' : '导入'}`
                : `${channel.name} · 未检测到本机登录：请先完成${channel.hint}（${channel.path}）`;
            return <button type="button" {...tileProps} className={`${tileProps.className} ${usable ? '' : 'is-disabled'}`} title={title} aria-label={title} onClick={() => { if (usable && !dragMovedRef.current) { setError(''); setSelectedKind(channel.kind); } }}>
              <Logo provider={provider} interactive={false} />
            </button>;
          })}</div>}
          <div className="modal-actions"><button type="button" className="primary-button" onClick={onClose}>退出</button></div>
        </>}
  </div></div>;
}


function UpdateModal({ update, version, onIgnore, onClose }) {
  const notes = update?.releaseNotes?.trim();
  const status = update?.status;
  const manualDownload = Boolean(update?.manualDownload);
  // 下载失败的重试直接重新下载；检查失败的重试才需要重新检查
  const retryUpdate = () => (update?.errorKind === 'download' ? window.quotaDesk?.downloadUpdate() : window.quotaDesk?.checkForUpdates());
  return <div className="modal-backdrop" onClick={onClose}><div className="modal compact-modal update-modal" onClick={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><h2>发现新版本 v{update?.version}</h2></div></div>
    <div className="adapter-note"><Download size={15} /><span>当前版本 v{version}，可升级到 v{update?.version}。</span></div>
    {status === 'error' && <div className="adapter-note update-error"><AlertCircle size={15} /><span>{update?.message || '检查更新失败，请稍后重试。'}</span></div>}
    {manualDownload && status === 'available' && <div className="adapter-note"><ExternalLink size={15} /><span>当前版本不支持应用内升级，将打开 GitHub 发布页手动下载。</span></div>}
    {notes ? <div className="release-notes">{notes}</div> : <div className="settings-empty">该版本没有提供更新说明</div>}
    {status === 'downloading' && <div className="update-progress" role="progressbar" aria-valuenow={update?.percent || 0}><i style={{ width: `${update?.percent || 0}%` }} /></div>}
    <div className="modal-actions">
      {status === 'available' && <button type="button" className="outline-button ignore-button" title="忽略该版本，不再主动提醒；后续新版本仍会正常提醒，可在设置中恢复" onClick={onIgnore}><BellOff size={14} /> 不提醒</button>}
      <button type="button" className="outline-button" onClick={onClose}>{status === 'downloaded' ? '稍后重启' : '暂不升级'}</button>
      {status === 'available' && <button type="button" className="primary-button" onClick={() => window.quotaDesk?.downloadUpdate()}>{manualDownload ? <ExternalLink size={14} /> : <Download size={14} />} {manualDownload ? '前往发布页下载' : '立即升级'}</button>}
      {status === 'downloading' && <button type="button" className="primary-button" disabled>下载中 {update?.percent || 0}%</button>}
      {status === 'downloaded' && <button type="button" className="primary-button" onClick={() => window.quotaDesk?.installUpdate()}><Power size={14} /> 重启并安装</button>}
      {status === 'error' && <button type="button" className="primary-button" onClick={retryUpdate}><RefreshCw size={14} /> 重试</button>}
    </div>
  </div></div>;
}

// 应用内操作确认弹窗：删除账号 / 清除历史 / 停用账号的确认都走这里，
// 不用 window.confirm 的系统级对话框，视觉与交互都留在应用界面内
function ConfirmModal({ confirm, onClose }) {
  return <div className="modal-backdrop" onClick={onClose}><div className="modal compact-modal confirm-modal" onClick={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><h2>{confirm.title}</h2></div></div>
    <p className="confirm-message">{confirm.message}</p>
    <div className="modal-actions">
      <button type="button" className="outline-button" onClick={onClose}>取消</button>
      <button type="button" className={confirm.danger ? 'danger-button' : 'primary-button'} onClick={() => { onClose(); confirm.action?.(); }}>{confirm.confirmLabel || '确认'}</button>
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
  // “不提醒”只忽略当前这一个版本：状态栏不再显示它的更新徽章，设置里仍可手动更新；
  // 记在 settings 里持久化，出现更新的版本号后自动恢复提醒
  const ignoreUpdate = () => {
    if (!update?.version) return;
    setSettings((old) => ({ ...old, ignoredUpdateVersion: update.version }));
    setUpdateOpen(false);
    setToast({ id: Date.now(), ok: true, message: `已忽略 v${update.version}，后续新版本仍会提醒` });
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
  const [confirmState, setConfirmState] = useState(null);
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

  // 浮窗预览跟随浮窗口径：只展示未停用的账号
  const activeAccounts = accounts.filter((item) => !item.disabled);
  const currentWidgetAccount = activeAccounts[widgetIndex % Math.max(activeAccounts.length, 1)];
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
  // 表单草稿连通性测试：走主进程 quota:test-draft，不保存任何东西；网页演示模式模拟通过
  const testDraft = async (draft) => {
    if (bridge?.testDraft) {
      try { return await bridge.testDraft(draft); }
      catch (error) { return { ok: false, message: error.message }; }
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
    return { ok: true, message: '模拟测试通过（网页演示模式）' };
  };
  const reorderAccounts = async (fromId, toId) => {
    const nextAccounts = reorderById(accounts, fromId, toId);
    if (nextAccounts === accounts) return;
    if (bridge) {
      const state = serializableState({ accounts: nextAccounts });
      lastSaved.current = JSON.stringify(state);
      await bridge.saveState(state);
    }
    setAccounts(nextAccounts);
  };
  const saveAccount = async (draft) => {
    const id = `${draft.providerId}-${Date.now()}`;
    const account = { id, providerId: draft.providerId, name: draft.name, identity: draft.identity, tags: draft.tags, endpoint: draft.endpoint, variables: draft.variables || {}, windowKeys: draft.windowKeys, timeoutSeconds: clampAccountTimeout(draft.timeoutSeconds), status: 'warning', lastChecked: new Date().toISOString(), lastError: '等待首次连接测试', windows: [] };
    const nextAccounts = [...accounts, account];
    if (bridge) {
      if (draft.credential || Object.keys(draft.secretVariables || {}).length) await bridge.saveCredential(id, draft.credential, draft.secretVariables || {});
      const state = serializableState({ accounts: nextAccounts });
      lastSaved.current = JSON.stringify(state);
      await bridge.saveState(state);
    }
    setAccounts(nextAccounts);
    setModal(null);
    if (!draft.connectUsageAfterSave || !bridge?.connectProviderUsage) return;
    try {
      const result = await bridge.connectProviderUsage(id);
      if (result?.state) applyProviderUsageState(result.state);
      setToast({
        id: Date.now(),
        ok: !result?.cancelled,
        message: result?.cancelled
          ? '账号已保存；官方账号登录未完成，可稍后在账号编辑中连接'
          : (PROVIDER_USAGE_COPY[draft.providerId]?.savedToast || `账号已保存，并已连接 ${PROVIDER_USAGE_COPY[draft.providerId]?.display || ''}官方用量`),
      });
    } catch (error) {
      setToast({ id: Date.now(), ok: false, message: `账号已保存；官方用量连接失败：${error?.message || '请稍后重试'}` });
    }
  };
  const updateAccount = async ({ account, name, identity, tags, endpoint, windowKeys, timeoutSeconds, variables, secretVariables }) => {
    const nextAccounts = accounts.map((item) => item.id === account.id ? { ...item, name, identity, tags, endpoint, variables: variables || {}, windowKeys, timeoutSeconds: clampAccountTimeout(timeoutSeconds) } : item);
    if (bridge) {
      // 凭据创建后不可修改：这里只保存可能更新的密钥变量，credential 传空表示保留原值
      if (Object.keys(secretVariables || {}).length) await bridge.saveCredential(account.id, '', secretVariables || {});
      const state = serializableState({ accounts: nextAccounts });
      lastSaved.current = JSON.stringify(state);
      await bridge.saveState(state);
    }
    setAccounts(nextAccounts);
    setModal(null);
  };
  const deleteAccount = (account) => setConfirmState({
    title: `删除账号「${account.name}」？`,
    message: '将同时删除该账号的本地凭据与额度历史，此操作不可恢复。只想暂停监控的话，停用账号即可保留历史。',
    confirmLabel: '删除',
    danger: true,
    action: async () => {
      const nextAccounts = accounts.filter((item) => item.id !== account.id);
      if (bridge) {
        await bridge.deleteCredential(account.id);
        const state = serializableState({ accounts: nextAccounts });
        lastSaved.current = JSON.stringify(state);
        await bridge.saveState(state);
      }
      if (historyAccountId === account.id) setHistoryAccountId(null);
      setAccounts(nextAccounts);
    },
  });
  // 账号停用 / 启用：只翻转 disabled 标记，账号与历史、周期档案、凭据都原地保留，
  // 重新启用后巡检接续（归档逻辑全量扫描历史，能识别停用空窗前后分属不同周期）
  const applyAccountDisabled = async (account, disabling) => {
    const nextAccounts = accounts.map((item) => item.id === account.id
      ? { ...item, disabled: disabling || undefined, disabledAt: disabling ? new Date().toISOString() : undefined }
      : item);
    if (bridge) {
      const state = serializableState({ accounts: nextAccounts });
      lastSaved.current = JSON.stringify(state);
      await bridge.saveState(state);
    }
    setAccounts(nextAccounts);
    if (disabling) setToast({ id: Date.now(), ok: true, message: `已停用「${account.name}」，历史数据已保留` });
    else {
      setToast({ id: Date.now(), ok: true, message: `已启用「${account.name}」，正在刷新额度` });
      // 启用后立即点名巡检一次，不等下一个轮询周期，让数据尽快接上
      bridge?.pollAccount?.(account.id).catch(() => {});
    }
  };
  const toggleAccountDisabled = (account) => {
    if (account.disabled) { applyAccountDisabled(account, false); return; }
    setConfirmState({
      title: `停用账号「${account.name}」？`,
      message: '停用后不再巡检该账号，桌面浮窗也不再显示；历史数据完整保留，可随时重新启用。',
      confirmLabel: '停用',
      action: () => applyAccountDisabled(account, true),
    });
  };
  const clearHistory = () => setConfirmState({
    title: '清除全部历史记录？',
    message: '所有账号已保存的额度历史都会被删除，此操作不可恢复。',
    confirmLabel: '清除',
    danger: true,
    action: async () => {
      if (bridge) await bridge.clearHistory?.().catch(() => {});
      setToast({ id: Date.now(), ok: true, message: '额度历史记录已清除' });
    },
  });
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
  // usage:connect/disconnect 会返回完整公开 state；立即采纳以避免等待 IPC 广播时
  // 弹窗和历史页短暂显示旧连接状态。敏感登录凭据从不在该 state 中。
  const applyProviderUsageState = (state) => {
    if (!state) return;
    if (Array.isArray(state.accounts)) setAccounts(state.accounts);
    if (Array.isArray(state.providers)) setProviders(state.providers);
    if (state.lastSync) setLastSync(state.lastSync);
    if (state.runtime) setRuntime(state.runtime);
  };
  const historyAccount = historyAccountId ? accounts.find((item) => item.id === historyAccountId) : null;

  return <div className="app-shell">
    <header className="titlebar"><span className="titlebar-drag"><img src="./quota-desk.svg" alt="" /><b>Quota Desk</b></span><div className="titlebar-controls"><span className="last-checked" title="最后一次额度检查时间"><Clock3 size={11} />{formatChecked(lastSync)}</span>{update && ['available', 'downloading', 'downloaded', 'error'].includes(update.status) && !(update.status === 'available' && update.version && update.version === settings.ignoredUpdateVersion) && <button className={`update-badge ${update.status}`} onClick={() => setUpdateOpen(true)} title="查看版本更新"><Download size={11} />{update.status === 'available' && `v${update.version} 可更新`}{update.status === 'downloading' && `下载中 ${update.percent || 0}%`}{update.status === 'downloaded' && '重启升级'}{update.status === 'error' && '更新失败'}</button>}<button className="control-solo" onClick={refreshAll} disabled={refreshing} title="立即刷新全部账号" aria-label="立即刷新全部账号"><RefreshCw size={13} className={refreshing ? 'spinning' : ''} /></button><div className="overview-controls" aria-label="账号总览展示方式"><button className={overviewMode === 'rings' && !historyAccountId ? 'active' : ''} onClick={() => { setHistoryAccountId(null); setOverviewMode('rings'); }} title="账号总览" aria-label="账号总览"><CircleGauge size={13} /></button><button className={overviewMode === 'rows' && !historyAccountId ? 'active' : ''} onClick={() => { setHistoryAccountId(null); setOverviewMode('rows'); }} title="行式明细" aria-label="行式明细"><Rows3 size={13} /></button><button className={overviewMode === 'periods' && !historyAccountId ? 'active' : ''} onClick={() => { setHistoryAccountId(null); setOverviewMode('periods'); }} title="周期明细" aria-label="周期明细"><Clock3 size={13} /></button></div></div><div className="titlebar-actions"><button title="设置" aria-label="打开设置" onClick={() => setSettingsOpen(true)}><Settings2 size={13} /></button>{bridge && <><button className={pinned ? 'active' : ''} title={pinned ? '取消固定' : '固定在桌面最前面'} aria-label="固定在桌面最前面" onClick={async () => setPinned(await bridge.togglePin())}><Pin size={13} /></button><button title="关闭到托盘" aria-label="关闭到托盘" onClick={() => bridge.closeMainWindow()}><X size={14} /></button></>}</div></header>
    {toast && <div className={`toast ${toast.ok ? 'ok' : 'fail'}`} role="status">{toast.ok ? <Check size={13} /> : <AlertCircle size={13} />}<span>{toast.message}</span></div>}
    <main className="main-shell">
      <div className="content-area">{desktopError && <div className="desktop-error"><AlertCircle size={15} /><span>{desktopError}</span><button onClick={() => setDesktopError('')} aria-label="关闭错误"><X size={14} /></button></div>}{accounts.length === 0 ? <section className="empty-workspace"><div className="empty-mark"><CircleGauge size={22} /></div><div><h2>把第一份 Coding Plan 接进来</h2><p>凭据将由 Windows 加密保存，额度请求只在本机发出。</p></div><button className="primary-button" onClick={() => setModal('account')}><Plus size={15} /> 添加账号</button><button className="outline-button" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /> 设置</button>{window.quotaDesk?.scanCcswitchImport && <button className="outline-button" onClick={() => setModal('import-ccswitch')}><Download size={15} /> 从 cc-switch 导入</button>}</section> : historyAccount ? <HistoryView account={historyAccount} provider={providers.find((item) => item.id === historyAccount.providerId)} onBack={() => setHistoryAccountId(null)} onProviderUsageState={applyProviderUsageState} /> : <StatusView accounts={accounts} providers={providers} reminderRules={settings.alerts === false ? [] : settings.reminderRules} mode={overviewMode} onModeChange={setOverviewMode} runtime={runtime} onTestAccount={testAccount} testingAccountId={testingAccountId} testResults={testResults} onOpenSettings={() => setSettingsOpen(true)} lastSync={lastSync} onRefresh={refreshAll} refreshing={refreshing} onOpenHistory={(account) => setHistoryAccountId(account.id)} onReorderAccounts={reorderAccounts} sortWeights={{ fiveHourRemaining: settings.periodSort5hRemaining, otherRemaining: settings.periodSortLongRemaining }} onRelogin={(account) => { const provider = providers.find((item) => item.id === account.providerId); const kind = reloginChannel(provider)?.kind || 'kimi'; setModal({ type: `${kind}-relogin`, account }); }} />}</div>
    </main>
    {settingsOpen && <SettingsDrawer accounts={accounts} providers={providers} settings={settings} setSettings={setSettings} onClose={() => setSettingsOpen(false)} openModal={setModal} onDeleteAccount={deleteAccount} onToggleAccountDisabled={toggleAccountDisabled} onTestAccount={testAccount} testingAccountId={testingAccountId} onEditProvider={editProvider} autoLaunch={autoLaunch} onToggleAutoLaunch={toggleAutoLaunch} appVersion={appVersion} update={update} onOpenUpdate={() => setUpdateOpen(true)} onCheckUpdate={onCheckUpdate} onClearHistory={clearHistory} runtime={runtime} />}
    {confirmState && <ConfirmModal confirm={confirmState} onClose={() => setConfirmState(null)} />}
    {updateOpen && update && <UpdateModal update={update} version={appVersion} onIgnore={ignoreUpdate} onClose={() => setUpdateOpen(false)} />}
    {settings.widgetPreview && <WidgetPreview account={currentWidgetAccount} provider={currentWidgetProvider} tagLimit={Number(settings.widgetTagLimit ?? 2)} scale={settings.widgetScale} length={settings.widgetLength} onClose={() => setSettings((old) => ({ ...old, widgetPreview: false }))} />}
    {(modal === 'account' || modal === 'import-cli') && <ImportCliLoginModal accounts={accounts} providers={providers} onClose={() => setModal(null)} onSaveAccount={saveAccount} onTestDraft={testDraft} onToast={setToast} providerOrder={settings.providerOrder} onReorderProviders={(order) => setSettings((old) => ({ ...old, providerOrder: order }))} onImported={(_kind, result) => {
      if (result?.state) { setAccounts(result.state.accounts || []); setProviders(result.state.providers || []); setLastSync(result.state.lastSync || new Date().toISOString()); if (result.state.runtime) setRuntime(result.state.runtime); }
      lastSaved.current = '';
      setToast({ id: Date.now(), ok: !result?.duplicate, message: result?.duplicate ? `该登录已收录在账号「${result.name}」中` : `已导入「${result.name}」，正在刷新额度` });
    }} />}
    {modal?.type === 'account-edit' && <AccountEditModalV2 account={accounts.find((item) => item.id === modal.account.id) || modal.account} provider={providers.find((item) => item.id === modal.account.providerId)} onClose={() => setModal(null)} onSave={updateAccount} onTestDraft={testDraft} onProviderUsageState={applyProviderUsageState} />}
    {modal === 'provider' && <ProviderModalV2 onClose={() => setModal(null)} onSave={saveProvider} />}
    {modal?.type === 'provider-edit' && <ProviderModalV2 provider={modal.provider} onClose={() => setModal(null)} onSave={saveProvider} />}
    {modal === 'import-ccswitch' && <ImportCcswitchModal onClose={() => setModal(null)} onApplied={(result) => {
      if (result?.state) { setAccounts(result.state.accounts || []); setProviders(result.state.providers || []); setLastSync(result.state.lastSync || new Date().toISOString()); if (result.state.runtime) setRuntime(result.state.runtime); }
      lastSaved.current = '';
      setModal(null);
      setToast({ id: Date.now(), ok: result?.imported > 0, message: result?.imported > 0 ? `已从 cc-switch 导入 ${result.imported} 个账号` : '没有导入新账号（Key 都已存在）' });
    }} />}
    {modal?.type === 'grok-relogin' && <ImportCliLoginModal accounts={accounts} providers={providers} reloginAccount={modal.account} onSaveAccount={saveAccount} onTestDraft={testDraft} onClose={() => setModal(null)} onToast={setToast} providerOrder={settings.providerOrder} onReorderProviders={(order) => setSettings((old) => ({ ...old, providerOrder: order }))} onImported={(_kind, result) => {
      if (result?.state) { setAccounts(result.state.accounts || []); setProviders(result.state.providers || []); setLastSync(result.state.lastSync || new Date().toISOString()); if (result.state.runtime) setRuntime(result.state.runtime); }
      lastSaved.current = '';
      setModal(null);
      setToast({ id: Date.now(), ok: !result?.duplicate, message: result?.duplicate ? `该登录已收录在账号「${result.name}」中` : `已重新导入「${result.name}」，正在刷新额度` });
    }} />}
    {modal?.type === 'kimi-relogin' && <div className="modal-backdrop" onClick={() => setModal(null)}><div className="modal compact-modal import-modal kimi-qr-modal import-window" onClick={(event) => event.stopPropagation()}>
      <KimiQrPanel mode="relogin" reloginAccount={modal.account} onExit={() => setModal(null)} onFinish={() => setModal(null)} onImported={(_kind, result) => {
        if (result?.state) { setAccounts(result.state.accounts || []); setProviders(result.state.providers || []); setLastSync(result.state.lastSync || new Date().toISOString()); if (result.state.runtime) setRuntime(result.state.runtime); }
        lastSaved.current = '';
        setToast({ id: Date.now(), ok: !result?.duplicate, message: result?.duplicate ? `该登录已收录在账号「${result.name}」中，请换一个账号扫码` : `已重新登录「${result.name}」，正在刷新额度` });
      }} />
    </div></div>}
    {modal?.type === 'copilot-relogin' && <div className="modal-backdrop" onClick={() => setModal(null)}><div className="modal compact-modal import-modal kimi-qr-modal import-window" onClick={(event) => event.stopPropagation()}>
      <CopilotDevicePanel mode="relogin" reloginAccount={modal.account} onExit={() => setModal(null)} onFinish={() => setModal(null)} onToast={setToast} onImported={(_kind, result) => {
        if (result?.state) { setAccounts(result.state.accounts || []); setProviders(result.state.providers || []); setLastSync(result.state.lastSync || new Date().toISOString()); if (result.state.runtime) setRuntime(result.state.runtime); }
        lastSaved.current = '';
        setToast({ id: Date.now(), ok: !result?.duplicate, message: result?.duplicate ? `该 GitHub 账号已收录在账号「${result.name}」中，请换一个账号授权` : `已重新授权「${result.name}」，正在刷新额度` });
      }} />
    </div></div>}
  </div>;
}

export default App;
export { ProviderUsageView };

const widgetMode = new URLSearchParams(window.location.search).get('widget') === '1';
createRoot(document.getElementById('root')).render(widgetMode ? <WidgetApp /> : <App />);
