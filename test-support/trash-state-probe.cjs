'use strict';
// B3-04: ⌫ on items already in the trash writes nothing and adds no undo
// entry; restoring a live item writes nothing either.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-trash-state-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'trash-state-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.items.length === 2); i += 1) await wait(20);
    if (state.items.length !== 2) throw new Error('fixture items not loaded');
    await applyTrash(['gone'], true);
    await applyTrash(['live'], false);
    const noop = { calls: window.__trashCalls.length, undo: trashUndoStack.length };
    await applyTrash(['gone', 'live'], true);
    return { noop, mixed: window.__trashCalls.map(call => call.id), undo: trashUndoStack.map(entry => entry.ids) };
  })()`);
  console.log(`EAGLEMV_TRASH_STATE ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
