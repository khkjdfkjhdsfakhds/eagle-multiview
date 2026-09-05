'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('thumbnail dialog honors cancellation, frozen context, honest outcomes and failure recovery', { timeout: 45000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/thumbnail-ui-probe.cjs')], { env, timeout: 40000 });
  assert.match(stdout, /THUMBNAIL_UI_CANCEL_OK/);
  assert.match(stdout, /THUMBNAIL_UI_OUTCOMES_OK/);
  assert.match(stdout, /THUMBNAIL_UI_LIBRARY_OK/);
  assert.match(stdout, /THUMBNAIL_UI_CAPABILITY_OK/);
  assert.match(stdout, /THUMBNAIL_UI_FAILURE_OK/);
});
