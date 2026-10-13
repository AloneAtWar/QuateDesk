// 热力图竖屏测量与平移/缩放交互：官方用量页(main.jsx)与本机用量热力图(LocalUsageHeatmap)
// 共用。抽成独立模块而不是互相 import，避免 main.jsx ↔ local-cli-usage 的循环依赖。
import { useCallback, useEffect, useRef } from 'react';

// 容器窄于该宽度视为竖屏：按「可读格子 + 横向滚动」处理，而不是把格子硬塞到 5px
export const HEATMAP_NARROW_PX = 620;
export const HEATMAP_MIN_CELL = 14;
// 竖屏格子默认大小：吃满高度但在上下各留约 HEATMAP_NARROW_MARGIN/2 的空白——
// 既透气，空白带也是天然的滑动握持区；其余月份左右滑动查看
const HEATMAP_NARROW_MARGIN = 64;
const HEATMAP_DRAG_MOVE_PX = 4;
// 缩放上限 40px。捏合/Ctrl+滚轮在这之间是无级连续调节（滚轮每格约 1.25 倍）；
// 下限是相对值——「整年恰好铺满当前容器宽度」的格子大小，大屏上最小档也占满宽度，
// 不会缩成中间一小条
const HEATMAP_ZOOM_MIN_CELL = 6;
const HEATMAP_ZOOM_MAX_CELL = 40;

// 统一的格子测量：宽屏整年铺满（1:2.5 扁长格子）；竖屏按「高度留白后的余量」取格子
// （比例约 1:1.45 接近方形），铺不下一年就横向滚动。返回 base(未缩放列宽，缩放换算基准)
// 与应用缩放后的 w/h/gap
export function computeHeatmapCells(el, weekCount, zoom = 1) {
  // 可用宽度 = 容器 clientWidth − 自身左右 padding(4×2) − 星期列(实际宽度) − 列间距(7)
  const weekdayCol = el.querySelector('.provider-heatmap-weekdays')?.offsetWidth ?? 10;
  const avail = el.clientWidth - 8 - weekdayCol - 7;
  // 最小缩放 = 整年恰好铺满当前宽度的格子大小（相对值，随屏幕宽度变化；兜底不小于 6px）。
  // 别忘了列间距：一年板宽 = 列数×格宽 + (列数-1)×间距，按该尺寸档的间距反解格宽
  const rough = Math.floor(avail / weekCount);
  const fitGap = rough >= 18 ? 3 : rough >= 10 ? 2 : 0;
  const minCell = Math.max(HEATMAP_ZOOM_MIN_CELL, Math.min(HEATMAP_ZOOM_MAX_CELL, Math.floor((avail - (weekCount - 1) * fitGap) / weekCount)));
  const gap0 = rough >= 18 ? 3 : rough >= 10 ? 2 : 0;
  let base = Math.min(HEATMAP_ZOOM_MAX_CELL, Math.max(5, Math.floor((avail - (weekCount - 1) * gap0) / weekCount)));
  const narrow = el.clientWidth < HEATMAP_NARROW_PX;
  const ratio = narrow ? 1.45 : 2.5;
  // 高度富余时按长宽比放大格子（桌面端拉高窗口与竖屏手机同等待遇）：常规高度下与
  // 宽度铺满的结果一致，不改变原有外观；高度被拉长后格子随之放大，整年放不下就横向滚动
  const hAvail = Math.floor((el.clientHeight - 10 - 2 - 10 - 3 - 6 * 2 - HEATMAP_NARROW_MARGIN) / 7);
  const fromHeight = Math.floor(hAvail / ratio);
  base = Math.max(base, Math.min(HEATMAP_ZOOM_MAX_CELL, Math.max(HEATMAP_MIN_CELL, fromHeight)));
  const w = Math.round(Math.min(HEATMAP_ZOOM_MAX_CELL, Math.max(minCell, base * zoom)));
  const gap = w >= 18 ? 3 : w >= 10 ? 2 : 0;
  // 行高吃满外框剩余高度；双重封顶：绝对 96px + 长宽比，防止格子被拉成竖条
  const h = Math.min(96, Math.round(w * ratio), Math.max(w, Math.floor((el.clientHeight - 10 - 2 - 10 - 3 - 6 * gap) / 7)));
  return { base, w, h, gap, minCell };
}

