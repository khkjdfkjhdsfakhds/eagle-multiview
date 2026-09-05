'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataHub } = require('../lib/data-hub');

function locate(nodes, id, parent = null) {
  for (const folder of nodes) {
    if (folder.id === id) return { folder, siblings: nodes, parent };
    const found = locate(folder.children || [], id, folder.id);
    if (found) return found;
  }
  return null;
}

class FolderAdapter {
  constructor() {
    this.libraryPath = '/fixture.library';
    this.tree = [
      { id: 'A', name: '来源', children: [{ id: 'C', name: '移动对象', iconColor: 'blue', description: '保留备注', tags: ['keep'], children: [{ id: 'D', name: '子节点', children: [] }] }] },
      { id: 'B', name: '目标', children: [{ id: 'E', name: '移动对象', children: [] }] }
    ];
    this.calls = [];
  }
  async appInfo() { return { version: 'fixture' }; }
  async libraryInfo() { return { path: this.libraryPath, modificationTime: 1 }; }
  async folderTree() { return structuredClone(this.tree); }
  async updateFolder(id, patch) {
    Object.assign(locate(this.tree, id).folder, structuredClone(patch));
    return structuredClone(locate(this.tree, id).folder);
  }
  async moveFolder(id, patch) {
    this.calls.push({ id, patch: structuredClone(patch) });
    const source = locate(this.tree, id);
    source.siblings.splice(source.siblings.indexOf(source.folder), 1);
    source.folder.iconColor = patch.iconColor;
    const target = patch.parent === null ? this.tree : locate(this.tree, patch.parent).folder.children;
    target.push(source.folder);
    return structuredClone(source.folder);
  }
}

async function fixture() {
  const adapter = new FolderAdapter();
  const hub = new DataHub(adapter);
  await hub.connect();
  return { adapter, hub };
}

function move(overrides = {}) {
  return { id: 'C', parentId: 'B', baseParentId: 'A', libraryPath: '/fixture.library', origin: 12, ...overrides };
}

test('moving a folder preserves its identity, child tree and metadata and broadcasts the confirmed parent', async () => {
  const { adapter, hub } = await fixture();
  const changed = [];
  const invalidated = [];
  hub.on('library-changed', event => changed.push(event));
  hub.on('query-invalidated', event => invalidated.push(event));
  const result = await hub.moveFolder(move());
  assert.equal(result.ok, true);
  assert.equal(result.parentId, 'B');
  assert.equal(result.folder.id, 'C');
  assert.equal(result.folder.children[0].id, 'D');
  assert.equal(result.folder.description, '保留备注');
  assert.deepEqual(result.folder.tags, ['keep']);
  assert.equal(result.folder.iconColor, 'blue');
  assert.deepEqual(adapter.calls, [{ id: 'C', patch: { parent: 'B', iconColor: 'blue' } }]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].origin, 12);
  assert.deepEqual(changed[0].library.folders[0].children, []);
  assert.deepEqual(changed[0].library.folders[1].children.map(folder => folder.id), ['E', 'C']);
  assert.equal(invalidated[0].reason, 'folder-move');
});

test('moving to root uses explicit null; dropping on the current parent performs no write', async () => {
  const { adapter, hub } = await fixture();
  const root = await hub.moveFolder(move({ parentId: null }));
  assert.equal(root.parentId, null);
  assert.equal(adapter.calls[0].patch.parent, null);
  assert.deepEqual(hub.library.folders.map(folder => folder.id), ['A', 'B', 'C']);
  const noop = await hub.moveFolder(move({ parentId: null, baseParentId: null }));
  assert.equal(noop.noop, true);
  assert.equal(adapter.calls.length, 1);
});

