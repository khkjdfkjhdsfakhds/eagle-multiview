'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createImportService, normalizeAddedIds } = require('../lib/import-service');

test('normalizes Eagle single and batch import responses', () => {
  assert.deepEqual(normalizeAddedIds({ id: 'A' }), ['A']);
  assert.deepEqual(normalizeAddedIds({ ids: ['A', 'B'] }), ['A', 'B']);
  assert.deepEqual(normalizeAddedIds(['A']), ['A']);
});

test('imports only real files to the requested folder and reports readiness', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first.png');
  const second = path.join(root, 'second.txt');
  const directory = path.join(root, 'folder');
  await fs.writeFile(first, 'png');
  await fs.writeFile(second, 'text');
  await fs.mkdir(directory);

  const calls = [];
  const client = {
    async addItems(paths, folderId) {
      calls.push({ paths, folderId });
      return { ids: ['A', 'B'] };
    },
    async getItems(ids) { return ids.map(id => ({ id })); }
  };
  const invalidations = [];
  const itemCache = new Map();
  const importPaths = createImportService({
    client,
    ensureLibraryPath: async value => assert.equal(value, '/Mock.library'),
    onInvalidate: value => invalidations.push(value),
    itemCache
  });
  const result = await importPaths({ paths: [first, second, directory, first], folderId: 'FOLDER', libraryPath: '/Mock.library' });
  assert.deepEqual(calls, [{ paths: [first, second], folderId: 'FOLDER' }]);
  assert.equal(result.count, 2);
  assert.equal(result.ready, 2);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(invalidations, ['items-import-accepted', 'items-imported']);
  assert.deepEqual([...itemCache.keys()], ['A', 'B']);
});
