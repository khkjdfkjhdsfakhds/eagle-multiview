'use strict';

const folders = [{ id: 'target-folder', name: '目标文件夹', children: [] }];
const items = [
  { id: 'item-1', name: '素材 1', ext: 'png', width: 1000, height: 800, size: 1000, star: 0, tags: [], btime: 1 },
  { id: 'item-2', name: '素材 2', ext: 'png', width: 1000, height: 800, size: 1000, star: 0, tags: [], btime: 2 },
  { id: 'item-3', name: '素材 3', ext: 'png', width: 1000, height: 800, size: 1000, star: 0, tags: [], btime: 3 },
  { id: 'item-4', name: '素材 4', ext: 'png', width: 1000, height: 800, size: 1000, star: 0, tags: [], btime: 4 },
  { id: 'text-1', name: '长文本', ext: 'txt', width: 0, height: 0, size: 5000, star: 0, tags: [], btime: 5 },
  { id: 'pdf-1', name: '多页文档', ext: 'pdf', width: 0, height: 0, size: 5000, star: 0, tags: [], btime: 6 }
];

window.__reviewCalls = [];
const bridge = {
  platform: 'darwin',
  capabilities: {
    nativeDrag: false, hostDialogs: false, clipboardFiles: false, finder: false,
    openDefault: false, openOther: false, share: false, export: false,
    importLocal: true, customThumbnail: false, copyPath: false, webAccess: false
  },
  mediaURL: () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  identity: async () => 'review-bugfixes-window',
  connect: async () => ({
    app: { version: 'review-test' },
    library: { path: '/tmp/EagleMV-Review-Test.library', name: '回归测试库', folders, smartFolders: [] }
  }),
  query: async query => {
    const data = query?.isUntagged ? items.filter(item => !item.tags.length) : items;
    return { data: data.map(item => ({ ...item })), total: data.length, nextOffset: data.length, hasMore: false };
  },
  getItem: async id => items.find(item => item.id === id) || null,
  mutateSet: async ({ id, field, add = [], remove = [] }) => {
    const item = items.find(candidate => candidate.id === id);
    if (!item) throw new Error('missing fixture item');
    if (id === 'item-2' && add.includes('部分失败')) throw new Error('fixture partial failure');
    const values = new Set(item[field] || []);
    add.forEach(value => values.add(value));
    remove.forEach(value => values.delete(value));
    item[field] = [...values];
    window.__reviewCalls.push({ kind: 'mutate-set', id, field, add, remove });
    return { ...item };
  },
  mutate: async ({ id, patch }) => {
    const item = items.find(candidate => candidate.id === id);
    Object.assign(item, patch);
    return { ...item };
  },
  readText: async () => ({ content: Array.from({ length: 200 }, (_, index) => `第 ${index + 1} 行`).join('\n'), fingerprint: { size: 5000, mtimeMs: 1 } }),
  fileURL: async () => 'about:blank',
  pathForFile: file => file.fixturePath || '',
  importItems: async payload => {
    window.__reviewCalls.push({ kind: 'import', folderId: payload.folderId, libraryPath: payload.libraryPath, paths: payload.paths || [] });
    return { count: payload.paths?.length || 0, ready: payload.paths?.length || 0, rejected: [] };
  },
  getTrashItems: async () => ({ data: [], total: 0, nextOffset: 0, hasMore: false }),
  getPins: async () => ({}), getTags: async () => [], getTagGroups: async () => [],
  getRecentFolders: async () => [], getTagColors: async () => ({}),
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
