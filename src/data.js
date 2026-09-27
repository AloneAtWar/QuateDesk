export const adapterRegistry = {
  zai: {
    id: 'zai',
    label: 'Z.ai / 智谱',
    endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    auth: 'token',
    windows: ['five_hour', 'weekly', 'monthly'],
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek API',
    endpoint: 'https://api.deepseek.com/user/balance',
    auth: 'bearer',
    windows: ['balance'],
  },
  wlb: {
    id: 'wlb',
    label: 'WLB Club',
    endpoint: 'https://codex.wlbclub.com/v1/usage',
    auth: 'bearer',
    windows: ['daily', 'weekly'],
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    endpoint: '',
    auth: 'none',
    windows: ['weekly', 'monthly'],
  },
  grokbot: {
    id: 'grokbot',
    label: 'Grok Bot',
    endpoint: '',
    auth: 'none',
    windows: ['weekly'],
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax Coding Plan',
    endpoint: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    auth: 'bearer',
    windows: ['five_hour', 'weekly'],
  },
  mimo: {
    id: 'mimo',
    label: 'Xiaomi MiMo Token Plan',
    endpoint: '',
    auth: 'none',
    windows: ['monthly', 'yearly'],
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    endpoint: '',
    auth: 'none',
    windows: ['five_hour', 'weekly'],
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex',
    endpoint: '',
    auth: 'none',
    windows: ['five_hour', 'weekly', 'monthly'],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    endpoint: '',
    auth: 'none',
    windows: ['gemini_pro', 'gemini_flash', 'gemini_flash_lite'],
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot',
    endpoint: '',
    auth: 'none',
    windows: ['monthly'],
  },
};

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const daysFromNow = (days) => minutesFromNow(days * 24 * 60);

export const providerCatalog = [
  // Kimi 渠道（kimi-subscription）双登录：扫码登录含月订阅额度；API Key 登录只有 5 小时 / 7 天（无月额度）
  { id: 'zai', name: 'Z.ai', legalName: 'Z.ai / 智谱', monogram: 'Z', tone: 'violet', adapter: 'zai', logo: './logos/zai.svg', website: 'https://bigmodel.cn/' },
  { id: 'deepseek', name: 'DeepSeek', legalName: 'DeepSeek API', monogram: 'D', tone: 'blue', adapter: 'deepseek', logo: './logos/deepseek.png', website: 'https://www.deepseek.com/' },
  { id: 'wlb', name: 'wlbclub', legalName: 'wlbclub', monogram: 'W', tone: 'coral', adapter: 'wlb', website: 'https://www.wlbclub.com/' },
  { id: 'grok', name: 'Grok', legalName: 'xAI Grok', monogram: 'G', tone: 'slate', adapter: 'grok', logo: './logos/grok.png', website: 'https://grok.com/' },
  { id: 'grokbot', name: 'Grok Bot', legalName: 'xAI Grok Bot', monogram: 'G', tone: 'slate', adapter: 'grokbot', logo: './logos/grokbot.png', website: 'https://x.ai/bot' },
  { id: 'minimax', name: 'MiniMax', legalName: 'MiniMax Coding Plan', monogram: 'M', tone: 'mint', adapter: 'minimax', logo: './logos/minimax.svg', website: 'https://platform.minimaxi.com' },
  { id: 'mimo', name: 'Xiaomi MiMo', legalName: 'Xiaomi MiMo Token Plan', monogram: 'M', tone: 'coral', adapter: 'mimo', logo: './logos/mimo.webp', website: 'https://platform.xiaomimimo.com' },
  { id: 'claude', name: 'Claude', legalName: 'Claude Code', monogram: 'C', tone: 'coral', adapter: 'claude', logo: './logos/claude.jpg', website: 'https://claude.com/claude-code' },
  { id: 'codex', name: 'Codex', legalName: 'OpenAI Codex', monogram: 'O', tone: 'mint', adapter: 'codex', logo: './logos/codex.svg', website: 'https://developers.openai.com/codex/' },
  { id: 'gemini', name: 'Gemini', legalName: 'Gemini CLI', monogram: 'G', tone: 'sky', adapter: 'gemini', logo: './logos/gemini.svg', website: 'https://gemini.google.com/' },
  { id: 'kimi-subscription', name: 'Kimi 订阅', legalName: 'Kimi for Coding 订阅', monogram: 'K', tone: 'sky', adapter: 'kimi', logo: './logos/kimi.png', website: 'https://www.kimi.com/' },
  { id: 'copilot', name: 'GitHub Copilot', legalName: 'GitHub Copilot 订阅', monogram: 'G', tone: 'slate', adapter: 'copilot', logo: './logos/copilot.svg', website: 'https://github.com/features/copilot' },
];

