'use strict';
require('./renderer-ui-preload.cjs');
const {ipcRenderer}=require('electron');
window.eagleMV.identity=()=>ipcRenderer.invoke('fixture:identity');
window.eagleMV.getManualOrders=data=>ipcRenderer.invoke('fixture:orders',data);
window.eagleMV.moveManualOrder=data=>ipcRenderer.invoke('fixture:move',data);
window.eagleMV.moveFolder=async data=>{const result=await ipcRenderer.invoke('fixture:folder-move',data);window.__folderMoves=(window.__folderMoves||0)+1;return result;};
window.eagleMV.onManualOrdersChanged=callback=>ipcRenderer.on('fixture:changed',(_event,data)=>callback(data));
window.eagleMV.query=data=>ipcRenderer.invoke('fixture:query',data);
window.eagleMV.capabilities.nativeDrag=true;
window.eagleMV.onItemDragState=callback=>{window.__nativeDragState=callback;};
window.eagleMV.startDrag=data=>{
  window.__nativeDragCalls=(window.__nativeDragCalls||0)+1;
  window.__nativeDragState?.({...data,active:true,token:window.__nativeDragCalls});
};
window.eagleMV.cancelDrag=token=>{
  (window.__cancelDragTokens ||= []).push(token);
  window.__nativeDragState?.({active:false,token});
};
