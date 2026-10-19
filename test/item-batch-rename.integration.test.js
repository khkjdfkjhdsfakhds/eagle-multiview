'use strict';
// Eagle's batch rename of several items (OPEN_RENAME type IMAGE).
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('several items: 重命名 N 个项目... and ⌘R open Eagle\'s batch rename', { timeout: 60000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/item-batch-rename-probe.cjs')], { env, timeout: 55000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_ITEM_RENAME '));
  assert.ok(line, `missing result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_ITEM_RENAME '.length));
  assert.match(result.menuRow, /^重命名 3 个项目\.\.\./);
  assert.equal(result.title, '批量重命名 (3)');
  assert.equal(result.defaultPattern, '新名字 - %N', 'Eagle\'s first name');
  assert.equal(result.thumbs, 3);
  assert.deepEqual(result.defaultRows, ['素材 1 > 新名字 - 1', '素材 2 > 新名字 - 2', '素材 3 > 新名字 - 3']);
  assert.deepEqual(result.rows, ['素材 1 > 图01', '素材 2 > 图02', '素材 3 > 图03'], 'a slash is dropped from a file name');
  assert.deepEqual(result.writes, ['item-1=图01', 'item-2=图02', 'item-3=图03']);
  assert.equal(result.toast, '3 个项目已重命名。');
  assert.equal(result.lastName, '图/%NN');
  assert.equal(result.commandRPattern, '图/%NN', 'the last name used comes back');
  assert.equal(result.closed, true);
});
