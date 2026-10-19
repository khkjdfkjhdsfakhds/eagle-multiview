'use strict';
// P3-05 in a real renderer: each undoable notice says what Eagle says and
// its 撤销 (⌘Z) writes back exactly what the edit replaced.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-notice-undo-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1300, height: 860, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'notice-undo-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (fn, label) => { for (let i = 0; i < 250; i++) { if (fn()) return; await wait(20); } throw Error('timeout: ' + label); };
    await until(() => state.connected, 'connect');
    const probe = window.__noticeUndo;
    const idle = () => until(() => !state.operationTracker.active().length, 'idle');
    const notice = () => document.querySelector('#toast').textContent;
    const undoNow = async () => { const before = probe.mutates.length; routeUndoCommand(); await until(() => probe.mutates.length > before || !undoSlot, 'undo'); await idle(); return probe.mutates.slice(before); };
    const out = {};

    await removeSelectionFromFolder({ ids: ['a', 'b'], folderId: 'mv-folder' });
    await idle();
    out.removeNotice = notice();
    out.removeUndo = await undoNow();

    await addSelectionToFolder({ ids: ['a'], folderId: 'eagle-folder' });
    await idle();
    out.addNotice = notice();
    out.addUndo = await undoNow();

    await moveSelectionToFolder({ ids: ['b'], folderId: 'mv-folder', sourceFolderId: 'eagle-folder' });
    await idle();
    out.moveNotice = notice();
    out.moveUndo = await undoNow();

    await addItemsToFolder(['a'], 'eagle-folder', 'Eagle 文件夹', state.library.path, { move: true, sourceFolderId: 'mv-folder' });
    await idle();
    out.dragNotice = notice();
    out.dragUndo = await undoNow();

    await clearTagsOnItems(['a', 'b']);
    await idle();
    out.clearNotice = notice();
    const clearWrites = probe.mutates.slice(-1);
    out.clearWrites = clearWrites;
    out.clearUndo = await undoNow();

    await renameFolderTo({ id: 'mv-folder', name: 'MultiView 文件夹' }, '新名字');
    await idle();
    out.renameNotice = notice();
    routeUndoCommand();
    await until(() => probe.folderRenames.length === 2, 'rename undo');
    await idle();
    out.renameUndo = probe.folderRenames[1];
    return out;
  })()`);
  console.log(`EAGLEMV_NOTICE_UNDO ${JSON.stringify(result)}`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
