'use strict';
// P6-02: ⌘A selects the whole view, loading past the first page, up to the
// locate cap, and says so when the view is larger than that.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-select-all-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'select-all-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.items.length); i += 1) await wait(20);
    const firstPage = state.items.length;
    const toasts = [];
    new MutationObserver(() => toasts.push($('#toast').textContent)).observe($('#toast'), { childList: true, characterData: true, subtree: true });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', metaKey: true, ctrlKey: !navigator.platform.startsWith('Mac'), bubbles: true, cancelable: true }));
    for (let i = 0; i < 200 && !toasts.some(text => /已全选/.test(text)); i += 1) await wait(20);
    return { firstPage, loaded: state.items.length, selected: state.selected.size, toast: toasts.at(-1) || '' };
  })()`);
  console.log(`EAGLEMV_SELECT_ALL ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
