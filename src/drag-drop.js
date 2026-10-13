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

  function hasNoTypes(dataTransfer) {
    return !Array.from(dataTransfer?.types || []).length;
  }

  // Hover-time guess only: dragenter/dragover cannot read dropped file paths,
  // so a native file drag counts as internal while a session supplies ids.
  // Text or URL drags never borrow session ids.
  function isInternalItemDrag(dataTransfer, fallbackIds = []) {
    if (hasType(dataTransfer, ITEM_TYPE)) return true;
    if (!hasType(dataTransfer, 'Files') && !hasNoTypes(dataTransfer)) return false;
    return readItemIds(dataTransfer, fallbackIds).length > 0;
  }

  function classifyDrop(dataTransfer, fallbackIds = []) {
    if (isInternalItemDrag(dataTransfer, fallbackIds)) return 'internal-items';
    if (hasType(dataTransfer, 'Files')) return 'external-files';
    return 'unsupported';
  }

  function shouldShowImportOverlay(dataTransfer, fallbackIds = []) {
    return classifyDrop(dataTransfer, fallbackIds) === 'external-files';
  }

  function normalizePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  }

  // `<library>/images/<id>.info/<file>` is where Eagle keeps an item's
  // original; anything else is not an item of that library.
  function libraryItemIdFromPath(filePath, libraryPath) {
    const root = normalizePath(libraryPath);
    const file = normalizePath(filePath);
    const prefix = `${root}/images/`;
    if (!root || !file.startsWith(prefix)) return null;
    const match = /^([^/]+)\.info\/[^/]+$/.exec(file.slice(prefix.length));
    return match ? match[1] : null;
  }

  // Drop-time decision. A native file drag is internal only when every
  // dropped path is a file of the current drag session or an item original of
  // the library; leftover session ids never turn Finder files into a move.
  // `fromSession` says whether the session's source folder/pane describe
  // this drop.
  function resolveDrop(dataTransfer, { sessionIds = [], sessionFiles = [], libraryPaths = [], paths = [] } = {}) {
    const session = [...new Set((sessionIds || []).filter(Boolean))];
    if (hasType(dataTransfer, ITEM_TYPE)) {
      return { kind: 'internal-items', ids: readItemIds(dataTransfer, session), fromSession: true };
    }
    if (hasType(dataTransfer, 'Files')) {
      const dropped = (paths || []).filter(Boolean);
      const external = { kind: 'external-files', ids: [], fromSession: false };
      if (!dropped.length) return external;
      const files = new Set((sessionFiles || []).map(normalizePath));
      if (session.length && dropped.every(file => files.has(normalizePath(file)))) {
        return { kind: 'internal-items', ids: session, fromSession: true };
      }
      const ids = [];
      for (const file of dropped) {
        const id = (libraryPaths || []).map(root => libraryItemIdFromPath(file, root)).find(Boolean);
        if (!id) return external;
        ids.push(id);
      }
      const sessionSet = new Set(session);
      if (session.length && ids.every(id => sessionSet.has(id))) {
        return { kind: 'internal-items', ids: session, fromSession: true };
      }
      return { kind: 'internal-items', ids: [...new Set(ids)], fromSession: false };
    }
    if (hasNoTypes(dataTransfer) && session.length) {
      return { kind: 'internal-items', ids: session, fromSession: true };
    }
    return { kind: 'unsupported', ids: [], fromSession: false };
  }

  return {
    ITEM_TYPE,
    SOURCE_PANE_TYPE,
    hasType,
    readItemIds,
    isInternalItemDrag,
    classifyDrop,
    shouldShowImportOverlay,
    libraryItemIdFromPath,
    resolveDrop
  };
});
