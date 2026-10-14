'use strict';
require('./renderer-ui-preload.cjs');
const folders = [
  { id: 'parent', name: 'Parent', children: [
    { id: 'child', name: 'Child', children: [{ id: 'deep', name: 'Deep', children: [] }] }
  ] },
  { id: 'outside', name: 'Outside', children: [] },
  { id: 'target', name: 'Target', children: [] }
];
const library = { path: '/tmp/EagleMV-UI-Test.library', name: '测试资料库', folders, smartFolders: [] };
const memberships = {
  p: ['parent'], c: ['child'], d: ['deep', 'outside'], e: ['deep', 'outside'],
  f: ['child'], h: ['deep'], k: ['deep'], g: ['parent', 'child']
};
const items = Object.entries(memberships).map(([id, list]) => ({ id, name: 'needle', ext: 'png', width: 10, height: 10, tags: [], folders: [...list] }));
window.__scopeItems = items;
window.__scopeCalls = [];
window.eagleMV.connect = async () => ({ app: { version: 'ui-test' }, library });
window.eagleMV.query = async query => {
  const data = items.filter(item => window.EagleMVQuerySpec.matchesConstraints(item, query)).map(item => structuredClone(item));
  return { data, total: data.length, nextOffset: data.length, hasMore: false };
};
window.eagleMV.getItem = async id => structuredClone(items.find(item => item.id === id));
window.eagleMV.mutateSet = async ({ id, field, add = [], remove = [] }) => {
  window.__scopeCalls.push({ id, field, add, remove });
  const item = items.find(candidate => candidate.id === id);
  item[field] = [...new Set([...item[field].filter(value => !remove.includes(value)), ...add])];
  return { ok: true, item: structuredClone(item) };
};
