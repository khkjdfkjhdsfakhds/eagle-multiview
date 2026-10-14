'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('the filter panel stays open when a swatch or tag chip re-renders under the click', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/filter-popover-click-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_FILTER_POPOVER_CLICK '));
  assert.ok(line, `missing filter popover result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_FILTER_POPOVER_CLICK '.length));
  assert.equal(result.opened, true);
  assert.equal(result.afterSwatch.open, true, 'picking a colour keeps the panel open');
  assert.ok(result.afterSwatch.color, 'the colour filter applied');
  assert.deepEqual(result.afterChip, { open: true, tags: ['y'] }, 'removing a tag keeps the panel open');
  assert.equal(result.afterOutside, false, 'a click outside still closes it');
});
