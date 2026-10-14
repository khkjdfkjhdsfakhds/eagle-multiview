'use strict';
// Real-renderer check for W-06: on a phone (390×844 web client) the filter
// sheet sits above the selection strip, so its last controls (保存为智能文件夹)
// stay reachable while something is selected.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-filter-sheet-phone-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 390, height: 844, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'web-mobile-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    assert(document.body.classList.contains('web-client') && isCompactLayout(), 'not the phone layout');
    state.currentView = { kind: 'folder', id: 'mv-folder' };
    await refresh({ reset: true });
    selectItem('i-0');
    await wait(30);
    const bar = document.querySelector('#selectionBar');
    assert(!bar.classList.contains('hidden') && bar.getBoundingClientRect().height > 0, 'selection strip not shown');
    document.querySelector('#filterButton').click();
    await wait(60);
    const sheet = document.querySelector('#filterPopover');
    assert(!sheet.classList.contains('hidden'), 'filter sheet did not open');
    const barTop = bar.getBoundingClientRect().top;
    assert(sheet.getBoundingClientRect().bottom <= barTop + 0.5, 'sheet runs under the strip: ' + sheet.getBoundingClientRect().bottom + ' > ' + barTop);
    sheet.scrollTop = sheet.scrollHeight;
    await wait(30);
    const controls = [...sheet.querySelectorAll('button, input, select')].filter(node => node.offsetParent);
    const last = controls.at(-1);
    last.scrollIntoView({ block: 'nearest' });
    const box = last.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    assert(last.contains(hit), 'last sheet control covered: "' + (last.textContent || last.name || last.id).trim() + '" under ' + (hit?.id || hit?.className));
  })()`);
  console.log('FILTER_SHEET_PHONE_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
