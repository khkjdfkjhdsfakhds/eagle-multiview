'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('metadata autosave stays quiet and retains typing across shared-folder refreshes', { timeout: 40000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/interaction-regression-probe.cjs'), '--scenario=inspectorQuietTyping'], { env, timeout: 38000 });
  const line = stdout.split('\n').find(row => row.startsWith('INTERACTION_AUDIT '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice(18));
  assert.ok(!result.error, result.error);
  assert.equal(result.result.mutations, 6);
  assert.deepEqual(result.result.notices, [], 'routine autosave must not repeatedly display success notices');
  for (const check of result.result.checks) {
    assert.equal(check.focused, true, check.selector);
    assert.equal(check.caret, 2, check.selector);
  }
});
test('metadata save ACK leaves an active IME composition untouched', { timeout: 15000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/interaction-regression-probe.cjs'), '--scenario=inspectorComposition'], { env, timeout: 13000 });
  const result = JSON.parse(stdout.split('\n').find(row => row.startsWith('INTERACTION_AUDIT ')).slice(18));
  assert.ok(!result.error, result.error);
  assert.deepEqual(result.result.pending, { value: 'before zhong ', caret: 8, count: 1 });
  assert.equal(result.result.stored, 'before 中文');
  assert.equal(result.result.focused, true);
});
test('metadata autosave waits through a thinking pause before refreshing', { timeout: 15000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/interaction-regression-probe.cjs'), '--scenario=inspectorPauseBeforeAutosave'], { env, timeout: 13000 });
  const result = JSON.parse(stdout.split('\n').find(row => row.startsWith('INTERACTION_AUDIT ')).slice(18));
  assert.ok(!result.error, result.error);
  assert.deepEqual(result.result.during, { mutations: 0, dirty: true, focused: true });
  assert.equal(result.result.stored, 'thinking pause');
});
