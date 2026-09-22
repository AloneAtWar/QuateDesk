// Xiaomi MiMo Token Plan 适配的单元测试。
// 接口语义参考 Javis603/token-monitor（src/shared/providers/mimo/limits.js）与
// cc-switch issue #2488 社区抓包：platform.xiaomimimo.com/api/v1 下的
// tokenPlan/usage（data.usage.items 的 plan_total_token 或 data.monthUsage.items
// 的 month_total_token）、tokenPlan/detail（currentPeriodEnd 重置时间）与
// balance（钱包余额）。percent 是 0–1 比例而非百分比（token-monitor #292）。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchMimoSnapshot,
  fetchMimoUsage,
  probeMimoSession,
  isAllowedMimoLoginUrl,
  isMimoCookieDomain,
  mimoCookieHeader,
  ProviderUsageError,
  __test,
} = require('../electron/provider-usage.cjs');
const { __mimo } = require('../electron/poller.cjs');

const jsonResponse = (payload, { status = 200, url = 'https://platform.xiaomimimo.com/api/v1/x' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  json: async () => payload,
});

const usagePayload = (items, container = 'usage') => ({
  code: 0,
  data: { [container]: { items, percent: 0.32 } },
});

const detailPayload = (overrides = {}) => ({
  code: 0,
  data: { planCode: 'Pro', planStatus: 'active', currentPeriodEnd: '2027-05-27 23:59:59', ...overrides },
});

const balancePayload = (overrides = {}) => ({
  code: 0,
  data: { balance: '12.34', cashBalance: '10.00', giftBalance: '2.34', currency: 'CNY', ...overrides },
});

const snapshotFetcher = ({ usage = usagePayload([{ name: 'plan_total_token', used: 1.2e11, limit: 4.56e11, percent: 0.263 }]), detail = detailPayload(), balance = balancePayload() } = {}) =>
  async (url) => {
    if (url.includes('/tokenPlan/usage')) return jsonResponse(usage);
    if (url.includes('/tokenPlan/detail')) return jsonResponse(detail);
    if (url.includes('/balance')) return jsonResponse(balance);
    throw new Error(`unexpected url ${url}`);
  };

test('isAllowedMimoLoginUrl allows the platform and Xiaomi passport hosts only', () => {
  assert.equal(isAllowedMimoLoginUrl('https://platform.xiaomimimo.com/console/plan-manage'), true);
  assert.equal(isAllowedMimoLoginUrl('https://platform.xiaomimimo.com/api/v1/genLoginUrl?currentPath=%2F'), true);
  assert.equal(isAllowedMimoLoginUrl('https://account.xiaomi.com/fe/service/login?sid=api-platform'), true);
  assert.equal(isAllowedMimoLoginUrl('https://i.account.xiaomi.com/fe/service/login'), true);
  assert.equal(isAllowedMimoLoginUrl('https://evil.xiaomi.com.example.com'), false);
  assert.equal(isAllowedMimoLoginUrl('http://platform.xiaomimimo.com'), false);
  assert.equal(isAllowedMimoLoginUrl('https://platform.xiaomimimo.com:8443/'), false);
  assert.equal(isAllowedMimoLoginUrl('not a url'), false);
});

test('isMimoCookieDomain covers platform session and Xiaomi passport cookies', () => {
  assert.equal(isMimoCookieDomain('.platform.xiaomimimo.com'), true);
  assert.equal(isMimoCookieDomain('.xiaomimimo.com'), true);
  assert.equal(isMimoCookieDomain('account.xiaomi.com'), true);
  assert.equal(isMimoCookieDomain('.xiaomi.com'), true);
  assert.equal(isMimoCookieDomain('xiaomimimo.com.evil.com'), false);
  assert.equal(isMimoCookieDomain('minimaxi.com'), false);
});

