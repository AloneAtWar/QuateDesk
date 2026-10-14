// /api/v1/*:面向 agent 与脚本的只读数据接口,与远程网页的 /api/* 契约互相独立。
// 设计约定:统一时间参数(date / from+to / last,优先级递减)、统一信封(query 回显 +
// generatedAt + coverage)、过滤词汇表全局同名同义、难算的领域统计进 summary、
// 好算的(环比/占比/排序)留给调用方。仅支持 GET。
const {
  canonicalModelKey, isValidTimeZone, isValidDateString, localDateString,
  zoneOffsetMs, zonedDayStartUtcMs, shiftDateString,
} = require('./cli-usage/normalize.cjs');
const { AGENT_IDS } = require('./cli-usage/index.cjs');

const MAX_RANGE_DAYS = 400;
const HOUR_MAX_SPAN_MS = 7 * 86_400_000;
const BUCKET_CAP = 480;
const WASTE_WINDOW_KEYS = ['weekly', 'monthly'];
const PROVIDER_USAGE_PROVIDERS = ['deepseek', 'zai', 'codex', 'minimax'];
// 本机 CLI 与账号厂商的典型对应(启发式,多通道路由的 CLI 无从判断)
const TYPICAL_PROVIDER = {
  zcode: 'zai', kimi: 'kimi-subscription', claude: 'claude', codex: 'codex',
  copilot: 'copilot', gemini: 'gemini', grok: 'grok', opencode: null,
  openclaw: null, hermes: null, dsh: 'deepseek',
};

const ENDPOINT_CATALOG = [
  { path: '/api/v1/meta', summary: '版本、时区、当前时间与两类数据的采集新鲜度' },
  { path: '/api/v1/accounts', summary: '账号字典:过滤参数 account 的合法取值' },
  { path: '/api/v1/agents', summary: '本机 CLI 字典:过滤参数 agent 的合法取值' },
  { path: '/api/v1/quota/snapshot', summary: '当前额度:账号 × 窗口的剩余/已用/重置时间' },
  { path: '/api/v1/quota/history', summary: '额度趋势序列(?account= 必填)' },
  { path: '/api/v1/usage/series', summary: '用量时间序列(?granularity=hour|day)' },
  { path: '/api/v1/usage/summary', summary: '区间汇总与全量累计' },
  { path: '/api/v1/usage/breakdown', summary: '维度分组:?by=model|agent|project' },
  { path: '/api/v1/waste', summary: '周期浪费:每个周期按自身总额度记 1 份' },
];

class ApiError extends Error {
  constructor(status, code, message, param = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const numOrNull = (value) => (value == null || !Number.isFinite(Number(value)) ? null : Number(value));

// 各厂商落库的 resetAt 五花八门(Z.ai 存毫秒时间戳、Kimi 存带偏移的 ISO 串、有的存秒),
// v1 出口统一为 ISO 8601 UTC 字符串,无法解析的归 null,调用方不需要再做格式判断
const isoOrNull = (value) => {
  if (value == null || value === '') return null;
  let stamp;
  const epochMs = (raw) => (raw >= 1e12 ? raw : raw >= 1e9 ? raw * 1000 : NaN); // ≥1e12 按毫秒、1e9~1e12 按秒,更小的重置时间无意义
  if (value instanceof Date) {
    stamp = value.getTime();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    stamp = epochMs(value);
  } else if (/^\d{10,16}$/.test(String(value).trim())) {
    stamp = epochMs(Number(value));
  } else {
    stamp = Date.parse(value);
  }
  return Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString() : null;
};
const trimmedParam = (url, name) => {
  const raw = url.searchParams.get(name);
  const value = raw == null ? null : raw.trim();
  return value === '' ? null : value;
};

const intParam = (url, name, { min, max, fallback }) => {
  const raw = trimmedParam(url, name);
  if (raw == null) return fallback;
  if (!/^-?\d{1,9}$/.test(raw)) throw new ApiError(400, 'invalid_param', `${name} 必须是整数`, name);
  const value = Number(raw);
  if (value < min || value > max) throw new ApiError(400, 'invalid_param', `${name} 必须在 ${min} 到 ${max} 之间`, name);
  return value;
};

const defaultTimezone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

// 无时区偏移的墙钟时间(YYYY-MM-DD[THH[:mm[:ss]]])按目标时区解释为 UTC 毫秒,两次逼近 DST
const zonedWallClockToUtcMs = (match, timeZone) => {
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const guess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  let offset = zoneOffsetMs(timeZone, guess);
  let stamp = guess - offset;
  offset = zoneOffsetMs(timeZone, stamp);
  return guess - offset;
};

// 单个时间参数 → UTC 毫秒。纯日期按目标时区当天零点;endOfDay 把纯日期解释为次日零点(右开)
const parseTimestampParam = (value, timeZone, { endOfDay = false } = {}) => {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    if (!isValidDateString(text)) return null;
    return endOfDay ? zonedDayStartUtcMs(shiftDateString(text, 1), timeZone) : zonedDayStartUtcMs(text, timeZone);
  }
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const stamp = Date.parse(text);
    return Number.isFinite(stamp) ? stamp : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2}))?(?::(\d{2}))?)?$/.exec(text);
  if (match && isValidDateString(`${match[1]}-${match[2]}-${match[3]}`)) return zonedWallClockToUtcMs(match, timeZone);
  return null;
};

