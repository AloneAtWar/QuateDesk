const { resolveCliAuth, refreshTokenOf, accessTokenExpiryMs, fetchWithCliAuth, __grok: cliGrok } = require('./cli-auth.cjs');
const { fetchMimoSnapshot, mimoCookieHeader, ProviderUsageError, PROVIDER_USAGE_AUTH_KEY } = require('./provider-usage.cjs');

const reauthRequiredError = (message) => Object.assign(new Error(message), { authStatus: 'reauth_required' });
const authStatusForPollError = (error) => error?.authStatus === 'reauth_required' ? 'reauth_required' : 'temporary_error';

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

// ── 网络层兜底：账号级超时 + 瞬时错误自动重试 ────────────────────────────────
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [1_000, 2_000];

// 账号设置里的超时（秒）收敛到 5–120，缺省 15 秒
const accountTimeoutMs = (account) => {
  const seconds = Number(account?.timeoutSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(120, Math.max(5, Math.round(seconds))) * 1000;
};

// 瞬时网络错误（值得自动重试）：超时中断、连接被掐断/重置、DNS 抖动、断网或网络切换、响应被截断。
// 凭据失效、HTTP 4xx/5xx、业务失败不属于瞬时错误，原样抛出不重试。
const TRANSIENT_NETWORK_ERROR = new RegExp([
  'aborted due to timeout',
  'TimeoutError',
  'timed?\\s*out',
  'ETIMEDOUT',
  'net::ERR_CONNECTION_(?:CLOSED|RESET|REFUSED|TIMED_OUT|ABORTED)',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_ADDRESS_UNREACHABLE',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_CONTENT_LENGTH_MISMATCH',
  'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'socket hang up',
  'fetch failed',
  'terminated',
  'Unexpected end of JSON',
  'grpc-status\\s*(?::|=)\\s*(?:1|4|14)\\b',
].join('|'), 'i');

const isTransientNetworkError = (error) => TRANSIENT_NETWORK_ERROR.test(String(error?.message || ''));
const isRetryableError = (error) => Boolean(error?.transient) || isTransientNetworkError(error);

// 网络类报错翻译成可行动的中文提示；attempts 为最终失败时的总尝试次数
const describeNetworkError = (error, attempts) => {
  const raw = String(error?.message || '');
  if (/aborted due to timeout|TimeoutError|ETIMEDOUT|timed?\s*out/i.test(raw)) {
    return `连接超时，已自动重试 ${attempts} 次仍失败。可在账号设置中调大超时时间；访问境外厂商请在「设置 → 网络代理」中配置代理`;
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return `域名解析失败，已自动重试 ${attempts} 次仍失败，请检查网络连接或代理设置`;
  }
  if (/ERR_PROXY|ERR_TUNNEL|ERR_SOCKS/i.test(raw)) {
    return '代理连接失败，请检查「设置 → 网络代理」中的代理地址是否可用';
  }
  if (/ERR_INTERNET_DISCONNECTED/i.test(raw)) {
    return '本机网络未连接，请检查网络后再刷新';
  }
  return `网络连接被中断（已自动重试 ${attempts} 次仍失败，${raw.slice(0, 90)}）。境外厂商直连常被中断，请在「设置 → 网络代理」中配置代理`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
          const key = mapping[rawWindow] || (['five_hour', 'daily', 'weekly', 'monthly', 'balance'].includes(rawWindow) ? rawWindow : rule.defaultWindow);
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

// 瞬时网络错误自动重试：默认共尝试 3 次（1 秒 / 2 秒退避），重试耗尽后把原始报错翻译成中文提示。
// options.retryDelaysMs 仅供测试注入零退避，生产调用不传。
// options.onCliAuth：CLI 登录态自动续期成功后的回调（kind, nextAuth, previousAuth, source），
// 由主进程把新 token 写回加密存储 / 本机 live 文件。
async function queryAccount(account, provider, credential, fetcher = fetch, secretVariables = {}, options = {}) {
  const delays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : RETRY_DELAYS_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await queryAccountOnce(account, provider, credential, fetcher, secretVariables, options);
    } catch (error) {
      if (!isRetryableError(error)) throw error;
      if (attempt > delays.length) {
        // 429/5xx 等厂商续期错误也值得重试，但它们不是网络故障；保留原始、可行动的
        // 厂商提示及 authStatus，而不是统一误报为“请配置代理”。
        if (!isTransientNetworkError(error)) throw error;
        throw new Error(describeNetworkError(error, attempt));
      }
      await sleep(delays[attempt - 1]);
    }
  }
}

