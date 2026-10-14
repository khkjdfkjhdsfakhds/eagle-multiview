'use strict';
// B1-01: a pane opened by a split shows its folder in the remembered sort.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-new-pane-sort-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1400, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'batch-selection-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.items.length === 3); i += 1) await wait(20);
    navigate({ kind: 'folder', id: 'mv-folder' });
    await wait(50);
    state.sort = 'name';
    state.sortDir = 'desc';
    sortMemory.remember(state.library.path, descriptorKey(state.currentView), 'name', 'desc', Date.now());
    renderPaneLayout('vertical2', { refresh: true });
    await wait(100);
    return state.panes.map(pane => ({ view: pane.currentView.id || pane.currentView.kind, sort: pane.sort, sortDir: pane.sortDir }));
  })()`);
  console.log(`EAGLEMV_NEW_PANE_SORT ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
