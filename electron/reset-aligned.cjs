// 窗口重置对齐的点名轮询（纯逻辑，便于单测；调度见 main.cjs 的 scheduleResetAlignedPoll）。
// 固定间隔轮询感知不到 resetAt：窗口重置后旧数据最多再挂 pollMinutes 分钟才翻新，
// 浪费统计的周期边界（extractCycles 靠历史点跳变识别周期结束）也被轮询间隔糊掉。
// 参考 magpie 在窗口重置点的处理（预热后 claudeWarmedNow 强制重读用量）：在最近一个
// 窗口重置后约一分钟点名拉一次，让新周期数据、显示与周期归档都在重置点后第一时间落位。

// 重置点后等多久再拉：太贴近重置瞬间可能拿到尚未翻转的旧数据，留一点缓冲
const RESET_ALIGNED_BUFFER_MS = 45_000;

const windowResetMs = (window) => {
  const ms = Date.parse(window?.resetAt || '');
  return Number.isFinite(ms) ? ms : null;
};

// 计算下一次点名轮询的时刻：所有未停用账号的所有窗口里最近的那个未来 resetAt（+缓冲）。
// 没有任何未来的重置点（无账号 / 无窗口 / resetAt 缺失或已过期）返回 null。
const nextResetAlignedAt = (state, now = Date.now()) => {
  let soonest = null;
  for (const account of state?.accounts || []) {
    if (account.disabled) continue;
    for (const window of account.windows || []) {
      const ms = windowResetMs(window);
      if (ms === null || ms <= now) continue;
      if (soonest === null || ms < soonest) soonest = ms;
    }
  }
  return soonest === null ? null : { at: soonest + RESET_ALIGNED_BUFFER_MS };
};

// 到点后应点名哪些账号：存在「刚重置」窗口（resetAt 在过去 horizon 内）的未停用账号。
// 拉取后新数据的 resetAt 会指向下一个周期（未来），自然不会重复点名；resetAt 迟迟
// 不翻新（查询失败 / 接口返回旧值）的账号也不会被循环点名——重调度只认未来重置点。
const dueResetAlignedAccounts = (state, now = Date.now(), horizonMs = 15 * 60_000) =>
  (state?.accounts || [])
    .filter((account) => !account.disabled && (account.windows || []).some((window) => {
      const ms = windowResetMs(window);
      return ms !== null && ms <= now && ms > now - horizonMs;
    }))
    .map((account) => account.id);

module.exports = { RESET_ALIGNED_BUFFER_MS, nextResetAlignedAt, dueResetAlignedAccounts };
