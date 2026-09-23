// 本机用量的展示格式化。Token 数字沿用官方用量页的中文大数口径;
// 渠道颜色/名称映射由 sources 元数据驱动,renderer 不写死平台列表。

const hasFiniteNumber = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));

// 紧凑大数:12.3 万 / 1.2 亿,用于统计卡与模型行
export const formatLocalTokensCompact = (value) => {
  if (!hasFiniteNumber(value)) return '—';
  try {
    const text = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(Number(value));
    return text.replace(/(万亿|亿|万)$/u, ' $1');
  } catch { return String(Number(value)); }
};

// 完整数字:1,234,567,用于 tooltip 与当日明细
export const formatLocalTokensExact = (value) => (hasFiniteNumber(value) ? new Intl.NumberFormat('zh-CN').format(Number(value)) : '—');

export const formatLocalPercent = (value) => (hasFiniteNumber(value) ? `${(Number(value) * 100).toFixed(1)}%` : '—');

const pad2 = (value) => String(value).padStart(2, '0');

// 2026-09-23 → 9月23日(热力图选中日标题)
export const formatLocalDayLabel = (dateString) => {
  const parts = String(dateString || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return String(dateString || '');
  return `${parts[1]}月${parts[2]}日`;
};

export const formatLocalDateTime = (isoString) => {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

export const localSourceStatusLabel = (status) => ({
  ready: '正常',
  missing: '未检测到',
  partial: '数据可能不完整',
  incompatible: '格式不兼容',
  error: '读取失败',
}[status] || status);

// 渠道身份色:从可访问性调色板按 colorToken 引用现有 CSS 变量
export const localAgentColor = (colorToken) => `var(--${colorToken || 'green-deep'})`;

// 合并行的渠道标注:≤2 个列名称,>2 个显示"首个渠道等 N 个渠道"
export const localAgentsLine = (agents, displayNameById, max = 2) => {
  const names = (agents || []).map((id) => displayNameById[id] || id);
  if (names.length <= max) return names.join(' + ');
  return `${names.slice(0, 1)[0]}等 ${names.length} 个渠道`;
};

// 热力图色阶:与官方用量页一致的 5 档,但按"当日值 / 筛选范围最大值"分级。
// 绝对阈值(官方页用固定 1000万/3000万/8000万)在不同用户量级下会全挤在一档,
// 相对分级让少量使用和大渠道都能看出波动;tooltip 始终显示准确 Token
export const localHeatmapLevel = (value, max) => {
  const total = Number(value) || 0;
  if (total <= 0 || !Number.isFinite(Number(max)) || Number(max) <= 0) return '0';
  const ratio = total / Number(max);
  if (ratio < 0.1) return '1';
  if (ratio < 0.3) return '2';
  if (ratio < 0.6) return '3';
  return '4';
};

export const localHeatmapMax = (days) => (days || []).reduce((max, day) => Math.max(max, Number(day?.totalTokens) || 0), 0);

// renderer 派生:是否允许合并(只有全部渠道才有意义)
export const canMergeModelsFor = (selectedAgent) => selectedAgent === 'all';

// 系统时区(app 内其他日期逻辑均按本机时区展示)
export const localTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch { return 'UTC'; }
};
