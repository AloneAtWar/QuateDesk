import { useState } from 'react';
import { windowCatalog } from './data';

// 与 main.jsx 的 durationOrder 保持同序：Antigravity 池窗口（agy_*）排入 5h / 7d 序列，
// 动态窗口（agy_pool_*，不在 windowCatalog）的 label 随 meter 下发
export const durationOrder = { five_hour: 1, daily: 2, weekly: 3, monthly: 4, balance: 5, agy_gemini_5h: 1.1, agy_claudegpt_5h: 1.2, agy_gemini_7d: 3.1, agy_claudegpt_7d: 3.2 };

export function ConcentricRings({ account, formatAmount }) {
  // 与 main.jsx 同款：未知周期 key 兜底 99，超 4 环时先被裁
  const meters = [...(account.windows || [])].sort((a, b) => ((durationOrder[b.key] || 99) - (durationOrder[a.key] || 99))).slice(0, 4);
  const smallest = meters.reduce((current, meter) => !current || (durationOrder[meter.key] || 99) < (durationOrder[current.key] || 99) ? meter : current, null);
  const [hoveredKey, setHoveredKey] = useState(null);
  const unavailable = meters.find((meter) => meter.available === false);
  const active = unavailable || meters.find((meter) => meter.key === hoveredKey) || smallest;
  return <div className="concentric-rings" aria-label={`${meters.length} 个额度窗口`}>
    {meters.map((meter, index) => <div className={`quota-ring ring-${index} ${active?.key === meter.key ? 'is-active' : ''}`} key={meter.key} style={{ '--progress': `${Math.max(0, Math.min(100, Number(meter.remaining || 0))) * 3.6}deg` }} onMouseEnter={() => setHoveredKey(meter.key)} onMouseLeave={() => setHoveredKey(null)}><span /></div>)}
    <div className={`ring-core ${unavailable ? 'unavailable' : ''}`}><strong>{unavailable ? '不可用' : active ? formatAmount(active) : '—'}</strong><small>{active ? active.label || windowCatalog[active.key]?.label || active.key : '暂无窗口'}</small></div>
  </div>;
}
