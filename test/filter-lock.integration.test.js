'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('changing view clears the search and filters unless they are locked', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/filter-lock-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_FILTER_LOCK '));
  assert.ok(line, `missing filter lock result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_FILTER_LOCK '.length));
  assert.equal(result.lockHiddenWhenIdle, true, 'the lock is offered only while something is filtered');
  assert.equal(result.lockShownWhenFiltered, true);
  assert.deepEqual(result.sidebar, { view: 'B', search: '', rating: [], box: '' }, 'the sidebar opens B unfiltered');
  assert.deepEqual(result.back, { view: 'A', search: 'cat', rating: [4], box: 'cat' }, 'back restores A with its search and filter');
  assert.deepEqual(result.locked, { pressed: 'true', badge: true });
  assert.deepEqual(result.lockedSidebar, { view: 'B', search: 'cat', rating: [4], box: 'cat' }, 'locked filters follow the navigation');
  assert.equal(result.clearUnlocks, false, '清除筛选 also releases the lock, as in Eagle');
});
