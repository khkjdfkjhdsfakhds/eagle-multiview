'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { DataHub } = require('../lib/data-hub');
const { folderRemovalScript } = require('../lib/folder-removal');

const LIBRARY = '/fixture.library';

function locate(nodes, id) {
  for (const folder of nodes) {
    if (folder.id === id) return { folder, siblings: nodes };
    const found = locate(folder.children || [], id);
    if (found) return found;
  }
  return null;
}

// A stand-in for Eagle's renderer: $bodyScope.removeFolder has the shape the
// script checks for, asks through window.swal (the folder prompt after
// 100 ms, then 批量操作确认 for 50+ items), and removes the subtree like
// Eagle's private removeFolder.
function eagleRenderer(adapter, { shape = true } = {}) {
  const window = {};
  const unrelated = [];
  const original = function (options) { unrelated.push(options); return new Promise(() => {}); };
  original.clickConfirm = () => 'kept';
  window.swal = original;
  const mappings = {};
  const index = (nodes, parent) => nodes.forEach(folder => { mappings[folder.id] = folder; folder.parent = parent; index(folder.children || [], folder.id); });
  index(adapter.tree, undefined);
  const scope = {
    libraryPath: LIBRARY,
    folderMappings: mappings,
    currentFolder: null,
    removals: [],
    checkOperationSafety2(count, callback, amount = 100) {
      if (count >= amount) window.swal({ customClass: 'alert-box', allowEnterKey: false, html: 'bulk' }).then(callback);
      else callback();
    },
    $evalAsync() {},
    $root: { undo() {}, closeAll() { scope.closed = (scope.closed || 0) + 1; } }
  };
  function removeFolder(folder, params) {
    scope.removals.push({ id: folder.id, params: { ...params } });
    // Eagle's notice keeps a restore of the tree and the items (10 ms later).
    const savedTree = JSON.parse(JSON.stringify(adapter.tree));
    const savedItems = JSON.parse(JSON.stringify(adapter.items));
    setTimeout(() => {
      scope.$root.undo = function restore() {
        scope.restored = (scope.restored || 0) + 1;
        adapter.tree.splice(0, adapter.tree.length, ...savedTree);
        adapter.items.splice(0, adapter.items.length, ...savedItems);
        index(adapter.tree, undefined);
      };
    }, 10);
    const location = locate(adapter.tree, folder.id);
    location.siblings.splice(location.siblings.indexOf(folder), 1);
    const ids = new Set();
    const collect = node => { ids.add(node.id); (node.children || []).forEach(collect); };
    collect(folder);
    for (const item of adapter.items) {
      for (const id of ids) {
        const at = item.folders.indexOf(id);
        if (at === -1) continue;
        if (params.isDeleteImages && item.folders.length === 1) item.isDeleted = true;
        item.folders.splice(at, 1);
      }
    }
    ids.forEach(id => delete mappings[id]);
  }
  scope.removeFolder = shape ? function (folder, params = {}) {
    if (folder.password && !folder.isUnLock) return;
    if (folder.imageCount > 0 || folder.children.length > 0) {
      setTimeout(function () {
        var message = "dialog.removeFolder.desc";
        window.swal({ html: message, customClass: 'alert-box', input: 'checkbox', inputValue: 1 }).then(function (result) {
          scope.checkOperationSafety2(folder.descendantImageCount, function () {
            params.isDeleteImages = (result == 1);
            removeFolder(folder, params);
          }, 50);
        });
      }, 100);
    } else removeFolder(folder, params);
  } : function (folder) { removeFolder(folder, {}); };
  return { scope, window, original, unrelated };
}

class Adapter {
  constructor() {
    this.libraryPath = LIBRARY;
    this.tree = [
      { id: 'A', name: '旧素材', imageCount: 2, descendantImageCount: 3, children: [
        { id: 'A1', name: '子', imageCount: 1, descendantImageCount: 1, children: [] }
      ] },
      { id: 'B', name: '保留', imageCount: 1, descendantImageCount: 1, children: [] },
      { id: 'E', name: '空', imageCount: 0, descendantImageCount: 0, children: [] }
    ];
    this.items = [
      { id: 'i1', folders: ['A'] },
      { id: 'i2', folders: ['A', 'B'] },
      { id: 'i3', folders: ['A1'] }
    ];
    this.renderer = null;
    this.injected = [];
  }
  async appInfo() { return { version: 'fixture' }; }
  async libraryInfo() { return { path: this.libraryPath, modificationTime: 1 }; }
  async folderTree() {
    const strip = nodes => nodes.map(({ parent, ...folder }) => ({ ...folder, children: strip(folder.children || []) }));
    return strip(this.tree);
  }
  async request(endpoint, options) {
    assert.equal(endpoint, '/api/script/inject');
    this.injected.push(options.body.script);
    const { scope, window } = this.renderer;
    vm.runInNewContext(options.body.script, { $bodyScope: scope, window, setInterval, clearInterval });
  }
}

