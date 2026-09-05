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
