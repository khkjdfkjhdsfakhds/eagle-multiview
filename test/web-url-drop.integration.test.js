'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('web pictures and links dropped from a browser import their address, like Eagle', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/web-url-drop-probe.cjs')], { env, timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /WEB_URL_DROP_OK/);
});
