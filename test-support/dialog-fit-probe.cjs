'use strict';
// Real-renderer check for P7-11: a modal card taller than the window (the
// Web access dialog with a QR code open is ~693px) scrolls inside itself and
// keeps its buttons on screen in a 980×640 window.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-dialog-fit-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 980, height: 640, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    assert(innerHeight === 640, 'window height ' + innerHeight);
    for (const id of ['webAccessDialog', 'trashDialog', 'duplicateDialog', 'folderDialog']) {
      const dialog = document.getElementById(id);
      if (!dialog) continue;
      const card = dialog.querySelector('.trash-dialog-card');
      const filler = document.createElement('div');
      filler.style.height = '700px';
      card.querySelector('.trash-dialog-actions').before(filler);
      dialog.classList.remove('hidden');
      await wait(30);
      const box = card.getBoundingClientRect();
      assert(box.top >= 0 && box.bottom <= innerHeight, id + ' card overflows the window: ' + box.top + '–' + box.bottom);
      const buttons = [...card.querySelectorAll('.trash-dialog-actions button')].filter(button => button.offsetParent);
      assert(buttons.length, id + ' has no visible buttons');
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        assert(rect.bottom <= innerHeight && button.contains(hit), id + ' button "' + button.textContent.trim() + '" not reachable at ' + rect.bottom);
      }
      card.scrollTop = 0;
      assert(card.scrollHeight > card.clientHeight, id + ' card does not scroll');
      filler.remove();
      dialog.classList.add('hidden');
    }
  })()`);
  console.log('DIALOG_FIT_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
