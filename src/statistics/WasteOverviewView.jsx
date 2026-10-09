import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, Info, RefreshCw, Trash2 } from 'lucide-react';
import { accountWasteWindows, buildWasteReport, createWasteRange, formatWasteAmount, formatWasteDate, formatWastePercent, loadWasteArchives, WASTE_RANGES } from '../waste-statistics';
import { ResizeHandle, useResizableHeight } from '../resize-handle';

const cycleDates = (cycle) => `${formatWasteDate(cycle.from, true)} → ${formatWasteDate(cycle.end, true)}`;
const exclusionReason = (cycle) => cycle.kind !== 'natural' ? '提前结束，未计入' : cycle.remaining == null ? '额度数据缺失，未计入' : '记录不可靠，未计入';
const cycleValue = (cycle) => `${!cycle.counted && cycle.remaining != null ? '≤ ' : ''}${formatWastePercent(cycle.remaining)}`;

function WasteChart({ buckets, selectedId, onSelect, hasData, plotHeight = null, plotRef = null }) {
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.total || 0));
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const maximum = Math.ceil(peak / magnitude) * magnitude;
  const step = maximum / 5;
  return <section className="global-waste-chart" aria-label="历史浪费趋势">
    <div className="global-waste-block-head"><b>历史浪费趋势</b><small>份周期额度</small></div>
    <div className="global-waste-plot" ref={plotRef} style={plotHeight !== null ? { '--waste-plot-height': `${plotHeight}px` } : undefined}>
      <div className="global-waste-axis" aria-hidden="true">{[5, 4, 3, 2, 1, 0].map((tick) => <span key={tick}>{formatWasteAmount(step * tick)}</span>)}</div>
      <div className="global-waste-bars" style={{ '--waste-columns': buckets.length }}>
        <div className="global-waste-gridlines" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((tick) => <i key={tick} />)}</div>
        {buckets.map((bucket) => <button type="button" key={bucket.id} className={`global-waste-bar-button${selectedId === bucket.id ? ' selected' : ''}${bucket.total == null ? ' unknown' : ''}`} aria-pressed={selectedId === bucket.id} aria-label={`${bucket.dateLabel}，${bucket.total == null ? '无可靠记录' : `浪费 ${formatWasteAmount(bucket.total)} 份，${bucket.count} 个有效周期`}，查看账号贡献`} title={`${bucket.dateLabel}\n${bucket.total == null ? '无可靠记录' : `${formatWasteAmount(bucket.total)} 份 · ${bucket.count} 个有效周期`}`} onClick={() => onSelect(bucket.id)}>
          <span className="global-waste-bar-area"><span className="global-waste-bar" style={{ height: bucket.total == null ? '0%' : `${bucket.total / maximum * 100}%` }}><b>{formatWasteAmount(bucket.total)}</b></span></span>
          <span className="global-waste-bar-label"><strong>{bucket.label}</strong><small>{buckets.length <= 4 ? bucket.dateLabel : formatWasteDate(bucket.start)}</small></span>
        </button>)}
        {!hasData && <span className="global-waste-chart-empty">此范围暂无可靠周期记录</span>}
      </div>
    </div>
  </section>;
}

