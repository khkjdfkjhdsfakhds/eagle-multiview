'use strict';
// Real-renderer check for dragging a folder onto another pane: plain drag
// moves it into that pane's folder, Option+drag copies the whole subtree.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-cross-pane-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'feature-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (fn, label) => { for (let i = 0; i < 200; i++) { if (fn()) return; await wait(20); } throw Error('timeout: ' + label); };
    const assert = (value, message) => { if (!value) throw Error(message); };
    await until(() => state.connected, 'connect');
    document.querySelector('[data-toggle-folder="eagle-folder"]').click();
    await until(() => document.querySelector('.folder-row[data-folder-node-id="mv-folder"]'), 'folder tree rows');
    document.querySelector('.folder-card[data-open-folder="eagle-folder"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await until(() => document.querySelector('[data-crumb-folder-id="eagle-folder"]'), 'enter folder');
    assert(renderPaneLayout('vertical2', { refresh: false }) === true, 'two-pane layout refused');
    await until(() => document.querySelectorAll('#paneLayout > .content-pane').length === 2, 'two panes rendered');
    const [paneA, paneB] = state.panes;
    paneA.currentView = { kind: 'folder', id: 'other-parent' };
    const calls = kind => window.__uiTestCalls.filter(call => call.kind === kind);
    const dragStart = (folderId, dataTransfer) => {
      const row = document.querySelector('.folder-row[data-folder-node-id="' + folderId + '"]');
      assert(row, 'missing folder row ' + folderId);
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    };
    const dropOnPane = async (paneId, { alt = false } = {}) => {
      const root = document.querySelector('.content-pane[data-pane-id="' + paneId + '"]');
      const box = root.getBoundingClientRect();
      const point = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      root.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, altKey: alt, ...point }));
      return { root, point };
    };
    // 1. Plain cross-pane drag moves into the other pane's folder.
    let before = calls('move-folder').length;
    window.__dt = new DataTransfer();
    dragStart('mv-folder', window.__dt);
    let { root, point } = await dropOnPane(paneB.id);
    assert(root.dataset.folderNodeDrop === 'allowed', 'other pane refused the folder');
    root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, ...point }));
    await until(() => calls('move-folder').length === before + 1, 'cross-pane move submitted');
    let payload = calls('move-folder').at(-1).payload;
    assert(payload.parentId === 'eagle-folder', 'cross-pane move parent was ' + payload.parentId);
    await wait(50);
    assert(!document.querySelector('[data-folder-node-drop]'), 'pane drop highlight stuck');
    // 2. Option+drag onto the same pane copies instead of moving.
    before = calls('copy-folder').length;
    const movesBefore = calls('move-folder').length;
    window.__dt = new DataTransfer();
    dragStart('mv-folder', window.__dt);
    ({ root, point } = await dropOnPane(paneB.id, { alt: true }));
    assert(root.dataset.folderNodeDrop === 'allowed', 'other pane refused the option drag');
    root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, altKey: true, ...point }));
    await until(() => calls('copy-folder').length === before + 1, 'cross-pane copy submitted');
    payload = calls('copy-folder').at(-1).payload;
    assert(payload.sourceId === 'mv-folder', 'copy source was ' + payload.sourceId);
    assert(payload.parentId === 'eagle-folder', 'copy parent was ' + payload.parentId);
    assert(calls('move-folder').length === movesBefore, 'option drag also moved the folder');
    // 3. Same window, own pane resolves to that pane's folder.
    before = calls('move-folder').length;
    window.__dt = new DataTransfer();
    dragStart('mv-folder', window.__dt);
    ({ root, point } = await dropOnPane(paneA.id));
    assert(root.dataset.folderNodeDrop === 'allowed', 'own pane refused the folder');
    root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, ...point }));
    await until(() => calls('move-folder').length === before + 1, 'own-pane move submitted');
    assert(calls('move-folder').at(-1).payload.parentId === 'other-parent', 'own-pane move parent wrong');
    // 4. A pane already showing the dragged folder refuses it.
    before = calls('move-folder').length + calls('copy-folder').length;
    window.__dt = new DataTransfer();
    dragStart('eagle-folder', window.__dt);
    ({ root } = await dropOnPane(paneB.id));
    assert(root.dataset.folderNodeDrop === 'blocked', 'pane accepted a folder onto itself');
    root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, ...point }));
    await wait(120);
    assert(calls('move-folder').length + calls('copy-folder').length === before, 'self drop wrote anyway');
  })()`);
  console.log('FOLDER_CROSS_PANE_DRAG_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