async function fixture(options) {
  const adapter = new Adapter();
  adapter.renderer = eagleRenderer(adapter, options);
  const hub = new DataHub(adapter);
  await hub.connect();
  return { adapter, hub };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('deleting a folder runs Eagle\'s removeFolder with the user\'s answer and confirms the subtree is gone', async () => {
  const { adapter, hub } = await fixture();
  const changed = [];
  const invalidated = [];
  hub.on('library-changed', event => changed.push(event));
  hub.on('query-invalidated', event => invalidated.push(event));
  const result = await hub.removeFolder({ id: 'A', baseName: '旧素材', isDeleteImages: true, libraryPath: LIBRARY, origin: 7 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removedIds.sort(), ['A', 'A1']);
  assert.equal(result.parentId, null);
  assert.deepEqual(adapter.tree.map(folder => folder.id), ['B', 'E']);
  // Only-here items go to the trash; one also in B just loses A.
  assert.deepEqual(adapter.items, [
    { id: 'i1', folders: [], isDeleted: true },
    { id: 'i2', folders: ['B'] },
    { id: 'i3', folders: [], isDeleted: true }
  ]);
  // Eagle is not showing A, so it stays where it is.
  assert.deepEqual(adapter.renderer.scope.removals, [{ id: 'A', params: { ignoreSelectNext: true, isDeleteImages: true } }]);
  assert.equal(changed.at(-1).origin, 7);
  assert.deepEqual(changed.at(-1).library.folders.map(folder => folder.id), ['B', 'E']);
  assert.ok(invalidated.some(event => event.reason === 'folder-remove' && event.id === 'A'));
  await wait(120);
  assert.equal(adapter.renderer.window.swal, adapter.renderer.original, 'Eagle\'s own prompt is back once the folder is gone');
});

test('unticking 把文件夹内项目丢到回收站 keeps every item, only out of the folder', async () => {
  const { adapter, hub } = await fixture();
  await hub.removeFolder({ id: 'A', baseName: '旧素材', isDeleteImages: false, libraryPath: LIBRARY });
  assert.deepEqual(adapter.items, [
    { id: 'i1', folders: [] },
    { id: 'i2', folders: ['B'] },
    { id: 'i3', folders: [] }
  ]);
});

test('Eagle\'s 批量操作确认 for 50+ items is answered too, and an empty folder goes without prompts', async () => {
  const { adapter, hub } = await fixture();
  adapter.tree[0].descendantImageCount = 80;
  adapter.renderer = eagleRenderer(adapter);
  assert.equal((await hub.removeFolder({ id: 'A', baseName: '旧素材', libraryPath: LIBRARY })).ok, true);
  assert.equal((await hub.removeFolder({ id: 'E', baseName: '空', libraryPath: LIBRARY })).ok, true);
  assert.deepEqual(adapter.tree.map(folder => folder.id), ['B']);
  assert.deepEqual(adapter.renderer.unrelated, [], 'no prompt was left for Eagle to show');
});

test('when Eagle shows the folder being deleted, it moves its own view as it does natively', async () => {
  const { adapter, hub } = await fixture();
  adapter.renderer.scope.currentFolder = adapter.renderer.scope.folderMappings.A1;
  await hub.removeFolder({ id: 'A', baseName: '旧素材', libraryPath: LIBRARY });
  assert.deepEqual(adapter.renderer.scope.removals[0].params, { isDeleteImages: true });
});

test('other prompts during the deletion are still Eagle\'s', () => {
  const adapter = new Adapter();
  adapter.renderer = eagleRenderer(adapter);
  const { scope, window, unrelated } = adapter.renderer;
  vm.runInNewContext(folderRemovalScript({ id: 'A', libraryPath: LIBRARY }), { $bodyScope: scope, window, setInterval, clearInterval });
  window.swal({ customClass: 'alert-box', html: 'something else' });
  assert.equal(unrelated.length, 1);
  assert.equal(window.swal.clickConfirm(), 'kept', 'swal helpers still work');
});

test('a renamed or vanished folder is not deleted', async () => {
  const { adapter, hub } = await fixture();
  const conflict = await hub.removeFolder({ id: 'A', baseName: '别的名字', libraryPath: LIBRARY });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.current.name, '旧素材');
  assert.deepEqual(await hub.removeFolder({ id: 'Z', baseName: 'x', libraryPath: LIBRARY }), { ok: false, missing: true });
  assert.equal(adapter.injected.length, 0);
});

test('Eagle refusing (a locked folder, another removeFolder shape, another library) leaves the folder and says so', async () => {
  // Each case waits out the confirmation window, so they run side by side.
  await Promise.all([
    adapter => { adapter.tree[1].password = 'x'; },
    adapter => { adapter.renderer = eagleRenderer(adapter, { shape: false }); },
    adapter => { adapter.renderer.scope.libraryPath = '/other.library'; }
  ].map(async setup => {
    const { adapter, hub } = await fixture();
    setup(adapter);
    await assert.rejects(hub.removeFolder({ id: 'B', baseName: '保留', libraryPath: LIBRARY }), error => {
      assert.equal(error.code, 'FOLDER_REMOVE_REFUSED');
      assert.equal(error.uncertain, undefined);
      assert.match(error.message, /没有执行删除/);
      return true;
    });
    assert.ok(locate(adapter.tree, 'B'));
  }));
});

test('the renderer offers 删除文件夹 at the end of both folder menus and on ⌘⌫', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  assert.ok(source.includes("removeFolderMenuRows(data.targetFolderId, { selectNext: true })"), 'sidebar menu, then the next folder opens');
  assert.ok(source.includes("removeFolderMenuRows(data.folderId, { selectNext: false })"), 'subfolder card menu, the view stays');
  assert.ok(source.includes("else if (!previewOpen) requestFolderRemovalShortcut();"), 'menu ⌘⌫ with no item selected');
  const dialog = source.slice(source.indexOf('function chooseFolderRemoval('), source.indexOf('async function removeFolderById('));
  assert.ok(dialog.includes("$('#trashDialogCheckbox').checked = true;"), 'the checkbox starts ticked, as in Eagle');
  assert.ok(dialog.includes("$('#trashDeleteButton').focus();"), 'Eagle focuses 确认删除');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const shim = fs.readFileSync(path.join(__dirname, '..', 'src', 'web-shim.js'), 'utf8');
  assert.ok(preload.includes("removeFolder: data => ipcRenderer.invoke('folder:remove', data)"));
  assert.ok(shim.includes("removeFolder: data => invoke('folder:remove', [data])"));
});

