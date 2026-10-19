'use strict';
// Real-renderer check for P7-17: in a 980px window, folder names stay
// readable down to the sixth level (Eagle indents each level 20px), the
// count gives way before the name, and every row names its folder in a
// tooltip.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-sidebar-depth-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 980, height: 640, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    let chain = [];
    for (let depth = 7; depth >= 0; depth--) {
      chain = [{ id: 'deep-' + depth, name: '第' + depth + '层参考文件夹', imageCount: 12345, descendantImageCount: 12345, children: chain }];
    }
    state.library.folders = [...state.library.folders, ...chain];
    for (let depth = 0; depth < 8; depth++) state.expandedFolders.add('deep-' + depth);
    renderFolderTree();
    await wait(30);
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    assert(sidebar.width > 0, 'sidebar hidden');
    const widths = [];
    for (let depth = 0; depth <= 7; depth++) {
      const row = document.querySelector('[data-folder-id="deep-' + depth + '"]');
      assert(row, 'row for depth ' + depth + ' missing');
      assert(row.title && row.title.includes('第' + depth + '层参考文件夹'), 'depth ' + depth + ' row has no title: ' + row.title);
      widths.push(Math.round(row.querySelector('.folder-name').getBoundingClientRect().width));
    }
    for (let depth = 0; depth <= 5; depth++) {
      assert(widths[depth] >= 36, 'depth ' + depth + ' name squeezed to ' + widths[depth] + 'px (sidebar ' + sidebar.width + '): ' + widths.join(','));
    }
    const first = document.querySelector('[data-folder-id="deep-0"]').getBoundingClientRect().left;
    const second = document.querySelector('[data-folder-id="deep-1"]').getBoundingClientRect().left;
    assert(Math.round(second - first) === 20, 'indent per level ' + (second - first));
  })()`);
  console.log('SIDEBAR_DEPTH_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
