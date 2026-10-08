'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { loadMain } = require('../test-support/main-data-harness.cjs');
const { folderCoverItemId } = require('../lib/eagle-native-sync');

const plain = value => JSON.parse(JSON.stringify(value));

// A fake Eagle renderer scope plus the native script scope, so the copy routine
// runs exactly as it does against Eagle. `heldBack` models the failure that
// started this work: Eagle accepts the file but never adds it to the visible
// list because its duplicate decision never lands.
async function setupFixture({ heldBackIds = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-folder-copy-'));
  const files = await Promise.all(['one', 'two', 'three'].map(async name => {
    const file = path.join(root, `${name}.txt`);
    await fs.writeFile(file, name);
    return file;
  }));
  const libraryPath = path.join(root, 'fixture.library');
  const main = loadMain(path.join(root, 'user-data'));
  const libraryKey = path.resolve(libraryPath);
  await fs.mkdir(path.join(root, 'user-data', 'state'), { recursive: true });
  await fs.writeFile(path.join(root, 'user-data', 'state', 'pins.json'), JSON.stringify({ version: 1, libraries: {
    [libraryKey]: { source: { one: 11 }, 'source-child': { two: 22 } }
  }}));
  const orderKey = createHash('sha256').update(libraryKey).digest('hex');
  await fs.writeFile(path.join(root, 'user-data', 'state', 'manual-order.json'), JSON.stringify({ version: 1, libraries: {
    [orderKey]: {
      '["folder:source","items"]': { ids: ['one'], revision: 3 },
      '["folder:source-child","items"]': { ids: ['two'], revision: 4 },
      '["folder:source","folders"]': { ids: ['source-child'], revision: 5 }
    }
  }}));
  await fs.writeFile(path.join(root, 'user-data', 'state', 'folder-covers.json'), JSON.stringify({ version: 1, libraries: {
    [libraryKey]: { revision: 1, covers: { 'source-child': { itemId: 'two', revision: 1 } } }
  }}));
  const coverMarkup = (id, name) => `<img class="sub-folder-cover" src="file:///fixture/images/${id}.info/${name}_thumbnail.png" style="aspect-ratio: 1;">`;
  const folders = [{
    id: 'source', name: 'Source', description: 'source description', orderBy: 'MANUAL', sortIncrease: true,
    coverId: 'one', iconColor: 'blue', tags: ['folder-tag'],
    // The source's cached cover is the newest image of the folder, exactly what
    // Eagle derived the last time it rebuilt its image bindings.
    children: [{ id: 'source-child', name: 'Child', description: 'child description', iconColor: 'blue',
      covers: [coverMarkup('two', 'two.txt')], children: [] }]
  }, { id: 'same-name-sibling', name: 'Source', children: [] }];
  const folderMappings = { source: folders[0], 'source-child': folders[0].children[0] };
  // Native Eagle keeps pin/order on the item, keyed by folder id. "one" also
  // carries order for a folder outside the copied subtree, which must not leak.
  const itemMappings = {
    one: { id: 'one', name: 'one', ext: 'txt', folders: ['source'], tags: ['copied-tag'], url: 'https://example.test/item',
      annotation: 'copied-note', modificationTime: 1700000000000, order: { source: '100', 'other-folder': '7' }, pinned: { source: 5 } },
    two: { id: 'two', name: 'two', ext: 'txt', folders: ['source-child'], tags: [], url: '', annotation: '', modificationTime: 1700000001000 },
    three: { id: 'three', name: 'three', ext: 'txt', folders: ['source-child'], tags: [], url: '', annotation: '', modificationTime: 1700000000500 }
  };
  // Eagle's visible list, duplicate map and duplicate check in one renderer scope.
  const scope = {
    libraryPath,
    raw: [],
    // Eagle serves its item API from the same mapping the renderer mutates.
    itemMappings,
    duplicateMappings: { 'one.txt': itemMappings.one, 'two.txt': itemMappings.two },
    isDuplicateImage(image) { return this.duplicateMappings[image?.name] || false; },
    addToDuplicateMapping(image) { this.duplicateMappings[image?.name] = image; },
    calculateImageBinding() {}, rebindRefresh() {}, $evalAsync() {}
  };
  const originalIsDuplicateImage = scope.isDuplicateImage;
  const queued = [];
  const imports = [];
  main.hub.library = { path: libraryPath, folders };
  main.client.libraryInfo = async () => main.hub.library;
  main.client.folderTree = async () => folders;
  main.client.queryItems = async ({ folderId }) => folderId === 'source'
    ? { data: [{ id: 'one' }], total: 1 }
    : { data: [{ id: 'two' }, { id: 'three' }], total: 2 };
  main.client.getItem = async id => itemMappings[id];
  main.client.getItems = async ids => ids
    .filter(id => scope.raw.some(item => item.id === id))
    .map(id => scope.itemMappings[id])
    .filter(Boolean);
  const fileIndexByItemId = { one: 0, two: 1, three: 2 };
  main.client.fileURLForItem = async item => pathToFileURL(files[fileIndexByItemId[item.id] ?? 0]).toString();
  const updateCounts = {};
  main.client.updateItem = async (id, patch) => {
    updateCounts[id] = (updateCounts[id] || 0) + 1;
    Object.assign(itemMappings[id], patch);
    // Eagle's own import pipeline can still write the item once more with its
    // import-time values; the copy has to notice and repair that.
    if (id === 'copy-1' && updateCounts[id] === 1) itemMappings[id].url = '';
    return itemMappings[id];
  };
  main.client.updateFolderProperties = async (id, patch) => Object.assign(folderMappings[id], patch);
  let folderCount = 0;
  const folderCreates = [], folderMoves = [];
  main.client.createFolder = async (name, parent, options) => {
    const id = folderCount++ ? 'copy-child' : 'copy-folder';
    folderCreates.push({ name, parent, options });
    const folder = { id, name, ...options, children: [] };
    folderMappings[id] = folder;
    if (parent) folders.find(entry => entry.id === parent).children.push(folder); else folders.push(folder);
    return { id };
  };
  main.client.moveFolder = async (id, patch) => { folderMoves.push({ id, patch }); return { id, ...patch }; };
  const copyIdByFile = { 'one.txt': 'copy-1', 'two.txt': 'copy-2', 'three.txt': 'copy-3' };
  main.client.addItems = async (paths, folderId) => paths.map(file => {
    const id = copyIdByFile[path.basename(file)];
    imports.push({ id, folderId });
    // A fresh import carries the import time and lands at the head of Eagle's
    // visible list, which is what made the copies' covers disagree.
    const item = { id, name: path.basename(file), ext: 'txt', folders: [folderId], tags: [], url: '', annotation: '', modificationTime: Date.now() };
    scope.itemMappings[id] = item;
    if (heldBackIds.includes(id) || scope.isDuplicateImage(item)) queued.push(item);
    else { scope.raw.unshift(item); scope.addToDuplicateMapping(item); }
    return id;
  });
  const rendererContext = () => ({
    $bodyScope: scope,
    document: { querySelector: () => null },
    angular: { element: () => ({ isolateScope: () => null }) },
    setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  });
  const walkFolders = (nodes = folders, list = []) => {
    for (const node of nodes) { list.push(node); walkFolders(node.children || [], list); }
    return list;
  };
  // Eagle's own binding pass: a folder's cached cover markup comes from its
  // coverId or from the first image of that folder in Eagle's raw order, and a
  // folder with neither keeps whatever cache it already had.
  const eagleBinding = (params = {}, callback) => {
    if (!params.ignoreSort) scope.raw.sort((a, b) => (b.modificationTime || 0) - (a.modificationTime || 0));
    const defaults = {};
    for (const item of scope.raw) {
      for (const folderId of item.folders || []) if (!defaults[folderId]) defaults[folderId] = item.id;
    }
    for (const folder of walkFolders()) {
      if (!folder.covers) folder.covers = [];
      const coverId = folder.coverId || defaults[folder.id];
      if (coverId && itemMappings[coverId]) folder.covers[0] = coverMarkup(coverId, itemMappings[coverId].name);
    }
    if (callback) callback();
  };
  const clearFolderCover = folder => {
    folder.covers = [];
    for (const node of walkFolders()) if ((node.children || []).includes(folder)) clearFolderCover(node);
  };
  const eagleScope = () => ({
    libraryPath, folders, folderMappings, itemMappings,
    saveFolder() {}, updateSidebarList() {},
    calculateImageBinding: eagleBinding, resetFolderCover: clearFolderCover
  });
  main.client.request = async (url, { body }) => {
    assert.equal(url, '/api/script/inject');
    const script = body.script;
    if (script.includes('__eaglemvCopyKeeper') || script.includes('__eaglemvCopyImportMode')) {
      vm.runInNewContext(script, rendererContext());
      return true;
    }
    if (script.includes('addToDuplicateMapping')) {
      // Direct restore of an item Eagle accepted but never made visible.
      return Boolean(vm.runInNewContext(script, rendererContext()));
    }
    if (script.includes('duplicate-modal')) {
      // The batch window never reaches the dialog in this fixture; its timers
      // drain immediately and leave the item pending.
      const timers = [];
      vm.runInNewContext(script, {
        $bodyScope: scope, document: { querySelector: () => null },
        angular: { element: () => ({ isolateScope: () => null }) }, setTimeout: fn => timers.push(fn)
      });
      while (timers.length) timers.shift()();
      return true;
    }
    // Run the real projection script against a script-scope model of Eagle.
    const result = vm.runInNewContext(script, { $bodyScope: eagleScope() });
    assert.equal(result, true, 'native clone script must apply');
    return true;
  };
  main.hub.connect = async () => {};
  const copy = () => main.copyFolderTree({ sourceId: 'source', libraryPath, decisionTimeoutMs: 250, itemWaitMs: 250 });
  return { root, libraryPath, libraryKey, orderKey, main, folders, folderMappings, itemMappings, scope, queued, imports, folderCreates, folderMoves, updateCounts, originalIsDuplicateImage, copy };
}

test('copying a folder tree clones hierarchy, native order, pins, cover and metadata', async t => {
  const fixture = await setupFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { main, itemMappings, folderMappings, scope, queued, imports, folderCreates, folderMoves, updateCounts, libraryKey, orderKey, root } = fixture;
  const result = await fixture.copy();
  assert.equal(result.copiedItems, 3);
  // Imports aimed at the copied folders never enter Eagle's duplicate queue, so
  // the copy does not depend on when Eagle gets around to asking about them.
  assert.deepEqual(queued, []);
  assert.deepEqual(scope.raw.map(item => item.id).sort(), ['copy-1', 'copy-2', 'copy-3']);
  assert.equal(scope.isDuplicateImage, fixture.originalIsDuplicateImage, 'the import patch must be reverted');
  assert.equal(scope.__eaglemvCopyImportMode, undefined);
  assert.equal(scope.__eaglemvCopyKeeper.timer, null, 'the resident keeper must be stopped after the copy');
  assert.deepEqual(imports.map(entry => entry.folderId), ['copy-folder', 'copy-child', 'copy-child']);
  // Eagle permits same-named siblings, so the copy keeps the source name
  // instead of being de-duplicated into "Source (1)".
  assert.equal(folderCreates[0].name, 'Source');
  assert.equal(folderCreates[1].name, 'Child');
  assert.equal(folderCreates[0].options.description, 'source description');
  assert.equal(folderCreates[1].options.description, 'child description');
  assert.deepEqual(folderMoves.map(entry => entry.id), ['copy-folder', 'copy-child']);
  assert.equal(folderMoves[1].patch.parent, 'copy-folder');
  assert.equal(folderMoves[1].patch.iconColor, 'blue');
  // Folder-level Eagle state: sort mode, cover and tags follow the source.
  const copiedRoot = folderMappings['copy-folder'];
  assert.equal(copiedRoot.orderBy, 'MANUAL');
  assert.equal(copiedRoot.sortIncrease, true);
  assert.equal(copiedRoot.coverId, 'copy-1');
  assert.equal(copiedRoot.iconColor, 'blue');
  assert.deepEqual(plain(copiedRoot.tags), ['folder-tag']);
  assert.equal(folderMappings['copy-child'].orderBy, undefined);
  // Eagle's cached cover markup has to follow the source onto the copies: the
  // child folder shows its newest image, not the image the import landed last.
  assert.equal(folderCoverItemId(folderMappings['source-child']), 'two');
  assert.equal(folderCoverItemId(folderMappings['copy-child']), 'copy-2');
  assert.equal(folderCoverItemId(copiedRoot), 'copy-1');
  assert.match(folderMappings['copy-child'].covers[0], /\/images\/copy-2\.info\//);
  assert.equal(folderMappings['copy-child'].coverId, undefined);
  // Item-level Eagle state is re-keyed onto the copied folders.
  assert.deepEqual(plain(itemMappings['copy-1'].order), { 'copy-folder': '100' });
  assert.deepEqual(plain(itemMappings['copy-1'].pinned), { 'copy-folder': 5 });
  assert.equal('order' in itemMappings['copy-2'], false);
  assert.equal('pinned' in itemMappings['copy-2'], false);
  // Metadata survives Eagle's late write, including the sort-relevant time.
  assert.equal(itemMappings['copy-1'].url, 'https://example.test/item');
  assert.equal(itemMappings['copy-1'].annotation, 'copied-note');
  assert.equal(itemMappings['copy-1'].modificationTime, 1700000000000);
  assert.deepEqual(plain(itemMappings['copy-1'].tags), ['copied-tag']);
  assert.equal(updateCounts['copy-1'], 2, 'a clobbered copy must be repaired');
  assert.equal(updateCounts['copy-2'], 1);
  assert.equal(updateCounts['copy-3'], 1);
  const pins = JSON.parse(await fs.readFile(path.join(root, 'user-data', 'state', 'pins.json'))).libraries[libraryKey];
  assert.deepEqual(pins['copy-folder'], { 'copy-1': 11 });
  assert.deepEqual(pins['copy-child'], { 'copy-2': 22 });
  const orders = JSON.parse(await fs.readFile(path.join(root, 'user-data', 'state', 'manual-order.json'))).libraries[orderKey];
  assert.deepEqual(orders['["folder:copy-folder","items"]'].ids, ['copy-1']);
  assert.deepEqual(orders['["folder:copy-child","items"]'].ids, ['copy-2']);
  assert.deepEqual(orders['["folder:copy-folder","folders"]'].ids, ['copy-child']);
  const covers = JSON.parse(await fs.readFile(path.join(root, 'user-data', 'state', 'folder-covers.json'))).libraries[libraryKey];
  assert.equal(covers.covers['copy-child'].itemId, 'copy-2');
});

test('a copy whose duplicate decision never lands is restored instead of failing', async t => {
  // Eagle ignores the import patch for one item and holds it back with no dialog.
  const fixture = await setupFixture({ heldBackIds: ['copy-2'] });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = await fixture.copy();
  assert.equal(result.copiedItems, 3);
  assert.equal(fixture.queued.length, 1);
  assert.deepEqual(fixture.scope.raw.map(item => item.id).sort(), ['copy-1', 'copy-2', 'copy-3']);
  assert.equal(fixture.updateCounts['copy-2'], 1);
  assert.equal(fixture.scope.__eaglemvCopyImportMode, undefined);
  const orders = JSON.parse(await fs.readFile(path.join(fixture.root, 'user-data', 'state', 'manual-order.json'))).libraries[fixture.orderKey];
  assert.deepEqual(orders['["folder:copy-child","items"]'].ids, ['copy-2']);
});
