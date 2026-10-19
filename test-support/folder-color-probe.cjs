'use strict';
// P6-01: Eagle's iconColor reaches the sidebar as a colour dot.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-folder-color-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'renderer-ui-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.library?.folders?.length); i += 1) await wait(20);
    const folders = state.library.folders;
    const folder = folders[0];
    folder.iconColor = 'red';
    delete folder.color;
    // T-06: the lock badge, the quick-access row and the locked-folder guard
    // are checked in the rendered sidebar, not in the source text.
    const locked = folders.find(entry => entry !== folder) || folders[0];
    locked.password = 'secret';
    state.library.quickAccess = [{ type: 'folder', id: folder.id }];
    const quickBefore = typeof quickAccessEntries === 'function';
    renderFolderTree();
    const rows = [...document.querySelectorAll('[data-folder-id="' + folder.id + '"]')];
    const dot = rows[0]?.querySelector('.folder-color-dot');
    const named = Object.fromEntries(['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink', 'gray', 'RED', 'teal', ''].map(name => [name, folderColorValue({ iconColor: name })]));
    const lockedRow = document.querySelector('[data-folder-id="' + locked.id + '"]');
    const viewBefore = JSON.stringify(state.currentView);
    const historyBefore = JSON.stringify([state.history, state.historyIndex]);
    const entered = navigate({ kind: 'folder', id: locked.id });
    await wait(0);
    return {
      value: folderColorValue({ iconColor: 'blue' }), hex: folderColorValue({ iconColor: '#123456' }), shortHex: folderColorValue({ color: '#abc' }),
      dot: dot?.style.background || null, dotRows: rows.filter(row => row.querySelector('.folder-color-dot')).length, quickBefore,
      named, lockBadge: Boolean(lockedRow?.querySelector('.folder-lock')), plainHasLock: Boolean(rows[0]?.querySelector('.folder-lock')),
      entered, stayed: JSON.stringify(state.currentView) === viewBefore, historyKept: JSON.stringify([state.history, state.historyIndex]) === historyBefore,
      toast: document.querySelector('#toast')?.textContent || ''
    };
  })()`);
  console.log(`EAGLEMV_FOLDER_COLOR ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
