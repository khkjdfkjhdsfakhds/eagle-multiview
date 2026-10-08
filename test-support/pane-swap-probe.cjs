'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-swap-'));
app.setPath('userData', profile);
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_UI_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    assert(!swapRecentPanes(), 'single pane should not swap');
    renderPaneLayout('vertical2', { refresh: false });
    const [a,b] = state.panes;
    activatePane(a.id);
    const item = { id: 'swap-txt', ext: 'txt', name: 'Swap fixture' };
    a.items = [item]; a.itemMap.set(item.id, item);
    renderGrid();
    paneQuery(a.id, '.item-card').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:400,clientY:200}));
    assert(document.querySelector('#contextMenu [data-context-action="swap-panes"]'), 'real item right-click omitted swap');
    hideContextMenu();
    window.eagleMV.readText = async () => ({ content: 'body', fingerprint: { size: 4, hash: 'base' } });
    await openPreview(item.id);
    const session = a.textSession, editor = paneQuery(a.id, '#textEditor');
    editor.value = 'unsaved body'; editor.dispatchEvent(new Event('input', { bubbles: true }));
    clearTimeout(session.autoSaveTimer); editor.setSelectionRange(2,6);
    const oldNode = paneRoot(a.id);
    activatePane(b.id);
    showContextMenuAt(400,200,{kind:'workspace',paneId:b.id,ids:[]});
    const row = document.querySelector('#contextMenu [data-context-action="swap-panes"]');
    assert(row && row.textContent.includes('交换双栏'), 'right-click swap entry missing');
    row.click();
    assert(state.panes[0] === b && state.panes[1] === a, 'two pane order did not swap');
    assert(state.activePaneId === b.id && paneRoot(a.id) === oldNode, 'swap changed identity or active pane');
    assert(editor.isConnected && a.textSession === session && session.dirty && editor.value === 'unsaved body' && editor.selectionStart === 2 && editor.selectionEnd === 6, 'swap lost editor state');
    assert(paneRoot(b.id).getBoundingClientRect().left < paneRoot(a.id).getBoundingClientRect().left, 'DOM position did not swap');
    discardTextSession(session); withActivePane(a.id, () => closePreview({skipDiscard:true,syncBroadcast:false}));
    for (const layout of ['vertical3','grid4','leftStack','horizontal2']) {
      renderPaneLayout(layout, { refresh: false });
      const original = [...state.panes];
      const first = original[0], last = original.at(-1);
      activatePane(first.id); activatePane(last.id);
      withActivePane(original[1].id, () => {});
      assert(recentPanePair().join() === [last.id,first.id].join(), 'temporary rendering changed activation history');
      assert(swapRecentPanes(), 'multi-pane swap failed');
      assert(state.panes[0] === last && state.panes.at(-1) === first, 'wrong recent pair swapped');
      assert(state.panes.slice(1,-1).every((p,i) => p === original[i+1]), 'unrelated pane moved');
      assert([...document.querySelectorAll('#paneLayout > .content-pane')].map(n=>n.dataset.paneId).join() === state.panes.map(p=>p.id).join(), 'DOM/state order differs');
      const saved = JSON.parse(localStorage.getItem('eaglemv.sessionState'));
      assert(saved.panes.map(p=>p.id).join() === state.panes.map(p=>p.id).join(), 'swap was not saved');
      swapRecentPanes();
      assert(state.panes.every((p,i)=>p===original[i]), 'repeated swap did not restore');
    }
  })()`);
  console.log('PANE_SWAP_OK'); win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
