'use strict';

const folders = [
  { id: 'mv-folder', name: 'MultiView 文件夹', children: [] },
  { id: 'eagle-folder', name: 'Eagle 文件夹', children: [] },
  { id: 'locked-folder', name: 'Locked 文件夹', password: 'test-only', children: [] }
];

window.__uiTestCalls = [];
window.__uiTestEagleState = { view: { kind: 'folder', id: 'eagle-folder' } };
window.__uiTestLibraryChanged = null;
window.__uiTestEmitFolderRename = name => {
  folders[0].name = name;
  window.__uiTestLibraryChanged?.({
    library: {
      path: '/tmp/EagleMV-UI-Test.library',
      name: '测试资料库',
      folders,
      smartFolders: []
    },
    revision: 1,
    source: 'multiview'
  });
};

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
    uiZoom: false,
    webAccess: false
  },
  mediaURL: (kind, id) => `test://${kind}/${id}`,
  identity: async () => 'ui-test-window',
  connect: async () => ({
    app: { version: 'ui-test' },
    library: { path: '/tmp/EagleMV-UI-Test.library', name: '测试资料库', folders, smartFolders: [] }
  }),
  query: async () => ({ data: [], total: 0, nextOffset: 0, hasMore: false }),
  getTrashItems: async () => ({ data: [], total: 0, nextOffset: 0, hasMore: false }),
  getPins: async () => ({}),
  getTags: async () => [],
  getTagGroups: async () => [],
  getRecentFolders: async () => [],
  getTagColors: async () => ({}),
  initialWindowState: async () => null,
  currentEagleWindowState: async () => window.__uiTestEagleState,
  onLibraryChanged: callback => {
    window.__uiTestLibraryChanged = callback;
    return () => {
      if (window.__uiTestLibraryChanged === callback) window.__uiTestLibraryChanged = null;
    };
  },
  prepareNewWindow: () => null,
  newWindow: async data => {
    window.__uiTestCalls.push({ kind: 'new-window', data });
    return true;
  },
  isFullScreen: async () => false,
  setZoomFactor: () => {},
  confirmClose: () => {},
  cancelClose: () => {}
};

window.eagleMV = new Proxy(bridge, {
  get(target, property) {
    if (property in target) return target[property];
    if (String(property).startsWith('on')) return () => () => {};
    return async () => null;
  }
});
