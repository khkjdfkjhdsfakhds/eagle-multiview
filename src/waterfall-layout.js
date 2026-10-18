'use strict';

// 瀑布流 as in Eagle's GridLayout (app.bundle.js): as many columns of at
// least the thumbnail size as fit, stretched to fill the width, and every
// card in turn goes to the shortest column (the leftmost of equals). Cards
// therefore read row by row, and appending a page only continues from the
// column heights the earlier cards left.
(function exposeWaterfallLayout(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVWaterfall = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const GAP = 12;

  function columnsFor(width, thumb, gap = GAP) {
    const count = Math.max(1, Math.floor((width + gap) / (Math.max(1, thumb) + gap)));
    return { count, width: Math.max(0, (width + gap) / count - gap) };
  }

  // heights: running bottom of each column (with the trailing gap), changed
  // in place. sizes: card heights in order. Returns [{ column, left, top }].
  function place(heights, sizes, columnWidth, gap = GAP) {
    return sizes.map(size => {
      let column = 0;
      for (let index = 1; index < heights.length; index += 1) if (heights[index] < heights[column]) column = index;
      const top = heights[column];
      heights[column] = top + size + gap;
      return { column, left: column * (columnWidth + gap), top };
    });
  }

  function contentHeight(heights, gap = GAP) {
    return Math.max(0, Math.max(0, ...heights) - gap);
  }

  return { GAP, columnsFor, place, contentHeight };
});
