'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DataHub } = require('../lib/data-hub');
const { EagleClient } = require('../lib/eagle-client');
const { createImportService, collectDirectoryFiles } = require('../lib/import-service');
const { PinStore } = require('../lib/pin-store');
const { SupplementalItemStore } = require('../lib/supplemental-item-store');
const { exportFiles } = require('../lib/export-service');
const { createTrashScanService } = require('../lib/trash-scan-service');
const { findDuplicateImports } = require('../lib/duplicate-service');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-data-regression-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

for (const failure of ['switch', 'timeout']) test(`DA-01/09: import ${failure} preserves accepted batches and never submits remaining files blindly`, async t => {
  const root = await fixture(t);
  const paths = await Promise.all(Array.from({ length: 401 }, async (_, i) => { const file = path.join(root, `${i}.txt`); await fs.writeFile(file, String(i)); return file; }));
  let library = '/A.library';
  const calls = [], invalidations = [];
  const service = createImportService({
    client: {
      async addItems(batch) { calls.push({ library, batch }); if (calls.length === 2) throw new Error('timeout'); if (failure === 'switch') library = '/B.library'; return batch.map((_, i) => `I${i}`); },
      async getItems(ids) { return ids.map(id => ({ id })); }
    },
    async ensureLibraryPath(expected) { if (library !== expected) { const error = new Error('switched'); error.code = 'LIBRARY_CHANGED'; throw error; } },
    onInvalidate: reason => invalidations.push(reason), itemCache: new Map()
  });
  const result = await service({ paths, libraryPath: '/A.library', waitTimeoutMs: 0 });
  assert.equal(result.count, 200);
  assert.equal(result.partial, true);
  assert.equal(result.ids.length, 200);
  assert.equal(calls.length, failure === 'switch' ? 1 : 2);
  assert.equal(result.notSubmitted.length, failure === 'switch' ? 201 : 1);
  assert.equal(result.unknown.length, failure === 'switch' ? 0 : 200);
  assert.ok(invalidations.includes('items-import-accepted'));
  assert.ok(result.rejected.length > 0, 'all current UI consumers receive a visible incomplete result');
});

test('DA-11: deep and unreadable subtrees are reported separately from the file cap', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'shallow.txt'), 'x');
  const deep = path.join(root, ...Array(9).fill('nested'));
  await fs.mkdir(deep, { recursive: true }); await fs.writeFile(path.join(deep, 'deep.txt'), 'x');
  const denied = path.join(root, 'denied'); await fs.mkdir(denied);
  const original = fs.readdir;
  fs.readdir = async (dir, ...args) => { if (dir === denied) { const e = new Error('access denied'); e.code = 'EACCES'; throw e; } return original(dir, ...args); };
  t.after(() => { fs.readdir = original; });
  const collected = await collectDirectoryFiles(root, 2000);
  assert.equal(collected.files.length, 1);
  assert.deepEqual(new Set(collected.skipped.map(entry => entry.code)), new Set(['IMPORT_DEPTH_LIMIT', 'EACCES']));
});

test('DA-10: deleted matches are excluded so use-existing can only resolve active items', async t => {
  const root = await fixture(t), input = path.join(root, 'input.txt'); await fs.writeFile(input, 'same');
  const libraryPath = path.join(root, 'synthetic-store');
  for (const [id, isDeleted] of [['A-trash', true], ['B-live', false]]) {
    const dir = path.join(libraryPath, 'images', `${id}.info`); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'item.txt'), 'same');
    await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ id, name: 'item', ext: 'txt', size: 4, isDeleted }));
  }
  const result = await findDuplicateImports({ paths: [input], libraryPath });
  assert.deepEqual(result.map(item => item.id), ['B-live']);
});

