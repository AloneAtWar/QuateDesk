export const refreshQueueCycles = ['five_hour', 'weekly', 'monthly'];

// Antigravity 的池窗口（agy_gemini_5h / agy_claudegpt_7d / agy_pool_*）按后缀归入
// 5 小时 / 7 天队列：队列按周期分组，同一周期的所有池窗口共用一条队列
const cycleKeyOf = (key) => {
  if (refreshQueueCycles.includes(key)) return key;
  if (/^agy_.+_5h$/.test(key)) return 'five_hour';
  if (/^agy_.+_7d$/.test(key)) return 'weekly';
  return null;
};

export function getUpcomingRefreshItems(accounts = []) {
  return accounts
    .filter((account) => !account.disabled)
    .flatMap((account) => (account.windows || [])
      .filter((meter) => meter.resetAt && Number.isFinite(new Date(meter.resetAt).getTime()))
      .map((meter) => ({ account, meter, at: new Date(meter.resetAt).getTime() })))
    .sort((a, b) => a.at - b.at);
}

// Queue membership follows the quota window, never its remaining countdown.
export function buildRefreshQueues(accounts = []) {
  const queues = refreshQueueCycles.map((key) => ({ key, items: [] }));
  const byKey = new Map(queues.map((queue) => [queue.key, queue]));
  for (const item of getUpcomingRefreshItems(accounts)) {
    const cycle = cycleKeyOf(item.meter.key);
    if (cycle) byKey.get(cycle).items.push(item);
  }
  return queues.filter(({ items }) => items.length > 0);
}
