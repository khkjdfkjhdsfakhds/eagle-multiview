'use strict';
require('./renderer-ui-preload.cjs');
// B2-01: mutate and query replies are held until the probe releases them, so
// it can change the selection or rate again while a batch is in flight.
const items = ['a', 'b', 'c'].map(id => ({ id, name: id, ext: 'png', width: 10, height: 10, tags: [], folders: [], star: 0 }));
window.__batchCalls = [];
window.__batchGates = { mutate: false, query: false };
const waiters = { mutate: [], query: [] };
window.__batchRelease = kind => {
  window.__batchGates[kind] = false;
  for (const resolve of waiters[kind].splice(0)) resolve();
};
const gate = kind => window.__batchGates[kind] ? new Promise(resolve => waiters[kind].push(resolve)) : Promise.resolve();
window.eagleMV.query = async () => {
  await gate('query');
  return { data: items.map(item => ({ ...item, tags: [...item.tags] })), total: items.length, nextOffset: items.length, hasMore: false };
};
window.eagleMV.mutate = async ({ id, patch, base }) => {
  window.__batchCalls.push({ kind: 'mutate', id, patch });
  await gate('mutate');
  const item = items.find(candidate => candidate.id === id);
  // Same conflict rule as DataHub.mutate: a field that moved away from the
  // caller's base to something other than the request is a conflict.
  for (const [field, value] of Object.entries(patch)) {
    if ((item[field] ?? null) !== (base?.[field] ?? null) && (item[field] ?? null) !== value) {
      return { ok: false, conflict: true, current: { ...item } };
    }
  }
  Object.assign(item, patch);
  return { ok: true, item: { ...item, tags: [...item.tags] } };
};
window.eagleMV.mutateSet = async ({ id, field, add = [], remove = [] }) => {
  window.__batchCalls.push({ kind: 'mutateSet', id, field, add, remove });
  await gate('mutate');
  const item = items.find(candidate => candidate.id === id);
  item[field] = [...new Set([...(item[field] || []), ...add])].filter(value => !remove.includes(value));
  return { ok: true, item: { ...item, tags: [...item.tags] } };
};
window.__batchItems = items;
