'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('clicking another pane releases focus from an open TXT editor', { timeout: 20000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/text-focus-scope-probe.cjs')], { env, timeout: 18000 });
  const line = stdout.split('\n').find(row => row.startsWith('TEXT_FOCUS_RESULT '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice('TEXT_FOCUS_RESULT '.length));
  assert.ok(result.retypedLength > 'fixture body'.length);
});
