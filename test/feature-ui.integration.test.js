'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('folder UI confirms menu moves but drops directly while guarding cancel, cycles, stale libraries and replay', { timeout: 45000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/feature-ui-probe.cjs')], { env, timeout: 40000 });
  assert.match(stdout, /FEATURE_UI_OK/);
});
