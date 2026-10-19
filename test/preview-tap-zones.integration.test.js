'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

test('preview pages by tapping its left or right third, e-reader style', { timeout: 30000 }, async () => {
  const electron = require('../test-support/electron-binary.cjs');
  const runner = require.resolve('../test-support/preview-tap-zones-probe.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 25000 });
  assertCleanElectronStderr(assert, stderr, 'preview tap zones probe');
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_TAPZONES '));
  assert.ok(line, `missing preview tap zones result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_TAPZONES '.length));

  assert.deepEqual(result.arrows, { prev: false, next: false }, 'the ‹ › buttons are gone');
  assert.equal(result.start, 'item-3');
  assert.equal(result.rightThird, 'item-4', 'a tap on the right third steps forward');
  assert.equal(result.leftThird, 'item-3', 'a tap on the left third steps back');
  assert.equal(result.middle, 'item-3', 'a tap on the middle third does nothing');
  assert.equal(result.drag, 'item-3', 'a drag is not a tap');
  assert.equal(result.longPress, 'item-3', 'a long press is not a tap');
  assert.equal(result.zoomedTap, 'item-3', 'taps do not page while the image is zoomed');
});