export default function WasteOverviewView({ accounts, providers, Logo, api = window.quotaDesk, active = true, onApi, onMetaChange }) {
  const [months, setMonths] = useState(1);
  const [windowKey, setWindowKey] = useState('weekly');
  const [rangeNow, setRangeNow] = useState(() => new Date());
  const [selectedId, setSelectedId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [data, setData] = useState({ archives: {}, loading: true, error: '', loadedAt: null });
  const requestId = useRef(0);
  const contributionsRef = useRef(null);
  // 贡献表是页面唯一的弹性区域(flex:1,最小 112px):两个手柄的动态上限
  // 都从它的余量里扣,拖到上限时贡献表刚好到最小高度,任何元素都不会被挤出
  const slack = useCallback(() => {
    const el = contributionsRef.current;
    return el ? Math.max(0, el.getBoundingClientRect().height - 112) : 0;
  }, []);
  // 趋势图可拖拽调高(默认沿用样式表,宽窗断点下更高),贡献表随 flex 自适应收缩
  const chartMeasure = useCallback((el) => el?.querySelector('.global-waste-bar-area')?.getBoundingClientRect().height || 0, []);
  const chartResize = useResizableHeight('qd-resize:waste-chart', {
    min: 48, max: 360, grow: 'down',
    measure: chartMeasure,
    limit: (el) => chartMeasure(el) + slack(),
  });
  // 汇总卡条也可拖拽调高,与趋势图共用贡献表余量
  const summaryResize = useResizableHeight('qd-resize:waste-summary', {
    min: 60, max: 150, grow: 'down',
    limit: (el) => (el?.getBoundingClientRect().height || 0) + slack(),
  });
  const mounted = useRef(false);
  const eligible = accounts.filter((account) => accountWasteWindows(account, providers.find((provider) => provider.id === account.providerId)).length > 0);
  const loadKey = JSON.stringify(eligible.map((account) => [account.id, account.lastChecked]));
  const idsRef = useRef([]);
  idsRef.current = eligible.map((account) => account.id);
  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    setData((previous) => ({ ...previous, loading: true, error: '' }));
    try {
      const archives = await loadWasteArchives(api, idsRef.current);
      if (!mounted.current || request !== requestId.current) return;
      setRangeNow(new Date());
      setData({ archives, loading: false, error: '', loadedAt: new Date().toISOString() });
    } catch (error) {
      if (mounted.current && request === requestId.current) setData((previous) => ({ ...previous, loading: false, error: error.message || '读取历史周期失败，请重试。' }));
    }
  }, [api]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current += 1; }; }, []);
  useEffect(() => { if (active) refresh(); }, [active, loadKey, refresh]);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setRangeNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { onApi?.({ refresh }); return () => onApi?.(null); }, [refresh, onApi]);
  useEffect(() => { onMetaChange?.({ loading: data.loading, loadedAt: data.loadedAt }); }, [data.loading, data.loadedAt, onMetaChange]);
  const range = useMemo(() => createWasteRange(months, rangeNow), [months, rangeNow]);
  const report = useMemo(() => buildWasteReport({ accounts, providers, archives: data.archives, windowKey, range }), [accounts, providers, data.archives, windowKey, range]);
  const selected = report.buckets.find((bucket) => bucket.id === selectedId);
  const detail = selected || report;
  const selectBucket = (id) => { setSelectedId(id === selectedId ? null : id); setExpandedId(null); };
  const changeRange = (value) => { setMonths(Number(value)); setRangeNow(new Date()); setSelectedId(null); setExpandedId(null); };
  const accountById = (id) => accounts.find((account) => account.id === id);
  const providerFor = (account) => providers.find((provider) => provider.id === account?.providerId);
  return <section className="surface-section global-waste-page" aria-label="全局额度浪费" aria-busy={data.loading}>
    <div className="global-waste-page-head">
      <div><small>{range.dateLabel} · 全部账号</small></div>
      <div className="global-waste-filters">
        <select aria-label="额度类型" value={windowKey} onChange={(event) => { setWindowKey(event.target.value); setSelectedId(null); setExpandedId(null); }}><option value="weekly">周额度</option><option value="monthly">月额度</option></select>
        <select aria-label="统计时间范围" value={months} onChange={(event) => changeRange(event.target.value)}>{WASTE_RANGES.map((item) => <option key={item.months} value={item.months}>{item.label}</option>)}</select>
      </div>
    </div>
    {data.error ? <div className="local-cli-state-card global-waste-state" role="alert"><AlertCircle size={27} /><div><b>无法读取完整的历史浪费</b><small>{data.error}</small></div><button type="button" className="outline-button" onClick={refresh}><RefreshCw size={12} />重新读取</button></div>
      : data.loading ? <div className="local-cli-state-card global-waste-state" role="status"><RefreshCw size={27} className="spinning" /><div><b>正在读取历史周期</b><small>汇总所有账号的已结束周期…</small></div></div> : <>
        <div className="global-waste-summary" ref={summaryResize.targetRef} style={summaryResize.height !== null ? { height: `${summaryResize.height}px`, minHeight: `${summaryResize.height}px` } : undefined}>
          <div className="global-waste-total"><span className="global-waste-icon"><Trash2 size={18} /></span><div><small>累计浪费</small><div><b>{formatWasteAmount(report.total)}</b><span>份周期额度</span></div><em>各周期总额度记为 1 份</em></div></div>
          <div className="global-waste-metric"><small>平均浪费</small><b>{formatWastePercent(report.average)}</b></div>
          <div className="global-waste-metric"><small>有效周期</small><b>{report.count}<span> 个</span></b></div>
        </div>
        <ResizeHandle handleProps={summaryResize.handleProps} label="汇总卡条" />
        <WasteChart buckets={report.buckets} selectedId={selected?.id} onSelect={selectBucket} hasData={report.count > 0} plotHeight={chartResize.height} plotRef={chartResize.targetRef} />
        <ResizeHandle handleProps={chartResize.handleProps} label="趋势图" />
        <section className="global-waste-contributions" aria-label="账号浪费贡献" ref={contributionsRef}>
          <div className="global-waste-detail-head"><div><b>{selected ? `${selected.dateLabel} 的浪费` : '整个范围的浪费'}</b><small>合计 <strong>{formatWasteAmount(detail.total)}</strong> 份 · {detail.accounts.length} 个浪费账号</small></div>{selected && <button type="button" onClick={() => { setSelectedId(null); setExpandedId(null); }}>查看整个范围</button>}</div>
          <div className="global-waste-accounts-scroll" tabIndex={0} aria-label="账号贡献列表，可滚动查看" key={selected?.id || `${months}:${windowKey}`}>
            <table className="global-waste-accounts"><thead><tr><th scope="col">账号</th><th scope="col">浪费</th><th scope="col">{selected ? '占本段' : '占总浪费'}</th><th scope="col"><span className="sr-only">周期明细</span></th></tr></thead><tbody>
              {detail.accounts.map((entry) => {
                const account = accountById(entry.accountId);
                return <Fragment key={entry.accountId}><tr>
                  <td><button type="button" className="global-waste-account-toggle" aria-expanded={expandedId === entry.accountId} aria-label={`${account?.name || entry.accountId}，查看周期明细`} onClick={() => setExpandedId(expandedId === entry.accountId ? null : entry.accountId)}>{Logo && <Logo provider={providerFor(account)} size="sm" interactive={false} />}<strong title={account?.name}>{account?.name || entry.accountId}</strong></button></td>
                  <td>{formatWasteAmount(entry.total)} <small>份</small></td><td>{formatWastePercent(entry.share)}</td><td><button type="button" className="global-waste-expand" aria-expanded={expandedId === entry.accountId} aria-label={`${expandedId === entry.accountId ? '收起' : '展开'} ${account?.name || entry.accountId} 的周期`} onClick={() => setExpandedId(expandedId === entry.accountId ? null : entry.accountId)}><ChevronDown size={13} /></button></td>
                </tr>{expandedId === entry.accountId && <tr><td colSpan={4} className="global-waste-cycle-cell"><div className="global-waste-cycles"><small>{entry.count} 个有效周期 · 按实际周期结束日期归入本范围</small>{entry.cycles.map((cycle) => <div key={`${cycle.kind}:${cycle.end}`} className={!cycle.counted ? 'excluded' : ''}><span title={cycleDates(cycle)}>{cycleDates(cycle)}<small>{cycle.counted ? '自然结束' : exclusionReason(cycle)}</small></span><b>{cycleValue(cycle)}</b></div>)}</div></td></tr>}</Fragment>;
              })}
              {!detail.accounts.length && <tr><td colSpan={4} className="global-waste-empty">{detail.count ? '这些已结束周期没有浪费。' : '暂无可靠记录，不能确认此范围的浪费。'}</td></tr>}
            </tbody></table>
          </div>
        </section>

        <div className="global-waste-footnote">
          <Info size={11} /><span>仅可靠、自然结束的周期计入统计</span>
          {detail.excluded.length > 0 && <details className="global-waste-excluded">
            <summary>{detail.excluded.length} 条记录未计入统计</summary>
            <div>{detail.excluded.map((cycle) => <div key={`${cycle.accountId}:${cycle.kind}:${cycle.end}`}>
              <span>{accountById(cycle.accountId)?.name || cycle.accountId} · {formatWasteDate(cycle.end, true)}<small>{exclusionReason(cycle)}</small></span>
              <b>{cycleValue(cycle)}</b>
            </div>)}</div>
          </details>}
          <Info size={11} tabIndex={0} aria-label="累计浪费以各周期总额度为一份归一化相加；平均浪费按有效周期等权计算；不代表金额或 Token。" title="累计浪费以各周期总额度为 1 份归一化相加；平均浪费按有效周期等权计算，不代表金额或 Token。" />
        </div>
      </>}
  </section>;
}
