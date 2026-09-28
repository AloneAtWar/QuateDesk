// 规范化层:模型名归一、HMAC 稳定性、安全整数守卫、时区日期边界。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalModelKey, modelDisplayName, hmacHex, safeTokenCount, buildUsageEvent,
  isValidTimeZone, isValidDateString, localDateString, shiftDateString,
  buildDayBoundaries, computeStreaks, normalizeModelRules, createModelRuleMatcher,
} = require('../electron/cli-usage/normalize.cjs');

test('canonicalModelKey 保守归一:NFKC、空格折叠、大小写、平台前缀', () => {
  assert.equal(canonicalModelKey('  GLM-4.7 '), 'glm-4.7');
  assert.equal(canonicalModelKey('glm-4.7'), 'glm-4.7');
  assert.equal(canonicalModelKey('GLM　4.7'.replace('　', ' ')), 'glm 4.7'); // 连续空格折叠成单个
  assert.equal(canonicalModelKey('kimi-code/kimi-for-coding'), 'kimi-for-coding');
  assert.equal(canonicalModelKey('Kimi-Code/Kimi-For-Coding'), 'kimi-for-coding');
  assert.equal(canonicalModelKey('anthropic/claude-sonnet-4-5'), 'claude-sonnet-4-5');
  assert.equal(canonicalModelKey(null), null);
  assert.equal(canonicalModelKey('   '), null);
  assert.equal(canonicalModelKey(''), null);
});

test('canonicalModelKey 不把不同版本强行归并', () => {
  const set = new Set(['claude-sonnet-4', 'claude-sonnet-4-5', 'glm-4.6', 'glm-4.7'].map(canonicalModelKey));
  assert.equal(set.size, 4);
});

test('modelDisplayName 去掉平台前缀,未知模型兜底', () => {
  assert.equal(modelDisplayName('kimi-code/kimi-for-coding'), 'kimi-for-coding');
  assert.equal(modelDisplayName(null), '未知模型');
  assert.equal(modelDisplayName('GLM-5.3'), 'GLM-5.3');
});

test('模型规则匹配规范化名称，支持完全匹配与忽略大小写的正则', () => {
  assert.deepEqual(normalizeModelRules([{ mode: 'exact', value: ' Anthropic/Claude-Sonnet-4-5 ' }]), [
    { mode: 'exact', value: 'claude-sonnet-4-5' },
  ]);
  const matchesClaude = createModelRuleMatcher([{ mode: 'regex', value: '^CLAUDE(?:-|$)' }]);
  assert.equal(matchesClaude('claude-sonnet-4-5'), true);
  assert.equal(matchesClaude(null, 'anthropic/Claude-Opus-4'), true);
  assert.equal(matchesClaude('gpt-5.6-sol'), false);
  const matchesExact = createModelRuleMatcher([{ mode: 'exact', value: 'openai/gpt-5.6-sol' }]);
  assert.equal(matchesExact('gpt-5.6-sol'), true);
  assert.equal(matchesExact('gpt-5.6-terra'), false);
  assert.equal(createModelRuleMatcher([])('glm-4.7'), false);
  assert.equal(createModelRuleMatcher(null)('anything'), true);
});

test('模型规则拒绝空内容、未知模式与无效正则', () => {
  assert.throws(() => normalizeModelRules([{ mode: 'regex', value: '(' }]), /正则无效/);
  assert.throws(() => normalizeModelRules([{ mode: 'prefix', value: 'glm-' }]), /匹配方式/);
  assert.throws(() => normalizeModelRules([{ mode: 'exact', value: ' ' }]), /不能为空/);
});

test('hmacHex 同 salt 稳定、不同值不同、截断到 24 位', () => {
  const salt = 'salt-a';
  assert.equal(hmacHex('session-1', salt), hmacHex('session-1', salt));
  assert.notEqual(hmacHex('session-1', salt), hmacHex('session-2', salt));
  assert.equal(hmacHex('x', salt).length, 24);
  const re = /^[0-9a-f]{24}$/;
  assert.match(hmacHex('/private/project/path', salt), re);
});

