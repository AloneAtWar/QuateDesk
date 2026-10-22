import { useEffect, useRef, useState } from 'react';
import { bindBoardPullRefresh, boardPullMetrics, boardPullVisual } from './board-pull-refresh';

export function useBoardPullRefresh({ enabled, refreshing, onRefresh, pageScroll = false }) {
  const ref = useRef(null);
  const latest = useRef({ refreshing, onRefresh });
  latest.current = { refreshing, onRefresh };
  const [distance, setDistance] = useState(0);
  const [metrics, setMetrics] = useState(() => boardPullMetrics(0, 0));
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const viewport = pageScroll ? document.documentElement : element;
    const measure = () => {
      const next = boardPullMetrics(viewport.clientWidth, viewport.clientHeight);
      setMetrics((previous) => previous.iconSize === next.iconSize && previous.threshold === next.threshold ? previous : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [enabled, pageScroll]);
  useEffect(() => {
    if (!enabled || refreshing || !ref.current) {
      setDistance(0);
      return;
    }
    return bindBoardPullRefresh(ref.current, {
      onPull: setDistance,
      isBusy: () => latest.current.refreshing,
      onRefresh: () => latest.current.onRefresh(),
      scrollElement: pageScroll ? document.scrollingElement : ref.current,
    });
  }, [enabled, refreshing, pageScroll, metrics.iconSize, metrics.threshold]);
  return {
    ref, distance, iconSize: metrics.iconSize,
    ...boardPullVisual(distance, metrics),
  };
}
