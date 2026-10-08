'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('pane swap preserves live editors and swaps the two most recently activated panes', { timeout: 20000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/pane-swap-probe.cjs')], { env, timeout: 18000 });
  assert.match(stdout, /PANE_SWAP_OK/);
});
