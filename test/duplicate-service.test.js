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
