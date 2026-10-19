'use strict';
// Finder files and library items dragged across two panes (D-03 – D-06).
require('./stale-drag-drop-preload.cjs');
window.eagleMV.capabilities.importLocal = true;
const query = window.eagleMV.query;
// A probe can hold back one folder's next query to stand in for a slow
// refresh of the drop target.
window.__paneDrag = { hangFolder: null };
window.eagleMV.query = (payload = {}) => (
  payload.folderId && payload.folderId === window.__paneDrag.hangFolder
    ? new Promise(() => {})
    : query(payload)
);
