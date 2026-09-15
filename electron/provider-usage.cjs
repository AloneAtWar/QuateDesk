const DEEPSEEK_PLATFORM_ORIGIN = 'https://platform.deepseek.com';
const DEEPSEEK_ROUTES = Object.freeze({
  summary: '/api/v0/users/get_user_summary',
  amount: '/api/v0/usage/by_api_key/amount',
  cost: '/api/v0/usage/by_api_key/cost',
  legacyAmount: '/api/v0/usage/amount',
  legacyCost: '/api/v0/usage/cost',
});

const DEFAULT_TIMEZONE_OFFSET_SEC = 8 * 60 * 60;
const DEFAULT_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 3_660;
const AUTH_ERROR_CODES = new Set([40002, 40003]);
const MAX_USER_TOKEN_LENGTH = 16 * 1024;
const SUMMARY_FIELDS = [
  'normal_wallets',
  'bonus_wallets',
  'current_token',
  'total_usage',
  'monthly_usage',
  'monthly_token_usage',
  'total_available_token_estimation',
  'total_costs',
  'monthly_costs',
];
const SUMMARY_NUMBER_FIELDS = [
  'current_token',
  'total_usage',
  'monthly_usage',
  'monthly_token_usage',
  'total_available_token_estimation',
];
const TOKEN_USAGE_FIELDS = new Set([
  'PROMPT_TOKEN',
  'PROMPT_CACHE_HIT_TOKEN',
  'PROMPT_CACHE_MISS_TOKEN',
  'RESPONSE_TOKEN',
  'REQUEST',
]);
// These are top-level destinations used by the current platform login flow. Third-party
// scripts and iframes are not navigated through this allow-list; Google OAuth and the
// WeChat QR callback are. Keep this exact-host list deliberately narrow.
const DEEPSEEK_LOGIN_HOSTS = new Set([
  'platform.deepseek.com',
  'accounts.google.com',
  'open.weixin.qq.com',
  'appleid.apple.com',
]);

class ProviderUsageError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.name = 'ProviderUsageError';
    this.code = code;
    if (status !== null) this.status = status;
  }
}

const own = (value, key) => Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));
const objectOf = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const isAllowedDeepSeekLoginUrl = (rawUrl) => {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (!url.port || url.port === '443')
      && DEEPSEEK_LOGIN_HOSTS.has(url.hostname.toLowerCase());
  } catch { return false; }
};

const normalizeDeepSeekUserToken = (raw) => {
  let value = raw;
  for (let depth = 0; depth < 6; depth += 1) {
    if (value && typeof value === 'object') {
      const field = ['value', 'token', 'accessToken', 'access_token']
        .find((key) => own(value, key) && value[key] !== undefined && value[key] !== null);
      if (!field) return '';
      value = value[field];
      continue;
    }
    const text = String(value || '').trim();
    if (!text) return '';
    // The platform storage manager serializes userToken as
    // {"value":"...","__version":"0"}; quoted JSON strings also occur in
    // older builds. Do not try to JSON-parse ordinary opaque/JWT tokens.
    if (/^[{[\"]/.test(text)) {
      try {
        value = JSON.parse(text);
        continue;
      } catch {}
    }
    const token = text.replace(/^Bearer\s+/i, '').trim();
    if (!token || token.length > MAX_USER_TOKEN_LENGTH || /[\u0000-\u0020\u007f]/.test(token)) return '';
    return token;
  }
  return '';
};

const shouldUseCachedUsage = (cached, { force = false, maxAgeMs, nowMs = Date.now() } = {}) => {
  const ageLimit = Number(maxAgeMs);
  const cachedAt = Number(cached?.at);
  return !force
    && Number.isFinite(ageLimit)
    && ageLimit >= 0
    && Number.isFinite(cachedAt)
    && Number(nowMs) - cachedAt >= 0
    && Number(nowMs) - cachedAt < ageLimit;
};

const finiteNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};
const countOf = (value) => Math.max(0, finiteNumber(value) ?? 0);
const validCurrency = (value) => typeof value === 'string' && /^[A-Za-z]{3,8}$/.test(value.trim());
const cleanCurrency = (value) => validCurrency(value)
  ? value.trim().toUpperCase()
  : 'CNY';
const cleanModel = (value) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : 'unknown';

const normalizeTimezoneOffset = (value) => {
  if (value === undefined || value === null) return DEFAULT_TIMEZONE_OFFSET_SEC;
  if (!Number.isInteger(value) || value < -43_200 || value > 50_400 || value % 900 !== 0) {
    throw new ProviderUsageError('DeepSeek 用量时区参数无效', 'INVALID_ARGUMENT');
  }
  return value;
};

const parseDate = (value, field) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new ProviderUsageError(`${field} 必须是 YYYY-MM-DD`, 'INVALID_ARGUMENT');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ordinal = Date.UTC(year, month - 1, day);
  const date = new Date(ordinal);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ProviderUsageError(`${field} 不是有效日期`, 'INVALID_ARGUMENT');
  }
  return { value: `${match[1]}-${match[2]}-${match[3]}`, year, month, day, ordinal };
};

const dateStringOfOrdinal = (ordinal) => new Date(ordinal).toISOString().slice(0, 10);

const targetToday = (timezoneOffsetSec, nowMs = Date.now()) => {
  const date = new Date(nowMs + timezoneOffsetSec * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
};

const defaultRange = (timezoneOffsetSec, nowMs) => {
  const endDate = targetToday(timezoneOffsetSec, nowMs);
  return { startDate: `${endDate.slice(0, 8)}01`, endDate };
};

const buildMonthChunks = (start, end, timezoneOffsetSec) => {
  const chunks = [];
  let cursor = start.ordinal;
  while (cursor <= end.ordinal) {
    const current = new Date(cursor);
    const year = current.getUTCFullYear();
    const month = current.getUTCMonth() + 1;
    const nextMonth = Date.UTC(year, month, 1);
    const chunkEndOrdinal = Math.min(end.ordinal, nextMonth - DAY_MS);
    chunks.push({
      year,
      month,
      key: `${year}-${String(month).padStart(2, '0')}`,
      startDate: dateStringOfOrdinal(cursor),
      endDate: dateStringOfOrdinal(chunkEndOrdinal),
      startSec: Math.floor(cursor / 1000) - timezoneOffsetSec,
      endSec: Math.floor((chunkEndOrdinal + DAY_MS) / 1000) - timezoneOffsetSec,
    });
    cursor = chunkEndOrdinal + DAY_MS;
  }
  return chunks;
};

const businessCode = (payload) => {
  const codes = [payload?.code, payload?.data?.biz_code];
  return codes.find((code) => code !== undefined && code !== null && String(code) !== '0') ?? null;
};

const assertBusinessSuccess = (payload) => {
  const code = businessCode(payload);
  if (code === null) return;
  const numericCode = Number(code);
  if (AUTH_ERROR_CODES.has(numericCode)) {
    throw new ProviderUsageError('DeepSeek 平台登录已失效，请重新连接', 'AUTH_EXPIRED');
  }
  throw new ProviderUsageError('DeepSeek 平台返回业务错误', 'PLATFORM_ERROR');
};

const unwrapBizData = (payload) => {
  if (own(payload?.data, 'biz_data')) return payload.data.biz_data;
  if (own(payload, 'biz_data')) return payload.biz_data;
  if (own(payload, 'data')) return payload.data;
  return payload;
};

const abortError = () => new ProviderUsageError('DeepSeek 用量请求已取消', 'ABORTED');
const normalizeAbortSignal = (signal) => {
  if (signal === undefined || signal === null) return null;
  if (typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function') {
    throw new ProviderUsageError('DeepSeek 用量取消信号无效', 'INVALID_ARGUMENT');
  }
  return signal;
};
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError();
};

const requestJson = async (fetcher, token, path, timeoutMs, externalSignal = null) => {
  throwIfAborted(externalSignal);
  const controller = new AbortController();
  let timedOut = false;
  let rejectStop;
  const stopPromise = new Promise((_, reject) => {
    rejectStop = reject;
  });
  const handleExternalAbort = () => {
    controller.abort(externalSignal?.reason);
    rejectStop(abortError());
  };
  if (externalSignal) {
    externalSignal.addEventListener('abort', handleExternalAbort, { once: true });
    // Cover an abort racing the pre-check and listener registration.
    if (externalSignal.aborted) handleExternalAbort();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectStop(new ProviderUsageError('DeepSeek 平台请求超时', 'TIMEOUT'));
  }, timeoutMs);
  const awaitWithStop = (promise) => Promise.race([Promise.resolve(promise), stopPromise]);
  const throwIfRequestStopped = () => {
    throwIfAborted(externalSignal);
    if (timedOut) throw new ProviderUsageError('DeepSeek 平台请求超时', 'TIMEOUT');
  };
  try {
    throwIfRequestStopped();
    let response;
    try {
      response = await awaitWithStop(fetcher(`${DEEPSEEK_PLATFORM_ORIGIN}${path}`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'include',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          Origin: DEEPSEEK_PLATFORM_ORIGIN,
          Referer: `${DEEPSEEK_PLATFORM_ORIGIN}/usage`,
          'x-client-platform': 'web',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        signal: controller.signal,
      }));
      // Custom fetch implementations may ignore AbortSignal. Still stop as soon as
      // their pending operation settles rather than starting more usage requests.
      throwIfRequestStopped();
    } catch (error) {
      if (externalSignal?.aborted || error?.code === 'ABORTED') throw abortError();
      if (error?.code === 'TIMEOUT') throw error;
      throw new ProviderUsageError(
        timedOut ? 'DeepSeek 平台请求超时' : '无法连接 DeepSeek 平台',
        timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
      );
    }

    throwIfRequestStopped();
    const status = Number(response?.status);
    const ok = response?.ok === true || (response?.ok === undefined && status >= 200 && status < 300);
    if (!ok) {
      if (typeof response?.json === 'function') {
        try {
          const errorPayload = await awaitWithStop(response.json());
          throwIfRequestStopped();
          if (AUTH_ERROR_CODES.has(Number(businessCode(errorPayload)))) {
            throw new ProviderUsageError('DeepSeek 平台登录已失效，请重新连接', 'AUTH_EXPIRED', Number.isFinite(status) ? status : null);
          }
        } catch (error) {
          if (externalSignal?.aborted || error?.code === 'ABORTED') throw abortError();
          if (error instanceof ProviderUsageError && (error.code === 'AUTH_EXPIRED' || error.code === 'TIMEOUT')) throw error;
        }
      }
      if (status === 401) {
        throw new ProviderUsageError('DeepSeek 平台登录已失效，请重新连接', 'AUTH_EXPIRED', status);
      }
      throw new ProviderUsageError('DeepSeek 平台请求失败', 'HTTP_ERROR', Number.isFinite(status) ? status : null);
    }
    if (typeof response?.json !== 'function') {
      throw new ProviderUsageError('DeepSeek 平台响应格式无效', 'INVALID_RESPONSE');
    }
    let payload;
    try {
      payload = await awaitWithStop(response.json());
      throwIfRequestStopped();
    } catch (error) {
      if (externalSignal?.aborted || error?.code === 'ABORTED') throw abortError();
      if (error?.code === 'TIMEOUT') throw error;
      throw new ProviderUsageError(
        timedOut ? 'DeepSeek 平台请求超时' : 'DeepSeek 平台响应格式无效',
        timedOut ? 'TIMEOUT' : 'INVALID_RESPONSE',
      );
    }
    if (!payload || typeof payload !== 'object') {
      throw new ProviderUsageError('DeepSeek 平台响应格式无效', 'INVALID_RESPONSE');
    }
    assertBusinessSuccess(payload);
    return payload;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', handleExternalAbort);
  }
};

