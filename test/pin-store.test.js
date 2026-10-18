'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PinStore } = require('../lib/pin-store');

test('persists folder-scoped pins without writing to the Eagle library', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-pins-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'app-data', 'pins.json');
  const libraryPath = path.join(root, 'ReadOnly.library');
  const store = new PinStore(stateFile);
  const pins = await store.set(libraryPath, 'FOLDER1', ['A', 'B'], true);
  assert.ok(pins.FOLDER1.A > pins.FOLDER1.B);

  const reloaded = new PinStore(stateFile);
  assert.deepEqual(await reloaded.get(libraryPath), pins);
  const unpinned = await reloaded.set(libraryPath, 'FOLDER1', ['A'], false);
  assert.equal(unpinned.FOLDER1.A, undefined);
  assert.ok(unpinned.FOLDER1.B > 0);

  const nativeOverride = await reloaded.set(libraryPath, 'FOLDER1', ['NATIVE_PIN'], false);
  assert.equal(nativeOverride.FOLDER1.NATIVE_PIN, -1);
  await assert.rejects(() => fs.stat(libraryPath), /ENOENT/);
});

test('S-01: pin ids that are not Eagle ids are rejected and never reach Object.prototype', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-pins-proto-'));
  const store = new PinStore(path.join(directory, 'pins.json'));
  const library = path.join(directory, 'Main.library');
  for (const [folderId, ids] of [['__proto__', ['isDeleted']], ['constructor', ['x']], ['folder', ['__proto__']], ['folder', ['bad id']]]) {
    await assert.rejects(store.set(library, folderId, ids, true), /置顶参数无效/);
  }
  assert.equal(({}).isDeleted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'isDeleted'), false);
  assert.deepEqual(await store.get(library), {});
  const pins = await store.set(library, 'FOLDER1', ['ITEM1'], true);
  assert.deepEqual(Object.keys(pins.FOLDER1), ['ITEM1']);
  const cloned = await store.cloneFolders(library, { FOLDER1: '__proto__', __proto__: 'X' }, { ITEM1: 'ITEM2' });
  assert.equal(({}).ITEM2, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(cloned, '__proto__'), false);
});

// S-15: records of items that left the library, above all -1 markers, are dropped.
test('S-15: a pin change drops records of items the library no longer has', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-pins-prune-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new PinStore(path.join(root, 'pins.json'));
  const libraryPath = path.join(root, 'Fixture.library');
  await store.set(libraryPath, 'F1', ['GONE_PIN'], true);
  await store.set(libraryPath, 'F1', ['GONE_UNPIN', 'KEPT_UNPIN'], false);
  let pins = await store.set(libraryPath, 'F1', ['LIVE'], true);
  assert.deepEqual(Object.keys(pins.F1).sort(), ['GONE_PIN', 'GONE_UNPIN', 'KEPT_UNPIN', 'LIVE'], 'no live check, nothing trimmed');
  const live = new Set(['LIVE', 'KEPT_UNPIN', 'NEW']);
  pins = await store.set(libraryPath, 'F1', ['NEW'], true, { isLive: id => live.has(id) });
  assert.deepEqual(Object.keys(pins.F1).sort(), ['KEPT_UNPIN', 'LIVE', 'NEW']);
  assert.equal(pins.F1.KEPT_UNPIN, -1);
});
