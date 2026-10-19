'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-tapzones-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));
async function run() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'sync-panes-preload.cjs') } });
  await window.loadFile(path.join(__dirname, '../src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async p => { for (let i=0;i<160;i+=1){ if (p()) return; await wait(20);} throw new Error('not ready'); };
    await until(() => document.body.classList.contains('offline') === false && document.querySelector('.content-pane .item-card'));
    const pane = document.querySelector('.content-pane');
    pane.querySelector('.item-card[data-id="item-3"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await until(() => window.state.panes[0].previewId === 'item-3');
    const modal = pane.querySelector('#previewModal');
    const media = pane.querySelector('#modalMedia');
    const preview = () => window.state.panes[0].previewId;
    // The mouse is pointer 1, so pointer capture on it is valid without a real press.
    const fire = (type, x, y) => media.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y
    }));
    const at = fraction => {
      const box = modal.getBoundingClientRect();
      return [box.left + box.width * fraction, box.top + box.height / 2];
    };
    const tap = async (fraction, { moveBy = 0, holdMs = 0 } = {}) => {
      const [x, y] = at(fraction);
      fire('pointerdown', x, y);
      if (moveBy) fire('pointermove', x + moveBy, y);
      if (holdMs) await wait(holdMs);
      fire('pointerup', x + moveBy, y);
      await wait(150);
      return preview();
    };
    const out = {
      arrows: { prev: Boolean(document.querySelector('#prevPreview')), next: Boolean(document.querySelector('#nextPreview')) },
      start: preview()
    };
    out.rightThird = await tap(5 / 6);
    out.leftThird = await tap(1 / 6);
    out.middle = await tap(1 / 2);
    out.drag = await tap(5 / 6, { moveBy: -40 });
    out.longPress = await tap(5 / 6, { holdMs: 650 });
    // The fixture images never decode, so zoom the pane state directly.
    window.state.panes[0].previewZoom.mode = 'zoom';
    window.state.panes[0].previewZoom.scale = 2;
    out.zoomedTap = await tap(5 / 6);
    return out;
  })()`);
  process.stdout.write(`EAGLEMV_TAPZONES ${JSON.stringify(result)}\n`);
  window.destroy(); app.quit();
}
run().catch(e => { console.error(e); app.exit(1); });
