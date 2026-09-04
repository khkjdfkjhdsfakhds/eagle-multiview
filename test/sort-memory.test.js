'use strict';

// Batch 3: per-folder sort memory, stored in MultiView's own storage and
// never in the Eagle library.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSortMemory, rememberCascade, STORAGE_KEY, SORT_CASCADE_KEY, MAX_VIEWS_PER_LIBRARY } = require('../src/sort-memory');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

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

test('the view chokepoint restores memory and sort changes persist through one helper', () => {
  assert.ok(html.includes('<script src="sort-memory.js"></script>'));
  const applyStart = renderer.indexOf('function applyView(view)');
  const applyFn = renderer.slice(applyStart, renderer.indexOf('\n}', applyStart));
  assert.ok(applyFn.includes('sortMemory.recall(state.library?.path, descriptorKey(view))'),
    'restore must live in applyView so every navigation path gets it');
  assert.ok(applyFn.includes("state.sort = remembered?.sort || 'default';"));
  const commitStart = renderer.indexOf('function commitSortChange()');
  const commitFn = renderer.slice(commitStart, renderer.indexOf('\n}', commitStart));
  assert.ok(commitFn.includes('sortMemory.remember(state.library?.path, descriptorKey(state.currentView), state.sort, state.sortDir, Date.now())'));
  // The sort select, the direction toggle, and the toggle's reshuffle branch
  // when the sort is 随机 — every path that changes the order.
  assert.equal((renderer.match(/commitSortChange\(\);/g) || []).length, 3,
    'every sort change goes through the helper');
});

test('the parsed store is cached and can be invalidated by other windows', () => {
  const storage = fakeStorage();
  let reads = 0;
  const counting = { getItem: key => { reads += 1; return storage.getItem(key); }, setItem: storage.setItem };
  const memory = createSortMemory(counting);
  memory.remember('/A.library', 'folder:F1', 'name', 'desc', 1);
  memory.recall('/A.library', 'folder:F1');
  memory.recall('/A.library', 'folder:F1');
  assert.equal(reads, 1, 'recall must reuse the cached parse');
  memory.invalidate();
  memory.recall('/A.library', 'folder:F1');
  assert.equal(reads, 2, 'invalidate must force a fresh read');
  assert.ok(renderer.includes("window.addEventListener('storage'"), 'cross-window updates must invalidate the cache');
});

test('rememberCascade writes sort preference for parent folder and all descendants', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  const foldersTree = [
    {
      id: 'F1',
      name: 'Folder 1',
      children: [
        {
          id: 'F1_1',
          name: 'Folder 1.1',
          children: [
            { id: 'F1_1_1', name: 'Folder 1.1.1' }
          ]
        },
        { id: 'F1_2', name: 'Folder 1.2' }
      ]
    },
    {
      id: 'F2',
      name: 'Folder 2',
      children: [
        { id: 'F2_1', name: 'Folder 2.1' }
      ]
    }
  ];

  const updatedIds = memory.rememberCascade('/A.library', 'F1', foldersTree, 'rating', 'asc', 100);
  assert.deepEqual(updatedIds.sort(), ['F1', 'F1_1', 'F1_1_1', 'F1_2'].sort());

  assert.deepEqual(memory.recall('/A.library', 'folder:F1'), { sort: 'rating', sortDir: 'asc' });
  assert.deepEqual(memory.recall('/A.library', 'folder:F1_1'), { sort: 'rating', sortDir: 'asc' });
  assert.deepEqual(memory.recall('/A.library', 'folder:F1_1_1'), { sort: 'rating', sortDir: 'asc' });
  assert.deepEqual(memory.recall('/A.library', 'folder:F1_2'), { sort: 'rating', sortDir: 'asc' });

  // Sibling folders must not be touched
  assert.equal(memory.recall('/A.library', 'folder:F2'), null);
  assert.equal(memory.recall('/A.library', 'folder:F2_1'), null);

  // Cascading default reset clears entries
  memory.rememberCascade('/A.library', 'folder:F1', foldersTree, 'default', 'auto', 200);
  assert.equal(memory.recall('/A.library', 'folder:F1'), null);
  assert.equal(memory.recall('/A.library', 'folder:F1_1'), null);
  assert.equal(memory.recall('/A.library', 'folder:F1_1_1'), null);
  assert.equal(memory.recall('/A.library', 'folder:F1_2'), null);
});

test('exported top-level rememberCascade helper works with storage or memory instance', () => {
  const storage = fakeStorage();
  const tree = [{ id: 'F10', children: [{ id: 'F11' }] }];
  rememberCascade(storage, '/A.library', 'F10', tree, 'size', 'desc', 123);
  const memory = createSortMemory(storage);
  assert.deepEqual(memory.recall('/A.library', 'folder:F10'), { sort: 'size', sortDir: 'desc' });
  assert.deepEqual(memory.recall('/A.library', 'folder:F11'), { sort: 'size', sortDir: 'desc' });
});

