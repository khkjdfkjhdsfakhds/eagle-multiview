'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('NAI character prompts render between global prompts, copy independently, wrap and clear', { timeout: 25000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/metadata-characters-probe.cjs')], { env, timeout: 22000 });
  const line = stdout.split('\n').find(row => row.startsWith('METADATA_CHARACTERS_RESULT '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice('METADATA_CHARACTERS_RESULT '.length));
  assert.equal(result.copies, 4);
  assert.equal(result.narrowLayout, true);
  assert.equal(result.switching, true);
});