test('after a sidebar delete Eagle opens the next sibling, else the previous, else the parent, else 全部', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('function folderViewAfterRemoval(');
  const body = source.slice(start, source.indexOf('\n}\n', start) + 2);
  const { findFolderPath } = require('../src/folder-navigation.js');
  const make = folders => new Function('state', 'findFolderPath', 'window', 'manualOrder', `${body}; return folderViewAfterRemoval;`)(
    { library: { folders } }, findFolderPath, { EagleMVManualOrder: { sort: list => list } }, () => null);
  const tree = [
    { id: 'P', children: [{ id: 'a', children: [] }, { id: 'b', children: [] }, { id: 'c', children: [] }] },
    { id: 'Q', children: [{ id: 'only', children: [] }] }
  ];
  const next = make(tree);
  assert.deepEqual(next('a'), { kind: 'folder', id: 'b' });
  assert.deepEqual(next('c'), { kind: 'folder', id: 'b' });
  assert.deepEqual(next('only'), { kind: 'folder', id: 'Q' });
  assert.deepEqual(next('P'), { kind: 'folder', id: 'Q' });
  assert.deepEqual(make([{ id: 'solo', children: [] }])('solo'), { kind: 'all' });
});

// P3-05: the 撤销 of “X”已删除。 runs Eagle's own restore.
test('撤销 runs the restore Eagle keeps for the deletion: tree and items come back', async () => {
  const { adapter, hub } = await fixture();
  const before = { tree: await adapter.folderTree(), items: JSON.parse(JSON.stringify(adapter.items)) };
  const removed = await hub.removeFolder({ id: 'A', baseName: '旧素材', isDeleteImages: true, libraryPath: LIBRARY });
  assert.ok(removed.undoToken);
  await wait(150);
  const changed = [];
  hub.on('library-changed', event => changed.push(event));
  assert.deepEqual(await hub.restoreRemovedFolder({ id: 'A', undoToken: removed.undoToken, libraryPath: LIBRARY }), { ok: true });
  assert.equal(adapter.renderer.scope.restored, 1);
  assert.equal(adapter.renderer.scope.closed, 1, 'Eagle\'s notice closes as its own 撤销 does');
  assert.deepEqual(await adapter.folderTree(), before.tree);
  assert.deepEqual(adapter.items, before.items);
  assert.ok(changed.at(-1).library.folders.some(folder => folder.id === 'A'));
  assert.equal(adapter.renderer.window.__eaglemvFolderUndo, null, 'the kept restore is used up');
  await hub.restoreRemovedFolder({ id: 'A', undoToken: removed.undoToken, libraryPath: LIBRARY });
  assert.equal(adapter.renderer.scope.restored, 1, 'a restore runs once');
});

test('once Eagle has a newer notice, 撤销 changes nothing and says the undo has expired', async () => {
  const { adapter, hub } = await fixture();
  const removed = await hub.removeFolder({ id: 'E', baseName: '空', libraryPath: LIBRARY });
  await wait(150);
  adapter.renderer.scope.$root.undo = function newerNotice() {};
  await assert.rejects(hub.restoreRemovedFolder({ id: 'E', undoToken: removed.undoToken, libraryPath: LIBRARY }), { code: 'FOLDER_RESTORE_EXPIRED' });
  assert.equal(adapter.renderer.scope.restored, undefined);
  assert.ok(!(await adapter.folderTree()).some(folder => folder.id === 'E'));
});
