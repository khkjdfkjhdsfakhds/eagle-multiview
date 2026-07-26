'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function normalizeAddedIds(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.ids)) return result.ids;
  if (result?.id) return [result.id];
  return [];
}

async function waitForImportedItems(client, ids, timeoutMs = 1000, intervalMs = 200) {
  if (!ids.length) return [];
  const deadline = Date.now() + timeoutMs;
  const found = new Map();
  while (Date.now() < deadline && found.size < ids.length) {
    try {
      const remaining = Math.max(100, deadline - Date.now());
      for (const item of await client.getItems(ids, { timeout: Math.min(500, remaining) })) found.set(item.id, item);
    } catch {}
    if (found.size >= ids.length) break;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return [...found.values()];
}

const IMPORT_DIR_MAX_DEPTH = 8;
const IMPORT_DIR_MAX_FILES = 2000;

// Recursively collect importable files from a dropped folder. Hidden entries
// and symlinks are skipped; depth and the shared file budget keep a runaway
// directory (or a link cycle) from freezing the import.
async function collectDirectoryFiles(root, maxFiles) {
  const files = [];
  let truncated = false;
  async function walk(dir, depth) {
    if (truncated || depth > IMPORT_DIR_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) { truncated = true; return; }
        files.push(full);
      }
    }
  }
  await walk(path.resolve(root), 1);
  return { files, truncated };
}

function createImportService({ client, ensureLibraryPath, onInvalidate = () => {}, itemCache }) {
  return async function importPaths({ paths, folderId, libraryPath, waitTimeoutMs = 1000 }) {
    await ensureLibraryPath(libraryPath);
    const accepted = [];
    const rejected = [];
    let directoryFileCount = 0;
    for (const candidate of [...new Set(paths || [])]) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          const { files, truncated } = await collectDirectoryFiles(candidate, IMPORT_DIR_MAX_FILES - directoryFileCount);
          directoryFileCount += files.length;
          accepted.push(...files);
          if (truncated) rejected.push({ path: candidate, message: `文件夹内容过多，本次仅导入前 ${IMPORT_DIR_MAX_FILES} 个文件` });
          else if (!files.length) rejected.push({ path: candidate, message: '文件夹内没有可导入的文件' });
          continue;
        }
        if (!stat.isFile()) throw new Error('不支持导入该类型');
        accepted.push(path.resolve(candidate));
      } catch (error) {
        rejected.push({ path: candidate, message: error.message });
      }
    }
    const uniqueAccepted = [...new Set(accepted)];
    if (!uniqueAccepted.length) return { count: 0, ready: 0, ids: [], rejected };

    const ids = [];
    for (let index = 0; index < uniqueAccepted.length; index += 200) {
      const result = await client.addItems(uniqueAccepted.slice(index, index + 200), folderId);
      ids.push(...normalizeAddedIds(result));
    }
    onInvalidate('items-import-accepted');
    const readyItems = await waitForImportedItems(client, ids, waitTimeoutMs);
    for (const item of readyItems) itemCache?.set(item.id, item);
    onInvalidate('items-imported');
    return { count: uniqueAccepted.length, ready: readyItems.length, ids, rejected };
  };
}

module.exports = { createImportService, normalizeAddedIds, waitForImportedItems, collectDirectoryFiles };