// 热力图平移/缩放交互集：悬停滚轮(横移 / Ctrl+滚轮缩放)、鼠标按住拖动、触屏两指捏合缩放、
// 默认钉在右端(最新)、两端渐隐提示。使用方把 handlers 挂到 .provider-heatmap-scroll 上
// （外层需包 .provider-heatmap-frame 提供渐隐覆盖层），并在自己的 measure 里调用
// markMeasured(base, w) 记录缩放基准，measure 函数本身通过 measureRef 暴露给缩放重算。
export function useHeatmapPan({ wrapRef, cellPx, cellGap, weekCount }) {
  const zoomRef = useRef(1);           // 缩放倍率（相对自动测量值），换数据集后重置
  const baseCellRef = useRef(8);       // 最近一次自动测量的未缩放格子宽
  const cellPxRef = useRef(8);         // 当前格子宽（原生监听闭包里 state 会过期，用镜像）
  const minCellRef = useRef(HEATMAP_ZOOM_MIN_CELL); // 最小缩放（整年铺满当前宽度的相对值）
  const measureRef = useRef(null);
  const pinnedRightRef = useRef(true); // 钉在右端（最新）；滑离后不再自动跟随，滑回右端恢复
  const anchorRef = useRef(null);      // 缩放锚点：渲染后按比例校正 scrollLeft，保持捏合/光标下的日期不动
  const pinchPointersRef = useRef(new Map());
  const pinchBaseRef = useRef(null);
  const mouseDragRef = useRef(null);
  const mouseSuppressClickRef = useRef(false);

  // 两端渐隐提示（挂在滚动容器的外层 frame 上，不随内容滚动）。scroll 事件之外，
  // 拖拽/滚轮/缩放后会主动同步，渲染被暂停的环境里也能正确显示
  const syncEdges = useCallback(() => {
    const el = wrapRef.current;
    const frame = el?.parentElement;
    if (!frame?.classList?.contains('provider-heatmap-frame')) return;
    frame.classList.toggle('more-left', el.scrollLeft > 1);
    frame.classList.toggle('more-right', el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, [wrapRef]);

  const markMeasured = useCallback((base, w, minCell) => {
    baseCellRef.current = base;
    cellPxRef.current = w;
    if (Number.isFinite(minCell)) minCellRef.current = minCell;
  }, []);

  const zoomAt = useCallback((nextCell, anchor) => {
    nextCell = Math.round(Math.min(HEATMAP_ZOOM_MAX_CELL, Math.max(minCellRef.current, nextCell)));
    if (nextCell === cellPxRef.current || !measureRef.current) return;
    zoomRef.current = nextCell / Math.max(1, baseCellRef.current);
    anchorRef.current = { ...anchor, cell: cellPxRef.current };
    measureRef.current();
  }, []);

  // 换数据集：重置缩放与右端钉随
  useEffect(() => {
    zoomRef.current = 1;
    pinnedRightRef.current = true;
  }, [weekCount]);

  // 滚动跟随：右端钉随状态 + 渐隐；悬停滚轮：Ctrl/Cmd+滚轮缩放，普通竖向滚轮在板可横滚时
  // 转为横向滚动（到头放行整页）。React 合成事件的 wheel 是 passive 的，preventDefault
  // 必须挂在原生非 passive 监听上
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      pinnedRightRef.current = el.scrollLeft >= el.scrollWidth - el.clientWidth - 4;
      syncEdges();
    };
    const onWheel = (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        // 每格滚轮约 1.25 倍（exp(120×0.0019)≈1.254）：5→44px 全程约 10 格，逐格细腻；
        // 捏合手势不走这里，仍是无级
        const rect = el.getBoundingClientRect();
        zoomAt(cellPxRef.current * Math.exp(-event.deltaY * 0.0019), { clientX: event.clientX, contentX: el.scrollLeft + (event.clientX - rect.left) });
        return;
      }
      if (el.scrollWidth <= el.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaMode === 2 ? event.deltaY * el.clientWidth : event.deltaY;
      const before = el.scrollLeft;
      el.scrollLeft = before + delta;
      if (el.scrollLeft !== before) {
        event.preventDefault();
        syncEdges();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
    };
  }, [weekCount, syncEdges, zoomAt]);

  // 格子尺寸落地后校正滚动位置：缩放按锚点换算，平时钉在右端（最新）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (anchorRef.current) {
      const { contentX, clientX, cell } = anchorRef.current;
      anchorRef.current = null;
      const rect = el.getBoundingClientRect();
      el.scrollLeft = contentX * (cellPx / cell) - (clientX - rect.left);
    } else if (pinnedRightRef.current && el.scrollWidth > el.clientWidth) {
      el.scrollLeft = el.scrollWidth;
    }
    syncEdges();
  }, [cellPx, cellGap, weekCount, syncEdges]);

  // 触屏两指捏合缩放（touch-action 已限定 pan-x/pan-y，捏合不被浏览器接管）、
  // 鼠标按住拖动平移（拖动后吞掉误触的点击），触屏单指交给原生滚动
  const onPointerDown = (event) => {
    if (event.pointerType === 'touch') {
      pinchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchPointersRef.current.size !== 2 || !wrapRef.current) return;
      const el = wrapRef.current;
      const [a, b] = [...pinchPointersRef.current.values()];
      const rect = el.getBoundingClientRect();
      const clientX = (a.x + b.x) / 2;
      pinchBaseRef.current = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        cell: cellPxRef.current,
        anchor: { clientX, contentX: el.scrollLeft + (clientX - rect.left) },
      };
      return;
    }
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const el = wrapRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    event.preventDefault();
    mouseDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScroll: el.scrollLeft, moved: false };
  };
  const onPointerMove = (event) => {
    if (pinchPointersRef.current.has(event.pointerId)) {
      const point = pinchPointersRef.current.get(event.pointerId);
      point.x = event.clientX;
      point.y = event.clientY;
      const base = pinchBaseRef.current;
      if (base) {
        const [a, b] = [...pinchPointersRef.current.values()];
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        zoomAt(base.cell * (dist / base.dist), base.anchor);
      }
      return;
    }
    const drag = mouseDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const el = wrapRef.current;
    if (!el) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(dx) < HEATMAP_DRAG_MOVE_PX) return;
      drag.moved = true;
      try { el.setPointerCapture?.(event.pointerId); } catch { /* 合成指针无法捕获，不影响后续移动 */ }
      window.getSelection?.()?.removeAllRanges?.();
    }
    el.scrollLeft = drag.startScroll - dx;
  };
  const onPointerEnd = (event) => {
    if (pinchPointersRef.current.delete(event.pointerId)) {
      if (pinchPointersRef.current.size < 2) pinchBaseRef.current = null;
      return;
    }
    if (mouseDragRef.current?.pointerId === event.pointerId) {
      if (mouseDragRef.current.moved) mouseSuppressClickRef.current = true;
      mouseDragRef.current = null;
      syncEdges();
    }
  };
  const onClickCapture = (event) => {
    if (!mouseSuppressClickRef.current) return;
    mouseSuppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onClickCapture,
    },
    zoomRef,
    measureRef,
    markMeasured,
    syncEdges,
  };
}