// 统一时间参数:优先级 date > from/to > last > 端点默认;同时传多个只取优先级最高的一个
const parseTimeRange = (searchParams, { defaultLastMs = 7 * 86_400_000, now = Date.now() } = {}) => {
  const rawTz = searchParams.get('tz');
  const timezone = rawTz == null || rawTz.trim() === '' ? defaultTimezone() : rawTz.trim();
  if (!isValidTimeZone(timezone)) throw new ApiError(400, 'invalid_param', `无效的时区:${timezone}`, 'tz');

  const issues = [];
  let fromMs;
  let toMs;
  let resolved;
  const iso = (stamp) => new Date(stamp).toISOString();
  const param = (name) => {
    const raw = searchParams.get(name);
    if (raw == null) return null;
    const value = raw.trim();
    return value === '' ? null : value;
  };
  const date = param('date');

  if (date) {
    if (!isValidDateString(date)) throw new ApiError(400, 'invalid_param', 'date 必须是 YYYY-MM-DD 格式的有效日期', 'date');
    fromMs = zonedDayStartUtcMs(date, timezone);
    toMs = zonedDayStartUtcMs(shiftDateString(date, 1), timezone);
    resolved = { kind: 'date', date, timezone, from: iso(fromMs), to: iso(toMs) };
  } else if (param('from') || param('to')) {
    if (!param('from')) throw new ApiError(400, 'invalid_param', '只提供 to 时必须同时提供 from', 'from');
    fromMs = parseTimestampParam(searchParams.get('from'), timezone);
    if (fromMs === null) throw new ApiError(400, 'invalid_param', 'from 必须是 ISO 时间或 YYYY-MM-DD[THH:mm[:ss]]', 'from');
    const toParam = param('to');
    if (toParam) {
      toMs = parseTimestampParam(toParam, timezone, { endOfDay: true });
      if (toMs === null) throw new ApiError(400, 'invalid_param', 'to 必须是 ISO 时间或 YYYY-MM-DD[THH:mm[:ss]]', 'to');
    } else {
      toMs = now;
    }
    resolved = { kind: 'range', timezone, from: iso(fromMs), to: iso(toMs) };
  } else {
    const last = param('last');
    if (last) {
      const match = /^(\d{1,4})([hd])$/.exec(last);
      if (!match || Number(match[1]) < 1) throw new ApiError(400, 'invalid_param', 'last 必须形如 12h 或 30d', 'last');
      toMs = now;
      fromMs = now - Number(match[1]) * (match[2] === 'h' ? 3_600_000 : 86_400_000);
    } else {
      toMs = now;
      fromMs = now - defaultLastMs;
    }
    resolved = { kind: 'last', last, timezone, from: iso(fromMs), to: iso(toMs) };
  }

  if (!(fromMs < toMs)) throw new ApiError(400, 'invalid_param', '时间区间的起点必须早于终点', date ? 'date' : 'from');
  if (toMs - fromMs > MAX_RANGE_DAYS * 86_400_000) throw new ApiError(400, 'invalid_param', `时间区间最长 ${MAX_RANGE_DAYS} 天`, date ? 'date' : 'from');

  return {
    fromMs, toMs, timezone, resolved, issues,
    fromDateString: localDateString(timezone, fromMs),
    toDateString: localDateString(timezone, toMs),
  };
};

// hour 粒度协商:官方渠道只有天;本机超 7 天自动降级为天并记录 issue
const negotiateGranularity = (requested, spanMs, source, issues) => {
  let granularity = requested === 'hour' ? 'hour' : 'day';
  if (granularity === 'hour' && source === 'provider') {
    granularity = 'day';
    issues.push('官方渠道只提供按天数据,granularity=hour 已按 day 执行');
  } else if (granularity === 'hour' && spanMs > HOUR_MAX_SPAN_MS) {
    granularity = 'day';
    issues.push('granularity=hour 的区间超过 7 天,已按 day 执行');
  }
  return granularity;
};

// 桶数超上限时等距抽样,保留首尾
const sampleBuckets = (buckets, cap = BUCKET_CAP) => {
  if (buckets.length <= cap) return { sampled: false, originalBuckets: buckets.length, buckets };
  const stride = Math.ceil((buckets.length - 1) / (cap - 1));
  const kept = buckets.filter((_bucket, index) => index % stride === 0 || index === buckets.length - 1);
  return { sampled: true, originalBuckets: buckets.length, buckets: kept };
};