test('DA-12: supplemental add/add and add/remove transactions retain unrelated changes and library isolation', async t => {
  const file = path.join(await fixture(t), 'state.json'), store = new SupplementalItemStore(file);
  await store.set('/A.library', ['existing']);
  await Promise.all([store.add('/A.library', ['one']), store.add('/A.library', ['two']), store.add('/B.library', ['other'])]);
  await Promise.all([store.add('/A.library', ['three']), store.remove('/A.library', ['existing'])]);
  const reloaded = new SupplementalItemStore(file);
  assert.deepEqual(new Set(await reloaded.get('/A.library')), new Set(['one', 'two', 'three']));
  assert.deepEqual(await reloaded.get('/B.library'), ['other']);
});

for (const Store of [PinStore, SupplementalItemStore]) {
  test(`DA-14: ${Store.name} concurrent initial readers share completed disk state`, async t => {
    const file = path.join(await fixture(t), 'state.json');
    const content = Store === PinStore ? { F: { I: 1 } } : ['I'];
    await fs.writeFile(file, JSON.stringify({ version: 1, libraries: { '/A.library': content } }));
    const gate = deferred(), original = fs.readFile; let reads = 0;
    fs.readFile = async (...args) => { if (args[0] === file) { reads++; await gate.promise; } return original(...args); };
    t.after(() => { fs.readFile = original; });
    const store = new Store(file), first = store.get('/A.library'), second = store.get('/A.library');
    await turn(); gate.resolve();
    assert.deepEqual(await first, content); assert.deepEqual(await second, content); assert.equal(reads, 1);
  });
  test(`DA-15: ${Store.name} failed writes roll back memory and subsequent operations recover`, async t => {
    const root = await fixture(t), file = path.join(root, 'state', 'data.json'), store = new Store(file);
    await store.load(); await fs.writeFile(path.dirname(file), 'obstacle');
    const write = id => Store === PinStore ? store.set('/A.library', 'F', [id], true) : store.add('/A.library', [id]);
    await assert.rejects(write('failed'));
    assert.deepEqual(await store.get('/A.library'), Store === PinStore ? {} : []);
    await fs.rm(path.dirname(file)); await write('saved');
    const result = await new Store(file).get('/A.library');
    assert.ok(Store === PinStore ? result.F.saved > 0 : result.includes('saved'));
  });
}

test('DA-04: estimated query counts preserve the underlying continuation', async () => {
  const hub = new DataHub({ queryItems: async () => ({ data: [{ id: 'I' }], total: 1, estimated: true, hasMore: true }) });
  assert.equal((await hub.query({ limit: 1 })).hasMore, true);
});

test('DA-04: real EagleClient scanning continues through DataHub until every filtered page is delivered', async () => {
  const client = new EagleClient();
  client.request = async (_endpoint, { body }) => ({
    data: Array.from({ length: 1000 }, (_, index) => ({ id: String(body.offset + index), tags: index < 160 ? ['match'] : [] })),
    total: 2000
  });
  const hub = new DataHub(client), query = { search: 'sample', tags: ['match'], limit: 160 };
  const first = await hub.query(query);
  assert.equal(first.estimated, true); assert.equal(first.hasMore, true); assert.equal(first.data.length, 160);
  const second = await hub.query({ ...query, offset: first.nextOffset });
  assert.equal(second.hasMore, false); assert.equal(second.estimated, false);
  assert.equal(new Set([...first.data, ...second.data].map(item => item.id)).size, 320);
});

test('DA-05: reads started before a successful mutation cannot roll back cache or query results', async () => {
  const gate = deferred(); let current = { id: 'I', name: 'before', modificationTime: 1 }, reads = 0;
  const hub = new DataHub({ request: () => gate.promise, queryItems: () => ++reads === 1 ? gate.promise : Promise.resolve({ data: [current], total: 1, hasMore: false }), getItem: async () => current, updateItem: async (_id, patch) => (current = { ...current, ...patch, modificationTime: 2 }) });
  hub.itemCache.set('I', current); hub.setWatchedIds('window', ['I']);
  const events = []; hub.on('items-changed', event => events.push(event.items[0].name));
  const watched = hub.refreshWatchedItems(), queried = hub.query({ limit: 1 });
  await hub.mutate({ id: 'I', patch: { name: 'after' }, base: current });
  gate.resolve({ data: [{ id: 'I', name: 'before', modificationTime: 1 }], total: 1 });
  await watched; assert.equal((await queried).data[0].name, 'after');
  assert.equal(hub.itemCache.get('I').name, 'after'); assert.deepEqual(events, ['after']);
});

