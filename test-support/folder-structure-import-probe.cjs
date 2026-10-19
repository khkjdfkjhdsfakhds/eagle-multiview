'use strict';
// P4-01 in a real renderer: folders dropped on the sidebar's blank area and
// the 导入本地文件夹 entries import with their structure at the root; Eagle's
// questions are asked per folder; a drop on a sidebar folder takes files only.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-folder-structure-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1300, height: 860, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'folder-structure-import-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (fn, label) => { for (let i = 0; i < 250; i++) { if (fn()) return; await wait(20); } throw Error('timeout: ' + label); };
    const assert = (value, message) => { if (!value) throw Error(message); };
    await until(() => state.connected && document.querySelector('#folderTree [data-folder-id="mv-folder"]'), 'connect');
    const probe = window.__folderImport;
    const idle = () => until(() => !state.importing && !state.operationTracker.active().length, 'idle');
    const drop = (target, entries) => {
      const data = new DataTransfer();
      for (const [name, filePath] of entries) { probe.paths.set(name, filePath); data.items.add(new File(['x'], name)); }
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    };
    const out = {};

    // 1. Sidebar blank: three folders; one too deep, one needs a yes (answered no).
    probe.planReply = { token: 't1', roots: [
      { name: '素材', fileCount: 3, folderCount: 2, needsConfirm: false, tooLarge: false },
      { name: '很深', fileCount: 1, folderCount: 15, needsConfirm: false, tooLarge: true },
      { name: '很多', fileCount: 2400, folderCount: 1, needsConfirm: true, tooLarge: false }
    ], rejected: [] };
    probe.runReplies.push({ canceled: false, folders: 2, count: 3, ready: 3, ids: [], rejected: [], rootIds: ['new-root'] });
    const label = [...document.querySelectorAll('#folderTree .folder-section-label')].at(-1);
    drop(label, [['素材', '/Users/tester/素材'], ['很深', '/Users/tester/很深'], ['很多', '/Users/tester/很多']]);
    await until(() => probe.runs.length === 1, 'blank drop run');
    await idle();
    out.blankPlan = probe.plans[0];
    out.blankRun = probe.runs[0];
    out.alerts = probe.alerts.length;
    out.confirmText = probe.confirms[0];
    await until(() => state.currentView.kind === 'folder' && state.currentView.id === 'new-root', 'opened new folder');
    out.opened = state.currentView.id;
    out.expanded = state.expandedFolders.has('new-root');

    // 2. 新建 menu row and the menu-bar command both open the folder picker.
    $('#newButton').click();
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'new menu');
    out.newMenuRow = Boolean($('#contextMenu [data-context-action="import-folders"]'));
    probe.planReply = { canceled: true };
    $('#contextMenu [data-context-action="import-folders"]').click();
    await until(() => probe.plans.length === 2, 'menu plan');
    await idle();
    out.menuPlanHasPaths = 'paths' in probe.plans[1];

    // 3. Duplicates are asked once, then the run repeats with the answer.
    probe.planReply = { token: 't3', roots: [{ name: 'A', fileCount: 1, folderCount: 1 }], rejected: [] };
    probe.runReplies.push({ canceled: false, needsDuplicateDecision: true, duplicates: [{ id: 'd', path: '/x' }], total: 1 });
    probe.runReplies.push({ canceled: false, folders: 1, count: 1, ready: 1, ids: [], rejected: [], rootIds: [] });
    runMenuCommand({ command: 'import-folders' });
    await until(() => !$('#duplicateDialog').classList.contains('hidden'), 'duplicate dialog');
    $('#duplicateUseExistingButton').click();
    await until(() => probe.runs.length === 3, 'second run');
    await idle();
    out.duplicateRun = probe.runs[2];

    // 4. A drop on a sidebar folder takes files only; the content area flattens.
    drop(document.querySelector('#folderTree [data-folder-id="mv-folder"]'), [['dir', '/Users/tester/dir']]);
    await until(() => probe.imports.length === 1, 'row import');
    await idle();
    drop(document.querySelector('#gridScroller'), [['dir2', '/Users/tester/dir2']]);
    await until(() => probe.imports.length === 2, 'content import');
    await idle();
    out.rowImport = probe.imports[0];
    out.contentImport = probe.imports[1];
    out.plansAfterRowDrops = probe.plans.length;
    return out;
  })()`);
  console.log(`EAGLEMV_FOLDER_STRUCTURE ${JSON.stringify(result)}`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
