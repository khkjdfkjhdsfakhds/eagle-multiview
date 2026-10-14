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

  // A web page image or link (dragged from a browser) carries no file, only
  // its address. It imports like Finder files, so it shares their kind. Drags
  // that start inside this page (its own <img> and links) pass
  // `allowURL: false`: those addresses are MultiView's own media.
  const URL_TYPES = ['text/uri-list', 'text/html', 'text/plain'];
  function hasURLData(dataTransfer) {
    // Folder and reorder drags of this app carry their own types.
    const types = Array.from(dataTransfer?.types || []);
    if (types.some(type => String(type).startsWith('application/x-eagle-multiview'))) return false;
    return URL_TYPES.some(type => types.includes(type));
  }

  function classifyDrop(dataTransfer, fallbackIds = [], { allowURL = true } = {}) {
    if (isInternalItemDrag(dataTransfer, fallbackIds)) return 'internal-items';
    if (hasType(dataTransfer, 'Files')) return 'external-files';
    if (allowURL && hasURLData(dataTransfer)) return 'external-files';
    return 'unsupported';
  }

  function absoluteWebURL(value) {
    try {
      const url = new URL(String(value || '').trim());
      return ['http:', 'https:', 'data:', 'blob:'].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  // Drop-time address of a dragged web image or link, read like Eagle: the
  // first <img src> of the HTML flavour wins (a dragged picture), then the
  // URL list, then plain text that is a URL. `image` says it came from <img>.
  function droppedURL(dataTransfer) {
    const read = type => { try { return dataTransfer?.getData?.(type) || ''; } catch { return ''; } };
    const source = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i.exec(read('text/html'))?.[1];
    const image = absoluteWebURL(source?.replace(/&amp;/g, '&'));
    if (image) return { url: image, image: true };
    const listed = read('text/uri-list').split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
    const link = absoluteWebURL(listed) || absoluteWebURL(read('text/plain'));
    return link && /^https?:/i.test(link) ? { url: link, image: false } : null;
  }

  function shouldShowImportOverlay(dataTransfer, fallbackIds = [], options = {}) {
    return classifyDrop(dataTransfer, fallbackIds, options) === 'external-files';
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
  function resolveDrop(dataTransfer, { sessionIds = [], sessionFiles = [], libraryPaths = [], paths = [], allowURL = true } = {}) {
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
    if (allowURL && hasURLData(dataTransfer)) return { kind: 'external-files', ids: [], fromSession: false };
    return { kind: 'unsupported', ids: [], fromSession: false };
  }

  return {
    ITEM_TYPE,
    SOURCE_PANE_TYPE,
    hasType,
    readItemIds,
    isInternalItemDrag,
    classifyDrop,
    droppedURL,
    shouldShowImportOverlay,
    libraryItemIdFromPath,
    resolveDrop
  };
});
