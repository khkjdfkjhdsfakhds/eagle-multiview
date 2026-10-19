'use strict';
// P4-01: the window side of 导入本地文件夹 — sidebar drop, menu, folder rows.
require('./renderer-ui-preload.cjs');
const LIBRARY = '/tmp/EagleMV-UI-Test.library';
const folders = [
  { id: 'mv-folder', name: 'MultiView 文件夹', children: [] },
  { id: 'eagle-folder', name: 'Eagle 文件夹', children: [] },
  { id: 'locked-folder', name: 'Locked 文件夹', password: 'test-only', children: [] }
];
const probe = window.__folderImport = {
  paths: new Map(), plans: [], runs: [], imports: [], alerts: [], confirms: [], confirmAnswer: false,
  planReply: null, runReplies: []
};
window.eagleMV.capabilities.importLocal = true;
window.alert = message => { probe.alerts.push(message); };
window.confirm = message => { probe.confirms.push(message); return probe.confirmAnswer; };
window.eagleMV.pathForFile = file => probe.paths.get(file.name) || '';
window.eagleMV.focusWindow = async () => true;
window.eagleMV.importItems = async payload => {
  probe.imports.push(JSON.parse(JSON.stringify(payload)));
  return { count: 1, ready: 1, ids: ['x'], rejected: [], ignoredDirectories: payload.ignoreDirectories ? 1 : 0 };
};
window.eagleMV.planFolderImport = async payload => {
  probe.plans.push(JSON.parse(JSON.stringify(payload)));
  return probe.planReply;
};
window.eagleMV.runFolderImport = async payload => {
  probe.runs.push(JSON.parse(JSON.stringify(payload)));
  const reply = probe.runReplies.shift();
  if (reply?.rootIds?.length) {
    // Main publishes the new folders before it answers.
    window.__uiTestLibraryChanged?.({
      library: { path: LIBRARY, name: '测试资料库', folders: [...folders, ...reply.rootIds.map(id => ({ id, name: `导入 ${id}`, children: [] }))], smartFolders: [] },
      revision: 10 + probe.runs.length, source: 'multiview'
    });
  }
  return reply;
};
