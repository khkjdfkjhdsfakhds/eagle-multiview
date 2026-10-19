'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('trashing deleted items or restoring live ones writes nothing and adds no undo entry', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/trash-state-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_TRASH_STATE '));
  assert.ok(line, `missing trash state result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_TRASH_STATE '.length));
  assert.deepEqual(result.noop, { calls: 0, undo: 0 });
  assert.deepEqual(result.mixed, ['live'], 'only the live item is moved to the trash');
  assert.deepEqual(result.undo, ['1 个项目已删除。撤销'], 'only the item that really went to the trash is offered for 撤销');
});
