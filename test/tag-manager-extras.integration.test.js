'use strict';
// The rest of Eagle's tag manager (optional items, second half): the 格状 /
// 列表 switch, group colours through tagGroup/update, 重命名 N 个项目... with
// Eagle's batch rename dialog, and groups dragged into MultiView's own order.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('tag manager layout, group colours, batch rename and group order', { timeout: 60000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/tag-manager-extras-probe.cjs')], { env, timeout: 55000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_TAG_EXTRAS '));
  assert.ok(line, `missing tag manager result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_TAG_EXTRAS '.length));

  assert.deepEqual(result.layoutButtons, ['格状*', '列表']);
  assert.equal(result.listFullWidth, true, '列表 gives every tag its own row');
  assert.equal(result.storedLayout, 'list');

  assert.deepEqual(result.groupMenu, ['搜索包含群组标签的项目', '重命名', '删除群组']);
  assert.deepEqual(result.swatches, ['无*', '红', '橙', '黄', '绿', '青', '蓝', '紫', '粉']);
  assert.equal(result.fruitDot, 'rgb(0, 144, 255)');

  assert.ok(result.tagMenu.includes('重命名 2 个项目...'), result.tagMenu.join('|'));
  assert.ok(!result.tagMenu.includes('重命名'), 'one-tag 重命名 is not shown for several');
  assert.equal(result.dialogTitle, '批量重命名 (2)');
  assert.deepEqual(result.defaultPreview, ['apple > apple', 'Banana > Banana'], '* keeps the name');
  assert.equal(result.startShown, true, '编号起始于 shows once %N is in the name');
  assert.equal(result.indexInsertDisabled, true);
  assert.deepEqual(result.formatPreview, ['apple > 水果 - 01', 'Banana > 水果 - 02']);
  assert.deepEqual(result.dateMenu, ['导入时间', '创建时间', '修改时间']);
  assert.equal(result.dialogAfterMenuEscape, true, 'Esc closes the insert menu first');
  assert.equal(result.submitWithoutFind, true);
  assert.deepEqual(result.replacePreview, ['apple > zpple', 'Banana > zanana']);
  assert.deepEqual(result.struck, ['a', 'B']);
  assert.equal(result.confirm, '重命名提示\n\n将会重命名 2 个文件，确定要重命名吗？');
  assert.deepEqual(result.findHistory, ['/^(a|B)/']);
  assert.equal(result.rememberedMethod, 'replace', 'the dialog keeps its settings, as Eagle\'s does');
  assert.equal(result.rememberedFind, '/^(a|B)/');
  assert.equal(result.patternStartsOver, '*');
  assert.equal(result.escapeClosed, true);
  assert.equal(result.escapeWrote, false);

  assert.equal(result.commandRTitle, '批量重命名 (2)', '⌘R with several tags in a group');
  assert.equal(result.groupDraggable, true);
  assert.deepEqual(result.orderBefore, ['g-animals', 'g-fruit']);
  assert.equal(result.dropBefore, true);
  assert.deepEqual(result.orderAfter, ['g-fruit', 'g-animals']);
  assert.deepEqual(result.storedOrder, ['g-fruit', 'g-animals']);

  assert.deepEqual(result.calls, [
    { kind: 'update-group', id: 'g-fruit', patch: { color: 'blue' } },
    { kind: 'update-group', id: 'g-animals', patch: { color: '' } },
    { kind: 'tag-color', tag: '猫', color: null },
    { kind: 'rename', originalName: 'apple', name: 'zpple' },
    { kind: 'rename', originalName: 'Banana', name: 'zanana' },
    { kind: 'merge', source: '风景', target: '猫' },
    { kind: 'merge', source: '3D', target: '猫' }
  ], 'group order writes nothing to Eagle');
});