test('sort controls include cascade checkbox in markup, scoping, and event bindings', () => {
  assert.ok(renderer.includes('id="sortCascadeCheck"'), 'markup includes cascade checkbox');
  assert.ok(renderer.includes("'#sortCascadeCheck'"), 'cascade check is pane-scoped');
  assert.ok(renderer.includes('id="sortPopover"'), 'markup includes sort popover');
  assert.ok(renderer.includes('sortMemory.rememberCascade('), 'cascade checkbox invokes rememberCascade');
  assert.match(styles, /\.sort-popover\s*\{/, 'styles define .sort-popover');
  assert.match(styles, /\.sort-cascade-check\s*\{/, 'styles define .sort-cascade-check');
});

test('sort cascade preference key is exported and renderer wires persistence and storage events', () => {
  assert.equal(SORT_CASCADE_KEY, 'eaglemv.sortCascade');
  assert.ok(renderer.includes('SORT_CASCADE_KEY'), 'renderer defines SORT_CASCADE_KEY');
  assert.ok(renderer.includes('setSortCascadeEnabled'), 'renderer includes setSortCascadeEnabled helper');
  assert.ok(renderer.includes('localStorage.setItem(SORT_CASCADE_KEY'), 'saves sort cascade preference');
  assert.ok(renderer.includes('localStorage.getItem(SORT_CASCADE_KEY'), 'reads sort cascade preference');
});

test('recallFolderSort falls back to closest ancestor sort when cascade is enabled', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  const foldersTree = [
    {
      id: 'ParentFolder',
      name: 'Parent',
      children: [
        {
          id: 'NewSubFolder',
          name: 'New Sub'
        }
      ]
    }
  ];

  memory.remember('/A.library', 'folder:ParentFolder', 'rating', 'asc', 100);

  // Without cascade enabled: returns null for new subfolder with no explicit sort
  assert.equal(memory.recallFolderSort('/A.library', 'NewSubFolder', foldersTree, false), null);

  // With cascade enabled: inherits parent sort
  assert.deepEqual(memory.recallFolderSort('/A.library', 'NewSubFolder', foldersTree, true), {
    sort: 'rating',
    sortDir: 'asc'
  });
});

test('recallFolderSort traverses deep ancestor chains to find the closest sort preference', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  const foldersTree = [
    {
      id: 'GrandParent',
      children: [
        {
          id: 'Parent',
          children: [
            {
              id: 'Child',
              children: [
                { id: 'GrandChild' }
              ]
            }
          ]
        },
        {
          id: 'SiblingParent',
          children: [{ id: 'SiblingChild' }]
        }
      ]
    }
  ];

  // Set sort at GrandParent
  memory.remember('/A.library', 'folder:GrandParent', 'size', 'desc', 10);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'GrandChild', foldersTree, true), {
    sort: 'size',
    sortDir: 'desc'
  });

  // Override sort at Parent
  memory.remember('/A.library', 'folder:Parent', 'name', 'asc', 20);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'GrandChild', foldersTree, true), {
    sort: 'name',
    sortDir: 'asc'
  });

  // Sibling branch still inherits from GrandParent
  assert.deepEqual(memory.recallFolderSort('/A.library', 'SiblingChild', foldersTree, true), {
    sort: 'size',
    sortDir: 'desc'
  });

  // Without cascade enabled, none of them inherit
  assert.equal(memory.recallFolderSort('/A.library', 'GrandChild', foldersTree, false), null);
  assert.equal(memory.recallFolderSort('/A.library', 'SiblingChild', foldersTree, false), null);
});

test('recallFolderSort handles nonexistent folders, null inputs, and missing library safely', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  assert.equal(memory.recallFolderSort('', 'F1', [], true), null);
  assert.equal(memory.recallFolderSort('/A.library', '', [], true), null);
  assert.equal(memory.recallFolderSort('/A.library', 'NotFound', [], true), null);
  assert.equal(memory.recallFolderSort('/A.library', 'NotFound', null, true), null);
});

test('newly added child folder dynamically reflects parent sort changes when cascade is enabled', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  const foldersTree = [
    {
      id: 'Parent',
      children: [{ id: 'NewChild' }]
    }
  ];

  // Set sort at Parent
  memory.remember('/A.library', 'folder:Parent', 'date', 'desc', 10);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'NewChild', foldersTree, true), {
    sort: 'date',
    sortDir: 'desc'
  });

  // When Parent sort changes, NewChild dynamically reflects the change without static record
  memory.remember('/A.library', 'folder:Parent', 'rating', 'asc', 20);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'NewChild', foldersTree, true), {
    sort: 'rating',
    sortDir: 'asc'
  });
});