test('mimoCookieHeader only sends xiaomimimo.com cookies to the platform API', () => {
  const cookies = [
    { name: 'api-platform_serviceToken', value: 'tok', domain: '.platform.xiaomimimo.com' },
    { name: 'userId', value: '123', domain: '.xiaomimimo.com' },
    { name: 'passToken', value: 'secret', domain: '.xiaomi.com' },
    { name: 'serviceToken', value: 'passport', domain: 'account.xiaomi.com' },
    { name: '', value: 'x', domain: '.platform.xiaomimimo.com' },
  ];
  const header = mimoCookieHeader(cookies);
  assert.match(header, /api-platform_serviceToken=tok/);
  assert.match(header, /userId=123/);
  assert.equal(header.includes('passToken'), false);
  assert.equal(header.includes('passport'), false);
});

test('mimoUsageItem reads plan_total_token and falls back to month shape', () => {
  const plan = __test.mimoUsageItem(usagePayload([
    { name: 'compensation_total_token', used: 1, limit: 10 },
    { name: 'plan_total_token', used: 25, limit: 100, percent: 0.25 },
  ]), ['plan_total_token', 'month_total_token']);
  assert.equal(plan.name, 'plan_total_token');
  assert.equal(plan.used, 25);
  assert.equal(plan.limit, 100);
  assert.equal(plan.usedPercent, 25);

  const month = __test.mimoUsageItem({
    code: 0,
    data: { monthUsage: { items: [{ name: 'month_total_token', used: 40, limit: 200 }] } },
  }, ['plan_total_token', 'month_total_token']);
  assert.equal(month.name, 'month_total_token');
  assert.equal(month.usedPercent, 20);
});

test('mimoUsageItem treats percent as a 0-1 ratio, never a percentage', () => {
  // token-monitor #292：用尽后的 percent 会超过 1（如 1.005），按百分比读会把
  // 用尽的套餐看成 99% 剩余
  const spent = __test.mimoUsageItem(usagePayload([
    { name: 'plan_total_token', used: 1.005e11, limit: 1e11, percent: 1.005 },
  ]), ['plan_total_token']);
  assert.equal(spent.usedPercent, 100);

  const ratioOnly = __test.mimoUsageItem(usagePayload([
    { name: 'plan_total_token', percent: 0.5 },
  ]), ['plan_total_token']);
  assert.equal(ratioOnly.usedPercent, 50);
});

test('mimoPlanDetail parses plan label, status and UTC period end', () => {
  const detail = __test.mimoPlanDetail(detailPayload());
  assert.equal(detail.label, 'Pro');
  assert.equal(detail.active, true);
  assert.equal(detail.expired, false);
  assert.equal(detail.resetsAt, '2027-05-27T23:59:59.000Z');

  const expired = __test.mimoPlanDetail(detailPayload({ planStatus: 'expired', currentPeriodEnd: '2026-01-01 00:00:00' }));
  assert.equal(expired.expired, true);
  assert.equal(expired.active, false);

  const iso = __test.mimoPlanDetail(detailPayload({ currentPeriodEnd: '2027-05-27T23:59:59+08:00' }));
  assert.equal(iso.resetsAt, '2027-05-27T15:59:59.000Z');

  assert.equal(__test.mimoPlanDetail({ code: 0, data: {} }).resetsAt, null);
});

test('mimoBalanceOf parses string amounts and defaults the currency', () => {
  const balance = __test.mimoBalanceOf(balancePayload());
  assert.equal(balance.balance, 12.34);
  assert.equal(balance.cashBalance, 10);
  assert.equal(balance.giftBalance, 2.34);
  assert.equal(balance.currency, 'CNY');
  assert.equal(__test.mimoBalanceOf({ code: 0, data: { balance: '5', currency: 'USD' } }).currency, 'USD');
  assert.equal(__test.mimoBalanceOf({ code: 0, data: {} }).balance, null);
});

