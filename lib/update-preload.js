'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updater', {
  getState: () => ipcRenderer.invoke('updater:get-state'),
  act: (action, value) => ipcRenderer.invoke('updater:action', { action, value }),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updater:state', listener);
    return () => ipcRenderer.removeListener('updater:state', listener);
  }
});
