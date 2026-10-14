'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('a pin reply that lands after a library switch leaves the new library’s pins alone', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/pin-library-switch-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_PIN_SWITCH '));
  assert.ok(line, `missing pin switch result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_PIN_SWITCH '.length));
  assert.equal(result.kept, true, 'the old library’s pin table must not replace the new one');
  assert.equal(result.installed, true, 'a reply for the current library is installed');
});
