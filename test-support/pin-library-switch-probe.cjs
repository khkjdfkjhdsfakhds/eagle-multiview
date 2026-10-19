'use strict';
// B2-10: a pin request that returns after the library switched must not
// install the old library's pin table into the new one.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-pin-switch-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, preload: path.join(__dirname, 'renderer-ui-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !state.connected; i += 1) await wait(20);
    if (!state.connected) throw new Error('fixture library not connected');
    const pane = paneById(state.activePaneId);
    pane.currentView = { kind: 'folder', id: 'mv-folder' };
    const item = { id: 'pin-me', name: 'pin', ext: 'png', folders: ['mv-folder'], tags: [] };
    pane.items = [item]; pane.itemMap.set(item.id, item);
    let release;
    window.eagleMV.setPins = () => new Promise(resolve => { release = resolve; });
    const pending = setPinned(['pin-me'], true, pane.id);
    for (let i = 0; i < 50 && !release; i += 1) await wait(10);
    // The library switches while the request is in flight.
    const newPins = { 'new-folder': { other: 1 } };
    state.library = { ...state.library, path: '/tmp/Other.library' };
    state.localPins = newPins;
    release({ 'mv-folder': { 'pin-me': 1 } });
    await pending;
    const kept = state.localPins === newPins;
    // Without a switch the reply is installed.
    window.eagleMV.setPins = async () => ({ 'mv-folder': { 'pin-me': 2 } });
    await setPinned(['pin-me'], true, pane.id);
    return { kept, installed: state.localPins?.['mv-folder']?.['pin-me'] === 2 };
  })()`);
  console.log(`EAGLEMV_PIN_SWITCH ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
