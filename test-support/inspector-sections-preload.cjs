'use strict';

// Fixture bridge for the inspector-sections probe: four items in one folder
// (and one elsewhere), with export, and a record of every write.
const folders = [{ id: 'folder-a', name: '甲', children: [] }, { id: 'folder-b', name: '乙', children: [] }];
const items = [1, 2, 3, 4].map(n => ({
  id: `item-${n}`, name: `素材 ${n}`, ext: 'png', width: 100, height: 100, size: 1000, tags: [],
  folders: ['folder-a'], modificationTime: 1000 - n, btime: n
}));
items.push({ id: 'item-u', name: '未分类', ext: 'png', width: 100, height: 100, size: 10, tags: [], folders: [], modificationTime: 1 });
const clone = value => structuredClone(value);

window.__sectionCalls = [];
const bridge = {
  platform: 'darwin',
  capabilities: {
    nativeDrag: false, hostDialogs: false, clipboardFiles: false, finder: false,
    openDefault: false, openOther: false, share: false, export: true,
    importLocal: false, customThumbnail: false, copyPath: false, webAccess: false
  },
  mediaURL: () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  identity: async () => 'inspector-sections-window',
  connect: async () => ({
    app: { version: 'inspector-sections-test' },
    library: { path: '/tmp/EagleMV-Sections-Test.library', name: '区块测试库', folders, smartFolders: [] }
  }),
  query: async (query = {}) => {
    let data = items.filter(item => !item.isDeleted);
    if (query.folderId) data = data.filter(item => item.folders.includes(query.folderId));
    if (query.unfiled) data = data.filter(item => !item.folders.length);
    return { data: clone(data), total: data.length, nextOffset: data.length, hasMore: false };
  },
  getItem: async id => clone(items.find(item => item.id === id) || null),
  mutateSet: async ({ id, field, add = [], remove = [] }) => {
    const item = items.find(candidate => candidate.id === id);
    const values = new Set(item[field] || []);
    add.forEach(value => values.add(value));
    remove.forEach(value => values.delete(value));
    item[field] = [...values];
    window.__sectionCalls.push({ kind: 'mutate-set', id, field, add, remove });
    return clone(item);
  },
  mutate: async ({ id, patch }) => {
    const item = items.find(candidate => candidate.id === id);
    Object.assign(item, patch);
    window.__sectionCalls.push({ kind: 'mutate', id, patch });
    return { ok: true, item: clone(item) };
  },
  exportFiles: async data => { window.__sectionCalls.push({ kind: 'export', ids: data.ids }); return { count: data.ids.length }; },
  getTrashItems: async () => ({ data: [], total: 0, nextOffset: 0, hasMore: false }),
  getPins: async () => ({}), getTags: async () => [], getTagGroups: async () => [],
  getRecentFolders: async () => [], getTagColors: async () => ({}),
  getComments: async () => [],
  initialWindowState: async () => null, currentEagleWindowState: async () => ({ view: { kind: 'root' } }),
  focusWindow: async () => true, isFullScreen: async () => false
};

window.eagleMV = new Proxy(bridge, {
  get(target, property) {
    if (property in target) return target[property];
    if (String(property).startsWith('on')) return () => () => {};
    return async () => null;
  }
});
