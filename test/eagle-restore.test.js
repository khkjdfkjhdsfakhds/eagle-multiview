'use strict';

// P3-05: the restores behind Eagle's 撤销 notices that the API cannot undo,
// run against a stand-in for Eagle's renderer.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { commentRestoreScript, locateSmartFolder, smartFolderRestoreScript } = require('../lib/eagle-restore');
const { DataHub } = require('../lib/data-hub');

const LIBRARY = '/fixture.library';

function eagleScope({ smartFolders = [], items = {} } = {}) {
  const mappings = {};
  const index = (nodes, parent) => nodes.forEach(folder => { mappings[folder.id] = folder; if (parent) folder.parent = parent; index(folder.children || [], folder.id); });
  index(smartFolders);
  const calls = [];
  return {
    calls,
    scope: {
      libraryPath: LIBRARY,
      smartFolders,
      smartFolderMappings: mappings,
      itemMappings: items,
      smartFolderCount: folder => (folder.conditions?.length || 0) * 10,
      updateSidebarList: () => calls.push('sidebar'),
      saveFolderDebounce: () => calls.push('save'),
      $broadcast: name => calls.push(name),
      $evalAsync() {}
    }
  };
}

const run = (script, scope, extra = {}) => vm.runInNewContext(script, { $bodyScope: scope, ...extra });

test('locates a smart folder with its parent and place', () => {
  const tree = [{ id: 'a', children: [{ id: 'a1', children: [] }, { id: 'a2', children: [] }] }, { id: 'b', children: [] }];
  assert.deepEqual(locateSmartFolder(tree, 'a2'), { folder: tree[0].children[1], parentId: 'a', index: 1 });
  assert.deepEqual(locateSmartFolder(tree, 'b'), { folder: tree[1], parentId: null, index: 1 });
  assert.equal(locateSmartFolder(tree, 'z'), null);
});

test('a removed smart folder goes back where it was, children and all, and Eagle saves', () => {
  const { scope, calls } = eagleScope({ smartFolders: [{ id: 'p', name: 'P', children: [{ id: 'x', name: 'X', children: [] }] }] });
  const removed = { id: 'r', name: '已删', conditions: [{ rules: [] }], children: [{ id: 'rc', name: '子', conditions: [], children: [] }] };
  assert.equal(run(smartFolderRestoreScript({ libraryPath: LIBRARY, folder: removed, parentId: 'p', index: 0 }), scope), true);
  assert.deepEqual(scope.smartFolders[0].children.map(folder => folder.id), ['r', 'x']);
  assert.equal(scope.smartFolderMappings.r.parent, 'p');
  assert.equal(scope.smartFolderMappings.rc.parent, 'r');
  assert.equal(scope.smartFolderMappings.r.imageCount, 10);
  assert.deepEqual(calls, ['sidebar', 'save']);
  // Already back: nothing more.
  assert.equal(run(smartFolderRestoreScript({ libraryPath: LIBRARY, folder: removed, parentId: 'p', index: 0 }), scope), true);
  assert.equal(scope.smartFolders[0].children.length, 2);
});

test('a smart folder restore changes nothing in another library or an unexpected Eagle', () => {
  const removed = { id: 'r', name: 'R', children: [] };
  const other = eagleScope();
  other.scope.libraryPath = '/other.library';
  assert.equal(run(smartFolderRestoreScript({ libraryPath: LIBRARY, folder: removed }), other.scope), false);
  const shapeless = eagleScope();
  delete shapeless.scope.saveFolderDebounce;
  assert.equal(run(smartFolderRestoreScript({ libraryPath: LIBRARY, folder: removed }), shapeless.scope), false);
  assert.equal(shapeless.scope.smartFolders.length, 0);
  const orphan = eagleScope();
  assert.equal(run(smartFolderRestoreScript({ libraryPath: LIBRARY, folder: removed, parentId: 'gone' }), orphan.scope), false);
});

test('a removed comment goes back into the item at its old place', () => {
  const item = { id: 'i', comments: [{ id: 'c1' }, { id: 'c3' }] };
  const { scope, calls } = eagleScope({ items: { i: item } });
  const changed = [];
  const script = commentRestoreScript({ libraryPath: LIBRARY, id: 'i', comment: { id: 'c2', annotation: '原文', x: 1, y: 2, width: 3, height: 4 }, index: 1 });
  assert.equal(run(script, scope, { ayncsImagesChange: list => changed.push(list) }), true);
  assert.deepEqual(item.comments.map(comment => comment.id), ['c1', 'c2', 'c3']);
  assert.equal(changed.length, 1, 'Eagle saves the item');
  assert.deepEqual(calls, ['REBIND_REFRESH']);
  assert.equal(run(script, scope, { ayncsImagesChange: list => changed.push(list) }), true);
  assert.equal(item.comments.length, 3, 'a second run adds nothing');
  assert.equal(run(script, scope, {}), false, 'no Eagle save function, no change');
});

test('mutateSet reports what it replaced, for the 撤销', async () => {
  const items = { i: { id: 'i', folders: ['a'], tags: ['t'] } };
  const client = {
    async appInfo() { return {}; },
    async libraryInfo() { return { path: LIBRARY }; },
    async folderTree() { return [{ id: 'a', name: 'A', children: [] }, { id: 'b', name: 'B', tags: ['自动'], children: [] }]; },
    async getItem(id) { return structuredClone(items[id]); },
    async updateItem(id, patch) { Object.assign(items[id], patch); return structuredClone(items[id]); }
  };
  const hub = new DataHub(client);
  await hub.connect();
  const result = await hub.mutateSet({ id: 'i', field: 'folders', add: ['b'], remove: ['a'], autoTags: 'always', libraryPath: LIBRARY });
  assert.deepEqual(result.previous, { folders: ['a'], tags: ['t'] });
  assert.deepEqual(result.item.folders, ['b']);
  assert.deepEqual(result.item.tags, ['t', '自动']);
});
