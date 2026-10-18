'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('新建智能文件夹 with nothing filtered opens the filter panel instead of saving the view', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/new-smart-folder-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_NEW_SMART_FOLDER '));
  assert.ok(line, `missing new smart folder result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_NEW_SMART_FOLDER '.length));
  assert.deepEqual(result.root, { filterPanel: true, nameDialog: false }, 'at the root it no longer saves 未分类');
  assert.deepEqual(result.folder, { filterPanel: true, nameDialog: false }, 'in a folder it no longer saves the folder alone');
  assert.deepEqual(result.withFilter, { nameDialog: true, title: '保存为智能文件夹' }, 'with a filter set it saves');
});
