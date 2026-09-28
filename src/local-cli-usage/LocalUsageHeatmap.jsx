// 本机用量热力图视图:四张统计卡 + 近一年日历热力图 + 选中日模型横向滚动区。
// 热力图结构与官方用量页同口径(组合 provider-heatmap 类),色阶改用
// log1p + 当前筛选 P95,统计卡沿用相同四项指标语义。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Flame, TrendingUp, Trophy } from 'lucide-react';
import { formatLocalTokensCompact, formatLocalTokensExact, formatLocalDayLabel, localHeatmapLevel, localHeatmapMax, localAgentsLine } from './local-cli-usage-format';
import MergeSameModelsToggle from './MergeSameModelsToggle';

const statCard = (key, icon, label, value, title) => (
  <div key={key} className={`local-cli-stat provider-stat ${key}`} title={title || label}>
    <span className="stat-icon">{icon}</span>
    <div className="stat-copy"><span>{label}</span><strong>{value}</strong></div>
  </div>
);

export default function LocalUsageHeatmap({ summary, selectedDate, onSelectDate, dayModels, dayModelsLoading, sources, selectedAgent, canMergeModels, mergeSameModels, onToggleMerge }) {
  const days = useMemo(() => (summary?.days || []).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day?.date))), [summary]);
  const heatmapRef = useRef(null);
  const wrapRef = useRef(null);
  const [cellPx, setCellPx] = useState(8);
  const [cellH, setCellH] = useState(8);

  // 近 1 年整幅铺满:列宽由容器宽度决定,行高吃满纵向空间(与官方用量页同口径)
  const weekCount = useMemo(() => {
    if (!days.length) return 1;
    const first = days[0].date.split('-').map(Number);
    const leading = (new Date(Date.UTC(first[0], first[1] - 1, first[2])).getUTCDay() + 6) % 7;
    return Math.max(1, Math.ceil((leading + days.length) / 7));
  }, [days]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => {
      const avail = el.clientWidth - 8 - 10 - 7;
      const w = Math.min(12, Math.max(5, Math.floor(avail / weekCount)));
      const h = Math.min(Math.round(w * 1.75), Math.max(w, Math.floor((el.clientHeight - 10 - 2 - 10 - 3) / 7)));
      setCellPx(w);
      setCellH(h);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [weekCount]);

  const maxValue = useMemo(() => localHeatmapMax(days), [days]);
  const info = summary?.summary;
  const agentNames = useMemo(() => Object.fromEntries((sources || []).map((source) => [source.agent, source.displayName])), [sources]);
  // 全部渠道 + 开启合并时,行内不再标注 CLI 来源;关闭合并或单渠道时保留
  // 全部渠道 + 开启合并,或已指定单个渠道时,行内不再标注 CLI 来源
  const hideAgentLabel = (canMergeModels && mergeSameModels) || selectedAgent !== 'all';

  const leading = useMemo(() => {
    if (!days.length) return 0;
    const first = days[0].date.split('-').map(Number);
    return (new Date(Date.UTC(first[0], first[1] - 1, first[2])).getUTCDay() + 6) % 7;
  }, [days]);
  const cells = useMemo(() => [...Array(leading).fill(null), ...days], [leading, days]);
  const monthMarkers = useMemo(() => {
    const markers = [];
    let previous = '';
    cells.forEach((day, index) => {
      if (!day) return;
      const month = day.date.slice(0, 7);
      if (month === previous) return;
      previous = month;
      markers.push({ key: month, label: `${Number(month.slice(5))}月`, column: Math.floor(index / 7) + 1 });
    });
    return markers;
  }, [cells]);

  const selectedDay = days.find((day) => day.date === selectedDate) || null;
  const selectedIndex = selectedDay ? days.indexOf(selectedDay) : -1;

  const dayTitle = (day) => `${day.date} · ${formatLocalTokensExact(day.totalTokens)} Token${day.sessions ? ` · ${day.sessions} 个会话` : ''}`;
  const stepTo = (index) => {
    const next = days[Math.max(0, Math.min(days.length - 1, index))];
    if (!next) return;
    onSelectDate(next.date);
    requestAnimationFrame(() => heatmapRef.current?.querySelector(`[data-local-day="${next.date}"]`)?.focus());
  };
  const handleKey = (event) => {
    if (!days.length) return;
    const base = selectedIndex >= 0 ? selectedIndex : days.length - 1;
    if (event.key === 'Home') { event.preventDefault(); stepTo(0); return; }
    if (event.key === 'End') { event.preventDefault(); stepTo(days.length - 1); return; }
    const delta = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    stepTo(base + delta);
  };

  const coverageLabel = info && info.coverageComplete === false ? '已覆盖区间 Token' : '累计消耗 Token';
  const stats = info ? [
    statCard('tokens', <Bot size={13} />, coverageLabel, formatLocalTokensCompact(info.totalTokens), `${formatLocalTokensExact(info.totalTokens)} Token(全部已索引历史)`),
    statCard('peak', <TrendingUp size={13} />, '峰值消耗 Token', formatLocalTokensCompact(info.peakTokens), `近一年单日最高:${formatLocalTokensExact(info.peakTokens)} Token`),
    statCard('streak', <Flame size={13} />, '当前连续', `${info.currentStreakDays} 天`, '从今天向前连续有 Token 的天数'),
    statCard('longest', <Trophy size={13} />, '最长连续', `${info.longestStreakDays} 天`, '全部已索引日期中的最长连续使用天数'),
  ] : [];

  return <div className="local-cli-heatmap-view">
    {!!stats.length && <div className="provider-usage-summary local-cli-stats">{stats}</div>}
    <div className="provider-heatmap-head">
      <span className="provider-heatmap-title">近 1 年本机使用热力图</span>
      <div className="provider-heatmap-legend" aria-hidden="true" title="颜色深浅按当前筛选范围强度缩放,悬停方格显示准确 Token">
        <span>较少</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`provider-heatmap-cell level-${level}`} />)}<span>较多</span>
      </div>
    </div>
    <div className="provider-heatmap-scroll local-cli-heatmap-scroll" role="grid" tabIndex={0} aria-label="近 1 年本机 CLI Token 热力图,方向键选择日期" ref={wrapRef} onKeyDown={handleKey}>
      <div className="provider-heatmap-board" ref={heatmapRef} style={{ '--hm-cell': `${cellPx}px`, '--hm-cell-h': `${cellH}px` }}>
        <span className="provider-heatmap-corner" aria-hidden="true" />
        <div className="provider-heatmap-months" aria-hidden="true" style={{ width: `${weekCount * cellPx}px` }}>{monthMarkers.map((item) => <span key={item.key} style={{ left: `${(item.column - 1) * cellPx}px` }}>{item.label}</span>)}</div>
        <div className="provider-heatmap-weekdays" aria-hidden="true"><span>一</span><span /><span>三</span><span /><span>五</span><span /><span>日</span></div>
        <div className="provider-heatmap-grid" role="rowgroup" aria-label="每日 Token 热力图">
          {cells.map((day, index) => day
            ? <button type="button" role="gridcell" key={day.date} data-local-day={day.date} tabIndex={selectedDate === day.date ? 0 : -1} aria-selected={selectedDate === day.date} title={dayTitle(day)} aria-label={dayTitle(day)} className={`provider-heatmap-cell level-${localHeatmapLevel(day.totalTokens, maxValue)}${selectedDate === day.date ? ' selected' : ''}`} onFocus={() => onSelectDate(day.date)} onClick={() => onSelectDate(day.date)} />
            : <span key={`blank-${index}`} className="provider-heatmap-cell blank" aria-hidden="true" />)}
        </div>
      </div>
    </div>
    <div className="local-cli-day-models">
      <div className="local-cli-day-models-head">
        <span className="local-cli-day-models-title">
          {selectedDay ? `${formatLocalDayLabel(selectedDay.date)} · ${formatLocalTokensCompact(selectedDay.totalTokens)} Token` : '选择一个日期查看当日模型'}
        </span>
        {canMergeModels && <MergeSameModelsToggle checked={mergeSameModels} onChange={onToggleMerge} />}
      </div>
      <div className="local-cli-day-models-frame">
        <div className="local-cli-day-models-scroll" tabIndex={0} aria-label="当日模型列表,横向滚动">
          <div className="local-cli-day-models-track">
            {dayModelsLoading && !dayModels?.models?.length ? <span className="local-cli-models-hint">正在读取当日模型…</span>
              : !selectedDate || !(dayModels?.models || []).length ? <span className="local-cli-models-hint">这一天没有本机用量记录</span>
                : dayModels.models.map((model) => <div
                  key={`${model.modelKey}-${model.agents.join('-')}`} className="local-cli-day-model-card"
                  title={`${model.displayName}${model.rawModels.length > 1 ? `(${model.rawModels.length} 个原始名称)` : ''}\n${hideAgentLabel ? '' : `${localAgentsLine(model.agents, agentNames, 99)} · `}${formatLocalTokensExact(model.totalTokens)} Token`}
                >
                  <div className="local-cli-day-model-card-head"><b>{model.displayName}</b>{!hideAgentLabel && <small>{localAgentsLine(model.agents, agentNames)}</small>}</div>
                  <em>{formatLocalTokensCompact(model.totalTokens)}</em>
                </div>)}
          </div>
        </div>
      </div>
    </div>
  </div>;
}
