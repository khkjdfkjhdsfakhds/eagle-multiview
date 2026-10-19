'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('menu commands do nothing behind an open dialog', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/menu-command-guard-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_MENU_COMMAND_GUARD '));
  assert.ok(line, `missing menu command result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_MENU_COMMAND_GUARD '.length));
  assert.deepEqual(result.behindTrashPrompt, { nameDialog: false, writes: 0, toast: '请先完成或关闭当前对话框' });
  assert.deepEqual(result.behindModal, { nameDialog: false });
  assert.equal(result.menuShown, true);
  assert.deepEqual(result.overMenu, { menu: false, nameDialog: true }, 'an open context menu gives way to the command');
});
