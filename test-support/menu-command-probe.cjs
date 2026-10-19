'use strict';
// Real-renderer check for the menu bar: command:menu reaches runMenuCommand,
// it acts like the matching shortcut, a dialog blocks it, the focus probe
// main asks before every command answers correctly, and the layout ticks
// are reported to main.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-menu-command-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'menu-command-preload.cjs')
  } });
  const source = path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html');
  await win.loadFile(source);
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const menu = command => window.__menuCommand(command);
    assert(typeof window.__menuCommand === 'function', 'command:menu not subscribed');
    navigate({ kind: 'folder', id: 'mv-folder' });
    await wait(80);
    const pane = paneById(state.activePaneId);
    assert(pane.items.length === 3, 'items ' + pane.items.length);

    // Focus probe: nothing focused, then a text field.
    document.activeElement?.blur();
    let focus = eagleMVMenuFocus();
    assert(!focus.editable && !focus.nativeCopy && !focus.nativeSelectAll, 'grid focus ' + JSON.stringify(focus));
    $('#searchInput').focus();
    focus = eagleMVMenuFocus();
    assert(focus.editable && focus.nativeCopy && focus.nativeSelectAll, 'field focus ' + JSON.stringify(focus));
    $('#searchInput').blur();

    // 全选 from the menu selects the items, like ⌘A.
    menu({ command: 'select-all' });
    await wait(30);
    assert(pane.selected.size === 3, 'select-all ' + pane.selected.size);

    // A dialog in front blocks every menu command.
    const pending = requestNameDialog({ title: '测试' });
    await wait(30);
    pane.selected.clear();
    menu({ command: 'select-all' });
    menu({ command: 'card-display', key: 'name' });
    await wait(30);
    assert(pane.selected.size === 0 && cardDisplay.name === true, 'menu ran behind a dialog');
    closeFolderDialog(null);
    await pending;

    // Display switches and layouts.
    menu({ command: 'card-display', key: 'name' });
    assert(cardDisplay.name === false, 'name not hidden');
    menu({ command: 'card-display', key: 'name' });
    assert(cardDisplay.name === true, 'name not shown again');
    menu({ command: 'view-mode', mode: 'list' });
    await wait(30);
    assert(state.viewMode === 'list', 'view mode ' + state.viewMode);
    assert(window.__menuReports.at(-1)?.viewMode === 'list', 'view mode not reported ' + JSON.stringify(window.__menuReports.at(-1)));
    menu({ command: 'view-mode', mode: 'justified' });
    menu({ command: 'pane-layout', layout: 'vertical2' });
    await wait(80);
    assert($('#paneLayout').dataset.layout === 'vertical2', 'pane layout');
    assert(window.__menuReports.at(-1)?.paneLayout === 'vertical2', 'pane layout not reported ' + JSON.stringify(window.__menuReports.at(-1)));
    menu({ command: 'pane-layout', layout: 'single' });
    await wait(80);

    // 移动到文件夹… opens the searchable picker in move mode; nothing happens
    // without a selection, as with the keyboard.
    const active = paneById(state.activePaneId);
    active.selected.clear();
    menu({ command: 'folder-picker', action: 'move-folder' });
    await wait(30);
    assert($('#contextMenu').classList.contains('hidden'), 'picker opened with no selection');
    active.selected = new Set([active.items[0].id]);
    updateCardSelectionStyles();
    renderInspector();
    menu({ command: 'folder-picker', action: 'move-folder' });
    await wait(30);
    const picker = $('#contextMenu [data-folder-picker-action]');
    assert(picker && picker.dataset.folderPickerAction === 'move-folder', 'move picker ' + $('#contextMenu').innerHTML.slice(0, 200));
    hideContextMenu();

    // 左栏 / 右栏 hides both, then shows both.
    menu({ command: 'toggle-panel', panel: 'both' });
    assert(!state.sidebarVisible && !state.inspectorVisible, 'panels not hidden');
    menu({ command: 'toggle-panel', panel: 'both' });
    assert(state.sidebarVisible && state.inspectorVisible, 'panels not shown');

    // ⌘T: the right panel's tag field takes focus.
    state.inspectorVisible = false;
    renderPanels();
    menu({ command: 'add-tag' });
    await wait(60);
    assert(state.inspectorVisible && document.activeElement?.id === 'itemTagInput', 'tag field focus ' + document.activeElement?.id);
    document.activeElement.blur();
    localStorage.removeItem('eaglemv.cardDisplay.v1');
  })()`);
  console.log('MENU_COMMAND_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
