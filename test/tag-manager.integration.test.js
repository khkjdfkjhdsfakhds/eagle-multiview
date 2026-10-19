'use strict';
// Group 6 F: the tag manager follows Eagle's — 全部 / 未分类 / 常用标签 /
// 标签群组, sections by initial or group, search, sort, the tag and group
// menus, dragging tags into a group, and the group description.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('tag manager in a real renderer', { timeout: 60000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/tag-manager-probe.cjs')], { env, timeout: 55000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_TAG_MANAGER '));
  assert.ok(line, `missing tag manager result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_TAG_MANAGER '.length));

  assert.deepEqual(result.nav, ['全部=6', '未分类=3', '常用标签=1', '动物=2', '水果=1']);
  assert.deepEqual(result.byInitial, ['A:apple', 'B:Banana', 'F:风景', 'G:狗', 'M:猫', '＃:3D'], 'pinyin initials, ＃ last');
  assert.equal(result.groupDot, 'rgb(229, 72, 77)', 'a group shows its Eagle colour');
  assert.deepEqual(result.sortMenu, ['A > Z', 'Z > A', '数量（多→少）', '数量（少→多）', '分组依据']);
  assert.deepEqual(result.byGroup, ['动物:狗,猫', '水果:apple', '未分类:3D,风景,Banana']);
  assert.equal(result.highlight, 'an');
  assert.equal(result.searchKeepsFocus, true, 'typing a search keeps the field');
  assert.deepEqual(result.unfiled, ['B:Banana', 'F:风景', '＃:3D']);
  assert.deepEqual(result.starred, ['常用标签:狗'], 'Eagle\'s starred tags, read only');
  assert.deepEqual(result.groupView, ['动物:狗,猫']);
  assert.equal(result.description, '宠物');
  assert.deepEqual(result.selected, ['狗', '猫'], '⌘-click adds to the selection');
  assert.deepEqual(result.tagMenu, ['搜索包含标签的项目', '重命名 2 个项目...', '添加至群组...', '移动至群组...', '从标签群组移除', '合并 2 个标签']);
  assert.deepEqual(result.rangeSelected, ['apple', 'Banana'], '⇧-click selects the run');
  assert.equal(result.dropHighlight, true);
  assert.deepEqual(result.groupMenu, ['搜索包含群组标签的项目', '重命名', '删除群组']);
  assert.deepEqual(result.openedQuery, { tags: ['猫'], logic: 'OR' }, 'double-click shows the tag\'s items');
  assert.deepEqual(result.calls, [
    { kind: 'remove', groupId: 'g-animals', tags: ['猫', '狗'] },
    { kind: 'add', groupId: 'g-fruit', tags: ['风景'] },
    { kind: 'rename', originalName: 'apple', name: '水果合集' },
    { kind: 'merge', source: 'Banana', target: '水果合集' },
    { kind: 'add', groupId: 'g-animals', tags: ['3D'] },
    { kind: 'update-group', id: 'g-fruit', patch: { description: '季节水果' } }
  ]);
});
