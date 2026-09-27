import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, ArrowUpRight, CircleGauge, Clock3, KeyRound, LockKeyhole, Moon, RefreshCw, Rows3, ShieldCheck, Sun, WifiOff } from 'lucide-react';
import { HistoryView, StatusView } from './main.jsx';
import { AppShell } from './app-shell';
import { initialAccounts, providerCatalog } from './data';
import './styles.css';
import './remote.css';

document.documentElement.classList.add('remote-page');
document.body.classList.add('remote-page');

const TOKEN_KEY = 'quota-desk-remote-token-v1';
const DEVICE_ID_KEY = 'quota-desk-remote-device-id-v1';
const DEVICE_NAME_KEY = 'quota-desk-remote-device-name-v1';
const THEME_KEY = 'quota-desk-remote-theme-v1';
const MODE_KEY = 'quota-desk-remote-mode-v1';

function readInitialConnection() {
  const params = new URLSearchParams(location.hash.slice(1));
  const pairingKey = params.get('pair') || '';
  if (pairingKey || params.has('access')) history.replaceState(null, '', location.pathname + location.search);
  return {
    pairingKey,
    token: pairingKey ? '' : (localStorage.getItem(TOKEN_KEY) || (import.meta.env.DEV ? 'demo' : '')),
  };
}

