'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('folder counts ignore search totals and background refreshes keep the sidebar highlight', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/folder-count-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_FOLDER_COUNT '));
  assert.ok(line, `missing folder count result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_FOLDER_COUNT '.length));
  assert.deepEqual(result.searched, { A: 10 }, 'a search that also matches A1 leaves A at its own count');
  assert.equal(result.bCount, 20, 'an unfiltered folder total still corrects the count');
  assert.equal(result.activeView, 'A');
  assert.deepEqual(result.sidebarActive, ['A'], 'the sidebar keeps highlighting the active pane’s folder');
});
