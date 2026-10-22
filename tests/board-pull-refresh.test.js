import test from 'node:test';
import assert from 'node:assert/strict';
import { bindBoardPullRefresh, boardPullMetrics, boardPullVisual } from '../src/board-pull-refresh.js';

function setup(t, options = {}) {
  const oldWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const element = Object.assign(new EventTarget(), { scrollTop: 0, clientHeight: 500, clientWidth: 800 });
  let release;
  let distance = 0;
  let refreshes = 0;
  let busy = false;
  const cleanup = bindBoardPullRefresh(element, {
    onPull: (value) => { distance = value; },
    onRefresh: () => { refreshes++; },
    isBusy: () => busy,
    schedule: (callback) => { release = callback; return 1; },
    cancel: () => { release = null; },
    ...options,
  });
  t.after(() => { cleanup(); globalThis.window = oldWindow; });
  return {
    element, cleanup,
    get metrics() { return boardPullMetrics(element.clientWidth, element.clientHeight); },
    get distance() { return distance; },
    get refreshes() { return refreshes; },
    set busy(value) { busy = value; },
    dispatch(type, values = {}) {
      const event = Object.assign(new Event(type, { cancelable: true }), { deltaX: 0, deltaY: 0, deltaMode: 0, ...values });
      element.dispatchEvent(event);
      return event;
    },
    async stop() { release?.(); await Promise.resolve(); },
  };
}

test('top overscroll shows resistance distance, then releases and refreshes once', async (t) => {
  const gesture = setup(t);
  assert.equal(gesture.dispatch('wheel', { deltaY: -80 }).defaultPrevented, true);
  gesture.dispatch('wheel', { deltaY: -(gesture.metrics.threshold - 80) });
  assert.equal(gesture.distance, gesture.metrics.threshold);
  assert.equal(gesture.refreshes, 0);
  await gesture.stop();
  assert.equal(gesture.distance, 0);
  assert.equal(gesture.refreshes, 1);
  await gesture.stop();
  assert.equal(gesture.refreshes, 1);
});

test('small or reversed gestures rebound without refreshing', async (t) => {
  const gesture = setup(t);
  gesture.dispatch('wheel', { deltaY: -40 });
  await gesture.stop();
  assert.equal(gesture.distance, 0);
  assert.equal(gesture.refreshes, 0);
  gesture.dispatch('wheel', { deltaY: -160 });
  gesture.dispatch('wheel', { deltaY: 100 });
  await gesture.stop();
  assert.equal(gesture.refreshes, 0);
});

test('normal scrolling, zoom, horizontal motion and busy refresh stay untouched', async (t) => {
  const gesture = setup(t);
  for (const values of [{ deltaY: 160 }, { deltaY: -160, ctrlKey: true }, { deltaY: -160, deltaX: 200 }]) {
    assert.equal(gesture.dispatch('wheel', values).defaultPrevented, false);
  }
  gesture.element.scrollTop = 100;
  assert.equal(gesture.dispatch('wheel', { deltaY: -160 }).defaultPrevented, false);
  gesture.element.scrollTop = 0;
  gesture.busy = true;
  gesture.dispatch('wheel', { deltaY: -160 });
  await gesture.stop();
  assert.equal(gesture.distance, 0);
  assert.equal(gesture.refreshes, 0);
});

test('touch release refreshes while cancellation only rebounds', async (t) => {
  const gesture = setup(t);
  const point = (clientY) => [{ identifier: 1, clientX: 20, clientY }];
  gesture.dispatch('touchstart', { touches: point(20) });
  gesture.dispatch('touchmove', { touches: point(180) });
  assert.equal(gesture.distance, 160);
  gesture.dispatch('touchcancel');
  assert.equal(gesture.distance, 0);
  assert.equal(gesture.refreshes, 0);
  gesture.dispatch('touchstart', { touches: point(20) });
  gesture.dispatch('touchmove', { touches: point(20 + gesture.metrics.threshold) });
  gesture.dispatch('touchend');
  await Promise.resolve();
  assert.equal(gesture.refreshes, 1);
});

test('cleanup cancels pending refresh and removes gesture listeners', async (t) => {
  const gesture = setup(t);
  gesture.dispatch('wheel', { deltaY: -160 });
  gesture.cleanup();
  await gesture.stop();
  gesture.dispatch('wheel', { deltaY: -160 });
  assert.equal(gesture.distance, 0);
  assert.equal(gesture.refreshes, 0);
});

test('icon size and trigger distance adapt to the board with bounded sizes', () => {
  assert.deepEqual(boardPullMetrics(320, 400), { iconSize: 64, revealDistance: 99, threshold: 219 });
  assert.deepEqual(boardPullMetrics(800, 600), { iconSize: 88, revealDistance: 130, threshold: 274 });
  assert.deepEqual(boardPullMetrics(1920, 1080), { iconSize: 96, revealDistance: 141, threshold: 361 });
});

test('only the final wheel distance counts, including retreat and a second pull', async (t) => {
  const gesture = setup(t);
  const threshold = gesture.metrics.threshold;
  gesture.dispatch('wheel', { deltaY: -(threshold - 1) });
  await gesture.stop();
  assert.equal(gesture.refreshes, 0);
  gesture.dispatch('wheel', { deltaY: -(threshold + 60) });
  gesture.dispatch('wheel', { deltaY: 61 });
  assert.equal(gesture.distance, threshold - 1);
  await gesture.stop();
  assert.equal(gesture.refreshes, 0);
  gesture.dispatch('wheel', { deltaY: -(threshold + 60) });
  gesture.dispatch('wheel', { deltaY: 100 });
  gesture.dispatch('wheel', { deltaY: -40 });
  await gesture.stop();
  assert.equal(gesture.refreshes, 1);
});