const invalidSummary = () => new ProviderUsageError('DeepSeek 账号摘要响应格式无效', 'INVALID_RESPONSE');

const normalizeMoneyList = (value) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidSummary();
  return value.map((entry) => {
    const amount = finiteNumber(entry?.amount);
    if (!objectOf(entry) || !validCurrency(entry.currency) || amount === null || amount < 0) throw invalidSummary();
    return { currency: cleanCurrency(entry.currency), amount };
  });
};

const normalizeSummary = (payload) => {
  let biz = unwrapBizData(payload);
  if (Array.isArray(biz)) biz = biz.find(objectOf) || null;
  if (!objectOf(biz)) throw new ProviderUsageError('DeepSeek 账号摘要响应格式无效', 'INVALID_RESPONSE');
  if (!SUMMARY_FIELDS.some((field) => own(biz, field))) throw invalidSummary();
  for (const field of SUMMARY_NUMBER_FIELDS) {
    if (own(biz, field) && biz[field] !== null && finiteNumber(biz[field]) === null) throw invalidSummary();
  }

  const balances = new Map();
  const addWallets = (wallets, field) => {
    if (wallets === undefined || wallets === null) return;
    if (!Array.isArray(wallets)) throw invalidSummary();
    for (const wallet of wallets) {
      const amount = finiteNumber(wallet?.balance);
      const tokenEstimate = wallet?.token_estimation === undefined || wallet?.token_estimation === null
        ? 0
        : finiteNumber(wallet.token_estimation);
      if (!objectOf(wallet) || !validCurrency(wallet.currency) || amount === null || amount < 0 || tokenEstimate === null || tokenEstimate < 0) {
        throw invalidSummary();
      }
      const currency = cleanCurrency(wallet?.currency);
      const current = balances.get(currency) || { currency, normal: 0, bonus: 0, total: 0, tokenEstimate: 0 };
      current[field] += amount;
      current.total += amount;
      current.tokenEstimate += tokenEstimate;
      balances.set(currency, current);
    }
  };
  addWallets(biz.normal_wallets, 'normal');
  addWallets(biz.bonus_wallets, 'bonus');

  const balanceList = [...balances.values()];
  const primary = balanceList.find((entry) => entry.currency === 'CNY') || balanceList[0] || null;
  return {
    currency: primary?.currency || 'CNY',
    balance: primary?.total ?? null,
    normalBalance: primary?.normal ?? null,
    bonusBalance: primary?.bonus ?? null,
    balances: balanceList,
    currentTokens: finiteNumber(biz.current_token),
    totalUsage: finiteNumber(biz.total_usage),
    monthlyUsage: finiteNumber(biz.monthly_usage),
    monthlyTokenUsage: finiteNumber(biz.monthly_token_usage),
    availableTokenEstimate: finiteNumber(biz.total_available_token_estimation),
    totalCosts: normalizeMoneyList(biz.total_costs),
    monthlyCosts: normalizeMoneyList(biz.monthly_costs),
  };
};

const nullableArray = (value) => value === null || Array.isArray(value);
const validNonNegativeNumber = (value) => {
  const number = finiteNumber(value);
  return number !== null && number >= 0;
};
const validTokenUsage = (usage) => {
  if (!objectOf(usage)) return false;
  const fields = [...TOKEN_USAGE_FIELDS].filter((field) => own(usage, field));
  return fields.length > 0 && fields.every((field) => validNonNegativeNumber(usage[field]));
};
const validEpoch = (value) => {
  const number = finiteNumber(value);
  if (number === null) return false;
  const milliseconds = Math.abs(number) >= 100_000_000_000 ? number : number * 1000;
  return !Number.isNaN(new Date(milliseconds).getTime());
};
const validNewAmountSeries = (series) => objectOf(series)
  && own(series, 'buckets')
  && nullableArray(series.buckets)
  && (series.buckets || []).every((bucket) => objectOf(bucket)
    && validEpoch(bucket.time)
    && validTokenUsage(bucket.usage));
const validNewCostSeries = (series) => objectOf(series)
  && own(series, 'buckets')
  && nullableArray(series.buckets)
  && (series.buckets || []).every((bucket) => objectOf(bucket)
    && validEpoch(bucket.time)
    && validNonNegativeNumber(bucket.cost));

const newAmountBiz = (payload) => {
  let biz = unwrapBizData(payload);
  if (Array.isArray(biz)) biz = biz.find(objectOf) || null;
  return objectOf(biz) && own(biz, 'series') && nullableArray(biz.series)
    && (biz.series || []).every(validNewAmountSeries)
    ? { ...biz, series: Array.isArray(biz.series) ? biz.series : [] }
    : null;
};

const newCostBiz = (payload) => {
  let biz = unwrapBizData(payload);
  if (Array.isArray(biz)) biz = biz.find(objectOf) || null;
  return objectOf(biz) && own(biz, 'data') && nullableArray(biz.data)
    && (biz.data || []).every((group) => objectOf(group)
      && validCurrency(group.currency)
      && own(group, 'series')
      && nullableArray(group.series)
      && (group.series || []).every(validNewCostSeries))
    ? { ...biz, data: Array.isArray(biz.data) ? biz.data : [] }
    : null;
};

const validLegacyModel = (model, allowedTypes) => {
  if (!objectOf(model) || !own(model, 'usage') || !nullableArray(model.usage)) return false;
  const usage = model.usage || [];
  if (usage.length === 0) return true;
  let recognized = false;
  for (const item of usage) {
    if (!objectOf(item) || typeof item.type !== 'string' || !validNonNegativeNumber(item.amount)) return false;
    if (allowedTypes.has(item.type)) recognized = true;
  }
  return recognized;
};
const validLegacyDay = (entry, allowedTypes) => objectOf(entry)
  && strictResponseDate(entry.date) !== null
  && own(entry, 'data')
  && nullableArray(entry.data)
  && (entry.data || []).every((model) => validLegacyModel(model, allowedTypes));

const legacyAmountBiz = (payload) => {
  let biz = unwrapBizData(payload);
  if (Array.isArray(biz)) biz = biz.find(objectOf) || null;
  return objectOf(biz) && own(biz, 'days') && nullableArray(biz.days)
    && (biz.days || []).every((entry) => validLegacyDay(entry, TOKEN_USAGE_FIELDS))
    ? { ...biz, days: Array.isArray(biz.days) ? biz.days : [] }
    : null;
};

const LEGACY_COST_TYPES = new Set(['PROMPT_TOKEN', 'PROMPT_CACHE_HIT_TOKEN', 'PROMPT_CACHE_MISS_TOKEN', 'RESPONSE_TOKEN']);
const legacyCostBiz = (payload) => {
  const biz = unwrapBizData(payload);
  if (Array.isArray(biz)) {
    if (biz.length === 0) return [];
    if (!biz.every((entry) => objectOf(entry)
      && validCurrency(entry.currency)
      && own(entry, 'days')
      && nullableArray(entry.days)
      && (entry.days || []).every((day) => validLegacyDay(day, LEGACY_COST_TYPES)))) return null;
    return biz.map((entry) => ({ ...entry, days: Array.isArray(entry.days) ? entry.days : [] }));
  }
  return objectOf(biz) && validCurrency(biz.currency) && own(biz, 'days') && nullableArray(biz.days)
    && (biz.days || []).every((day) => validLegacyDay(day, LEGACY_COST_TYPES))
    ? [{ ...biz, days: Array.isArray(biz.days) ? biz.days : [] }]
    : null;
};

const attemptMetric = async (fetcher, token, path, timeoutMs, parser, signal = null) => {
  try {
    const payload = await requestJson(fetcher, token, path, timeoutMs, signal);
    const biz = parser(payload);
    if (biz === null) throw new ProviderUsageError('DeepSeek 用量响应结构不兼容', 'SCHEMA_INCOMPATIBLE');
    return { ok: true, biz };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ProviderUsageError
        ? error
        : new ProviderUsageError('DeepSeek 用量请求失败', 'USAGE_UNAVAILABLE'),
    };
  }
};

const shouldFallbackToLegacy = (result) => !result.ok && (
  result.error?.code === 'SCHEMA_INCOMPATIBLE'
  || (result.error?.code === 'HTTP_ERROR' && (result.error.status === 404 || result.error.status === 410))
);

const normalizedEpochSec = (value) => {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.abs(number) >= 100_000_000_000 ? Math.floor(number / 1000) : Math.floor(number);
};

