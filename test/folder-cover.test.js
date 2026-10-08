'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { FolderCoverStore } = require('../lib/folder-cover-store');
const { loadMain } = require('../test-support/main-data-harness.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-cover-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('folder covers survive restart, isolate libraries and retain reset conflicts', async t => {
  const file = path.join(await fixture(t), 'state', 'covers.json');
  const store = new FolderCoverStore(file);
  const payload = { libraryPath: '/fixture-A.library', folderId: 'folder', itemId: 'image', revision: 0 };
  const [first, stale] = await Promise.all([store.set(payload), store.set({ ...payload, itemId: 'other' })]);
  assert.equal(first.ok, true);
  assert.equal(stale.conflict, true);
  assert.equal(await new FolderCoverStore(file).getCover(payload.libraryPath, 'folder'), 'image');
  assert.equal(await store.getCover('/fixture-B.library', 'folder'), null);
  const reset = await store.set({ ...payload, itemId: null, revision: 1 });
  assert.equal(reset.covers.folder.itemId, null);
  assert.equal((await store.set({ ...payload, revision: 1 })).conflict, true);
  assert.equal(await new FolderCoverStore(file).getCover(payload.libraryPath, 'folder'), null);
});

test('failed cover writes leave disk and memory unchanged, and queue recovers', async t => {
  const root = await fixture(t);
  const store = new FolderCoverStore(path.join(root, 'covers.json'));
  const payload = { libraryPath: '/fixture.library', folderId: 'folder', itemId: 'a', revision: 0 };
  await store.set(payload);
  store.filePath = path.join(root, 'obstacle', 'covers.json');
  await fs.writeFile(path.join(root, 'obstacle'), 'file');
  await assert.rejects(store.set({ ...payload, itemId: 'b', revision: 1 }));
  assert.equal(await store.getCover(payload.libraryPath, 'folder'), 'a');
  store.filePath = path.join(root, 'covers.json');
  assert.equal((await store.set({ ...payload, itemId: 'b', revision: 1 })).ok, true);
  await assert.rejects(store.set({ ...payload, folderId: '__proto__' }));
});

test('real cover RPC broadcasts, reads back after restart, resets and falls back without Eagle writes', async t => {
  const root = await fixture(t);
  const main = loadMain(root);
  const libraryPath = '/fixture.library';
  const native = path.join(root, 'eagle.png'), selected = path.join(root, 'selected.png');
  await fs.writeFile(native, 'native'); await fs.writeFile(selected, 'selected');
  const folder = { id: 'folder', covers: [`<img src="${pathToFileURL(native)}">`] };
  main.hub.library = { path: libraryPath, folders: [folder] };
  main.hub.ensureLibraryPath = async value => assert.equal(value, main.hub.library.path);
  main.client.folderTree = async () => [folder];
  main.client.getItem = async id => ({ id, ext: 'png' });
  main.client.thumbnailPath = async () => selected;
  const messages = [];
  main.addFakeWindow({ isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } });
  const set = main.rpcRegistry.get('folder-covers:set');
  const payload = { libraryPath, folderId: 'folder', itemId: 'image', revision: 0 };
  assert.equal((await set({}, payload)).ok, true);
  assert.ok(messages.some(([name]) => name === 'folder-covers:changed'));
  assert.equal(await main.resolveMediaURL('folder', 'folder'), pathToFileURL(selected).toString());
  const fresh = loadMain(root);
  fresh.hub.ensureLibraryPath = async () => {};
  assert.equal((await fresh.rpcRegistry.get('folder-covers:get')({}, { libraryPath })).covers.folder.itemId, 'image');
  main.client.getItem = async id => ({ id, ext: 'png', isDeleted: true });
  assert.equal(await main.resolveMediaURL('folder', 'folder'), pathToFileURL(native).toString());
  main.client.getItem = async id => ({ id, ext: 'png' });
  await fs.unlink(selected);
  assert.equal(await main.resolveMediaURL('folder', 'folder'), pathToFileURL(native).toString());
  assert.equal((await set({}, { ...payload, itemId: null, revision: 1 })).ok, true);
  assert.equal(await main.resolveMediaURL('folder', 'folder'), pathToFileURL(native).toString());
  assert.equal(await fs.readFile(native, 'utf8'), 'native');
});

test('cover RPC rejects deleted images, missing folders and library switches before persistence', async t => {
  const root = await fixture(t), main = loadMain(root);
  const libraryPath = '/fixture.library';
  main.hub.ensureLibraryPath = async p => assert.equal(p, libraryPath);
  main.client.folderTree = async () => [];
  const set = main.rpcRegistry.get('folder-covers:set');
  const payload = { libraryPath, folderId: 'folder', itemId: 'image', revision: 0 };
  await assert.rejects(set({}, payload), /文件夹/);
  main.client.folderTree = async () => [{ id: 'folder' }];
  main.client.getItem = async id => ({ id, ext: 'png', isDeleted: true });
  await assert.rejects(set({}, payload), /图片/);
  const thumb = path.join(root, 'thumb.png'); await fs.writeFile(thumb, 'fixture');
  main.client.getItem = async id => ({ id, ext: 'png' });
  main.client.thumbnailPath = async () => { main.hub.ensureLibraryPath = async () => { throw Error('switched library'); }; return thumb; };
  await assert.rejects(set({}, payload), /switched library/);
  await assert.rejects(fs.readFile(path.join(root, 'state', 'folder-covers.json')), { code: 'ENOENT' });
});