function parsePairingInput(value) {
  const input = String(value || '').trim();
  if (/^https?:\/\//i.test(input)) {
    let url;
    try { url = new URL(input); }
    catch { throw new Error('配对链接格式无效，请重新扫描电脑端二维码'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || !['', '/', '/remote.html'].includes(url.pathname)) {
      throw new Error('配对链接格式无效，请重新扫描电脑端二维码');
    }
    const pairingKey = new URLSearchParams(url.hash.slice(1)).get('pair') || '';
    if (!pairingKey) throw new Error('配对链接中没有配对密钥，请扫描电脑端当前的二维码');
    return { pairingKey };
  }
  if (/^[A-Za-z0-9_-]{32,128}$/.test(input)) return { pairingKey: input };
  throw new Error('配对信息格式无效，请扫描电脑端二维码或粘贴配对密钥');
}

const initialConnection = readInitialConnection();

async function requestJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (response.status === 401) throw Object.assign(new Error('此设备的配对已失效或已被电脑移除，请重新扫描电脑端的配对信息'), { unauthorized: true });
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch { /* The HTTP status still identifies the failure. */ }
    const message = body.error === 'read_only' ? '远程查看固定为只读，无法保存这些设置'
      : body.error === 'invalid_settings' ? '设置格式不正确，请检查后重试'
        : body.error === 'settings_unavailable' ? '电脑端暂不支持远程保存设置'
          : `读取失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return response.json();
}

const demoSnapshot = {
  readOnly: true,
  lastSync: new Date().toISOString(),
  pollMinutes: 5,
  settings: { alerts: true, pollMinutes: 5, reminderRules: [{ id: 'soon', label: '即将刷新且额度充足', beforeMinutes: 120, minRemaining: 50 }], periodSort5hRemaining: 0, periodSortLongRemaining: 0 },
  providers: providerCatalog,
  accounts: initialAccounts.map((account) => ({
    ...account,
    provider: providerCatalog.find((provider) => provider.id === account.providerId)?.name || account.providerId,
    usageSupported: ['deepseek', 'zai', 'codex', 'minimax'].includes(account.providerId),
    usageStatus: account.providerId === 'zai' ? 'connected' : 'disconnected',
    wasteWindows: (account.windows || []).map((window) => window.key).filter((key) => ['weekly', 'monthly'].includes(key)),
  })),
};

const demoHistory = (account) => ({ points: Array.from({ length: 76 }, (_, index) => {
  const progress = index / 75;
  return {
    at: new Date(Date.now() - (1 - progress) * 30 * 86_400_000).toISOString(),
    windows: Object.fromEntries((account.windows || []).map((meter) => [meter.key, {
      remaining: Math.min(100, Math.max(3, (Number(meter.remaining) || 50) + Math.sin(index * .28) * 13 + Math.cos(index * .11) * 8 + (1 - progress) * 14)),
      amount: meter.amount ?? null,
      unit: meter.unit,
    }])),
  };
}) });

const demoUsage = (account) => {
  const today = new Date();
  const days = Array.from({ length: 365 }, (_, index) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (364 - index))).toISOString().slice(0, 10);
    const tokens = Math.round((8 + (Math.sin(index * .17) + 1) * 13 + (Math.cos(index * .037) + 1) * 10) * 1_000_000);
    return { date, cost: Number((tokens / 1_000_000 * .72).toFixed(2)), tokens, requests: Math.round(tokens / 7200), currency: '¥' };
  });
  return {
    provider: account.providerId,
    metric: 'cost',
    currency: '¥',
    summary: { totalCost: days.reduce((sum, day) => sum + day.cost, 0), totalTokens: days.reduce((sum, day) => sum + day.tokens, 0), peakDailyCost: Math.max(...days.map((day) => day.cost)), peakDailyTokens: Math.max(...days.map((day) => day.tokens)), currentStreakDays: 4, longestStreakDays: 27 },
    coverage: { timezoneOffsetSec: 8 * 60 * 60, cost: { complete: true }, tokens: { complete: true } },
    days,
  };
};

function Pairing({ onConnect, pairingKey, message, theme, setTheme }) {
  const [input, setInput] = useState('');
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem(DEVICE_NAME_KEY) || defaultDeviceName());
  return <main className="remote-pair-page">
    <div className="remote-pair-card">
      <div className="remote-pair-top"><div className="remote-pair-icon"><LockKeyhole size={26} strokeWidth={1.7} /></div><button type="button" className="remote-pair-theme" onClick={() => setTheme((old) => old === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? '切换亮色主题' : '切换暗色主题'}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button></div>
      <div className="remote-eyebrow">QUOTA DESK · 额度查看</div>
      <h1>在这里查看你的额度</h1>
      <p>{pairingKey ? '已读取电脑端配对信息。给这台设备起个名称，然后完成配对。' : '在电脑端打开「设置 → 远程查看 → 配对信息」，扫描二维码；也可以粘贴配对信息。'}</p>
      <form onSubmit={(event) => { event.preventDefault(); const value = pairingKey || input.trim(); if (value) onConnect(value, deviceName.trim()); }}>
        {!pairingKey && <><label htmlFor="pair-token">配对信息</label><div className="remote-pair-input"><KeyRound size={17} /><input id="pair-token" value={input} onChange={(event) => setInput(event.target.value)} placeholder="粘贴电脑端二维码内容或配对密钥" autoComplete="off" spellCheck="false" /></div></>}
        <label htmlFor="pair-device-name">设备名称</label>
        <div className="remote-pair-input"><input id="pair-device-name" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={60} placeholder="例如：我的手机" autoComplete="off" /></div>
        {message && <div className="remote-inline-error" role="alert"><AlertCircle size={15} />{message}</div>}
        <button type="submit" className="remote-primary-button" disabled={(!pairingKey && !input.trim()) || !deviceName.trim()}>配对并连接 <ArrowUpRight size={16} /></button>
      </form>
      <div className="remote-pair-foot"><ShieldCheck size={15} />电脑授权后，此设备会获得独立的只读访问权限</div>
    </div>
  </main>;
}

function App() {
  const [token, setToken] = useState(initialConnection.token);
  const [pairingKey, setPairingKey] = useState(initialConnection.pairingKey);
  const [pairError, setPairError] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(Boolean(initialConnection.token));
  const [connectionError, setConnectionError] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [mode, setMode] = useState(() => localStorage.getItem(MODE_KEY) || 'rings');
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark');
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); }, [theme]);
  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);
  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    const load = async () => {
      try {
        const data = import.meta.env.DEV && token === 'demo' ? { ...demoSnapshot, lastSync: new Date().toISOString() } : await requestJson('/api/snapshot', token);
        if (!active) return;
        setSnapshot(data); setConnectionError(''); setPairError(''); setNow(Date.now());
      } catch (error) {
        if (!active) return;
        if (error.unauthorized) { localStorage.removeItem(TOKEN_KEY); setToken(''); setSnapshot(null); setPairError(error.message); }
        else setConnectionError('无法连接电脑，请确认 Quota Desk 已开启局域网访问，且设备能够访问二维码中的地址');
      } finally { if (active) setLoading(false); }
    };
    load();
    const timer = setInterval(load, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [token]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);

  const bridge = useMemo(() => ({
    getHistory: (accountId) => {
      const account = snapshotRef.current?.accounts?.find((item) => item.id === accountId);
      if (import.meta.env.DEV && token === 'demo' && account) return Promise.resolve(demoHistory(account).points);
      return requestJson(`/api/history?accountId=${encodeURIComponent(accountId)}&days=0`, token).then((result) => result.points || []);
    },
    getCycles: (accountId) => import.meta.env.DEV && token === 'demo'
      ? Promise.resolve([])
      : requestJson(`/api/cycles?accountId=${encodeURIComponent(accountId)}`, token).then((result) => result.cycles || []),
    getProviderUsage: (accountId) => {
      const account = snapshotRef.current?.accounts?.find((item) => item.id === accountId);
      if (import.meta.env.DEV && token === 'demo' && account) return Promise.resolve(demoUsage(account));
      return requestJson(`/api/usage?accountId=${encodeURIComponent(accountId)}`, token);
    },
  }), [token]);
  window.quotaDesk = bridge;

  const connect = async (value, deviceName) => {
    const parsed = parsePairingInput(value);
    setPairError('');
    try {
      const deviceId = localStorage.getItem(DEVICE_ID_KEY) || (crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const response = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ pairingKey: parsed.pairingKey, id: deviceId, name: deviceName }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || (result.error === 'pairing_key_invalid' ? '配对信息已重置或失效，请重新扫描电脑端当前的配对信息' : `配对失败（HTTP ${response.status}）`));
      localStorage.setItem(TOKEN_KEY, result.token);
      localStorage.setItem(DEVICE_ID_KEY, result.deviceId);
      localStorage.setItem(DEVICE_NAME_KEY, result.deviceName || deviceName);
      setPairingKey(''); setLoading(true); setToken(result.token);
    } catch (error) { setPairError(error.message || '配对失败，请确认电脑端服务正在运行'); }
  };
  const lastSync = snapshot?.lastSync;
  const accounts = (snapshot?.accounts || []).map((account) => ({
    ...account,
    usageConnection: {
      ...(account.usageConnection || {}),
      status: account.usageStatus ?? account.usageConnection?.status ?? 'disconnected',
      supported: account.usageSupported ?? account.usageConnection?.supported,
    },
  }));
  const providers = snapshot?.providers || providerCatalog;
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const selectedProvider = providers.find((provider) => provider.id === selectedAccount?.providerId);
  const readOnly = true;

  if (!token || pairingKey) return <Pairing pairingKey={pairingKey} onConnect={connect} message={pairError} theme={theme} setTheme={setTheme} />;
  const shellControls = <>
    <span className="last-checked" title="最后一次额度检查时间"><Clock3 size={11} />{lastSync ? new Date(lastSync).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未检查'}</span>
    <button type="button" className="control-solo" onClick={() => location.reload()} title="重新读取电脑数据" aria-label="重新读取电脑数据"><RefreshCw size={13} /></button>
    <div className="overview-controls" aria-label="额度展示方式">{[['rings', '账号总览', CircleGauge], ['rows', '行式明细', Rows3], ['periods', '周期明细', Clock3]].map(([key, label, Icon]) => <button type="button" key={key} className={mode === key && !selectedAccountId ? 'active' : ''} onClick={() => { setSelectedAccountId(null); setMode(key); }} title={label} aria-label={label}><Icon size={13} /></button>)}</div>
    <button type="button" className="remote-title-theme" onClick={() => setTheme((old) => old === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? '切换亮色主题' : '切换暗色主题'}>{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</button>
  </>;
  return <AppShell variant="remote" controls={shellControls}>
    <main className="main-shell content-area remote-main">
      {connectionError && <div className="remote-banner offline" role="status"><WifiOff size={18} /><span>{connectionError}{snapshot ? '，下方保留本次读取的数据。' : '。'}</span></div>}
      {loading && !snapshot ? <div className="remote-loading"><RefreshCw size={23} className="spinning" /><span>正在读取电脑上的额度</span></div> : snapshot ? <>
        {selectedAccount ? <HistoryView key={selectedAccount.id} account={selectedAccount} provider={selectedProvider} onBack={() => setSelectedAccountId(null)} readOnly wasteWindowsOverride={selectedAccount.wasteWindows} /> : <>
          <StatusView accounts={accounts} providers={providers} mode={mode} readOnly onOpenHistory={(account) => setSelectedAccountId(account.id)} lastSync={lastSync} reminderRules={snapshot.settings?.alerts === false ? [] : snapshot.settings?.reminderRules || []} sortWeights={{ fiveHourRemaining: snapshot.settings?.periodSort5hRemaining, otherRemaining: snapshot.settings?.periodSortLongRemaining }} testResults={{}} />
        </>}
      </> : !loading && <div className="remote-empty"><WifiOff size={23} /><strong>暂时无法读取额度</strong><span>请确认电脑正在运行并可通过配对地址访问</span></div>}
    </main>
  </AppShell>;
}

const root = document.getElementById('remote-root');
if (root) createRoot(root).render(<App />);