test('DA-05/07: newer connect wins and old-library queries cannot refill caches', async () => {
  const old = deferred(), query = deferred(); let calls = 0;
  const hub = new DataHub({ appInfo: async () => ({}), libraryInfo: () => ++calls === 1 ? old.promise : Promise.resolve({ path: '/B.library', modificationTime: 2 }), folderTree: async () => [], queryItems: () => query.promise });
  hub.library = { path: '/A.library', folders: [] };
  const pendingQuery = hub.query({}).catch(error => error);
  const first = hub.connect(); await hub.connect(); old.resolve({ path: '/A.library', modificationTime: 1 }); await first;
  query.resolve({ data: [{ id: 'OLD' }], total: 1 });
  assert.equal((await pendingQuery).code, 'LIBRARY_CHANGED');
  assert.equal(hub.library.path, '/B.library'); assert.equal(hub.itemCache.has('OLD'), false);
});

test('DA-06: a transient folder-tree error leaves a retry watermark until the tree succeeds', async () => {
  let calls = 0;
  const hub = new DataHub({ libraryInfo: async () => ({ path: '/A.library', modificationTime: 2 }), folderTree: async () => { if (++calls === 1) throw new Error('temporary'); return [{ id: 'F', name: 'new' }]; } });
  hub.library = { path: '/A.library', folders: [{ id: 'F', name: 'old' }] }; hub.lastModificationTime = 1;
  await hub.poll(); await hub.poll();
  assert.equal(calls, 2); assert.equal(hub.library.folders[0].name, 'new');
});

test('DA-21: simultaneous exports reserve unique destinations atomically', async t => {
  const root = await fixture(t), destinationRoot = path.join(root, 'out'), sources = [];
  for (const name of ['one', 'two']) { const dir = path.join(root, name); await fs.mkdir(dir); const file = path.join(dir, 'same.txt'); await fs.writeFile(file, name); sources.push(file); }
  const gate = deferred(); let arrivals = 0;
  const injected = { ...fs, existsSync: syncFs.existsSync, async copyFile(...args) { if (++arrivals <= 2) { if (arrivals === 2) gate.resolve(); await gate.promise; } return fs.copyFile(...args); } };
  const results = await Promise.all(sources.map(source => exportFiles({ filePaths: [source], destinationRoot, fs: injected })));
  const files = results.flatMap(result => result.files);
  assert.equal(new Set(files).size, 2); assert.deepEqual(new Set(await Promise.all(files.map(file => fs.readFile(file, 'utf8')))), new Set(['one', 'two']));
});

test('DA-22: hung readdir settles at the deadline, retry is fresh and the late read cannot cache', async () => {
  const gate = deferred(); let calls = 0;
  const service = createTrashScanService({ fs: { readdir: () => ++calls === 1 ? gate.promise : Promise.resolve([]) }, timeoutMs: 20 });
  const first = service.read('/A.library').catch(error => error);
  const result = await Promise.race([first, new Promise(resolve => setTimeout(() => resolve('still pending'), 100))]);
  gate.resolve([]);
  assert.equal(result.code, 'TRASH_SCAN_TIMEOUT');
  assert.deepEqual(await service.read('/A.library'), []); assert.equal(calls, 2);
});

