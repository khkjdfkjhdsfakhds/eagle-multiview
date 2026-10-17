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
    const folder = state.library.folders[0];
    folder.iconColor = 'red';
    delete folder.color;
    renderFolderTree();
    const row = document.querySelector('[data-folder-id="' + folder.id + '"]');
    const dot = row?.querySelector('.folder-color-dot');
    return { value: folderColorValue({ iconColor: 'blue' }), hex: folderColorValue({ iconColor: '#123456' }), dot: dot?.style.background || null };
  })()`);
  console.log(`EAGLEMV_FOLDER_COLOR ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
