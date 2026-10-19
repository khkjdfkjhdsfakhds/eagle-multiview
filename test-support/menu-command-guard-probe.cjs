'use strict';
// F-05: a menu command (⌥N, ⌘R, a rating) fired while a dialog covers the
// workspace does nothing behind it; an open context menu just gives way.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-menu-command-guard-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'menu-command-guard-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.items.length === 3); i += 1) await wait(20);
    if (state.items.length !== 3) throw new Error('fixture items not loaded');
    const commands = window.__menuCommands;
    const nameDialogOpen = () => !$('#folderDialog').classList.contains('hidden');
    const out = {};
    selectItem('a');

    // The trash prompt is up: ⌥N, ⌘R and a rating must not reach the grid.
    $('#trashDialog').classList.remove('hidden');
    commands.onCreateFolderRequest();
    commands.onRenameRequest();
    commands.onSetRating({ ids: ['a'], rating: 4 });
    await wait(60);
    out.behindTrashPrompt = { nameDialog: nameDialogOpen(), writes: window.__batchCalls.length, toast: $('#toast').textContent };
    $('#trashDialog').classList.add('hidden');

    // A native modal dialog (feature dialogs, thumbnail, site import).
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    dialog.showModal();
    commands.onCreateFolderRequest();
    await wait(60);
    out.behindModal = { nameDialog: nameDialogOpen() };
    dialog.close();
    dialog.remove();

    // Only a context menu open: it closes and the command runs.
    showContextMenuAt(200, 200, { kind: 'workspace', ids: [], folderId: null, paneId: state.activePaneId });
    out.menuShown = !$('#contextMenu').classList.contains('hidden');
    commands.onCreateFolderRequest();
    await wait(60);
    out.overMenu = { menu: !$('#contextMenu').classList.contains('hidden'), nameDialog: nameDialogOpen() };
    closeFolderDialog();
    return out;
  })()`);
  console.log(`EAGLEMV_MENU_COMMAND_GUARD ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
