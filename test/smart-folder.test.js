'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSmartFolderConditions } = require('../src/smart-folder');

test('rejects active filters without a verified lossless Eagle rule conversion', () => {
  for (const query of [{ color: '#ff0000' }, { size: { min: 10 } }, { added: { min: 10 } }, { pixels: { min: 10 } }, { search: 'cat', searchScope: 'name' }]) {
    const result = buildSmartFolderConditions({ kind: 'folder', id: 'folder-1' }, query);
    assert.ok(result.unsupported, JSON.stringify(query));
    assert.deepEqual(result.conditions, []);
  }
});

test('converts a folder-scoped structured query to Eagle smart-folder rules', () => {
  const result = buildSmartFolderConditions({ kind: 'folder', id: 'folder-1' }, {
    search: 'cat portrait', tags: ['reference'], ext: 'PNG', rating: 4, annotation: 'approved', url: 'example', shape: 'square'
  });
  assert.equal(result.unsupported, null);
  assert.equal(result.conditions.length, 3);
  assert.deepEqual(result.conditions.at(-1).rules, [
    { property: 'folders', method: 'intersection', value: ['folder-1'] },
    { property: 'tags', method: 'intersection', value: ['reference'] },
    { property: 'type', method: 'equal', value: 'png' },
    { property: 'rating', method: 'equal', value: '4' },
    { property: 'annotation', method: 'contain', value: 'approved' },
    { property: 'url', method: 'contain', value: 'example' },
    { property: 'shape', method: 'equal', value: 'square' }
  ]);
});

test('does not claim that advanced full-text syntax can be converted losslessly', () => {
  const result = buildSmartFolderConditions({ kind: 'all' }, { search: 'cat OR dog -watermark' });
  assert.match(result.unsupported, /高级搜索语法/);
  assert.deepEqual(result.conditions, []);
});

test('represents unfiled and untagged views with empty-set rules', () => {
  assert.deepEqual(buildSmartFolderConditions({ kind: 'unfiled' }, {}).conditions[0].rules, [
    { property: 'folders', method: 'empty' }
  ]);
  assert.deepEqual(buildSmartFolderConditions({ kind: 'untagged' }, {}).conditions[0].rules, [
    { property: 'tags', method: 'empty' }
  ]);
});

test('a searched folder or root saves what the view shows (S-05)', () => {
  // A search inside a folder covers its subtree; Eagle's `union` matches any.
  const folder = buildSmartFolderConditions({ kind: 'folder', id: 'A' }, { search: 'cat' }, [], { folderScope: ['A', 'A1', 'A2'] });
  assert.deepEqual(folder.conditions.at(-1).rules, [{ property: 'folders', method: 'union', value: ['A', 'A1', 'A2'] }]);
  // Without a search the folder view is the folder alone.
  const plain = buildSmartFolderConditions({ kind: 'folder', id: 'A' }, { tags: ['t'] }, [], { folderScope: null });
  assert.deepEqual(plain.conditions[0].rules[0], { property: 'folders', method: 'intersection', value: ['A'] });
  // A search at the root covers the whole library, not 未分类.
  const root = buildSmartFolderConditions({ kind: 'root' }, { search: 'cat' });
  assert.equal(root.conditions.length, 1, 'only the search condition');
  assert.ok(!JSON.stringify(root.conditions).includes('"empty"'));
  // The unsearched root still shows only unfiled items.
  assert.deepEqual(buildSmartFolderConditions({ kind: 'root' }, { tags: ['t'] }).conditions[0].rules[0], { property: 'folders', method: 'empty' });
});

test('tag, folder and format lists convert with Eagle rule methods', () => {
  const build = query => buildSmartFolderConditions({ kind: 'all' }, query);
  assert.deepEqual(build({ tags: ['a', 'b'] }).conditions, [
    { match: 'OR', boolean: 'TRUE', rules: [{ property: 'tags', method: 'union', value: ['a', 'b'] }] }
  ]);
  assert.deepEqual(build({ tags: ['a'], tagsExclude: ['x'], tagLogic: 'EQUAL' }).conditions[0].rules, [
    { property: 'tags', method: 'equal', value: ['a'] },
    { property: 'tags', method: 'identity', value: ['x'] }
  ]);
  assert.deepEqual(build({ tags: ['a'], noTags: true }).conditions[0].rules, [
    { property: 'tags', method: 'union', value: ['a'] },
    { property: 'tags', method: 'empty' }
  ]);
  assert.deepEqual(build({ folderInclude: ['F1', 'NoFolders'], folderLogic: 'AND' }).conditions[0].rules, [
    { property: 'folders', method: 'intersection', value: ['F1'] },
    { property: 'folders', method: 'empty' }
  ]);
  assert.match(build({ folderInclude: ['F1'], folderExclude: ['NoFolders'] }).unsupported, /文件夹/);
  assert.deepEqual(build({ ext: ['png', 'jpg'] }).conditions, [
    { match: 'OR', boolean: 'TRUE', rules: [{ property: 'type', method: 'equal', value: 'png' }, { property: 'type', method: 'equal', value: 'jpg' }] }
  ]);
  assert.match(build({ extExclude: ['gif'] }).unsupported, /格式/);
  for (const [query, label] of [[{ modifiedPresets: ['today'] }, '修改日期'], [{ duration: { min: 5 } }, '时长'], [{ comments: 'has' }, '标注']]) {
    assert.match(build(query).unsupported, new RegExp(label));
  }
});

test('the filter menus\' multi-choice and 有/没有 rules save as their Eagle rules', () => {
  const result = buildSmartFolderConditions({ kind: 'all' }, {
    rating: [5, 0], shape: ['landscape'], annotationState: 'has', annotation: 'blue, sea', urlState: 'none',
    width: { min: 1000 }, height: { min: 100, max: 800 }
  });
  assert.equal(result.unsupported, null);
  const [all, ...groups] = result.conditions;
  assert.deepEqual(all.rules, [
    { property: 'annotation', method: 'contain', value: 'blue' },
    { property: 'annotation', method: 'contain', value: 'sea' },
    { property: 'url', method: 'empty' },
    { property: 'width', method: '>=', value: [1000] },
    { property: 'height', method: 'between', value: [100, 800] }
  ]);
  assert.deepEqual(groups.map(group => group.rules), [
    [{ property: 'rating', method: 'equal', value: '5' }, { property: 'rating', method: 'equal', value: 'none' }],
    // 横图 in the menu takes the 细长 ones too; Eagle's shape rule does not.
    [{ property: 'shape', method: 'equal', value: 'landscape' }, { property: 'shape', method: 'equal', value: 'panoramic-landscape' }]
  ]);
  assert.match(buildSmartFolderConditions({ kind: 'all' }, { shape: ['16:9'] }).unsupported, /形状/);
  assert.deepEqual(buildSmartFolderConditions({ kind: 'all' }, { annotationState: 'has' }).conditions[0].rules,
    [{ property: 'annotation', method: 'not-empty' }]);
});
