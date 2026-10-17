'use strict';

// Fixture bridge for the filter-panel probe: a few items across folders,
// formats and dates; queries are answered by the shared query table, and the
// panel's counts come from viewFacets as the hub would compute them.
const now = Date.now();
const day = 86400000;
const folders = [{ id: 'folder-a', name: '甲', iconColor: 'red', children: [{ id: 'folder-b', name: '乙', children: [] }] }, { id: 'folder-c', name: '丙', children: [] }];
const items = [
  { id: 'item-1', name: '图一', ext: 'png', width: 800, height: 600, size: 1000, tags: ['猫', '白'], folders: ['folder-a'], modificationTime: now - 1000, comments: [{ annotation: '耳朵' }] },
  { id: 'item-2', name: '图二', ext: 'jpg', width: 800, height: 600, size: 2000, tags: ['猫'], folders: ['folder-a', 'folder-b'], modificationTime: now - 40 * day },
  { id: 'item-3', name: '视频', ext: 'mp4', width: 1920, height: 1080, size: 9000, duration: 90, tags: [], folders: ['folder-c'], modificationTime: now - 2 * day },
  { id: 'item-4', name: '散图', ext: 'png', width: 500, height: 500, size: 500, tags: ['狗'], folders: [], modificationTime: now - 400 * day }
];

window.__filterQueries = [];
const visible = query => items.filter(item => window.EagleMVQuerySpec.matchesConstraints(item, query));
const bridge = {
  platform: 'darwin',
  capabilities: {
    nativeDrag: false, hostDialogs: false, clipboardFiles: false, finder: false,
    openDefault: false, openOther: false, share: false, export: false,
    importLocal: false, customThumbnail: false, copyPath: false, webAccess: false
  },
  mediaURL: () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  identity: async () => 'filter-panel-window',
  connect: async () => ({
    app: { version: 'filter-test' },
    library: { path: '/tmp/EagleMV-Filter-Test.library', name: '筛选测试库', folders, smartFolders: [] }
  }),
  query: async query => {
    window.__filterQueries.push(structuredClone(query));
    const data = visible(query).map(item => structuredClone(item));
    return { data, total: data.length, nextOffset: data.length, hasMore: false };
  },
  viewFacets: async query => {
    const facets = { total: 0, exts: {}, folders: {}, addedMonths: {}, modifiedMonths: {} };
    const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };
    for (const item of visible(query)) {
      facets.total += 1;
      bump(facets.exts, item.ext);
      if (item.folders.length) item.folders.forEach(id => bump(facets.folders, id));
      else bump(facets.folders, 'NoFolders');
      bump(facets.addedMonths, window.EagleMVQuerySpec.monthKey(item.modificationTime));
      bump(facets.modifiedMonths, window.EagleMVQuerySpec.monthKey(item.modificationTime));
    }
    return facets;
  },
  getItem: async id => structuredClone(items.find(item => item.id === id) || null),
  getTrashItems: async () => ({ data: [], total: 0, nextOffset: 0, hasMore: false }),
  getPins: async () => ({}), getTagGroups: async () => [],
  getTags: async () => [{ name: '猫', imageCount: 2 }, { name: '白', imageCount: 1 }, { name: '狗', imageCount: 1 }],
  getRecentFolders: async () => [], getTagColors: async () => ({}),
  getComments: async () => [],
  initialWindowState: async () => null, currentEagleWindowState: async () => ({ view: { kind: 'all' } }),
  focusWindow: async () => true, isFullScreen: async () => false
};

window.eagleMV = new Proxy(bridge, {
  get(target, property) {
    if (property in target) return target[property];
    if (String(property).startsWith('on')) return () => () => {};
    return async () => null;
  }
});
