'use strict';

const { ipcRenderer } = require('electron');

const folders = [
  {
    id: 'alpha-folder',
    name: 'Alpha',
    children: [{
      id: 'beta-folder',
      name: 'Beta',
      children: [{
        id: 'gamma-folder',
        name: 'Gamma',
        children: [{ id: 'delta-folder', name: 'Delta', children: [] }]
      }, {
        id: 'alpha-shared-folder',
        name: 'Shared',
        children: []
      }]
    }]
  },
  { id: 'other-folder', name: 'Other', children: [{ id: 'other-shared-folder', name: 'Shared', children: [] }] }
];

const bridge = {
  platform: process.env.EAGLEMV_UI_PLATFORM || 'web',
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
  identity: async () => 'path-bar-ui-test-window',
  connect: async () => ({
    app: { version: 'path-bar-ui-test' },
    library: {
      path: '/tmp/EagleMV-Path-Bar-Test.library',
      name: '路径测试资料库',
      folders,
      smartFolders: [{ id: 'smart-folder', name: '精选智能视图' }]
    }
  }),
  query: async () => ({ data: [], total: 0, nextOffset: 0, hasMore: false }),
  getTrashItems: async () => ({ data: [], total: 0, nextOffset: 0, hasMore: false }),
  getPins: async () => ({}),
  getTags: async () => [],
  getTagGroups: async () => [],
  getRecentFolders: async () => [],
  getTagColors: async () => ({}),
  initialWindowState: async () => null,
  currentEagleWindowState: async () => ({ view: { kind: 'root' } }),
  newWindow: async () => true,
  isFullScreen: async () => false,
  resizeWindow: (width, height) => ipcRenderer.invoke('path-bar-ui-resize', { width, height })
};

window.eagleMV = new Proxy(bridge, {
  get(target, property) {
    if (property in target) return target[property];
    if (String(property).startsWith('on')) return () => () => {};
    return async () => null;
  }
});
