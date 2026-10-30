const test = require('node:test');
const assert = require('node:assert/strict');
const { medianGapMs, detectCycleClose, extractCycles, mergeCycles, dedupeCycles, purgeGhostCycles, computeWasteStats, resolveWasteWindows, repairDowngradedCycles } = require('../electron/waste.cjs');

const T0 = Date.parse('2026-09-01T02:00:00Z'); // 周期重置时刻（周二 10:00 +08）
const H = 3_600_000;
const D = 86_400_000;

// 构造一串 5 分钟间隔的周窗口快照：resetAt 固定，剩余率按给定序列变化
const weeklyPoints = (resetAt, remainings, startMs = T0 - 7 * D) =>
  remainings.map((remaining, index) => ({
    at: new Date(startMs + index * 5 * 60_000).toISOString(),
    windows: { weekly: { remaining, amount: remaining * 35, limit: 3500, unit: '%', resetAt } },
  }));

test('medianGapMs 取间隔中位数，点太少回退 5 分钟', () => {
  assert.equal(medianGapMs([]), 5 * 60_000);
  assert.equal(medianGapMs(weeklyPoints('2026-09-01T02:00:00Z', [50, 40, 30, 20])), 5 * 60_000);
  const sparse = [0, 5, 10, 30, 35].map((m) => ({ at: new Date(T0 + m * 60_000).toISOString() }));
  assert.equal(medianGapMs(sparse), 5 * 60_000);
});

test('detectCycleClose：resetAt 变晚且旧重置时刻已过 → 自然到期', () => {
  const prev = { remaining: 34, resetAt: '2026-09-01T02:00:00Z' };
  const curr = { remaining: 98, resetAt: '2026-09-08T02:00:00Z' };
  const close = detectCycleClose(prev, curr, T0 - 5 * 60_000, T0 + 5 * 60_000);
  assert.deepEqual(close, { kind: 'natural', end: T0 });
});

test('detectCycleClose：滑动窗口 resetAt 持续后移但永远在将来 → 不算周期结束', () => {
  // 每次轮询 resetAt 都是「现在 + 7 天」，后移 5 分钟在抖动容差内，且旧 resetAt 还没到
  const prev = { remaining: 60, resetAt: new Date(T0 + 7 * D).toISOString() };
  const curr = { remaining: 55, resetAt: new Date(T0 + 7 * D + 5 * 60_000).toISOString() };
  assert.equal(detectCycleClose(prev, curr, T0 - 5 * 60_000, T0), null);
  // 轮询间隔 10 分钟时后移步长也约 10 分钟（超出抖动容差），同样是滑动窗口而非提前重置
  const prev2 = { remaining: 60, resetAt: new Date(T0 + 7 * D).toISOString() };
  const curr2 = { remaining: 55, resetAt: new Date(T0 + 7 * D + 10 * 60_000).toISOString() };
  assert.equal(detectCycleClose(prev2, curr2, T0 - 10 * 60_000, T0), null);
});

test('detectCycleClose：resetAt 变早 → 厂商提前重置', () => {
  const prev = { remaining: 22, resetAt: '2026-09-08T02:00:00Z' };
  const curr = { remaining: 96, resetAt: '2026-09-05T02:00:00Z' };
  const prevAt = T0 - 5 * 60_000;
  const close = detectCycleClose(prev, curr, prevAt, T0);
  assert.deepEqual(close, { kind: 'early', end: prevAt });
});

test('detectCycleClose：resetAt 为数值型毫秒时间戳（Z.ai 场景）→ 照常判定', () => {
  // 9/9 17:57 剩 5%、resetAt=18:00:07；18:02 剩 99%、resetAt 变为下周：旧重置时刻已被跨过 → 自然到期
  const prevAt = Date.parse('2026-09-09T09:57:25Z');
  const currAt = Date.parse('2026-09-09T10:02:25Z');
  const prev = { remaining: 5, resetAt: Date.parse('2026-09-09T10:00:07Z') };
  const curr = { remaining: 99, resetAt: Date.parse('2026-09-16T10:00:07Z') };
  assert.deepEqual(detectCycleClose(prev, curr, prevAt, currAt), { kind: 'natural', end: prev.resetAt });
  // 秒级时间戳同样兼容
  const prevSec = { remaining: 5, resetAt: Math.floor(prev.resetAt / 1000) };
  const currSec = { remaining: 99, resetAt: Math.floor(curr.resetAt / 1000) };
  assert.deepEqual(detectCycleClose(prevSec, currSec, prevAt, currAt).kind, 'natural');
});

