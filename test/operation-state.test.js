'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationTracker } = require('../src/operation-state');

test('foreground operations keep their status visible over faster background updates', () => {
  const tracker = createOperationTracker('等待同步');
  const first = tracker.begin('正在导入…', { key: 'import' }).token;
  tracker.setStatus('所有窗口已同步');
  assert.equal(tracker.currentText(), '正在导入…');
  const second = tracker.begin('正在设置评分…', { key: 'rating:pane-1' }).token;
  assert.equal(tracker.currentText(), '正在设置评分… · 共 2 项');
  tracker.end(second);
  assert.equal(tracker.currentText(), '正在导入…');
  tracker.end(first);
  assert.equal(tracker.currentText(), '所有窗口已同步');
});

test('duplicate operation keys are rejected without losing the original operation', () => {
  const tracker = createOperationTracker();
  const first = tracker.begin('正在导入…', { key: 'import' });
  const duplicate = tracker.begin('再次导入…', { key: 'import' });
  assert.ok(first.token);
  assert.equal(duplicate.token, null);
  assert.equal(duplicate.duplicate.label, '正在导入…');
  assert.equal(tracker.size, 1);
});

test('only operations marked as close-blocking prevent window teardown', () => {
  const tracker = createOperationTracker();
  tracker.begin('正在读取…', { key: 'read', blocksClose: false });
  tracker.begin('正在归类…', { key: 'write' });
  assert.deepEqual(tracker.blocking().map(operation => operation.key), ['write']);
  assert.equal(tracker.summary(), '正在归类…，另有 1 项操作尚未完成');
});
