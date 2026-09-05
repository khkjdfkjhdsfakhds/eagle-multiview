'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function normalizeAddedIds(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.ids)) return result.ids;
  if (result?.id) return [result.id];
  return [];
}

async function waitForImportedItems(client, ids, timeoutMs = 1000, intervalMs = 200, ensureCurrent = async () => {}) {
  if (!ids.length) return [];
  const deadline = Date.now() + timeoutMs;
  const found = new Map();
  while (Date.now() < deadline && found.size < ids.length) {
    await ensureCurrent();
    try {
      const remaining = Math.max(100, deadline - Date.now());
      const items = await client.getItems(ids, { timeout: Math.min(500, remaining) });
      await ensureCurrent();
      for (const item of items) if (item?.id && !item.isDeleted) found.set(item.id, item);
    } catch (error) { if (error.code === 'LIBRARY_CHANGED') throw error; }
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
  const skipped = [];
  let truncated = false;
  async function walk(dir, depth) {
    if (truncated) return;
    if (depth > IMPORT_DIR_MAX_DEPTH) {
      skipped.push({ path: dir, code: 'IMPORT_DEPTH_LIMIT', message: `子目录超过 ${IMPORT_DIR_MAX_DEPTH} 层深度限制，未导入其中内容` });
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: dir, code: error.code || 'IMPORT_READ_FAILED', message: `未读取子目录：${error.message}` });
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
  return { files, truncated, skipped };
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
          const { files, truncated, skipped } = await collectDirectoryFiles(candidate, IMPORT_DIR_MAX_FILES - directoryFileCount);
          directoryFileCount += files.length;
          accepted.push(...files);
          rejected.push(...skipped);
          if (truncated) rejected.push({ path: candidate, message: `文件夹内容过多，本次仅导入前 ${IMPORT_DIR_MAX_FILES} 个文件` });
          else if (!files.length && !skipped.length) rejected.push({ path: candidate, message: '文件夹内没有可导入的文件' });
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
    const submitted = [];
    let unknown = [];
    let notSubmitted = [];
    let failure = null;
    for (let index = 0; index < uniqueAccepted.length; index += 200) {
      const batch = uniqueAccepted.slice(index, index + 200);
      try {
        await ensureLibraryPath(libraryPath);
      } catch (error) {
        failure = error;
        notSubmitted = uniqueAccepted.slice(index);
        break;
      }
      try {
        const result = await client.addItems(batch, folderId);
        ids.push(...normalizeAddedIds(result));
        submitted.push(...batch);
        onInvalidate('items-import-accepted');
      } catch (error) {
        // A timed-out request may have reached Eagle. Do not label it safe to
        // retry; retain accepted batches and distinguish these unknown paths.
        failure = error;
        unknown = batch;
        notSubmitted = uniqueAccepted.slice(index + batch.length);
        onInvalidate('items-import-uncertain');
        break;
      }
    }
    let readyItems = [];
    try {
      readyItems = await waitForImportedItems(client, ids, waitTimeoutMs, 200, () => ensureLibraryPath(libraryPath));
      await ensureLibraryPath(libraryPath);
      for (const item of readyItems) itemCache?.set(item.id, item);
    } catch (error) {
      failure ||= error;
      readyItems = [];
    }
    if (failure) rejected.push({
      code: failure.code || 'IMPORT_PARTIAL',
      message: `已确认提交 ${submitted.length} 个；结果待核对 ${unknown.length} 个；未提交 ${notSubmitted.length} 个。${failure.message}`,
      paths: [...unknown, ...notSubmitted]
    });
    onInvalidate('items-imported');
    return { count: submitted.length, ready: readyItems.length, ids, rejected,
      partial: Boolean(failure), submitted, unknown, notSubmitted,
      error: failure ? { code: failure.code || 'IMPORT_PARTIAL', message: failure.message } : null };
  };
}

module.exports = { createImportService, normalizeAddedIds, waitForImportedItems, collectDirectoryFiles };