const dateOfEpoch = (value, timezoneOffsetSec) => {
  const seconds = normalizedEpochSec(value);
  if (seconds === null) return null;
  const date = new Date((seconds + timezoneOffsetSec) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const strictResponseDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  try {
    return parseDate(`${match[1]}-${match[2]}-${match[3]}`, 'date').value;
  } catch {
    return null;
  }
};

const tokenCounts = (usage) => {
  const promptTokens = countOf(usage?.PROMPT_TOKEN);
  const cacheHitTokens = countOf(usage?.PROMPT_CACHE_HIT_TOKEN);
  const cacheMissTokens = countOf(usage?.PROMPT_CACHE_MISS_TOKEN);
  const detailedInput = cacheHitTokens + cacheMissTokens;
  const inputTokens = detailedInput > 0 ? detailedInput : promptTokens;
  const outputTokens = countOf(usage?.RESPONSE_TOKEN);
  return {
    tokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    promptTokens,
    cacheHitTokens,
    cacheMissTokens,
    requests: countOf(usage?.REQUEST),
  };
};

const legacyUsageObject = (entry) => {
  const usage = {};
  for (const item of Array.isArray(entry?.usage) ? entry.usage : []) {
    const type = typeof item?.type === 'string' ? item.type : '';
    if (!type) continue;
    usage[type] = (usage[type] || 0) + countOf(item?.amount);
  }
  return usage;
};

const createDayAccumulator = (date) => ({
  date,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  promptTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  requests: 0,
  costs: new Map(),
  models: new Map(),
});

const createModelAccumulator = (model) => ({
  model,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  requests: 0,
  costs: new Map(),
});

const ensureDay = (days, date) => {
  if (!days.has(date)) days.set(date, createDayAccumulator(date));
  return days.get(date);
};

const ensureModel = (day, modelName) => {
  const model = cleanModel(modelName);
  if (!day.models.has(model)) day.models.set(model, createModelAccumulator(model));
  return day.models.get(model);
};

const addTokens = (day, modelName, counts) => {
  const model = ensureModel(day, modelName);
  for (const key of ['tokens', 'inputTokens', 'outputTokens', 'cacheHitTokens', 'cacheMissTokens', 'requests']) {
    day[key] += counts[key];
    model[key] += counts[key];
  }
  day.promptTokens += counts.promptTokens;
};

const addCost = (day, modelName, currencyValue, amountValue) => {
  const currency = cleanCurrency(currencyValue);
  const amount = countOf(amountValue);
  day.costs.set(currency, (day.costs.get(currency) || 0) + amount);
  const model = ensureModel(day, modelName);
  model.costs.set(currency, (model.costs.get(currency) || 0) + amount);
};

const inRange = (date, startDate, endDate) => date !== null && date >= startDate && date <= endDate;

const mergeNewAmount = (biz, days, chunk, timezoneOffsetSec) => {
  for (const series of biz.series) {
    if (!objectOf(series)) continue;
    for (const bucket of Array.isArray(series.buckets) ? series.buckets : []) {
      const date = dateOfEpoch(bucket?.time, timezoneOffsetSec);
      if (!inRange(date, chunk.startDate, chunk.endDate)) continue;
      addTokens(ensureDay(days, date), series.model, tokenCounts(bucket?.usage));
    }
  }
};

const mergeNewCost = (biz, days, chunk, timezoneOffsetSec) => {
  for (const group of biz.data) {
    if (!objectOf(group)) continue;
    for (const series of Array.isArray(group.series) ? group.series : []) {
      if (!objectOf(series)) continue;
      for (const bucket of Array.isArray(series.buckets) ? series.buckets : []) {
        const date = dateOfEpoch(bucket?.time, timezoneOffsetSec);
        if (!inRange(date, chunk.startDate, chunk.endDate)) continue;
        addCost(ensureDay(days, date), series.model, group.currency, bucket?.cost);
      }
    }
  }
};

const mergeLegacyAmount = (biz, days, chunk) => {
  for (const entry of biz.days) {
    const date = strictResponseDate(entry?.date);
    if (!inRange(date, chunk.startDate, chunk.endDate)) continue;
    for (const model of Array.isArray(entry?.data) ? entry.data : []) {
      addTokens(ensureDay(days, date), model?.model, tokenCounts(legacyUsageObject(model)));
    }
  }
};

const mergeLegacyCost = (groups, days, chunk) => {
  for (const group of groups) {
    for (const entry of Array.isArray(group?.days) ? group.days : []) {
      const date = strictResponseDate(entry?.date);
      if (!inRange(date, chunk.startDate, chunk.endDate)) continue;
      for (const model of Array.isArray(entry?.data) ? entry.data : []) {
        let amount = 0;
        for (const item of Array.isArray(model?.usage) ? model.usage : []) {
          if (LEGACY_COST_TYPES.has(item?.type)) amount += countOf(item?.amount);
        }
        addCost(ensureDay(days, date), model?.model, group.currency, amount);
      }
    }
  }
};

const currencyAmounts = (map) => [...map.entries()]
  .map(([currency, amount]) => ({ currency, amount }))
  .sort((left, right) => left.currency.localeCompare(right.currency));

const sumCurrencyAmounts = (daily, metricKey) => {
  const totals = new Map();
  for (const day of daily) {
    if (!day.coverage[metricKey]) continue;
    for (const entry of day.costs) totals.set(entry.currency, (totals.get(entry.currency) || 0) + entry.amount);
  }
  return currencyAmounts(totals);
};

const metricCoverage = (chunks, metric) => {
  const successful = chunks.filter((chunk) => chunk[metric].source !== null);
  const sources = [...new Set(successful.map((chunk) => chunk[metric].source))];
  return {
    complete: successful.length === chunks.length,
    coveredPeriods: successful.length,
    totalPeriods: chunks.length,
    sources,
    legacyFallback: sources.includes('legacy'),
  };
};

const sourceLabel = (coverage) => {
  const sources = new Set([...coverage.tokens.sources, ...coverage.cost.sources]);
  if (sources.size === 0) return 'unavailable';
  if (sources.size === 1) return [...sources][0];
  return 'mixed';
};

const throwIfAuthError = (...results) => {
  const fatal = results.find((result) => !result.ok
    && (result.error?.code === 'AUTH_EXPIRED' || result.error?.code === 'ABORTED'));
  if (fatal) throw fatal.error;
};

const fetchDeepSeekSummary = async (userToken, fetcher, options = {}) => {
  const token = normalizeDeepSeekUserToken(userToken);
  if (!token) throw new ProviderUsageError('缺少 DeepSeek 平台登录凭据', 'AUTH_MISSING');
  if (typeof fetcher !== 'function') throw new ProviderUsageError('缺少网络请求实现', 'INVALID_ARGUMENT');
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.min(120_000, Math.max(1_000, Math.round(Number(options.timeoutMs))))
    : DEFAULT_TIMEOUT_MS;
  const signal = normalizeAbortSignal(options.signal);
  throwIfAborted(signal);
  return normalizeSummary(await requestJson(fetcher, token, DEEPSEEK_ROUTES.summary, timeoutMs, signal));
};

/**
 * Fetch DeepSeek account usage without persisting the platform userToken.
 * startDate/endDate are inclusive YYYY-MM-DD dates in timezoneOffsetSec.
 * The result is shaped for a cost heatmap and includes token breakdowns when available.
 */
const fetchDeepSeekUsage = async (userToken, fetcher, options = {}) => {
  const token = normalizeDeepSeekUserToken(userToken);
  if (!token) throw new ProviderUsageError('缺少 DeepSeek 平台登录凭据', 'AUTH_MISSING');
  if (typeof fetcher !== 'function') throw new ProviderUsageError('缺少网络请求实现', 'INVALID_ARGUMENT');

  const timezoneOffsetSec = normalizeTimezoneOffset(options.timezoneOffsetSec);
  const fallbackRange = defaultRange(timezoneOffsetSec, options.nowMs);
  const start = parseDate(options.startDate || fallbackRange.startDate, 'startDate');
  const end = parseDate(options.endDate || fallbackRange.endDate, 'endDate');
  if (start.ordinal > end.ordinal) throw new ProviderUsageError('startDate 不能晚于 endDate', 'INVALID_ARGUMENT');
  if ((end.ordinal - start.ordinal) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    throw new ProviderUsageError('DeepSeek 用量查询范围不能超过 3660 天', 'INVALID_ARGUMENT');
  }
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.min(120_000, Math.max(1_000, Math.round(Number(options.timeoutMs))))
    : DEFAULT_TIMEOUT_MS;
  const signal = normalizeAbortSignal(options.signal);
  throwIfAborted(signal);

  const accountSummary = await fetchDeepSeekSummary(token, fetcher, { timeoutMs, signal });
  const chunks = buildMonthChunks(start, end, timezoneOffsetSec);
  const days = new Map();
  const chunkCoverage = [];
  const issues = [];

  for (const chunk of chunks) {
    throwIfAborted(signal);
    const query = `start=${chunk.startSec}&end=${chunk.endSec}&tz=${timezoneOffsetSec}`;
    let [amount, cost] = await Promise.all([
      attemptMetric(fetcher, token, `${DEEPSEEK_ROUTES.amount}?${query}`, timeoutMs, newAmountBiz, signal),
      attemptMetric(fetcher, token, `${DEEPSEEK_ROUTES.cost}?${query}`, timeoutMs, newCostBiz, signal),
    ]);
    throwIfAuthError(amount, cost);
    throwIfAborted(signal);

    let amountSource = amount.ok ? 'by_api_key' : null;
    let costSource = cost.ok ? 'by_api_key' : null;
    const legacyQuery = `month=${chunk.month}&year=${chunk.year}`;
    const fallbackAmount = shouldFallbackToLegacy(amount);
    const fallbackCost = shouldFallbackToLegacy(cost);
    const fallbackTasks = [];
    throwIfAborted(signal);
    if (fallbackAmount) fallbackTasks.push(attemptMetric(fetcher, token, `${DEEPSEEK_ROUTES.legacyAmount}?${legacyQuery}`, timeoutMs, legacyAmountBiz, signal));
    if (fallbackCost) fallbackTasks.push(attemptMetric(fetcher, token, `${DEEPSEEK_ROUTES.legacyCost}?${legacyQuery}`, timeoutMs, legacyCostBiz, signal));
    if (fallbackTasks.length) {
      const fallbacks = await Promise.all(fallbackTasks);
      let index = 0;
      throwIfAborted(signal);
      if (fallbackAmount) {
        const fallback = fallbacks[index++];
        throwIfAuthError(fallback);
        if (fallback.ok) {
          amount = fallback;
          amountSource = 'legacy';
        }
      }
      if (fallbackCost) {
        const fallback = fallbacks[index++];
        throwIfAuthError(fallback);
        if (fallback.ok) {
          cost = fallback;
          costSource = 'legacy';
        }
      }
    }

    if (amount.ok) {
      if (amountSource === 'by_api_key') mergeNewAmount(amount.biz, days, chunk, timezoneOffsetSec);
      else mergeLegacyAmount(amount.biz, days, chunk);
    } else {
      issues.push({ period: chunk.key, metric: 'tokens', code: amount.error?.code || 'USAGE_UNAVAILABLE' });
    }
    if (cost.ok) {
      if (costSource === 'by_api_key') mergeNewCost(cost.biz, days, chunk, timezoneOffsetSec);
      else mergeLegacyCost(cost.biz, days, chunk);
    } else {
      issues.push({ period: chunk.key, metric: 'cost', code: cost.error?.code || 'USAGE_UNAVAILABLE' });
    }
    chunkCoverage.push({
      startDate: chunk.startDate,
      endDate: chunk.endDate,
      tokens: { source: amountSource },
      cost: { source: costSource },
    });
  }

  throwIfAborted(signal);

  const tokensCoverage = metricCoverage(chunkCoverage, 'tokens');
  const costCoverage = metricCoverage(chunkCoverage, 'cost');
  if (tokensCoverage.coveredPeriods === 0 && costCoverage.coveredPeriods === 0) {
    throw new ProviderUsageError('DeepSeek 历史用量暂时不可用', 'USAGE_UNAVAILABLE');
  }

  const costCurrencies = new Set();
  for (const day of days.values()) for (const currency of day.costs.keys()) costCurrencies.add(currency);
  const primaryCurrency = costCurrencies.has(accountSummary.currency)
    ? accountSummary.currency
    : costCurrencies.has('CNY') ? 'CNY' : [...costCurrencies][0] || accountSummary.currency || 'CNY';

  const coverageByDate = new Map();
  for (const chunk of chunkCoverage) {
    for (let ordinal = parseDate(chunk.startDate, 'date').ordinal; ordinal <= parseDate(chunk.endDate, 'date').ordinal; ordinal += DAY_MS) {
      coverageByDate.set(dateStringOfOrdinal(ordinal), {
        tokens: chunk.tokens.source !== null,
        cost: chunk.cost.source !== null,
      });
    }
  }

  const daily = [];
  for (let ordinal = start.ordinal; ordinal <= end.ordinal; ordinal += DAY_MS) {
    const date = dateStringOfOrdinal(ordinal);
    const accumulated = days.get(date) || createDayAccumulator(date);
    const dayCoverage = coverageByDate.get(date) || { tokens: false, cost: false };
    const costs = currencyAmounts(accumulated.costs);
    const models = [...accumulated.models.values()].map((model) => {
      const modelCosts = currencyAmounts(model.costs);
      return {
        model: model.model,
        cost: dayCoverage.cost ? (model.costs.get(primaryCurrency) || 0) : null,
        currency: primaryCurrency,
        costs: modelCosts,
        tokens: dayCoverage.tokens ? model.tokens : null,
        inputTokens: dayCoverage.tokens ? model.inputTokens : null,
        outputTokens: dayCoverage.tokens ? model.outputTokens : null,
        cacheHitTokens: dayCoverage.tokens ? model.cacheHitTokens : null,
        cacheMissTokens: dayCoverage.tokens ? model.cacheMissTokens : null,
        requests: dayCoverage.tokens ? model.requests : null,
      };
    }).filter((model) => model.tokens !== 0 || model.cost !== 0).sort((left, right) => (right.cost || 0) - (left.cost || 0));
    daily.push({
      date,
      cost: dayCoverage.cost ? (accumulated.costs.get(primaryCurrency) || 0) : null,
      currency: primaryCurrency,
      costs,
      tokens: dayCoverage.tokens ? accumulated.tokens : null,
      inputTokens: dayCoverage.tokens ? accumulated.inputTokens : null,
      outputTokens: dayCoverage.tokens ? accumulated.outputTokens : null,
      promptTokens: dayCoverage.tokens ? accumulated.promptTokens : null,
      cacheHitTokens: dayCoverage.tokens ? accumulated.cacheHitTokens : null,
      cacheMissTokens: dayCoverage.tokens ? accumulated.cacheMissTokens : null,
      requests: dayCoverage.tokens ? accumulated.requests : null,
      models,
      coverage: dayCoverage,
    });
  }

  const knownTokens = daily.reduce((sum, day) => sum + (day.tokens || 0), 0);
  const knownCost = daily.reduce((sum, day) => sum + (day.cost || 0), 0);
  const knownCosts = sumCurrencyAmounts(daily, 'cost');
  const accountTotalCost = accountSummary.totalCosts.find((entry) => entry.currency === primaryCurrency)?.amount ?? null;
  const activeDays = daily.filter((day) => (day.cost || 0) > 0 || (day.tokens || 0) > 0).length;
  const peakDailyCost = costCoverage.coveredPeriods > 0
    ? daily.reduce((peak, day) => day.cost === null ? peak : Math.max(peak, day.cost), 0)
    : null;
  const coverage = {
    start: start.value,
    end: end.value,
    timeZone: timezoneOffsetSec,
    timezoneOffsetSec,
    source: sourceLabel({ tokens: tokensCoverage, cost: costCoverage }),
    partial: !tokensCoverage.complete || !costCoverage.complete,
    tokens: tokensCoverage,
    cost: costCoverage,
    issues,
  };

  return {
    provider: 'deepseek',
    metric: 'cost',
    currency: primaryCurrency,
    summary: {
      balance: accountSummary.currency === primaryCurrency ? accountSummary.balance : null,
      grantedBalance: accountSummary.currency === primaryCurrency ? accountSummary.bonusBalance : null,
      toppedUpBalance: accountSummary.currency === primaryCurrency ? accountSummary.normalBalance : null,
      totalCost: accountTotalCost,
      rangeCost: costCoverage.complete ? knownCost : null,
      peakDailyCost,
      activeDays,
      rangeTokens: tokensCoverage.complete ? knownTokens : null,
      knownRangeCost: knownCost,
      knownRangeTokens: knownTokens,
      inputTokens: tokensCoverage.complete ? daily.reduce((sum, day) => sum + (day.inputTokens || 0), 0) : null,
      outputTokens: tokensCoverage.complete ? daily.reduce((sum, day) => sum + (day.outputTokens || 0), 0) : null,
      requests: tokensCoverage.complete ? daily.reduce((sum, day) => sum + (day.requests || 0), 0) : null,
      balances: accountSummary.balances,
      totalCosts: accountSummary.totalCosts,
      monthlyCosts: accountSummary.monthlyCosts,
      availableTokenEstimate: accountSummary.availableTokenEstimate,
    },
    coverage,
    days: daily,
    fetchedAt: new Date().toISOString(),
  };
};

// ── 通用 JSON 请求（供 DeepSeek 之外的厂商复用）──────────────────────────────
// 与 requestJson 同一套超时/取消语义，但主机、请求头与业务错误判定由调用方给出。
const requestProviderJson = async ({
  label, fetcher, url, headers = {}, credentials = undefined, timeoutMs, signal = null,
  authMessage, isBusinessAuthError = null, businessError = null,
}) => {
  throwIfAborted(signal);
  const providerAbortError = () => new ProviderUsageError(`${label}请求已取消`, 'ABORTED');
  const controller = new AbortController();
  let timedOut = false;
  let rejectStop;
  const stopPromise = new Promise((_, reject) => { rejectStop = reject; });
  const handleExternalAbort = () => { controller.abort(signal?.reason); rejectStop(providerAbortError()); };
  if (signal) {
    signal.addEventListener('abort', handleExternalAbort, { once: true });
    if (signal.aborted) handleExternalAbort();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectStop(new ProviderUsageError(`${label}请求超时`, 'TIMEOUT'));
  }, timeoutMs);
  const awaitWithStop = (promise) => Promise.race([Promise.resolve(promise), stopPromise]);
  const throwIfStopped = () => {
    if (signal?.aborted) throw providerAbortError();
    if (timedOut) throw new ProviderUsageError(`${label}请求超时`, 'TIMEOUT');
  };
  try {
    let response;
    try {
      response = await awaitWithStop(fetcher(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error',
        ...(credentials ? { credentials } : {}),
        headers: { Accept: 'application/json', ...headers },
        signal: controller.signal,
      }));
      throwIfStopped();
    } catch (error) {
      if (signal?.aborted || error?.code === 'ABORTED') throw providerAbortError();
      if (error instanceof ProviderUsageError && error.code === 'TIMEOUT') throw error;
      throw new ProviderUsageError(
        timedOut ? `${label}请求超时` : `无法连接${label}`,
        timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
      );
    }
    throwIfStopped();
    const status = Number(response?.status);
    let payload = null;
    if (typeof response?.json === 'function') {
      try {
        payload = await awaitWithStop(response.json());
        throwIfStopped();
      } catch (error) {
        if (signal?.aborted || error?.code === 'ABORTED') throw providerAbortError();
        if (error instanceof ProviderUsageError) throw error;
        payload = null;
      }
    }
    if (status === 401 || status === 403 || (payload && isBusinessAuthError?.(payload))) {
      throw new ProviderUsageError(authMessage || `${label}登录已失效，请重新连接`, 'AUTH_EXPIRED', Number.isFinite(status) ? status : null);
    }
    const ok = response?.ok === true || (response?.ok === undefined && status >= 200 && status < 300);
    if (!ok) throw new ProviderUsageError(`${label}请求失败`, 'HTTP_ERROR', Number.isFinite(status) ? status : null);
    if (payload === null || typeof payload !== 'object') {
      throw new ProviderUsageError(`${label}响应不是有效 JSON`, 'SCHEMA_INCOMPATIBLE');
    }
    if (businessError) {
      const message = businessError(payload);
      if (message) throw new ProviderUsageError(message, 'PLATFORM_ERROR', Number.isFinite(status) ? status : null);
    }
    return payload;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', handleExternalAbort);
  }
};

