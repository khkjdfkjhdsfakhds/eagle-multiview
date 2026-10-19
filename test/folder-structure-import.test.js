'use strict';

// P4-01: 导入本地文件夹 keeps the folder structure, as Eagle 4.0's
// uploadFolderToSidebar / uploadFilesFromFolder do. Real directories on disk,
// a fake Eagle for the folder tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanFolderTree, importFolderTrees, FOLDER_IMPORT_CONFIRM_FILES } = require('../lib/folder-import');
const { prepareImportPaths } = require('../lib/import-service');

async function tempDir(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const names = node => ({ name: node.name, files: node.files.map(file => path.basename(file)), folders: node.folders.map(names) });

test('scans a folder into its structure; sub-folders in Eagle name order, hidden, links and libraries left out', async t => {
  const base = await tempDir(t, 'eaglemv-structure-');
  const root = path.join(base, '素材');
  await fs.mkdir(path.join(root, '第10章'), { recursive: true });
  await fs.mkdir(path.join(root, '第2章', '草图'), { recursive: true });
  await fs.mkdir(path.join(root, '空文件夹'));
  await fs.mkdir(path.join(root, '.hidden'));
  await fs.mkdir(path.join(root, 'Old.library'));
  await fs.writeFile(path.join(root, 'a.png'), 'a');
  await fs.writeFile(path.join(root, '.DS_Store'), 'x');
  await fs.writeFile(path.join(root, '第2章', 'b.jpg'), 'b');
  await fs.writeFile(path.join(root, '第2章', '草图', 'c.png'), 'c');
  await fs.writeFile(path.join(root, '第10章', 'd.png'), 'd');
  await fs.symlink(path.join(root, 'a.png'), path.join(root, 'link.png'));

  const scan = await scanFolderTree(root);
  assert.deepEqual(names(scan.tree), {
    name: '素材',
    files: ['a.png'],
    folders: [
      { name: '第2章', files: ['b.jpg'], folders: [{ name: '草图', files: ['c.png'], folders: [] }] },
      { name: '第10章', files: ['d.png'], folders: [] },
      { name: '空文件夹', files: [], folders: [] }
    ]
  });
  assert.equal(scan.fileCount, 4);
  assert.equal(scan.folderCount, 5);
  assert.equal(scan.depth, 3);
  assert.equal(scan.tooLarge, false);
  assert.equal(scan.needsConfirm, false);
  assert.ok(scan.skipped.some(entry => entry.path.endsWith('Old.library')));
});

test('a folder 15 levels deep is refused, as Eagle does; 14 levels are fine', async t => {
  const base = await tempDir(t, 'eaglemv-structure-depth-');
  let deep = path.join(base, 'L1');
  for (let level = 2; level <= 14; level += 1) deep = path.join(deep, `L${level}`);
  await fs.mkdir(deep, { recursive: true });
  const fourteen = await scanFolderTree(path.join(base, 'L1'));
  assert.equal(fourteen.depth, 14);
  assert.equal(fourteen.tooLarge, false);
  await fs.mkdir(path.join(deep, 'L15'));
  const fifteen = await scanFolderTree(path.join(base, 'L1'));
  assert.equal(fifteen.tooLarge, true);
});

test(`${FOLDER_IMPORT_CONFIRM_FILES} files or more ask first`, async t => {
  const root = await tempDir(t, 'eaglemv-structure-many-');
  await Promise.all(Array.from({ length: FOLDER_IMPORT_CONFIRM_FILES }, (_, index) => fs.writeFile(path.join(root, `f${index}.txt`), '')));
  const scan = await scanFolderTree(root);
  assert.equal(scan.fileCount, FOLDER_IMPORT_CONFIRM_FILES);
  assert.equal(scan.needsConfirm, true);
});

function fakeEagle({ appendReversed = false } = {}) {
  const folders = [];
  const byId = new Map();
  let next = 0;
  const calls = [];
  return {
    calls,
    folders,
    createFolder: async (name, parent) => {
      const folder = { id: `F${++next}`, name, children: [] };
      byId.set(folder.id, folder);
      const siblings = parent ? byId.get(parent).children : folders;
      if (appendReversed) siblings.unshift(folder); else siblings.push(folder);
      calls.push(['create', name, parent]);
      return folder.id;
    },
    readFolders: async () => structuredClone(folders),
    setOrder: async (parent, ids) => {
      calls.push(['order', parent, ids]);
      const holder = byId.get(parent);
      holder.children = ids.map(id => byId.get(id));
      return true;
    },
    importInto: async (files, folderId) => {
      calls.push(['import', files.map(file => path.basename(file)), folderId]);
      return { count: files.length, ready: files.length, ids: files.map((_, index) => `${folderId}-${index}`), rejected: [] };
    }
  };
}

const tree = (name, files = [], folders = []) => ({ dir: `/src/${name}`, name, files: files.map(file => `/src/${name}/${file}`), folders });

test('creates the same folders under the parent and imports each file into its own folder', async () => {
  const eagle = fakeEagle();
  const roots = [tree('素材', ['a.png'], [tree('第2章', ['b.jpg'], [tree('草图', ['c.png'])]), tree('空', [])])];
  const result = await importFolderTrees({ trees: roots, parentId: null, ...eagle });
  assert.deepEqual(eagle.calls, [
    ['create', '素材', null],
    ['create', '第2章', 'F1'],
    ['create', '草图', 'F2'],
    ['create', '空', 'F1'],
    ['import', ['a.png'], 'F1'],
    ['import', ['b.jpg'], 'F2'],
    ['import', ['c.png'], 'F3']
  ]);
  assert.deepEqual(result.rootIds, ['F1']);
  assert.equal(result.folders, 4);
  assert.equal(result.count, 3);
  assert.equal(result.error, null);
});

test('fixes the sub-folder order where Eagle did not keep it', async () => {
  const eagle = fakeEagle({ appendReversed: true });
  await importFolderTrees({ trees: [tree('A', [], [tree('1'), tree('2'), tree('3')])], ...eagle });
  const order = eagle.calls.find(call => call[0] === 'order');
  assert.deepEqual(order, ['order', 'F1', ['F2', 'F3', 'F4']]);
  assert.deepEqual(eagle.folders[0].children.map(folder => folder.name), ['1', '2', '3']);
});

test('a failure stops the run and reports what was done', async () => {
  const eagle = fakeEagle();
  const importInto = eagle.importInto;
  eagle.importInto = async (files, folderId) => {
    if (folderId === 'F2') throw Object.assign(new Error('资源库已切换'), { code: 'LIBRARY_CHANGED' });
    return importInto(files, folderId);
  };
  const result = await importFolderTrees({ trees: [tree('A', ['a.png'], [tree('B', ['b.png'], [tree('C', ['c.png'])])])], ...eagle });
  assert.equal(result.count, 1);
  assert.equal(result.folders, 3);
  assert.deepEqual(result.error, { message: '资源库已切换', code: 'LIBRARY_CHANGED' });
  assert.ok(!eagle.calls.some(call => call[0] === 'import' && call[2] === 'F3'));
});

test('a drop on a sidebar folder takes the files and leaves dropped folders out', async t => {
  const root = await tempDir(t, 'eaglemv-ignore-dirs-');
  await fs.mkdir(path.join(root, 'dir'));
  await fs.writeFile(path.join(root, 'dir', 'inner.png'), 'i');
  await fs.writeFile(path.join(root, 'top.png'), 't');
  const flat = await prepareImportPaths([path.join(root, 'dir'), path.join(root, 'top.png')]);
  assert.deepEqual(flat.paths.map(file => path.basename(file)).sort(), ['inner.png', 'top.png']);
  const filesOnly = await prepareImportPaths([path.join(root, 'dir'), path.join(root, 'top.png')], { ignoreDirectories: true });
  assert.deepEqual(filesOnly.paths.map(file => path.basename(file)), ['top.png']);
  assert.equal(filesOnly.ignoredDirectories, 1);
});
