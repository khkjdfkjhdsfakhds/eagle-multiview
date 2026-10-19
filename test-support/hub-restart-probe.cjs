'use strict';
// H-02: after the host restarts its snapshot revisions count from 0 again;
// a page that outlived the restart must still apply them.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-hub-restart-');
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
    const until = async predicate => { for (let i = 0; i < 100; i += 1) { if (predicate()) return true; await wait(20); } return false; };
    await until(() => window.state?.connected && window.__uiTestLibraryChanged);
    const send = (name, revision, hubInstance) => window.__uiTestLibraryChanged({ library: { ...state.library, name }, revision, hubInstance, source: 'multiview' });
    send('before restart', 50, 'host-1');
    const first = await until(() => state.library.name === 'before restart');
    send('stale', 40, 'host-1');
    await wait(200);
    const staleIgnored = state.library.name === 'before restart';
    send('after restart', 1, 'host-2');
    const restarted = await until(() => state.library.name === 'after restart');
    return { first, staleIgnored, restarted };
  })()`);
  console.log(`EAGLEMV_HUB_RESTART ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
