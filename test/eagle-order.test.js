'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nativeValue, folderOrder, dragSortable, comparator, insertionValues, blockNeighbours } = require('../src/eagle-order');

const sortIds = (items, order, folderId = 'F') => [...items].sort(comparator(order, folderId)).map(item => item.id);

test('a folder follows its own Eagle sort, reversed unless sortIncrease is true (P1-02)', () => {
  assert.equal(folderOrder({ id: 'F' }, 'default'), null, 'no folder sort keeps the API order');
  assert.deepEqual(folderOrder({ orderBy: 'NAME', sortIncrease: true }, 'default'), { orderBy: 'NAME', increase: true });
  assert.deepEqual(folderOrder({ orderBy: 'NAME' }, 'default'), { orderBy: 'NAME', increase: false });
  assert.equal(folderOrder({ orderBy: 'NAME', sortIncrease: true }, 'name'), null);
  assert.deepEqual(folderOrder({ orderBy: 'NAME', sortIncrease: true }, 'manual'), { orderBy: 'MANUAL', increase: true });
  assert.deepEqual(folderOrder({ orderBy: 'MANUAL', sortIncrease: false }, 'manual'), { orderBy: 'MANUAL', increase: false });
  const items = [{ id: 'a', name: '图10', modificationTime: 3 }, { id: 'b', name: '图2', modificationTime: 2 }, { id: 'c', name: '图1', modificationTime: 1 }];
  assert.deepEqual(sortIds(items, { orderBy: 'NAME', increase: true }), ['c', 'b', 'a']);
  assert.deepEqual(sortIds(items, { orderBy: 'NAME', increase: false }), ['a', 'b', 'c']);
  assert.deepEqual(sortIds(items, { orderBy: 'IMPORT', increase: true }), ['a', 'b', 'c'], 'add time, newest first');
});

test('manual order compares order[folder] as strings, largest first, falling back to the add time', () => {
  const items = [
    { id: 'old', modificationTime: 1791536164000 },
    { id: 'placed', modificationTime: 1, order: { F: '1791536164500.5', Other: '9' } },
    { id: 'new', modificationTime: 1791536164900 }
  ];
  assert.equal(nativeValue(items[0], 'F'), '1791536164000');
  assert.equal(nativeValue(items[1], 'F'), '1791536164500.5');
  assert.deepEqual(sortIds(items, { orderBy: 'MANUAL', increase: true }), ['new', 'placed', 'old']);
  assert.deepEqual(sortIds(items, { orderBy: 'MANUAL', increase: false }), ['old', 'placed', 'new']);
  assert.equal(comparator({ orderBy: 'RANDOM', increase: true }, 'F'), null);
});

test('dragging is offered where Eagle offers it: manual or add-time order only', () => {
  assert.equal(dragSortable({}, 'default'), true);
  assert.equal(dragSortable({ orderBy: 'MANUAL', sortIncrease: false }, 'default'), true);
  assert.equal(dragSortable({ orderBy: 'IMPORT', sortIncrease: true }, 'default'), true);
  assert.equal(dragSortable({ orderBy: 'NAME', sortIncrease: true }, 'default'), false);
  assert.equal(dragSortable({ orderBy: 'NAME', sortIncrease: true }, 'manual'), true);
  assert.equal(dragSortable({}, 'name'), false);
  assert.equal(dragSortable(null, 'default'), false);
});

test('only the moved block gets values, between its neighbours like onDropBoxItem (E-11)', () => {
  assert.deepEqual(insertionValues({ above: '1000', below: '990', count: 1 }), ['995']);
  assert.deepEqual(insertionValues({ above: '1000', below: '990', count: 2 }), ['997.5', '995']);
  assert.deepEqual(insertionValues({ above: null, below: '1000', count: 1 }), ['1000.5'], 'to the top');
  assert.deepEqual(insertionValues({ above: '1000', below: null, count: 1 }), ['999.5'], 'to the bottom');
  assert.deepEqual(insertionValues({ above: '990', below: '1000', count: 1, increase: false }), ['995'], 'reversed folder');
  assert.deepEqual(insertionValues({ above: null, below: '990', count: 1, increase: false }), ['989.5']);
  const tight = insertionValues({ above: '1791536164346.5', below: '1791536164346', count: 3 });
  const sorted = ['1791536164346.5', ...tight, '1791536164346'];
  assert.deepEqual([...sorted].sort().reverse(), sorted, 'string order (how Eagle compares) keeps the block in place');
  assert.throws(() => insertionValues({ above: '5', below: '5', count: 1 }), /顺序值相同/);
  assert.throws(() => insertionValues({ above: '1e5', below: '5', count: 1 }), /格式异常/);
});

