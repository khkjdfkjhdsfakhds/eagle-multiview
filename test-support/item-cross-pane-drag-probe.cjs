'use strict';
// Real-renderer check for dropping images onto the cards of another pane.
// Item drags start the native session through the manual-order handler; a
// drop that lands on a card of a different folder must still move/copy the
// images into that pane instead of being swallowed as a failed reorder.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-item-cross-pane-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'item-cross-pane-drag-preload.cjs')
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
    await until(() => card(paneA.id, 'a-0') && card(paneB.id, 'b-1') && !paneA.loading && !paneB.loading, 'pane items');
    const mutations = window.__itemDrag.mutations;
    const dragOnto = (sourceId, target, { alt = false } = {}) => {
      const data = new DataTransfer();
      // A constructed DataTransfer ignores dropEffect writes; record them.
      let effect = 'none';
      Object.defineProperty(data, 'dropEffect', { get: () => effect, set: value => { effect = value; } });
      card(paneA.id, sourceId).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data, altKey: alt }));
      const box = target.getBoundingClientRect();
      const point = { clientX: box.left + 3, clientY: box.top + box.height / 2, altKey: alt };
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, ...point });
      target.dispatchEvent(over);
      const dropEffect = data.dropEffect;
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, ...point }));
      return { accepted: over.defaultPrevented, dropEffect };
    };
    // 1. Plain drop onto an image card of the other pane moves the image there.
    let before = mutations.length;
    let result = dragOnto('a-0', card(paneB.id, 'b-1'));
    assert(window.__itemDrag.started === 1, 'item drag did not start the native session');
    assert(result.accepted && result.dropEffect === 'move', 'other pane card refused the images: ' + result.dropEffect);
    await until(() => mutations.length === before + 1, 'cross-pane card drop submitted');
    let payload = mutations.at(-1);
    assert(payload.id === 'a-0' && payload.add[0] === 'eagle-folder' && payload.remove[0] === 'mv-folder', 'move payload ' + JSON.stringify(payload));
    await until(() => card(paneB.id, 'a-0') && !card(paneA.id, 'a-0'), 'panes refreshed after move');
    // 2. Option+drop onto a card of the other pane copies instead of moving.
    await until(() => !state.operationTracker.active().length, 'previous operation finished');
    before = mutations.length;
    result = dragOnto('a-1', card(paneB.id, 'b-2'), { alt: true });
    assert(result.accepted && result.dropEffect === 'copy', 'option drop effect was ' + result.dropEffect);
    await until(() => mutations.length === before + 1, 'cross-pane card copy submitted');
    payload = mutations.at(-1);
    assert(payload.id === 'a-1' && payload.add[0] === 'eagle-folder' && !payload.remove.length, 'copy payload ' + JSON.stringify(payload));
    // 3. Dropping onto a card of the same folder still reorders, never re-files.
    await until(() => !state.operationTracker.active().length, 'copy finished');
    before = mutations.length;
    const orders = window.__uiTestCalls.filter(call => call.kind === 'manual-order').length;
    result = dragOnto('a-2', card(paneA.id, 'a-3'));
    assert(result.accepted && result.dropEffect === 'move', 'same-folder reorder refused');
    await until(() => window.__uiTestCalls.filter(call => call.kind === 'manual-order').length === orders + 1, 'same-folder reorder submitted');
    await wait(60);
    assert(mutations.length === before, 'same-folder reorder also changed folders');
    assert(!document.querySelector('[data-manual-drop]'), 'insertion marker stuck');
  })()`);
  console.log('ITEM_CROSS_PANE_DRAG_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
