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

  // Pane order is visual order, not identity.  Keep the two concepts separate
  // so changing a layout can move an existing pane to a different DOM slot
  // without changing the state object that owns its path, history, and scroll.
  // The slot centres are normalized to the layout rectangle; this makes the
  // same coordinator work for desktop grids and the web client's stacked
  // presentation.
  const paneLayoutSpecs = Object.freeze({
    single: Object.freeze({
      count: 1,
      slots: Object.freeze([{ id: 'center', x: .5, y: .5 }])
    }),
    vertical2: Object.freeze({
      count: 2,
      slots: Object.freeze([{ id: 'left', x: .25, y: .5 }, { id: 'right', x: .75, y: .5 }])
    }),
    horizontal2: Object.freeze({
      count: 2,
      slots: Object.freeze([{ id: 'top', x: .5, y: .25 }, { id: 'bottom', x: .5, y: .75 }])
    }),
    grid4: Object.freeze({
      count: 4,
      slots: Object.freeze([
        { id: 'top-left', x: .25, y: .25 },
        { id: 'top-right', x: .75, y: .25 },
        { id: 'bottom-left', x: .25, y: .75 },
        { id: 'bottom-right', x: .75, y: .75 }
      ])
    }),
    leftStack: Object.freeze({
      count: 3,
      slots: Object.freeze([
        { id: 'left', x: .25, y: .5 },
        { id: 'right-top', x: .75, y: .25 },
        { id: 'right-bottom', x: .75, y: .75 }
      ])
    }),
    rightStack: Object.freeze({
      count: 3,
      slots: Object.freeze([
        { id: 'left-top', x: .25, y: .25 },
        { id: 'left-bottom', x: .25, y: .75 },
        { id: 'right', x: .75, y: .5 }
      ])
    }),
    topStack: Object.freeze({
      count: 3,
      slots: Object.freeze([
        { id: 'top', x: .5, y: .25 },
        { id: 'bottom-left', x: .25, y: .75 },
        { id: 'bottom-right', x: .75, y: .75 }
      ])
    }),
    bottomStack: Object.freeze({
      count: 3,
      slots: Object.freeze([
        { id: 'top-left', x: .25, y: .25 },
        { id: 'top-right', x: .75, y: .25 },
        { id: 'bottom', x: .5, y: .75 }
      ])
    }),
    horizontal3: Object.freeze({
      count: 3,
      slots: Object.freeze([{ id: 'top', x: .5, y: 1 / 6 }, { id: 'middle', x: .5, y: .5 }, { id: 'bottom', x: .5, y: 5 / 6 }])
    }),
    vertical3: Object.freeze({
      count: 3,
      slots: Object.freeze([{ id: 'left', x: 1 / 6, y: .5 }, { id: 'middle', x: .5, y: .5 }, { id: 'right', x: 5 / 6, y: .5 }])
    }),
    horizontal4: Object.freeze({
      count: 4,
      slots: Object.freeze([{ id: 'top', x: .5, y: .125 }, { id: 'upper-middle', x: .5, y: .375 }, { id: 'lower-middle', x: .5, y: .625 }, { id: 'bottom', x: .5, y: .875 }])
    }),
    vertical4: Object.freeze({
      count: 4,
      slots: Object.freeze([{ id: 'left', x: .125, y: .5 }, { id: 'upper-middle', x: .375, y: .5 }, { id: 'lower-middle', x: .625, y: .5 }, { id: 'right', x: .875, y: .5 }])
    })
  });

  function paneLayoutSpec(layout) {
    return paneLayoutSpecs[layout] || paneLayoutSpecs.single;
  }

  function paneRevealTargets(layout, panes, sourcePaneId, { stacked = false } = {}) {
    const list = Array.isArray(panes) ? panes : [];
    if (!list.some(pane => pane.id === sourcePaneId)) return [];
    const labels = {
      left: '左', right: '右', top: '上', bottom: '下', middle: '中',
      'top-left': '左上', 'left-top': '左上', 'top-right': '右上', 'right-top': '右上',
      'bottom-left': '左下', 'left-bottom': '左下', 'bottom-right': '右下', 'right-bottom': '右下',
      'upper-middle': layout === 'vertical4' ? '中左' : '中上',
      'lower-middle': layout === 'vertical4' ? '中右' : '中下'
    };
    const slots = paneLayoutSpec(layout).slots;
    return list.flatMap((pane, index) => pane.id === sourcePaneId ? [] : [{
      paneId: pane.id,
      label: stacked ? '第 ' + (index + 1) + ' 栏' : labels[slots[index]?.id] || '第 ' + (index + 1) + ' 栏'
    }]);
  }

  function paneCreationRank(pane, index) {
    const explicit = Number(pane?.creationOrder);
    if (Number.isFinite(explicit)) return explicit;
    const match = String(pane?.id || '').match(/(\d+)$/);
    return match ? Number(match[1]) : index;
  }

  function paneSlotDistance(sourceSlot, targetSlot) {
    const dx = sourceSlot.x - targetSlot.x;
    const dy = sourceSlot.y - targetSlot.y;
    return (dx * dx) + (dy * dy);
  }

  function assignmentIsEarlier(candidate, current) {
    if (!current) return true;
    for (let index = 0; index < candidate.length; index += 1) {
      if (candidate[index] !== current[index]) return candidate[index] < current[index];
    }
    return false;
  }

  // There are at most four panes.  Exhaustive matching keeps ties explicit and
  // deterministic: a single pane grows into the first slot, while two edge
  // panes grow into the two edge slots and leave the middle for the new pane.
  function matchPanesToSlots(entries, targetSlots) {
    let bestCost = Infinity;
    let bestAssignment = null;
    const COST_EPSILON = 1e-12;
    const usedSlots = new Set();
    const assignment = [];

    function visit(entryIndex, cost) {
      if (entryIndex >= entries.length) {
        if (cost < bestCost - COST_EPSILON || (Math.abs(cost - bestCost) <= COST_EPSILON && assignmentIsEarlier(assignment, bestAssignment))) {
          bestCost = cost;
          bestAssignment = [...assignment];
        }
        return;
      }
      const entry = entries[entryIndex];
      for (let targetIndex = 0; targetIndex < targetSlots.length; targetIndex += 1) {
        if (usedSlots.has(targetIndex)) continue;
        usedSlots.add(targetIndex);
        assignment.push(targetIndex);
        visit(entryIndex + 1, cost + paneSlotDistance(entry.slot, targetSlots[targetIndex]));
        assignment.pop();
        usedSlots.delete(targetIndex);
      }
    }

    visit(0, 0);
    return bestAssignment || [];
  }

  function uniquePaneEntries(panes, sourceSlots) {
    const seenIds = new Set();
    return (panes || []).reduce((entries, pane, index) => {
      if (!pane) return entries;
      const id = pane.id || `pane-${index + 1}`;
      if (seenIds.has(id)) return entries;
      seenIds.add(id);
      entries.push({ pane, index, id, rank: paneCreationRank(pane, index), slot: sourceSlots[index] || sourceSlots.at(-1) || paneLayoutSpecs.single.slots[0] });
      return entries;
    }, []);
  }

  /**
   * Reconcile pane objects with a new visual layout.
   *
   * Existing pane objects are returned unchanged and assigned to the closest
   * target slots.  On a reduction, non-active panes are retired from newest
   * to oldest first; this removes an inserted pane before an older edge pane,
   * while always preserving the active pane when one exists.  Missing target
   * slots are created through the callback, which receives only the active
   * source pane and the target slot.  The renderer uses that boundary to copy
   * currentView and deliberately reset every other per-pane field.
   */
  function coordinatePaneLayout({
    currentLayout = 'single',
    nextLayout = 'single',
    panes = [],
    activePaneId = null,
    createPane = null
  } = {}) {
    const sourceSlots = paneLayoutSpec(currentLayout).slots;
    const targetSpec = paneLayoutSpec(nextLayout);
    const entries = uniquePaneEntries(panes, sourceSlots);
    const keepCount = Math.min(entries.length, targetSpec.count);
    const activeEntry = entries.find(entry => entry.id === activePaneId);
    const removable = [...entries].sort((left, right) => {
      const leftActive = left.id === activePaneId;
      const rightActive = right.id === activePaneId;
      if (leftActive !== rightActive) return leftActive ? 1 : -1;
      if (left.rank !== right.rank) return right.rank - left.rank;
      return right.index - left.index;
    });
    const removed = new Set(removable.slice(0, Math.max(0, entries.length - keepCount)).map(entry => entry.id));
    if (activeEntry && removed.has(activeEntry.id)) {
      // This is only reachable when malformed input contains too few usable
      // entries or a duplicate id. Keep the active object and retire the
      // first deterministic non-active candidate instead.
      removed.delete(activeEntry.id);
      const replacement = removable.find(entry => entry.id !== activeEntry.id && !removed.has(entry.id));
      if (replacement) removed.add(replacement.id);
    }
    const retained = entries.filter(entry => !removed.has(entry.id));
    const assignment = matchPanesToSlots(retained, targetSpec.slots);
    const assignedByTarget = new Map();
    retained.forEach((entry, index) => assignedByTarget.set(assignment[index], entry));
    const activeSource = activeEntry?.pane || retained[0]?.pane || panes[0] || null;
    const created = [];
    const panesBySlot = targetSpec.slots.map((slot, targetIndex) => {
      const existing = assignedByTarget.get(targetIndex);
      if (existing) return existing.pane;
      if (typeof createPane !== 'function') return null;
      const pane = createPane({ slot, slotIndex: targetIndex, layout: nextLayout, source: activeSource });
      if (pane) created.push(pane);
      return pane || null;
    });
    const nextPanes = panesBySlot.filter(Boolean);
    const nextIds = new Set(nextPanes.map(pane => pane.id));
    const nextActivePaneId = activePaneId && nextIds.has(activePaneId)
      ? activePaneId
      : (nextPanes[0]?.id || null);

    return {
      layout: nextLayout,
      panes: nextPanes,
      activePaneId: nextActivePaneId,
      created,
      removed: entries.filter(entry => removed.has(entry.id)).map(entry => entry.pane),
      slots: targetSpec.slots.map((slot, index) => ({ ...slot, paneId: panesBySlot[index]?.id || null }))
    };
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

  function defaultSplitRatios(layout) {
    switch (layout) {
      case 'vertical2':
        return { cols: ['1fr', '1fr'], rows: ['1fr'] };
      case 'vertical3':
        return { cols: ['1fr', '1fr', '1fr'], rows: ['1fr'] };
      case 'vertical4':
        return { cols: ['1fr', '1fr', '1fr', '1fr'], rows: ['1fr'] };
      case 'horizontal2':
        return { cols: ['1fr'], rows: ['1fr', '1fr'] };
      case 'horizontal3':
        return { cols: ['1fr'], rows: ['1fr', '1fr', '1fr'] };
      case 'horizontal4':
        return { cols: ['1fr'], rows: ['1fr', '1fr', '1fr', '1fr'] };
      case 'grid4':
      case 'leftStack':
      case 'rightStack':
      case 'topStack':
      case 'bottomStack':
        return { cols: ['1fr', '1fr'], rows: ['1fr', '1fr'] };
      default:
        return { cols: ['1fr'], rows: ['1fr'] };
    }
  }

  function findFolderInTree(folders, id) {
    if (!id || !Array.isArray(folders)) return null;
    for (const folder of folders) {
      if (folder?.id === id) return folder;
      if (Array.isArray(folder?.children) && folder.children.length) {
        const found = findFolderInTree(folder.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  function validateSessionView(view, folders = [], smartFolders = []) {
    if (!view || typeof view !== 'object') return { kind: 'root' };
    if (view.kind === 'folder') {
      const exists = findFolderInTree(folders, view.id);
      return exists ? { kind: 'folder', id: view.id } : { kind: 'root' };
    }
    if (view.kind === 'smart') {
      const exists = findFolderInTree(smartFolders, view.id);
      return exists ? { kind: 'smart', id: view.id, ...(view.name ? { name: view.name } : {}) } : { kind: 'root' };
    }
    const validKinds = new Set(['root', 'all', 'unfiled', 'untagged', 'recent', 'random', 'trash', 'tags']);
    if (validKinds.has(view.kind)) return { ...view };
    return { kind: 'root' };
  }

  function createSessionState({ layout = 'single', splitRatios = null, activePaneId = null, panes = [] } = {}) {
    const validLayout = paneLayoutSpecs[layout] ? layout : 'single';
    const ratios = splitRatios || defaultSplitRatios(validLayout);
    const normalizedPanes = (panes || []).map((pane, index) => ({
      id: pane?.id || `pane-${index + 1}`,
      view: pane?.view || (pane?.currentView ? { ...pane.currentView } : { kind: 'root' }),
      sort: pane?.sort || 'default',
      sortDir: pane?.sortDir || 'auto'
    }));
    return {
      layout: validLayout,
      splitRatios: {
        cols: Array.isArray(ratios.cols) ? [...ratios.cols] : ['1fr'],
        rows: Array.isArray(ratios.rows) ? [...ratios.rows] : ['1fr']
      },
      activePaneId: activePaneId || (normalizedPanes[0]?.id || 'pane-1'),
      panes: normalizedPanes
    };
  }

  function calculateSplitRatios(axis, index, startSizes, delta, totalDimension, minSize = (axis === 'col' ? 180 : 150)) {
    if (!Array.isArray(startSizes) || startSizes.length <= 1) {
      return ['1fr'];
    }
    const i = Number(index);
    if (i < 0 || i + 1 >= startSizes.length) return startSizes.map(s => `${s}fr`);
    const combined = startSizes[i] + startSizes[i + 1];
    const minFloor = Math.min(minSize, combined / 2);
    const maxFloor = combined - minFloor;
    const target = startSizes[i] + delta;
    const clampedI = Math.max(minFloor, Math.min(maxFloor, target));
    const clampedIPlus1 = combined - clampedI;

    const nextSizes = [...startSizes];
    nextSizes[i] = clampedI;
    nextSizes[i + 1] = clampedIPlus1;

    const sum = nextSizes.reduce((a, b) => a + b, 0) || totalDimension || 1;
    return nextSizes.map(s => `${(s / sum * nextSizes.length).toFixed(4)}fr`);
  }

  function resetSplitRatioAxis(splitRatios, layout, axis) {
    const validLayout = paneLayoutSpecs[layout] ? layout : 'single';
    const defaults = defaultSplitRatios(validLayout);
    const current = splitRatios || defaults;
    if (axis === 'col') {
      return {
        cols: [...defaults.cols],
        rows: Array.isArray(current.rows) ? [...current.rows] : [...defaults.rows]
      };
    }
    if (axis === 'row') {
      return {
        cols: Array.isArray(current.cols) ? [...current.cols] : [...defaults.cols],
        rows: [...defaults.rows]
      };
    }
    return {
      cols: [...defaults.cols],
      rows: [...defaults.rows]
    };
  }

  return {
    createQuery,
    cloneQuery,
    queryWithoutSearch,
    filtersActive,
    filterCount,
    normalizeRange,
    selectRange,
    defaultSortDir,
    effectiveSortDir,
    compareBySort,
    randomRank,
    sharedTags,
    appendableTailCount,
    paneLayoutSpecs,
    paneLayoutSpec,
    paneRevealTargets,
    coordinatePaneLayout,
    defaultSplitRatios,
    resetSplitRatioAxis,
    findFolderInTree,
    validateSessionView,
    createSessionState,
    calculateSplitRatios
  };
});
