import { useLayoutEffect, useRef, useState } from 'react';

// Probe the actual rendered content before removing anything. The first two
// quota values and provider icon always survive; names shrink before hiding.
export function WidgetFitRow({ accountId, name, error, tags = [], meters, logo, scale = 1, textSettings }) {
  const rowRef = useRef(null);
  const probesRef = useRef(null);
  const [stage, setStage] = useState(0);
  const [spacing, setSpacing] = useState({ offset: 0, groupGap: 5, innerGap: 3 });
  const minimumNameWidth = 2 * (textSettings?.name?.size || 11) * Math.max(1, scale);
  useLayoutEffect(() => {
    let active = true;
    const measure = () => {
      if (!active || !rowRef.current || !probesRef.current) return;
      const available = rowRef.current.getBoundingClientRect().width;
      const probes = [...probesRef.current.children];
      const index = probes.findIndex((probe) => probe.getBoundingClientRect().width <= available + 0.5);
      const nextStage = index < 0 ? probes.length - 1 : index;
      setStage(nextStage);
      // Spend a small share of spare width on capped reading gaps, then move
      // the quota group right. Compact stages reserve their space for text.
      const spare = nextStage === 0 ? Math.max(0, available - probes[0].getBoundingClientRect().width) : 0;
      const spread = Math.min(1, spare / 180);
      const innerExtra = 3 * spread;
      const groupExtra = 5 * spread;
      const readingSpace = meters.reduce((sum, meter) => sum + (meter.label ? 1 : 0) + (meter.reset ? 1 : 0), 0) * innerExtra
        + Math.max(0, meters.length - 1) * groupExtra;
      const next = {
        offset: Math.round(Math.max(0, spare - readingSpace) * 0.85 * 100) / 100,
        groupGap: Math.round((5 + groupExtra) * 100) / 100,
        innerGap: Math.round((3 + innerExtra) * 100) / 100,
      };
      setSpacing((old) => old.offset === next.offset && old.groupGap === next.groupGap && old.innerGap === next.innerGap ? old : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rowRef.current);
    // Font loading can change widths without resizing the outer cell.
    if (probesRef.current) observer.observe(probesRef.current);
    document.fonts?.ready.then(measure);
    document.fonts?.addEventListener('loadingdone', measure);
    return () => { active = false; observer.disconnect(); document.fonts?.removeEventListener('loadingdone', measure); };
  }, [name, tags.join('|'), meters.map((meter) => `${meter.key}|${meter.value}|${meter.reset}|${meter.label}`).join('|'), scale, JSON.stringify(textSettings)]);
  const contents = (level) => <>
    {logo}
    {level < 6 && <div className="widget-account-block">
      <span className="widget-account" title={name}>{name}</span>
      {level === 0 && tags.length > 0 && <span className="widget-tags">{tags.map((tag, index) => <em key={`${tag}-${index}`}>{tag}</em>)}</span>}
    </div>}
    <div className="widget-meters">{(level >= 3 ? meters.slice(0, 2) : meters).map((meter) => <span className={`widget-meter ${meter.off ? 'off' : ''}`} key={meter.key} title={meter.title}>
      {level < 4 && <b>{meter.label}</b>}<em>{meter.value}</em>{level < 2 && <small>{meter.reset}</small>}
    </span>)}{!meters.length && <span className="widget-empty">等待同步</span>}</div>
  </>;
  const classes = (level) => `widget-row widget-cell widget-fit-${level}`;
  return <>
    <div ref={rowRef} className={classes(stage)} title={error || name} data-fit-stage={stage} data-account-id={accountId}
      style={{ '--widget-name-min': `${minimumNameWidth}px`, '--widget-meter-offset': `${spacing.offset}px`,
        '--widget-group-gap': `${spacing.groupGap}px`, '--widget-inner-gap': `${spacing.innerGap}px` }}>{contents(stage)}</div>
    <div className="widget-fit-probes" ref={probesRef} aria-hidden="true" inert style={{ '--widget-name-min': `${minimumNameWidth}px` }}>
      {Array.from({ length: 7 }, (_, level) => <div key={level} className={classes(level)}>{contents(level)}</div>)}
    </div>
  </>;
}
