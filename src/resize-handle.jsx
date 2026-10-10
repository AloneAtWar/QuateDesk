// 垂直拖拽调高:useResizableHeight 维护一个持久化(localStorage)的像素高度,
// 从未调整过时返回 null,调用方不写内联高度,沿用样式表的响应式默认;
// 首次拖拽/按键时实测目标元素的当前高度作为起点。
// grow='up' 手柄在面板上方(向上拖变大),grow='down' 反之;方向键微调,双击/Home 复位。
// limit(targetEl) 可选:返回当前允许的最大高度(按布局余量动态计算),
// 保证拖到上限也只是吃掉弹性区域的余量,不会把其他内容挤出页面。
// 窗口尺寸变化时会用 limit 重新收敛显示高度(存储的期望高度不变,窗口复原自动恢复);
// 因此 limit 需要把页面已产生的溢出量计为负余量,才能压回已超高的组件。
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const useResizableHeight = (storageKey, { min = 48, max = 480, grow = 'up', step = 16, measure = null, limit = null } = {}) => {
  const nodeRef = useRef(null);
  // 回调 ref:目标元素可能晚于首帧挂载(数据加载后才渲染),挂载时触发收敛重算
  const [targetEl, setTargetEl] = useState(null);
  const targetRef = useCallback((node) => {
    nodeRef.current = node;
    setTargetEl(node);
  }, []);
  const [height, setHeight] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored > 0 ? clamp(Math.round(stored), min, max) : null;
    } catch { return null; }
  });
  const dragRef = useRef(null);
  // 窗口变化时的动态上限:持久化的是拖拽时刻的"期望高度",窗口缩小后弹性余量
  // 缩水,显示高度要临时压到当前上限内(不改写存储值,窗口复原后自动恢复)
  const limitRef = useRef(limit);
  limitRef.current = limit;
  const [cap, setCap] = useState(null);
  useLayoutEffect(() => {
    if (!limitRef.current || !targetEl) return undefined;
    const update = () => {
      const el = nodeRef.current;
      // 元素不可见(hidden 面板)时布局尺寸为 0,保留最后可见时的上限,切回时不塌缩
      if (!el || !el.offsetParent) return;
      const dynamicMax = Math.max(min, Math.min(max, limitRef.current(el) ?? max));
      setCap((previous) => (previous === dynamicMax ? previous : dynamicMax));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [min, max, height, targetEl]);
  const effective = height === null || cap === null ? height : Math.min(height, cap);

  // 起点高度:已调整过用显示值(可能被窗口变化收敛过),否则实测目标元素(响应式默认随断点变化)
  const currentHeight = useCallback(() => {
    if (effective !== null) return effective;
    const el = nodeRef.current;
    if (!el) return min;
    const measured = measure ? measure(el) : el.getBoundingClientRect().height;
    return measured > 0 ? measured : min;
  }, [effective, measure, min]);

  const apply = useCallback((next) => {
    // 动态上限:布局余量不足时封顶,确保拖到头也不会挤出其他元素
    const dynamicMax = limit ? Math.max(min, Math.min(max, limit(nodeRef.current) ?? max)) : max;
    const value = clamp(Math.round(next), min, dynamicMax);
    setHeight(value);
    try { window.localStorage.setItem(storageKey, String(value)); } catch { /* 无持久化环境时忽略 */ }
  }, [min, max, storageKey, limit]);

  const reset = useCallback(() => {
    setHeight(null);
    try { window.localStorage.removeItem(storageKey); } catch { /* 忽略 */ }
  }, [storageKey]);

  const endDrag = useCallback((event) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.classList.remove('dragging');
    document.body.classList.remove('row-resizing');
  }, []);

  const onPointerDown = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startHeight: currentHeight() };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.classList.add('dragging');
    document.body.classList.add('row-resizing');
  }, [currentHeight]);

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = grow === 'up' ? drag.startY - event.clientY : event.clientY - drag.startY;
    apply(drag.startHeight + delta);
  }, [apply, grow]);

  const onKeyDown = useCallback((event) => {
    const growKey = grow === 'up' ? 'ArrowUp' : 'ArrowDown';
    const shrinkKey = grow === 'up' ? 'ArrowDown' : 'ArrowUp';
    if (event.key === growKey) { event.preventDefault(); apply(currentHeight() + step); }
    else if (event.key === shrinkKey) { event.preventDefault(); apply(currentHeight() - step); }
    else if (event.key === 'Home') { event.preventDefault(); reset(); }
  }, [apply, currentHeight, grow, reset, step]);

  const handleProps = {
    role: 'separator',
    'aria-orientation': 'horizontal',
    'aria-valuemin': min,
    'aria-valuemax': max,
    ...(effective !== null ? { 'aria-valuenow': effective } : {}),
    tabIndex: 0,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onKeyDown,
    onDoubleClick: reset,
  };
  return { height: effective, targetRef, reset, handleProps };
};

export function ResizeHandle({ handleProps, label }) {
  return <div className="resize-handle" title={`${label}:拖拽调整高度,方向键微调,双击恢复默认`} {...handleProps}><i aria-hidden="true" /></div>;
}
