const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchDeepSeekUsage,
  fetchDeepSeekSummary,
  ProviderUsageError,
  isAllowedDeepSeekLoginUrl,
  normalizeDeepSeekUserToken,
  shouldUseCachedUsage,
  __test,
} = require('../electron/provider-usage.cjs');

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const localMidnightSec = (date, timezoneOffsetSec = 28_800) => {
  const [year, month, day] = date.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 1000) - timezoneOffsetSec;
};

const summaryPayload = () => ({
  code: 0,
  data: {
    biz_code: 0,
    biz_data: {
      normal_wallets: [{ currency: 'CNY', balance: '10.50', token_estimation: '1000' }],
      bonus_wallets: [{ currency: 'CNY', balance: '2.00', token_estimation: '200' }],
      total_available_token_estimation: '1200',
      total_usage: '987654',
      monthly_token_usage: '4321',
      total_costs: [{ currency: 'CNY', amount: '123.45' }],
      monthly_costs: [{ currency: 'CNY', amount: '4.56' }],
    },
  },
});

test('fetches summary first and normalizes by_api_key usage into daily cost buckets', async () => {
  const secret = 'platform-user-token-never-return-this';
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/v0/users/get_user_summary')) return jsonResponse(summaryPayload());
    if (url.includes('/api/v0/usage/by_api_key/amount?')) {
      return jsonResponse({
        code: 0,
        data: {
          biz_code: 0,
          biz_data: {
            bucket: 86400,
            series: [
              {
                api_key: { tracking_id: 'not-exposed' },
                model: 'deepseek-chat',
                buckets: [
                  {
                    time: localMidnightSec('2026-09-01'),
                    usage: {
                      PROMPT_TOKEN: '150',
                      PROMPT_CACHE_HIT_TOKEN: '100',
                      PROMPT_CACHE_MISS_TOKEN: '50',
                      RESPONSE_TOKEN: '20',
                      REQUEST: '2',
                    },
                  },
                  { time: localMidnightSec('2026-09-03'), usage: { PROMPT_TOKEN: '20', RESPONSE_TOKEN: '10', REQUEST: '1' } },
                ],
              },
              {
                model: 'deepseek-reasoner',
                buckets: [{
                  time: localMidnightSec('2026-09-01'),
                  usage: { PROMPT_CACHE_MISS_TOKEN: '10', RESPONSE_TOKEN: '5', REQUEST: '1' },
                }],
              },
            ],
          },
        },
      });
    }
    if (url.includes('/api/v0/usage/by_api_key/cost?')) {
      return jsonResponse({
        code: 0,
        data: {
          biz_code: 0,
          biz_data: {
            data: [{
              currency: 'CNY',
              series: [
                {
                  api_key: { sensitive_id: 'not-exposed-either' },
                  model: 'deepseek-chat',
                  buckets: [
                    { time: localMidnightSec('2026-09-01'), cost: '0.25' },
                    { time: localMidnightSec('2026-09-02'), cost: '0.10' },
                  ],
                },
                { model: 'deepseek-reasoner', buckets: [{ time: localMidnightSec('2026-09-01'), cost: '0.05' }] },
              ],
            }],
          },
        },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await fetchDeepSeekUsage(secret, fetcher, {
    startDate: '2026-09-01',
    endDate: '2026-09-03',
    timezoneOffsetSec: 28_800,
    baseUrl: 'https://attacker.invalid',
  });

  assert.equal(calls[0].url, 'https://platform.deepseek.com/api/v0/users/get_user_summary');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(calls[0].options.headers['x-client-platform'], 'web');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls.every((call) => call.url.startsWith(__test.DEEPSEEK_PLATFORM_ORIGIN)));
  assert.ok(calls[1].url.includes(`start=${localMidnightSec('2026-09-01')}`));
  assert.ok(calls[1].url.includes(`end=${localMidnightSec('2026-09-04')}`));
  assert.ok(calls[1].url.endsWith('&tz=28800'));

  assert.equal(result.provider, 'deepseek');
  assert.equal(result.metric, 'cost');
  assert.equal(result.currency, 'CNY');
  assert.equal(result.summary.balance, 12.5);
  assert.equal(result.summary.toppedUpBalance, 10.5);
  assert.equal(result.summary.grantedBalance, 2);
  assert.equal(result.summary.totalCost, 123.45);
  assert.ok(Math.abs(result.summary.rangeCost - 0.4) < 1e-12);
  assert.ok(Math.abs(result.summary.peakDailyCost - 0.3) < 1e-12);
  assert.equal(result.summary.activeDays, 3);
  assert.equal(result.summary.rangeTokens, 215);
  assert.deepEqual(result.coverage.start, '2026-09-01');
  assert.deepEqual(result.coverage.end, '2026-09-03');
  assert.equal(result.coverage.timeZone, 28_800);
  assert.equal(result.coverage.source, 'by_api_key');
  assert.equal(result.coverage.partial, false);

  assert.equal(result.days.length, 3);
  assert.deepEqual(
    result.days.map((day) => ({ date: day.date, cost: day.cost, tokens: day.tokens })),
    [
      { date: '2026-09-01', cost: 0.3, tokens: 185 },
      { date: '2026-09-02', cost: 0.1, tokens: 0 },
      { date: '2026-09-03', cost: 0, tokens: 30 },
    ],
  );
  assert.equal(result.days[0].inputTokens, 160);
  assert.equal(result.days[0].outputTokens, 25);
  assert.equal(result.days[0].cacheHitTokens, 100);
  assert.equal(result.days[0].cacheMissTokens, 60);
  assert.equal(result.days[0].requests, 3);
  assert.deepEqual(result.days[0].models.map((model) => model.model).sort(), ['deepseek-chat', 'deepseek-reasoner']);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('not-exposed'));
});

test('normalizes the current platform userToken wrapper and strictly allow-lists login destinations', () => {
  assert.equal(normalizeDeepSeekUserToken(JSON.stringify({ value: 'Bearer ds-user-token', __version: '0' })), 'ds-user-token');
  assert.equal(normalizeDeepSeekUserToken({ token: JSON.stringify('Bearer nested-token') }), 'nested-token');
  assert.equal(normalizeDeepSeekUserToken('Bearer token with spaces'), '');
  assert.equal(normalizeDeepSeekUserToken(`Bearer token\nInjected: value`), '');

  for (const url of [
    'https://platform.deepseek.com/sign_in',
    'https://accounts.google.com/o/oauth2/auth',
    'https://open.weixin.qq.com/connect/qrconnect',
    'https://appleid.apple.com/auth/authorize',
  ]) assert.equal(isAllowedDeepSeekLoginUrl(url), true, url);

  for (const url of [
    'http://platform.deepseek.com/usage',
    'https://platform.deepseek.com.evil.test/usage',
    'https://deepseek.com/usage',
    'https://user@platform.deepseek.com/usage',
    'https://platform.deepseek.com:444/usage',
    'javascript:alert(1)',
  ]) assert.equal(isAllowedDeepSeekLoginUrl(url), false, url);
});

test('validates a captured token with only the account summary endpoint', async () => {
  const calls = [];
  const summary = await fetchDeepSeekSummary(
    JSON.stringify({ value: 'captured-token', __version: '0' }),
    async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(summaryPayload());
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${__test.DEEPSEEK_PLATFORM_ORIGIN}${__test.DEEPSEEK_ROUTES.summary}`);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer captured-token');
  assert.equal(summary.balance, 12.5);
});

test('force refresh bypasses an otherwise fresh provider-usage cache entry', () => {
  const cached = { at: 10_000, data: { marker: true } };
  assert.equal(shouldUseCachedUsage(cached, { nowMs: 10_500, maxAgeMs: 1_000 }), true);
  assert.equal(shouldUseCachedUsage(cached, { nowMs: 10_500, maxAgeMs: 1_000, force: true }), false);
  assert.equal(shouldUseCachedUsage(cached, { nowMs: 11_000, maxAgeMs: 1_000 }), false);
  assert.equal(shouldUseCachedUsage(cached, { nowMs: 9_999, maxAgeMs: 1_000 }), false);
});

test('a pre-aborted signal rejects without issuing a request', async (t) => {
  for (const [name, invoke] of [
    ['summary', fetchDeepSeekSummary],
    ['usage', fetchDeepSeekUsage],
  ]) {
    await t.test(name, async () => {
      const controller = new AbortController();
      controller.abort();
      let calls = 0;
      await assert.rejects(
        () => invoke('token', async () => {
          calls += 1;
          return jsonResponse(summaryPayload());
        }, { signal: controller.signal }),
        (error) => error instanceof ProviderUsageError
          && error.code === 'ABORTED'
          && /取消/.test(error.message),
      );
      assert.equal(calls, 0);
    });
  }
});

test('mid-request abort stops later month chunks even when fetch ignores its signal', async () => {
  const controller = new AbortController();
  let addedListeners = 0;
  let removedListeners = 0;
  const trackedSignal = {
    get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    addEventListener(...args) {
      addedListeners += 1;
      controller.signal.addEventListener(...args);
    },
    removeEventListener(...args) {
      removedListeners += 1;
      controller.signal.removeEventListener(...args);
    },
  };
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/v0/users/get_user_summary')) return jsonResponse(summaryPayload());
    if (url.includes('/usage/by_api_key/amount?')) {
      // Let both requests for the first chunk start, then abort. Both promises stay
      // pending to prove cancellation does not depend on the fetcher honoring signal.
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    }
    if (url.includes('/usage/by_api_key/cost?')) {
      return new Promise(() => {});
    }
    throw new Error(`unexpected URL after abort: ${url}`);
  };

  await assert.rejects(
    () => fetchDeepSeekUsage('token', fetcher, {
      startDate: '2026-08-31',
      endDate: '2026-10-01',
      signal: trackedSignal,
    }),
    (error) => error instanceof ProviderUsageError
      && error.code === 'ABORTED'
      && /取消/.test(error.message),
  );

  assert.equal(calls.length, 3);
  assert.equal(calls.filter((url) => url.includes('/usage/by_api_key/')).length, 2);
  assert.equal(calls.some((url) => url.includes('/api/v0/usage/amount?') || url.includes('/api/v0/usage/cost?')), false);
  assert.equal(addedListeners, removedListeners);
  assert.equal(addedListeners, 3);
});

test('completed requests remove their external abort listener', async () => {
  const controller = new AbortController();
  let addedListeners = 0;
  let removedListeners = 0;
  const trackedSignal = {
    get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    addEventListener(...args) {
      addedListeners += 1;
      controller.signal.addEventListener(...args);
    },
    removeEventListener(...args) {
      removedListeners += 1;
      controller.signal.removeEventListener(...args);
    },
  };

  await fetchDeepSeekSummary('token', async () => jsonResponse(summaryPayload()), { signal: trackedSignal });
  assert.equal(addedListeners, 1);
  assert.equal(removedListeners, 1);
});

test('falls back metric-by-metric to legacy month/year routes', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/v0/users/get_user_summary')) return jsonResponse(summaryPayload());
    if (url.includes('/usage/by_api_key/')) return jsonResponse({}, 404);
    if (url.includes('/api/v0/usage/amount?month=9&year=2026')) {
      return jsonResponse({
        code: 0,
        data: {
          biz_code: 0,
          biz_data: {
            days: [
              { date: '2026-09-01', data: [{ model: 'ignored-outside-range', usage: [{ type: 'PROMPT_TOKEN', amount: '999' }] }] },
              {
                date: '2026-09-02',
                data: [{
                  model: 'deepseek-chat',
                  usage: [
                    { type: 'PROMPT_TOKEN', amount: '100' },
                    { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '80' },
                    { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '20' },
                    { type: 'RESPONSE_TOKEN', amount: '5' },
                    { type: 'REQUEST', amount: '2' },
                  ],
                }],
              },
            ],
          },
        },
      });
    }
    if (url.includes('/api/v0/usage/cost?month=9&year=2026')) {
      return jsonResponse({
        code: 0,
        data: {
          biz_code: 0,
          biz_data: [{
            currency: 'CNY',
            days: [{
              date: '2026-09-02',
              data: [{
                model: 'deepseek-chat',
                usage: [
                  { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '0.10' },
                  { type: 'RESPONSE_TOKEN', amount: '0.20' },
                  { type: 'REQUEST', amount: '1000' },
                ],
              }],
            }],
          }],
        },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await fetchDeepSeekUsage('token', fetcher, {
    startDate: '2026-09-02',
    endDate: '2026-09-03',
  });

  assert.ok(calls.some((url) => url.endsWith('/api/v0/usage/amount?month=9&year=2026')));
  assert.ok(calls.some((url) => url.endsWith('/api/v0/usage/cost?month=9&year=2026')));
  assert.equal(result.coverage.source, 'legacy');
  assert.equal(result.coverage.tokens.legacyFallback, true);
  assert.equal(result.coverage.cost.legacyFallback, true);
  assert.equal(result.days.length, 2);
  assert.equal(result.days[0].tokens, 105);
  assert.ok(Math.abs(result.days[0].cost - 0.3) < 1e-12);
  assert.deepEqual(result.days[1].coverage, { tokens: true, cost: true });
  assert.equal(result.days[1].tokens, 0);
  assert.equal(result.days[1].cost, 0);
});

test('returns null instead of zero when a metric is unavailable', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/v0/users/get_user_summary')) return jsonResponse(summaryPayload());
    if (url.includes('/usage/by_api_key/amount?')) {
      return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { series: [] } } });
    }
    if (url.includes('/usage/by_api_key/cost?') || url.includes('/api/v0/usage/cost?')) {
      return jsonResponse({}, 503);
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await fetchDeepSeekUsage('token', fetcher, {
    startDate: '2026-09-01',
    endDate: '2026-09-02',
  });

  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.tokens.complete, true);
  assert.equal(result.coverage.cost.complete, false);
  assert.equal(result.summary.rangeCost, null);
  assert.equal(result.summary.peakDailyCost, null);
  assert.equal(result.days[0].tokens, 0);
  assert.equal(result.days[0].cost, null);
  assert.deepEqual(result.days[0].coverage, { tokens: true, cost: false });
  assert.deepEqual(result.coverage.issues, [{ period: '2026-09', metric: 'cost', code: 'HTTP_ERROR' }]);
  assert.equal(calls.some((url) => url.includes('/api/v0/usage/cost?')), false);
});

test('rejects non-empty summary fields that cannot be parsed', async (t) => {
  await t.test('unknown summary shape', async () => {
    await assert.rejects(
      () => fetchDeepSeekSummary('token', async () => jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { account: 'x' } } })),
      (error) => error.code === 'INVALID_RESPONSE',
    );
  });

  await t.test('malformed known summary field', async () => {
    await assert.rejects(
      () => fetchDeepSeekSummary('token', async () => jsonResponse({
        code: 0,
        data: { biz_code: 0, biz_data: { total_costs: [{ currency: 'CNY', amount: 'not-a-number' }] } },
      })),
      (error) => error.code === 'INVALID_RESPONSE',
    );
  });
});

test('marks malformed non-empty amount and cost schemas unavailable instead of complete zero usage', async (t) => {
  await t.test('amount schema', async () => {
    const calls = [];
    const fetcher = async (url) => {
      calls.push(url);
      if (url.endsWith('/api/v0/users/get_user_summary')) return jsonResponse(summaryPayload());
      if (url.includes('/usage/by_api_key/amount?')) {
        return jsonResponse({
          code: 0,
          data: { biz_code: 0, biz_data: { series: [{ model: 'deepseek-chat', buckets: [{ time: localMidnightSec('2026-09-01'), usage: { PROMPT_TOKEN: 'broken' } }] }] } },
        });
      }
      if (url.includes('/usage/by_api_key/cost?')) {
        return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { data: [] } } });
      }
      if (url.includes('/api/v0/usage/amount?')) return jsonResponse({}, 503);
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await fetchDeepSeekUsage('token', fetcher, { startDate: '2026-09-01', endDate: '2026-09-01' });
    assert.equal(result.coverage.tokens.complete, false);
    assert.equal(result.days[0].tokens, null);
    assert.equal(result.days[0].cost, 0);
    assert.deepEqual(result.coverage.issues, [{ period: '2026-09', metric: 'tokens', code: 'SCHEMA_INCOMPATIBLE' }]);
    assert.equal(calls.some((url) => url.includes('/api/v0/usage/amount?')), true);
  });

  await t.test('cost schema', async () => {
    const calls = [];
    const fetcher = async (url) => {
      calls.push(url);
      if (url.endsWith('/api/v0/users/get_user_summary')) return jsonResponse(summaryPayload());
      if (url.includes('/usage/by_api_key/amount?')) {
        return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { series: [] } } });
      }
      if (url.includes('/usage/by_api_key/cost?')) {
        return jsonResponse({
          code: 0,
          data: { biz_code: 0, biz_data: { data: [{ currency: 'CNY', series: [{ buckets: [{ time: localMidnightSec('2026-09-01'), cost: 'broken' }] }] }] } },
        });
      }
      if (url.includes('/api/v0/usage/cost?')) return jsonResponse({}, 503);
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await fetchDeepSeekUsage('token', fetcher, { startDate: '2026-09-01', endDate: '2026-09-01' });
    assert.equal(result.coverage.cost.complete, false);
    assert.equal(result.days[0].cost, null);
    assert.equal(result.days[0].tokens, 0);
    assert.deepEqual(result.coverage.issues, [{ period: '2026-09', metric: 'cost', code: 'SCHEMA_INCOMPATIBLE' }]);
    assert.equal(calls.some((url) => url.includes('/api/v0/usage/cost?')), true);
  });
});

test('does not call legacy routes after rate limits, server errors, or network failures', async (t) => {
  for (const scenario of [
    { name: 'HTTP 429', response: () => jsonResponse({}, 429), code: 'HTTP_ERROR' },
    { name: 'HTTP 503', response: () => jsonResponse({}, 503), code: 'HTTP_ERROR' },
    { name: 'network failure', response: () => { throw new Error('offline'); }, code: 'NETWORK_ERROR' },
  ]) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const fetcher = async (url) => {
        calls.push(url);
        if (url.endsWith('/api/v0/users/get_user_summary')) return jsonResponse(summaryPayload());
        if (url.includes('/usage/by_api_key/amount?')) {
          return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { series: [] } } });
        }
        if (url.includes('/usage/by_api_key/cost?')) return scenario.response();
        throw new Error(`unexpected legacy request: ${url}`);
      };

      const result = await fetchDeepSeekUsage('token', fetcher, { startDate: '2026-09-01', endDate: '2026-09-01' });
      assert.equal(result.coverage.cost.complete, false);
      assert.equal(result.days[0].cost, null);
      assert.deepEqual(result.coverage.issues, [{ period: '2026-09', metric: 'cost', code: scenario.code }]);
      assert.equal(calls.some((url) => url.includes('/api/v0/usage/cost?')), false);
    });
  }
});

test('legacy fallback eligibility excludes timeouts and generic response failures', () => {
  const failed = (code, status = null) => ({ ok: false, error: new ProviderUsageError('test', code, status) });
  assert.equal(__test.shouldFallbackToLegacy(failed('HTTP_ERROR', 404)), true);
  assert.equal(__test.shouldFallbackToLegacy(failed('HTTP_ERROR', 410)), true);
  assert.equal(__test.shouldFallbackToLegacy(failed('SCHEMA_INCOMPATIBLE')), true);
  assert.equal(__test.shouldFallbackToLegacy(failed('HTTP_ERROR', 429)), false);
  assert.equal(__test.shouldFallbackToLegacy(failed('HTTP_ERROR', 503)), false);
  assert.equal(__test.shouldFallbackToLegacy(failed('NETWORK_ERROR')), false);
  assert.equal(__test.shouldFallbackToLegacy(failed('TIMEOUT')), false);
  assert.equal(__test.shouldFallbackToLegacy(failed('INVALID_RESPONSE')), false);
});

test('splits a multi-month range into bounded start/end requests', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/v0/users/get_user_summary')) return jsonResponse(summaryPayload());
    if (url.includes('/by_api_key/amount?')) return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { series: [] } } });
    if (url.includes('/by_api_key/cost?')) return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { data: [] } } });
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await fetchDeepSeekUsage('token', fetcher, {
    startDate: '2026-08-31',
    endDate: '2026-09-01',
  });

  assert.equal(calls.filter((url) => url.includes('/by_api_key/')).length, 4);
  assert.ok(calls.some((url) => url.includes(`start=${localMidnightSec('2026-08-31')}&end=${localMidnightSec('2026-09-01')}`)));
  assert.ok(calls.some((url) => url.includes(`start=${localMidnightSec('2026-09-01')}&end=${localMidnightSec('2026-09-02')}`)));
  assert.deepEqual(result.days.map((day) => day.date), ['2026-08-31', '2026-09-01']);
  assert.equal(result.coverage.tokens.totalPeriods, 2);
});

test('maps HTTP and business authentication failures to AUTH_EXPIRED', async (t) => {
  await t.test('HTTP 401', async () => {
    const secret = 'sensitive-login-token';
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return jsonResponse({}, 401);
    };
    await assert.rejects(
      () => fetchDeepSeekUsage(secret, fetcher),
      (error) => {
        assert.ok(error instanceof ProviderUsageError);
        assert.equal(error.code, 'AUTH_EXPIRED');
        assert.equal(error.status, 401);
        assert.ok(!String(error.message).includes(secret));
        assert.ok(!JSON.stringify(error).includes(secret));
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  await t.test('business code 40003', async () => {
    const fetcher = async () => jsonResponse({ code: 40003, msg: 'expired' });
    await assert.rejects(
      () => fetchDeepSeekUsage('secret', fetcher),
      (error) => error.code === 'AUTH_EXPIRED',
    );
  });

  await t.test('HTTP 403 is not assumed to mean an expired credential', async () => {
    await assert.rejects(
      () => fetchDeepSeekUsage('secret', async () => jsonResponse({}, 403)),
      (error) => {
        assert.equal(error.code, 'HTTP_ERROR');
        assert.equal(error.status, 403);
        return true;
      },
    );
  });

  await t.test('HTTP 403 with an explicit expired business code is AUTH_EXPIRED', async () => {
    await assert.rejects(
      () => fetchDeepSeekUsage('secret', async () => jsonResponse({ code: 40002 }, 403)),
      (error) => error.code === 'AUTH_EXPIRED' && error.status === 403,
    );
  });
});

test('sanitizes fetch errors and validates date arguments', async () => {
  const secret = 'token-that-must-not-leak';
  const fetcher = async () => {
    throw new Error(`network failed with Authorization: Bearer ${secret}`);
  };
  await assert.rejects(
    () => fetchDeepSeekUsage(secret, fetcher),
    (error) => {
      assert.equal(error.code, 'NETWORK_ERROR');
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
  await assert.rejects(
    () => fetchDeepSeekUsage('token', async () => jsonResponse({}), { startDate: '2026-02-30', endDate: '2026-03-01' }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});
