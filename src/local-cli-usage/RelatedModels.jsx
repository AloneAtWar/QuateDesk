import { useLayoutEffect, useRef, useState } from 'react';
import { fitModelChips } from './fit-model-chips';

export default function RelatedModels({ models, loading }) {
  const tagsRef = useRef(null);
  const measureRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(0);

  useLayoutEffect(() => {
    const tags = tagsRef.current;
    const measure = measureRef.current;
    if (!tags || !measure) return undefined;
    const chips = [...measure.querySelectorAll('.local-cli-model-chip')];
    const more = measure.querySelector('.local-cli-model-more');
    const update = () => {
      const gap = parseFloat(getComputedStyle(measure).columnGap) || 0;
      setVisibleCount(fitModelChips(chips.map(chip => chip.getBoundingClientRect().width), tags.clientWidth, gap, more.getBoundingClientRect().width));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(tags);
    chips.forEach(chip => observer.observe(chip));
    observer.observe(more);
    return () => observer.disconnect();
  }, [models]);

  const hiddenNames = models.slice(visibleCount).map(model => model.displayName).join('、');
  return <div className="local-cli-scope-models">
    <span title="显示当前渠道下实际命中模型规则的本机 CLI 模型。记录可能同时匹配多个厂商，不代表由当前账号产生。">相关模型</span>
    <div className="local-cli-model-tags" ref={tagsRef}>
      <div className="local-cli-model-tags-row">
        {models.slice(0, visibleCount).map(model => <span className="local-cli-model-chip" key={model.key} title={model.displayName}>{model.displayName}</span>)}
        {visibleCount < models.length && <span className="local-cli-model-more" title={hiddenNames} aria-label={`更多相关模型：${hiddenNames}`}>...</span>}
        {!models.length && <em>{loading ? '读取中…' : '暂无数据'}</em>}
      </div>
      <div className="local-cli-model-tags-row local-cli-model-measure" ref={measureRef} aria-hidden="true">
        {models.map(model => <span className="local-cli-model-chip" key={model.key}>{model.displayName}</span>)}
        <span className="local-cli-model-more">...</span>
      </div>
    </div>
  </div>;
}
