'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataHub } = require('../lib/data-hub');

class FakeClient {
  constructor(item) {
    this.item = structuredClone(item);
    this.folders = [];
    this.libraryPath = '/library';
    this.libraryModificationTime = 1;
    this.updateFolderCalls = 0;
  }
  async getItem() { return structuredClone(this.item); }
  async updateItem(_id, patch) {
    await new Promise(resolve => setTimeout(resolve, 5));
    this.item = { ...this.item, ...structuredClone(patch), modificationTime: this.item.modificationTime + 1 };
    return structuredClone(this.item);
  }
  async libraryInfo() { return { path: this.libraryPath, modificationTime: this.libraryModificationTime }; }
  async folderTree() { return structuredClone(this.folders); }
  async updateFolder(id, patch) {
    this.updateFolderCalls += 1;
    const visit = nodes => {
      for (const folder of nodes) {
        if (folder.id === id) return Object.assign(folder, structuredClone(patch));
        const child = visit(folder.children || []);
        if (child) return child;
      }
      return null;
    };
    const updated = visit(this.folders);
    this.libraryModificationTime += 1;
    return structuredClone(updated);
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

test('renames a folder through Eagle and broadcasts the refreshed folder tree', async () => {
  const client = new FakeClient({ id: 'A' });
  client.folders = [{ id: 'F', name: '原文件夹', children: [] }];
  const hub = new DataHub(client);
  hub.library = { path: '/library', folders: structuredClone(client.folders) };
  const changes = [];
  hub.on('library-changed', payload => changes.push(payload));

  const result = await hub.mutateFolder({
    id: 'F',
    name: '新文件夹',
    baseName: '原文件夹',
    libraryPath: '/library',
    origin: 42
  });

  assert.equal(result.ok, true);
  assert.equal(result.folder.name, '新文件夹');
  assert.equal(client.updateFolderCalls, 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].library.folders[0].name, '新文件夹');
  assert.equal(changes[0].origin, 42);
});

test('keeps a renamed folder in the published snapshot when Eagle briefly returns an incomplete tree', async () => {
  const client = new FakeClient({ id: 'A' });
  client.folders = [{ id: 'F', name: '原文件夹', children: [] }];
  const originalFolderTree = client.folderTree.bind(client);
  let folderTreeCalls = 0;
  client.folderTree = async () => {
    folderTreeCalls += 1;
    if (folderTreeCalls === 2) return [];
    return originalFolderTree();
  };
  const hub = new DataHub(client);
  hub.library = { path: '/library', folders: structuredClone(client.folders) };
  const changes = [];
  hub.on('library-changed', payload => changes.push(payload));

  const result = await hub.mutateFolder({
    id: 'F',
    name: '新文件夹',
    baseName: '原文件夹',
    libraryPath: '/library'
  });

  assert.equal(result.ok, true);
  assert.equal(result.folder.name, '新文件夹');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].library.folders[0].id, 'F');
  assert.equal(changes[0].library.folders[0].name, '新文件夹');
});

test('a poll that started before a folder rename cannot overwrite the newer snapshot', async () => {
  const client = new FakeClient({ id: 'A' });
  client.folders = [{ id: 'F', name: '原文件夹', children: [] }];
  let libraryInfoCalls = 0;
  let releasePoll;
  let pollStarted;
  const pollStartedPromise = new Promise(resolve => { pollStarted = resolve; });
  const originalLibraryInfo = client.libraryInfo.bind(client);
  client.libraryInfo = async () => {
    libraryInfoCalls += 1;
    if (libraryInfoCalls === 1) {
      pollStarted();
      return new Promise(resolve => { releasePoll = resolve; });
    }
    if (libraryInfoCalls === 2) return originalLibraryInfo();
    return originalLibraryInfo();
  };
  const hub = new DataHub(client);
  hub.library = { path: '/library', modificationTime: 1, folders: structuredClone(client.folders) };
  hub.lastModificationTime = 1;
  hub.connected = true;
  const changes = [];
  hub.on('library-changed', payload => changes.push(payload));

  const pollPromise = hub.poll();
  await pollStartedPromise;
  const rename = await hub.mutateFolder({
    id: 'F',
    name: '新文件夹',
    baseName: '原文件夹',
    libraryPath: '/library'
  });
  assert.equal(rename.ok, true);
  assert.equal(hub.library.folders[0].name, '新文件夹');

  releasePoll({ path: '/library', modificationTime: 1 });
  await pollPromise;

  assert.equal(changes.length, 1);
  assert.equal(changes[0].library.folders[0].name, '新文件夹');
  assert.equal(changes[0].revision, 1);
  assert.equal(hub.lastModificationTime, 2);
});

test('stops a stale folder rename and broadcasts the name currently in Eagle', async () => {
  const client = new FakeClient({ id: 'A' });
  client.folders = [{ id: 'F', name: 'Eagle 中的新名称', children: [] }];
  const hub = new DataHub(client);
  hub.library = { path: '/library', folders: [{ id: 'F', name: '旧名称', children: [] }] };
  const changes = [];
  hub.on('library-changed', payload => changes.push(payload));

  const result = await hub.mutateFolder({
    id: 'F',
    name: 'MultiView 的名称',
    baseName: '旧名称',
    libraryPath: '/library'
  });

  assert.equal(result.conflict, true);
  assert.equal(result.current.name, 'Eagle 中的新名称');
  assert.equal(client.updateFolderCalls, 0);
  assert.equal(changes[0].library.folders[0].name, 'Eagle 中的新名称');
});

