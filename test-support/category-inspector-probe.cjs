'use strict';
// Real-renderer check for P2-05: with no item selected the inspector shows the
// open folder (or the selected folder card, or the view) like Eagle's: the
// folder's name and description are editable there, and every view lists its
// file count and size, computed without the search and filters.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-category-inspector-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'inspector-refresh-preload.cjs')
  } });
  const source = path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html');
  await win.loadFile(source);
  // A hidden window never has focus; without this, blur (which saves) never fires.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    const visible = selector => !document.querySelector(selector).classList.contains('hidden');
    const meta = () => Object.fromEntries([...document.querySelectorAll('#categoryMeta span')].map(span => [span.querySelector('em').textContent, span.textContent.slice(span.querySelector('em').textContent.length)]));
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const folder = state.library.folders.find(entry => entry.id === 'mv-folder');
    folder.modificationTime = new Date(2026, 9, 1, 8, 5).getTime();
    const statsQueries = [];
    let releaseStats;
    window.eagleMV.viewStats = query => {
      statsQueries.push(query);
      return new Promise(resolve => { releaseStats = () => resolve({ count: 3, size: 303 }); });
    };
    const writes = [];
    window.eagleMV.updateFolderProperties = async request => {
      writes.push(request);
      return { ok: true, folder: { ...folder, ...request.patch } };
    };
    const renames = [];
    window.eagleMV.mutateFolder = async request => {
      renames.push(request);
      return { ok: true, folder: { ...folder, name: request.name } };
    };
    // A search in this folder must not narrow the count.
    state.query.search = 'image';
    navigate({ kind: 'folder', id: 'mv-folder' });
    await wait(80);
    assert(visible('#categoryInspector') && !visible('#noSelection'), 'folder view without selection does not show the folder');
    assert(document.querySelector('#categoryName').value === 'MultiView 文件夹' && !document.querySelector('#categoryName').readOnly, 'name field ' + document.querySelector('#categoryName').value);
    assert(!document.querySelector('#categoryDescription').closest('.inspector-field').classList.contains('hidden'), 'description hidden for a folder');
    assert(meta()['占用空间'] === '计算中…', 'size while counting: ' + JSON.stringify(meta()));
    assert(meta()['添加日期'] === '2026/10/01 08:05', 'added date ' + meta()['添加日期']);
    assert(statsQueries.length === 1 && statsQueries[0].folderId === 'mv-folder' && !statsQueries[0].search, 'stats query ' + JSON.stringify(statsQueries));
    releaseStats();
    await wait(30);
    assert(meta()['文件数'] === '3' && meta()['占用空间'] === '303 B', 'stats shown ' + JSON.stringify(meta()));
    renderInspector();
    await wait(10);
    assert(statsQueries.length === 1, 'stats not cached');

    // Description: saved on blur with the value it started from as the base.
    const description = document.querySelector('#categoryDescription');
    description.focus();
    description.value = '新描述';
    description.dispatchEvent(new Event('input'));
    description.blur();
    for (let n = 0; n < 50 && !writes.length; n++) await wait(10);
    assert(writes.length === 1 && writes[0].id === 'mv-folder' && writes[0].patch.description === '新描述' && writes[0].base.description === '', 'description write ' + JSON.stringify(writes));
    await wait(30);
    // A redraw while typing keeps the typed text; Esc goes back to the saved one.
    description.focus();
    description.value = '还在输入';
    renderInspector();
    assert(description.value === '还在输入', 'redraw replaced typed text: ' + description.value);
    description.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(30);
    assert(description.value === '新描述' && document.activeElement !== description && writes.length === 1, 'Esc did not revert: ' + description.value + ' writes ' + writes.length);

    // Name: Return renames through the shared rename path.
    const name = document.querySelector('#categoryName');
    name.focus();
    name.value = '改过的名字';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    for (let n = 0; n < 50 && !renames.length; n++) await wait(10);
    assert(renames.length === 1 && renames[0].name === '改过的名字' && renames[0].baseName === 'MultiView 文件夹', 'rename ' + JSON.stringify(renames));
    await wait(30);

    // Selecting an item hands the inspector back to the item.
    state.selected = new Set(['i-0']);
    renderInspector();
    assert(!visible('#categoryInspector') && visible('#inspectorContent'), 'item selection still shows the folder');
    state.selected.clear();
    renderInspector();
    assert(visible('#categoryInspector'), 'clearing the selection did not bring the folder back');

    // Another view: read-only name, no description, stats of the whole view.
    window.eagleMV.viewStats = async query => { statsQueries.push(query); return { count: 12, size: 5 * 1024 * 1024 }; };
    navigate({ kind: 'all' });
    await wait(80);
    assert(document.querySelector('#categoryName').readOnly && document.querySelector('#categoryName').value === state.viewTitle, 'all view name ' + document.querySelector('#categoryName').value);
    assert(document.querySelector('#categoryDescription').closest('.inspector-field').classList.contains('hidden'), 'description shown for 全部');
    assert(statsQueries.at(-1).folderId === null, 'all view stats query ' + JSON.stringify(statsQueries.at(-1)));
    assert(meta()['文件数'] === '12' && meta()['占用空间'] === '5.0 MB' && !('添加日期' in meta()), 'all view meta ' + JSON.stringify(meta()));

    // A locked folder card: nothing editable, no counts.
    paneById(state.activePaneId).selectedFolderCard = 'locked-folder';
    renderInspector();
    assert(document.querySelector('#categoryName').readOnly && document.querySelector('#categoryName').value === 'Locked 文件夹', 'locked name');
    assert(JSON.stringify(meta()) === JSON.stringify({ 状态: '已加密' }), 'locked meta ' + JSON.stringify(meta()));
    assert(document.querySelector('#categoryHint').textContent.includes('Return'), 'card hint missing');
  })()`);
  console.log('CATEGORY_INSPECTOR_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
