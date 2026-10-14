'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('list rows span the pane and keep every column aligned', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/list-columns-probe.cjs')], { env, timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /LIST_COLUMNS_OK/);
});