test('block neighbours come from the order after the move', () => {
  assert.deepEqual(blockNeighbours(['a', 'b', 'c', 'd'], ['d', 'b'], 'a', 'after'), { block: ['b', 'd'], aboveId: 'a', belowId: 'c' });
  assert.deepEqual(blockNeighbours(['a', 'b', 'c'], ['c'], 'a', 'before'), { block: ['c'], aboveId: null, belowId: 'a' });
  assert.deepEqual(blockNeighbours(['a', 'b', 'c'], ['a'], 'c', 'after'), { block: ['a'], aboveId: 'c', belowId: null });
  assert.throws(() => blockNeighbours(['a', 'b'], ['a'], 'a', 'after'), /排序目标已失效/);
  assert.throws(() => blockNeighbours(['a', 'b'], ['x'], 'a', 'after'), /排序目标已失效/);
});

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { loadMain } = require('../test-support/main-data-harness.cjs');

test('eagle-order:move writes only the moved items and switches the folder to manual order', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-eagle-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = loadMain(root), libraryPath = '/fixture.library';
  const folder = { id: 'F', children: [], covers: [] };
  const items = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, index) => [id, { id, folders: ['F'], modificationTime: 4000 - index * 1000 }]));
  items.c.order = { Other: '7' };
  const scope = { libraryPath, folderMappings: { F: folder }, itemMappings: items, saveFolder() {}, calculateImageBinding() {} };
  const updates = [], published = [];
  main.hub.ensureLibraryPath = async value => assert.equal(value, libraryPath);
  main.hub.connect = async () => {};
  main.hub.publishItemMutation = item => published.push(item.id);
  main.client.getItems = async ids => ids.map(id => structuredClone(items[id]));
  main.client.updateItem = async (id, patch) => { updates.push([id, patch]); return items[id]; };
  main.client.request = async (endpoint, options) => {
    assert.equal(endpoint, '/api/script/inject');
    vm.runInNewContext(options.body.script, { $bodyScope: scope });
  };
  const move = main.rpcRegistry.get('eagle-order:move');
  // d goes between a (4000) and b (3000); c and the rest keep their values.
  const result = await move({ sender: { id: 1 } }, { libraryPath, folderId: 'F', ids: ['d'], anchorId: 'a', position: 'after', displayedIds: ['a', 'b', 'c', 'd'] });
  assert.equal(result.ok, true);
  assert.equal(items.d.order.F, '3500');
  assert.equal(items.a.order, undefined);
  assert.equal(items.b.order, undefined);
  assert.deepEqual(items.c.order, { Other: '7' });
  assert.deepEqual(updates.map(([id]) => id), ['d'], 'only the moved item is persisted');
  assert.deepEqual(published, ['d']);
  assert.equal(folder.orderBy, 'MANUAL');
  assert.equal(folder.sortIncrease, true);
  // A reversed manual folder stays reversed.
  folder.sortIncrease = false;
  await move({ sender: { id: 1 } }, { libraryPath, folderId: 'F', ids: ['a'], anchorId: 'b', position: 'before', displayedIds: ['c', 'b', 'd', 'a'], increase: false });
  assert.equal(items.a.order.F, '2500');
  assert.equal(folder.sortIncrease, false);
  // An item that left the folder meanwhile stops the move before any write.
  items.b.folders = [];
  updates.length = 0;
  await assert.rejects(move({ sender: { id: 1 } }, { libraryPath, folderId: 'F', ids: ['c'], anchorId: 'b', position: 'before', displayedIds: ['d', 'b', 'c'] }), /排序素材已变化/);
  assert.equal(updates.length, 0);
});

test('folder views sort by the folder Eagle order and reorder only through eagle-order:move', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const compareStart = source.indexOf('function compareItemsForView(');
  const compare = source.slice(compareStart, source.indexOf('\n}\n', compareStart));
  assert.ok(compare.includes('eagleFolderComparator(state.currentView, state.sort)'));
  assert.ok(compare.indexOf('if (folderCompare)') < compare.indexOf("state.sort === 'manual'"));
  assert.ok(source.includes('const sortBackfillActive = viewHasClientOrder() && state.hasMore;'));
  assert.ok(source.includes("if (source.kind==='items' && source.scope.startsWith('folder:')) return submitEagleItemOrder(source,target,position);"));
  assert.ok(source.includes('window.EagleMVEagleOrder.dragSortable(libraryFolder(view.id), pane.sort)'));
  const html = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  assert.ok(html.indexOf('eagle-order.js') < html.indexOf('renderer.js'));
  const preload = require('node:fs').readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const shim = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'web-shim.js'), 'utf8');
  assert.ok(preload.includes("moveEagleOrder: data => ipcRenderer.invoke('eagle-order:move', data)"));
  assert.ok(shim.includes("moveEagleOrder: data => invoke('eagle-order:move', [data])"));
});
