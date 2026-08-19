'use strict';

(function exposeMarquee(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVMarquee = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const DRAG_THRESHOLD = 4;
  const EDGE_SIZE = 28;
  const MAX_SCROLL_SPEED = 18;

  function exceedsThreshold(dx, dy, threshold = DRAG_THRESHOLD) {
    return Math.max(Math.abs(dx), Math.abs(dy)) >= threshold;
  }

  function normalizeRect(x1, y1, x2, y2) {
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      right: Math.max(x1, x2),
      bottom: Math.max(y1, y2)
    };
  }

  function clampRect(rect, width, height) {
    return {
      left: Math.max(0, Math.min(rect.left, width)),
      top: Math.max(0, Math.min(rect.top, height)),
      right: Math.max(0, Math.min(rect.right, width)),
      bottom: Math.max(0, Math.min(rect.bottom, height))
    };
  }

  function rectsIntersect(a, b) {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  }

  function hitIds(rect, cards) {
    const ids = [];
    for (const card of cards || []) {
      if (rectsIntersect(rect, card)) ids.push(card.id);
    }
    return ids;
  }

  function combineSelection(baseIds, hits, additive) {
    const next = new Set(additive ? baseIds : []);
    for (const id of hits || []) next.add(id);
    return next;
  }

  function sameSelection(a, b) {
    if (a.size !== b.size) return false;
    for (const id of a) if (!b.has(id)) return false;
    return true;
  }

  function autoScrollSpeed(pointer, viewStart, viewEnd, { edge = EDGE_SIZE, maxSpeed = MAX_SCROLL_SPEED } = {}) {
    if (viewEnd - viewStart <= edge * 2) return 0;
    if (pointer < viewStart + edge) {
      return -Math.ceil(Math.min(1, (viewStart + edge - pointer) / edge) * maxSpeed);
    }
    if (pointer > viewEnd - edge) {
      return Math.ceil(Math.min(1, (pointer - (viewEnd - edge)) / edge) * maxSpeed);
    }
    return 0;
  }

  return {
    DRAG_THRESHOLD,
    exceedsThreshold,
    normalizeRect,
    clampRect,
    rectsIntersect,
    hitIds,
    combineSelection,
    sameSelection,
    autoScrollSpeed
  };
});
