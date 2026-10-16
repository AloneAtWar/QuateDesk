// Data-only Electron preload replacement. No network, credentials or persistence.
const DAY = 86_400_000;
const clone = (value) => structuredClone(value);
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const dateInZone = (at, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const tokenKeys = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'extraTokens', 'totalTokens', 'requests'];
const emptyTokens = () => Object.fromEntries(tokenKeys.map((key) => [key, 0]));
const addTokens = (target, row) => { for (const key of tokenKeys) target[key] += Number(row[key]) || 0; };
const streaks = (values) => {
  let longest = 0; let run = 0; let current = 0;
  for (const value of values) { run = value > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  let index = values.length - 1;
  if (!values[index]) index -= 1;
  while (index >= 0 && values[index--] > 0) current += 1;
  return { longest, current };
};
const matchesRules = (row, rules) => rules == null || rules.some((rule) => rule.mode === 'exact'
  ? [row.canonical, row.model].some((name) => name?.toLowerCase() === rule.value.toLowerCase())
  : rule.mode === 'regex' && new RegExp(rule.value, 'i').test(row.canonical || row.model));

export function createDemoBridge(snapshot, { now = Date.now(), theme = 'dark' } = {}) {
  const today = dateInZone(now, snapshot.timezone);
  const captureDate = dateInZone(Date.parse(snapshot.capturedAt), snapshot.timezone);
  const dateShift = Math.round((Date.parse(today) - Date.parse(captureDate)) / DAY);
  const timeShift = now - Date.parse(snapshot.capturedAt);
  const rebase = (value) => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(Date.parse(value) + timeShift).toISOString();
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return addDays(value, dateShift);
    if (Array.isArray(value)) return value.map(rebase);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rebase(child)]));
    return value;
  };
  const data = rebase(snapshot);
  let state = {
    accounts: data.accounts, providers: data.providers,
    settings: { theme, onboarded: true, widget: false, historyDays: 0, localCliUsage: { enabled: true, mergeSameModels: true, scanWsl: false } },
    lastSync: new Date(now).toISOString(), runtime: { running: false, checking: false, nextPollAt: null },
  };
  const accountFor = (id) => state.accounts.find((account) => account.id === id);
  const filteredRows = (query) => data.localUsage.rows.filter((row) => (!query.agent || query.agent === 'all' || query.agent === row.agent) && matchesRules(row, query.modelRules));
  const summary = (query = {}) => {
    const end = query.endDate || today;
    const start = addDays(end, 1 - (query.days || 365));
    const rows = filteredRows(query);
    const days = new Map();
    for (let date = start; date <= end; date = addDays(date, 1)) days.set(date, { date, ...emptyTokens(), sessions: new Set(), agents: {} });
    const sessions = new Set();
    for (const row of rows) {
      const day = days.get(row.date);
      if (!day) continue;
      addTokens(day, row);
      for (const id of row.sessions) { day.sessions.add(id); sessions.add(id); }
      day.agents[row.agent] = (day.agents[row.agent] || 0) + row.totalTokens;
    }
    const dayRows = [...days.values()].map((day) => ({ ...day, sessions: day.sessions.size }));
    const totals = dayRows.reduce((total, row) => { addTokens(total, row); return total; }, emptyTokens());
    const counts = streaks(dayRows.map((day) => day.totalTokens));
    const cacheBase = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
    return {
      range: { start, end, timezone: query.timezone || snapshot.timezone }, filter: clone(query),
      matchedModels: query.modelRules == null ? [] : [...new Map(rows.map((row) => [row.canonical, { key: row.canonical, displayName: row.model }])).values()],
      recordsByAgent: query.modelRules == null ? null : data.localUsage.rows.filter((row) => matchesRules(row, query.modelRules)).reduce((counts, row) => ({ ...counts, [row.agent]: (counts[row.agent] || 0) + row.requests }), {}),
      summary: { ...totals, totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0), coverageComplete: rows.every((row) => row.date >= start), peakTokens: Math.max(0, ...dayRows.map((row) => row.totalTokens)), currentStreakDays: counts.current, longestStreakDays: counts.longest, sessions: sessions.size, activeDays: dayRows.filter((row) => row.totalTokens > 0).length, cacheReuseRatio: cacheBase > 0 ? totals.cacheReadTokens / cacheBase : null },
      days: dayRows,
    };
  };
  const models = (query = {}) => {
    const scope = query.scope || { kind: 'range', days: 30 };
    const end = scope.kind === 'day' ? scope.date : today;
    const start = scope.kind === 'day' ? end : scope.days > 0 ? addDays(end, 1 - scope.days) : null;
    const merge = (!query.agent || query.agent === 'all') && query.mergeSameModels !== false;
    const groups = new Map();
    for (const row of filteredRows(query).filter((row) => (!start || row.date >= start) && row.date <= end)) {
      const key = `${merge ? '' : row.agent}:${row.canonical}`;
      if (!groups.has(key)) groups.set(key, { modelKey: row.canonical, displayName: row.canonical || row.model, agents: new Set(), rawModels: new Set(), sessions: new Set(), ...emptyTokens() });
      const group = groups.get(key);
      addTokens(group, row); group.agents.add(row.agent); group.rawModels.add(row.model);
      for (const session of row.sessions) group.sessions.add(session);
    }
    const total = [...groups.values()].reduce((sum, group) => sum + group.totalTokens, 0);
    const rows = [...groups.values()].map((group) => ({ ...group, agents: [...group.agents].sort(), rawModels: [...group.rawModels], sessions: group.sessions.size, share: total > 0 ? group.totalTokens / total : 0 })).sort((a, b) => b.totalTokens - a.totalTokens || a.modelKey.localeCompare(b.modelKey));
    return { range: { start, end, timezone: query.timezone || snapshot.timezone }, filter: { ...clone(query), effectiveMergeSameModels: merge }, models: rows };
  };
  const officialUsage = (id) => {
    const account = accountFor(id);
    if (!account?.usageConnection?.supported) throw new Error('当前渠道不提供官方用量');
    const seed = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const costEnabled = ['deepseek', 'minimax'].includes(account.providerId);
    const names = { deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'], zai: ['glm-5', 'glm-4.7'], codex: ['gpt-5.4', 'gpt-5.3-codex'], minimax: ['MiniMax-M2.7', 'MiniMax-M2.5'] }[account.providerId];
    const days = Array.from({ length: 365 }, (_, index) => {
      const tokens = (index + seed) % 11 === 0 ? 0 : (1 + ((index * 73 + seed) % 430)) * 61_000;
      const cost = costEnabled ? Math.round(tokens / 70_000) / 100 : null;
      const requests = Math.ceil(tokens / 32_000);
      return { date: addDays(today, index - 364), currency: 'CNY', tokens, cost, requests,
        inputTokens: Math.round(tokens * .8), outputTokens: tokens - Math.round(tokens * .8),
        models: names.map((model, index) => ({ model, name: model, tokens: Math.round(tokens * (index ? .3 : .7)), cost: cost == null ? null : cost * (index ? .3 : .7), requests: Math.round(requests * (index ? .3 : .7)) })),
      };
    });
    const tokens = days.reduce((sum, day) => sum + day.tokens, 0);
    const cost = costEnabled ? days.reduce((sum, day) => sum + day.cost, 0) : null;
    const counts = streaks(days.map((day) => day.tokens));
    const peak = days.reduce((best, day) => day.tokens > best.tokens ? day : best, days[0]);
    return { provider: account.providerId, currency: 'CNY', connected: true, supported: true, fetchedAt: new Date(now).toISOString(),
      coverage: { start: days[0].date, end: today, timezoneOffsetSec: 28800, partial: false, tokens: { complete: true }, cost: { complete: costEnabled }, issues: [] },
      summary: { totalTokens: tokens, rangeTokens: tokens, knownRangeTokens: tokens, totalCost: cost, rangeCost: cost, knownRangeCost: cost, peakDailyTokens: peak.tokens, peakDailyTokensDate: peak.date, peakDailyCost: costEnabled ? Math.max(...days.map((day) => day.cost)) : null, currentStreakDays: counts.current, longestStreakDays: counts.longest }, days,
    };
  };
  const stateResult = (id) => ({ ok: accountFor(id)?.status !== 'warning', message: accountFor(id)?.lastError || '已读取固定额度快照', state: clone(state) });
  const unsupported = async () => { throw new Error('演示模式不连接真实服务，也不保存凭据'); };
  return {
    isDesktop: false, isDemo: true,
    loadState: async () => clone(state),
    saveState: async (next) => { state = { ...clone(next), runtime: state.runtime }; return clone(state); },
    onStateUpdated: () => () => {},
    pollAll: async () => clone(state), pollAccount: async (id) => stateResult(id), testAccount: async (id) => stateResult(id), testDraft: unsupported,
    saveCredential: unsupported, deleteCredential: async () => true,
    getHistory: async (id) => clone(data.history[id] || []), getCycles: async (id) => clone(data.cycles[id] || []),
    getLocalCliUsageSources: async () => clone(data.localUsage.sources), scanLocalCliUsage: async () => clone(data.localUsage.sources),
    getLocalCliUsageSummary: async (query) => summary(query), getLocalCliUsageModels: async (query) => models(query),
    getProviderUsage: async (id) => officialUsage(id),
    connectProviderUsage: async (id) => {
      const account = accountFor(id);
      if (!account?.usageConnection?.supported) throw new Error('当前渠道不提供官方用量');
      account.usageConnection.status = 'connected';
      return { state: clone(state), connection: { status: 'connected' } };
    },
    disconnectProviderUsage: async (id) => { if (accountFor(id)) accountFor(id).usageConnection.status = 'disconnected'; return { state: clone(state) }; },
    clearHistory: async () => { data.history = {}; return true; },
    setWidgetVisible: async () => false,
  };
}
