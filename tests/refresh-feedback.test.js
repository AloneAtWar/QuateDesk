import test from 'node:test';
import assert from 'node:assert/strict';
import { accountRefreshFeedback } from '../src/refresh-feedback.js';

test('refresh feedback counts only accounts included in the refresh', () => {
  const result = accountRefreshFeedback([{ status: 'active' }, { status: 'active' }, { status: 'warning', disabled: true }]);
  assert.equal(result.ok, true);
  assert.equal(result.message, '刷新成功，共刷新2个账号。');
});

test('partial failures report the successful and failed account counts', () => {
  const result = accountRefreshFeedback([{ status: 'active' }, { status: 'warning' }, { status: 'active' }]);
  assert.equal(result.ok, false);
  assert.equal(result.message, '刷新部分失败，成功刷新2个账号，失败刷新1个账号，请具体查看错误信息。');
});

test('all failures use the requested failure message', () => {
  const result = accountRefreshFeedback([{ status: 'warning' }, { status: 'warning' }]);
  assert.equal(result.ok, false);
  assert.equal(result.message, '刷新失败，失败刷新2个账号，请具体查看错误信息。');
});

test('request failures count all active accounts regardless of their previous status', () => {
  const result = accountRefreshFeedback([{ status: 'active' }, { status: 'warning' }, { disabled: true }], { allFailed: true });
  assert.equal(result.ok, false);
  assert.equal(result.message, '刷新失败，失败刷新2个账号，请具体查看错误信息。');
});
