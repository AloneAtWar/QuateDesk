const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
          const rawTotal = mappedNumber(item, payload, rule.totalPath, NaN);
          const rawUsed = mappedNumber(item, payload, rule.usedPath, NaN);
          const rawRemaining = mappedNumber(item, payload, rule.remainingPath, NaN);
          const total = Number.isFinite(rawTotal) ? rawTotal : 0;
          const used = Number.isFinite(rawUsed) ? rawUsed : 0;
          const remainingAmount = Number.isFinite(rawRemaining) ? rawRemaining : Math.max(0, total - used);
          const rawPercentage = mappedNumber(item, payload, rule.percentagePath, NaN);
          const percentageRemaining = rule.percentageMode === 'remaining' ? rawPercentage : 100 - rawPercentage;
          const remaining = key === 'balance' ? 100 : Number.isFinite(rawPercentage) ? Math.max(0, Math.min(100, percentageRemaining)) : percent(remainingAmount, total);
          const availableValue = mappedAtPath(item, payload, rule.availablePath);
          const normalizedAvailability = typeof availableValue === 'string' ? availableValue.toLowerCase() : availableValue;
          const unavailableValues = String(rule.unavailableValues || 'false|0|inactive|invalid').split('|').map((value) => value.toLowerCase());
          const available = availableValue === undefined ? true : !unavailableValues.includes(String(normalizedAvailability));
          const mappedUnit = mappedAtPath(item, payload, rule.unitPath) || rule.unit || (key === 'balance' ? 'CNY' : '%');
          // 只配了百分比的窗口没有真实的总量/剩余数值，置 null 让展示层不渲染“已用 0 / 0”占位
          const hasRealAmount = Number.isFinite(rawRemaining) || (Number.isFinite(rawTotal) && Number.isFinite(rawUsed));
          const hasRealLimit = Number.isFinite(rawTotal) && total > 0;
          return [meter(key, remaining, 100, mappedUnit, mappedAtPath(item, payload, rule.resetPath), {
            amount: mappedUnit === '%' && !hasRealAmount ? null : remainingAmount,
            limitAmount: mappedUnit === '%' && !hasRealLimit ? null : total,
            available,
          })];
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
  // CLI 凭据类订阅是专属适配：凭据来自本机各官方 CLI 登录态，不走标准映射/脚本模板
  if (config.adapterMode === 'grok') return queryGrokSubscription(fetcher);
  if (config.adapterMode === 'claude') return queryClaudeQuota(fetcher, meter);
  if (config.adapterMode === 'codex') return queryCodexQuota(fetcher, meter);
  if (config.adapterMode === 'gemini') return queryGeminiQuota(fetcher, meter);
  const credentialRequired = config.adapterMode === 'script' ? config.credentialRequired === true : config.auth !== 'none';
  if (!credential && credentialRequired) throw new Error('缺少凭据，请在「设置 → 账号与凭据」中编辑该账号填写 API Token');
  const scripted = config.adapterMode === 'script' && config.script ? runScriptAdapter(account, provider, credential, null, secretVariables) : null;
  const standard = config.adapterMode === 'standard' ? buildStandardRequest(account, provider, credential, secretVariables) : null;
  if (!scripted && !standard) throw new Error(`厂商 ${provider.name} 必须选择标准映射或脚本适配`);
  const request = scripted?.request || standard;
  if (!request.url || !/^https?:\/\//i.test(request.url)) throw new Error('额度接口地址无效');
  const headers = scripted || standard ? { Accept: 'application/json', ...request.headers } : buildHeaders(request.auth, credential);
  const response = await fetcher(request.url, { method: request.method || 'GET', headers, body: request.body ? JSON.stringify(request.body) : undefined, signal: AbortSignal.timeout(15_000) });
  if (response.status === 401 || response.status === 403) throw new Error('凭据已失效，请在「设置 → 账号与凭据」中编辑该账号，更新 API Token 后重新保存');
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

// ── Grok（xAI）订阅额度专属适配 ─────────────────────────────────────────────
// 实现参考 cc-switch / CodexBar：读取 grok CLI 的 OAuth 凭据，调用 grok.com 的
// gRPC-web 计费端点 GetGrokCreditsConfig（非公开接口、无 .proto），按字段路径
// 启发式提取已用百分比与重置时间。token 的刷新由 grok CLI 自己负责。

const { queryClaudeQuota, queryCodexQuota, queryGeminiQuota } = require('./cli-quota.cjs');

const GROK_BILLING_ENDPOINT = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const GROK_OIDC_SCOPE_PREFIX = 'https://auth.x.ai::';
const GROK_LEGACY_SESSION_SCOPE = 'https://accounts.x.ai/sign-in';

const grokAuthPath = () => path.join(os.homedir(), '.grok', 'auth.json');

// auth.json 顶层是 scope → 条目 的 map；SuperGrok（OIDC）条目优先，legacy session 兜底
const selectGrokAuthEntry = (auth) => {
  if (!auth || typeof auth !== 'object') return null;
  let oidc = null;
  let legacy = null;
  for (const [scope, entry] of Object.entries(auth)) {
    if (!entry || typeof entry !== 'object' || !entry.key) continue;
    if (scope.startsWith(GROK_OIDC_SCOPE_PREFIX)) oidc ??= entry;
    else if (scope === GROK_LEGACY_SESSION_SCOPE || scope.includes('/sign-in')) legacy ??= entry;
  }
  return oidc || legacy;
};

const readGrokVarint = (bytes, index) => {
  let value = 0;
  let shift = 0;
  while (index.i < bytes.length && shift < 64) {
    const byte = bytes[index.i++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
  return null;
};

// 无 .proto 定义：递归扫描 protobuf，收集 varint 与 fixed32 字段（路径 = 字段号链）
const scanGrokProtobuf = (bytes, depth, prefix, fixed32, varints) => {
  const index = { i: 0 };
  while (index.i < bytes.length) {
    const start = index.i;
    const key = readGrokVarint(bytes, index);
    if (!key) { index.i = start + 1; continue; }
    const fieldNumber = Math.floor(key / 8);
    const wireType = key % 8;
    const fieldPath = [...prefix, fieldNumber];
    if (wireType === 0) {
      const value = readGrokVarint(bytes, index);
      if (value != null) varints.push([fieldPath, value]);
    } else if (wireType === 1) index.i += 8;
    else if (wireType === 2) {
      const length = readGrokVarint(bytes, index);
      if (length == null || length > bytes.length - index.i) { index.i = start + 1; continue; }
      if (depth < 4 && length > 0) scanGrokProtobuf(bytes.subarray(index.i, index.i + length), depth + 1, fieldPath, fixed32, varints);
      index.i += length;
    } else if (wireType === 5) {
      if (index.i + 4 > bytes.length) return;
      fixed32.push([fieldPath, bytes.readFloatLE(index.i)]);
      index.i += 4;
    } else index.i = start + 1;
  }
};

// 从 gRPC-web 响应拆出 data 帧（0x80 标记的 trailer 帧跳过）
const grokGrpcDataFrames = (data) => {
  const frames = [];
  let i = 0;
  while (i + 5 <= data.length) {
    const flags = data[i];
    const length = data.readUInt32BE(i + 1);
    if (i + 5 + length > data.length) return [];
    if (!(flags & 0x80)) frames.push(data.subarray(i + 5, i + 5 + length));
    i += 5 + length;
  }
  return frames;
};

// 启发式提取（百分比/重置与 cc-switch/CodexBar 一致）：
// - 百分比：fixed32 中路径末段为 1 且值域 [0,100]，取路径最浅、最早出现的
// - 重置时间：未来 Unix 秒的 varint，优先路径 [1,5,1]，否则取最近的
// - 窗口开始：路径 [1,4,1] 的 Unix 秒，与重置时间一起用于判断窗口时长
// - proto3 零值省略：百分比缺失但存在重置时间与用量周期标记时按 0% 处理
const parseGrokBilling = (data, nowSeconds = Math.floor(Date.now() / 1000)) => {
  const frames = grokGrpcDataFrames(data);
  if (!frames.length && data.length && data[0] % 16 < 6 && data[0] >= 8) frames.push(data);
  if (!frames.length) throw new Error('Grok 计费响应中没有可解析的数据');
  const fixed32 = [];
  const varints = [];
  for (const frame of frames) scanGrokProtobuf(frame, 0, [], fixed32, varints);
  const percent = fixed32
    .filter(([p, value]) => p[p.length - 1] === 1 && value >= 0 && value <= 100)
    .sort((a, b) => a[0].length - b[0].length)[0];
  const resets = varints
    .filter(([p, value]) => value > 1_700_000_000 && value < 2_100_000_000 && value > nowSeconds)
    .sort((a, b) => a[1] - b[1]);
  const reset = resets.find(([p]) => p.length === 3 && p[0] === 1 && p[1] === 5 && p[2] === 1) || resets[0];
  // 窗口开始时间：[1,4,1]，取早于重置时间且在合理区间的候选
  const starts = varints
    .filter(([p, value]) => p.length === 3 && p[0] === 1 && p[1] === 4 && p[2] === 1 && value > 1_700_000_000 && value < 2_100_000_000 && reset && value < reset[1])
    .map(([p, value]) => value);
  const hasUsagePeriod = varints.some(([p, value]) => (p[0] === 1 && p[1] === 6) || (p.length === 3 && p[0] === 1 && p[1] === 8 && p[2] === 1 && (value === 1 || value === 2)));
  const usedPercent = percent ? percent[1] : (reset && hasUsagePeriod && fixed32.length === 0 ? 0 : null);
  if (usedPercent == null) throw new Error('无法从 Grok 计费响应中识别用量百分比');
  return { usedPercent, resetsAt: reset ? reset[1] : null, startsAt: starts.length ? Math.max(...starts) : null };
};

// 优先按窗口起止时长判断（≈7 天 → 周窗口，≈1 个月 → 月窗口，≈5 小时 → 5 小时窗口）；
// 拿不到开始时间时退回按剩余天数推断（cc-switch 的做法，周期尾声会误判，仅作兜底）
const grokWindowKey = (startsAt, resetsAt, nowSeconds) => {
  if (startsAt && resetsAt) {
    const days = (resetsAt - startsAt) / 86400;
    if (days >= 5.5 && days <= 8.5) return 'weekly';
    if (days >= 26 && days <= 35) return 'monthly';
    if (days >= 0.15 && days <= 0.35) return 'five_hour';
    return 'monthly';
  }
  if (resetsAt == null || nowSeconds == null) return 'monthly';
  const remaining = Math.round((resetsAt - nowSeconds) / 86400);
  if (remaining >= 4 && remaining <= 12) return 'weekly';
  return 'monthly';
};

async function queryGrokSubscription(fetcher = fetch) {
  if (!fs.existsSync(grokAuthPath())) {
    throw new Error('未检测到 grok CLI 登录信息，请先安装 grok CLI 并运行 grok login');
  }
  let auth;
  try { auth = JSON.parse(fs.readFileSync(grokAuthPath(), 'utf8')); }
  catch { throw new Error('~/.grok/auth.json 不是有效的 JSON，请重新 grok login'); }
  const entry = selectGrokAuthEntry(auth);
  if (!entry) throw new Error('grok 凭据中没有可用的访问令牌，请重新 grok login');
  if (entry.expires_at && new Date(entry.expires_at).getTime() < Date.now()) {
    throw new Error('Grok 访问令牌已过期，运行一次 grok CLI 让其自动刷新，或重新 grok login');
  }
  // 空 gRPC-web 帧：1 字节 flags + 4 字节大端长度 0
  const body = new Uint8Array(5);
  const response = await fetcher(GROK_BILLING_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${entry.key}`,
      Origin: 'https://grok.com',
      Referer: 'https://grok.com/?_s=usage',
      Accept: '*/*',
      'Content-Type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'connect-es/2.1.1',
      'User-Agent': 'quota-desk',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Grok 凭据被拒绝，请重新 grok login');
  if (!response.ok) throw new Error(`Grok 计费接口返回 HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const trailer = /grpc-status:(\d+)/.exec(data.toString('latin1').slice(-64));
  if (trailer && trailer[1] !== '0') throw new Error(`Grok 计费 RPC 失败（grpc-status ${trailer[1]}）`);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { usedPercent, resetsAt, startsAt } = parseGrokBilling(data, nowSeconds);
  const key = grokWindowKey(startsAt, resetsAt, nowSeconds);
  return [meter(key, Math.max(0, 100 - usedPercent), 100, '%', resetsAt ? new Date(resetsAt * 1000).toISOString() : null, {
    amount: Math.max(0, 100 - usedPercent),
    limitAmount: 100,
  })];
}

module.exports = { definitions, queryAccount, __grok: { selectGrokAuthEntry, parseGrokBilling, grokWindowKey } };
