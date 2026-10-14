'use strict';
// B3-02: when the folder of a background pane is deleted in Eagle, that pane
// returns to the library root without redrawing the shared inspector, search
// box or filter panel of the pane the user is working in.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-bg-delete-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: { sandbox: false, contextIsolation: false, backgroundThrottling: false, preload: path.join(__dirname, 'renderer-ui-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !state.connected; i += 1) await wait(20);
    if (!state.connected) throw new Error('fixture library not connected');
    const item = { id: 'note-item', name: 'needle', ext: 'png', width: 10, height: 10, folders: ['mv-folder'], tags: [], annotation: '' };
    window.eagleMV.query = async query => query.folderId === 'mv-folder'
      ? { data: [structuredClone(item)], total: 1, nextOffset: 1, hasMore: false }
      : { data: [], total: 0, nextOffset: 0, hasMore: false };
    window.eagleMV.getItem = async () => structuredClone(item);
    renderPaneLayout('vertical2', { refresh: false });
    const [a, b] = state.panes;
    activatePane(b.id);
    navigate({ kind: 'folder', id: 'eagle-folder' });
    activatePane(a.id);
    navigate({ kind: 'folder', id: 'mv-folder' }, { query: { ...cloneQuery(state.query), search: 'needle' } });
    await refresh({ reset: true, preserveScroll: false, paneId: a.id });
    selectItem('note-item');
    const note = document.querySelector('#itemAnnotation');
    note.value = 'unsaved note';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    const before = { dirty: state.inspectorDirty, search: document.querySelector('#searchInput').value };
    // Eagle deletes B's folder.
    const library = { ...state.library, folders: state.library.folders.filter(folder => folder.id !== 'eagle-folder') };
    window.eagleMV.connect = async () => ({ app: { version: 'ui-test' }, library });
    window.__uiTestLibraryChanged({ library, revision: 100, source: 'eagle' });
    for (let i = 0; i < 200 && b.currentView.kind !== 'root'; i += 1) await wait(20);
    await wait(50);
    return {
      before,
      bView: b.currentView.kind,
      active: state.activePaneId === a.id,
      dirty: state.inspectorDirty,
      note: document.querySelector('#itemAnnotation').value,
      name: document.querySelector('#itemName').value,
      inspectorShown: !document.querySelector('#inspectorContent').classList.contains('hidden')
        && document.querySelector('#noSelection').classList.contains('hidden'),
      search: document.querySelector('#searchInput').value
    };
  })()`);
  console.log(`EAGLEMV_BG_DELETE ${JSON.stringify(result)}`);
  // The unsaved note would hold the window open through the close protocol.
  window.destroy();
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  // An unsaved inspector edit would hold windows open through the close protocol.
  for (const open of BrowserWindow.getAllWindows()) open.destroy();
  app.quit();
});