test('detectCycleClose：resetAt 没变 → 同一周期，即使剩余率回升也不算重置', () => {
  const reset = '2026-09-08T02:00:00Z';
  const prevAt = T0 - 5 * 60_000;
  assert.equal(detectCycleClose({ remaining: 40, resetAt: reset }, { remaining: 100, resetAt: reset }, prevAt, T0), null);
  assert.equal(detectCycleClose({ remaining: 40, resetAt: reset }, { remaining: 50, resetAt: reset }, prevAt, T0), null);
});

test('detectCycleClose：resetAt 变晚但旧重置时刻还没到 → 提前重置（wlbclub 场景）', () => {
  // 9/13 10:05 检测时说 9/14 重置，9/13 10:10 检测时变成 9/20 重置：两次轮询之间没有跨越 9/14
  const prevAt = Date.parse('2026-09-13T02:05:00Z');
  const currAt = Date.parse('2026-09-13T02:10:00Z');
  const prev = { remaining: 51.6, resetAt: '2026-09-14T02:00:00Z' };
  const curr = { remaining: 100, resetAt: '2026-09-20T02:00:00Z' };
  assert.deepEqual(detectCycleClose(prev, curr, prevAt, currAt), { kind: 'early', end: prevAt });
});

test('detectCycleClose：resetAt 缺失 → 无法判定周期边界，不算结束', () => {
  const prevAt = T0 - 5 * 60_000;
  assert.equal(detectCycleClose({ remaining: 40, resetAt: '2026-09-08T02:00:00Z' }, { remaining: 100, resetAt: null }, prevAt, T0), null);
  assert.equal(detectCycleClose({ remaining: 100, resetAt: null }, { remaining: 99, resetAt: '2026-09-08T02:00:00Z' }, prevAt, T0), null);
});

test('detectCycleClose：resetAt 抖动在容差内 → 同一周期', () => {
  const prev = { remaining: 40, resetAt: '2026-09-01T02:00:00Z' };
  const curr = { remaining: 38, resetAt: '2026-09-01T02:03:00Z' };
  assert.equal(detectCycleClose(prev, curr, T0 - 5 * 60_000, T0), null);
});

test('detectCycleClose：旧重置时刻已过但剩余率没回升 → 厂商推迟重置，同一周期', () => {
  // 跨过了旧 resetAt 但额度没有回补：周期其实还在继续，重置被推迟了
  const prev = { remaining: 45, resetAt: '2026-09-01T02:00:00Z' };
  const curr = { remaining: 44, resetAt: '2026-09-04T02:00:00Z' };
  assert.equal(detectCycleClose(prev, curr, T0 - 5 * 60_000, T0 + 5 * 60_000), null);
});

test('detectCycleClose：剩余率接近满格时跨过旧重置时刻 → 回补不可见仍按自然到期', () => {
  // 整周没用（剩 99.91%），重置后回满与重置前无法区分：仍归档自然到期
  const prev = { remaining: 99.91, resetAt: '2026-09-21T01:58:05Z' };
  const curr = { remaining: 100, resetAt: '2026-09-28T01:58:05Z' };
  const close = detectCycleClose(prev, curr, Date.parse('2026-09-21T01:57:00Z'), Date.parse('2026-09-21T02:05:00Z'));
  assert.deepEqual(close, { kind: 'natural', end: Date.parse('2026-09-21T01:58:05Z') });
});

