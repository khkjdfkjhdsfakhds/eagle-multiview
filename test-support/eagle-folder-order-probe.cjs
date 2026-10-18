'use strict';
// Real-renderer check for P1-02/E-11: a folder view's "Eagle 顺序" follows the
// folder's own Eagle sort, dragging is offered only where Eagle offers it, and
// a drag sends just the moved block to eagle-order:move.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-eagle-folder-order-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1200, height: 700, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (fn, label) => { for (let n = 0; n < 250; n++) { if (fn()) return; await wait(20); } throw Error('timeout: ' + label); };
    await until(() => state.connected, 'connect');
    const items = [
      { id: 'n10', name: '图10', ext: 'png', width: 10, height: 10, folders: ['F'], tags: [], modificationTime: 3000 },
      { id: 'n2', name: '图2', ext: 'png', width: 10, height: 10, folders: ['F'], tags: [], modificationTime: 2000, order: { F: '5000' } },
      { id: 'n1', name: '图1', ext: 'png', width: 10, height: 10, folders: ['F'], tags: [], modificationTime: 1000 }
    ];
    const moves = [];
    window.eagleMV.query = async () => ({ data: items.map(item => structuredClone(item)), total: items.length, nextOffset: items.length, hasMore: false });
    window.eagleMV.moveEagleOrder = async payload => {
      moves.push(payload);
      return { ok: true, items: [{ ...structuredClone(items.find(item => item.id === payload.ids[0])), order: { F: '9000' } }] };
    };
    const folder = { id: 'F', name: 'Ordered', orderBy: 'NAME', sortIncrease: true, children: [] };
    state.library.folders = [folder];
    navigate({ kind: 'folder', id: 'F' }, { skipDiscard: true });
    await until(() => document.querySelectorAll('.item-card').length === 3, 'cards');
    const ids = () => [...document.querySelectorAll('.item-card')].map(card => card.dataset.id);
    const dragOver = (fromId, toId) => {
      const from = document.querySelector('[data-id="' + fromId + '"]'), to = document.querySelector('[data-id="' + toId + '"]');
      const data = new DataTransfer(), box = to.getBoundingClientRect();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.left + 2, clientY: box.top + 2 }));
      return { to, data, box, marker: to.dataset.manualDrop || null };
    };
    const byName = ids();
    const nameTitle = document.querySelector('#sortSelectButton').title;
    const nameDrag = dragOver('n1', 'n10');
    nameDrag.to.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: nameDrag.data }));
    folder.orderBy = 'MANUAL';
    renderSortControls(); renderGrid({ preserveScroll: true });
    const manual = ids();
    const manualTitle = document.querySelector('#sortSelectButton').title;
    const drag = dragOver('n1', 'n2');
    drag.to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: drag.data, clientX: drag.box.left + 2, clientY: drag.box.top + 2 }));
    await until(() => moves.length === 1, 'move ' + document.querySelector('#toast').textContent + ' marker=' + drag.marker + ' ready=' + state.manualOrdersReady);
    await until(() => ids()[0] === 'n1', 'regrid');
    await wait(60);
    return { byName, nameTitle, nameMarker: nameDrag.marker, manual, manualTitle, manualMarker: drag.marker, move: moves[0], after: ids(), sort: state.sort };
  })()`);
  console.log('EAGLE_FOLDER_ORDER ' + JSON.stringify(result));
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