test('DA-08: folder rename readback cannot overlay the old folder onto a newly active library', async () => {
  let currentPath = '/A.library';
  const hub = new DataHub({
    libraryInfo: async () => ({ path: currentPath, modificationTime: 2 }),
    folderTree: async () => currentPath === '/A.library' ? [{ id: 'F', name: 'before' }] : [{ id: 'B', name: 'other' }],
    updateFolder: async () => { currentPath = '/B.library'; }
  });
  hub.library = { path: '/A.library', folders: [{ id: 'F', name: 'before' }] };
  hub.itemCache.set('A', { id: 'A' }); hub.setWatchedIds('W', ['A']);
  const events = []; hub.on('library-changed', event => events.push(event));
  await assert.rejects(hub.mutateFolder({ id: 'F', name: 'after', baseName: 'before', libraryPath: '/A.library' }), error => error.code === 'LIBRARY_CHANGED');
  assert.deepEqual(hub.library.folders, [{ id: 'B', name: 'other' }]);
  assert.equal(hub.itemCache.size, 0); assert.equal(hub.watchers.size, 0); assert.equal(events[0].libraryChanged, true);
});

test('DA-05: writes and watched responses carry library identity and reject late old-library items', async () => {
  const gate = deferred();
  const hub = new DataHub({ request: () => gate.promise, libraryInfo: async () => ({ path: '/A.library' }), getItem: async () => ({ id: 'I', name: 'before' }), updateItem: async (_id, patch) => ({ id: 'I', ...patch }) });
  hub.library = { path: '/A.library' }; hub.setWatchedIds('W', ['I']);
  const events = []; hub.on('items-changed', event => events.push(event));
  await hub.mutate({ id: 'I', patch: { name: 'after' }, base: { name: 'before' }, libraryPath: '/A.library' });
  assert.equal(events[0].libraryPath, '/A.library');
  const read = hub.refreshWatchedItems();
  hub.publishLibrarySnapshot({ path: '/B.library', folders: [] });
  gate.resolve({ data: [{ id: 'I', name: 'from A' }] }); await read;
  assert.equal(events.length, 1); assert.equal(hub.itemCache.size, 0);
});

test('DA-07/08: late rename snapshots cannot undo a newer connect', async () => {
  const gate = deferred(), started = deferred(); let libraryPath = '/A.library', treeReads = 0;
  const hub = new DataHub({
    appInfo: async () => ({}), libraryInfo: async () => ({ path: libraryPath, modificationTime: 2 }),
    folderTree: async () => {
      if (++treeReads === 2) { started.resolve(); return gate.promise; }
      return libraryPath === '/A.library' ? [{ id: 'F', name: 'before' }] : [{ id: 'B', name: 'other' }];
    }, updateFolder: async () => {}
  });
  hub.library = { path: '/A.library', folders: [{ id: 'F', name: 'before' }] };
  const rename = hub.mutateFolder({ id: 'F', name: 'after', baseName: 'before', libraryPath: '/A.library' }).catch(error => error);
  await started.promise; libraryPath = '/B.library'; await hub.connect();
  gate.resolve([{ id: 'F', name: 'after' }]);
  assert.equal((await rename).code, 'LIBRARY_CHANGED');
  assert.equal(hub.library.path, '/B.library'); assert.deepEqual(hub.library.folders, [{ id: 'B', name: 'other' }]);
});

test('DA-05: supplemental slices started before a save cannot restore their stale values', async () => {
  const gate = deferred(); let item = { id: 'S', name: 'before' };
  const hub = new DataHub({ queryItems: () => gate.promise, libraryInfo: async () => ({ path: '/A.library' }), getItem: async () => item, updateItem: async (_id, patch) => (item = { ...item, ...patch }) });
  hub.library = { path: '/A.library' }; hub.setSupplementalItems('/A.library', [item]); hub.itemCache.set('S', item);
  const query = hub.query({ limit: 1 });
  await hub.mutate({ id: 'S', patch: { name: 'after' }, base: item, libraryPath: '/A.library' });
  gate.resolve({ data: [], total: 0, hasMore: false });
  assert.equal((await query).data[0].name, 'after'); assert.equal(hub.itemCache.get('S').name, 'after');
});
