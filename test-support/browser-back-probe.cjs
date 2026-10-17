'use strict';
// Real-renderer check for W-08: a plain phone browser (web client without the
// Android shell) gets back semantics. While back has something to close a
// sentinel history entry exists; popping it closes the preview, then the
// selection, then steps back through folders; with nothing left the sentinel
// goes, so the next back leaves the page. The preview keeps its close button
// on touch.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-browser-back-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 390, height: 844, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'web-mobile-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    assert(document.body.classList.contains('browser-back'), 'browser client not detected');
    state.library.folders.find(folder => folder.id === 'mv-folder').children = [{ id: 'child', name: '子文件夹', children: [] }];
    navigate({ kind: 'folder', id: 'mv-folder' });
    await wait(80);
    const settle = async () => { document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })); await wait(40); };
    const back = async () => { history.back(); await wait(120); };
    const guard = () => Boolean(history.state?.eaglemvBackGuard);
    // Start from a clean history: the first navigation already counts.
    state.history = [state.history[state.historyIndex]];
    state.historyIndex = 0;
    await settle();
    assert(!guard(), 'guard armed with nothing to close');

    // 1. Preview over a selection: back closes the preview, then the selection.
    selectItem('i-0');
    openPreview('i-0');
    await wait(60);
    await settle();
    assert(guard(), 'guard not armed for an open preview');
    const close = document.querySelector('#previewModal:not(.hidden) .modal-close, .content-pane.active #previewModal .modal-close');
    assert(close && getComputedStyle(close).display !== 'none', 'preview close button hidden on a touch browser');
    await back();
    assert(document.querySelector('.content-pane.active #previewModal').classList.contains('hidden'), 'back did not close the preview');
    assert(state.selected.size === 1, 'back closed more than the preview');
    assert(guard(), 'guard not re-armed while a selection remains');
    await back();
    assert(state.selected.size === 0, 'second back did not clear the selection');
    assert(!guard(), 'guard left behind with nothing to close');

    // 2. Folder history: back steps out of the subfolder.
    navigate({ kind: 'folder', id: 'child' });
    await wait(80);
    await settle();
    assert(guard(), 'guard not armed after entering a folder');
    await back();
    assert(state.currentView.kind === 'folder' && state.currentView.id === 'mv-folder', 'back did not step out: ' + JSON.stringify(state.currentView));
    assert(!guard(), 'guard left at the first page');

    // 3. Closing things by hand removes the sentinel, so back is not swallowed.
    selectItem('i-1');
    await settle();
    assert(guard(), 'guard not armed for a selection');
    clearSelection();
    await settle();
    await wait(120);
    assert(!guard(), 'stale guard after the selection was cleared by hand');
    assert(state.currentView.id === 'mv-folder', 'disarming navigated the app: ' + JSON.stringify(state.currentView));
  })()`);
  console.log('BROWSER_BACK_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