async function queryAccountOnce(account, provider, credential, fetcher = fetch, secretVariables = {}, options = {}) {
  const config = provider.requestConfig || {};
  const timeoutMs = accountTimeoutMs(account);
  // CLI 凭据类订阅是专属适配：凭据优先来自账号自己的登录快照（variables 里，DPAPI 加密），
  // 没有快照时回落本机 CLI 登录态；令牌临期/失效时用 refresh_token 自动续期。
  // 每次尝试（含网络重试）都重新取凭据：上一次尝试可能已续期并轮换 refresh_token
  if (['claude', 'codex', 'gemini', 'kimi', 'grok', 'copilot', 'grokbot'].includes(config.adapterMode)) {
    const variables = options.getSecretVariables ? options.getSecretVariables() : secretVariables;
    const cliContext = { variables, onAuthUpdate: options.onCliAuth ? (kind, next, previous, source) => options.onCliAuth({ account, kind, next, previous, source }) : undefined };
    if (config.adapterMode === 'claude') return queryClaudeQuota(fetcher, meter, timeoutMs, cliContext);
    if (config.adapterMode === 'codex') return queryCodexQuota(fetcher, meter, timeoutMs, cliContext);
    if (config.adapterMode === 'kimi') {
      // Kimi 同渠道双登录：无扫码快照的账号是 API Key 模式（kimi 没有 live 登录文件，
      // resolveCliAuth 为 null 即没有快照），走 API Key 用量端点（拿不到月订阅额度）
      if (!resolveCliAuth('kimi', variables)) return queryKimiApiKeyQuota(account, provider, credential, fetcher, meter, timeoutMs, variables);
      return queryKimiWebQuota(fetcher, meter, timeoutMs, cliContext);
    }
    if (config.adapterMode === 'grok') return queryGrokSubscription(fetcher, timeoutMs, cliContext);
    if (config.adapterMode === 'copilot') return queryCopilotQuota(fetcher, meter, timeoutMs, cliContext);
    if (config.adapterMode === 'grokbot') return queryGrokBotUsage(fetcher, meter, timeoutMs, cliContext);
    return queryGeminiQuota(fetcher, meter, timeoutMs, cliContext);
  }
  // MiMo Token Plan：额度接口只认网页会话 Cookie（没有 API Key 端点），凭据
  // 来自官方账号登录保存在加密变量里的 Cookie 快照；会话 24 小时过期后由
  // 主进程 pollState 的静默续期（recoverBrowserUsageAuth）换发再重试。
  if (config.adapterMode === 'mimo') {
    const variables = options.getSecretVariables ? options.getSecretVariables() : secretVariables;
    return queryMimoQuota(fetcher, meter, timeoutMs, variables);
  }
  const credentialRequired = config.adapterMode === 'script' ? config.credentialRequired === true : config.auth !== 'none';
  if (!credential && credentialRequired) throw reauthRequiredError('缺少凭据，请在「设置 → 账号与凭据」中编辑该账号填写 API Token');
  const scripted = config.adapterMode === 'script' && config.script ? runScriptAdapter(account, provider, credential, null, secretVariables) : null;
  const standard = config.adapterMode === 'standard' ? buildStandardRequest(account, provider, credential, secretVariables) : null;
  if (!scripted && !standard) throw new Error(`厂商 ${provider.name} 必须选择标准映射或脚本适配`);
  const request = scripted?.request || standard;
  if (!request.url || !/^https?:\/\//i.test(request.url)) throw new Error('额度接口地址无效');
  const headers = scripted || standard ? { Accept: 'application/json', ...request.headers } : buildHeaders(request.auth, credential);
  const response = await fetcher(request.url, { method: request.method || 'GET', headers, body: request.body ? JSON.stringify(request.body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 401 || response.status === 403) throw reauthRequiredError('凭据已失效，请在「设置 → 账号与凭据」中编辑该账号，更新 API Token 后重新保存');
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

// ── Kimi API Key 额度适配（kimi-subscription 渠道的 API Key 登录模式）────────
// 同一渠道两种登录方式：有扫码快照的账号走 queryKimiWebQuota（含月订阅额度）；
// 只有 API Key 的账号走这里——GET api.kimi.com/coding/v1/usages（Bearer Key），
// 接口只返回 5 小时 / 7 天窗口，拿不到月订阅额度。API Key 账号扫码升级后 Key 仍
// 保留在凭据里（storage.saveCredential 空凭据保留原值），cc-switch 导入按 Key 去重不受影响。
const KIMI_API_USAGE_ENDPOINT = 'https://api.kimi.com/coding/v1/usages';

async function queryKimiApiKeyQuota(account, provider, credential, fetcher, meter, timeoutMs, secretVariables = {}) {
  const apiKey = String(secretVariables?.apiKey || credential || '').trim();
  if (!apiKey) throw reauthRequiredError('该 Kimi 账号没有 API Key，也没有扫码登录：请在「设置 → 账号与凭据」中编辑该账号完成登录');
  const endpoint = String(account.endpoint || provider?.requestConfig?.endpoint || KIMI_API_USAGE_ENDPOINT);
  const response = await fetcher(endpoint, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 401 || response.status === 403) throw reauthRequiredError('Kimi API Key 已失效：请在设置中编辑该账号改用扫码登录，或删除账号后重新添加');
  if (!response.ok) throw new Error(`Kimi 额度接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  const windows = (payload?.limits || []).map((item) => {
    const detail = item?.detail || item || {};
    const total = numeric(detail.limit);
    const remaining = numeric(detail.remaining);
    return meter('five_hour', percent(remaining, total), 100, '%', detail.resetTime, { amount: remaining, limitAmount: total });
  });
  if (payload?.usage) {
    const total = numeric(payload.usage.limit);
    const remaining = numeric(payload.usage.remaining);
    windows.push(meter('weekly', percent(remaining, total), 100, '%', payload.usage.resetTime, { amount: remaining, limitAmount: total }));
  }
  if (!windows.length) throw new Error('Kimi 接口返回成功，但没有识别到额度窗口');
  return windows;
}

// ── Xiaomi MiMo Token Plan 额度专属适配 ─────────────────────────────────────
// 额度数据来自平台控制台的内部接口（tokenPlan/usage + detail），鉴权是官方账号
// 登录保存的网页会话 Cookie（见 provider-usage.cjs 的 MiMo 段）。
// 展示口径：只展示套餐 Credits（原始值以“亿”为单位，cc-switch 社区惯例，
// Lite ≈ 492 亿）；钱包余额不作为额度窗口。会话过期抛 reauth_required，由主进程
// 走隐藏窗口静默续期后重试，续期失败才提示用户重新登录。
const MIMO_CREDITS_YI = 1e8;

// 包年 / 包月按周期时长自动区分：包月账号挂到通用的 monthly 窗口（「1个月」，
// 与其它厂商的月度窗口同一口径），包年账号挂到新增的 yearly 窗口（「1年」）。
// 优先用详情里的周期起点 + 终点算完整时长（年付临近续期的最后一两个月，
// 只看「距重置还剩多久」会误判成包月）；拿不到起点时退回距重置的剩余时长
// （月付周期 ≤ 31 天，距重置超过阈值即视为包年）。
const MIMO_YEARLY_THRESHOLD_MS = 45 * 24 * 60 * 60 * 1000;
const mimoPlanWindowKey = (detail) => {
  const end = detail?.resetsAt ? Date.parse(detail.resetsAt) : NaN;
  if (!Number.isFinite(end)) return 'monthly';
  const start = detail?.periodStartAt ? Date.parse(detail.periodStartAt) : NaN;
  const span = Number.isFinite(start) ? end - start : end - Date.now();
  return span > MIMO_YEARLY_THRESHOLD_MS ? 'yearly' : 'monthly';
};

const readMimoAuthCookies = (variables = {}) => {
  const raw = variables?.[PROVIDER_USAGE_AUTH_KEY];
  if (!raw) return [];
  try {
    const auth = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(auth?.cookies) ? auth.cookies : [];
  } catch { return []; }
};

async function queryMimoQuota(fetcher, meter, timeoutMs, variables = {}) {
  const cookies = readMimoAuthCookies(variables);
  if (!cookies.length) {
    throw reauthRequiredError('尚未连接小米账号：请编辑该账号并勾选「官方账号用量」完成登录');
  }
  const cookieHeader = mimoCookieHeader(cookies);
  if (!cookieHeader) throw reauthRequiredError('MiMo 登录 Cookie 缺失，请重新连接官方账号');
  let snapshot;
  try {
    snapshot = await fetchMimoSnapshot(fetcher, { cookieHeader, timeoutMs });
  } catch (error) {
    if (error instanceof ProviderUsageError && (error.code === 'AUTH_EXPIRED' || error.code === 'AUTH_MISSING')) {
      throw reauthRequiredError('MiMo 官方账号登录已失效，请重新连接官方账号');
    }
    throw error;
  }
  const windows = [];
  const plan = snapshot.plan;
  if (plan && plan.limit !== null && plan.limit > 0) {
    const remainingCredits = Math.max(0, plan.limit - (plan.used ?? 0));
    const remainingPercent = plan.usedPercent !== null
      ? Math.max(0, 100 - plan.usedPercent)
      : percent(remainingCredits, plan.limit);
    windows.push(meter(mimoPlanWindowKey(snapshot.detail), remainingPercent, 100, '%', snapshot.detail?.resetsAt ?? null, {
      amount: Number((remainingCredits / MIMO_CREDITS_YI).toFixed(2)),
      limitAmount: Number((plan.limit / MIMO_CREDITS_YI).toFixed(2)),
      available: !(snapshot.detail?.expired),
    }));
  }
  if (!windows.length) {
    throw new Error('MiMo 账号没有识别到 Token Plan 套餐 Credits（可能尚未订阅）');
  }
  return windows;
}

// ── Grok（xAI）订阅额度专属适配 ─────────────────────────────────────────────
// 实现参考 cc-switch / CodexBar：读取 grok CLI 的 OAuth 凭据，调用 grok.com 的
// gRPC-web 计费端点 GetGrokCreditsConfig（非公开接口、无 .proto），按字段路径
// 启发式提取已用百分比与重置时间。令牌续期统一复用 cli-auth.cjs。

const { queryClaudeQuota, queryCodexQuota, queryGeminiQuota, queryKimiWebQuota, queryCopilotQuota, queryGrokBotUsage } = require('./cli-quota.cjs');

const GROK_BILLING_ENDPOINT = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const selectGrokAuthEntry = cliGrok.selectGrokAuthEntry;

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

const headerValue = (headers, name) => {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  return key ? String(headers[key] || '') : '';
};

const grpcStatusFromData = (data) => {
  const text = Buffer.from(data || '').toString('latin1');
  const match = /grpc-status\s*:\s*(\d+)/i.exec(text);
  return match ? Number(match[1]) : null;
};

const grpcStatusFromResponse = async (response) => {
  const headerStatus = headerValue(response?.headers, 'grpc-status');
  if (headerStatus) return Number(headerStatus);
  if (response?.grpcStatus != null) return Number(response.grpcStatus);
  if (typeof response?.arrayBuffer === 'function') {
    try {
      const bodyStatus = grpcStatusFromData(await response.arrayBuffer());
      if (bodyStatus != null) return bodyStatus;
    } catch {}
  }
  // Undici/Electron versions that expose HTTP trailers do so as a promise-like property.
  try {
    const trailers = typeof response?.trailers?.then === 'function' ? await response.trailers : response?.trailers;
    const trailerStatus = headerValue(trailers, 'grpc-status');
    if (trailerStatus) return Number(trailerStatus);
  } catch {}
  return null;
};

// gRPC-Web 鉴权失败有时以 HTTP 200 + trailer(status 16/7) 返回。fetchWithCliAuth
// 会在这里检查 clone 后的响应，再按与 HTTP 401 相同的逻辑刷新一次。
const grokGrpcAuthFailure = async (response) => {
  return [7, 16].includes(await grpcStatusFromResponse(response));
};

async function queryGrokSubscription(fetcher = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, ctx = {}) {
  const resolved = resolveCliAuth('grok', ctx.variables);
  if (!resolved) throw reauthRequiredError('未检测到 Grok CLI 登录信息。请先运行 grok login，或在「导入订阅登录」中保存本机登录');
  const expiry = accessTokenExpiryMs('grok', resolved.auth);
  if (expiry && expiry < Date.now() && !refreshTokenOf('grok', resolved.auth)) {
    throw reauthRequiredError('Grok 访问令牌已过期且无法自动续期，请运行 grok login 后重新导入');
  }
  // 空 gRPC-web 帧：1 字节 flags + 4 字节大端长度 0
  const body = new Uint8Array(5);
  const response = await fetchWithCliAuth('grok', {
    auth: resolved.auth,
    source: resolved.source,
    fetcher,
    timeoutMs,
    buildRequest: (auth) => ({
      url: GROK_BILLING_ENDPOINT,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth?.key || auth?.access_token || auth?.accessToken || ''}`,
          Origin: 'https://grok.com',
          Referer: 'https://grok.com/?_s=usage',
          Accept: '*/*',
          'Content-Type': 'application/grpc-web+proto',
          'x-grpc-web': '1',
          'x-user-agent': 'connect-es/2.1.1',
          'User-Agent': 'quota-desk',
        },
        body,
      },
    }),
    onAuthUpdate: ctx.onAuthUpdate,
    isAuthFailure: grokGrpcAuthFailure,
  });
  if (response.status === 401 || response.status === 403) throw reauthRequiredError('Grok 凭据被拒绝（自动续期后仍无效），请重新 grok login 并再次导入');
  if (!response.ok) throw new Error(`Grok 计费接口返回 HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const grpcStatus = grpcStatusFromData(data) ?? await grpcStatusFromResponse(response);
  if (grpcStatus != null && grpcStatus !== 0) {
    if ([7, 16].includes(grpcStatus)) throw reauthRequiredError('Grok 凭据被拒绝（自动续期后仍无效），请重新 grok login 并再次导入');
    throw new Error(`Grok 计费 RPC 失败（grpc-status ${grpcStatus}）`);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { usedPercent, resetsAt, startsAt } = parseGrokBilling(data, nowSeconds);
  const key = grokWindowKey(startsAt, resetsAt, nowSeconds);
  return [meter(key, Math.max(0, 100 - usedPercent), 100, '%', resetsAt ? new Date(resetsAt * 1000).toISOString() : null, {
    amount: Math.max(0, 100 - usedPercent),
    limitAmount: 100,
  })];
}

module.exports = {
  definitions,
  queryAccount,
  authStatusForPollError,
  __grok: { selectGrokAuthEntry, parseGrokBilling, grokWindowKey, grpcStatusFromData },
  __mimo: { queryMimoQuota, readMimoAuthCookies, mimoPlanWindowKey, MIMO_CREDITS_YI, MIMO_YEARLY_THRESHOLD_MS },
  __network: { accountTimeoutMs, isTransientNetworkError, describeNetworkError },
};
