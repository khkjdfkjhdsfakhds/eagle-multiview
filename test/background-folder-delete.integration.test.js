'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('a background pane leaving its deleted folder keeps the active pane’s inspector and search', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/background-folder-delete-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_BG_DELETE '));
  assert.ok(line, `missing background delete result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_BG_DELETE '.length));
  assert.deepEqual(result.before, { dirty: true, search: 'needle' }, 'fixture: an unsaved note and a search in the active pane');
  assert.equal(result.bView, 'root', 'the background pane leaves its deleted folder');
  assert.equal(result.active, true);
  assert.equal(result.inspectorShown, true, 'the inspector keeps showing the active pane\u2019s item');
  assert.equal(result.dirty, true, 'the active pane’s edit stays pending');
  assert.equal(result.note, 'unsaved note');
  assert.equal(result.name, 'needle', 'the inspector still shows the active pane’s item');
  assert.equal(result.search, 'needle', 'the search box keeps the active pane’s query');
});
