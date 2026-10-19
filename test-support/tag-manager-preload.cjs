'use strict';

// Fixture bridge for the tag-manager probe: tags with counts, two groups, a
// starred list, and a record of every tag write the manager makes.
const tags = [
  { name: '猫', imageCount: 12 }, { name: '狗', imageCount: 30 }, { name: '风景', imageCount: 5 },
  { name: 'apple', imageCount: 2 }, { name: 'Banana', imageCount: 9 }, { name: '3D', imageCount: 1 }
];
const groups = [
  { id: 'g-animals', name: '动物', color: 'red', tags: ['猫', '狗'], description: '宠物' },
  { id: 'g-fruit', name: '水果', tags: ['apple'] }
];

window.__tagCalls = [];
const record = (kind, data) => { window.__tagCalls.push({ kind, ...structuredClone(data) }); return { ok: true }; };
const bridge = {
  platform: 'darwin',
  capabilities: {
    nativeDrag: false, hostDialogs: false, clipboardFiles: false, finder: false,
    openDefault: false, openOther: false, share: false, export: false,
    importLocal: false, customThumbnail: false, copyPath: false, webAccess: false
  },
  mediaURL: () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  identity: async () => 'tag-manager-window',
  connect: async () => ({
    app: { version: 'tag-test' },
    library: { path: '/tmp/EagleMV-Tag-Test.library', name: '标签测试库', folders: [], smartFolders: [] }
  }),
  query: async query => {
    window.__tagQueries = [...(window.__tagQueries || []), structuredClone(query)];
    return { data: [], total: 0, nextOffset: 0, hasMore: false };
  },
  getTags: async () => structuredClone(tags),
  getTagGroups: async () => structuredClone(groups),
  getStarredTags: async () => ['狗'],
  renameTag: async data => record('rename', data),
  mergeTag: async data => record('merge', data),
  addTagsToGroup: async data => record('add', data),
  removeTagsFromGroup: async data => record('remove', data),
  updateTagGroup: async data => record('update-group', data),
  getTrashItems: async () => ({ data: [], total: 0, nextOffset: 0, hasMore: false }),
  getPins: async () => ({}), getRecentFolders: async () => [],
  // 猫 has a colour of its own, which a group colour clears (as in Eagle).
  getTagColors: async () => ({ 猫: '#00a2c7' }),
  setTagColor: async data => { record('tag-color', data); return {}; },
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
