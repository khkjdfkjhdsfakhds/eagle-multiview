'use strict';
// Group 6 B: the inspector follows Eagle's — section order, the 文件夹 block,
// five-star rating, and a multi-select panel that edits every selected item.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('inspector parity in a real renderer', { timeout: 60000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/inspector-parity-probe.cjs')], { env, timeout: 55000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_INSPECTOR_PARITY '));
  assert.ok(line, `missing inspector parity result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_INSPECTOR_PARITY '.length));

  assert.equal(result.singleOrder, true, '名称 → 注释 → 链接 → 标签 → 文件夹 → 标注 → 评分 → 基本信息');
  assert.equal(result.ratingSelectHidden, true);
  assert.deepEqual(result.folderChips.map(chip => [chip.name, chip.title]), [['甲', '甲'], ['乙', '甲 / 乙']]);
  assert.ok(result.folderChips[0].color, 'a coloured folder colours its chip');
  assert.equal(result.addButton, '+');
  assert.equal(result.litStars, 2);
  assert.deepEqual(result.metaLabels, ['尺寸', '文件大小', '格式', '添加日期', '创建日期', '修改日期']);
  assert.deepEqual(result.starWrites, [4, 0], 'a star sets, the lit star clears');
  assert.deepEqual(result.folderRemoval.map(call => call.remove), [['folder-b']], 'only that folder, not its parent');
  assert.deepEqual(result.selectedAfterRemoval, ['item-1']);
  assert.equal(result.audioMeta[0], '时长2:05', 'audio shows 时长 and no 尺寸');
  assert.equal(result.emptyFolderButton, '+ 添加文件夹');

  assert.deepEqual(result.multi, {
    count: '已选 2 个文件', thumbs: 2, annotation: '同一注释', url: '', urlPlaceholder: '多个链接',
    sharedTags: ['共同'], sharedFolders: ['甲'], litStars: 0, meta: '文件大小3.9 KB'
  });
  assert.equal(result.untouchedLinkWrites, 0, 'focusing and leaving a field writes nothing');
  assert.deepEqual(result.batchWrites, [
    { id: 'item-1', patch: { annotation: '批量注释' } }, { id: 'item-2', patch: { annotation: '批量注释' } },
    { id: 'item-1', patch: { star: 3 } }, { id: 'item-2', patch: { star: 3 } },
    { id: 'item-1', field: 'tags', add: ['批量标签'], remove: [] }, { id: 'item-2', field: 'tags', add: ['批量标签'], remove: [] }
  ]);
  assert.deepEqual(result.selectionAfterBatch, ['item-1', 'item-2'], 'batch edits keep the selection');
  assert.equal(result.pickerOpen, true, 'the opening click does not dismiss the folder picker');
});