// 厂商通用的时区参数校验（各厂商默认时区不同，由调用方传入回退值）
const normalizeUsageTimezoneOffset = (value, fallback, label = '厂商用量') => {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < -43_200 || value > 50_400 || value % 900 !== 0) {
    throw new ProviderUsageError(`${label}时区参数无效`, 'INVALID_ARGUMENT');
  }
  return value;
};

const usageTimeoutMs = (value) => Number.isFinite(Number(value))
  ? Math.min(120_000, Math.max(1_000, Math.round(Number(value))))
  : DEFAULT_TIMEOUT_MS;

// ── Z.ai（智谱开放平台）逐日模型用量 ────────────────────────────────────────
// Z.ai 用量统计直接复用账号已保存的 API Key（与额度巡检同一份凭据），不需要
// 网页登录。数据来自 model-usage 接口：按月分块拉取每日各模型的 Token 消耗；
// x_time 标签格式不稳定（YYYY-MM-DD / MM-DD / 时间戳都有可能出现），解析失败
// 时按块内序号对齐日期，保证热力图不错位。接口语义参考 CodexBar 的 zai 插件。
const ZAI_DEFAULT_ORIGIN = 'https://open.bigmodel.cn';
const ZAI_MODEL_USAGE_PATH = '/api/monitor/usage/model-usage';
const ZAI_QUOTA_LIMIT_PATH = '/api/monitor/usage/quota/limit';
const ZAI_CREDIT_ACTIVITY_PATH = '/api/monitor/credit-usage/activity';
// model-usage 接口只保留近两个月明细，更早的月份只会返回全零序列；
// 逐模型拆分只查近 60 天，更早的每日总量改由 credit-usage/activity 提供。
const ZAI_MODEL_USAGE_RETENTION_DAYS = 60;
const ZAI_TIMEZONE_OFFSET_SEC = 8 * 60 * 60;
const ZAI_LABEL = 'Z.ai 平台';
const ZAI_AUTH_EXPIRED_MESSAGE = 'Z.ai API Key 无效或已过期，请在账号设置更新凭据后重新连接';

