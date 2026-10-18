'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('every pane shows the shared "include subfolders" sort preference', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/sort-cascade-sync-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_SORT_CASCADE '));
  assert.ok(line, `missing sort cascade result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_SORT_CASCADE '.length));
  assert.deepEqual(result.afterCheck, { a: true, b: true }, 'checking in one pane shows in the other');
  assert.deepEqual(result.afterUncheck, { a: false, b: false });
  assert.deepEqual(result.afterRemote, { a: true, b: true }, 'a change from another window reaches every pane');
  assert.equal(result.reopened, true, 'opening the sort menu re-syncs a stale checkbox');
  assert.equal(result.cascadedWhenOff, 0, 'with the preference off a sort change stays on the current folder');
});
