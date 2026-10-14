'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('⇧-click and ⇧-arrows extend from the last click, as in Eagle', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/shift-select-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_SHIFT_SELECT '));
  assert.ok(line, `missing shift select result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_SHIFT_SELECT '.length));
  assert.deepEqual(result.anchorStays, [2, 3, 4, 5, 6, 7, 8], 'click 5, ⇧2, ⇧8: the anchor stays at 5 and the runs add up');
  assert.deepEqual(result.cmdAnchor, [1, 2, 3, 5], 'a ⌘-click moves the anchor and keeps the rest');
  assert.deepEqual(result.shiftOnSelected, [1, 2, 5], '⇧-click on a selected item drops it');
  assert.deepEqual(result.shiftRight, [4, 5, 6]);
  assert.deepEqual(result.shiftLeft, [3, 4], '⇧← shrinks back to the anchor, then grows left');
  assert.deepEqual(result.gridShiftDown, [4], '⇧↓ does nothing in the grid layouts');
  assert.deepEqual(result.listShiftDown, [4, 5], '⇧↓ extends in the list layout');
});
