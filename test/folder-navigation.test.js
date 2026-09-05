'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeView, parentView, recordViewNavigation, folderMoveDelta, flattenFolders, searchFolders, overlayFolder } = require('../src/folder-navigation');

const folders = [{
  id: 'top',
  parent: null,
  children: [{
    id: 'middle',
    parent: 'top',
    children: [{ id: 'deep', parent: 'middle', children: [] }]
  }]
}];

test('updates the entry being left with its latest search and takes an immutable snapshot', () => {
  const current = { kind: 'folder', id: 'top', query: { search: 'latest', tags: ['cat'] } };
  const result = recordViewNavigation([{ kind: 'root' }, { kind: 'folder', id: 'top', query: { search: '' } }], 1, current, { kind: 'all' });
  current.query.tags.push('dog');
  assert.deepEqual(result.history[1].query, { search: 'latest', tags: ['cat'] });
});

test('moves from a deep folder to its immediate parent', () => {
  assert.deepEqual(parentView(folders, { kind: 'folder', id: 'deep' }), {
    kind: 'folder',
    id: 'middle',
    parentId: 'top'
  });
});

test('uses the saved parent when the current folder is temporarily absent from the tree', () => {
  const currentView = normalizeView(folders, { kind: 'folder', id: 'deep' });
  assert.deepEqual(parentView([], currentView), {
    kind: 'folder',
    id: 'middle',
    parentId: null
  });
});

test('does not jump to the library root when the folder path is unknown', () => {
  assert.equal(parentView([], { kind: 'folder', id: 'unknown' }), null);
});

test('returns to the library root only from a confirmed top-level folder', () => {
  assert.deepEqual(parentView(folders, { kind: 'folder', id: 'top' }), { kind: 'root' });
});

test('records the initial view before the first navigation in a new pane', () => {
  assert.deepEqual(recordViewNavigation([], -1, { kind: 'root' }, { kind: 'folder', id: 'top' }), {
    history: [{ kind: 'root' }, { kind: 'folder', id: 'top' }],
    historyIndex: 1
  });
});

test('drops forward history after navigating from a previous entry', () => {
  assert.deepEqual(recordViewNavigation(
    [{ kind: 'root' }, { kind: 'folder', id: 'top' }, { kind: 'folder', id: 'middle' }],
    1,
    { kind: 'folder', id: 'top' },
    { kind: 'all' }
  ), {
    history: [{ kind: 'root' }, { kind: 'folder', id: 'top' }, { kind: 'all' }],
    historyIndex: 2
  });
});

test('moves only out of the active folder while preserving other memberships', () => {
  assert.deepEqual(folderMoveDelta('source', 'target'), {
    add: ['target'],
    remove: ['source']
  });
});

test('does not remove a folder when the move target is already active', () => {
  assert.deepEqual(folderMoveDelta('same', 'same'), {
    add: ['same'],
    remove: []
  });
});

test('folder picker searches the complete hierarchy by full path', () => {
  const tree = [
    { id: 'a', name: '参考', children: [{ id: 'b', name: '人物', children: [{ id: 'c', name: '表情', children: [] }] }] },
    { id: 'd', name: '项目', children: [{ id: 'e', name: '表情', children: [] }] }
  ];
  assert.deepEqual(flattenFolders(tree).map(folder => folder.path), ['参考', '参考 / 人物', '参考 / 人物 / 表情', '项目', '项目 / 表情']);
  assert.deepEqual(searchFolders(tree, '人物 / 表情').results.map(folder => folder.id), ['c']);
  assert.deepEqual(searchFolders(tree, '项目').results.map(folder => folder.id), ['d', 'e']);
});

test('folder picker reports truncation instead of silently losing later folders', () => {
  const tree = Array.from({ length: 140 }, (_, index) => ({ id: `folder-${index}`, name: `文件夹 ${index}`, children: [] }));
  const page = searchFolders(tree, '', { excludeId: 'folder-3', limit: 100 });
  assert.equal(page.total, 139);
  assert.equal(page.results.length, 100);
  assert.equal(page.truncated, true);
  assert.equal(searchFolders(tree, '文件夹 139').results[0].id, 'folder-139');
});

test('overlayFolder updates folder in place preserving nested children and untouched siblings', () => {
  const tree = [
    {
      id: 'a',
      name: '原名称A',
      children: [
        { id: 'b', name: '子文件夹B', children: [] },
        { id: 'c', name: '子文件夹C', children: [{ id: 'd', name: '孙D', children: [] }] }
      ]
    },
    { id: 'e', name: '原名称E', children: [] }
  ];
  const updated = overlayFolder(tree, 'a', { name: '新名称A' });
  assert.equal(updated[0].name, '新名称A');
  assert.equal(updated[0].children.length, 2);
  assert.equal(updated[0].children[1].children[0].id, 'd');
  assert.equal(updated[1].name, '原名称E');
});