test('probeMimoSession succeeds when the balance endpoint answers', async () => {
  const balance = await probeMimoSession(snapshotFetcher(), { timeoutMs: 1000 });
  assert.equal(balance.balance, 12.34);
});

test('probeMimoSession fails on a missing balance field', async () => {
  await assert.rejects(
    () => probeMimoSession(snapshotFetcher({ balance: { code: 0, data: {} } }), { timeoutMs: 1000 }),
    (error) => error instanceof ProviderUsageError && error.code === 'SCHEMA_INCOMPATIBLE',
  );
});

test('fetchMimoSnapshot merges usage, detail and balance', async () => {
  const snapshot = await fetchMimoSnapshot(snapshotFetcher(), { timeoutMs: 1000 });
  assert.equal(snapshot.plan.limit, 4.56e11);
  assert.equal(snapshot.detail.label, 'Pro');
  assert.equal(snapshot.balance.balance, 12.34);
});

test('fetchMimoSnapshot degrades gracefully when detail or balance fail', async () => {
  const fetcher = async (url) => {
    if (url.includes('/tokenPlan/usage')) return jsonResponse(usagePayload([{ name: 'plan_total_token', used: 1, limit: 10 }]));
    throw new Error('network hiccup');
  };
  const snapshot = await fetchMimoSnapshot(fetcher, { timeoutMs: 1000 });
  assert.equal(snapshot.plan.limit, 10);
  assert.equal(snapshot.detail, null);
  assert.equal(snapshot.balance, null);
});

test('expired session (redirect to Xiaomi passport) maps to AUTH_EXPIRED', async () => {
  const fetcher = async () => jsonResponse({}, { status: 200, url: 'https://account.xiaomi.com/fe/service/login?sid=api-platform' });
  await assert.rejects(
    () => fetchMimoSnapshot(fetcher, { timeoutMs: 1000 }),
    (error) => error.code === 'AUTH_EXPIRED',
  );
});

test('plain 401/403 and body code 401 map to AUTH_EXPIRED', async () => {
  const unauthorized = async () => jsonResponse({ code: 0 }, { status: 401 });
  await assert.rejects(
    () => fetchMimoSnapshot(unauthorized, { timeoutMs: 1000 }),
    (error) => error.code === 'AUTH_EXPIRED',
  );
  const bodyCode = async () => jsonResponse({ code: 401, message: 'unauthorized' });
  await assert.rejects(
    () => probeMimoSession(bodyCode, { timeoutMs: 1000 }),
    (error) => error.code === 'AUTH_EXPIRED',
  );
});

test('business failure surfaces the platform message', async () => {
  const fetcher = async () => jsonResponse({ code: 500, message: 'boom' });
  await assert.rejects(
    () => probeMimoSession(fetcher, { timeoutMs: 1000 }),
    (error) => error.code === 'PLATFORM_ERROR' && error.message.includes('boom'),
  );
});

test('fetchMimoUsage returns the shared shape with plan summary and empty days', async () => {
  const data = await fetchMimoUsage(snapshotFetcher(), { startDate: '2026-09-01', endDate: '2026-09-22', timeoutMs: 1000 });
  assert.equal(data.provider, 'mimo');
  assert.deepEqual(data.days, []);
  assert.equal(data.summary.planName, 'Pro');
  assert.equal(data.summary.balance, 12.34);
  assert.equal(data.summary.planCreditsLimit, 4.56e11);
  assert.equal(data.summary.planCreditsUsed, 1.2e11);
  assert.equal(data.coverage.partial, true);
});

