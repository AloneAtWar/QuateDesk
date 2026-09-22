const scripts = {
  zai: `({
    request: { url: "{{endpoint}}", method: "GET", headers: { Authorization: "{{apiKey}}" } },
    extractor(response) {
      const source = response?.data || response?.result || response || {}; const rows = source.limits || source.quotas || source.items || [];
      return rows.map((row, index) => { const item = row?.detail || row || {}; const total = Number(item.limit ?? item.total ?? item.usage ?? 0); const used = Number(item.used ?? item.currentValue ?? 0); const amount = Number(item.remaining ?? Math.max(0, total - used)); const raw = String(row.type || row.window || row.name || "").toLowerCase(); const unit = Number(item.unit); const number = Number(item.number); const key = number === 5 && unit === 3 ? "five_hour" : unit === 6 || raw.includes("week") || raw.includes("7") ? "weekly" : unit === 5 || raw.includes("month") || raw.includes("30") ? "monthly" : index === 0 ? "five_hour" : "weekly"; const pct = Number.isFinite(Number(item.percentage)) ? 100 - Number(item.percentage) : total > 0 ? amount / total * 100 : 0; return { key, remaining: Math.max(0, Math.min(100, pct)), total: 100, unit: "%", amount, limitAmount: total, resetAt: item.nextResetTime ?? item.resetTime ?? item.resetAt }; });
    }
  })`,
  deepseek: `({
    request: { url: "{{endpoint}}", method: "GET", headers: { Authorization: "Bearer {{apiKey}}" } },
    extractor(response) { return (response?.balance_infos || []).map((item) => ({ key: "balance", remaining: 100, total: 100, unit: item.currency || "CNY", amount: Number(item.total_balance || 0), limitAmount: Number(item.total_balance || 0), available: response?.is_available !== false, error: response?.is_available === false ? "余额不可用" : undefined })); }
  })`,
  wlb: `({
    request: { url: "{{endpoint}}", method: "GET", headers: { Authorization: "Bearer {{apiKey}}" } },
    extractor(response) { const item = response?.rate_limits?.find((row) => row.window === "7d") || {}; const total = Number(item.limit || 0); const used = Number(item.used || 0); const amount = Number(item.remaining ?? Math.max(0, total - used)); return { key: "weekly", remaining: total > 0 ? amount / total * 100 : 0, total: 100, unit: "%", amount, limitAmount: total, resetAt: item.reset_at ?? item.resetAt ?? item.resetTime, available: response?.isValid ?? response?.status === "active" }; }
  })`,
};

const scriptVariables = (endpoint) => [
  { key: 'endpoint', label: '额度接口路径', defaultValue: endpoint, required: true, secret: false, system: true },
  { key: 'apiKey', label: 'API Key', defaultValue: '', required: true, secret: true, system: true },
];

