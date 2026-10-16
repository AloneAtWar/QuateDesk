import test from 'node:test';
import assert from 'node:assert/strict';
import { fitModelChips } from '../src/local-cli-usage/fit-model-chips.js';

test('全部标签刚好放下时不预留省略号', () => {
  assert.equal(fitModelChips([20, 35, 25], 90, 5, 10), 3);
});

test('溢出时给省略号和间距留出空间', () => {
  assert.equal(fitModelChips([20, 35, 25], 70, 5, 10), 1);
  assert.equal(fitModelChips([20, 35, 25], 75, 5, 10), 2);
});

test('窗口变宽后按实际标签宽度显示更多模型', () => {
  const widths = [20, 35, 25, 80, 30];
  assert.equal(fitModelChips(widths, 75, 5, 10), 2);
  assert.equal(fitModelChips(widths, 110, 5, 10), 3);
  assert.equal(fitModelChips(widths, 210, 5, 10), 5);
});

test('过窄时只保留省略号，空列表不产生标签', () => {
  assert.equal(fitModelChips([90, 30], 50, 5, 10), 0);
  assert.equal(fitModelChips([], 50, 5, 10), 0);
});
