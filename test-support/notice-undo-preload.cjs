'use strict';
// P3-05: Eagle's 撤销 on the notices of item and folder edits.
require('./renderer-ui-preload.cjs');
const items = {
  a: { id: 'a', name: 'A', folders: ['mv-folder'], tags: ['t1'] },
  b: { id: 'b', name: 'B', folders: ['mv-folder', 'eagle-folder'], tags: [] }
};
const probe = window.__noticeUndo = { mutates: [], folderRenames: [] };
window.eagleMV.getItem = async id => structuredClone(items[id]);
window.eagleMV.mutateSet = async ({ id, field, add = [], remove = [] }) => {
  const before = structuredClone(items[id]);
  const values = new Set(before[field] || []);
  add.forEach(value => values.add(value));
  remove.forEach(value => values.delete(value));
  items[id][field] = [...values];
  return { ok: true, item: structuredClone(items[id]), previous: { [field]: before[field] || [] } };
};
window.eagleMV.mutate = async payload => {
  probe.mutates.push(JSON.parse(JSON.stringify(payload)));
  Object.assign(items[payload.id], payload.patch);
  return { ok: true, item: structuredClone(items[payload.id]) };
};
window.eagleMV.mutateFolder = async payload => {
  probe.folderRenames.push(JSON.parse(JSON.stringify(payload)));
  return { ok: true };
};
