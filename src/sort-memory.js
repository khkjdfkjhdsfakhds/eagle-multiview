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
  //
  // 包含子文件夹 stores one subtree marker (`cascade:folder:<id>`) instead of
  // copying the sort onto every descendant: large trees would otherwise blow
  // through the per-library cap and evict the parent, so subfolders silently
  // fell back to a grandparent's sort. A folder resolves to the newest of its
  // own entry and the markers on itself and its ancestors, which also covers
  // subfolders created after the sort was applied.
  const CASCADE_PREFIX = 'cascade:';

  function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
      sort: typeof entry.sort === 'string' && entry.sort ? entry.sort : 'default',
      sortDir: entry.sortDir === 'asc' || entry.sortDir === 'desc' ? entry.sortDir : 'auto',
      at: Number(entry.at) || 0
    };
  }

  function parentMap(tree) {
    const parents = new Map();
    const walk = (nodes, parent) => {
      for (const node of nodes || []) {
        if (!node?.id) continue;
        parents.set(node.id, parent);
        walk(node.children, node.id);
      }
    };
    walk(Array.isArray(tree) ? tree : [tree], null);
    return parents;
  }

  function ancestorIds(parents, id) {
    const chain = [];
    for (let parent = parents.get(id); parent && !chain.includes(parent); parent = parents.get(parent)) chain.push(parent);
    return chain;
  }

  function pruneLibrary(library, foldersTree = null) {
    // Markers and per-view entries are capped separately so a burst of view
    // entries can never evict the marker a whole subtree depends on.
    for (const markers of [false, true]) {
      const keys = Object.keys(library).filter(key => key.startsWith(CASCADE_PREFIX) === markers);
      if (keys.length <= MAX_VIEWS_PER_LIBRARY) continue;
      const at = key => Number(library[key].at) || 0;
      // Eagle keeps every folder's own sort on the folder. Here an evicted
      // choice inside a 包含子文件夹 subtree silently took the subtree's sort
      // again (S-09), so those go last: first entries a marker on the same
      // folder already repeats, then the rest oldest first.
      let rank = () => 1;
      if (!markers) {
        const parents = foldersTree ? parentMap(foldersTree) : null;
        rank = key => {
          if (!key.startsWith('folder:')) return 1;
          const id = key.slice('folder:'.length);
          const own = library[`${CASCADE_PREFIX}folder:${id}`];
          if (own && own.sort === library[key].sort && own.sortDir === library[key].sortDir) return 0;
          const covered = own || (parents && ancestorIds(parents, id).some(parent => library[`${CASCADE_PREFIX}folder:${parent}`]));
          return covered ? 2 : 1;
        };
      }
      keys.sort((a, b) => (rank(a) - rank(b)) || (at(a) - at(b)));
      for (const key of keys.slice(0, keys.length - MAX_VIEWS_PER_LIBRARY)) delete library[key];
    }
  }

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

    // Writes start from what storage holds now, not this window's cached
    // parse, so a change another window made a moment ago is kept (S-09).
    function fresh() {
      cache = null;
      return read();
    }

    function recall(libraryPath, viewKey) {
      if (!libraryPath || !viewKey) return null;
      const entry = normalizeEntry(read()[String(libraryPath)]?.[String(viewKey)]);
      return entry ? { sort: entry.sort, sortDir: entry.sortDir } : null;
    }

    function recallFolderSort(libraryPath, folderId, foldersTree = null) {
      if (!libraryPath || !folderId) return null;
      const cleanId = String(folderId).replace(/^folder:/, '');
      if (!cleanId) return null;
      const library = read()[String(libraryPath)];
      if (!library || typeof library !== 'object') return null;
      let best = normalizeEntry(library[`folder:${cleanId}`]);
      const path = foldersTree ? findFolderPath(foldersTree, cleanId) : [];
      const chain = path.length ? path.map(node => node.id) : [cleanId];
      // Deepest first with a strict comparison: on equal timestamps the
      // folder's own choice, then the nearest marker, wins.
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const marker = normalizeEntry(library[`${CASCADE_PREFIX}folder:${chain[index]}`]);
        if (marker && (!best || marker.at > best.at)) best = marker;
      }
      return best ? { sort: best.sort, sortDir: best.sortDir } : null;
    }

    function remember(libraryPath, viewKey, sort, sortDir, now = 0, foldersTree = null) {
      if (!libraryPath || !viewKey) return;
      const data = fresh();
      const library = data[String(libraryPath)] || (data[String(libraryPath)] = {});
      const isDefault = (!sort || sort === 'default') && (!sortDir || sortDir === 'auto');
      // Under a subtree marker, 默认 is a real override of the inherited sort
      // and has to be stored instead of dropped. With the folder tree, only a
      // marker on the folder or an ancestor counts (S-09).
      const keepDefault = String(viewKey).startsWith('folder:') && (() => {
        const markers = Object.keys(library).filter(key => key.startsWith(CASCADE_PREFIX));
        if (!markers.length) return false;
        if (!foldersTree) return true;
        const cleanId = String(viewKey).slice('folder:'.length);
        const chain = findFolderPath(foldersTree, cleanId).map(node => node.id);
        return (chain.length ? chain : [cleanId]).some(id => Object.hasOwn(library, `${CASCADE_PREFIX}folder:${id}`));
      })();
      if (isDefault && !keepDefault) delete library[String(viewKey)];
      else library[String(viewKey)] = { sort: sort || 'default', sortDir: sortDir || 'auto', at: Number(now) || 0 };
      pruneLibrary(library, foldersTree);
      if (!Object.keys(library).length) delete data[String(libraryPath)];
      write(data);
    }

    function rememberCascade(libraryPath, parentFolderId, foldersTree, sort, sortDir, now = 0) {
      if (!libraryPath || !parentFolderId) return [];
      const cleanId = String(parentFolderId).replace(/^folder:/, '');
      if (!cleanId) return [];
      const node = findFolderNode(foldersTree, cleanId);
      const ids = node ? collectFolderIds(node) : [cleanId];
      const data = fresh();
      const library = data[String(libraryPath)] || (data[String(libraryPath)] = {});
      // Older choices inside the subtree are superseded; dropping them keeps
      // the store small and the result independent of timestamps.
      for (const id of ids.slice(1)) {
        delete library[`folder:${id}`];
        delete library[`${CASCADE_PREFIX}folder:${id}`];
      }
      const entry = { sort: sort || 'default', sortDir: sortDir || 'auto', at: Number(now) || 0 };
      library[`${CASCADE_PREFIX}folder:${cleanId}`] = entry;
      library[`folder:${cleanId}`] = { ...entry };
      pruneLibrary(library, foldersTree);
      write(data);
      return ids;
    }

    // A folder moved out of a 包含子文件夹 subtree kept no sort of its own and
    // fell back to its new ancestors' (S-09); in Eagle a folder's sort stays
    // with it. The newest marker it lost moves onto it, with its timestamp,
    // so the folder and its subfolders resolve as before the move.
    function followMovedFolders(libraryPath, previousTree, nextTree) {
      if (!libraryPath || !previousTree || !nextTree) return [];
      const before = parentMap(previousTree);
      const after = parentMap(nextTree);
      const moved = [...after.keys()].filter(id => before.has(id) && before.get(id) !== after.get(id));
      if (!moved.length) return [];
      const data = fresh();
      const library = data[String(libraryPath)];
      if (!library || !Object.keys(library).some(key => key.startsWith(CASCADE_PREFIX))) return [];
      const followed = [];
      for (const id of moved) {
        const kept = new Set(ancestorIds(after, id));
        const lost = ancestorIds(before, id).filter(parent => !kept.has(parent))
          .map(parent => normalizeEntry(library[`${CASCADE_PREFIX}folder:${parent}`])).filter(Boolean);
        if (!lost.length) continue;
        const newest = lost.reduce((left, right) => (right.at > left.at ? right : left));
        const own = normalizeEntry(library[`${CASCADE_PREFIX}folder:${id}`]);
        if (own && own.at >= newest.at) continue;
        library[`${CASCADE_PREFIX}folder:${id}`] = { sort: newest.sort, sortDir: newest.sortDir, at: newest.at };
        followed.push(id);
      }
      if (!followed.length) return [];
      pruneLibrary(library, nextTree);
      write(data);
      return followed;
    }

    function cloneFolders(libraryPath, folderMap, now = 0) {
      if (!libraryPath || !folderMap || typeof folderMap !== 'object') return;
      const data = fresh();
      const source = data[String(libraryPath)];
      if (!source) return;
      const timestamp = Number(now) || Date.now();
      const library = data[String(libraryPath)] = { ...source };
      for (const [sourceId, targetId] of Object.entries(folderMap)) {
        for (const prefix of ['', CASCADE_PREFIX]) {
          const entry = library[`${prefix}folder:${sourceId}`];
          if (entry) library[`${prefix}folder:${targetId}`] = { ...entry, at: timestamp };
        }
      }
      pruneLibrary(library);
      write(data);
    }

    return { recall, recallFolderSort, remember, rememberCascade, cloneFolders, followMovedFolders, invalidate };
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
