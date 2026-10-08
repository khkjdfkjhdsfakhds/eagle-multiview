'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { loadMain } = require('../test-support/main-data-harness.cjs');

for (const entry of ['clipboard', 'directory', 'external-change']) test(`${entry} duplicate stays in MultiView before any Eagle import`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-import-routing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryPath = path.join(root, 'library');
  const directory = path.join(root, 'incoming');
  await fs.mkdir(directory);
  await fs.mkdir(path.join(libraryPath, 'images'), { recursive: true });
  const file = path.join(directory, 'copy.txt');
  await fs.writeFile(file, 'duplicate fixture');
  const main = loadMain(root, { clipboard: { read: () => file, readText: () => file, availableFormats: () => [] } });
  main.hub.library = { path: libraryPath, folders: [] };
  main.client.libraryInfo = async () => main.hub.library;
  let imports = 0;
  main.client.addItems = async () => { imports++; return ['new']; };
  main.client.getItems = async () => [{ id: 'new' }];
  main.client.getItem = async () => ({ id: 'existing', folders: ['source'] });
  const assigned = [];
  main.hub.mutateSet = async payload => { assigned.push(payload); return { id: payload.id }; };
  const event = { sender: { id: 1 } };
  const payload = { paths: [file], libraryPath, folderId: 'destination' };
  if (entry === 'external-change') {
    await main.rpcRegistry.get('items:import')(event, payload);
    // Populate the index while empty once more after import invalidation.
    await main.rpcRegistry.get('items:import')(event, { ...payload, duplicateChoice: 'cancel' });
    imports = 0;
  }
  const existing = path.join(libraryPath, 'images', 'existing.info');
  await fs.mkdir(existing);
  await fs.copyFile(file, path.join(existing, 'original.txt'));
  await fs.writeFile(path.join(existing, 'metadata.json'), JSON.stringify({ id: 'existing', name: 'original', ext: 'txt', size: 17 }));
  const result = entry === 'clipboard'
    ? await main.rpcRegistry.get('items:import-clipboard')(event, payload)
    : await main.rpcRegistry.get('items:import')(event, { ...payload, paths: entry === 'directory' ? [directory] : [file] });
  assert.equal(imports, 0, 'Duplicate went straight to Eagle, which opens its own confirmation');
  assert.equal(result.needsDuplicateDecision, true);
  assert.equal(result.duplicates[0].id, 'existing');
  const completed = await main.rpcRegistry.get('items:import')(event, { ...payload, paths: result.paths, duplicateChoice: 'use-existing' });
  assert.equal(imports, 0);
  assert.equal(completed.duplicateCount, 1);
  assert.equal(assigned[0].add[0], 'destination');
});
