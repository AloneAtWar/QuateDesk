export const adapterRegistry = {
  kimi: {
    id: 'kimi',
    label: 'Kimi for Coding',
    endpoint: 'https://api.kimi.com/coding/v1/usages',
    auth: 'bearer',
    windows: ['five_hour', 'weekly'],
  },
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
    windows: ['weekly'],
  },
};

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const daysFromNow = (days) => minutesFromNow(days * 24 * 60);

export const providerCatalog = [
  { id: 'kimi', name: 'Kimi', legalName: 'Kimi for Coding', monogram: 'K', tone: 'sky', adapter: 'kimi', logo: './logos/kimi.png', website: 'https://www.kimi.com/' },
  { id: 'zai', name: 'Z.ai', legalName: 'Z.ai / 智谱', monogram: 'Z', tone: 'violet', adapter: 'zai', logo: './logos/zai.svg', website: 'https://bigmodel.cn/' },
  { id: 'deepseek', name: 'DeepSeek', legalName: 'DeepSeek API', monogram: 'D', tone: 'blue', adapter: 'deepseek', logo: './logos/deepseek.png', website: 'https://www.deepseek.com/' },
  { id: 'wlb', name: 'wlbclub', legalName: 'wlbclub', monogram: 'W', tone: 'coral', adapter: 'wlb', website: 'https://www.wlbclub.com/' },
];

export const windowCatalog = {
  five_hour: { key: 'five_hour', label: '5 小时', short: '5h', group: '短周期', color: 'cyan' },
  weekly: { key: 'weekly', label: '7 天', short: '7d', group: '中周期', color: 'violet' },
  monthly: { key: 'monthly', label: '1个月', short: '月', group: '长周期', color: 'coral' },
  balance: { key: 'balance', label: '余额', short: '余额', group: '余额', color: 'green' },
};

export const initialAccounts = [
  {
    id: 'kimi-main', providerId: 'kimi', name: '主力账号', identity: 'hello@northstar.dev', tags: ['日常', '主力'], status: 'active', lastChecked: minutesFromNow(-3),
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
