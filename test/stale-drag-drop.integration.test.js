'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('a lingering native item drag never turns Finder files into a move, and every session end resets drag state', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/stale-drag-drop-probe.cjs')], { env, timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /STALE_DRAG_DROP_OK/);
});