const envelope = (queryEcho) => ({ query: queryEcho, generatedAt: new Date().toISOString() });
const echoParams = (url, names) => Object.fromEntries(
  names.map((name) => [name, url.searchParams.get(name)]).filter(([, value]) => value != null && value !== ''),
);
const queryEcho = (url, time, names) => ({ ...echoParams(url, names), ...time.resolved });

const tokenShape = (entry) => ({
  total: entry.totalTokens,
  input: entry.inputTokens,
  output: entry.outputTokens,
  cacheRead: entry.cacheReadTokens,
  cacheWrite: entry.cacheWriteTokens,
  extra: entry.extraTokens,
});

// ---- 共享读取 ------------------------------------------------------------

const loadStateOrEmpty = (deps) => deps.store.loadState() || {};
const providerMap = (state) => new Map((state.providers || []).map((provider) => [provider.id, provider]));

const trackedWindowKeys = (account) => (Array.isArray(account.windowKeys) && account.windowKeys.length
  ? account.windowKeys
  : Array.isArray(account.windows) ? account.windows.map((meter) => meter.key) : []);

const wasteWindowKeys = (account, provider) => {
  const configured = Array.isArray(account.wasteWindows) ? account.wasteWindows
    : Array.isArray(provider?.requestConfig?.wasteWindows) ? provider.requestConfig.wasteWindows
      : (provider?.requestConfig?.windows || []).filter((key) => WASTE_WINDOW_KEYS.includes(key));
  const tracked = trackedWindowKeys(account);
  return configured.filter((key) => WASTE_WINDOW_KEYS.includes(key) && (!tracked.length || tracked.includes(key)));
};

const usageConnectionStatus = (account) => (['connected', 'reauth_required'].includes(account.usageConnection?.status)
  ? account.usageConnection.status
  : account.usageConnection?.connected === true ? 'connected' : 'disconnected');

const quotaFreshness = (state) => ({
  lastSync: state.lastSync || null,
  pollMinutes: Math.min(30, Math.max(1, Number(state.settings?.pollMinutes) || 5)),
});

const cliUsageFreshness = async (deps) => {
  try {
    const sources = await deps.cliUsage.getSources();
    return { lastScanAt: sources?.[0]?.lastScannedAt || null };
  } catch {
    return { lastScanAt: null, error: 'cli_usage_unavailable' };
  }
};

// ---- 字典端点 ------------------------------------------------------------

async function metaHandler({ deps }) {
  const state = loadStateOrEmpty(deps);
  return {
    ...envelope({}),
    version: deps.appVersion || null,
    timezone: defaultTimezone(),
    now: new Date().toISOString(),
    freshness: { quota: quotaFreshness(state), cliUsage: await cliUsageFreshness(deps) },
    endpoints: ENDPOINT_CATALOG,
  };
}

function accountsHandler({ deps }) {
  const state = loadStateOrEmpty(deps);
  const providers = providerMap(state);
  return {
    ...envelope({}),
    accounts: (state.accounts || []).map((account) => {
      const provider = providers.get(account.providerId);
      return {
        id: account.id,
        name: account.name || null,
        providerId: account.providerId,
        providerName: provider?.name || account.providerId,
        status: account.status === 'warning' ? 'warning' : 'active',
        authStatus: account.authStatus || 'ok',
        disabled: Boolean(account.disabled),
        tags: Array.isArray(account.tags) ? account.tags : [],
        windowKeys: trackedWindowKeys(account),
        wasteWindows: wasteWindowKeys(account, provider),
        usageSupported: PROVIDER_USAGE_PROVIDERS.includes(account.providerId) && account.usageConnection?.supported !== false,
        usageStatus: usageConnectionStatus(account),
        lastChecked: account.lastChecked || null,
      };
    }),
  };
}

async function agentsHandler({ deps }) {
  let sources;
  try { sources = await deps.cliUsage.getSources(); } catch { throw new ApiError(502, 'cli_usage_unavailable', '本机用量服务不可用'); }
  return {
    ...envelope({}),
    agents: sources.map((source) => ({
      key: source.agent,
      displayName: source.displayName,
      status: source.status,
      records: source.records,
      files: source.files,
      warning: source.warning || null,
      lastScannedAt: source.lastScannedAt || null,
      typicalProvider: TYPICAL_PROVIDER[source.agent] || null,
    })),
  };
}

// ---- 额度端点 ------------------------------------------------------------

