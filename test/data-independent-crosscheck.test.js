'use strict';
// Independent review regressions: real DataHub/main entry points, only synthetic fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DataHub } = require('../lib/data-hub');
const { loadMain } = require('../test-support/main-data-harness.cjs');
const syncFs = require('node:fs');
const { exportFiles } = require('../lib/export-service');
const { createTrashScanService } = require('../lib/trash-scan-service');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('DA-07/08 independent: an earlier connect cannot undo a completed same-library folder rename', async () => {
  const oldTree = deferred(), started = deferred();
  let treeReads = 0, name = 'before';
  const hub = new DataHub({ appInfo: async () => ({}), libraryInfo: async () => ({ path: '/A.library', modificationTime: 2 }),
    folderTree: async () => { if (++treeReads === 1) { started.resolve(); return oldTree.promise; } return [{ id: 'F', name }]; },
    updateFolder: async (_id, patch) => { name = patch.name; } });
  hub.library = { path: '/A.library', folders: [{ id: 'F', name: 'before' }] };
  const connect = hub.connect(); await started.promise;
  await hub.mutateFolder({ id: 'F', name: 'after', baseName: 'before', libraryPath: '/A.library' });
  assert.equal(hub.library.folders[0].name, 'after');
  oldTree.resolve([{ id: 'F', name: 'before' }]); await connect;
  assert.equal(hub.library.folders[0].name, 'after');
});

test('DA-05/13 independent: earlier hydration cannot roll back a committed supplemental item', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-independent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = loadMain(root), read = deferred(), started = deferred();
  main.hub.library = { path: '/A.library', folders: [] };
  main.client.libraryInfo = async () => ({ path: '/A.library' });
  await main.getSupplementalItemStore().set('/A.library', ['I']);
  main.hub.setSupplementalItems('/A.library', [{ id: 'I', name: 'before' }]);
  main.client.getItem = () => { started.resolve(); return read.promise; };
  const hydration = main.hydrateSupplementalItems('/A.library'); await started.promise;
  main.hub.publishItemMutation({ id: 'I', name: 'after' }, { libraryPath: '/A.library' });
  read.resolve({ id: 'I', name: 'before' }); await hydration;
  main.client.queryItems = async () => ({ data: [], total: 0, hasMore: false });
  const page = await main.hub.query({ limit: 1 });
  assert.equal(page.data[0].name, 'after');
  assert.equal(main.hub.itemCache.get('I').name, 'after');
});

test('DA-05 independent: a write invalidates query membership, sort and cursor rather than replacing one stale row', async () => {
  const oldPage = deferred(); let reads = 0;
  let item = { id: 'I', star: 3, name: 'before' };
  const requests = [];
  const hub = new DataHub({
    queryItems: async query => {
      requests.push(query);
      if (++reads === 1) return oldPage.promise;
      return { data: [{ id: 'J', star: 3, name: 'next matching item' }], total: 8, nextOffset: 5, hasMore: true };
    }, getItem: async () => item, updateItem: async (_id, patch) => (item = { ...item, ...patch })
  });
  const query = { rating: 3, orderBy: 'NAME', offset: 4, limit: 1, search: 'fixture' };
  const pending = hub.query(query);
  await hub.mutate({ id: 'I', patch: { star: 4 }, base: { star: 3 } });
  oldPage.resolve({ data: [{ id: 'I', star: 3, name: 'before' }], total: 9, nextOffset: 5, hasMore: true });
  const result = await pending;
  assert.deepEqual(result.data.map(item => item.id), ['J']);
  assert.equal(result.total, 8); assert.equal(result.nextOffset, 5); assert.equal(result.hasMore, true);
  assert.deepEqual(requests, [query, query]);
});

