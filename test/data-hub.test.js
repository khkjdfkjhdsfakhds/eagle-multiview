'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataHub } = require('../lib/data-hub');

class FakeClient {
  constructor(item) { this.item = structuredClone(item); }
  async getItem() { return structuredClone(this.item); }
  async updateItem(_id, patch) {
    await new Promise(resolve => setTimeout(resolve, 5));
    this.item = { ...this.item, ...structuredClone(patch), modificationTime: this.item.modificationTime + 1 };
    return structuredClone(this.item);
  }
}

test('serializes writes and merges edits to different fields', async () => {
  const base = { id: 'A', name: '原名', annotation: '', tags: ['a'], folders: [], modificationTime: 1 };
  const client = new FakeClient(base);
  const hub = new DataHub(client);
  const first = hub.mutate({ id: 'A', patch: { name: '窗口一' }, base });
  const second = hub.mutate({ id: 'A', patch: { annotation: '窗口二备注' }, base });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(client.item.name, '窗口一');
  assert.equal(client.item.annotation, '窗口二备注');
});

test('stops a same-field overwrite and returns conflict details', async () => {
  const base = { id: 'A', name: '原名', tags: [], folders: [], modificationTime: 1 };
  const client = new FakeClient({ ...base, name: 'Eagle 中的新名字', modificationTime: 2 });
  const hub = new DataHub(client);
  const result = await hub.mutate({ id: 'A', patch: { name: '伴侣窗口的新名字' }, base });
  assert.equal(result.conflict, true);
  assert.equal(result.conflicts[0].field, 'name');
  assert.equal(client.item.name, 'Eagle 中的新名字');
});

test('intent-based tag update preserves concurrently added tags', async () => {
  const client = new FakeClient({ id: 'A', tags: ['原标签', '外部新增'], folders: [], modificationTime: 3 });
  const hub = new DataHub(client);
  await hub.mutateSet({ id: 'A', field: 'tags', add: ['伴侣新增'], remove: ['原标签'] });
  assert.deepEqual(client.item.tags.sort(), ['伴侣新增', '外部新增']);
});

test('a successful edit is broadcast immediately to every window listener', async () => {
  const base = { id: 'A', name: '原名', tags: [], folders: [], modificationTime: 1 };
  const hub = new DataHub(new FakeClient(base));
  const changes = [];
  const invalidations = [];
  hub.on('items-changed', payload => changes.push(payload));
  hub.on('query-invalidated', payload => invalidations.push(payload));
  await hub.mutate({ id: 'A', patch: { name: '新名字' }, base, origin: 42 });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].items[0].name, '新名字');
  assert.equal(changes[0].origin, 42);
  assert.equal(invalidations.length, 1);
});

test('tracks visible items from more than one window', () => {
  const hub = new DataHub(new FakeClient({ id: 'A' }));
  hub.setWatchedIds(1, ['A', 'B']);
  hub.setWatchedIds(2, ['C']);
  assert.deepEqual([...new Set([...hub.watchers.values()].flatMap(set => [...set]))].sort(), ['A', 'B', 'C']);
  hub.removeWatcher(1);
  assert.deepEqual([...hub.watchers.get(2)], ['C']);
});

test('polling retains the folder tree when the library metadata is unchanged', async () => {
  const client = new FakeClient({ id: 'A' });
  client.libraryInfo = async () => ({ path: '/library', modificationTime: 10 });
  client.folderTree = async () => { throw new Error('folder tree should not be reloaded'); };
  const hub = new DataHub(client);
  hub.connected = true;
  hub.lastModificationTime = 10;
  hub.library = { path: '/library', modificationTime: 10, folders: [{ id: 'folder-a' }] };
  await hub.poll();
  assert.deepEqual(hub.library.folders, [{ id: 'folder-a' }]);
});

test('a library switch clears item and window watcher caches before broadcasting the new tree', async () => {
  const client = new FakeClient({ id: 'A' });
  client.libraryInfo = async () => ({ path: '/new-library', modificationTime: 20 });
  client.folderTree = async () => [{ id: 'new-folder' }];
  const hub = new DataHub(client);
  hub.connected = true;
  hub.lastModificationTime = 10;
  hub.library = { path: '/old-library', modificationTime: 10, folders: [{ id: 'old-folder' }] };
  hub.itemCache.set('A', { id: 'A', name: 'old cached item' });
  hub.setWatchedIds(7, ['A']);
  const changes = [];
  hub.on('library-changed', payload => changes.push(payload));

  await hub.poll();

  assert.equal(hub.itemCache.size, 0);
  assert.equal(hub.watchers.size, 0);
  assert.deepEqual(hub.library.folders, [{ id: 'new-folder' }]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].libraryChanged, true);
});

test('a queued mutation is cancelled if Eagle changed libraries', async () => {
  const client = new FakeClient({ id: 'A', name: 'unchanged', modificationTime: 1 });
  client.libraryInfo = async () => ({ path: '/new-library', modificationTime: 20 });
  let updateCalls = 0;
  client.updateItem = async () => { updateCalls += 1; throw new Error('must not write'); };
  const hub = new DataHub(client);
  hub.library = { path: '/old-library' };

  await assert.rejects(
    hub.mutate({
      id: 'A',
      patch: { name: 'should not be written' },
      base: client.item,
      libraryPath: '/old-library'
    }),
    error => error.code === 'LIBRARY_CHANGED'
  );
  assert.equal(updateCalls, 0);
});

test('connect broadcasts a library switch so already-open windows cannot remain on the old library', async () => {
  const client = new FakeClient({ id: 'A' });
  client.appInfo = async () => ({ version: '4.0' });
  client.libraryInfo = async () => ({ path: '/new-library', modificationTime: 30 });
  client.folderTree = async () => [{ id: 'new-folder' }];
  const hub = new DataHub(client);
  hub.library = { path: '/old-library', folders: [{ id: 'old-folder' }] };
  hub.itemCache.set('A', { id: 'A' });
  hub.setWatchedIds(9, ['A']);
  const changes = [];
  hub.on('library-changed', payload => changes.push(payload));

  await hub.connect();

  assert.equal(changes.length, 1);
  assert.equal(changes[0].library.path, '/new-library');
  assert.equal(hub.itemCache.size, 0);
  assert.equal(hub.watchers.size, 0);
});
