// 模型拆分视图:不显示统计卡,标题下直接进入模型数据。
// 列为 模型 / Token 用量 / 缓存命中率 / 占比;缓存命中率 = 缓存读取 /(新输入+缓存读取+缓存写入),
// 该渠道不提供缓存字段时显示 —。合并开关只改变分组,不改变每行数值,条宽不按合并归一化。
import { useMemo } from 'react';
import { formatLocalTokensCompact, formatLocalTokensExact, formatLocalPercent, localAgentsLine } from './local-cli-usage-format';
import MergeSameModelsToggle from './MergeSameModelsToggle';

const RANGES = [
  { days: 7, label: '7天' },
  { days: 30, label: '30天' },
  { days: 90, label: '90天' },
  { days: 365, label: '1年' },
];

const cacheHitRatio = (row) => {
  const base = (row.inputTokens || 0) + (row.cacheReadTokens || 0) + (row.cacheWriteTokens || 0);
  if (base <= 0) return null;
  return (row.cacheReadTokens || 0) / base;
};

export default function LocalUsageModelBreakdown({ report, loading, error, rangeDays, onRangeChange, canMergeModels, mergeSameModels, onToggleMerge, sources, selectedAgent }) {
  const agentNames = useMemo(() => Object.fromEntries((sources || []).map((source) => [source.agent, source.displayName])), [sources]);
  const models = report?.models || [];
  // 全部渠道 + 开启合并,或已指定单个渠道时,行内不再标注 CLI 来源
  const hideAgentLabel = (canMergeModels && mergeSameModels) || selectedAgent !== 'all';
  // 合并开关只改变分组,不改变每行数值;条宽按各行自身 total,不按合并后归一化
  const maxTotal = useMemo(() => models.reduce((max, row) => Math.max(max, row.totalTokens), 0), [models]);

  return <div className="local-cli-models-view">
    <div className="local-cli-model-toolbar">
      {canMergeModels && <MergeSameModelsToggle checked={mergeSameModels} onChange={onToggleMerge} />}
      <div className="seg-control local-cli-range-switch" role="group" aria-label="模型统计周期">
        {RANGES.map((range) => <button key={range.days} type="button" className={rangeDays === range.days ? 'active' : ''} onClick={() => onRangeChange(range.days)}>{range.label}</button>)}
      </div>
    </div>
    <div className="local-cli-model-table">
      <div className="local-cli-model-header" aria-hidden="true">
        <span className="col-model">{hideAgentLabel ? '模型' : '模型 / 渠道'}</span>
        <span className="col-bar" />
        <span className="col-total">Token 用量</span>
        <span className="col-cache">缓存命中率</span>
        <span className="col-share">占比</span>
      </div>
      <div className="local-cli-model-list" tabIndex={0} aria-label="模型列表,纵向滚动">
        {loading && !models.length ? <div className="local-cli-models-hint block">正在读取模型数据…</div>
          : error && !models.length ? <div className="local-cli-models-hint block error">{error}</div>
            : !models.length ? <div className="local-cli-models-hint block">这个范围没有本机用量记录</div>
              : models.map((row) => {
                const agentsLine = localAgentsLine(row.agents, agentNames);
                const fullAgents = row.agents.map((id) => agentNames[id] || id).join(' + ');
                const ratio = cacheHitRatio(row);
                const tip = [
                  `${row.displayName}`,
                  `${fullAgents}${row.rawModels.length > 1 ? ` · ${row.rawModels.length} 个原始名称` : ''}`,
                  `新输入 ${formatLocalTokensExact(row.inputTokens)}`,
                  `缓存读取 ${formatLocalTokensExact(row.cacheReadTokens)}`,
                  `缓存写入 ${formatLocalTokensExact(row.cacheWriteTokens)}`,
                  `输出 ${formatLocalTokensExact(row.outputTokens)}`,
                  row.extraTokens > 0 ? `其他 ${formatLocalTokensExact(row.extraTokens)}` : null,
                  `合计 ${formatLocalTokensExact(row.totalTokens)} Token · ${formatLocalTokensExact(row.requests)} 次请求 · ${row.sessions} 个会话`,
                ].filter(Boolean).join('\n');
                return <div key={row.modelKey} className="local-cli-model-row" title={tip}>
                  <div className="col-model">
                    <b>{row.displayName}</b>
                    {!hideAgentLabel && <small>{agentsLine}{!canMergeModels ? '' : row.agents.length > 1 ? ` · ${row.agents.length} 个渠道` : ''}</small>}
                  </div>
                  <div className="col-bar">
                    <span className="local-cli-total-bar" style={{ width: `${maxTotal > 0 ? Math.max(2, Math.round((row.totalTokens / maxTotal) * 100)) : 0}%` }} />
                  </div>
                  <div className="col-total">{formatLocalTokensCompact(row.totalTokens)}</div>
                  <div className="col-cache">{ratio === null ? '—' : formatLocalPercent(ratio)}</div>
                  <div className="col-share">{formatLocalPercent(row.share)}</div>
                </div>;
              })}
      </div>
    </div>
  </div>;
}
