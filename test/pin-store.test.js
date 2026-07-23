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
