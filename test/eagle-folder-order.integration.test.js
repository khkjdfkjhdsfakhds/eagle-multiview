'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('a folder shows its Eagle sort and drags only its manual order, writing the moved block (P1-02/E-11)', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/eagle-folder-order-probe.cjs')], { env, timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLE_FOLDER_ORDER '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice('EAGLE_FOLDER_ORDER '.length));
  // Eagle 顺序 in a folder sorted by 标题 in Eagle is natural name order.
  assert.deepEqual(result.byName, ['n1', 'n2', 'n10']);
  assert.match(result.nameTitle, /此文件夹在 Eagle 中为“标题”/);
  assert.doesNotMatch(result.nameTitle, /拖动/);
  assert.equal(result.nameMarker, null, 'a name-sorted folder offers no reorder, like Eagle');
  // Manual: order[F] first, then the add time, largest first.
  assert.deepEqual(result.manual, ['n2', 'n10', 'n1']);
  assert.match(result.manualTitle, /自定义排序.*也可直接拖动调整顺序/);
  assert.equal(result.manualMarker, 'horizontal-before');
  assert.equal(result.move.folderId, 'F');
  assert.deepEqual(result.move.ids, ['n1']);
  assert.equal(result.move.anchorId, 'n2');
  assert.equal(result.move.position, 'before');
  assert.deepEqual(result.move.displayedIds, ['n2', 'n10', 'n1']);
  assert.equal(result.move.increase, true);
  assert.deepEqual(result.after, ['n1', 'n2', 'n10']);
  assert.equal(result.sort, 'default', 'the pane stays on Eagle 顺序');
});
