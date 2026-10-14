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

test('clones folder sort preferences onto copied folder ids', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  memory.remember('/A.library', 'folder:source', 'rating', 'desc', 111);
  memory.remember('/A.library', 'folder:source-child', 'name', 'asc', 112);
  memory.cloneFolders('/A.library', { source: 'copy', 'source-child': 'copy-child' }, 200);
  assert.deepEqual(memory.recall('/A.library', 'folder:copy'), { sort: 'rating', sortDir: 'desc' });
  assert.deepEqual(memory.recall('/A.library', 'folder:copy-child'), { sort: 'name', sortDir: 'asc' });
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
  assert.ok(applyFn.includes('const remembered = rememberedSortFor(view);'),
    'restore must live in applyView so every navigation path gets it');
  assert.ok(renderer.includes('sortMemory.recall(state.library?.path, descriptorKey(view))'));
  // A new pane skips applyView and reads the memory itself (B1-01).
  assert.ok(renderer.includes('const remembered = rememberedSortFor(currentView);'));
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

  for (const id of ['F1', 'F1_1', 'F1_1_1', 'F1_2']) {
    assert.deepEqual(memory.recallFolderSort('/A.library', id, foldersTree), { sort: 'rating', sortDir: 'asc' }, id);
  }

  // Sibling folders must not be touched
  assert.equal(memory.recallFolderSort('/A.library', 'F2', foldersTree), null);
  assert.equal(memory.recallFolderSort('/A.library', 'F2_1', foldersTree), null);

  // Cascading Eagle order resets the whole subtree
  memory.rememberCascade('/A.library', 'folder:F1', foldersTree, 'default', 'auto', 200);
  for (const id of ['F1', 'F1_1', 'F1_1_1', 'F1_2']) {
    assert.deepEqual(memory.recallFolderSort('/A.library', id, foldersTree), { sort: 'default', sortDir: 'auto' }, id);
  }
});

test('exported top-level rememberCascade helper works with storage or memory instance', () => {
  const storage = fakeStorage();
  const tree = [{ id: 'F10', children: [{ id: 'F11' }] }];
  rememberCascade(storage, '/A.library', 'F10', tree, 'size', 'desc', 123);
  const memory = createSortMemory(storage);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'F10', tree), { sort: 'size', sortDir: 'desc' });
  assert.deepEqual(memory.recallFolderSort('/A.library', 'F11', tree), { sort: 'size', sortDir: 'desc' });
});

test('exported top-level rememberCascade helper keeps arguments aligned with browser localStorage fallback', () => {
  const storage = fakeStorage();
  const tree = [{ id: 'F20', children: [{ id: 'F21' }] }];
  const previousWindow = global.window;
  global.window = { localStorage: storage };
  try {
    rememberCascade(null, '/B.library', 'F20', tree, 'rating', 'asc', 456);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
  const memory = createSortMemory(storage);
  assert.deepEqual(memory.recallFolderSort('/B.library', 'F20', tree), { sort: 'rating', sortDir: 'asc' });
  assert.deepEqual(memory.recallFolderSort('/B.library', 'F21', tree), { sort: 'rating', sortDir: 'asc' });
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

test('a sort chosen without 包含子文件夹 stays on that folder', () => {
  const memory = createSortMemory(fakeStorage());
  const tree = [{ id: 'Parent', children: [{ id: 'Child' }] }];
  memory.remember('/A.library', 'folder:Parent', 'rating', 'asc', 100);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'Parent', tree), { sort: 'rating', sortDir: 'asc' });
  assert.equal(memory.recallFolderSort('/A.library', 'Child', tree), null);
});

test('the newest of own choice and ancestor markers wins at every depth', () => {
  const memory = createSortMemory(fakeStorage());
  const tree = [{
    id: 'GrandParent',
    children: [
      { id: 'Parent', children: [{ id: 'Child', children: [{ id: 'GrandChild' }] }] },
      { id: 'SiblingParent', children: [{ id: 'SiblingChild' }] }
    ]
  }];
  memory.rememberCascade('/A.library', 'GrandParent', tree, 'size', 'desc', 10);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'GrandChild', tree), { sort: 'size', sortDir: 'desc' });

  memory.rememberCascade('/A.library', 'Parent', tree, 'name', 'asc', 20);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'GrandChild', tree), { sort: 'name', sortDir: 'asc' });
  assert.deepEqual(memory.recallFolderSort('/A.library', 'SiblingChild', tree), { sort: 'size', sortDir: 'desc' });

  // A later choice on one subfolder (without cascading) overrides only it.
  memory.remember('/A.library', 'folder:Child', 'rating', 'desc', 30);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'Child', tree), { sort: 'rating', sortDir: 'desc' });
  assert.deepEqual(memory.recallFolderSort('/A.library', 'GrandChild', tree), { sort: 'name', sortDir: 'asc' });

  // Re-applying from the top supersedes everything underneath.
  memory.rememberCascade('/A.library', 'GrandParent', tree, 'added', 'asc', 40);
  for (const id of ['GrandParent', 'Parent', 'Child', 'GrandChild', 'SiblingParent', 'SiblingChild']) {
    assert.deepEqual(memory.recallFolderSort('/A.library', id, tree), { sort: 'added', sortDir: 'asc' }, id);
  }
});

