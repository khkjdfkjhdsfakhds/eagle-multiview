'use strict';

(function exposePaneState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVPanestate = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function createQuery(source = {}) {
    return {
      folderId: source.folderId || null,
      smartFolderId: source.smartFolderId || null,
      search: String(source.search || ''),
      tags: [...new Set((source.tags || []).map(String).filter(Boolean))],
      ext: String(source.ext || ''),
      rating: Number.isInteger(source.rating) ? source.rating : null,
      annotation: String(source.annotation || ''),
      url: String(source.url || ''),
      shape: String(source.shape || '')
    };
  }

  function cloneQuery(source) {
    return createQuery(source);
  }

  function filtersActive(query) {
    const current = createQuery(query);
    return Boolean(current.search.trim() || current.tags.length || current.ext ||
      Number.isInteger(current.rating) || current.annotation.trim() || current.url.trim() || current.shape);
  }

  function filterCount(query) {
    const current = createQuery(query);
    return [
      current.search.trim(), current.tags.length, current.ext, Number.isInteger(current.rating),
      current.annotation.trim(), current.url.trim(), current.shape
    ].filter(Boolean).length;
  }

  function selectRange(items, selectedIds, targetId, additive = false) {
    const current = new Set(selectedIds || []);
    const targetIndex = (items || []).findIndex(item => item?.id === targetId);
    const anchorIndex = (items || []).findIndex(item => current.has(item?.id));
    const next = additive ? current : new Set();
    if (targetIndex < 0) return next;
    if (anchorIndex < 0) {
      next.add(targetId);
      return next;
    }
    for (let index = Math.min(anchorIndex, targetIndex); index <= Math.max(anchorIndex, targetIndex); index += 1) {
      const id = items[index]?.id;
      if (id) next.add(id);
    }
    return next;
  }

  return { createQuery, cloneQuery, filtersActive, filterCount, selectRange };
});