test('safeTokenCount 丢弃负数、NaN、Infinity 与超出安全整数的值', () => {
  assert.equal(safeTokenCount(100), 100);
  assert.equal(safeTokenCount('123'), 123);
  assert.equal(safeTokenCount(-1), null);
  assert.equal(safeTokenCount(Number.NaN), null);
  assert.equal(safeTokenCount(Number.POSITIVE_INFINITY), null);
  assert.equal(safeTokenCount(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(safeTokenCount(null), null);
});

test('buildUsageEvent 统一公式:classified/extra/total', () => {
  const event = buildUsageEvent({
    eventKey: 'k:r:1', agent: 'kimi', occurredAtMs: Date.now(), sessionKey: 's', model: 'M1',
    inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10, outputTokens: 40,
    reasoningTokens: 5, providerTotalTokens: 215,
  });
  assert.equal(event.totalTokens, 215); // 取厂商总数
  assert.equal(event.extraTokens, 15);  // 215 - classified 200
  assert.ok(event.reasoningTokens <= event.outputTokens); // 展示子集,不入 total
});

test('buildUsageEvent 无厂商总数时 total = classified,非法时间戳丢弃', () => {
  const event = buildUsageEvent({
    eventKey: 'k:r:2', agent: 'kimi', occurredAtMs: 1782000000000, sessionKey: 's', model: 'M',
    inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 5,
  });
  assert.equal(event.totalTokens, 20);
  assert.equal(event.extraTokens, 0);
  assert.equal(buildUsageEvent({ eventKey: 'x', occurredAtMs: 0, agent: 'a' }), null);
  assert.equal(buildUsageEvent({ eventKey: 'x', occurredAtMs: Number.NaN, agent: 'a' }), null);
});

test('时区工具:校验与本地日期', () => {
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidDateString('2026-09-23'), true);
  assert.equal(isValidDateString('2026-02-30'), false);
  assert.equal(isValidDateString('20260923'), false);
  // 2026-09-23T18:00Z 是上海 2026-09-24 凌晨 2 点
  assert.equal(localDateString('Asia/Shanghai', Date.UTC(2026, 8, 23, 18)), '2026-09-24');
  assert.equal(localDateString('UTC', Date.UTC(2026, 8, 23, 18)), '2026-09-23');
  assert.equal(shiftDateString('2026-09-23', -30), '2026-08-24');
});

test('buildDayBoundaries 上海时区:UTC+8 无 DST,边界整天对齐', () => {
  const boundaries = buildDayBoundaries('Asia/Shanghai', '2026-09-23', 3);
  assert.equal(boundaries.length, 3);
  assert.equal(boundaries[0].date, '2026-09-21');
  assert.equal(boundaries[2].date, '2026-09-23');
  assert.equal(boundaries[0].startMs, Date.UTC(2026, 8, 20, 16)); // 上海 00:00 = UTC 16:00 前一天
  assert.equal(boundaries[0].endMs, boundaries[1].startMs);
});

test('buildDayBoundaries 含 DST 时区边界仍连续无缝', () => {
  const boundaries = buildDayBoundaries('America/New_York', '2026-03-08', 3); // 春令时切换日
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    assert.equal(boundaries[index].endMs, boundaries[index + 1].startMs);
  }
  // 切换日(2026-03-08)只有 23 小时,相邻边界仍衔接
  assert.equal(boundaries[2].endMs - boundaries[2].startMs, 23 * 3600 * 1000);
});

test('computeStreaks 今天没有用量时从昨天起算', () => {
  assert.deepEqual(computeStreaks([0, 5, 3, 0]), { current: 2, longest: 2 });
  assert.deepEqual(computeStreaks([0, 5, 3, 2]), { current: 3, longest: 3 });
  assert.deepEqual(computeStreaks([0, 0, 0, 0]), { current: 0, longest: 0 });
  assert.deepEqual(computeStreaks([]), { current: 0, longest: 0 });
});
