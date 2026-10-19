'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('导入本地文件夹: sidebar drop, menu entries, Eagle questions, folder rows take files only', { timeout: 40000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/folder-structure-import-probe.cjs')], { env, timeout: 35000, maxBuffer: 4 * 1024 * 1024 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_FOLDER_STRUCTURE '));
  assert.ok(line, `missing probe result: ${stdout}`);
  const out = JSON.parse(line.slice('EAGLEMV_FOLDER_STRUCTURE '.length));
  assert.deepEqual(out.blankPlan.paths, ['/Users/tester/素材', '/Users/tester/很深', '/Users/tester/很多']);
  assert.deepEqual(out.blankRun.accept, [0], 'only the folder that passed both questions is imported');
  assert.equal(out.blankRun.parentId, null, 'imports land at the library root, as in Eagle');
  assert.equal(out.alerts, 1, 'the too-deep folder is refused with Eagle’s notice');
  assert.match(out.confirmText, /文件夹包含 2400 个文件/);
  assert.equal(out.opened, 'new-root', 'the new folder opens');
  assert.equal(out.expanded, true);
  assert.equal(out.newMenuRow, true);
  assert.equal(out.menuPlanHasPaths, false, 'the menu lets main show the folder picker');
  assert.equal(out.duplicateRun.duplicateChoice, 'use-existing');
  assert.equal(out.rowImport.ignoreDirectories, true, 'a sidebar folder takes the files only');
  assert.equal(out.rowImport.folderId, 'mv-folder');
  assert.equal(out.contentImport.ignoreDirectories, undefined, 'the content area keeps flattening folders');
  assert.equal(out.plansAfterRowDrops, 3, 'folder rows and the content area do not start a structured import');
});
