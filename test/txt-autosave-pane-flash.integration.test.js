'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('TXT autosave does not rebuild an unrelated pane grid', { timeout: 20000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), [
    '--disable-logging', require.resolve('../test-support/interaction-regression-probe.cjs'),
    '--scenario=textSaveDoesNotRefreshOtherPane'
  ], { env, timeout: 18000 });
  const line = stdout.split('\n').find(row => row.startsWith('INTERACTION_AUDIT '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice('INTERACTION_AUDIT '.length));
  assert.ok(!result.error, result.error);
  assert.equal(result.result.before, 0);
  assert.equal(result.result.after, 0);
  assert.ok(result.result.otherItems > 0);
});