test('invalid, missing or cyclic targets and unfrozen context are rejected before any API write', async () => {
  for (const [patch, code] of [
    [{ parentId: 'C' }, 'FOLDER_MOVE_CYCLE'],
    [{ parentId: 'D' }, 'FOLDER_MOVE_CYCLE'],
    [{ parentId: 'missing' }, 'FOLDER_NOT_FOUND'],
    [{ id: 'missing' }, 'FOLDER_NOT_FOUND'],
    [{ parentId: undefined }, 'INVALID_FOLDER_MOVE'],
    [{ baseParentId: undefined }, 'INVALID_FOLDER_MOVE'],
    [{ libraryPath: '' }, 'INVALID_FOLDER_MOVE']
  ]) {
    const { adapter, hub } = await fixture();
    await assert.rejects(hub.moveFolder(move(patch)), error => error.code === code);
    assert.equal(adapter.calls.length, 0);
  }
});

test('a different current parent produces a conflict instead of silently overwriting another window', async () => {
  const { adapter, hub } = await fixture();
  const result = await hub.moveFolder(move({ baseParentId: null }));
  assert.equal(result.conflict, true);
  assert.deepEqual(result.conflicts, [{ field: 'parent', base: null, current: 'A', next: 'B' }]);
  assert.equal(adapter.calls.length, 0);
});

test('an accepted response is not success until the read-back tree confirms the move and subtree', async () => {
  for (const corruption of ['no-move', 'lost-child']) {
    const { adapter, hub } = await fixture();
    const events = [];
    hub.on('library-changed', event => events.push(event));
    const originalMove = adapter.moveFolder.bind(adapter);
    adapter.moveFolder = async (id, patch) => {
      if (corruption === 'no-move') { adapter.calls.push({ id, patch }); return { id }; }
      const result = await originalMove(id, patch);
      locate(adapter.tree, 'C').folder.children = [];
      return result;
    };
    await assert.rejects(hub.moveFolder(move()), error => error.code === 'FOLDER_MOVE_UNCONFIRMED' && error.uncertain);
    assert.equal(adapter.calls.length, 1);
    assert.equal(events.length, 0);
    assert.equal(locate(hub.library.folders, 'C').parent, 'A');
  }
});

test('a lost write response is reported as uncertain without replay, and the queue accepts a later operation', async () => {
  const { adapter, hub } = await fixture();
  const originalMove = adapter.moveFolder.bind(adapter);
  adapter.moveFolder = async (...args) => { await originalMove(...args); throw new Error('connection lost'); };
  await assert.rejects(hub.moveFolder(move()), error => error.uncertain === true && /核对/.test(error.message));
  assert.equal(adapter.calls.length, 1);
  adapter.moveFolder = originalMove;
  const next = await hub.moveFolder(move({ baseParentId: 'B', parentId: null }));
  assert.equal(next.ok, true);
  assert.equal(next.parentId, null);
  assert.equal(adapter.calls.length, 2);
});

test('a library switch before writing cancels; a switch after writing never publishes the other library tree', async () => {
  const first = await fixture();
  first.adapter.libraryPath = '/other.library';
  await assert.rejects(first.hub.moveFolder(move()), error => error.code === 'LIBRARY_CHANGED');
  assert.equal(first.adapter.calls.length, 0);

  const { adapter, hub } = await fixture();
  const originalMove = adapter.moveFolder.bind(adapter);
  adapter.moveFolder = async (...args) => {
    await originalMove(...args);
    adapter.libraryPath = '/other.library';
    return { id: 'C' };
  };
  const changes = [];
  hub.on('library-changed', event => changes.push(event));
  await assert.rejects(hub.moveFolder(move()), error => error.code === 'LIBRARY_CHANGED' && error.uncertain);
  assert.equal(changes.length, 0);
  assert.equal(hub.library.path, '/fixture.library');
});

