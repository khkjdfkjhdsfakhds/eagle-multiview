'use strict';
// Real-renderer check for P7-14: in the list layout every row spans the pane
// and each column starts at the same x on every row, whatever the name, tag,
// rating, date or size lengths, at the full width and at each narrower step.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-list-columns-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 800, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'inspector-refresh-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const items = window.__inspectorRefresh.items;
    Object.assign(items[0], { name: 'a', tags: [], star: 0, width: 1, height: 1, size: 10, btime: 0 });
    Object.assign(items[1], { name: 'A much longer file name that goes on and on for a while', tags: ['portrait', 'reference', 'lighting'],
      star: 5, width: 12000, height: 8000, size: 987654321, btime: Date.UTC(2026, 9, 1) });
    Object.assign(items[2], { name: 'medium name', tags: ['x'], star: 2, width: 640, height: 480, size: 52345, btime: Date.UTC(2025, 0, 9) });
    state.currentView = { kind: 'folder', id: 'mv-folder' };
    setPaneViewMode('list');
    await refresh({ reset: true });
    const check = label => {
      const rows = [...document.querySelectorAll('#itemGrid .item-card')];
      assert(rows.length === 3, label + ': rows ' + rows.length);
      const grid = document.querySelector('#itemGrid').getBoundingClientRect();
      for (const row of rows) {
        const box = row.getBoundingClientRect();
        assert(Math.abs(box.width - grid.width) < 1, label + ': row ' + box.width + ' vs list ' + grid.width);
        assert(box.right <= grid.right + 0.5, label + ': row overflows');
      }
      for (const selector of ['.card-name', '.card-list-tags', '.card-list-rating', '.card-list-date', '.card-meta']) {
        const shown = rows.map(row => row.querySelector(selector)).filter(cell => cell && cell.offsetParent);
        if (!shown.length) continue;
        const lefts = shown.map(cell => Math.round(cell.getBoundingClientRect().left));
        assert(new Set(lefts).size === 1, label + ': ' + selector + ' starts at ' + lefts.join(', '));
      }
    };
    await wait(50);
    check('full width');
    // The pane's narrower container steps (620/500/400/300px).
    const pane = document.querySelector('.content-pane');
    for (const width of [600, 480, 380, 280]) {
      pane.style.width = width + 'px';
      pane.style.flex = 'none';
      await wait(50);
      check(width + 'px pane');
    }
  })()`);
  console.log('LIST_COLUMNS_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
