import { useState } from 'react';
import { windowCatalog } from './data';

export const durationOrder = { five_hour: 1, daily: 2, weekly: 3, monthly: 4, balance: 5 };

export function ConcentricRings({ account, formatAmount, formatReset }) {
  const meters = [...(account.windows || [])].sort((a, b) => (durationOrder[b.key] || 9) - (durationOrder[a.key] || 9)).slice(0, 4);
  const smallest = meters.reduce((current, meter) => !current || (durationOrder[meter.key] || 9) < (durationOrder[current.key] || 9) ? meter : current, null);
  const [hoveredKey, setHoveredKey] = useState(null);
  const unavailable = meters.find((meter) => meter.available === false);
  const active = unavailable || meters.find((meter) => meter.key === hoveredKey) || smallest;
  return <div className="concentric-rings" aria-label={`${meters.length} 个额度窗口`}>
    {meters.map((meter, index) => <div className={`quota-ring ring-${index} ${active?.key === meter.key ? 'is-active' : ''}`} key={meter.key} style={{ '--progress': `${Math.max(0, Math.min(100, Number(meter.remaining || 0))) * 3.6}deg` }} onMouseEnter={() => setHoveredKey(meter.key)} onMouseLeave={() => setHoveredKey(null)}><span /></div>)}
    <div className={`ring-core ${unavailable ? 'unavailable' : ''}`}><strong>{unavailable ? '不可用' : active ? formatAmount(active) : '—'}</strong><small>{active ? windowCatalog[active.key]?.label || active.key : '暂无窗口'}</small>{!unavailable && active?.resetAt && <em>{formatReset(active.resetAt)}</em>}</div>
  </div>;
}