const normalizeZaiApiKey = (raw) => {
  const text = String(raw || '').trim().replace(/^Bearer\s+/i, '').trim();
  if (!text || text.length > 4096 || /\s/.test(text)) return '';
  return text;
};

// 用量接口只发往 open.bigmodel.cn / api.z.ai 系主机；自定义中转端点一律回落
// 默认域名，避免把 API Key 泄露给第三方主机。
const normalizeZaiOrigin = (raw) => {
  try {
    const url = new URL(String(raw || '').trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && !url.username && !url.password && (/(^|\.)bigmodel\.cn$/.test(host) || /(^|\.)z\.ai$/.test(host))) return url.origin;
  } catch {}
  return ZAI_DEFAULT_ORIGIN;
};

const zaiGetJson = (fetcher, origin, path, query, apiKey, timeoutMs, signal) => requestProviderJson({
  label: ZAI_LABEL,
  fetcher,
  url: `${origin}${path}${query ? `?${query}` : ''}`,
  // 与额度巡检的内置脚本一致：智谱网关在 Authorization 头里直接收 API Key（不加 Bearer）
  headers: { Authorization: apiKey, 'Accept-Language': 'zh-CN,zh' },
  timeoutMs,
  signal,
  authMessage: ZAI_AUTH_EXPIRED_MESSAGE,
  isBusinessAuthError: (payload) => Number(payload?.code) === 1001
    || /authorization|身份验证|鉴权|登录|凭证|凭据/i.test(String(payload?.msg || '')),
  businessError: (payload) => (payload?.success === false || (payload?.code !== undefined && Number(payload?.code) !== 200)
    ? `Z.ai 平台返回错误：${String(payload?.msg || '未知错误').slice(0, 120)}`
    : null),
});

// 无用量时 data 可能为空对象或缺省，按空序列处理；结构不符才视为不兼容
const zaiModelUsageData = (payload) => {
  const data = objectOf(payload?.data);
  if (!data || (!own(data, 'x_time') && !own(data, 'modelDataList'))) return { x_time: [], modelDataList: [] };
  const labels = Array.isArray(data.x_time) ? data.x_time : null;
  if (!labels) return null;
  const models = Array.isArray(data.modelDataList) ? data.modelDataList : [];
  if (!models.every((model) => objectOf(model) && (model.tokensUsage === undefined || Array.isArray(model.tokensUsage)))) return null;
  return { x_time: labels, modelDataList: models };
};

const zaiChunkDays = (chunk) => Math.round((parseDate(chunk.endDate, 'date').ordinal - parseDate(chunk.startDate, 'date').ordinal) / DAY_MS) + 1;

