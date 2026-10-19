'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-folder-multiselect-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1300, height: 860, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'folder-multiselect-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (fn, label) => { for (let i = 0; i < 250; i++) { if (fn()) return; await wait(20); } throw Error('timeout: ' + label); };
    await until(() => state.connected && document.querySelector('#folderTree [data-folder-id="mv-folder"]'), 'connect');
    const probe = window.__multiFolder;
    const row = id => document.querySelector('#folderTree .folder-node > [data-folder-id="' + id + '"]');
    const click = (id, init = {}) => row(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    const idle = () => until(() => !state.operationTracker.active().length, 'idle');
    const snap = () => ({
      view: JSON.parse(JSON.stringify(state.currentView)),
      title: document.querySelector('#viewTitle').textContent,
      active: [...document.querySelectorAll('#folderTree .folder-node > .folder-row.active')].map(node => node.dataset.folderId),
      folderIds: paneItemQuery(activePane()).folderIds || null
    });
    const out = {};
    click('mv-folder');
    await idle();
    out.single = snap();
    click('eagle-folder', { metaKey: true });
    await idle();
    out.added = snap();
    out.breadcrumb = document.querySelector('#breadcrumb').textContent.replace(/\\s+/g, ' ').trim();
    click('locked-folder', { metaKey: true });
    await idle();
    out.lockedRefused = snap().view.selectedFolderIds;
    click('mv-folder', { metaKey: true });
    await idle();
    out.removed = snap().view.selectedFolderIds;
    click('eagle-folder', { metaKey: true });
    await idle();
    out.lastKept = snap().view.selectedFolderIds;
    click('mv-folder');
    await idle();
    click('eagle-folder', { shiftKey: true });
    await idle();
    out.range = snap();

    row('eagle-folder').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 200 }));
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'menu');
    out.menu = [...document.querySelectorAll('#contextMenu .context-menu-row')].map(node => node.textContent.replace(/\\s+/g, ' ').trim());
    out.swatches = document.querySelectorAll('#contextMenu [data-context-action="set-folders-color"]').length;
    document.querySelector('#contextMenu [data-context-action="set-folders-color"][title="红"], #contextMenu [data-context-action="set-folders-color"]:not(.none)').click();
    await until(() => probe.colors.length === 2, 'colours');
    await idle();
    out.colors = probe.colors.map(call => call.id);

    row('eagle-folder').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 200 }));
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'menu for move');
    document.querySelector('#contextMenu [data-context-action="move-folder-nodes"]').click();
    await until(() => document.querySelector('.feature-dialog[open]'), 'move dialog');
    const moveDialog = document.querySelector('.feature-dialog[open]');
    out.moveTargets = [...moveDialog.querySelectorAll('option')].map(option => option.value);
    out.moveDisabledAtParent = moveDialog.querySelector('[data-feature-submit]').disabled;
    const select = moveDialog.querySelector('select');
    select.value = 'locked-folder'; select.dispatchEvent(new Event('change', { bubbles: true }));
    moveDialog.querySelector('[data-feature-submit]').click();
    await until(() => (probe.moves || []).length === 2 && !document.querySelector('.feature-dialog[open]'), 'moves');
    await idle();
    out.moves = probe.moves.map(call => [call.id, call.parentId]);

    row('eagle-folder').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 200 }));
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'menu again');
    document.querySelector('#contextMenu [data-context-action="remove-folder-nodes"]').click();
    await until(() => !$('#trashDialog').classList.contains('hidden'), 'remove dialog');
    out.removeMessage = $('#trashDialogMessage').textContent;
    out.removeCheckbox = !$('#trashDialogCheck').classList.contains('hidden');
    $('#trashDeleteButton').click();
    await until(() => probe.removals.length === 2, 'removals');
    await idle();
    out.removals = probe.removals.map(call => ({ id: call.id, isDeleteImages: call.isDeleteImages }));
    return out;
  })()`);
  console.log(`EAGLEMV_FOLDER_MULTISELECT ${JSON.stringify(result)}`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
