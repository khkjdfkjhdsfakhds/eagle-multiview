'use strict';

(function exposeContextMenuPosition(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVContextMenuPosition = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const MARGIN = 8;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  // The menu opens at the pointer and is pushed back inside the viewport.
  // Its height is already capped by CSS, so the bottom rows stay reachable
  // by scrolling the menu instead of hanging below the window.
  function menuPosition(point, size, viewport) {
    return {
      left: clamp(point.x, MARGIN, viewport.width - size.width - MARGIN),
      top: clamp(point.y, MARGIN, viewport.height - size.height - MARGIN)
    };
  }

  // A submenu flies out to the right of its row, or to the left when the
  // right side has no room, and slides up so its bottom stays visible.
  function submenuPosition(row, size, viewport, { overlap = 2, lift = 6 } = {}) {
    const rightRoom = viewport.width - MARGIN - (row.right - overlap);
    const leftRoom = row.left + overlap - MARGIN;
    const openLeft = size.width > rightRoom && leftRoom > rightRoom;
    const left = openLeft ? row.left + overlap - size.width : row.right - overlap;
    return {
      left: clamp(left, MARGIN, viewport.width - size.width - MARGIN),
      top: clamp(row.top - lift, MARGIN, viewport.height - size.height - MARGIN),
      openLeft
    };
  }

  return { MARGIN, menuPosition, submenuPosition };
});
