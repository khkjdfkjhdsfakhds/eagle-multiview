'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('search includes descendants and clearing it restores direct-folder browsing', {timeout:30000}, async () => {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const {stdout} = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/search-descendants-probe.cjs')], {env, timeout:25000, maxBuffer:4*1024*1024});
  assert.match(stdout, /SEARCH_DESCENDANTS_OK/);
});
