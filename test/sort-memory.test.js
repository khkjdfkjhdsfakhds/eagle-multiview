'use strict';

// Batch 3: per-folder sort memory, stored in MultiView's own storage and
// never in the Eagle library.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSortMemory, STORAGE_KEY, MAX_VIEWS_PER_LIBRARY } = require('../src/sort-memory');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => JSON.parse(map.get(STORAGE_KEY) || '{}')
  };
}

test('remembers and recalls the sort per library and view', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  memory.remember('/A.library', 'folder:F1', 'rating', 'asc', 111);
  memory.remember('/B.library', 'folder:F1', 'name', 'auto', 222);
  assert.deepEqual(memory.recall('/A.library', 'folder:F1'), { sort: 'rating', sortDir: 'asc' });
  assert.deepEqual(memory.recall('/B.library', 'folder:F1'), { sort: 'name', sortDir: 'auto' });
  assert.equal(memory.recall('/A.library', 'folder:F2'), null);
  assert.equal(memory.recall('', 'folder:F1'), null);
});

test('resetting a view to Eagle order removes its entry', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  memory.remember('/A.library', 'folder:F1', 'size', 'desc', 1);
  memory.remember('/A.library', 'folder:F1', 'default', 'auto', 2);
  assert.equal(memory.recall('/A.library', 'folder:F1'), null);
  assert.deepEqual(storage.dump(), {});
});

test('corrupted storage and junk entries degrade to defaults', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: '{not json' });
  const memory = createSortMemory(storage);
  assert.equal(memory.recall('/A.library', 'folder:F1'), null);
  memory.remember('/A.library', 'folder:F1', 'rating', 'sideways', 5);
  assert.deepEqual(memory.recall('/A.library', 'folder:F1'), { sort: 'rating', sortDir: 'auto' });
});

test('oldest views are pruned past the per-library cap', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  for (let index = 0; index <= MAX_VIEWS_PER_LIBRARY; index += 1) {
    memory.remember('/A.library', `folder:F${index}`, 'name', 'desc', index);
  }
  assert.equal(memory.recall('/A.library', 'folder:F0'), null, 'oldest entry evicted');
  assert.deepEqual(memory.recall('/A.library', `folder:F${MAX_VIEWS_PER_LIBRARY}`), { sort: 'name', sortDir: 'desc' });
  assert.equal(Object.keys(storage.dump()['/A.library']).length, MAX_VIEWS_PER_LIBRARY);
});

test('renderer restores memory on navigation and records sort changes', () => {
  assert.ok(html.includes('<script src="sort-memory.js"></script>'));
  const navigateStart = renderer.indexOf('function navigate(view');
  const navigateFn = renderer.slice(navigateStart, navigateStart + 1800);
  assert.ok(navigateFn.includes('sortMemory.recall(state.library?.path, descriptorKey(view))'));
  assert.ok(navigateFn.includes("state.sort = remembered?.sort || 'default';"));
  assert.equal((renderer.match(/sortMemory\.remember\(state\.library\?\.path, descriptorKey\(state\.currentView\), state\.sort, state\.sortDir, Date\.now\(\)\)/g) || []).length, 2,
    'both the sort select and the direction toggle must persist');
});
