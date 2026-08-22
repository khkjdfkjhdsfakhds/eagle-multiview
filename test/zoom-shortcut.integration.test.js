'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

test('actual Electron renderer: Cmd/Ctrl +/- resize only the middle grid and keep the slider in sync', { timeout: 20000 }, async () => {
  const electron = require('electron');
  const runner = require.resolve('../test-support/zoom-shortcut-probe.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 18000 });
  assertCleanElectronStderr(assert, stderr, 'zoom shortcut runner');
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_ZOOM_RESULT '));
  assert.ok(line, `missing zoom result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_ZOOM_RESULT '.length));
  assert.equal(result.defaultThumb, 168);
  assert.equal(result.grown, 180);
  assert.equal(result.slider, '168');
});
