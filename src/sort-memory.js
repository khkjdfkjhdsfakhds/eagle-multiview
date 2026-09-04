'use strict';

(function exposeSortMemory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVSortMemory = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const STORAGE_KEY = 'eaglemv.sortPrefs';
  const SORT_CASCADE_KEY = 'eaglemv.sortCascade';
  const MAX_VIEWS_PER_LIBRARY = 400;

  function findFolderNode(nodes, targetId) {
    if (!nodes || !targetId) return null;
    const list = Array.isArray(nodes) ? nodes : [nodes];
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      if (node.id === targetId) return node;
      const child = findFolderNode(node.children, targetId);
      if (child) return child;
    }
    return null;
  }

  function findFolderPath(nodes, targetId, trail = []) {
    if (!nodes || !targetId) return [];
    const list = Array.isArray(nodes) ? nodes : [nodes];
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      const next = [...trail, node];
      if (node.id === targetId) return next;
      const child = findFolderPath(node.children, targetId, next);
      if (child.length) return child;
    }
    return [];
  }

  function collectFolderIds(node) {
    if (!node || !node.id) return [];
    const ids = [node.id];
    const queue = [...(node.children || [])];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current && current.id) {
        ids.push(current.id);
        if (Array.isArray(current.children) && current.children.length > 0) {
          queue.push(...current.children);
        }
      }
    }
    return ids;
  }

  // Eagle remembers the sort per folder. MultiView keeps the same memory in
  // its own storage (never in the Eagle library), keyed by library path and
  // view descriptor; default-sorted views are dropped to keep the map small.
  function createSortMemory(storage) {
    // recall runs on every navigation; cache the parsed store and let other
    // windows invalidate it through the storage event.
    let cache = null;

    function read() {
      if (cache) return cache;
      try {
        const raw = storage.getItem(STORAGE_KEY);
        const data = raw ? JSON.parse(raw) : null;
        cache = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      } catch {
        cache = {};
      }
      return cache;
    }

    function write(data) {
      cache = data;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch {}
    }

    function invalidate() {
      cache = null;
    }

    function recall(libraryPath, viewKey) {
      if (!libraryPath || !viewKey) return null;
      const entry = read()[String(libraryPath)]?.[String(viewKey)];
      if (!entry || typeof entry !== 'object') return null;
      return {
        sort: typeof entry.sort === 'string' && entry.sort ? entry.sort : 'default',
        sortDir: entry.sortDir === 'asc' || entry.sortDir === 'desc' ? entry.sortDir : 'auto'
      };
    }

    function recallFolderSort(libraryPath, folderId, foldersTree = null, cascade = false) {
      if (!libraryPath || !folderId) return null;
      const cleanId = String(folderId).replace(/^folder:/, '');
      const direct = recall(libraryPath, `folder:${cleanId}`);
      if (direct) return direct;
      if (!cascade || !foldersTree) return null;
      const path = findFolderPath(foldersTree, cleanId);
      for (let i = path.length - 2; i >= 0; i--) {
        const ancestor = path[i];
        if (ancestor && ancestor.id) {
          const ancestorSort = recall(libraryPath, `folder:${ancestor.id}`);
          if (ancestorSort) return ancestorSort;
        }
      }
      return null;
    }

    function remember(libraryPath, viewKey, sort, sortDir, now = 0) {
      if (!libraryPath || !viewKey) return;
      const data = read();
      const library = data[String(libraryPath)] || (data[String(libraryPath)] = {});
      const isDefault = (!sort || sort === 'default') && (!sortDir || sortDir === 'auto');
      if (isDefault) delete library[String(viewKey)];
      else library[String(viewKey)] = { sort, sortDir, at: Number(now) || 0 };
      const keys = Object.keys(library);
      if (keys.length > MAX_VIEWS_PER_LIBRARY) {
        keys.sort((a, b) => (Number(library[a].at) || 0) - (Number(library[b].at) || 0));
        for (const key of keys.slice(0, keys.length - MAX_VIEWS_PER_LIBRARY)) delete library[key];
      }
      if (!Object.keys(library).length) delete data[String(libraryPath)];
      write(data);
    }

    function rememberCascade(libraryPath, parentFolderId, foldersTree, sort, sortDir, now = 0) {
      if (!libraryPath || !parentFolderId) return [];
      const cleanId = String(parentFolderId).replace(/^folder:/, '');
      if (!cleanId) return [];
      const node = findFolderNode(foldersTree, cleanId);
      const ids = node ? collectFolderIds(node) : [cleanId];
      const data = read();
      const library = data[String(libraryPath)] || (data[String(libraryPath)] = {});
      const isDefault = (!sort || sort === 'default') && (!sortDir || sortDir === 'auto');
      const timestamp = Number(now) || 0;
      for (const id of ids) {
        const viewKey = `folder:${id}`;
        if (isDefault) delete library[viewKey];
        else library[viewKey] = { sort, sortDir, at: timestamp };
      }
      const keys = Object.keys(library);
      if (keys.length > MAX_VIEWS_PER_LIBRARY) {
        keys.sort((a, b) => (Number(library[a].at) || 0) - (Number(library[b].at) || 0));
        for (const key of keys.slice(0, keys.length - MAX_VIEWS_PER_LIBRARY)) delete library[key];
      }
      if (!Object.keys(library).length) delete data[String(libraryPath)];
      write(data);
      return ids;
    }

    return { recall, recallFolderSort, remember, rememberCascade, invalidate };
  }

  function rememberCascade(storageOrMemory, libraryPath, parentFolderId, foldersTree, sort, sortDir, now = 0) {
    if (storageOrMemory && typeof storageOrMemory.rememberCascade === 'function') {
      return storageOrMemory.rememberCascade(libraryPath, parentFolderId, foldersTree, sort, sortDir, now);
    }
    if (storageOrMemory && (typeof storageOrMemory.getItem === 'function' || typeof storageOrMemory.setItem === 'function')) {
      const memory = createSortMemory(storageOrMemory);
      return memory.rememberCascade(libraryPath, parentFolderId, foldersTree, sort, sortDir, now);
    }
    const storage = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
    if (storage) {
      const memory = createSortMemory(storage);
      return memory.rememberCascade(libraryPath, parentFolderId, foldersTree, sort, sortDir, now);
    }
    return [];
  }

  return { createSortMemory, rememberCascade, findFolderPath, STORAGE_KEY, SORT_CASCADE_KEY, MAX_VIEWS_PER_LIBRARY };
});
