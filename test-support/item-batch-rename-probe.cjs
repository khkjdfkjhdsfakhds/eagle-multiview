'use strict';
// Real-renderer check for Eagle's batch rename of several items: the
// 重命名 N 个项目... menu row and ⌘R, the dialog with thumbnails, the last
// name remembered, and one Eagle rename per item.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-item-rename-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'inspector-sections-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (predicate, label) => { for (let i = 0; i < 250; i += 1) { if (predicate()) return; await wait(20); } throw new Error('timed out: ' + label); };
    const $ = selector => document.querySelector(selector);
    const mouse = (target, type, init = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }));
    const card = id => document.querySelector('.content-pane .item-card[data-id="' + id + '"]');
    const dialog = () => $('dialog.batch-rename-dialog');
    const rows = () => [...dialog().querySelectorAll('.batch-rename-preview-row:not(.head)')].map(row => [...row.querySelectorAll('[role=cell]')].map(cell => cell.textContent).filter(Boolean).join(' > '));
    const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
    const out = {};
    await until(() => state.connected && state.library, 'library');
    navigate({ kind: 'folder', id: 'folder-a' });
    await until(() => document.querySelectorAll('.content-pane .item-card').length === 4, 'cards');
    mouse(card('item-1'), 'click');
    mouse(card('item-3'), 'click', { shiftKey: true });
    mouse(card('item-3'), 'contextmenu');
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'menu');
    out.menuRow = $('#contextMenu [data-context-action="batch-rename"]')?.textContent.trim();
    mouse($('#contextMenu [data-context-action="batch-rename"]'), 'click');
    await until(() => dialog()?.open, 'dialog');
    out.title = dialog().querySelector('h2').textContent;
    out.defaultPattern = dialog().querySelector('[data-rename-field="pattern"]').value;
    out.thumbs = dialog().querySelectorAll('.batch-rename-thumb img').length;
    out.defaultRows = rows();
    type(dialog().querySelector('[data-rename-field="pattern"]'), '图/%NN');
    out.rows = rows();
    mouse(dialog().querySelector('[data-feature-submit]'), 'click');
    await until(() => window.__sectionCalls.filter(call => call.kind === 'mutate').length === 3 && !state.operationTracker.size, 'renamed');
    out.writes = window.__sectionCalls.filter(call => call.kind === 'mutate').map(call => call.id + '=' + call.patch.name);
    out.toast = $('#toast').textContent;
    out.lastName = localStorage.getItem('eaglemv.batchRename.lastName');
    // ⌘R with two selected opens it again, starting from the last name.
    mouse(card('item-2'), 'click');
    mouse(card('item-4'), 'click', { metaKey: true });
    requestRenameSelection();
    await until(() => dialog()?.open, 'command-r');
    out.commandRPattern = dialog().querySelector('[data-rename-field="pattern"]').value;
    dialog().querySelector('[data-rename-field="pattern"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.closed = !dialog();
    return out;
  })()`);
  console.log(`EAGLEMV_ITEM_RENAME ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
