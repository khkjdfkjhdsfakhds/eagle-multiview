'use strict';

const folder = { id: 'sync-folder', name: '同步文件夹', children: [] };
const items = Array.from({ length: 6 }, (_, index) => ({
  id: `item-${index + 1}`,
  name: `素材 ${index + 1}`,
  ext: 'png',
  width: 1000 + index,
  height: 800,
  size: 1000 + index,
  star: 0,
  btime: 1700000000000 + index
}));

const bridge = {
  platform: 'darwin',
  capabilities: {
    nativeDrag: false,
    hostDialogs: false,
    clipboardFiles: false,
    finder: false,
    openDefault: false,
    openOther: false,
    share: false,
    export: false,
    importLocal: false,
    customThumbnail: false,
    copyPath: false,
    webAccess: false
  },
  mediaURL: (kind, id) => `test://${kind}/${id}`,
  identity: async () => 'sync-panes-test-window',
  connect: async () => ({
    app: { version: 'sync-panes-test' },
    library: { path: '/tmp/EagleMV-Sync-Test.library', name: '同步测试库', folders: [folder], smartFolders: [] }
  }),
  query: async () => ({ data: items, total: items.length, nextOffset: items.length, hasMore: false }),
  getItem: async id => items.find(item => item.id === id) || null,
  mutate: async ({ id, patch }) => {
    const item = items.find(candidate => candidate.id === id);
    if (item && patch && 'star' in patch) item.star = patch.star;
    return item ? { ...item } : { id };
  },
  getTrashItems: async () => ({ data: [], total: 0, nextOffset: 0, hasMore: false }),
  getPins: async () => ({}),
  getTags: async () => [],
  getTagGroups: async () => [],
  getRecentFolders: async () => [],
  getTagColors: async () => ({}),
  initialWindowState: async () => null,
  currentEagleWindowState: async () => ({ view: { kind: 'root' } }),
  newWindow: async () => true,
  isFullScreen: async () => false
};

window.eagleMV = new Proxy(bridge, {
  get(target, property) {
    if (property in target) return target[property];
    if (String(property).startsWith('on')) return () => () => {};
    return async () => null;
  }
});
