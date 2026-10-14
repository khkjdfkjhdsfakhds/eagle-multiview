'use strict';
// Real-renderer check for drags that pass over or end in a pane:
// D-03 each pane keeps its own import overlay; D-04 passing over a pane does
// not activate it (only the drop does); D-05 letting go in the folder the
// items came from is a silent no-op; D-06 a slow refresh after a completed
// move is not reported as a failed move.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-pane-drag-pass-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'pane-drag-pass-preload.cjs')
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
    const inPane = (paneId, selector) => document.querySelector('.content-pane[data-pane-id="' + paneId + '"] ' + selector);
    const card = (paneId, id) => inPane(paneId, '.item-card[data-id="' + id + '"]');
    const overlayShown = paneId => !inPane(paneId, '#dropOverlay').classList.contains('hidden');
    await until(() => card(paneA.id, 'a-0') && card(paneB.id, 'b-1') && !paneA.loading && !paneB.loading, 'pane items');
    activatePane(paneA.id);
    const { paths } = window.__staleDrag;
    const mutations = window.__itemDrag.mutations;
    const toasts = [];
    const showToast = window.toast;
    window.toast = (message, duration) => { toasts.push(String(message)); return showToast(message, duration); };
    let inspectorRenders = 0;
    const renderInspectorNow = window.renderInspector;
    window.renderInspector = (...args) => { inspectorRenders += 1; return renderInspectorNow(...args); };
    const idle = () => until(() => !state.operationTracker.active().length && !state.importing, 'operations idle');
    const fire = (target, type, data, extra = {}) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, ...extra });
      target.dispatchEvent(event);
      return event;
    };
    const recordEffect = data => {
      let effect = 'none';
      Object.defineProperty(data, 'dropEffect', { get: () => effect, set: value => { effect = value; } });
      return data;
    };

    // 1. D-03 / D-04: Finder files pass from pane A into pane B. Chromium
    //    fires B's dragenter before A's dragleave.
    paths.set('photo.png', '/Users/tester/Desktop/photo.png');
    const files = new DataTransfer();
    files.items.add(new File(['x'], 'photo.png', { type: 'image/png' }));
    const scrollerA = inPane(paneA.id, '#gridScroller');
    const scrollerB = inPane(paneB.id, '#gridScroller');
    inspectorRenders = 0;
    fire(scrollerA, 'dragenter', files);
    fire(scrollerA, 'dragover', files);
    assert(overlayShown(paneA.id) && !overlayShown(paneB.id), 'overlay not on pane A');
    fire(scrollerB, 'dragenter', files);
    fire(scrollerA, 'dragleave', files, { relatedTarget: scrollerB });
    fire(scrollerB, 'dragover', files);
    assert(!overlayShown(paneA.id), 'pane A overlay stuck after the drag left it');
    assert(overlayShown(paneB.id), 'pane B overlay hidden while the drag is over it');
    assert(state.activePaneId === paneA.id, 'passing over pane B activated it');
    assert(inspectorRenders === 0, 'passing over pane B rebuilt the inspector ' + inspectorRenders + 'x');
    // Leaving B again (back out of the window) hides its overlay too.
    fire(scrollerB, 'dragleave', files, { relatedTarget: null });
    assert(!overlayShown(paneA.id) && !overlayShown(paneB.id), 'an overlay survived the drag leaving the window');
    // Coming back and dropping on B activates B and imports there.
    fire(scrollerB, 'dragenter', files);
    fire(scrollerB, 'dragover', files);
    fire(scrollerB, 'drop', files);
    assert(state.activePaneId === paneB.id, 'dropping on pane B did not activate it');
    await until(() => window.__staleDrag.imports.length === 1, 'finder drop imported');
    assert(window.__staleDrag.imports[0].folderId === 'eagle-folder', 'import went to ' + window.__staleDrag.imports[0].folderId);
    assert(!overlayShown(paneA.id) && !overlayShown(paneB.id), 'overlay left after the drop');
    await idle();

    // 2. D-05: an item drag let go on the blank area of its own pane is
    //    refused by the cursor and stays silent.
    activatePane(paneA.id);
    let before = mutations.length;
    toasts.length = 0;
    let data = recordEffect(new DataTransfer());
    fire(card(paneA.id, 'a-0'), 'dragstart', data);
    fire(scrollerA, 'dragenter', data);
    fire(scrollerA, 'dragover', data);
    assert(data.dropEffect === 'none', 'own pane offered a ' + data.dropEffect + ' drop');
    fire(scrollerA, 'drop', data);
    await wait(120);
    await idle();
    assert(mutations.length === before, 'own-pane drop changed folders: ' + JSON.stringify(mutations.slice(before)));
    assert(!toasts.length, 'own-pane drop showed: ' + toasts.join(' / '));
    clearDragUI();

    // 3. D-06: the move succeeds, then refreshing pane B takes too long.
    window.withTimeout = ((original) => (promise, ms, message) => original(promise, Math.min(ms, 300), message))(window.withTimeout);
    before = mutations.length;
    toasts.length = 0;
    window.__paneDrag.hangFolder = 'eagle-folder';
    data = recordEffect(new DataTransfer());
    fire(card(paneA.id, 'a-1'), 'dragstart', data);
    fire(scrollerB, 'dragenter', data);
    fire(scrollerB, 'dragover', data);
    assert(data.dropEffect === 'move', 'cross-pane drop offered ' + data.dropEffect);
    fire(scrollerB, 'drop', data);
    await until(() => mutations.length === before + 1, 'cross-pane move submitted');
    await wait(500);
    window.__paneDrag.hangFolder = null;
    assert(toasts.some(text => text.includes('已移动')), 'no success toast: ' + toasts.join(' / '));
    assert(!toasts.some(text => text.includes('失败')), 'completed move reported as failed: ' + toasts.join(' / '));
    assert(!card(paneA.id, 'a-1'), 'moved item still shown in its source pane');
  })()`);
  console.log('PANE_DRAG_PASS_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
