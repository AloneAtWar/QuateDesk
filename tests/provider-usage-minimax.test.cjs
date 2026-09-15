// MiniMax 官方账号账单历史适配的单元测试。
// 接口语义参考 CodexBar 的 MiniMaxBillingHistory：platform.minimaxi.com/account/amount
// 分页（page/limit/aggregate=false），非 SUCCESS 记录跳过，created_at 优先于 ymd。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchMinimaxUsage,
  probeMinimaxSession,
  isAllowedMinimaxLoginUrl,
  isMinimaxCookieDomain,
  normalizeMinimaxOrigin,
  ProviderUsageError,
  __test,
} = require('../electron/provider-usage.cjs');

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const epochSec = (date) => {
  const [year, month, day] = date.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 1000) - 8 * 3600;
};

const record = (overrides) => ({
  consume_token: 100,
  consume_input_token: 80,
  consume_output_token: 20,
  consume_cash: 0.5,
  consume_cash_after_voucher: 0.4,
  created_at: epochSec('2026-09-10'),
  model: 'MiniMax-M2',
  method: 'chat.completion',
  result: 'SUCCESS',
  ...overrides,
});

const billingPayload = (records, total = null) => ({
  base_resp: { status_code: 0, status_msg: 'success' },
  charge_records: records,
  ...(total === null ? {} : { total_cnt: total }),
});

test('isAllowedMinimaxLoginUrl keeps the login hosts narrow', () => {
  assert.equal(isAllowedMinimaxLoginUrl('https://platform.minimaxi.com/user-center/payment/coding-plan'), true);
  assert.equal(isAllowedMinimaxLoginUrl('https://platform.minimax.io/user-center'), true);
  assert.equal(isAllowedMinimaxLoginUrl('https://evil-minimaxi.com'), false);
  assert.equal(isAllowedMinimaxLoginUrl('http://platform.minimaxi.com'), false);
  assert.equal(isAllowedMinimaxLoginUrl('not a url'), false);
});

test('isMinimaxCookieDomain accepts both TLD families', () => {
  assert.equal(isMinimaxCookieDomain('.minimaxi.com'), true);
  assert.equal(isMinimaxCookieDomain('platform.minimax.io'), true);
  assert.equal(isMinimaxCookieDomain('deepseek.com'), false);
});

test('normalizeMinimaxOrigin only trusts official hosts', () => {
  assert.equal(normalizeMinimaxOrigin('https://platform.minimax.io/x'), 'https://platform.minimax.io');
  assert.equal(normalizeMinimaxOrigin('https://evil.example.com'), 'https://platform.minimaxi.com');
});

test('fetchMinimaxUsage paginates billing records into daily cost+token buckets', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes('page=1&')) return jsonResponse(billingPayload([
      record({}),
      record({ consume_token: 50, consume_input_token: 30, consume_output_token: 20, consume_cash_after_voucher: 0.1, created_at: epochSec('2026-09-10'), model: 'abab6.5s' }),
      record({ created_at: epochSec('2026-09-09'), consume_cash_after_voucher: null, consume_cash: null }),
      record({ result: 'FAILED', consume_token: 99999 }),
      record({ created_at: epochSec('2025-01-01') }),
    ], 5));
    throw new Error('unexpected url ' + url);
  };
  const result = await fetchMinimaxUsage(fetcher, { startDate: '2026-09-09', endDate: '2026-09-10' });
  assert.equal(result.provider, 'minimax');
  assert.equal(result.metric, 'cost');
  assert.equal(result.currency, 'CNY');
  assert.equal(result.days.length, 2);
  const sep9 = result.days.find((day) => day.date === '2026-09-09');
  const sep10 = result.days.find((day) => day.date === '2026-09-10');
  assert.equal(sep10.tokens, 150);
  assert.equal(sep10.requests, 2);
  assert.ok(Math.abs(sep10.cost - 0.5) < 1e-9);
  assert.deepEqual(sep10.models.map((model) => model.model), ['MiniMax-M2', 'abab6.5s']);
  assert.equal(sep9.tokens, 100);
  assert.equal(sep9.cost, 0);
  assert.equal(result.summary.rangeCost, 0.5);
  assert.equal(result.summary.rangeTokens, 250);
  assert.equal(result.summary.requests, 3);
  assert.equal(result.summary.activeDays, 2);
  assert.equal(result.coverage.tokens.complete, true);
  assert.equal(calls.length, 1);
});

