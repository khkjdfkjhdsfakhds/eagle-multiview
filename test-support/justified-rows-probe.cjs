'use strict';
// Real-renderer check for P7-16: in the justified layout a row that cannot be
// filled (a portrait before a panorama that wraps) no longer blows its card up
// to the full width; growth is capped at 1.5× the thumbnail size and the short
// row stays left-aligned. Full rows still fill the width.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-justified-rows-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'inspector-refresh-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const items = window.__inspectorRefresh.items;
    Object.assign(items[0], { width: 50, height: 100 });   // portrait
    Object.assign(items[1], { width: 500, height: 100 });  // panorama: wraps
    Object.assign(items[2], { width: 100, height: 100 });
    for (let index = 3; index < 15; index++) items.push({ ...items[2], id: 'i-' + index, name: 'Image ' + index });
    state.currentView = { kind: 'folder', id: 'mv-folder' };
    await refresh({ reset: true });
    await wait(60);
    const thumb = currentThumbnailSize();
    const grid = document.querySelector('#itemGrid .asset-grid');
    assert(grid.classList.contains('justified'), 'not the justified layout');
    const box = grid.getBoundingClientRect();
    const cards = [...grid.querySelectorAll('.item-card')];
    for (const card of cards) {
      const image = card.querySelector('.thumb-wrap').getBoundingClientRect();
      assert(image.height <= thumb * 1.5 + 2, card.dataset.id + ' blown up to ' + Math.round(image.height) + 'px (thumb ' + thumb + ')');
      assert(card.getBoundingClientRect().right <= box.right + 0.5, card.dataset.id + ' overflows the grid');
    }
    const portrait = cards.find(card => card.dataset.id === 'i-0').getBoundingClientRect();
    assert(Math.abs(portrait.left - box.left) < 1, 'short row not left-aligned');
    // A full row of squares still spans the width.
    const rows = new Map();
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const top = Math.round(rect.top);
      rows.set(top, [...(rows.get(top) || []), rect]);
    }
    const full = [...rows.values()].filter(row => row.length >= 3);
    assert(full.length >= 2, 'fixture has no full rows');
    const first = full[0];
    assert(box.right - Math.max(...first.map(rect => rect.right)) < 2, 'a full row no longer fills the width');
  })()`);
  console.log('JUSTIFIED_ROWS_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