function quotaSnapshotHandler({ deps, url }) {
  const accountFilter = trimmedParam(url, 'account');
  const state = loadStateOrEmpty(deps);
  const providers = providerMap(state);
  const accounts = (state.accounts || []).filter((account) => !accountFilter || account.id === accountFilter);
  if (accountFilter && !accounts.length) throw new ApiError(404, 'account_not_found', '账号不存在');
  return {
    ...envelope(queryEcho(url, { resolved: {}, timezone: defaultTimezone() }, ['account'])),
    lastSync: state.lastSync || null,
    freshness: { quota: quotaFreshness(state) },
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name || null,
      providerId: account.providerId,
      providerName: providers.get(account.providerId)?.name || account.providerId,
      status: account.status === 'warning' ? 'warning' : 'active',
      disabled: Boolean(account.disabled),
      windows: (Array.isArray(account.windows) ? account.windows : []).map((meter) => ({
        key: meter?.key ?? null,
        unit: meter?.unit ?? null,
        remaining: numOrNull(meter?.remaining),
        used: numOrNull(meter?.used),
        total: numOrNull(meter?.total),
        amount: numOrNull(meter?.amount),
        limitAmount: numOrNull(meter?.limitAmount),
        resetAt: isoOrNull(meter?.resetAt),
        available: meter?.available !== false,
      })),
    })),
  };
}

async function quotaHistoryHandler({ deps, url, time }) {
  const accountParam = trimmedParam(url, 'account');
  if (!accountParam) throw new ApiError(400, 'invalid_param', '必须提供 account 参数', 'account');
  const state = loadStateOrEmpty(deps);
  if (!(state.accounts || []).some((account) => account.id === accountParam)) throw new ApiError(404, 'account_not_found', '账号不存在');
  const windowKey = trimmedParam(url, 'window');
  const points = await Promise.resolve(deps.getHistory ? deps.getHistory(accountParam) : []);
  const filtered = (Array.isArray(points) ? points : []).filter((point) => {
    const at = Date.parse(point?.at);
    return Number.isFinite(at) && at >= time.fromMs && at < time.toMs
      && (!windowKey || point?.windows?.[windowKey] != null);
  });
  const cap = intParam(url, 'points', { min: 10, max: 800, fallback: 400 });
  const stride = Math.max(1, Math.ceil((filtered.length - 1) / (cap - 1)));
  const sampled = stride > 1 ? filtered.filter((_point, index) => index % stride === 0 || index === filtered.length - 1) : filtered;
  return {
    ...envelope(queryEcho(url, time, ['account', 'window', 'points'])),
    sampled: stride > 1,
    originalCount: filtered.length,
    points: sampled.map((point) => ({
      at: point.at,
      windows: Object.fromEntries(Object.entries(point.windows || {})
        .filter(([key]) => !windowKey || key === windowKey)
        .map(([key, meter]) => [key, {
          remaining: numOrNull(meter?.remaining),
          amount: numOrNull(meter?.amount),
          limit: numOrNull(meter?.limit),
          unit: meter?.unit ?? null,
          resetAt: isoOrNull(meter?.resetAt),
        }])),
    })),
  };
}

// ---- 用量端点 ------------------------------------------------------------

