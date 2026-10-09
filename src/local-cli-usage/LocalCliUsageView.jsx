// 本机用量页:标题栏第四个全局视图。只读展示本机 CLI 会话的 Token 统计,
// 与账号额度、官方用量完全独立。首卡确认后才开始扫描,数据只含聚合数值。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Database, HelpCircle, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import useLocalCliUsage from './useLocalCliUsage';
import ChannelSelect from './ChannelSelect';
import LocalUsageHeatmap from './LocalUsageHeatmap';
import LocalUsageModelBreakdown from './LocalUsageModelBreakdown';
import {
  formatLocalDateTime, localTimeZone, canMergeModelsFor,
} from './local-cli-usage-format';

const VIEWS = [
  { key: 'heatmap', label: '热力图' },
  { key: 'models', label: '模型拆分' },
];

export default function LocalCliUsageView({ settings, setSettings, onApi, onMetaChange, modelRules, scopeName, embedded = false }) {
  const bridge = window.quotaDesk;
  const timezone = useMemo(() => localTimeZone(), []);
  const [activeView, setActiveView] = useState('heatmap');
  const [selectedAgent, setSelectedAgent] = useState('all');
  const [selectedDate, setSelectedDate] = useState(null);
  const [modelRangeDays, setModelRangeDays] = useState(30);
  const {
    sources: sourcesBlock, summary: summaryBlock, dayModels: dayModelsBlock, rangeModels: rangeModelsBlock, scanning,
    refreshSources, refreshSummary, refreshDayModels, refreshRangeModels, scan,
  } = useLocalCliUsage();
  const enabled = settings?.localCliUsage?.enabled === true;
  const queryModelRules = useMemo(() => (Array.isArray(modelRules)
    ? modelRules.map((rule) => ({ mode: rule.mode, value: rule.value }))
    : undefined), [modelRules]);
  const mergeSameModels = settings?.localCliUsage?.mergeSameModels !== false;
  const canMergeModels = canMergeModelsFor(selectedAgent);
  const sources = sourcesBlock.data || [];
  const [scopeMeta, setScopeMeta] = useState({ matchedModels: [], recordsByAgent: null });
  const agentNames = useMemo(() => Object.fromEntries(sources.map((source) => [source.agent, source.displayName])), [sources]);
  // 厂商上下文按规则命中数判断渠道是否可选；全局页直接使用来源总记录数。
  const channelOptions = useMemo(() => sources.map((source) => ({
    id: source.agent,
    label: source.displayName,
    colorToken: source.colorToken,
    status: source.status,
    records: queryModelRules ? scopeMeta.recordsByAgent?.[source.agent] : source.records,
    disabled: queryModelRules
      ? scopeMeta.recordsByAgent !== null && Number(scopeMeta.recordsByAgent?.[source.agent] || 0) <= 0
      : Number(source.records || 0) <= 0,
  })), [sources, queryModelRules, scopeMeta.recordsByAgent]);
  const selectedSource = sources.find((source) => source.agent === selectedAgent) || null;
  const enteredRef = useRef(false);

  const updateMergeSameModels = useCallback((next) => {
    setSettings((old) => ({ ...old, localCliUsage: { ...(old.localCliUsage || {}), mergeSameModels: next } }));
  }, [setSettings]);

  // ---- 数据加载 -----------------------------------------------------------

  const loadSummary = useCallback((agent) => {
    refreshSummary({ agent, timezone, ...(queryModelRules ? { modelRules: queryModelRules } : {}) });
  }, [refreshSummary, timezone, queryModelRules]);

  const loadDayModels = useCallback((agent, date, merge) => {
    if (!date) return;
    refreshDayModels({ agent, mergeSameModels: merge && agent === 'all', scope: { kind: 'day', date }, timezone, ...(queryModelRules ? { modelRules: queryModelRules } : {}) });
  }, [refreshDayModels, timezone, queryModelRules]);

  const loadRangeModels = useCallback((agent, days, merge) => {
    refreshRangeModels({ agent, mergeSameModels: merge && agent === 'all', scope: { kind: 'range', days }, timezone, ...(queryModelRules ? { modelRules: queryModelRules } : {}) });
  }, [refreshRangeModels, timezone, queryModelRules]);

  // 进入页面:并行读 sources 与缓存 summary;已启用时后台轻量增量,完成后刷新
  useEffect(() => {
    if (!bridge?.getLocalCliUsageSources) return undefined;
    if (enteredRef.current) return undefined;
    enteredRef.current = true;
    refreshSources();
    loadSummary(selectedAgent);
    if (enabled && bridge.scanLocalCliUsage) {
      scan().then(() => { refreshSources(); loadSummary(selectedAgent); }).catch(() => {});
    }
    return () => { enteredRef.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 渠道切换:summary 必刷;当前可见的模型数据跟随刷新
  useEffect(() => {
    if (!enteredRef.current) return;
    loadSummary(selectedAgent);
    if (activeView === 'models') loadRangeModels(selectedAgent, modelRangeDays, mergeSameModels);
    else loadDayModels(selectedAgent, selectedDate, mergeSameModels);
  }, [selectedAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!summaryBlock.data) return;
    setScopeMeta({
      matchedModels: Array.isArray(summaryBlock.data.matchedModels) ? summaryBlock.data.matchedModels : [],
      recordsByAgent: summaryBlock.data.recordsByAgent && typeof summaryBlock.data.recordsByAgent === 'object'
        ? summaryBlock.data.recordsByAgent
        : null,
    });
  }, [summaryBlock.data]);

  useEffect(() => {
    if (selectedAgent === 'all') return;
    if (channelOptions.find((option) => option.id === selectedAgent)?.disabled) setSelectedAgent('all');
  }, [channelOptions, selectedAgent]);

  // summary 到达后初始化/校对选中日期:默认最近一个有数据的日期
  useEffect(() => {
    const days = summaryBlock.data?.days || [];
    if (!days.length) return;
    const valid = days.some((day) => day.date === selectedDate && day.totalTokens > 0);
    if (valid) return;
    const latest = [...days].reverse().find((day) => day.totalTokens > 0);
    setSelectedDate(latest ? latest.date : null);
  }, [summaryBlock.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // 选中日期/合并开关变化:刷新当日模型(合并状态只重新请求模型数据,不动热力图)
  useEffect(() => {
    if (!enteredRef.current) return;
    loadDayModels(selectedAgent, selectedDate, mergeSameModels);
  }, [selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enteredRef.current) return;
    if (activeView === 'models') loadRangeModels(selectedAgent, modelRangeDays, mergeSameModels);
    else loadDayModels(selectedAgent, selectedDate, mergeSameModels);
  }, [mergeSameModels, activeView]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enteredRef.current || activeView !== 'models') return;
    loadRangeModels(selectedAgent, modelRangeDays, mergeSameModels);
  }, [modelRangeDays]); // eslint-disable-line react-hooks/exhaustive-deps

  // 标题栏刷新按钮与"最后扫描"时间
  const refreshAll = useCallback(async () => {
    if (!enabled) { refreshSources(); return; }
    await scan();
    refreshSources();
    loadSummary(selectedAgent);
    if (activeView === 'models') loadRangeModels(selectedAgent, modelRangeDays, mergeSameModels);
    else loadDayModels(selectedAgent, selectedDate, mergeSameModels);
  }, [enabled, scan, refreshSources, loadSummary, loadRangeModels, loadDayModels, activeView, selectedAgent, selectedDate, modelRangeDays, mergeSameModels]);

  useEffect(() => { onApi?.({ refresh: refreshAll }); }, [onApi, refreshAll]);
  useEffect(() => { onMetaChange?.({ scanning, lastScannedAt: sources.find((source) => source.lastScannedAt)?.lastScannedAt || null }); }, [onMetaChange, scanning, sources]);

  const startFirstScan = async () => {
    // 只翻转 enabled;mergeSameModels 由 normalizeSettings 与开关自身维护,不在这里重置
    setSettings((old) => ({ ...old, localCliUsage: { ...(old.localCliUsage || {}), enabled: true } }));
    await scan();
    refreshSources();
    loadSummary(selectedAgent);
  };

  // ---- 渲染 ---------------------------------------------------------------

  if (!bridge?.getLocalCliUsageSources) {
    return <section className={`${embedded ? '' : 'surface-section '}local-cli-page${embedded ? ' embedded' : ''}`}>
      <div className="local-cli-state-card"><AlertCircle size={18} /><div><b>本机用量仅在桌面应用中可用</b><small>网页演示模式无法读取本机 CLI 记录。</small></div></div>
    </section>;
  }

  if (!enabled) {
    return <section className={`${embedded ? '' : 'surface-section '}local-cli-page${embedded ? ' embedded' : ''}`}>
      <div className="local-cli-intro-card">
        <span className="local-cli-state-icon"><ShieldCheck size={18} /></span>
        <div className="local-cli-intro-copy">
          <b>统计这台电脑上的 CLI 用量</b>
          <small>从 ZCode、Kimi Code、Claude Code 和 Codex 已保存在本机的会话记录中提取 Token 数字。只保存聚合所需字段，不保存或上传对话正文、代码和命令输出。本机记录与账号额度、官方用量是不同口径，不会合并。</small>
        </div>
        <button type="button" className="primary-button" disabled={scanning} onClick={startFirstScan}><Play size={13} />{scanning ? '正在扫描…' : '开始扫描'}</button>
      </div>
    </section>;
  }

  const body = () => {
    const selectedOption = channelOptions.find((option) => option.id === selectedAgent);
    if (selectedAgent !== 'all' && selectedSource && selectedOption?.disabled && selectedSource.status !== 'ready' && selectedSource.status !== 'partial') {
      const hint = selectedSource.status === 'missing'
        ? `未检测到 ${selectedSource.displayName} 的本机记录,默认目录:${(selectedSource.rootLabels || []).join(' 或 ')}。`
        : selectedSource.status === 'incompatible'
          ? `检测到 ${selectedSource.displayName} 的记录,但当前格式暂不兼容。`
          : `${selectedSource.displayName} 读取失败:${selectedSource.warning || '请稍后重试'}`;
      return <div className="local-cli-state-card"><AlertCircle size={18} /><div><b>{selectedSource.displayName} 暂不可用</b><small>{hint}</small></div></div>;
    }
    if (summaryBlock.error) {
      return <div className="local-cli-state-card"><AlertCircle size={18} /><div><b>本机用量暂时不可用</b><small>{summaryBlock.error}</small></div>
        <button type="button" className="outline-button" onClick={refreshAll}><RefreshCw size={13} /> 重试</button></div>;
    }
    if (summaryBlock.loading && !summaryBlock.data) {
      return <div className="local-cli-state-card loading"><RefreshCw size={17} className="spinning" /><div><b>正在读取本机用量</b><small>聚合近一年 CLI 会话记录</small></div></div>;
    }
    const hasData = (summaryBlock.data?.summary?.activeDays || 0) > 0;
    if (!hasData) {
      return <div className="local-cli-state-card"><Database size={18} /><div><b>{queryModelRules ? `没有找到 ${scopeName || '当前厂商'} 相关的本机用量` : '没有找到可解析的用量记录'}</b><small>{queryModelRules ? '当前模型规则没有匹配到已扫描的 CLI 记录。' : '已扫描本机 CLI 目录,但没有可统计的 Token 记录;正常使用 CLI 后会自动出现。'}</small></div></div>;
    }
    return activeView === 'heatmap'
      ? <LocalUsageHeatmap
        summary={summaryBlock.data}
        selectedDate={selectedDate}
        onSelectDate={setSelectedDate}
        dayModels={dayModelsBlock.data}
        dayModelsLoading={dayModelsBlock.loading}
        sources={sources}
        selectedAgent={selectedAgent}
        canMergeModels={canMergeModels}
        mergeSameModels={mergeSameModels}
        onToggleMerge={updateMergeSameModels}
        resizable={!embedded}
      />
      : <LocalUsageModelBreakdown
        report={rangeModelsBlock.data}
        loading={rangeModelsBlock.loading}
        error={rangeModelsBlock.error}
        rangeDays={modelRangeDays}
        onRangeChange={setModelRangeDays}
        canMergeModels={canMergeModels}
        mergeSameModels={mergeSameModels}
        onToggleMerge={updateMergeSameModels}
        sources={sources}
        selectedAgent={selectedAgent}
      />;
  };

  const lastScanned = sources.find((source) => source.lastScannedAt)?.lastScannedAt;
  const matchedModels = scopeMeta.matchedModels;
  const visibleMatchedModels = matchedModels.slice(0, 2);

  return <section className={`${embedded ? '' : 'surface-section '}local-cli-page${embedded ? ' embedded' : ''}`}>
    <div className="local-cli-page-head">
      {embedded ? <div className="local-cli-scope-models">
        <span>相关模型</span>
        {visibleMatchedModels.map((model) => <span className="local-cli-model-chip" key={model.key} title={model.displayName}>{model.displayName}</span>)}
        {matchedModels.length > visibleMatchedModels.length && <span className="local-cli-model-more" title={matchedModels.slice(visibleMatchedModels.length).map((model) => model.displayName).join('、')}>+{matchedModels.length - visibleMatchedModels.length}</span>}
        {!matchedModels.length && <em>{summaryBlock.loading ? '读取中…' : '暂无数据'}</em>}
        <span className="local-cli-scope-help" title="显示当前渠道下实际命中模型规则的本机 CLI 模型。记录可能同时匹配多个厂商，不代表由当前账号产生。"><HelpCircle size={13} /></span>
      </div> : <div className="local-cli-page-title">
        <b>本机用量</b>
        <small>{lastScanned ? `最后扫描 ${formatLocalDateTime(lastScanned)}` : '尚未完成扫描'}{agentNames[selectedAgent] && selectedAgent !== 'all' ? ` · ${agentNames[selectedAgent]}` : ''}</small>
      </div>}
      <div className="local-cli-page-actions">
        <div className="seg-control local-cli-view-switch" role="tablist" aria-label="本机用量视图">
          {VIEWS.map((view) => <button key={view.key} type="button" role="tab" aria-selected={activeView === view.key} className={activeView === view.key ? 'active' : ''} onClick={() => setActiveView(view.key)}>{view.label}</button>)}
        </div>
        <ChannelSelect value={selectedAgent} options={channelOptions} onChange={setSelectedAgent} />
      </div>
    </div>
    {body()}
  </section>;
}
