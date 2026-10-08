'use strict';
require('./renderer-ui-preload.cjs');
const { ipcRenderer } = require('electron');
window.eagleMV.getFolderCovers = data => ipcRenderer.invoke('cover-fixture:get', data);
window.eagleMV.setFolderCover = data => ipcRenderer.invoke('cover-fixture:set', data);
window.eagleMV.onFolderCoversChanged = callback => ipcRenderer.on('folder-covers:changed', (_event, data) => callback(data));
window.eagleMV.mediaURL = (kind, id) => `eaglemv://${kind}/${id}`;
window.eagleMV.connect = () => ipcRenderer.invoke('cover-fixture:connect');
window.eagleMV.onLibraryChanged = callback => ipcRenderer.on('hub:library-changed', (_event, data) => callback(data));
