'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('TXT status stays still through repeated typing/autosaves and empty-draft protection', { timeout: 25000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/text-status-probe.cjs')], { env, timeout: 22000 });
  const line = stdout.split('\n').find(row => row.startsWith('TEXT_STATUS_RESULT '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice('TEXT_STATUS_RESULT '.length));
  assert.equal(result.typingUpdates, 1);
  assert.equal(result.blankUpdates, 1);
  assert.ok(result.saves >= 2);
});
