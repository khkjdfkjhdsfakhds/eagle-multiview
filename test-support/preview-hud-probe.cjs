'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-hud-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));
async function run() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'renderer-ui-preload.cjs') } });
  await window.loadFile(path.join(__dirname, '../src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async p => { for (let i=0;i<120;i+=1){ if (p()) return; await wait(20);} throw new Error('not ready'); };
    await until(() => document.body.classList.contains('offline') === false && document.querySelector('.content-pane'));
    const modal = document.querySelector('.content-pane .preview-modal');
    modal.classList.remove('hidden');
    const read = () => ({
      close: getComputedStyle(document.querySelector('#closePreview')).display,
      prev: getComputedStyle(document.querySelector('#prevPreview')).display,
      next: getComputedStyle(document.querySelector('#nextPreview')).display,
      rating: getComputedStyle(document.querySelector('#modalRating')).display,
      slideshow: getComputedStyle(document.querySelector('#slideshowControls')).display,
      previewBackground: getComputedStyle(document.querySelector('#previewBackground')).display,
      closeOpacity: parseFloat(getComputedStyle(document.querySelector('#closePreview')).opacity)
    });
    const desktop = read();
    document.body.classList.add('web-client');
    const web = read();
    window.state.previewId = 'fixture-preview';
    document.querySelector('#slideshowToggle').click();
    const slideshowPressed = document.querySelector('#slideshowToggle').getAttribute('aria-pressed');
    document.querySelector('#slideshowToggle').click();
    modal.classList.add('hud-hidden');
    // Let the slow .7s opacity transition settle; poll in case the Electron
    // process is busy and the compositor frame is delayed under load.
    const closeEl = document.querySelector('#closePreview');
    for (let i = 0; i < 60 && parseFloat(getComputedStyle(closeEl).opacity) > 0.001; i += 1) {
      await wait(50);
    }
    const hudHidden = read();
    modal.classList.remove('hud-hidden');
    document.body.classList.remove('web-client');
    return { desktop, web, hudHidden, slideshowPressed };
  })()`);
  process.stdout.write(`EAGLEMV_HUD ${JSON.stringify(result)}\n`);
  window.destroy(); app.quit();
}
run().catch(e => { console.error(e); app.exit(1); });
