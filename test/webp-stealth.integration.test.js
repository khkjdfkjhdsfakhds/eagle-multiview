'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
for (const extension of ['webp', 'png']) test(`Metadata Viewer reads and copies alpha-embedded generation metadata from ${extension}`, { timeout: 25000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  env.EAGLEMV_STEALTH_EXT = extension;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/webp-stealth-probe.cjs')], { env, timeout: 22000 });
  const line = stdout.split('\n').find(row => row.startsWith('WEBP_STEALTH_RESULT '));
  assert.ok(line, stdout);
  assert.equal(JSON.parse(line.slice('WEBP_STEALTH_RESULT '.length)).displayed, true);
});
