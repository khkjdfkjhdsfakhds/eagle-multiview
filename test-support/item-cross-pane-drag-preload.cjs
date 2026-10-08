'use strict';
// Two folders of images with Electron-style native item drags, so a probe can
// drop images from one pane onto the cards of another pane.
require('./renderer-ui-preload.cjs');
const items = [
  ...Array.from({ length: 4 }, (_, index) => ({ id: `a-${index}`, name: `A ${index}`, ext: 'png', width: 10, height: 10, folders: ['mv-folder'], tags: [] })),
  ...Array.from({ length: 4 }, (_, index) => ({ id: `b-${index}`, name: `B ${index}`, ext: 'png', width: 10, height: 10, folders: ['eagle-folder'], tags: [] }))
];
const clone = value => JSON.parse(JSON.stringify(value));
window.__itemDrag = { mutations: [] };
window.eagleMV.capabilities.nativeDrag = true;
window.eagleMV.mediaURL = () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
window.eagleMV.query = async (query = {}) => {
  let data = items;
  if (query.folderId) data = data.filter(item => item.folders.includes(query.folderId));
  return { data: clone(data), total: data.length, nextOffset: data.length, hasMore: false };
};
window.eagleMV.getManualOrders = async () => ({});
window.eagleMV.moveManualOrder = async payload => {
  window.__uiTestCalls.push({ kind: 'manual-order', payload });
  return { ok: true, orders: {} };
};
window.eagleMV.mutateSet = async payload => {
  window.__itemDrag.mutations.push(clone(payload));
  const item = items.find(candidate => candidate.id === payload.id);
  const values = new Set(item.folders);
  (payload.add || []).forEach(value => values.add(value));
  (payload.remove || []).forEach(value => values.delete(value));
  item.folders = [...values];
  return { ok: true, item: clone(item) };
};
window.eagleMV.onItemDragState = callback => { window.__itemDrag.emit = callback; };
let token = 0;
window.eagleMV.startDrag = data => {
  token += 1;
  window.__itemDrag.started = token;
  window.__itemDrag.emit?.({ ...data, active: true, token });
};
window.eagleMV.cancelDrag = value => window.__itemDrag.emit?.({ active: false, token: value });
