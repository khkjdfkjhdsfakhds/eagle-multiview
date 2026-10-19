'use strict';
// P6-03 / P6-04: ⇧-click and ⇧-arrows follow Eagle's anchor rules in the
// real grid, and ⇧↑/⇧↓ only extend in the list layout.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-shift-select-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));
process.env.EAGLEMV_SELECT_ALL_COUNT = '10';

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'select-all-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.items.length === 10); i += 1) await wait(20);
    const ids = () => [...state.selected].map(id => Number(id.slice(1))).sort((a, b) => a - b);
    const click = (index, modifiers = {}) => {
      const card = document.querySelector('.item-card[data-id="i' + index + '"]');
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...modifiers }));
    };
    const key = (name, shiftKey = true) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, shiftKey, bubbles: true, cancelable: true }));
    const cmd = navigator.platform.startsWith('Mac') ? { metaKey: true } : { ctrlKey: true };
    const out = {};
    click(5); click(2, { shiftKey: true }); click(8, { shiftKey: true });
    out.anchorStays = ids();
    click(5); click(1, cmd); click(3, { shiftKey: true });
    out.cmdAnchor = ids();
    click(3, { shiftKey: true });
    out.shiftOnSelected = ids();
    click(4); key('ArrowRight'); key('ArrowRight');
    out.shiftRight = ids();
    key('ArrowLeft'); key('ArrowLeft'); key('ArrowLeft');
    out.shiftLeft = ids();
    click(4); key('ArrowDown');
    out.gridShiftDown = ids();
    state.viewMode = 'list';
    renderGrid({ preserveScroll: true });
    click(4); key('ArrowDown');
    out.listShiftDown = ids();
    return out;
  })()`);
  console.log(`EAGLEMV_SHIFT_SELECT ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