test('fetchMinimaxUsage falls back to token metric when all cash is zero', async () => {
  const fetcher = async (url) => {
    if (url.includes('page=1&')) return jsonResponse(billingPayload([
      record({ consume_cash: 0, consume_cash_after_voucher: 0 }),
    ], 1));
    throw new Error('unexpected url ' + url);
  };
  const result = await fetchMinimaxUsage(fetcher, { startDate: '2026-09-09', endDate: '2026-09-10' });
  assert.equal(result.metric, 'tokens');
  assert.equal(result.days.every((day) => day.cost === null), true);
  assert.equal(result.summary.rangeCost, null);
  assert.equal(result.summary.knownRangeCost, null);
  assert.equal(result.summary.rangeTokens, 100);
});

test('fetchMinimaxUsage stops at the range start using the oldest record date', async () => {
  const fetcher = async (url) => {
    if (url.includes('page=1&')) return jsonResponse(billingPayload([
      record({ created_at: epochSec('2026-09-10') }),
      record({ created_at: epochSec('2026-09-01') }),
    ], 9999));
    throw new Error('unexpected url ' + url);
  };
  const result = await fetchMinimaxUsage(fetcher, { startDate: '2026-09-09', endDate: '2026-09-10' });
  assert.equal(result.summary.rangeTokens, 100);
  assert.equal(result.coverage.tokens.complete, true);
});

test('fetchMinimaxUsage throws AUTH_EXPIRED when the session cookie is rejected', async () => {
  const fetcher = async () => jsonResponse({ base_resp: { status_code: 1004, status_msg: 'cookie is missing, log in again' } });
  await assert.rejects(
    () => fetchMinimaxUsage(fetcher, { startDate: '2026-09-09', endDate: '2026-09-10' }),
    (error) => error instanceof ProviderUsageError && error.code === 'AUTH_EXPIRED',
  );
});

test('fetchMinimaxUsage keeps partial data when a later page fails', async () => {
  const fetcher = async (url) => {
    if (url.includes('page=1&')) return jsonResponse(billingPayload([record({})], 300));
    throw new Error('page 2 boom');
  };
  const result = await fetchMinimaxUsage(fetcher, { startDate: '2026-09-09', endDate: '2026-09-10' });
  assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.issues.length, 1);
  assert.equal(result.summary.rangeTokens, null);
  assert.equal(result.summary.knownRangeTokens, 100);
});

test('minimax record helpers handle ymd variants and token fallbacks', () => {
  assert.equal(__test.minimaxRecordDate({ ymd: '20260910' }, 0), '2026-09-10');
  assert.equal(__test.minimaxRecordDate({ ymd: '2026/9/5' }, 0), '2026-09-05');
  assert.equal(__test.minimaxRecordDate({ consume_time: '2026-09-03 12:00:00' }, 0), '2026-09-03');
  assert.equal(__test.minimaxRecordDate({ created_at: epochSec('2026-09-10') }, 8 * 3600), '2026-09-10');
  assert.equal(__test.minimaxRecordTokens({ consume_token: 0, consume_input_token: 30, consume_output_token: 20 }), 50);
  assert.equal(__test.minimaxRecordTokens({ consume_token: 7, consume_input_token: 30, consume_output_token: 20 }), 7);
  assert.equal(__test.minimaxRecordSucceeded({ result: 'success' }), true);
  assert.equal(__test.minimaxRecordSucceeded({ result: 'FAILED' }), false);
  assert.equal(__test.minimaxRecordSucceeded({}), true);
});

test('probeMinimaxSession succeeds on a readable first page', async () => {
  const probe = await probeMinimaxSession(async () => jsonResponse(billingPayload([], 0)));
  assert.equal(probe.records, 0);
  await assert.rejects(
    () => probeMinimaxSession(async () => jsonResponse({ base_resp: { status_code: 1004, status_msg: 'cookie is missing' } })),
    (error) => error.code === 'AUTH_EXPIRED',
  );
});
