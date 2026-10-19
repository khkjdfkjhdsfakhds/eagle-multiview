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
    const calls = [];
    const offer = (name, duration = 4000) => toast(name, duration, { undo: () => { calls.push(name); } });
    const input = document.querySelector('#searchInput');
    input.focus();
    document.execCommand('insertText', false, 'abc');
    const typed = input.value;
    offer('typing');
    window.__undoMenu();
    await wait(50);
    const afterUndo = input.value;
    input.blur();
    // Behind a dialog nothing runs and the undo stays.
    document.querySelector('#folderDialog').classList.remove('hidden');
    window.__undoMenu();
    await wait(50);
    const behindDialog = calls.slice();
    document.querySelector('#folderDialog').classList.add('hidden');
    document.body.focus();
    await wait(50);
    window.__undoMenu();
    await wait(50);
    const afterPlain = calls.slice();
    // Eagle has one undo: a second ⌘Z does nothing.
    window.__undoMenu();
    await wait(50);
    const afterSecond = calls.slice();
    // A later notice without 撤销 takes the undo's place.
    offer('replaced');
    toast('其他提示');
    window.__undoMenu();
    await wait(50);
    const afterReplaced = calls.slice();
    // The 撤销 link runs it and closes the notice.
    offer('link');
    const link = document.querySelector('#toast .toast-undo');
    const linkText = link?.textContent;
    const clickable = getComputedStyle(document.querySelector('#toast')).pointerEvents;
    link?.click();
    await wait(50);
    const afterLink = calls.slice();
    const hiddenAfterLink = document.querySelector('#toast').classList.contains('hidden');
    // 5 s after the notice has gone, it no longer undoes.
    offer('expired', 10);
    undoSlot.expiresAt = Date.now() - 1;
    window.__undoMenu();
    await wait(50);
    return { typed, afterUndo, behindDialog, afterPlain, afterSecond, afterReplaced, linkText, clickable, afterLink, hiddenAfterLink, final: calls.slice() };
  })()`);
  console.log(`EAGLEMV_UNDO_ROUTING ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
