const scripts = {
  kimi: `({
    request: { url: "{{endpoint}}", method: "GET", headers: { Authorization: "Bearer {{apiKey}}" } },
    extractor(response) {
      const rows = (response?.limits || []).map((row) => {
        const item = row?.detail || row || {}; const total = Number(item.limit || 0); const amount = Number(item.remaining || 0);
        return { key: "five_hour", remaining: total > 0 ? amount / total * 100 : 0, total: 100, unit: "%", amount, limitAmount: total, resetAt: item.resetTime };
      });
      if (response?.usage) { const item = response.usage; const total = Number(item.limit || 0); const amount = Number(item.remaining || 0); rows.push({ key: "weekly", remaining: total > 0 ? amount / total * 100 : 0, total: 100, unit: "%", amount, limitAmount: total, resetAt: item.resetTime }); }
      return rows;
    }
  })`,
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
  { key: 'apiKey', label: 'API Key', defaultValue: '', required: false, secret: true, system: true },
];

const builtinConfigs = {
  kimi: { endpoint: 'https://api.kimi.com/coding/v1/usages', windows: ['five_hour', 'weekly'], adapterMode: 'script', script: scripts.kimi, variables: scriptVariables('https://api.kimi.com/coding/v1/usages') },
  zai: { endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', windows: ['five_hour', 'weekly', 'monthly'], adapterMode: 'script', script: scripts.zai, variables: scriptVariables('https://open.bigmodel.cn/api/monitor/usage/quota/limit') },
  deepseek: { endpoint: 'https://api.deepseek.com/user/balance', windows: ['balance'], adapterMode: 'script', script: scripts.deepseek, variables: scriptVariables('https://api.deepseek.com/user/balance') },
  wlb: {
    endpoint: 'https://codex.wlbclub.com/v1/usage', windows: ['weekly'], adapterMode: 'standard', method: 'GET', auth: 'bearer', authHeader: 'Authorization', authPrefix: 'Bearer ', builtinMigration: 'wlb-standard-v1',
    responseRules: [{ listPath: 'rate_limits', collectionMode: 'array', filterPath: 'window', filterOperator: 'equals', filterValue: '7d', defaultWindow: 'weekly', totalPath: 'limit', remainingPath: 'remaining', usedPath: 'used', resetPath: 'reset_at|resetAt|resetTime', availablePath: '$root.status', unavailableValues: 'inactive|invalid|false|0', unit: '%' }],
  },
  // Grok 订阅走专属适配（poller.cjs queryGrokSubscription）：读本机 grok CLI 凭据查 grok.com 计费端点，无需用户填任何凭据
  grok: { windows: ['weekly', 'monthly'], adapterMode: 'grok', auth: 'none', credentialRequired: false },
  // MiniMax Coding Plan（规则移植自 cc-switch coding_plan.rs）：model_remains 里 model_name=general 的 5 小时/周剩余百分比
  minimax: {
    endpoint: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    windows: ['five_hour', 'weekly'], adapterMode: 'script',
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
  // Claude / Codex / Gemini 官方订阅：专属适配（cli-quota.cjs），复用本机 CLI 登录态
  claude: { windows: ['five_hour', 'weekly'], adapterMode: 'claude', auth: 'none', credentialRequired: false },
  codex: { windows: ['five_hour', 'weekly', 'monthly'], adapterMode: 'codex', auth: 'none', credentialRequired: false },
  gemini: { windows: ['gemini_pro', 'gemini_flash', 'gemini_flash_lite'], adapterMode: 'gemini', auth: 'none', credentialRequired: false },
};

module.exports = { builtinConfigs };
