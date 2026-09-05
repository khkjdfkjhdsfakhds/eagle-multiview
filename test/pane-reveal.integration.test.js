'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

test('real renderer reveals paths, folders and paginated selections without writes or stale navigation', { timeout: 40000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await promisify(execFile)(require('electron'), [
    '--disable-logging', require.resolve('../test-support/pane-reveal-runner.cjs')
  ], { env, timeout: 35000 });
  assertCleanElectronStderr(assert, stderr, 'pane reveal');
  const line = stdout.split('\n').find(row => row.startsWith('PANE_REVEAL_RESULT '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice('PANE_REVEAL_RESULT '.length));
  assert.ok(result.checks >= 40);
  assert.equal(result.writes, 0);
});
