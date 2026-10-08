'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('created root and child folders remain visible after the final ordering snapshot', {timeout:30000}, async () => {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const {stdout} = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/folder-create-scroll-probe.cjs')], {env, timeout:25000, maxBuffer:4*1024*1024});
  assert.match(stdout, /FOLDER_CREATE_SCROLL_OK/);
});
