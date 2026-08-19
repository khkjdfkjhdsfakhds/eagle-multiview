'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

test('actual Electron renderer drives new-window controls, folder rename sync, and responsive wrapping', { timeout: 20000 }, async () => {
  const electron = require('electron');
  const runner = require.resolve('../test-support/renderer-ui-runner.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 18000 });
  assertCleanElectronStderr(assert, stderr, 'renderer UI runner');
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_UI_RESULT '));
  assert.ok(line, `missing UI result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_UI_RESULT '.length));
  assert.equal(result.labels.length, 3);
  assert.equal(result.searchExited, true);
  assert.deepEqual(result.renamePreserved, { viewId: 'mv-folder', title: '重命名后文件夹' });
  assert.equal(result.recent[1].id, 'eagle-folder');
  assert.notEqual(result.desktopNarrow.sidebarPosition, 'fixed');
  assert.notEqual(result.desktopNarrow.inspectorPosition, 'fixed');
  assert.ok(result.desktopNarrow.searchLeft >= 80);
  assert.equal(result.desktopSidebarHidden.sidebarHidden, true);
  assert.ok(result.desktopSidebarHidden.searchLeft >= 80);
  assert.ok(result.layouts.some(layout => layout.wrapped));
});
