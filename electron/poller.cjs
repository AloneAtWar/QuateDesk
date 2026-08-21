const numeric = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const percent = (remaining, total) => total > 0 ? Number(((remaining / total) * 100).toFixed(2)) : 0;
const pathCandidates = (fieldPath) => String(fieldPath || '').split(/[|,]/).map((item) => item.trim()).filter(Boolean);
const atPath = (source, fieldPath) => String(fieldPath || '').split('.').filter(Boolean).reduce((value, key) => {
  if (value == null) return undefined;
  if (/^\d+$/.test(key)) return value[Number(key)];
  return value[key];
}, source);
const firstAtPath = (source, fieldPath) => pathCandidates(fieldPath).map((path) => atPath(source, path)).find((value) => value !== undefined && value !== null && value !== '');
const firstNumber = (source, fieldPath, fallback = 0) => {
  const value = firstAtPath(source, fieldPath);
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
};

const objectEntries = (value) => Object.entries(value || {}).map(([key, item]) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) return { ...item, __windowKey: key };
  return { value: item, __windowKey: key };
});

const mappedAtPath = (item, payload, fieldPath) => pathCandidates(fieldPath).map((candidate) => {
  if (candidate.startsWith('=')) {
    const literal = candidate.slice(1);
    return Number.isFinite(Number(literal)) ? Number(literal) : literal;
  }
  if (candidate === '$root') return payload;
  if (candidate.startsWith('$root.')) return atPath(payload, candidate.slice(6));
  if (candidate === '$item') return item;
  if (candidate.startsWith('$item.')) return atPath(item, candidate.slice(6));
  return atPath(item, candidate);
}).find((value) => value !== undefined && value !== null && value !== '');
const mappedNumber = (item, payload, fieldPath, fallback = 0) => {
  const value = mappedAtPath(item, payload, fieldPath);
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
};
const filterMatches = (item, payload, rule) => {
  if (!rule.filterPath) return true;
  const actual = mappedAtPath(item, payload, rule.filterPath);
  const expected = templateValue(rule.filterValue ?? '', {});
  if (rule.filterOperator === 'not-equals') return String(actual) !== String(expected);
  if (rule.filterOperator === 'includes') return String(actual ?? '').includes(String(expected));
  if (rule.filterOperator === 'exists') return actual !== undefined && actual !== null;
  return String(actual) === String(expected);
};

const templateValue = (value, variables) => String(value ?? '').replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (_match, key) => String(variables[key] ?? ''));
const templateDeep = (value, variables) => {
  if (typeof value === 'string') return templateValue(value, variables);
  if (Array.isArray(value)) return value.map((item) => templateDeep(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, templateDeep(item, variables)]));
  return value;
};

const normalizeCustomResult = (result, config) => {
  const rows = Array.isArray(result) ? result : [result];
  return rows.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const key = item.key || item.window || item.windowKey || config.defaultWindow || 'weekly';
    const rawTotal = numeric(item.total ?? item.limit ?? item.limitAmount, 100);
    const rawRemaining = numeric(item.remaining ?? item.remainingAmount, 0);
    const rawUsed = numeric(item.used ?? item.usedAmount, Math.max(0, rawTotal - rawRemaining));
    const hasPercent = item.total === 100 || item.unit === '%' || item.remainingPercent !== undefined;
    const remaining = hasPercent ? rawRemaining : percent(rawRemaining, rawTotal);
    const used = hasPercent ? numeric(item.used, Math.max(0, 100 - remaining)) : percent(rawUsed, rawTotal);
    return [meter(key, remaining, 100, item.unit || '%', item.resetAt ?? item.reset_at ?? item.resetTime ?? item.nextResetTime, {
      used, amount: numeric(item.amount, rawRemaining), limitAmount: numeric(item.limitAmount, rawTotal),
      available: item.available ?? item.isValid ?? true,
      error: item.error,
    })];
  });
};

const buildVariables = (account, config, credential, secretVariables = {}) => {
  const declared = Array.isArray(config.variables) ? config.variables : [];
  const defaults = Object.fromEntries(declared.map((item) => [item.key, item.defaultValue ?? '']).filter(([key]) => key));
  const variables = { endpoint: account.endpoint || config.endpoint || '', apiKey: credential, credential, accountId: account.id, ...defaults, ...(account.variables || {}), ...(secretVariables || {}) };
  if (!String(variables.apiKey || '').trim()) variables.apiKey = credential || '';
  if (!String(variables.endpoint || '').trim()) variables.endpoint = account.endpoint || config.endpoint || '';
  const missing = declared.find((item) => item.required && !String(variables[item.key] ?? '').trim());
  if (missing) throw new Error(`缺少脚本变量：${missing.label || missing.key}`);
  return variables;
};

