'use strict';
// Eagle's inspector, rest (optional items, second half): 标签 / 文件夹 /
// 标注 / 基本信息 fold under their headings and are dragged into order (kept
// for every window, both inspectors), 导出 under 基本信息, and the next item
// selected when the selection leaves the folder on screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('inspector sections, export and the next selection', { timeout: 60000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/inspector-sections-probe.cjs')], { env, timeout: 55000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_INSPECTOR_SECTIONS '));
  assert.ok(line, `missing inspector result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_INSPECTOR_SECTIONS '.length));

  assert.deepEqual(result.defaultOrder, ['tags', 'folders', 'annotations', 'information'], 'Eagle\'s default order');
  assert.deepEqual(result.headings, ['标签:true', '文件夹:true', '评论与标注:true', '基本信息:true']);
  assert.equal(result.foldedFolders, true);
  assert.equal(result.storedFold, true);
  assert.equal(result.multiFolded, true, 'one fold for both inspectors, as Eagle\'s show* flags');
  assert.equal(result.unfolded, true);
  assert.equal(result.notDraggingYet, true, 'under 10px is still a click');
  assert.equal(result.dropMark, true);
  assert.deepEqual(result.multiOrder, ['information', 'tags', 'folders']);
  assert.deepEqual(result.singleOrder, ['information', 'tags', 'folders', 'annotations']);
  assert.equal(result.dragDidNotFold, true, 'the click ending a drag does not fold');
  assert.equal(result.exportButton, '导出');
  assert.deepEqual(result.exportMenu, ['导出到计算机']);
  assert.deepEqual(result.afterRemove, ['item-3'], 'the next item after the one taken out');
  assert.equal(result.inspectorName, '素材 3');
  assert.deepEqual(result.afterTrash, ['item-4']);
  assert.deepEqual(result.afterLast, ['item-1'], 'no next: the one before');
  assert.deepEqual(result.keptOnOtherFolder, ['item-1'], 'leaving another folder keeps the item');
});