export const windowCatalog = {
  five_hour: { key: 'five_hour', label: '5 小时', short: '5h', group: '短周期', color: 'cyan' },
  daily: { key: 'daily', label: '1 天', short: '1d', group: '短周期', color: 'sky' },
  weekly: { key: 'weekly', label: '7 天', short: '7d', group: '中周期', color: 'violet' },
  monthly: { key: 'monthly', label: '1个月', short: '1M', group: '长周期', color: 'coral' },
  yearly: { key: 'yearly', label: '1年', short: '1Y', group: '长周期', color: 'amber' },
  balance: { key: 'balance', label: '余额', short: '余额', group: '余额', color: 'green' },
  // 旧版 MiMo 套餐窗口：已按包月 / 包年并入 monthly / yearly，条目留给历史数据标名
  mimo_plan: { key: 'mimo_plan', label: 'Credits', short: 'Credits', group: 'MiMo', color: 'coral' },
  gemini_pro: { key: 'gemini_pro', label: 'Gemini Pro', short: 'Pro', group: 'Gemini', color: 'sky' },
  gemini_flash: { key: 'gemini_flash', label: 'Gemini Flash', short: 'Flash', group: 'Gemini', color: 'cyan' },
  gemini_flash_lite: { key: 'gemini_flash_lite', label: 'Flash Lite', short: 'Lite', group: 'Gemini', color: 'mint' },
};

export const initialAccounts = [
  {
    id: 'kimi-main', providerId: 'kimi-subscription', name: '主力账号', identity: 'hello@northstar.dev', tags: ['日常', '主力'], status: 'active', lastChecked: minutesFromNow(-3),
    windows: [
      { key: 'five_hour', remaining: 68, used: 32, total: 100, unit: '%', resetAt: minutesFromNow(102), available: true },
      { key: 'weekly', remaining: 42, used: 58, total: 100, unit: '%', resetAt: daysFromNow(2.18), available: true },
    ],
  },
  {
    id: 'zai-lab', providerId: 'zai', name: '实验室', identity: 'zai-lab', tags: ['实验'], status: 'active', lastChecked: minutesFromNow(-7),
    windows: [
      { key: 'five_hour', remaining: 83, used: 17, total: 100, unit: '%', resetAt: minutesFromNow(37), available: true },
      { key: 'weekly', remaining: 61, used: 39, total: 100, unit: '%', resetAt: daysFromNow(4.4), available: true },
    ],
  },
  {
    id: 'deepseek-cny', providerId: 'deepseek', name: 'API 余额', identity: 'CNY', tags: ['API'], status: 'active', lastChecked: minutesFromNow(-12),
    windows: [{ key: 'balance', remaining: 78.2, used: 21.8, total: 100, unit: '¥', amount: 78.2, limitAmount: 100, resetAt: null, available: true }],
  },
  {
    id: 'wlb-shared', providerId: 'wlb', name: '共享中转', identity: 'coding', tags: ['中转', '低优先'], status: 'active', lastChecked: minutesFromNow(-5),
    windows: [{ key: 'weekly', remaining: 36, used: 64, total: 100, unit: '%', resetAt: daysFromNow(1.52), available: true }],
  },
];

export const cloneWindows = (keys, source = initialAccounts[0].windows) => keys.map((key) => {
  const existing = source.find((item) => item.key === key);
  return existing ? { ...existing } : { key, remaining: 100, used: 0, total: 100, unit: '%', resetAt: minutesFromNow(120), available: true };
});
