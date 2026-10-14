'use strict';
// B2-03: a search inside a folder must not rewrite the folder's count with
// the subtree match total. B2-07: a background pane's refresh must not move
// the sidebar highlight to its folder.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-folder-count-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1400, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'folder-count-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !window.state?.connected; i += 1) await wait(20);
    const folder = id => findFolder(state.library.folders, id);
    navigate({ kind: 'folder', id: 'A' });
    await wait(60);
    state.query.search = 'x';
    await refresh({ reset: true });
    const searched = { A: folder('A').imageCount };
    state.query.search = '';
    renderPaneLayout('vertical2', { refresh: true });
    await wait(80);
    const [first, second] = state.panes;
    activatePane(first.id);
    withActivePane(second.id, () => navigate({ kind: 'folder', id: 'B' }));
    await wait(60);
    activatePane(first.id);
    await refresh({ reset: true, paneId: second.id });
    await wait(30);
    const active = [...document.querySelectorAll('#folderTree .folder-row.active[data-folder-id]')].map(row => row.dataset.folderId);
    return { searched, bCount: folder('B').imageCount, activeView: state.currentView.id, sidebarActive: active };
  })()`);
  console.log(`EAGLEMV_FOLDER_COUNT ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
