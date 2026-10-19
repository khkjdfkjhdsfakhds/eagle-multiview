'use strict';
// Real-renderer check for the rest of Eagle's tag manager: the 格状 / 列表
// switch, group colours, 重命名 N 个项目... and dragging groups into order.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-tag-extras-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1280, height: 820,
    webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'tag-manager-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (predicate, label) => { for (let i = 0; i < 250; i += 1) { if (predicate()) return; await wait(20); } throw new Error('timed out: ' + label); };
    const $ = selector => document.querySelector(selector);
    const pane = () => document.querySelector('.content-pane');
    const inPane = selector => pane().querySelector(selector);
    const mouse = (target, type, init = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }));
    const chip = name => inPane('[data-tm-tag="' + name + '"]');
    const menu = () => [...document.querySelectorAll('#contextMenu > .context-menu-row')].map(row => row.querySelector('.context-menu-label').textContent);
    const calls = () => window.__tagCalls.map(call => { const { libraryPath, ...rest } = call; return rest; });
    const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
    const dialog = () => $('dialog.batch-rename-dialog');
    const previewRows = () => [...dialog().querySelectorAll('.batch-rename-preview-row:not(.head)')].map(row => [...row.children].map(cell => cell.textContent).join(' > '));
    window.confirm = message => { window.__confirms = [...(window.__confirms || []), message]; return true; };
    const out = {};
    await until(() => state.connected && state.availableTags.length === 6, 'library');
    navigate({ kind: 'tags' });
    await until(() => inPane('.tag-manager'), 'tag manager');

    // 格状 / 列表
    out.layoutButtons = [...pane().querySelectorAll('[data-tm-layout]')].map(button => button.getAttribute('aria-label') + (button.classList.contains('active') ? '*' : ''));
    mouse(inPane('[data-tm-layout="list"]'), 'click');
    await until(() => inPane('.tag-manager.list-mode'), 'list layout');
    const rows = [...pane().querySelectorAll('.tm-section')[0].querySelectorAll('.tm-tag')];
    out.listFullWidth = rows.every(row => Math.abs(row.getBoundingClientRect().width - row.parentElement.getBoundingClientRect().width) < 1);
    out.storedLayout = JSON.parse(localStorage.getItem('eaglemv.tagManager.v1')).layout;
    mouse(inPane('[data-tm-layout="list"]'), 'click');
    await until(() => !inPane('.tag-manager.list-mode'), 'grid layout again');

    // Group colours
    mouse(inPane('[data-tm-group="g-fruit"]'), 'contextmenu');
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'group menu');
    out.groupMenu = menu();
    out.swatches = [...document.querySelectorAll('#contextMenu .context-menu-colors .context-color-swatch')].map(node => node.title + (node.getAttribute('aria-checked') === 'true' ? '*' : ''));
    mouse([...document.querySelectorAll('#contextMenu .context-color-swatch')].find(node => node.title === '蓝'), 'click');
    await until(() => calls().some(call => call.kind === 'update-group'), 'blue');
    out.fruitDot = inPane('[data-tm-group="g-fruit"] .tm-group-dot')?.style.background;
    mouse(inPane('[data-tm-group="g-animals"]'), 'contextmenu');
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'animals menu');
    mouse([...document.querySelectorAll('#contextMenu .context-color-swatch')].find(node => node.title === '无'), 'click');
    await until(() => calls().some(call => call.kind === 'tag-color'), 'clear group colour');

    // 重命名 N 个项目...
    mouse(chip('apple'), 'click');
    mouse(chip('Banana'), 'click', { shiftKey: true });
    mouse(chip('Banana'), 'contextmenu');
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'tag menu');
    out.tagMenu = menu();
    mouse([...document.querySelectorAll('#contextMenu .context-menu-row')].find(row => row.dataset.contextAction === 'tm-batch-rename'), 'click');
    await until(() => dialog()?.open, 'rename dialog');
    out.dialogTitle = dialog().querySelector('h2').textContent;
    out.defaultPreview = previewRows();
    const pattern = dialog().querySelector('[data-rename-field="pattern"]');
    type(pattern, '水果 - %NN');
    out.startShown = !dialog().querySelector('[data-rename-field="startAt"]').closest('label').hidden;
    out.indexInsertDisabled = dialog().querySelector('[data-rename-insert="index"]').disabled;
    out.formatPreview = previewRows();
    mouse(dialog().querySelector('[data-rename-insert="date"]'), 'click');
    out.dateMenu = [...dialog().querySelectorAll('.batch-rename-menu-label')].map(node => node.textContent);
    dialog().querySelector('.batch-rename-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.dialogAfterMenuEscape = dialog()?.open === true;
    mouse(dialog().querySelector('[data-rename-setting="method"][data-value="replace"]'), 'click');
    out.submitWithoutFind = dialog().querySelector('[data-feature-submit]').disabled;
    type(dialog().querySelector('[data-rename-field="find"]'), '/^(a|B)/');
    type(dialog().querySelector('[data-rename-field="replacement"]'), 'Z');
    mouse(dialog().querySelector('[data-rename-setting="textCase"][data-value="lowercase"]'), 'click');
    out.replacePreview = previewRows();
    out.struck = [...dialog().querySelectorAll('.batch-rename-preview-row s')].map(node => node.textContent);
    dialog().querySelector('[data-rename-field="find"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await until(() => !dialog(), 'dialog closed');
    await until(() => calls().filter(call => call.kind === 'rename').length === 2, 'renames');
    out.confirm = window.__confirms?.[0];
    out.findHistory = JSON.parse(localStorage.getItem('eaglemv.batchRename.findHistory.TAGS'));

    // A name already taken merges.
    mouse(chip('风景'), 'click');
    mouse(chip('3D'), 'click', { metaKey: true });
    mouse(chip('3D'), 'contextmenu');
    mouse([...document.querySelectorAll('#contextMenu .context-menu-row')].find(row => row.dataset.contextAction === 'tm-batch-rename'), 'click');
    await until(() => dialog()?.open, 'second dialog');
    out.rememberedMethod = dialog().querySelector('[data-rename-setting="method"].active')?.dataset.value;
    out.rememberedFind = dialog().querySelector('[data-rename-field="find"]').value;
    out.patternStartsOver = dialog().querySelector('[data-rename-field="pattern"]').value;
    mouse(dialog().querySelector('[data-rename-setting="method"][data-value="format"]'), 'click');
    mouse(dialog().querySelector('[data-rename-setting="textCase"][data-value="none"]'), 'click');
    type(dialog().querySelector('[data-rename-field="pattern"]'), '猫');
    mouse(dialog().querySelector('[data-feature-submit]'), 'click');
    await until(() => calls().filter(call => call.kind === 'merge').length === 2, 'merges');

    // Esc closes without renaming.
    mouse(chip('猫'), 'click');
    mouse(chip('狗'), 'click', { metaKey: true });
    mouse(chip('狗'), 'contextmenu');
    mouse([...document.querySelectorAll('#contextMenu .context-menu-row')].find(row => row.dataset.contextAction === 'tm-batch-rename'), 'click');
    await until(() => dialog()?.open, 'third dialog');
    const before = calls().length;
    dialog().querySelector('[data-rename-field="pattern"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.escapeClosed = !dialog();
    out.escapeWrote = calls().length !== before;

    // Dragging a group reorders the groups (MultiView's own order).
    const groupOrder = () => [...pane().querySelectorAll('.tm-groups [data-tm-group]')].map(row => row.dataset.tmGroup);
    out.orderBefore = groupOrder();
    const transfer = new DataTransfer();
    const fruit = inPane('[data-tm-group="g-fruit"]');
    const animals = inPane('[data-tm-group="g-animals"]');
    out.groupDraggable = fruit.draggable;
    fruit.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const box = animals.getBoundingClientRect();
    animals.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: box.top + 2 }));
    out.dropBefore = animals.classList.contains('drop-before');
    animals.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: box.top + 2 }));
    await until(() => groupOrder()[0] === 'g-fruit', 'reordered');
    out.orderAfter = groupOrder();
    out.storedOrder = JSON.parse(localStorage.getItem('eaglemv.tagGroupOrder.v1'))['/tmp/EagleMV-Tag-Test.library'];
    out.groupWrites = calls().filter(call => call.kind === 'update-group').length;
    out.calls = calls();
    return out;
  })()`);
  console.log(`EAGLEMV_TAG_EXTRAS ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
