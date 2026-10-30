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
  // 演示档案:kimi 渠道挂在「笔记本归档」导入来源下,其余都是本机采集;
  // 行级来源分配是演示专用的,桌面版由 sqlite 的来源表决定
  const LOCAL_SOURCE_ID = 'demo-local-archive-01';
  const LAPTOP_SOURCE_ID = 'demo-imported-laptop-01';
  const rowSourceId = (row) => (row.agent === 'kimi' ? LAPTOP_SOURCE_ID : LOCAL_SOURCE_ID);
  const sourceRows = (sourceId) => data.localUsage.rows.filter((row) => rowSourceId(row) === sourceId);
  const sourceStats = (sourceId) => {
    const rows = sourceRows(sourceId);
    return {
      records: rows.reduce((sum, row) => sum + row.requests, 0),
      totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
      firstAt: rows.length ? `${rows[0].date}T09:00:00.000Z` : null,
      lastAt: rows.length ? `${rows[rows.length - 1].date}T21:30:00.000Z` : null,
    };
  };
  let archiveState = {
    local: { sourceId: LOCAL_SOURCE_ID, label: '本机采集', revision: 7, ...sourceStats(LOCAL_SOURCE_ID) },
    imported: [{ sourceId: LAPTOP_SOURCE_ID, label: '笔记本归档', originLabel: 'LAPTOP-DEMO', revision: 4, enabled: true, importedAt: new Date(now - 12 * DAY).toISOString(), ...sourceStats(LAPTOP_SOURCE_ID) }],
    history: [],
  };
  let state = {
    accounts: data.accounts, providers: data.providers,
    settings: { theme, onboarded: true, widget: false, historyDays: 0, localCliUsage: { enabled: true, mergeSameModels: true, scanWsl: false } },
    lastSync: new Date(now).toISOString(), runtime: { running: false, checking: false, nextPollAt: null },
  };
  const accountFor = (id) => state.accounts.find((account) => account.id === id);
  // 汇总口径排除「暂停计入」的导入来源;指定 sourceId 查看时档案本身仍完整可见
  const rowVisible = (row, query) => (!query.sourceId
    || rowSourceId(row) === query.sourceId)
    && (query.sourceId || !archiveState.imported.some((source) => source.sourceId === rowSourceId(row) && source.enabled === false));
  const filteredRows = (query) => data.localUsage.rows.filter((row) => (!query.agent || query.agent === 'all' || query.agent === row.agent) && rowVisible(row, query) && matchesRules(row, query.modelRules));
  const sourceScopedSources = (query) => clone(data.localUsage.sources.map((source) => ({
    ...source,
    records: query.sourceId
      ? sourceRows(query.sourceId).filter((row) => row.agent === source.agent).reduce((sum, row) => sum + row.requests, 0)
      : (archiveState.imported.some((entry) => entry.sourceId === LAPTOP_SOURCE_ID && entry.enabled === false)
        ? data.localUsage.rows.filter((row) => rowVisible(row, {})).filter((row) => row.agent === source.agent).reduce((sum, row) => sum + row.requests, 0)
        : source.records),
  })));
  const summary = (query = {}) => {
    const end = query.endDate || today;
    const start = query.startDate || addDays(end, 1 - (query.days || 365));
    const rowsAll = filteredRows(query);
    // 显式日期区间(浪费周期 → 本机用量):累计口径随区间收敛
    const rows = query.startDate ? rowsAll.filter((row) => row.date >= start && row.date <= end) : rowsAll;
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
      recordsByAgent: query.modelRules == null ? null : rowsAll.reduce((counts, row) => ({ ...counts, [row.agent]: (counts[row.agent] || 0) + row.requests }), {}),
      summary: { ...totals, totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0), coverageComplete: rows.every((row) => row.date >= start), peakTokens: Math.max(0, ...dayRows.map((row) => row.totalTokens)), currentStreakDays: counts.current, longestStreakDays: counts.longest, sessions: sessions.size, activeDays: dayRows.filter((row) => row.totalTokens > 0).length, cacheReuseRatio: cacheBase > 0 ? totals.cacheReadTokens / cacheBase : null },
      days: dayRows,
    };
  };
  const models = (query = {}) => {
    const scope = query.scope || { kind: 'range', days: 30 };
    const tz = query.timezone || snapshot.timezone;
    const end = scope.kind === 'day' ? scope.date
      : scope.kind === 'between' ? dateInZone(Math.max(scope.fromMs, scope.toMs - 1), tz)
        : today;
    const start = scope.kind === 'day' ? scope.date
      : scope.kind === 'between' ? dateInZone(scope.fromMs, tz)
        : scope.days > 0 ? addDays(end, 1 - scope.days) : null;
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
    readCliLogins: async () => ({}), importCliLogin: unsupported,
    getHistory: async (id) => clone(data.history[id] || []), getCycles: async (id) => clone(data.cycles[id] || []),
    getLocalCliUsageSources: async (query = {}) => sourceScopedSources(query), scanLocalCliUsage: async () => clone(data.localUsage.sources),
    getLocalCliUsageSummary: async (query) => summary(query), getLocalCliUsageModels: async (query) => models(query),
    getUsageArchives: async () => clone(archiveState),
    onUsageArchivesChanged: () => () => {},
    updateUsageArchive: async (query) => {
      if (query.sourceId === LOCAL_SOURCE_ID) {
        if (query.label !== undefined) archiveState.local.label = String(query.label).slice(0, 100);
        if (query.enabled === false) throw new Error('不能停用本机档案');
      } else {
        const source = archiveState.imported.find((entry) => entry.sourceId === query.sourceId);
        if (!source) throw new Error('导入来源不存在');
        if (query.label !== undefined) source.label = String(query.label).slice(0, 100);
        if (query.enabled !== undefined) source.enabled = Boolean(query.enabled);
      }
      return clone(archiveState);
    },
    deleteUsageArchive: async (sourceId) => {
      if (sourceId === LOCAL_SOURCE_ID) throw new Error('不能通过导入管理删除本机档案');
      if (!archiveState.imported.some((entry) => entry.sourceId === sourceId)) throw new Error('导入来源不存在');
      archiveState.imported = archiveState.imported.filter((entry) => entry.sourceId !== sourceId);
      data.localUsage.rows = data.localUsage.rows.filter((row) => rowSourceId(row) !== sourceId);
      return clone(archiveState);
    },
    exportUsageArchives: async () => { throw new Error('演示模式不支持导出档案'); },
    importUsageArchives: async () => { throw new Error('演示模式不支持导入档案'); },
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