async function buildUsageQuery({ url, time, deps }) {
  const source = trimmedParam(url, 'source') || 'local';
  if (!['local', 'provider'].includes(source)) throw new ApiError(400, 'invalid_param', 'source 只支持 local 或 provider', 'source');

  const accountParam = trimmedParam(url, 'account');
  let providerAccount = null;
  if (source === 'provider') {
    if (!accountParam) throw new ApiError(400, 'invalid_param', 'source=provider 时必须提供 account 参数', 'account');
    const state = loadStateOrEmpty(deps);
    providerAccount = (state.accounts || []).find((account) => account.id === accountParam);
    if (!providerAccount) throw new ApiError(404, 'account_not_found', '账号不存在');
    const connected = ['connected', 'reauth_required'].includes(providerAccount.usageConnection?.status) || providerAccount.usageConnection?.connected === true;
    if (!PROVIDER_USAGE_PROVIDERS.includes(providerAccount.providerId) || providerAccount.usageConnection?.supported === false || !connected) {
      throw new ApiError(409, 'usage_not_connected', '该账号未连接官方用量(仅 DeepSeek / Z.ai / Codex / MiniMax 支持)');
    }
  } else if (accountParam) {
    throw new ApiError(400, 'invalid_param', 'source=local 没有账号维度,请去掉 account 参数', 'account');
  }

  const agentsParam = trimmedParam(url, 'agent');
  let agents = null;
  if (agentsParam) {
    if (source !== 'local') throw new ApiError(400, 'invalid_param', 'source=provider 不支持按本机渠道过滤', 'agent');
    agents = agentsParam.split(',').map((value) => value.trim()).filter(Boolean);
    const invalid = agents.filter((agent) => !AGENT_IDS.includes(agent));
    if (invalid.length) throw new ApiError(400, 'invalid_param', `未知的本机用量渠道:${invalid.join(',')}`, 'agent');
    if (!agents.length) agents = null;
  }

  const modelsParam = trimmedParam(url, 'model');
  let canonicalModels = null;
  let modelsIncludeUnknown = false;
  let providerModelNames = null;
  if (modelsParam) {
    if (source === 'local') {
      canonicalModels = [];
      for (const raw of modelsParam.split(',').map((value) => value.trim()).filter(Boolean)) {
        if (raw === 'unknown') { modelsIncludeUnknown = true; continue; }
        const key = canonicalModelKey(raw);
        if (!key) throw new ApiError(400, 'invalid_param', `无法识别的模型名:${raw}`, 'model');
        canonicalModels.push(key);
      }
      if (!canonicalModels.length && !modelsIncludeUnknown) canonicalModels = null;
    } else {
      providerModelNames = modelsParam.split(',').map((value) => value.trim()).filter(Boolean);
    }
  }

  const projectParam = trimmedParam(url, 'project');
  let projectKeys = null;
  let projectIncludeUnknown = false;
  if (projectParam) {
    if (source !== 'local') throw new ApiError(400, 'invalid_param', 'source=provider 不支持按项目过滤', 'project');
    projectKeys = [];
    for (const raw of projectParam.split(',').map((value) => value.trim()).filter(Boolean)) {
      if (raw === 'unknown') { projectIncludeUnknown = true; continue; }
      if (!/^[a-f0-9]{4,64}$/i.test(raw)) throw new ApiError(400, 'invalid_param', 'project 必须是 breakdown?by=project 返回的十六进制键', 'project');
      projectKeys.push(raw.toLowerCase());
    }
    if (!projectKeys.length && !projectIncludeUnknown) projectKeys = null;
  }

  return { source, providerAccount, agents, canonicalModels, modelsIncludeUnknown, providerModelNames, projectKeys, projectIncludeUnknown };
}

const localAggregate = async (deps, { time, granularity, query, groupBy = null }) => {
  if (!deps.cliUsage || typeof deps.cliUsage.getV1Aggregate !== 'function') throw new ApiError(502, 'cli_usage_unavailable', '本机用量服务不可用');
  try {
    return await deps.cliUsage.getV1Aggregate({
      startMs: time.fromMs,
      endMs: time.toMs,
      granularity,
      timezone: time.timezone,
      agents: query.agents,
      canonicalModels: query.canonicalModels,
      modelsIncludeUnknown: query.modelsIncludeUnknown,
      projectKeys: query.projectKeys,
      projectIncludeUnknown: query.projectIncludeUnknown,
      groupBy,
    });
  } catch (error) {
    if (error?.name === 'CliUsageError') throw new ApiError(400, 'invalid_param', error.message);
    throw new ApiError(502, 'cli_usage_unavailable', '本机用量服务不可用');
  }
};

const fetchProviderUsage = async (deps, account, time, url) => {
  const days = Math.min(365, Math.max(1, Math.ceil((time.toMs - time.fromMs) / 86_400_000) + 1));
  const refresh = ['1', 'true'].includes(String(trimmedParam(url, 'refresh') || '').toLowerCase());
  const fetcher = deps.queryUsage || ((accountId) => deps.getUsage(accountId));
  let data;
  try { data = await fetcher(account.id, { days, force: refresh }); } catch { throw new ApiError(502, 'usage_unavailable', '官方用量查询失败'); }
  if (!data || data.provider !== account.providerId) throw new ApiError(502, 'usage_unavailable', '官方用量查询失败');
  return data;
};

const filterProviderDays = (data, time, query) => (Array.isArray(data.days) ? data.days : []).filter((day) => {
  if (typeof day?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) return false;
  if (day.date < time.fromDateString || day.date >= time.toDateString) return false;
  if (query.providerModelNames && query.providerModelNames.length) {
    return (Array.isArray(day.models) ? day.models : []).some((model) => query.providerModelNames.includes(model?.model));
  }
  return true;
});

const providerCoverage = (data, time) => ({
  complete: data.coverage?.partial !== true,
  issues: [
    ...(Array.isArray(data.coverage?.issues) ? data.coverage.issues : []),
    ...(data.coverage?.timezoneOffsetSec != null ? [`官方数据时区偏移 ${data.coverage.timezoneOffsetSec} 秒,日界与查询时区可能不一致`] : []),
  ],
});

const localCoverage = (result, time) => ({
  complete: result.earliestEventMs === null || result.earliestEventMs >= time.fromMs,
  issues: [],
});

const USAGE_PARAM_NAMES = ['source', 'account', 'agent', 'model', 'project', 'granularity', 'by', 'top', 'refresh'];

