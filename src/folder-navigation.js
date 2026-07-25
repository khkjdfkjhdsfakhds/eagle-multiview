'use strict';

(function exposeFolderNavigation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVFolderNavigation = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function findFolder(nodes, id) {
    for (const folder of nodes || []) {
      if (folder.id === id) return folder;
      const child = findFolder(folder.children, id);
      if (child) return child;
    }
    return null;
  }

  function findFolderPath(nodes, id, trail = []) {
    for (const folder of nodes || []) {
      const next = [...trail, folder];
      if (folder.id === id) return next;
      const child = findFolderPath(folder.children, id, next);
      if (child.length) return child;
    }
    return [];
  }

  function normalizeView(nodes, view) {
    if (view.kind !== 'folder') return { ...view };
    const folder = findFolder(nodes, view.id);
    const path = findFolderPath(nodes, view.id);
    return {
      ...view,
      parentId: folder?.parent || path.at(-2)?.id || view.parentId || null
    };
  }

  function parentView(nodes, currentView) {
    if (currentView.kind !== 'folder') return null;
    const folder = findFolder(nodes, currentView.id);
    const path = findFolderPath(nodes, currentView.id);
    const parentId = folder?.parent || path.at(-2)?.id || (!folder ? currentView.parentId : null);
    if (parentId) return normalizeView(nodes, { kind: 'folder', id: parentId });
    return folder && path.length === 1 ? { kind: 'root' } : null;
  }

  function recordViewNavigation(history, historyIndex, currentView, nextView) {
    let entries = [...(history || [])];
    let index = Number.isInteger(historyIndex) ? historyIndex : -1;
    if (index < 0) {
      entries = [{ ...currentView }];
      index = 0;
    }
    entries = entries.slice(0, index + 1);
    entries.push({ ...nextView });
    return { history: entries, historyIndex: entries.length - 1 };
  }

  function folderMoveDelta(sourceFolderId, targetFolderId) {
    const source = sourceFolderId ? String(sourceFolderId) : '';
    const target = targetFolderId ? String(targetFolderId) : '';
    return {
      add: target ? [target] : [],
      remove: source && source !== target ? [source] : []
    };
  }

  function flattenFolders(nodes, trail = []) {
    const results = [];
    for (const folder of nodes || []) {
      const path = [...trail, folder.name || '未命名文件夹'];
      results.push({ id: folder.id, name: folder.name || '未命名文件夹', path: path.join(' / '), depth: trail.length });
      results.push(...flattenFolders(folder.children, path));
    }
    return results;
  }

  function searchFolders(nodes, query = '', { excludeId = null, limit = 100 } = {}) {
    const pageSize = Math.max(1, Number(limit) || 100);
    const all = flattenFolders(nodes).filter(folder => folder.id !== excludeId);
    const keyword = String(query || '').trim().toLocaleLowerCase('zh-CN');
    const matches = keyword
      ? all.filter(folder => folder.path.toLocaleLowerCase('zh-CN').includes(keyword))
      : all;
    return {
      results: matches.slice(0, pageSize),
      total: all.length,
      matched: matches.length,
      truncated: matches.length > pageSize
    };
  }

  return { findFolder, findFolderPath, normalizeView, parentView, recordViewNavigation, folderMoveDelta, flattenFolders, searchFolders };
});