test('cascading Eagle order under a sorted grandparent does not inherit the grandparent sort', () => {
  const memory = createSortMemory(fakeStorage());
  const tree = [{ id: 'GrandParent', children: [{ id: 'Parent', children: [{ id: 'Child' }] }] }];
  memory.rememberCascade('/A.library', 'GrandParent', tree, 'size', 'desc', 10);
  memory.rememberCascade('/A.library', 'Parent', tree, 'default', 'auto', 20);
  memory.remember('/A.library', 'folder:Parent', 'default', 'auto', 21);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'Parent', tree), { sort: 'default', sortDir: 'auto' });
  assert.deepEqual(memory.recallFolderSort('/A.library', 'Child', tree), { sort: 'default', sortDir: 'auto' });
  // Resetting one folder to Eagle order is likewise a real override.
  memory.remember('/A.library', 'folder:GrandParent', 'default', 'auto', 30);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'GrandParent', tree), { sort: 'default', sortDir: 'auto' });
});

test('cascading over a subtree larger than the cap keeps every folder on the parent sort', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  const children = Array.from({ length: MAX_VIEWS_PER_LIBRARY * 3 }, (_, index) => ({ id: `C${index}`, children: [{ id: `C${index}_x` }] }));
  const tree = [{ id: 'GrandParent', children: [{ id: 'Parent', children }] }];
  memory.rememberCascade('/A.library', 'GrandParent', tree, 'size', 'desc', 10);
  memory.rememberCascade('/A.library', 'Parent', tree, 'name', 'asc', 20);
  for (const id of ['Parent', 'C0', 'C0_x', `C${children.length - 1}_x`]) {
    assert.deepEqual(memory.recallFolderSort('/A.library', id, tree), { sort: 'name', sortDir: 'asc' }, id);
  }
  // Unrelated view entries filling the cap must not evict the markers.
  for (let index = 0; index <= MAX_VIEWS_PER_LIBRARY; index += 1) {
    memory.remember('/A.library', `smart:S${index}`, 'rating', 'desc', 100 + index);
  }
  assert.deepEqual(memory.recallFolderSort('/A.library', 'C5_x', tree), { sort: 'name', sortDir: 'asc' });
  assert.ok(Object.keys(storage.dump()['/A.library']).length <= MAX_VIEWS_PER_LIBRARY * 2);
});

test('subfolders created after 包含子文件夹 follow the marker', () => {
  const memory = createSortMemory(fakeStorage());
  memory.rememberCascade('/A.library', 'Parent', [{ id: 'Parent' }], 'rating', 'asc', 10);
  const grown = [{ id: 'Parent', children: [{ id: 'NewChild', children: [{ id: 'NewGrandChild' }] }] }];
  assert.deepEqual(memory.recallFolderSort('/A.library', 'NewGrandChild', grown), { sort: 'rating', sortDir: 'asc' });
});

test('cloning a folder carries its subtree marker', () => {
  const memory = createSortMemory(fakeStorage());
  const tree = [{ id: 'src', children: [{ id: 'src-child' }] }, { id: 'copy', children: [{ id: 'copy-child' }] }];
  memory.rememberCascade('/A.library', 'src', tree, 'size', 'asc', 10);
  memory.cloneFolders('/A.library', { src: 'copy', 'src-child': 'copy-child' }, 20);
  assert.deepEqual(memory.recallFolderSort('/A.library', 'copy-child', tree), { sort: 'size', sortDir: 'asc' });
});

test('recallFolderSort handles nonexistent folders, null inputs, and missing library safely', () => {
  const storage = fakeStorage();
  const memory = createSortMemory(storage);
  assert.equal(memory.recallFolderSort('', 'F1', []), null);
  assert.equal(memory.recallFolderSort('/A.library', '', []), null);
  assert.equal(memory.recallFolderSort('/A.library', 'NotFound', []), null);
  assert.equal(memory.recallFolderSort('/A.library', 'NotFound', null), null);
});