test('queryMimoQuota maps plan credits to the mimo_plan window in 亿', async () => {
  const meter = (key, remaining, total, unit, resetAt, extra = {}) => ({ key, remaining, total, unit, resetAt, ...extra });
  const windows = await __mimo.queryMimoQuota(snapshotFetcher(), meter, 1000, {
    providerUsageAuth: JSON.stringify({ cookies: [{ name: 'api-platform_serviceToken', value: 'tok', domain: '.platform.xiaomimimo.com' }] }),
  });
  assert.equal(windows.length, 1);
  const plan = windows[0];
  assert.equal(plan.key, 'mimo_plan');
  assert.equal(plan.unit, '%');
  // 1.2e11 / 4.56e11 ≈ 26.32% 已用 → 剩余 ≈ 73.68
  assert.ok(Math.abs(plan.remaining - (100 - (1.2e11 / 4.56e11) * 100)) < 0.01);
  assert.equal(plan.limitAmount, 4560);
  assert.equal(plan.amount, Number(((4.56e11 - 1.2e11) / 1e8).toFixed(2)));
  assert.equal(plan.resetAt, '2027-05-27T23:59:59.000Z');
});

test('queryMimoQuota never surfaces the wallet balance as a quota window', async () => {
  const meter = (key) => ({ key });
  // 钱包有余额也不出 balance 窗口：额度窗口只保留套餐 Credits
  const windows = await __mimo.queryMimoQuota(snapshotFetcher({ balance: balancePayload({ balance: '88.5' }) }), meter, 1000, {
    providerUsageAuth: JSON.stringify({ cookies: [{ name: 'api-platform_serviceToken', value: 'tok', domain: '.platform.xiaomimimo.com' }] }),
  });
  assert.deepEqual(windows.map((window) => window.key), ['mimo_plan']);
});

test('queryMimoQuota requires a saved login and rejects expired sessions with reauth_required', async () => {
  const meter = () => ({});
  await assert.rejects(
    () => __mimo.queryMimoQuota(snapshotFetcher(), meter, 1000, {}),
    (error) => error.authStatus === 'reauth_required' && /尚未连接小米账号/.test(error.message),
  );
  await assert.rejects(
    () => __mimo.queryMimoQuota(snapshotFetcher(), meter, 1000, { providerUsageAuth: JSON.stringify({ cookies: [{ name: 'passToken', value: 'x', domain: '.xiaomi.com' }] }) }),
    (error) => error.authStatus === 'reauth_required' && /Cookie 缺失/.test(error.message),
  );
  const expired = async () => jsonResponse({}, { status: 200, url: 'https://account.xiaomi.com/fe/service/login' });
  await assert.rejects(
    () => __mimo.queryMimoQuota(expired, meter, 1000, {
      providerUsageAuth: JSON.stringify({ cookies: [{ name: 'api-platform_serviceToken', value: 'tok', domain: '.platform.xiaomimimo.com' }] }),
    }),
    (error) => error.authStatus === 'reauth_required' && /已失效/.test(error.message),
  );
});

test('queryMimoQuota throws a plain error when the account has no plan', async () => {
  const meter = () => ({});
  const fetcher = snapshotFetcher({
    usage: usagePayload([{ name: 'compensation_total_token', used: 0, limit: 0 }]),
    balance: balancePayload({ balance: '99' }),
  });
  await assert.rejects(
    () => __mimo.queryMimoQuota(fetcher, meter, 1000, {
      providerUsageAuth: JSON.stringify({ cookies: [{ name: 'api-platform_serviceToken', value: 'tok', domain: '.platform.xiaomimimo.com' }] }),
    }),
    (error) => error.authStatus === undefined && /没有识别到 Token Plan 套餐 Credits/.test(error.message),
  );
});

test('readMimoAuthCookies tolerates malformed snapshots', () => {
  assert.equal(__mimo.readMimoAuthCookies({}).length, 0);
  assert.equal(__mimo.readMimoAuthCookies({ providerUsageAuth: 'not json' }).length, 0);
  assert.equal(__mimo.readMimoAuthCookies({ providerUsageAuth: JSON.stringify({ cookies: [{ name: 'a', value: 'b', domain: '.platform.xiaomimimo.com' }] }) }).length, 1);
});