test('tracks visible items from more than one window', () => {
  const hub = new DataHub(new FakeClient({ id: 'A' }));
  hub.setWatchedIds(1, ['A', 'B']);
  hub.setWatchedIds(2, ['C']);
  assert.deepEqual([...new Set([...hub.watchers.values()].flatMap(set => [...set]))].sort(), ['A', 'B', 'C']);
  hub.removeWatcher(1);
  assert.deepEqual([...hub.watchers.get(2)], ['C']);
});

test('visible-item polling keeps successful chunks when one chunk fails', async () => {
  let active = 0;
  let maximum = 0;
  const client = {
    async request(_path, { body }) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 4));
      active -= 1;
      if (body.ids.includes('bad')) throw new Error('one chunk failed');
      return { data: body.ids.map(id => ({ id, modificationTime: 1 })) };
    }
  };
  const hub = new DataHub(client);
  const ids = Array.from({ length: 205 }, (_, index) => index === 100 ? 'bad' : `item-${index}`);
  hub.setWatchedIds('window-1', ids);
  await hub.refreshWatchedItems();
  assert.ok(maximum > 1);
  assert.ok(maximum <= 3);
  assert.equal(hub.itemCache.has('item-0'), true);
  assert.equal(hub.itemCache.has('item-204'), true);
  assert.equal(hub.itemCache.has('bad'), false);
});

test('folder-tree refresh failure keeps the app connected with the previous tree', async () => {
  const oldFolders = [{ id: 'old', name: 'Old' }];
  const client = {
    libraryInfo: async () => ({ path: '/library', modificationTime: 2 }),
    folderTree: async () => { throw new Error('temporary folder failure'); }
  };
  const hub = new DataHub(client);
  hub.library = { path: '/library', modificationTime: 1, folders: oldFolders };
  hub.lastModificationTime = 1;
  hub.connected = true;
  await hub.poll();
  assert.equal(hub.connected, true);
  assert.deepEqual(hub.library.folders, oldFolders);
  assert.equal(hub.lastModificationTime, 2);
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

test('supplemental API-created items remain visible when Eagle query omits byte-identical duplicates', async () => {
  class QueryClient {
    static matchesSearchConstraints(item, query) {
      return !query.folderId || (item.folders || []).includes(query.folderId);
    }
    async queryItems(query) {
      const data = [{ id: 'indexed', name: 'Indexed', folders: ['F'], modificationTime: 1 }];
      const offset = Number(query.offset) || 0;
      const limit = Number(query.limit) || 160;
      return { data: data.slice(offset, offset + limit), total: data.length, nextOffset: offset + data.length, hasMore: false };
    }
  }
  const hub = new DataHub(new QueryClient());
  hub.library = { path: '/library' };
  hub.setSupplementalItems('/library', [{ id: 'duplicate', name: 'Duplicate', folders: ['F'], modificationTime: 2 }]);

  const first = await hub.query({ folderId: 'F', offset: 0, limit: 1 });
  const second = await hub.query({ folderId: 'F', offset: 1, limit: 1 });
  assert.deepEqual(first.data.map(item => item.id), ['duplicate']);
  assert.deepEqual(second.data.map(item => item.id), ['indexed']);
  assert.equal(first.total, 2);
  assert.equal(second.total, 2);
});

test('supplemental items are pruned after Eagle begins returning them normally', async () => {
  class QueryClient {
    static matchesSearchConstraints() { return true; }
    async queryItems() {
      return { data: [{ id: 'duplicate', name: 'Duplicate', folders: ['F'] }], total: 1, nextOffset: 1, hasMore: false };
    }
  }
  const hub = new DataHub(new QueryClient());
  hub.library = { path: '/library' };
  hub.setSupplementalItems('/library', [{ id: 'duplicate', name: 'Duplicate', folders: ['F'] }]);
  const indexed = [];
  hub.on('supplemental-indexed', payload => indexed.push(payload));

  const page = await hub.query({ folderId: 'F', offset: 0, limit: 10 });
  assert.deepEqual(page.data.map(item => item.id), ['duplicate']);
  assert.equal(page.total, 1);
  assert.equal(hub.supplementalItems.size, 0);
  assert.deepEqual(indexed[0].ids, ['duplicate']);
});

test('renaming a nested parent folder retains its children hierarchy and updates in-place', async () => {
  const client = new FakeClient({ id: 'A' });
  client.folders = [{
    id: 'parent-1',
    name: '原父文件夹',
    children: [
      { id: 'child-1', name: '子文件夹 1', children: [] },
      { id: 'child-2', name: '子文件夹 2', children: [{ id: 'grandchild-1', name: '孙文件夹', children: [] }] }
    ]
  }];
  const hub = new DataHub(client);
  hub.library = { path: '/library', folders: structuredClone(client.folders) };
  const changes = [];
  hub.on('library-changed', payload => changes.push(payload));

  const result = await hub.mutateFolder({
    id: 'parent-1',
    name: '新父文件夹',
    baseName: '原父文件夹',
    libraryPath: '/library'
  });

  assert.equal(result.ok, true);
  assert.equal(result.folder.name, '新父文件夹');
  assert.equal(result.folder.children.length, 2);
  assert.equal(result.folder.children[1].children[0].id, 'grandchild-1');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].library.folders[0].name, '新父文件夹');
  assert.equal(changes[0].library.folders[0].children[0].id, 'child-1');
  assert.equal(changes[0].library.folders[0].children[1].children[0].id, 'grandchild-1');
});