const zaiLabelDate = (label, chunk, index, timezoneOffsetSec) => {
  const text = String(label ?? '').trim();
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (full) return strictResponseDate(`${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`);
  if (/^\d{9,13}$/.test(text)) {
    const date = dateOfEpoch(text, timezoneOffsetSec);
    if (date) return date;
  }
  const monthDay = /^(\d{1,2})-(\d{1,2})(?!\d)/.exec(text);
  if (monthDay) {
    const years = [...new Set([Number(chunk.endDate.slice(0, 4)), Number(chunk.startDate.slice(0, 4))])];
    for (const year of years) {
      const date = `${year}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
      if (date >= chunk.startDate && date <= chunk.endDate) return date;
    }
  }
  // 标签无法解析时按块内序号对齐（按日分桶时第 i 桶即块起始后第 i 天）；
  // 单天块（如范围尾日落在 1 号）即使返回小时桶也全部归入这一天
  if (zaiChunkDays(chunk) === 1) return chunk.startDate;
  const date = dateStringOfOrdinal(parseDate(chunk.startDate, 'date').ordinal + index * DAY_MS);
  return date <= chunk.endDate ? date : null;
};

const mergeZaiModelUsage = (data, days, chunk, timezoneOffsetSec) => {
  const labels = data.x_time;
  const models = data.modelDataList;
  for (let index = 0; index < labels.length; index += 1) {
    const date = zaiLabelDate(labels[index], chunk, index, timezoneOffsetSec);
    if (!inRange(date, chunk.startDate, chunk.endDate)) continue;
    for (const model of models) {
      const value = countOf(Array.isArray(model.tokensUsage) ? model.tokensUsage[index] : 0);
      if (value <= 0) continue;
      addTokens(ensureDay(days, date), model.modelName, {
        tokens: value,
        inputTokens: 0,
        outputTokens: 0,
        promptTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        requests: 0,
      });
    }
  }
};

const zaiChunkQuery = (chunk) => `startTime=${encodeURIComponent(`${chunk.startDate} 00:00:00`)}&endTime=${encodeURIComponent(`${chunk.endDate} 23:59:59`)}`;

const attemptZaiModelUsage = async (fetcher, origin, apiKey, chunk, timeoutMs, signal) => {
  try {
    const payload = await zaiGetJson(fetcher, origin, ZAI_MODEL_USAGE_PATH, zaiChunkQuery(chunk), apiKey, timeoutMs, signal);
    const data = zaiModelUsageData(payload);
    if (data === null) throw new ProviderUsageError('Z.ai 用量响应结构不兼容', 'SCHEMA_INCOMPATIBLE');
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ProviderUsageError ? error : new ProviderUsageError('Z.ai 用量请求失败', 'USAGE_UNAVAILABLE'),
    };
  }
};

// 套餐名只是摘要卡片的可选增强，结构宽容、失败不阻塞逐日用量
// 套餐额度信息：解析 quota/limit 接口的 limits 数组，返回可展示的额度卡片数据
const zaiQuotaCards = (limits) => {
  if (!Array.isArray(limits)) return [];
  return limits.map((item) => {
    const type = String(item?.type || '').toUpperCase();
    const unit = Number(item?.unit);
    // unit: 3 = 5小时窗口, 5 = 每月, 6 = 每周（根据实际数据推断）
    const windowLabel = unit === 3 ? '5 小时' : unit === 5 ? '每月' : unit === 6 ? '每周' : '周期';
    const isToken = type === 'TOKENS_LIMIT';
    const isTime = type === 'TIME_LIMIT';
    const total = Number(item?.number) || 0;
    const used = Number(item?.usage) || 0;
    const remaining = Number(item?.remaining) || (total > 0 ? total - used : 0);
    const percentage = Number(item?.percentage) || 0;
    const nextResetTime = Number(item?.nextResetTime) || null;
    const usageDetails = Array.isArray(item?.usageDetails) ? item.usageDetails : [];
    return {
      type: isToken ? 'tokens' : isTime ? 'calls' : 'other',
      windowLabel,
      total,
      used,
      remaining,
      percentage,
      nextResetTime,
      usageDetails: usageDetails.map((d) => ({ model: d?.modelCode || '', usage: Number(d?.usage) || 0 })),
    };
  });
};

const fetchZaiPlanSummary = async (apiKeyRaw, fetcher, options = {}) => {
  const apiKey = normalizeZaiApiKey(apiKeyRaw);
  if (!apiKey) throw new ProviderUsageError('缺少 Z.ai API Key', 'AUTH_MISSING');
  if (typeof fetcher !== 'function') throw new ProviderUsageError('缺少网络请求实现', 'INVALID_ARGUMENT');
  const timeoutMs = usageTimeoutMs(options.timeoutMs);
  const signal = normalizeAbortSignal(options.signal);
  throwIfAborted(signal);
  const origin = normalizeZaiOrigin(options.origin);
  const payload = await zaiGetJson(fetcher, origin, ZAI_QUOTA_LIMIT_PATH, '', apiKey, timeoutMs, signal);
  const data = objectOf(payload?.data) || {};
  const planName = ['planName', 'plan', 'plan_type', 'packageName', 'level']
    .map((key) => data[key])
    .find((value) => typeof value === 'string' && value.trim())?.trim().slice(0, 60) || null;
  const quotaCards = zaiQuotaCards(data.limits);
  return { planName, quotaCards, limits: Array.isArray(data.limits) ? data.limits.length : 0 };
};

// 账号累计活跃统计（credit-usage/activity）：与 ZCode「个人套餐」统计页同一份
// 云端数据。一次请求覆盖近一年每日 Token 总量，摘要直接给出累计 Token、峰值日、
// 累计使用时长与连续天数；按个人套餐固定 type=1。
const zaiActivityQuery = (startDate, endDate) => `type=1&startTime=${encodeURIComponent(`${startDate} 00:00:00`)}&endTime=${encodeURIComponent(`${endDate} 23:59:59`)}`;

const zaiCountOrNull = (value) => {
  const number = finiteNumber(value);
  return number === null || number < 0 ? null : Math.floor(number);
};

// 响应结构宽容：summary 字段逐个校验，series 只保留日期合法的条目
const zaiActivityData = (payload) => {
  const data = objectOf(payload?.data);
  if (!data) return { summary: null, series: [] };
  const rawSummary = objectOf(data.summary);
  const summary = rawSummary ? {
    totalTokens: zaiCountOrNull(rawSummary.totalTokens),
    peakDailyTokens: zaiCountOrNull(rawSummary.peakDailyTokens),
    peakDailyTokensDate: strictResponseDate(rawSummary.peakDailyTokensDate),
    totalUsageDurationMs: zaiCountOrNull(rawSummary.totalUsageDurationMs),
    currentStreakDays: zaiCountOrNull(rawSummary.currentStreakDays),
    longestStreakDays: zaiCountOrNull(rawSummary.longestStreakDays),
  } : null;
  const series = (Array.isArray(data.series) ? data.series : [])
    .map((entry) => {
      const item = objectOf(entry);
      const date = strictResponseDate(item?.date);
      if (!date) return null;
      return {
        date,
        tokens: countOf(item.totalTokens),
        modelCallCount: countOf(item.modelCallCount),
        mcpCalls: countOf(item.mcpCalls),
      };
    })
    .filter(Boolean);
  return { summary, series };
};

const fetchZaiActivity = async (apiKey, fetcher, options = {}) => {
  const { origin, timeoutMs, signal, startDate, endDate } = options;
  const payload = await zaiGetJson(fetcher, origin, ZAI_CREDIT_ACTIVITY_PATH, zaiActivityQuery(startDate, endDate), apiKey, timeoutMs, signal);
  return zaiActivityData(payload);
};

/**
 * Fetch Z.ai (bigmodel.cn) daily model token usage with the account API key.
 * startDate/endDate are inclusive YYYY-MM-DD dates in timezoneOffsetSec (UTC+8).
 * The result mirrors the DeepSeek shape but only carries the tokens metric.
 */
const fetchZaiUsage = async (apiKeyRaw, fetcher, options = {}) => {
  const apiKey = normalizeZaiApiKey(apiKeyRaw);
  if (!apiKey) throw new ProviderUsageError('缺少 Z.ai API Key', 'AUTH_MISSING');
  if (typeof fetcher !== 'function') throw new ProviderUsageError('缺少网络请求实现', 'INVALID_ARGUMENT');

  const timezoneOffsetSec = normalizeUsageTimezoneOffset(options.timezoneOffsetSec, ZAI_TIMEZONE_OFFSET_SEC, 'Z.ai 用量');
  const fallbackRange = defaultRange(timezoneOffsetSec, options.nowMs);
  const start = parseDate(options.startDate || fallbackRange.startDate, 'startDate');
  const end = parseDate(options.endDate || fallbackRange.endDate, 'endDate');
  if (start.ordinal > end.ordinal) throw new ProviderUsageError('startDate 不能晚于 endDate', 'INVALID_ARGUMENT');
  if ((end.ordinal - start.ordinal) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    throw new ProviderUsageError('Z.ai 用量查询范围不能超过 3660 天', 'INVALID_ARGUMENT');
  }
  const timeoutMs = usageTimeoutMs(options.timeoutMs);
  const signal = normalizeAbortSignal(options.signal);
  throwIfAborted(signal);
  const origin = normalizeZaiOrigin(options.origin);

  // model-usage 只保留近两个月，逐模型拆分只查保留期内的块；
  // 更早的日期由 credit-usage/activity 的全年逐日总量覆盖
  const modelCutoff = dateStringOfOrdinal(end.ordinal - ZAI_MODEL_USAGE_RETENTION_DAYS * DAY_MS);
  const chunks = buildMonthChunks(start, end, timezoneOffsetSec).filter((chunk) => chunk.endDate >= modelCutoff);
  const days = new Map();
  const chunkCoverage = [];
  const issues = [];
  for (const chunk of chunks) {
    throwIfAborted(signal);
    const result = await attemptZaiModelUsage(fetcher, origin, apiKey, chunk, timeoutMs, signal);
    if (!result.ok && (result.error?.code === 'AUTH_EXPIRED' || result.error?.code === 'ABORTED')) throw result.error;
    chunkCoverage.push({ startDate: chunk.startDate, endDate: chunk.endDate, ok: result.ok });
    if (!result.ok) {
      issues.push({ period: `${chunk.startDate}~${chunk.endDate}`, code: result.error?.code || 'USAGE_UNAVAILABLE' });
      continue;
    }
    mergeZaiModelUsage(result.data, days, chunk, timezoneOffsetSec);
  }

  // 累计活跃统计（近一年）：失败不阻塞逐日用量，鉴权类错误照常抛出
  let activity = null;
  try {
    activity = await fetchZaiActivity(apiKey, fetcher, {
      origin,
      timeoutMs,
      signal,
      startDate: dateStringOfOrdinal(end.ordinal - 365 * DAY_MS),
      endDate: end.value,
    });
  } catch (error) {
    if (error?.code === 'ABORTED' || error?.code === 'AUTH_EXPIRED') throw error;
  }
  const activityByDate = new Map();
  if (activity) for (const entry of activity.series) activityByDate.set(entry.date, entry.tokens);

  let planName = null;
  try {
    planName = (await fetchZaiPlanSummary(apiKey, fetcher, { origin, timeoutMs, signal })).planName;
  } catch (error) {
    if (error?.code === 'ABORTED' || error?.code === 'AUTH_EXPIRED') throw error;
  }

  const coveredPeriods = chunkCoverage.filter((chunk) => chunk.ok).length;
  const tokensSources = [
    ...(activityByDate.size ? ['credit-usage/activity'] : []),
    ...(coveredPeriods ? ['model-usage'] : []),
  ];
  const tokensCoverage = {
    complete: false, // 逐日循环后按实际覆盖回填
    coveredPeriods,
    totalPeriods: chunkCoverage.length,
    sources: tokensSources,
    legacyFallback: false,
  };
  const costCoverage = { complete: false, coveredPeriods: 0, totalPeriods: 0, sources: [], legacyFallback: false };
  const coverageByDate = new Map();
  for (const chunk of chunkCoverage) {
    for (let ordinal = parseDate(chunk.startDate, 'date').ordinal; ordinal <= parseDate(chunk.endDate, 'date').ordinal; ordinal += DAY_MS) {
      coverageByDate.set(dateStringOfOrdinal(ordinal), chunk.ok);
    }
  }

  const daily = [];
  for (let ordinal = start.ordinal; ordinal <= end.ordinal; ordinal += DAY_MS) {
    const date = dateStringOfOrdinal(ordinal);
    const accumulated = days.get(date) || createDayAccumulator(date);
    // activity 是账号级全年逐日总量（与 ZCode 统计页同口径），优先于逐模型加总
    const hasActivity = activityByDate.has(date);
    const covered = hasActivity || coverageByDate.get(date) === true;
    daily.push({
      date,
      cost: null,
      currency: null,
      costs: [],
      tokens: covered ? (hasActivity ? activityByDate.get(date) : accumulated.tokens) : null,
      inputTokens: null,
      outputTokens: null,
      promptTokens: null,
      cacheHitTokens: null,
      cacheMissTokens: null,
      requests: null,
      models: [...accumulated.models.values()].map((model) => ({
        model: model.model,
        cost: null,
        currency: null,
        costs: [],
        tokens: covered ? model.tokens : null,
        inputTokens: null,
        outputTokens: null,
        cacheHitTokens: null,
        cacheMissTokens: null,
        requests: null,
      })).filter((model) => (model.tokens || 0) > 0).sort((left, right) => (right.tokens || 0) - (left.tokens || 0)),
      coverage: { tokens: covered, cost: false },
    });
  }

  tokensCoverage.complete = daily.every((day) => day.coverage.tokens);
  const knownTokens = daily.reduce((sum, day) => sum + (day.tokens || 0), 0);
  const activeDays = daily.filter((day) => (day.tokens || 0) > 0).length;
  const activitySummary = activity?.summary || null;
  const peakDailyTokens = activitySummary?.peakDailyTokens ?? (coveredPeriods > 0 || activityByDate.size > 0
    ? daily.reduce((peak, day) => day.tokens === null ? peak : Math.max(peak, day.tokens), 0)
    : null);

  return {
    provider: 'zai',
    metric: 'tokens',
    currency: null,
    summary: {
      balance: null,
      grantedBalance: null,
      toppedUpBalance: null,
      totalCost: null,
      rangeCost: null,
      peakDailyCost: null,
      rangeTokens: tokensCoverage.complete ? knownTokens : null,
      knownRangeTokens: knownTokens,
      // 账号累计口径（credit-usage/activity 摘要，与 ZCode 统计页一致）；
      // 拿不到时渲染层自动退回区间口径
      totalTokens: activitySummary?.totalTokens ?? null,
      peakDailyTokens,
      peakDailyTokensDate: activitySummary?.peakDailyTokensDate ?? null,
      currentStreakDays: activitySummary?.currentStreakDays ?? null,
      longestStreakDays: activitySummary?.longestStreakDays ?? null,
      totalUsageDurationMs: activitySummary?.totalUsageDurationMs ?? null,
      activeDays,
      inputTokens: null,
      outputTokens: null,
      requests: null,
      planName,
    },
    coverage: {
      start: start.value,
      end: end.value,
      timeZone: timezoneOffsetSec,
      timezoneOffsetSec,
      source: tokensSources.length ? tokensSources.join(' + ') : 'unavailable',
      partial: !tokensCoverage.complete,
      tokens: tokensCoverage,
      cost: costCoverage,
      issues,
    },
    days: daily,
    fetchedAt: new Date().toISOString(),
  };
};
// ── Codex（ChatGPT 订阅）逐日 Token 用量 ─────────────────────────────────
// 复用本机 Codex CLI 的 ChatGPT OAuth 登录（与额度巡检同一份凭据，支持自动续期），
// 查询 chatgpt.com 的 token-activity 摘要：每日 Token 桶 + 累计/峰值/连续天数。
// 接口字段对齐 codex-rs 的 TokenUsageProfile（backend-client/src/types.rs）。
const CODEX_USAGE_PROFILE_URL = 'https://chatgpt.com/backend-api/wham/profiles/me';
const CODEX_TIMEZONE_OFFSET_SEC = 0;
const CODEX_LABEL = 'Codex 平台';

const buildCodexUsageRequest = (auth) => {
  const headers = {
    Authorization: `Bearer ${auth?.tokens?.access_token}`,
    'User-Agent': 'codex-cli',
    Accept: 'application/json',
  };
  if (auth?.tokens?.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
  return { url: CODEX_USAGE_PROFILE_URL, init: { headers } };
};

const codexStatsOf = (payload) => {
  const stats = objectOf(payload?.stats);
  if (!stats) return null;
  const buckets = stats.daily_usage_buckets;
  if (buckets !== null && buckets !== undefined) {
    if (!Array.isArray(buckets)) return null;
    for (const bucket of buckets) {
      if (!objectOf(bucket) || strictResponseDate(bucket.start_date) === null || finiteNumber(bucket.tokens) === null) return null;
    }
  }
  return stats;
};

const optionalCount = (value) => {
  const number = finiteNumber(value);
  return number === null || number < 0 ? null : Math.floor(number);
};

/**
 * Normalize a ChatGPT token-activity profile into the shared usage shape.
 * Codex has no cost/request metrics — tokens only. Bucket dates are server-local
 * calendar days; days without a bucket count as covered with zero usage.
 */
const normalizeCodexTokenUsage = (payload, options = {}) => {
  const timezoneOffsetSec = normalizeUsageTimezoneOffset(options.timezoneOffsetSec, CODEX_TIMEZONE_OFFSET_SEC, 'Codex 用量');
  const fallbackRange = defaultRange(timezoneOffsetSec, options.nowMs);
  const start = parseDate(options.startDate || fallbackRange.startDate, 'startDate');
  const end = parseDate(options.endDate || fallbackRange.endDate, 'endDate');
  if (start.ordinal > end.ordinal) throw new ProviderUsageError('startDate 不能晚于 endDate', 'INVALID_ARGUMENT');
  if ((end.ordinal - start.ordinal) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    throw new ProviderUsageError('Codex 用量查询范围不能超过 3660 天', 'INVALID_ARGUMENT');
  }
  const stats = codexStatsOf(payload);
  if (!stats) throw new ProviderUsageError('Codex 用量响应结构不兼容', 'SCHEMA_INCOMPATIBLE');

  const hasBuckets = Array.isArray(stats.daily_usage_buckets);
  const bucketByDate = new Map();
  if (hasBuckets) {
    for (const bucket of stats.daily_usage_buckets) {
      const date = strictResponseDate(bucket.start_date);
      const tokens = countOf(bucket.tokens);
      if (!date) continue;
      bucketByDate.set(date, (bucketByDate.get(date) || 0) + tokens);
    }
  }

  const daily = [];
  for (let ordinal = start.ordinal; ordinal <= end.ordinal; ordinal += DAY_MS) {
    const date = dateStringOfOrdinal(ordinal);
    daily.push({
      date,
      cost: null,
      currency: null,
      costs: [],
      tokens: hasBuckets ? (bucketByDate.get(date) || 0) : null,
      inputTokens: null,
      outputTokens: null,
      promptTokens: null,
      cacheHitTokens: null,
      cacheMissTokens: null,
      requests: null,
      models: [],
      coverage: { tokens: hasBuckets, cost: false },
    });
  }

  const knownTokens = daily.reduce((sum, day) => sum + (day.tokens || 0), 0);
  const activeDays = daily.filter((day) => (day.tokens || 0) > 0).length;
  const tokensCoverage = {
    complete: hasBuckets,
    coveredPeriods: hasBuckets ? 1 : 0,
    totalPeriods: 1,
    sources: hasBuckets ? ['token-activity'] : [],
    legacyFallback: false,
  };
  const costCoverage = { complete: false, coveredPeriods: 0, totalPeriods: 0, sources: [], legacyFallback: false };

  return {
    provider: 'codex',
    metric: 'tokens',
    currency: null,
    summary: {
      balance: null,
      grantedBalance: null,
      toppedUpBalance: null,
      totalCost: null,
      rangeCost: null,
      peakDailyCost: null,
      totalTokens: optionalCount(stats.lifetime_tokens),
      rangeTokens: hasBuckets ? knownTokens : null,
      knownRangeTokens: knownTokens,
      peakDailyTokens: optionalCount(stats.peak_daily_tokens),
      currentStreakDays: optionalCount(stats.current_streak_days),
      longestStreakDays: optionalCount(stats.longest_streak_days),
      longestRunningTurnSec: optionalCount(stats.longest_running_turn_sec),
      activeDays,
      inputTokens: null,
      outputTokens: null,
      requests: null,
      planName: null,
    },
    coverage: {
      start: start.value,
      end: end.value,
      timeZone: timezoneOffsetSec,
      timezoneOffsetSec,
      source: hasBuckets ? 'token-activity' : 'unavailable',
      partial: !hasBuckets,
      tokens: tokensCoverage,
      cost: costCoverage,
      issues: hasBuckets ? [] : [{ period: `${start.value}~${end.value}`, code: 'NO_DAILY_BUCKETS' }],
    },
    days: daily,
    fetchedAt: new Date().toISOString(),
  };
};
// ── MiniMax 官方账号账单历史 ────────────────────────────────────────────────
// MiniMax 控制台没有 API Key 可用的历史接口，逐日用量来自网页会话的分页账单
// （platform.minimaxi.com/account/amount，与 CodexBar 的 MiniMaxBillingHistory
// 同一路径）。登录走浏览器窗口捕获 Cookie；consume_cash 系字段全为 0 时说明
// 是纯套餐用量，界面自动退回 Token 口径着色。
const MINIMAX_PLATFORM_ORIGIN = 'https://platform.minimaxi.com';
const MINIMAX_BILLING_PATH = '/account/amount';
const MINIMAX_BILLING_PAGE_LIMIT = 100;
const MINIMAX_MAX_BILLING_PAGES = 40;
const MINIMAX_TIMEZONE_OFFSET_SEC = 8 * 60 * 60;
const MINIMAX_LABEL = 'MiniMax 平台';
const MINIMAX_AUTH_EXPIRED_MESSAGE = 'MiniMax 官方账号登录已失效，请重新连接';
// 控制台登录链路可能跳转的域名（密码/扫码登录、OAuth 回跳）。第三方脚本与
// iframe 不走这个白名单；列表刻意保持精确主机收敛。
const MINIMAX_LOGIN_HOSTS = new Set([
  'platform.minimaxi.com',
  'platform.minimax.io',
  'www.minimaxi.com',
  'www.minimax.io',
  'passport.minimaxi.com',
  'passport.minimax.io',
  'account.minimaxi.com',
  'account.minimax.io',
  'api.minimaxi.com',
  'api.minimax.io',
]);

const isAllowedMinimaxLoginUrl = (rawUrl) => {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (!url.port || url.port === '443')
      && MINIMAX_LOGIN_HOSTS.has(url.hostname.toLowerCase());
  } catch { return false; }
};

const isMinimaxCookieDomain = (value) => {
  const domain = String(value || '').toLowerCase().replace(/^\./, '');
  return domain === 'minimaxi.com' || domain.endsWith('.minimaxi.com')
    || domain === 'minimax.io' || domain.endsWith('.minimax.io');
};

// 账单接口只发往 MiniMax 官方控制台主机；自定义地址一律回落默认域名，避免泄露 Cookie
const normalizeMinimaxOrigin = (raw) => {
  try {
    const url = new URL(String(raw || '').trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && !url.username && !url.password && (/(^|\.)minimaxi\.com$/.test(host) || /(^|\.)minimax\.io$/.test(host))) return url.origin;
  } catch {}
  return MINIMAX_PLATFORM_ORIGIN;
};

const minimaxBillingPage = async (fetcher, origin, page, timeoutMs, signal) => {
  const payload = await requestProviderJson({
    label: MINIMAX_LABEL,
    fetcher,
    url: `${origin}${MINIMAX_BILLING_PATH}?page=${page}&limit=${MINIMAX_BILLING_PAGE_LIMIT}&aggregate=false`,
    credentials: 'include',
    headers: {
      Origin: origin,
      Referer: `${origin}/account`,
      'x-requested-with': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    timeoutMs,
    signal,
    authMessage: MINIMAX_AUTH_EXPIRED_MESSAGE,
    isBusinessAuthError: (body) => Number(body?.base_resp?.status_code) === 1004
      || /cookie|登录|log in/i.test(String(body?.base_resp?.status_msg || '')),
    businessError: (body) => {
      const code = Number(body?.base_resp?.status_code ?? 0);
      return code !== 0 ? `MiniMax 平台返回错误：${String(body?.base_resp?.status_msg || '未知错误').slice(0, 120)}` : null;
    },
  });
  const records = payload?.charge_records;
  if (records !== undefined && records !== null && !Array.isArray(records)) {
    throw new ProviderUsageError('MiniMax 账单响应结构不兼容', 'SCHEMA_INCOMPATIBLE');
  }
  const total = finiteNumber(payload?.total_cnt);
  return { records: Array.isArray(records) ? records : [], totalCount: total === null ? null : Math.max(0, Math.floor(total)) };
};

// 登录探针：一页账单能读通即视为会话有效（capture 流程在窗口会话内带 Cookie 调用）
const probeMinimaxSession = async (fetcher, options = {}) => {
  const timeoutMs = usageTimeoutMs(options.timeoutMs);
  const signal = normalizeAbortSignal(options.signal);
  const result = await minimaxBillingPage(fetcher, normalizeMinimaxOrigin(options.origin), 1, timeoutMs, signal);
  return { records: result.records.length, totalCount: result.totalCount };
};

const minimaxRecordDate = (record, timezoneOffsetSec) => {
  const epoch = finiteNumber(record?.created_at);
  if (epoch !== null && epoch > 0) return dateOfEpoch(epoch, timezoneOffsetSec);
  const ymd = String(record?.ymd || '').trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(ymd)) return strictResponseDate(ymd);
  if (/^\d{8}$/.test(ymd)) return strictResponseDate(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`);
  const slashed = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(ymd);
  if (slashed) return strictResponseDate(`${slashed[1]}-${slashed[2].padStart(2, '0')}-${slashed[3].padStart(2, '0')}`);
  const consume = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(record?.consume_time || '').trim());
  if (consume) return strictResponseDate(`${consume[1]}-${consume[2].padStart(2, '0')}-${consume[3].padStart(2, '0')}`);
  return null;
};