async function usageSeriesHandler({ deps, url, time }) {
  const query = await buildUsageQuery({ url, time, deps });
  const requested = trimmedParam(url, 'granularity') || 'day';
  if (!['hour', 'day'].includes(requested)) throw new ApiError(400, 'invalid_param', 'granularity 只支持 hour 或 day', 'granularity');
  const granularity = negotiateGranularity(requested, time.toMs - time.fromMs, query.source, time.issues);

  let buckets;
  let coverage;
  let extra = {};
  if (query.source === 'local') {
    const result = await localAggregate(deps, { time, granularity, query });
    buckets = result.buckets.map((bucket) => ({ t: bucket.label, startMs: bucket.startMs, tokens: tokenShape(bucket), requests: bucket.requests, sessions: bucket.sessions }));
    coverage = localCoverage(result, time);
  } else {
    const data = await fetchProviderUsage(deps, query.providerAccount, time, url);
    const days = filterProviderDays(data, time, query);
    buckets = days.map((day) => ({ t: day.date, tokens: { total: numOrNull(day.tokens) }, cost: numOrNull(day.cost), currency: day.currency || data.currency || null, requests: numOrNull(day.requests) }));
    coverage = providerCoverage(data, time);
    extra = { metric: data.metric || 'tokens', currency: data.currency || null };
  }
  const sampling = sampleBuckets(buckets);
  return {
    ...envelope(queryEcho(url, time, USAGE_PARAM_NAMES)),
    source: query.source,
    granularity,
    ...extra,
    coverage: { ...coverage, issues: [...coverage.issues, ...time.issues] },
    ...sampling,
    buckets: sampling.buckets,
  };
}

async function usageSummaryHandler({ deps, url, time }) {
  const query = await buildUsageQuery({ url, time, deps });
  if (query.source === 'local') {
    const result = await localAggregate(deps, { time, granularity: 'day', query });
    return {
      ...envelope(queryEcho(url, time, USAGE_PARAM_NAMES)),
      source: 'local',
      coverage: localCoverage(result, time),
      range: {
        tokens: tokenShape(result.totals),
        requests: result.totals.requests,
        sessions: result.totals.sessions,
        activeDays: result.totals.activeBuckets,
        peak: result.totals.peak,
        currentStreakDays: result.totals.currentStreakDays,
        longestStreakDays: result.totals.longestStreakDays,
        cacheReuseRatio: result.totals.cacheReuseRatio,
      },
      allTime: { tokens: { total: result.allTimeTotalTokens } },
    };
  }
  const data = await fetchProviderUsage(deps, query.providerAccount, time, url);
  const days = filterProviderDays(data, time, query);
  const rangeTokens = days.reduce((sum, day) => sum + (Number(day.tokens) || 0), 0);
  const rangeCost = days.reduce((sum, day) => sum + (Number(day.cost) || 0), 0);
  const requests = days.reduce((sum, day) => sum + (Number(day.requests) || 0), 0);
  let peak = null;
  for (const day of days) {
    const tokens = Number(day.tokens) || 0;
    if (tokens > 0 && (!peak || tokens > peak.tokens)) peak = { date: day.date, tokens };
  }
  return {
    ...envelope(queryEcho(url, time, USAGE_PARAM_NAMES)),
    source: 'provider',
    metric: data.metric || 'tokens',
    currency: data.currency || null,
    coverage: { ...providerCoverage(data, time), issues: [...providerCoverage(data, time).issues, ...time.issues] },
    range: {
      days: days.length,
      tokens: { total: rangeTokens || null },
      cost: data.metric === 'cost' || rangeCost > 0 ? rangeCost : null,
      requests: requests || null,
      peak,
    },
    allTime: {
      tokens: { total: numOrNull(data.summary?.totalTokens) },
      cost: numOrNull(data.summary?.totalCost),
      planName: typeof data.summary?.planName === 'string' ? data.summary.planName : null,
    },
  };
}

// top-N 之外合并进 other;sessions/requests 在合并行中为各行之和(可能重复计数)
const applyTop = (rows, top) => {
  const grand = rows.reduce((sum, row) => sum + row.tokens.total, 0);
  const withShare = rows.map((row) => ({ ...row, share: grand > 0 ? row.tokens.total / grand : 0 }));
  if (withShare.length <= top) return { rows: withShare, other: null };
  const head = withShare.slice(0, top);
  const rest = withShare.slice(top);
  const sumField = (field) => rest.reduce((sum, row) => sum + row[field], 0);
  const tokens = {};
  for (const field of ['total', 'input', 'output', 'cacheRead', 'cacheWrite', 'extra']) {
    tokens[field] = rest.reduce((sum, row) => sum + (row.tokens[field] || 0), 0);
  }
  const other = {
    key: 'other',
    displayName: `其他 ${rest.length} 项`,
    tokens,
    requests: sumField('requests'),
    sessions: sumField('sessions'),
    share: rest.reduce((sum, row) => sum + row.share, 0),
    agents: [...new Set(rest.flatMap((row) => row.agents || []))],
  };
  return { rows: head, other };
};

