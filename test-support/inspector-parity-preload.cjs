'use strict';

// Fixture bridge for the Eagle-parity inspector probe: items in nested,
// coloured folders, and a record of every write the inspector makes.
const folders = [{ id: 'folder-a', name: '甲', iconColor: 'red', children: [{ id: 'folder-b', name: '乙', children: [] }] }];
const items = [
  { id: 'item-1', name: '素材 1', ext: 'png', width: 1000, height: 800, size: 1000, star: 2, tags: ['共同'], folders: ['folder-a', 'folder-b'], url: 'https://a.example', annotation: '同一注释', btime: 1 },
  { id: 'item-2', name: '素材 2', ext: 'png', width: 1000, height: 800, size: 3000, star: 2, tags: ['共同', '独有'], folders: ['folder-b', 'folder-a'], url: 'https://b.example', annotation: '同一注释', btime: 2 },
  { id: 'item-3', name: '音频', ext: 'mp3', width: 0, height: 0, size: 5000, duration: 125, tags: [], folders: [], btime: 3 }
];

window.__inspectorCalls = [];
const bridge = {
  platform: 'darwin',
  capabilities: {
    nativeDrag: false, hostDialogs: false, clipboardFiles: false, finder: false,
    openDefault: false, openOther: false, share: false, export: false,
    importLocal: false, customThumbnail: false, copyPath: false, webAccess: false
  },
  mediaURL: () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  identity: async () => 'inspector-parity-window',
  connect: async () => ({
    app: { version: 'inspector-test' },
    library: { path: '/tmp/EagleMV-Inspector-Test.library', name: '检查器测试库', folders, smartFolders: [] }
  }),
  query: async () => ({ data: items.map(item => structuredClone(item)), total: items.length, nextOffset: items.length, hasMore: false }),
  getItem: async id => structuredClone(items.find(item => item.id === id) || null),
  mutateSet: async ({ id, field, add = [], remove = [] }) => {
    const item = items.find(candidate => candidate.id === id);
    const values = new Set(item[field] || []);
    add.forEach(value => values.add(value));
    remove.forEach(value => values.delete(value));
    item[field] = [...values];
    window.__inspectorCalls.push({ kind: 'mutate-set', id, field, add, remove });
    return structuredClone(item);
  },
  mutate: async ({ id, patch }) => {
    const item = items.find(candidate => candidate.id === id);
    Object.assign(item, patch);
    window.__inspectorCalls.push({ kind: 'mutate', id, patch });
    return { item: structuredClone(item) };
  },
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
