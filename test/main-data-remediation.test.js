'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadMain } = require('../test-support/main-data-harness.cjs');
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-main-regression-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

test('DA-02: failed creation never rolls back another library and reports the residual item', async t => {
  const main = loadMain(await fixture(t)); let library = '/A.library';
  main.hub.library = { path: library, folders: [] };
  main.client.libraryInfo = async () => ({ path: library });
  main.client.queryItems = async () => ({ data: [], total: 0, hasMore: false });
  main.client.addItems = async () => ['NEW-A'];
  main.client.getItems = async () => [{ id: 'NEW-A' }];
  main.setWaitForImportedFile(async () => { library = '/B.library'; return { item: null, fileURL: null }; });
  const writes = []; main.client.updateItem = async (id, patch) => { writes.push({ library, id, patch }); };
  const result = await main.rpcRegistry.get('document:create')({ sender: { id: 1 } }, { type: 'txt', name: 'fixture', libraryPath: '/A.library' }).catch(error => error);
  assert.equal(writes.length, 0);
  assert.equal(result.cleanup?.status, 'pending'); assert.equal(result.cleanup?.id, 'NEW-A');
  assert.match(result.message, /NEW-A/);
});

test('DA-17: cancel quit preserves Web; only the final will-quit stops it', async t => {
  const main = loadMain(await fixture(t));
  const server = { listening: true, async stop() { this.listening = false; } }; main.setWebServer(server);
  main.app.emit('before-quit'); main.rpcRegistry.get('window:cancel-close')({ sender: { id: 1 } });
  assert.equal(main.getQuitting(), false); assert.equal(server.listening, true);
  main.app.emit('before-quit'); main.app.emit('will-quit'); assert.equal(server.listening, false);
});

test('DA-14/16/UW-07: first tag-color readers and concurrent color writes persist and broadcast the same committed state', async t => {
  const root = await fixture(t), file = path.join(root, 'state', 'tag-colors.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, libraries: { '/A.library': { existing: '#000000' } } }));
  const main = loadMain(root), events = [];
  main.addFakeWindow({ isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } });
  const [first, second] = await Promise.all([main.getTagColors('/A.library'), main.getTagColors('/A.library')]);
  assert.deepEqual(second, first); assert.equal(second.existing, '#000000');
  const handler = main.rpcRegistry.get('tag-colors:set');
  await Promise.all([handler({ sender: { id: 1 } }, { libraryPath: '/A.library', tag: 'A', color: '#111111' }), handler({ sender: { id: 2 } }, { libraryPath: '/A.library', tag: 'B', color: '#222222' })]);
  const saved = JSON.parse(await fs.readFile(file, 'utf8')).libraries['/A.library'];
  assert.deepEqual(saved, { existing: '#000000', A: '#111111', B: '#222222' });
  const broadcasts = events.filter(event => event.channel === 'tag-data:changed');
  assert.equal(broadcasts.length, 2); assert.equal(broadcasts[1].payload.libraryPath, '/A.library');
  assert.equal(broadcasts[1].payload.reason, 'tag-color');
});

test('DA-13: transient hydration retains IDs and old snapshots; explicit deletion removes only that ID', async t => {
  const main = loadMain(await fixture(t));
  main.hub.library = { path: '/A.library', folders: [] }; main.client.libraryInfo = async () => main.hub.library;
  await main.getSupplementalItemStore().set('/A.library', ['transient', 'deleted', 'new']);
  main.hub.setSupplementalItems('/A.library', [{ id: 'transient', name: 'last known' }]);
  main.client.getItem = async id => { if (id === 'transient') throw new Error('temporary timeout'); return { id, isDeleted: id === 'deleted' }; };
  await main.hydrateSupplementalItems('/A.library');
  assert.deepEqual(await main.getSupplementalItemStore().get('/A.library'), ['transient', 'new']);
  assert.equal(main.hub.supplementalItems.get('transient').name, 'last known');
  main.client.getItem = async id => ({ id, name: 'recovered' });
  await main.hydrateSupplementalItems('/A.library');
  assert.equal(main.hub.supplementalItems.get('transient').name, 'recovered');
});

