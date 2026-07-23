'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function normalizeAddedIds(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.ids)) return result.ids;
  if (result?.id) return [result.id];
  return [];
}

async function waitForImportedItems(client, ids, timeoutMs = 12000, intervalMs = 350) {
  if (!ids.length) return [];
  const deadline = Date.now() + timeoutMs;
  const found = new Map();
  while (Date.now() < deadline && found.size < ids.length) {
    try {
      for (const item of await client.getItems(ids)) found.set(item.id, item);
    } catch {}
    if (found.size >= ids.length) break;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return [...found.values()];
}

function createImportService({ client, ensureLibraryPath, onInvalidate = () => {}, itemCache }) {
  return async function importPaths({ paths, folderId, libraryPath, waitTimeoutMs = 12000 }) {
    await ensureLibraryPath(libraryPath);
    const accepted = [];
    const rejected = [];
    for (const candidate of [...new Set(paths || [])]) {
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) throw new Error('暂不支持直接导入文件夹');
        accepted.push(path.resolve(candidate));
      } catch (error) {
        rejected.push({ path: candidate, message: error.message });
      }
    }
    if (!accepted.length) return { count: 0, ready: 0, ids: [], rejected };

    const ids = [];
    for (let index = 0; index < accepted.length; index += 200) {
      const result = await client.addItems(accepted.slice(index, index + 200), folderId);
      ids.push(...normalizeAddedIds(result));
    }
    onInvalidate('items-import-accepted');
    const readyItems = await waitForImportedItems(client, ids, waitTimeoutMs);
    for (const item of readyItems) itemCache?.set(item.id, item);
    onInvalidate('items-imported');
    return { count: accepted.length, ready: readyItems.length, ids, rejected };
  };
}

module.exports = { createImportService, normalizeAddedIds, waitForImportedItems };
