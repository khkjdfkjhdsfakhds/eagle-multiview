'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('other-pane navigation retains the open TXT document and editor state', { timeout: 20000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/text-pane-retention-probe.cjs')], { env, timeout: 18000 });
  const line = stdout.split('\n').find(row => row.startsWith('TEXT_RETENTION_RESULT '));
  assert.ok(line, stdout);
  assert.equal(JSON.parse(line.slice('TEXT_RETENTION_RESULT '.length)).retained, true);
});
