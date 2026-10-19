'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
test('/ toggles between expanding every folder and collapsing every folder', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/folder-locate-probe.cjs')], { env, timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
  const line = stdout.split('\n').find(entry => entry.startsWith('FOLDER_LOCATE '));
  assert.ok(line, stdout);
  const { first, second, third, fourth, rootCollapse } = JSON.parse(line.slice('FOLDER_LOCATE '.length));
  // The parent was open (the tree revealed the path): / collapses every
  // folder, the current folder's ancestors included, as Eagle does.
  assert.deepEqual(first.expanded, []);
  assert.equal(first.toast, '已收起全部文件夹');
  // / then expands everything and locates the current folder.
  assert.deepEqual(second.expanded, ['A', 'B', 'C', 'other']);
  assert.equal(second.toast, '已展开全部文件夹并定位当前文件夹');
  assert.equal(second.activeVisible, true);
  assert.deepEqual(third.expanded, []);
  assert.ok(third.rows < second.rows);
  assert.deepEqual(fourth.expanded, ['A', 'B', 'C', 'other']);
  assert.deepEqual(rootCollapse.expanded, [], 'outside a folder, collapsing closes everything');
  assert.equal(rootCollapse.toast, '已收起全部文件夹');
});
