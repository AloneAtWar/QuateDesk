export function boardPullMetrics(width, height) {
  const iconSize = Math.round(Math.max(64, Math.min(96, width * .11, height * .16)));
  const revealDistance = Math.round(iconSize * 1.3 + 16);
  return {
    iconSize,
    revealDistance,
    threshold: revealDistance + Math.round(Math.max(120, Math.min(220, height * .24))),
  };
}

export function boardPullVisual(distance, metrics) {
  const reveal = Math.min(distance / metrics.revealDistance, 1);
  const progress = Math.max(0, Math.min((distance - metrics.revealDistance) / (metrics.threshold - metrics.revealDistance), 1));
  return {
    progress,
    height: (metrics.iconSize + 16) * reveal + metrics.iconSize * .4 * progress,
    ready: progress >= 1,
  };
}

// Wheel gestures have no release event; a short pause acts as letting go.
export function bindBoardPullRefresh(element, { onPull, onRefresh, isBusy, scrollElement = element, schedule = setTimeout, cancel = clearTimeout }) {
  const threshold = () => boardPullMetrics(scrollElement.clientWidth, scrollElement.clientHeight).threshold;
  let distance = 0;
  let timer;
  let touch = null;
  let disposed = false;
  let locked = false;
  const reset = () => {
    cancel(timer);
    distance = 0;
    onPull(0);
  };
  const release = () => {
    // Read the final distance, never a previously crossed trigger point.
    const ready = distance >= threshold() && scrollElement.scrollTop <= 1;
    reset();
    if (!ready || isBusy() || locked) return;
    locked = true;
    Promise.resolve().then(() => !disposed && onRefresh()).finally(() => { locked = false; }).catch(() => {});
  };
  const eligible = (target) => {
    if (isBusy() || locked || scrollElement.scrollTop > 1) return false;
    for (let node = target; node && node !== element; node = node.parentElement) {
      if (node.matches?.('input, textarea, select, [contenteditable="true"], [role="slider"]')) return false;
      // Let independently scrolling panels handle their own gestures.
      if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return false;
    }
    return true;
  };
  const update = (value) => {
    distance = Math.max(0, Math.min(value, threshold() * 2.5));
    onPull(distance);
  };
  const wheel = (event) => {
    if (touch || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !eligible(event.target)) return;
    if (!distance && event.deltaY >= 0) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scrollElement.clientHeight : 1;
    update(distance - event.deltaY * unit);
    cancel(timer);
    timer = schedule(release, 180);
  };
  const touchStart = (event) => {
    reset();
    touch = event.touches.length === 1 && eligible(event.target)
      ? { id: event.touches[0].identifier, y: event.touches[0].clientY, x: event.touches[0].clientX }
      : null;
  };
  const touchMove = (event) => {
    if (!touch) return;
    const point = event.touches[0];
    if (event.touches.length !== 1 || point.identifier !== touch.id || !eligible(event.target)) {
      touch = null;
      reset();
      return;
    }
    const dy = point.clientY - touch.y;
    if (Math.abs(point.clientX - touch.x) > Math.max(10, Math.abs(dy))) {
      touch = null;
      reset();
      return;
    }
    if (dy > 0 || distance) {
      event.preventDefault();
      update(dy);
    }
  };
  const touchEnd = () => {
    if (!touch) return;
    touch = null;
    release();
  };
  const abort = () => { touch = null; reset(); };
  const scroll = () => { if (scrollElement.scrollTop > 1) abort(); };
  const listeners = [['wheel', wheel], ['touchstart', touchStart], ['touchmove', touchMove], ['touchend', touchEnd], ['touchcancel', abort], ['scroll', scroll]];
  for (const [name, handler] of listeners) element.addEventListener(name, handler, { passive: false });
  window.addEventListener('blur', abort);
  window.addEventListener('resize', abort);
  window.addEventListener('scroll', scroll);
  return () => {
    disposed = true;
    for (const [name, handler] of listeners) element.removeEventListener(name, handler);
    window.removeEventListener('blur', abort);
    window.removeEventListener('resize', abort);
    window.removeEventListener('scroll', scroll);
    reset();
  };
}