async function usageBreakdownHandler({ deps, url, time, scope }) {
  const query = await buildUsageQuery({ url, time, deps });
  const by = trimmedParam(url, 'by') || 'model';
  if (!['model', 'agent', 'project'].includes(by)) throw new ApiError(400, 'invalid_param', 'by 只支持 model、agent 或 project', 'by');
  const top = intParam(url, 'top', { min: 1, max: 100, fallback: 15 });

  let rows;
  let coverage;
  let extra = {};
  if (query.source === 'local') {
    const result = await localAggregate(deps, { time, granularity: 'day', query, groupBy: by });
    rows = result.groups.map((group) => ({
      key: group.key,
      displayName: by === 'project' ? (scope === 'local' ? group.label || group.key : group.key) : group.displayName,
      ...(by !== 'agent' ? { agents: group.agents } : {}),
      tokens: tokenShape(group),
      requests: group.requests,
      sessions: group.sessions,
      firstAt: new Date(group.firstAtMs).toISOString(),
      lastAt: new Date(group.lastAtMs).toISOString(),
    }));
    coverage = localCoverage(result, time);
  } else {
    if (by !== 'model') throw new ApiError(400, 'invalid_param', '官方渠道只支持 by=model', 'by');
    const data = await fetchProviderUsage(deps, query.providerAccount, time, url);
    const days = filterProviderDays(data, time, query);
    const groups = new Map();
    for (const day of days) {
      for (const model of Array.isArray(day.models) ? day.models : []) {
        const name = typeof model?.model === 'string' && model.model ? model.model : null;
        if (!name) continue;
        if (query.providerModelNames && query.providerModelNames.length && !query.providerModelNames.includes(name)) continue;
        let group = groups.get(name);
        if (!group) { group = { key: name, tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, extra: 0 }, requests: 0, cost: 0 }; groups.set(name, group); }
        group.tokens.total += Number(model.tokens) || 0;
        group.tokens.input += Number(model.inputTokens) || 0;
        group.tokens.output += Number(model.outputTokens) || 0;
        group.tokens.cacheRead += Number(model.cacheHitTokens) || 0;
        group.tokens.cacheWrite += Number(model.cacheMissTokens) || 0;
        group.requests += Number(model.requests) || 0;
        group.cost += Number(model.cost) || 0;
      }
    }
    rows = [...groups.values()].sort((left, right) => right.tokens.total - left.tokens.total)
      .map((group) => ({ key: group.key, displayName: group.key, tokens: group.tokens, cost: group.cost || null, requests: group.requests }));
    coverage = providerCoverage(data, time);
    extra = { metric: data.metric || 'tokens', currency: data.currency || null };
  }
  const { rows: topRows, other } = applyTop(rows, top);
  return {
    ...envelope(queryEcho(url, time, USAGE_PARAM_NAMES)),
    source: query.source,
    by,
    top,
    ...extra,
    coverage: { ...coverage, issues: [...coverage.issues, ...time.issues] },
    rows: topRows,
    ...(other ? { other } : {}),
  };
}

// ---- 浪费端点 ------------------------------------------------------------

const detailCycles = (records) => records.map((record) => ({
  window: record.cycle.window,
  kind: record.cycle.kind,
  from: record.cycle.from || null,
  end: record.cycle.end,
  observedAt: record.cycle.observedAt || null,
  remaining: record.remaining,
  amount: numOrNull(record.cycle.amount),
  limit: numOrNull(record.cycle.limit),
  gapMs: numOrNull(record.cycle.gapMs),
  reliable: record.cycle.reliable === true,
  counted: record.counted,
}));