test('touch retreat below the threshold cancels a previously armed refresh', async (t) => {
  const gesture = setup(t);
  const point = (clientY) => [{ identifier: 1, clientX: 20, clientY }];
  gesture.dispatch('touchstart', { touches: point(20) });
  gesture.dispatch('touchmove', { touches: point(20 + gesture.metrics.threshold + 50) });
  gesture.dispatch('touchmove', { touches: point(20 + gesture.metrics.threshold - 1) });
  gesture.dispatch('touchend');
  await Promise.resolve();
  assert.equal(gesture.distance, 0);
  assert.equal(gesture.refreshes, 0);
});

test('larger boards require a longer pull, synchronized with the progress ring', async (t) => {
  const gesture = setup(t);
  gesture.element.clientHeight = 900;
  gesture.dispatch('wheel', { deltaY: -160 });
  await gesture.stop();
  assert.equal(gesture.refreshes, 0);
  gesture.dispatch('wheel', { deltaY: -gesture.metrics.threshold });
  await gesture.stop();
  assert.equal(gesture.refreshes, 1);
});

test('leaving the top cancels the pending wheel release', async (t) => {
  const gesture = setup(t);
  gesture.dispatch('wheel', { deltaY: -gesture.metrics.threshold });
  gesture.element.scrollTop = 20;
  gesture.dispatch('scroll');
  await gesture.stop();
  assert.equal(gesture.distance, 0);
  assert.equal(gesture.refreshes, 0);
});

test('fully revealing the icon does not refresh; a second animated stage is required', async (t) => {
  const gesture = setup(t);
  const metrics = gesture.metrics;
  const revealed = boardPullVisual(metrics.revealDistance, metrics);
  assert.equal(revealed.height, metrics.iconSize + 16);
  assert.equal(revealed.progress, 0);
  assert.equal(revealed.ready, false);
  gesture.dispatch('wheel', { deltaY: -metrics.revealDistance });
  await gesture.stop();
  assert.equal(gesture.refreshes, 0);
  const halfway = (metrics.revealDistance + metrics.threshold) / 2;
  const visual = boardPullVisual(halfway, metrics);
  assert.equal(visual.progress, .5);
  assert.ok(visual.height > revealed.height);
  assert.equal(visual.ready, false);
  gesture.dispatch('wheel', { deltaY: -halfway });
  await gesture.stop();
  assert.equal(gesture.refreshes, 0);
  assert.equal(boardPullVisual(metrics.threshold, metrics).ready, true);
  gesture.dispatch('wheel', { deltaY: -metrics.threshold });
  await gesture.stop();
  assert.equal(gesture.refreshes, 1);
});

test('mobile document scrolling uses the viewport and requires starting at the page top', async (t) => {
  const scrollElement = { scrollTop: 90, clientWidth: 390, clientHeight: 800 };
  const gesture = setup(t, { scrollElement });
  gesture.element.clientHeight = 5000;
  const point = (clientY) => [{ identifier: 1, clientX: 100, clientY }];
  gesture.dispatch('touchstart', { touches: point(40) });
  assert.equal(gesture.dispatch('touchmove', { touches: point(400) }).defaultPrevented, false);
  gesture.dispatch('touchend');
  await Promise.resolve();
  assert.equal(gesture.refreshes, 0);
  scrollElement.scrollTop = 0;
  const metrics = boardPullMetrics(scrollElement.clientWidth, scrollElement.clientHeight);
  gesture.dispatch('touchstart', { touches: point(40) });
  assert.equal(gesture.dispatch('touchmove', { touches: point(40 + metrics.revealDistance) }).defaultPrevented, true);
  gesture.dispatch('touchend');
  await Promise.resolve();
  assert.equal(gesture.refreshes, 0);
  gesture.dispatch('touchstart', { touches: point(40) });
  gesture.dispatch('touchmove', { touches: point(40 + metrics.threshold) });
  gesture.dispatch('touchend');
  await Promise.resolve();
  assert.equal(gesture.refreshes, 1);
});

test('horizontal and multi-touch mobile gestures cancel without refreshing', async (t) => {
  const gesture = setup(t);
  const point = (clientX, clientY) => ({ identifier: 1, clientX, clientY });
  gesture.dispatch('touchstart', { touches: [point(20, 20)] });
  gesture.dispatch('touchmove', { touches: [point(400, 30)] });
  gesture.dispatch('touchend');
  await Promise.resolve();
  assert.equal(gesture.refreshes, 0);
  gesture.dispatch('touchstart', { touches: [point(20, 20)] });
  gesture.dispatch('touchmove', { touches: [point(20, 20 + gesture.metrics.threshold)] });
  gesture.dispatch('touchmove', { touches: [point(20, 300), { identifier: 2, clientX: 30, clientY: 300 }] });
  gesture.dispatch('touchend');
  await Promise.resolve();
  assert.equal(gesture.distance, 0);
  assert.equal(gesture.refreshes, 0);
});