test('a late move read-back never replaces a newer reconnect snapshot with stale sibling metadata', async () => {
  const { adapter, hub } = await fixture();
  const originalTree = adapter.folderTree.bind(adapter);
  let reads = 0;
  let release;
  let announce;
  const waiting = new Promise(resolve => { announce = resolve; });
  adapter.folderTree = async () => {
    const snapshot = await originalTree();
    if (++reads === 2) {
      announce();
      await new Promise(resolve => { release = resolve; });
    }
    return snapshot;
  };
  const pending = hub.moveFolder(move());
  await waiting;
  locate(adapter.tree, 'E').folder.name = '另一窗口的新名字';
  await hub.connect({ notify: true });
  release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(locate(hub.library.folders, 'E').folder.name, '另一窗口的新名字');
  assert.equal(locate(hub.library.folders, 'C').parent, 'B');
  assert.equal(adapter.calls.length, 1);
});

test('simultaneous moves of different folders are serialized so they never introduce a cycle', async () => {
  const { adapter, hub } = await fixture();
  const results = await Promise.allSettled([
    hub.moveFolder(move({ id: 'A', parentId: 'B', baseParentId: null })),
    hub.moveFolder(move({ id: 'B', parentId: 'A', baseParentId: null }))
  ]);
  assert.equal(results[0].value.ok, true);
  assert.equal(results[1].reason.code, 'FOLDER_MOVE_CYCLE');
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(hub.library.folders.map(folder => folder.id), ['B']);
});

test('a library identity mismatch in the post-write snapshot remains a switch error even if the next check recovers', async () => {
  const { adapter, hub } = await fixture();
  const originalInfo = adapter.libraryInfo.bind(adapter);
  let reportedOther = false;
  adapter.libraryInfo = async () => {
    if (adapter.calls.length && !reportedOther) { reportedOther = true; return { path: '/other.library' }; }
    return originalInfo();
  };
  await assert.rejects(hub.moveFolder(move()), error => error.code === 'LIBRARY_CHANGED' && error.uncertain);
  assert.equal(hub.library.path, '/fixture.library');
});

test('two windows repeating the same frozen move produce one write and a parent conflict', async () => {
  const { adapter, hub } = await fixture();
  const results = await Promise.all([hub.moveFolder(move()), hub.moveFolder(move({ origin: 13 }))]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].conflict, true);
  assert.equal(results[1].conflicts[0].current, 'B');
  assert.equal(adapter.calls.length, 1);
});

test('a target disappearing after selection is rejected from fresh API state, not stale window state', async () => {
  const { adapter, hub } = await fixture();
  adapter.tree = adapter.tree.filter(folder => folder.id !== 'B');
  await assert.rejects(hub.moveFolder(move()), error => error.code === 'FOLDER_NOT_FOUND');
  assert.equal(adapter.calls.length, 0);
});

test('post-write read failure does not erase the current tree or trigger a second write', async () => {
  const { adapter, hub } = await fixture();
  const originalTree = adapter.folderTree.bind(adapter);
  adapter.folderTree = () => adapter.calls.length ? Promise.reject(new Error('read offline')) : originalTree();
  await assert.rejects(hub.moveFolder(move()), error => error.uncertain === true && /核对/.test(error.message));
  assert.equal(adapter.calls.length, 1);
  assert.equal(locate(hub.library.folders, 'C').parent, 'A');
});

test('a simultaneous rename is preserved while moving the same node, including the published tree', async () => {
  const { adapter, hub } = await fixture();
  const [moved, renamed] = await Promise.all([
    hub.moveFolder(move()),
    hub.mutateFolder({ id: 'C', name: '新名字', baseName: '移动对象', libraryPath: '/fixture.library' })
  ]);
  assert.equal(moved.ok, true);
  assert.equal(renamed.ok, true);
  assert.equal(locate(hub.library.folders, 'C').parent, 'B');
  assert.equal(locate(hub.library.folders, 'C').folder.name, '新名字');
  assert.equal(locate(adapter.tree, 'C').folder.name, '新名字');
  assert.equal(adapter.calls.length, 1);
});
