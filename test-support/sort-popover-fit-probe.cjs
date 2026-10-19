'use strict';
// Real-renderer check for P7-13: in a top/bottom split of a 640px window the
// sort popover is taller than its pane. It must not be clipped by the pane:
// every option, including "包含子文件夹", is visible and clickable, and the
// popover stays inside the window (flipping up when there is no room below).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-sort-popover-fit-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 640, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    assert(renderPaneLayout('horizontal2', { refresh: false }) === true, 'top/bottom layout refused');
    await wait(50);
    const [top, bottom] = state.panes;
    for (const pane of state.panes) {
      pane.currentView = { kind: 'folder', id: 'mv-folder' };
      await refresh({ reset: true, paneId: pane.id });
    }
    const reachable = element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && element.contains(hit);
    };
    for (const pane of [top, bottom]) {
      const button = paneQuery(pane.id, '#sortSelectButton');
      assert(button && button.offsetParent, 'sort button hidden in pane ' + pane.id);
      button.click();
      await wait(30);
      const popover = paneQuery(pane.id, '#sortPopover');
      assert(!popover.classList.contains('hidden'), 'popover did not open');
      const paneBox = paneRoot(pane.id).getBoundingClientRect();
      const box = popover.getBoundingClientRect();
      assert(box.height > paneBox.height - 60 || box.bottom > paneBox.bottom || box.top < paneBox.top,
        'fixture too roomy: popover ' + box.height + ' in pane ' + paneBox.height);
      assert(box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth, 'popover outside the window: ' + JSON.stringify(box));
      for (const option of popover.querySelectorAll('.sort-popover-option, #sortCascadeItem')) {
        if (option.closest('.hidden')) continue;
        // Disabled options (direction under Eagle order) take no pointer events.
        if (option.disabled) continue;
        assert(reachable(option), 'clipped option in pane ' + pane.id + ': ' + option.textContent.trim());
      }
      // Choosing an option still works and closes it.
      popover.querySelector('[data-sort="name"]').click();
      await wait(30);
      assert(popover.classList.contains('hidden'), 'popover stayed open after a choice');
      assert(pane.sort === 'name', 'choice not applied: ' + pane.sort);
    }
  })()`);
  console.log('SORT_POPOVER_FIT_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