// 与 CodexBar 一致：result/status 存在且不是 SUCCESS 的记录不计入用量
const minimaxRecordSucceeded = (record) => {
  const result = String(record?.result ?? record?.status ?? '').trim();
  return !result || result.toUpperCase() === 'SUCCESS';
};

const minimaxRecordTokens = (record) => {
  const total = finiteNumber(record?.consume_token);
  if (total !== null && total > 0) return Math.floor(total);
  return countOf(record?.consume_input_token) + countOf(record?.consume_output_token);
};

const minimaxRecordCash = (record) => finiteNumber(record?.consume_cash_after_voucher) ?? finiteNumber(record?.consume_cash);

/**
 * Fetch MiniMax console billing history (cookie session) into the shared usage shape.
 * startDate/endDate are inclusive YYYY-MM-DD dates in timezoneOffsetSec (UTC+8).
 */
const fetchMinimaxUsage = async (fetcher, options = {}) => {
  if (typeof fetcher !== 'function') throw new ProviderUsageError('缺少网络请求实现', 'INVALID_ARGUMENT');
  const timezoneOffsetSec = normalizeUsageTimezoneOffset(options.timezoneOffsetSec, MINIMAX_TIMEZONE_OFFSET_SEC, 'MiniMax 用量');
  const fallbackRange = defaultRange(timezoneOffsetSec, options.nowMs);
  const start = parseDate(options.startDate || fallbackRange.startDate, 'startDate');
  const end = parseDate(options.endDate || fallbackRange.endDate, 'endDate');
  if (start.ordinal > end.ordinal) throw new ProviderUsageError('startDate 不能晚于 endDate', 'INVALID_ARGUMENT');
  if ((end.ordinal - start.ordinal) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    throw new ProviderUsageError('MiniMax 用量查询范围不能超过 3660 天', 'INVALID_ARGUMENT');
  }
  const timeoutMs = usageTimeoutMs(options.timeoutMs);
  const signal = normalizeAbortSignal(options.signal);
  throwIfAborted(signal);
  const origin = normalizeMinimaxOrigin(options.origin);

  const days = new Map();
  const issues = [];
  let totalCount = null;
  let fetched = 0;
  let reachedRangeStart = false;
  let page = 1;
  for (; page <= MINIMAX_MAX_BILLING_PAGES; page += 1) {
    throwIfAborted(signal);
    let result;
    try {
      result = await minimaxBillingPage(fetcher, origin, page, timeoutMs, signal);
    } catch (error) {
      if (error?.code === 'AUTH_EXPIRED' || error?.code === 'ABORTED') throw error;
      // 首页失败视为整体不可用；后续页失败保留已翻到的部分并如实标注
      if (page === 1) throw error;
      issues.push({ period: `page ${page}`, code: error?.code || 'USAGE_UNAVAILABLE' });
      break;
    }
    if (result.totalCount !== null) totalCount = result.totalCount;
    if (!result.records.length) break;
    fetched += result.records.length;
    let oldestInPage = null;
    for (const record of result.records) {
      if (!objectOf(record) || !minimaxRecordSucceeded(record)) continue;
      const date = minimaxRecordDate(record, timezoneOffsetSec);
      if (!date) continue;
      if (!oldestInPage || date < oldestInPage) oldestInPage = date;
      if (!inRange(date, start.value, end.value)) continue;
      const day = ensureDay(days, date);
      const counts = {
        tokens: minimaxRecordTokens(record),
        inputTokens: countOf(record?.consume_input_token),
        outputTokens: countOf(record?.consume_output_token),
        promptTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        requests: 1,
      };
      addTokens(day, record?.model, counts);
      const cash = minimaxRecordCash(record);
      if (cash !== null) addCost(day, record?.model, 'CNY', cash);
    }
    if (oldestInPage && oldestInPage <= start.value) { reachedRangeStart = true; break; }
    if (totalCount !== null && fetched >= totalCount) break;
  }
  if (!reachedRangeStart && (totalCount === null || fetched < totalCount) && page > MINIMAX_MAX_BILLING_PAGES) {
    issues.push({ period: `${start.value}~${end.value}`, code: 'PAGE_CAP' });
  }

  // 纯套餐账单的 consume_cash 全为 0：金额没有区分度，退回 Token 口径
  const anyPositiveCash = [...days.values()].some((day) => [...day.costs.values()].some((amount) => amount > 0));
  const complete = reachedRangeStart || (totalCount !== null && fetched >= totalCount);

  const daily = [];
  for (let ordinal = start.ordinal; ordinal <= end.ordinal; ordinal += DAY_MS) {
    const date = dateStringOfOrdinal(ordinal);
    const accumulated = days.get(date) || createDayAccumulator(date);
    const costs = anyPositiveCash ? currencyAmounts(accumulated.costs) : [];
    daily.push({
      date,
      cost: anyPositiveCash ? (accumulated.costs.get('CNY') || 0) : null,
      currency: anyPositiveCash ? 'CNY' : null,
      costs,
      tokens: accumulated.tokens,
      inputTokens: accumulated.inputTokens,
      outputTokens: accumulated.outputTokens,
      promptTokens: null,
      cacheHitTokens: null,
      cacheMissTokens: null,
      requests: accumulated.requests,
      models: [...accumulated.models.values()].map((model) => ({
        model: model.model,
        cost: anyPositiveCash ? (model.costs.get('CNY') || 0) : null,
        currency: anyPositiveCash ? 'CNY' : null,
        costs: anyPositiveCash ? currencyAmounts(model.costs) : [],
        tokens: model.tokens,
        inputTokens: model.inputTokens,
        outputTokens: model.outputTokens,
        cacheHitTokens: null,
        cacheMissTokens: null,
        requests: model.requests,
      })).filter((model) => model.tokens !== 0 || model.cost !== 0).sort((left, right) => (right.cost || 0) - (left.cost || 0) || (right.tokens || 0) - (left.tokens || 0)),
      coverage: { tokens: true, cost: anyPositiveCash },
    });
  }

  const knownTokens = daily.reduce((sum, day) => sum + (day.tokens || 0), 0);
  const knownCost = daily.reduce((sum, day) => sum + (day.cost || 0), 0);
  const activeDays = daily.filter((day) => (day.cost || 0) > 0 || (day.tokens || 0) > 0).length;
  const peakDailyTokens = daily.reduce((peak, day) => Math.max(peak, day.tokens || 0), 0);
  const peakDailyCost = anyPositiveCash ? daily.reduce((peak, day) => Math.max(peak, day.cost || 0), 0) : null;
  const tokensCoverage = {
    complete,
    coveredPeriods: complete ? 1 : 0,
    totalPeriods: 1,
    sources: fetched ? ['billing-history'] : [],
    legacyFallback: false,
  };
  const costCoverage = {
    complete: anyPositiveCash && complete,
    coveredPeriods: anyPositiveCash ? tokensCoverage.coveredPeriods : 0,
    totalPeriods: tokensCoverage.totalPeriods,
    sources: anyPositiveCash ? ['billing-history'] : [],
    legacyFallback: false,
  };

  return {
    provider: 'minimax',
    metric: anyPositiveCash ? 'cost' : 'tokens',
    currency: anyPositiveCash ? 'CNY' : null,
    summary: {
      balance: null,
      grantedBalance: null,
      toppedUpBalance: null,
      totalCost: null,
      rangeCost: anyPositiveCash && complete ? knownCost : null,
      knownRangeCost: anyPositiveCash ? knownCost : null,
      peakDailyCost,
      rangeTokens: complete ? knownTokens : null,
      knownRangeTokens: knownTokens,
      peakDailyTokens,
      activeDays,
      inputTokens: complete ? daily.reduce((sum, day) => sum + (day.inputTokens || 0), 0) : null,
      outputTokens: complete ? daily.reduce((sum, day) => sum + (day.outputTokens || 0), 0) : null,
      requests: complete ? daily.reduce((sum, day) => sum + (day.requests || 0), 0) : null,
      planName: null,
    },
    coverage: {
      start: start.value,
      end: end.value,
      timeZone: timezoneOffsetSec,
      timezoneOffsetSec,
      source: fetched ? 'billing-history' : 'unavailable',
      partial: !complete,
      tokens: tokensCoverage,
      cost: costCoverage,
      issues,
    },
    days: daily,
    fetchedAt: new Date().toISOString(),
  };
};
module.exports = {
  fetchDeepSeekUsage,
  fetchDeepSeekSummary,
  queryDeepSeekUsage: fetchDeepSeekUsage,
  ProviderUsageError,
  isAllowedDeepSeekLoginUrl,
  normalizeDeepSeekUserToken,
  fetchZaiUsage,
  fetchZaiPlanSummary,
  fetchZaiActivity,
  normalizeZaiApiKey,
  normalizeZaiOrigin,
  buildCodexUsageRequest,
  normalizeCodexTokenUsage,
  fetchMinimaxUsage,
  probeMinimaxSession,
  isAllowedMinimaxLoginUrl,
  isMinimaxCookieDomain,
  normalizeMinimaxOrigin,
  shouldUseCachedUsage,
  __test: {
    ZAI_DEFAULT_ORIGIN,
    ZAI_MODEL_USAGE_PATH,
    ZAI_QUOTA_LIMIT_PATH,
    ZAI_CREDIT_ACTIVITY_PATH,
    ZAI_MODEL_USAGE_RETENTION_DAYS,
    ZAI_TIMEZONE_OFFSET_SEC,
    CODEX_USAGE_PROFILE_URL,
    CODEX_TIMEZONE_OFFSET_SEC,
    MINIMAX_PLATFORM_ORIGIN,
    MINIMAX_BILLING_PATH,
    MINIMAX_TIMEZONE_OFFSET_SEC,
    MINIMAX_MAX_BILLING_PAGES,
    minimaxRecordDate,
    minimaxRecordSucceeded,
    minimaxRecordTokens,
    zaiLabelDate,
    zaiModelUsageData,
    zaiActivityData,
    DEEPSEEK_PLATFORM_ORIGIN,
    DEEPSEEK_ROUTES,
    DEEPSEEK_LOGIN_HOSTS,
    buildMonthChunks,
    normalizeSummary,
    shouldFallbackToLegacy,
  },
};
