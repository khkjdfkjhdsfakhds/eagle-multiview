'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('/ toggles expand-all and collapse, collapsing keeps the way to the current folder (R2-03)', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/folder-locate-probe.cjs')], { env, timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
  const line = stdout.split('\n').find(entry => entry.startsWith('FOLDER_LOCATE '));
  assert.ok(line, stdout);
  const { first, second, third, fourth, rootCollapse } = JSON.parse(line.slice('FOLDER_LOCATE '.length));
  // The parent was open (the tree revealed the path): / collapses, as before,
  // but A and B stay open and C stays in view.
  assert.deepEqual(first.expanded, ['A', 'B']);
  assert.equal(first.toast, '已收起全部文件夹');
  assert.equal(first.activeVisible, true);
  // The collapsed tree counts as collapsed: / expands everything again.
  assert.deepEqual(second.expanded, ['A', 'B', 'C', 'other']);
  assert.equal(second.toast, '已展开全部文件夹并定位当前文件夹');
  assert.equal(second.activeVisible, true);
  assert.deepEqual(third.expanded, ['A', 'B']);
  assert.ok(third.rows < second.rows);
  assert.deepEqual(fourth.expanded, ['A', 'B', 'C', 'other']);
  assert.deepEqual(rootCollapse.expanded, [], 'outside a folder, collapsing closes everything');
  assert.equal(rootCollapse.toast, '已收起全部文件夹');
});
