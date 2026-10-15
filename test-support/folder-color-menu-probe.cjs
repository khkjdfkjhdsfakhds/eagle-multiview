'use strict';
// Real-renderer check for P1-12: the folder menus (sidebar row and folder
// card) end with Eagle's row of colour dots; picking one writes the colour
// through updateFolderProperties with the colour it replaces as the base, and
// the sidebar dot follows without a reload.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-folder-color-menu-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'inspector-refresh-preload.cjs')
  } });
  const source = path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html');
  await win.loadFile(source);
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const folder = state.library.folders.find(entry => entry.id === 'mv-folder');
    folder.iconColor = 'red';
    renderFolderTree();
    const calls = [];
    window.eagleMV.updateFolderProperties = async request => {
      calls.push(request);
      return { ok: true, folder: { ...folder, ...request.patch } };
    };
    const row = document.querySelector('#folderTree .folder-row[data-folder-id="mv-folder"]');
    assert(row, 'no sidebar row');
    const box = row.getBoundingClientRect();
    openSidebarContextMenu(row, { x: box.left + 20, y: box.top + 5 });
    await wait(30);
    const swatches = [...document.querySelectorAll('#contextMenu .context-menu-colors .context-color-swatch')];
    assert(swatches.length === 9, 'sidebar menu shows ' + swatches.length + ' swatches');
    assert(swatches[0].classList.contains('none') && swatches[0].title === '无', 'first dot is not 无');
    const checked = swatches.filter(swatch => swatch.getAttribute('aria-checked') === 'true');
    assert(checked.length === 1 && checked[0].title === '红', 'current colour not marked: ' + checked.map(s => s.title));
    const menuBox = document.querySelector('#contextMenu').getBoundingClientRect();
    for (const swatch of swatches) {
      const rect = swatch.getBoundingClientRect();
      assert(rect.right <= menuBox.right && rect.left >= menuBox.left, 'swatch ' + swatch.title + ' spills out of the menu');
    }
    swatches.find(swatch => swatch.title === '绿').click();
    for (let n = 0; n < 50 && !calls.length; n++) await wait(10);
    await wait(30);
    assert(calls.length === 1, 'calls ' + calls.length);
    const call = calls[0];
    assert(call.id === 'mv-folder' && call.patch.iconColor === 'green' && call.base.iconColor === 'red' && call.libraryPath === state.library.path,
      'wrong request ' + JSON.stringify(call));
    assert(document.querySelector('#contextMenu').classList.contains('hidden') || !document.querySelector('#contextMenu .context-menu-colors'), 'menu stayed open');
    const dot = document.querySelector('#folderTree .folder-row[data-folder-id="mv-folder"] .folder-color-dot');
    assert(dot && getComputedStyle(dot).backgroundColor === 'rgb(70, 167, 88)', 'sidebar dot ' + (dot && getComputedStyle(dot).backgroundColor));
    // Picking the colour it already has is not a write.
    openSidebarContextMenu(document.querySelector('#folderTree .folder-row[data-folder-id="mv-folder"]'), { x: box.left + 20, y: box.top + 5 });
    await wait(30);
    document.querySelector('#contextMenu .context-color-swatch[aria-checked="true"]').click();
    await wait(30);
    assert(calls.length === 1, 'same colour wrote again');
    // The folder card menu offers the same row; 无 clears.
    showContextMenuAt(200, 200, { kind: 'folder', ids: [], folderId: 'mv-folder', paneId: state.activePaneId });
    await wait(30);
    const cardSwatches = [...document.querySelectorAll('#contextMenu .context-color-swatch')];
    assert(cardSwatches.length === 9, 'card menu shows ' + cardSwatches.length + ' swatches');
    cardSwatches[0].click();
    for (let n = 0; n < 50 && calls.length < 2; n++) await wait(10);
    assert(calls.length === 2 && calls[1].patch.iconColor === '' && calls[1].base.iconColor === 'green', 'clear request ' + JSON.stringify(calls[1]));
    await wait(30);
    assert(!document.querySelector('#folderTree .folder-row[data-folder-id="mv-folder"] .folder-color-dot'), 'dot still shown after 无');
  })()`);
  console.log('FOLDER_COLOR_MENU_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
