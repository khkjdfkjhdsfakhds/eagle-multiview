'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-zf-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));
async function run() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'renderer-ui-preload.cjs') } });
  await window.loadFile(path.join(__dirname, '../src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async p => { for (let i=0;i<120;i+=1){ if (p()) return; await wait(20);} throw new Error('not ready'); };
    await until(() => document.body.classList.contains('offline') === false && document.querySelector('.content-pane'));

    // Verify the LIST rows follow --thumb: inject a list grid and read the
    // computed thumbnail width at two --thumb sizes.
    const probeList = document.createElement('div');
    probeList.className = 'asset-grid list';
    probeList.innerHTML = '<article class="item-card"><div class="thumb-wrap"></div></article>';
    document.body.appendChild(probeList);
    const thumb = () => probeList.querySelector('.thumb-wrap');
    document.documentElement.style.setProperty('--thumb', '168px');
    const defaultWidth = thumb().getBoundingClientRect().width;
    document.documentElement.style.setProperty('--thumb', '220px');
    await wait(250); // let the width transition settle before measuring
    const grownWidth = thumb().getBoundingClientRect().width;
    document.documentElement.style.removeProperty('--thumb');
    probeList.remove();

    // Verify the keyboard shortcut grows the size and Cmd+0 resets it. The
    // size readout badge was removed entirely (per product request), so the
    // #pinchBadge element must not exist in the DOM at all.
    const readThumb = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb'));
    const badgeGone = document.querySelector('.content-pane.active #pinchBadge') === null;
    const press = (code, meta=true) => document.dispatchEvent(new KeyboardEvent('keydown', { code, metaKey: meta, ctrlKey: false, altKey: false, bubbles: true, cancelable: true }));

    press('Equal'); await wait(60);
    const afterPlus = { thumb: readThumb() };
    press('Digit0'); await wait(60);
    const afterReset = { thumb: readThumb() };

    return { defaultWidth, grownWidth, afterPlus, afterReset, badgeGone };
  })()`);
  process.stdout.write(`EAGLEMV_ZOOM_FEEDBACK ${JSON.stringify(result)}\n`);
  window.destroy(); app.quit();
}
run().catch(e => { console.error(e); app.exit(1); });