test('DA-08: mutation readback switching libraries runs the normal cache and watcher lifecycle', async t => {
  const main = loadMain(await fixture(t)); let library = '/A.library';
  main.hub.library = { path: library, folders: [] };
  main.client.libraryInfo = async () => ({ path: library, modificationTime: 2 });
  main.client.folderTree = async () => [];
  main.client.createFolder = async () => { library = '/B.library'; return { id: 'NEW-A' }; };
  const events = []; main.hub.on('library-changed', event => events.push(event));
  main.hub.itemCache.set('OLD-A', { id: 'OLD-A' }); main.hub.setWatchedIds('old-window', ['OLD-A']); main.hub.setSupplementalItems('/A.library', [{ id: 'S' }]);
  await main.rpcRegistry.get('folder:create')({ sender: { id: 1 } }, { name: 'fixture', libraryPath: '/A.library' });
  assert.equal(events[0]?.libraryChanged, true); assert.equal(main.hub.library.path, '/B.library');
  assert.equal(main.hub.itemCache.size, 0); assert.equal(main.hub.watchers.size, 0); assert.notEqual(main.hub.supplementalLibraryPath, '/A.library');
});

test('DA-16: rejected tag writes do not advance memory or broadcast and the next save can recover', async t => {
  const root = await fixture(t), main = loadMain(root), events = [];
  await main.getTagColors('/A.library');
  main.addFakeWindow({ isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } });
  await fs.writeFile(path.join(root, 'state'), 'temporary obstacle');
  const handler = main.rpcRegistry.get('tag-colors:set');
  await assert.rejects(handler({ sender: { id: 1 } }, { libraryPath: '/A.library', tag: 'failed', color: '#111111' }));
  assert.equal(Object.keys(await main.getTagColors('/A.library')).length, 0);
  assert.equal(events.length, 0);
  await fs.rm(path.join(root, 'state'));
  await handler({ sender: { id: 1 } }, { libraryPath: '/A.library', tag: 'saved', color: '#222222' });
  assert.equal((await main.getTagColors('/A.library')).saved, '#222222');
  assert.equal(events.length, 1);
});

test('DA-13: late hydration cannot replace a newer library supplemental snapshot', async t => {
  const main = loadMain(await fixture(t)); let release;
  const gate = new Promise(resolve => { release = resolve; });
  main.hub.library = { path: '/A.library', folders: [] };
  await main.getSupplementalItemStore().set('/A.library', ['old']);
  main.client.getItem = () => gate;
  const first = main.hydrateSupplementalItems('/A.library');
  await new Promise(resolve => setImmediate(resolve));
  main.hub.publishLibrarySnapshot({ path: '/B.library', folders: [] });
  main.hub.setSupplementalItems('/B.library', [{ id: 'new' }]);
  release({ id: 'old' }); await first;
  assert.equal(main.hub.supplementalLibraryPath, '/B.library');
  assert.equal(main.hub.supplementalItems.has('old'), false);
  assert.deepEqual(await main.getSupplementalItemStore().get('/A.library'), ['old']);
});

test('DA-10: root use-existing rechecks deleted state after duplicate discovery', async t => {
  const root = await fixture(t), main = loadMain(path.join(root, 'user-data'));
  const libraryPath = path.join(root, 'synthetic-store'), dir = path.join(libraryPath, 'images', 'I.info'), input = path.join(root, 'input.txt');
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(input, 'same'); await fs.writeFile(path.join(dir, 'item.txt'), 'same');
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ id: 'I', name: 'item', ext: 'txt', size: 4, isDeleted: false }));
  main.hub.library = { path: libraryPath, folders: [] };
  main.client.libraryInfo = async () => main.hub.library;
  main.client.getItem = async () => ({ id: 'I', isDeleted: true });
  const result = await main.rpcRegistry.get('items:import')({ sender: { id: 1 } }, { paths: [input], libraryPath, duplicateChoice: 'use-existing' });
  assert.equal(result.count, 0); assert.equal(result.ready, 0); assert.equal(result.duplicateFailed, 1); assert.equal(result.ids.length, 0);
});
