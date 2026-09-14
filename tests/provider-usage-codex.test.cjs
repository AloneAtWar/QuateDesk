// Codex（ChatGPT 订阅）token-activity 规范化的单元测试。
// 字段对齐 codex-rs 的 TokenUsageProfile：stats.{lifetime_tokens, peak_daily_tokens,
// current_streak_days, longest_streak_days, daily_usage_buckets[{start_date, tokens}]}。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCodexUsageRequest,
  normalizeCodexTokenUsage,
  ProviderUsageError,
  __test,
} = require('../electron/provider-usage.cjs');

const profilePayload = () => ({
  stats: {
    lifetime_tokens: 987654,
    peak_daily_tokens: 50000,
    longest_running_turn_sec: 1320,
    current_streak_days: 6,
    longest_streak_days: 21,
    daily_usage_buckets: [
      { start_date: '2026-09-01', tokens: 12000 },
      { start_date: '2026-09-03', tokens: 30000 },
    ],
  },
});

test('buildCodexUsageRequest targets the wham profile endpoint with CLI headers', () => {
  const request = buildCodexUsageRequest({ tokens: { access_token: 'at', account_id: 'acc-1' } });
  assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/profiles/me');
  assert.equal(request.init.headers.Authorization, 'Bearer at');
  assert.equal(request.init.headers['ChatGPT-Account-Id'], 'acc-1');
  assert.equal(request.init.headers['User-Agent'], 'codex-cli');
  const noAccount = buildCodexUsageRequest({ tokens: { access_token: 'at' } });
  assert.equal('ChatGPT-Account-Id' in noAccount.init.headers, false);
});

test('normalizeCodexTokenUsage fills a continuous daily series with zeros', () => {
  const result = normalizeCodexTokenUsage(profilePayload(), { startDate: '2026-08-31', endDate: '2026-09-03' });
  assert.equal(result.provider, 'codex');
  assert.equal(result.metric, 'tokens');
  assert.equal(result.currency, null);
  assert.equal(result.days.length, 4);
  assert.deepEqual(result.days.map((day) => [day.date, day.tokens]), [
    ['2026-08-31', 0],
    ['2026-09-01', 12000],
    ['2026-09-02', 0],
    ['2026-09-03', 30000],
  ]);
  assert.equal(result.summary.totalTokens, 987654);
  assert.equal(result.summary.rangeTokens, 42000);
  assert.equal(result.summary.peakDailyTokens, 50000);
  assert.equal(result.summary.currentStreakDays, 6);
  assert.equal(result.summary.longestStreakDays, 21);
  assert.equal(result.summary.activeDays, 2);
  assert.equal(result.coverage.tokens.complete, true);
  assert.equal(result.coverage.partial, false);
  assert.equal(result.days[0].cost, null);
  assert.equal(result.days[0].requests, null);
});

test('normalizeCodexTokenUsage merges duplicate buckets and ignores out-of-range days', () => {
  const payload = profilePayload();
  payload.stats.daily_usage_buckets.push({ start_date: '2026-09-01', tokens: 8000 });
  payload.stats.daily_usage_buckets.push({ start_date: '2025-01-01', tokens: 999999 });
  const result = normalizeCodexTokenUsage(payload, { startDate: '2026-09-01', endDate: '2026-09-01' });
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].tokens, 20000);
  assert.equal(result.summary.rangeTokens, 20000);
});

test('normalizeCodexTokenUsage marks days uncovered when buckets are absent', () => {
  const payload = profilePayload();
  delete payload.stats.daily_usage_buckets;
  const result = normalizeCodexTokenUsage(payload, { startDate: '2026-09-01', endDate: '2026-09-03' });
  assert.equal(result.days.every((day) => day.tokens === null), true);
  assert.equal(result.summary.rangeTokens, null);
  assert.equal(result.summary.knownRangeTokens, 0);
  assert.equal(result.summary.totalTokens, 987654);
  assert.equal(result.coverage.tokens.complete, false);
  assert.equal(result.coverage.issues[0].code, 'NO_DAILY_BUCKETS');
});

test('normalizeCodexTokenUsage rejects incompatible payloads and bad ranges', () => {
  assert.throws(() => normalizeCodexTokenUsage({}), (error) => error instanceof ProviderUsageError && error.code === 'SCHEMA_INCOMPATIBLE');
  assert.throws(() => normalizeCodexTokenUsage({ stats: { daily_usage_buckets: [{ start_date: 'not-a-date', tokens: 1 }] } }), (error) => error.code === 'SCHEMA_INCOMPATIBLE');
  assert.throws(() => normalizeCodexTokenUsage(profilePayload(), { startDate: '2026-09-02', endDate: '2026-09-01' }), /startDate 不能晚于 endDate/);
});

test('normalizeCodexTokenUsage defaults to the UTC calendar for range fallback', () => {
  const result = normalizeCodexTokenUsage(profilePayload(), { nowMs: Date.UTC(2026, 8, 15, 12, 0, 0) });
  assert.equal(result.coverage.timezoneOffsetSec, 0);
  assert.equal(result.coverage.end, '2026-09-15');
});
