'use strict';
// Real-renderer check for P7-14: in the list layout every row spans the pane
// and each column starts at the same x on every row, whatever the name, tag,
// rating, date or size lengths, at the full width and at each narrower step.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-list-columns-'));
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
    // Every column on, so each one's alignment is checked.
    localStorage.setItem('eaglemv.listColumns', JSON.stringify({ tags: true, rating: true }));
    applyListColumnClasses();
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
      const header = document.querySelector('#itemGrid .list-header');
      assert(header, label + ': no column header');
      for (const key of ['name', 'tags', 'resolution', 'rating', 'ext', 'size', 'added']) {
        const selector = key === 'name' ? '.card-name' : '.list-col-' + key;
        const shown = rows.map(row => row.querySelector(selector)).filter(cell => cell && cell.offsetParent);
        const head = header.querySelector('.list-col-' + key);
        assert(Boolean(head && head.offsetParent) === Boolean(shown.length), label + ': header ' + key + ' shown with its column');
        if (!shown.length) continue;
        const lefts = [...shown, head].map(cell => Math.round(cell.getBoundingClientRect().left));
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
    pane.style.width = '';
    pane.style.flex = '';
    await wait(50);
    // Clicking a column sorts by it in Eagle's increasing order; again flips it.
    const head = key => document.querySelector('#itemGrid .list-header .list-col-' + key);
    head('size').click();
    await wait(30);
    assert(state.sort === 'size' && effectiveSortDir(state.sort, state.sortDir) === 'asc', 'size header sorts ascending: ' + state.sort + ' ' + state.sortDir);
    let names = [...document.querySelectorAll('#itemGrid .item-card')].map(card => card.dataset.id);
    assert(names[0] === items[0].id, 'smallest first');
    assert(head('size').classList.contains('active') && !head('size').querySelector('.list-head-arrow.up'), 'active, arrow down');
    head('size').click();
    await wait(30);
    assert(effectiveSortDir(state.sort, state.sortDir) === 'desc', 'second click flips');
    assert(head('size').querySelector('.list-head-arrow.up'), 'arrow up');
    head('added').click();
    await wait(30);
    assert(state.sort === 'added' && effectiveSortDir(state.sort, state.sortDir) === 'desc', 'date starts newest first');
    // Right-click picks the columns, the menu staying open between toggles.
    document.querySelector('#itemGrid .list-header').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 100 }));
    await wait(30);
    const rows = [...document.querySelectorAll('#contextMenu [data-context-action="toggle-list-column"]')];
    assert(rows.length === 6, 'six column toggles: ' + rows.length);
    const tagsRow = rows.find(row => row.textContent.includes('标签'));
    assert(tagsRow.classList.contains('checked'), 'tags on');
    tagsRow.click();
    await wait(30);
    assert(!$('#contextMenu').classList.contains('hidden'), 'menu stays open');
    assert(!tagsRow.classList.contains('checked'), 'tags row unchecked');
    assert(!document.querySelector('#itemGrid .item-card .list-col-tags').offsetParent, 'tags column hidden');
    assert(!head('tags').offsetParent, 'tags header hidden');
  })()`);
  console.log('LIST_COLUMNS_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
