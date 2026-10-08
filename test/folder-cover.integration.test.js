'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('folder cover menus persist through RPC and update three renderer windows including narrow layout', { timeout: 30000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/folder-cover-probe.cjs')], { env, timeout: 27000 });
  const line = stdout.split('\n').find(row => row.startsWith('FOLDER_COVER_RESULT '));
  assert.ok(line, stdout);
  assert.deepEqual(JSON.parse(line.slice('FOLDER_COVER_RESULT '.length)), { windows: 3, sync: true, restored: true, reset: true, narrow: true });
});
