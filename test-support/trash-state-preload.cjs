'use strict';
require('./renderer-ui-preload.cjs');
const items = [
  { id: 'live', name: 'live', ext: 'png', width: 10, height: 10, tags: [], folders: [] },
  { id: 'gone', name: 'gone', ext: 'png', width: 10, height: 10, tags: [], folders: [], isDeleted: true }
];
window.__trashCalls = [];
window.eagleMV.query = async () => ({ data: items.map(item => ({ ...item })), total: items.length, nextOffset: items.length, hasMore: false });
window.eagleMV.mutate = async ({ id, patch }) => {
  window.__trashCalls.push({ id, patch });
  const item = items.find(candidate => candidate.id === id);
  Object.assign(item, patch);
  return { ok: true, item: { ...item } };
};
