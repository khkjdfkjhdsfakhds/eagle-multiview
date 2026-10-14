'use strict';
// B3-03: clicking a colour swatch or removing a tag chip in the filter panel
// re-renders the clicked button away; the panel must stay open regardless.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-filter-popover-click-'));
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
    const open = () => !$('#filterPopover').classList.contains('hidden');
    $('#filterButton').click();
    const opened = open();
    document.querySelector('#filterPopover [data-filter-color]:not([data-filter-color=""])').click();
    await wait(30);
    const afterSwatch = { open: open(), color: state.query.color || null };
    setTagValues('filter', ['x', 'y']);
    await wait(30);
    document.querySelector('#filterTagChips [data-remove-tag="x"]').click();
    await wait(30);
    const afterChip = { open: open(), tags: [...state.query.tags] };
    document.body.click();
    return { opened, afterSwatch, afterChip, afterOutside: open() };
  })()`);
  console.log(`EAGLEMV_FILTER_POPOVER_CLICK ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
