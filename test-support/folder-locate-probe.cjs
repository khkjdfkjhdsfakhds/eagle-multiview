'use strict';
// Real-renderer check for /: it toggles between expanding every folder
// (locating the current one) and collapsing every folder, as Eagle does.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-folder-locate-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1200, height: 360, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const leaf = (id, n) => Array.from({ length: n }, (_, index) => ({ id: id + index, name: id + index, children: [] }));
    // Enough siblings above the current folder that it starts out of view.
    state.library.folders = [
      { id: 'other', name: 'Other', children: leaf('o', 3) },
      ...leaf('top', 20),
      { id: 'A', name: 'A', children: [{ id: 'B', name: 'B', children: [{ id: 'C', name: 'C', children: [{ id: 'D', name: 'D', children: [] }] }, ...leaf('b', 3)] }] }
    ];
    navigate({ kind: 'folder', id: 'C' }, { refreshView: false, skipDiscard: true });
    state.expandedFolders = new Set(['A', 'B']);
    renderFolderTree();
    const press = async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
      await frame();
      const tree = document.querySelector('#folderTree');
      const active = tree.querySelector('.folder-row.active');
      const box = active?.getBoundingClientRect(), outer = tree.getBoundingClientRect();
      return {
        expanded: [...state.expandedFolders].sort(),
        toast: document.querySelector('#toast').textContent,
        activeVisible: Boolean(box && box.top >= outer.top - 1 && box.bottom <= outer.bottom + 1),
        rows: tree.querySelectorAll('.folder-row').length
      };
    };
    const first = await press();
    const second = await press();
    const third = await press();
    const fourth = await press();
    navigate({ kind: 'all' }, { refreshView: false, skipDiscard: true });
    state.expandedFolders = new Set(['A', 'B', 'C', 'other']);
    renderFolderTree();
    const rootCollapse = await press();
    return { first, second, third, fourth, rootCollapse };
  })()`);
  console.log('FOLDER_LOCATE ' + JSON.stringify(result));
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
