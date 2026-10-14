'use strict';
// B1-03: 新建 › 新建智能文件夹… from the context menu, with nothing filtered,
// opens the filter panel (and it stays open) instead of saving the view.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-new-smart-folder-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'batch-selection-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.items.length === 3); i += 1) await wait(20);
    const choose = () => {
      showContextMenuAt(200, 200, { kind: 'workspace', ids: [], folderId: state.currentView.id || null, paneId: state.activePaneId });
      document.querySelector('#contextMenu [data-context-action="create-smart-folder"]').click();
    };
    const open = selector => !$(selector).classList.contains('hidden');
    const out = {};
    for (const view of [{ kind: 'root' }, { kind: 'folder', id: 'mv-folder' }]) {
      navigate(view);
      await wait(40);
      choose();
      await wait(60);
      out[view.kind] = { filterPanel: open('#filterPopover'), nameDialog: open('#folderDialog') };
      if (open('#folderDialog')) closeFolderDialog();
      $('#filterPopover').classList.add('hidden');
    }
    state.query.tags = ['x'];
    choose();
    await wait(60);
    out.withFilter = { nameDialog: open('#folderDialog'), title: $('#folderDialogTitle')?.textContent || '' };
    return out;
  })()`);
  console.log(`EAGLEMV_NEW_SMART_FOLDER ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
