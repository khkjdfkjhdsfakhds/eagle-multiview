'use strict';

(function exposePaneState(root, factory) {
  const querySpec = typeof module === 'object' && module.exports
    ? require('./query-spec')
    : root.EagleMVQuerySpec;
  const api = factory(querySpec);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVPanestate = api;
})(typeof window !== 'undefined' ? window : globalThis, querySpec => {
  // Query structure, defaults, and filter detection all derive from the
  // declarative field table in query-spec.js.
  const { createQuery, filtersActive, filterCount, normalizeRange } = querySpec;

  function cloneQuery(source) {
    return createQuery(source);
  }

  function queryWithoutSearch(source) {
    return createQuery({ ...source, search: '' });
  }

  // A lazy-load page appends to the end when the already-rendered ids form an
  // exact prefix of the next list; anything else (reorder, shrink, in-place
  // change) needs a full grid rebuild.
  function appendableTailCount(renderedIds, items) {
    if (!Array.isArray(renderedIds) || !renderedIds.length) return -1;
    if (!Array.isArray(items) || items.length <= renderedIds.length) return -1;
    for (let index = 0; index < renderedIds.length; index += 1) {
      if (items[index]?.id !== renderedIds[index]) return -1;
    }
    return items.length - renderedIds.length;
  }

  // Ascending base comparators; direction is applied as a factor so every
  // sort key stays stable (equal keys keep Eagle's original order).
  const sortComparators = {
    name: (a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-CN'),
    // Eagle separates 添加日期 from 修改日期: btime is when the item entered the
    // library, modificationTime is when the file itself last changed. They are
    // genuinely different orders — an old file imported today sorts first by
    // one and last by the other.
    added: (a, b) => (a?.btime || 0) - (b?.btime || 0),
    newest: (a, b) => (a?.modificationTime || 0) - (b?.modificationTime || 0),
    size: (a, b) => (a?.size || 0) - (b?.size || 0),
    resolution: (a, b) => ((a?.width || 0) * (a?.height || 0)) - ((b?.width || 0) * (b?.height || 0)),
    rating: (a, b) => (Number(a?.star) || 0) - (Number(b?.star) || 0),
    type: (a, b) => String(a?.ext || '').toLowerCase().localeCompare(String(b?.ext || '').toLowerCase(), 'en')
  };
  const defaultSortDirections = { name: 'asc', type: 'asc', added: 'desc', newest: 'desc', size: 'desc', resolution: 'desc', rating: 'desc' };

  // Eagle's 随机 sort. A shuffle has to be stable: the grid re-renders on every
  // lazy page and re-sorts each time, so drawing fresh randomness per compare
  // would reorder the view under the reader (and break the comparator's
  // transitivity). Ranking by a hash of (seed, id) is deterministic until the
  // seed changes, which is what "shuffle again" does.
  function randomRank(seed, id) {
    let hash = 0x811c9dc5;
    const source = `${seed ?? ''}:${id ?? ''}`;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  function defaultSortDir(sort) {
    return defaultSortDirections[sort] || 'asc';
  }

  function effectiveSortDir(sort, sortDir) {
    return sortDir === 'asc' || sortDir === 'desc' ? sortDir : defaultSortDir(sort);
  }

  function compareBySort(sort, sortDir, a, b, options = {}) {
    if (sort === 'random') {
      // Direction is meaningless for a shuffle; reversing it would just be
      // another arbitrary order, so the direction button reshuffles instead.
      const left = randomRank(options.seed, a?.id);
      const right = randomRank(options.seed, b?.id);
      return left === right ? 0 : (left < right ? -1 : 1);
    }
    const base = sortComparators[sort];
    if (!base) return 0;
    const result = base(a, b);
    if (result === 0) return 0;
    return effectiveSortDir(sort, sortDir) === 'desc' ? -result : result;
  }

  // Tags present on every given item, in first-item order (Eagle's multi-select
  // inspector shows the intersection).
  function sharedTags(items) {
    let shared = null;
    for (const item of items || []) {
      const tags = new Set((item?.tags || []).map(String));
      shared = shared === null ? tags : new Set([...shared].filter(tag => tags.has(tag)));
      if (!shared.size) break;
    }
    return [...(shared || [])];
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

  return { createQuery, cloneQuery, queryWithoutSearch, filtersActive, filterCount, normalizeRange, selectRange, defaultSortDir, effectiveSortDir, compareBySort, randomRank, sharedTags, appendableTailCount };
});
