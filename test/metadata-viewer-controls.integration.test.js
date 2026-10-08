'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

test('Metadata Viewer controls are focused-only and resizable', { timeout: 25000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await promisify(execFile)(require('electron'), [
    '--disable-logging', require.resolve('../test-support/metadata-viewer-controls-probe.cjs')
  ], { env, timeout: 22000 });
  assertCleanElectronStderr(assert, stderr, 'metadata viewer controls runner');
  const line = stdout.split('\n').find(row => row.startsWith('METADATA_VIEWER_CONTROLS_RESULT '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice('METADATA_VIEWER_CONTROLS_RESULT '.length));
  assert.equal(result.zoom, '150');
  assert.equal(result.thumb, 180);
  assert.ok(result.heightChanged >= 148);
});
