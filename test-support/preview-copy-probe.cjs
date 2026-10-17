'use strict';
// B3-01: ⌘C in the preview copies the item on screen, not the grid selection,
// and works in a preview opened without any selection (touch).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-preview-copy-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'preview-copy-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.items.length === 3); i += 1) await wait(20);
    if (state.items.length !== 3) throw new Error('fixture items not loaded');
    const copy = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', metaKey: true, ctrlKey: !navigator.platform.startsWith('Mac'), bubbles: true, cancelable: true }));
    selectItem('a');
    await openPreview('a');
    await openPreview('b');
    copy();
    await wait(30);
    const paged = window.__copied.at(-1) || null;
    closePreview({ commitSelection: false });
    state.selected.clear();
    await openPreview('c');
    copy();
    await wait(30);
    const unselected = window.__copied.at(-1) || null;
    closePreview({ commitSelection: false });
    selectItem('a');
    copy();
    await wait(30);
    return { paged, unselected, grid: window.__copied.at(-1) || null };
  })()`);
  console.log(`EAGLEMV_PREVIEW_COPY ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
