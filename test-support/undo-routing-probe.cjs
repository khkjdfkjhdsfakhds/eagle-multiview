'use strict';
// Real-renderer check for BUG-01: 编辑 → 撤销 (⌘Z) undoes typing in a focused
// field instead of undoing a delete, and does nothing behind an open dialog.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-undo-routing-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'undo-routing-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && window.__undoMenu); i += 1) await wait(20);
    if (!window.__undoMenu) throw new Error('undo menu handler never registered');
    const toasts = [];
    const showToast = window.toast;
    window.toast = (message, ...rest) => { toasts.push(String(message)); return showToast(message, ...rest); };
    const input = document.querySelector('#searchInput');
    input.focus();
    document.execCommand('insertText', false, 'abc');
    const typed = input.value;
    window.__undoMenu();
    await wait(50);
    const afterUndo = input.value;
    input.blur();
    document.querySelector('#folderDialog').classList.remove('hidden');
    window.__undoMenu();
    await wait(50);
    const behindDialog = toasts.slice();
    document.querySelector('#folderDialog').classList.add('hidden');
    document.body.focus();
    await wait(50);
    const focusTag = document.activeElement?.id || document.activeElement?.tagName;
    const openDialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(d => !d.classList.contains('hidden')).map(d => d.id);
    window.__undoMenu();
    await wait(50);
    return { focusTag, openDialogs, typed, afterUndo, behindDialog, plain: toasts.slice(behindDialog.length) };
  })()`);
  console.log(`EAGLEMV_UNDO_ROUTING ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