test('detectCycleClose：改期但剩余率没有回升 → 滑动窗口重新锚定，不算重置', () => {
  // mtvgdl2m 场景：没用的时候 resetAt=now+7d 随轮询滑动，厂商重新锚定往前三天的重置时刻
  const prevAt = Date.parse('2026-09-12T08:04:41Z');
  const currAt = Date.parse('2026-09-12T09:04:41Z');
  assert.equal(detectCycleClose({ remaining: 100, resetAt: '2026-09-16T05:38:05Z' }, { remaining: 100, resetAt: '2026-09-19T08:09:51Z' }, prevAt, currAt), null);
  assert.equal(detectCycleClose({ remaining: 53, resetAt: '2026-09-16T05:38:05Z' }, { remaining: 53, resetAt: '2026-09-19T08:09:51Z' }, prevAt, currAt), null);
});

test('detectCycleClose：剩余率数据缺失 → 退回只看 resetAt 的旧行为', () => {
  const prev = { resetAt: '2026-09-01T02:00:00Z' };
  const curr = { resetAt: '2026-09-08T02:00:00Z' };
  assert.deepEqual(detectCycleClose(prev, curr, T0 - 5 * 60_000, T0 + 5 * 60_000), { kind: 'natural', end: T0 });
});

test('extractCycles：完整周期被归档，周期末剩余率即浪费率', () => {
  // 一个周期（每 5 分钟一点，最后观测距重置仅 5 分钟，剩余率从 100 降到 33.5），随后新周期从 98 开始
  const beforeReset = weeklyPoints('2026-09-01T02:00:00Z', Array.from({ length: 20 }, (_, i) => 100 - i * 3.5), T0 - 20 * 5 * 60_000);
  const afterReset = weeklyPoints('2026-09-08T02:00:00Z', [98, 97], T0 + 5 * 60_000);
  const cycles = extractCycles([...beforeReset, ...afterReset], ['weekly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].window, 'weekly');
  assert.equal(cycles[0].kind, 'natural');
  assert.equal(cycles[0].end, '2026-09-01T02:00:00.000Z');
  assert.equal(cycles[0].remaining, 100 - 19 * 3.5); // 33.5
  assert.equal(cycles[0].reliable, true); // 最后观测距重置仅 5 分钟
  assert.equal(cycles[0].limit, 3500);
});

test('extractCycles：关机断档导致最后观测过早 → 记录失真（reliable=false）', () => {
  // 最后一条记录距重置 12 小时（远超 2×5 分钟），随后 12 小时后才有新周期的点
  const beforeReset = weeklyPoints('2026-09-01T02:00:00Z', [80, 70, 60, 55], T0 - 12 * H - 15 * 60_000);
  const afterReset = weeklyPoints('2026-09-08T02:00:00Z', [99], T0 + 5 * 60_000);
  const cycles = extractCycles([...beforeReset, ...afterReset], ['weekly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].reliable, false);
  assert.equal(cycles[0].remaining, 55);
  assert.ok(cycles[0].gapMs > 11 * H);
});

test('extractCycles：提前重置的周期标记为 early，新周期从观测点重新起算', () => {
  const reset = '2026-09-08T02:00:00Z';
  const earlyReset = '2026-09-03T02:00:00Z';
  const points = [
    ...weeklyPoints(reset, [90, 80, 78], T0 - 15 * 60_000),
    // resetAt 突然变早 + 剩余率回升：厂商提前清零
    ...weeklyPoints(earlyReset, [97, 95], T0 + 5 * 60_000),
  ];
  const cycles = extractCycles(points, ['weekly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].kind, 'early');
  assert.equal(cycles[0].reliable, false); // early 一律不计入统计
  assert.equal(cycles[0].remaining, 78);
});

test('extractCycles：resetAt 在重置瞬间短暂消失 → 桥接后仍能识别自然到期', () => {
  // wlbclub 场景：01:57 时 resetAt=02:00（3 分钟后到期），02:02 resetAt 消失、剩余率回满，02:07 resetAt 变为下周
  const t = (m) => new Date(T0 + m * 60_000).toISOString();
  const point = (m, remaining, resetAt) => ({ at: t(m), windows: { weekly: { remaining, amount: remaining, limit: 100, unit: '%', resetAt } } });
  const points = [
    point(-10, 90, t(0)),
    point(-5, 84.09, t(0)),
    point(0, 100, null),          // 重置瞬间 resetAt 消失
    point(5, 99.8, t(7 * 24 * 60)), // 恢复后 resetAt 指向下一周期
  ];
  const cycles = extractCycles(points, ['weekly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].kind, 'natural');
  assert.equal(cycles[0].end, t(0));
  assert.equal(cycles[0].remaining, 84.09);
});

test('extractCycles：resetAt 消失后直到历史末尾都没恢复 → 消失本身视为周期结束', () => {
  const t = (m) => new Date(T0 + m * 60_000).toISOString();
  const point = (m, remaining, resetAt) => ({ at: t(m), windows: { weekly: { remaining, amount: remaining, limit: 100, unit: '%', resetAt } } });
  // 旧重置时刻（T0）在消失前已被跨过 → 自然到期
  const natural = extractCycles([point(-10, 90, t(0)), point(-5, 80, t(0)), point(5, 100, null), point(10, 100, null)], ['weekly']);
  assert.equal(natural.length, 1);
  assert.equal(natural[0].kind, 'natural');
  assert.equal(natural[0].end, t(0));
  assert.equal(natural[0].remaining, 80);
  // 旧重置时刻还没到就消失了 → 提前重置，end ≈ 最后一次带 resetAt 的观测
  const early = extractCycles([point(-10, 90, t(7 * 24 * 60)), point(-5, 80, t(7 * 24 * 60)), point(0, 100, null)], ['weekly']);
  assert.equal(early.length, 1);
  assert.equal(early[0].kind, 'early');
  assert.equal(early[0].end, t(-5));
});

test('extractCycles：natural 记录的 from 按标称周期倒推，首条记录不用首次观测时间', () => {
  // 首个观测点落在周期中间（真实周期 08/25 → 09/01），归档区间应从 08/25 起算
  const points = [
    ...weeklyPoints('2026-09-01T02:00:00Z', [60, 50], Date.parse('2026-08-30T00:00:00Z')),
    ...weeklyPoints('2026-09-08T02:00:00Z', [90], T0 + 5 * 60_000),
  ];
  const cycles = extractCycles(points, ['weekly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].from, '2026-08-25T02:00:00.000Z');
  assert.equal(cycles[0].end, '2026-09-01T02:00:00.000Z');
});

test('extractCycles：观测跨过整个周期的跳跃后，from 仍是标称周期长', () => {
  // 09/23 观测后断档到 10/09：期间 09/30、10/07 两个周期结束，只归档到能观测的 09/30；
  // 下一条（10/14 结束）的 from 按 end−7d 起算，不会出现 21 天的「周周期」
  const points = [
    ...weeklyPoints('2026-09-30T14:32:26.781Z', [30, 28], Date.parse('2026-09-23T14:20:00Z')),
    ...weeklyPoints('2026-10-14T14:32:26.781Z', [90], Date.parse('2026-10-09T18:00:00Z')),
  ];
  const cycles = extractCycles(points, ['weekly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].end, '2026-09-30T14:32:26.781Z');
  assert.equal(cycles[0].from, '2026-09-23T14:32:26.781Z');
});

test('extractCycles：monthly natural 的 from 倒推一个日历月', () => {
  const point = (at, remaining, resetAt) => ({ at, windows: { monthly: { remaining, amount: remaining, limit: 100, unit: '%', resetAt } } });
  const cycles = extractCycles([
    point('2026-09-20T00:00:00Z', 60, '2026-10-01T00:00:00Z'),
    point('2026-09-20T00:05:00Z', 58, '2026-10-01T00:00:00Z'),
    point('2026-10-01T00:05:00Z', 100, '2026-11-01T00:00:00Z'),
  ], ['monthly']);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].from, '2026-09-01T00:00:00.000Z');
  assert.equal(cycles[0].end, '2026-10-01T00:00:00.000Z');
});

test('mergeCycles：按 窗口:类型:结束时间 去重，可安全重复扫描', () => {
  const points = [
    ...weeklyPoints('2026-09-01T02:00:00Z', [90, 60, 40], T0 - 15 * 60_000),
    ...weeklyPoints('2026-09-08T02:00:00Z', [99], T0 + 5 * 60_000),
  ];
  const first = extractCycles(points, ['weekly']);
  const merged = mergeCycles([], first);
  assert.equal(merged.length, 1);
  // 再次扫描同样的历史，不会产生重复档案
  const again = mergeCycles(merged, extractCycles(points, ['weekly']));
  assert.equal(again.length, 1);
});

test('mergeCycles：相近结束时间的旧记录被新记录覆盖，不再重复归档', () => {
  // kimi 场景：早期用较短历史扫描归档（end 锚点差零点几秒），后来全量重扫产出更准的记录
  const old = { window: 'weekly', kind: 'natural', end: '2026-09-21T01:58:05.417Z', from: '2026-09-14T01:58:05Z', observedAt: '2026-09-20T11:12:08Z', remaining: 1.88, reliable: false };
  const fresh = { window: 'weekly', kind: 'natural', end: '2026-09-21T01:58:05.866Z', from: '2026-09-14T01:58:05Z', observedAt: '2026-09-20T11:02:08Z', remaining: 1.88, reliable: true };
  const merged = mergeCycles([old], [fresh]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].end, fresh.end);
  assert.equal(merged[0].reliable, true);
});

test('mergeCycles：降采样历史的重提取不得把可靠档案改写成失真', () => {
  // 10/28 事故场景：9 月周期按全分辨率归档（观测贴近重置、reliable），历史越过 30 天
  // 降采样线后重提取只能拿到整点附近的观测点，gap 拉长到约一小时且 reliable=false
  const archived = { window: 'weekly', kind: 'natural', end: '2026-09-16T10:00:07.998Z', from: '2026-09-09T10:00:07.998Z', observedAt: '2026-09-16T09:59:01Z', remaining: 3, gapMs: 70_000, reliable: true };
  const degraded = { window: 'weekly', kind: 'natural', end: '2026-09-16T10:00:07.998Z', from: '2026-09-09T10:00:07.998Z', observedAt: '2026-09-16T09:04:11Z', remaining: 17, gapMs: 3_356_000, reliable: false };
  const merged = mergeCycles([archived], [degraded]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].observedAt, archived.observedAt);
  assert.equal(merged[0].reliable, true);
  assert.equal(merged[0].remaining, 3);
});

test('mergeCycles：旧记录失真时仍采用重提取结果（可靠方向不受保护限制）', () => {
  // 旧档案本来就不可靠（如重置前长期断档），全量重扫产出更可信或同样新的记录时照常覆盖
  const oldBad = { window: 'weekly', kind: 'natural', end: '2026-09-21T01:58:05Z', observedAt: '2026-09-20T11:02Z', remaining: 1.88, gapMs: 53_760_000, reliable: false };
  const freshGood = { window: 'weekly', kind: 'natural', end: '2026-09-21T01:58:06Z', observedAt: '2026-09-20T11:12Z', remaining: 1.88, gapMs: 53_700_000, reliable: false };
  assert.equal(mergeCycles([oldBad], [freshGood])[0].observedAt, freshGood.observedAt);
  // 两条都可靠时也按原语义取新记录（end 锚点修正仍生效）
  const oldOk = { ...oldBad, reliable: true };
  const freshOk = { ...freshGood, end: '2026-09-21T01:58:06.2Z', reliable: true };
  assert.equal(mergeCycles([oldOk], [freshOk])[0].end, freshOk.end);
});

test('mergeCycles：被压制的失真重提取不再进入档案，重复扫描保持幂等', () => {
  const archived = { window: 'weekly', kind: 'natural', end: '2026-09-23T10:00:07Z', observedAt: '2026-09-23T09:59:02Z', remaining: 0, gapMs: 65_000, reliable: true };
  const degraded = { window: 'weekly', kind: 'natural', end: '2026-09-23T10:00:07Z', observedAt: '2026-09-23T09:04:12Z', remaining: 4, gapMs: 3_355_000, reliable: false };
  const first = mergeCycles([archived], [degraded]);
  assert.equal(first.length, 1);
  // 下一轮轮询同样只能重提取出失真记录，档案不再变化（不重复、不降级）
  const again = mergeCycles(first, [degraded]);
  assert.equal(again.length, 1);
  assert.equal(again[0].reliable, true);
  assert.equal(again[0].observedAt, archived.observedAt);
});

test('mergeCycles：历史覆盖范围内的旧记录在新链条中无对应 → 丢弃；范围之前的保留', () => {
  const coveredFrom = Date.parse('2026-09-01T00:00:00Z');
  const fresh = { window: 'weekly', kind: 'early', end: '2026-09-26T18:04:33Z', observedAt: '2026-09-26T18:04:33Z', remaining: 100, reliable: false };
  // 旧算法对同一次重置的误报（5 分钟后另归了一条），全量重扫的链条里没有 → 丢弃
  const stale = { window: 'weekly', kind: 'early', end: '2026-09-26T17:04:34Z', observedAt: '2026-09-26T17:04:34Z', remaining: 35, reliable: false };
  assert.equal(mergeCycles([stale], [fresh], coveredFrom).length, 1);
  // 历史已裁剪（覆盖范围之前）的记录无法重算 → 原样保留
  const ancient = { window: 'weekly', kind: 'natural', end: '2026-08-01T00:00:00Z', observedAt: '2026-07-31T23:00:00Z', remaining: 10, reliable: true };
  const kept = mergeCycles([ancient, stale], [fresh], coveredFrom);
  assert.equal(kept.length, 2);
  assert.ok(kept.includes(ancient));
});

test('dedupeCycles：相近结束时间的重复记录合并为更可信的一条，natural 起点按周期修正', () => {
  // kimi 场景：同一周期归了两条（end 差 449ms、观测点不同）
  const a = { window: 'weekly', kind: 'natural', end: '2026-09-21T01:58:05.417Z', from: '2026-09-14T01:58:05Z', observedAt: '2026-09-20T11:12:08Z', remaining: 1.88, reliable: false };
  const b = { window: 'weekly', kind: 'natural', end: '2026-09-21T01:58:05.866Z', from: '2026-09-14T01:58:05Z', observedAt: '2026-09-20T11:02:08Z', remaining: 1.88, reliable: false };
  const deduped = dedupeCycles([a, b]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].observedAt, a.observedAt); // 观测点更晚的 end 锚点更准
  assert.equal(deduped[0].from, '2026-09-14T01:58:05.417Z'); // end − 7 天
  // reliable 优先于观测时间
  const reliable = { ...b, reliable: true, observedAt: '2026-09-20T10:00:00Z' };
  assert.equal(dedupeCycles([a, reliable])[0].reliable, true);
  // 不同周期（结束时间相隔一周）不会误合并
  const nextWeek = { ...a, end: '2026-09-28T01:58:05.417Z', observedAt: '2026-09-27T11:00:00Z' };
  assert.equal(dedupeCycles([a, nextWeek]).length, 2);
  assert.deepEqual(dedupeCycles(null), []);
});

test('purgeGhostCycles：与 natural 共享 observedAt 的幽灵 early 被删除，真实提前重置保留', () => {
  // 真实化石形态（wlb 09/07 双重归档）：旧版算法的突升兜底和新算法各自归档了同一次自然重置
  const natural = { window: 'weekly', kind: 'natural', end: '2026-09-07T02:00:00.000Z', observedAt: '2026-09-07T01:57:36.463Z', remaining: 84.09, reliable: true };
  const ghost = { window: 'weekly', kind: 'early', end: '2026-09-07T01:57:36.463Z', observedAt: '2026-09-07T01:57:36.463Z', remaining: 84.09, reliable: false };
  // 没有同观测点 natural 对照的真实提前重置，不能误伤
  const genuine = { window: 'weekly', kind: 'early', end: '2026-09-08T04:47:31.761Z', observedAt: '2026-09-08T04:47:31.761Z', remaining: 57.71, reliable: false };
  assert.deepEqual(purgeGhostCycles([ghost, natural, genuine]), [natural, genuine]);
});

test('purgeGhostCycles：无 natural 对照或空列表时原样返回', () => {
  const early = { window: 'weekly', kind: 'early', end: '2026-09-08T04:47:31.761Z', observedAt: '2026-09-08T04:47:31.761Z' };
  assert.deepEqual(purgeGhostCycles([early]), [early]);
  assert.deepEqual(purgeGhostCycles([]), []);
  assert.deepEqual(purgeGhostCycles(null), []);
});

test('computeWasteStats：失真与提前重置不计入平均和累计', () => {
  const cycles = [
    { window: 'weekly', kind: 'natural', reliable: true, remaining: 30, end: '2026-08-01T00:00:00Z' },
    { window: 'weekly', kind: 'natural', reliable: true, remaining: 10, end: '2026-08-08T00:00:00Z' },
    { window: 'weekly', kind: 'natural', reliable: false, remaining: 90, end: '2026-08-15T00:00:00Z' },
    { window: 'weekly', kind: 'early', reliable: false, remaining: 50, end: '2026-08-20T00:00:00Z' },
    { window: 'monthly', kind: 'natural', reliable: true, remaining: 12, end: '2026-09-01T00:00:00Z' },
  ];
  const stats = computeWasteStats(cycles, 'weekly');
  assert.equal(stats.cycles, 4);
  assert.equal(stats.reliable, 2);
  assert.equal(stats.excluded, 2);
  assert.equal(stats.avgWaste, 20);
  assert.ok(Math.abs(stats.totalWaste - 0.4) < 1e-9);
  assert.equal(computeWasteStats(cycles, 'monthly').avgWaste, 12);
  assert.equal(computeWasteStats([], 'weekly').avgWaste, null);
});

test('extractCycles：0/0 与 limit=100 的百分比占位不写入档案', () => {
  const t = (m) => new Date(T0 + m * 60_000).toISOString();
  const after = { at: t(10), windows: { weekly: { remaining: 99, amount: 0, limit: 0, unit: '%', resetAt: t(7 * 24 * 60) } } };
  const zero = extractCycles([
    { at: t(-10), windows: { weekly: { remaining: 5, amount: 0, limit: 0, unit: '%', resetAt: t(0) } } },
    { at: t(-5), windows: { weekly: { remaining: 5, amount: 0, limit: 0, unit: '%', resetAt: t(0) } } },
    after,
  ], ['weekly']);
  assert.equal(zero.length, 1);
  assert.equal(zero[0].amount, null);
  assert.equal(zero[0].limit, null);
  const pct = extractCycles([
    { at: t(-10), windows: { weekly: { remaining: 66, amount: 66, limit: 100, unit: '%', resetAt: t(0) } } },
    { at: t(-5), windows: { weekly: { remaining: 66, amount: 66, limit: 100, unit: '%', resetAt: t(0) } } },
    after,
  ], ['weekly']);
  assert.equal(pct[0].amount, null);
  assert.equal(pct[0].limit, null);
});

test('resolveWasteWindows：预设优先，缺省取周期类型窗口', () => {
  assert.deepEqual(resolveWasteWindows({ windows: ['five_hour', 'weekly'], wasteWindows: ['weekly'] }), ['weekly']);
  assert.deepEqual(resolveWasteWindows({ windows: ['five_hour', 'weekly'], wasteWindows: [] }), []);
  assert.deepEqual(resolveWasteWindows({ windows: ['five_hour', 'weekly', 'monthly'] }), ['weekly', 'monthly']);
  assert.deepEqual(resolveWasteWindows({ windows: ['balance'] }), []);
  assert.deepEqual(resolveWasteWindows(undefined), []);
});

test('repairDowngradedCycles：用备份中的可靠记录替换被改写的失真记录', () => {
  // 10/28 事故的真实形态：当前档案观测点被拉到整点附近（失真），备份里是当时贴近重置的观测
  const degraded = { window: 'weekly', kind: 'natural', end: '2026-09-09T10:00:07.998Z', from: '2026-09-02T10:00:07.998Z', observedAt: '2026-09-09T09:02:25.356Z', remaining: 17, gapMs: 3_462_642, reliable: false };
  const original = { window: 'weekly', kind: 'natural', end: '2026-09-09T10:00:07.998Z', from: '2026-09-02T10:00:07.998Z', observedAt: '2026-09-09T09:57:16Z', remaining: 5, gapMs: 171_998, reliable: true };
  const { cycles, repaired } = repairDowngradedCycles(
    { 'zai-x': [degraded] },
    [{ 'zai-x': [original] }],
  );
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].window, 'weekly');
  assert.deepEqual(cycles['zai-x'], [original]);
});

test('repairDowngradedCycles：可靠记录不动，无可靠对照的失真保持失真', () => {
  const good = { window: 'weekly', kind: 'natural', end: '2026-10-07T10:00:00Z', observedAt: '2026-10-07T09:59:30Z', remaining: 67, gapMs: 30_000, reliable: true };
  // kimi 9/21 场景：重置前 15 小时无观测，任何备份里都没有可靠版本
  const gapDay = { window: 'weekly', kind: 'natural', end: '2026-09-21T01:58:05Z', observedAt: '2026-09-20T11:02:08Z', remaining: 1.88, gapMs: 53_760_000, reliable: false };
  const { cycles, repaired } = repairDowngradedCycles(
    { 'k': [good, gapDay] },
    [{ 'k': [{ ...gapDay, observedAt: '2026-09-20T11:12:08Z', gapMs: 53_700_000 }] }],
  );
  assert.equal(repaired.length, 0);
  assert.equal(cycles['k'][0], good);
  assert.equal(cycles['k'][1].reliable, false);
});

test('repairDowngradedCycles：候选按 窗口+类型+相近结束时间 匹配，取 gap 最小的一条', () => {
  const damaged = { window: 'weekly', kind: 'natural', end: '2026-09-16T10:00:07Z', observedAt: '2026-09-16T09:04:11Z', remaining: 17, gapMs: 3_356_000, reliable: false };
  const farEnd = { window: 'weekly', kind: 'natural', end: '2026-09-19T10:00:07Z', observedAt: '2026-09-19T09:59:00Z', remaining: 1, gapMs: 60_000, reliable: true }; // 结束时间超出容差
  const otherWindow = { window: 'monthly', kind: 'natural', end: '2026-09-16T10:00:07Z', observedAt: '2026-09-16T09:59:00Z', remaining: 1, gapMs: 60_000, reliable: true }; // 窗口不同
  const worse = { window: 'weekly', kind: 'natural', end: '2026-09-16T10:00:07Z', observedAt: '2026-09-16T09:40:00Z', remaining: 9, gapMs: 1_207_000, reliable: true };
  const best = { window: 'weekly', kind: 'natural', end: '2026-09-16T10:00:07Z', observedAt: '2026-09-16T09:59:01Z', remaining: 0, gapMs: 66_000, reliable: true };
  const { cycles, repaired } = repairDowngradedCycles(
    { 'a': [damaged], 'b': [{ ...damaged, end: '2026-09-23T10:00:07Z' }] },
    [{ 'a': [farEnd, otherWindow, worse], 'b': [] }, { 'a': [best] }],
  );
  assert.equal(repaired.length, 1);
  assert.equal(cycles['a'][0].observedAt, best.observedAt);
  // b 账号在备份里没有对应记录 → 保持原样
  assert.equal(cycles['b'][0].reliable, false);
});

