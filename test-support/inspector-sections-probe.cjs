'use strict';
// Real-renderer check for the rest of Eagle's inspector: blocks that fold
// and are dragged into order, the 导出 button, and the next item selected
// once the selection leaves the folder on screen.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-inspector-sections-');
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
    const pointer = (target, type, init = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true, ...init }));
    const card = id => document.querySelector('.content-pane .item-card[data-id="' + id + '"]');
    const order = panel => [...$(panel + ' [data-inspector-sections]').children].map(section => section.dataset.inspectorSection);
    const calls = () => window.__sectionCalls;
    const settled = () => until(() => !state.operationTracker.size, 'settled');
    const out = {};
    await until(() => state.connected && state.library, 'library');
    navigate({ kind: 'folder', id: 'folder-a' });
    await until(() => document.querySelectorAll('.content-pane .item-card').length === 4, 'cards');

    mouse(card('item-1'), 'click');
    await until(() => !$('#inspectorContent').classList.contains('hidden'), 'single inspector');
    out.defaultOrder = order('#inspectorContent');
    out.headings = [...document.querySelectorAll('#inspectorContent [data-section-toggle]')].map(button => button.textContent.trim() + ':' + button.getAttribute('aria-expanded'));

    // Folding
    mouse($('#inspectorContent [data-section-toggle="folders"]'), 'click');
    out.foldedFolders = $('#inspectorContent [data-inspector-section="folders"]').classList.contains('collapsed')
      && !$('#itemFolderChips').checkVisibility()
      && $('#inspectorContent [data-section-toggle="folders"]').getAttribute('aria-expanded') === 'false';
    out.storedFold = JSON.parse(localStorage.getItem('eaglemv.inspector.sections.v1')).collapsed.folders;
    mouse(card('item-2'), 'click', { metaKey: true });
    await until(() => !$('#multiSelection').classList.contains('hidden'), 'multi');
    out.multiFolded = $('#multiSelection [data-inspector-section="folders"]').classList.contains('collapsed');
    mouse($('#multiSelection [data-section-toggle="folders"]'), 'click');
    out.unfolded = !$('#inspectorContent [data-inspector-section="folders"]').classList.contains('collapsed');

    // Dragging 基本信息 above 标签 in the multi inspector reorders both.
    const info = $('#multiSelection [data-section-toggle="information"]');
    const tagsBox = $('#multiSelection [data-inspector-section="tags"]').getBoundingClientRect();
    const start = info.getBoundingClientRect();
    pointer(info, 'pointerdown', { clientX: start.left + 5, clientY: start.top + 5 });
    pointer(document, 'pointermove', { clientX: start.left + 6, clientY: start.top + 8 });
    out.notDraggingYet = !document.querySelector('.section-dragging');
    pointer(document, 'pointermove', { clientX: start.left + 5, clientY: tagsBox.top + 2 });
    out.dropMark = $('#multiSelection [data-inspector-section="tags"]').classList.contains('drop-before');
    pointer(document, 'pointerup', { clientX: start.left + 5, clientY: tagsBox.top + 2 });
    mouse(info, 'click');
    out.multiOrder = order('#multiSelection');
    out.singleOrder = order('#inspectorContent');
    out.dragDidNotFold = !$('#multiSelection [data-inspector-section="information"]').classList.contains('collapsed');

    // 导出
    out.exportButton = $('#batchExportButton').textContent + (($('#batchExportButton').hidden) ? '(hidden)' : '');
    mouse($('#batchExportButton'), 'click');
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'export menu');
    out.exportMenu = [...document.querySelectorAll('#contextMenu .context-menu-row')].map(row => row.querySelector('.context-menu-label').textContent);
    mouse($('#contextMenu [data-context-action="inspector-export"]'), 'click');
    await until(() => calls().some(call => call.kind === 'export'), 'export');

    // Taking item-2 out of the folder on screen selects item-3.
    mouse(card('item-2'), 'click');
    await until(() => state.selected.size === 1 && $('#itemFolderChips [data-remove-folder="folder-a"]'), 'item-2');
    mouse($('#itemFolderChips [data-remove-folder="folder-a"]'), 'click');
    await until(() => !card('item-2') && state.selected.has('item-3'), 'next after ×');
    await settled();
    out.afterRemove = [...state.selected];
    out.inspectorName = $('#itemName').value;
    // The trash selects the next one too.
    await applyTrash(['item-3'], true);
    await settled();
    out.afterTrash = [...state.selected];
    // The last one leaving selects the one before.
    await removeSelectionFromFolder({ ids: ['item-4'], folderId: 'folder-a' });
    await settled();
    out.afterLast = [...state.selected];
    // Leaving an item's other folder (not the one on screen) keeps it.
    mouse(card('item-1'), 'click');
    await mutateSelectionSet(['item-1'], 'folders', { add: ['folder-b'] }, 'x', state.activePaneId, { keepSelection: true });
    await settled();
    await until(() => $('#itemFolderChips [data-remove-folder="folder-b"]'), 'item-1 in 乙');
    mouse($('#itemFolderChips [data-remove-folder="folder-b"]'), 'click');
    await until(() => calls().filter(call => call.kind === 'mutate-set' && call.remove.includes('folder-b')).length === 1, 'left 乙');
    await settled();
    out.keptOnOtherFolder = [...state.selected];
    return out;
  })()`);
  console.log(`EAGLEMV_INSPECTOR_SECTIONS ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
