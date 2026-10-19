'use strict';
// S-02: a damaged state file is set aside and the store starts empty; a file
// from a newer MultiView is never overwritten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PinStore } = require('../lib/pin-store');
const { ManualOrderStore } = require('../lib/manual-order-store');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-state-file-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('an empty or torn pin file is set aside and pins work again', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'pins.json');
  await fs.writeFile(file, '');
  const store = new PinStore(file);
  const library = path.join(dir, 'A.library');
  assert.deepEqual(await store.get(library), {});
  const left = (await fs.readdir(dir)).filter(name => name.startsWith('pins.json.corrupt-'));
  assert.equal(left.length, 1, 'the damaged file is kept for inspection');
});

test('a manual-order file from a newer version is not overwritten', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'orders.json');
  const newer = JSON.stringify({ version: 2, libraries: { future: true } });
  await fs.writeFile(file, newer);
  const store = new ManualOrderStore(file);
  await assert.rejects(store.load(), /更新版本/);
  assert.equal(await fs.readFile(file, 'utf8'), newer);
});
