'use strict';
require('./renderer-ui-preload.cjs');
// P6-02: a view larger than one page, served page by page like the hub.
const count = Number(process.env.EAGLEMV_SELECT_ALL_COUNT || 400);
const items = Array.from({ length: count }, (_, index) => ({ id: `i${index}`, name: `i${index}`, ext: 'png', width: 10, height: 10, tags: [], folders: [] }));
window.eagleMV.query = async ({ offset = 0, limit = 160 } = {}) => {
  const data = items.slice(offset, offset + limit).map(item => ({ ...item }));
  return { data, total: items.length, nextOffset: offset + data.length, hasMore: offset + data.length < items.length };
};
// The rest of the view by id, and the main process's summary of it.
if (!process.env.EAGLEMV_SELECT_ALL_NO_IDS) {
  window.eagleMV.viewIds = async () => items.map(item => item.id);
  window.eagleMV.selectionSummary = async ({ ids }) => {
    window.__summaryRequests = (window.__summaryRequests || 0) + 1;
    return { count: ids.length, size: ids.length * 1024, tags: [], folders: [], annotation: { value: '', mixed: false }, url: { value: '', mixed: false }, star: { value: 0, mixed: false } };
  };
}
// Batch writes reach the ids past the loaded range too.
window.__mutated = [];
window.eagleMV.getItem = async id => ({ ...items.find(item => item.id === id) });
window.eagleMV.mutate = async ({ id, patch }) => {
  window.__mutated.push(id);
  const item = items.find(entry => entry.id === id);
  Object.assign(item, patch);
  return { item: { ...item } };
};
