'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DuplicateIndex, findDuplicateImports, mapWithConcurrency, pairImportedIdsWithFolders } = require('../lib/duplicate-service');

test('pairs imported copies with their original folder memberships', () => {
  assert.deepEqual(pairImportedIdsWithFolders(['copy-a', 'copy-b'], [
    { item: { folders: ['folder-a', 'folder-a', null] } },
    { item: { folders: [] } }
  ]), [{ id: 'copy-a', folders: ['folder-a'] }]);
});

async function addLibraryItem(imagesRoot, { id, name, ext, content }) {
  const directory = path.join(imagesRoot, `${id}.info`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${name}.${ext}`), content);
  await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ id, name, ext, size: content.length }));
}

test('finds only byte-identical imports while scanning metadata concurrently', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-duplicates-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const imagesRoot = path.join(root, 'images');
  await fs.mkdir(imagesRoot);
  const duplicateContent = Buffer.from('same-size duplicate');
  const differentContent = Buffer.from('same-size different');
  const mismatchContent = Buffer.from('same-size mismatch!');
  const duplicateSource = path.join(root, 'duplicate.png');
  const distinctSource = path.join(root, 'distinct.png');
  await Promise.all([
    fs.writeFile(duplicateSource, duplicateContent),
    fs.writeFile(distinctSource, differentContent),
    addLibraryItem(imagesRoot, { id: 'duplicate-id', name: 'existing-duplicate', ext: 'png', content: duplicateContent }),
    addLibraryItem(imagesRoot, { id: 'distinct-id', name: 'existing-distinct', ext: 'png', content: differentContent }),
    addLibraryItem(imagesRoot, { id: 'mismatch-id', name: 'same-size-mismatch', ext: 'png', content: mismatchContent })
  ]);

  const index = new DuplicateIndex({ metadataConcurrency: 2 });
  await index.warm(root);
  const result = await findDuplicateImports({
    paths: [duplicateSource, distinctSource],
    libraryPath: root,
    index,
    hashConcurrency: 1
  });

  assert.deepEqual(result.sort((left, right) => left.path.localeCompare(right.path)), [
    { path: path.resolve(duplicateSource), id: 'duplicate-id', name: 'existing-duplicate', ext: 'png' },
    { path: path.resolve(distinctSource), id: 'distinct-id', name: 'existing-distinct', ext: 'png' }
  ].sort((left, right) => left.path.localeCompare(right.path)));
  index.invalidate(root);
  assert.equal((await index.recordsFor(root)).length, 3);
});

test('bounds concurrent metadata work', async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return value;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(result.sort((left, right) => left - right), [1, 2, 3, 4, 5]);
});

// E-04: after the first read, changes only read new item folders.
test('the duplicate index refreshes incrementally after the first full read', async t => {
  const fsSync = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const fsp = require('node:fs/promises');
  const { DuplicateIndex } = require('../lib/duplicate-service');
  const library = fsSync.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-dup-incremental-'));
  t.after(() => fsSync.rmSync(library, { recursive: true, force: true }));
  const addItem = id => {
    const folder = path.join(library, 'images', `${id}.info`);
    fsSync.mkdirSync(folder, { recursive: true });
    fsSync.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify({ id, name: id, ext: 'png', size: 1 }));
  };
  addItem('A'); addItem('B');
  const index = new DuplicateIndex();
  assert.deepEqual((await index.warm(library)).map(record => record.metadata.id).sort(), ['A', 'B']);

  const realReadFile = fsp.readFile;
  const reads = [];
  t.after(() => { fsp.readFile = realReadFile; });
  fsp.readFile = async (file, ...rest) => { reads.push(path.basename(path.dirname(file))); return realReadFile(file, ...rest); };
  addItem('C');
  fsSync.rmSync(path.join(library, 'images', 'A.info'), { recursive: true });
  index.markStale(library);
  assert.equal(index.peek(library), null, 'a stale snapshot is not offered');
  const refreshed = await index.recordsFor(library);
  assert.deepEqual(refreshed.map(record => record.metadata.id).sort(), ['B', 'C']);
  assert.deepEqual(reads, ['C.info'], 'only the new item folder is read');
  assert.ok(index.peek(library), 'the refreshed snapshot is current');
  // Unchanged: no reads at all.
  reads.length = 0;
  await index.recordsFor(library);
  assert.deepEqual(reads, []);
  // A folder whose metadata was not written yet is read again next time.
  fsSync.mkdirSync(path.join(library, 'images', 'D.info'));
  index.markStale(library);
  await index.recordsFor(library);
  fsSync.writeFileSync(path.join(library, 'images', 'D.info', 'metadata.json'), JSON.stringify({ id: 'D', name: 'D', ext: 'png', size: 1 }));
  index.markStale(library);
  assert.ok((await index.recordsFor(library)).some(record => record.metadata.id === 'D'));
});
