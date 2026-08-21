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
};

module.exports = { builtinConfigs };