const builtinConfigs = {
  // Kimi 已下线独立的 API Key 渠道（api.kimi.com/coding/v1/usages）：订阅额度统一走
  // 「kimi-subscription」扫码登录，避免同一厂商出现两个入口
  zai: { endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', windows: ['five_hour', 'weekly', 'monthly'], wasteWindows: ['weekly'], adapterMode: 'script', script: scripts.zai, variables: scriptVariables('https://open.bigmodel.cn/api/monitor/usage/quota/limit') },
  deepseek: { endpoint: 'https://api.deepseek.com/user/balance', windows: ['balance'], wasteWindows: [], adapterMode: 'script', script: scripts.deepseek, variables: scriptVariables('https://api.deepseek.com/user/balance') },
  wlb: {
    endpoint: 'https://codex.wlbclub.com/v1/usage', windows: ['daily', 'weekly'], wasteWindows: ['weekly'], adapterMode: 'standard', method: 'GET', auth: 'bearer', authHeader: 'Authorization', authPrefix: 'Bearer ', builtinMigration: 'wlb-standard-v2',
    responseRules: [
      // rate_limits 里 window=1d 的行是 wlbclub 后上线的 1 天限额
      { listPath: 'rate_limits', collectionMode: 'array', filterPath: 'window', filterOperator: 'equals', filterValue: '1d', defaultWindow: 'daily', totalPath: 'limit', remainingPath: 'remaining', usedPath: 'used', resetPath: 'reset_at|resetAt|resetTime', availablePath: '$root.status', unavailableValues: 'inactive|invalid|false|0', unit: '%' },
      { listPath: 'rate_limits', collectionMode: 'array', filterPath: 'window', filterOperator: 'equals', filterValue: '7d', defaultWindow: 'weekly', totalPath: 'limit', remainingPath: 'remaining', usedPath: 'used', resetPath: 'reset_at|resetAt|resetTime', availablePath: '$root.status', unavailableValues: 'inactive|invalid|false|0', unit: '%' },
    ],
  },
  // Grok 订阅走专属适配（poller.cjs queryGrokSubscription）：读本机 grok CLI 凭据查 grok.com 计费端点，无需用户填任何凭据
  // Grok 订阅走专属适配（poller.cjs queryGrokSubscription）：读本机 grok CLI 凭据查 grok.com 计费端点，无需用户填任何凭据；Grok 只有周额度，没有月额度
  grok: { windows: ['weekly'], wasteWindows: ['weekly'], adapterMode: 'grok', auth: 'none', credentialRequired: false },
  // Grok Bot（xAI 的 AI 队友）：专属适配（cli-quota.cjs queryGrokBotUsage），凭据来自「导入订阅登录」
  // 收录的本机 Grok Bot 客户端登录快照；Bot 的周额度与 Grok 聊天额度独立（挂 Cursor 后端计量）
  grokbot: { windows: ['weekly'], wasteWindows: ['weekly'], adapterMode: 'grokbot', auth: 'none', credentialRequired: false },
  // MiniMax Coding Plan（规则移植自 cc-switch coding_plan.rs）：model_remains 里 model_name=general 的 5 小时/周剩余百分比
  minimax: {
    endpoint: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    windows: ['five_hour', 'weekly'], wasteWindows: ['weekly'], adapterMode: 'script',
    script: `({
    request: { url: "{{endpoint}}", method: "GET", headers: { Authorization: "Bearer {{apiKey}}" } },
    extractor(response) {
      if (response?.base_resp?.status_code && response.base_resp.status_code !== 0) throw new Error(response.base_resp.status_msg || "MiniMax 接口返回错误");
      const item = (response?.model_remains || []).find((row) => row.model_name === "general");
      if (!item) throw new Error("MiniMax 响应中没有 general 套餐额度");
      const rows = [];
      if (Number.isFinite(Number(item.current_interval_remaining_percent))) {
        rows.push({ key: "five_hour", remaining: Number(item.current_interval_remaining_percent), total: 100, unit: "%", resetAt: item.end_time ? new Date(Number(item.end_time)).toISOString() : null });
      }
      if (Number(item.current_weekly_status) === 1 && Number.isFinite(Number(item.current_weekly_remaining_percent))) {
        rows.push({ key: "weekly", remaining: Number(item.current_weekly_remaining_percent), total: 100, unit: "%" });
      }
      if (!rows.length) throw new Error("MiniMax 响应中没有可识别的额度窗口");
      return rows;
    }
  })`,
    variables: scriptVariables('https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains'),
  },
  // Xiaomi MiMo Token Plan：专属适配（poller.cjs queryMimoQuota），额度来自
  // platform.xiaomimimo.com 控制台内部接口，凭据是「连接官方账号」捕获的小米
  // 账号会话 Cookie（加密保存，24 小时过期由主进程静默续期），无需 API Key
  mimo: {
    endpoint: 'https://platform.xiaomimimo.com',
    windows: ['mimo_plan', 'balance'], wasteWindows: [], adapterMode: 'mimo', auth: 'none', credentialRequired: false,
  },
  // Claude / Codex / Gemini 官方订阅：专属适配（cli-quota.cjs），复用本机 CLI 登录态
  claude: { windows: ['five_hour', 'weekly'], wasteWindows: ['weekly'], adapterMode: 'claude', auth: 'none', credentialRequired: false },
  codex: { windows: ['five_hour', 'weekly', 'monthly'], wasteWindows: ['weekly', 'monthly'], adapterMode: 'codex', auth: 'none', credentialRequired: false },
  gemini: { windows: ['gemini_pro', 'gemini_flash', 'gemini_flash_lite'], wasteWindows: [], adapterMode: 'gemini', auth: 'none', credentialRequired: false },
  // Kimi 官方订阅：专属适配（cli-quota.cjs），凭据来自「导入订阅登录」的扫码快照，含月订阅额度
  'kimi-subscription': { windows: ['five_hour', 'weekly', 'monthly'], wasteWindows: ['weekly', 'monthly'], adapterMode: 'kimi', auth: 'none', credentialRequired: false },
  // GitHub Copilot 订阅：专属适配（cli-quota.cjs），凭据来自「导入订阅登录」的 GitHub 设备码授权快照。
  // 额度是 premium requests（补充请求）月度池，每月 1 号重置
  copilot: { windows: ['monthly'], wasteWindows: ['monthly'], adapterMode: 'copilot', auth: 'none', credentialRequired: false },
};

module.exports = { builtinConfigs };
