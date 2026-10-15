import { useEffect, useMemo, useRef, useState } from 'react';
import { computeWidgetGeometry, clampWidgetInterval, WIDGET_MIN_CELL } from '../electron/widget-layout.mjs';
import { normalizeWidgetText, widgetTextStyles } from '../electron/widget-appearance.mjs';

export function useWidgetGeometry(accounts, settings, formatAmount, preview = false) {
  const fallback = () => ({ width: window.screen.availWidth || 1920, height: window.screen.availHeight || 1080 });
  const [area, setArea] = useState(fallback);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [fontVersion, setFontVersion] = useState(0);
  useEffect(() => {
    let active = true;
    const update = () => { if (active) setFontVersion((old) => old + 1); };
    document.fonts?.ready.then(update);
    document.fonts?.addEventListener('loadingdone', update);
    return () => { active = false; document.fonts?.removeEventListener('loadingdone', update); };
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      window.quotaDesk?.getWidgetWorkArea?.().then((next) => { if (active && next) setArea(next); }).catch(() => {});
    };
    refresh();
    const unsubscribe = window.quotaDesk?.onWidgetWorkAreaChanged?.(refresh);
    window.addEventListener('resize', refresh);
    return () => { active = false; unsubscribe?.(); window.removeEventListener('resize', refresh); };
  }, []);
  const minimum = useMemo(() => {
    const context = document.createElement('canvas').getContext('2d');
    const fonts = normalizeWidgetText(settings).widgetText;
    const quota = fonts.quota;
    if (context) context.font = `${quota.weight} ${quota.size}px ${getComputedStyle(document.documentElement).fontFamily}`;
    const width = Math.max(WIDGET_MIN_CELL.width, ...accounts.filter((item) => !item.disabled).map((item) =>
      50 + (item.windows || []).slice(0, 2).reduce((sum, meter) => sum + Math.ceil(context?.measureText(formatAmount(meter)).width || 60) + 12, 0)));
    return { width: width + (settings.widgetTextOutline ? 4 : 0), height: Math.max(36, Math.ceil(Math.max(...Object.values(fonts).map((font) => font.size)) * 1.6 + 14)) };
  }, [accounts, formatAmount, JSON.stringify(settings.widgetText), settings.widgetTextOutline, fontVersion]);
  useEffect(() => {
    if (!preview) window.quotaDesk?.setWidgetMinimum?.(minimum).catch(() => {});
  }, [minimum.width, minimum.height, preview]);
  const drawerWidth = preview && viewport.width > 700 ? document.querySelector('.settings-drawer')?.getBoundingClientRect().width || 0 : 0;
  const available = preview
    ? { width: Math.min(area.width, Math.max(1, viewport.width - drawerWidth - 44)), height: Math.min(area.height, Math.max(1, viewport.width <= 700 ? Math.min(250, viewport.height * 0.35) : viewport.height - 110)) }
    : area;
  return computeWidgetGeometry(accounts.filter((item) => !item.disabled).length, settings, available, minimum);
}

export function useWidgetPaging(count, geometry, settings) {
  const pageCount = Math.max(1, Math.ceil(count / geometry.pageSize));
  const [pageIndex, setPageIndex] = useState(0);
  const [wheelVersion, setWheelVersion] = useState(0);
  const surface = useRef(null);
  const lastWheel = useRef(0);
  useEffect(() => { setPageIndex((old) => Math.min(old, pageCount - 1)); }, [pageCount]);
  useEffect(() => {
    if (!settings.widgetCarousel || pageCount <= 1) return undefined;
    const timer = setInterval(() => setPageIndex((old) => (old + 1) % pageCount), clampWidgetInterval(settings.widgetCarouselSeconds) * 1000);
    return () => clearInterval(timer);
  }, [pageCount, settings.widgetCarousel, settings.widgetCarouselSeconds, wheelVersion]);
  useEffect(() => {
    const element = surface.current;
    if (!element) return undefined;
    const wheel = (event) => {
      event.preventDefault(); event.stopPropagation();
      const delta = event.deltaY || event.deltaX;
      if (!delta || Date.now() - lastWheel.current < 250) return;
      lastWheel.current = Date.now();
      setPageIndex((old) => (old + (delta > 0 ? 1 : -1) + pageCount) % pageCount);
      setWheelVersion((old) => old + 1);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [pageCount]);
  return { surface, pageIndex: Math.min(pageIndex, pageCount - 1), pageCount };
}

export function WidgetGrid({ accounts, geometry, settings, theme, pageIndex, renderRow, placeholder }) {
  const active = accounts.filter((item) => !item.disabled);
  return <div className="widget-grid" style={{ ...widgetTextStyles(settings, theme), width: geometry.width, height: geometry.height,
    gridTemplateColumns: `repeat(${geometry.columns}, ${geometry.cellWidth}px)`,
    gridTemplateRows: `repeat(${geometry.rows}, ${geometry.cellHeight}px)`,
    '--widget-content-scale': Math.max(0.8, geometry.scale) }}>
    {active.length ? active.slice(pageIndex * geometry.pageSize, (pageIndex + 1) * geometry.pageSize).map(renderRow) : placeholder}
  </div>;
}
