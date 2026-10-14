'use strict';
// Real-renderer check for P7-15: like Eagle, the 子文件夹 section above the
// files folds open or shut from its heading, once for every pane and view,
// remembered across reloads, so a folder with many subfolders (in any layout,
// the list included) shows its files at once.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-subfolder-section-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 800, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'inspector-refresh-preload.cjs')
  } });
  const source = path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html');
  const setup = `(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const parent = state.library.folders.find(folder => folder.id === 'mv-folder');
    parent.children = Array.from({ length: 50 }, (_, index) => ({ id: 'sub-' + index, name: '子文件夹 ' + index, imageCount: index, children: [] }));
    renderPaneLayout('vertical2', { refresh: false });
    await wait(30);
    for (const pane of state.panes) {
      pane.currentView = { kind: 'folder', id: 'mv-folder' };
      pane.viewMode = 'list';
      await refresh({ reset: true, paneId: pane.id });
    }
    await wait(40);
  })()`;
  await win.loadFile(source);
  await win.webContents.executeJavaScript(setup);
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    const [a, b] = state.panes;
    const toggle = paneId => paneQuery(paneId, '[data-toggle-subfolders]');
    const cards = paneId => paneRoot(paneId).querySelectorAll('.folder-card').length;
    const firstFileTop = paneId => paneQuery(paneId, '.item-card').getBoundingClientRect().top;
    assert(toggle(a.id) && toggle(a.id).getAttribute('aria-expanded') === 'true', 'section not open by default');
    assert(toggle(a.id).textContent.includes('子文件夹') && toggle(a.id).textContent.includes('50'), 'heading text ' + toggle(a.id).textContent);
    assert(cards(a.id) === 50, 'open section shows ' + cards(a.id) + ' cards');
    const before = firstFileTop(a.id);
    assert(before > innerHeight, 'fixture: files already on screen at ' + before);
    // Select a card first: folding must not leave an invisible selection.
    paneRoot(a.id).querySelector('.folder-card').click();
    await wait(20);
    assert(a.selectedFolderCard, 'card click did not select');
    toggle(a.id).click();
    await wait(40);
    assert(toggle(a.id).getAttribute('aria-expanded') === 'false', 'heading did not fold');
    assert(cards(a.id) === 0 && cards(b.id) === 0, 'folded section still shows cards (A ' + cards(a.id) + ', B ' + cards(b.id) + ')');
    assert(!a.selectedFolderCard, 'a folded card stayed selected');
    assert(firstFileTop(a.id) < innerHeight, 'files still below the fold at ' + firstFileTop(a.id));
    assert(toggle(b.id).getAttribute('aria-expanded') === 'false', 'other pane not folded');
  })()`);
  // Remembered across a reload.
  await win.loadFile(source);
  await win.webContents.executeJavaScript(setup);
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    const pane = state.panes[0];
    const toggle = paneQuery(pane.id, '[data-toggle-subfolders]');
    assert(toggle.getAttribute('aria-expanded') === 'false', 'fold not remembered');
    toggle.click();
    await wait(40);
    assert(paneRoot(pane.id).querySelectorAll('.folder-card').length === 50, 'unfold did not bring the cards back');
  })()`);
  console.log('SUBFOLDER_SECTION_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
