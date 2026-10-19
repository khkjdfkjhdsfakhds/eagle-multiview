'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('Enter and Space belong to a keyboard-focused button, not the preview', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/button-keys-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_BUTTON_KEYS '));
  assert.ok(line, `missing button keys result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_BUTTON_KEYS '.length));
  assert.equal(result.keyboard.focusVisible, true);
  assert.deepEqual({ ...result.keyboard, focusVisible: undefined }, { focusVisible: undefined, enterPrevented: false, enterPreview: false, spacePrevented: false, spacePreview: false });
  assert.equal(result.mouse.focusVisible, false, 'a mouse click leaves no visible focus ring');
  assert.equal(result.mouse.spacePreview, true, 'Space after clicking a button still opens the preview');
  assert.deepEqual(result.card, { prevented: true, preview: true }, 'Enter on a focused card still opens the preview');
});
