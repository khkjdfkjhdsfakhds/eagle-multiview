'use strict';

// 导入本地文件夹 (P4-01), as Eagle 4.0 does it (`uploadFolderToSidebar`,
// `uploadFilesFromFolder`, `tree.helper.js`): a folder from Finder becomes an
// Eagle folder of the same name with the same sub-folder structure, and each
// file goes into the folder it sat in. Dropping onto the sidebar's blank area
// and the 导入本地文件夹 menu both put the new folders at the library root.

const fs = require('node:fs/promises');
const path = require('node:path');

// Eagle refuses a folder 15 levels deep or holding 100 000 files, and asks
// first from 2 000 files on.
const FOLDER_IMPORT_MAX_DEPTH = 15;
const FOLDER_IMPORT_MAX_FILES = 100000;
const FOLDER_IMPORT_CONFIRM_FILES = 2000;

// Eagle orders the new sub-folders by name with a numeric collator.
const folderCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function isLibraryPath(candidate) {
  return path.resolve(candidate).split(path.sep).some(segment => /\.library$/i.test(segment));
}

// Walks one folder. Hidden entries and symlinks are skipped, as in every other
// MultiView import; an Eagle library inside is skipped (E-20). The walk stops
// as soon as Eagle's limits are reached, so a huge tree is not read in full.
async function scanFolderTree(root) {
  const dir = path.resolve(root);
  const skipped = [];
  let fileCount = 0;
  let folderCount = 0;
  let depth = 1;
  let stopped = false;
  async function walk(node, level) {
    if (stopped) return;
    depth = Math.max(depth, level);
    if (depth >= FOLDER_IMPORT_MAX_DEPTH) { stopped = true; return; }
    let entries;
    try {
      entries = await fs.readdir(node.dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: node.dir, code: error.code || 'IMPORT_READ_FAILED', message: `未读取文件夹：${error.message}` });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const children = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(node.dir, entry.name);
      if (entry.isDirectory()) {
        if (isLibraryPath(full)) { skipped.push({ path: full, message: '不能导入 Eagle 资源库本身或其中的文件夹' }); continue; }
        children.push({ dir: full, name: entry.name, files: [], folders: [] });
      } else if (entry.isFile()) {
        node.files.push(full);
        fileCount += 1;
        if (fileCount >= FOLDER_IMPORT_MAX_FILES) { stopped = true; return; }
      }
    }
    children.sort((a, b) => folderCollator.compare(a.name, b.name));
    for (const child of children) {
      if (stopped) return;
      node.folders.push(child);
      folderCount += 1;
      await walk(child, level + 1);
    }
  }
  const tree = { dir, name: path.basename(dir), files: [], folders: [] };
  await walk(tree, 1);
  return {
    tree,
    depth,
    fileCount,
    folderCount: folderCount + 1,
    tooLarge: stopped,
    needsConfirm: !stopped && fileCount >= FOLDER_IMPORT_CONFIRM_FILES,
    skipped
  };
}

function walkTree(tree, visit, parent = null) {
  visit(tree, parent);
  for (const child of tree.folders) walkTree(child, visit, tree);
}

// Creates the folders of every tree under `parentId` (null: the library
// root), puts their sub-folders in name order, then imports each folder's
// files into it. `importInto` is the regular import with its duplicate
// decision and the folder's auto tags. A failure stops the run and reports
// what was already done.
async function importFolderTrees({ trees, parentId = null, createFolder, readFolders, setOrder, importInto, ensureCurrent = async () => {} }) {
  const created = new Map();
  const rootIds = [];
  const result = { folders: 0, count: 0, ready: 0, ids: [], rejected: [], unknown: [], notSubmitted: [], duplicateCount: 0, duplicateFailed: 0, nativeDecisionPending: false, error: null };
  try {
    for (const tree of trees) {
      const create = async (node, parent) => {
        await ensureCurrent();
        const id = await createFolder(node.name, parent);
        if (!id) throw new Error(`创建文件夹“${node.name}”后未获得文件夹 ID`);
        created.set(node, id);
        result.folders += 1;
        for (const child of node.folders) await create(child, id);
        return id;
      };
      rootIds.push(await create(tree, parentId));
    }
    // Eagle appends a created folder to its parent; confirm the name order of
    // every new folder's children and fix it where Eagle differs.
    const byId = new Map();
    const index = nodes => { for (const folder of nodes || []) { byId.set(folder.id, folder); index(folder.children); } };
    await ensureCurrent();
    index(await readFolders());
    for (const tree of trees) {
      const pending = [];
      walkTree(tree, node => { if (node.folders.length > 1) pending.push(node); });
      for (const node of pending) {
        const ids = node.folders.map(child => created.get(child));
        const actual = (byId.get(created.get(node))?.children || []).map(folder => folder.id);
        if (JSON.stringify(actual) === JSON.stringify(ids)) continue;
        if (!await setOrder(created.get(node), ids)) result.rejected.push({ path: node.dir, message: `“${node.name}”的子文件夹顺序未确认，请在 Eagle 里核对` });
      }
    }
    for (const tree of trees) {
      const nodes = [];
      walkTree(tree, node => { if (node.files.length) nodes.push(node); });
      for (const node of nodes) {
        await ensureCurrent();
        const imported = await importInto(node.files, created.get(node));
        result.count += imported.count || 0;
        result.ready += imported.ready || 0;
        result.ids.push(...(imported.ids || []));
        result.rejected.push(...(imported.rejected || []));
        result.unknown.push(...(imported.unknown || []));
        result.notSubmitted.push(...(imported.notSubmitted || []));
        result.duplicateCount += imported.duplicateCount || 0;
        result.duplicateFailed += imported.duplicateFailed || 0;
        if (imported.nativeDecisionPending) result.nativeDecisionPending = true;
        if (imported.error) throw imported.error;
      }
    }
  } catch (error) {
    result.error = { message: error.message, code: error.code };
  }
  return { ...result, rootIds };
}

module.exports = {
  FOLDER_IMPORT_CONFIRM_FILES,
  FOLDER_IMPORT_MAX_DEPTH,
  FOLDER_IMPORT_MAX_FILES,
  importFolderTrees,
  scanFolderTree
};
