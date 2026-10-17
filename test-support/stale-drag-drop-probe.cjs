'use strict';
// Real-renderer check for D-01 / D-02: Electron delivers no dragend once a
// native item drag leaves the window, so its state can linger. A later drop
// of Finder files must import them, never re-file the stale items, and every
// end of a session must reset the whole drag state.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-stale-drag-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'stale-drag-drop-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (fn, label) => { for (let i = 0; i < 200; i++) { if (fn()) return; await wait(20); } throw Error('timeout: ' + label); };
    const assert = (value, message) => { if (!value) throw Error(message); };
    await until(() => state.connected && state.manualOrdersReady, 'connect');
    assert(renderPaneLayout('vertical2', { refresh: false }) === true, 'two-pane layout refused');
    await until(() => document.querySelectorAll('#paneLayout > .content-pane').length === 2, 'two panes rendered');
    const [paneA, paneB] = state.panes;
    paneA.currentView = { kind: 'folder', id: 'mv-folder' };
    paneB.currentView = { kind: 'folder', id: 'eagle-folder' };
    await refresh({ reset: true, paneId: paneA.id });
    await refresh({ reset: true, paneId: paneB.id });
    const card = (paneId, id) => document.querySelector('.content-pane[data-pane-id="' + paneId + '"] .item-card[data-id="' + id + '"]');
    const scroller = paneId => document.querySelector('.content-pane[data-pane-id="' + paneId + '"] #gridScroller');
    await until(() => card(paneA.id, 'a-0') && card(paneB.id, 'b-1') && !paneA.loading && !paneB.loading, 'pane items');
    const { imports, paths, sessionFile } = window.__staleDrag;
    const mutations = window.__itemDrag.mutations;
    const idle = () => until(() => !state.operationTracker.active().length && !state.importing, 'operations idle');
    const startDrag = id => {
      card(paneA.id, id).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    };
    const dropFiles = (paneId, files) => {
      const data = new DataTransfer();
      for (const [name, filePath] of files) {
        paths.set(name, filePath);
        data.items.add(new File(['x'], name, { type: 'image/png' }));
      }
      const target = scroller(paneId);
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    };
    const dragCleared = () => !state.internalDrag && !state.draggingItemIds && !state.dragSourcePaneId
      && state.panes.every(pane => !pane.draggingItemIds);

    // 1. D-01: the item drag ends outside the window, so no dragend and no end
    //    broadcast arrive. Finder files dropped afterwards are imported.
    startDrag('a-0');
    assert(state.internalDrag?.active && state.internalDrag.token === window.__itemDrag.started, 'drag session not started');
    assert(state.draggingItemIds?.includes('a-0'), 'drag ids not recorded');
    let before = mutations.length;
    dropFiles(paneB.id, [['photo.png', '/Users/tester/Desktop/photo.png']]);
    await until(() => imports.length === 1, 'finder drop imported');
    await idle();
    assert(mutations.length === before, 'stale drag re-filed items: ' + JSON.stringify(mutations.slice(before)));
    assert(JSON.stringify(imports[0].paths) === JSON.stringify(['/Users/tester/Desktop/photo.png']), 'import paths ' + JSON.stringify(imports[0]));
    assert(imports[0].folderId === 'eagle-folder', 'import went to ' + imports[0].folderId);
    assert(dragCleared(), 'drag state survived the drop');

    // 2. Main's last-resort end (with the session token) resets everything,
    //    including the window-level ids.
    startDrag('a-1');
    window.__itemDrag.emit({ active: false, token: window.__itemDrag.started });
    assert(dragCleared(), 'token end left drag state behind');

    // 3. D-02: a native start that fails reports no token. The pending local
    //    drag never received one, so it must still be reset.
    const listener = window.__itemDrag.emit;
    window.__itemDrag.emit = null;
    startDrag('a-1');
    window.__itemDrag.emit = listener;
    assert(state.internalDrag && !state.internalDrag.token, 'pending drag should have no token yet');
    listener({ active: false });
    assert(dragCleared(), 'tokenless failure left drag state behind');

    // 4. An older session's late end does not clear a newer one.
    startDrag('a-1');
    const live = window.__itemDrag.started;
    window.__itemDrag.emit({ active: false, token: live - 1 });
    assert(state.internalDrag?.token === live, 'older end cleared the live drag');

    // 5. The live session's own files still re-file the items as a move.
    before = mutations.length;
    dropFiles(paneB.id, [['a-1.png', sessionFile('a-1')]]);
    await until(() => mutations.length === before + 1, 'session drop re-filed');
    await idle();
    const moved = mutations.at(-1);
    assert(moved.id === 'a-1' && moved.add[0] === 'eagle-folder' && moved.remove[0] === 'mv-folder', 'move payload ' + JSON.stringify(moved));
    assert(imports.length === 1, 'session files were imported again');
    assert(dragCleared(), 'drag state survived the session drop');
  })()`);
  console.log('STALE_DRAG_DROP_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
