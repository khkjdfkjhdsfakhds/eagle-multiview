'use strict';

// Eagle-parity batch 2: dropping a folder imports its files recursively.
// Real directories on disk, fake Eagle client — no source grepping.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createImportService, collectDirectoryFiles } = require('../lib/import-service');

function makeService(calls) {
  return createImportService({
    client: {
      async addItems(paths, folderId) {
        calls.push({ paths: [...paths], folderId });
        return { ids: paths.map((_, index) => `ID${calls.length}-${index}`) };
      },
      async getItems(ids) { return ids.map(id => ({ id })); }
    },
    ensureLibraryPath: async () => {},
    onInvalidate: () => {},
    itemCache: new Map()
  });
}

test('imports a dropped folder recursively, skipping hidden files and symlinks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-folder-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dropped = path.join(root, 'shoot');
  await fs.mkdir(path.join(dropped, 'nested', 'deeper'), { recursive: true });
  await fs.writeFile(path.join(dropped, 'b.png'), 'b');
  await fs.writeFile(path.join(dropped, 'a.jpg'), 'a');
  await fs.writeFile(path.join(dropped, '.hidden.png'), 'x');
  await fs.writeFile(path.join(dropped, 'nested', 'c.gif'), 'c');
  await fs.writeFile(path.join(dropped, 'nested', 'deeper', 'd.webp'), 'd');
  await fs.mkdir(path.join(dropped, '.git'));
  await fs.writeFile(path.join(dropped, '.git', 'ignored.png'), 'no');
  await fs.symlink(root, path.join(dropped, 'loop'));
  await fs.writeFile(path.join(root, 'single.txt'), 's');
  await fs.symlink(path.join(dropped, 'a.jpg'), path.join(dropped, 'alias.jpg'));

  const calls = [];
  const importPaths = makeService(calls);
  const result = await importPaths({ paths: [dropped, path.join(root, 'single.txt')], folderId: 'F', libraryPath: '/Mock.library' });
  assert.equal(result.rejected.length, 0);
  assert.equal(result.count, 5);
  const imported = calls.flatMap(call => call.paths).map(p => path.relative(root, p)).sort();
  assert.deepEqual(imported, [
    'shoot/a.jpg', 'shoot/b.png', 'shoot/nested/c.gif', 'shoot/nested/deeper/d.webp', 'single.txt'
  ].sort());
});

test('deep nesting stops at the depth limit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-folder-depth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let dir = path.join(root, 'drop');
  for (let level = 1; level <= 10; level += 1) {
    dir = path.join(dir, `level${level}`);
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'too-deep.png'), 'x');
  let shallow = path.join(root, 'drop');
  for (let level = 1; level <= 6; level += 1) shallow = path.join(shallow, `level${level}`);
  await fs.writeFile(path.join(shallow, 'ok.png'), 'x');

  const { files, truncated } = await collectDirectoryFiles(path.join(root, 'drop'), () => 2000);
  assert.equal(truncated, false);
  assert.deepEqual(files.map(p => path.basename(p)), ['ok.png']);
});

test('a folder with too many files is truncated and reported', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-folder-cap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dropped = path.join(root, 'big');
  await fs.mkdir(dropped);
  for (let index = 0; index < 12; index += 1) {
    await fs.writeFile(path.join(dropped, `file${String(index).padStart(2, '0')}.png`), 'x');
  }

  const budget = 10;
  const { files, truncated } = await collectDirectoryFiles(dropped, () => budget);
  assert.equal(truncated, true);
  assert.equal(files.length, budget);

  const calls = [];
  const importPaths = makeService(calls);
  const result = await importPaths({ paths: [dropped], folderId: null, libraryPath: '/Mock.library' });
  assert.equal(result.count, 12, 'real cap is 2000 so nothing is dropped here');
  assert.equal(result.rejected.length, 0);
});

test('empty folders are rejected with a clear message', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-folder-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dropped = path.join(root, 'empty');
  await fs.mkdir(dropped);
  const calls = [];
  const importPaths = makeService(calls);
  const result = await importPaths({ paths: [dropped], folderId: null, libraryPath: '/Mock.library' });
  assert.equal(result.count, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].message, '文件夹内没有可导入的文件');
  assert.equal(calls.length, 0);
});
