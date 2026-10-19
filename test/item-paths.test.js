'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileInDirectory } = require('../lib/item-paths');
const { EagleClient } = require('../lib/eagle-client');

test('E-14: item names never lead a built path out of the item folder', () => {
  const folder = path.join('/lib', 'images', 'ID.info');
  assert.equal(fileInDirectory(folder, 'photo.png'), path.join(folder, 'photo.png'));
  assert.equal(fileInDirectory(`${folder}/`, 'photo.png'), path.join(folder, 'photo.png'));
  assert.equal(fileInDirectory(folder, '..png'), path.join(folder, '..png'));
  for (const name of ['../../secret.png', 'a/b.png', 'a\\b.png', '..', '.', '', 'x\0.png']) {
    assert.equal(fileInDirectory(folder, name), null, name);
  }
});

test('E-14: a hostile item name falls back to the files actually in the item folder', async t => {
  const library = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-item-paths-'));
  t.after(() => fs.rm(library, { recursive: true, force: true }));
  const folder = path.join(library, 'images', 'ID.info');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'real.png'), 'x');
  await fs.writeFile(path.join(library, 'outside.png'), 'secret');
  const client = new EagleClient();
  const url = await client.fileURLForItem({ id: 'ID', name: '../../outside', ext: 'png' }, library);
  assert.equal(url, require('node:url').pathToFileURL(path.join(folder, 'real.png')).href);
});