const runScriptAdapter = (account, provider, credential, payload, secretVariables = {}) => {
  const config = provider.requestConfig || {};
  const variables = buildVariables(account, config, credential, secretVariables);
  let program;
  try {
    const vm = require('node:vm');
    const source = String(config.script || '').trim();
    if (!source) return null;
    program = new vm.Script(`(${source})`, { timeout: 1000 }).runInNewContext({ variables: Object.freeze({ ...variables }) }, { timeout: 1000 });
  } catch (error) { throw new Error(`适配脚本语法错误：${error.message}`); }
  if (!program || typeof program !== 'object') throw new Error('适配脚本必须返回 request 和 extractor');
  const request = templateDeep(program.request || {}, variables);
  const url = String(request.url || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('脚本请求 URL 无效');
  return { request: { url, method: request.method || 'GET', headers: request.headers || {}, body: request.body }, extractor: program.extractor, variables, payload };
};

const meter = (key, remaining, total, unit = '%', resetAt = null, extra = {}) => ({
  key,
  remaining: numeric(remaining),
  used: Math.max(0, numeric(total) - numeric(remaining)),
  total: numeric(total),
  unit,
  resetAt: resetAt || null,
  available: extra.available ?? true,
  ...extra,
});

const definitions = {
  generic: {
    request: (account, provider) => {
      const config = provider.requestConfig || {};
      const endpoint = String(account.endpoint || config.endpoint || '');
      const url = /^https?:\/\//i.test(endpoint) ? endpoint : `${String(account.baseUrl || provider.baseUrl || '').replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
      return { url, auth: config.auth || 'bearer' };
    },
    normalize(payload, provider) {
      const config = provider.requestConfig || {};
      const rules = Array.isArray(config.responseRules) && config.responseRules.length ? config.responseRules : [config];
      return rules.flatMap((rule) => {
        const found = rule.listPath ? atPath(payload, rule.listPath) : payload;
        const mode = rule.collectionMode || 'auto';
        const rows = Array.isArray(found) ? found : mode === 'object-entries' ? objectEntries(found) : [found];
        return rows.flatMap((item) => {
          if (!item || !filterMatches(item, payload, rule)) return [];
          const rawWindow = String(mappedAtPath(item, payload, rule.windowField) ?? item.__windowKey ?? rule.defaultWindow ?? '').toLowerCase();
          const mapping = rule.windowMap || {};
          const key = mapping[rawWindow] || (['five_hour', 'weekly', 'monthly', 'balance'].includes(rawWindow) ? rawWindow : rule.defaultWindow);
          if (!key) return [];
          const total = mappedNumber(item, payload, rule.totalPath, 0);
          const used = mappedNumber(item, payload, rule.usedPath, 0);
          const rawPercentage = mappedNumber(item, payload, rule.percentagePath, NaN);
          const remainingAmount = mappedNumber(item, payload, rule.remainingPath, Math.max(0, total - used));
          const percentageRemaining = rule.percentageMode === 'remaining' ? rawPercentage : 100 - rawPercentage;
          const remaining = key === 'balance' ? 100 : Number.isFinite(rawPercentage) ? Math.max(0, Math.min(100, percentageRemaining)) : percent(remainingAmount, total);
          const availableValue = mappedAtPath(item, payload, rule.availablePath);
          const normalizedAvailability = typeof availableValue === 'string' ? availableValue.toLowerCase() : availableValue;
          const unavailableValues = String(rule.unavailableValues || 'false|0|inactive|invalid').split('|').map((value) => value.toLowerCase());
          const available = availableValue === undefined ? true : !unavailableValues.includes(String(normalizedAvailability));
          const mappedUnit = mappedAtPath(item, payload, rule.unitPath) || rule.unit || (key === 'balance' ? 'CNY' : '%');
          return [meter(key, remaining, 100, mappedUnit, mappedAtPath(item, payload, rule.resetPath), { amount: remainingAmount, limitAmount: total, available })];
        });
      });
    },
  },
  kimi: {
    request: (account, provider) => ({ url: account.endpoint || provider.requestConfig?.endpoint || 'https://api.kimi.com/coding/v1/usages', auth: provider.requestConfig?.auth || 'bearer' }),
    normalize(payload) {
      const windows = (payload?.limits || []).map((item) => {
        const detail = item.detail || item;
        const total = numeric(detail.limit);
        const remaining = numeric(detail.remaining);
        return meter('five_hour', percent(remaining, total), 100, '%', detail.resetTime, { amount: remaining, limitAmount: total });
      });
      if (payload?.usage) {
        const total = numeric(payload.usage.limit);
        const remaining = numeric(payload.usage.remaining);
        windows.push(meter('weekly', percent(remaining, total), 100, '%', payload.usage.resetTime, { amount: remaining, limitAmount: total }));
      }
      return windows;
    },
  },
  zai: {
    request: (account, provider) => {
      if (account.endpoint || provider.requestConfig?.endpoint) return { url: account.endpoint || provider.requestConfig.endpoint, auth: provider.requestConfig?.auth || 'token' };
      const host = String(account.baseUrl || provider.baseUrl || provider.domain || '').toLowerCase();
      const base = host.includes('api.z.ai') ? 'https://api.z.ai' : host.includes('bigmodel.cn') ? 'https://open.bigmodel.cn' : account.baseUrl || provider.baseUrl;
      return { url: `${String(base || '').replace(/\/$/, '')}/api/monitor/usage/quota/limit`, auth: 'token' };
    },
    normalize(payload) {
      const source = payload?.data || payload?.result || payload || {};
      const rows = source.limits || source.quotas || source.items || [];
      const normalized = Array.isArray(rows) ? rows.map((item, index) => {
        const detail = item.detail || item;
        const total = numeric(detail.limit ?? detail.total ?? detail.usage);
        const used = numeric(detail.used ?? detail.currentValue);
        const remainingAmount = numeric(detail.remaining, Math.max(0, total - used));
        const usedPercent = Number(detail.percentage);
        const remainingPercent = Number.isFinite(usedPercent)
          ? Math.max(0, Math.min(100, 100 - usedPercent))
          : percent(remainingAmount, total);
        const rawWindow = String(item.type || item.window || item.name || '').toLowerCase();
        const unit = numeric(detail.unit, -1);
        const number = numeric(detail.number, -1);
        const key = number === 5 && unit === 3
          ? 'five_hour'
          : unit === 6 || rawWindow.includes('week') || rawWindow.includes('7')
            ? 'weekly'
            : unit === 5 || rawWindow.includes('month') || rawWindow.includes('30')
              ? 'monthly'
              : index === 0 ? 'five_hour' : 'weekly';
        return meter(key, remainingPercent, 100, '%', detail.nextResetTime ?? detail.resetTime ?? detail.resetAt, {
          amount: remainingAmount,
          limitAmount: total,
          sourceType: item.type || null,
        });
      }) : [];
      if (normalized.length) return normalized;
      return ['five_hour', 'weekly'].flatMap((key) => {
        const item = key === 'five_hour' ? source.five_hour || source.fiveHour : source.weekly || source.sevenDay;
        if (!item) return [];
        const total = numeric(item.limit ?? item.total);
        const remaining = numeric(item.remaining, Math.max(0, total - numeric(item.used)));
        return [meter(key, percent(remaining, total), 100, '%', item.resetTime ?? item.resetAt, { amount: remaining, limitAmount: total })];
      });
    },
  },
  deepseek: {
    request: (account, provider) => ({ url: account.endpoint || provider.requestConfig?.endpoint || 'https://api.deepseek.com/user/balance', auth: provider.requestConfig?.auth || 'bearer' }),
    normalize(payload) {
      return (payload?.balance_infos || []).map((item) => meter('balance', 100, 100, item.currency || 'CNY', null, {
        amount: numeric(item.total_balance),
        limitAmount: numeric(item.total_balance),
        available: payload?.is_available !== false,
        error: payload?.is_available === false ? 'Insufficient balance' : undefined,
      }));
    },
  },
  wlb: {
    request: (account, provider) => ({ url: account.endpoint || provider.requestConfig?.endpoint || `${String(account.baseUrl || provider.baseUrl || '').replace(/\/$/, '')}/v1/usage`, auth: provider.requestConfig?.auth || 'bearer' }),
    normalize(payload) {
      const item = payload?.rate_limits?.find((row) => row.window === '7d') || {};
      const total = numeric(item.limit);
      const remaining = numeric(item.remaining, Math.max(0, total - numeric(item.used)));
      return [meter('weekly', percent(remaining, total), 100, '%', item.resetAt ?? item.reset_at ?? item.resetTime, { amount: remaining, limitAmount: total, available: payload?.isValid ?? payload?.status === 'active' })];
    },
  },
  mimo: {
    request: (account, provider) => ({ url: account.endpoint || provider.requestConfig?.endpoint || 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage', auth: provider.requestConfig?.auth || 'cookie' }),
    normalize(payload) {
      const item = payload?.data?.monthUsage?.items?.find((row) => row.name === 'month_total_token');
      if (!item) return [];
      const total = numeric(item.limit);
      const remaining = Math.max(0, total - numeric(item.used));
      return [meter('monthly', percent(remaining, total), 100, '%', item.resetTime, { amount: remaining, limitAmount: total })];
    },
  },
};

const buildHeaders = (auth, credential) => {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (auth === 'bearer') headers.Authorization = `Bearer ${credential}`;
  if (auth === 'token') headers.Authorization = credential;
  if (auth === 'cookie') headers.Cookie = credential;
  return headers;
};

const parseObjectConfig = (value, label) => {
  if (!value || (typeof value === 'string' && !value.trim())) return {};
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); }
  catch (error) { throw new Error(`${label}不是有效 JSON：${error.message}`); }
};

const buildStandardRequest = (account, provider, credential, secretVariables = {}) => {
  const config = provider.requestConfig || {};
  let url = String(account.endpoint || config.endpoint || '');
  const variables = buildVariables(account, config, credential, secretVariables);
  const headers = { Accept: 'application/json', ...templateDeep(parseObjectConfig(config.headers, '自定义请求头'), variables) };
  const auth = config.auth || 'bearer';
  if (auth === 'bearer') headers[config.authHeader || 'Authorization'] = `${config.authPrefix ?? 'Bearer '}${credential}`;
  if (auth === 'token') headers[config.authHeader || 'Authorization'] = `${config.authPrefix || ''}${credential}`;
  if (auth === 'cookie') headers[config.authHeader || 'Cookie'] = credential;
  if (auth === 'query') {
    const parsed = new URL(url);
    parsed.searchParams.set(config.authQuery || 'api_key', credential);
    url = parsed.toString();
  }
  const body = templateDeep(parseObjectConfig(config.body, '请求体'), variables);
  const hasBody = Object.keys(body).length > 0 && !['GET', 'HEAD'].includes(String(config.method || 'GET').toUpperCase());
  if (hasBody && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return { url, method: String(config.method || 'GET').toUpperCase(), headers, body: hasBody ? body : undefined };
};

async function queryAccount(account, provider, credential, fetcher = fetch, secretVariables = {}) {
  const config = provider.requestConfig || {};
  const credentialRequired = config.adapterMode === 'script' ? config.credentialRequired !== false : config.auth !== 'none';
  if (!credential && credentialRequired) throw new Error('缺少凭据，请在账号设置中更新');
  const scripted = config.adapterMode === 'script' && config.script ? runScriptAdapter(account, provider, credential, null, secretVariables) : null;
  const standard = config.adapterMode === 'standard' ? buildStandardRequest(account, provider, credential, secretVariables) : null;
  if (!scripted && !standard) throw new Error(`厂商 ${provider.name} 必须选择标准映射或脚本适配`);
  const request = scripted?.request || standard;
  if (!request.url || !/^https?:\/\//i.test(request.url)) throw new Error('额度接口地址无效');
  const headers = scripted || standard ? { Accept: 'application/json', ...request.headers } : buildHeaders(request.auth, credential);
  const response = await fetcher(request.url, { method: request.method || 'GET', headers, body: request.body ? JSON.stringify(request.body) : undefined, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) throw new Error(provider.adapter === 'mimo' ? 'Cookie 已过期' : '凭据已失效');
  if (!response.ok) throw new Error(`额度接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.success === false || Number(payload?.code) >= 400) {
    throw new Error(payload?.msg || payload?.message || '额度接口报告请求失败');
  }
  let windows;
  if (scripted) {
    let result;
    try { result = scripted.extractor(payload, scripted.variables); }
    catch (error) { throw new Error(`适配脚本执行失败：${error.message}`); }
    windows = normalizeCustomResult(result, provider.requestConfig || {});
  } else windows = definitions.generic.normalize(payload, provider);
  if (!windows.length) throw new Error('接口返回成功，但没有识别到额度窗口');
  const selected = Array.isArray(account.windowKeys) && account.windowKeys.length ? new Set(account.windowKeys) : null;
  const visibleWindows = selected ? windows.filter((item) => selected.has(item.key)) : windows;
  if (!visibleWindows.length) throw new Error('接口已返回额度，但没有包含该账号选择的窗口');
  return visibleWindows;
}

module.exports = { definitions, queryAccount };