test('DA-07/08 independent: slow folder readback preserves another folder rename committed meanwhile', async () => {
  const slow = deferred(), started = deferred(); let reads = 0;
  const folders = [{ id: 'F', name: 'F-before' }, { id: 'G', name: 'G-before' }];
  const hub = new DataHub({ libraryInfo: async () => ({ path: '/A.library', modificationTime: 2 }),
    folderTree: async () => {
      if (++reads === 2) { started.resolve(); return slow.promise; }
      return structuredClone(folders);
    }, updateFolder: async (id, patch) => Object.assign(folders.find(folder => folder.id === id), patch) });
  hub.library = { path: '/A.library', folders: structuredClone(folders) };
  const first = hub.mutateFolder({ id: 'F', name: 'F-after', baseName: 'F-before', libraryPath: '/A.library' });
  await started.promise;
  const oldRead = structuredClone(folders);
  await hub.mutateFolder({ id: 'G', name: 'G-after', baseName: 'G-before', libraryPath: '/A.library' });
  slow.resolve(oldRead); await first;
  assert.deepEqual(hub.library.folders.map(folder => folder.name), ['F-after', 'G-after']);
});

test('DA-05 independent: continuously changing queries fail boundedly without returning a stale page', async () => {
  let reads = 0;
  const hub = new DataHub({ queryItems: async () => {
    reads++; hub.publishItemMutation({ id: 'I', star: 4 });
    return { data: [{ id: 'I', star: 3 }], total: 1, hasMore: false };
  } });
  await assert.rejects(hub.query({ rating: 3, limit: 1 }), error => error.code === 'QUERY_CHANGED');
  assert.equal(reads, 3);
  assert.equal(hub.itemCache.get('I').star, 4);
});

test('DA-04 independent: an authoritative consumed cursor progresses across an empty API page', async () => {
  const hub = new DataHub({ queryItems: async () => ({ data: [], total: 8, nextOffset: 5, hasMore: true }) });
  const page = await hub.query({ offset: 3, limit: 1 });
  assert.equal(page.nextOffset, 5); assert.equal(page.hasMore, true);
});

test('DA-21 independent: symlink aliases cannot turn export into a direct library write', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-export-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = path.join(root, 'synthetic-store'), alias = path.join(root, 'library-alias');
  const source = path.join(root, 'source.txt');
  await fs.mkdir(library); await fs.symlink(library, alias); await fs.writeFile(source, 'fixture');
  const adapter = { ...fs, existsSync: syncFs.existsSync };
  for (const destinationRoot of [alias, path.join(alias, 'not-created')]) {
    await assert.rejects(exportFiles({ filePaths: [source], destinationRoot, libraryPath: library, fs: adapter }), /资料库内部/);
  }
  assert.deepEqual(await fs.readdir(library), [], 'a rejected export must not create even an empty folder in the library');
  const outside = path.join(root, 'outside'), outsideAlias = path.join(root, 'outside-alias');
  await fs.mkdir(outside); await fs.symlink(outside, outsideAlias);
  const result = await exportFiles({ filePaths: [source], destinationRoot: outsideAlias, libraryPath: library, fs: adapter });
  assert.equal(result.count, 1);
  assert.equal(await fs.readFile(path.join(outside, 'source.txt'), 'utf8'), 'fixture');
});

test('DA-22 independent: a new read after soft invalidation never joins or caches the older scan', async () => {
  const oldRead = deferred(), started = deferred(); let reads = 0;
  const service = createTrashScanService({ fs: {
    readdir: async () => [{ name: 'I.info', isDirectory: () => true }],
    readFile: async () => {
      if (++reads === 1) { started.resolve(); return oldRead.promise; }
      return JSON.stringify({ id: 'I', name: 'after', isDeleted: true });
    }
  } });
  const first = service.read('/A.library'); await started.promise;
  service.invalidateAll();
  const second = service.read('/A.library');
  oldRead.resolve(JSON.stringify({ id: 'I', name: 'before', isDeleted: true }));
  await first;
  assert.equal((await second)[0].name, 'after');
  assert.equal((await service.read('/A.library'))[0].name, 'after');
  assert.equal(reads, 2);
});
