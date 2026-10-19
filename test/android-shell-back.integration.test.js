'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('Android shell Back never waits on confirm() inside its request; the question follows it (A-02)', { timeout: 45000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/android-shell-back-probe.cjs')], { env, timeout: 40000 });
  const line = stdout.split('\n').find(row => row.startsWith('EAGLEMV_ANDROID_SHELL_BACK '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice('EAGLEMV_ANDROID_SHELL_BACK '.length));
  // The shell gets "blocked" at once; nothing is asked while it waits.
  assert.deepEqual(result.declined, ['blocked', 'history', 'unsaved-edit', 0]);
  assert.deepEqual(result.afterDecline, { view: 'folder', dirty: true }, 'declining keeps the folder and the edit');
  // Accepting runs the same Back step: the edit is dropped and history goes back.
  assert.deepEqual(result.accepted, ['blocked', 0]);
  assert.deepEqual(result.afterAccept, { asked: 2, dirty: false });
  assert.deepEqual(result.plain, ['handled', 'history', 2]);
});
