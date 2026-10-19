'use strict';
// B3-08: reloading a library's extras keeps manual orders ready meanwhile.
// H-11: a failed read keeps what was shown; an older load cannot win.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-library-extras-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'library-extras-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.manualOrdersReady); i += 1) await wait(20);
    const out = { readyAtStart: state.manualOrdersReady, pinsAtStart: JSON.stringify(state.localPins) };
    __extras.holdOrders = true;
    __extras.failPins = true;
    const reload = loadLibraryExtras();
    await wait(30);
    out.readyDuringReload = state.manualOrdersReady;
    __extrasRelease();
    await reload;
    out.pinsAfterFailure = JSON.stringify(state.localPins);
    out.colorsAfterReload = JSON.stringify(state.tagColors);
    // An older, slower load must not overwrite a newer one; requests made
    // while it runs fold into one more read after it (H-11).
    __extras.failPins = false;
    __extras.pinsReply = { old: { i: 1 } };
    const readsBefore = __extras.pinReads;
    const older = loadLibraryExtras();
    await wait(10);
    __extras.holdOrders = false;
    __extras.pinsReply = { new: { i: 1 } };
    const newer = [loadLibraryExtras(), loadLibraryExtras(), loadLibraryExtras()];
    __extrasRelease();
    await Promise.all([older, ...newer]);
    out.pinsAfterRace = JSON.stringify(state.localPins);
    out.readsForFourRequests = __extras.pinReads - readsBefore;
    // A colour broadcast carries the whole table and needs no reload.
    const colorReads = __extras.colorReads; const pinReads = __extras.pinReads;
    await __extrasTagDataChanged({ libraryPath: state.library.path, reason: 'tag-color', colors: { blue: '#0000ff' } });
    out.colorsFromBroadcast = JSON.stringify(state.tagColors);
    out.readsForColorBroadcast = (__extras.colorReads - colorReads) + (__extras.pinReads - pinReads);
    return out;
  })()`);
  console.log(`EAGLEMV_LIBRARY_EXTRAS ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
