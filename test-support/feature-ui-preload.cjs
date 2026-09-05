'use strict';
require('./renderer-ui-preload.cjs');
const featureState = window.__featureState = {
  libraryPath: '/tmp/EagleMV-UI-Test.library',
  folders: [
    { id: 'mv-folder', name: 'MultiView 文件夹', children: [{ id: 'child-folder', name: '后代', children: [] }] },
    { id: 'eagle-folder', name: 'Eagle 文件夹', children: [{ id: 'same-one', name: '同名', children: [] }] },
    { id: 'other-parent', name: '其他父级', children: [{ id: 'same-two', name: '同名', children: [] }] },
    ...Array.from({ length: 300 }, (_, index) => ({ id: `many-${index}`, name: `大量文件夹 ${index}`, children: [] }))
  ],
  mode: 'success', revision: 1
};
const library = () => ({ path: featureState.libraryPath, name: featureState.libraryPath.includes('Other') ? '另一测试库' : '测试资料库', folders: structuredClone(featureState.folders), smartFolders: [] });
window.eagleMV.connect = async () => ({ app: { version: 'ui-test' }, library: library() });
let manualOrders = {};
window.eagleMV.getManualOrders = async () => structuredClone(manualOrders);
window.eagleMV.onManualOrdersChanged = callback => {window.__manualOrderChanged=callback;};
window.eagleMV.moveManualOrder = async payload => {
  window.__uiTestCalls.push({kind:'manual-order',payload});
  const key=JSON.stringify([payload.scope,payload.kind]);
  const current=manualOrders[key] || {ids:[],revision:0};
  if(current.revision!==payload.revision)return {conflict:true,orders:structuredClone(manualOrders)};
  const selected=new Set(payload.ids), merged=[...new Set([...current.ids,...payload.knownIds])];
  const next=merged.filter(id=>!selected.has(id));
  next.splice(next.indexOf(payload.anchorId)+(payload.position==='after'?1:0),0,...merged.filter(id=>selected.has(id)));
  manualOrders[key]={ids:next,revision:current.revision+1};
  window.__manualOrderChanged?.({libraryPath:payload.libraryPath,orders:structuredClone(manualOrders)});
  return {ok:true,orders:structuredClone(manualOrders)};
};
window.__featureEmit = libraryPath => {
  featureState.libraryPath = libraryPath;
  window.__uiTestLibraryChanged?.({ library: library(), revision: ++featureState.revision, source: 'multiview' });
};
window.eagleMV.moveFolder = async payload => {
  window.__uiTestCalls.push({ kind: 'move-folder', payload });
  if (featureState.mode === 'failure') throw new Error('移动请求已发送，请刷新核对，不要重复提交。');
  if (featureState.mode === 'conflict') return { ok: false, conflict: true };
  if (featureState.mode === 'pending') await new Promise(resolve => { window.__featureRelease = resolve; });
  return { ok: true, parentId: payload.parentId };
};
