'use strict';
// Only the public Eagle bridge is a fixture; HTML, CSS and renderer are real.
const { ipcRenderer } = require('electron');
const call = (method, payload) => ipcRenderer.invoke('txt-layout:invoke', method, [payload]);
const methods = {
  connect: 'hub:connect', query: 'hub:query', getItem: 'hub:get-item',
  readText: 'text:read', saveText: 'text:save',
  getTextDraft: 'text-draft:get', putTextDraft: 'text-draft:put',
  removeTextDraft: 'text-draft:remove', listTextDrafts: 'text-draft:list'
};
const bridge = {
  platform: 'darwin', capabilities: {},
  mediaURL: () => '', identity: async () => 'txt-layout-fixture',
  initialWindowState: async () => ({ view: { kind: 'all' } }),
  currentEagleWindowState: async () => ({ view: { kind: 'all' } }),
  getPins: async () => ({}), getTags: async () => [], getTagGroups: async () => [],
  getRecentFolders: async () => [], getTagColors: async () => ({}),
  getComments: async () => [], isFullScreen: async () => false
};
for (const [name, method] of Object.entries(methods)) bridge[name] = payload => call(method, payload);
window.eagleMV = new Proxy(bridge, {
  get(target, name) {
    if (name in target) return target[name];
    if (String(name).startsWith('on')) return () => () => {};
    return async () => null;
  }
});
