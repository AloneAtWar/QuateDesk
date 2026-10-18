export const refreshQueueCycles = ['five_hour', 'weekly', 'monthly'];

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
    byKey.get(item.meter.key)?.items.push(item);
  }
  return queues.filter(({ items }) => items.length > 0);
}