async function wasteHandler({ deps, url, time }) {
  const windowParam = trimmedParam(url, 'window');
  if (windowParam && !WASTE_WINDOW_KEYS.includes(windowParam)) throw new ApiError(400, 'invalid_param', 'window 只支持 weekly 或 monthly', 'window');
  const accountParam = trimmedParam(url, 'account');
  const state = loadStateOrEmpty(deps);
  const providers = providerMap(state);
  let accounts = state.accounts || [];
  if (accountParam) {
    accounts = accounts.filter((account) => account.id === accountParam);
    if (!accounts.length) throw new ApiError(404, 'account_not_found', '账号不存在');
  }

  // 与看板口径一致:reliable 且自然结束的周期才计入平均;份额 = remaining/100,
  // 每个账号自己的周期总额度记 1 份,不代表金额或 Token
  const windows = new Map();
  for (const account of accounts) {
    const provider = providers.get(account.providerId);
    const keys = wasteWindowKeys(account, provider).filter((key) => !windowParam || key === windowParam);
    if (!keys.length) continue;
    const cycles = await Promise.resolve(deps.getCycles ? deps.getCycles(account.id) : []);
    const seen = new Set();
    for (const cycle of Array.isArray(cycles) ? cycles : []) {
      if (!keys.includes(cycle?.window)) continue;
      const endMs = Date.parse(cycle.end);
      if (!Number.isFinite(endMs) || endMs < time.fromMs || endMs >= time.toMs) continue;
      const identity = `${cycle.window}:${cycle.kind}:${cycle.end}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const percentage = Number(cycle.remaining);
      const remaining = Number.isFinite(percentage) && percentage >= 0 && percentage <= 100 ? percentage : null;
      const counted = cycle.reliable === true && cycle.kind === 'natural' && remaining !== null;
      if (!windows.has(cycle.window)) windows.set(cycle.window, []);
      windows.get(cycle.window).push({
        cycle, accountId: account.id, accountName: account.name || account.id, endMs, remaining, counted,
      });
    }
  }

  const windowRows = [...windows.entries()].map(([key, records]) => {
    const counted = records.filter((record) => record.counted);
    const totalShares = counted.reduce((sum, record) => sum + record.remaining / 100, 0);
    const byAccount = new Map();
    for (const record of counted) {
      const entry = byAccount.get(record.accountId) || { accountId: record.accountId, name: record.accountName, wasteShares: 0, countedCycles: 0, records: [] };
      entry.wasteShares += record.remaining / 100;
      entry.countedCycles += 1;
      if (accountParam) entry.records.push(record);
      byAccount.set(record.accountId, entry);
    }
    return {
      window: key,
      cycles: records.length,
      countedCycles: counted.length,
      averageRemaining: counted.length ? counted.reduce((sum, record) => sum + record.remaining, 0) / counted.length : null,
      totalWasteShares: counted.length ? totalShares : null,
      accounts: [...byAccount.values()]
        .map(({ records: accountRecords, ...entry }) => ({
          ...entry,
          share: totalShares > 0 ? entry.wasteShares / totalShares : 0,
          ...(accountParam ? { cycles: detailCycles(accountRecords) } : {}),
        }))
        .sort((left, right) => right.wasteShares - left.wasteShares || left.accountId.localeCompare(right.accountId)),
    };
  }).sort((left, right) => left.window.localeCompare(right.window));

  return {
    ...envelope(queryEcho(url, time, ['window', 'account'])),
    coverage: { complete: true, issues: time.issues },
    windows: windowRows,
  };
}

// ---- 路由 ----------------------------------------------------------------

const ROUTES = [
  ['/api/v1/meta', metaHandler],
  ['/api/v1/accounts', accountsHandler],
  ['/api/v1/agents', agentsHandler],
  ['/api/v1/quota/snapshot', quotaSnapshotHandler],
  ['/api/v1/quota/history', quotaHistoryHandler],
  ['/api/v1/usage/series', usageSeriesHandler],
  ['/api/v1/usage/summary', usageSummaryHandler],
  ['/api/v1/usage/breakdown', usageBreakdownHandler],
  ['/api/v1/waste', wasteHandler],
];

const TIME_DEFAULTS = new Map([
  ['/api/v1/quota/history', 7 * 86_400_000],
  ['/api/v1/usage/series', 7 * 86_400_000],
  ['/api/v1/usage/summary', 7 * 86_400_000],
  ['/api/v1/usage/breakdown', 7 * 86_400_000],
  ['/api/v1/waste', 31 * 86_400_000],
]);

// 远程查看服务器在令牌校验通过后调用;返回 true 表示已处理(含错误响应)
async function handleApiV1({ pathname, url, request, response, deps, scope = 'device', now = Date.now() }) {
  try {
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method_not_supported', message: 'v1 接口仅支持 GET' });
      return true;
    }
    const route = ROUTES.find(([prefix]) => pathname === prefix);
    if (!route) {
      json(response, 404, { error: 'not_found', message: '未知的 v1 端点,可用端点见 /api/v1/meta' });
      return true;
    }
    const [prefix, handler] = route;
    const time = parseTimeRange(url.searchParams, { defaultLastMs: TIME_DEFAULTS.get(prefix) || 7 * 86_400_000, now });
    const payload = await handler({ pathname: prefix, url, request, deps, scope, now, time });
    json(response, 200, payload);
  } catch (error) {
    if (error instanceof ApiError) {
      json(response, error.status, { error: error.code, message: error.message, ...(error.param ? { param: error.param } : {}) });
    } else {
      json(response, 500, { error: 'internal', message: '服务内部错误' });
    }
  }
  return true;
}

module.exports = {
  handleApiV1,
  parseTimeRange,
  negotiateGranularity,
  applyTop,
  ApiError,
  defaultTimezone,
};
