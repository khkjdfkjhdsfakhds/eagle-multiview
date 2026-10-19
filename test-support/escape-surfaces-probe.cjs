'use strict';
// B3-06: Esc closes the filter, library and layout popovers, the tag colour
// manager and drawers, innermost first, and leaves the grid selection alone
// while it does.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-escape-surfaces-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'batch-selection-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.items.length === 3); i += 1) await wait(20);
    if (state.items.length !== 3) throw new Error('fixture items not loaded');
    const esc = (target = document.activeElement || document.body) => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    };
    const open = selector => !$(selector).classList.contains('hidden');
    const out = {};
    selectItem('a');

    $('#filterButton').click();
    $('#filterButton').focus();
    out.filterOpened = open('#filterPopover');
    esc();
    out.filter = { open: open('#filterPopover'), selected: [...state.selected] };

    $('#filterButton').click();
    $('#toggleTagColorsButton').click();
    out.managerOpened = open('#tagColorManager');
    esc();
    out.afterFirstEsc = { manager: open('#tagColorManager'), filter: open('#filterPopover') };
    esc();
    out.afterSecondEsc = { filter: open('#filterPopover') };

    $('#paneLayoutButton').click();
    out.layoutOpened = open('#paneLayoutPopover');
    esc($('#paneLayoutButton'));
    out.layout = { open: open('#paneLayoutPopover'), expanded: $('#paneLayoutButton').getAttribute('aria-expanded') };

    await openLibraryPopover();
    esc();
    out.library = { open: open('#libraryPopover'), expanded: $('#libraryButton').getAttribute('aria-expanded') };

    out.selectionKept = [...state.selected];
    document.activeElement?.blur?.();
    esc(document.body);
    out.selectionAfterPlainEsc = [...state.selected];
    return out;
  })()`);
  console.log(`EAGLEMV_ESCAPE_SURFACES ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
