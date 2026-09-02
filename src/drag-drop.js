'use strict';

(function exposeDragDrop(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVDragDrop = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const ITEM_TYPE = 'application/x-eagle-multiview-items';
  const SOURCE_PANE_TYPE = 'application/x-eagle-multiview-source-pane';

  function hasType(dataTransfer, type) {
    return Array.from(dataTransfer?.types || []).includes(type);
  }

  function readItemIds(dataTransfer, fallbackIds = []) {
    let ids = [];
    try {
      ids = JSON.parse(dataTransfer?.getData?.(ITEM_TYPE) || '[]');
    } catch {}
    if (!Array.isArray(ids) || !ids.length) ids = fallbackIds;
    return [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
  }

  function isInternalItemDrag(dataTransfer, fallbackIds = []) {
    return hasType(dataTransfer, ITEM_TYPE) || readItemIds(dataTransfer, fallbackIds).length > 0;
  }

  function classifyDrop(dataTransfer, fallbackIds = []) {
    if (isInternalItemDrag(dataTransfer, fallbackIds)) return 'internal-items';
    if (hasType(dataTransfer, 'Files')) return 'external-files';
    return 'unsupported';
  }

  function shouldShowImportOverlay(dataTransfer, fallbackIds = []) {
    return classifyDrop(dataTransfer, fallbackIds) === 'external-files';
  }

  return { ITEM_TYPE, SOURCE_PANE_TYPE, hasType, readItemIds, isInternalItemDrag, classifyDrop, shouldShowImportOverlay };
});
