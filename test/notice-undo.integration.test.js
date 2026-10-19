'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('Eagle\'s undoable notices: wording, and 撤销 writes back what the edit replaced', { timeout: 40000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/notice-undo-probe.cjs')], { env, timeout: 35000, maxBuffer: 4 * 1024 * 1024 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_NOTICE_UNDO '));
  assert.ok(line, `missing probe result: ${stdout}`);
  const out = JSON.parse(line.slice('EAGLEMV_NOTICE_UNDO '.length));
  const writes = list => list.map(({ id, patch, base }) => ({ id, patch, base }));

  assert.equal(out.removeNotice, '2 个项目已从“MultiView 文件夹”移除。撤销');
  assert.deepEqual(writes(out.removeUndo), [
    { id: 'a', patch: { folders: ['mv-folder'] }, base: { folders: [] } },
    { id: 'b', patch: { folders: ['mv-folder', 'eagle-folder'] }, base: { folders: ['eagle-folder'] } }
  ]);
  assert.equal(out.addNotice, '1 个项目已添加至“Eagle 文件夹”.撤销');
  assert.deepEqual(writes(out.addUndo), [{ id: 'a', patch: { folders: ['mv-folder'] }, base: { folders: ['mv-folder', 'eagle-folder'] } }]);
  assert.equal(out.moveNotice, '1 个项目已移动至“MultiView 文件夹”.撤销');
  assert.deepEqual(writes(out.moveUndo), [{ id: 'b', patch: { folders: ['mv-folder', 'eagle-folder'] }, base: { folders: ['mv-folder'] } }]);
  assert.equal(out.dragNotice, '1 个项目已移动至“Eagle 文件夹”.撤销');
  assert.deepEqual(writes(out.dragUndo), [{ id: 'a', patch: { folders: ['mv-folder'] }, base: { folders: ['eagle-folder'] } }]);
  assert.equal(out.clearNotice, '已清除标签撤销');
  assert.deepEqual(writes(out.clearWrites), [{ id: 'a', patch: { tags: [] }, base: { tags: ['t1'] } }], 'an item without tags is not written');
  assert.deepEqual(writes(out.clearUndo), [{ id: 'a', patch: { tags: ['t1'] }, base: { tags: [] } }]);
  assert.equal(out.renameNotice, '“MultiView 文件夹”已重命名为“新名字”。撤销');
  assert.equal(out.renameUndo.name, 'MultiView 文件夹');
  assert.equal(out.renameUndo.baseName, '新名字', 'the undo checks the name is still the new one');
});
