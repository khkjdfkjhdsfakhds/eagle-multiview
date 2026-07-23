'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('eagleMV', {
  connect: () => ipcRenderer.invoke('hub:connect'),
  identity: () => ipcRenderer.invoke('hub:identity'),
  query: query => ipcRenderer.invoke('hub:query', query),
  getRecentFolders: () => ipcRenderer.invoke('hub:recent-folders'),
  getTrashItems: data => ipcRenderer.invoke('hub:trash-items', data),
  getItem: id => ipcRenderer.invoke('hub:get-item', id),
  getTags: () => ipcRenderer.invoke('hub:tags'),
  mutate: mutation => ipcRenderer.invoke('hub:mutate', mutation),
  mutateSet: mutation => ipcRenderer.invoke('hub:mutate-set', mutation),
  watchItems: ids => ipcRenderer.invoke('hub:watch-items', ids),
  newWindow: () => ipcRenderer.invoke('window:new'),
  confirmClose: () => ipcRenderer.send('window:confirm-close'),
  cancelClose: () => ipcRenderer.send('window:cancel-close'),
  createFolder: data => ipcRenderer.invoke('folder:create', data),
  importItems: data => ipcRenderer.invoke('items:import', data),
  importClipboard: data => ipcRenderer.invoke('items:import-clipboard', data),
  pathForFile: file => webUtils.getPathForFile(file),
  showInFinder: id => ipcRenderer.invoke('item:show-in-finder', id),
  filePath: id => ipcRenderer.invoke('item:file-path', id),
  openDefault: id => ipcRenderer.invoke('item:open-default', id),
  copyText: text => ipcRenderer.invoke('clipboard:write-text', String(text || '')),
  showItemContextMenu: data => ipcRenderer.invoke('item:context-menu', data),
  getPins: data => ipcRenderer.invoke('pins:get', data),
  setPins: data => ipcRenderer.invoke('pins:set', data),
  readText: data => ipcRenderer.invoke('text:read', data),
  saveText: data => ipcRenderer.invoke('text:save', data),
  onStatus: callback => on('hub:status', callback),
  onLibraryChanged: callback => on('hub:library-changed', callback),
  onItemsChanged: callback => on('hub:items-changed', callback),
  onQueryInvalidated: callback => on('hub:query-invalidated', callback),
  onTrashSelection: callback => on('command:trash-selection', callback),
  onPinSelection: callback => on('command:pin-selection', callback),
  onAddToFolder: callback => on('command:add-to-folder', callback),
  onMoveToFolder: callback => on('command:move-to-folder', callback),
  onRemoveFromFolder: callback => on('command:remove-from-folder', callback),
  onAddTag: callback => on('command:add-tag', callback),
  onSetRating: callback => on('command:set-rating', callback),
  onSetTagColor: callback => on('command:set-tag-color', callback),
  getTagColors: data => ipcRenderer.invoke('tag-colors:get', data),
  setTagColor: data => ipcRenderer.invoke('tag-colors:set', data),
  onImportRequest: callback => on('command:import', callback),
  onPinsChanged: callback => on('pins:changed', callback),
  onTextChanged: callback => on('text:changed', callback),
  onRequestClose: callback => on('command:request-close', callback)
});
